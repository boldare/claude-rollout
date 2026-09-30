import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDriver, doneDetail } from '../lib/driver.mjs'
import { postCommand } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { readEvents } from '../lib/view.mjs'
import { makeRollout } from './fixtures.mjs'

function agentResult(overrides = {}) {
  return { ok: true, output: null, costUsd: 1.25, seconds: 60, denials: [], error: null, stopped: false, ...overrides }
}

function headline(role, output) {
  return doneDetail(role, 'A1-01-run', agentResult({ output })).result
}

// A driver on a fixture rollout. Only commands that never notify are posted.
function driverFor(prs, options) {
  const M = loadManifest(makeRollout({ prs, events: [] }))

  return { M, driver: createDriver(M, options) }
}

// Posts the commands, applies them and returns the events they caused.
function apply(M, driver, ...commands) {
  const before = readEvents(M).length

  for (const command of commands) {
    postCommand(M, command)
  }

  driver.applyCommands()

  return readEvents(M)
    .slice(before)
    .map(({ at: _, ...event }) => event)
}

// postCommand names can tie within a millisecond and then sort at random,
// so a batch whose order matters is written under numbered names.
function writeBatch(M, contents) {
  contents.forEach((content, index) => {
    const text = typeof content === 'string' ? content : JSON.stringify(content)
    writeFileSync(join(M.dir, 'inbox', `${String(index + 1).padStart(4, '0')}-test.json`), text)
  })
}

function sorted(events) {
  return events.map((event) => JSON.stringify(event)).sort()
}

test('doneDetail: the headline of each role', () => {
  assert.equal(headline('implement', { status: 'READY' }), 'READY')
  assert.equal(headline('fix', { status: 'BLOCKED' }), 'BLOCKED')
  assert.equal(headline('verify', { verdict: 'PASS' }), 'PASS')
  assert.equal(headline('verify', { verdict: 'FAIL' }), 'FAIL')
  assert.equal(headline('brief', { brief: '# A1', questions: [] }), 'BRIEF')
  assert.equal(headline('brief', { brief: '', questions: ['Which API?'] }), 'QUESTIONS')
})

test('doneDetail: no headline when not ok, stopped as a boolean, denials as a count', () => {
  const failed = doneDetail(
    'verify',
    'A1-02-verify',
    agentResult({ ok: false, costUsd: 0, seconds: 3, denials: [{}, {}], error: 'x'.repeat(300), stopped: undefined }),
  )

  assert.deepEqual(failed, {
    run: 'A1-02-verify',
    ok: false,
    result: null,
    cost: 0,
    seconds: 3,
    denials: 2,
    stopped: false,
    error: 'x'.repeat(200),
  })
  assert.equal(doneDetail('fix', 'A1-03-fix', { ok: false, stopped: true }).stopped, true)
  assert.equal(doneDetail('fix', 'A1-03-fix', { ok: false }).denials, 0)
  assert.equal(doneDetail('fix', 'A1-03-fix', { ok: false }).error, null)
})

test('doneDetail never overwrites the event envelope', () => {
  const detail = doneDetail('implement', 'A1-01-implement', agentResult({ output: { status: 'READY' } }))

  for (const key of ['at', 'id', 'kind']) {
    assert.ok(!(key in detail), key)
  }
})

test('hold parks a PR and release lifts it', () => {
  const { M, driver } = driverFor({ A1: { state: 'needs_fix' } })

  assert.deepEqual(apply(M, driver, { cmd: 'hold', id: 'A1' }), [{ id: 'A1', kind: 'held', state: 'needs_fix', running: null }])
  assert.ok(Date.parse(driver.L.prs.A1.held.at))

  assert.deepEqual(apply(M, driver, { cmd: 'release', id: 'A1' }), [{ id: 'A1', kind: 'released', state: 'needs_fix' }])
  assert.equal(driver.L.prs.A1.held, null)
})

test('hold records the agent that keeps running', () => {
  const { M, driver } = driverFor({ A1: { state: 'fixing' } })
  driver.running.set('A1', 'fix')

  assert.deepEqual(apply(M, driver, { cmd: 'hold', id: 'A1' }), [{ id: 'A1', kind: 'held', state: 'fixing', running: 'fix' }])
})

test('hold and release reject what they cannot do, and the rest of the batch still applies', () => {
  const { M, driver } = driverFor({ A1: { state: 'pending' }, A2: { state: 'merged' } })
  apply(M, driver, { cmd: 'hold', id: 'A1' })

  const events = apply(
    M,
    driver,
    { cmd: 'hold' },
    { cmd: 'release' },
    { cmd: 'hold', id: 'Z9' },
    { cmd: 'hold', id: 'A2' },
    { cmd: 'hold', id: 'A1' },
    { cmd: 'release', id: 'A3' },
  )

  assert.deepEqual(
    sorted(events),
    sorted([
      { id: '-', kind: 'command-rejected', command: 'hold', reason: 'needs a PR id' },
      { id: '-', kind: 'command-rejected', command: 'release', reason: 'needs a PR id' },
      { id: '-', kind: 'command-rejected', command: 'hold', reason: 'unknown PR Z9' },
      { id: 'A2', kind: 'command-rejected', command: 'hold', reason: 'already merged' },
      { id: 'A1', kind: 'command-rejected', command: 'hold', reason: 'already held' },
      { id: 'A3', kind: 'command-rejected', command: 'release', reason: 'not held' },
    ]),
  )
  assert.ok(driver.L.prs.A1.held)
  assert.equal(driver.L.prs.A2.held, null)
  assert.equal(driver.L.prs.A3.held, null)
})

test('each bad command is rejected with its reason, and the rest of the batch still applies', () => {
  const { M, driver } = driverFor({ A1: { state: 'pending' } })

  Object.defineProperty(driver.L.prs.A3, 'state', {
    get() {
      throw new Error('boom')
    },
  })
  writeBatch(M, [
    'null',
    '[]',
    '42',
    '"pause"',
    '{',
    { cmd: 'approve' },
    { cmd: 'note', text: 'x' },
    { cmd: 'retry' },
    { cmd: 'retry', id: 7 },
    { cmd: 'hold', id: '__proto__' },
    { cmd: 'retry', id: '__proto__' },
    { cmd: 'launch' },
    { cmd: 'hold', id: 'A3' },
    { cmd: 'hold', id: 'A1' },
  ])

  const events = apply(M, driver)
  const notAnObject = { id: '-', kind: 'command-rejected', command: null, reason: 'not a JSON object' }

  // V8 words the rest of a JSON error differently across Node versions.
  assert.match(events[4].reason, /^SyntaxError/)
  events[4].reason = 'SyntaxError'

  assert.deepEqual(events, [
    notAnObject,
    notAnObject,
    notAnObject,
    notAnObject,
    { id: '-', kind: 'command-rejected', command: 'invalid', file: '0005-test.json', reason: 'SyntaxError' },
    { id: '-', kind: 'command-rejected', command: 'approve', reason: 'needs a PR id' },
    { id: '-', kind: 'command-rejected', command: 'note', reason: 'needs a PR id' },
    { id: '-', kind: 'command-rejected', command: 'retry', reason: 'needs a PR id' },
    { id: '-', kind: 'command-rejected', command: 'retry', reason: 'needs a PR id' },
    { id: '-', kind: 'command-rejected', command: 'hold', reason: 'unknown PR __proto__' },
    { id: '-', kind: 'command-rejected', command: 'retry', reason: 'unknown PR __proto__' },
    { id: '-', kind: 'command-rejected', command: 'launch', reason: 'unknown command' },
    { id: 'A3', kind: 'command-rejected', command: 'hold', reason: 'boom' },
    { id: 'A1', kind: 'held', state: 'pending', running: null },
  ])
  assert.ok(driver.L.prs.A1.held)
  assert.equal(driver.L.data.paused, false)
  assert.equal(Object.prototype.held, undefined)
  assert.equal(Object.prototype.state, undefined)
  assert.equal(Object.prototype.attempts, undefined)
})

test('a PR still in the ledger but gone from the manifest is unknown, and a pause naming one still pauses', () => {
  const { M, driver } = driverFor({ A1: { state: 'pending' }, B9: { state: 'needs_fix' } })
  const before = structuredClone(driver.L.prs.B9)

  const events = apply(
    M,
    driver,
    { cmd: 'note', id: 'B9', text: 'x' },
    { cmd: 'approve', id: 'B9', sha: 'x', patchId: 'y' },
    { cmd: 'pause', id: 'Z9' },
  )

  assert.deepEqual(
    sorted(events),
    sorted([
      { id: '-', kind: 'command-rejected', command: 'note', reason: 'unknown PR B9' },
      { id: '-', kind: 'command-rejected', command: 'approve', reason: 'unknown PR B9' },
      { id: '-', kind: 'paused' },
    ]),
  )
  assert.deepEqual(driver.L.prs.B9, before)
  assert.equal(driver.L.data.paused, true)
})

test('retry rejects a merged PR and changes nothing', () => {
  const attempts = { implement: 1, fix: 2, verify: 1, brief: 1 }
  const { M, driver } = driverFor({ A1: { state: 'merged', pr: 7, attempts } })

  assert.deepEqual(apply(M, driver, { cmd: 'retry', id: 'A1' }), [
    { id: 'A1', kind: 'command-rejected', command: 'retry', reason: 'already merged' },
  ])
  assert.equal(driver.L.prs.A1.state, 'merged')
  assert.deepEqual(driver.L.prs.A1.attempts, attempts)
})

test('retry rejects a PR whose agent is running and changes nothing', () => {
  const attempts = { implement: 1, fix: 2, verify: 0, brief: 0 }
  const { M, driver } = driverFor({ A1: { state: 'fixing', attempts } })
  driver.running.set('A1', 'fix')

  assert.deepEqual(apply(M, driver, { cmd: 'retry', id: 'A1' }), [
    { id: 'A1', kind: 'command-rejected', command: 'retry', reason: 'an agent is working on this PR' },
  ])
  assert.equal(driver.L.prs.A1.state, 'fixing')
  assert.deepEqual(driver.L.prs.A1.attempts, attempts)
})

test('retry resets the attempts, the refunds, the failure streak, the errors and the backoff', () => {
  const briefAnswers = [{ question: 'Q1', answer: 'yes' }]
  const { M, driver } = driverFor({
    A1: {
      state: 'escalated',
      pr: 11,
      sessionId: 'session-1',
      refunds: 5,
      failStreak: 3,
      tickErrors: 5,
      retryAfter: new Date(Date.now() + 3_600_000).toISOString(),
      attempts: { implement: 2, fix: 4, verify: 1, brief: 1 },
      briefAnswers,
    },
  })

  assert.deepEqual(apply(M, driver, { cmd: 'retry', id: 'A1' }), [{ id: 'A1', kind: 'retry', state: 'interrupted' }])

  const s = driver.L.prs.A1

  assert.deepEqual(s.attempts, { implement: 0, fix: 0, verify: 0, brief: 0 })
  assert.equal(s.refunds, 0)
  assert.equal(s.failStreak, 0)
  assert.equal(s.tickErrors, 0)
  assert.equal(s.retryAfter, null)
  assert.equal(s.state, 'interrupted')
  assert.deepEqual(s.briefAnswers, briefAnswers)
})

test('note on needs_fix is queued for the fix run and keeps the reason it waits with', () => {
  const { M, driver } = driverFor({
    A1: {
      state: 'needs_fix',
      pr: 11,
      fixReason: 'verifier findings',
      fixNote: '<findings>',
      attempts: { implement: 1, fix: 4, verify: 1, brief: 0 },
    },
  })

  assert.deepEqual(apply(M, driver, { cmd: 'note', id: 'A1', text: 'Keep the old flag.' }), [
    { id: 'A1', kind: 'note-queued', state: 'needs_fix' },
  ])

  const s = driver.L.prs.A1

  assert.equal(s.fixReason, 'verifier findings')
  assert.equal(s.fixNote, '<findings>')
  assert.equal(s.pendingNote, 'Keep the old flag.')
  assert.equal(s.attempts.fix, 3)
  assert.equal(s.state, 'needs_fix')

  apply(M, driver, { cmd: 'note', id: 'A1', text: 'And document it.' })

  assert.equal(s.pendingNote, 'Keep the old flag.\n\nAnd document it.')
  assert.equal(s.fixNote, '<findings>')
  assert.equal(s.attempts.fix, 3)
})

test('note on a PR with no brief and no GitHub PR answers the brief writer', () => {
  const escalated = { state: 'escalated', attempts: { implement: 0, fix: 0, verify: 0, brief: 2 } }
  const { M, driver } = driverFor({ A1: escalated, A3: escalated })

  assert.deepEqual(apply(M, driver, { cmd: 'note', id: 'A1', text: 'Write it from the second plan.' }), [
    { id: 'A1', kind: 'brief-answered' },
  ])

  const s = driver.L.prs.A1

  assert.equal(s.state, 'pending')
  assert.equal(s.attempts.brief, 1)
  assert.deepEqual(s.briefAnswers, [{ question: null, answer: 'Write it from the second plan.' }])
  assert.equal(s.fixReason, undefined)

  const withBrief = M.all.find((pr) => pr.id === 'A3')
  mkdirSync(dirname(withBrief.brief), { recursive: true })
  writeFileSync(withBrief.brief, '# A3\n')

  assert.deepEqual(apply(M, driver, { cmd: 'note', id: 'A3', text: 'Try again.' }), [
    { id: 'A3', kind: 'needs-fix', reason: 'answer from the maintainer' },
  ])
})

test('answers to brief questions give the attempt back and keep every round until the brief is written', () => {
  const { M, driver } = driverFor({
    A1: {
      state: 'blocked',
      blocked: { kind: 'brief-questions', question: 'Q1', evidence: '' },
      attempts: { implement: 0, fix: 0, verify: 0, brief: 1 },
    },
  })
  const pr = M.all.find((item) => item.id === 'A1')
  const s = driver.L.prs.A1

  assert.deepEqual(apply(M, driver, { cmd: 'note', id: 'A1', text: 'A1 answer' }), [{ id: 'A1', kind: 'brief-answered' }])
  assert.equal(s.state, 'pending')
  assert.equal(s.attempts.brief, 0)
  assert.equal(s.pendingNote, null)

  s.state = 'blocked'
  s.blocked = { kind: 'brief-questions', question: 'Q2', evidence: '' }
  s.attempts.brief = 2
  apply(M, driver, { cmd: 'note', id: 'A1', text: 'A2 answer' })

  assert.equal(s.attempts.brief, 1)
  assert.ok(s.attempts.brief < M.policy.attempts.brief)
  assert.deepEqual(s.briefAnswers, [
    { question: 'Q1', answer: 'A1 answer' },
    { question: 'Q2', answer: 'A2 answer' },
  ])

  const before = readEvents(M).length
  driver.onBriefDone(
    pr,
    agentResult({ output: { brief: '# A1\n', questions: [], notes: 'Checked.', expectedFiles: ['lib/a.mjs'], changesetBump: 'none' } }),
  )

  assert.deepEqual(
    readEvents(M)
      .slice(before)
      .map((event) => event.kind),
    ['brief-written'],
  )
  assert.deepEqual(s.briefAnswers, [])
})

test('launch never starts an implementer or a fixer without a brief and a GitHub PR', () => {
  const attempts = { implement: 1, fix: 1, verify: 0, brief: 1 }
  const { M, driver } = driverFor({ A1: { state: 'interrupted', interruptedRole: 'fix', sessionId: 'session-1', attempts } })
  const pr = M.all.find((item) => item.id === 'A1')
  M.claudeBin = join(M.dir, 'no-such-claude')
  const before = readEvents(M).length

  driver.launch(pr, 'fix', { reason: 'r', note: 'n' })
  driver.launch(pr, 'implement')

  const s = driver.L.prs.A1

  assert.equal(driver.running.size, 0)
  assert.deepEqual(s.attempts, attempts)
  assert.equal(s.state, 'pending')
  assert.equal(s.sessionId, 'session-1')
  assert.deepEqual(
    readEvents(M)
      .slice(before)
      .map(({ at: _, ...event }) => event),
    [
      { id: 'A1', kind: 'brief-missing', role: 'fix' },
      { id: 'A1', kind: 'brief-missing', role: 'implement' },
    ],
  )
})

test('onDone: a PR merged during the run stays merged and is cleaned up after the run', async () => {
  for (const result of [agentResult({ output: { verdict: 'PASS' } }), agentResult({ ok: false, error: 'error_during_execution' })]) {
    const cleaned = []
    const { M, driver } = driverFor({ A1: { state: 'merged', pr: 7, costUsd: 2 } }, { cleanup: async (pr) => cleaned.push(pr.id) })
    const before = readEvents(M).length

    await driver.onDone(
      M.prs.find((pr) => pr.id === 'A1'),
      'verify',
      result,
      { sha: 'abc1234', run: 'A1-03-verify' },
    )

    assert.equal(driver.L.prs.A1.state, 'merged')
    assert.equal(driver.L.prs.A1.costUsd, 3.25)
    assert.deepEqual(cleaned, ['A1'])
    assert.deepEqual(
      readEvents(M)
        .slice(before)
        .map((event) => event.kind),
      ['verify-done'],
    )
  }
})
