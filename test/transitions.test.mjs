import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshPr } from '../lib/ledger.mjs'
import {
  answerBrief,
  briefWaits,
  briefWritten,
  claimNewHead,
  DISPUTE,
  escalateDispute,
  escalatedOverDispute,
  escalateErrors,
  escalateExhausted,
  joinFix,
  recoverRun,
  reportUsed,
  reportWaits,
  resumeAfterRetry,
  runFailed,
  runStarted,
  toBlocked,
  toClaimed,
  toFix,
  toMerged,
  toPending,
  toVerified,
  verifyAgain,
} from '../lib/transitions.ts'

const SHA = 'a'.repeat(40)
const OLD_SHA = 'b'.repeat(40)
const AT = '2001-02-03T04:05:06.000Z'
const EARLIER = '2001-02-03T03:00:00.000Z'

function entryWith(fields = {}) {
  return { ...freshPr(), ...fields }
}

function verification(sha = SHA) {
  return { sha, patchId: 'patch-1', at: EARLIER }
}

test('transitions: escalatedOverDispute is true for a PR escalated over a dispute', () => {
  const entry = entryWith({ state: 'escalated', escalation: DISPUTE })

  assert.equal(escalatedOverDispute(entry), true)
})

test('transitions: escalatedOverDispute is false for another escalation or a dispute left behind', () => {
  assert.equal(escalatedOverDispute(entryWith({ state: 'escalated', escalation: 'repeated errors' })), false)
  assert.equal(escalatedOverDispute(entryWith({ state: 'needs_fix', escalation: DISPUTE })), false)
})

test('transitions: toFix sends the PR to a fix and drops the verification', () => {
  const entry = entryWith({ state: 'verified', pr: 7, claimedSha: SHA, verified: verification() })
  const before = structuredClone(entry)

  toFix(entry, 'merge gate', 'CI is red')

  assert.deepEqual(entry, { ...before, state: 'needs_fix', fixReason: 'merge gate', fixNote: 'CI is red', verified: null })
})

test('transitions: joinFix adds a note under the note of the fix', () => {
  const entry = entryWith({ state: 'needs_fix', fixReason: 'verifier findings', fixNote: 'first' })
  const before = structuredClone(entry)

  joinFix(entry, 'second')

  assert.deepEqual(entry, { ...before, fixNote: 'first\n\nsecond' })
})

test('transitions: joinFix starts from an empty note when the fix has none', () => {
  const entry = entryWith({ state: 'needs_fix' })
  const before = structuredClone(entry)

  joinFix(entry, 'second')

  assert.deepEqual(entry, { ...before, fixNote: '\n\nsecond' })
})

test('transitions: answerBrief records the answer and sends the PR back to its brief', () => {
  const blocked = { kind: 'brief-questions', question: 'Which file?', evidence: '', run: 'P1-01-brief-review' }
  const entry = entryWith({
    state: 'blocked',
    blocked,
    attempts: { implement: 0, fix: 0, verify: 0, brief: 2 },
    briefAnswers: [{ question: 'Earlier?', answer: 'yes' }],
  })

  const before = structuredClone(entry)

  answerBrief(entry, 'Which file?', 'lib/a.mjs')

  assert.deepEqual(entry, {
    ...before,
    briefAnswers: [
      { question: 'Earlier?', answer: 'yes' },
      { question: 'Which file?', answer: 'lib/a.mjs' },
    ],
    attempts: { ...before.attempts, brief: 1 },
    state: 'pending',
    blocked: null,
  })
})

test('transitions: answerBrief keeps the brief attempts at 0', () => {
  const entry = entryWith({ state: 'escalated' })
  const before = structuredClone(entry)

  answerBrief(entry, null, 'write it from the plan')

  assert.deepEqual(entry, {
    ...before,
    briefAnswers: [{ question: null, answer: 'write it from the plan' }],
    state: 'pending',
    blocked: null,
  })
})

test('transitions: toPending sends the PR back to pending', () => {
  const entry = entryWith({ state: 'briefing', attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } })
  const before = structuredClone(entry)

  toPending(entry)

  assert.deepEqual(entry, { ...before, state: 'pending' })
})

test('transitions: briefWaits gives the brief attempt back and remembers the heads', () => {
  const entry = entryWith({ state: 'briefing', attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } })
  const before = structuredClone(entry)

  briefWaits(entry, `P1@${SHA}`)

  assert.deepEqual(entry, { ...before, attempts: { ...before.attempts, brief: 0 }, previewConflict: `P1@${SHA}`, state: 'pending' })
})

test('transitions: briefWaits keeps the brief attempts at 0', () => {
  const entry = entryWith({ state: 'briefing' })
  const before = structuredClone(entry)

  briefWaits(entry, `P1@${SHA}`)

  assert.deepEqual(entry, { ...before, previewConflict: `P1@${SHA}`, state: 'pending' })
})

test('transitions: briefWritten records the brief and sends the PR back to pending', () => {
  const entry = entryWith({
    state: 'briefing',
    previewConflict: `P1@${OLD_SHA}`,
    briefAnswers: [{ question: 'Which file?', answer: 'lib/a.mjs' }],
    failStreak: 2,
  })

  const before = structuredClone(entry)
  const heads = [{ id: 'P1', sha: SHA, patchId: 'patch-1' }]

  briefWritten(entry, { scope: ['lib/a.mjs'], heads, at: AT })

  assert.deepEqual(entry, {
    ...before,
    briefScope: ['lib/a.mjs'],
    briefHeads: heads,
    previewConflict: null,
    briefAt: AT,
    briefAnswers: [],
    failStreak: 0,
    state: 'pending',
  })
})

test('transitions: runStarted puts the PR in the run state of its role', () => {
  const states = { brief: 'briefing', implement: 'implementing', fix: 'fixing', verify: 'verifying' }

  for (const [role, state] of Object.entries(states)) {
    const entry = entryWith({ state: 'pending' })
    const before = structuredClone(entry)

    runStarted(entry, role)

    assert.deepEqual(entry, { ...before, state }, role)
  }
})

test('transitions: runFailed interrupts the PR with the role of the run', () => {
  const entry = entryWith({ state: 'fixing', pr: 7 })
  const before = structuredClone(entry)

  runFailed(entry, 'fix')

  assert.deepEqual(entry, { ...before, state: 'interrupted', interruptedRole: 'fix' })
})

test('transitions: reportWaits parks the READY report for a later tick', () => {
  const entry = entryWith({ state: 'implementing', ready: { status: 'READY', pr: 7, headSha: SHA } })
  const before = structuredClone(entry)

  reportWaits(entry)

  assert.deepEqual(entry, { ...before, state: 'interrupted', interruptedRole: 'report' })
})

test('transitions: reportUsed drops the report role and keeps the state', () => {
  const entry = entryWith({ state: 'interrupted', interruptedRole: 'report', ready: { status: 'READY', pr: 7, headSha: SHA } })
  const before = structuredClone(entry)

  reportUsed(entry)

  assert.deepEqual(entry, { ...before, interruptedRole: null })
})

test('transitions: toClaimed records the claim of a READY report', () => {
  const entry = entryWith({ state: 'implementing', ciPendingSince: EARLIER, verified: verification(OLD_SHA) })
  const before = structuredClone(entry)

  toClaimed(entry, { pr: 7, sha: SHA, at: AT })

  assert.deepEqual(entry, {
    ...before,
    pr: 7,
    claimedSha: SHA,
    claimedAt: AT,
    ciPendingSince: null,
    verified: null,
    state: 'ready_claimed',
  })
})

test('transitions: claimNewHead claims the new head and drops the verification', () => {
  const entry = entryWith({
    state: 'verified',
    pr: 7,
    claimedSha: OLD_SHA,
    claimedAt: EARLIER,
    ciPendingSince: EARLIER,
    verified: verification(OLD_SHA),
    approved: { sha: OLD_SHA, patchId: 'patch-1', at: EARLIER },
  })

  const before = structuredClone(entry)

  claimNewHead(entry, { sha: SHA, at: AT })

  assert.deepEqual(entry, { ...before, verified: null, state: 'ready_claimed', claimedSha: SHA, claimedAt: AT, ciPendingSince: null })
})

test('transitions: verifyAgain sends the PR back to its claim', () => {
  const entry = entryWith({ state: 'verifying', pr: 7, claimedSha: SHA })
  const before = structuredClone(entry)

  verifyAgain(entry)

  assert.deepEqual(entry, { ...before, state: 'ready_claimed' })
})

test('transitions: toVerified binds the verification to the claimed patch and clears the findings', () => {
  const entry = entryWith({
    state: 'verifying',
    pr: 7,
    claimedSha: SHA,
    claimPatchId: 'patch-2',
    attempts: { implement: 1, fix: 1, verify: 2, brief: 0 },
    findings: { items: [{ id: 'F1', text: 'a finding' }] },
  })

  const before = structuredClone(entry)

  toVerified(entry, { sha: SHA, at: AT })

  assert.deepEqual(entry, {
    ...before,
    verified: { sha: SHA, patchId: 'patch-2', at: AT },
    attempts: { ...before.attempts, verify: 0 },
    state: 'verified',
    findings: null,
  })
})

test('transitions: toBlocked blocks the PR on the record it is given', () => {
  const blocked = { kind: 'needs-decision', question: 'Which API?', evidence: 'two APIs fit', run: 'P1-01-implement' }
  const entry = entryWith({ state: 'implementing' })
  const before = structuredClone(entry)

  toBlocked(entry, blocked)

  assert.deepEqual(entry, { ...before, state: 'blocked', blocked })
})

test('transitions: escalateExhausted escalates a PR out of fix attempts', () => {
  const entry = entryWith({ state: 'needs_fix', pr: 7, attempts: { implement: 1, fix: 3, verify: 0, brief: 0 } })
  const before = structuredClone(entry)

  escalateExhausted(entry, { role: 'fix', limit: 3, at: AT, run: 'P1-04-fix' })

  assert.deepEqual(entry, {
    ...before,
    state: 'escalated',
    escalation: 'fix attempts exhausted',
    escalatedAt: AT,
    escalationRun: 'P1-04-fix',
    lastError: 'fix attempts exhausted (3)',
  })
})

test('transitions: escalateExhausted escalates a PR out of brief attempts', () => {
  const entry = entryWith({ state: 'pending', attempts: { implement: 0, fix: 0, verify: 0, brief: 2 } })
  const before = structuredClone(entry)

  escalateExhausted(entry, { role: 'brief', limit: 2, at: AT, run: null })

  assert.deepEqual(entry, {
    ...before,
    state: 'escalated',
    escalation: 'brief attempts exhausted',
    escalatedAt: AT,
    escalationRun: null,
    lastError: 'brief attempts exhausted (2)',
  })
})

test('transitions: escalateDispute escalates an upheld dispute and keeps the findings for a fix', () => {
  const entry = entryWith({ state: 'verifying', pr: 7, claimedSha: SHA, verified: verification() })
  const before = structuredClone(entry)

  escalateDispute(entry, { note: 'F1: still open', text: 'the verifier still finds F1 open', at: AT, run: 'P1-03-verify' })

  assert.deepEqual(entry, {
    ...before,
    state: 'escalated',
    escalation: DISPUTE,
    escalatedAt: AT,
    escalationRun: 'P1-03-verify',
    verified: null,
    fixReason: 'verifier findings',
    fixNote: 'F1: still open',
    lastError: 'the verifier still finds F1 open',
  })
})

test('transitions: escalateErrors escalates a PR after repeated errors', () => {
  const entry = entryWith({ state: 'ready_claimed', pr: 7, lastError: 'boom' })
  const before = structuredClone(entry)

  escalateErrors(entry, { at: AT, run: 'P1-02-implement' })

  assert.deepEqual(entry, {
    ...before,
    state: 'escalated',
    escalation: 'repeated errors',
    escalatedAt: AT,
    escalationRun: 'P1-02-implement',
  })
})

test('transitions: toMerged with no field marks the PR merged and adds no key', () => {
  const entry = entryWith({ state: 'verified', pr: 7, verified: verification() })
  const before = structuredClone(entry)

  toMerged(entry)

  assert.deepEqual(entry, { ...before, state: 'merged' })
})

test('transitions: toMerged records the merge commit', () => {
  const entry = entryWith({ state: 'verified', pr: 7, verified: verification() })
  const before = structuredClone(entry)

  toMerged(entry, { mergeSha: SHA })

  assert.deepEqual(entry, { ...before, state: 'merged', mergeSha: SHA })
})

test('transitions: toMerged records the PR number of a merge outside the run', () => {
  const entry = entryWith({ state: 'pending' })
  const before = structuredClone(entry)

  toMerged(entry, { pr: 12 })

  assert.deepEqual(entry, { ...before, state: 'merged', pr: 12 })
})

test('transitions: recoverRun sends a briefing back to pending without a refund', () => {
  const entry = entryWith({ state: 'briefing', attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: false }), 'brief')
  assert.deepEqual(entry, { ...before, state: 'pending' })
})

test('transitions: recoverRun sends a briefing back to pending with its attempt refunded', () => {
  const entry = entryWith({ state: 'briefing', attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true }), 'brief')
  assert.deepEqual(entry, { ...before, state: 'pending', attempts: { ...before.attempts, brief: 0 } })
})

test('transitions: recoverRun interrupts a run state with its role and no refund', () => {
  const entry = entryWith({ state: 'fixing', pr: 7, attempts: { implement: 1, fix: 2, verify: 0, brief: 0 } })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: false }), 'fix')
  assert.deepEqual(entry, { ...before, interruptedRole: 'fix', state: 'interrupted' })
})

test('transitions: recoverRun interrupts a run state with its attempt refunded', () => {
  const entry = entryWith({ state: 'verifying', pr: 7, claimedSha: SHA, attempts: { implement: 1, fix: 0, verify: 1, brief: 0 } })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true }), 'verify')
  assert.deepEqual(entry, { ...before, interruptedRole: 'verify', state: 'interrupted', attempts: { ...before.attempts, verify: 0 } })
})

test('transitions: recoverRun keeps a refunded attempt at 0', () => {
  const entry = entryWith({ state: 'implementing' })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true }), 'implement')
  assert.deepEqual(entry, { ...before, interruptedRole: 'implement', state: 'interrupted' })
})

test('transitions: recoverRun leaves a PR in no run state untouched', () => {
  const entry = entryWith({ state: 'needs_fix', pr: 7, attempts: { implement: 1, fix: 1, verify: 0, brief: 0 } })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true }), null)
  assert.deepEqual(entry, before)
})

test('transitions: resumeAfterRetry sends an upheld dispute to a fix', () => {
  const entry = entryWith({ state: 'escalated', escalation: DISPUTE, pr: 7, claimedSha: SHA, interruptedRole: 'verify' })
  const before = structuredClone(entry)

  resumeAfterRetry(entry)

  assert.deepEqual(entry, { ...before, state: 'needs_fix', interruptedRole: null })
})

test('transitions: resumeAfterRetry sends a verification at the claimed head back to the gate', () => {
  const entry = entryWith({
    state: 'escalated',
    escalation: 'repeated errors',
    pr: 7,
    claimedSha: SHA,
    verified: verification(SHA),
    interruptedRole: 'fix',
  })

  const before = structuredClone(entry)

  resumeAfterRetry(entry)

  assert.deepEqual(entry, { ...before, state: 'verified', interruptedRole: null })
})

test('transitions: resumeAfterRetry checks a verification at an older head again from the claim', () => {
  const entry = entryWith({
    state: 'blocked',
    pr: 7,
    claimedSha: SHA,
    ciPendingSince: EARLIER,
    verified: verification(OLD_SHA),
    interruptedRole: 'verify',
  })

  const before = structuredClone(entry)

  resumeAfterRetry(entry)

  assert.deepEqual(entry, { ...before, verified: null, ciPendingSince: null, state: 'ready_claimed', interruptedRole: null })
})

test('transitions: resumeAfterRetry keeps a parked READY report for its claim', () => {
  const entry = entryWith({
    state: 'escalated',
    escalation: 'repeated errors',
    sessionId: 'session-1',
    interruptedRole: 'report',
    ready: { status: 'READY', pr: 7, headSha: SHA },
  })

  const before = structuredClone(entry)

  resumeAfterRetry(entry)

  assert.deepEqual(entry, { ...before, state: 'interrupted' })
})

test('transitions: resumeAfterRetry verifies a claim with no verification', () => {
  const entry = entryWith({ state: 'escalated', escalation: 'verify attempts exhausted', pr: 7, claimedSha: SHA, sessionId: 'session-1' })
  const before = structuredClone(entry)

  resumeAfterRetry(entry)

  assert.deepEqual(entry, { ...before, state: 'interrupted', interruptedRole: 'verify' })
})

test('transitions: resumeAfterRetry sends a PR or a session with no claim to a fix', () => {
  for (const fields of [{ pr: 7 }, { sessionId: 'session-1' }]) {
    const entry = entryWith({ state: 'escalated', escalation: 'implement attempts exhausted', ...fields })
    const before = structuredClone(entry)

    resumeAfterRetry(entry)

    assert.deepEqual(entry, { ...before, state: 'interrupted', interruptedRole: 'fix' }, JSON.stringify(fields))
  }
})

test('transitions: resumeAfterRetry sends an entry with no PR and no session back to pending', () => {
  const entry = entryWith({ state: 'escalated', escalation: 'repeated errors' })
  const before = structuredClone(entry)

  resumeAfterRetry(entry)

  assert.deepEqual(entry, { ...before, state: 'pending', interruptedRole: 'fix' })
})
