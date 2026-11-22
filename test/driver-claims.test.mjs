import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDriver } from '../lib/driver.mjs'
import { DRIVER_MARKER, setFetch } from '../lib/github.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { verifyPrompt } from '../lib/prompts.mjs'
import { runStarted, verifyAgain } from '../lib/transitions.ts'
import { readEvents } from '../lib/view.mjs'
import { worktreePath } from '../lib/worktree.mjs'
import { at, fakeGitHub, fakeTools, makeRollout, samplePrs, waitFor, zipArchive } from './fixtures.mjs'
import {
  agentResult,
  apply,
  SHA,
  FETCH,
  MAINTAINER_TOKEN,
  MERGE_SHA,
  MERGED_PR,
  prRoute,
  restPr,
  runsRoute,
  stoppableAgent,
  tickDriver,
  eventsSince,
  kindsSince,
  GREEN_EVIDENCE,
  gateCheckEvent,
  NEW_HEAD,
  REBASED,
  CLAIMED,
  verifiableDriver,
  gatesWith,
  FIRST_ROUND,
  UNANSWERED,
  modelDriver,
  COMMANDS_GATE,
  commandSeam,
  preVerified,
} from './driver-helpers.mjs'

const IMPLEMENTING = { state: 'implementing', sessionId: 'session-1', attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } }

const READY = agentResult({ output: { status: 'READY', pr: 12, headSha: NEW_HEAD, summary: 'Done.' } })

const PR_12 = 'repos/example/widgets/pulls/12'
const NOT_FOUND = { status: 404, body: { message: 'Not Found' } }
const REPOSITORY = { path: 'repos/example/widgets', body: { full_name: 'example/widgets' } }

test('onDone: a READY report GitHub could not read waits, and a later tick claims it with no agent', async () => {
  const { manifest, driver, github } = tickDriver({ A1: IMPLEMENTING }, { rules: [FETCH], routes: [{ path: PR_12, status: 502 }] })

  const pr = manifest.prs.find((item) => item.id === 'A1')
  const entry = driver.ledger.prs.A1

  await driver.onDone(pr, 'implement', READY, { run: 'A1-01-implement' })

  const events = eventsSince(manifest)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'github'])
  assert.equal(entry.reportUnchecked, true)
  assert.match(entry.lastError, /HTTP 502/)
  assert.deepEqual(
    events.map((event) => event.kind),
    ['implement-done', 'report-unchecked'],
  )

  assert.match(events[1].error, /HTTP 502/)
  assert.equal(entry.attempts.fix, 0)

  github.answer([prRoute({ number: 12, head: { sha: NEW_HEAD } })])
  await driver.tick()

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.deepEqual([entry.reportUnchecked, entry.implementCutOff], [false, false])
  assert.equal(entry.pr, 12)
  assert.equal(entry.claimedSha, NEW_HEAD)
  assert.equal(entry.attempts.fix, 0)
  assert.equal(driver.running.size, 0)
  assert.deepEqual(kindsSince(manifest, events.length), ['ready-claimed'])
})

test('onDone: a READY report whose PR answers 404 while the repository reads names an unknown PR and goes to a fix run', async () => {
  const { manifest, driver, github } = tickDriver({ A1: IMPLEMENTING }, { routes: [{ path: PR_12, ...NOT_FOUND }, REPOSITORY] })
  const entry = driver.ledger.prs.A1

  await driver.onDone(
    manifest.prs.find((item) => item.id === 'A1'),
    'implement',
    READY,
    { run: 'A1-01-implement' },
  )

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fixReason, 'report does not match GitHub')
  assert.match(entry.fixNote, /^PR #12 could not be read \(GitHubError: GET repos\/example\/widgets\/pulls\/12: HTTP 404: Not Found\)/)
  assert.deepEqual(eventsSince(manifest).at(-1), { id: 'A1', kind: 'needs-fix', reason: 'report does not match GitHub' })
  assert.deepEqual(kindsSince(manifest), ['implement-done', 'needs-fix'])
  assert.deepEqual(
    github.requests().map((request) => [request.path, request.status]),
    [
      [PR_12, 404],
      ['repos/example/widgets', 200],
    ],
  )
})

test('onDone: a READY report whose PR and repository both answer 404 waits, and counts as an error of the PR on the next tick', async () => {
  const { manifest, driver } = tickDriver(
    { A1: IMPLEMENTING },
    {
      rules: [FETCH],
      routes: [
        { path: PR_12, ...NOT_FOUND },
        { ...REPOSITORY, ...NOT_FOUND },
      ],
    },
  )

  const pr = manifest.prs.find((item) => item.id === 'A1')
  const entry = driver.ledger.prs.A1

  await driver.onDone(pr, 'implement', READY, { run: 'A1-01-implement' })

  const events = eventsSince(manifest)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'github'])
  assert.equal(entry.reportUnchecked, true)
  assert.equal(entry.attempts.fix, 0)
  assert.deepEqual(
    events.map((event) => event.kind),
    ['implement-done', 'report-unchecked'],
  )

  assert.match(events[1].error, /HTTP 404: Not Found/)

  await driver.tick()

  const later = eventsSince(manifest, events.length)

  assert.deepEqual(
    later.map((event) => [event.id, event.kind, event.count]),
    [['A1', 'error', 1]],
  )

  assert.match(later[0].error, /HTTP 404: Not Found/)
  assert.equal(entry.tickErrors, 1)
  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'github'])
  assert.equal(entry.reportUnchecked, true)
  assert.equal(entry.attempts.fix, 0)
})

test('advance: a parked READY report GitHub now contradicts goes to a fix run and is never claimed again', async () => {
  const parked = { ...IMPLEMENTING, state: 'interrupted', interruptedRole: 'report', ready: READY.output }
  const { manifest, driver } = tickDriver(
    { A1: parked },
    { rules: [FETCH], routes: [prRoute({ number: 12, head: { sha: NEW_HEAD }, state: 'closed' })] },
  )

  const entry = driver.ledger.prs.A1

  await driver.tick()

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fixReason, 'report does not match GitHub')
  assert.deepEqual([entry.reportUnchecked, entry.implementCutOff], [false, false])
  assert.deepEqual(kindsSince(manifest), ['needs-fix'])
})

const GATE_BLOCK = { kind: 'gate', question: 'PR is a draft', evidence: '' }

// A gate block needs no retry: the gate reads it again on every tick, and the retry only resets the budgets.
test('retry: a PR whose verification still holds stays verified, keeps its hold, and the gate looks again with no agent', async () => {
  for (const [state, [stage, status, code]] of [
    [{ state: 'escalated', tickErrors: 5 }, ['merge', 'waiting', 'held']],
    [{ state: 'blocked', blocked: GATE_BLOCK }, ['merge', 'needs-you', 'gate-blocked']],
  ]) {
    const { manifest, driver, gate } = tickDriver({ A1: { ...samplePrs().A1, ...state } }, { rules: [FETCH], routes: [prRoute()] })
    const entry = driver.ledger.prs.A1

    assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [{ id: 'A1', kind: 'retry', stage, status, code }], state.state)
    assert.deepEqual(entry.verified, samplePrs().A1.verified, state.state)
    assert.deepEqual([entry.reportUnchecked, entry.implementCutOff], [false, false], state.state)
    assert.ok(entry.hold, state.state)

    await driver.tick()

    assert.equal(gate.calls, 1, state.state)
    assert.equal(driver.running.size, 0, state.state)
    assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'held'], state.state)
    assert.deepEqual(entry.attempts, { implement: 0, fix: 0, verify: 0, brief: 0 }, state.state)
  }
})

test('retry: a verification for an older head stays on merge, and the next sync checks the head', async () => {
  const stale = { ...samplePrs().A1, state: 'escalated', verified: { ...samplePrs().A1.verified, sha: NEW_HEAD }, ciPendingSince: at(85) }
  const { manifest, driver, gate } = tickDriver({ A1: stale }, { rules: [FETCH], routes: [prRoute()] })
  const entry = driver.ledger.prs.A1

  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [
    { id: 'A1', kind: 'retry', stage: 'merge', status: 'waiting', code: 'held' },
  ])

  assert.equal(entry.stage, 'merge')
  assert.equal(entry.verified.sha, NEW_HEAD)

  // GitHub's head carries another patch than the one verified.
  gate.facts = { patchId: 'patch-other' }

  const before = readEvents(manifest).length
  await driver.tick()

  assert.ok(kindsSince(manifest, before).includes('head-moved-reverify'), kindsSince(manifest, before).join(', '))
  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'held'])
  assert.equal(entry.verified, null)
  assert.equal(entry.ciPendingSince, null)
  assert.equal(entry.claimedSha, SHA)
})

test('note: an answer to a gate block on a verified PR drops the verification', () => {
  const { manifest, driver } = tickDriver(
    { A1: { ...samplePrs().A1, state: 'blocked', blocked: GATE_BLOCK } },
    { rules: [FETCH], routes: [prRoute()] },
  )

  const entry = driver.ledger.prs.A1

  assert.deepEqual(apply(manifest, driver, { cmd: 'note', id: 'A1', text: 'Mark it ready for review.' }), [
    { id: 'A1', kind: 'needs-fix', reason: 'answer from the maintainer' },
  ])

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'held'])
  assert.equal(entry.fixNote, 'Mark it ready for review.')
  assert.equal(entry.verified, null)
})

test('retry: a parked READY report stays parked, and the next tick claims it with no agent', async () => {
  const parked = { ...IMPLEMENTING, state: 'escalated', interruptedRole: 'report', ready: READY.output }
  const { manifest, driver } = tickDriver({ A1: parked }, { rules: [FETCH], routes: [prRoute({ number: 12, head: { sha: NEW_HEAD } })] })
  const entry = driver.ledger.prs.A1

  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [
    { id: 'A1', kind: 'retry', stage: 'pre-verify', status: 'waiting', code: 'github' },
  ])

  assert.equal(entry.reportUnchecked, true)

  const before = readEvents(manifest).length
  await driver.tick()

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.deepEqual([entry.reportUnchecked, entry.implementCutOff], [false, false])
  assert.equal(entry.pr, 12)
  assert.equal(entry.claimedSha, NEW_HEAD)
  assert.equal(entry.attempts.fix, 0)
  assert.equal(driver.running.size, 0)
  assert.deepEqual(kindsSince(manifest, before), ['ready-claimed'])
})

function placeOf(entry) {
  return [entry.stage, entry.status?.kind ?? null, entry.status?.code ?? null]
}

const MERGE_TICK = { action: 'merge', code: 'merge', reasons: [], mergeState: 'CLEAN', sha: SHA, at: at(85) }

test('the PR: merged, and the driver asked for the merge', async () => {
  const { manifest, driver, cleaned, notices } = tickDriver(
    { A1: { ...samplePrs().A1, held: null, gate: MERGE_TICK } },
    { rules: [FETCH], routes: [prRoute(MERGED_PR)] },
  )

  const entry = driver.ledger.prs.A1

  await driver.tick()

  assert.deepEqual([entry.stage, entry.status], ['merged', null])
  assert.deepEqual(entry.merged, { by: 'driver', at: at(90), sha: MERGE_SHA, from: 'merge', verified: true })
  assert.deepEqual(driver.ledger.data.lastMerge, { id: 'A1', sha: MERGE_SHA, at: driver.ledger.data.lastMerge.at })
  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.kind.startsWith('merged')),
    [{ id: 'A1', kind: 'merged', pr: 11 }],
  )

  assert.deepEqual(cleaned, ['A1'])
  assert.deepEqual(notices, ['A1: merged PR #11'])
})

test('the PR: merged outside the driver', async () => {
  for (const [head, verified] of [
    [SHA, true],
    [NEW_HEAD, false],
  ]) {
    const { manifest, driver, cleaned, notices } = tickDriver(samplePrs(), {
      rules: [FETCH],
      routes: [prRoute({ ...MERGED_PR, head: { sha: head } })],
    })

    const entry = driver.ledger.prs.A1

    await driver.tick()

    // A head the driver has not seen counts as not verified, even with the verified patch.
    assert.deepEqual(entry.merged, { by: 'github', at: at(90), sha: MERGE_SHA, from: 'merge', verified }, head)
    assert.deepEqual(
      eventsSince(manifest).filter((event) => event.kind.startsWith('merged')),
      [{ id: 'A1', kind: 'merged-outside-driver', pr: 11, from: 'merge', verified, stopped: null }],
      head,
    )

    assert.deepEqual(placeOf(entry), ['merged', null, null], head)
    assert.equal(entry.mergeSha, MERGE_SHA, head)
    assert.deepEqual(cleaned, ['A1'], head)
    assert.deepEqual(notices, [], head)
  }
})

test('the PR: merged while an agent runs', async () => {
  const agent = stoppableAgent()
  const { manifest, driver, cleaned } = tickDriver(
    { A1: { state: 'pending', pr: 11 }, A2: { state: 'merged', pr: 12 }, A3: { state: 'merged', pr: 13 } },
    { policy: { concurrency: 1 }, rules: [{ tool: 'git', args: '', stdout: '' }], routes: [prRoute(MERGED_PR)], runAgent: agent.runAgent },
  )

  const pr = manifest.prs.find((item) => item.id === 'A1')
  const entry = driver.ledger.prs.A1

  mkdirSync(join(worktreePath(manifest, pr), '.git'), { recursive: true })
  writeFileSync(join(worktreePath(manifest, pr), '.git', 'rollout-ready'), '')
  mkdirSync(dirname(pr.brief), { recursive: true })
  writeFileSync(pr.brief, '# A1\n')

  driver.launch(pr, 'implement')
  await waitFor(() => agent.signals.length === 1, 'the implement run')

  const budgets = { attempts: { ...entry.attempts }, refunds: entry.refunds, retryAfter: entry.retryAfter, failStreak: entry.failStreak }

  await driver.tick()

  assert.equal(agent.signals[0].aborted, true)

  await waitFor(() => !driver.running.has('A1'), 'the stopped run to end')

  assert.deepEqual(placeOf(entry), ['merged', null, null])
  assert.deepEqual(entry.merged, { by: 'github', at: at(90), sha: MERGE_SHA, from: 'implement', verified: false })
  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.kind === 'merged-outside-driver'),
    [{ id: 'A1', kind: 'merged-outside-driver', pr: 11, from: 'implement', verified: false, stopped: 'implement' }],
  )

  assert.deepEqual(cleaned, ['A1'])
  assert.deepEqual(
    { attempts: entry.attempts, refunds: entry.refunds, retryAfter: entry.retryAfter, failStreak: entry.failStreak },
    budgets,
  )
})

test('the PR: closed without a merge', async () => {
  const { manifest, driver, github, notices } = tickDriver(samplePrs(), { rules: [FETCH], routes: [prRoute({ state: 'closed' })] })
  const entry = driver.ledger.prs.A1

  await driver.tick()
  await driver.tick()

  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'closed'])

  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.kind === 'blocked'),
    [{ id: 'A1', kind: 'blocked', reason: 'closed' }],
  )

  assert.deepEqual(notices, ['A1: PR #11 was closed'])

  github.answer([prRoute()])
  await driver.tick()

  // A1 is held, so the gate's verdict on merge is held.
  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'held'])
  assert.deepEqual(entry.verified, samplePrs().A1.verified)
})

test('the PR: head moved after the verification, same patch', async () => {
  const { manifest, driver, gate } = tickDriver(samplePrs(), { rules: [FETCH], routes: [prRoute({ head: { sha: NEW_HEAD } })] })
  const entry = driver.ledger.prs.A1

  gate.pr = { headRefOid: NEW_HEAD }
  await driver.tick()

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'held'])
  assert.deepEqual(entry.verified, { ...samplePrs().A1.verified, sha: NEW_HEAD })
  assert.deepEqual(entry.approved, { ...samplePrs().A1.approved, sha: NEW_HEAD })
  assert.equal(entry.claimedSha, NEW_HEAD)
  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.kind.startsWith('head-moved')),
    [{ id: 'A1', kind: 'head-moved-same-patch', sha: NEW_HEAD.slice(0, 7) }],
  )
})

test('the PR: head moved after the verification, another patch', async () => {
  const pending = { check_runs: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }
  const { manifest, driver, gate } = tickDriver(
    { A1: { ...samplePrs().A1, held: null } },
    { rules: [FETCH], routes: [prRoute({ head: { sha: NEW_HEAD } }), runsRoute(NEW_HEAD, pending)] },
  )

  const entry = driver.ledger.prs.A1

  // Sync claims the new head, so the gate no longer judges the PR in this tick.
  // Its one read of the facts is sync's, which compares the patches.
  gate.pr = { headRefOid: NEW_HEAD }
  gate.facts = { patchId: 'patch-other' }
  await driver.tick()

  assert.equal(gate.calls, 1)
  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.deepEqual(entry.status.pending, ['test'])
  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.equal(entry.verified, null)
  assert.equal(entry.approved, null)
  assert.equal(entry.claimedSha, NEW_HEAD)
  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.kind === 'head-moved-reverify'),
    [{ id: 'A1', kind: 'head-moved-reverify', sha: NEW_HEAD.slice(0, 7), reason: 'new-patch' }],
  )
})

test('the PR: head moved before the verification', async () => {
  const pending = { check_runs: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }
  const { manifest, driver, github, pr, entry } = claimDriver({})

  entry.claimedAt = at(1)
  github.answer([prRoute({ head: { sha: NEW_HEAD } }), runsRoute(NEW_HEAD, pending)])
  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.equal(entry.status.sha, NEW_HEAD)
  assert.equal(entry.claimedSha, NEW_HEAD)
  assert.notEqual(entry.claimedAt, at(1))
  assert.deepEqual(eventsSince(manifest), [{ id: 'A1', kind: 'claim-moved', claimed: SHA.slice(0, 7), head: NEW_HEAD.slice(0, 7) }])
})

test('the PR: a dependency outside this run merged', async () => {
  const pulls = 'repos/example/widgets/pulls'
  const mergedA1 = restPr({ ...MERGED_PR, labels: [{ name: 'rollout:demo' }] })
  const { manifest, driver } = tickDriver(
    { A1: { state: 'pending' }, A2: { state: 'pending' } },
    { only: ['A2'], rules: [FETCH], routes: [{ path: pulls, query: { head: 'example:feat/a1' }, body: [mergedA1] }] },
  )

  await driver.tick()

  assert.deepEqual([driver.ledger.prs.A1.stage, driver.ledger.prs.A1.pr], ['merged', 11])
  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.kind === 'merged-outside-run'),
    [{ id: 'A1', kind: 'merged-outside-run', pr: 11 }],
  )
})

const DECISION_STATUS = {
  kind: 'needs-you',
  code: 'decision',
  question: {
    kind: 'needs-decision',
    text: 'Keep the old flag?',
    evidence: 'cli.mjs:12 still reads it.',
    run: 'A1-01-implement',
    delegate: null,
  },
  since: at(40),
}

const DISPUTE_STATUS = {
  kind: 'needs-you',
  code: 'dispute',
  findings: ['F2'],
  text: 'the verifier still finds F2 open, which the implementer disputed',
  since: at(50),
}

// A1 on `stage` with `status`, as a driver of this version writes it, and its PR closed on GitHub.
function closedLater(stage, status, fields = {}) {
  const entry = { pr: 11, claimedSha: SHA, sessionId: 'session-1', hold: null, fix: null, ...fields, stage, status }

  return tickDriver({ A1: entry }, { rules: [FETCH], routes: [prRoute({ state: 'closed' })] })
}

test('a PR closed on a question or a dispute and open again gets it back, with its time, and no command', async () => {
  const cases = [
    ['implement', DECISION_STATUS, {}],
    ['verify', DISPUTE_STATUS, { lastError: DISPUTE_STATUS.text, fixReason: 'verifier findings', fixNote: '<findings>' }],
  ]

  for (const [stage, status, fields] of cases) {
    const { manifest, driver, github } = closedLater(stage, status, fields)
    const entry = driver.ledger.prs.A1

    await driver.tick()

    assert.deepEqual(placeOf(entry), [stage, 'needs-you', 'closed'], status.code)
    assert.deepEqual(entry.closedFrom, status, status.code)

    github.answer([prRoute()])
    await driver.tick()

    assert.deepEqual(entry.status, status, status.code)
    assert.equal(entry.stage, stage, status.code)
    assert.equal(entry.closedFrom, null, status.code)
    assert.ok(!kindsSince(manifest).some((kind) => ['retry', 'note-queued', 'needs-fix'].includes(kind)), status.code)
  }

  const decision = closedLater('implement', DECISION_STATUS)

  await decision.driver.tick()
  decision.github.answer([prRoute()])
  await decision.driver.tick()

  assert.deepEqual(decision.driver.ledger.prs.A1.status.question, DECISION_STATUS.question)
})

// The fake GitHub is the last driver's, so each driver runs to its end before the next one starts.
async function noteWhileClosed(setup, note) {
  await setup.driver.tick()

  const { stage } = setup.driver.ledger.prs.A1

  assert.deepEqual(apply(setup.manifest, setup.driver, { cmd: 'note', id: 'A1', text: note }), [
    { id: 'A1', kind: 'note-queued', stage, status: 'needs-you', code: 'closed' },
  ])

  setup.github.answer([prRoute()])
  await setup.driver.tick()

  return setup.driver.ledger.prs.A1
}

test('a note sent while the PR was closed answers the status the reopen brings back', async () => {
  const note = 'Keep the flag, and say so in the README.'
  const answered = await noteWhileClosed(closedLater('implement', DECISION_STATUS), note)

  assert.deepEqual(placeOf(answered), ['implement', 'waiting', 'slot'])
  assert.deepEqual([answered.fix.reason, answered.fixReason, answered.fixNote], ['maintainer-note', 'answer from the maintainer', note])
  assert.equal(answered.pendingNote, null)
  assert.deepEqual(
    answered.noteHistory.map((record) => [record.kind, record.question, record.text]),
    [['needs-decision', 'Keep the old flag?', note]],
  )

  const disputed = closedLater('verify', DISPUTE_STATUS, {
    escalation: 'disputed finding',
    fixReason: 'verifier findings',
    fixNote: '<findings>',
  })

  const ruled = await noteWhileClosed(disputed, note)

  assert.deepEqual(placeOf(ruled), ['implement', 'waiting', 'slot'])
  assert.deepEqual([ruled.fix.reason, ruled.fix.note, ruled.pendingNote], ['verifier-findings', '<findings>', note])
  assert.deepEqual(
    ruled.noteHistory.map((record) => [record.kind, record.question, record.text]),
    [['disputed finding', DISPUTE_STATUS.text, note]],
  )
})

test('a PR closed from a waiting status is open again on the waiting status of its stage', async () => {
  const waiting = { kind: 'waiting', code: 'ci', sha: SHA, missing: [], pending: ['test'], since: at(30) }
  const { driver, github } = closedLater('pre-verify', waiting)
  const entry = driver.ledger.prs.A1

  await driver.tick()

  assert.deepEqual(placeOf(entry), ['pre-verify', 'needs-you', 'closed'])
  assert.equal(entry.closedFrom, null)

  github.answer([prRoute(), runsRoute(SHA, { check_runs: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] })])
  await driver.tick()

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
})

test('checkClaim: a claimed PR merged or closed since sync is left to the next sync', async () => {
  const claimed = { state: 'ready_claimed', pr: 11, claimedSha: SHA, attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } }

  const states = [
    ['MERGED', MERGED_PR],
    ['CLOSED', { state: 'closed' }],
  ]

  for (const [state, fields] of states) {
    const { manifest, driver, github, gate } = tickDriver({ A1: claimed }, { routes: [prRoute(fields)] })

    await driver.advance(manifest.prs.find((item) => item.id === 'A1'))

    assert.deepEqual(placeOf(driver.ledger.prs.A1), ['pre-verify', 'waiting', 'ci'], state)
    assert.deepEqual(kindsSince(manifest), [], state)
    assert.ok(!github.requests().some((request) => request.path.endsWith('/check-runs')), state)
    assert.equal(gate.calls, 0, state)
  }

  const { manifest, driver, github, gate } = tickDriver({ A1: claimed }, { routes: [prRoute(), runsRoute(SHA)] })

  gate.pr = { state: 'MERGED' }

  await driver.advance(manifest.prs.find((item) => item.id === 'A1'))

  assert.ok(github.requests().some((request) => request.path.endsWith('/check-runs')))
  assert.equal(gate.calls, 1)
  assert.deepEqual(placeOf(driver.ledger.prs.A1), ['pre-verify', 'waiting', 'ci'])
  assert.equal(driver.ledger.prs.A1.claimPatchId, undefined)
  assert.deepEqual(eventsSince(manifest), [gateCheckEvent('ci', 'pass', GREEN_EVIDENCE)])
})

test('checkClaim: a note queued while a verifier ran goes to a fix run first, with no agent, no GitHub request and no gh or git call', async () => {
  const note = 'Drop the old flag.'
  const queued = {
    pr: 11,
    claimedSha: SHA,
    sessionId: 'session-1',
    pendingNote: note,
    noteHistory: [{ at: at(10), by: 'maintainer', kind: null, question: null, text: note }],
    attempts: { implement: 1, fix: 0, verify: 1, brief: 0 },
  }

  for (const state of [{ state: 'ready_claimed' }, { state: 'interrupted', interruptedRole: 'verify' }]) {
    const calls = []
    const runAgent = async (_, pr, options) => {
      calls.push({ id: pr.id, ...options })

      return agentResult()
    }

    const dir = makeRollout({ prs: { A1: { ...queued, ...state } }, events: [] })
    const tools = fakeTools(dir, [])
    const github = fakeGitHub()
    const manifest = loadManifest(dir)

    setFetch(github.fetch, { token: async () => MAINTAINER_TOKEN })

    const driver = createDriver(manifest, { notify: () => {}, runAgent })
    const entry = driver.ledger.prs.A1

    await driver.advance(manifest.all.find((item) => item.id === 'A1'))

    assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'], state.state)
    assert.equal(entry.fixReason, 'answer from the maintainer')
    assert.equal(entry.fixNote, '')
    assert.equal(entry.pendingNote, note)
    assert.deepEqual(kindsSince(manifest), ['needs-fix'])
    assert.deepEqual(calls, [])
    assert.deepEqual(tools.calls(), [])
    assert.deepEqual(github.requests(), [])
  }
})

// A code scanning alert as alertsFrom maps it, on A1's head unless `sha` says otherwise.
function scanAlert(overrides = {}) {
  return {
    number: 4,
    rule: 'js/shell-command-injection-from-environment',
    securitySeverity: 'medium',
    severity: 'warning',
    tool: 'CodeQL',
    path: 'bin/rollout.mjs',
    line: 357,
    message: 'This shell command depends on an uncontrolled absolute path.',
    url: 'https://github.com/example/widgets/security/code-scanning/4',
    sha: SHA,
    ...overrides,
  }
}

function scanned(alerts) {
  return { codeScanning: { available: true, alerts, baseOpen: [] } }
}

const ALERT_REASON =
  'CodeQL js/shell-command-injection-from-environment (medium) bin/rollout.mjs:357: This shell command depends on an uncontrolled absolute path. https://github.com/example/widgets/security/code-scanning/4'

// A claimed A1 with green CI on its head, and the given code scanning facts.
function claimDriver(facts) {
  const setup = tickDriver({ A1: CLAIMED }, { routes: [prRoute(), runsRoute(SHA)] })
  setup.gate.facts = facts

  return { ...setup, pr: setup.manifest.prs.find((item) => item.id === 'A1'), entry: setup.driver.ledger.prs.A1 }
}

test('checkClaim: a new code scanning alert on the head goes back to the implementer before verification', async () => {
  const { manifest, driver, pr, entry } = claimDriver(scanned([scanAlert()]))

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fixReason, 'code scanning')
  assert.ok(entry.fixNote.includes(`- ${ALERT_REASON}`))
  assert.match(entry.fixNote, /Never silence the analyser/)
  assert.match(entry.fixNote, /kind `code-scanning`/)
  assert.match(entry.fixNote, /gh api repos\/example\/widgets\/code-scanning\/alerts\/<number>/)
  assert.equal(entry.claimPatchId, undefined)
  assert.equal(entry.patchSince, undefined)
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    gateCheckEvent('code-scanning', 'fail', ALERT_REASON),
    { id: 'A1', kind: 'needs-fix', reason: 'code scanning' },
  ])
})

test('checkClaim: with action block, a new alert blocks the PR for the maintainer', async () => {
  const { manifest, driver, pr, entry, notices } = claimDriver(scanned([scanAlert()]))
  manifest.repo.codeScanning = { action: 'block', minSeverity: 'medium' }

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'needs-you', 'code-scanning-alerts'])
  assert.deepEqual(placeOf(entry), ['pre-verify', 'needs-you', 'code-scanning-alerts'])
  assert.deepEqual(entry.status.alerts, [ALERT_REASON])

  assert.equal(entry.claimPatchId, undefined)
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    gateCheckEvent('code-scanning', 'fail', ALERT_REASON),
    { id: 'A1', kind: 'blocked', reason: 'code-scanning' },
  ])

  assert.deepEqual(notices, [`A1: blocked (code-scanning): ${ALERT_REASON.slice(0, 120)}`])
})

test('checkClaim: a code scanning block is read again on the next tick, logs and notifies nothing again, and moves on once the alert is gone', async () => {
  const { manifest, driver, gate, pr, entry, notices } = claimDriver(scanned([scanAlert()]))
  const second = scanAlert({ number: 5, line: 360, url: 'https://github.com/example/widgets/security/code-scanning/5' })
  const secondReason = ALERT_REASON.replace('357', '360').replace('code-scanning/4', 'code-scanning/5')

  manifest.repo.codeScanning = { action: 'block', minSeverity: 'medium' }

  await driver.advance(pr)

  const since = entry.status.since
  const events = readEvents(manifest).length

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'needs-you', 'code-scanning-alerts'])
  assert.equal(entry.status.since, since)
  assert.equal(readEvents(manifest).length, events)
  assert.equal(notices.length, 1)

  gate.facts = scanned([scanAlert(), second])
  await driver.advance(pr)

  assert.deepEqual(entry.status.alerts, [ALERT_REASON, secondReason])
  assert.equal(entry.status.since, since)
  assert.deepEqual(kindsSince(manifest, events), ['gate-check'])
  assert.equal(notices.length, 1)

  gate.facts = scanned([])
  await driver.advance(pr)

  // No slot under concurrency 0: the claim goes on as any claim.
  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'slot'])
  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'slot'])
  assert.equal(entry.claimPatchId, samplePrs().A1.verified.patchId)
  assert.deepEqual(eventsSince(manifest).at(-1), gateCheckEvent('code-scanning', 'pass', 'no new alerts at or above medium'))
})

test('checkClaim: an alert from an older commit waits for the analysis of the head, logged once', async () => {
  const { manifest, driver, pr, entry, notices } = claimDriver(scanned([scanAlert({ sha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2' })]))

  await driver.advance(pr)
  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'code-scanning-pending'])
  assert.equal(entry.claimPatchId, undefined)
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    {
      id: 'A1',
      kind: 'code-scanning-wait',
      sha: SHA.slice(0, 7),
      reasons: [`code scanning has not analysed ${SHA.slice(0, 7)} yet (alert #4 is from b2b2b2b)`],
    },
  ])

  assert.deepEqual(notices, [])
})

test('checkClaim: a repo without code scanning logs it once and goes on', async () => {
  const unavailable = { codeScanning: { available: false, reason: 'HTTP 404: no analysis found', alerts: [], baseOpen: [] } }
  const { manifest, driver, pr, entry, notices } = claimDriver(unavailable)

  await driver.advance(pr)
  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'slot'])
  assert.equal(entry.claimPatchId, samplePrs().A1.verified.patchId)
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    { id: 'A1', kind: 'code-scanning-unavailable', reason: 'HTTP 404: no analysis found' },
    gateCheckEvent('code-scanning', 'skip', 'unavailable'),
  ])

  assert.equal(entry.notified.codeScanningUnavailable, true)
  assert.deepEqual(notices, [])
})

test('checkClaim: no new alert, or one below the threshold, goes on to verification', async () => {
  for (const alerts of [[], [scanAlert({ securitySeverity: 'low' })]]) {
    const { manifest, driver, pr, entry } = claimDriver(scanned(alerts))

    await driver.advance(pr)

    assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'slot'], JSON.stringify(alerts))
    assert.equal(entry.claimPatchId, samplePrs().A1.verified.patchId, JSON.stringify(alerts))
    assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'gate-check'], JSON.stringify(alerts))
  }
})

const SCOPE_GATE = gatesWith({ preVerify: { scope: true } })

test('after READY: files outside the scope, not listed in the report', async () => {
  const { manifest, driver, pr, entry, agentCalls } = verifiableDriver({ gates: SCOPE_GATE })

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fix.reason, 'scope')
  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fixReason, 'out of scope')
  assert.ok(entry.fixNote.includes('- README.md'))
  assert.match(entry.fixNote, /list the file in `deviations` of your next READY report/)
  assert.deepEqual(entry.outOfScope, ['README.md'])
  assert.deepEqual(agentCalls, [])
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    gateCheckEvent('code-scanning', 'pass', 'no new alerts at or above medium'),
    gateCheckEvent('scope', 'fail', 'undeclared: README.md'),
    { id: 'A1', kind: 'needs-fix', reason: 'out of scope' },
  ])
})

test('checkClaim: with gates.preVerify.scope, a file out of scope listed in deviations goes on to the verifier', async () => {
  const deviations = [{ file: 'README.md', reason: 'The usage section names the new flag.' }]
  const { manifest, driver, pr, entry, agentCalls } = verifiableDriver({ gates: SCOPE_GATE, deviations })

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'])
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])

  const events = eventsSince(manifest)

  assert.deepEqual(events.slice(0, 4), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    gateCheckEvent('code-scanning', 'pass', 'no new alerts at or above medium'),
    gateCheckEvent('scope', 'pass', 'declared in deviations: README.md'),
  ])

  assert.deepEqual(
    events.map((event) => event.kind),
    ['gate-check', 'gate-check', 'gate-check', 'gate-check', 'verify-start'],
  )

  assert.equal(events[4].run, 'A1-02-verify-2')
})

test('checkClaim: with gates.preVerify.scope and no file out of scope, the scope check passes', async () => {
  const { manifest, driver, pr, gate, agentCalls } = verifiableDriver({ gates: SCOPE_GATE })
  gate.facts = { files: [{ status: 'modified', path: 'lib/widget.mjs' }] }

  await driver.advance(pr)

  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])
  assert.deepEqual(eventsSince(manifest)[3], gateCheckEvent('scope', 'pass', 'no files out of scope'))
  assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'gate-check', 'gate-check', 'verify-start'])
})

test('checkClaim: without gates, an undeclared file out of scope still goes on to the verifier', async () => {
  const { manifest, driver, pr, entry, agentCalls } = verifiableDriver()

  assert.deepEqual(manifest.gates, gatesWith())

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'])
  assert.deepEqual(entry.outOfScope, ['README.md'])
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])
  assert.deepEqual(eventsSince(manifest).slice(0, 3), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    gateCheckEvent('code-scanning', 'pass', 'no new alerts at or above medium'),
  ])

  assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'gate-check', 'verify-start'])
})

test('checkClaim: untracked Claude Code files in the worktree are removed and logged before the verifier starts', async () => {
  const { manifest, driver, pr, entry, agentCalls } = verifiableDriver()
  const wt = worktreePath(manifest, pr)

  mkdirSync(join(wt, '.claude'))
  writeFileSync(join(wt, '.claude', 'settings.local.json'), '{}\n')
  writeFileSync(join(wt, 'CLAUDE.local.md'), 'notes\n')

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'])
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])
  assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'gate-check', 'local-config-removed', 'verify-start'])
  assert.deepEqual(eventsSince(manifest)[3], {
    id: 'A1',
    kind: 'local-config-removed',
    paths: ['.claude/settings.local.json', 'CLAUDE.local.md'],
  })

  assert.equal(existsSync(join(wt, '.claude', 'settings.local.json')), false)
  assert.equal(existsSync(join(wt, 'CLAUDE.local.md')), false)
})

test('after READY: CI is red', async () => {
  const { manifest, driver, github, pr, entry } = claimDriver({})
  const runs = {
    check_runs: [
      { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'lint', status: 'completed', conclusion: 'failure' },
    ],
  }

  github.answer([prRoute(), runsRoute(SHA, runs)])

  await driver.advance(pr)

  // The failed ci check is logged right before the PR goes back to the implementer.
  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fix.reason, 'ci-red')
  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'fail', 'failing: lint: failure'),
    { id: 'A1', kind: 'needs-fix', reason: 'CI is red' },
  ])
})

test('after READY: CI runs on the head', async () => {
  const { manifest, driver, github, pr, entry } = claimDriver({})
  const running = { check_runs: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }

  github.answer([prRoute(), runsRoute(SHA, running)])

  await driver.advance(pr)
  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.deepEqual([entry.status.sha, entry.status.missing, entry.status.pending], [SHA, [], ['test']])
  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.ok(entry.ciPendingSince)
  assert.deepEqual(eventsSince(manifest), [])
})

test('after READY: CI does not settle within ciStallMinutes', async () => {
  const { manifest, driver, github, pr, entry } = claimDriver({})
  const running = { check_runs: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }

  entry.ciPendingSince = new Date(Date.now() - 60 * 60_000).toISOString()
  github.answer([prRoute(), runsRoute(SHA, running)])

  await driver.advance(pr)

  // The failed ci check is logged right before the PR goes back to the implementer.
  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fix.reason, 'ci-stalled')
  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'fail', 'not settled after 20 minutes (missing: none, running: test)'),
    { id: 'A1', kind: 'needs-fix', reason: 'CI did not settle' },
  ])
})

test('after READY: the PR breaks a rollout rule', async () => {
  const { manifest, driver, pr, entry } = claimDriver({ files: [{ status: 'modified', path: '.github/workflows/ci.yml' }] })

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.fix.reason, entry.fixReason], ['policy', 'rollout policy'])
  assert.match(entry.fixNote, /^The PR breaks rollout rules:\n- touches \.github\/workflows\/ci\.yml/)
  assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'needs-fix'])
})

test('after READY: new code scanning alerts', async () => {
  const cases = [
    ['fix', scanned([scanAlert()]), ['implement', 'waiting', 'slot']],
    ['block', scanned([scanAlert()]), ['pre-verify', 'needs-you', 'code-scanning-alerts']],
    ['fix', scanned([scanAlert({ sha: NEW_HEAD })]), ['pre-verify', 'waiting', 'code-scanning-pending']],
  ]

  for (const [action, facts, place] of cases) {
    const { manifest, driver, pr, entry } = claimDriver(facts)

    manifest.repo.codeScanning = { action, minSeverity: 'medium' }
    await driver.advance(pr)

    assert.deepEqual(placeOf(entry), place, action)
    assert.equal(entry.fix?.reason ?? null, place[0] === 'implement' ? 'code-scanning' : null, action)
  }
})

test('after READY: the worktree cannot be set to the head', async () => {
  const { manifest, driver, pr, entry, agentCalls } = verifiableDriver({
    rules: [{ tool: 'git', args: 'status --porcelain', stdout: ' M lib/widget.mjs\n' }],
  })

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.fix.reason, entry.fixReason], ['worktree', 'worktree not at the PR head'])
  assert.match(entry.fixNote, /^worktree has uncommitted changes/)
  assert.deepEqual(agentCalls, [])
  assert.equal(kindsSince(manifest).at(-1), 'needs-fix')
})

test('after READY: no free slot', async () => {
  const { manifest, driver, pr, entry } = claimDriver({})

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'slot'])
  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'slot'])
  assert.equal(entry.claimPatchId, samplePrs().A1.verified.patchId)
  assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'gate-check'])
})

test('checkClaim: a pass is logged once per claim, and again for a new claim', async () => {
  const { manifest, driver, github, gate, pr, entry } = claimDriver({})
  const passes = (sha) => [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE, sha),
    gateCheckEvent('policy', 'pass', 'no violations', sha),
    gateCheckEvent('code-scanning', 'pass', 'no new alerts at or above medium', sha),
  ]

  entry.claimedAt = at(1)

  await driver.advance(pr)
  await driver.advance(pr)

  assert.equal(gate.calls, 2)
  assert.deepEqual(eventsSince(manifest), passes(SHA))

  let before = readEvents(manifest).length
  entry.claimedAt = at(2)

  await driver.advance(pr)

  assert.deepEqual(eventsSince(manifest, before), passes(SHA))

  before = readEvents(manifest).length
  entry.claimedSha = REBASED
  entry.claimedAt = at(3)
  gate.pr = { headRefOid: REBASED }
  github.answer([prRoute({ head: { sha: REBASED } }), runsRoute(REBASED)])

  await driver.advance(pr)

  assert.deepEqual(eventsSince(manifest, before), passes(REBASED))
  assert.deepEqual(entry.notified.gateChecks, {
    claimedAt: at(3),
    sha: REBASED,
    seen: ['preVerify:required:ci:pass', 'preVerify:required:policy:pass', 'preVerify:required:code-scanning:pass'],
  })
})

// Sync's head-moved-same-patch moves claimedSha and keeps claimedAt. A gate block and rollout retry can then bring the PR back here.
test('checkClaim: a new head under the same claim logs its passes again', async () => {
  const { manifest, driver, github, gate, pr, entry } = claimDriver({})

  entry.claimedAt = at(1)

  await driver.advance(pr)

  const before = readEvents(manifest).length
  entry.claimedSha = REBASED
  gate.pr = { headRefOid: REBASED }
  github.answer([prRoute({ head: { sha: REBASED } }), runsRoute(REBASED)])

  await driver.advance(pr)

  assert.equal(entry.claimedAt, at(1))
  assert.deepEqual(eventsSince(manifest, before), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE, REBASED),
    gateCheckEvent('policy', 'pass', 'no violations', REBASED),
    gateCheckEvent('code-scanning', 'pass', 'no new alerts at or above medium', REBASED),
  ])
})

test('checkClaim: the scope gate failing again on the same SHA after a new READY logs its fail again', async () => {
  const { manifest, driver, pr, entry } = verifiableDriver({ gates: SCOPE_GATE })
  const round = [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    gateCheckEvent('code-scanning', 'pass', 'no new alerts at or above medium'),
    gateCheckEvent('scope', 'fail', 'undeclared: README.md'),
    { id: 'A1', kind: 'needs-fix', reason: 'out of scope' },
  ]

  entry.claimedAt = at(1)

  await driver.advance(pr)

  verifyAgain(entry, at(2))
  entry.claimedAt = at(2)

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual(eventsSince(manifest), [...round, ...round])
})

test('checkClaim: a claim read again after a fail, with no new READY, logs each check once, and a fail with new evidence again', async () => {
  const { manifest, driver, gate, pr, entry } = claimDriver(scanned([scanAlert()]))
  const other = scanAlert({ line: 360 })
  const otherReason = ALERT_REASON.replace('357', '360')

  manifest.repo.codeScanning = { action: 'block', minSeverity: 'medium' }
  entry.claimedAt = at(1)

  await driver.advance(pr)
  await driver.advance(pr)

  gate.facts = scanned([other])
  await driver.advance(pr)
  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'needs-you', 'code-scanning-alerts'])
  assert.equal(entry.claimedAt, at(1))
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    gateCheckEvent('code-scanning', 'fail', ALERT_REASON),
    { id: 'A1', kind: 'blocked', reason: 'code-scanning' },
    gateCheckEvent('code-scanning', 'fail', otherReason),
  ])
})

test('checkClaim: code scanning turned off is a skip, not a pass', async () => {
  const { manifest, driver, pr } = claimDriver(scanned([scanAlert()]))
  manifest.repo.codeScanning = { action: 'ignore', minSeverity: 'medium' }

  await driver.advance(pr)

  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    gateCheckEvent('code-scanning', 'skip', 'off'),
  ])
})

test('checkClaim: a ci pass lists every run on the SHA with its conclusion', async () => {
  const { manifest, driver, github, pr } = claimDriver({})
  const runs = {
    check_runs: [
      { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'docs', status: 'completed', conclusion: 'skipped' },
    ],
  }

  github.answer([prRoute(), runsRoute(SHA, runs)])

  await driver.advance(pr)

  assert.deepEqual(eventsSince(manifest)[0], gateCheckEvent('ci', 'pass', 'required checks passed, runs: test (success), docs (skipped)'))
})

test('checkClaim: every gate-check event is short and names the stage and the level', async () => {
  const { manifest, driver, github, pr } = claimDriver({})
  const many = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `job-${i}`, status: 'completed', conclusion: 'failure' }))

  github.answer([prRoute(), runsRoute(SHA, { check_runs: many })])

  await driver.advance(pr)

  const [event] = eventsSince(manifest)

  assert.equal(event.kind, 'gate-check')
  assert.equal(event.stage, 'preVerify')
  assert.equal(event.level, 'required')
  assert.equal(event.sha, SHA.slice(0, 7))
  assert.equal(event.evidence.length, 300)
  assert.match(event.evidence, /^failing: job-0: failure, job-1: failure/)
})

// The external review: a check run named `agent review` and the artifact review-11 it uploads.
const REVIEW_CHECK = 'agent review'
const EXTERNAL_FINDINGS = { check: REVIEW_CHECK, artifact: 'review-{pr}', minSeverity: 'medium' }
const REVIEW_GATE = gatesWith({ verify: { externalFindings: EXTERNAL_FINDINGS } })
const ARTIFACTS = 'repos/example/widgets/actions/artifacts'
const TESTED = { id: 1, name: 'test', status: 'completed', conclusion: 'success' }
const PASSES = [
  gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
  gateCheckEvent('policy', 'pass', 'no violations'),
  gateCheckEvent('code-scanning', 'pass', 'no new alerts at or above medium'),
]

const HIGH = {
  severity: 'high',
  criterion: 'review.correctness',
  title: 'The total ignores a refunded line',
  file: 'src/orders/total.ts',
  line: 42,
  failure_scenario: 'An order with one refunded line shows the full price.',
  fix: 'Skip a line whose refund is settled.',
  status: 'new',
}

const MEDIUM = {
  severity: 'medium',
  criterion: 'review.errors',
  title: 'A refused refund is dropped',
  file: 'src/orders/refund.ts',
  line: 18,
  failure_scenario: 'A refund the bank refuses leaves the order marked as refunded.',
  fix: 'Keep the order open until the bank confirms.',
  status: 'open',
}

const LOW = {
  severity: 'low',
  criterion: 'review.naming',
  title: 'A flag named tmp',
  file: 'src/orders/total.ts',
  line: 12,
  failure_scenario: 'The next reader cannot tell what it guards.',
  fix: 'Name it after the condition.',
  status: 'open',
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function reviewRun(status, conclusion = null, { id = 2, started = minutesAgo(1) } = {}) {
  return { id, name: REVIEW_CHECK, status, conclusion, started_at: started }
}

// A finding as the driver stores it.
function storedFinding({ failure_scenario: failureScenario, ...finding }) {
  return { ...finding, failureScenario }
}

function reviewJson(changes = {}) {
  return JSON.stringify({
    schema_version: 1,
    revision: SHA,
    input_digest: '9b2d',
    findings: [LOW, HIGH, MEDIUM],
    fixed: [],
    dropped: [],
    ...changes,
  })
}

function artifactJson(id, sha) {
  return {
    id,
    name: 'review-11',
    size_in_bytes: 900,
    expired: false,
    created_at: '2026-10-01T10:00:00Z',
    workflow_run: { id: id * 10, head_sha: sha },
  }
}

function listRoute(artifacts) {
  return { path: ARTIFACTS, query: { name: 'review-11' }, body: { total_count: artifacts.length, artifacts }, items: 'artifacts' }
}

// The API's 302 for one artifact, and the storage host's answer.
function zipRoutes(id, storage) {
  return [
    { path: `${ARTIFACTS}/${id}/zip`, status: 302, headers: { location: `https://storage.example.com/artifacts/${id}.zip?sig=synthetic` } },
    { path: `artifacts/${id}.zip`, ...storage },
  ]
}

// A1's PR at SHA with `runs` on its head, and the review's artifact for that head.
function reviewRoutes(runs, { json = reviewJson(), artifacts = [artifactJson(7, SHA)] } = {}) {
  return [
    prRoute(),
    runsRoute(SHA, { check_runs: runs }),
    listRoute(artifacts),
    ...zipRoutes(7, { body: zipArchive([{ name: 'review.json', data: json }]) }),
  ]
}

// A claimed A1 that can start its verifier, with the external review on and `runs` on its head.
function reviewDriver(runs, { gates = REVIEW_GATE, routes = {}, ...options } = {}) {
  const setup = verifiableDriver({ gates, ...options })

  setup.github.answer(reviewRoutes(runs, routes))

  return setup
}

function artifactRequests(github) {
  return github.requests().filter((request) => request.path.startsWith(ARTIFACTS))
}

// A skip goes on to the verifier: one gate-check, a stored reason and no fix.
async function assertSkips(setup, reason, run = 2) {
  const { manifest, driver, pr, entry, agentCalls } = setup

  await driver.advance(pr)

  const events = eventsSince(manifest)

  assert.deepEqual(events.slice(0, 4), [...PASSES, gateCheckEvent('external-review', 'skip', reason)], reason)
  assert.deepEqual(
    events.map((event) => event.kind),
    ['gate-check', 'gate-check', 'gate-check', 'gate-check', 'verify-start'],
    reason,
  )

  assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'], reason)
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }], reason)
  assert.equal(entry.fix, null, reason)
  assert.deepEqual(
    { ...entry.review, at: null },
    { sha: SHA, at: null, run, reusedFrom: null, skipped: reason, findings: [], fixed: [], leftOut: 0, candidates: [] },
    reason,
  )
}

test('checkClaim: with no review run, a claim younger than 2 minutes waits, and an older one skips the review and starts the verifier', async () => {
  const { manifest, driver, github, pr, entry, agentCalls } = reviewDriver([TESTED])

  entry.claimedAt = minutesAgo(1)
  await driver.advance(pr)
  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'external-review'])
  assert.equal(entry.status.sha, SHA)
  assert.equal(entry.review, undefined)
  assert.deepEqual(agentCalls, [])
  assert.deepEqual(eventsSince(manifest), PASSES)

  const before = readEvents(manifest).length

  entry.claimedAt = minutesAgo(3)
  await driver.advance(pr)

  const later = eventsSince(manifest, before)

  assert.deepEqual(
    later.filter((event) => event.item === 'external-review'),
    [gateCheckEvent('external-review', 'skip', 'no review run on the head')],
  )

  assert.equal(later.at(-1).kind, 'verify-start')
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])
  assert.equal(entry.review.run, null)
  assert.deepEqual(artifactRequests(github), [])
})

test('checkClaim: with no review run and no claimedAt, the review is a skip at once', async () => {
  const setup = reviewDriver([TESTED])

  assert.equal(setup.entry.claimedAt, null)
  await assertSkips(setup, 'no review run on the head', null)
})

test('checkClaim: a review run in progress within ciStallMinutes waits on the head, with no fix, no agent and no read', async () => {
  const cases = [
    ['started a minute ago', reviewRun('in_progress'), null],
    ['queued with no start, on a claim a minute old', reviewRun('queued', null, { started: null }), minutesAgo(1)],
  ]

  for (const [name, run, claimedAt] of cases) {
    const { manifest, driver, github, pr, entry, agentCalls } = reviewDriver([TESTED, run])

    entry.claimedAt = claimedAt
    await driver.advance(pr)
    await driver.advance(pr)

    assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'external-review'], name)
    assert.equal(entry.status.sha, SHA, name)
    assert.equal(entry.review, undefined, name)
    assert.deepEqual(agentCalls, [], name)
    assert.deepEqual(eventsSince(manifest), PASSES, name)
    assert.deepEqual(artifactRequests(github), [], name)
  }
})

test('checkClaim: a review run in progress for longer than ciStallMinutes is a skip', async () => {
  await assertSkips(
    reviewDriver([TESTED, reviewRun('in_progress', null, { started: minutesAgo(30) })]),
    'the review has run for more than 20 minutes',
  )

  const unstarted = reviewDriver([TESTED, reviewRun('queued', null, { started: null })])

  unstarted.entry.claimedAt = minutesAgo(30)
  await assertSkips(unstarted, 'the review has run for more than 20 minutes')
})

test('checkClaim: a review run that failed, was cancelled or was skipped is a skip, never CI is red', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    await assertSkips(reviewDriver([TESTED, reviewRun('completed', conclusion)]), `the review run ended as ${conclusion}`)
  }
})

test('checkClaim: a successful review run with no artifact for the head, or a review.json of another revision, is a skip', async () => {
  await assertSkips(
    reviewDriver([TESTED, reviewRun('completed', 'success')], { routes: { artifacts: [artifactJson(7, NEW_HEAD)] } }),
    'the review left no artifact for this head',
  )

  await assertSkips(
    reviewDriver([TESTED, reviewRun('completed', 'success')], { routes: { json: reviewJson({ revision: NEW_HEAD }) } }),
    'revision b2b2b2b is not the head',
  )
})

test('checkClaim: a review read for the head logs its counts, is stored, and a claim that moves drops it', async () => {
  const { manifest, driver, pr, entry, agentCalls } = reviewDriver([TESTED, reviewRun('completed', 'success')])

  await driver.advance(pr)

  const events = eventsSince(manifest)

  assert.deepEqual(events.slice(0, 4), [
    ...PASSES,
    gateCheckEvent('external-review', 'pass', '2 candidates (1 high, 1 medium), 1 below medium'),
  ])

  assert.equal(events[4].kind, 'verify-start')
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])
  assert.equal(typeof entry.review.at, 'string')
  assert.deepEqual(
    { ...entry.review, at: null },
    {
      sha: SHA,
      at: null,
      run: 2,
      reusedFrom: null,
      skipped: null,
      findings: [HIGH, MEDIUM, LOW].map(storedFinding),
      fixed: [],
      leftOut: 0,
      candidates: [],
    },
  )

  // GitHub's view of the PR shows another head before CI is read, the gate's facts after its pass.
  const moves = { viewPr: ['claim-moved'], facts: ['gate-check', 'claim-moved'] }

  for (const [where, kinds] of Object.entries(moves)) {
    const moved = claimDriver({})

    moved.entry.review = structuredClone(entry.review)

    if (where === 'viewPr') {
      moved.github.answer([prRoute({ head: { sha: NEW_HEAD } }), runsRoute(NEW_HEAD, { check_runs: [reviewRun('in_progress')] })])
    } else {
      moved.gate.pr = { headRefOid: NEW_HEAD }
    }

    await moved.driver.advance(moved.pr)

    assert.equal(moved.entry.claimedSha, NEW_HEAD, where)
    assert.equal(moved.entry.review, null, where)
    assert.deepEqual(placeOf(moved.entry), ['pre-verify', 'waiting', 'ci'], where)
    assert.deepEqual(kindsSince(moved.manifest), kinds, where)
  }
})

test('checkClaim: a stored result of the head and its run is used with no read, and a new run of the head is read again', async () => {
  const stored = {
    sha: SHA,
    at: at(1),
    run: 2,
    reusedFrom: null,
    skipped: null,
    findings: [storedFinding(HIGH)],
    fixed: [],
    leftOut: 0,
    candidates: [],
  }

  const reused = reviewDriver([TESTED, reviewRun('completed', 'success')])

  reused.entry.review = structuredClone(stored)
  await reused.driver.advance(reused.pr)

  assert.deepEqual(eventsSince(reused.manifest)[3], gateCheckEvent('external-review', 'pass', '1 candidate (1 high)'))
  assert.deepEqual(artifactRequests(reused.github), [])
  assert.deepEqual(reused.entry.review, stored)
  assert.deepEqual(reused.agentCalls, [{ id: 'A1', role: 'verify' }])

  const rerun = reviewDriver([TESTED, reviewRun('completed', 'success', { id: 3 })])

  rerun.entry.review = structuredClone(stored)
  await rerun.driver.advance(rerun.pr)

  assert.deepEqual(
    eventsSince(rerun.manifest)[3],
    gateCheckEvent('external-review', 'pass', '2 candidates (1 high, 1 medium), 1 below medium'),
  )

  assert.equal(rerun.entry.review.run, 3)
  assert.equal(rerun.entry.review.findings.length, 3)
})

test('checkClaim: a review with no finding at or above minSeverity and findings left out says so', async () => {
  const findings = Array.from({ length: 52 }, (_, i) => ({ ...LOW, line: i + 1 }))
  const { manifest, driver, pr, entry } = reviewDriver([TESTED, reviewRun('completed', 'success')], {
    routes: { json: reviewJson({ findings }) },
  })

  await driver.advance(pr)

  assert.deepEqual(eventsSince(manifest)[3], gateCheckEvent('external-review', 'pass', 'no candidates, 50 below medium, 2 left out'))
  assert.equal(entry.review.leftOut, 2)
})

test('checkClaim: an outage while reading the review is an error of the PR, never a skip', async () => {
  const { manifest, driver, github, pr, entry, agentCalls } = reviewDriver([TESTED, reviewRun('completed', 'success')])

  github.answer([
    prRoute(),
    runsRoute(SHA, { check_runs: [TESTED, reviewRun('completed', 'success')] }),
    { path: ARTIFACTS, status: 500, body: { message: 'Server Error' } },
  ])

  await assert.rejects(driver.advance(pr), /HTTP 500: Server Error/)

  assert.equal(entry.review, undefined)
  assert.deepEqual(agentCalls, [])
  assert.deepEqual(eventsSince(manifest), PASSES)
})

test('checkClaim: with the external review on, a failed run of another check still sends CI is red', async () => {
  const { manifest, driver, pr, entry, agentCalls } = reviewDriver([
    TESTED,
    { id: 3, name: 'lint', status: 'completed', conclusion: 'failure' },
    reviewRun('completed', 'success'),
  ])

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fix.reason, 'ci-red')
  assert.deepEqual(agentCalls, [])
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'fail', 'failing: lint: failure'),
    { id: 'A1', kind: 'needs-fix', reason: 'CI is red' },
  ])
})

test('checkClaim: the pre-verify commands run while the review runs, and the wait comes after them', async () => {
  const seam = commandSeam()
  const gates = gatesWith({ preVerify: COMMANDS_GATE.preVerify, verify: { externalFindings: EXTERNAL_FINDINGS } })
  const setup = reviewDriver([TESTED, reviewRun('in_progress')], { gates, runCommand: seam.runCommand })
  const { manifest, driver, github, pr, entry, agentCalls } = setup

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm test', 'npm run lint'])
  assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'gate-check', 'gate-check', 'gate-check'])

  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'external-review'])
  assert.deepEqual(agentCalls, [])
  assert.deepEqual(seam.commands(), ['npm test', 'npm run lint'])
  assert.equal(
    eventsSince(manifest).some((event) => event.item === 'external-review'),
    false,
  )

  github.answer(reviewRoutes([TESTED, reviewRun('completed', 'success')]))
  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'])
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])
  assert.deepEqual(seam.commands(), ['npm test', 'npm run lint'])
  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.item === 'external-review'),
    [gateCheckEvent('external-review', 'pass', '2 candidates (1 high, 1 medium), 1 below medium')],
  )
})

test('mergeCandidate: a new code scanning alert drops the verification and goes back to the implementer', async () => {
  const { manifest, driver, gate } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  const entry = driver.ledger.prs.A1
  gate.facts = scanned([scanAlert()])

  assert.equal(await driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1')), false)
  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fixReason, 'code scanning')
  assert.equal(entry.verified, null)
  assert.ok(entry.fixNote.includes(`- ${ALERT_REASON}`))
  assert.match(entry.fixNote, /Never silence the analyser/)
  assert.match(entry.fixNote, /kind `code-scanning`/)
  assert.deepEqual(eventsSince(manifest), [
    { id: 'A1', kind: 'gate-fix', code: 'code-scanning', reasons: [ALERT_REASON] },
    { id: 'A1', kind: 'needs-fix', reason: 'code scanning' },
  ])
})

test('mergeCandidate: with action block, a new code scanning alert blocks and keeps the verification', async () => {
  const { manifest, driver, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  const entry = driver.ledger.prs.A1
  manifest.repo.codeScanning = { action: 'block', minSeverity: 'medium' }
  gate.facts = scanned([scanAlert()])

  assert.equal(await driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1')), false)
  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'code-scanning-alerts'])
  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'code-scanning-alerts'])
  assert.deepEqual(entry.status.alerts, [ALERT_REASON])
  assert.deepEqual(entry.verified, samplePrs().A1.verified)
  assert.deepEqual(eventsSince(manifest), [
    { id: 'A1', kind: 'gate-block', code: 'code-scanning', reasons: [ALERT_REASON] },
    { id: 'A1', kind: 'blocked', reason: 'code-scanning' },
  ])

  assert.deepEqual(notices, [`A1: blocked (code-scanning): ${ALERT_REASON.slice(0, 120)}`])
})

test('mergeCandidate: an analysis of an older commit waits with no notification', async () => {
  const { manifest, driver, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  gate.facts = scanned([scanAlert({ sha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2' })])

  assert.equal(await driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1')), false)
  assert.deepEqual(placeOf(driver.ledger.prs.A1), ['merge', 'waiting', 'code-scanning-pending'])
  assert.equal(driver.ledger.prs.A1.gate.code, 'code-scanning')
  assert.deepEqual(notices, [])
})

// A1 in a fix run after a FAIL whose findings are not answered yet.
function answeringDriver(routes, state = {}) {
  const setup = tickDriver(
    { A1: { state: 'fixing', pr: 11, claimedSha: SHA, sessionId: 'session-1', findings: UNANSWERED, ...state } },
    { routes },
  )

  return { ...setup, pr: setup.manifest.prs.find((item) => item.id === 'A1'), entry: setup.driver.ledger.prs.A1 }
}

function readyReport(headSha, addressed) {
  return agentResult({ output: { status: 'READY', pr: 11, headSha, summary: 'Done.', ...(addressed ? { addressed } : {}) } })
}

const ANSWERS = [
  { id: 'F1', action: 'It is logged at cli.mjs:42.', outcome: 'fixed' },
  { id: 'F2', action: 'The brief keeps the flag internal.', outcome: 'disputed' },
]

test('claimReport: answers from one READY report survive a later one with none, and reach the next verifier', async () => {
  const { manifest, driver, pr, entry } = answeringDriver([prRoute({ head: { sha: NEW_HEAD } })])
  const ciFixed = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3'

  await driver.onDone(pr, 'fix', readyReport(NEW_HEAD, ANSWERS), { run: 'A1-03-fix' })

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])

  // CI was red on that head, and the fix run after it answered nothing.
  runStarted(entry, 'fix', { at: at(3) })
  await driver.onDone(pr, 'fix', readyReport(ciFixed), { run: 'A1-04-fix' })

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.equal(entry.claimedSha, ciFixed)
  assert.deepEqual(entry.findings, FIRST_ROUND)

  const prompt = verifyPrompt(manifest, pr, entry, ciFixed)

  assert.ok(prompt.includes('### F1\n\nFinding:\n\ncli.mjs:40 swallows the error.\n\nAnswer (fixed):\n\nIt is logged at cli.mjs:42.'))
  assert.ok(
    prompt.includes('### F2\n\nFinding:\n\nThe retry flag is not documented.\n\nAnswer (disputed):\n\nThe brief keeps the flag internal.'),
  )
})

test('claimReport: a READY report sent back for GitHub, or parked during an outage, still answers the findings', async () => {
  const pr11 = 'repos/example/widgets/pulls/11'
  const cases = [
    { place: ['implement', 'waiting', 'slot'], routes: [{ path: pr11, ...NOT_FOUND }, REPOSITORY] },
    { place: ['pre-verify', 'waiting', 'github'], routes: [{ path: pr11, status: 502 }] },
  ]

  for (const { place, routes } of cases) {
    const { driver, pr, entry } = answeringDriver(routes)

    await driver.onDone(pr, 'fix', readyReport(NEW_HEAD, ANSWERS), { run: 'A1-03-fix' })

    assert.deepEqual(placeOf(entry), place)
    assert.deepEqual(entry.findings, FIRST_ROUND, place.join(' '))
  }
})

test('onDone: a run that ends mid-tick, after sync read its PR at the old head, makes checkClaim read the PR again', async () => {
  const { manifest, driver, github, gate } = tickDriver(
    { A1: { state: 'fixing', pr: 11, claimedSha: SHA, sessionId: 'session-1' } },
    { rules: [FETCH], routes: [prRoute()] },
  )

  const pr = manifest.prs.find((item) => item.id === 'A1')
  const prPath = prRoute().path
  let ended = false

  // The stubbed collectFacts reads no PR, so its head check takes this one.
  gate.pr = { headRefOid: NEW_HEAD }

  // The first read of PR 11 is sync's, at the head from before the push. The
  // run pushes and ends before that answer arrives.
  async function endingMidTick(url, init) {
    const answer = await github.fetch(url, init)

    if (!ended && init.method === 'GET' && new URL(url).pathname === `/${prPath}`) {
      ended = true
      github.answer([prRoute({ head: { sha: NEW_HEAD } }), runsRoute(NEW_HEAD)])
      await driver.onDone(pr, 'fix', readyReport(NEW_HEAD), { run: 'A1-02-fix' })
    }

    return answer
  }

  setFetch(endingMidTick, { token: async () => MAINTAINER_TOKEN })
  await driver.tick()

  assert.ok(ended)
  assert.ok(!kindsSince(manifest).includes('claim-moved'), kindsSince(manifest).join(', '))
  assert.equal(driver.ledger.prs.A1.claimedSha, NEW_HEAD)
  assert.equal(github.requests().filter((request) => request.path === prPath).length, 3)
})

test('claimReport: a finding id in addressed never reaches GitHub, and the review comment is answered as before', async () => {
  const replies = 'repos/example/widgets/pulls/11/comments/55/replies'
  const { driver, pr, entry, github } = answeringDriver(
    [prRoute({ head: { sha: NEW_HEAD } }), { method: 'POST', path: replies, status: 201, body: { id: 56 } }],
    { feedbackInFix: [{ id: 'inline-5', commentId: 55, body: 'Rename this helper.' }] },
  )

  const addressed = [{ id: 'inline-5', action: 'Renamed it to parseTicket.' }, ANSWERS[0]]

  await driver.onDone(pr, 'fix', readyReport(NEW_HEAD, addressed), { run: 'A1-03-fix' })

  const sent = github.requests().map((request) => JSON.stringify(request.body))
  const writes = github.requests().filter((request) => request.method !== 'GET')

  assert.deepEqual(
    writes.map((request) => [request.method, request.path, request.body]),
    [['POST', replies, { body: `Renamed it to parseTicket. (b2b2b2b)\n\n${DRIVER_MARKER}` }]],
  )

  assert.ok(
    sent.every((body) => !body.includes('F1') && !body.includes(ANSWERS[0].action)),
    sent.join('\n'),
  )

  assert.deepEqual(entry.findings.items[0].answer, { outcome: 'fixed', action: ANSWERS[0].action })
  assert.deepEqual(
    entry.feedbackHandled.map((item) => [item.id, item.action]),
    [['inline-5', 'Renamed it to parseTicket.']],
  )
})

const PR_12_ROUTE = prRoute({ number: 12, head: { sha: NEW_HEAD } })
const FINDINGS = 'Blocking findings:\n- F1: cli.mjs:40 swallows the error.'
const FIXING = {
  state: 'fixing',
  pr: 11,
  claimedSha: SHA,
  sessionId: 'session-1',
  fixReason: 'verifier findings',
  fixNote: FINDINGS,
  attempts: { implement: 1, fix: 1, verify: 1, brief: 0 },
}

// A1's implementer run of `role` ends with `result`. `routes` answer for GitHub.
async function implementerEnds(state, role, result, routes = []) {
  const setup = tickDriver({ A1: state }, { routes })
  const entry = setup.driver.ledger.prs.A1

  await setup.driver.onDone(
    setup.manifest.prs.find((item) => item.id === 'A1'),
    role,
    result,
    { run: `A1-02-${role}` },
  )

  return { ...setup, entry }
}

function blockedEnding(blocked) {
  return agentResult({ output: { status: 'BLOCKED', summary: 'Blocked on a question.', blocked } })
}

test('implementer run: ready, the report matches GitHub', async () => {
  const { entry } = await implementerEnds(IMPLEMENTING, 'implement', READY, [PR_12_ROUTE])

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.deepEqual([entry.pr, entry.claimedSha, entry.status.sha], [12, NEW_HEAD, NEW_HEAD])
})

test('implementer run: ready, a note waits in the queue', async () => {
  const { entry } = await implementerEnds({ ...IMPLEMENTING, pendingNote: 'Keep the old flag.' }, 'implement', READY, [PR_12_ROUTE])

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.fix.reason, entry.fixReason], ['maintainer-note', 'answer from the maintainer'])
})

test('implementer run: ready, report-mismatch', async () => {
  const closed = prRoute({ number: 12, state: 'closed', head: { sha: NEW_HEAD } })
  const { entry } = await implementerEnds(IMPLEMENTING, 'implement', READY, [closed])

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.equal(entry.fix.reason, 'report-mismatch')
})

test('implementer run: ready, github-unavailable', async () => {
  const { entry } = await implementerEnds(IMPLEMENTING, 'implement', READY, [{ path: PR_12, status: 502 }])

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'github'])
  assert.deepEqual([entry.reportUnchecked, entry.ready], [true, READY.output])
})

test('implementer run: blocked: needs-decision, brief-contradiction or no kind', async () => {
  for (const kind of ['needs-decision', 'brief-contradiction', null]) {
    const blocked = kind ? { kind, question: 'Keep the old flag?', evidence: 'cli.mjs:12 reads it.' } : undefined
    const { entry } = await implementerEnds(IMPLEMENTING, 'implement', blockedEnding(blocked))

    assert.deepEqual(placeOf(entry), ['implement', 'needs-you', 'decision'], String(kind))
    assert.equal(entry.status.question.kind, kind ?? 'unknown')
  }
})

test('implementer run: blocked: environment, ci, code-scanning, stuck', async () => {
  for (const kind of ['environment', 'ci', 'code-scanning', 'stuck']) {
    const { entry } = await implementerEnds(FIXING, 'fix', blockedEnding({ kind, question: 'The runner has no Docker.', evidence: '' }))

    assert.deepEqual(placeOf(entry), ['implement', 'needs-you', 'obstacle'], kind)
    assert.equal(entry.status.question.kind, kind)
  }
})

test('implementer run: failed', async () => {
  const failure = agentResult({ ok: false, error: 'error_during_execution' })
  const implementing = (await implementerEnds(IMPLEMENTING, 'implement', failure)).entry
  const fixing = (await implementerEnds(FIXING, 'fix', failure)).entry

  for (const entry of [implementing, fixing]) {
    assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'backoff'])
    assert.equal(entry.status.until, entry.retryAfter)
  }

  assert.equal(implementing.fix.reason, 'no-report')
  assert.deepEqual([fixing.reportUnchecked, fixing.implementCutOff], [false, false])
  assert.deepEqual(
    [fixing.fix.reason, fixing.fix.note, fixing.fixReason, fixing.fixNote],
    ['verifier-findings', FINDINGS, 'verifier findings', FINDINGS],
  )
})

// A first implement run that failed, with its session lost or kept, then the next advance.
async function afterCutOff(sessionMissing) {
  const setup = modelDriver({
    A1: { state: 'implementing', sessionId: 'session-1', attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } },
  })

  const failure = agentResult({ ok: false, error: 'error_during_execution', sessionMissing, costUsd: 1, seconds: 120 })

  await setup.driver.onDone(setup.pr, 'implement', failure, { run: 'A1-01-implement' })

  const cutOff = { fix: setup.entry.fix.reason, implementCutOff: setup.entry.implementCutOff, sessionId: setup.entry.sessionId }

  setup.entry.retryAfter = null
  await setup.driver.advance(setup.pr)
  await waitFor(() => setup.calls.length === 1, 'the next run')

  return { cutOff, call: setup.calls[0] }
}

test('advance: an implement run cut off with its session lost runs implement again, and one with its session resumes as a fix', async () => {
  const lost = await afterCutOff(true)

  assert.deepEqual(lost.cutOff, { fix: 'no-report', implementCutOff: true, sessionId: null })
  assert.equal(lost.call.role, 'implement')

  const kept = await afterCutOff(false)

  assert.deepEqual(kept.cutOff, { fix: 'no-report', implementCutOff: true, sessionId: 'session-1' })
  assert.equal(kept.call.role, 'fix')
  assert.ok(kept.call.prompt.includes('previous run ended without a report'), kept.call.prompt)
})

test('implementer run: failed with stopped', async () => {
  const stopped = agentResult({ ok: false, error: 'stopped', stopped: true, costUsd: 0, seconds: 0 })
  const { entry } = await implementerEnds(FIXING, 'fix', stopped)

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.attempts.fix, entry.refunds, entry.retryAfter], [0, 1, null])
  assert.deepEqual(
    [entry.fix.reason, entry.fix.note, entry.fixReason, entry.fixNote],
    ['verifier-findings', FINDINGS, 'verifier findings', FINDINGS],
  )
})
