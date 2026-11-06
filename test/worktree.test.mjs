import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  alignWorktree,
  mirrorPath,
  preparePreview,
  prepareWorktree,
  previewPath,
  rebaseWorktree,
  removePreview,
  removeWorktree,
  resetWorktree,
  worktreePath,
} from '../lib/worktree.mjs'
import { fakeDocker, readEnvFile, withProcessEnv } from './fixtures.mjs'

const HOME = new URL('..', import.meta.url).pathname
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']
const GITHUB_URL = 'https://github.com/example/widgets.git'

function git(cwd, ...args) {
  return execFileSync('git', [...IDENTITY, '-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function gitCode(cwd, ...args) {
  return spawnSync('git', ['-C', cwd, ...args], { stdio: 'ignore' }).status
}

function commit(cwd, file) {
  writeFileSync(join(cwd, file), `${file}\n`)
  git(cwd, 'add', file)
  git(cwd, 'commit', '--quiet', '-m', `add ${file}`)

  return git(cwd, 'rev-parse', 'HEAD')
}

// Config that every git started by this process reads, until the test ends.
// The tests in a file run one at a time, so none sees another's.
function gitEnvConfig(context, entries) {
  const names = ['GIT_CONFIG_COUNT', ...entries.flatMap((_, i) => [`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`])]
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))

  process.env.GIT_CONFIG_COUNT = String(entries.length)

  for (const [i, [key, value]] of entries.entries()) {
    process.env[`GIT_CONFIG_KEY_${i}`] = key
    process.env[`GIT_CONFIG_VALUE_${i}`] = value
  }

  context.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })
}

// A local bare origin and repo.path cloned from it. git maps the clones'
// GitHub origin to the bare one, so no test reaches GitHub. The identity and
// the signing are for the rebase.
function fixture(context) {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-wt-'))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')

  context.after(() => rmSync(dir, { recursive: true, force: true }))
  gitEnvConfig(context, [
    [`url.${origin}.insteadOf`, GITHUB_URL],
    ['user.name', 'Test'],
    ['user.email', 'test@example.com'],
    ['commit.gpgsign', 'false'],
  ])

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

  return { dir, origin, manifest, repo, pr: { id: 'A1', branch: 'feat/a1' } }
}

function mergeElsewhere(repo, file) {
  git(repo, 'checkout', '--quiet', '--detach', 'origin/main')
  const sha = commit(repo, file)
  git(repo, 'push', '--quiet', 'origin', 'HEAD:main')

  return sha
}

// A dependency's PR branch off main with one commit, pushed like an implementer would.
function pushBranch(repo, branch, file, text = `${file}\n`) {
  git(repo, 'checkout', '--quiet', '-B', branch, 'origin/main')
  writeFileSync(join(repo, file), text)
  git(repo, 'add', file)
  git(repo, 'commit', '--quiet', '-m', `add ${file}`)
  git(repo, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)

  return git(repo, 'rev-parse', 'HEAD')
}

// Branch names and SHAs under a ref prefix, without the symbolic HEAD.
function refs(cwd, prefix) {
  return git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)', prefix)
    .split('\n')
    .map((line) => line.slice(prefix.length))
    .filter((line) => !line.startsWith('HEAD '))
}

async function started(context) {
  const setup = fixture(context)
  const wt = await prepareWorktree(setup.manifest, setup.pr)

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
  assert.equal(readFileSync(join(wt, 'draft.txt'), 'utf8'), 'work in progress\n')
})

test('prepareWorktree: a pushed branch is left to the rebase at the gate', async (context) => {
  const { manifest, repo, pr, wt } = await started(context)
  const head = git(wt, 'rev-parse', 'HEAD')
  git(repo, 'push', '--quiet', 'origin', `${head}:refs/heads/${pr.branch}`)
  mergeElsewhere(repo, 'b.txt')

  await prepareWorktree(manifest, pr)
  assert.equal(git(wt, 'rev-parse', 'HEAD'), head)
})

test('prepareWorktree: two PRs prepared at once each get a clone of the mirror, with its own .git and GitHub as origin', async (context) => {
  const { manifest, origin, repo } = fixture(context)
  const prs = [
    { id: 'A1', branch: 'feat/a1' },
    { id: 'A2', branch: 'feat/a2' },
  ]

  pushBranch(repo, 'feat/other', 'other.txt')

  const wts = await Promise.all(prs.map((pr) => prepareWorktree(manifest, pr)))

  for (const [i, wt] of wts.entries()) {
    assert.equal(wt, worktreePath(manifest, prs[i]))
    assert.ok(lstatSync(join(wt, '.git')).isDirectory())
    assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), prs[i].branch)
    assert.deepEqual(refs(wt, 'refs/remotes/origin/'), refs(origin, 'refs/heads/'))
    assert.equal(git(wt, 'config', 'remote.origin.url'), GITHUB_URL)
    assert.equal(git(wt, 'remote', 'get-url', 'origin'), origin)
  }

  assert.equal(git(mirrorPath(manifest), 'rev-parse', '--is-bare-repository'), 'true')
})

test('prepareWorktree: a local branch in repo.path with the PR branch name neither blocks the PR nor reaches its clone', async (context) => {
  const { manifest, repo, pr } = fixture(context)

  git(repo, 'checkout', '--quiet', '-b', pr.branch)

  const local = commit(repo, 'local.txt')
  const wt = await prepareWorktree(manifest, pr)

  assert.equal(git(wt, 'rev-parse', 'HEAD'), git(wt, 'rev-parse', 'origin/main'))
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), pr.branch)
  assert.notEqual(gitCode(wt, 'cat-file', '-e', local), 0)
  assert.equal(git(repo, 'rev-parse', `refs/heads/${pr.branch}`), local)
})

test('prepareWorktree: refuses a git worktree of repo.path left by an earlier version, and leaves it and repo.path as they are', async (context) => {
  const { manifest, repo, pr } = fixture(context)
  const wt = worktreePath(manifest, pr)

  git(repo, 'worktree', 'add', '--quiet', '-b', pr.branch, wt, 'origin/main')
  writeFileSync(join(git(wt, 'rev-parse', '--absolute-git-dir'), 'rollout-ready'), '')
  writeFileSync(join(wt, 'draft.txt'), 'work in progress\n')

  await assert.rejects(prepareWorktree(manifest, pr), (error) => error.message.includes(wt))
  assert.ok(existsSync(join(wt, 'a.txt')))
  assert.equal(readFileSync(join(wt, 'draft.txt'), 'utf8'), 'work in progress\n')
  assert.equal(gitCode(repo, 'config', '--get', 'core.hooksPath'), 1)
})

test('removeWorktree deletes the clone and leaves the branches of repo.path as they were', async (context) => {
  const { manifest, repo, pr } = fixture(context)

  git(repo, 'branch', pr.branch)

  const branches = refs(repo, 'refs/heads/')
  const wt = await prepareWorktree(manifest, pr)

  await removeWorktree(manifest, pr)

  assert.equal(existsSync(wt), false)
  assert.deepEqual(refs(repo, 'refs/heads/'), branches)
})

test('removeWorktree also deletes the implementer home of the PR', async (context) => {
  const { manifest, pr } = fixture(context)
  const home = join(manifest.wtRoot, `${pr.id}.home`)

  await prepareWorktree(manifest, pr)
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'session.jsonl'), '{}\n')

  await removeWorktree(manifest, pr)

  assert.equal(existsSync(home), false)
})

// Every regular file under a mirror's objects, info/ aside, relative to objects/.
function objectFiles(objects) {
  return readdirSync(objects, { recursive: true }).filter((path) => !path.startsWith('info') && statSync(join(objects, path)).isFile())
}

test('a clone shares no object file with the mirror, so an agent cannot rewrite the mirror through a hard link', async (context) => {
  const { manifest, wt } = await started(context)
  const mirrorObjects = join(mirrorPath(manifest), 'objects')
  const cloneObjects = join(wt, '.git', 'objects')
  const shared = objectFiles(mirrorObjects).filter((path) => existsSync(join(cloneObjects, path)))

  assert.ok(shared.length > 0)

  for (const path of shared) {
    assert.notEqual(statSync(join(mirrorObjects, path)).ino, statSync(join(cloneObjects, path)).ino, path)
  }
})

test('a clone asks gh from PATH for credentials, after the empty helper that drops every other one', async (context) => {
  const { wt } = await started(context)
  const helpers = execFileSync('git', ['-C', wt, 'config', '--local', '--get-all', 'credential.helper'], { encoding: 'utf8' })

  assert.deepEqual(helpers.split('\n').slice(0, -1), ['', '!gh auth git-credential'])
})

test('rebaseWorktree rebases a clone onto the new base and pushes the head to the PR branch', async (context) => {
  const { manifest, origin, repo, pr, wt } = await started(context)
  const own = commit(wt, 'own.txt')

  git(wt, 'push', '--quiet', 'origin', `HEAD:refs/heads/${pr.branch}`)

  const base = mergeElsewhere(repo, 'b.txt')
  const rebased = await rebaseWorktree(manifest, pr, own)

  assert.equal(rebased.ok, true)
  assert.notEqual(rebased.head, own)
  assert.equal(git(origin, 'rev-parse', `refs/heads/${pr.branch}`), rebased.head)
  assert.equal(git(origin, 'rev-parse', `${rebased.head}^`), base)
})

function previewSetup(context) {
  return { ...fixture(context), pr: { id: 'A3', branch: 'feat/a3' } }
}

test('preparePreview: origin/main with each verified head merged in, detached, and the PR branch untouched', async (context) => {
  const { manifest, repo, pr } = previewSetup(context)
  const heads = [
    { id: 'A1', sha: pushBranch(repo, 'feat/a1', 'one.txt') },
    { id: 'A2', sha: pushBranch(repo, 'feat/a2', 'two.txt') },
  ]

  const wt = await preparePreview(manifest, pr, heads)

  assert.equal(wt, previewPath(manifest, pr))
  assert.ok(lstatSync(join(wt, '.git')).isDirectory())
  assert.ok(existsSync(join(wt, 'one.txt')) && existsSync(join(wt, 'two.txt')) && existsSync(join(wt, 'a.txt')))
  assert.equal(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD')
  assert.equal(git(wt, 'log', '-1', '--format=%s'), 'preview: A2 at ' + heads[1].sha.slice(0, 7))
  assert.equal(git(repo, 'branch', '--list', pr.branch), '')
  assert.throws(() => git(wt, 'push', '--quiet', 'origin', 'HEAD:refs/heads/feat/a3'), /no rollout-branch marker/)

  await removePreview(manifest, pr)
  assert.equal(existsSync(wt), false)
})

test('preparePreview: heads that conflict give null and leave no preview behind', async (context) => {
  const { manifest, repo, pr } = previewSetup(context)
  const heads = [
    { id: 'A1', sha: pushBranch(repo, 'feat/a1', 'same.txt', 'one\n') },
    { id: 'A2', sha: pushBranch(repo, 'feat/a2', 'same.txt', 'two\n') },
  ]

  assert.equal(await preparePreview(manifest, pr, heads), null)
  assert.equal(existsSync(previewPath(manifest, pr)), false)
  assert.equal(await preparePreview(manifest, pr, heads.slice(0, 1)), previewPath(manifest, pr))
})

test('repo.install runs with the environment of a read-only agent, in a new PR worktree and in a preview', async (context) => {
  const { dir, manifest, pr } = fixture(context)
  const installEnv = join(dir, 'install.env')
  const parent = {
    GH_TOKEN: 'synthetic-maintainer-token',
    NPM_TOKEN: 'synthetic-npm-token',
    NODE_AUTH_TOKEN: 'synthetic-node-auth-token',
    ROLLOUT_BRANCH: 'main',
    ROLLOUT_ID: 'Z9',
  }

  manifest.repo.install = `env > '${installEnv}'`
  manifest.repo.agentToken = join(dir, 'agent-token')
  manifest.repo.pushUrl = join(dir, 'origin.git')
  writeFileSync(manifest.repo.agentToken, 'synthetic-agent-token\n')

  for (const prepare of [() => prepareWorktree(manifest, pr), () => preparePreview(manifest, pr, [])]) {
    rmSync(installEnv, { force: true })
    await withProcessEnv(parent, prepare)

    const env = readEnvFile(installEnv)

    assert.equal(env.GH_TOKEN, 'synthetic-agent-token')
    assert.equal(env.NPM_TOKEN, '')
    assert.equal(env.NODE_AUTH_TOKEN, '')
    assert.equal(env.NPM_CONFIG_USERCONFIG, join(manifest.dir, '.npmrc-agents'))
    assert.equal(env.ROLLOUT_ROLE, 'install')
    assert.equal('ROLLOUT_BRANCH' in env, false)
    assert.equal('ROLLOUT_ID' in env, false)
  }
})

test('repo.install in a new clone runs in a container under the Docker runtime, with the clone mounted and no maintainer variable', async (context) => {
  const { dir, manifest, pr } = fixture(context)
  const { bin, calls } = fakeDocker(dir)
  const installEnv = join(dir, 'install.env')
  const tokenFile = join(dir, 'oauth-token')
  const parent = { GH_TOKEN: 'synthetic-maintainer-token', SYNTHETIC_MAINTAINER_SECRET: 'synthetic-secret', ROLLOUT_ID: 'Z9' }

  writeFileSync(tokenFile, 'synthetic-oauth-token\n', { mode: 0o600 })
  manifest.repo.install = `env > '${installEnv}'`
  manifest.repo.agentToken = join(dir, 'agent-token')
  manifest.repo.pushUrl = join(dir, 'origin.git')
  manifest.repo.pathPrepend = [bin]
  manifest.sandbox = {
    runtime: 'docker',
    image: 'rollout-agent:test',
    oauthTokenFile: tokenFile,
    allowedDomains: ['api.anthropic.com', 'github.com'],
    passEnv: [],
    memory: '4g',
    cpus: 2,
    pidsLimit: 512,
  }

  writeFileSync(manifest.repo.agentToken, 'synthetic-agent-token\n')

  const wt = await withProcessEnv(parent, () => prepareWorktree(manifest, pr))
  const runs = calls().filter((call) => call.args[0] === 'run')
  const env = readEnvFile(installEnv)

  assert.equal(runs.length, 1)

  const { args } = runs[0]

  assert.ok(args.includes(`${wt}:${wt}`))
  assert.equal(args[args.indexOf('-w') + 1], wt)
  assert.deepEqual(args.slice(args.indexOf('rollout-agent:test') + 1), ['sh', '-c', manifest.repo.install])
  assert.equal(env.ROLLOUT_ROLE, 'install')
  assert.equal(env.GH_TOKEN, 'synthetic-agent-token')
  assert.equal(env.NPM_CONFIG_USERCONFIG, '/etc/rollout/npmrc')
  assert.equal('SYNTHETIC_MAINTAINER_SECRET' in env, false)
  assert.equal('ROLLOUT_ID' in env, false)
  assert.ok(existsSync(join(wt, '.git', 'rollout-ready')))
})

const LOCAL_CONFIG = ['.claude/settings.json', '.claude/settings.local.json', 'CLAUDE.local.md']

// The clone's own excludesFile hides .claude/ from git status, like a global gitignore would.
async function ignoringClaude(context) {
  const setup = await started(context)
  const excludes = join(setup.dir, 'excludes')

  writeFileSync(excludes, '.claude/\n')
  git(setup.wt, 'config', 'core.excludesFile', excludes)

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
