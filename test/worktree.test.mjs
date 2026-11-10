import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import {
  alignWorktree,
  inspectWorktree,
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
import { ghError } from '../lib/github.mjs'
import { fakeDocker, readEnvFile, waitFor, withProcessEnv } from './fixtures.mjs'

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

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

// A git for repo.pathPrepend, after fake-bin, that records each call in the
// fake's calls.jsonl and runs the real git. A fake container's PATH leaves it
// out, so git inside a container is never recorded as host git.
function loggingGit(dir, bin) {
  const wrapper = join(dir, 'host-git')
  const script = [
    '#!/usr/bin/env node',
    "const { appendFileSync } = require('node:fs')",
    "const { spawnSync } = require('node:child_process')",
    'const args = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(join(bin, 'calls.jsonl'))}, JSON.stringify({ tool: 'host-git', args }) + '\\n')`,
    `process.exitCode = spawnSync(${JSON.stringify(REAL_GIT)}, args, { stdio: 'inherit' }).status ?? 1`,
  ]

  mkdirSync(wrapper)
  writeFileSync(join(wrapper, 'git'), `${script.join('\n')}\n`, { mode: 0o755 })

  return wrapper
}

// The host git calls in the clone, after their -C <wt>, with paths and SHAs
// replaced by names.
function hostGitIn(calls, wt, names = {}) {
  const replacements = [[wt, '<wt>'], ...Object.entries(names).map(([name, path]) => [path, `<${name}>`])]
  const normalized = (arg) =>
    replacements.reduce((text, [path, name]) => text.replaceAll(path, name), arg).replace(/\b[0-9a-f]{40}\b/g, '<sha>')

  return calls
    .filter((call) => call.tool === 'host-git' && call.args[0] === '-C' && call.args[1] === wt)
    .map((call) => call.args.slice(2).map(normalized))
}

const IMAGE = 'rollout-agent:test'

const SANDBOX = {
  runtime: 'docker',
  image: IMAGE,
  oauthTokenFile: null,
  allowedDomains: ['api.anthropic.com', 'github.com'],
  passEnv: [],
  memory: '4g',
  cpus: 2,
  pidsLimit: 512,
}

function dockerRuns(calls) {
  return calls.filter((call) => call.tool === 'docker' && call.args[0] === 'run')
}

// Every value that follows the flag.
function values(args, flag) {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []))
}

// The argv a container runs, after the image.
function command(run) {
  return run.args.slice(run.args.indexOf(IMAGE) + 1)
}

// A ready clone made under the host runtime, then the Docker runtime, with
// host git recorded after the fake docker. A fake container gets none of
// gitEnvConfig's variables, so the clone's own config maps GitHub to the bare
// origin, and holds the identity and the signing for the rebase.
async function dockerClone(context) {
  const setup = fixture(context)
  const { dir, manifest, origin, pr } = setup
  const docker = fakeDocker(dir)

  manifest.repo.agentToken = join(dir, 'agent-token')
  manifest.repo.pushUrl = origin
  writeFileSync(manifest.repo.agentToken, 'synthetic-agent-token\n')

  const wt = await prepareWorktree(manifest, pr)

  git(wt, 'config', `url.${origin}.insteadOf`, GITHUB_URL)
  git(wt, 'config', 'user.name', 'Test')
  git(wt, 'config', 'user.email', 'test@example.com')
  git(wt, 'config', 'commit.gpgsign', 'false')
  manifest.repo.pathPrepend = [docker.bin, loggingGit(dir, docker.bin)]
  manifest.sandbox = { ...SANDBOX }

  return { ...setup, ...docker, wt }
}

// A hook that git runs on almost any command, outside the clone. It writes
// the HOME it ran with to the canary, then fails, so git goes on without it.
function plantFsmonitor(dir, wt) {
  const canary = join(dir, 'canary')
  const monitor = join(dir, 'fsmonitor')

  writeFileSync(monitor, `#!/bin/sh\necho "$HOME" >> '${canary}'\nexit 1\n`, { mode: 0o755 })
  execFileSync('git', ['config', '--file', join(wt, '.git', 'config'), 'core.fsmonitor', monitor])

  return canary
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

test('preparePreview never reuses a preview, so a hook or a file planted in the last one neither runs nor stays', async (context) => {
  const { dir, manifest, pr } = previewSetup(context)
  const first = await preparePreview(manifest, pr, [])
  const canary = plantFsmonitor(dir, first)

  writeFileSync(join(first, 'stray.txt'), 'left behind\n')

  const second = await preparePreview(manifest, pr, [])

  assert.equal(second, first)
  assert.equal(existsSync(canary), false)
  assert.equal(existsSync(join(second, 'stray.txt')), false)
  assert.equal(gitCode(second, 'config', '--get', 'core.fsmonitor'), 1)
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

test('repo.install in a new clone runs in a container under the Docker runtime, with the clone mounted and no maintainer variable, then the ready marker in a git container', async (context) => {
  const { dir, manifest, pr } = fixture(context)
  const { bin, calls } = fakeDocker(dir)
  const installEnv = join(dir, 'install.env')
  const tokenFile = join(dir, 'oauth-token')
  const parent = { GH_TOKEN: 'synthetic-maintainer-token', SYNTHETIC_MAINTAINER_SECRET: 'synthetic-secret', ROLLOUT_ID: 'Z9' }

  writeFileSync(tokenFile, 'synthetic-oauth-token\n', { mode: 0o600 })
  manifest.repo.install = `env > '${installEnv}'`
  manifest.repo.agentToken = join(dir, 'agent-token')
  manifest.repo.pushUrl = join(dir, 'origin.git')
  manifest.repo.pathPrepend = [bin, loggingGit(dir, bin)]
  manifest.sandbox = { ...SANDBOX, oauthTokenFile: tokenFile }

  writeFileSync(manifest.repo.agentToken, 'synthetic-agent-token\n')

  const wt = await withProcessEnv(parent, () => prepareWorktree(manifest, pr))
  const recorded = calls()
  const [install, ready, ...rest] = dockerRuns(recorded)
  const installed = recorded.indexOf(install)
  const env = readEnvFile(installEnv)

  assert.deepEqual(rest, [])
  assert.ok(install.args.includes(`${wt}:${wt}`))
  assert.deepEqual(values(install.args, '-w'), [wt])
  assert.deepEqual(command(install), ['sh', '-c', manifest.repo.install])
  assert.equal(env.ROLLOUT_ROLE, 'install')
  assert.equal(env.GH_TOKEN, 'synthetic-agent-token')
  assert.equal(env.NPM_CONFIG_USERCONFIG, '/etc/rollout/npmrc')
  assert.equal('SYNTHETIC_MAINTAINER_SECRET' in env, false)
  assert.equal('ROLLOUT_ID' in env, false)

  const [shell, flag, script, name, cloneWord, time] = command(ready)

  assert.deepEqual([shell, flag, name, cloneWord], ['sh', '-c', 'sh', wt])
  assert.match(script, /rollout-ready/)
  assert.match(values(ready.args, '--name')[0], /^rollout-demo-A1-git-[0-9a-f]{8}$/)
  assert.ok(ready.args.includes(`${wt}:${wt}`))
  assert.equal(readFileSync(join(wt, '.git', 'rollout-ready'), 'utf8'), time)
  assert.ok(hostGitIn(recorded.slice(0, installed), wt).length > 0)
  assert.deepEqual(hostGitIn(recorded.slice(installed + 1), wt), [])
})

// A container command that runs git in the clone: git -C <wt>, or a script
// that runs git -C "$1" with the clone as its first word.
function runsGitIn(args, wt) {
  if (args[0] === 'git') {
    return args[1] === '-C' && args[2] === wt
  }

  return args[0] === 'sh' && args[1] === '-c' && args[2].includes('git -C "$1"') && args[4] === wt
}

test('under the Docker runtime every git in a ready clone runs in a container over the clone, and none on the host', async (context) => {
  const { calls, manifest, pr, repo, wt } = await dockerClone(context)
  const head = git(wt, 'rev-parse', 'HEAD')

  async function rebase() {
    const own = commit(wt, 'own.txt')

    git(wt, 'push', '--quiet', 'origin', `HEAD:refs/heads/${pr.branch}`)
    mergeElsewhere(repo, 'b.txt')

    return rebaseWorktree(manifest, pr, own)
  }

  const steps = {
    prepareWorktree: () => prepareWorktree(manifest, pr),
    alignWorktree: () => alignWorktree(manifest, pr, head),
    inspectWorktree: () => inspectWorktree(manifest, pr),
    resetWorktree: () => resetWorktree(manifest, pr, head),
    rebaseWorktree: rebase,
  }

  const starts = {}

  for (const [name, step] of Object.entries(steps)) {
    const before = calls().length

    await step()

    const recorded = calls().slice(before)
    const runs = dockerRuns(recorded)

    starts[name] = runs.length
    assert.ok(runs.length > 0, name)
    assert.deepEqual(hostGitIn(recorded, wt), [], name)

    for (const run of runs) {
      assert.ok(values(run.args, '-v').includes(`${wt}:${wt}`), name)
      assert.ok(runsGitIn(command(run), wt), `${name}: ${command(run).join(' ')}`)
    }
  }

  assert.equal(starts.inspectWorktree, 1)
  assert.equal(git(wt, 'rev-parse', 'HEAD^'), git(repo, 'rev-parse', 'origin/main'))
})

test('inspectWorktree under the Docker runtime reads a dirty status and the head in one container', async (context) => {
  const { calls, manifest, pr, wt } = await dockerClone(context)
  const before = calls().length

  writeFileSync(join(wt, 'draft.txt'), 'work in progress\n')

  assert.deepEqual(await inspectWorktree(manifest, pr), { clean: false, status: '?? draft.txt', head: git(wt, 'rev-parse', 'HEAD') })
  assert.equal(dockerRuns(calls().slice(before)).length, 1)
})

test('a core.fsmonitor planted in a ready clone runs only inside containers, each in a home under homes/', async (context) => {
  const { dir, manifest, pr, wt } = await dockerClone(context)
  const head = git(wt, 'rev-parse', 'HEAD')
  const canary = plantFsmonitor(dir, wt)

  await prepareWorktree(manifest, pr)
  await alignWorktree(manifest, pr, head)
  await inspectWorktree(manifest, pr)

  const homes = readFileSync(canary, 'utf8').split('\n').filter(Boolean)

  assert.ok(homes.length > 0)

  for (const home of homes) {
    assert.ok(home.startsWith(`${join(manifest.wtRoot, 'homes')}/`), home)
  }
})

test('a rebase that conflicts under the Docker runtime returns the file and leaves no rebase in progress', async (context) => {
  const { manifest, pr, repo, wt } = await dockerClone(context)

  writeFileSync(join(wt, 'same.txt'), 'own\n')
  git(wt, 'add', 'same.txt')
  git(wt, 'commit', '--quiet', '-m', 'add same.txt')
  git(wt, 'push', '--quiet', 'origin', `HEAD:refs/heads/${pr.branch}`)
  pushBranch(repo, 'main', 'same.txt', 'base\n')

  const rebased = await rebaseWorktree(manifest, pr, git(wt, 'rev-parse', 'HEAD'))

  assert.equal(rebased.ok, false)
  assert.deepEqual(rebased.conflicts, ['same.txt'])
  assert.equal(existsSync(join(wt, '.git', 'rebase-merge')), false)
})

test('a git that fails in a container reads like shOk, so ghError finds what git printed', async (context) => {
  const { manifest, pr, wt } = await dockerClone(context)
  const missing = '0'.repeat(40)

  await assert.rejects(resetWorktree(manifest, pr, missing), (error) => {
    assert.ok(error.message.startsWith(`git -C ${wt} reset && clean exited 128: `), error.message)
    assert.match(ghError(error), /^fatal: /)

    return true
  })

  await assert.rejects(rebaseWorktree(manifest, pr, missing), (error) => {
    assert.ok(error.message.startsWith(`git -C ${wt} checkout --quiet -B ${pr.branch} ${missing} exited 128: `), error.message)
    assert.match(ghError(error), /^fatal: /)

    return true
  })
})

const GIT_CONTAINER_ENV = [
  'GH_TOKEN',
  'GIT_TERMINAL_PROMPT',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
]

test('a git container is named after the PR, starts in a fresh home that is gone after it, and gets only the bot token and the identity', async (context) => {
  const { calls, dir, manifest, pr } = await dockerClone(context)
  const tokenFile = join(dir, 'oauth-token')

  writeFileSync(tokenFile, 'synthetic-oauth-token\n', { mode: 0o600 })
  manifest.sandbox = { ...SANDBOX, oauthTokenFile: tokenFile, passEnv: ['SYNTHETIC_PASSED'] }

  const before = calls().length

  await withProcessEnv({ SYNTHETIC_PASSED: 'synthetic-passed-value' }, () => inspectWorktree(manifest, pr))

  const [run] = dockerRuns(calls().slice(before))
  const home = values(run.args, '-v')
    .map((volume) => volume.split(':'))
    .find((parts) => parts[1] === '/home/agent')[0]

  const names = values(run.args, '-e')
    .find((variable) => variable.startsWith('ROLLOUT_ENV='))
    .slice('ROLLOUT_ENV='.length)
    .split(' ')

  assert.match(values(run.args, '--name')[0], /^rollout-demo-A1-git-[0-9a-f]{8}$/)
  assert.ok(home.startsWith(`${join(manifest.wtRoot, 'homes')}/`), home)
  assert.ok(names.includes('GH_TOKEN'))

  for (const name of names) {
    assert.ok(GIT_CONTAINER_ENV.includes(name), name)
  }

  await waitFor(() => !existsSync(home), 'the home of the git container to be removed')
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

const REFRESH = [
  ['config', 'remote.origin.url', GITHUB_URL],
  ['config', 'core.hooksPath', '<home>/git-hooks'],
  ['config', '--unset-all', 'credential.helper'],
  ['config', '--add', 'credential.helper', ''],
  ['config', '--add', 'credential.helper', '!gh auth git-credential'],
  ['config', 'remote.origin.pushurl', '<origin>'],
  ['fetch', '--quiet', '--prune', 'origin'],
  ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feat/a1'],
]

// With no remote branch, a ready prepare checks whether the base moved.
const UNTOUCHED = [
  ['rev-parse', 'HEAD'],
  ['rev-parse', 'origin/main'],
]

const INSPECT = [
  ['status', '--porcelain'],
  ['rev-parse', 'HEAD'],
]

test('the host runtime runs the same git in a clone as before, from a new prepare to a rebase', async (context) => {
  const { dir, manifest, origin, repo, pr } = fixture(context)
  const { bin, calls } = fakeDocker(dir)
  const wt = worktreePath(manifest, pr)

  manifest.repo.agentToken = join(dir, 'agent-token')
  manifest.repo.pushUrl = origin
  manifest.repo.pathPrepend = [bin, loggingGit(dir, bin)]
  writeFileSync(manifest.repo.agentToken, 'synthetic-agent-token\n')

  await prepareWorktree(manifest, pr)
  await prepareWorktree(manifest, pr)

  const { head } = await inspectWorktree(manifest, pr)

  await alignWorktree(manifest, pr, head)
  await resetWorktree(manifest, pr, head)

  const own = commit(wt, 'own.txt')

  git(wt, 'push', '--quiet', 'origin', `HEAD:refs/heads/${pr.branch}`)
  mergeElsewhere(repo, 'b.txt')
  assert.equal((await rebaseWorktree(manifest, pr, own)).ok, true)

  assert.deepEqual(hostGitIn(calls(), wt, { origin, home: HOME.replace(/\/$/, '') }), [
    ...REFRESH,
    ['checkout', '--quiet', '-B', 'feat/a1', 'origin/main'],
    ['branch', '--unset-upstream'],
    ...REFRESH,
    ...UNTOUCHED,
    ...INSPECT,
    ...REFRESH,
    ...UNTOUCHED,
    ...INSPECT,
    ['reset', '--quiet', '--hard', '<sha>'],
    ['clean', '-fdq'],
    ...REFRESH,
    ['fetch', '--quiet', 'origin'],
    ['status', '--porcelain', '--untracked-files=no'],
    ['checkout', '--quiet', '-B', 'feat/a1', '<sha>'],
    ['rebase', 'origin/main'],
    ['push', '--force-with-lease=refs/heads/feat/a1:<sha>', 'origin', 'HEAD:refs/heads/feat/a1'],
    ['rev-parse', 'HEAD'],
  ])
})

const HOST_OPERATIONS = [
  ['writeFileSync', /\bwriteFileSync\b/],
  ['appendFileSync', /\bappendFileSync\b/],
  ['readFileSync', /\breadFileSync\b/],
  ['mkdirSync', /\bmkdirSync\b/],
  ['rmSync', /\brmSync\b/],
  ['rm', /\brm\(/],
  ['cpSync', /\bcpSync\b/],
  ['copyFileSync', /\bcopyFileSync\b/],
  ['openSync', /\bopenSync\b/],
  ['renameSync', /\brenameSync\b/],
  ['symlinkSync', /\bsymlinkSync\b/],
  ['chmodSync', /\bchmodSync\b/],
  ['createWriteStream', /\bcreateWriteStream\b/],
  ['execFile', /\bexecFile\b/],
  ['execFileSync', /\bexecFileSync\b/],
  ['spawn', /\bspawn\(/],
  ['sh', /\bsh\(/],
  ['shOk', /\bshOk\(/],
  ['git', /\bgit\(manifest,/],
  ['hostGit', /\bhostGit\(/],
]

const CLONE_PATHS = [/\bwt\b/, /\bworktreePath\(/, /\bpreviewPath\(/, /\bhomePath\(/, /\bwtRoot\b/]

// Where the driver may touch a clone from the host, all in lib/worktree.mjs:
// the clone of the mirror, host git itself, the two clones no code has run
// in yet, and the deletes, which follow no symlink.
const ALLOWED_TOUCHES = [
  ['cloneFromMirror', 'shOk'],
  ['hostGit', 'sh'],
  ['newClone', 'hostGit'],
  ['preparePreview', 'hostGit'],
  ['prepareWorktree', 'rm'],
  ['removeLocalConfig', 'rmSync'],
  ['removePreview', 'rm'],
  ['removeWorktree', 'rm'],
]

const TOP_LEVEL_FUNCTION = /^(?:export\s+)?(?:async\s+)?function\*?\s+([\w$]+)/

// Every line with a host operation and a clone path, with the top-level
// function above it. A declaration line only names the function.
function hostTouches(file, source) {
  const touches = []
  let name = null

  for (const [index, line] of source.split('\n').entries()) {
    const declared = line.match(TOP_LEVEL_FUNCTION)
    const text = line.trim()

    if (declared) {
      name = declared[1]
      continue
    }

    if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*') || !CLONE_PATHS.some((path) => path.test(line))) {
      continue
    }

    for (const [operation] of HOST_OPERATIONS.filter(([, pattern]) => pattern.test(line))) {
      touches.push({ file, line: index + 1, name, operation })
    }
  }

  return touches
}

function allowed(touch) {
  return (
    touch.file === 'lib/worktree.mjs' && ALLOWED_TOUCHES.some(([name, operation]) => touch.name === name && touch.operation === operation)
  )
}

function shown(touches) {
  return touches.map((touch) => `${touch.file}:${touch.line} ${touch.name} ${touch.operation}`)
}

test('host git and host file operations touch a clone only in the functions this test names', () => {
  const synthetic = [
    'async function refreshClone(manifest, pr, wt) {',
    "  writeFileSync(join(wt, '.git', 'rollout-branch'), branch)",
    "  await git(manifest, wt, ['status'])",
    '  const local = hostGit(manifest, wt)',
    '}',
    '',
    'async function newClone(manifest, pr, wt) {',
    '  const local = hostGit(manifest, wt)',
    "  writeFileSync(join(wt, '.git', 'rollout-branch'), branch)",
    "  // writeFileSync(join(wt, '.git', 'rollout-branch'), branch)",
    '}',
  ]

  assert.deepEqual(shown(hostTouches('lib/worktree.mjs', synthetic.join('\n')).filter((touch) => !allowed(touch))), [
    'lib/worktree.mjs:2 refreshClone writeFileSync',
    'lib/worktree.mjs:3 refreshClone git',
    'lib/worktree.mjs:4 refreshClone hostGit',
    'lib/worktree.mjs:9 newClone writeFileSync',
  ])

  const lib = join(HOME, 'lib')
  const files = readdirSync(lib).filter((file) => file.endsWith('.mjs'))
  const touches = files.flatMap((file) => hostTouches(`lib/${file}`, readFileSync(join(lib, file), 'utf8')))

  assert.deepEqual(shown(touches.filter((touch) => !allowed(touch))), [])

  for (const [name, operation] of ALLOWED_TOUCHES) {
    assert.ok(
      touches.some((touch) => touch.name === name && touch.operation === operation),
      `${name} ${operation} is allowed but never used`,
    )
  }
})
