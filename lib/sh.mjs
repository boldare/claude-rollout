import { execFile } from 'node:child_process'
import { homedir } from 'node:os'

export function expandHome(path) {
  if (path === '~') {
    return homedir()
  }

  if (path.startsWith('~/')) {
    return `${homedir()}/${path.slice(2)}`
  }

  return path
}

// PATH for everything the driver and its agents run: the manifest decides
// which node, pnpm and gh win over whatever the parent shell had.
export function makeEnv(manifest, extra = {}) {
  const env = { ...process.env, ...extra }
  const prepend = manifest.repo.pathPrepend.map(expandHome)
  env.PATH = [...prepend, process.env.PATH].join(':')

  // A driver started from inside a Claude Code session must not make its
  // workers look like nested sessions.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT

  return env
}

const TIMEOUT_MS = 10 * 60_000

// execFile's error carries the exit code, or a string code when the command
// could not start at all (ENOENT).
function exitCode(error) {
  if (!error) {
    return 0
  }

  return typeof error.code === 'number' ? error.code : 1
}

export function sh(command, args, options = {}) {
  const { cwd, env, input, timeout = TIMEOUT_MS } = options

  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd, env, timeout, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = exitCode(error)
      // execFile sets killed only when it ended the child itself, and here only the timeout does that.
      const timedOut = error?.killed === true
      resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut })
    })

    if (input !== undefined) {
      child.stdin.end(input)
    }
  })
}

// Same as sh, but a non-zero exit is an error with the command's stderr.
// githubUnavailable reads "timed out" as an outage, so a kill for the
// timeout must say so.
export async function shOk(command, args, options = {}) {
  const result = await sh(command, args, options)

  if (result.code === 0) {
    return result.stdout
  }

  const shown = [command, ...args].join(' ').slice(0, 300)
  const output = result.stderr.trim() || result.stdout.trim()

  if (result.timedOut) {
    const seconds = (options.timeout ?? TIMEOUT_MS) / 1000
    const tail = output ? `: ${output}` : ''

    throw new Error(`${shown} timed out after ${seconds} s${tail}`)
  }

  throw new Error(`${shown} exited ${result.code}: ${output}`)
}
