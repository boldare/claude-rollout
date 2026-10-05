import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMANDS, driverCommand, parseCommand, signalablePid, startDriver, stopDriver } from '../lib/control.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { alive, makeRollout, waitFor } from './fixtures.mjs'

const IDLE = 'setInterval(() => {}, 1000)'
const TRAPS_SIGTERM = `process.on('SIGTERM', () => {}); console.log('ready'); ${IDLE}`

function demo(options = {}) {
  return loadManifest(makeRollout(options))
}

function writeLock(manifest, pid) {
  writeFileSync(join(manifest.dir, 'driver.lock'), JSON.stringify({ pid, at: new Date().toISOString() }))
}

// Only children spawned here are ever signalled: the maintainer's own driver may run on this machine.
async function child(context, script, stdio = 'ignore') {
  const spawned = spawn(process.execPath, ['-e', script], { stdio: ['ignore', stdio, 'ignore'] })

  context.after(() => spawned.kill('SIGKILL'))
  await once(spawned, 'spawn')

  return spawned
}

function readyLine(stream) {
  return new Promise((resolve) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      if (chunk.includes('ready')) {
        resolve()
      }
    })
  })
}

test('COMMANDS: the inbox commands, stop and start, without approve', () => {
  assert.deepEqual(COMMANDS, ['pause', 'resume', 'unhalt', 'retry', 'note', 'hold', 'release', 'stop', 'start'])
})

test('parseCommand: every command keeps only its own fields', () => {
  const manifest = demo()
  const extra = { sha: 'a1a1a1a', patchId: 'patch-a1', at: 'then' }
  const cases = [
    [{ cmd: 'pause', id: 'A1', ...extra }, { cmd: 'pause' }],
    [{ cmd: 'resume', ...extra }, { cmd: 'resume' }],
    [{ cmd: 'unhalt', text: 'x', ...extra }, { cmd: 'unhalt' }],
    [
      { cmd: 'retry', id: 'A2', text: 'x', ...extra },
      { cmd: 'retry', id: 'A2' },
    ],
    [
      { cmd: 'note', id: 'A1', text: '  use the old API  ', ...extra },
      { cmd: 'note', id: 'A1', text: 'use the old API' },
    ],
    [
      { cmd: 'hold', id: 'A3', ...extra },
      { cmd: 'hold', id: 'A3' },
    ],
    [
      { cmd: 'release', id: 'A1', ...extra },
      { cmd: 'release', id: 'A1' },
    ],
    [{ cmd: 'stop', id: 'A1', pid: 42, ...extra }, { cmd: 'stop' }],
    [
      { cmd: 'start', dryRun: true, ...extra },
      { cmd: 'start', dryRun: true },
    ],
    [{ cmd: 'start' }, { cmd: 'start', dryRun: false }],
  ]

  for (const [body, command] of cases) {
    assert.deepEqual(parseCommand(manifest, body), { command }, JSON.stringify(body))
  }
})

test('parseCommand: the errors', () => {
  const manifest = demo()
  const cases = [
    [null, 'body must be a JSON object'],
    [[], 'body must be a JSON object'],
    ['pause', 'body must be a JSON object'],
    [{ cmd: 'launch' }, 'unknown command launch'],
    [{ cmd: 'approve', id: 'A1', sha: 'a1a1a1a', patchId: 'patch-a1' }, 'unknown command approve'],
    [{}, 'unknown command undefined'],
    [{ cmd: 'hold' }, 'unknown or missing PR id'],
    [{ cmd: 'retry', id: 'Z9' }, 'unknown or missing PR id'],
    [{ cmd: 'release', id: ['A1'] }, 'unknown or missing PR id'],
    [{ cmd: 'note', id: 'Z9', text: 'hi' }, 'unknown or missing PR id'],
    [{ cmd: 'note', id: 'A1' }, 'note needs text'],
    [{ cmd: 'note', id: 'A1', text: ' \n\t ' }, 'note needs text'],
    [{ cmd: 'note', id: 'A1', text: 42 }, 'note needs text'],
    [{ cmd: 'start', dryRun: 'yes' }, 'dryRun must be a boolean'],
    [{ cmd: 'start', dryRun: 1 }, 'dryRun must be a boolean'],
    [{ cmd: 'start', dryRun: null }, 'dryRun must be a boolean'],
  ]

  for (const [body, error] of cases) {
    assert.deepEqual(parseCommand(manifest, body), { error }, JSON.stringify(body))
  }
})

test('signalablePid: only an integer above 1 that is not this process', () => {
  assert.equal(signalablePid({ pid: 4242 }, 1000), 4242)
  assert.equal(signalablePid({ pid: 4242 }), 4242)

  for (const pid of [0, 1, -1, -4242, 1.5, '42', null, undefined, Number.NaN]) {
    assert.equal(signalablePid({ pid }, 1000), null, String(pid))
  }

  assert.equal(signalablePid({ pid: process.pid }), null)
  assert.equal(signalablePid({ pid: 1000 }, 1000), null)
  assert.equal(signalablePid(null), null)
})

test('driverCommand: caffeinate on macOS when it exists, plain node otherwise', () => {
  const manifest = { home: 'home', dir: 'rollouts/demo' }
  const plain = [join('home', 'bin', 'rollout.mjs'), 'run', '--dir', 'rollouts/demo']

  assert.deepEqual(driverCommand(manifest, { platform: 'darwin', caffeinate: true }), {
    command: '/usr/bin/caffeinate',
    args: ['-is', process.execPath, ...plain],
  })

  assert.deepEqual(driverCommand(manifest, { dryRun: true, platform: 'darwin', caffeinate: true }), {
    command: '/usr/bin/caffeinate',
    args: ['-is', process.execPath, ...plain, '--dry-run'],
  })

  assert.deepEqual(driverCommand(manifest, { platform: 'darwin', caffeinate: false }), { command: process.execPath, args: plain })
  assert.deepEqual(driverCommand(manifest, { platform: 'linux', caffeinate: true }), { command: process.execPath, args: plain })
  assert.deepEqual(driverCommand(manifest, { dryRun: true, platform: 'linux', caffeinate: false }), {
    command: process.execPath,
    args: [...plain, '--dry-run'],
  })
})

test('stopDriver: one SIGTERM to the driver in the lock, then no driver is running', async (context) => {
  const manifest = demo({ lock: false })
  const driver = await child(context, IDLE)
  const stopping = new Map()

  writeLock(manifest, driver.pid)

  const exited = once(driver, 'exit')
  assert.deepEqual(stopDriver(manifest, stopping), { status: 202, body: { cmd: 'stop', pid: driver.pid } })
  assert.deepEqual(await exited, [null, 'SIGTERM'])
  assert.deepEqual(stopDriver(manifest, stopping), { status: 409, body: { error: 'no driver is running' } })
})

test('stopDriver: never a second SIGTERM to a driver that is still stopping', async (context) => {
  const manifest = demo({ lock: false })
  const driver = await child(context, TRAPS_SIGTERM, 'pipe')
  const stopping = new Map()

  await readyLine(driver.stdout)
  writeLock(manifest, driver.pid)

  assert.deepEqual(stopDriver(manifest, stopping), { status: 202, body: { cmd: 'stop', pid: driver.pid } })
  assert.deepEqual(stopDriver(manifest, stopping), { status: 409, body: { error: `the driver (pid ${driver.pid}) is already stopping` } })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(driver.exitCode, null)
  assert.equal(driver.signalCode, null)
  assert.ok(alive(driver.pid))
})

test('stopDriver: a lock naming this process or no lock signals nothing', () => {
  const manifest = demo()

  assert.deepEqual(stopDriver(manifest), { status: 409, body: { error: 'driver.lock names no driver process' } })

  const stopped = demo({ lock: false })
  assert.deepEqual(stopDriver(stopped), { status: 409, body: { error: 'no driver is running' } })
})

test('startDriver: spawns the command detached with its output in driver.log', async () => {
  const manifest = demo({ lock: false })
  const calls = []
  const command = (commandManifest, options) => {
    calls.push([commandManifest.dir, options])

    return { command: process.execPath, args: ['-e', "console.log('fake out'); console.error('fake err', process.cwd())"] }
  }

  const started = await startDriver(manifest, { dryRun: true, command, batteryWarning: async () => null })
  const log = join(manifest.dir, 'driver.log')

  assert.equal(started.status, 202)
  assert.ok(Number.isInteger(started.body.pid) && started.body.pid > 1)
  assert.deepEqual(started.body, { cmd: 'start', pid: started.body.pid, dryRun: true, log, warning: null })
  assert.deepEqual(calls, [[manifest.dir, { dryRun: true }]])

  await waitFor(() => existsSync(log) && /fake err/.test(readFileSync(log, 'utf8')), 'the fake driver output')

  const text = readFileSync(log, 'utf8')
  assert.match(text, /fake out/)
  assert.ok(text.includes(realpathSync(manifest.dir)), text)
})

test('startDriver: 409 while a driver holds the lock, 500 for a command that does not exist', async () => {
  const locked = demo()
  let called = false
  let warned = 0
  const batteryWarning = async () => {
    warned += 1

    return null
  }

  const refused = await startDriver(locked, {
    command: () => {
      called = true
      return { command: process.execPath, args: ['-e', ''] }
    },
    batteryWarning,
  })

  assert.deepEqual(refused, { status: 409, body: { error: `a driver is already running (pid ${process.pid})` } })
  assert.equal(called, false)

  const manifest = demo({ lock: false })
  const missing = await startDriver(manifest, {
    command: () => ({ command: join(manifest.dir, 'no-such-driver'), args: [] }),
    batteryWarning,
  })

  assert.equal(missing.status, 500)
  assert.match(missing.body.error, /^cannot start the driver: .*ENOENT/)
  assert.equal(warned, 0)
})
