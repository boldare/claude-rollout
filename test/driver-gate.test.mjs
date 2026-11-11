import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyPrompt } from '../lib/prompts.mjs'
import { stageLabels } from '../lib/stage.mjs'
import { readEvents } from '../lib/view.mjs'
import { worktreePath } from '../lib/worktree.mjs'
import { at, samplePrs } from './fixtures.mjs'
import {
  agentResult,
  apply,
  SHA,
  MERGE_SHA,
  MERGED_PR,
  FETCH,
  prRoute,
  tickDriver,
  eventsSince,
  kindsSince,
  NEW_HEAD,
  REBASED,
  CLAIMED,
  verifiableDriver,
  gatesWith,
  COMMANDS_GATE,
  commandSeam,
  preVerified,
  FIRST_ROUND,
  UNANSWERED,
} from './driver-helpers.mjs'

test('mergeCandidate: a merge GitHub has not confirmed stays verified until a sync sees it merged', async () => {
  const earlier = { id: 'A3', sha: MERGE_SHA.replaceAll('f', 'c'), at: at(70), checked: 'green' }
  const { manifest, driver, tools, github, notices, cleaned } = tickDriver(
    { A1: { ...samplePrs().A1, held: null }, A3: { state: 'merged', pr: 13, mergeSha: earlier.sha } },
    {
      policy: { merge: 'auto' },
      rules: [{ tool: 'gh', args: 'pr merge 11', stdout: '' }],
      routes: [prRoute()],
    },
  )

  const pr = manifest.prs.find((item) => item.id === 'A1')
  const entry = driver.ledger.prs.A1
  driver.ledger.data.lastMerge = structuredClone(earlier)

  assert.equal(await driver.mergeCandidate(pr), true)

  const events = eventsSince(manifest)

  assert.ok(tools.calls().some((call) => call.args.join(' ').startsWith(`pr merge 11 --squash --match-head-commit ${SHA}`)))
  assert.equal(entry.state, 'verified')
  assert.equal(entry.gate.action, 'merge')
  assert.equal(entry.mergeSha, undefined)
  assert.deepEqual(driver.ledger.data.lastMerge, earlier)
  assert.deepEqual(cleaned, [])
  assert.deepEqual(notices, [])
  assert.deepEqual(events, [
    { id: 'A1', kind: 'gate-merge', code: 'merge', reasons: [] },
    { id: 'A1', kind: 'merge-unconfirmed', pr: 11, sha: SHA.slice(0, 7) },
  ])

  tools.answer([FETCH])
  github.answer([prRoute(MERGED_PR)])

  await driver.tick()

  assert.equal(entry.state, 'merged')
  assert.equal(entry.mergeSha, MERGE_SHA)
  assert.equal(driver.ledger.data.lastMerge.id, 'A1')
  assert.equal(driver.ledger.data.lastMerge.sha, MERGE_SHA)
  assert.deepEqual(cleaned, ['A1'])
  assert.deepEqual(notices, ['A1: merged PR #11'])
  assert.deepEqual(eventsSince(manifest, events.length), [{ id: 'A1', kind: 'merged', pr: 11 }])
})

test('mergeCandidate: a PR merged on GitHub while the gate reads it waits for sync, with no notification', async () => {
  const { manifest, driver, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  gate.pr = { state: 'MERGED' }

  assert.equal(await driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1')), false)
  assert.equal(driver.ledger.prs.A1.state, 'verified')
  assert.deepEqual(eventsSince(manifest), [
    { id: 'A1', kind: 'gate-wait', code: 'merged-on-github', reasons: ['merged on GitHub (the next sync records it)'] },
  ])

  assert.deepEqual(notices, [])
})

test('mergeCandidate: a merge GitHub refuses waits with the merge-refused code', async () => {
  const { manifest, driver, notices } = tickDriver(
    { A1: { ...samplePrs().A1, held: null } },
    {
      policy: { merge: 'auto' },
      rules: [
        {
          tool: 'gh',
          args: 'pr merge 11',
          code: 1,
          stderr: 'Pull request example/widgets#11 is not mergeable: the base branch policy prohibits the merge.\n',
        },
      ],
    },
  )

  const entry = driver.ledger.prs.A1

  assert.equal(await driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1')), false)
  assert.equal(entry.state, 'verified')
  assert.equal(entry.gate.action, 'wait')
  assert.equal(entry.gate.code, 'merge-refused')
  assert.deepEqual(entry.gate.reasons, ['GitHub refused the merge (ruleset)'])
  assert.deepEqual(kindsSince(manifest), ['gate-merge', 'merge-refused'])
  assert.deepEqual(notices, ['A1: GitHub refused to merge PR #11; check its ruleset requirements'])
})

test('mergeCandidate: a failed merge gh does not call a refusal is an error, whatever the PR title says', async () => {
  const { manifest, driver, gate } = tickDriver(
    { A1: { ...samplePrs().A1, held: null } },
    { policy: { merge: 'auto' }, rules: [{ tool: 'gh', args: 'pr merge 11', code: 1, stderr: 'HTTP 422: Validation Failed\n' }] },
  )

  gate.pr = { title: 'fix: say why a PR is not mergeable' }

  await assert.rejects(driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1')), /not mergeable \(#11\).* exited 1: HTTP 422/)
  assert.equal(driver.ledger.prs.A1.gate.code, 'merge')
  assert.deepEqual(kindsSince(manifest), ['gate-merge'])
})

// Holds none of the phrases the old notice regexes matched ("awaiting",
// "approve PR", "GitHub still blocks"), so only the code can pick a notice.
const PLAIN_REASON = 'the stub gate says no'

// A1 verified and not held, under a merge gate that answers `stub.verdict`.
function stubbedGate() {
  const stub = { verdict: null }
  const setup = tickDriver({ A1: { ...samplePrs().A1, held: null } }, { judge: () => stub.verdict })

  return { ...setup, stub, pr: setup.manifest.prs.find((item) => item.id === 'A1'), entry: setup.driver.ledger.prs.A1 }
}

test('mergeCandidate: each approval code sends one approval notice per patch, whatever its prose', async () => {
  for (const code of ['awaiting-github-review', 'stale-github-review', 'awaiting-inbox-approval']) {
    const { driver, pr, stub, notices } = stubbedGate()
    stub.verdict = { action: 'wait', code, reasons: [PLAIN_REASON] }

    assert.equal(await driver.mergeCandidate(pr), false)
    assert.equal(await driver.mergeCandidate(pr), false)
    assert.deepEqual(notices, [`A1: PR #11 is verified; ${PLAIN_REASON}`], code)
  }
})

test('mergeCandidate: changes-requested, or another code with approval prose, sends no approval notice', async () => {
  const verdicts = [
    { action: 'wait', code: 'changes-requested', reasons: [PLAIN_REASON] },
    { action: 'wait', code: 'ci-pending', reasons: ['awaiting a maintainer review on GitHub (approve PR #11)'] },
  ]

  for (const verdict of verdicts) {
    const { driver, pr, stub, notices } = stubbedGate()
    stub.verdict = verdict

    assert.equal(await driver.mergeCandidate(pr), false)
    assert.deepEqual(notices, [], verdict.code)
  }
})

test('mergeCandidate: github-blocked sends the ruleset notice once per head, ruleset prose under another code sends none', async () => {
  const blocked = stubbedGate()
  const notice = "A1: PR #11 passes the rollout gate, but GitHub's ruleset still blocks the merge"
  blocked.stub.verdict = { action: 'wait', code: 'github-blocked', reasons: [PLAIN_REASON] }

  await blocked.driver.mergeCandidate(blocked.pr)
  await blocked.driver.mergeCandidate(blocked.pr)

  assert.deepEqual(blocked.notices, [notice])

  blocked.gate.pr = { headRefOid: NEW_HEAD }
  await blocked.driver.mergeCandidate(blocked.pr)

  assert.deepEqual(blocked.notices, [notice, notice])

  const other = stubbedGate()
  other.stub.verdict = { action: 'wait', code: 'github-merge-state', reasons: ['GitHub still blocks the merge'] }

  await other.driver.mergeCandidate(other.pr)

  assert.deepEqual(other.notices, [])
})

test('mergeCandidate: a block with the code scanning code blocks as code scanning, any other code as the gate', async () => {
  const cases = [
    ['code-scanning', 'code-scanning'],
    ['pr-not-open', 'gate'],
  ]

  for (const [code, kind] of cases) {
    const { driver, pr, entry, stub } = stubbedGate()
    stub.verdict = { action: 'block', code, reasons: [PLAIN_REASON] }

    assert.equal(await driver.mergeCandidate(pr), false)
    assert.equal(entry.state, 'blocked', code)
    assert.equal(entry.blocked.kind, kind, code)
    assert.equal(entry.blocked.run, null, code)
  }
})

test('mergeCandidate: a fix with the code scanning code goes back as code scanning, any other code as the merge gate', async () => {
  const cases = [
    ['code-scanning', 'code scanning'],
    ['ci-red', 'merge gate'],
  ]

  for (const [code, reason] of cases) {
    const { driver, pr, entry, stub } = stubbedGate()
    stub.verdict = { action: 'fix', code, reasons: [PLAIN_REASON] }

    assert.equal(await driver.mergeCandidate(pr), false)
    assert.equal(entry.state, 'needs_fix', code)
    assert.equal(entry.fixReason, reason, code)
  }
})

test('mergeCandidate: a new gate event needs a new action or code, new prose alone only updates the stored reasons', async () => {
  const { manifest, driver, pr, entry, stub } = stubbedGate()
  const missing = 'CI pending (missing: test; running: -)'
  const running = 'CI pending (missing: -; running: test)'

  stub.verdict = { action: 'wait', code: 'ci-pending', reasons: [missing] }
  await driver.mergeCandidate(pr)
  stub.verdict = { action: 'wait', code: 'ci-pending', reasons: [running] }
  await driver.mergeCandidate(pr)

  assert.equal(entry.gate.code, 'ci-pending')
  assert.deepEqual(entry.gate.reasons, [running])
  assert.deepEqual(eventsSince(manifest), [{ id: 'A1', kind: 'gate-wait', code: 'ci-pending', reasons: [missing] }])

  stub.verdict = { action: 'wait', code: 'base-not-green', reasons: ['main is not green (pending)'] }
  await driver.mergeCandidate(pr)

  assert.deepEqual(eventsSince(manifest), [
    { id: 'A1', kind: 'gate-wait', code: 'ci-pending', reasons: [missing] },
    { id: 'A1', kind: 'gate-wait', code: 'base-not-green', reasons: ['main is not green (pending)'] },
  ])
})

test('mergeCandidate: a verified PR whose patch id the gate no longer matches is verified again, and its approval asked for again', async (context) => {
  const agents = []
  const sample = samplePrs().A1
  const emptyApproval = { ...sample.approved, patchId: '', channel: 'inbox' }
  const { manifest, driver } = tickDriver(
    { A1: { ...sample, held: null, verified: { ...sample.verified, patchId: '' }, approved: emptyApproval } },
    { runAgent: async (...call) => agents.push(call) },
  )

  context.after(() => rmSync(manifest.dir, { recursive: true, force: true }))

  const pr = manifest.prs.find((item) => item.id === 'A1')
  const entry = driver.ledger.prs.A1
  const gateBefore = entry.gate

  assert.equal(await driver.mergeCandidate(pr), false)
  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.verified, null)
  assert.equal(entry.claimedSha, SHA)
  assert.equal(entry.gate, gateBefore)
  assert.deepEqual(eventsSince(manifest), [{ id: 'A1', kind: 'head-moved-reverify', sha: SHA.slice(0, 7), reason: 'not-verified' }])
  assert.deepEqual(agents, [])

  entry.state = 'verified'
  entry.verified = { sha: SHA, patchId: 'patch-a1', at: at(90) }

  assert.equal(await driver.mergeCandidate(pr), false)
  assert.equal(entry.gate.code, 'awaiting-inbox-approval')
  assert.deepEqual(entry.approved, emptyApproval)
  assert.equal(kindsSince(manifest).filter((kind) => kind === 'head-moved-reverify').length, 1)
})

// Two verified PRs under merge: manual, both passing the gate on the same facts.
function twoReady(states = {}) {
  const verified = { ...samplePrs().A1, held: null, notified: {} }

  const rollout = tickDriver(
    { A1: { ...verified, ...states.A1 }, A3: { ...verified, pr: 13, ...states.A3 } },
    { policy: { merge: 'manual' } },
  )

  rollout.gate.pr = (pr, entry) => ({ number: entry.pr, headRefName: pr.branch })

  return rollout
}

test('mergeNext: under manual merge one PR is ready at a time, the next waits for it with a reason label', async () => {
  const { manifest, driver } = twoReady()

  await driver.mergeNext()

  assert.equal(driver.ledger.prs.A1.gate.action, 'ready')
  assert.equal(driver.ledger.prs.A1.gate.code, 'ready')
  assert.equal(driver.ledger.prs.A3.gate.action, 'wait')
  assert.equal(driver.ledger.prs.A3.gate.code, 'queued')
  assert.equal(driver.ledger.prs.A3.gate.after, 11)
  assert.match(driver.ledger.prs.A3.gate.reasons[0], /^after PR #11/)
  assert.deepEqual(
    eventsSince(manifest)
      .filter((event) => event.kind === 'ready-to-merge')
      .map((event) => event.id),
    ['A1'],
  )

  assert.deepEqual(stageLabels(driver.ledger.prs.A3), ['rollout-stage:verified', 'rollout-reason:queued'])
  assert.deepEqual(stageLabels(driver.ledger.prs.A1), ['rollout-stage:verified', 'rollout-reason:ready-to-merge'])
})

test('mergeNext: the PR already announced ready keeps the slot when an earlier one in the manifest becomes verified', async () => {
  const { driver } = twoReady({ A3: { gate: { action: 'ready', reasons: ['ready'], sha: SHA, at: at(83) } } })

  await driver.mergeNext()

  assert.equal(driver.ledger.prs.A3.gate.action, 'ready')
  assert.equal(driver.ledger.prs.A1.gate.action, 'wait')
  assert.equal(driver.ledger.prs.A1.gate.after, 13)
})

test('mergeNext: a "ready" from before a fix run holds no slot once the PR is verified again', async () => {
  const { driver } = twoReady({
    A1: { verified: { ...samplePrs().A1.verified, at: at(90) }, gate: { action: 'ready', reasons: ['ready'], sha: SHA, at: at(83) } },
    A3: { gate: { action: 'ready', reasons: ['ready'], sha: SHA, at: at(84) } },
  })

  await driver.mergeNext()

  assert.equal(driver.ledger.prs.A3.gate.action, 'ready')
  assert.equal(driver.ledger.prs.A1.gate.action, 'wait')
  assert.equal(driver.ledger.prs.A1.gate.after, 13)
})

// A3's worktree as prepareWorktree leaves it, with a fake git under which
// its rebase onto the new base succeeds at REBASED.
function rebasableWorktree(manifest, tools) {
  const wt = worktreePath(
    manifest,
    manifest.prs.find((pr) => pr.id === 'A3'),
  )

  const gitDir = join(wt, '.git')

  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(gitDir, 'rollout-ready'), '')
  tools.answer([
    { tool: 'git', args: 'rev-parse HEAD', stdout: REBASED },
    { tool: 'git', args: '', stdout: '' },
  ])
}

test('mergeNext: once the ready PR is merged, the one that waited is rebased and announced only when CI is green on the new head', async () => {
  const { manifest, driver, tools, gate } = twoReady()
  const readyNotices = (from) =>
    eventsSince(manifest, from)
      .filter((event) => event.kind === 'ready-to-merge')
      .map((event) => event.id)

  await driver.mergeNext()
  driver.ledger.prs.A1.state = 'merged'
  rebasableWorktree(manifest, tools)
  gate.facts = { baseIsAncestor: false }
  let before = readEvents(manifest).length
  await driver.mergeNext()

  assert.equal(driver.ledger.prs.A3.gate.action, 'rebase')
  assert.deepEqual(
    eventsSince(manifest, before).find((event) => event.kind === 'rebased'),
    { id: 'A3', kind: 'rebased', head: REBASED.slice(0, 7) },
  )

  assert.deepEqual(readyNotices(before), [])

  gate.pr = (pr, entry) => ({ number: entry.pr, headRefName: pr.branch, headRefOid: REBASED })
  gate.facts = { checks: { state: 'pending', missing: [], pending: ['test'], failing: [], runs: [] } }
  before = readEvents(manifest).length
  await driver.mergeNext()

  assert.equal(driver.ledger.prs.A3.gate.action, 'wait')
  assert.deepEqual(readyNotices(before), [])

  gate.facts = {}
  before = readEvents(manifest).length
  await driver.mergeNext()

  assert.equal(driver.ledger.prs.A3.gate.action, 'ready')
  assert.equal(driver.ledger.prs.A3.gate.after, undefined)
  assert.deepEqual(stageLabels(driver.ledger.prs.A3), ['rollout-stage:verified', 'rollout-reason:ready-to-merge'])
  assert.deepEqual(readyNotices(before), ['A3'])
})

test('mergeNext: under human merge nothing waits for another PR', async () => {
  const verified = { ...samplePrs().A1, held: null, notified: {} }
  const { driver, gate } = tickDriver(
    { A1: { ...verified }, A3: { ...verified, pr: 13 } },
    { policy: { merge: 'human', mergeDelaySeconds: 3600 } },
  )

  gate.pr = (pr, entry) => ({ number: entry.pr, headRefName: pr.branch })

  await driver.mergeNext()

  assert.equal(driver.ledger.prs.A3.gate.after, undefined)
  assert.notEqual(driver.ledger.prs.A3.gate.action, 'wait')
})

const NEW_FINDING = 'README.md:3 still names the old flag.'

// A1 under verification of SHA, with the findings of the FAIL before it and
// the implementer's answers. Its fake git shows a clean worktree at SHA, in a
// clone directory that git starts in.
function recheckDriver(state = {}) {
  const setup = tickDriver(
    {
      A1: {
        state: 'verifying',
        pr: 11,
        author: 'demo-bot',
        claimedSha: SHA,
        sessionId: 'session-1',
        attempts: { implement: 1, fix: 4, verify: 1, brief: 0 },
        findings: FIRST_ROUND,
        ...state,
      },
    },
    {
      rules: [
        { tool: 'git', args: 'status --porcelain', stdout: '' },
        { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
      ],
    },
  )

  const pr = setup.manifest.prs.find((item) => item.id === 'A1')

  mkdirSync(worktreePath(setup.manifest, pr), { recursive: true })

  return { ...setup, pr, entry: setup.driver.ledger.prs.A1 }
}

// The next verifier's FAIL on SHA, with `recheck` mapping each id to its status.
function recheckVerdict(recheck, overrides = {}) {
  return agentResult({
    output: {
      verdict: 'FAIL',
      sha: SHA,
      summary: 'A finding is still open.',
      checklist: [{ item: 'docs updated', status: 'fail', evidence: 'README.md:3' }],
      blocking: [NEW_FINDING],
      nonBlocking: [],
      recheck: Object.entries(recheck).map(([id, status]) => ({ id, status, evidence: `${id} is ${status} at a1a1a1a.` })),
      ...overrides,
    },
  })
}

function rechecked(setup, result) {
  return setup.driver.onDone(setup.pr, 'verify', result, { sha: SHA, run: 'A1-04-verify' })
}

test('verified: a disputed finding the next verifier still finds open escalates the PR, with no fix run', async () => {
  const setup = recheckDriver({ pendingNote: 'Keep the README short.' })
  const { manifest, entry, notices } = setup

  await rechecked(
    setup,
    recheckVerdict({ F1: 'resolved', F2: 'open' }, { blocking: ['The retry flag is still not documented.', NEW_FINDING] }),
  )

  assert.equal(entry.state, 'escalated')
  assert.equal(entry.escalation, 'disputed finding')
  assert.equal(entry.escalationRun, 'A1-04-verify')
  assert.ok(Date.parse(entry.escalatedAt) >= Date.parse(setup.driver.ledger.data.runs['A1-04-verify'].endedAt), entry.escalatedAt)
  assert.deepEqual(stageLabels(entry), ['rollout-stage:escalated', 'rollout-reason:disputed-finding'])
  assert.equal(
    entry.lastError,
    'the verifier still finds F2 open, which the implementer disputed: The retry flag is not documented. The implementer: The brief keeps the flag internal.',
  )

  assert.deepEqual(kindsSince(manifest), ['verify-done', 'escalated'])
  assert.deepEqual(eventsSince(manifest).at(-1), { id: 'A1', kind: 'escalated', reason: 'disputed finding', findings: ['F2'] })
  assert.equal(notices.length, 1)
  assert.match(notices[0], /^A1: the verifier still finds F2 open, which the implementer disputed\. /)
  assert.ok(notices[0].includes('rollout note A1') && notices[0].includes('rollout retry A1'), notices[0])

  assert.equal(entry.attempts.fix, 4)
  assert.equal(entry.verified, null)
  assert.equal(entry.pendingNote, 'Keep the README short.')
  assert.equal(entry.fixReason, 'verifier findings')
  assert.ok(entry.fixNote.includes(`- F1: The retry flag is still not documented.\n- F2: ${NEW_FINDING}\n`), entry.fixNote)
  assert.deepEqual(entry.findings.items, [
    { id: 'F1', text: 'The retry flag is still not documented.', answer: null },
    { id: 'F2', text: NEW_FINDING, answer: null },
  ])

  const [fixed, disputed] = FIRST_ROUND.items

  assert.deepEqual(entry.verdict.recheck, [
    { id: 'F1', status: 'resolved', evidence: 'F1 is resolved at a1a1a1a.', finding: fixed.text, answer: fixed.answer },
    { id: 'F2', status: 'open', evidence: 'F2 is open at a1a1a1a.', finding: disputed.text, answer: disputed.answer },
  ])
})

test('verified: a disputed finding the next verifier calls wrong never escalates', async () => {
  const failing = recheckDriver()

  await rechecked(failing, recheckVerdict({ F1: 'resolved', F2: 'wrong' }))

  assert.equal(failing.entry.state, 'needs_fix')
  assert.equal(failing.entry.fixReason, 'verifier findings')
  assert.equal(failing.entry.escalation, null)
  assert.deepEqual(kindsSince(failing.manifest), ['verify-done', 'needs-fix'])
  assert.deepEqual(failing.notices, [])
  assert.deepEqual(failing.entry.findings.items, [{ id: 'F1', text: NEW_FINDING, answer: null }])

  const passing = recheckDriver()
  const pass = { verdict: 'PASS', checklist: [{ item: 'docs updated', status: 'pass', evidence: 'README.md:3' }], blocking: [] }

  await rechecked(passing, recheckVerdict({ F1: 'resolved', F2: 'wrong' }, pass))

  assert.equal(passing.entry.state, 'verified')
  assert.equal(passing.entry.findings, null)
  assert.deepEqual(kindsSince(passing.manifest), ['verify-done', 'verified'])
  assert.deepEqual(
    passing.entry.verdict.recheck.map((item) => [item.id, item.status, item.finding]),
    [
      ['F1', 'resolved', FIRST_ROUND.items[0].text],
      ['F2', 'wrong', FIRST_ROUND.items[1].text],
    ],
  )
})

test('verified: an open finding reported fixed or left unanswered, or a dispute the re-check leaves out, goes to a fix run', async () => {
  const cases = [
    { name: 'reported fixed', findings: FIRST_ROUND, recheck: { F1: 'open', F2: 'resolved' } },
    { name: 'not answered', findings: UNANSWERED, recheck: { F1: 'open', F2: 'open' } },
    { name: 'left out', findings: FIRST_ROUND, recheck: { F1: 'resolved' } },
  ]

  for (const { name, findings, recheck } of cases) {
    const setup = recheckDriver({ findings })

    await rechecked(setup, recheckVerdict(recheck))

    assert.equal(setup.entry.state, 'needs_fix', name)
    assert.equal(setup.entry.fixReason, 'verifier findings', name)
    assert.equal(setup.entry.attempts.fix, 4, name)
    assert.deepEqual(kindsSince(setup.manifest), ['verify-done', 'needs-fix'], name)
    assert.deepEqual(setup.notices, [], name)
  }
})

test('verified: a PASS the driver discards, for a stale SHA or from a touched tree, keeps the findings for the next verifier', async () => {
  const stale = recheckDriver()
  const touched = recheckDriver()
  const pass = { verdict: 'PASS', blocking: [] }

  touched.tools.answer([
    { tool: 'git', args: 'status --porcelain', stdout: ' M lib/a.mjs' },
    { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
    { tool: 'git', args: 'reset', stdout: '' },
    { tool: 'git', args: 'clean', stdout: '' },
  ])

  await rechecked(stale, recheckVerdict({ F1: 'resolved', F2: 'wrong' }, { ...pass, sha: NEW_HEAD }))
  await rechecked(touched, recheckVerdict({ F1: 'resolved', F2: 'wrong' }, pass))

  assert.deepEqual(kindsSince(stale.manifest), ['verify-done', 'verify-stale'])
  assert.deepEqual(kindsSince(touched.manifest), ['verify-done', 'verifier-touched-tree'])

  for (const setup of [stale, touched]) {
    assert.equal(setup.entry.state, 'ready_claimed')
    assert.deepEqual(setup.entry.findings, FIRST_ROUND)
  }
})

test('verified: a reset logs the Claude Code files it removed before it discards the PASS', async () => {
  const setup = recheckDriver()
  const wt = worktreePath(setup.manifest, setup.pr)

  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, 'CLAUDE.local.md'), 'notes\n')
  setup.tools.answer([
    { tool: 'git', args: 'status --porcelain', stdout: '?? CLAUDE.local.md' },
    { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
    { tool: 'git', args: 'ls-files', stdout: '' },
    { tool: 'git', args: 'reset', stdout: '' },
    { tool: 'git', args: 'clean', stdout: '' },
  ])

  await rechecked(setup, recheckVerdict({ F1: 'resolved', F2: 'wrong' }, { verdict: 'PASS', blocking: [] }))

  assert.deepEqual(kindsSince(setup.manifest), ['verify-done', 'local-config-removed', 'verifier-touched-tree'])
  assert.deepEqual(eventsSince(setup.manifest)[1], { id: 'A1', kind: 'local-config-removed', paths: ['CLAUDE.local.md'] })
  assert.equal(existsSync(join(wt, 'CLAUDE.local.md')), false)
})

test('verified: a verdict without recheck is recorded with an empty one', async () => {
  const setup = recheckDriver({ findings: null })
  const { recheck: _, ...output } = recheckVerdict({}).output

  await rechecked(setup, agentResult({ output }))

  assert.deepEqual(setup.entry.verdict.recheck, [])
  assert.equal(setup.entry.state, 'needs_fix')
  assert.deepEqual(setup.entry.findings.items, [{ id: 'F1', text: NEW_FINDING, answer: null }])
})

const BRANCH_TEST = 'A new branch in the code has a test that fails without it.'
const NO_SEMICOLONS = 'No semicolons in prose.'
const DOCS_ROW = 'Docs: every new option has its row.'
const CRITERIA_GATE = gatesWith({ verify: { required: [BRANCH_TEST, NO_SEMICOLONS], recommended: [DOCS_ROW] } })
const VERIFY_CRITERIA = [
  { id: 'V1', level: 'required', text: BRANCH_TEST },
  { id: 'V2', level: 'required', text: NO_SEMICOLONS },
  { id: 'V3', level: 'recommended', text: DOCS_ROW },
]

// The next verifier's PASS on SHA, with `results` mapping each criterion id to its result.
function criteriaVerdict(results, overrides = {}) {
  return recheckVerdict(
    { F1: 'resolved', F2: 'wrong' },
    {
      verdict: 'PASS',
      checklist: [{ item: 'docs updated', status: 'pass', evidence: 'README.md:3' }],
      blocking: [],
      criteria: Object.entries(results).map(([id, result]) => ({ id, result, evidence: `${id} is ${result} at a1a1a1a.` })),
      ...overrides,
    },
  )
}

function criterionRecord(index, result, evidence = `${VERIFY_CRITERIA[index].id} is ${result} at a1a1a1a.`) {
  return { ...VERIFY_CRITERIA[index], result, evidence }
}

function criterionCheckEvent(record) {
  const { id, level, result, evidence } = record

  return { id: 'A1', kind: 'gate-check', stage: 'verify', item: id, level, result, sha: SHA.slice(0, 7), evidence }
}

test('checkClaim: the verifier starts with the project criteria fixed in the ledger and listed in its prompt', async () => {
  const { driver, pr, entry, prompts } = verifiableDriver({ gates: CRITERIA_GATE })

  await driver.advance(pr)

  assert.equal(entry.state, 'verifying')
  assert.deepEqual(entry.verifyCriteria, VERIFY_CRITERIA)
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].includes('\n## Project criteria\n\n'), prompts[0])
  assert.ok(
    prompts[0].includes(`\n\n- V1 (required): ${BRANCH_TEST}\n- V2 (required): ${NO_SEMICOLONS}\n- V3 (recommended): ${DOCS_ROW}\n`),
    prompts[0],
  )

  const plain = verifiableDriver()

  await plain.driver.advance(plain.pr)

  assert.deepEqual(plain.entry.verifyCriteria, [])
  assert.equal(plain.prompts[0].includes('\n## Project criteria\n'), false)
})

test('checkClaim: a pre-verify job does not fix the criteria, the verifier after it does', async () => {
  const seam = commandSeam()
  const setup = verifiableDriver({
    gates: gatesWith({ preVerify: COMMANDS_GATE.preVerify, verify: CRITERIA_GATE.verify }),
    runCommand: seam.runCommand,
  })

  const { driver, pr, entry, agentCalls, prompts } = setup

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm test', 'npm run lint'])
  assert.deepEqual(agentCalls, [])
  assert.equal(entry.verifyCriteria, null)

  await driver.advance(pr)

  assert.equal(entry.state, 'verifying')
  assert.deepEqual(entry.verifyCriteria, VERIFY_CRITERIA)
  assert.ok(prompts[0].includes(`- V1 (required): ${BRANCH_TEST}\n`), prompts[0])
})

const DOCS_STALE = 'Unchanged text in an edited doc agrees with the change.'
const UI_STATES = 'Every new UI control has an empty, loading and error state.'
const CATALOG = [
  '- id: docs-stale',
  `  criterion: ${DOCS_STALE}`,
  "  paths: ['docs/**', '*.md']",
  '- id: ui-states',
  `  criterion: ${UI_STATES}`,
  '  tags: [ui]',
  '- id: tests-fail-first',
  `  criterion: ${BRANCH_TEST}`,
  '',
].join('\n')

const CATALOG_GATE = gatesWith({ verify: { ...CRITERIA_GATE.verify, criteriaFrom: 'criteria.yaml' } })
const SHOW_CATALOG = 'show origin/main:criteria.yaml'
const CATALOG_RULE = { tool: 'git', args: SHOW_CATALOG, stdout: CATALOG }
const CATALOG_MISSING = {
  tool: 'git',
  args: SHOW_CATALOG,
  code: 128,
  stderr: "fatal: path 'criteria.yaml' does not exist in 'origin/main'\n",
}

const CATALOG_INVALID = { tool: 'git', args: SHOW_CATALOG, stdout: '- id: V1\n  criterion: A test per branch.\n' }
const MISSING_ERROR =
  "gates.verify.criteriaFrom criteria.yaml cannot be read from origin/main: fatal: path 'criteria.yaml' does not exist in 'origin/main'"

const INVALID_ERROR =
  "gates.verify.criteriaFrom criteria.yaml on origin/main is invalid: entry 1 (V1): V<n> and B<n> ids are the driver's own numbering"

function catalogReads(tools) {
  return tools.calls().filter((call) => call.tool === 'git' && call.args.includes('show'))
}

const criteriaIds = (entry) => entry.verifyCriteria.map((criterion) => criterion.id)

test('checkClaim: the catalog entries that apply follow the manifest criteria, read from origin/<base> in repo.path', async () => {
  const { manifest, driver, pr, entry, tools, prompts } = verifiableDriver({ gates: CATALOG_GATE, rules: [CATALOG_RULE] })

  await driver.advance(pr)

  assert.equal(entry.state, 'verifying')
  assert.deepEqual(criteriaIds(entry), ['V1', 'V2', 'V3', 'docs-stale', 'tests-fail-first'])
  assert.deepEqual(entry.verifyCriteria.slice(3), [
    { id: 'docs-stale', level: 'required', text: DOCS_STALE },
    { id: 'tests-fail-first', level: 'required', text: BRANCH_TEST },
  ])

  assert.deepEqual(catalogReads(tools), [{ tool: 'git', args: ['-C', manifest.repo.path, 'show', 'origin/main:criteria.yaml'] }])
  assert.ok(
    prompts[0].includes(
      `- V3 (recommended): ${DOCS_ROW}\n- docs-stale (required): ${DOCS_STALE}\n- tests-fail-first (required): ${BRANCH_TEST}\n`,
    ),
    prompts[0],
  )
})

test("checkClaim: the PR's briefTags pick the tagged catalog entries, in catalog order", async () => {
  const { driver, pr, entry, prompts } = verifiableDriver({ gates: CATALOG_GATE, rules: [CATALOG_RULE] })
  pr.briefTags = ['ui']

  await driver.advance(pr)

  assert.deepEqual(criteriaIds(entry), ['V1', 'V2', 'V3', 'docs-stale', 'ui-states', 'tests-fail-first'])
  assert.ok(prompts[0].includes(`- docs-stale (required): ${DOCS_STALE}\n- ui-states (required): ${UI_STATES}\n`), prompts[0])
})

test('checkClaim: without criteriaFrom, set to null or absent, no git call reads a catalog', async () => {
  for (const verify of [CRITERIA_GATE.verify, { required: [BRANCH_TEST], recommended: [] }]) {
    const { driver, pr, entry, tools } = verifiableDriver({ gates: { verify } })

    await driver.advance(pr)

    assert.equal(entry.state, 'verifying', JSON.stringify(verify))
    assert.deepEqual(catalogReads(tools), [], JSON.stringify(verify))
  }
})

test('checkClaim: the advance that starts the pre-verify job reads no catalog, the one that starts the verifier does', async () => {
  const seam = commandSeam()
  const setup = verifiableDriver({
    gates: gatesWith({ preVerify: COMMANDS_GATE.preVerify, verify: CATALOG_GATE.verify }),
    rules: [CATALOG_RULE],
    runCommand: seam.runCommand,
  })

  const { driver, pr, entry, tools } = setup

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm test', 'npm run lint'])
  assert.deepEqual(catalogReads(tools), [])

  await driver.advance(pr)

  assert.equal(entry.state, 'verifying')
  assert.deepEqual(criteriaIds(entry), ['V1', 'V2', 'V3', 'docs-stale', 'tests-fail-first'])
  assert.equal(catalogReads(tools).length, 1)
})

test('tick: a missing or invalid catalog is an error of that PR, no verifier starts and the other PRs go on', async () => {
  for (const [rule, message] of [
    [CATALOG_MISSING, MISSING_ERROR],
    [CATALOG_INVALID, INVALID_ERROR],
  ]) {
    const { manifest, driver, entry, agentCalls } = verifiableDriver({ gates: CATALOG_GATE, rules: [rule] })
    const earlier = VERIFY_CRITERIA.slice(0, 1)
    entry.verifyCriteria = earlier

    await driver.tick()

    const events = eventsSince(manifest)

    assert.deepEqual(
      agentCalls.filter((call) => call.role === 'verify'),
      [],
      message,
    )

    assert.equal(entry.state, 'ready_claimed')
    assert.deepEqual(entry.attempts, CLAIMED.attempts)
    assert.equal(entry.verifyCriteria, earlier)
    assert.deepEqual(
      events.filter((event) => event.id === 'A1' && event.kind === 'error'),
      [{ id: 'A1', kind: 'error', error: message, count: 1 }],
    )

    assert.equal(entry.tickErrors, 1)
    assert.equal(entry.lastError, message)
    assert.ok(
      events.some((event) => event.id === 'A3' && event.kind === 'brief-start'),
      JSON.stringify(events),
    )
  }
})

test('tick: a catalog that stays missing escalates the PR after five erroring ticks in a row', async () => {
  const { manifest, driver, entry, notices } = verifiableDriver({ gates: CATALOG_GATE, rules: [CATALOG_MISSING] })
  entry.tickErrors = 4

  await driver.tick()

  assert.equal(entry.tickErrors, 5)
  assert.equal(entry.state, 'escalated')
  assert.equal(entry.escalation, 'repeated errors')
  assert.ok(Number.isFinite(Date.parse(entry.escalatedAt)), entry.escalatedAt)
  assert.equal(entry.escalationRun, null)
  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.kind === 'escalated'),
    [{ id: 'A1', kind: 'escalated', reason: 'repeated errors' }],
  )

  assert.ok(
    notices.some((notice) => notice.startsWith('A1: repeated errors')),
    JSON.stringify(notices),
  )
})

test('checkClaim: once the catalog is fixed on the base, the next advance starts the verifier with its entries', async () => {
  const { driver, pr, entry, agentCalls, answer } = verifiableDriver({ gates: CATALOG_GATE, rules: [CATALOG_MISSING] })

  await assert.rejects(driver.advance(pr), { message: MISSING_ERROR })

  assert.equal(entry.state, 'ready_claimed')
  assert.deepEqual(agentCalls, [])

  answer([CATALOG_RULE])
  await driver.advance(pr)

  assert.equal(entry.state, 'verifying')
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])
  assert.deepEqual(criteriaIds(entry), ['V1', 'V2', 'V3', 'docs-stale', 'tests-fail-first'])
})

test('verified: a PASS with a failed required criterion is recorded as a FAIL and goes to a fix run with the criterion as a finding', async () => {
  const setup = recheckDriver({ verifyCriteria: VERIFY_CRITERIA })
  const { manifest, entry } = setup
  const finding = `V1 (required criterion): ${BRANCH_TEST} V1 is fail at a1a1a1a.`

  await rechecked(setup, criteriaVerdict({ V1: 'fail', V2: 'pass', V3: 'pass' }))

  assert.equal(entry.verdict.verdict, 'FAIL')
  assert.deepEqual(entry.verdict.blocking, [finding])
  assert.deepEqual(entry.verdict.criteria, [criterionRecord(0, 'fail'), criterionRecord(1, 'pass'), criterionRecord(2, 'pass')])
  assert.equal(entry.verdict.summary, 'A finding is still open.')
  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'verifier findings')
  assert.equal(entry.verified, null)
  assert.deepEqual(entry.findings.items, [{ id: 'F1', text: finding, answer: null }])
  assert.ok(entry.fixNote.includes(`Blocking findings:\n- F1: ${finding}\n`), entry.fixNote)

  const events = eventsSince(manifest)

  assert.deepEqual(
    events.map((event) => event.kind),
    ['verify-done', 'gate-check', 'gate-check', 'gate-check', 'needs-fix'],
  )

  assert.equal(events[0].result, 'PASS', "verify-done keeps the verifier's own verdict")
  assert.deepEqual(events.slice(1, 4), entry.verdict.criteria.map(criterionCheckEvent))
})

test("verified: a criterion finding comes after the verifier's own findings, which keep F1 and on", async () => {
  const setup = recheckDriver({ verifyCriteria: VERIFY_CRITERIA })
  const { entry } = setup
  const finding = `V2 (required criterion): ${NO_SEMICOLONS} V2 is fail at a1a1a1a.`

  await rechecked(setup, criteriaVerdict({ V1: 'pass', V2: 'fail', V3: 'pass' }, { verdict: 'FAIL', blocking: [NEW_FINDING] }))

  assert.equal(entry.verdict.verdict, 'FAIL')
  assert.deepEqual(entry.verdict.blocking, [NEW_FINDING, finding])
  assert.deepEqual(entry.findings.items, [
    { id: 'F1', text: NEW_FINDING, answer: null },
    { id: 'F2', text: finding, answer: null },
  ])

  assert.ok(entry.fixNote.includes(`Blocking findings:\n- F1: ${NEW_FINDING}\n- F2: ${finding}\n`), entry.fixNote)
})

test('verified: a required criterion the verifier left out or could not verify fails the PASS the same way', async () => {
  const cases = [
    {
      name: 'left out',
      results: { V2: 'pass', V3: 'pass' },
      record: criterionRecord(0, 'fail', 'The verifier did not report it.'),
      finding: `V1 (required criterion): ${BRANCH_TEST} The verifier did not report it.`,
    },
    {
      name: 'unverifiable',
      results: { V1: 'unverifiable', V2: 'pass', V3: 'pass' },
      record: criterionRecord(0, 'unverifiable'),
      finding: `V1 (required criterion): ${BRANCH_TEST} Unverifiable: V1 is unverifiable at a1a1a1a.`,
    },
  ]

  for (const { name, results, record, finding } of cases) {
    const setup = recheckDriver({ verifyCriteria: VERIFY_CRITERIA })
    const { manifest, entry } = setup

    await rechecked(setup, criteriaVerdict(results))

    assert.equal(entry.verdict.verdict, 'FAIL', name)
    assert.deepEqual(entry.verdict.criteria[0], record, name)
    assert.equal(entry.state, 'needs_fix', name)
    assert.equal(entry.fixReason, 'verifier findings', name)
    assert.deepEqual(entry.findings.items, [{ id: 'F1', text: finding, answer: null }], name)
    assert.deepEqual(eventsSince(manifest)[1], criterionCheckEvent(record), name)
    assert.equal(kindsSince(manifest).at(-1), 'needs-fix', name)
  }
})

test('verified: a PASS whose only failed criteria are recommended ends verified', async () => {
  for (const result of ['fail', 'unverifiable']) {
    const setup = recheckDriver({ verifyCriteria: VERIFY_CRITERIA })
    const { manifest, entry } = setup

    await rechecked(setup, criteriaVerdict({ V1: 'pass', V2: 'pass', V3: result }))

    assert.equal(entry.state, 'verified', result)
    assert.equal(entry.verdict.verdict, 'PASS', result)
    assert.deepEqual(entry.verdict.blocking, [], result)
    assert.deepEqual(entry.verdict.criteria[2], criterionRecord(2, result), result)
    assert.equal(entry.findings, null, result)
    assert.deepEqual(kindsSince(manifest), ['verify-done', 'gate-check', 'gate-check', 'gate-check', 'verified'], result)
    assert.deepEqual(eventsSince(manifest)[3], criterionCheckEvent(criterionRecord(2, result)), result)
  }
})

test('verified: the criteria gate-check events come after the reset and before the outcome, also when a dispute escalates', async () => {
  const touched = recheckDriver({ verifyCriteria: VERIFY_CRITERIA })
  const wt = worktreePath(touched.manifest, touched.pr)

  mkdirSync(wt, { recursive: true })
  writeFileSync(join(wt, 'CLAUDE.local.md'), 'notes\n')
  touched.tools.answer([
    { tool: 'git', args: 'status --porcelain', stdout: '?? CLAUDE.local.md' },
    { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
    { tool: 'git', args: 'ls-files', stdout: '' },
    { tool: 'git', args: 'reset', stdout: '' },
    { tool: 'git', args: 'clean', stdout: '' },
  ])

  await rechecked(touched, criteriaVerdict({ V1: 'fail', V2: 'pass', V3: 'pass' }))

  assert.equal(touched.entry.state, 'needs_fix', 'a FAIL is honoured from a touched tree')
  assert.ok(touched.entry.fixNote.endsWith('(it has been reset):\n?? CLAUDE.local.md'), touched.entry.fixNote)
  assert.deepEqual(kindsSince(touched.manifest), [
    'verify-done',
    'local-config-removed',
    'gate-check',
    'gate-check',
    'gate-check',
    'needs-fix',
  ])

  const disputed = recheckDriver({ verifyCriteria: VERIFY_CRITERIA })

  await rechecked(
    disputed,
    criteriaVerdict({ V1: 'pass', V2: 'fail', V3: 'pass' }, { recheck: [{ id: 'F2', status: 'open', evidence: 'open' }] }),
  )

  assert.equal(disputed.entry.state, 'escalated')
  assert.equal(disputed.entry.verdict.verdict, 'FAIL')
  assert.deepEqual(kindsSince(disputed.manifest), ['verify-done', 'gate-check', 'gate-check', 'gate-check', 'escalated'])
})

test('verified: a verdict without criteria is judged as before and recorded with none', async () => {
  const failing = recheckDriver()

  await rechecked(
    failing,
    recheckVerdict({ F1: 'resolved', F2: 'wrong' }, { criteria: [{ id: 'V1', result: 'fail', evidence: 'made up' }] }),
  )

  assert.deepEqual(failing.entry.verdict.criteria, [])
  assert.deepEqual(failing.entry.verdict.blocking, [NEW_FINDING])
  assert.deepEqual(kindsSince(failing.manifest), ['verify-done', 'needs-fix'])

  for (const verifyCriteria of [null, []]) {
    const passing = recheckDriver({ verifyCriteria })
    const { criteria: _, ...output } = criteriaVerdict({}).output

    await rechecked(passing, agentResult({ output }))

    assert.equal(passing.entry.state, 'verified')
    assert.deepEqual(passing.entry.verdict.criteria, [])
    assert.deepEqual(kindsSince(passing.manifest), ['verify-done', 'verified'])
  }
})

test('verified: a manifest reload while the verifier runs changes nothing, the criteria fixed at its launch judge the verdict', async () => {
  const pass = { verdict: 'PASS', sha: SHA, summary: 'Every item holds.', checklist: [], blocking: [], nonBlocking: [], recheck: [] }
  const removed = verifiableDriver({ gates: gatesWith({ verify: { required: [BRANCH_TEST] } }) })

  await removed.driver.advance(removed.pr)

  assert.equal(removed.entry.state, 'verifying')

  Object.assign(removed.manifest, { gates: gatesWith() })

  await removed.driver.onDone(
    removed.pr,
    'verify',
    agentResult({ output: { ...pass, criteria: [{ id: 'V1', result: 'fail', evidence: 'lib/a.mjs:12 adds a branch with no test.' }] } }),
    { sha: SHA, run: 'A1-02-verify' },
  )

  assert.equal(removed.entry.state, 'needs_fix')
  assert.equal(removed.entry.verdict.verdict, 'FAIL')
  assert.deepEqual(removed.entry.findings.items, [
    { id: 'F1', text: `V1 (required criterion): ${BRANCH_TEST} lib/a.mjs:12 adds a branch with no test.`, answer: null },
  ])

  const added = verifiableDriver()

  await added.driver.advance(added.pr)

  assert.equal(added.entry.state, 'verifying')

  Object.assign(added.manifest, { gates: gatesWith({ verify: { required: [NO_SEMICOLONS] } }) })

  await added.driver.onDone(added.pr, 'verify', agentResult({ output: { ...pass, criteria: [] } }), { sha: SHA, run: 'A1-02-verify' })

  assert.equal(added.entry.state, 'verified')
  assert.deepEqual(added.entry.verdict.criteria, [])
})

test('verified: after a criterion FAIL the next verifier re-checks the criterion finding', async () => {
  const setup = recheckDriver({ verifyCriteria: VERIFY_CRITERIA })
  const { manifest, pr, entry } = setup
  const finding = `V1 (required criterion): ${BRANCH_TEST} V1 is fail at a1a1a1a.`

  await rechecked(setup, criteriaVerdict({ V1: 'fail', V2: 'pass', V3: 'pass' }))

  const text = verifyPrompt(manifest, pr, entry, SHA)
  const section = text.indexOf('## Findings to re-check')

  assert.ok(section > text.indexOf('## Project criteria'))
  assert.ok(text.indexOf(`### F1\n\nFinding:\n\n${finding}\n\nNo answer from the implementer.`, section) > section, text.slice(section))
})

test('note: on a PR escalated over a dispute, the findings go to a fix run with the note, recorded as the answer to the dispute', async () => {
  const setup = recheckDriver()
  const { manifest, driver, pr, entry } = setup

  await rechecked(setup, recheckVerdict({ F1: 'resolved', F2: 'open' }))

  const dispute = entry.lastError
  const findings = entry.fixNote

  assert.deepEqual(apply(manifest, driver, { cmd: 'note', id: 'A1', text: 'Document the flag in the README.' }), [
    { id: 'A1', kind: 'needs-fix', reason: 'verifier findings' },
    { id: 'A1', kind: 'note-queued', state: 'needs_fix' },
  ])

  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'verifier findings')
  assert.equal(entry.fixNote, findings)
  assert.ok(findings.includes(`- F1: ${NEW_FINDING}`), findings)
  assert.equal(entry.pendingNote, 'Document the flag in the README.')
  assert.equal(entry.attempts.fix, 3)
  assert.match(dispute, /^the verifier still finds F2 open, which the implementer disputed: The retry flag is not documented\./)
  assert.deepEqual(
    entry.noteHistory.map(({ at: _, ...note }) => note),
    [{ by: 'maintainer', kind: 'disputed finding', question: dispute, text: 'Document the flag in the README.', run: null }],
  )

  assert.ok(
    verifyPrompt(manifest, pr, entry, SHA).includes(
      `### 1. From the maintainer, on disputed finding\n\nQuestion:\n\n${dispute}\n\nAnswer:\n\nDocument the flag in the README.`,
    ),
  )
})

test('retry: a PR escalated over a dispute goes to a fix run with the findings', async () => {
  const setup = recheckDriver({ interruptedRole: 'verify' })
  const { manifest, driver, entry } = setup

  await rechecked(setup, recheckVerdict({ F1: 'resolved', F2: 'open' }))

  const findings = entry.fixNote

  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [{ id: 'A1', kind: 'retry', state: 'needs_fix' }])
  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'verifier findings')
  assert.equal(entry.fixNote, findings)
  assert.equal(entry.interruptedRole, null)
  assert.deepEqual(entry.attempts, { implement: 0, fix: 0, verify: 0, brief: 0 })
})
