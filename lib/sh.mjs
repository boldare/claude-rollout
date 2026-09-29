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
export function makeEnv(M, extra = {}) {
  const env = { ...process.env, ...extra }
  const prepend = M.repo.pathPrepend.map(expandHome)
  env.PATH = [...prepend, process.env.PATH].join(':')

  // A driver started from inside a Claude Code session must not make its
  // workers look like nested sessions.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_ENTRYPOINT

  return env
}

export function sh(command, args, options = {}) {
  const { cwd, env, input, timeout = 10 * 60_000 } = options

  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd, env, timeout, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })

    if (input !== undefined) {
      child.stdin.end(input)
    }
  })
}

// Same as sh, but a non-zero exit is an error with the command's stderr.
export async function shOk(command, args, options = {}) {
  const result = await sh(command, args, options)

  if (result.code !== 0) {
    const shown = [command, ...args].join(' ').slice(0, 300)
    throw new Error(`${shown} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`)
  }

  return result.stdout
}
