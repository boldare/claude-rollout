import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshPr } from '../lib/ledger.mjs'
import {
  answerBrief,
  approveInbox,
  briefWaits,
  briefWritten,
  claimNewHead,
  commandsPassed,
  delegateReturned,
  delegateStarted,
  DISPUTE,
  dropVerification,
  escalateDispute,
  escalatedOverDispute,
  escalateErrors,
  escalateExhausted,
  fillFromState,
  fixReasonCode,
  freshAttempt,
  gateVerdict,
  holdPr,
  joinFix,
  recoverRun,
  refundAttempt,
  releasePr,
  reportUsed,
  reportWaits,
  mergeStatus,
  resetBudgets,
  retryFix,
  retryMerge,
  runFailed,
  runName,
  runStarted,
  setStatus,
  stateOf,
  toBlocked,
  toClaimed,
  toClosed,
  toFix,
  toMergeStatus,
  toMerged,
  toPending,
  toReopened,
  toVerified,
  unheld,
  verifyAgain,
  waitOnStage,
  wake,
} from '../lib/transitions.ts'

const SHA = 'a'.repeat(40)
const OLD_SHA = 'b'.repeat(40)
const AT = '2001-02-03T04:05:06.000Z'
const EARLIER = '2001-02-03T03:00:00.000Z'
const OPENED = '2001-02-03T02:00:00.000Z'
const LATER = '2001-02-03T05:00:00.000Z'

// An entry as openLedger leaves it: the version 2 fields, filled at OPENED.
function entryWith(fields = {}, { briefWritten: written = false, runs = {} } = {}) {
  return fillFromState({ ...freshPr(), ...fields }, { id: 'P1', briefWritten: written, runs, at: OPENED })
}

function verification(sha = SHA) {
  return { sha, patchId: 'patch-1', at: EARLIER }
}

function slot(since = AT) {
  return { kind: 'waiting', code: 'slot', since }
}

function ciAt(sha, since = AT) {
  return { kind: 'waiting', code: 'ci', sha, missing: [], pending: [], since }
}

function noReport(since = AT) {
  return { reason: 'no-report', note: '', since }
}

function question(kind, text, evidence, run) {
  return { kind, text, evidence, run, delegate: null }
}

const DECISION = { kind: 'needs-decision', question: 'Keep the old flag?', evidence: 'cli.mjs:12', run: 'P1-01-implement' }

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

  toFix(entry, 'merge gate', 'CI is red', { code: 'ci-red', at: AT })

  assert.deepEqual(entry, {
    ...before,
    state: 'needs_fix',
    fixReason: 'merge gate',
    fixNote: 'CI is red',
    verified: null,
    stage: 'implement',
    status: slot(),
    fix: { reason: 'ci-red', note: 'CI is red', since: AT },
  })
})

test('transitions: toFix in back-off waits it out', () => {
  const entry = entryWith({ state: 'ready_claimed', pr: 7, claimedSha: SHA, retryAfter: LATER, failStreak: 2 })

  toFix(entry, 'CI is red', 'fix it', { code: 'ci-red', at: AT })

  assert.deepEqual(entry.status, { kind: 'waiting', code: 'backoff', until: LATER, failures: 2, since: AT })
  assert.equal(entry.state, 'needs_fix')
})

test('transitions: joinFix adds a note under the note of the fix', () => {
  const entry = entryWith({ state: 'needs_fix', fixReason: 'verifier findings', fixNote: 'first' })
  const before = structuredClone(entry)

  joinFix(entry, 'second')

  assert.deepEqual(entry, { ...before, fixNote: 'first\n\nsecond', fix: { ...before.fix, note: 'first\n\nsecond' } })
})

test('transitions: joinFix starts from an empty note when the fix has none', () => {
  const entry = entryWith({ state: 'needs_fix' })
  const before = structuredClone(entry)

  joinFix(entry, 'second')

  assert.deepEqual(entry, { ...before, fixNote: '\n\nsecond', fix: { ...before.fix, note: '\n\nsecond' } })
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

  answerBrief(entry, 'Which file?', 'lib/a.mjs', AT)

  assert.deepEqual(entry, {
    ...before,
    briefAnswers: [
      { question: 'Earlier?', answer: 'yes' },
      { question: 'Which file?', answer: 'lib/a.mjs' },
    ],
    attempts: { ...before.attempts, brief: 1 },
    state: 'pending',
    blocked: null,
    stage: 'brief',
    status: slot(),
  })
})

test('transitions: answerBrief keeps the brief attempts at 0', () => {
  const entry = entryWith({ state: 'escalated' })
  const before = structuredClone(entry)

  answerBrief(entry, null, 'write it from the plan', AT)

  assert.deepEqual(entry, {
    ...before,
    briefAnswers: [{ question: null, answer: 'write it from the plan' }],
    state: 'pending',
    blocked: null,
    stage: 'brief',
    status: slot(),
  })
})

test('transitions: toPending sends the PR back to pending', () => {
  const entry = entryWith({ state: 'briefing', attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } })
  const before = structuredClone(entry)

  toPending(entry, AT)

  assert.deepEqual(entry, { ...before, state: 'pending', stage: 'brief', status: slot() })
})

test('transitions: briefWaits gives the brief attempt back and remembers the heads', () => {
  const entry = entryWith({ state: 'briefing', attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } })
  const before = structuredClone(entry)
  const heads = [{ id: 'P0', sha: SHA, patchId: 'patch-0' }]

  briefWaits(entry, `P0@${SHA}`, { heads, at: AT })

  assert.deepEqual(entry, {
    ...before,
    attempts: { ...before.attempts, brief: 0 },
    previewConflict: `P0@${SHA}`,
    state: 'pending',
    stage: 'brief',
    status: { kind: 'waiting', code: 'dependencies-merge', heads, since: AT },
  })
})

test('transitions: briefWaits keeps the brief attempts at 0', () => {
  const entry = entryWith({ state: 'briefing' })
  const before = structuredClone(entry)

  briefWaits(entry, `P0@${SHA}`, { heads: [], at: AT })

  assert.deepEqual(entry, {
    ...before,
    previewConflict: `P0@${SHA}`,
    state: 'pending',
    stage: 'brief',
    status: { kind: 'waiting', code: 'dependencies-merge', heads: [], since: AT },
  })
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
    stage: 'implement',
    status: slot(),
    fix: null,
  })
})

test('transitions: runStarted puts the PR in the run state of its role', () => {
  const started = {
    brief: ['briefing', 'brief', { kind: 'running', code: 'brief-write', run: '', since: AT }],
    implement: ['implementing', 'implement', { kind: 'running', code: 'implement', run: '', since: AT }],
    fix: ['fixing', 'implement', { kind: 'running', code: 'fix', reason: 'no-report', run: '', since: AT }],
    verify: ['verifying', 'verify', { kind: 'running', code: 'verify', sha: SHA, run: '', since: AT }],
  }

  for (const [role, [state, stage, status]] of Object.entries(started)) {
    const entry = entryWith({ state: 'pending' })
    const before = structuredClone(entry)

    runStarted(entry, role, { at: AT, sha: SHA })

    assert.deepEqual(entry, { ...before, state, stage, status, fix: null }, role)
  }
})

test('transitions: runStarted for a fix runs under the reason of the fix and keeps it', () => {
  const entry = entryWith({ state: 'needs_fix', pr: 7, fixReason: 'CI is red', fixNote: 'the test fails' })
  const fix = { reason: 'ci-red', note: 'the test fails', since: OPENED }

  runStarted(entry, 'fix', { at: AT })

  assert.deepEqual(entry.status, { kind: 'running', code: 'fix', reason: 'ci-red', run: '', since: AT })
  assert.deepEqual(entry.fix, fix)
  assert.equal(entry.state, 'fixing')
})

test('transitions: runName names the run of a running status and keeps its time', () => {
  const entry = entryWith({ state: 'pending' })

  runStarted(entry, 'implement', { at: AT })
  runName(entry, 'P1-01-implement')

  assert.deepEqual(entry.status, { kind: 'running', code: 'implement', run: 'P1-01-implement', since: AT })

  const waiting = entryWith({ state: 'needs_fix' })
  const before = structuredClone(waiting)

  runName(waiting, 'P1-02-fix')

  assert.deepEqual(waiting, before)
})

test('transitions: runFailed interrupts the PR with the role of the run', () => {
  const entry = entryWith({ state: 'fixing', pr: 7 })
  const before = structuredClone(entry)

  runFailed(entry, 'fix', AT)

  assert.deepEqual(entry, { ...before, state: 'interrupted', interruptedRole: 'fix', status: slot(), fix: noReport() })
})

test("transitions: runFailed keeps a fix run's fix, its reason and its note, and the PR owes that fix again", () => {
  const entry = entryWith({ state: 'fixing', pr: 7, sessionId: 'session-1', fixReason: 'verifier findings', fixNote: 'F1: the flag.' })
  const before = structuredClone(entry)

  runFailed(entry, 'fix', AT)

  assert.deepEqual(entry, { ...before, state: 'needs_fix', interruptedRole: null, status: slot() })
  assert.deepEqual(entry.fix, { reason: 'verifier-findings', note: 'F1: the flag.', since: OPENED })
})

test('transitions: runFailed keeps a fix in back-off while it lasts', () => {
  const entry = entryWith({ state: 'fixing', pr: 7, fixReason: 'CI is red', fixNote: 'test fails', retryAfter: LATER, failStreak: 1 })

  runFailed(entry, 'fix', AT)

  assert.deepEqual(
    [entry.state, entry.status, entry.fix.reason],
    ['needs_fix', { kind: 'waiting', code: 'backoff', until: LATER, failures: 1, since: AT }, 'ci-red'],
  )
})

test('transitions: runFailed rests a brief and a verify run on their own stage, in back-off while it lasts', () => {
  const brief = entryWith({ state: 'briefing' })

  runFailed(brief, 'brief', AT)

  assert.deepEqual([brief.state, brief.stage, brief.status, brief.fix], ['pending', 'brief', slot(), null])

  const verify = entryWith({ state: 'verifying', pr: 7, claimedSha: SHA, retryAfter: LATER, failStreak: 1 })

  runFailed(verify, 'verify', AT)

  assert.deepEqual(
    [verify.state, verify.stage, verify.status],
    ['interrupted', 'verify', { kind: 'waiting', code: 'backoff', until: LATER, failures: 1, since: AT }],
  )
})

test('transitions: reportWaits parks the READY report for a later tick', () => {
  const entry = entryWith({ state: 'implementing', ready: { status: 'READY', pr: 7, headSha: SHA } })
  const before = structuredClone(entry)

  reportWaits(entry, AT)

  assert.deepEqual(entry, {
    ...before,
    state: 'interrupted',
    interruptedRole: 'report',
    stage: 'pre-verify',
    status: { kind: 'waiting', code: 'github', since: AT },
    fix: null,
  })
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
    stage: 'pre-verify',
    status: ciAt(SHA),
    fix: null,
  })
})

test('transitions: claimNewHead claims the new head and drops the verification and the approval', () => {
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

  assert.deepEqual(entry, {
    ...before,
    verified: null,
    approved: null,
    state: 'ready_claimed',
    claimedSha: SHA,
    claimedAt: AT,
    ciPendingSince: null,
    stage: 'pre-verify',
    status: ciAt(SHA),
  })
})

test('transitions: verifyAgain sends the PR back to its claim', () => {
  const entry = entryWith({ state: 'verifying', pr: 7, claimedSha: SHA })
  const before = structuredClone(entry)

  verifyAgain(entry, AT)

  assert.deepEqual(entry, { ...before, state: 'ready_claimed', stage: 'pre-verify', status: ciAt(SHA) })
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
    stage: 'merge',
    status: { kind: 'waiting', code: 'gate-pending', since: AT },
  })
})

test('transitions: toBlocked blocks the PR on the record it is given', () => {
  const blocked = { kind: 'needs-decision', question: 'Which API?', evidence: 'two APIs fit', run: 'P1-01-implement' }
  const entry = entryWith({ state: 'implementing' })
  const before = structuredClone(entry)

  toBlocked(entry, blocked, { at: AT })

  assert.deepEqual(entry, {
    ...before,
    state: 'blocked',
    blocked,
    status: {
      kind: 'needs-you',
      code: 'decision',
      question: question('needs-decision', 'Which API?', 'two APIs fit', 'P1-01-implement'),
      since: AT,
    },
  })
})

test('transitions: toBlocked puts each kind of question on its stage and code', () => {
  const report = (kind) => ({ kind, question: 'What now?', evidence: 'line one\nline two', run: 'P1-02-fix' })
  const cases = [
    [report('brief-questions'), 'brief', 'brief-questions', 'brief-questions'],
    [report('brief-contradiction'), 'implement', 'decision', 'brief-contradiction'],
    [report('a kind no schema has'), 'implement', 'decision', 'unknown'],
    [report('environment'), 'implement', 'obstacle', 'environment'],
    [report('ci'), 'implement', 'obstacle', 'ci'],
    [report('stuck'), 'implement', 'obstacle', 'stuck'],
    [report('code-scanning'), 'implement', 'obstacle', 'code-scanning'],
  ]

  for (const [blocked, stage, code, kind] of cases) {
    const entry = entryWith({ state: 'fixing', pr: 7, fixReason: 'CI is red' })
    const fix = structuredClone(entry.fix)

    toBlocked(entry, blocked, { at: AT })

    const asked = question(kind, 'What now?', 'line one\nline two', 'P1-02-fix')

    assert.deepEqual(entry.status, { kind: 'needs-you', code, question: asked, since: AT })
    assert.equal(entry.stage, stage, blocked.kind)
    assert.deepEqual(entry.fix, stage === 'implement' ? fix : null, blocked.kind)
    assert.equal(entry.state, 'blocked', blocked.kind)
  }
})

test('transitions: toBlocked puts the driver code scanning block on its alerts, on merge while a verification holds', () => {
  const blocked = { kind: 'code-scanning', question: 'New alerts.', evidence: 'alert one\nalert two', run: null }
  const claimed = entryWith({ state: 'ready_claimed', pr: 7, claimedSha: SHA })

  toBlocked(claimed, blocked, { at: AT })

  assert.equal(claimed.stage, 'pre-verify')
  assert.deepEqual(claimed.status, { kind: 'needs-you', code: 'code-scanning-alerts', alerts: ['alert one', 'alert two'], since: AT })

  const verified = entryWith({ state: 'verified', pr: 7, claimedSha: SHA, verified: verification() })

  toBlocked(verified, blocked, { at: AT })

  assert.equal(verified.stage, 'merge')
  assert.equal(verified.state, 'blocked')
})

test('transitions: toBlocked keeps a closed PR on its stage, and one still on its brief goes to implement', () => {
  const closed = { kind: 'closed', question: 'PR #7 was closed.', evidence: '', run: null }

  for (const [fields, stage] of [
    [{ state: 'ready_claimed', pr: 7, claimedSha: SHA }, 'pre-verify'],
    [{ state: 'verified', pr: 7, claimedSha: SHA, verified: verification() }, 'merge'],
    [{ state: 'pending', pr: 7 }, 'implement'],
  ]) {
    const entry = entryWith(fields)

    toBlocked(entry, closed, { at: AT })

    assert.deepEqual(
      [entry.stage, entry.status, entry.state],
      [stage, { kind: 'needs-you', code: 'closed', since: AT }, 'blocked'],
      fields.state,
    )
  }
})

test('transitions: toBlocked records the code and the reasons of a gate block', () => {
  const entry = entryWith({ state: 'verified', pr: 7, claimedSha: SHA, verified: verification() })
  const gate = { action: 'block', code: 'draft', reasons: ['PR is a draft'] }

  toBlocked(entry, { kind: 'gate', question: 'PR is a draft', evidence: '', run: null }, { at: AT, gate })

  assert.equal(entry.stage, 'merge')
  assert.deepEqual(entry.status, { kind: 'needs-you', code: 'gate-blocked', gate: 'draft', reasons: ['PR is a draft'], since: AT })
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
    status: { kind: 'needs-you', code: 'attempts-exhausted', role: 'fix', limit: 3, since: AT },
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
    status: { kind: 'needs-you', code: 'attempts-exhausted', role: 'brief', limit: 2, since: AT },
  })
})

test('transitions: escalateDispute escalates an upheld dispute and keeps the findings for a fix', () => {
  const entry = entryWith({ state: 'verifying', pr: 7, claimedSha: SHA, verified: verification() })
  const before = structuredClone(entry)

  escalateDispute(entry, {
    note: 'F1: still open',
    text: 'the verifier still finds F1 open',
    at: AT,
    run: 'P1-03-verify',
    findings: ['F1'],
  })

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
    status: { kind: 'needs-you', code: 'dispute', findings: ['F1'], text: 'the verifier still finds F1 open', since: AT },
  })
})

test('transitions: escalateErrors escalates a PR after repeated errors', () => {
  const entry = entryWith({ state: 'ready_claimed', pr: 7, lastError: 'GitHub answered 502 Bad Gateway for PR #7', tickErrors: 5 })
  const before = structuredClone(entry)

  escalateErrors(entry, { at: AT, run: 'P1-02-implement' })

  assert.deepEqual(entry, {
    ...before,
    state: 'escalated',
    escalation: 'repeated errors',
    escalatedAt: AT,
    escalationRun: 'P1-02-implement',
    status: { kind: 'needs-you', code: 'errors', error: 'GitHub answered 502 Bad Gateway for PR #7', count: 5, since: AT },
  })
})

const QUESTION_STATUS = {
  kind: 'needs-you',
  code: 'decision',
  question: question('needs-decision', 'Keep the old flag?', 'cli.mjs:12', 'P1-01-implement'),
  since: EARLIER,
}

const CLOSE = { at: AT, text: 'PR #7 was closed on GitHub.' }

test('transitions: toClosed keeps a needs-you status whole in closedFrom, and the fix the PR owes', () => {
  const fix = { reason: 'verifier-findings', note: '<findings>', since: OPENED }
  const entry = entryWith({ state: 'needs_fix', pr: 7 })

  entry.status = QUESTION_STATUS
  entry.fix = fix
  entry.state = stateOf(entry)

  toClosed(entry, CLOSE)

  assert.deepEqual(
    [entry.stage, entry.status, entry.fix, entry.state],
    ['implement', { kind: 'needs-you', code: 'closed', since: AT }, fix, 'blocked'],
  )

  assert.deepEqual(entry.closedFrom, QUESTION_STATUS)
  assert.deepEqual(entry.blocked, { kind: 'closed', question: CLOSE.text, evidence: '', run: null })
})

test('transitions: toClosed keeps nothing from a waiting status, and a PR on its brief closes on implement', () => {
  for (const [fields, stage] of [
    [{ state: 'ready_claimed', pr: 7, claimedSha: SHA }, 'pre-verify'],
    [{ state: 'pending', pr: 7 }, 'implement'],
  ]) {
    const entry = entryWith(fields)

    toClosed(entry, CLOSE)

    assert.deepEqual([entry.stage, entry.status.code, entry.closedFrom], [stage, 'closed', null], fields.state)
  }
})

test('transitions: toReopened brings the kept status back unchanged, with its time and its question', () => {
  const entry = entryWith({ state: 'needs_fix', pr: 7 })

  entry.status = QUESTION_STATUS
  entry.state = stateOf(entry)
  toClosed(entry, CLOSE)
  toReopened(entry, LATER)

  assert.deepEqual([entry.stage, entry.status, entry.closedFrom, entry.state], ['implement', QUESTION_STATUS, null, 'blocked'])
  assert.deepEqual(entry.blocked, {
    kind: 'needs-decision',
    question: 'Keep the old flag?',
    evidence: 'cli.mjs:12',
    run: 'P1-01-implement',
  })

  const disputed = entryWith({ state: 'escalated', escalation: DISPUTE, pr: 7, claimedSha: SHA })

  toClosed(disputed, CLOSE)
  toReopened(disputed, LATER)

  assert.deepEqual([disputed.stage, disputed.status.code, disputed.status.since, disputed.blocked], ['verify', 'dispute', OPENED, null])
  assert.equal(disputed.state, 'escalated')
})

test('transitions: toReopened without a kept status waits on the stage, as a retry does', () => {
  const claimed = entryWith({ state: 'ready_claimed', pr: 7, claimedSha: SHA })
  const verified = entryWith({ state: 'verified', pr: 7, claimedSha: SHA, verified: verification() })

  for (const entry of [claimed, verified]) {
    toClosed(entry, CLOSE)
    toReopened(entry, LATER)
  }

  assert.deepEqual([claimed.status, claimed.state, claimed.blocked], [ciAt(SHA, LATER), 'ready_claimed', null])
  assert.deepEqual([verified.stage, verified.status.code, verified.state], ['merge', 'gate-pending', 'verified'])
})

test('transitions: toMerged with a record writes it, and drops what a close kept', () => {
  const entry = entryWith({ state: 'needs_fix', pr: 7 })
  const merged = { by: 'github', at: AT, sha: null, from: 'implement', verified: false }

  entry.status = QUESTION_STATUS
  entry.state = stateOf(entry)
  toClosed(entry, CLOSE)
  toMerged(entry, { merged })

  assert.deepEqual([entry.stage, entry.status, entry.state, entry.merged, entry.closedFrom], ['merged', null, 'merged', merged, null])
})

test('transitions: retryMerge drops the stored verdict and waits for the gate', () => {
  const refused = { action: 'wait', code: 'merge-refused', reasons: ['GitHub refused the merge (ruleset)'], sha: SHA, at: LATER }
  const entry = entryWith({ state: 'verified', pr: 7, claimedSha: SHA, verified: verification(), gate: refused })

  assert.equal(entry.status.code, 'merge-refused')

  retryMerge(entry, AT)

  assert.deepEqual(
    [entry.stage, entry.status, entry.gate, entry.state],
    ['merge', { kind: 'waiting', code: 'gate-pending', since: AT }, null, 'verified'],
  )
})

test('setStatus, gateVerdict, mergeStatus: a status that replaces closed, gate-blocked or code-scanning-alerts settles the state', () => {
  const facts = {
    pr: { headRefOid: SHA },
    depsPending: [],
    checks: { missing: [], pending: ['test'] },
    mainChecks: { sha: OLD_SHA, failing: [] },
  }

  const gateBlock = { kind: 'gate', question: 'PR is a draft', evidence: '', run: null }
  const alerts = { kind: 'code-scanning', question: 'New alerts.', evidence: 'alert', run: null }
  const leave = [
    (entry) => setStatus(entry, entry.stage, { kind: 'waiting', code: 'slot' }, LATER),
    (entry) => gateVerdict(entry, { action: 'wait', code: 'ci-pending', reasons: [] }, facts, LATER),
    (entry) => mergeStatus(entry, LATER),
  ]

  for (const [index, write] of leave.entries()) {
    for (const block of [gateBlock, alerts]) {
      const entry = entryWith({ state: 'verified', pr: 7, claimedSha: SHA, verified: verification() })

      toBlocked(entry, block, { at: AT })
      assert.equal(entry.state, 'blocked')

      write(entry)

      assert.equal(entry.state, stateOf(entry), `${index} ${block.kind}`)
      assert.equal(entry.state, 'verified', `${index} ${block.kind}`)
      assert.equal(entry.blocked, null, `${index} ${block.kind}`)
    }
  }

  const closed = entryWith({ state: 'ready_claimed', pr: 7, claimedSha: SHA })

  toClosed(closed, CLOSE)
  setStatus(closed, 'pre-verify', { kind: 'waiting', code: 'slot' }, LATER)

  assert.deepEqual([closed.state, closed.blocked], ['ready_claimed', null])
})

test('setStatus: the same block written again keeps the state and the block', () => {
  const entry = entryWith({ state: 'ready_claimed', pr: 7, claimedSha: SHA })

  toBlocked(entry, { kind: 'code-scanning', question: 'New alerts.', evidence: 'alert one', run: null }, { at: AT })
  setStatus(entry, 'pre-verify', { kind: 'needs-you', code: 'code-scanning-alerts', alerts: ['alert two'] }, LATER)

  assert.deepEqual(
    [entry.state, entry.blocked.kind, entry.status.since, entry.status.alerts],
    ['blocked', 'code-scanning', AT, ['alert two']],
  )
})

test('transitions: toMerged with no field marks the PR merged and adds no key', () => {
  const entry = entryWith({ state: 'verified', pr: 7, verified: verification() })
  const before = structuredClone(entry)

  toMerged(entry)

  assert.deepEqual(entry, { ...before, state: 'merged', stage: 'merged', status: null })
})

test('transitions: toMerged records the merge commit', () => {
  const entry = entryWith({ state: 'verified', pr: 7, verified: verification() })
  const before = structuredClone(entry)

  toMerged(entry, { mergeSha: SHA })

  assert.deepEqual(entry, { ...before, state: 'merged', mergeSha: SHA, stage: 'merged', status: null })
})

test('transitions: toMerged records the PR number of a merge outside the run', () => {
  const entry = entryWith({ state: 'pending' })
  const before = structuredClone(entry)

  toMerged(entry, { pr: 12 })

  assert.deepEqual(entry, { ...before, state: 'merged', pr: 12, stage: 'merged', status: null })
})

test('transitions: recoverRun sends a briefing back to pending without a refund', () => {
  const entry = entryWith({ state: 'briefing', attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: false, at: AT }), 'brief')
  assert.deepEqual(entry, { ...before, state: 'pending', status: slot() })
})

test('transitions: recoverRun sends a briefing back to pending with its attempt refunded', () => {
  const entry = entryWith({ state: 'briefing', attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true, at: AT }), 'brief')
  assert.deepEqual(entry, { ...before, state: 'pending', attempts: { ...before.attempts, brief: 0 }, refunds: 1, status: slot() })
})

test('transitions: recoverRun interrupts a run state with its role and no refund', () => {
  const entry = entryWith({ state: 'fixing', pr: 7, attempts: { implement: 1, fix: 2, verify: 0, brief: 0 } })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: false, at: AT }), 'fix')
  assert.deepEqual(entry, { ...before, interruptedRole: 'fix', state: 'interrupted', status: slot(), fix: noReport() })
})

test('transitions: recoverRun interrupts a run state with its attempt refunded', () => {
  const entry = entryWith({ state: 'verifying', pr: 7, claimedSha: SHA, attempts: { implement: 1, fix: 0, verify: 1, brief: 0 } })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true, at: AT }), 'verify')
  assert.deepEqual(entry, {
    ...before,
    interruptedRole: 'verify',
    state: 'interrupted',
    attempts: { ...before.attempts, verify: 0 },
    refunds: 1,
    status: slot(),
  })
})

test('transitions: recoverRun keeps a refunded attempt at 0', () => {
  const entry = entryWith({ state: 'implementing' })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true, at: AT }), 'implement')
  assert.deepEqual(entry, { ...before, interruptedRole: 'implement', state: 'interrupted', status: slot(), fix: noReport() })
})

test('transitions: recoverRun leaves a PR in no run state untouched', () => {
  const entry = entryWith({ state: 'needs_fix', pr: 7, attempts: { implement: 1, fix: 1, verify: 0, brief: 0 } })
  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true, at: AT }), null)
  assert.deepEqual(entry, before)
})

test('recoverRun: commands a dead driver ran leave the claim waiting for a slot, with no refund and no role', () => {
  const entry = entryWith({ state: 'ready_claimed', pr: 7, claimedSha: SHA, attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } })

  setStatus(entry, 'pre-verify', { kind: 'running', code: 'commands', sha: SHA }, EARLIER)

  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true, at: AT }), null)
  assert.deepEqual(entry, { ...before, status: slot() })
})

test('recoverRun: a delegate whose run is gone hands its question back and gives its run back, with no role', () => {
  const entry = entryWith({
    state: 'blocked',
    pr: 7,
    blocked: DECISION,
    delegate: { runs: 1, lastQuestion: null, limitNotified: false, answers: [] },
  })

  delegateStarted(entry, { run: 'P1-01-delegate', at: EARLIER })

  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true, at: AT }), null)
  assert.deepEqual(entry, {
    ...before,
    delegate: { ...before.delegate, runs: 0 },
    status: {
      kind: 'needs-you',
      code: 'decision',
      question: question('needs-decision', 'Keep the old flag?', 'cli.mjs:12', 'P1-01-implement'),
      since: AT,
    },
  })
})

test('recoverRun: the driver own merge keeps its status', () => {
  const entry = entryWith({ state: 'verified', pr: 7, claimedSha: SHA, verified: verification() })

  setStatus(entry, 'merge', { kind: 'running', code: 'merge', sha: SHA }, EARLIER)

  const before = structuredClone(entry)

  assert.equal(recoverRun(entry, { refund: true, at: AT }), null)
  assert.deepEqual(entry, before)
})

test('refundAttempt: gives one attempt back and counts it under five refunds, none at five, never below 0', () => {
  const attempts = { implement: 0, fix: 2, verify: 0, brief: 0 }
  const first = entryWith({ attempts: { ...attempts } })
  const fifth = entryWith({ attempts: { ...attempts }, refunds: 4 })
  const spent = entryWith({ attempts: { ...attempts }, refunds: 5 })
  const unused = entryWith({ attempts: { ...attempts }, refunds: 1 })

  refundAttempt(first, 'fix')
  refundAttempt(fifth, 'fix')
  refundAttempt(spent, 'fix')
  refundAttempt(unused, 'verify')

  assert.deepEqual([first.attempts, first.refunds], [{ ...attempts, fix: 1 }, 1])
  assert.deepEqual([fifth.attempts, fifth.refunds], [{ ...attempts, fix: 1 }, 5])
  assert.deepEqual([spent.attempts, spent.refunds], [attempts, 5])
  assert.deepEqual([unused.attempts, unused.refunds], [attempts, 1])
})

test('recoverRun: a cut-off fix run keeps the fix it ran for, with its reason and note, as a stopped one does', () => {
  const fields = {
    state: 'fixing',
    pr: 7,
    sessionId: 'session-1',
    fixReason: 'verifier findings',
    fixNote: 'F1: the flag.',
    attempts: { implement: 1, fix: 1, verify: 1, brief: 0 },
  }

  const cut = entryWith(structuredClone(fields))
  const stopped = entryWith(structuredClone(fields))
  const before = structuredClone(cut)

  assert.equal(recoverRun(cut, { refund: true, at: AT }), 'fix')

  refundAttempt(stopped, 'fix')
  runFailed(stopped, 'fix', AT)

  assert.deepEqual(cut, stopped)
  assert.deepEqual(cut, {
    ...before,
    state: 'needs_fix',
    interruptedRole: null,
    attempts: { ...before.attempts, fix: 0 },
    refunds: 1,
    status: slot(),
  })

  assert.deepEqual(cut.fix, { reason: 'verifier-findings', note: 'F1: the flag.', since: OPENED })
})

test('recoverRun: a refund at start counts against the five of a PR, and none is given at five', () => {
  const attempts = { implement: 1, fix: 0, verify: 0, brief: 1 }
  const fifth = entryWith({ state: 'implementing', attempts: { ...attempts }, refunds: 4 })
  const spent = entryWith({ state: 'implementing', attempts: { ...attempts }, refunds: 5 })
  const briefing = entryWith({ state: 'briefing', attempts: { ...attempts }, refunds: 5 })
  const unrefunded = entryWith({ state: 'implementing', attempts: { ...attempts }, refunds: 4 })

  recoverRun(fifth, { refund: true, at: AT })
  recoverRun(spent, { refund: true, at: AT })
  recoverRun(briefing, { refund: true, at: AT })
  recoverRun(unrefunded, { refund: false, at: AT })

  assert.deepEqual([fifth.attempts, fifth.refunds], [{ ...attempts, implement: 0 }, 5])
  assert.deepEqual([spent.attempts, spent.refunds], [attempts, 5])
  assert.deepEqual([briefing.attempts, briefing.refunds], [attempts, 5])
  assert.deepEqual([unrefunded.attempts, unrefunded.refunds], [attempts, 4])
})

test('recoverRun: at start a cut-off delegate run gives its run back, as a stopped one does', () => {
  const fields = { state: 'blocked', pr: 7, blocked: DECISION, refunds: 2 }
  const delegated = (runs) => {
    const entry = entryWith({ ...fields, delegate: { runs, lastQuestion: null, limitNotified: false, answers: [] } })

    delegateStarted(entry, { run: 'P1-02-delegate', at: EARLIER })

    return entry
  }

  const cut = delegated(2)
  const stopped = delegated(2)
  const kept = delegated(2)
  const none = delegated(0)

  recoverRun(cut, { refund: true, at: AT })
  recoverRun(kept, { refund: false, at: AT })
  recoverRun(none, { refund: true, at: AT })

  stopped.delegate.runs -= 1
  delegateReturned(stopped, { outcome: null, reason: '', at: AT })

  assert.deepEqual(cut, stopped)
  assert.deepEqual([cut.delegate.runs, cut.refunds], [1, 2])
  assert.equal(cut.status.code, 'decision')
  assert.equal(kept.delegate.runs, 2)
  assert.equal(none.delegate.runs, 0)
})

test('resetBudgets: the attempts, the refunds, the failure streak, the errors, the backoff and the delegate runs go back', () => {
  const entry = entryWith({
    state: 'escalated',
    attempts: { implement: 2, fix: 4, verify: 3, brief: 2 },
    refunds: 5,
    failStreak: 3,
    tickErrors: 5,
    retryAfter: LATER,
    delegate: { runs: 2, lastQuestion: 'abc', limitNotified: true, answers: [] },
  })

  const before = structuredClone(entry)

  resetBudgets(entry)

  assert.deepEqual(entry, {
    ...before,
    attempts: { implement: 0, fix: 0, verify: 0, brief: 0 },
    refunds: 0,
    failStreak: 0,
    tickErrors: 0,
    retryAfter: null,
    delegate: { runs: 0, lastQuestion: 'abc', limitNotified: false, answers: [] },
  })
})

test('freshAttempt: a role at its limit gets one attempt back, and a role below it keeps its count', () => {
  const entry = entryWith({ state: 'escalated', attempts: { implement: 2, fix: 1, verify: 0, brief: 0 } })

  freshAttempt(entry, 'implement', 2)
  freshAttempt(entry, 'fix', 4)

  assert.deepEqual(entry.attempts, { implement: 1, fix: 1, verify: 0, brief: 0 })
})

test('wake: a PR waits on its stage with its fix, and on verify with its role', () => {
  const fix = { reason: 'verifier-findings', note: 'F1', since: EARLIER }
  const implement = entryWith({ state: 'escalated', escalation: 'fix attempts exhausted', fixReason: 'verifier findings', fixNote: 'F1' })

  implement.fix = fix
  wake(implement, 'implement', AT)

  assert.deepEqual([implement.state, implement.stage, implement.status, implement.fix], ['needs_fix', 'implement', slot(), fix])

  const verify = entryWith({ state: 'escalated', escalation: 'verify attempts exhausted', pr: 7, claimedSha: SHA })

  wake(verify, 'verify', AT)

  assert.deepEqual([verify.state, verify.stage, verify.status, verify.interruptedRole], ['interrupted', 'verify', slot(), 'verify'])
})

test('wake: a back-off still ahead stays', () => {
  const entry = entryWith({ state: 'escalated', retryAfter: LATER, failStreak: 2 })

  wake(entry, 'brief', AT)

  assert.deepEqual(entry.status, { kind: 'waiting', code: 'backoff', until: LATER, failures: 2, since: AT })
})

test('waitOnStage: each stage waits for what it waits for once nothing stops it', () => {
  const brief = entryWith({ state: 'escalated' })

  waitOnStage(brief, 'brief', AT)
  assert.deepEqual([brief.state, brief.stage, brief.status], ['pending', 'brief', slot()])

  const claimed = entryWith({ state: 'escalated', pr: 7, claimedSha: SHA })

  waitOnStage(claimed, 'pre-verify', AT)
  assert.deepEqual([claimed.state, claimed.stage, claimed.status], ['ready_claimed', 'pre-verify', ciAt(SHA)])

  const parked = entryWith({ state: 'escalated', sessionId: 'session-1', interruptedRole: 'report', ready: { status: 'READY' } })

  waitOnStage(parked, 'pre-verify', AT)
  assert.deepEqual([parked.state, parked.status], ['interrupted', { kind: 'waiting', code: 'github', since: AT }])

  const verified = entryWith({ state: 'escalated', pr: 7, claimedSha: SHA, verified: verification() })

  waitOnStage(verified, 'merge', AT)
  assert.deepEqual(
    [verified.state, verified.stage, verified.status],
    ['verified', 'merge', { kind: 'waiting', code: 'gate-pending', since: EARLIER }],
  )
})

test('waitOnStage: work on implement with no fix owed resumes as a cut-off fix run, and an owed fix stays', () => {
  const session = entryWith({ state: 'escalated', sessionId: 'session-1', interruptedRole: 'verify' })

  waitOnStage(session, 'implement', AT)
  assert.deepEqual([session.state, session.status, session.fix, session.interruptedRole], ['interrupted', slot(), noReport(), 'fix'])

  const owed = entryWith({ state: 'needs_fix', pr: 7, fixReason: 'CI is red', fixNote: 'red' })
  const fix = owed.fix

  waitOnStage(owed, 'implement', AT)
  assert.deepEqual([owed.state, owed.fix], ['needs_fix', fix])

  const fresh = entryWith({ state: 'escalated' })

  waitOnStage(fresh, 'implement', AT)
  assert.deepEqual([fresh.state, fresh.stage, fresh.fix], ['pending', 'implement', null])
})

test('retryFix: the obstacle, its evidence and the note of an owed fix make the fix retry', () => {
  const blocked = { kind: 'environment', question: 'The runner has no Docker.', evidence: 'docker: not found', run: 'P1-02-fix' }
  const entry = entryWith({ state: 'blocked', blocked, pr: 7, fixReason: 'CI is red', fixNote: 'red' })

  entry.fix = { reason: 'ci-red', note: 'red', since: EARLIER }
  retryFix(entry, AT)

  const note = 'The runner has no Docker.\n\nEvidence: docker: not found\n\nred'

  assert.deepEqual([entry.state, entry.stage, entry.status], ['needs_fix', 'implement', slot()])
  assert.deepEqual(entry.fix, { reason: 'retry', note, since: AT })
  assert.deepEqual([entry.fixReason, entry.fixNote], ['retry', note])
  assert.equal(fixReasonCode(entry.fixReason), 'retry')

  const bare = entryWith({ state: 'blocked', blocked: { ...blocked, evidence: '' } })

  retryFix(bare, AT)
  assert.equal(bare.fix.note, 'The runner has no Docker.')
})

test('dropVerification: the verification and the approval go', () => {
  const entry = entryWith({
    state: 'verified',
    pr: 7,
    claimedSha: SHA,
    verified: verification(),
    approved: { ...verification(), channel: 'inbox' },
  })

  dropVerification(entry)

  assert.deepEqual([entry.verified, entry.approved], [null, null])
})

test('approveInbox: the approval, and the merge delay from it', () => {
  const entry = entryWith({ state: 'escalated', tickErrors: 5, pr: 7, claimedSha: SHA, verified: verification() })
  const approval = { sha: SHA, patchId: 'patch-1', at: AT, channel: 'inbox' }

  approveInbox(entry, approval, { until: LATER, at: AT })

  assert.deepEqual(entry.approved, approval)
  assert.deepEqual(
    [entry.state, entry.stage, entry.status],
    ['verified', 'merge', { kind: 'waiting', code: 'merge-delay', until: LATER, since: AT }],
  )
})

test('toMergeStatus: a PR out of a needs-you status follows the stored rule, and its state follows', () => {
  const entry = entryWith({
    state: 'blocked',
    blocked: { kind: 'gate', question: 'draft', evidence: '' },
    pr: 7,
    claimedSha: SHA,
    verified: verification(),
  })

  assert.equal(entry.state, 'blocked')

  toMergeStatus(entry, AT)

  assert.deepEqual(
    [entry.state, entry.stage, entry.status],
    ['verified', 'merge', { kind: 'waiting', code: 'gate-pending', since: EARLIER }],
  )
})

// stateOf reads only the stage, the status, the fix and a parked report's role.
function derived(stage, status, { fix = null, interruptedRole = null } = {}) {
  return stateOf({ stage, status: status && { since: AT, ...status }, fix, interruptedRole })
}

test('stateOf: a merged PR is merged', () => {
  assert.equal(derived('merged', null), 'merged')
})

test('stateOf: a brief run is briefing, the writer and the reviewer alike', () => {
  for (const code of ['brief-write', 'brief-review']) {
    assert.equal(derived('brief', { kind: 'running', code, run: 'P1-01-brief' }), 'briefing', code)
  }
})

test('stateOf: an implement, a fix and a verify run have their run states', () => {
  assert.equal(derived('implement', { kind: 'running', code: 'implement', run: 'P1-01-implement' }), 'implementing')
  assert.equal(derived('implement', { kind: 'running', code: 'fix', reason: 'ci-red', run: 'P1-02-fix' }, { fix: noReport() }), 'fixing')
  assert.equal(derived('verify', { kind: 'running', code: 'verify', sha: SHA, run: 'P1-03-verify' }), 'verifying')
})

test('stateOf: the commands keep the claim', () => {
  assert.equal(derived('pre-verify', { kind: 'running', code: 'commands', sha: SHA }), 'ready_claimed')
})

test('stateOf: the merge keeps the verification', () => {
  assert.equal(derived('merge', { kind: 'running', code: 'merge', sha: SHA }), 'verified')
})

test('stateOf: a delegate at work keeps the PR blocked', () => {
  assert.equal(derived('implement', { kind: 'running', code: 'delegate', question: 'needs-decision', run: 'P1-01-delegate' }), 'blocked')
})

test('stateOf: exhausted attempts, a dispute and repeated errors are escalated', () => {
  assert.equal(derived('implement', { kind: 'needs-you', code: 'attempts-exhausted', role: 'fix', limit: 3 }), 'escalated')
  assert.equal(derived('verify', { kind: 'needs-you', code: 'dispute', findings: ['F1'], text: 'still open' }), 'escalated')
  assert.equal(derived('pre-verify', { kind: 'needs-you', code: 'errors', error: 'boom', count: 5 }), 'escalated')
})

test('stateOf: what the maintainer does on a verified PR keeps it verified', () => {
  const statuses = [
    { code: 'approve' },
    { code: 'review', stale: false },
    { code: 'changes-requested' },
    { code: 'merge-by-hand', mergeState: 'CLEAN' },
    { code: 'github-blocked' },
    { code: 'merge-refused', error: 'refused' },
  ]

  for (const status of statuses) {
    assert.equal(derived('merge', { kind: 'needs-you', ...status }), 'verified', status.code)
  }
})

test('stateOf: every other needs-you code is blocked', () => {
  const asked = question('needs-decision', 'Which?', '', null)
  const cases = [
    ['brief', { code: 'brief-questions', question: asked }],
    ['implement', { code: 'decision', question: asked }],
    ['implement', { code: 'obstacle', question: asked }],
    ['implement', { code: 'closed' }],
    ['pre-verify', { code: 'code-scanning-alerts', alerts: ['alert'] }],
    ['merge', { code: 'gate-blocked', gate: 'draft', reasons: ['PR is a draft'] }],
  ]

  for (const [stage, status] of cases) {
    assert.equal(derived(stage, { kind: 'needs-you', ...status }), 'blocked', status.code)
  }
})

test('stateOf: a PR waiting on its brief is pending', () => {
  assert.equal(derived('brief', { kind: 'waiting', code: 'dependencies', on: ['P0'] }), 'pending')
})

test('stateOf: on implement a cut-off run is interrupted, an owed fix is needs_fix, and no fix is pending', () => {
  const waiting = { kind: 'waiting', code: 'slot' }

  assert.equal(derived('implement', waiting, { fix: noReport() }), 'interrupted')
  assert.equal(derived('implement', waiting, { fix: { reason: 'ci-red', note: '', since: AT } }), 'needs_fix')
  assert.equal(derived('implement', waiting), 'pending')
})

test('stateOf: on pre-verify a parked READY report is interrupted, under a hold too, and a claim is ready_claimed', () => {
  assert.equal(derived('pre-verify', { kind: 'waiting', code: 'github' }, { interruptedRole: 'report' }), 'interrupted')
  assert.equal(derived('pre-verify', { kind: 'waiting', code: 'held', scope: 'pr' }, { interruptedRole: 'report' }), 'interrupted')
  assert.equal(derived('pre-verify', { kind: 'waiting', code: 'ci', sha: SHA, missing: [], pending: [] }), 'ready_claimed')
})

test('stateOf: a verify run waiting to run again is interrupted', () => {
  assert.equal(derived('verify', { kind: 'waiting', code: 'slot' }), 'interrupted')
})

test('stateOf: a PR waiting on merge is verified', () => {
  assert.equal(derived('merge', { kind: 'waiting', code: 'gate-pending' }), 'verified')
})

test('fixReasonCode: today texts map to their codes, the gate by its verdict, and any other text to the verifier findings', () => {
  assert.equal(fixReasonCode('CI did not settle'), 'ci-stalled')
  assert.equal(fixReasonCode('pre-verify check'), 'commands')
  assert.equal(fixReasonCode('request from the delegate'), 'delegate-answer')
  assert.equal(fixReasonCode('merge gate', 'policy-violations'), 'policy')
  assert.equal(fixReasonCode('merge gate', 'ci-red'), 'ci-red')
  assert.equal(fixReasonCode('previous run ended without a report'), 'verifier-findings')
  assert.equal(fixReasonCode('constructor'), 'verifier-findings')
  assert.equal(fixReasonCode(undefined), 'verifier-findings')
})

test('holdPr: the hold goes into hold and held, and a waiting status shows it from the time of the hold', () => {
  const entry = entryWith({ state: 'ready_claimed', pr: 7, claimedSha: SHA })
  const hold = { at: AT, by: 'maintainer', reason: null }
  const before = structuredClone(entry)

  holdPr(entry, hold)

  assert.deepEqual(entry, { ...before, hold, held: hold, status: { kind: 'waiting', code: 'held', scope: 'pr', since: AT } })
})

test('holdPr: a running or needs-you status stays as it is', () => {
  const hold = { at: AT, by: 'maintainer', reason: null }

  for (const fields of [{ state: 'implementing' }, { state: 'blocked' }, { state: 'escalated', escalation: DISPUTE }]) {
    const entry = entryWith(fields)
    const before = structuredClone(entry)

    holdPr(entry, hold)

    assert.deepEqual(entry, { ...before, hold, held: hold }, fields.state)
  }
})

test('releasePr: both holds go, and the status waits for the next step', () => {
  const hold = { at: AT, by: 'maintainer', reason: null }
  const entry = entryWith({ state: 'needs_fix', pr: 7, held: hold })
  const before = structuredClone(entry)

  releasePr(entry)

  assert.deepEqual(entry, { ...before, hold: null, held: null })
  assert.equal(entry.status.code, 'held')
})

test('unheld: a held status no hold covers goes back to slot, a parked report to github, and a verified PR to the stored rule', () => {
  const held = { at: EARLIER, by: 'maintainer', reason: null }
  const cases = [
    [
      { state: 'needs_fix', pr: 7 },
      { kind: 'waiting', code: 'slot', since: AT },
    ],
    [
      { state: 'interrupted', interruptedRole: 'report', ready: { status: 'READY' } },
      { kind: 'waiting', code: 'github', since: AT },
    ],
    [
      { state: 'verified', pr: 7, claimedSha: SHA, verified: verification() },
      { kind: 'waiting', code: 'gate-pending', since: EARLIER },
    ],
  ]

  for (const [fields, status] of cases) {
    const entry = entryWith({ ...fields, held })

    assert.equal(entry.status.code, 'held', fields.state)
    releasePr(entry)
    unheld(entry, AT)

    assert.deepEqual(entry.status, status, fields.state)
    assert.equal(entry.state, fields.state)
  }
})

test('unheld: leaves a status that is not held alone', () => {
  const entry = entryWith({ state: 'ready_claimed', pr: 7, claimedSha: SHA })
  const before = structuredClone(entry)

  unheld(entry, AT)

  assert.deepEqual(entry, before)
})

test('setStatus: a write that keeps the stage, the kind and the code keeps the time and updates the data', () => {
  const entry = entryWith({ state: 'ready_claimed', pr: 7, claimedSha: SHA })

  setStatus(entry, 'pre-verify', { kind: 'waiting', code: 'ci', sha: SHA, missing: ['test'], pending: [] }, AT)

  assert.deepEqual(entry.status, { kind: 'waiting', code: 'ci', sha: SHA, missing: ['test'], pending: [], since: OPENED })

  setStatus(entry, 'pre-verify', { kind: 'waiting', code: 'slot' }, AT)

  assert.deepEqual(entry.status, slot())
  assert.equal(entry.state, 'ready_claimed')
})

test('delegateStarted: the delegate runs on the stage of the question, which stays blocked, and the fix owed stays', () => {
  const fix = { reason: 'verifier-findings', note: 'F1', since: EARLIER }
  const implement = entryWith({ state: 'blocked', pr: 7, blocked: DECISION })
  const brief = entryWith({ state: 'blocked', blocked: { kind: 'brief-questions', question: 'Which API?', evidence: '', run: null } })

  implement.fix = fix
  delegateStarted(implement, { run: 'P1-01-delegate', at: AT })
  delegateStarted(brief, { run: 'P1-02-delegate', at: AT })

  assert.deepEqual(
    [implement.stage, implement.status, implement.fix, implement.state, implement.blocked],
    [
      'implement',
      { kind: 'running', code: 'delegate', question: 'needs-decision', run: 'P1-01-delegate', since: AT },
      fix,
      'blocked',
      DECISION,
    ],
  )

  assert.deepEqual(
    [brief.stage, brief.status, brief.state],
    ['brief', { kind: 'running', code: 'delegate', question: 'brief-questions', run: 'P1-02-delegate', since: AT }, 'blocked'],
  )
})

test('delegateStarted: a block of an unknown kind runs as unknown', () => {
  const entry = entryWith({ state: 'blocked', pr: 7, blocked: { ...DECISION, kind: 'gate' } })

  delegateStarted(entry, { run: 'P1-01-delegate', at: AT })

  assert.deepEqual([entry.stage, entry.status.question], ['implement', 'unknown'])
})

test('delegateReturned: the question waits for you again with what the delegate did, the fix owed kept', () => {
  const fix = { reason: 'ci-red', note: 'test fails', since: EARLIER }
  const cases = [
    { blocked: DECISION, outcome: 'escalated', reason: 'The plan is silent.', code: 'decision' },
    { blocked: { ...DECISION, kind: 'stuck' }, outcome: 'failed', reason: 'killed by SIGKILL', code: 'obstacle' },
    { blocked: { ...DECISION, kind: 'brief-questions' }, outcome: null, reason: '', code: 'brief-questions' },
  ]

  for (const { blocked, outcome, reason, code } of cases) {
    const entry = entryWith({ state: 'blocked', pr: 7, blocked })
    const stage = code === 'brief-questions' ? 'brief' : 'implement'

    entry.fix = stage === 'implement' ? fix : null
    delegateStarted(entry, { run: 'P1-01-delegate', at: EARLIER })
    delegateReturned(entry, { outcome, reason, at: AT })

    const asked = question(blocked.kind, blocked.question, blocked.evidence, blocked.run)

    assert.deepEqual(
      [entry.stage, entry.status, entry.state],
      [stage, { kind: 'needs-you', code, question: { ...asked, delegate: outcome ? { outcome, reason } : null }, since: AT }, 'blocked'],
      code,
    )

    assert.equal(entry.fix, stage === 'implement' ? fix : null, code)
  }
})

test('delegateReturned: an entry with no block takes the kind its status names, with an empty question', () => {
  const entry = entryWith({ state: 'blocked', pr: 7, blocked: { ...DECISION, kind: 'environment' } })

  delegateStarted(entry, { run: 'P1-01-delegate', at: EARLIER })
  entry.blocked = null
  delegateReturned(entry, { outcome: 'escalated', reason: '', at: AT })

  assert.deepEqual(entry.status, {
    kind: 'needs-you',
    code: 'obstacle',
    question: { kind: 'environment', text: '', evidence: '', run: null, delegate: { outcome: 'escalated', reason: '' } },
    since: AT,
  })

  const bare = entryWith({ state: 'pending' })

  bare.blocked = undefined
  delegateReturned(bare, { outcome: null, reason: '', at: AT })

  assert.deepEqual([bare.stage, bare.status.code, bare.status.question.kind], ['brief', 'brief-questions', 'unknown'])
})

test('commandsPassed: the pass is written to the entry and the PR waits on verify for a slot, as a cut-off verifier does', () => {
  const entry = entryWith({ state: 'ready_claimed', pr: 7, claimedSha: SHA })

  setStatus(entry, 'pre-verify', { kind: 'running', code: 'commands', sha: SHA }, EARLIER)
  commandsPassed(entry, { sha: SHA, key: '{"ready":[[],[]]}', at: AT })

  assert.deepEqual(entry.commands, { sha: SHA, at: AT, key: '{"ready":[[],[]]}' })
  assert.deepEqual([entry.stage, entry.status, entry.state, entry.interruptedRole], ['verify', slot(), 'interrupted', 'verify'])
})
