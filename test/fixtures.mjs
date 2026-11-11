import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { freshPr } from '../lib/ledger.mjs'
import { runRecords } from '../lib/runs.mjs'

// A synthetic rollout directory, in a fresh temp dir unless `dir` names one.
// Every part can be overridden, and null leaves the file out.

export const START = Date.parse('2026-09-01T10:00:00.000Z')

export function at(minutes) {
  return new Date(START + minutes * 60_000).toISOString()
}

const SHA = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'

export function samplePrs() {
  const verdict = {
    verdict: 'PASS',
    sha: SHA,
    summary: 'Every checklist item holds.',
    checklist: [{ item: 'tests pass', status: 'pass', evidence: 'npm test: 12 pass' }],
    blocking: [],
    nonBlocking: [],
    at: at(80),
    run: 'A1-02-verify',
  }

  return {
    A1: {
      state: 'verified',
      attempts: { implement: 1, fix: 0, verify: 0, brief: 0 },
      pr: 11,
      author: 'demo-bot',
      claimedSha: SHA,
      verified: { sha: SHA, patchId: 'patch-a1', at: at(80) },
      approved: { sha: SHA, patchId: 'patch-a1', at: at(81) },
      gate: { action: 'wait', code: 'held', reasons: ['held (rollout release A1)'], mergeState: 'CLEAN', sha: SHA, at: at(82) },
      verdict,
      verdicts: [verdict],
      held: { at: at(81) },
      costUsd: 6.25,
    },
    A2: {
      state: 'implementing',
      attempts: { implement: 1, fix: 0, verify: 0, brief: 1 },
      costUsd: 1.5,
    },
  }
}

export function sampleEvents() {
  return [
    { at: at(0), id: '-', kind: 'driver-start', prs: ['A1', 'A2', 'A3'], dryRun: false, merge: 'human', pid: 1 },
    { at: at(1), id: 'A2', kind: 'brief-start', effort: 'xhigh', log: 'logs/A2-01-brief-write.jsonl' },
    { at: at(20), id: 'A2', kind: 'brief-done', ok: true, cost: 1.5, seconds: 1140 },
    {
      at: at(21),
      id: 'A1',
      kind: 'implement-start',
      run: 'A1-01-implement',
      log: 'logs/A1-01-implement.jsonl',
      effort: 'high',
      resume: false,
    },
    {
      at: at(60),
      id: 'A1',
      kind: 'implement-done',
      run: 'A1-01-implement',
      ok: true,
      result: 'READY',
      cost: 4.25,
      seconds: 2340,
      denials: 1,
      stopped: false,
      error: null,
    },
    { at: at(61), id: 'A1', kind: 'verify-start', run: 'A1-02-verify', log: 'logs/A1-02-verify.jsonl', effort: 'high', resume: false },
    {
      at: at(80),
      id: 'A1',
      kind: 'verify-done',
      run: 'A1-02-verify',
      ok: true,
      result: 'PASS',
      cost: 2,
      seconds: 1140,
      denials: 0,
      stopped: false,
      error: null,
    },
    { at: at(81), id: 'A1', kind: 'held', state: 'verified', running: null },
    {
      at: at(82),
      id: 'A2',
      kind: 'implement-start',
      run: 'A2-01-implement',
      log: 'logs/A2-01-implement.jsonl',
      effort: 'high',
      resume: false,
    },
    // The driver is still appending this line.
    '{"at":"2026-09-01T11:23:00.000Z","id":"A2","ki',
  ]
}

// One stream-json agent log, as `claude -p --output-format stream-json` writes it.
export function sampleTranscript() {
  return [
    { type: 'system', subtype: 'init', model: 'opus', session_id: 'session-1' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Plan the work.' },
          { type: 'text', text: 'Reading the brief.' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tests 12, pass 12' }] } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'gh pr merge 11' } },
          { type: 'tool_use', id: 'tool-3', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: 'rollout guard: the driver merges PRs' }],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-3',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'image', source: { type: 'base64', data: '' } },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
      },
    },
    { type: 'user', message: { content: 'a prompt as plain text' } },
    { type: 'rate_limit_event', status: 'allowed' },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 4.25,
      duration_ms: 2_340_400,
      num_turns: 31,
      permission_denials: [{ tool_name: 'Bash' }],
      structured_output: { status: 'READY', pr: 11, headSha: SHA },
      result: 'Done.',
    },
  ]
}

// The log of a run killed before its result line. Its token usage is
// estimated at $2.67: $2.60 of Opus 5.5 and $0.07 of the Haiku subagent.
export function interruptedTranscript() {
  const usage = {
    input_tokens: 100000,
    cache_read_input_tokens: 1000000,
    cache_creation_input_tokens: 200000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200000 },
    output_tokens: 3,
  }

  const opus = (content) => ({ type: 'assistant', message: { id: 'msg-1', model: 'claude-opus-5-5', content, usage } })

  return [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 'session-2' },
    opus([{ type: 'text', text: 'a'.repeat(3978) }]),
    opus([{ type: 'tool_use', id: 'tool-9', name: 'Bash', input: { command: 'npm test' } }]),
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens_delta: 9000 },
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens_delta: 10000 },
    {
      type: 'assistant',
      parent_tool_use_id: 'tool-9',
      message: {
        id: 'msg-2',
        model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'b'.repeat(400) }],
        usage: { input_tokens: 10000, cache_creation_input_tokens: 40000, output_tokens: 2000 },
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'msg-3',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
        usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-9', content: 'tests 3, pass 3' }] } },
    '{"type":"assistant","message":{"id":"msg-4"',
  ]
}

export function jsonLines(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')
}

function sampleManifest(dir, policy) {
  const effort = { implement: 'high', verify: 'high' }
  const pr = (id, extra = {}) => ({
    id,
    branch: `feat/${id.toLowerCase()}`,
    title: `feat: ${id}`,
    brief: `briefs/${id}.md`,
    effort,
    changeset: 'none',
    ...extra,
  })

  return {
    rollout: 'demo',
    repo: { path: join(dir, 'repo'), github: 'example/widgets', requiredChecks: ['test'] },
    policy,
    briefing: { sources: [{ title: 'Plan', path: join(dir, 'plan.md'), kind: 'markdown' }] },
    prs: [pr('A1'), pr('A2', { deps: ['A1'] }), pr('A3')],
  }
}

// A legacy ledger is one a driver from before ledger versions wrote. Any
// other records the runs of the events, as the driver that holds the lock
// would, unless `runs` gives them.
function ledgerOf(options, prs) {
  const { paused, halted } = options

  if (options.legacy) {
    return { prs, paused, halted }
  }

  const events = (options.events ?? []).filter((event) => typeof event !== 'string')

  return { version: 2, prs, runs: options.runs ?? runRecords(events, { driverRunning: true }), paused, halted }
}

export function makeRollout(overrides = {}) {
  const options = {
    prs: samplePrs(),
    paused: false,
    halted: null,
    legacy: false,
    runs: null,
    events: sampleEvents(),
    heartbeat: 'tick',
    lock: true,
    logs: { 'A1-01-implement': [...sampleTranscript(), '{"type":"assis'], 'A1-02-verify': sampleTranscript().slice(0, 1) },
    policy: {},
    manifest: {},
    dir: null,
    ...overrides,
  }

  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'rollout-'))

  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'repo'))
  mkdirSync(join(dir, 'logs'))
  writeFileSync(join(dir, 'plan.md'), '# Plan\n')
  writeFileSync(join(dir, 'manifest.yaml'), stringify({ ...sampleManifest(dir, options.policy), ...options.manifest }))

  if (options.prs) {
    const prs = Object.fromEntries(Object.entries(options.prs).map(([id, state]) => [id, { ...freshPr(), ...state }]))
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify(ledgerOf(options, prs), null, 2))
  }

  if (options.events) {
    writeFileSync(join(dir, 'events.jsonl'), jsonLines(options.events))
  }

  if (options.heartbeat !== null) {
    writeFileSync(join(dir, 'heartbeat'), `${new Date().toISOString()} ${options.heartbeat}`.trim())
  }

  if (options.lock) {
    writeFileSync(join(dir, 'driver.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  }

  for (const [name, lines] of Object.entries(options.logs ?? {})) {
    writeFileSync(join(dir, 'logs', `${name}.jsonl`), jsonLines(lines))
  }

  return dir
}

// The script never reads stdin: sh() leaves it open when it has no input,
// so a read would hang.
function fakeTool(tool) {
  return `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const tool = ${JSON.stringify(tool)}
const args = process.argv.slice(2)
const line = args.join(' ')
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify({ tool, args }) + '\\n')

const rules = JSON.parse(readFileSync(join(__dirname, 'rules.json'), 'utf8'))
const rule = rules.find((item) => item.tool === tool && line.includes(item.args ?? ''))

if (!rule) {
  process.stderr.write('fake ' + tool + ': no rule for ' + line + '\\n')
  process.exitCode = 1
} else {
  if (rule.stdout !== undefined) {
    process.stdout.write(typeof rule.stdout === 'string' ? rule.stdout : JSON.stringify(rule.stdout))
  }

  if (rule.stderr !== undefined) {
    process.stderr.write(rule.stderr)
  }

  if (rule.next !== undefined) {
    writeFileSync(join(__dirname, 'rules.json'), JSON.stringify(rule.next))
  }

  process.exitCode = rule.code ?? 0
}
`
}

function readCalls(bin) {
  const log = join(bin, 'calls.jsonl')

  if (!existsSync(log)) {
    return []
  }

  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

// A fake gh and git for a rollout made by makeRollout, first on the PATH of
// every manifest load, so a test never reaches the real tools or GitHub.
// Call it before loadManifest. A rule is { tool, args, stdout, stderr, code, next }:
// the first whose args the call's arguments contain answers it, and a call
// no rule matches fails. A rule with `next` puts those rules in place once it
// answers, so a call can change what later calls see, as a reset cleans the tree.
export function fakeTools(dir, rules = []) {
  const bin = join(dir, 'fake-bin')
  const file = join(dir, 'manifest.yaml')
  const manifest = parse(readFileSync(file, 'utf8'))

  mkdirSync(bin, { recursive: true })

  for (const tool of ['gh', 'git']) {
    writeFileSync(join(bin, tool), fakeTool(tool), { mode: 0o755 })
  }

  writeFileSync(file, stringify({ ...manifest, repo: { ...manifest.repo, pathPrepend: [bin] } }))

  function answer(next) {
    writeFileSync(join(bin, 'rules.json'), JSON.stringify(next))
  }

  answer(rules)

  return { answer, calls: () => readCalls(bin) }
}

// The docker client of the Docker runtime, without a daemon. run starts the
// argv after the image as a local process in its own group, in the -w
// directory and with the environment the entrypoint would give it. With
// --entrypoint X the argv is X and the words after the image. stop and kill
// signal the group of a run with --name. version and image inspect answer
// from docker.json: the server version, null for a daemon that does not
// answer, and the images that exist. Every call is recorded like a fakeTools
// call.
const FAKE_DOCKER = `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { constants } = require('node:os')
const { join } = require('node:path')

const VALUE_FLAGS = [
  '--name',
  '-v',
  '-e',
  '-w',
  '--memory',
  '--cpus',
  '--pids-limit',
  '--cap-add',
  '--cap-drop',
  '--security-opt',
  '--pull',
  '--entrypoint',
  '--network',
]

const containers = join(__dirname, 'containers')
const state = JSON.parse(readFileSync(join(__dirname, 'docker.json'), 'utf8'))
const [command, ...rest] = process.argv.slice(2)

appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify({ tool: 'docker', args: process.argv.slice(2) }) + '\\n')

function pidFile(name) {
  return join(containers, name + '.pid')
}

function containerPid(name) {
  if (!existsSync(pidFile(name))) {
    process.stderr.write('fake docker: no container ' + name + '\\n')
    process.exit(1)
  }

  return Number(readFileSync(pidFile(name), 'utf8'))
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)

    return true
  } catch {
    return false
  }
}

function parseRun(words) {
  const container = { name: null, entrypoint: null, volumes: [], env: [], workdir: process.cwd() }
  let i = 0

  while (i < words.length && words[i].startsWith('-')) {
    const flag = words[i]

    if (!VALUE_FLAGS.includes(flag)) {
      i += 1
      continue
    }

    const value = words[i + 1]

    if (flag === '--name') {
      container.name = value
    } else if (flag === '--entrypoint') {
      container.entrypoint = value
    } else if (flag === '-v') {
      container.volumes.push(value)
    } else if (flag === '-e') {
      container.env.push(value)
    } else if (flag === '-w') {
      container.workdir = value
    }

    i += 2
  }

  const argv = words.slice(i + 1)

  return { ...container, image: words[i], argv: container.entrypoint ? [container.entrypoint, ...argv] : argv }
}

// Only the names ROLLOUT_ENV lists, as the entrypoint passes them on, plus HOME and a PATH without node.
function childEnv(container) {
  const given = new Map()

  for (const entry of container.env) {
    const equals = entry.indexOf('=')

    if (equals !== -1) {
      given.set(entry.slice(0, equals), entry.slice(equals + 1))
    } else if (process.env[entry] !== undefined) {
      given.set(entry, process.env[entry])
    }
  }

  const env = {}

  for (const name of (given.get('ROLLOUT_ENV') ?? '').split(' ').filter(Boolean)) {
    if (given.has(name)) {
      env[name] = given.get(name)
    }
  }

  const home = container.volumes.map((volume) => volume.split(':')).find((parts) => parts[1] === '/home/agent')

  env.HOME = home ? home[0] : ''
  env.PATH = __dirname + ':/usr/bin:/bin'

  return env
}

function run() {
  const container = parseRun(rest)
  const [program, ...args] = container.argv
  const child = spawn(program, args, { cwd: container.workdir, env: childEnv(container), stdio: 'inherit', detached: true })

  mkdirSync(containers, { recursive: true })

  if (child.pid && container.name) {
    writeFileSync(pidFile(container.name), String(child.pid))
  }

  child.on('error', (error) => {
    process.stderr.write('fake docker: ' + error.message + '\\n')
    process.exit(127)
  })

  // The container ends with its first process, and everything it started goes with it.
  child.on('exit', (code, signal) => {
    signalGroup(child.pid, 'SIGKILL')

    if (container.name) {
      rmSync(pidFile(container.name), { force: true })
    }

    process.exit(code ?? 128 + constants.signals[signal])
  })
}

function stop() {
  const seconds = rest[0] === '-t' ? Number(rest[1]) : 10
  const pid = containerPid(rest[rest.length - 1])
  const deadline = Date.now() + seconds * 1000

  signalGroup(pid, 'SIGTERM')

  const timer = setInterval(() => {
    if (!signalGroup(pid, 0)) {
      clearInterval(timer)
    } else if (Date.now() > deadline) {
      signalGroup(pid, 'SIGKILL')
    }
  }, 25)
}

function kill() {
  const named = rest.indexOf('--signal')

  signalGroup(containerPid(rest[rest.length - 1]), named === -1 ? 'SIGKILL' : rest[named + 1])
}

function version() {
  if (state.server === null) {
    process.stderr.write('Cannot connect to the Docker daemon\\n')
    process.exitCode = 1
  } else {
    process.stdout.write(state.server + '\\n')
  }
}

function inspectImage() {
  const tag = rest[rest.length - 1]

  if (state.images.includes(tag)) {
    process.stdout.write('sha256:' + '0'.repeat(64) + '\\n')
  } else {
    process.stderr.write('Error: No such image: ' + tag + '\\n')
    process.exitCode = 1
  }
}

if (command === 'run') {
  run()
} else if (command === 'version') {
  version()
} else if (command === 'image' && rest[0] === 'inspect') {
  inspectImage()
} else if (command === 'stop') {
  stop()
} else if (command === 'kill') {
  kill()
} else if (command !== 'build') {
  process.stderr.write('fake docker: no fake for ' + command + '\\n')
  process.exitCode = 1
}
`

// A fake docker for the Docker runtime, in <dir>/fake-bin. With a
// manifest.yaml in dir, the bin goes first on repo.pathPrepend. A fake claude
// or command that runs inside must be a #!/bin/sh script in the bin, because
// node is not on the PATH a container gets. `state` and setState are the
// daemon's answers, { server, images }.
export function fakeDocker(dir, state = {}) {
  const bin = join(dir, 'fake-bin')
  const file = join(dir, 'manifest.yaml')

  function setState(next) {
    writeFileSync(join(bin, 'docker.json'), JSON.stringify({ server: '27.3.1', images: [], ...next }))
  }

  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { mode: 0o755 })
  setState(state)

  if (existsSync(file)) {
    prependBin(file, bin)
  }

  return { bin, calls: () => readCalls(bin), setState }
}

// Puts bin first on repo.pathPrepend of the manifest file, once, and returns
// the manifest as it was read.
function prependBin(file, bin) {
  const manifest = parse(readFileSync(file, 'utf8'))
  const pathPrepend = manifest.repo.pathPrepend ?? []

  if (!pathPrepend.includes(bin)) {
    writeFileSync(file, stringify({ ...manifest, repo: { ...manifest.repo, pathPrepend: [bin, ...pathPrepend] } }))
  }

  return manifest
}

const NULL_BODY_STATUSES = [204, 205, 304]

// A string body is text, anything else JSON. Route headers win.
function respond(status, body, headers) {
  if (body === undefined || NULL_BODY_STATUSES.includes(status)) {
    return new Response(null, { status, headers })
  }

  if (typeof body === 'string') {
    return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } })
  }

  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

// The slice of a list answer that the request's page and per_page ask for,
// with GitHub's default of 30 per page.
function servedPage(route, url) {
  const list = Array.isArray(route.body) ? route.body : route.body?.[route.items]

  if (!Array.isArray(list) || (!Array.isArray(route.body) && !route.items)) {
    return { body: route.body, link: null }
  }

  const perPage = Number(url.searchParams.get('per_page') ?? 30)
  const page = Number(url.searchParams.get('page') ?? 1)
  const items = list.slice((page - 1) * perPage, page * perPage)
  const next = new URL(url)

  next.searchParams.set('page', String(page + 1))

  return {
    body: Array.isArray(route.body) ? items : { ...route.body, [route.items]: items },
    link: list.length > page * perPage ? `<${next.href}>; rel="next"` : null,
  }
}

function etagOf(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null)

  return `"${createHash('sha256').update(text).digest('hex').slice(0, 32)}"`
}

// How undici's fetch rejects when the connection fails.
function connectionError(code) {
  const cause = new Error(`read ${code}`)
  cause.code = code

  return new TypeError('fetch failed', { cause })
}

function hanging(signal) {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

function routeMatches(route, method, path, query) {
  const entries = Object.entries(route.query ?? {})

  return (route.method ?? 'GET') === method && route.path === path && entries.every(([name, value]) => query[name] === String(value))
}

// A GitHub for setFetch in lib/github.mjs, so a test never reaches the real
// one. A route is { method, path, query, status, body, headers, items,
// error, hang }, and the first whose method and path equal the request's,
// and whose query entries all equal the request's, answers. An array body,
// or the array under `items` of an object body, comes in pages with a Link
// header. Every 200 GET carries an ETag and answers 304 when it comes back
// in If-None-Match. `error: 'ECONNRESET'` rejects the way undici does, and
// `hang` answers never and rejects on the request's abort. A request no route
// matches gets a 400, which means nothing to the driver, so a test's mistake
// never passes for an unknown PR, a missing code scanning or an outage.
export function fakeGitHub(routes = []) {
  let current = routes
  const log = []

  function answer(next) {
    current = next
  }

  function requests() {
    return log
  }

  async function fetch(input, init = {}) {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const path = url.pathname.slice(1)
    const query = Object.fromEntries(url.searchParams)
    const headers = Object.fromEntries(new Headers(init.headers))
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    const record = { method, url: url.href, path, query, headers, body, status: null }
    const route = current.find((candidate) => routeMatches(candidate, method, path, query))

    log.push(record)

    if (!route) {
      record.status = 400

      return respond(400, { message: `fake GitHub: no route for ${method} ${path}` })
    }

    if (route.error) {
      throw connectionError(route.error)
    }

    if (route.hang) {
      return hanging(init.signal)
    }

    const status = route.status ?? 200
    const served = servedPage(route, url)
    const answerHeaders = { ...route.headers }

    if (served.link) {
      answerHeaders.link = served.link
    }

    if (method === 'GET' && status === 200) {
      answerHeaders.etag = etagOf(served.body)

      if (headers['if-none-match'] === answerHeaders.etag) {
        record.status = 304

        return new Response(null, { status: 304 })
      }
    }

    record.status = status

    return respond(status, served.body, answerHeaders)
  }

  return { fetch, answer, requests }
}

// The gh of fakeGitHubRepo, for `pr merge` alone. It squashes the PR head onto
// the base of the bare origin that github.json names, and fails for a PR that
// is not open, a head that moved or a head without the base tip. Every call is
// recorded like a fakeTools call.
const FAKE_GH = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process')
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fake GitHub',
  GIT_AUTHOR_EMAIL: 'merge@example.com',
  GIT_COMMITTER_NAME: 'Fake GitHub',
  GIT_COMMITTER_EMAIL: 'merge@example.com',
}

const VALUE_FLAGS = ['--match-head-commit', '--subject', '--body']
const args = process.argv.slice(2)
const file = join(__dirname, 'github.json')

appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify({ tool: 'gh', args }) + '\\n')

function fail(message) {
  process.stderr.write(message + '\\n')
  process.exit(1)
}

function git(state, words) {
  return execFileSync('git', ['-C', state.origin, ...words], { encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim()
}

function succeeds(state, words) {
  try {
    git(state, words)

    return true
  } catch {
    return false
  }
}

function refSha(state, ref) {
  try {
    return git(state, ['rev-parse', '--verify', '--quiet', ref])
  } catch {
    return null
  }
}

// --squash and a value for each of VALUE_FLAGS, or null for anything else.
function mergeOptions(words) {
  const options = { squash: false }

  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === '--squash') {
      options.squash = true
    } else if (VALUE_FLAGS.includes(words[i]) && i + 1 < words.length) {
      options[words[i].slice(2)] = words[i + 1]
      i += 1
    } else {
      return null
    }
  }

  const complete = options.squash && VALUE_FLAGS.every((flag) => options[flag.slice(2)] !== undefined)

  return complete ? options : null
}

function merge(number, options) {
  const state = JSON.parse(readFileSync(file, 'utf8'))
  const pr = state.prs.find((item) => item.number === number)

  if (!pr || pr.merged) {
    fail('fake gh: pull request #' + number + ' is not open')
  }

  const head = refSha(state, 'refs/heads/' + pr.branch)

  if (head !== options['match-head-commit']) {
    fail('GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)')
  }

  const tip = refSha(state, 'refs/heads/' + state.base)

  // The head's tree on a base it does not contain would drop the base's newer changes.
  if (!succeeds(state, ['merge-base', '--is-ancestor', tip, head])) {
    fail('Pull request is not mergeable')
  }

  const sha = git(state, ['commit-tree', head + '^{tree}', '-p', tip, '-m', options.subject])

  git(state, ['update-ref', 'refs/heads/' + state.base, sha, tip])
  pr.merged = { sha, head, at: new Date().toISOString() }
  writeFileSync(file, JSON.stringify(state, null, 2))
}

const [group, command, prNumber, ...rest] = args
const requested = group === 'pr' && command === 'merge' && /^[0-9]+$/.test(prNumber ?? '') ? mergeOptions(rest) : null

if (requested) {
  merge(Number(prNumber), requested)
} else {
  fail('fake gh: no fake for ' + args.join(' '))
}
`

const GREEN_RUN = { id: 1, name: 'test', status: 'completed', conclusion: 'success' }
const PAGING = ['per_page', 'page']

function originRef(origin, ref) {
  try {
    return execFileSync('git', ['-C', origin, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function pullOf(state, number) {
  return state.prs.find((pr) => pr.number === Number(number)) ?? null
}

function labelObjects(pr) {
  return pr.labels.map((name) => ({ name }))
}

// The REST shape of a PR, with the fields prFacts reads. An open PR's head is
// its branch in the origin at the time of the request.
function restPull(state, pr) {
  const fields = {
    number: pr.number,
    draft: false,
    title: pr.title,
    body: '',
    labels: labelObjects(pr),
    user: { login: pr.author },
    html_url: `https://github.com/${state.repo}/pull/${pr.number}`,
    base: { ref: state.base },
  }

  if (pr.merged) {
    const head = { ref: pr.branch, sha: pr.merged.head }
    const merged = { merged_at: pr.merged.at, merge_commit_sha: pr.merged.sha }

    return { ...fields, state: 'closed', head, mergeable: null, mergeable_state: 'unknown', ...merged }
  }

  const branchHead = originRef(state.origin, `refs/heads/${pr.branch}`)

  return {
    ...fields,
    state: 'open',
    head: { ref: pr.branch, sha: branchHead },
    mergeable: true,
    mergeable_state: 'clean',
    merged_at: null,
    merge_commit_sha: null,
  }
}

function openPulls(state, request) {
  const filters = Object.keys(request.query).filter((name) => !PAGING.includes(name))

  if (filters.length !== 1 || request.query.state !== 'open') {
    return null
  }

  return { status: 200, body: state.prs.filter((pr) => !pr.merged).map((pr) => restPull(state, pr)) }
}

function onePull(state, _, number) {
  const pr = pullOf(state, number)

  return pr ? { status: 200, body: restPull(state, pr) } : null
}

function reviews(state, _, number) {
  return pullOf(state, number) ? { status: 200, body: [] } : null
}

function addLabels(state, request, number) {
  const pr = pullOf(state, number)

  if (!pr || !Array.isArray(request.body?.labels)) {
    return null
  }

  pr.labels = [...new Set([...pr.labels, ...request.body.labels])]

  return { status: 200, body: labelObjects(pr) }
}

function removeLabel(state, _, number, encoded) {
  const pr = pullOf(state, number)
  const name = decodeURIComponent(encoded)

  if (!pr) {
    return null
  }

  if (!pr.labels.includes(name)) {
    return { status: 404, body: { message: 'Label does not exist' } }
  }

  pr.labels = pr.labels.filter((label) => label !== name)

  return { status: 200, body: labelObjects(pr) }
}

function deleteBranch(state, _, encoded) {
  const ref = `refs/heads/${encoded.split('/').map(decodeURIComponent).join('/')}`

  if (!originRef(state.origin, ref)) {
    return { status: 422, body: { message: 'Reference does not exist' } }
  }

  execFileSync('git', ['-C', state.origin, 'update-ref', '-d', ref])

  return { status: 204 }
}

// Paths under repos/<repo>/, whatever the paging. An answer is { status, body },
// and null means no fake.
const REPO_ROUTES = [
  { method: 'GET', path: /^pulls$/, answer: openPulls },
  { method: 'GET', path: /^pulls\/(\d+)$/, answer: onePull },
  { method: 'GET', path: /^pulls\/(\d+)\/reviews$/, answer: reviews },
  { method: 'GET', path: /^code-scanning\/alerts$/, answer: () => ({ status: 200, body: [] }) },
  {
    method: 'GET',
    path: /^commits\/[0-9a-f]{40}\/check-runs$/,
    answer: () => ({ status: 200, body: { total_count: 1, check_runs: [GREEN_RUN] } }),
  },
  { method: 'POST', path: /^labels$/, answer: (_, request) => ({ status: 201, body: request.body }) },
  { method: 'POST', path: /^issues\/(\d+)\/labels$/, answer: addLabels },
  { method: 'DELETE', path: /^issues\/(\d+)\/labels\/([^/]+)$/, answer: removeLabel },
  { method: 'DELETE', path: /^git\/refs\/heads\/(.+)$/, answer: deleteBranch },
]

function repoAnswer(state, request, path) {
  for (const route of REPO_ROUTES) {
    const match = route.method === request.method ? path.match(route.path) : null

    if (match) {
      return route.answer(state, request, ...match.slice(1))
    }
  }

  return null
}

// A GitHub that keeps state for the repository of the manifest in dir, for
// setFetch, and a fake gh first on its repo.pathPrepend. Call it before
// loadManifest. git stays real: an open PR's head is its branch in the bare
// `origin` at each request, and `gh pr merge` squashes into the origin's base.
// The state is a file because the fake gh is another process. A request with
// no fake gets a 400, as in fakeGitHub.
export function fakeGitHubRepo(dir, { origin, base = 'main' }) {
  const bin = join(dir, 'fake-bin')
  const file = join(bin, 'github.json')
  const manifest = prependBin(join(dir, 'manifest.yaml'), bin)
  const prefix = `repos/${manifest.repo.github}/`
  const log = []

  const readState = () => JSON.parse(readFileSync(file, 'utf8'))
  const writeState = (state) => writeFileSync(file, JSON.stringify(state, null, 2))

  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  writeState({ repo: manifest.repo.github, origin, base, prs: [] })

  // As gh pr create: the number of the branch's open PR, or of a new one. A PR
  // is { number, branch, title, labels, author, merged }, and merged is null
  // or { sha, head, at }.
  function openPr({ branch, title, labels = [] }) {
    const state = readState()
    const open = state.prs.find((pr) => pr.branch === branch && !pr.merged)

    if (open) {
      return open.number
    }

    const number = state.prs.length + 1

    state.prs.push({ number, branch, title, labels, author: 'demo-bot', merged: null })
    writeState(state)

    return number
  }

  async function fetch(input, init = {}) {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const path = url.pathname.slice(1)
    const headers = Object.fromEntries(new Headers(init.headers))
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    const record = { method, path, query: Object.fromEntries(url.searchParams), body, status: null }
    const state = readState()
    const answer = path.startsWith(prefix) ? repoAnswer(state, record, path.slice(prefix.length)) : null

    log.push(record)

    if (!answer) {
      record.status = 400

      return respond(400, { message: `fake GitHub: no route for ${method} ${path}` })
    }

    if (method !== 'GET') {
      writeState(state)
    }

    record.status = answer.status

    if (method !== 'GET' || answer.status !== 200) {
      return respond(answer.status, answer.body)
    }

    const etag = etagOf(answer.body)

    if (headers['if-none-match'] === etag) {
      record.status = 304

      return new Response(null, { status: 304 })
    }

    return respond(200, answer.body, { etag })
  }

  return { fetch, openPr, requests: () => log, ghCalls: () => readCalls(bin).map((call) => call.args) }
}

// A root like ~/.rollouts: demo with a ledger and a brief, fresh without a
// ledger or a driver, broken with an invalid manifest, and the worktrees
// directory of demo, which holds no manifest.
export function makeRolloutRoot() {
  const root = mkdtempSync(join(tmpdir(), 'rollout-root-'))

  makeRollout({ dir: join(root, 'demo') })
  mkdirSync(join(root, 'demo', 'briefs'))
  writeFileSync(join(root, 'demo', 'briefs', 'A1.md'), '# A1\n')
  makeRollout({ dir: join(root, 'fresh'), prs: null, events: null, heartbeat: null, lock: false, logs: null })
  mkdirSync(join(root, 'broken'))
  writeFileSync(join(root, 'broken', 'manifest.yaml'), 'rollout: broken\n')
  mkdirSync(join(root, 'demo.worktrees', 'A1'), { recursive: true })

  return root
}

export function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Polls, so a check on a detached process or a file another process writes
// fails the test after timeoutMs instead of hanging it.
export async function waitFor(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// Sets process.env for one callback and restores it after, so a child sees
// synthetic parent values.
export async function withProcessEnv(values, callback) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))

  Object.assign(process.env, values)

  try {
    return await callback()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
}

// The variables in a file a child wrote with `env`.
export function readEnvFile(file) {
  const lines = readFileSync(file, 'utf8').split('\n')

  return Object.fromEntries(
    lines.filter((line) => line.includes('=')).map((line) => [line.split('=')[0], line.slice(line.indexOf('=') + 1)]),
  )
}
