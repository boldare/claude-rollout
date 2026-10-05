import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { lockHolder, postCommand } from './ledger.mjs'
import { batteryWarning as readBatteryWarning } from './machine.mjs'

export const COMMANDS = ['pause', 'resume', 'unhalt', 'retry', 'note', 'hold', 'release', 'stop', 'start']

const PR_COMMANDS = ['retry', 'note', 'hold', 'release']
const GONE = ['ESRCH', 'EPERM']
const NO_DRIVER = { status: 409, body: { error: 'no driver is running' } }

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseCommand(manifest, body) {
  if (!plainObject(body)) {
    return { error: 'body must be a JSON object' }
  }

  const { cmd, id, text, dryRun = false } = body

  if (!COMMANDS.includes(cmd)) {
    return { error: `unknown command ${cmd}` }
  }

  if (cmd === 'start') {
    return typeof dryRun === 'boolean' ? { command: { cmd, dryRun } } : { error: 'dryRun must be a boolean' }
  }

  if (!PR_COMMANDS.includes(cmd)) {
    return { command: { cmd } }
  }

  if (typeof id !== 'string' || !manifest.all.some((pr) => pr.id === id)) {
    return { error: 'unknown or missing PR id' }
  }

  if (cmd !== 'note') {
    return { command: { cmd, id } }
  }

  if (typeof text !== 'string' || text.trim() === '') {
    return { error: 'note needs text' }
  }

  return { command: { cmd, id, text: text.trim() } }
}

// process.kill(0) signals the whole process group and process.kill(-1) every
// process of this user, and the lock is plain JSON. A lock that names this
// process is stale, because the UI server never holds a driver lock.
export function signalablePid(lock, ownPid = process.pid) {
  const pid = lock?.pid

  return Number.isInteger(pid) && pid > 1 && pid !== ownPid ? pid : null
}

export function stopDriver(manifest, stopping = new Map()) {
  const holder = lockHolder(manifest)

  if (!holder) {
    stopping.delete(manifest.dir)
    return NO_DRIVER
  }

  const pid = signalablePid(holder)

  if (pid === null) {
    return { status: 409, body: { error: 'driver.lock names no driver process' } }
  }

  // A second SIGTERM makes the driver exit at once, without waiting for its agents.
  if (stopping.get(manifest.dir) === pid) {
    return { status: 409, body: { error: `the driver (pid ${pid}) is already stopping` } }
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (GONE.includes(error.code)) {
      return NO_DRIVER
    }

    throw error
  }

  stopping.set(manifest.dir, pid)

  return { status: 202, body: { cmd: 'stop', pid } }
}

export function driverCommand(
  manifest,
  { dryRun = false, platform = process.platform, caffeinate = existsSync('/usr/bin/caffeinate') } = {},
) {
  const args = [join(manifest.home, 'bin', 'rollout.mjs'), 'run', '--dir', manifest.dir, ...(dryRun ? ['--dry-run'] : [])]

  if (platform === 'darwin' && caffeinate) {
    return { command: '/usr/bin/caffeinate', args: ['-is', process.execPath, ...args] }
  }

  return { command: process.execPath, args }
}

export function startDriver(manifest, { dryRun = false, command = driverCommand, batteryWarning = readBatteryWarning } = {}) {
  const holder = lockHolder(manifest)

  if (holder) {
    return Promise.resolve({ status: 409, body: { error: `a driver is already running (pid ${holder.pid})` } })
  }

  const log = join(manifest.dir, 'driver.log')
  const fd = openSync(log, 'a')
  let child

  try {
    const { command: executable, args } = command(manifest, { dryRun })
    child = spawn(executable, args, { cwd: manifest.dir, detached: true, stdio: ['ignore', fd, fd] })
    child.unref()
  } finally {
    closeSync(fd)
  }

  return new Promise((resolve) => {
    // Read after the spawn, so the lock check and the spawn stay one synchronous step.
    child.once('spawn', async () => {
      const warning = await batteryWarning()

      resolve({ status: 202, body: { cmd: 'start', pid: child.pid, dryRun, log, warning } })
    })

    child.on('error', (error) => resolve({ status: 500, body: { error: `cannot start the driver: ${error.message}` } }))
  })
}

export function runCommand(manifest, command, { driverCommand: launch = driverCommand, stopping, batteryWarning } = {}) {
  if (command.cmd === 'stop') {
    return stopDriver(manifest, stopping)
  }

  if (command.cmd === 'start') {
    return startDriver(manifest, { dryRun: command.dryRun, command: launch, batteryWarning })
  }

  return { status: 202, body: { cmd: command.cmd, queued: postCommand(manifest, command) } }
}
