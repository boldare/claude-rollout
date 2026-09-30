import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadManifest } from '../lib/manifest.mjs'
import { failureReason, failureSignals, runAgent, streamError } from '../lib/spawn.mjs'
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
  const M = loadManifest(makeRollout())
  const pr = M.all[0]

  M.claudeBin = join(M.dir, 'no-such-claude')

  const result = await runAgent(M, pr, {
    role: 'implement',
    prompt: 'unused',
    effort: 'high',
    sessionId: '00000000-0000-4000-8000-000000000000',
    resume: false,
    cwd: M.repo.path,
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
function fakeClaude(M, script, lines = null) {
  const bin = join(M.dir, 'fake-claude')
  let body = script

  if (lines) {
    const stream = join(M.dir, 'fake-stream.jsonl')
    writeFileSync(stream, jsonLines(lines) + '\n')
    body = `cat '${stream}'\n${script}`
  }

  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  M.claudeBin = bin
}

function run(M, logName) {
  return runAgent(M, M.all[0], {
    role: 'implement',
    prompt: 'unused',
    effort: 'high',
    sessionId: '00000000-0000-4000-8000-000000000000',
    resume: false,
    cwd: M.repo.path,
    logName,
  })
}

test('runAgent: a run killed by a signal names the signal', async () => {
  const M = loadManifest(makeRollout())

  fakeClaude(M, 'kill -9 $$')

  const result = await run(M, 'A1-01-sigkill')

  assert.equal(result.ok, false)
  assert.equal(result.error, 'killed by SIGKILL')
  assert.equal(result.transient, false)
})

test('runAgent: stderr from before a timeout still classifies the run', async () => {
  const M = loadManifest(makeRollout())

  M.policy.timeouts.implement = 0.01
  // exec, so SIGTERM reaches sleep and the pipes close with it.
  fakeClaude(M, "echo 'API Error: 429 rate limit exceeded' >&2\nexec sleep 30")

  const result = await run(M, 'A1-01-timeout')

  assert.equal(result.ok, false)
  assert.equal(result.error, 'timeout after 0.01 min')
  assert.equal(result.transient, true)
})

test('runAgent: a billing error in the stream is an account problem', async () => {
  const M = loadManifest(makeRollout())
  const failure = { type: 'result', subtype: 'success', is_error: true, total_cost_usd: 0, result: 'API Error: Credit balance is too low' }

  fakeClaude(M, 'exit 1', [apiErrorLine('billing_error'), failure])

  const result = await run(M, 'A1-01-billing')

  assert.equal(result.ok, false)
  assert.equal(result.account, true)
  assert.equal(result.transient, false)
})

test('runAgent: a run that hits its budget cap fails as a normal attempt', async () => {
  const M = loadManifest(makeRollout())

  fakeClaude(M, 'exit 1', [BUDGET_RESULT])

  const result = await run(M, 'A1-01-budget')

  assert.equal(result.ok, false)
  assert.equal(result.error, 'hit its budget cap ($20): Reached maximum budget ($20)')
  assert.equal(result.costUsd, 20.4)
  assert.equal(result.transient, false)
  assert.equal(result.account, false)
})
