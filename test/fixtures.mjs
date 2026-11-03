import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { freshPr } from '../lib/ledger.mjs'

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

export function makeRollout(overrides = {}) {
  const options = {
    prs: samplePrs(),
    paused: false,
    halted: null,
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
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ prs, paused: options.paused, halted: options.halted }, null, 2))
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

  function calls() {
    const log = join(bin, 'calls.jsonl')

    if (!existsSync(log)) {
      return []
    }

    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }

  answer(rules)

  return { answer, calls }
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
