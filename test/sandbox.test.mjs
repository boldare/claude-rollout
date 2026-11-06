import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, chmodSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from 'yaml'
import { loadManifest } from '../lib/manifest.mjs'
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
