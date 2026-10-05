import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentEnv } from '../lib/identity.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { children, failureReason, failureSignals, runAgent, streamError } from '../lib/spawn.mjs'
import { jsonLines, makeRollout, sampleTranscript } from './fixtures.mjs'

// What claude prints for `--resume` of a session that never reached disk.
const RESUME_MISSING = {
  stdout: { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, total_cost_usd: 0 },
  stderr: 'No conversation found with session ID: 00000000-0000-4000-8000-000000000000\n',
}

test('failureSignals: a missing session is read from stderr, not from the subtype', () => {
  assert.deepEqual(failureSignals(RESUME_MISSING.stdout, RESUME_MISSING.stderr), {
    transient: false,
    account: false,
    sessionMissing: true,
  })

  assert.equal(failureSignals(RESUME_MISSING.stdout, '').sessionMissing, false)
})

test('failureSignals: transient and account problems', () => {
  assert.equal(failureSignals({ api_error_status: 529 }, '').transient, true)
  assert.equal(failureSignals({ api_error_status: 429 }, '').transient, true)
  assert.equal(failureSignals({ api_error_status: 400 }, '').transient, false)
  assert.equal(failureSignals(null, 'Error: socket hang up').transient, true)
  assert.equal(failureSignals(null, 'Your credit balance is too low').account, true)
  assert.deepEqual(failureSignals(null, ''), { transient: false, account: false, sessionMissing: false })
})

test('failureSignals: the agent answer never counts, only stderr', () => {
  const result = { subtype: 'success', is_error: true, result: 'No conversation found; rate limit; billing' }

  assert.deepEqual(failureSignals(result, ''), { transient: false, account: false, sessionMissing: false })
})

test('runAgent: a missing claude binary fails the run instead of throwing', async () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]

  manifest.claudeBin = join(manifest.dir, 'no-such-claude')

  const result = await runAgent(manifest, pr, {
    role: 'implement',
    prompt: 'unused',
    effort: 'high',
    sessionId: '00000000-0000-4000-8000-000000000000',
    resume: false,
    cwd: manifest.repo.path,
    logName: 'A1-01-implement',
  })

  assert.equal(result.ok, false)
  assert.match(result.error, /ENOENT/)
})

const TRANSIENT_KINDS = ['rate_limit', 'overloaded', 'server_error']
const ACCOUNT_KINDS = ['billing_error', 'account_on_hold', 'authentication_failed']

function apiErrorLine(kind, extra = {}) {
  return {
    type: 'assistant',
    message: {
      id: 'msg-err',
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: 'API Error: Credit balance is too low' }],
    },
    parent_tool_use_id: null,
    error: kind,
    is_api_error_message: true,
    api_error_status: 400,
    uuid: 'u-1',
    session_id: 'session-1',
    ...extra,
  }
}

function rateLimitEvent(status) {
  return {
    type: 'rate_limit_event',
    rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt: 1790000000 },
    uuid: 'u-2',
    session_id: 'session-1',
  }
}

const BUDGET_RESULT = {
  type: 'result',
  subtype: 'error_max_budget_usd',
  is_error: true,
  total_cost_usd: 20.4,
  errors: ['Reached maximum budget ($20)'],
  session_id: 'session-1',
}

test('streamError: the kind of a main-agent API error line', () => {
  for (const kind of [...TRANSIENT_KINDS, ...ACCOUNT_KINDS]) {
    assert.equal(streamError(apiErrorLine(kind)), kind)
  }
})

test('streamError: a subagent API error never counts', () => {
  assert.equal(streamError(apiErrorLine('billing_error', { parent_tool_use_id: 'tool-1' })), null)
})

test('streamError: only a rejected rate limit event counts', () => {
  assert.equal(streamError(rateLimitEvent('rejected')), 'rate_limit')
  assert.equal(streamError(rateLimitEvent('allowed')), null)
  assert.equal(streamError(rateLimitEvent('allowed_warning')), null)
})

test('streamError: anything else is null', () => {
  assert.equal(streamError(null), null)
  assert.equal(streamError('API Error: rate limit'), null)

  for (const line of sampleTranscript()) {
    assert.equal(streamError(line), null)
  }
})

test('failureSignals: claude error kinds from the stream', () => {
  for (const kind of TRANSIENT_KINDS) {
    assert.deepEqual(failureSignals(null, '', [kind]), { transient: true, account: false, sessionMissing: false })
  }

  for (const kind of ACCOUNT_KINDS) {
    assert.deepEqual(failureSignals(null, '', [kind]), { transient: false, account: true, sessionMissing: false })
  }

  assert.deepEqual(failureSignals(null, '', ['invalid_request']), { transient: false, account: false, sessionMissing: false })
  assert.deepEqual(failureSignals(null, '', ['unknown']), { transient: false, account: false, sessionMissing: false })
})

test('failureSignals: the run budget cap is neither an outage nor an account limit', () => {
  const result = { type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: ['Reached maximum budget ($20)'] }

  assert.deepEqual(failureSignals(result, 'Error: budget exceeded', ['rate_limit']), {
    transient: false,
    account: false,
    sessionMissing: false,
  })
})

test('failureReason: the budget cap and claude errors', () => {
  assert.equal(
    failureReason({ result: BUDGET_RESULT, stderr: '', code: 1, signal: null, budgetUsd: 20 }),
    'hit its budget cap ($20): Reached maximum budget ($20)',
  )

  assert.equal(
    failureReason({ result: { subtype: 'error_max_turns', errors: ['Reached maximum number of turns (40)'] }, stderr: '', code: 1 }),
    'error_max_turns: Reached maximum number of turns (40)',
  )
})

test('failureReason: signals, stderr and exit codes', () => {
  assert.equal(failureReason({ result: null, stderr: '', code: null, signal: 'SIGKILL' }), 'killed by SIGKILL')
  assert.equal(failureReason({ result: null, stderr: 'boom\n', code: null, signal: 'SIGKILL' }), 'killed by SIGKILL: boom')
  assert.equal(failureReason({ result: null, stderr: 'boom\n', code: 1, signal: null }), 'boom')
  assert.equal(failureReason({ result: null, stderr: '', code: 3, signal: null }), 'exited with code 3')
  assert.equal(failureReason({ result: { subtype: 'success', is_error: true, result: '' }, stderr: '', code: 0 }), 'exited with code 0')
})

// A fake claude inside the temp rollout. Stream lines go through a file, so the script needs no JSON quoting.
function fakeClaude(manifest, script, lines = null) {
  const bin = join(manifest.dir, 'fake-claude')
  let body = script

  if (lines) {
    const stream = join(manifest.dir, 'fake-stream.jsonl')
    writeFileSync(stream, jsonLines(lines) + '\n')
    body = `cat '${stream}'\n${script}`
  }

  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  manifest.claudeBin = bin
}

function run(manifest, logName, seams) {
  return runAgent(
    manifest,
    manifest.all[0],
    {
      role: 'implement',
      prompt: 'unused',
      effort: 'high',
      sessionId: '00000000-0000-4000-8000-000000000000',
      resume: false,
      cwd: manifest.repo.path,
      logName,
    },
    seams,
  )
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// Records the ticker instead of arming it. tick() moves a fake clock and
// fires the ticker, so the test decides how much time passes between checks.
function manualTimers() {
  const intervals = []
  let time = Date.parse('2026-01-01T00:00:00Z')
  const timers = {
    setInterval: (callback, ms) => {
      intervals.push({ callback, ms })

      return intervals.length
    },
    clearInterval: () => {},
  }

  function tick(ms = MINUTE) {
    time += ms
    intervals[0].callback()
  }

  function ticks(count) {
    for (let i = 0; i < count; i += 1) {
      tick()
    }
  }

  return { seams: { timers, clock: () => time }, intervals, tick, ticks }
}

// A fake claude that prints nothing and lives until it is killed.
function silentRun(context, manifest, logName, seams) {
  fakeClaude(manifest, 'exec sleep 30')

  const running = run(manifest, logName, seams)
  const [child] = children

  context.after(() => child.kill('SIGKILL'))

  return { running, child }
}

// Resolves on close too, so a broken fake fails the test instead of hanging it.
function stderrSeen(child, text) {
  return new Promise((resolve) => {
    let seen = ''

    child.stderr.on('data', (chunk) => {
      seen += chunk

      if (seen.includes(text)) {
        resolve()
      }
    })

    child.on('close', resolve)
  })
}

test('runAgent: a run killed by a signal names the signal', async () => {
  const manifest = loadManifest(makeRollout())

  fakeClaude(manifest, 'kill -9 $$')

  const result = await run(manifest, 'A1-01-sigkill')

  assert.equal(result.ok, false)
  assert.equal(result.error, 'killed by SIGKILL')
  assert.equal(result.transient, false)
})

test('runAgent: stderr from before a timeout still classifies the run', async (context) => {
  const manifest = loadManifest(makeRollout())
  const { seams, intervals, tick } = manualTimers()

  manifest.policy.timeouts.implement = 1
  // exec, so SIGTERM reaches sleep and the pipes close with it.
  fakeClaude(manifest, "echo 'API Error: 429 rate limit exceeded' >&2\nexec sleep 30")

  const running = run(manifest, 'A1-01-timeout', seams)

  assert.equal(children.size, 1)

  const [child] = children

  context.after(() => child.kill('SIGKILL'))

  await stderrSeen(child, 'rate limit exceeded')

  assert.deepEqual(
    intervals.map((interval) => interval.ms),
    [MINUTE],
  )

  tick()

  const result = await running

  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout after 1 min')
  assert.equal(result.transient, true)
})

test('runAgent: a 2-hour sleep counts toward the wall clock and not toward the timeout', async (context) => {
  const manifest = loadManifest(makeRollout())
  const { seams, intervals, tick, ticks } = manualTimers()

  manifest.policy.timeouts.implement = 60
  manifest.policy.stallMinutes = 600

  const { running, child } = silentRun(context, manifest, 'A1-01-sleep', seams)

  ticks(30)
  tick(2 * HOUR)
  ticks(20)

  assert.equal(child.killed, false)

  child.kill('SIGTERM')

  const result = await running

  assert.deepEqual(
    intervals.map((interval) => interval.ms),
    [MINUTE],
  )

  assert.equal(result.seconds, 10200)
  assert.equal(result.awakeSeconds, 3060)
  assert.equal(result.error, 'killed by SIGTERM')
})

test('runAgent: the timeout kills a run on its last awake minute', async (context) => {
  const manifest = loadManifest(makeRollout())
  const { seams, intervals, tick, ticks } = manualTimers()

  manifest.policy.timeouts.implement = 60
  manifest.policy.stallMinutes = 600

  const { running, child } = silentRun(context, manifest, 'A1-01-deadline', seams)

  ticks(59)

  assert.equal(child.killed, false)

  tick()

  assert.equal(child.killed, true)

  const result = await running

  assert.deepEqual(
    intervals.map((interval) => interval.ms),
    [MINUTE],
  )

  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout after 60 min')
  assert.equal(result.transient, false)
})

test('runAgent: the stall watchdog counts quiet awake minutes and skips a sleep', async (context) => {
  const manifest = loadManifest(makeRollout())
  const { seams, intervals, tick, ticks } = manualTimers()
  const { running, child } = silentRun(context, manifest, 'A1-01-stall', seams)

  ticks(5)
  tick(2 * HOUR)
  ticks(5)

  assert.equal(child.killed, false)

  ticks(9)

  assert.equal(child.killed, false)

  tick()

  assert.equal(child.killed, true)

  const result = await running

  assert.deepEqual(
    intervals.map((interval) => interval.ms),
    [MINUTE],
  )

  assert.equal(result.ok, false)
  assert.equal(result.error, 'no output for 20 min')
})

test('runAgent: a billing error in the stream is an account problem', async () => {
  const manifest = loadManifest(makeRollout())
  const failure = { type: 'result', subtype: 'success', is_error: true, total_cost_usd: 0, result: 'API Error: Credit balance is too low' }

  fakeClaude(manifest, 'exit 1', [apiErrorLine('billing_error'), failure])

  const result = await run(manifest, 'A1-01-billing')

  assert.equal(result.ok, false)
  assert.equal(result.account, true)
  assert.equal(result.transient, false)
})

test('runAgent: a run that hits its budget cap fails as a normal attempt', async () => {
  const manifest = loadManifest(makeRollout())

  fakeClaude(manifest, 'exit 1', [BUDGET_RESULT])

  const result = await run(manifest, 'A1-01-budget')

  assert.equal(result.ok, false)
  assert.equal(result.error, 'hit its budget cap ($20): Reached maximum budget ($20)')
  assert.equal(result.costUsd, 20.4)
  assert.equal(result.transient, false)
  assert.equal(result.account, false)
})

test('runAgent: the delegate runs read-only, with no branch and its own schema', async () => {
  const manifest = loadManifest(makeRollout())
  const argsFile = join(manifest.dir, 'args.bin')
  const branchFile = join(manifest.dir, 'branch.txt')

  fakeClaude(manifest, `printf '%s\\0' "$@" > '${argsFile}'\nprintf '%s' "\${ROLLOUT_BRANCH-unset}" > '${branchFile}'\nexit 1`)

  const result = await runAgent(manifest, manifest.all[0], {
    role: 'delegate',
    prompt: 'unused',
    effort: 'high',
    sessionId: '00000000-0000-4000-8000-000000000000',
    resume: false,
    cwd: manifest.repo.path,
    logName: 'A1-01-delegate',
  })

  const args = readFileSync(argsFile, 'utf8').split('\0').slice(0, -1)
  const disallowed = args.indexOf('--disallowedTools')
  const schema = JSON.parse(readFileSync(new URL('../schemas/delegate.json', import.meta.url), 'utf8'))

  assert.equal(result.ok, false)
  assert.deepEqual(args.slice(disallowed, disallowed + 4), ['--disallowedTools', 'Edit', 'Write', 'NotebookEdit'])
  assert.equal(readFileSync(branchFile, 'utf8'), '')
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), schema)
})

// What a maintainer's shell may export. With GH_HOST set, gh reads the keyring login.
const SHELL_GITHUB_ENV = {
  GH_HOST: 'ghe.example.com',
  GH_ENTERPRISE_TOKEN: 'synthetic-enterprise-token',
  GITHUB_ENTERPRISE_TOKEN: 'synthetic-enterprise-token',
}

async function withProcessEnv(values, callback) {
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

function withAgentToken(manifest) {
  manifest.repo.agentToken = join(manifest.dir, 'agent-token')
  writeFileSync(manifest.repo.agentToken, 'synthetic-agent-token\n')
}

test('runAgent: agents get GH_REPO and ROLLOUT_REPO and never GH_HOST', async () => {
  const manifest = loadManifest(makeRollout())
  const envFile = join(manifest.dir, 'agent-env.txt')

  withAgentToken(manifest)
  fakeClaude(manifest, `env > '${envFile}'\nexit 1`)

  const result = await withProcessEnv(SHELL_GITHUB_ENV, () => run(manifest, 'A1-01-env'))
  const lines = readFileSync(envFile, 'utf8').split('\n')
  const env = Object.fromEntries(
    lines.filter((line) => line.includes('=')).map((line) => [line.split('=')[0], line.slice(line.indexOf('=') + 1)]),
  )

  assert.equal(result.ok, false)
  assert.equal(env.GH_REPO, 'github.com/example/demo')
  assert.equal(env.ROLLOUT_REPO, 'example/demo')
  assert.equal(env.GH_TOKEN, 'synthetic-agent-token')
  assert.equal(env.GH_CONFIG_DIR, join(manifest.dir, '.gh-agents'))

  for (const name of Object.keys(SHELL_GITHUB_ENV)) {
    assert.equal(name in env, false, name)
  }
})

test('agentEnv: extra never brings back GH_HOST or moves GH_REPO', () => {
  const manifest = loadManifest(makeRollout())

  withAgentToken(manifest)

  const env = agentEnv(manifest, {
    ...SHELL_GITHUB_ENV,
    GH_REPO: 'other/x',
    GH_TOKEN: 'another-token',
    GH_CONFIG_DIR: '/tmp/gh',
    ROLLOUT_ROLE: 'implement',
  })

  assert.equal(env.GH_REPO, 'github.com/example/demo')
  assert.equal(env.GH_TOKEN, 'synthetic-agent-token')
  assert.equal(env.GH_CONFIG_DIR, join(manifest.dir, '.gh-agents'))
  assert.equal(env.ROLLOUT_ROLE, 'implement')

  for (const name of Object.keys(SHELL_GITHUB_ENV)) {
    assert.equal(name in env, false, name)
  }

  manifest.repo.agentToken = null

  const unpinned = agentEnv(manifest, { GH_HOST: 'github.com' })

  assert.equal(unpinned.GH_REPO, 'github.com/example/demo')
  assert.equal('GH_HOST' in unpinned, false)
})
