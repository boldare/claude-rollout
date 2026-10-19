import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { enableWorktreeConfig, preparePreview, prepareWorktree, previewPath, removePreview } from '../lib/worktree.mjs'

const HOME = new URL('..', import.meta.url).pathname
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']

function git(cwd, ...args) {
  return execFileSync('git', [...IDENTITY, '-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function commit(cwd, file) {
  writeFileSync(join(cwd, file), `${file}\n`)
  git(cwd, 'add', file)
  git(cwd, 'commit', '--quiet', '-m', `add ${file}`)

  return git(cwd, 'rev-parse', 'HEAD')
}

// A local bare origin and a clone, no GitHub.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-wt-'))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')

  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  execFileSync('git', ['clone', '--quiet', origin, repo], { stdio: 'ignore' })
  commit(repo, 'a.txt')
  git(repo, 'push', '--quiet', 'origin', 'HEAD:main')

  const manifest = {
    home: HOME,
    wtRoot: join(dir, 'demo.worktrees'),
    repo: { path: repo, base: 'main', install: null, agentToken: null, pathPrepend: [] },
  }

  return { dir, manifest, repo, pr: { id: 'A1', branch: 'feat/a1' } }
}

function mergeElsewhere(repo, file) {
  git(repo, 'checkout', '--quiet', '--detach', 'origin/main')
  const sha = commit(repo, file)
  git(repo, 'push', '--quiet', 'origin', 'HEAD:main')

  return sha
}

async function started(context) {
  const setup = fixture()
  await enableWorktreeConfig(setup.manifest)
  const wt = await prepareWorktree(setup.manifest, setup.pr)
  context.after(() => rmSync(setup.dir, { recursive: true, force: true }))

  return { ...setup, wt }
}

test('prepareWorktree: an untouched worktree moves to the current base', async (context) => {
  const { manifest, repo, pr, wt } = await started(context)
  const base = mergeElsewhere(repo, 'b.txt')

  assert.equal(await prepareWorktree(manifest, pr), wt)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), base)
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), pr.branch)
})

test('prepareWorktree: local commits stay where they are', async (context) => {
  const { manifest, repo, pr, wt } = await started(context)
  const own = commit(wt, 'own.txt')
  mergeElsewhere(repo, 'b.txt')

  await prepareWorktree(manifest, pr)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), own)
})

test('prepareWorktree: uncommitted or untracked changes stay where they are', async (context) => {
  const { manifest, repo, pr, wt } = await started(context)
  const head = git(wt, 'rev-parse', 'HEAD')
  writeFileSync(join(wt, 'draft.txt'), 'work in progress\n')
  mergeElsewhere(repo, 'b.txt')

  await prepareWorktree(manifest, pr)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head)
})

test('prepareWorktree: a pushed branch is left to the rebase at the gate', async (context) => {
  const { manifest, repo, pr, wt } = await started(context)
  const head = git(wt, 'rev-parse', 'HEAD')
  git(repo, 'push', '--quiet', 'origin', `${head}:refs/heads/${pr.branch}`)
  mergeElsewhere(repo, 'b.txt')

  await prepareWorktree(manifest, pr)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head)
})

// A dependency's PR branch off main with one commit, pushed like an implementer would.
function pushBranch(repo, branch, file, text = `${file}\n`) {
  git(repo, 'checkout', '--quiet', '-B', branch, 'origin/main')
  writeFileSync(join(repo, file), text)
  git(repo, 'add', file)
  git(repo, 'commit', '--quiet', '-m', `add ${file}`)
  git(repo, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)

  return git(repo, 'rev-parse', 'HEAD')
}

async function previewSetup(context) {
  const setup = fixture()
  await enableWorktreeConfig(setup.manifest)
  context.after(() => rmSync(setup.dir, { recursive: true, force: true }))

  return { ...setup, pr: { id: 'A3', branch: 'feat/a3' } }
}

test('preparePreview: origin/main with each verified head merged in, detached, and the PR branch untouched', async (context) => {
  const { manifest, repo, pr } = await previewSetup(context)
  const heads = [
    { id: 'A1', sha: pushBranch(repo, 'feat/a1', 'one.txt') },
    { id: 'A2', sha: pushBranch(repo, 'feat/a2', 'two.txt') },
  ]

  const wt = await preparePreview(manifest, pr, heads)

  assert.equal(wt, previewPath(manifest, pr))
  assert.ok(existsSync(join(wt, 'one.txt')) && existsSync(join(wt, 'two.txt')) && existsSync(join(wt, 'a.txt')))
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD')
  assert.equal(git(wt, 'log', '-1', '--format=%s'), 'preview: A2 at ' + heads[1].sha.slice(0, 7))
  assert.equal(git(repo, 'branch', '--list', pr.branch), '')
  assert.throws(() => git(wt, 'push', '--quiet', 'origin', 'HEAD:refs/heads/feat/a3'), /no rollout-branch marker/)

  await removePreview(manifest, pr)
  assert.equal(existsSync(wt), false)
})

test('preparePreview: heads that conflict give null and leave no preview behind', async (context) => {
  const { manifest, repo, pr } = await previewSetup(context)
  const heads = [
    { id: 'A1', sha: pushBranch(repo, 'feat/a1', 'same.txt', 'one\n') },
    { id: 'A2', sha: pushBranch(repo, 'feat/a2', 'same.txt', 'two\n') },
  ]

  assert.equal(await preparePreview(manifest, pr, heads), null)
  assert.equal(existsSync(previewPath(manifest, pr)), false)
  assert.equal(await preparePreview(manifest, pr, heads.slice(0, 1)), previewPath(manifest, pr))
})
