import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { commandEffect } from '../lib/driver/commands.ts'
import { approveRefusal } from '../lib/judge.mjs'
import { implementPrompt } from '../lib/prompts.mjs'
import { DISPUTE, stateOf, toBlocked } from '../lib/transitions.ts'
import { readEvents } from '../lib/view.mjs'
import { at, sampleStatus, samplePrs, waitFor } from './fixtures.mjs'
import { agentResult, driverFor, apply, modelDriver, SHA } from './driver-helpers.mjs'

const AT_WORK = 'an agent is working on this PR'
const WAITS_FOR_WORDS = 'this PR waits for your answer: rollout note A1 "..."'
const VERIFIED = { sha: SHA, patchId: 'patch-a1', at: at(80) }
const FINDINGS_FIX = { reason: 'verifier-findings', note: '<findings>', since: at(50) }
const HOLD = { at: at(70), by: 'maintainer', reason: null }
// The obstacle of STATUS_SAMPLES, as the fix retry carries it.
const OBSTACLE_NOTE = 'Keep the old flag?\nThe plan names both.\n\nEvidence: cli.mjs:12 still reads it.'
const NOTE = 'Rename the field to partnerId.'

// An entry as a driver of this version writes it: the state follows from
// the stage, the status and the fix. `status` adds to the sample data.
function staged(stage, kind, code, { status = {}, ...fields } = {}) {
  const entry = {
    hold: null,
    held: null,
    fix: null,
    interruptedRole: null,
    ...fields,
    stage,
    status: { ...sampleStatus(kind, code), ...status },
  }

  return { ...entry, state: stateOf(entry) }
}

// A1 verified and on merge, with the status of `code`.
function onMerge(kind, code, fields = {}) {
  return staged('merge', kind, code, { pr: 11, author: 'demo-bot', claimedSha: SHA, verified: VERIFIED, approved: null, ...fields })
}

function atWorkOf(role) {
  if (role === undefined) {
    return null
  }

  return role === 'delegate' ? 'delegate' : 'agent'
}

// What commandEffect says the command does, from the driver's own facts.
function effectOf(manifest, driver, command) {
  const pr = manifest.all.find((item) => item.id === command.id)
  const now = new Date().toISOString()

  return commandEffect(
    { prs: driver.ledger.prs, hold: driver.ledger.data.hold },
    { at: now, ...command },
    {
      at: now,
      atWork: atWorkOf(driver.running.get(command.id)),
      briefWritten: existsSync(pr.brief),
      limits: manifest.policy.attempts,
      mergeDelaySeconds: manifest.policy.mergeDelaySeconds,
      approveRefusal: (entry) => approveRefusal(manifest, entry),
    },
  )
}

// The driver reads the clock a moment after the effect does.
function untimed(value) {
  if (!value) {
    return value
  }

  const { since: _, ...rest } = value

  if (rest.code === 'merge-delay') {
    delete rest.until
  }

  return rest
}

// Computes the effect, applies the command, and holds the entry to the effect:
// the same stage, status and fix, or nothing changed at all for a refusal.
function applied(manifest, driver, command) {
  const effect = effectOf(manifest, driver, command)
  const before = structuredClone(driver.ledger.prs[command.id])
  const events = apply(manifest, driver, command)
  const entry = driver.ledger.prs[command.id]

  if (effect.applies) {
    assert.deepEqual(
      { stage: entry.stage, status: untimed(entry.status), fix: untimed(entry.fix) },
      { stage: effect.stage, status: untimed(effect.status), fix: untimed(effect.fix) },
    )
  } else {
    assert.deepEqual(entry, before)
  }

  return { effect, events, entry, before }
}

function place(entry) {
  return [entry.stage, entry.status?.kind ?? null, entry.status?.code ?? null]
}

function writeBrief(manifest, id = 'A1') {
  const pr = manifest.all.find((item) => item.id === id)

  mkdirSync(dirname(pr.brief), { recursive: true })
  writeFileSync(pr.brief, `# ${id}\n`)
}

// postCommand names can tie within a millisecond and then sort at random,
// so a batch whose order matters is written under numbered names.
function writeBatch(manifest, contents) {
  contents.forEach((content, index) => {
    const text = typeof content === 'string' ? content : JSON.stringify(content)
    writeFileSync(join(manifest.dir, 'inbox', `${String(index + 1).padStart(4, '0')}-test.json`), text)
  })
}

function sorted(events) {
  return events.map((event) => JSON.stringify(event)).sort()
}

// A PR's hold as the maintainer sets it.
function assertMaintainerHold(hold) {
  assert.ok(Date.parse(hold?.at), JSON.stringify(hold))
  assert.deepEqual(hold, { at: hold.at, by: 'maintainer', reason: null })
}

test('hold and release with a lone id, as an older CLI or page sends them, park a PR and lift it', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'needs_fix' } })

  assert.deepEqual(apply(manifest, driver, { cmd: 'hold', id: 'A1' }), [{ id: 'A1', kind: 'held', state: 'needs_fix', running: null }])
  assertMaintainerHold(driver.ledger.prs.A1.held)

  assert.deepEqual(apply(manifest, driver, { cmd: 'release', id: 'A1' }), [{ id: 'A1', kind: 'released', state: 'needs_fix' }])
  assert.equal(driver.ledger.prs.A1.held, null)
})

test('hold <ids>: a PR that is not held is held', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'needs_fix' }, A3: { state: 'pending' } })

  assert.deepEqual(apply(manifest, driver, { cmd: 'hold', ids: ['A1', 'A3'] }), [
    { id: 'A1', kind: 'held', state: 'needs_fix', running: null },
    { id: 'A3', kind: 'held', state: 'pending', running: null },
  ])

  assertMaintainerHold(driver.ledger.prs.A1.held)
  assertMaintainerHold(driver.ledger.prs.A3.held)
  assert.equal(driver.ledger.prs.A2.held, null)
  assert.equal(driver.ledger.data.hold, null)
})

test('hold <ids>: a PR already held or merged is refused', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' }, A2: { state: 'merged' }, A3: { state: 'pending' } })
  apply(manifest, driver, { cmd: 'hold', ids: ['A1'] })
  const before = structuredClone(driver.ledger.prs.A1.held)

  assert.deepEqual(apply(manifest, driver, { cmd: 'hold', ids: ['A1', 'A2', 'A3'] }), [
    { id: 'A1', kind: 'command-rejected', command: 'hold', reason: 'already held' },
    { id: 'A2', kind: 'command-rejected', command: 'hold', reason: 'already merged' },
    { id: 'A3', kind: 'held', state: 'pending', running: null },
  ])

  assert.deepEqual(driver.ledger.prs.A1.held, before)
  assert.equal(driver.ledger.prs.A2.held, null)
  assertMaintainerHold(driver.ledger.prs.A3.held)
})

test('hold --all: a rollout that is not held is held, with author and time', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' } })
  const before = Date.now()

  assert.deepEqual(apply(manifest, driver, { cmd: 'hold', all: true }), [
    { id: '-', kind: 'held', scope: 'rollout', by: 'maintainer', reason: null },
  ])

  const { hold } = driver.ledger.data

  assert.deepEqual(hold, { at: hold.at, by: 'maintainer', reason: null })
  assert.ok(Date.parse(hold.at) >= before - 1000, hold.at)
  assert.ok(
    manifest.all.every((pr) => driver.ledger.prs[pr.id].held === null),
    'no PR is held on its own',
  )
})

test('hold --all: a rollout already held is refused, with author and time', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' } })
  apply(manifest, driver, { cmd: 'hold', all: true })
  const hold = structuredClone(driver.ledger.data.hold)

  assert.deepEqual(apply(manifest, driver, { cmd: 'hold', all: true }), [
    { id: '-', kind: 'command-rejected', command: 'hold', reason: `already held since ${hold.at} by maintainer` },
  ])

  assert.deepEqual(driver.ledger.data.hold, hold)

  const byDriver = { at: at(5), by: 'driver', reason: 'usage limit reached' }
  driver.ledger.data.hold = structuredClone(byDriver)

  assert.deepEqual(apply(manifest, driver, { cmd: 'hold', all: true }), [
    { id: '-', kind: 'command-rejected', command: 'hold', reason: `already held since ${byDriver.at} by driver: usage limit reached` },
  ])

  assert.deepEqual(driver.ledger.data.hold, byDriver)
})

test('release <ids>: a held PR is released', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'needs_fix' }, A3: { state: 'pending' } })
  apply(manifest, driver, { cmd: 'hold', ids: ['A1', 'A3'] })

  assert.deepEqual(apply(manifest, driver, { cmd: 'release', ids: ['A1', 'A3'] }), [
    { id: 'A1', kind: 'released', state: 'needs_fix' },
    { id: 'A3', kind: 'released', state: 'pending' },
  ])

  assert.equal(driver.ledger.prs.A1.held, null)
  assert.equal(driver.ledger.prs.A3.held, null)
})

test('release <ids>: a PR that is not held is refused, and the reason names a held rollout', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' } })

  assert.deepEqual(apply(manifest, driver, { cmd: 'release', ids: ['A1'] }), [
    { id: 'A1', kind: 'command-rejected', command: 'release', reason: 'not held' },
  ])

  apply(manifest, driver, { cmd: 'hold', all: true })
  const hold = structuredClone(driver.ledger.data.hold)

  assert.deepEqual(apply(manifest, driver, { cmd: 'release', ids: ['A1'] }), [
    { id: 'A1', kind: 'command-rejected', command: 'release', reason: 'not held. The rollout is held: rollout release --all' },
  ])

  assert.deepEqual(driver.ledger.data.hold, hold, 'releasing a PR leaves the rollout held')
})

test('release --all: a held rollout is released, and the event names the PRs held on their own', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' }, A2: { state: 'merged', held: { at: at(1) } } })

  apply(manifest, driver, { cmd: 'hold', id: 'A1' })
  apply(manifest, driver, { cmd: 'hold', all: true })
  const held = structuredClone(driver.ledger.prs.A1.held)

  assert.deepEqual(apply(manifest, driver, { cmd: 'release', all: true }), [
    { id: '-', kind: 'released', scope: 'rollout', stillHeld: ['A1'] },
  ])

  assert.equal(driver.ledger.data.hold, null)
  assert.deepEqual(driver.ledger.prs.A1.held, held, 'A1 stays held on its own')
})

test('release --all: a rollout that is not held is refused', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' } })
  apply(manifest, driver, { cmd: 'hold', ids: ['A1'] })

  assert.deepEqual(apply(manifest, driver, { cmd: 'release', all: true }), [
    { id: '-', kind: 'command-rejected', command: 'release', reason: 'not held' },
  ])

  assert.equal(driver.ledger.data.hold, null)
  assertMaintainerHold(driver.ledger.prs.A1.held)
})

test('hold with ids applies each id on its own: a bad or failing one is rejected, a repeat applies once', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' }, A3: { state: 'pending' } })

  Object.defineProperty(driver.ledger.prs.A3, 'state', {
    get() {
      throw new Error('boom')
    },
  })

  writeBatch(manifest, [
    { cmd: 'hold', ids: ['A1', 'Z9', 7, '__proto__', 'A1'] },
    { cmd: 'hold', ids: ['A3', 'A2'] },
    { cmd: 'hold', ids: [] },
    { cmd: 'release', ids: 'A1' },
  ])

  assert.deepEqual(apply(manifest, driver), [
    { id: 'A1', kind: 'held', state: 'pending', running: null },
    { id: '-', kind: 'command-rejected', command: 'hold', reason: 'unknown PR Z9' },
    { id: '-', kind: 'command-rejected', command: 'hold', reason: 'needs a PR id' },
    { id: '-', kind: 'command-rejected', command: 'hold', reason: 'unknown PR __proto__' },
    { id: 'A3', kind: 'command-rejected', command: 'hold', reason: 'boom' },
    { id: 'A2', kind: 'held', state: 'pending', running: null },
    { id: '-', kind: 'command-rejected', command: 'hold', reason: 'needs PR ids or all' },
    { id: '-', kind: 'command-rejected', command: 'release', reason: 'needs PR ids or all' },
  ])

  assertMaintainerHold(driver.ledger.prs.A1.held)
  assertMaintainerHold(driver.ledger.prs.A2.held)
  assert.equal(Object.prototype.held, undefined)
  assert.equal(driver.ledger.data.hold, null)
})

test('hold --all ignores any ids, and release --all never lifts a PR hold', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' } })

  assert.deepEqual(apply(manifest, driver, { cmd: 'hold', all: true, ids: ['A1'], id: 'Z9' }), [
    { id: '-', kind: 'held', scope: 'rollout', by: 'maintainer', reason: null },
  ])

  assert.equal(driver.ledger.prs.A1.held, null)

  apply(manifest, driver, { cmd: 'hold', ids: ['A1'] })

  assert.deepEqual(apply(manifest, driver, { cmd: 'release', all: true, ids: ['A1'] }), [
    { id: '-', kind: 'released', scope: 'rollout', stillHeld: ['A1'] },
  ])

  assertMaintainerHold(driver.ledger.prs.A1.held)
})

test('pause and resume are unknown commands and change no hold', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' } })

  assert.deepEqual(apply(manifest, driver, { cmd: 'pause' }), [
    { id: '-', kind: 'command-rejected', command: 'pause', reason: 'unknown command' },
  ])

  assert.equal(driver.ledger.data.hold, null)

  apply(manifest, driver, { cmd: 'hold', all: true })
  const hold = structuredClone(driver.ledger.data.hold)

  assert.deepEqual(apply(manifest, driver, { cmd: 'resume' }), [
    { id: '-', kind: 'command-rejected', command: 'resume', reason: 'unknown command' },
  ])

  assert.deepEqual(driver.ledger.data.hold, hold)
})

test('hold records the agent that keeps running', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'fixing' } })
  driver.running.set('A1', 'fix')

  assert.deepEqual(apply(manifest, driver, { cmd: 'hold', id: 'A1' }), [{ id: 'A1', kind: 'held', state: 'fixing', running: 'fix' }])
})

test('hold and release reject what they cannot do, and the rest of the batch still applies', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' }, A2: { state: 'merged' } })
  apply(manifest, driver, { cmd: 'hold', id: 'A1' })

  const events = apply(
    manifest,
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
      { id: '-', kind: 'command-rejected', command: 'hold', reason: 'needs PR ids or all' },
      { id: '-', kind: 'command-rejected', command: 'release', reason: 'needs PR ids or all' },
      { id: '-', kind: 'command-rejected', command: 'hold', reason: 'unknown PR Z9' },
      { id: 'A2', kind: 'command-rejected', command: 'hold', reason: 'already merged' },
      { id: 'A1', kind: 'command-rejected', command: 'hold', reason: 'already held' },
      { id: 'A3', kind: 'command-rejected', command: 'release', reason: 'not held' },
    ]),
  )

  assert.ok(driver.ledger.prs.A1.held)
  assert.equal(driver.ledger.prs.A2.held, null)
  assert.equal(driver.ledger.prs.A3.held, null)
})

test('each bad command is rejected with its reason, and the rest of the batch still applies', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' } })

  Object.defineProperty(driver.ledger.prs.A3, 'state', {
    get() {
      throw new Error('boom')
    },
  })

  writeBatch(manifest, [
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

  const events = apply(manifest, driver)
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

  assert.ok(driver.ledger.prs.A1.held)
  assert.equal(driver.ledger.data.hold, null)
  assert.equal(Object.prototype.held, undefined)
  assert.equal(Object.prototype.state, undefined)
  assert.equal(Object.prototype.attempts, undefined)
})

test('a PR still in the ledger but gone from the manifest is unknown, and a hold of the rollout that names one still holds it', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' }, B9: { state: 'needs_fix' } })
  const before = structuredClone(driver.ledger.prs.B9)

  const events = apply(
    manifest,
    driver,
    { cmd: 'note', id: 'B9', text: 'x' },
    { cmd: 'approve', id: 'B9', sha: 'x', patchId: 'y' },
    { cmd: 'hold', ids: ['B9'] },
    { cmd: 'hold', all: true, id: 'Z9' },
  )

  assert.deepEqual(
    sorted(events),
    sorted([
      { id: '-', kind: 'command-rejected', command: 'note', reason: 'unknown PR B9' },
      { id: '-', kind: 'command-rejected', command: 'approve', reason: 'unknown PR B9' },
      { id: '-', kind: 'command-rejected', command: 'hold', reason: 'unknown PR B9' },
      { id: '-', kind: 'held', scope: 'rollout', by: 'maintainer', reason: null },
    ]),
  )

  assert.deepEqual(driver.ledger.prs.B9, before)
  assert.equal(driver.ledger.data.hold.by, 'maintainer')
})

test('an unhalt from an older CLI is an unknown command and leaves the last merge as it was', () => {
  const merge = { id: 'A3', sha: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0', at: at(90) }

  for (const lastMerge of [merge, { ...merge, checked: 'red' }]) {
    const { manifest, driver } = driverFor({ A1: { state: 'pending' } })

    driver.ledger.data.lastMerge = structuredClone(lastMerge)

    assert.deepEqual(apply(manifest, driver, { cmd: 'unhalt' }), [
      { id: '-', kind: 'command-rejected', command: 'unhalt', reason: 'unknown command' },
    ])

    assert.deepEqual(driver.ledger.data.lastMerge, lastMerge)
  }
})

const RETRY = { cmd: 'retry', id: 'A1' }
const SPENT = { implement: 1, fix: 4, verify: 3, brief: 2 }
const RESET = { implement: 0, fix: 0, verify: 0, brief: 0 }

function retried(entry, { brief = false, rolloutHold = null } = {}) {
  const { manifest, driver } = driverFor({ A1: entry })

  driver.ledger.data.hold = rolloutHold

  if (brief) {
    writeBrief(manifest)
  }

  return { manifest, driver, ...applied(manifest, driver, RETRY) }
}

test('retry: merged', () => {
  const { events, entry } = retried({ state: 'merged', pr: 7, attempts: SPENT })

  assert.deepEqual(events, [{ id: 'A1', kind: 'command-rejected', command: 'retry', reason: 'already merged' }])
  assert.equal(entry.state, 'merged')
  assert.deepEqual(entry.attempts, SPENT)
})

test('retry: any running status, or atWork set (a delegate included)', () => {
  const cases = [
    [staged('implement', 'running', 'fix', { pr: 11, fix: FINDINGS_FIX, attempts: SPENT }), 'fix'],
    [staged('implement', 'needs-you', 'obstacle', { pr: 11, attempts: SPENT }), 'delegate'],
    [staged('pre-verify', 'running', 'commands', { pr: 11, claimedSha: SHA, attempts: SPENT }), 'gate'],
    // The driver's own merge has no run behind it in `running`.
    [onMerge('running', 'merge', { attempts: SPENT }), null],
  ]

  for (const [fixture, role] of cases) {
    const { manifest, driver } = driverFor({ A1: fixture })

    if (role) {
      driver.running.set('A1', role)
    }

    const { events, entry } = applied(manifest, driver, RETRY)

    assert.deepEqual(events, [{ id: 'A1', kind: 'command-rejected', command: 'retry', reason: AT_WORK }], fixture.status.code)
    assert.deepEqual(entry.attempts, SPENT)
  }
})

// The driver settles the status before the lookup, so this effect is not the one before it.
test('retry: a running status whose run is gone resumes first, as advance would', () => {
  const { manifest, driver } = driverFor({ A1: staged('implement', 'running', 'implement', { sessionId: 'session-1', attempts: SPENT }) })
  const events = apply(manifest, driver, RETRY)
  const entry = driver.ledger.prs.A1

  assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: 'interrupted' }])
  assert.deepEqual(place(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fix.reason, 'no-report')
  assert.deepEqual(entry.attempts, RESET)
})

for (const [stage, code] of [
  ['brief', 'brief-questions'],
  ['implement', 'decision'],
  ['verify', 'dispute'],
]) {
  test(`retry: ${stage} · needs-you: ${code}`, () => {
    const { events, entry } = retried(staged(stage, 'needs-you', code, { pr: stage === 'brief' ? null : 11, attempts: SPENT }))

    assert.deepEqual(events, [{ id: 'A1', kind: 'command-rejected', command: 'retry', reason: WAITS_FOR_WORDS }])
    assert.deepEqual(entry.attempts, SPENT)
  })
}

test('retry: brief · needs-you: attempts-exhausted', () => {
  const briefAnswers = [{ question: 'Which API?', answer: 'The new one.' }]
  const exhausted = staged('brief', 'needs-you', 'attempts-exhausted', {
    status: { role: 'brief', limit: 2 },
    attempts: SPENT,
    briefAnswers,
  })

  const { events, entry } = retried(exhausted)

  assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: 'pending' }])
  assert.deepEqual(place(entry), ['brief', 'waiting', 'slot'])
  assert.deepEqual(entry.briefAnswers, briefAnswers)
  assert.deepEqual(entry.attempts, RESET)
})

test('retry: a PR on brief whose brief file exists takes the implement row of the same status', () => {
  const exhausted = staged('brief', 'needs-you', 'attempts-exhausted', { status: { role: 'brief', limit: 2 }, attempts: SPENT })
  const { events, entry } = retried(exhausted, { brief: true })

  assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: 'pending' }])
  assert.deepEqual(place(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fix, null)
})

test('retry: implement · needs-you: obstacle', () => {
  const owed = { pr: 11, sessionId: 'session-1', fix: FINDINGS_FIX, fixReason: 'verifier findings', fixNote: '<findings>', attempts: SPENT }
  const { events, entry, effect } = retried(staged('implement', 'needs-you', 'obstacle', owed))
  const note = `${OBSTACLE_NOTE}\n\n<findings>`

  assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: 'needs_fix' }])
  assert.deepEqual(place(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual(untimed(entry.fix), { reason: 'retry', note })
  assert.deepEqual([entry.fixReason, entry.fixNote], ['retry', note])
  assert.equal(effect.fix.reason, 'retry')
  assert.deepEqual(entry.attempts, RESET)
})

test('retry: an obstacle, then a tick: the fix run reads the obstacle and the reason retry', async () => {
  const setup = modelDriver({
    A1: staged('implement', 'needs-you', 'obstacle', { sessionId: 'session-1', attempts: { ...RESET, implement: 1 } }),
  })

  apply(setup.manifest, setup.driver, RETRY)
  await setup.driver.tick()
  await waitFor(() => setup.calls.some((call) => call.role === 'fix'), 'the fix run')

  const { prompt, resume } = setup.calls.find((call) => call.role === 'fix')

  assert.equal(resume, true)
  assert.ok(
    prompt.includes(
      'reason: **retry: the maintainer removed the cause of the obstacle your last report named, and asks you to try again**',
    ),
    prompt,
  )

  assert.ok(prompt.includes(OBSTACLE_NOTE), prompt)
})

test('retry: implement · needs-you: attempts-exhausted', () => {
  const owed = {
    status: { role: 'fix', limit: 4 },
    pr: 11,
    sessionId: 'session-1',
    claimedSha: SHA,
    fix: FINDINGS_FIX,
    fixReason: 'verifier findings',
    fixNote: '<findings>',
    interruptedRole: 'fix',
    attempts: SPENT,
  }

  const { events, entry } = retried(staged('implement', 'needs-you', 'attempts-exhausted', owed))

  assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: 'needs_fix' }])
  assert.deepEqual(place(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual(entry.fix, FINDINGS_FIX)
  assert.deepEqual([entry.fixReason, entry.fixNote, entry.interruptedRole], ['verifier findings', '<findings>', 'fix'])
  assert.deepEqual(entry.attempts, RESET)
})

test('retry: verify · needs-you: attempts-exhausted', () => {
  const claim = { status: { role: 'verify', limit: 3 }, pr: 11, claimedSha: SHA, claimPatchId: 'patch-a1', attempts: SPENT }
  const { events, entry } = retried(staged('verify', 'needs-you', 'attempts-exhausted', claim))

  assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: 'interrupted' }])
  assert.deepEqual(place(entry), ['verify', 'waiting', 'slot'])
  assert.equal(entry.interruptedRole, 'verify')
  assert.equal(entry.claimedSha, SHA)
  assert.deepEqual(entry.attempts, RESET)
})

test('retry: any needs-you: errors', () => {
  const parked = { status: 'READY', pr: 12, headSha: SHA, summary: 'Done.' }
  const cases = [
    [staged('brief', 'needs-you', 'errors'), ['brief', 'waiting', 'slot'], 'pending'],
    [staged('implement', 'needs-you', 'errors', { sessionId: 'session-1' }), ['implement', 'waiting', 'slot'], 'interrupted'],
    [staged('implement', 'needs-you', 'errors', { pr: 11, fix: FINDINGS_FIX }), ['implement', 'waiting', 'slot'], 'needs_fix'],
    [staged('verify', 'needs-you', 'errors', { pr: 11, claimedSha: SHA }), ['verify', 'waiting', 'slot'], 'interrupted'],
    [staged('pre-verify', 'needs-you', 'errors', { pr: 11, claimedSha: SHA }), ['pre-verify', 'waiting', 'ci'], 'ready_claimed'],
    [
      staged('pre-verify', 'needs-you', 'errors', { sessionId: 'session-1', interruptedRole: 'report', ready: parked }),
      ['pre-verify', 'waiting', 'github'],
      'interrupted',
    ],
    [onMerge('needs-you', 'errors'), ['merge', 'waiting', 'gate-pending'], 'verified'],
  ]

  for (const [fixture, expected, state] of cases) {
    const { events, entry } = retried({ ...fixture, tickErrors: 5, attempts: SPENT })

    assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state }], expected.join(' '))
    assert.deepEqual(place(entry), expected)
    assert.equal(entry.tickErrors, 0)
  }
})

test('retry: an implement PR with work and no fix owed resumes it as after a cut-off fix run', () => {
  const { entry } = retried(staged('implement', 'needs-you', 'errors', { pr: 11, sessionId: 'session-1', interruptedRole: 'verify' }))

  assert.equal(entry.fix.reason, 'no-report')
  assert.equal(entry.interruptedRole, 'fix')
})

test('retry: closed, gate-blocked, code-scanning-alerts', () => {
  const owed = { pr: 11, fix: FINDINGS_FIX, fixReason: 'verifier findings', fixNote: '<findings>' }
  const gate = { action: 'block', code: 'draft', reasons: ['the PR is a draft'], at: at(85) }
  const cases = [
    [staged('implement', 'needs-you', 'closed', owed), ['implement', 'waiting', 'slot'], 'needs_fix'],
    [onMerge('needs-you', 'closed'), ['merge', 'waiting', 'gate-pending'], 'verified'],
    [onMerge('needs-you', 'gate-blocked', { gate }), ['merge', 'waiting', 'gate-pending'], 'verified'],
    [
      staged('pre-verify', 'needs-you', 'code-scanning-alerts', { pr: 11, claimedSha: SHA }),
      ['pre-verify', 'waiting', 'ci'],
      'ready_claimed',
    ],
  ]

  for (const [fixture, expected, state] of cases) {
    const { events, entry } = retried(fixture)

    assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state }], expected.join(' '))
    assert.deepEqual(place(entry), expected)
  }
})

test('retry: a PR closed on merge with a note kept meanwhile goes to a fix, without its verification and approval', () => {
  const approved = { sha: SHA, patchId: 'patch-a1', at: at(81), channel: 'inbox' }
  const { events, entry, effect } = retried(onMerge('needs-you', 'closed', { approved, pendingNote: NOTE }))

  assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: 'needs_fix' }])
  assert.deepEqual(place(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fix.reason, 'maintainer-note')
  assert.deepEqual([entry.verified, entry.approved, entry.pendingNote], [null, null, NOTE])
  assert.deepEqual(effect.drops, ['verification', 'approval'])
})

test('retry: approve, review, changes-requested, merge-by-hand, github-blocked, merge-refused', () => {
  for (const code of ['approve', 'review', 'changes-requested', 'merge-by-hand', 'github-blocked', 'merge-refused']) {
    const { events, entry, before } = retried(onMerge('needs-you', code, { attempts: SPENT }))

    assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: 'verified' }], code)
    assert.deepEqual(entry.status, before.status, code)
    assert.deepEqual(entry.attempts, RESET, code)
  }
})

test('retry: implement · waiting: backoff, and backoff on brief and verify', () => {
  const later = new Date(Date.now() + 3_600_000).toISOString()
  const cases = [
    staged('brief', 'waiting', 'backoff'),
    staged('implement', 'waiting', 'backoff', { pr: 11, fix: { reason: 'no-report', note: '', since: at(60) } }),
    staged('verify', 'waiting', 'backoff', { pr: 11, claimedSha: SHA, interruptedRole: 'verify' }),
  ]

  for (const fixture of cases) {
    const { entry } = retried({ ...fixture, retryAfter: later, failStreak: 2 })

    assert.deepEqual(place(entry), [fixture.stage, 'waiting', 'slot'])
    assert.deepEqual([entry.retryAfter, entry.failStreak], [null, 0])
  }
})

test('retry: implement · waiting, with or without a fix owed', () => {
  const owed = { pr: 11, claimedSha: SHA, fix: FINDINGS_FIX, fixReason: 'verifier findings', fixNote: '<findings>', attempts: SPENT }
  const { events, entry, before } = retried(staged('implement', 'waiting', 'slot', owed))

  assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: 'needs_fix' }])
  assert.deepEqual([entry.stage, entry.status], [before.stage, before.status])
  assert.deepEqual(entry.fix, FINDINGS_FIX)
  assert.deepEqual([entry.fixReason, entry.fixNote, entry.verified], ['verifier findings', '<findings>', null])
  assert.deepEqual(entry.attempts, RESET)

  const fresh = retried(staged('implement', 'waiting', 'slot'))

  assert.deepEqual(fresh.events, [{ id: 'A1', kind: 'retry', state: 'pending' }])
  assert.deepEqual(fresh.entry.status, fresh.before.status)
  assert.equal(fresh.entry.fix, null)
})

test('retry: pre-verify · waiting', () => {
  const { events, entry, before } = retried(staged('pre-verify', 'waiting', 'ci', { pr: 11, claimedSha: SHA }))

  assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: 'ready_claimed' }])
  assert.deepEqual(entry.status, before.status)
})

test('retry: any other waiting status', () => {
  for (const fixture of [
    staged('brief', 'waiting', 'dependencies'),
    onMerge('waiting', 'merge-delay'),
    onMerge('waiting', 'gate-pending'),
  ]) {
    const { events, entry, before } = retried(fixture)

    assert.deepEqual(events, [{ id: 'A1', kind: 'retry', state: fixture.state }], fixture.status.code)
    assert.deepEqual(entry.status, before.status, fixture.status.code)
  }
})

test("retry: a waiting status a row writes under a hold is held, the rollout's scope over the PR's own", () => {
  const ownHold = retried(staged('brief', 'needs-you', 'errors', { hold: HOLD, held: HOLD }))

  assert.deepEqual(ownHold.entry.status, { kind: 'waiting', code: 'held', scope: 'pr', since: ownHold.entry.status.since })

  const both = retried(staged('brief', 'needs-you', 'errors', { hold: HOLD, held: HOLD }), { rolloutHold: HOLD })

  assert.equal(both.entry.status.scope, 'rollout')
  assert.equal(both.effect.status.scope, 'rollout')
})

test('retry resets the attempts, the refunds, the failure streak, the errors and the backoff', () => {
  const briefAnswers = [{ question: 'Q1', answer: 'yes' }]
  const { manifest, driver } = driverFor({
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

  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [{ id: 'A1', kind: 'retry', state: 'interrupted' }])

  const entry = driver.ledger.prs.A1

  assert.deepEqual(entry.attempts, { implement: 0, fix: 0, verify: 0, brief: 0 })
  assert.equal(entry.refunds, 0)
  assert.equal(entry.failStreak, 0)
  assert.equal(entry.tickErrors, 0)
  assert.equal(entry.retryAfter, null)
  assert.equal(entry.state, 'interrupted')
  assert.deepEqual(entry.briefAnswers, briefAnswers)
})

test('note on needs_fix is queued for the fix run and keeps the reason it waits with', () => {
  const { manifest, driver } = driverFor({
    A1: {
      state: 'needs_fix',
      pr: 11,
      fixReason: 'verifier findings',
      fixNote: '<findings>',
      attempts: { implement: 1, fix: 4, verify: 1, brief: 0 },
    },
  })

  assert.deepEqual(apply(manifest, driver, { cmd: 'note', id: 'A1', text: 'Keep the old flag.' }), [
    { id: 'A1', kind: 'note-queued', state: 'needs_fix' },
  ])

  const entry = driver.ledger.prs.A1

  assert.equal(entry.fixReason, 'verifier findings')
  assert.equal(entry.fixNote, '<findings>')
  assert.equal(entry.pendingNote, 'Keep the old flag.')
  assert.equal(entry.attempts.fix, 3)
  assert.equal(entry.state, 'needs_fix')

  apply(manifest, driver, { cmd: 'note', id: 'A1', text: 'And document it.' })

  assert.equal(entry.pendingNote, 'Keep the old flag.\n\nAnd document it.')
  assert.equal(entry.fixNote, '<findings>')
  assert.equal(entry.attempts.fix, 3)
})

test('note on a PR with no brief and no GitHub PR answers the brief writer', () => {
  const escalated = { state: 'escalated', attempts: { implement: 0, fix: 0, verify: 0, brief: 2 } }
  const { manifest, driver } = driverFor({ A1: escalated, A3: escalated })

  assert.deepEqual(apply(manifest, driver, { cmd: 'note', id: 'A1', text: 'Write it from the second plan.' }), [
    { id: 'A1', kind: 'brief-answered' },
  ])

  const entry = driver.ledger.prs.A1

  assert.equal(entry.state, 'pending')
  assert.equal(entry.attempts.brief, 1)
  assert.deepEqual(entry.briefAnswers, [{ question: null, answer: 'Write it from the second plan.' }])
  assert.equal(entry.fixReason, undefined)

  const withBrief = manifest.all.find((pr) => pr.id === 'A3')
  mkdirSync(dirname(withBrief.brief), { recursive: true })
  writeFileSync(withBrief.brief, '# A3\n')

  assert.deepEqual(apply(manifest, driver, { cmd: 'note', id: 'A3', text: 'Try again.' }), [
    { id: 'A3', kind: 'needs-fix', reason: 'answer from the maintainer' },
  ])
})

test('answers to brief questions give the attempt back and keep every round until the brief is written', () => {
  const { manifest, driver } = driverFor({
    A1: {
      state: 'blocked',
      blocked: { kind: 'brief-questions', question: 'Q1', evidence: '' },
      attempts: { implement: 0, fix: 0, verify: 0, brief: 1 },
    },
  })

  const pr = manifest.all.find((item) => item.id === 'A1')
  const entry = driver.ledger.prs.A1

  assert.deepEqual(apply(manifest, driver, { cmd: 'note', id: 'A1', text: 'A1 answer' }), [{ id: 'A1', kind: 'brief-answered' }])
  assert.equal(entry.state, 'pending')
  assert.equal(entry.attempts.brief, 0)
  assert.equal(entry.pendingNote, null)

  toBlocked(entry, { kind: 'brief-questions', question: 'Q2', evidence: '', run: null }, { at: at(90) })
  entry.attempts.brief = 2
  apply(manifest, driver, { cmd: 'note', id: 'A1', text: 'A2 answer' })

  assert.equal(entry.attempts.brief, 1)
  assert.ok(entry.attempts.brief < manifest.policy.attempts.brief)
  assert.deepEqual(entry.briefAnswers, [
    { question: 'Q1', answer: 'A1 answer' },
    { question: 'Q2', answer: 'A2 answer' },
  ])

  const before = readEvents(manifest).length
  driver.onBriefDone(
    pr,
    agentResult({ output: { brief: '# A1\n', questions: [], notes: 'Checked.', expectedFiles: ['lib/a.mjs'], changesetBump: 'none' } }),
  )

  assert.deepEqual(
    readEvents(manifest)
      .slice(before)
      .map((event) => event.kind),
    ['brief-written'],
  )

  assert.deepEqual(entry.briefAnswers, [])
})

const NOTE_COMMAND = { cmd: 'note', id: 'A1', text: NOTE }

function noted(entry, { brief = false, running = null } = {}) {
  const { manifest, driver } = driverFor({ A1: entry })

  if (brief) {
    writeBrief(manifest)
  }

  if (running) {
    driver.running.set('A1', running)
  }

  return { manifest, driver, ...applied(manifest, driver, NOTE_COMMAND) }
}

function assertQueued({ entry, effect, events }, state) {
  assert.deepEqual(events, [{ id: 'A1', kind: 'note-queued', state }])
  assert.equal(entry.pendingNote, NOTE)
  assert.equal(effect.queued, true)
  assert.deepEqual(
    entry.noteHistory.map((record) => record.text),
    [NOTE],
  )
}

function assertNoteFix({ entry, effect, events }, reason) {
  assert.deepEqual(events, [{ id: 'A1', kind: 'needs-fix', reason }])
  assert.deepEqual(place(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.fix.reason, entry.fix.note, entry.fixNote], ['maintainer-note', NOTE, NOTE])
  assert.equal(effect.queued, false)
}

test('note: merged', () => {
  const { events, entry } = noted({ state: 'merged', pr: 7 })

  assert.deepEqual(events, [{ id: 'A1', kind: 'command-rejected', command: 'note', reason: 'already merged' }])
  assert.deepEqual(entry.noteHistory, [])
})

test('note: brief · needs-you: brief-questions', () => {
  const question = 'Keep the old flag?\nThe plan names both.'
  const blocked = { kind: 'brief-questions', question, evidence: '', run: 'A1-01-brief-write' }
  const result = noted(staged('brief', 'needs-you', 'brief-questions', { blocked, attempts: { ...RESET, brief: 1 } }))
  const { events, entry } = result

  assert.deepEqual(events, [{ id: 'A1', kind: 'brief-answered' }])
  assert.deepEqual(place(entry), ['brief', 'waiting', 'slot'])
  assert.deepEqual(entry.briefAnswers, [{ question, answer: NOTE }])
  assert.equal(entry.attempts.brief, 0)
  assert.equal(entry.pendingNote, null)
  assert.deepEqual(
    entry.noteHistory.map(({ at: _, ...record }) => record),
    [{ by: 'maintainer', kind: 'brief-questions', question, text: NOTE, run: null }],
  )
})

test('note: any needs-you: closed', () => {
  const blocked = { kind: 'closed', question: 'PR #11 was closed outside the driver.', evidence: '', run: null }

  for (const fixture of [staged('implement', 'needs-you', 'closed', { pr: 11, blocked }), onMerge('needs-you', 'closed', { blocked })]) {
    const result = noted(fixture)

    assertQueued(result, 'blocked')
    assert.deepEqual(result.entry.status, result.before.status)
    assert.deepEqual(result.entry.verified, fixture.verified ?? null)
  }
})

test("note: any stage while atWork is 'agent' (a brief, implement, fix or verify run, or the pre-verify commands)", () => {
  const cases = [
    [staged('brief', 'running', 'brief-write'), 'brief', 'briefing'],
    [staged('implement', 'running', 'implement', { sessionId: 'session-1' }), 'implement', 'implementing'],
    [staged('implement', 'running', 'fix', { pr: 11, fix: FINDINGS_FIX }), 'fix', 'fixing'],
    [staged('pre-verify', 'running', 'commands', { pr: 11, claimedSha: SHA }), 'gate', 'ready_claimed'],
    [staged('verify', 'running', 'verify', { pr: 11, claimedSha: SHA }), 'verify', 'verifying'],
  ]

  for (const [fixture, role, state] of cases) {
    const result = noted(fixture, { running: role })

    assertQueued(result, state)
    assert.deepEqual(result.entry.status, result.before.status, role)
  }
})

test('note: brief · waiting', () => {
  const result = noted(staged('brief', 'waiting', 'slot'))

  assertQueued(result, 'pending')
  assert.deepEqual(place(result.entry), ['brief', 'waiting', 'slot'])
})

test('note: brief · needs-you: attempts-exhausted or errors', () => {
  const exhausted = { status: { role: 'brief', limit: 2 } }

  for (const [code, fields] of [
    ['attempts-exhausted', exhausted],
    ['errors', {}],
  ]) {
    const { events, entry } = noted(staged('brief', 'needs-you', code, { ...fields, attempts: { ...RESET, brief: 2 } }))

    assert.deepEqual(events, [{ id: 'A1', kind: 'brief-answered' }], code)
    assert.deepEqual(place(entry), ['brief', 'waiting', 'slot'])
    assert.deepEqual(entry.briefAnswers, [{ question: null, answer: NOTE }])
    assert.equal(entry.attempts.brief, 1)
  }
})

test('note: implement · waiting, never ran (no fix owed)', () => {
  const result = noted(staged('implement', 'waiting', 'slot'), { brief: true })

  assertQueued(result, 'pending')
  assert.equal(result.entry.fix, null)
  assert.ok(implementPrompt(result.manifest, result.manifest.all[0], result.entry).includes(NOTE))
})

test('note: implement · waiting, a fix owed', () => {
  const owed = { pr: 11, fix: FINDINGS_FIX, fixReason: 'verifier findings', fixNote: '<findings>', attempts: SPENT }
  const result = noted(staged('implement', 'waiting', 'slot', owed))

  assertQueued(result, 'needs_fix')
  assert.deepEqual(result.entry.fix, FINDINGS_FIX)
  assert.deepEqual([result.entry.fixReason, result.entry.fixNote], ['verifier findings', '<findings>'])
  assert.equal(result.entry.attempts.fix, 3)
})

test('note: implement · needs-you: decision or obstacle', () => {
  for (const code of ['decision', 'obstacle']) {
    const result = noted(staged('implement', 'needs-you', code, { pr: 11, sessionId: 'session-1', attempts: SPENT }))

    assertNoteFix(result, 'answer from the maintainer')
    assert.equal(result.entry.attempts.fix, 3)
  }
})

test('note: implement · needs-you: attempts-exhausted or errors', () => {
  const owed = { pr: 11, fix: FINDINGS_FIX, fixReason: 'verifier findings', fixNote: '<findings>', attempts: SPENT }
  const exhausted = noted(staged('implement', 'needs-you', 'attempts-exhausted', { ...owed, status: { role: 'fix', limit: 4 } }))

  assertQueued(exhausted, 'needs_fix')
  assert.deepEqual(place(exhausted.entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual(exhausted.entry.fix, FINDINGS_FIX)
  assert.equal(exhausted.entry.attempts.fix, 3)

  const errors = noted(staged('implement', 'needs-you', 'errors', { sessionId: 'session-1', attempts: SPENT }))

  assertNoteFix(errors, 'answer from the maintainer')

  const implement = noted(
    staged('implement', 'needs-you', 'attempts-exhausted', {
      status: { role: 'implement', limit: 2 },
      attempts: { ...SPENT, implement: 2 },
    }),
  )

  assertNoteFix(implement, 'answer from the maintainer')
  assert.equal(implement.entry.attempts.implement, 1)
})

test('note: on exhausted fix attempts, the next fix run reads the findings and the note', async () => {
  const owed = { sessionId: 'session-1', fix: FINDINGS_FIX, fixReason: 'verifier findings', fixNote: '<findings>', attempts: SPENT }
  const setup = modelDriver({ A1: staged('implement', 'needs-you', 'attempts-exhausted', { ...owed, status: { role: 'fix', limit: 4 } }) })

  apply(setup.manifest, setup.driver, NOTE_COMMAND)

  assert.equal(setup.entry.fix.reason, 'verifier-findings')

  await setup.driver.tick()
  await waitFor(() => setup.calls.some((call) => call.role === 'fix'), 'the fix run')

  const { prompt } = setup.calls.find((call) => call.role === 'fix')

  assert.ok(prompt.includes('reason: **verifier findings**'), prompt)
  assert.ok(prompt.includes(`<findings>\n\n${NOTE}`), prompt)
})

test('note: pre-verify, any status', () => {
  const claimed = { pr: 11, claimedSha: SHA, attempts: SPENT }

  assertNoteFix(noted(staged('pre-verify', 'waiting', 'ci', claimed)), 'request from the maintainer')
  assertNoteFix(noted(staged('pre-verify', 'needs-you', 'errors', claimed)), 'answer from the maintainer')
  assertNoteFix(noted(staged('pre-verify', 'needs-you', 'code-scanning-alerts', claimed)), 'answer from the maintainer')
})

test('note: verify · needs-you: dispute', () => {
  const lastError = 'the verifier still finds F2 open, which the implementer disputed'
  const disputed = {
    pr: 11,
    claimedSha: SHA,
    fixReason: 'verifier findings',
    fixNote: '<findings>',
    escalation: DISPUTE,
    lastError,
    attempts: SPENT,
  }

  const { events, entry, effect } = noted(staged('verify', 'needs-you', 'dispute', disputed))

  assert.deepEqual(events, [
    { id: 'A1', kind: 'needs-fix', reason: 'verifier findings' },
    { id: 'A1', kind: 'note-queued', state: 'needs_fix' },
  ])

  assert.deepEqual(place(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.fix.reason, entry.fix.note, entry.pendingNote], ['verifier-findings', '<findings>', NOTE])
  assert.equal(effect.queued, true)
  assert.equal(entry.attempts.fix, 3)
  assert.deepEqual(
    entry.noteHistory.map(({ at: _, ...record }) => record),
    [{ by: 'maintainer', kind: DISPUTE, question: lastError, text: NOTE, run: null }],
  )
})

test('note: verify · needs-you: attempts-exhausted or errors, or verify · waiting', () => {
  const claimed = { pr: 11, claimedSha: SHA, attempts: SPENT }
  const exhausted = noted(staged('verify', 'needs-you', 'attempts-exhausted', { ...claimed, status: { role: 'verify', limit: 3 } }))

  assertNoteFix(exhausted, 'answer from the maintainer')
  assert.equal(exhausted.entry.attempts.verify, 2)

  assertNoteFix(noted(staged('verify', 'needs-you', 'errors', claimed)), 'answer from the maintainer')
  assertNoteFix(noted(staged('verify', 'waiting', 'slot', { ...claimed, interruptedRole: 'verify' })), 'answer from the maintainer')
})

test('note: merge, any status', () => {
  const approved = { sha: SHA, patchId: 'patch-a1', at: at(81), channel: 'inbox' }

  for (const [kind, code] of [
    ['needs-you', 'approve'],
    ['waiting', 'gate-pending'],
    ['needs-you', 'gate-blocked'],
  ]) {
    const result = noted(onMerge(kind, code, { approved }))

    assertNoteFix(result, code === 'gate-blocked' ? 'answer from the maintainer' : 'request from the maintainer')
    assert.deepEqual([result.entry.verified, result.entry.approved], [null, null], code)
    assert.deepEqual(result.effect.drops, ['verification', 'approval'], code)
  }
})

test('note: a note never shortens a backoff', () => {
  const later = new Date(Date.now() + 3_600_000).toISOString()
  const { entry } = noted(staged('implement', 'needs-you', 'decision', { pr: 11, retryAfter: later, failStreak: 2 }))

  assert.deepEqual(place(entry), ['implement', 'waiting', 'backoff'])
  assert.equal(entry.status.until, later)
})

test('onDone: a PR merged during the run stays merged and is cleaned up after the run', async () => {
  for (const result of [agentResult({ output: { verdict: 'PASS' } }), agentResult({ ok: false, error: 'error_during_execution' })]) {
    const cleaned = []
    const { manifest, driver } = driverFor({ A1: { state: 'merged', pr: 7, costUsd: 2 } }, { cleanup: async (pr) => cleaned.push(pr.id) })
    const before = readEvents(manifest).length

    await driver.onDone(
      manifest.prs.find((pr) => pr.id === 'A1'),
      'verify',
      result,
      { sha: 'abc1234', run: 'A1-03-verify' },
    )

    assert.equal(driver.ledger.prs.A1.state, 'merged')
    assert.equal(driver.ledger.prs.A1.costUsd, 3.25)
    assert.deepEqual(cleaned, ['A1'])
    assert.deepEqual(
      readEvents(manifest)
        .slice(before)
        .map((event) => event.kind),
      ['verify-done'],
    )
  }
})

test('approve is refused under manual and auto, and accepted under human', () => {
  const { sha, patchId } = samplePrs().A1.verified
  const ledger = { A1: { ...samplePrs().A1, held: null, approved: null } }
  const refusals = {
    manual: 'policy.merge is manual: no approval is needed. Merge the PR on GitHub once the driver says it is ready',
    auto: 'policy.merge is auto: no approval is needed. The driver merges once the gate passes, and rollout hold stops it',
  }

  for (const [merge, reason] of Object.entries(refusals)) {
    const notices = []
    const { manifest, driver } = driverFor(ledger, { notify: (_, message) => notices.push(message) })
    manifest.policy.merge = merge

    assert.deepEqual(apply(manifest, driver, { cmd: 'approve', id: 'A1', sha, patchId }), [{ id: 'A1', kind: 'approval-rejected', reason }])
    assert.equal(driver.ledger.prs.A1.approved, null)
    assert.equal(notices.length, 1, merge)
    assert.ok(notices[0].startsWith('A1: approval rejected: '), notices[0])
  }

  const notices = []
  const { manifest, driver } = driverFor(ledger, { notify: (_, message) => notices.push(message) })

  assert.deepEqual(apply(manifest, driver, { cmd: 'approve', id: 'A1', sha, patchId }), [
    { id: 'A1', kind: 'approved', sha: sha.slice(0, 7), channel: 'inbox' },
  ])

  assert.equal(driver.ledger.prs.A1.approved.channel, 'inbox')
  assert.deepEqual(notices, ['A1: approved PR #11; merging in 120s unless you hold it (rollout hold A1)'])
})

test('an inbox approve without a valid at is rejected, and one posted before the verification is refused', () => {
  const { sha, patchId } = samplePrs().A1.verified
  const { manifest, driver } = driverFor({ A1: { ...samplePrs().A1, held: null, approved: null } })
  const noValidAt = { id: '-', kind: 'command-rejected', command: 'approve', reason: 'needs a valid at' }
  const approve = { cmd: 'approve', id: 'A1', sha, patchId }

  writeBatch(manifest, [approve, { ...approve, at: 'not a time' }, { ...approve, at: 42 }, { ...approve, at: at(79) }])

  assert.deepEqual(apply(manifest, driver), [
    noValidAt,
    noValidAt,
    noValidAt,
    { id: 'A1', kind: 'approval-rejected', reason: 'it was posted before the verification finished' },
  ])

  assert.equal(driver.ledger.prs.A1.approved, null)
  assert.deepEqual(apply(manifest, driver, approve), [{ id: 'A1', kind: 'approved', sha: sha.slice(0, 7), channel: 'inbox' }])
})

const APPROVE = { cmd: 'approve', id: 'A1', sha: SHA, patchId: 'patch-a1' }

function approvedWith(entry, { command = APPROVE, running = null, rolloutHold = null, policy = {} } = {}) {
  const notices = []
  const { manifest, driver } = driverFor({ A1: entry }, { notify: (_, message) => notices.push(message) })

  Object.assign(manifest.policy, policy)
  driver.ledger.data.hold = rolloutHold

  if (running) {
    driver.running.set('A1', running)
  }

  return { manifest, driver, notices, ...applied(manifest, driver, command) }
}

function assertApprovalRejected({ events, notices, entry }, reason) {
  assert.deepEqual(events, [{ id: 'A1', kind: 'approval-rejected', reason }])
  assert.deepEqual(notices, [`A1: approval rejected: ${reason}`])
  assert.equal(entry.approved, null)
}

test('approve: approveRefusal(manifest, entry) is not null (merge: manual or auto, or the GitHub channel)', () => {
  const refusals = {
    manual: 'policy.merge is manual: no approval is needed. Merge the PR on GitHub once the driver says it is ready',
    auto: 'policy.merge is auto: no approval is needed. The driver merges once the gate passes, and rollout hold stops it',
  }

  for (const [merge, reason] of Object.entries(refusals)) {
    assertApprovalRejected(approvedWith(onMerge('needs-you', 'approve'), { policy: { merge } }), reason)
  }

  // A login that is no maintainer approves on GitHub.
  assertApprovalRejected(
    approvedWith(onMerge('needs-you', 'review'), { policy: { approval: 'github' } }),
    'PR #11 is approved on GitHub: review it there',
  )
})

test('approve: Not on merge, no verification, or a status that is neither waiting nor needs-you: approve', () => {
  const cases = [
    [staged('implement', 'waiting', 'slot', { pr: 11 }), 'implement · waiting: slot'],
    [staged('pre-verify', 'waiting', 'ci', { pr: 11, claimedSha: SHA, verified: VERIFIED }), 'pre-verify · waiting: ci'],
    [onMerge('needs-you', 'review'), 'merge · needs-you: review'],
    [onMerge('needs-you', 'errors'), 'merge · needs-you: errors'],
    [onMerge('running', 'merge'), 'merge · running: merge'],
    [{ state: 'merged', pr: 11, verified: VERIFIED }, 'merged'],
  ]

  for (const [fixture, shown] of cases) {
    assertApprovalRejected(approvedWith(fixture), `nothing to approve: A1 is ${shown}`)
  }
})

test('approve: atWork set', () => {
  assertApprovalRejected(approvedWith(onMerge('needs-you', 'approve'), { running: 'delegate' }), AT_WORK)
})

test('approve: Another head or patch than the verification', () => {
  const stale = 'it names a different head than the one verified now; look at the card again'

  assertApprovalRejected(approvedWith(onMerge('needs-you', 'approve'), { command: { ...APPROVE, sha: 'b'.repeat(40) } }), stale)
  assertApprovalRejected(approvedWith(onMerge('needs-you', 'approve'), { command: { ...APPROVE, patchId: 'patch-other' } }), stale)
})

test('approve: Posted before the verification finished', () => {
  const early = approvedWith(onMerge('needs-you', 'approve'), { command: { ...APPROVE, at: at(79) } })

  assertApprovalRejected(early, 'it was posted before the verification finished')
})

test('approve: Already approved: entry.approved names the verified patch and its channel is not github', () => {
  const approved = { sha: SHA, patchId: 'patch-a1', at: at(81), channel: 'inbox' }
  const { events, entry, notices } = approvedWith(onMerge('waiting', 'merge-delay', { approved }))
  const reason = 'already approved at 2026-09-01 11:21 UTC. The merge delay counts from then'

  assert.deepEqual(events, [{ id: 'A1', kind: 'approval-rejected', reason }])
  assert.deepEqual(notices, [`A1: approval rejected: ${reason}`])
  assert.deepEqual(entry.approved, approved)

  // An approval on GitHub does not count as one through the inbox.
  const github = approvedWith(onMerge('waiting', 'gate-pending', { approved: { ...approved, channel: 'github', by: 'maint' } }))

  assert.equal(github.entry.approved.channel, 'inbox')
})

test('approve: Under a hold of the PR or the rollout', () => {
  const own = approvedWith(onMerge('waiting', 'held', { hold: HOLD, held: HOLD, status: { scope: 'pr' } }))

  assert.deepEqual(
    own.events.map((event) => event.kind),
    ['approved'],
  )

  assert.deepEqual(place(own.entry), ['merge', 'waiting', 'held'])
  assert.equal(own.entry.status.scope, 'pr')
  assert.equal(own.entry.approved.channel, 'inbox')

  const rollout = approvedWith(onMerge('needs-you', 'approve'), { rolloutHold: HOLD })

  assert.deepEqual(place(rollout.entry), ['merge', 'waiting', 'held'])
  assert.equal(rollout.entry.status.scope, 'rollout')
})

test('approve: On merge, names the verified head and patch, posted after the verification', () => {
  const { events, entry, notices, effect } = approvedWith(onMerge('needs-you', 'approve'))
  const until = new Date(Date.parse(entry.approved.at) + 120_000).toISOString()

  assert.deepEqual(events, [{ id: 'A1', kind: 'approved', sha: SHA.slice(0, 7), channel: 'inbox' }])
  assert.deepEqual(notices, ['A1: approved PR #11; merging in 120s unless you hold it (rollout hold A1)'])
  assert.deepEqual({ ...entry.approved, at: null }, { sha: SHA, patchId: 'patch-a1', at: null, channel: 'inbox' })
  assert.deepEqual(entry.status, { kind: 'waiting', code: 'merge-delay', until, since: entry.approved.at })
  assert.deepEqual([effect.stage, effect.status.code], ['merge', 'merge-delay'])
})

test('approve: a second approve is refused, and neither the approval time nor the end of the merge delay moves', () => {
  const { manifest, driver } = driverFor({ A1: onMerge('needs-you', 'approve') })
  const entry = driver.ledger.prs.A1

  apply(manifest, driver, APPROVE)

  const first = structuredClone(entry.approved)
  const until = entry.status.until
  const { events } = applied(manifest, driver, APPROVE)

  assert.deepEqual(events, [
    {
      id: 'A1',
      kind: 'approval-rejected',
      reason: `already approved at ${first.at.slice(0, 16).replace('T', ' ')} UTC. The merge delay counts from then`,
    },
  ])

  assert.deepEqual(entry.approved, first)
  assert.equal(entry.status.until, until)
})

test('a GitHub approval is noticed once, and the merge delay counts from when the driver first saw it', async () => {
  const { sha, patchId } = samplePrs().A1.verified
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()
  const green = { state: 'green', missing: [], pending: [], failing: [] }
  const reviews = [{ user: 'maint', state: 'APPROVED', commit: sha, at: minutesAgo(60) }]
  const notices = []
  const ledger = {
    A1: { ...samplePrs().A1, held: null, approved: null, patchSince: minutesAgo(120), verified: { sha, patchId, at: minutesAgo(120) } },
  }

  const { manifest, driver } = driverFor(ledger, {
    notify: (_, message) => notices.push(message),
    collectFacts: async () => ({
      depsPending: [],
      files: [],
      addedLines: [],
      commits: [],
      changesets: [],
      baseIsAncestor: true,
      patchId,
      pr: {
        number: 11,
        state: 'OPEN',
        isDraft: false,
        title: 'feat: A1',
        body: '',
        author: 'demo-bot',
        headRefName: 'feat/a1',
        headRefOid: sha,
        baseRefName: 'main',
        labels: [manifest.label],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      },
      checks: green,
      mainChecks: green,
      reviews: [...reviews],
    }),
  })

  const pr = manifest.prs.find((item) => item.id === 'A1')
  const entry = driver.ledger.prs.A1

  // Without a token the manifest refuses approval: github, so the test sets it here.
  manifest.policy.approval = 'github'
  manifest.repo.maintainers = ['maint']
  manifest.dryRun = true

  async function pass() {
    const before = readEvents(manifest).length
    const sent = notices.length

    await driver.mergeCandidate(pr)

    return {
      kinds: readEvents(manifest)
        .slice(before)
        .map((event) => event.kind),
      sent: notices.slice(sent),
    }
  }

  entry.held = { at: minutesAgo(1) }

  const held = await pass()
  assert.equal(entry.approved, null)
  assert.deepEqual(held.sent, [])
  assert.ok(!held.kinds.includes('approved'), held.kinds)

  entry.held = null

  const first = await pass()
  assert.deepEqual({ ...entry.approved, at: null }, { patchId, sha, at: null, by: 'maint', channel: 'github' })
  assert.ok(Date.now() - Date.parse(entry.approved.at) < 60_000, entry.approved.at)
  assert.deepEqual(first.sent, ['A1: PR #11 approved on GitHub by maint; merging in 120s unless you hold it (rollout hold A1)'])
  assert.ok(!first.kinds.includes('would-merge'), first.kinds)

  const second = await pass()
  assert.deepEqual(second.sent, [])
  assert.ok(!second.kinds.includes('would-merge'), second.kinds)

  entry.approved.at = new Date(Date.parse(entry.approved.at) - 121_000).toISOString()

  assert.ok((await pass()).kinds.includes('would-merge'))

  reviews.push({ user: 'maint', state: 'CHANGES_REQUESTED', commit: sha, at: minutesAgo(30) })

  await pass()
  assert.equal(entry.approved, null)

  reviews.push({ user: 'maint', state: 'APPROVED', commit: sha, at: minutesAgo(10) })

  const again = await pass()
  assert.equal(entry.approved.channel, 'github')
  assert.deepEqual(again.sent, ['A1: PR #11 approved on GitHub by maint; merging in 120s unless you hold it (rollout hold A1)'])
})
