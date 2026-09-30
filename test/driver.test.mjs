import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
