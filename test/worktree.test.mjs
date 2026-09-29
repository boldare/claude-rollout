import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enableWorktreeConfig, prepareWorktree } from '../lib/worktree.mjs'

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

// A local bare origin with one commit on main and a clone as the repo. No
// GitHub: fetches and pushes stay on disk.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-wt-'))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')

  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  execFileSync('git', ['clone', '--quiet', origin, repo], { stdio: 'ignore' })
  commit(repo, 'a.txt')
  git(repo, 'push', '--quiet', 'origin', 'HEAD:main')

  const M = {
    home: HOME,
    wtRoot: join(dir, 'demo.worktrees'),
    repo: { path: repo, base: 'main', install: null, agentToken: null, pathPrepend: [] },
  }

  return { dir, M, repo, pr: { id: 'A1', branch: 'feat/a1' } }
}

// Lands a commit on origin/main, as a merged PR would.
function mergeElsewhere(repo, file) {
  git(repo, 'checkout', '--quiet', '--detach', 'origin/main')
  const sha = commit(repo, file)
  git(repo, 'push', '--quiet', 'origin', 'HEAD:main')

  return sha
}

async function started(t) {
  const f = fixture()
  await enableWorktreeConfig(f.M)
  const wt = await prepareWorktree(f.M, f.pr)
  t.after(() => rmSync(f.dir, { recursive: true, force: true }))

  return { ...f, wt }
}

test('prepareWorktree: an untouched worktree moves to the current base', async (t) => {
  const { M, repo, pr, wt } = await started(t)
  const base = mergeElsewhere(repo, 'b.txt')

  assert.equal(await prepareWorktree(M, pr), wt)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), base)
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), pr.branch)
})

test('prepareWorktree: local commits stay where they are', async (t) => {
  const { M, repo, pr, wt } = await started(t)
  const own = commit(wt, 'own.txt')
  mergeElsewhere(repo, 'b.txt')

  await prepareWorktree(M, pr)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), own)
})

test('prepareWorktree: uncommitted or untracked changes stay where they are', async (t) => {
  const { M, repo, pr, wt } = await started(t)
  const head = git(wt, 'rev-parse', 'HEAD')
  writeFileSync(join(wt, 'draft.txt'), 'work in progress\n')
  mergeElsewhere(repo, 'b.txt')

  await prepareWorktree(M, pr)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head)
})

test('prepareWorktree: a pushed branch is left to the rebase at the gate', async (t) => {
  const { M, repo, pr, wt } = await started(t)
  const head = git(wt, 'rev-parse', 'HEAD')
  git(repo, 'push', '--quiet', 'origin', `${head}:refs/heads/${pr.branch}`)
  mergeElsewhere(repo, 'b.txt')

  await prepareWorktree(M, pr)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head)
})
