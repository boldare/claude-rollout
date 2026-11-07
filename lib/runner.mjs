import { readOnlyEnv } from './identity.mjs'
import { sleptMs } from './machine.mjs'
import { commandRun, runtimeFor } from './sandbox.mjs'
import { children } from './spawn.mjs'

const TAIL_CHARS = 4000
const KILL_AFTER_MS = 5_000
const TICK_MS = 60_000

// Runs one pre-verify command with `sh -c` in the read-only agents'
// environment: it runs code from a worktree an agent wrote. Resolves with
// { exitCode, signal, timedOut, stopped, tail, seconds } however the command
// ends, a failed spawn included, and throws before anything runs when the
// environment cannot be built. The timeout counts awake time, like
// runAgent's, so a laptop that slept never fails a command.
export function runCommand(manifest, pr, { command, cwd, timeoutMs = 10 * 60_000 }) {
  const env = readOnlyEnv(manifest, 'gate')

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const interval = Math.min(timeoutMs, TICK_MS)
    const run = commandRun(pr, 'gate')
    const child = runtimeFor(manifest).start({
      command: 'sh',
      args: ['-c', command],
      cwd,
      env,
      role: 'gate',
      pr,
      run,
      stdin: 'ignore',
      group: true,
    })

    let closed = false
    let tail = ''
    let spawnError = null
    let timedOut = false
    let killTimer = null
    let lastReading = startedAt
    let awakeMs = 0

    // stopAllAgents stops it like an agent. After close the group may be gone
    // and its id taken by another process, so a late SIGKILL does nothing.
    const handle = {
      stopReason: null,
      kill(signal) {
        if (!closed) {
          child.kill(signal)
        }
      },
    }

    function keep(chunk) {
      tail = (tail + chunk).slice(-TAIL_CHARS)
    }

    // sh exiting does not end what it started in the background, so its exit
    // ends the group too, as a timeout does.
    function terminate() {
      child.kill('SIGTERM')

      if (killTimer) {
        return
      }

      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
        // A process that left the group can hold the pipes open, and close would never fire.
        child.stdout.destroy()
        child.stderr.destroy()
      }, KILL_AFTER_MS)
    }

    // The wall clock, not the timer, tells a sleep, as in runAgent.
    const ticker = setInterval(() => {
      const reading = Date.now()
      const gap = Math.max(0, reading - lastReading)

      lastReading = reading
      awakeMs += gap - sleptMs(gap, interval)

      if (awakeMs >= timeoutMs && !timedOut) {
        timedOut = true
        terminate()
      }
    }, interval)

    children.add(handle)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    child.on('exit', terminate)

    // Unhandled, a spawn error would kill the driver. Node still emits close afterwards.
    child.on('error', (error) => {
      spawnError = error
    })

    child.on('close', (code, signal) => {
      const started = Boolean(child.pid)

      closed = true
      children.delete(handle)
      clearInterval(ticker)
      clearTimeout(killTimer)
      resolve({
        exitCode: started ? code : null,
        signal: signal ?? null,
        timedOut,
        stopped: handle.stopReason === 'driver-stop',
        tail: started ? tail : String(spawnError?.message ?? ''),
        seconds: Math.round((Date.now() - startedAt) / 1000),
      })
    })
  })
}
