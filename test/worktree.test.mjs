import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  alignWorktree,
  enableWorktreeConfig,
  preparePreview,
  prepareWorktree,
  previewPath,
  removePreview,
  resetWorktree,
} from '../lib/worktree.mjs'
import { readEnvFile, withProcessEnv } from './fixtures.mjs'

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
    dir: join(dir, 'demo'),
    rollout: 'demo',
    wtRoot: join(dir, 'demo.worktrees'),
    repo: { path: repo, github: 'example/widgets', base: 'main', install: null, agentToken: null, pathPrepend: [] },
  }

  mkdirSync(manifest.dir)

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

test('repo.install runs with the environment of a read-only agent, in a new PR worktree and in a preview', async (context) => {
  const { dir, manifest, pr } = fixture()
  const installEnv = join(dir, 'install.env')
  const parent = { GH_TOKEN: 'synthetic-maintainer-token', NPM_TOKEN: 'synthetic-npm-token', NODE_AUTH_TOKEN: 'synthetic-node-auth-token' }

  context.after(() => rmSync(dir, { recursive: true, force: true }))
  manifest.repo.install = `env > '${installEnv}'`
  manifest.repo.agentToken = join(dir, 'agent-token')
  manifest.repo.pushUrl = join(dir, 'origin.git')
  writeFileSync(manifest.repo.agentToken, 'synthetic-agent-token\n')
  await enableWorktreeConfig(manifest)

  for (const prepare of [() => prepareWorktree(manifest, pr), () => preparePreview(manifest, pr, [])]) {
    rmSync(installEnv, { force: true })
    await withProcessEnv(parent, prepare)

    const env = readEnvFile(installEnv)

    assert.equal(env.GH_TOKEN, 'synthetic-agent-token')
    assert.equal(env.NPM_TOKEN, '')
    assert.equal(env.NODE_AUTH_TOKEN, '')
    assert.equal(env.NPM_CONFIG_USERCONFIG, join(manifest.dir, '.npmrc-agents'))
    assert.equal(env.ROLLOUT_BRANCH, '')
    assert.equal(env.ROLLOUT_ROLE, 'install')
    assert.equal(env.ROLLOUT_ID, pr.id)
  }
})

const LOCAL_CONFIG = ['.claude/settings.json', '.claude/settings.local.json', 'CLAUDE.local.md']

// The fixture repo's own excludesFile hides .claude/ from git status, like a global gitignore would.
async function ignoringClaude(context) {
  const setup = await started(context)
  const excludes = join(setup.dir, 'excludes')

  writeFileSync(excludes, '.claude/\n')
  git(setup.repo, 'config', 'core.excludesFile', excludes)

  return setup
}

function writeLocalConfig(wt) {
  mkdirSync(join(wt, '.claude'), { recursive: true })

  for (const path of LOCAL_CONFIG) {
    writeFileSync(join(wt, path), '{}\n')
  }
}

test('alignWorktree and resetWorktree delete untracked and ignored Claude Code files at the worktree root', async (context) => {
  const { manifest, pr, wt } = await ignoringClaude(context)
  const head = git(wt, 'rev-parse', 'HEAD')

  writeLocalConfig(wt)
  assert.equal(git(wt, 'status', '--porcelain'), '?? CLAUDE.local.md')
  assert.deepEqual(await alignWorktree(manifest, pr, head), { ok: true, wt, removed: LOCAL_CONFIG })

  for (const path of LOCAL_CONFIG) {
    assert.equal(existsSync(join(wt, path)), false, path)
  }

  writeLocalConfig(wt)
  assert.deepEqual(await resetWorktree(manifest, pr, head), LOCAL_CONFIG)

  for (const path of LOCAL_CONFIG) {
    assert.equal(existsSync(join(wt, path)), false, path)
  }
})

test('alignWorktree and resetWorktree keep tracked Claude Code files', async (context) => {
  const { manifest, pr, wt } = await ignoringClaude(context)

  mkdirSync(join(wt, '.claude'))
  writeFileSync(join(wt, '.claude', 'settings.json'), '{}\n')
  writeFileSync(join(wt, 'CLAUDE.local.md'), 'notes\n')
  git(wt, 'add', '-f', '.claude/settings.json', 'CLAUDE.local.md')
  git(wt, 'commit', '--quiet', '-m', 'add Claude Code files')

  const head = git(wt, 'rev-parse', 'HEAD')

  assert.deepEqual(await alignWorktree(manifest, pr, head), { ok: true, wt, removed: [] })
  assert.deepEqual(await resetWorktree(manifest, pr, head), [])
  assert.ok(existsSync(join(wt, '.claude', 'settings.json')))
  assert.ok(existsSync(join(wt, 'CLAUDE.local.md')))
})

test('alignWorktree and resetWorktree never follow a symlinked .claude', async (context) => {
  const { dir, manifest, pr, wt } = await ignoringClaude(context)
  const outside = join(dir, 'outside')
  const head = git(wt, 'rev-parse', 'HEAD')

  mkdirSync(outside)
  writeFileSync(join(outside, 'settings.json'), '{}\n')
  writeFileSync(join(outside, 'settings.local.json'), '{}\n')
  symlinkSync(outside, join(wt, '.claude'))
  writeFileSync(join(wt, 'CLAUDE.local.md'), 'notes\n')

  // The pattern .claude/ matches directories only, so the link itself is untracked and align refuses the tree.
  const aligned = await alignWorktree(manifest, pr, head)

  assert.equal(aligned.ok, false)
  assert.match(aligned.reason, /\.claude/)
  assert.deepEqual(aligned.removed, ['CLAUDE.local.md'])

  writeFileSync(join(wt, 'CLAUDE.local.md'), 'notes\n')
  assert.deepEqual(await resetWorktree(manifest, pr, head), ['CLAUDE.local.md'])
  assert.ok(existsSync(join(outside, 'settings.json')))
  assert.ok(existsSync(join(outside, 'settings.local.json')))
})
