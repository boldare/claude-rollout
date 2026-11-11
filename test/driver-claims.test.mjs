import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDriver } from '../lib/driver.mjs'
import { DRIVER_MARKER, setFetch } from '../lib/github.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { verifyPrompt } from '../lib/prompts.mjs'
import { readEvents } from '../lib/view.mjs'
import { worktreePath } from '../lib/worktree.mjs'
import { at, fakeGitHub, fakeTools, makeRollout, samplePrs } from './fixtures.mjs'
import {
  agentResult,
  apply,
  SHA,
  FETCH,
  MAINTAINER_TOKEN,
  MERGED_PR,
  prRoute,
  runsRoute,
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

  assert.equal(entry.state, 'interrupted')
  assert.equal(entry.interruptedRole, 'report')
  assert.match(entry.lastError, /HTTP 502/)
  assert.deepEqual(
    events.map((event) => event.kind),
    ['implement-done', 'report-unchecked'],
  )

  assert.match(events[1].error, /HTTP 502/)
  assert.equal(entry.attempts.fix, 0)

  github.answer([prRoute({ number: 12, head: { sha: NEW_HEAD } })])
  await driver.tick()

  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.interruptedRole, null)
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

  assert.equal(entry.state, 'needs_fix')
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

  assert.equal(entry.state, 'interrupted')
  assert.equal(entry.interruptedRole, 'report')
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
  assert.equal(entry.state, 'interrupted')
  assert.equal(entry.interruptedRole, 'report')
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

  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'report does not match GitHub')
  assert.equal(entry.interruptedRole, null)
  assert.deepEqual(kindsSince(manifest), ['needs-fix'])
})

const GATE_BLOCK = { kind: 'gate', question: 'PR is a draft', evidence: '' }

test('retry: a PR whose verification still holds goes back to verified, keeps its hold, and the gate looks again with no agent', async () => {
  for (const state of [
    { state: 'escalated', tickErrors: 5 },
    { state: 'blocked', blocked: GATE_BLOCK },
  ]) {
    const { manifest, driver, gate } = tickDriver({ A1: { ...samplePrs().A1, ...state } }, { rules: [FETCH], routes: [prRoute()] })
    const entry = driver.ledger.prs.A1

    assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [{ id: 'A1', kind: 'retry', state: 'verified' }], state.state)
    assert.deepEqual(entry.verified, samplePrs().A1.verified, state.state)
    assert.equal(entry.interruptedRole, null, state.state)
    assert.ok(entry.held, state.state)

    await driver.tick()

    assert.equal(gate.calls, 1, state.state)
    assert.equal(driver.running.size, 0, state.state)
    assert.equal(entry.state, 'verified', state.state)
    assert.deepEqual(entry.attempts, { implement: 0, fix: 0, verify: 0, brief: 0 }, state.state)
  }
})

test('retry: a verification for an older head is dropped, and the PR goes back to its claim', () => {
  const stale = { ...samplePrs().A1, state: 'escalated', verified: { ...samplePrs().A1.verified, sha: NEW_HEAD }, ciPendingSince: at(85) }
  const { manifest, driver } = tickDriver({ A1: stale }, { rules: [FETCH], routes: [prRoute()] })
  const entry = driver.ledger.prs.A1

  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [{ id: 'A1', kind: 'retry', state: 'ready_claimed' }])
  assert.equal(entry.verified, null)
  assert.equal(entry.ciPendingSince, null)
  assert.equal(entry.interruptedRole, null)
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

  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixNote, 'Mark it ready for review.')
  assert.equal(entry.verified, null)
})

test('retry: a parked READY report stays parked, and the next tick claims it with no agent', async () => {
  const parked = { ...IMPLEMENTING, state: 'escalated', interruptedRole: 'report', ready: READY.output }
  const { manifest, driver } = tickDriver({ A1: parked }, { rules: [FETCH], routes: [prRoute({ number: 12, head: { sha: NEW_HEAD } })] })
  const entry = driver.ledger.prs.A1

  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [{ id: 'A1', kind: 'retry', state: 'interrupted' }])
  assert.equal(entry.interruptedRole, 'report')

  const before = readEvents(manifest).length
  await driver.tick()

  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.interruptedRole, null)
  assert.equal(entry.pr, 12)
  assert.equal(entry.claimedSha, NEW_HEAD)
  assert.equal(entry.attempts.fix, 0)
  assert.equal(driver.running.size, 0)
  assert.deepEqual(kindsSince(manifest, before), ['ready-claimed'])
})

test('sync: a head moved to another patch drops the verification, and the PR is claimed again at the new head', async () => {
  const { manifest, driver, gate } = tickDriver(samplePrs(), { rules: [FETCH], routes: [prRoute({ head: { sha: NEW_HEAD } })] })
  const entry = driver.ledger.prs.A1

  // A1 stays held, so the gate waits on held before its own re-verification
  // on not-verified could claim it again. Only sync claims it here.
  gate.pr = { headRefOid: NEW_HEAD }
  gate.facts = { patchId: 'patch-other' }
  await driver.tick()

  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.verified, null)
  assert.equal(entry.claimedSha, NEW_HEAD)
  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.kind === 'head-moved-reverify'),
    [{ id: 'A1', kind: 'head-moved-reverify', sha: NEW_HEAD.slice(0, 7), reason: 'new-patch' }],
  )
})

test('sync: a PR closed on GitHub is blocked as closed, with a notice', async () => {
  const { manifest, driver, notices } = tickDriver(samplePrs(), { rules: [FETCH], routes: [prRoute({ state: 'closed' })] })
  const entry = driver.ledger.prs.A1

  await driver.tick()

  // A gate that read the closed PR would block it too, as kind gate.
  assert.equal(entry.state, 'blocked')
  assert.equal(entry.blocked.kind, 'closed')
  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.kind === 'blocked'),
    [{ id: 'A1', kind: 'blocked', reason: 'closed' }],
  )

  assert.deepEqual(notices, ['A1: PR #11 was closed'])
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

    assert.equal(driver.ledger.prs.A1.state, 'ready_claimed', state)
    assert.deepEqual(kindsSince(manifest), [], state)
    assert.ok(!github.requests().some((request) => request.path.endsWith('/check-runs')), state)
    assert.equal(gate.calls, 0, state)
  }

  const { manifest, driver, github, gate } = tickDriver({ A1: claimed }, { routes: [prRoute(), runsRoute(SHA)] })

  gate.pr = { state: 'MERGED' }

  await driver.advance(manifest.prs.find((item) => item.id === 'A1'))

  assert.ok(github.requests().some((request) => request.path.endsWith('/check-runs')))
  assert.equal(gate.calls, 1)
  assert.equal(driver.ledger.prs.A1.state, 'ready_claimed')
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

    assert.equal(entry.state, 'needs_fix', state.state)
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

  assert.equal(entry.state, 'needs_fix')
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

  assert.equal(entry.state, 'blocked')
  assert.equal(entry.blocked.kind, 'code-scanning')
  assert.equal(entry.blocked.evidence, ALERT_REASON)
  assert.match(entry.blocked.question, /^PR #11 has new code scanning alerts\. Dismiss a false positive on GitHub and run rollout retry/)
  assert.equal(entry.verified, null)
  assert.equal(entry.claimPatchId, undefined)
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    gateCheckEvent('code-scanning', 'fail', ALERT_REASON),
    { id: 'A1', kind: 'blocked', reason: 'code-scanning' },
  ])

  assert.deepEqual(notices, [`A1: blocked (code-scanning): ${ALERT_REASON.slice(0, 120)}`])
})

test('checkClaim: an alert from an older commit waits for the analysis of the head, logged once', async () => {
  const { manifest, driver, pr, entry, notices } = claimDriver(scanned([scanAlert({ sha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2' })]))

  await driver.advance(pr)
  await driver.advance(pr)

  assert.equal(entry.state, 'ready_claimed')
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

  assert.equal(entry.state, 'ready_claimed')
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

    assert.equal(entry.state, 'ready_claimed', JSON.stringify(alerts))
    assert.equal(entry.claimPatchId, samplePrs().A1.verified.patchId, JSON.stringify(alerts))
    assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'gate-check'], JSON.stringify(alerts))
  }
})

const SCOPE_GATE = gatesWith({ preVerify: { scope: true } })

test('checkClaim: with gates.preVerify.scope, an undeclared file out of scope goes back to the implementer before the verifier', async () => {
  const { manifest, driver, pr, entry, agentCalls } = verifiableDriver({ gates: SCOPE_GATE })

  await driver.advance(pr)

  assert.equal(entry.state, 'needs_fix')
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

  assert.equal(entry.state, 'verifying')
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

  assert.equal(entry.state, 'verifying')
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

  assert.equal(entry.state, 'verifying')
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

test('checkClaim: red CI logs a failed ci check right before it goes back to the implementer', async () => {
  const { manifest, driver, github, pr, entry } = claimDriver({})
  const runs = {
    check_runs: [
      { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'lint', status: 'completed', conclusion: 'failure' },
    ],
  }

  github.answer([prRoute(), runsRoute(SHA, runs)])

  await driver.advance(pr)

  assert.equal(entry.state, 'needs_fix')
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'fail', 'failing: lint: failure'),
    { id: 'A1', kind: 'needs-fix', reason: 'CI is red' },
  ])
})

test('checkClaim: CI that does not settle logs a failed ci check right before it goes back to the implementer', async () => {
  const { manifest, driver, github, pr, entry } = claimDriver({})
  const running = { check_runs: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }

  entry.ciPendingSince = new Date(Date.now() - 60 * 60_000).toISOString()
  github.answer([prRoute(), runsRoute(SHA, running)])

  await driver.advance(pr)

  assert.equal(entry.state, 'needs_fix')
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'fail', 'not settled after 20 minutes (missing: none, running: test)'),
    { id: 'A1', kind: 'needs-fix', reason: 'CI did not settle' },
  ])
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

  entry.state = 'ready_claimed'
  entry.claimedAt = at(2)

  await driver.advance(pr)

  assert.equal(entry.state, 'needs_fix')
  assert.deepEqual(eventsSince(manifest), [...round, ...round])
})

test('checkClaim: a claim resumed after a fail, with no new READY, logs every check again', async () => {
  const { manifest, driver, pr, entry } = claimDriver(scanned([scanAlert()]))
  const round = [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    gateCheckEvent('code-scanning', 'fail', ALERT_REASON),
    { id: 'A1', kind: 'blocked', reason: 'code-scanning' },
  ]

  manifest.repo.codeScanning = { action: 'block', minSeverity: 'medium' }
  entry.claimedAt = at(1)

  await driver.advance(pr)

  entry.state = 'ready_claimed'

  await driver.advance(pr)

  assert.equal(entry.state, 'blocked')
  assert.equal(entry.claimedAt, at(1))
  assert.deepEqual(eventsSince(manifest), [...round, ...round])
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

test('mergeCandidate: a new code scanning alert drops the verification and goes back to the implementer', async () => {
  const { manifest, driver, gate } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  const entry = driver.ledger.prs.A1
  gate.facts = scanned([scanAlert()])

  assert.equal(await driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1')), false)
  assert.equal(entry.state, 'needs_fix')
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

test('mergeCandidate: with action block, a new code scanning alert blocks and drops the verification', async () => {
  const { manifest, driver, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  const entry = driver.ledger.prs.A1
  manifest.repo.codeScanning = { action: 'block', minSeverity: 'medium' }
  gate.facts = scanned([scanAlert()])

  assert.equal(await driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1')), false)
  assert.equal(entry.state, 'blocked')
  assert.equal(entry.blocked.kind, 'code-scanning')
  assert.equal(entry.blocked.evidence, ALERT_REASON)
  assert.equal(entry.verified, null)
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
  assert.equal(driver.ledger.prs.A1.state, 'verified')
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

  assert.equal(entry.state, 'ready_claimed')

  // CI was red on that head, and the fix run after it answered nothing.
  entry.state = 'fixing'
  await driver.onDone(pr, 'fix', readyReport(ciFixed), { run: 'A1-04-fix' })

  assert.equal(entry.state, 'ready_claimed')
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
    { state: 'needs_fix', routes: [{ path: pr11, ...NOT_FOUND }, REPOSITORY] },
    { state: 'interrupted', routes: [{ path: pr11, status: 502 }] },
  ]

  for (const { state, routes } of cases) {
    const { driver, pr, entry } = answeringDriver(routes)

    await driver.onDone(pr, 'fix', readyReport(NEW_HEAD, ANSWERS), { run: 'A1-03-fix' })

    assert.equal(entry.state, state)
    assert.deepEqual(entry.findings, FIRST_ROUND, state)
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
