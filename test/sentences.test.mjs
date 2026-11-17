import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergedSentence, statusSentence, timeText, wayOut } from '../lib/sentences.ts'
import { STAGE_STATUSES } from '../lib/state.ts'
import { STATUS_SAMPLES, at, sampleStatus } from './fixtures.mjs'

const FACTS = { id: 'A1', base: 'main', hold: null }
const HOLD = { at: at(10), by: 'maintainer', reason: 'waiting for the release' }
const BROKEN = /undefined|null|NaN|Invalid|\[object/

// Every kind and code of the table, once each, plus the view's own driver-stopped.
function allStatuses() {
  const seen = new Map()

  for (const kinds of Object.values(STAGE_STATUSES)) {
    for (const [kind, codes] of Object.entries(kinds)) {
      for (const code of codes) {
        seen.set(code, kind)
      }
    }
  }

  return [...[...seen].map(([code, kind]) => sampleStatus(kind, code)), { kind: 'waiting', code: 'driver-stopped', since: at(60) }]
}

function sentence(kind, code, changes = {}, facts = FACTS) {
  return statusSentence({ ...sampleStatus(kind, code), ...changes }, facts)
}

test('statusSentence: every code of STAGE_STATUSES and driver-stopped has a whole sentence', () => {
  const statuses = allStatuses()

  assert.equal(statuses.length, 41)
  assert.deepEqual(
    Object.keys(STATUS_SAMPLES).sort(),
    statuses
      .map((status) => status.code)
      .filter((code) => code !== 'driver-stopped')
      .sort(),
  )

  for (const status of statuses) {
    const text = statusSentence(status, { ...FACTS, hold: HOLD })

    assert.ok(text.length > 0, status.code)
    assert.doesNotMatch(text, BROKEN, `${status.code}: ${text}`)
  }
})

test('statusSentence: the sentences with their data', () => {
  const sha = 'a1a1a1a'

  assert.equal(sentence('running', 'fix'), 'the implementer is fixing: ci-red')
  assert.equal(sentence('running', 'delegate'), 'the delegate is answering the question (needs-decision)')
  assert.equal(sentence('running', 'commands'), `the driver runs the pre-verify commands on ${sha}`)
  assert.equal(sentence('running', 'verify'), `the verifier is checking ${sha}`)
  assert.equal(sentence('running', 'merge'), `merging ${sha}`)
  assert.equal(sentence('waiting', 'backoff'), 'waits until 2026-09-01 10:30 UTC after 2 failed runs')
  assert.equal(sentence('waiting', 'dependencies'), 'waits for A2, A3 to merge')
  assert.equal(sentence('waiting', 'dependencies-merge'), 'waits: the verified heads of A2, A3 do not merge cleanly together')
  assert.equal(sentence('waiting', 'outside-dependency'), 'waits for B7, which are not in this run')
  assert.equal(sentence('waiting', 'ci'), `CI runs on ${sha}: test, no run yet for lint`)
  assert.equal(sentence('waiting', 'base-red'), 'main is red at b0b0b0b: test, lint. Merges wait until it is green')
  assert.equal(sentence('waiting', 'base-pending'), 'main is not green yet at b0b0b0b')
  assert.equal(sentence('waiting', 'github-merge-state'), "GitHub's merge state is BEHIND")
  assert.equal(sentence('waiting', 'merge-delay'), 'approved, merges at 2026-09-01 11:35 UTC')
  assert.equal(sentence('waiting', 'queued'), 'ready after PR #12: one PR is ready at a time')
  assert.equal(sentence('waiting', 'review-in-progress'), 'the maintainer is reviewing, last comment at 2026-09-01 11:10 UTC')
  assert.equal(sentence('waiting', 'driver-stopped'), 'the driver is not running')
  assert.equal(sentence('needs-you', 'obstacle'), 'the implementer is blocked (environment): Keep the old flag?')
  assert.equal(sentence('needs-you', 'dispute'), 'the verifier upholds F1, F2, which the implementer disputes')
  assert.equal(sentence('needs-you', 'attempts-exhausted'), 'fix attempts exhausted (3)')
  assert.equal(sentence('needs-you', 'errors'), '5 ticks in a row failed: gh pr view failed: HTTP 502')
  assert.equal(sentence('needs-you', 'merge-refused'), 'GitHub refused the merge: Base branch was modified')
  assert.equal(sentence('needs-you', 'review'), "verified, waits for a maintainer's review on GitHub")
  assert.equal(
    sentence('needs-you', 'review', { stale: true }),
    "verified, waits for a maintainer's review on GitHub: the approval is older than the current patch",
  )

  assert.equal(sentence('needs-you', 'merge-by-hand'), 'ready: merge it on GitHub (CLEAN)')
  assert.equal(sentence('needs-you', 'gate-blocked'), 'the gate blocks the merge (missing-label): the PR lacks the label rollout:demo')
  assert.equal(sentence('needs-you', 'code-scanning-alerts'), 'new code scanning alerts: js/sql-injection at lib/db.mjs:12')
})

test('statusSentence: an empty list drops its part, or falls back where the list is the subject', () => {
  assert.equal(sentence('waiting', 'dependencies', { on: [] }), 'waits for its dependencies to merge')
  assert.equal(
    sentence('waiting', 'dependencies-merge', { heads: [] }),
    'waits: the verified heads of its dependencies do not merge cleanly together',
  )

  assert.equal(sentence('waiting', 'outside-dependency', { on: [] }), 'waits for dependencies outside this run')
  assert.equal(sentence('waiting', 'ci', { pending: [] }), 'CI runs on a1a1a1a: no run yet for lint')
  assert.equal(sentence('waiting', 'ci', { missing: [] }), 'CI runs on a1a1a1a: test')
  assert.equal(sentence('waiting', 'ci', { missing: [], pending: [] }), 'CI runs on a1a1a1a')
  assert.equal(sentence('waiting', 'base-red', { failing: [] }), 'main is red at b0b0b0b. Merges wait until it is green')
  assert.equal(sentence('needs-you', 'dispute', { findings: [] }), 'the verifier upholds a finding the implementer disputes')
  assert.equal(sentence('needs-you', 'gate-blocked', { reasons: [] }), 'the gate blocks the merge (missing-label)')
  assert.equal(sentence('needs-you', 'code-scanning-alerts', { alerts: [] }), 'new code scanning alerts')
  assert.equal(sentence('needs-you', 'merge-refused', { error: '' }), 'GitHub refused the merge')
  assert.equal(sentence('needs-you', 'merge-by-hand', { mergeState: '' }), 'ready: merge it on GitHub')
  assert.equal(sentence('waiting', 'github-merge-state', { mergeState: '' }), "GitHub's merge state is unknown")
})

test('statusSentence: an empty sha reads the head, and drops its part on the base', () => {
  assert.equal(sentence('running', 'verify', { sha: '' }), 'the verifier is checking the head')
  assert.equal(sentence('waiting', 'ci', { sha: '' }), 'CI runs on the head: test, no run yet for lint')
  assert.equal(sentence('waiting', 'code-scanning-pending', { sha: '' }), 'code scanning has not analysed the head yet')
  assert.equal(sentence('waiting', 'base-red', { sha: '' }), 'main is red: test, lint. Merges wait until it is green')
  assert.equal(sentence('waiting', 'base-pending', { sha: '' }), 'main is not green yet')
  assert.equal(sentence('waiting', 'base-pending', {}, { ...FACTS, base: 'develop' }), 'develop is not green yet at b0b0b0b')
})

test('statusSentence: a count of 0 drops its part, and one failure is one run', () => {
  assert.equal(sentence('needs-you', 'errors', { count: 0 }), 'repeated errors: gh pr view failed: HTTP 502')
  assert.equal(sentence('needs-you', 'errors', { count: 0, error: '' }), 'repeated errors')
  assert.equal(sentence('waiting', 'backoff', { failures: 0 }), 'waits until 2026-09-01 10:30 UTC')
  assert.equal(sentence('waiting', 'backoff', { failures: 1 }), 'waits until 2026-09-01 10:30 UTC after 1 failed run')
  assert.equal(sentence('needs-you', 'attempts-exhausted', { limit: 0 }), 'fix attempts exhausted')
})

test('statusSentence: a hold with and without a reason, on the PR and on the rollout, and none in the facts', () => {
  const held = (scope, hold) => sentence('waiting', 'held', { scope }, { ...FACTS, hold })

  assert.equal(held('pr', HOLD), 'held since 2026-09-01 10:10 UTC by maintainer: waiting for the release')
  assert.equal(held('pr', { ...HOLD, reason: null }), 'held since 2026-09-01 10:10 UTC by maintainer')
  assert.equal(
    held('rollout', { ...HOLD, by: 'driver', reason: 'usage limit' }),
    'the whole rollout is held since 2026-09-01 10:10 UTC by driver: usage limit',
  )

  assert.equal(held('pr', { ...HOLD, at: '' }), 'held by maintainer: waiting for the release')
  assert.equal(held('pr', null), 'held')
  assert.equal(held('rollout', null), 'the whole rollout is held')
})

test('statusSentence: a question prints its first non-blank line only', () => {
  const question = { ...STATUS_SAMPLES.decision.question, text: '\n  \nWhich API?\nThe old one is deprecated.' }

  assert.equal(sentence('needs-you', 'decision', { question }), 'the implementer asks: Which API?')
  assert.equal(sentence('needs-you', 'brief-questions'), 'the brief needs your answer: Keep the old flag?')
  assert.equal(sentence('needs-you', 'decision', { question: { ...question, text: '' } }), 'the implementer asks')
})

test('statusSentence: a question the delegate handed back names what it did, with the first line of its reason', () => {
  const plain = {
    'brief-questions': 'the brief needs your answer: Keep the old flag?',
    decision: 'the implementer asks: Keep the old flag?',
    obstacle: 'the implementer is blocked (environment): Keep the old flag?',
  }

  const parts = [
    [
      { outcome: 'escalated', reason: '\nThe plan is silent on the flag.\nThe brief too.' },
      ' (the delegate passed it on: The plan is silent on the flag.)',
    ],
    [{ outcome: 'escalated', reason: '' }, ' (the delegate passed it on)'],
    [{ outcome: 'failed', reason: 'killed by SIGKILL' }, ' (the delegate failed: killed by SIGKILL)'],
    [{ outcome: 'failed', reason: '  ' }, ' (the delegate failed)'],
    [null, ''],
  ]

  for (const [code, text] of Object.entries(plain)) {
    for (const [delegate, part] of parts) {
      const question = { ...STATUS_SAMPLES[code].question, delegate }

      assert.equal(sentence('needs-you', code, { question }), `${text}${part}`, `${code} ${JSON.stringify(delegate)}`)
    }
  }
})

test('statusSentence: a code with no sentence throws', () => {
  assert.throws(() => statusSentence({ kind: 'waiting', code: 'nothing', since: at(0) }, FACTS), /no sentence for the status code nothing/)
})

test('mergedSentence: the short merge commit, or merged alone', () => {
  assert.equal(mergedSentence('feedface00'), 'merged as feedfac')
  assert.equal(mergedSentence(null), 'merged')
  assert.equal(mergedSentence(''), 'merged')
})

test('timeText: minutes in UTC, and an unknown time for anything else', () => {
  assert.equal(timeText('2026-09-01T10:05:59.000Z'), '2026-09-01 10:05 UTC')
  assert.equal(timeText('2026-09-01T12:05:00+02:00'), '2026-09-01 10:05 UTC')

  for (const value of ['', 'yesterday', null, undefined, 42]) {
    assert.equal(timeText(value), 'an unknown time', String(value))
  }
})

test('wayOut: each way out with the id, release for a held status, and none for the rest', () => {
  const way = (kind, code, changes = {}) => wayOut({ ...sampleStatus(kind, code), ...changes }, FACTS)

  assert.deepEqual(way('needs-you', 'decision'), { kind: 'note', text: 'rollout note A1 "..."' })
  assert.deepEqual(way('needs-you', 'errors'), { kind: 'retry', text: 'rollout retry A1' })
  assert.deepEqual(way('needs-you', 'obstacle'), {
    kind: 'retry-or-note',
    text: 'remove the cause, then rollout retry A1, or rollout note A1 "..."',
  })

  assert.deepEqual(way('needs-you', 'approve'), { kind: 'approve', text: 'rollout approve A1' })
  assert.deepEqual(way('needs-you', 'merge-by-hand'), { kind: 'github', text: 'act on GitHub. The driver reads it again every tick' })
  assert.deepEqual(way('waiting', 'held'), { kind: 'release', text: 'rollout release A1' })
  assert.deepEqual(way('waiting', 'held', { scope: 'rollout' }), { kind: 'release', text: 'rollout release --all' })

  for (const status of allStatuses().filter((item) => item.kind !== 'needs-you' && item.code !== 'held')) {
    assert.equal(wayOut(status, FACTS), null, status.code)
  }

  for (const status of allStatuses().filter((item) => item.kind === 'needs-you')) {
    assert.ok(wayOut(status, FACTS).text.length > 0, status.code)
  }
})
