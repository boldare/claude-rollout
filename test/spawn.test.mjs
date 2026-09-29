import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failureSignals } from '../lib/spawn.mjs'

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
