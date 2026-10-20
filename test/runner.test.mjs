import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManifest } from '../lib/manifest.mjs'
import { runCommand } from '../lib/runner.mjs'
import { children, stopAllAgents } from '../lib/spawn.mjs'
import { alive, makeRollout, readEnvFile, waitFor, withProcessEnv } from './fixtures.mjs'

// A background process a command starts writes its pid here.
const PID_FILE = 'pid'

function killLeftover(file) {
  if (!existsSync(file)) {
    return
  }

  try {
    process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL')
  } catch {
    // Already gone.
  }
}

// A manifest of a synthetic rollout and a working directory, removed after
// the test with any process a failed test left behind.
function setup(context) {
  const manifest = loadManifest(makeRollout())
  const cwd = mkdtempSync(join(tmpdir(), 'rollout-command-'))

  context.after(() => {
    killLeftover(join(cwd, PID_FILE))
    rmSync(cwd, { recursive: true, force: true })
  })

  return { manifest, pr: manifest.all[0], cwd }
}

function backgroundPid(cwd) {
  return Number(readFileSync(join(cwd, PID_FILE), 'utf8'))
}

async function timed(task) {
  const started = Date.now()
  const result = await task()

  return { result, ms: Date.now() - started }
}

test('runCommand: exit 0 and exit 3, with the output in the tail', async (context) => {
  const { manifest, pr, cwd } = setup(context)

  const { seconds, ...passed } = await runCommand(manifest, pr, { command: 'echo hello', cwd })

  assert.deepEqual(passed, { exitCode: 0, signal: null, timedOut: false, stopped: false, tail: 'hello\n' })
  assert.ok(Number.isInteger(seconds) && seconds <= 1, String(seconds))

  const failed = await runCommand(manifest, pr, { command: 'echo broken >&2; exit 3', cwd })

  assert.equal(failed.exitCode, 3)
  assert.equal(failed.signal, null)
  assert.equal(failed.tail, 'broken\n')
  assert.equal(children.size, 0)
})

test('runCommand: the tail keeps the last 4000 characters of stdout and stderr together, in arrival order', async (context) => {
  const { manifest, pr, cwd } = setup(context)
  const command = "echo first-on-stderr >&2; sleep 0.2; head -c 5000 /dev/zero | tr '\\0' a; sleep 0.2; echo last-on-stderr >&2"
  const result = await runCommand(manifest, pr, { command, cwd })

  assert.equal(result.exitCode, 0)
  assert.equal(result.tail.length, 4000)
  assert.equal(result.tail, `${'a'.repeat(3985)}last-on-stderr\n`)
})

test('runCommand: a timeout kills the command and its children, and says so', async (context) => {
  const { manifest, pr, cwd } = setup(context)
  const { result, ms } = await timed(() =>
    runCommand(manifest, pr, { command: `sleep 30 & echo $! > ${PID_FILE}; wait`, cwd, timeoutMs: 300 }),
  )

  assert.ok(ms < 5000, `${ms} ms`)
  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, null)
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(result.stopped, false)
  await waitFor(() => !alive(backgroundPid(cwd)), 'the background sleep to die')
})

test('runCommand: a background process the command leaves behind is killed when sh exits', async (context) => {
  const { manifest, pr, cwd } = setup(context)
  const { result, ms } = await timed(() => runCommand(manifest, pr, { command: `sleep 30 & echo $! > ${PID_FILE}`, cwd }))

  assert.ok(ms < 3000, `${ms} ms`)
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  await waitFor(() => !alive(backgroundPid(cwd)), 'the background sleep to die')
})

test('runCommand: a process that left the group and keeps the output open still lets the command end', async (context) => {
  const { manifest, pr, cwd } = setup(context)
  const script = join(cwd, 'escape.cjs')

  writeFileSync(
    script,
    [
      "const { spawn } = require('node:child_process')",
      "const child = spawn('sleep', ['30'], { detached: true, stdio: 'inherit' })",
      `require('node:fs').writeFileSync(${JSON.stringify(PID_FILE)}, String(child.pid))`,
      'child.unref()',
    ].join('\n'),
  )

  const { result, ms } = await timed(() => runCommand(manifest, pr, { command: `"${process.execPath}" escape.cjs`, cwd }))

  assert.equal(result.exitCode, 0)
  assert.ok(ms < 10_000, `${ms} ms`)
  assert.equal(children.size, 0)
})

test('runCommand: the command gets the read-only agents environment, with ROLLOUT_ROLE gate and no branch', async (context) => {
  const { manifest, pr, cwd } = setup(context)
  const parent = { GH_TOKEN: 'synthetic-maintainer-token', NPM_TOKEN: 'synthetic-npm-token', NODE_AUTH_TOKEN: 'synthetic-node-auth-token' }

  manifest.repo.agentToken = join(cwd, 'agent-token')
  writeFileSync(manifest.repo.agentToken, 'synthetic-agent-token\n')

  const result = await withProcessEnv(parent, () => runCommand(manifest, pr, { command: 'env > command.env', cwd }))
  const env = readEnvFile(join(cwd, 'command.env'))

  assert.equal(result.exitCode, 0)
  assert.equal(env.GH_TOKEN, 'synthetic-agent-token')
  assert.equal(env.NPM_TOKEN, '')
  assert.equal(env.NODE_AUTH_TOKEN, '')
  assert.equal(env.NPM_CONFIG_USERCONFIG, join(manifest.dir, '.npmrc-agents'))
  assert.equal(env.ROLLOUT_ROLE, 'gate')
  assert.equal(env.ROLLOUT_BRANCH, '')
  assert.equal(env.ROLLOUT_ID, pr.id)
})

test('runCommand: a missing repo.agentToken file throws before anything runs', (context) => {
  const { manifest, pr, cwd } = setup(context)

  manifest.repo.agentToken = join(cwd, 'no-such-token')

  assert.throws(() => runCommand(manifest, pr, { command: 'touch ran', cwd }), /repo\.agentToken .*no-such-token does not exist/)
  assert.equal(existsSync(join(cwd, 'ran')), false)
  assert.equal(children.size, 0)
})

test('runCommand: a command that cannot start resolves with no exit code and the error in the tail', async (context) => {
  const { manifest, pr, cwd } = setup(context)
  const result = await runCommand(manifest, pr, { command: 'true', cwd: join(cwd, 'missing') })

  assert.equal(result.exitCode, null)
  assert.equal(result.signal, null)
  assert.equal(result.timedOut, false)
  assert.match(result.tail, /ENOENT/)
  assert.equal(children.size, 0)
})

// Last: stopAllAgents also stops every runAgent this process would start.
test('runCommand: stopAllAgents ends a running command and its children, and the result says stopped', async (context) => {
  const { manifest, pr, cwd } = setup(context)
  const running = runCommand(manifest, pr, { command: `sleep 30 & echo $! > ${PID_FILE}; wait`, cwd })

  await waitFor(() => existsSync(join(cwd, PID_FILE)) && readFileSync(join(cwd, PID_FILE), 'utf8').trim(), 'the background sleep')
  assert.equal(children.size, 1)

  stopAllAgents()

  const result = await running

  assert.equal(result.stopped, true)
  assert.equal(result.timedOut, false)
  assert.equal(result.exitCode, null)
  assert.equal(children.size, 0)
  await waitFor(() => !alive(backgroundPid(cwd)), 'the background sleep to die')
})
