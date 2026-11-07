import { execFileSync, spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { makeEnv, sh } from './sh.mjs'

export const DEFAULT_ALLOWED_DOMAINS = [
  'api.anthropic.com',
  'statsig.anthropic.com',
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'registry.npmjs.org',
]

// The part of the host runtime's environment a container gets.
const FROM_SPEC = [
  'GH_TOKEN',
  'GH_REPO',
  'GIT_TERMINAL_PROMPT',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'ROLLOUT_ROLE',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
  'CLAUDE_CODE_PROMPT_CACHE_TTL',
]

const IDENTITY = {
  'user.name': ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME'],
  'user.email': ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL'],
}

// sandbox.passEnv may name none of these, so a passed variable never
// replaces the bot's token or the container's paths.
export const RUNTIME_VARIABLES = [
  ...FROM_SPEC,
  'NPM_CONFIG_USERCONFIG',
  'CLAUDE_CODE_OAUTH_TOKEN',
  ...Object.values(IDENTITY).flat(),
  'HOME',
  'PATH',
  'TMPDIR',
  'HOST_UID',
  'HOST_GID',
  'ALLOWED_DOMAINS',
]

// For the root part of the entrypoint only. The agent runs with none.
const CAPABILITIES = ['NET_ADMIN', 'CHOWN', 'SETUID', 'SETGID', 'KILL', 'FOWNER', 'DAC_OVERRIDE']
const KEPT_HOMES = ['implement', 'fix']
const VERSION = /\d+\.\d+\.\d+/
const STOP_SECONDS = 10
const KILL_AFTER_MS = 5_000

export function runtimeFor(manifest) {
  return manifest.sandbox?.runtime === 'docker' ? dockerRuntime(manifest) : hostRuntime(manifest)
}

// A command's run name, unique like an agent's log name, for its container and its home.
export function commandRun(pr, role) {
  return `${pr.id}-${role}-${randomUUID().slice(0, 8)}`
}

// The command runs in its own process group. Killing only sh would leave its
// children running with the pipes open, and close would never fire.
function signalGroup(child, signal) {
  if (!child.pid) {
    return
  }

  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    // ESRCH: the group is gone. Anything else falls back to sh alone,
    // because a throw from a timer would stop the driver.
    if (error.code !== 'ESRCH') {
      child.kill(signal)
    }
  }
}

function groupHandle(child) {
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    stopReason: null,
    on(event, listener) {
      child.on(event, listener)

      return this
    },
    kill(signal = 'SIGTERM') {
      signalGroup(child, signal)
    },
  }
}

export function hostRuntime(manifest, { spawn = spawnProcess } = {}) {
  function start({ command, args, cwd, env, group }) {
    if (!group) {
      return spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    }

    return groupHandle(spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }))
  }

  return { name: 'host', claude: manifest.claudeBin, start }
}

function containerName(manifest, spec) {
  return `rollout-${manifest.rollout}-${spec.run}`.replace(/[^A-Za-z0-9_.-]/g, '-')
}

// The implementer's home outlives its runs, so a fix's --resume finds the session.
export function homePath(manifest, pr) {
  return join(manifest.wtRoot, `${pr.id}.home`)
}

// Every other run starts in an empty home of its own, so no read-only role
// or command ever reads what an implementer left in one.
export function homeFor(manifest, spec) {
  if (KEPT_HOMES.includes(spec.role)) {
    return homePath(manifest, spec.pr)
  }

  return join(manifest.wtRoot, 'homes', containerName(manifest, spec))
}

// spec.image and spec.names are resolved by start. A variable goes in by
// name only, so its value is never on the client's command line.
export function dockerArgs(manifest, spec) {
  const { sandbox } = manifest
  const variables = [
    `HOST_UID=${process.getuid()}`,
    `HOST_GID=${process.getgid()}`,
    `ALLOWED_DOMAINS=${sandbox.allowedDomains.join(' ')}`,
    `ROLLOUT_ENV=${spec.names.join(' ')}`,
    ...spec.names,
  ]

  const options = [
    ['run', '--rm', '--init', '--pull', 'never'],
    ['--name', containerName(manifest, spec)],
    ['--cap-drop', 'ALL'],
    ...CAPABILITIES.map((capability) => ['--cap-add', capability]),
    ['--security-opt', 'no-new-privileges=false'],
    ['--memory', sandbox.memory, '--cpus', String(sandbox.cpus), '--pids-limit', String(sandbox.pidsLimit)],
    spec.stdin === 'pipe' ? ['-i'] : [],
    ['-v', `${spec.cwd}:${spec.cwd}`],
    ['-v', `${manifest.home}:${manifest.home}:ro`],
    ['-v', `${homeFor(manifest, spec)}:/home/agent`],
    ['-w', spec.cwd],
    ...variables.map((variable) => ['-e', variable]),
    [spec.image, spec.command, ...spec.args],
  ]

  return options.flat()
}

function gitConfig(manifest, key) {
  try {
    const options = {
      cwd: manifest.repo.path,
      env: makeEnv(manifest),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }

    return execFileSync('git', ['config', key], options).trim()
  } catch {
    return ''
  }
}

// Without an identity git commit fails in the container.
const identities = new Map()

function gitIdentity(manifest) {
  const { path } = manifest.repo

  if (identities.has(path)) {
    return identities.get(path)
  }

  const identity = {}

  for (const [key, names] of Object.entries(IDENTITY)) {
    const value = gitConfig(manifest, key)

    for (const name of value ? names : []) {
      identity[name] = value
    }
  }

  identities.set(path, identity)

  return identity
}

export function containerEnv(manifest, spec) {
  const variables = {}

  for (const name of manifest.sandbox.passEnv) {
    if (process.env[name] !== undefined) {
      variables[name] = process.env[name]
    }
  }

  for (const name of FROM_SPEC) {
    if (spec.env?.[name] !== undefined) {
      variables[name] = spec.env[name]
    }
  }

  // An empty file in the image, so the runtime never writes into a home an agent controls.
  variables.NPM_CONFIG_USERCONFIG = '/etc/rollout/npmrc'

  // Read on every start, so a rotated token applies to the next run.
  if (manifest.sandbox.oauthTokenFile) {
    variables.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(manifest.sandbox.oauthTokenFile, 'utf8').trim()
  }

  return { ...variables, ...gitIdentity(manifest) }
}

// HOME holds the client's config and context, and DOCKER_* may name the daemon.
function clientEnv(manifest) {
  const env = { PATH: makeEnv(manifest).PATH }

  for (const [name, value] of Object.entries(process.env)) {
    if (name === 'HOME' || name.startsWith('DOCKER_')) {
      env[name] = value
    }
  }

  return env
}

// The container variables are in the client's environment, so that `-e NAME` finds them.
export function dockerEnv(manifest, spec) {
  return { ...clientEnv(manifest), ...containerEnv(manifest, spec) }
}

function versionOf(output) {
  return String(output).match(VERSION)?.[0] ?? null
}

function claudeVersion(manifest) {
  try {
    const options = { env: makeEnv(manifest), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }

    return versionOf(execFileSync(manifest.claudeBin, ['--version'], options))
  } catch {
    return null
  }
}

const versions = new Map()

// The default tag follows the host's claude, the version sandbox build pins into the image.
export function imageFor(manifest) {
  if (manifest.sandbox?.image) {
    return manifest.sandbox.image
  }

  if (!versions.has(manifest.claudeBin)) {
    const version = claudeVersion(manifest)

    if (!version) {
      throw new Error(
        `${manifest.claudeBin} --version printed no x.y.z version, so there is no default image: fix claudeBin or set sandbox.image`,
      )
    }

    versions.set(manifest.claudeBin, version)
  }

  return `rollout-agent:${versions.get(manifest.claudeBin)}`
}

// A refused start ends the way a failed spawn does, so runAgent and runCommand need no case of their own.
function failedStart(error) {
  const handle = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: new Writable({ write: (chunk, encoding, callback) => callback() }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stopReason: null,
    kill() {},
  })

  handle.stdout.end()
  handle.stderr.end()
  process.nextTick(() => {
    handle.emit('error', error)
    handle.emit('exit', null, null)
    handle.emit('close', null, null)
  })

  return handle
}

// The clone is the one mount an agent can write, so it is never the rollout directory, repo.path or the mirror.
function mountable(manifest, spec) {
  const id = String(spec.pr?.id ?? '')
  const allowed = [join(manifest.wtRoot, id), join(manifest.wtRoot, `${id}.brief`)]

  return id !== '' && allowed.includes(spec.cwd) && dirname(spec.cwd) === manifest.wtRoot
}

function prepare(manifest, spec) {
  if (!mountable(manifest, spec)) {
    throw new Error(`the Docker runtime mounts only the PR's clone or its brief preview under ${manifest.wtRoot}, not ${spec.cwd}`)
  }

  const image = imageFor(manifest)
  const variables = containerEnv(manifest, spec)
  const prepared = {
    name: containerName(manifest, spec),
    home: homeFor(manifest, spec),
    args: dockerArgs(manifest, { ...spec, image, names: Object.keys(variables) }),
    env: { ...clientEnv(manifest), ...variables },
  }

  mkdirSync(prepared.home, { recursive: true })

  return prepared
}

// A signal to the client alone does not reliably end the container, so it goes through the daemon.
function stopArgs(signal, name) {
  if (signal === 'SIGTERM') {
    return ['stop', '-t', String(STOP_SECONDS), name]
  }

  if (signal === 'SIGKILL') {
    return ['kill', name]
  }

  return ['kill', '--signal', signal, name]
}

function removeHome(spec, home) {
  if (!KEPT_HOMES.includes(spec.role)) {
    rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

function containerHandle(manifest, spec, prepared, spawn) {
  const child = spawn('docker', prepared.args, { cwd: spec.cwd, env: prepared.env, stdio: [spec.stdin, 'pipe', 'pipe'] })
  const handle = new EventEmitter()
  let exited = false
  let terminated = false

  // A container ended by a signal exits 128 plus its number, and callers expect the signal.
  function outcome(code, signal) {
    if (code === 137) {
      return [null, 'SIGKILL']
    }

    if (code === 143 && terminated) {
      return [null, 'SIGTERM']
    }

    return [code, signal]
  }

  // Runs in the background, and a failure is ignored: kill is called from timers.
  function kill(signal = 'SIGTERM') {
    if (exited || !child.pid) {
      return
    }

    terminated = terminated || signal === 'SIGTERM'

    try {
      spawn('docker', stopArgs(signal, prepared.name), { env: clientEnv(manifest), stdio: 'ignore' }).on('error', () => {})
    } catch {
      // Nothing to do: the next signal or the container's own end follows.
    }
  }

  child.on('error', (error) => handle.emit('error', error))

  child.on('exit', (code, signal) => {
    exited = true
    handle.emit('exit', ...outcome(code, signal))
  })

  child.on('close', (code, signal) => {
    exited = true
    removeHome(spec, prepared.home)
    handle.emit('close', ...outcome(code, signal))
  })

  return Object.assign(handle, { pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, stopReason: null, kill })
}

export function dockerRuntime(manifest, { spawn = spawnProcess } = {}) {
  // Never throws: whatever fails before docker runs reaches the caller as a failed start.
  function start(spec) {
    let prepared = null

    try {
      prepared = prepare(manifest, spec)

      return containerHandle(manifest, spec, prepared, spawn)
    } catch (error) {
      if (prepared) {
        removeHome(spec, prepared.home)
      }

      return failedStart(error)
    }
  }

  return { name: 'docker', claude: 'claude', start }
}

// One command through the runtime, with its whole output. Resolves however
// it ends and never rejects. A failed start has no code and its reason in stderr.
export function runOnce(manifest, spec, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let child

    try {
      child = runtimeFor(manifest).start(spec)
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: error.message, timedOut: false })

      return
    }

    let stdout = ''
    let stderr = ''
    let startError = null
    let timedOut = false
    let killTimer = null

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        child.kill('SIGKILL')
        // A process that left the group can hold the pipes open, and close would never fire.
        child.stdout.destroy()
        child.stderr.destroy()
      }, KILL_AFTER_MS)
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    // Unhandled, a spawn error would kill the driver. close still follows.
    child.on('error', (error) => {
      startError = error
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(killTimer)

      if (!child.pid) {
        resolve({ code: null, signal: null, stdout, stderr: String(startError?.message ?? stderr), timedOut })

        return
      }

      resolve({ code, signal: signal ?? null, stdout, stderr, timedOut })
    })
  })
}

async function hostVersion(tool, env) {
  const { stdout } = await sh(tool, ['--version'], { env, timeout: 30_000 })
  const version = versionOf(stdout)

  if (!version) {
    throw new Error(`${tool} --version printed no x.y.z version`)
  }

  return version
}

export async function buildImage(manifest, { stdio = 'inherit' } = {}) {
  const env = makeEnv(manifest)
  const claude = await hostVersion(manifest.claudeBin, env)
  const gh = await hostVersion('gh', env)
  const image = manifest.sandbox?.image ?? `rollout-agent:${claude}`
  const args = [
    'build',
    '--build-arg',
    `CLAUDE_VERSION=${claude}`,
    '--build-arg',
    `GH_VERSION=${gh}`,
    '-t',
    image,
    join(manifest.home, 'sandbox'),
  ]

  const code = await new Promise((resolve, reject) => {
    const child = spawnProcess('docker', args, { env, stdio })

    child.on('error', reject)
    child.on('close', resolve)
  })

  return { code, image }
}

export function runtimeSummary(manifest) {
  if (manifest.sandbox?.runtime !== 'docker') {
    return { runtime: 'host', image: null }
  }

  return { runtime: 'docker', image: imageFor(manifest) }
}

export function runtimeLine(summary) {
  return summary.runtime === 'docker' ? `runtime docker, image ${summary.image}` : 'runtime host'
}
