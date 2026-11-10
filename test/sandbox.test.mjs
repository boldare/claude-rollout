import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { loadManifest } from '../lib/manifest.mjs'
import { BOUNDARY_PROBES, boundaryProof, liveGuardTest, runtimeCheck } from '../lib/preflight.mjs'
import { runCommand } from '../lib/runner.mjs'
import {
  buildImage,
  containerEnv,
  DEFAULT_ALLOWED_DOMAINS,
  dockerArgs,
  dockerEnv,
  dockerRuntime,
  homePath,
  hostRuntime,
  imageFor,
  runtimeFor,
  runtimeLine,
  runtimeSummary,
} from '../lib/sandbox.mjs'
import { runAgent, stopAllAgents } from '../lib/spawn.mjs'
import { mirrorPath } from '../lib/worktree.mjs'
import { fakeDocker, jsonLines, makeRollout, readEnvFile, waitFor, withProcessEnv } from './fixtures.mjs'

const BIN = fileURLToPath(new URL('../bin/rollout.mjs', import.meta.url))
const IMAGE = 'rollout-agent:test'
const BOT_TOKEN = 'synthetic-agent-token'
const OAUTH_TOKEN = 'synthetic-oauth-token'
const PASSED = 'synthetic-passed-value'
const CAPABILITIES = ['NET_ADMIN', 'CHOWN', 'SETUID', 'SETGID', 'KILL', 'FOWNER', 'DAC_OVERRIDE']

const STREAM = [
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 'session-1' },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.5,
    session_id: 'session-1',
    structured_output: { status: 'READY' },
  },
]

function editManifest(dir, edit) {
  const file = join(dir, 'manifest.yaml')

  writeFileSync(file, stringify(edit(parse(readFileSync(file, 'utf8')))))
}

// A rollout under the Docker runtime: the bot's token, an OAuth token file
// of mode 600 named relative to the rollout, the fake docker first on PATH,
// and the clone of A1 that every container run needs. The image is pinned,
// so no test runs the claude of the machine, unless pinned is false.
function dockerRollout(sandbox = {}, { pinned = true } = {}) {
  const dir = makeRollout()
  const agentToken = join(dir, 'agent-token')
  const image = pinned ? { image: IMAGE } : {}

  writeFileSync(agentToken, `${BOT_TOKEN}\n`)
  writeFileSync(join(dir, 'oauth-token'), `${OAUTH_TOKEN}\n`)
  chmodSync(join(dir, 'oauth-token'), 0o600)
  editManifest(dir, (raw) => ({
    ...raw,
    repo: { ...raw.repo, agentToken },
    sandbox: { runtime: 'docker', oauthTokenFile: 'oauth-token', ...image, ...sandbox },
  }))

  const docker = fakeDocker(dir)
  const manifest = loadManifest(dir)
  const clone = join(manifest.wtRoot, 'A1')

  mkdirSync(clone, { recursive: true })

  return { dir, docker, manifest, pr: manifest.all[0], clone }
}

// The only claude on the PATH a container gets.
function fakeClaude(docker, script) {
  writeFileSync(join(docker.bin, 'claude'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
}

function agentRun(manifest, role, logName) {
  return runAgent(manifest, manifest.all[0], {
    role,
    prompt: 'unused',
    effort: 'high',
    sessionId: '00000000-0000-4000-8000-000000000000',
    resume: false,
    cwd: join(manifest.wtRoot, 'A1'),
    logName,
  })
}

function runs(docker) {
  return docker.calls().filter((call) => call.tool === 'docker' && call.args[0] === 'run')
}

// Every value that follows the flag.
function values(args, flag) {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []))
}

function startEvents(handle) {
  return new Promise((resolve) => {
    const seen = []

    handle.on('error', (error) => seen.push(['error', error.message]))
    handle.on('exit', (code, signal) => seen.push(['exit', code, signal]))
    handle.on('close', (code, signal) => {
      seen.push(['close', code, signal])
      resolve(seen)
    })
  })
}

// Host claude and gh that print the versions sandbox build pins.
function versionTools(dir, bin) {
  const claude = join(dir, 'version-claude')

  writeFileSync(claude, "#!/bin/sh\necho '2.1.309 (Claude Code)'\n", { mode: 0o755 })
  writeFileSync(join(bin, 'gh'), "#!/bin/sh\necho 'gh version 2.103.3 (2026-10-26)'\n", { mode: 0o755 })

  return claude
}

function cliEnv() {
  const env = { ...process.env }

  delete env.ROLLOUT_ROLE
  delete env.ROLLOUT_ROOT
  delete env.ROLLOUT_DIR

  return env
}

function cli(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: cliEnv(), timeout: 20_000 })
}

test('runtimeFor: the host for the default and for a manifest without sandbox, docker under runtime docker', () => {
  const manifest = loadManifest(makeRollout())
  const { sandbox: _, ...bare } = manifest
  const docker = dockerRollout().manifest

  assert.equal(runtimeFor(manifest).name, 'host')
  assert.equal(runtimeFor(manifest).claude, manifest.claudeBin)
  assert.equal(runtimeFor(bare).name, 'host')
  assert.equal(runtimeFor(docker).name, 'docker')
  assert.equal(runtimeFor(docker).claude, 'claude')
})

test('the host runtime spawns an agent and a command exactly as runAgent and runCommand did', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const calls = []
  const env = { PATH: 'synthetic-path' }
  const cwd = join(manifest.wtRoot, pr.id)

  function spy(...call) {
    calls.push(call)

    return Object.assign(new EventEmitter(), { pid: 4242, stdin: null, stdout: null, stderr: null })
  }

  const runtime = hostRuntime(manifest, { spawn: spy })
  const agent = runtime.start({
    command: runtime.claude,
    args: ['-p'],
    cwd,
    env,
    role: 'implement',
    pr,
    run: 'A1-01-implement',
    stdin: 'pipe',
  })

  const command = runtime.start({
    command: 'sh',
    args: ['-c', 'npm test'],
    cwd,
    env,
    role: 'gate',
    pr,
    run: 'A1-gate-0123abcd',
    stdin: 'ignore',
    group: true,
  })

  assert.deepEqual(calls, [
    [manifest.claudeBin, ['-p'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }],
    ['sh', ['-c', 'npm test'], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }],
  ])

  assert.ok(agent instanceof EventEmitter)
  assert.equal(command.pid, 4242)
})

test('dockerArgs for an implement run: the clone, the skill read-only and the kept home, limits, and no value on the command line', async () => {
  const { manifest, pr, clone } = dockerRollout({ passEnv: ['SYNTHETIC_PASSED'] })
  const spec = {
    command: 'claude',
    args: ['-p', '--model', 'opus'],
    cwd: clone,
    env: { GH_TOKEN: BOT_TOKEN, ROLLOUT_ROLE: 'implement' },
    role: 'implement',
    pr,
    run: 'A1-01-implement',
    stdin: 'pipe',
  }

  const names = await withProcessEnv({ SYNTHETIC_PASSED: PASSED }, () => Object.keys(containerEnv(manifest, spec)))
  const args = dockerArgs(manifest, { ...spec, image: 'rollout-agent:test', names })
  const image = args.indexOf('rollout-agent:test')
  const sources = values(args, '-v').map((volume) => volume.split(':')[0])

  assert.deepEqual(args.slice(0, 5), ['run', '--rm', '--init', '--pull', 'never'])
  assert.deepEqual(values(args, '--name'), ['rollout-demo-A1-01-implement'])
  assert.deepEqual(values(args, '-v'), [
    `${clone}:${clone}`,
    `${manifest.home}:${manifest.home}:ro`,
    `${manifest.wtRoot}/A1.home:/home/agent`,
  ])

  assert.deepEqual(values(args, '-w'), [clone])
  assert.deepEqual(values(args, '--cap-drop'), ['ALL'])
  assert.deepEqual(values(args, '--cap-add'), CAPABILITIES)
  assert.deepEqual(values(args, '--security-opt'), ['no-new-privileges=false'])
  assert.deepEqual([values(args, '--memory'), values(args, '--cpus'), values(args, '--pids-limit')], [['4g'], ['2'], ['512']])
  assert.ok(args.includes('-i'))
  assert.deepEqual(args.slice(image), ['rollout-agent:test', 'claude', '-p', '--model', 'opus'])
  assert.ok(names.includes('SYNTHETIC_PASSED') && names.includes('GH_TOKEN') && names.includes('CLAUDE_CODE_OAUTH_TOKEN'))

  assert.deepEqual(values(args, '-e'), [
    `HOST_UID=${process.getuid()}`,
    `HOST_GID=${process.getgid()}`,
    `ALLOWED_DOMAINS=${DEFAULT_ALLOWED_DOMAINS.join(' ')}`,
    `ROLLOUT_ENV=${names.join(' ')}`,
    ...names,
  ])

  for (const source of sources) {
    for (const outside of [manifest.dir, manifest.repo.path]) {
      assert.notEqual(source, outside)
      assert.equal(source.startsWith(`${outside}/`), false, source)
    }
  }

  for (const arg of args) {
    assert.equal(arg.includes('ROLLOUT_FIREWALL'), false, arg)

    for (const secret of [BOT_TOKEN, OAUTH_TOKEN, PASSED]) {
      assert.equal(arg.includes(secret), false, arg)
    }
  }
})

test('dockerArgs: a verify run gets a fresh home under homes/, and a command no -i', () => {
  const { manifest, pr, clone } = dockerRollout()
  const base = { command: 'sh', args: ['-c', 'npm test'], cwd: clone, env: {}, pr, image: 'rollout-agent:test', names: [] }
  const verify = dockerArgs(manifest, { ...base, role: 'verify', run: 'A1-02-verify', stdin: 'pipe' })
  const gate = dockerArgs(manifest, { ...base, role: 'gate', run: 'A1-gate-0123abcd', stdin: 'ignore', group: true })

  assert.equal(values(verify, '-v')[2], `${manifest.wtRoot}/homes/rollout-demo-A1-02-verify:/home/agent`)
  assert.equal(values(gate, '-v')[2], `${manifest.wtRoot}/homes/rollout-demo-A1-gate-0123abcd:/home/agent`)
  assert.equal(gate.includes('-i'), false)
})

test('containerEnv and dockerEnv: passEnv and the runtime variables reach them, nothing else of the driver does', async () => {
  const { manifest, pr, clone } = dockerRollout({ passEnv: ['SYNTHETIC_PASSED'] })
  const spec = {
    command: 'sh',
    args: ['-c', 'true'],
    cwd: clone,
    env: {
      GH_TOKEN: BOT_TOKEN,
      GITHUB_TOKEN: '',
      GH_CONFIG_DIR: join(manifest.dir, '.gh-agents'),
      GH_REPO: 'github.com/example/widgets',
      NPM_TOKEN: '',
      NPM_CONFIG_USERCONFIG: join(manifest.dir, '.npmrc-agents'),
      ROLLOUT_ROLE: 'gate',
      PATH: 'synthetic-path',
      HOME: 'synthetic-home',
      SYNTHETIC_DRIVER_SECRET: 'synthetic-secret',
    },
    role: 'gate',
    pr,
    run: 'A1-gate-0123abcd',
    stdin: 'ignore',
    group: true,
  }

  const parent = { SYNTHETIC_PASSED: PASSED, SYNTHETIC_DRIVER_SECRET: 'synthetic-secret', DOCKER_HOST: 'tcp://docker.example:2376' }
  const { container, client } = await withProcessEnv(parent, () => ({
    container: containerEnv(manifest, spec),
    client: dockerEnv(manifest, spec),
  }))

  assert.equal(container.SYNTHETIC_PASSED, PASSED)
  assert.equal(container.GH_TOKEN, BOT_TOKEN)
  assert.equal(container.GH_REPO, 'github.com/example/widgets')
  assert.equal(container.NPM_TOKEN, '')
  assert.equal(container.ROLLOUT_ROLE, 'gate')
  assert.equal(container.NPM_CONFIG_USERCONFIG, '/etc/rollout/npmrc')
  assert.equal(container.CLAUDE_CODE_OAUTH_TOKEN, OAUTH_TOKEN)

  for (const name of ['SYNTHETIC_DRIVER_SECRET', 'GITHUB_TOKEN', 'GH_CONFIG_DIR', 'PATH', 'HOME', 'DOCKER_HOST']) {
    assert.equal(name in container, false, name)
  }

  assert.equal(client.DOCKER_HOST, 'tcp://docker.example:2376')
  assert.equal(client.SYNTHETIC_PASSED, PASSED)
  assert.equal('SYNTHETIC_DRIVER_SECRET' in client, false)
  assert.ok(client.PATH.startsWith(join(manifest.dir, 'fake-bin')))

  for (const name of Object.keys(client)) {
    assert.ok(['PATH', 'HOME'].includes(name) || name.startsWith('DOCKER_') || name in container, name)
  }
})

test('containerEnv for a git container: the bot token, the prompt switch and the identity, nothing else of the spec or passEnv, and no token file read', async () => {
  const { dir, manifest, pr, clone } = dockerRollout({ passEnv: ['SYNTHETIC_PASSED'] })
  const spec = {
    command: 'git',
    args: ['-C', clone, 'status', '--porcelain'],
    cwd: clone,
    env: {
      GH_TOKEN: BOT_TOKEN,
      GITHUB_TOKEN: '',
      GH_CONFIG_DIR: join(manifest.dir, '.gh-agents'),
      GIT_TERMINAL_PROMPT: '0',
      GH_REPO: 'github.com/example/widgets',
      NPM_TOKEN: '',
      ROLLOUT_ROLE: 'gate',
      PATH: 'synthetic-path',
      SYNTHETIC_MAINTAINER_SECRET: 'synthetic-secret',
    },
    role: 'git',
    pr,
    run: 'A1-git-0123abcd',
    stdin: 'ignore',
    group: true,
  }

  const parent = {
    SYNTHETIC_PASSED: PASSED,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Demo Maintainer',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'maintainer@example.com',
  }

  rmSync(join(dir, 'oauth-token'))

  const container = await withProcessEnv(parent, () => containerEnv(manifest, spec))

  assert.deepEqual(container, {
    GH_TOKEN: BOT_TOKEN,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Demo Maintainer',
    GIT_COMMITTER_NAME: 'Demo Maintainer',
    GIT_AUTHOR_EMAIL: 'maintainer@example.com',
    GIT_COMMITTER_EMAIL: 'maintainer@example.com',
  })

  assert.throws(() => containerEnv(manifest, { ...spec, role: 'gate' }), /ENOENT/)
})

test('the Docker runtime refuses any cwd but the clone and the preview: error, then close, and docker never runs', async () => {
  const { docker, manifest, pr } = dockerRollout()
  const outside = [
    manifest.dir,
    manifest.repo.path,
    join(manifest.wtRoot, 'mirror.git'),
    manifest.wtRoot,
    join(manifest.wtRoot, 'A1', 'src'),
  ]

  for (const cwd of outside) {
    for (const role of ['implement', 'gate']) {
      const handle = dockerRuntime(manifest).start({
        command: 'claude',
        args: [],
        cwd,
        env: {},
        role,
        pr,
        run: `A1-${role}-refused`,
        stdin: 'pipe',
      })

      const seen = await startEvents(handle)

      assert.equal(handle.pid, undefined)
      assert.equal(seen[0][0], 'error')
      assert.match(seen[0][1], /mounts only the PR's clone or its brief preview/)
      assert.deepEqual(seen.slice(1), [
        ['exit', null, null],
        ['close', null, null],
      ])

      handle.stdin.end('accepted and dropped')
    }
  }

  assert.deepEqual(runs(docker), [])
  assert.equal(existsSync(homePath(manifest, pr)), false)
  assert.equal(existsSync(join(manifest.wtRoot, 'homes')), false)
})

test('runAgent under Docker writes its log, resolves ok, and claude sees the bot token, the OAuth token and no maintainer variable', async () => {
  const { dir, docker, manifest, clone } = dockerRollout()
  const envFile = join(dir, 'claude.env')
  const stream = join(dir, 'stream.jsonl')
  const maintainer = { GH_TOKEN: 'synthetic-maintainer-token', SYNTHETIC_MAINTAINER_SECRET: 'synthetic-secret' }

  writeFileSync(stream, `${jsonLines(STREAM)}\n`)
  fakeClaude(docker, `env > '${envFile}'\ncat '${stream}'`)

  const result = await withProcessEnv(maintainer, () => agentRun(manifest, 'implement', 'A1-05-implement'))
  const env = readEnvFile(envFile)
  const [run] = runs(docker)

  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.output, { status: 'READY' })
  assert.match(readFileSync(join(manifest.dir, 'logs', 'A1-05-implement.jsonl'), 'utf8'), /"structured_output"/)
  assert.equal(env.GH_TOKEN, BOT_TOKEN)
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH_TOKEN)
  assert.equal(env.ROLLOUT_ROLE, 'implement')
  assert.equal(env.HOME, homePath(manifest, manifest.all[0]))
  assert.equal('SYNTHETIC_MAINTAINER_SECRET' in env, false)
  assert.deepEqual(values(run.args, '-w'), [clone])
  assert.deepEqual(run.args.slice(run.args.indexOf(IMAGE), run.args.indexOf(IMAGE) + 3), [IMAGE, 'claude', '-p'])
})

test('a verify run under Docker starts in an empty home of its own, which is gone after the run', async () => {
  const { dir, docker, manifest } = dockerRollout()
  const homeFile = join(dir, 'home.txt')

  fakeClaude(docker, `echo "$HOME" > '${homeFile}'\nls -A "$HOME" >> '${homeFile}'\ntouch "$HOME/left-behind"`)

  await agentRun(manifest, 'verify', 'A1-07-verify')

  const home = join(manifest.wtRoot, 'homes', 'rollout-demo-A1-07-verify')

  assert.equal(readFileSync(homeFile, 'utf8'), `${home}\n`)
  await waitFor(() => !existsSync(home), 'the fresh home to be removed')
})

test('runCommand under Docker: the exit code and the tail, and an exit of 137 reads as SIGKILL', async () => {
  const { docker, manifest, pr, clone } = dockerRollout()
  const { seconds, ...passed } = await runCommand(manifest, pr, { command: 'echo hello', cwd: clone })

  assert.deepEqual(passed, { exitCode: 0, signal: null, timedOut: false, stopped: false, tail: 'hello\n' })
  assert.ok(Number.isInteger(seconds))

  const failed = await runCommand(manifest, pr, { command: 'echo broken >&2; exit 3', cwd: clone })

  assert.equal(failed.exitCode, 3)
  assert.equal(failed.signal, null)
  assert.equal(failed.tail, 'broken\n')

  const killed = await runCommand(manifest, pr, { command: 'exit 137', cwd: clone })

  assert.equal(killed.exitCode, null)
  assert.equal(killed.signal, 'SIGKILL')

  for (const [i, command] of ['echo hello', 'echo broken >&2; exit 3', 'exit 137'].entries()) {
    const { args } = runs(docker)[i]

    assert.deepEqual(args.slice(-4), [IMAGE, 'sh', '-c', command])
    assert.deepEqual(values(args, '-w'), [clone])
    assert.match(values(args, '--name')[0], /^rollout-demo-A1-gate-[0-9a-f]{8}$/)
  }
})

test('imageFor: sandbox.image without running claude, else rollout-agent tagged with the version of the host claude', () => {
  const { dir, manifest } = dockerRollout({ image: 'rollout-agent:pinned' })
  const calls = join(dir, 'claude-calls')
  const claude = join(dir, 'counting-claude')

  writeFileSync(claude, `#!/bin/sh\necho "$@" >> '${calls}'\necho '2.1.309 (Claude Code)'\n`, { mode: 0o755 })
  manifest.claudeBin = claude

  assert.equal(imageFor(manifest), 'rollout-agent:pinned')
  assert.equal(existsSync(calls), false)

  manifest.sandbox.image = null

  assert.equal(imageFor(manifest), 'rollout-agent:2.1.309')
  assert.equal(imageFor(manifest), 'rollout-agent:2.1.309')
  assert.equal(readFileSync(calls, 'utf8'), '--version\n')

  manifest.claudeBin = join(dir, 'no-such-claude')

  assert.throws(
    () => imageFor(manifest),
    (error) => error.message.includes(manifest.claudeBin) && error.message.includes('sandbox.image'),
  )
})

test('buildImage: docker build of sandbox/ with the host versions of claude and gh, tagged after claude', async () => {
  const { dir, docker, manifest } = dockerRollout({}, { pinned: false })

  manifest.claudeBin = versionTools(dir, docker.bin)

  assert.deepEqual(await buildImage(manifest, { stdio: 'ignore' }), { code: 0, image: 'rollout-agent:2.1.309' })
  assert.deepEqual(docker.calls().at(-1).args, [
    'build',
    '--build-arg',
    'CLAUDE_VERSION=2.1.309',
    '--build-arg',
    'GH_VERSION=2.103.3',
    '-t',
    'rollout-agent:2.1.309',
    join(manifest.home, 'sandbox'),
  ])

  manifest.claudeBin = join(dir, 'no-such-claude')
  await assert.rejects(buildImage(manifest, { stdio: 'ignore' }), /no-such-claude --version printed no x\.y\.z version/)
})

test('the CLI: sandbox build under either runtime, and an unknown sandbox command', () => {
  const host = makeRollout()
  const docker = dockerRollout({}, { pinned: false })

  for (const dir of [host, docker.dir]) {
    const { bin, calls } = fakeDocker(dir)
    const claudeBin = versionTools(dir, bin)

    editManifest(dir, (raw) => ({ ...raw, claudeBin }))

    const built = cli('sandbox', 'build', '--dir', dir)

    assert.equal(built.status, 0, built.stderr)
    assert.equal(built.stdout, 'built rollout-agent:2.1.309\n')
    assert.deepEqual(calls().at(-1).args.slice(0, 7), [
      'build',
      '--build-arg',
      'CLAUDE_VERSION=2.1.309',
      '--build-arg',
      'GH_VERSION=2.103.3',
      '-t',
      'rollout-agent:2.1.309',
    ])

    assert.match(calls().at(-1).args[7], /sandbox$/)
  }

  const bogus = cli('sandbox', 'bogus', '--dir', host)

  assert.equal(bogus.status, 1)
  assert.equal(bogus.stderr, 'unknown sandbox command bogus, known: build\n')
})

test('the CLI: status prints the runtime after the driver line, with the image under Docker', () => {
  const host = cli('status', '--dir', makeRollout())

  assert.equal(host.status, 0, host.stderr)
  assert.match(host.stdout.split('\n')[0], /^rollout demo {2}driver: /)
  assert.equal(host.stdout.split('\n')[1], 'runtime host')

  const pinned = cli('status', '--dir', dockerRollout({ image: 'rollout-agent:pinned' }).dir)

  assert.equal(pinned.stdout.split('\n')[1], 'runtime docker, image rollout-agent:pinned')

  const { dir } = dockerRollout({}, { pinned: false })

  assert.equal(cli('status', '--dir', dir).stdout.split('\n')[1], 'runtime docker, image default')

  const start = { at: new Date().toISOString(), id: '-', kind: 'driver-start', runtime: 'docker', image: 'rollout-agent:2.1.309' }

  appendFileSync(join(dir, 'events.jsonl'), `\n${JSON.stringify(start)}\n`)
  assert.equal(cli('status', '--dir', dir).stdout.split('\n')[1], 'runtime docker, image rollout-agent:2.1.309')
})

test('runtimeSummary and runtimeLine for both runtimes', () => {
  const host = loadManifest(makeRollout())
  const { sandbox: _, ...bare } = host
  const { manifest } = dockerRollout({ image: 'rollout-agent:pinned' })

  assert.deepEqual(runtimeSummary(host), { runtime: 'host', image: null })
  assert.deepEqual(runtimeSummary(bare), { runtime: 'host', image: null })
  assert.deepEqual(runtimeSummary(manifest), { runtime: 'docker', image: 'rollout-agent:pinned' })
  assert.equal(runtimeLine(runtimeSummary(host)), 'runtime host')
  assert.equal(runtimeLine(runtimeSummary(manifest)), 'runtime docker, image rollout-agent:pinned')
})

// The image's claude and gh, which the fake docker runs through --entrypoint.
function imageTools(docker, claude = '2.1.309') {
  fakeClaude(docker, `echo '${claude} (Claude Code)'`)
  writeFileSync(join(docker.bin, 'gh'), "#!/bin/sh\necho 'gh version 2.103.3 (2026-10-26)'\n", { mode: 0o755 })
}

function dockerCalls(docker) {
  return docker.calls().map((call) => call.args)
}

function versionRun(tool) {
  return ['run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', tool, IMAGE, '--version']
}

const RUNTIME_INFO =
  "info claudeBin and repo.pathPrepend apply on the host only. In the container agents run the image's claude, gh and node"

test('runtimeCheck under Docker: the daemon, the image, its claude and gh and the token pass, through the docker calls preflight makes', async () => {
  const { docker, manifest } = dockerRollout()

  docker.setState({ images: [IMAGE] })
  imageTools(docker)

  const { lines, problems, warnings } = await runtimeCheck(manifest, '2.1.309 (Claude Code)\n')

  assert.deepEqual(problems, [])
  assert.deepEqual(warnings, [])
  assert.deepEqual(lines, [
    'ok   docker: server 27.3.1',
    `ok   image ${IMAGE}`,
    'ok   claude in the image: 2.1.309',
    'ok   gh in the image: 2.103.3',
    'ok   sandbox.oauthTokenFile: mode 600, not empty',
    RUNTIME_INFO,
  ])

  assert.deepEqual(dockerCalls(docker), [
    ['version', '--format', '{{.Server.Version}}'],
    ['image', 'inspect', '--format', '{{.Id}}', IMAGE],
    versionRun('claude'),
    versionRun('gh'),
  ])
})

test('runtimeCheck under Docker: a missing image is one problem that says to build it, and nothing runs', async () => {
  const { docker, manifest } = dockerRollout()

  imageTools(docker)

  const { lines, problems } = await runtimeCheck(manifest, null)

  assert.deepEqual(problems, [`image ${IMAGE} is missing: build it with rollout.mjs sandbox build --dir ${manifest.dir}`])
  assert.ok(lines.includes(`FAIL image ${IMAGE} is missing`), lines.join('\n'))
  assert.deepEqual(lines.slice(-2), ['ok   sandbox.oauthTokenFile: mode 600, not empty', RUNTIME_INFO])
  assert.deepEqual(runs(docker), [])
})

test('runtimeCheck under Docker: a daemon that does not answer fails before the image is inspected', async () => {
  const { docker, manifest } = dockerRollout()

  docker.setState({ server: null, images: [IMAGE] })

  const { lines, problems } = await runtimeCheck(manifest, null)

  assert.equal(lines[0], 'FAIL docker: Cannot connect to the Docker daemon')
  assert.deepEqual(problems, ['docker version failed: Cannot connect to the Docker daemon. Start the Docker daemon'])
  assert.deepEqual(dockerCalls(docker), [['version', '--format', '{{.Server.Version}}']])
})

test('runtimeCheck under Docker: no docker client on PATH fails before any call', async () => {
  const { dir, docker, manifest } = dockerRollout()
  const empty = join(dir, 'empty-path')
  const bare = { ...manifest, repo: { ...manifest.repo, pathPrepend: [] } }

  mkdirSync(empty)

  const { lines, problems } = await withProcessEnv({ PATH: empty }, () => runtimeCheck(bare, null))

  assert.equal(lines[0], 'FAIL docker: no docker client on PATH')
  assert.deepEqual(problems, [
    'sandbox.runtime docker needs a docker client on PATH: install Docker or colima, or set sandbox.runtime: host',
  ])

  assert.deepEqual(dockerCalls(docker), [])
})

test('runtimeCheck under Docker: an image claude below the verified version fails, and one other than yours warns', async () => {
  const old = dockerRollout()

  old.docker.setState({ images: [IMAGE] })
  imageTools(old.docker, '2.1.200')

  const stale = await runtimeCheck(old.manifest, '2.1.309 (Claude Code)')

  assert.deepEqual(stale.problems, [
    `claude 2.1.200 in the image is older than 2.1.303: update it on the host and rebuild with rollout.mjs sandbox build --dir ${old.manifest.dir}`,
  ])

  assert.ok(stale.lines.includes('FAIL claude in the image: 2.1.200, older than 2.1.303'), stale.lines.join('\n'))
  assert.deepEqual(stale.warnings, [])
  assert.deepEqual(dockerCalls(old.docker).at(-1), versionRun('claude'))

  const newer = dockerRollout()

  newer.docker.setState({ images: [IMAGE] })
  imageTools(newer.docker, '2.1.400')

  const ahead = await runtimeCheck(newer.manifest, '2.1.309 (Claude Code)')

  assert.deepEqual(ahead.problems, [])
  assert.deepEqual(ahead.warnings, [
    `the image has claude 2.1.400 and your claude is 2.1.309. Agents run the image's: rebuild with rollout.mjs sandbox build --dir ${newer.manifest.dir}`,
  ])

  for (const host of [null, 'Claude Code']) {
    assert.deepEqual((await runtimeCheck(newer.manifest, host)).warnings, [], String(host))
  }
})

test('runtimeCheck under Docker: an empty token file, or ANTHROPIC_API_KEY in passEnv but unset, is a problem', async () => {
  const withFile = dockerRollout()
  const file = withFile.manifest.sandbox.oauthTokenFile

  withFile.docker.setState({ images: [IMAGE] })
  imageTools(withFile.docker)
  writeFileSync(file, '\n')

  const empty = await runtimeCheck(withFile.manifest, null)

  assert.deepEqual(empty.problems, [`sandbox.oauthTokenFile ${file} is empty: put a Claude token in it`])
  assert.ok(empty.lines.includes(`FAIL sandbox.oauthTokenFile: ${file} is empty`), empty.lines.join('\n'))

  const withKey = dockerRollout({ oauthTokenFile: undefined, passEnv: ['ANTHROPIC_API_KEY'] })

  withKey.docker.setState({ images: [IMAGE] })
  imageTools(withKey.docker)

  const unset = await withProcessEnv({ ANTHROPIC_API_KEY: '' }, () => runtimeCheck(withKey.manifest, null))
  const set = await withProcessEnv({ ANTHROPIC_API_KEY: 'synthetic-api-key' }, () => runtimeCheck(withKey.manifest, null))

  assert.equal(withKey.manifest.sandbox.oauthTokenFile, null)
  assert.deepEqual(unset.problems, ["sandbox.passEnv names ANTHROPIC_API_KEY, but it is not set in the driver's environment"])
  assert.deepEqual(set.problems, [])
  assert.ok(set.lines.includes('ok   sandbox.passEnv: ANTHROPIC_API_KEY is set'), set.lines.join('\n'))
})

const GIT_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']

function git(cwd, ...args) {
  return execFileSync('git', [...GIT_IDENTITY, '-C', cwd, ...args], { encoding: 'utf8' })
}

// The driver's mirror, cloned from a local bare origin with one pushed
// commit, so its objects are loose. repo.path's origin is that origin.
function withMirror(manifest) {
  const origin = join(manifest.dir, 'origin.git')
  const repo = manifest.repo.path

  git(manifest.dir, 'init', '--quiet', '--bare', origin)
  git(repo, 'init', '--quiet')
  writeFileSync(join(repo, 'README.md'), '# widgets\n')
  git(repo, 'add', 'README.md')
  git(repo, 'commit', '--quiet', '-m', 'init')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
  git(manifest.dir, 'clone', '--mirror', '--quiet', origin, mirrorPath(manifest))
}

// Stands in for BOUNDARY_SCRIPT, which would write into this checkout and
// reach the network under the fake docker. `lines` replaces a probe's line.
function cannedProbes(lines = {}) {
  const probes = BOUNDARY_PROBES.filter(({ name }) => name !== 'stop').map(({ name }) => lines[name] ?? `echo 'probe ${name} ok'`)

  return [
    ...probes,
    ': > rollout-owner-probe',
    'chmod u+w ".git/${10}"',
    'printf "rewritten\\n" > ".git/${10}"',
    'echo probes-done',
    'exec sleep 30',
  ].join('\n')
}

function scratchClones(manifest) {
  return readdirSync(manifest.wtRoot).filter((name) => name.startsWith('preflight-'))
}

test('boundaryProof under Docker: one container over a scratch clone with the real mounts, stopped by docker stop, and nothing left behind', async () => {
  const { docker, manifest } = dockerRollout()

  withMirror(manifest)

  const { lines, problems } = await boundaryProof(manifest, { script: cannedProbes() })
  const [run, ...others] = runs(docker)
  const [workdir] = values(run.args, '-w')
  const [name] = values(run.args, '--name')
  const volumes = values(run.args, '-v')
  const sources = volumes.map((volume) => volume.split(':')[0])
  const passed = BOUNDARY_PROBES.map((probe) => `ok   boundary: ${probe.text}`)

  assert.deepEqual(problems, [])
  assert.deepEqual(lines, passed)
  assert.deepEqual(others, [])
  assert.equal(dirname(workdir), manifest.wtRoot)
  assert.match(basename(workdir), /^preflight-[0-9a-f]{8}$/)
  assert.ok(volumes.includes(`${manifest.home}:${manifest.home}:ro`), volumes.join(' '))

  for (const root of [manifest.dir, manifest.repo.path, mirrorPath(manifest)]) {
    const mounted = sources.filter((source) => source === root || source.startsWith(`${root}/`))

    assert.deepEqual(mounted, [], root)
  }

  assert.ok(docker.calls().some((call) => call.args.join(' ') === `stop -t 10 ${name}`))
  assert.equal(existsSync(workdir), false)
  assert.deepEqual(scratchClones(manifest), [])
  await waitFor(() => !existsSync(join(manifest.wtRoot, 'homes', name)), 'the fresh home to be removed')
})

test('boundaryProof under Docker: a probe the container reports as failed is a problem that names it', async () => {
  const { manifest } = dockerRollout()

  withMirror(manifest)

  const script = cannedProbes({ 'egress-blocked': "echo 'probe egress-blocked fail curl connected'" })
  const { lines, problems } = await boundaryProof(manifest, { script })

  assert.deepEqual(problems, ['boundary probe egress-blocked: curl connected'])
  assert.ok(lines.includes('FAIL boundary: HTTPS to a host outside sandbox.allowedDomains fails (curl connected)'), lines.join('\n'))
})

test('boundaryProof under Docker: without a scratch clone it is one problem, and no container starts', async () => {
  const { docker, manifest } = dockerRollout()
  const { lines, problems } = await boundaryProof(manifest, { script: cannedProbes() })

  assert.equal(problems.length, 1)
  assert.match(problems[0], /^boundary: cannot make a scratch clone \(/)
  assert.deepEqual(lines, [`FAIL ${problems[0]}`])
  assert.deepEqual(runs(docker), [])
  assert.deepEqual(scratchClones(manifest), [])
})

test('boundaryProof under the host runtime returns nothing and calls no docker', async () => {
  const dir = makeRollout()
  const docker = fakeDocker(dir)
  const manifest = loadManifest(dir)

  assert.deepEqual(await boundaryProof(manifest, { script: 'exit 1' }), { lines: [], problems: [] })
  assert.deepEqual(docker.calls(), [])
})

const GUARD_COMMANDS = [
  'gh pr --repo o/r merge 999999 --admin',
  'echo x && git push origin x:main --dry-run',
  'pnpm --filter nothing publish --dry-run',
  'gh api -X PUT repos/o/r/pulls/999999/merge',
  'echo allowed',
]

// The live guard test's agent: the guard refused the four forbidden
// commands, and `echo allowed` printed `allowedOutput`.
function guardStream(allowedOutput = 'allowed') {
  return GUARD_COMMANDS.flatMap((command, i) => {
    const content = command === 'echo allowed' ? allowedOutput : 'rollout guard: refused'

    return [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: `tool-${i}`, name: 'Bash', input: { command } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tool-${i}`, content }] } },
    ]
  })
}

// A rollout under the host runtime whose claudeBin records its directory,
// its first argument and its role, then prints `stream`.
function hostGuardRollout(stream) {
  const dir = makeRollout()
  const claude = join(dir, 'fake-claude')
  const record = join(dir, 'claude.txt')
  const transcript = join(dir, 'guard.jsonl')

  writeFileSync(transcript, `${jsonLines(stream)}\n`)
  writeFileSync(claude, `#!/bin/sh\npwd > '${record}'\nprintf '%s\\n' "$1" "$ROLLOUT_ROLE" >> '${record}'\ncat '${transcript}'\n`, {
    mode: 0o755,
  })

  editManifest(dir, (raw) => ({ ...raw, claudeBin: claude }))

  return { manifest: loadManifest(dir), record }
}

function notOk(lines) {
  return lines.filter((line) => !line.startsWith('ok   live guard: '))
}

test('liveGuardTest under the host runtime: claudeBin in a scratch directory that is gone afterwards, five ok lines', async () => {
  const { manifest, record } = hostGuardRollout(guardStream())
  const { lines, problems } = await liveGuardTest(manifest)
  const [cwd, first, role] = readFileSync(record, 'utf8').trim().split('\n')

  assert.deepEqual(problems, [])
  assert.equal(lines.length, 5)
  assert.deepEqual(notOk(lines), [])
  assert.equal(first, '-p')
  assert.equal(role, 'implement')
  assert.match(basename(cwd), /^rollout-guard-/)
  assert.equal(existsSync(cwd), false)
})

test('liveGuardTest: an echo allowed that the guard refused is a FAIL line and a problem', async () => {
  const { manifest } = hostGuardRollout(guardStream('rollout guard: refused'))
  const { lines, problems } = await liveGuardTest(manifest)

  assert.deepEqual(problems, ['live guard test: ^echo allowed$ was not allowed'])
  assert.equal(lines[4], 'FAIL live guard: ^echo allowed$ allowed → rollout guard: refused')
})

test('liveGuardTest under Docker: claude -p runs in a container over a scratch clone that is gone afterwards, five ok lines', async () => {
  const { dir, docker, manifest } = dockerRollout()
  const transcript = join(dir, 'guard.jsonl')

  withMirror(manifest)
  writeFileSync(transcript, `${jsonLines(guardStream())}\n`)
  fakeClaude(docker, `cat '${transcript}'`)

  const { lines, problems } = await liveGuardTest(manifest)
  const [run, ...others] = runs(docker)
  const [workdir] = values(run.args, '-w')
  const image = run.args.indexOf(IMAGE)

  assert.deepEqual(problems, [])
  assert.equal(lines.length, 5)
  assert.deepEqual(notOk(lines), [])
  assert.deepEqual(others, [])
  assert.deepEqual(run.args.slice(image + 1, image + 3), ['claude', '-p'])
  assert.equal(dirname(workdir), manifest.wtRoot)
  assert.match(basename(workdir), /^preflight-[0-9a-f]{8}$/)
  assert.equal(existsSync(workdir), false)
  assert.equal(existsSync(`${workdir}.home`), false)
})

test('liveGuardTest under Docker: a throw is a problem, and the scratch clone is gone', async () => {
  const { docker, manifest } = dockerRollout()

  withMirror(manifest)
  rmSync(manifest.repo.agentToken)

  const { problems } = await liveGuardTest(manifest)

  assert.deepEqual(problems, [`live guard test: repo.agentToken ${manifest.repo.agentToken} does not exist`])
  assert.deepEqual(runs(docker), [])
  assert.deepEqual(scratchClones(manifest), [])
})

// Last: stopAllAgents also stops every runAgent this process would start.
test('stopAllAgents ends a sleeping agent under Docker through docker stop, well within 15 s', async () => {
  const { docker, manifest } = dockerRollout()
  const name = 'rollout-demo-A1-09-implement'

  fakeClaude(docker, 'exec sleep 30')

  const started = Date.now()
  const running = agentRun(manifest, 'implement', 'A1-09-implement')

  await waitFor(() => existsSync(join(docker.bin, 'containers', `${name}.pid`)), 'the container to start', 10_000)
  stopAllAgents()

  const result = await running

  assert.equal(result.stopped, true)
  assert.ok(Date.now() - started < 15_000, `${Date.now() - started} ms`)
  assert.ok(docker.calls().some((call) => call.args.join(' ') === `stop -t 10 ${name}`))
})
