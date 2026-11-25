import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarizeChecks } from '../lib/checks.mjs'
import { GATE_CODES } from '../lib/judge.mjs'
import { verifyPrompt } from '../lib/prompts.mjs'
import { matchKey } from '../lib/review.ts'
import { stageLabels } from '../lib/stage.mjs'
import { toMerged, toVerified } from '../lib/transitions.ts'
import { readEvents } from '../lib/view.mjs'
import { worktreePath } from '../lib/worktree.mjs'
import { at, laterReview, samplePrs, zipArchive } from './fixtures.mjs'
import {
  agentResult,
  apply,
  SHA,
  MERGE_SHA,
  MERGED_PR,
  FETCH,
  MERGE_RULE,
  mergeCalls,
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
  REVIEW_CHECK,
  EXTERNAL_FINDINGS,
  ARTIFACTS,
  HIGH,
  MEDIUM,
  LOW,
  storedFinding,
  reviewJson,
  artifactJson,
  listRoute,
  zipRoutes,
  artifactRequests,
  TRACE_COMMENTS,
  traceRoutes,
  commentRequests,
  writtenTraces,
  MAINTAINER_TOKEN,
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
  assert.deepEqual(placeOf(entry), ['merge', 'running', 'merge'])
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

  assert.deepEqual(placeOf(entry), ['merged', null, null])
  assert.equal(entry.mergeSha, MERGE_SHA)
  assert.equal(driver.ledger.data.lastMerge.id, 'A1')
  assert.equal(driver.ledger.data.lastMerge.sha, MERGE_SHA)
  assert.deepEqual(cleaned, ['A1'])
  assert.deepEqual(notices, ['A1: merged PR #11'])
  assert.deepEqual(eventsSince(manifest, events.length), [{ id: 'A1', kind: 'merged', pr: 11 }])
})

test('mergeCandidate: a merge GitHub confirms is recorded as merged, with its commit as the last merge, and cleaned up', async () => {
  const { manifest, driver, tools, cleaned } = tickDriver(
    { A1: { ...samplePrs().A1, held: null } },
    { policy: { merge: 'auto' }, rules: [MERGE_RULE], routes: [prRoute(MERGED_PR)] },
  )

  const pr = manifest.prs.find((item) => item.id === 'A1')
  const entry = driver.ledger.prs.A1

  assert.equal(await driver.mergeCandidate(pr), true)
  assert.equal(mergeCalls(tools).length, 1)
  assert.deepEqual(placeOf(entry), ['merged', null, null])
  assert.equal(entry.mergeSha, MERGE_SHA)
  assert.equal(driver.ledger.data.lastMerge.id, 'A1')
  assert.equal(driver.ledger.data.lastMerge.sha, MERGE_SHA)
  assert.deepEqual(cleaned, ['A1'])
  assert.deepEqual(eventsSince(manifest).at(-1), { id: 'A1', kind: 'merged', pr: 11, sha: MERGE_SHA.slice(0, 7) })
})

// A1 approved and unheld under merge auto with policy.trace comment, on a GitHub that shows the PR merged.
function tracedMerge(traceRoutesUsed) {
  const setup = tickDriver(
    { A1: { ...samplePrs().A1, held: null } },
    { policy: { merge: 'auto', trace: 'comment' }, rules: [MERGE_RULE], routes: [prRoute(MERGED_PR), ...traceRoutesUsed] },
  )

  return { ...setup, pr: setup.manifest.prs.find((item) => item.id === 'A1'), entry: setup.driver.ledger.prs.A1 }
}

test('mergeCandidate: a trace that cannot be written is logged before the merge, and the merge still happens', async () => {
  const failing = [
    { path: TRACE_COMMENTS, status: 500, body: { message: 'Server Error' } },
    { method: 'POST', path: TRACE_COMMENTS, status: 500, body: { message: 'Server Error' } },
  ]

  const { manifest, driver, tools, pr, entry } = tracedMerge(failing)

  assert.equal(await driver.mergeCandidate(pr), true)
  assert.equal(mergeCalls(tools).length, 1)
  assert.deepEqual(placeOf(entry), ['merged', null, null])
  assert.match(entry.trace.error, /^GET repos\/example\/widgets\/issues\/11\/comments: HTTP 500: Server Error$/)

  const events = eventsSince(manifest)

  assert.deepEqual(
    events.map((event) => event.kind),
    ['gate-merge', 'trace-failed', 'merged'],
  )

  assert.deepEqual(events[1], { id: 'A1', kind: 'trace-failed', error: entry.trace.error })
})

test('mergeCandidate: the trace written right before the merge shows the merge running', async () => {
  const { driver, github, tools, pr, entry } = tracedMerge(traceRoutes())

  assert.equal(await driver.mergeCandidate(pr), true)
  assert.equal(mergeCalls(tools).length, 1)
  assert.deepEqual(commentRequests(github), [
    ['GET', TRACE_COMMENTS],
    ['POST', TRACE_COMMENTS],
  ])

  const [written] = writtenTraces(github)

  assert.deepEqual(written.place, { stage: 'merge', status: 'running', code: 'merge' })
  assert.equal(written.merged, null)
  assert.deepEqual([entry.trace.comment, entry.trace.at, entry.trace.error], [901, written.updated_at, null])
})

test('mergeNext: unread maintainer feedback holds the merge, and the PR merges once it is read', async () => {
  const { driver, tools, gate } = tickDriver({ A1: { ...samplePrs().A1, held: null } }, { rules: [MERGE_RULE], routes: [prRoute()] })
  const entry = driver.ledger.prs.A1

  entry.feedbackWaiting = true
  await driver.mergeNext()

  assert.equal(gate.calls, 0)
  assert.deepEqual(mergeCalls(tools), [])

  entry.feedbackWaiting = false
  await driver.mergeNext()

  assert.equal(mergeCalls(tools).length, 1)
})

test('mergeCandidate: a PR merged on GitHub while the gate reads it waits for sync, with no notification', async () => {
  const { manifest, driver, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  gate.pr = { state: 'MERGED' }

  assert.equal(await driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1')), false)
  assert.deepEqual(placeOf(driver.ledger.prs.A1), ['merge', 'waiting', 'gate-pending'])
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
  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'merge-refused'])
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
    ['code-scanning', 'code-scanning-alerts'],
    ['pr-not-open', 'gate-blocked'],
  ]

  for (const [code, blocked] of cases) {
    const { driver, pr, entry, stub } = stubbedGate()
    stub.verdict = { action: 'block', code, reasons: [PLAIN_REASON] }

    assert.equal(await driver.mergeCandidate(pr), false)
    assert.deepEqual(placeOf(entry), ['merge', 'needs-you', blocked], code)
  }
})

test('mergeCandidate: a fix from the gate goes back named by its cause, never as the merge gate', async () => {
  const cases = [
    ['code-scanning', 'code scanning', 'code-scanning'],
    ['ci-red', 'CI is red', 'ci-red'],
    ['policy-violations', 'rollout policy', 'policy'],
  ]

  for (const [code, reason, fixCode] of cases) {
    const { driver, pr, entry, stub } = stubbedGate()
    stub.verdict = { action: 'fix', code, reasons: [PLAIN_REASON] }

    assert.equal(await driver.mergeCandidate(pr), false)
    assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'], code)
    assert.equal(entry.fixReason, reason, code)
    assert.equal(entry.fix.reason, fixCode, code)
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

  stub.verdict = { action: 'wait', code: 'base-pending', reasons: ['main is not green (pending)'] }
  await driver.mergeCandidate(pr)

  assert.deepEqual(eventsSince(manifest), [
    { id: 'A1', kind: 'gate-wait', code: 'ci-pending', reasons: [missing] },
    { id: 'A1', kind: 'gate-wait', code: 'base-pending', reasons: ['main is not green (pending)'] },
  ])
})

test('mergeCandidate: a verified PR whose patch id the gate no longer matches is verified again, without its approval', async (context) => {
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
  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.equal(entry.verified, null)
  assert.equal(entry.approved, null)
  assert.equal(entry.claimedSha, SHA)
  assert.equal(entry.gate, gateBefore)
  assert.deepEqual(eventsSince(manifest), [{ id: 'A1', kind: 'head-moved-reverify', sha: SHA.slice(0, 7), reason: 'not-verified' }])
  assert.deepEqual(agents, [])

  toVerified(entry, { sha: SHA, at: at(90) })
  entry.verified.patchId = 'patch-a1'

  assert.equal(await driver.mergeCandidate(pr), false)
  assert.equal(entry.gate.code, 'awaiting-inbox-approval')
  assert.equal(entry.approved, null)
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

test('mergeNext: under manual merge one PR is ready at a time, the next waits for it with a status label', async () => {
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

  assert.deepEqual(stageLabels(driver.ledger.prs.A3), ['rollout-stage:merge', 'rollout-status:queued'])
  assert.deepEqual(stageLabels(driver.ledger.prs.A1), ['rollout-stage:merge', 'rollout-status:merge-by-hand'])
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
  toMerged(driver.ledger.prs.A1)
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
  assert.deepEqual(stageLabels(driver.ledger.prs.A3), ['rollout-stage:merge', 'rollout-status:merge-by-hand'])
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

function placeOf(entry) {
  return [entry.stage, entry.status?.kind ?? null, entry.status?.code ?? null]
}

const RED = { state: 'red', missing: [], pending: [], failing: ['test: failure'], runs: [] }
const PENDING = { state: 'pending', missing: ['lint'], pending: ['test'], failing: [], runs: [] }
const BLOCK_CODES = ['no-pr', 'pr-not-open', 'never-merge', 'draft', 'wrong-base', 'wrong-head', 'missing-label']
const REFUSAL = {
  tool: 'gh',
  args: 'pr merge 11',
  code: 1,
  stderr: 'Pull request example/widgets#11 is not mergeable: the base branch policy prohibits the merge.\n',
}

// A code scanning alert as alertsFrom maps it, on A1's head unless `sha` says otherwise.
function scanAlert(sha = SHA) {
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
    sha,
  }
}

function scanned(alerts) {
  return { codeScanning: { available: true, alerts, baseOpen: [] } }
}

// A1 verified and not held, judged once by the merge gate on facts it merges
// on, with `facts` and `pr` on top. Merges are auto unless `policy` says otherwise.
async function judgedOnce({
  facts = {},
  pr = {},
  policy = {},
  fields = {},
  rules = [],
  routes = [],
  readyTaken = null,
  codeScanning,
  externalFindings,
} = {}) {
  const setup = tickDriver({ A1: { ...samplePrs().A1, held: null, ...fields } }, { policy: { merge: 'auto', ...policy }, rules, routes })
  const manifestPr = setup.manifest.prs.find((item) => item.id === 'A1')

  if (codeScanning) {
    setup.manifest.repo.codeScanning = codeScanning
  }

  if (externalFindings) {
    withReviewKey(setup.manifest, externalFindings)
  }

  setup.gate.facts = facts
  setup.gate.pr = pr

  const acted = await setup.driver.mergeCandidate(manifestPr, { readyTaken })

  return { ...setup, pr: manifestPr, entry: setup.driver.ledger.prs.A1, acted }
}

// The same verdict judged once by a stubbed gate.
async function stubbedOnce(verdict) {
  const setup = stubbedGate()

  setup.stub.verdict = verdict
  await setup.driver.mergeCandidate(setup.pr)

  return setup
}

test('merge gate: held', async () => {
  const { entry } = await judgedOnce({ fields: { held: samplePrs().A1.held } })

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'held'])
  assert.deepEqual([entry.gate.code, entry.status.scope], ['held', 'pr'])
})

test('merge gate: halted', async () => {
  assert.ok(!GATE_CODES.includes('halted'))

  const { entry } = await judgedOnce({ facts: { mainChecks: { ...RED, sha: MERGE_SHA } } })

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'base-red'])
  assert.deepEqual([entry.status.sha, entry.status.failing], [MERGE_SHA, ['test: failure']])
})

test('merge gate: deps-pending', async () => {
  const { entry } = await judgedOnce({ facts: { depsPending: ['A3'] } })

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'dependencies'])
  assert.deepEqual(entry.status.on, ['A3'])
})

test('merge gate: ci-pending', async () => {
  const { entry } = await judgedOnce({ facts: { checks: PENDING } })

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'ci'])
  assert.deepEqual([entry.status.sha, entry.status.missing, entry.status.pending], [SHA, ['lint'], ['test']])
})

test('merge gate: base-not-green', async () => {
  const red = await judgedOnce({ facts: { mainChecks: { ...RED, sha: MERGE_SHA } } })

  assert.deepEqual(placeOf(red.entry), ['merge', 'waiting', 'base-red'])

  const pending = await judgedOnce({ facts: { mainChecks: { ...PENDING, sha: MERGE_SHA } } })

  assert.deepEqual(placeOf(pending.entry), ['merge', 'waiting', 'base-pending'])
  assert.equal(pending.entry.status.sha, MERGE_SHA)
})

test('merge gate: mergeable-unknown', async () => {
  const { entry } = await judgedOnce({ pr: { mergeable: 'UNKNOWN' } })

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'mergeable-unknown'])
})

test('merge gate: github-merge-state', async () => {
  const { entry } = await judgedOnce({ pr: { mergeStateStatus: 'BEHIND' } })

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'github-merge-state'])
  assert.equal(entry.status.mergeState, 'BEHIND')
})

test('merge gate: code-scanning with action wait', async () => {
  const { entry } = await judgedOnce({ facts: scanned([scanAlert(NEW_HEAD)]) })

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'code-scanning-pending'])
  assert.equal(entry.status.sha, SHA)
})

test("merge gate: queued, the driver's code", async () => {
  const { entry } = await judgedOnce({ policy: { merge: 'manual' }, readyTaken: 13 })

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'queued'])
  assert.equal(entry.status.after, 13)
})

test('merge gate: the delay after an approval', async () => {
  const approved = { sha: SHA, patchId: 'patch-a1', at: new Date().toISOString(), channel: 'inbox' }
  const { entry, tools } = await judgedOnce({ policy: { merge: 'human', mergeDelaySeconds: 3600 }, fields: { approved } })

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'merge-delay'])
  assert.equal(entry.status.until, new Date(Date.parse(approved.at) + 3_600_000).toISOString())
  assert.deepEqual(mergeCalls(tools), [])
})

test('merge gate: awaiting-inbox-approval', async () => {
  const { entry } = await judgedOnce({ policy: { merge: 'human' }, fields: { approved: null } })

  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'approve'])
})

const LOGIN = 'demo-maintainer'
const REVIEW_ID = 7700112233
const REVIEWS = 'repos/example/widgets/pulls/11/reviews'
const USER_ROUTE = { path: 'user', body: { login: LOGIN } }
const REVIEW_ROUTE = { method: 'POST', path: REVIEWS, body: { id: REVIEW_ID } }
const REFUSED_REVIEW = { method: 'POST', path: REVIEWS, status: 422, body: { message: 'Unprocessable Entity' } }
const REFUSAL_TEXT = 'POST repos/example/widgets/pulls/11/reviews: HTTP 422: Unprocessable Entity'
const REVIEW_BODY = `Approved through \`rollout approve\` at ${SHA}.\n\n<!-- rollout-driver -->`

// A rollout approve of A1 at `approvedAt`, with `fields` on top.
function inboxApproval(approvedAt, fields = {}) {
  return { sha: SHA, patchId: 'patch-a1', at: approvedAt, channel: 'inbox', ...fields }
}

// A1 under merge: human with an inbox approval, judged once. An old approval
// merges in that call, a fresh one waits for an hour of merge delay.
function approvedOnce({ fresh = false, routes = [], fields = {}, pr = {} } = {}) {
  const approved = inboxApproval(fresh ? new Date().toISOString() : at(81), fields)
  const policy = fresh ? { merge: 'human', mergeDelaySeconds: 3600 } : { merge: 'human' }
  const githubRoutes = fresh ? routes : [prRoute(MERGED_PR), ...routes]

  return judgedOnce({ policy, fields: { approved }, rules: [MERGE_RULE], routes: githubRoutes, pr })
}

// The requests for the driver's login and for the PR's reviews, as [method, path].
function reviewRequests(github) {
  return github
    .requests()
    .filter((request) => request.path === 'user' || request.path === REVIEWS)
    .map((request) => [request.method, request.path])
}

function reviewKinds(manifest) {
  return kindsSince(manifest).filter((kind) => kind.startsWith('github-review-') || kind === 'error')
}

function reviewState(approved) {
  return { by: approved.by, review: approved.review, reviewError: approved.reviewError }
}

test('merge gate: rollout approve becomes one approving review as the maintainer, at the approved commit, and the PR merges in the same call', async () => {
  const { manifest, entry, github, tools, acted } = await approvedOnce({ routes: [USER_ROUTE, REVIEW_ROUTE] })
  const posts = github.requests().filter((request) => request.method === 'POST' && request.path === REVIEWS)

  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].body, { commit_id: SHA, event: 'APPROVE', body: REVIEW_BODY })
  assert.equal(posts[0].headers.authorization, `Bearer ${MAINTAINER_TOKEN}`)
  assert.deepEqual(reviewState(entry.approved), { by: LOGIN, review: REVIEW_ID, reviewError: null })
  assert.deepEqual(
    eventsSince(manifest).filter((event) => event.kind.startsWith('github-review-')),
    [{ id: 'A1', kind: 'github-review-submitted', review: REVIEW_ID, sha: SHA.slice(0, 7) }],
  )

  assert.equal(acted, true)
  assert.equal(mergeCalls(tools).length, 1)
  assert.deepEqual(placeOf(entry), ['merged', null, null])
})

test('merge gate: inside the merge delay the review goes out once, and a second pass asks GitHub for neither the login nor a review', async () => {
  const { manifest, driver, pr, entry, github } = await approvedOnce({ fresh: true, routes: [USER_ROUTE, REVIEW_ROUTE] })

  await driver.mergeCandidate(pr)

  assert.deepEqual(reviewRequests(github), [
    ['GET', 'user'],
    ['POST', REVIEWS],
  ])

  assert.deepEqual(reviewState(entry.approved), { by: LOGIN, review: REVIEW_ID, reviewError: null })
  assert.deepEqual(reviewKinds(manifest), ['github-review-submitted'])
  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'merge-delay'])
})

test('merge gate: a refused review is kept on the approval and logged once, holds nothing, and a later pass that GitHub accepts clears it', async () => {
  const { manifest, driver, pr, entry, github } = await approvedOnce({ fresh: true, routes: [USER_ROUTE, REFUSED_REVIEW] })
  const lastError = entry.lastError

  await driver.mergeCandidate(pr)

  assert.deepEqual(reviewState(entry.approved), { by: LOGIN, review: undefined, reviewError: REFUSAL_TEXT })
  assert.deepEqual(reviewKinds(manifest), ['github-review-failed'])
  assert.deepEqual(eventsSince(manifest).find((event) => event.kind === 'github-review-failed').error, REFUSAL_TEXT)
  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'merge-delay'])
  assert.equal(entry.lastError, lastError)
  assert.deepEqual(reviewRequests(github), [
    ['GET', 'user'],
    ['POST', REVIEWS],
    ['POST', REVIEWS],
  ])

  github.answer([USER_ROUTE, REVIEW_ROUTE])
  await driver.mergeCandidate(pr)

  assert.deepEqual(reviewState(entry.approved), { by: LOGIN, review: REVIEW_ID, reviewError: null })
  assert.deepEqual(reviewKinds(manifest), ['github-review-failed', 'github-review-submitted'])
})

test('merge gate: a refused review does not stop the merge once the delay passed', async () => {
  const { manifest, entry, tools, acted } = await approvedOnce({ routes: [USER_ROUTE, REFUSED_REVIEW] })

  assert.equal(acted, true)
  assert.equal(mergeCalls(tools).length, 1)
  assert.deepEqual(placeOf(entry), ['merged', null, null])
  assert.deepEqual(reviewState(entry.approved), { by: LOGIN, review: undefined, reviewError: REFUSAL_TEXT })
  assert.deepEqual(reviewKinds(manifest), ['github-review-failed'])
})

test("merge gate: the driver's own PR gets no review, its login is recorded and an earlier login error is cleared", async () => {
  const earlier = { reviewError: "the driver's login is unknown: GET user: HTTP 500: Server Error" }
  const { manifest, entry, github } = await approvedOnce({
    fresh: true,
    fields: earlier,
    routes: [{ path: 'user', body: { login: 'demo-bot' } }],
  })

  assert.deepEqual(reviewRequests(github), [['GET', 'user']])
  assert.deepEqual(reviewState(entry.approved), { by: 'demo-bot', review: undefined, reviewError: null })
  assert.deepEqual(reviewKinds(manifest), [])
})

test('merge gate: a login GitHub does not give holds nothing, and the next pass reads it again and submits the review', async () => {
  const failing = { path: 'user', status: 500, body: { message: 'Server Error' } }
  const { manifest, driver, pr, entry, github } = await approvedOnce({ fresh: true, routes: [failing, REVIEW_ROUTE] })

  assert.deepEqual(reviewRequests(github), [['GET', 'user']])
  assert.ok(entry.approved.reviewError.startsWith("the driver's login is unknown: "), entry.approved.reviewError)
  assert.equal(entry.approved.by, undefined)
  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'merge-delay'])

  github.answer([USER_ROUTE, REVIEW_ROUTE])
  await driver.mergeCandidate(pr)

  assert.deepEqual(reviewRequests(github), [
    ['GET', 'user'],
    ['GET', 'user'],
    ['POST', REVIEWS],
  ])

  assert.deepEqual(reviewState(entry.approved), { by: LOGIN, review: REVIEW_ID, reviewError: null })
  assert.deepEqual(reviewKinds(manifest), ['github-review-failed', 'github-review-submitted'])
})

test('merge gate: a held PR, and an approval that already has its login and review, ask GitHub for neither', async () => {
  const done = { by: LOGIN, review: REVIEW_ID, reviewError: null }
  const held = await judgedOnce({
    policy: { merge: 'human' },
    fields: { held: samplePrs().A1.held, approved: inboxApproval(at(81)) },
    routes: [USER_ROUTE, REVIEW_ROUTE],
  })

  const reviewed = await approvedOnce({ fresh: true, fields: done, routes: [USER_ROUTE, REVIEW_ROUTE] })
  const moved = await approvedOnce({
    fresh: true,
    fields: { ...done, sha: NEW_HEAD },
    pr: { headRefOid: NEW_HEAD },
    routes: [USER_ROUTE, REVIEW_ROUTE],
  })

  for (const [name, setup] of Object.entries({ held, reviewed, moved })) {
    assert.deepEqual(reviewRequests(setup.github), [], name)
    assert.deepEqual(reviewKinds(setup.manifest), [], name)
  }

  assert.deepEqual(reviewState(moved.entry.approved), done)
  assert.deepEqual(placeOf(held.entry), ['merge', 'waiting', 'held'])
})

test('merge gate: merge manual, merge auto and approval github submit no review for an inbox approval', async () => {
  for (const policy of [{ merge: 'manual' }, { merge: 'auto' }, { merge: 'human', approval: 'github' }]) {
    const { manifest, driver, github } = tickDriver(
      { A1: { ...samplePrs().A1, held: null, approved: inboxApproval(at(81)) } },
      { policy: { merge: policy.merge }, rules: [MERGE_RULE], routes: [prRoute(MERGED_PR), USER_ROUTE, REVIEW_ROUTE] },
    )

    // Without a token the manifest refuses approval: github, so the test sets it here.
    Object.assign(manifest.policy, policy)
    await driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1'))

    assert.deepEqual(reviewRequests(github), [], JSON.stringify(policy))
    assert.deepEqual(reviewKinds(manifest), [], JSON.stringify(policy))
  }
})

test('merge gate: awaiting-github-review, stale-github-review', async () => {
  for (const [code, stale] of [
    ['awaiting-github-review', false],
    ['stale-github-review', true],
  ]) {
    const { entry } = await stubbedOnce({ action: 'wait', code, reasons: [PLAIN_REASON] })

    assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'review'], code)
    assert.equal(entry.status.stale, stale, code)
  }
})

test('merge gate: changes-requested', async () => {
  const { entry } = await stubbedOnce({ action: 'wait', code: 'changes-requested', reasons: [PLAIN_REASON] })

  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'changes-requested'])
})

test("merge gate: ready, the driver's code under merge: manual", async () => {
  const { entry, tools } = await judgedOnce({ policy: { merge: 'manual' } })

  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'merge-by-hand'])
  assert.equal(entry.status.mergeState, 'CLEAN')
  assert.deepEqual(mergeCalls(tools), [])
})

test('merge gate: github-blocked', async () => {
  const { entry } = await judgedOnce({ pr: { mergeStateStatus: 'BLOCKED' } })

  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'github-blocked'])
})

test("merge gate: merge-refused, the driver's code", async () => {
  const { manifest, driver, tools, notices } = tickDriver(
    { A1: { ...samplePrs().A1, held: null } },
    { policy: { merge: 'auto' }, rules: [FETCH, REFUSAL], routes: [prRoute()] },
  )

  const entry = driver.ledger.prs.A1

  await driver.tick()

  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'merge-refused'])
  assert.equal(mergeCalls(tools).length, 1)

  await driver.tick()
  await driver.tick()

  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'merge-refused'])
  assert.equal(mergeCalls(tools).length, 1)
  assert.deepEqual(notices, ['A1: GitHub refused to merge PR #11; check its ruleset requirements'])

  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [
    { id: 'A1', kind: 'retry', stage: 'merge', status: 'waiting', code: 'gate-pending' },
  ])

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'gate-pending'])
  assert.equal(entry.gate, null)

  tools.answer([FETCH, MERGE_RULE])
  await driver.tick()

  assert.equal(mergeCalls(tools).length, 2)
  assert.deepEqual(placeOf(entry), ['merge', 'running', 'merge'])
  assert.deepEqual(kindsSince(manifest).slice(-2), ['gate-merge', 'merge-unconfirmed'])
})

test('merge gate: no-pr, pr-not-open, never-merge, draft, wrong-base, wrong-head, missing-label', async () => {
  for (const code of BLOCK_CODES) {
    const { driver, entry, stub, gate } = await stubbedOnce({ action: 'block', code, reasons: [`blocked by ${code}`] })

    assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'gate-blocked'], code)
    assert.deepEqual([entry.status.gate, entry.status.reasons], [code, [`blocked by ${code}`]], code)
    assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'gate-blocked'], code)

    // Read again on the next gate run, with no command.
    stub.verdict = { action: 'wait', code: 'ci-pending', reasons: ['CI pending'] }
    await driver.mergeNext()

    assert.equal(gate.calls, 2, code)
    assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'ci'], code)
  }
})

test('merge gate: code-scanning with action block', async () => {
  const { entry } = await judgedOnce({ facts: scanned([scanAlert()]), codeScanning: { action: 'block', minSeverity: 'medium' } })

  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'code-scanning-alerts'])
  assert.equal(entry.status.alerts.length, 1)
  assert.deepEqual(entry.verified, samplePrs().A1.verified)
  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'code-scanning-alerts'])
})

test('merge gate: policy-violations', async () => {
  const { entry } = await judgedOnce({ facts: { files: [{ status: 'modified', path: '.github/workflows/ci.yml' }] } })

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.fix.reason, entry.fixReason], ['policy', 'rollout policy'])
  assert.match(entry.fixNote, /^The merge gate sent the PR back:\n- touches \.github\/workflows\/ci\.yml/)
})

test('merge gate: ci-red', async () => {
  const { manifest, entry } = await judgedOnce({ facts: { checks: RED } })

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.fix.reason, entry.fixReason], ['ci-red', 'CI is red'])
  assert.equal(entry.fixNote, 'The merge gate sent the PR back:\n- test: failure\n- CI is red on the PR head')
  assert.deepEqual(eventsSince(manifest).at(-1), { id: 'A1', kind: 'needs-fix', reason: 'CI is red' })
  assert.equal(entry.verified, null)
})

test('merge gate: code-scanning with action fix', async () => {
  const { entry } = await judgedOnce({ facts: scanned([scanAlert()]) })

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.fix.reason, entry.fixReason], ['code-scanning', 'code scanning'])
  assert.match(entry.fixNote, /Never silence the analyser/)
})

test('merge gate: behind-base', async () => {
  const worktree = (manifest) => {
    const gitDir = join(
      worktreePath(
        manifest,
        manifest.prs.find((item) => item.id === 'A1'),
      ),
      '.git',
    )

    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'rollout-ready'), '')
  }

  const rebased = tickDriver({ A1: { ...samplePrs().A1, held: null } }, { policy: { merge: 'auto' } })

  worktree(rebased.manifest)
  rebased.tools.answer([
    { tool: 'git', args: 'rev-parse HEAD', stdout: REBASED },
    { tool: 'git', args: '', stdout: '' },
  ])

  rebased.gate.facts = { baseIsAncestor: false }

  assert.equal(await rebased.driver.mergeCandidate(rebased.manifest.prs.find((item) => item.id === 'A1')), true)
  assert.deepEqual(placeOf(rebased.driver.ledger.prs.A1), ['merge', 'waiting', 'ci'])
  assert.equal(rebased.driver.ledger.prs.A1.status.sha, REBASED)
  assert.deepEqual(eventsSince(rebased.manifest).at(-1), { id: 'A1', kind: 'rebased', head: REBASED.slice(0, 7) })

  const conflict = tickDriver({ A1: { ...samplePrs().A1, held: null } }, { policy: { merge: 'auto' } })

  worktree(conflict.manifest)
  conflict.tools.answer([
    { tool: 'git', args: 'rebase origin/main', code: 1, stderr: 'CONFLICT (content): Merge conflict in lib/widget.mjs\n' },
    { tool: 'git', args: 'diff --name-only', stdout: 'lib/widget.mjs\n' },
    { tool: 'git', args: '', stdout: '' },
  ])

  conflict.gate.facts = { baseIsAncestor: false }

  assert.equal(await conflict.driver.mergeCandidate(conflict.manifest.prs.find((item) => item.id === 'A1')), true)

  const entry = conflict.driver.ledger.prs.A1

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.fix.reason, entry.fixReason, entry.verified], ['rebase-conflict', 'rebase conflict', null])
  assert.match(entry.fixNote, /Conflicting files: lib\/widget\.mjs/)
})

test('merge gate: merge', async () => {
  const { manifest, driver, tools, github, cleaned } = tickDriver(
    { A1: { ...samplePrs().A1, held: null } },
    { policy: { merge: 'auto' }, rules: [FETCH, MERGE_RULE], routes: [prRoute()] },
  )

  const entry = driver.ledger.prs.A1

  // GitHub accepts the merge and shows no merge commit yet.
  await driver.tick()

  assert.deepEqual(placeOf(entry), ['merge', 'running', 'merge'])
  assert.equal(mergeCalls(tools).length, 1)

  github.answer([prRoute(MERGED_PR)])
  await driver.tick()

  assert.deepEqual([entry.stage, entry.status], ['merged', null])
  assert.deepEqual(entry.merged, { by: 'driver', at: at(90), sha: MERGE_SHA, from: 'merge', verified: true })
  assert.equal(mergeCalls(tools).length, 1)
  assert.deepEqual(cleaned, ['A1'])
  assert.deepEqual(kindsSince(manifest).slice(-1), ['merged'])
})

test('merge gate: not-verified, merged-on-github', async () => {
  const unverified = await judgedOnce({ facts: { patchId: 'patch-other' } })

  assert.deepEqual(placeOf(unverified.entry), ['pre-verify', 'waiting', 'ci'])
  assert.deepEqual([unverified.entry.verified, unverified.entry.approved], [null, null])

  const { driver, github, entry, gate } = await judgedOnce({ pr: { state: 'MERGED' }, rules: [FETCH] })

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'gate-pending'])
  assert.equal(entry.gate.code, 'merged-on-github')

  github.answer([prRoute(MERGED_PR)])
  gate.pr = {}
  await driver.tick()

  assert.equal(entry.stage, 'merged')
  assert.equal(entry.merged.by, 'github')
})

test("mergeCandidate: the gate's own merge records the driver's merge, verified, from merge", async () => {
  const { entry, acted } = await judgedOnce({ rules: [MERGE_RULE], routes: [prRoute(MERGED_PR)] })

  assert.equal(acted, true)
  assert.deepEqual(placeOf(entry), ['merged', null, null])
  assert.deepEqual(entry.merged, { by: 'driver', at: entry.merged.at, sha: MERGE_SHA, from: 'merge', verified: true })
  assert.ok(Number.isFinite(Date.parse(entry.merged.at)))
})

const HELD = { held: samplePrs().A1.held }
const GREEN_CHECKS = { state: 'green', missing: [], pending: [], failing: [], runs: [] }
// The medium finding of reviewJson() went to a verifier in an earlier round. Its high one went to none.
const EARLIER_MEMORY = { sent: [matchKey(MEDIUM)], refuted: [] }
const ONE_NEW = '2 candidates (1 high, 1 medium), 1 below medium, 1 new since the verification'

// A skip of the review's run 5 on SHA, read by the claim check at at(78), before the verification at at(80).
const SKIPPED_BEFORE = {
  sha: SHA,
  at: at(78),
  run: 5,
  reusedFrom: null,
  skipped: 'the review has run for more than 20 minutes',
  findings: [],
  fixed: [],
  leftOut: 0,
  candidates: [],
}

function withReviewKey(manifest, externalFindings = EXTERNAL_FINDINGS) {
  manifest.gates = { ...manifest.gates, verify: { ...manifest.gates.verify, externalFindings } }
}

// The checks of gateFacts with the review's run 5, in the shape summarizeChecks gives it.
function reviewChecks(status = 'completed', conclusion = 'success') {
  return { ...GREEN_CHECKS, reviewRun: { id: 5, status, conclusion, startedAt: at(83) } }
}

// The review's artifact 7, made for `made` and holding reviewJson() of `sha`.
function reviewArtifact(sha, made = sha) {
  return [
    listRoute([artifactJson(7, made)]),
    ...zipRoutes(7, { body: zipArchive([{ name: 'review.json', data: reviewJson({ revision: sha }) }]) }),
  ]
}

function listRequests(github) {
  return artifactRequests(github).filter((request) => request.path === ARTIFACTS)
}

function mergeChecks(manifest) {
  return eventsSince(manifest).filter((event) => event.kind === 'gate-check' && event.stage === 'merge')
}

function mergeCheck(result, evidence, sha = SHA) {
  return {
    id: 'A1',
    kind: 'gate-check',
    stage: 'merge',
    item: 'external-review',
    level: 'recommended',
    result,
    sha: sha.slice(0, 7),
    evidence,
  }
}

function gateOutcome(entry) {
  return [...placeOf(entry), entry.gate.action, entry.gate.code]
}

// A1 verified at SHA, whose head moved to NEW_HEAD with the same patch. The review's run on NEW_HEAD
// succeeded. One tick syncs the move, then the gate judges A1.
async function movedAndTicked({ key = true, fields = {}, policy = {}, rules = [] } = {}) {
  const setup = tickDriver(
    { A1: { ...samplePrs().A1, reviewMemory: EARLIER_MEMORY, ...fields } },
    { policy, rules: [FETCH, ...rules], routes: [prRoute({ head: { sha: NEW_HEAD } }), ...reviewArtifact(NEW_HEAD)] },
  )

  if (key) {
    withReviewKey(setup.manifest)
  }

  setup.gate.pr = { headRefOid: NEW_HEAD }
  setup.gate.facts = { checks: reviewChecks() }
  await setup.driver.tick()

  return { ...setup, entry: setup.driver.ledger.prs.A1 }
}

test('merge gate: the review of a head that moved with the same patch is read once its run has finished, and the verdict stays', async () => {
  const { manifest, entry } = await movedAndTicked()

  assert.deepEqual(entry.verified, { ...samplePrs().A1.verified, sha: NEW_HEAD })
  assert.equal(entry.verified.patchId, samplePrs().A1.verified.patchId)
  assert.deepEqual(
    { ...entry.review, at: null },
    {
      sha: NEW_HEAD,
      at: null,
      run: 5,
      reusedFrom: null,
      skipped: null,
      findings: [HIGH, MEDIUM, LOW].map(storedFinding),
      fixed: [],
      leftOut: 0,
      candidates: [],
    },
  )

  assert.deepEqual(mergeChecks(manifest), [mergeCheck('pass', ONE_NEW, NEW_HEAD)])
  assert.deepEqual(gateOutcome(entry), ['merge', 'waiting', 'held', 'wait', 'held'])

  const without = await movedAndTicked({ key: false })

  assert.deepEqual(gateOutcome(without.entry), gateOutcome(entry))
  assert.deepEqual(without.entry.verified, entry.verified)
  assert.deepEqual(artifactRequests(without.github), [])
  assert.deepEqual(mergeChecks(without.manifest), [])
})

test('merge gate: under merge auto, a PR whose review the gate read merges in the same tick', async () => {
  const { manifest, entry, tools } = await movedAndTicked({ fields: { held: null }, policy: { merge: 'auto' }, rules: [MERGE_RULE] })

  assert.equal(mergeCalls(tools).length, 1)
  assert.deepEqual(placeOf(entry), ['merge', 'running', 'merge'])
  assert.deepEqual(mergeChecks(manifest), [mergeCheck('pass', ONE_NEW, NEW_HEAD)])
})

test('merge gate: a review run still going, no review run, no manifest key or a pass the verifier got reads nothing, stores nothing and logs nothing', async () => {
  const passBefore = { ...SKIPPED_BEFORE, skipped: null, findings: [HIGH].map(storedFinding) }
  const cases = {
    'a run in progress': { externalFindings: EXTERNAL_FINDINGS, checks: reviewChecks('in_progress', null) },
    'a queued run': { externalFindings: EXTERNAL_FINDINGS, checks: reviewChecks('queued', null) },
    'no review run': { externalFindings: EXTERNAL_FINDINGS, checks: { ...GREEN_CHECKS, reviewRun: null } },
    'checks without a review run': { externalFindings: EXTERNAL_FINDINGS, checks: GREEN_CHECKS },
    'no manifest key': { externalFindings: undefined, checks: reviewChecks() },
    'a pass of the run read before the verification': { externalFindings: EXTERNAL_FINDINGS, checks: reviewChecks(), review: passBefore },
  }

  for (const [name, { externalFindings, checks, review = SKIPPED_BEFORE }] of Object.entries(cases)) {
    const { manifest, github, entry } = await judgedOnce({
      externalFindings,
      facts: { checks },
      fields: { ...HELD, review },
      routes: reviewArtifact(SHA),
    })

    assert.deepEqual(artifactRequests(github), [], name)
    assert.deepEqual(entry.review, review, name)
    assert.deepEqual(mergeChecks(manifest), [], name)
    assert.deepEqual(gateOutcome(entry), ['merge', 'waiting', 'held', 'wait', 'held'], name)
  }
})

test('merge gate: a review run that failed is a skip with no request, stored and logged, and the verdict stays', async () => {
  const { manifest, github, entry } = await judgedOnce({
    externalFindings: EXTERNAL_FINDINGS,
    facts: { checks: reviewChecks('completed', 'failure') },
    fields: HELD,
    routes: reviewArtifact(SHA),
  })

  assert.deepEqual(artifactRequests(github), [])
  assert.deepEqual({ ...entry.review, at: null }, { ...SKIPPED_BEFORE, at: null, skipped: 'the review run ended as failure' })

  assert.deepEqual(mergeChecks(manifest), [mergeCheck('skip', 'the review run ended as failure')])
  assert.deepEqual(gateOutcome(entry), ['merge', 'waiting', 'held', 'wait', 'held'])
})

test('merge gate: a review run that succeeded with no artifact for the head is a skip, read once, and the verdict stays', async () => {
  const { manifest, github, driver, pr, entry } = await judgedOnce({
    externalFindings: EXTERNAL_FINDINGS,
    facts: { checks: reviewChecks() },
    fields: HELD,
    routes: reviewArtifact(SHA, NEW_HEAD),
  })

  assert.equal(listRequests(github).length, 1)
  assert.deepEqual({ ...entry.review, at: null }, { ...SKIPPED_BEFORE, at: null, skipped: 'the review left no artifact for this head' })

  assert.deepEqual(mergeChecks(manifest), [mergeCheck('skip', 'the review left no artifact for this head')])
  assert.deepEqual(gateOutcome(entry), ['merge', 'waiting', 'held', 'wait', 'held'])

  // The gate's own skip was read after the verification, so the same run is not read again.
  const events = readEvents(manifest).length

  await driver.mergeCandidate(pr)

  assert.equal(listRequests(github).length, 1)
  assert.equal(readEvents(manifest).length, events)
})

test('merge gate: an outage of the artifact list stores nothing and logs nothing, and under merge auto the PR merges in that tick', async () => {
  const { manifest, driver, tools, gate, github } = tickDriver(
    { A1: { ...samplePrs().A1, held: null } },
    {
      policy: { merge: 'auto' },
      rules: [FETCH, MERGE_RULE],
      routes: [prRoute(), { path: ARTIFACTS, status: 500, body: { message: 'Server Error' } }],
    },
  )

  const entry = driver.ledger.prs.A1
  const review = entry.review

  withReviewKey(manifest)
  gate.facts = { checks: reviewChecks() }
  await driver.tick()

  assert.ok(listRequests(github).length > 0)
  assert.equal(entry.review, review)
  assert.deepEqual(mergeChecks(manifest), [])
  assert.equal(kindsSince(manifest).includes('error'), false)
  assert.equal(mergeCalls(tools).length, 1)
})

test('merge gate: a second pass on the same run reads nothing and logs nothing', async () => {
  const { manifest, github, driver, pr, entry } = await judgedOnce({
    externalFindings: EXTERNAL_FINDINGS,
    facts: { checks: reviewChecks() },
    fields: HELD,
    routes: reviewArtifact(SHA),
  })

  const requests = artifactRequests(github).length
  const events = readEvents(manifest).length
  const stored = structuredClone(entry.review)

  assert.equal(listRequests(github).length, 1)
  assert.equal(entry.review.skipped, null)

  await driver.mergeCandidate(pr)

  assert.equal(artifactRequests(github).length, requests)
  assert.equal(readEvents(manifest).length, events)
  assert.deepEqual(entry.review, stored)
})

test('merge gate: newer skipped runs of the review check keep a review read after the verification', async () => {
  const raw = (id, name, conclusion) => ({ id, name, status: 'completed', conclusion, startedAt: at(83) })
  const checks = summarizeChecks(
    [raw(1, 'test', 'success'), raw(7, REVIEW_CHECK, 'success'), raw(9, REVIEW_CHECK, 'skipped'), raw(10, REVIEW_CHECK, 'skipped')],
    ['test'],
    [],
    REVIEW_CHECK,
  )

  const { manifest, github, entry } = await judgedOnce({
    externalFindings: EXTERNAL_FINDINGS,
    facts: { checks },
    fields: { ...HELD, review: laterReview() },
    routes: reviewArtifact(SHA),
  })

  assert.deepEqual(artifactRequests(github), [])
  assert.deepEqual(entry.review, laterReview())
  assert.deepEqual(mergeChecks(manifest), [])
  assert.deepEqual(gateOutcome(entry), ['merge', 'waiting', 'held', 'wait', 'held'])
})

test('merge gate: a skip read before the verification is read again once its run has succeeded, and only once', async () => {
  const { manifest, github, driver, pr, entry } = await judgedOnce({
    externalFindings: EXTERNAL_FINDINGS,
    facts: { checks: reviewChecks() },
    fields: { ...HELD, review: SKIPPED_BEFORE, reviewMemory: EARLIER_MEMORY },
    routes: reviewArtifact(SHA),
  })

  assert.equal(listRequests(github).length, 1)
  assert.deepEqual(
    { ...entry.review, at: null },
    { ...SKIPPED_BEFORE, at: null, skipped: null, findings: [HIGH, MEDIUM, LOW].map(storedFinding) },
  )

  assert.deepEqual(mergeChecks(manifest), [mergeCheck('pass', ONE_NEW)])
  assert.deepEqual(gateOutcome(entry), ['merge', 'waiting', 'held', 'wait', 'held'])

  const requests = artifactRequests(github).length

  await driver.mergeCandidate(pr)

  assert.equal(artifactRequests(github).length, requests)
})

test('mergeNext: a draft made ready merges on the next tick, with one merge call and no command', async () => {
  const { manifest, driver, tools, gate } = tickDriver(
    { A1: { ...samplePrs().A1, held: null } },
    { policy: { merge: 'auto' }, rules: [FETCH, MERGE_RULE], routes: [prRoute()] },
  )

  const entry = driver.ledger.prs.A1

  gate.pr = { isDraft: true }
  await driver.tick()

  assert.deepEqual([...placeOf(entry), entry.status.gate], ['merge', 'needs-you', 'gate-blocked', 'draft'])
  assert.deepEqual(mergeCalls(tools), [])

  gate.pr = {}
  await driver.tick()

  assert.equal(mergeCalls(tools).length, 1)
  assert.ok(!kindsSince(manifest).includes('retry'))
})

test('mergeNext: a code scanning block on merge keeps the verification, and the PR merges once the alert is gone', async () => {
  const { manifest, driver, tools, gate } = tickDriver(
    { A1: { ...samplePrs().A1, held: null } },
    { policy: { merge: 'auto' }, rules: [FETCH, MERGE_RULE], routes: [prRoute()] },
  )

  const entry = driver.ledger.prs.A1

  manifest.repo.codeScanning = { action: 'block', minSeverity: 'medium' }
  gate.facts = scanned([scanAlert()])
  await driver.tick()
  await driver.tick()

  assert.deepEqual(placeOf(entry), ['merge', 'needs-you', 'code-scanning-alerts'])
  assert.deepEqual(entry.verified, samplePrs().A1.verified)
  assert.deepEqual(mergeCalls(tools), [])

  gate.facts = scanned([])
  await driver.tick()

  assert.equal(mergeCalls(tools).length, 1)
})

test('mergeNext: a gate block given again keeps its time, and logs and notifies nothing', async () => {
  const { manifest, driver, entry, stub, notices } = stubbedGate()

  stub.verdict = { action: 'block', code: 'draft', reasons: ['PR is a draft'] }
  await driver.mergeNext()

  const since = entry.status.since
  const events = readEvents(manifest).length

  await driver.mergeNext()
  await driver.mergeNext()

  assert.deepEqual([...placeOf(entry), entry.status.since], ['merge', 'needs-you', 'gate-blocked', since])
  assert.equal(readEvents(manifest).length, events)
  assert.deepEqual(kindsSince(manifest), ['gate-block', 'blocked'])
  assert.deepEqual(notices, ['A1: gate blocked: PR is a draft'])
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

  assert.deepEqual(placeOf(entry), ['verify', 'needs-you', 'dispute'])
  assert.equal(entry.status.code, 'dispute')
  assert.equal(entry.escalationRun, 'A1-04-verify')
  assert.ok(Date.parse(entry.status.since) >= Date.parse(setup.driver.ledger.data.runs['A1-04-verify'].endedAt), entry.status.since)
  assert.deepEqual(stageLabels(entry), ['rollout-stage:verify', 'rollout-status:dispute'])
  assert.equal(
    entry.lastError,
    'the verifier still finds F2 open, which the implementer disputed: The retry flag is not documented. The implementer: The brief keeps the flag internal.',
  )

  assert.deepEqual(kindsSince(manifest), ['verify-done', 'escalated'])
  assert.deepEqual(eventsSince(manifest).at(-1), { id: 'A1', kind: 'escalated', reason: 'disputed finding', findings: ['F2'] })
  assert.equal(notices.length, 1)
  assert.match(notices[0], /^A1: the verifier still finds F2 open, which the implementer disputed\. /)
  assert.ok(notices[0].includes('rollout note A1') && !notices[0].includes('rollout retry'), notices[0])

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
    { id: 'F1', status: 'resolved', evidence: 'F1 is resolved at a1a1a1a.', finding: fixed.text, answer: fixed.answer, fromReview: null },
    { id: 'F2', status: 'open', evidence: 'F2 is open at a1a1a1a.', finding: disputed.text, answer: disputed.answer, fromReview: null },
  ])
})

test('verified: a disputed finding the next verifier calls wrong never escalates', async () => {
  const failing = recheckDriver()

  await rechecked(failing, recheckVerdict({ F1: 'resolved', F2: 'wrong' }))

  assert.deepEqual(placeOf(failing.entry), ['implement', 'waiting', 'slot'])
  assert.equal(failing.entry.fixReason, 'verifier findings')
  assert.deepEqual(kindsSince(failing.manifest), ['verify-done', 'needs-fix'])
  assert.deepEqual(failing.notices, [])
  assert.deepEqual(failing.entry.findings.items, [{ id: 'F1', text: NEW_FINDING, answer: null }])

  const passing = recheckDriver()
  const pass = { verdict: 'PASS', checklist: [{ item: 'docs updated', status: 'pass', evidence: 'README.md:3' }], blocking: [] }

  await rechecked(passing, recheckVerdict({ F1: 'resolved', F2: 'wrong' }, pass))

  assert.deepEqual(placeOf(passing.entry), ['merge', 'waiting', 'gate-pending'])
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

    assert.deepEqual(placeOf(setup.entry), ['implement', 'waiting', 'slot'], name)
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

  assert.deepEqual(placeOf(stale.entry), ['pre-verify', 'waiting', 'ci'])
  assert.deepEqual([touched.entry.stage, touched.entry.status.kind, touched.entry.status.code], ['verify', 'waiting', 'slot'])

  for (const setup of [stale, touched]) {
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
  assert.deepEqual(placeOf(setup.entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual(setup.entry.findings.items, [{ id: 'F1', text: NEW_FINDING, answer: null }])
})

// Two findings of the external review of SHA, as the driver stores them.
const REVIEW_HIGH = {
  severity: 'high',
  criterion: 'review.correctness',
  title: 'The total ignores a refunded line',
  file: 'src/orders/total.ts',
  line: 42,
  failureScenario: 'An order with one refunded line shows the full price.',
  fix: 'Skip a line whose refund is settled.',
  status: 'new',
}

const REVIEW_MEDIUM = {
  severity: 'medium',
  criterion: 'review.errors',
  title: 'A refused refund is dropped',
  file: 'src/orders/refund.ts',
  line: 18,
  failureScenario: 'A refund the bank refuses leaves the order marked as refunded.',
  fix: 'Keep the order open until the bank confirms.',
  status: 'open',
}

const SENT_KEYS = [matchKey(REVIEW_HIGH), matchKey(REVIEW_MEDIUM)]
const CONFIRMED_EVIDENCE = 'src/orders/total.ts:44 adds every line.'
const CONFIRMED_FINDING = `External review finding (high, review.correctness) at src/orders/total.ts:42: The total ignores a refunded line. Failure scenario: An order with one refunded line shows the full price. Proposed fix: Skip a line whose refund is settled. The verifier confirmed it: ${CONFIRMED_EVIDENCE}`

const REFUND_BLOB = '3b18e512dba79e4c8300dd08aeb37f8e728b8dad'
const TOTAL_BLOB = '9daeafb9864cf43055ae93beb0afd6c7d144bfa4'

// The review memory with each refutation's time checked to be an ISO time and left out. No order against a time the
// test read: the wall clock can step back between two reads.
function memoryTimed(memory) {
  return {
    ...memory,
    refuted: memory.refuted.map(({ at: recorded, ...record }) => {
      assert.equal(new Date(recorded).toISOString(), recorded)

      return record
    }),
  }
}

// The <sha>:<path> of each blob the driver read.
function blobReads(tools) {
  return tools
    .calls()
    .filter((call) => call.tool === 'git' && call.args.includes('rev-parse') && call.args.includes('--verify'))
    .map((call) => call.args.at(-1))
}

// recheckDriver's clean worktree at SHA, and the answer to the blob read of each path at SHA.
function answerBlobs(setup, blobs) {
  setup.tools.answer([
    ...Object.entries(blobs).map(([path, answer]) => ({ tool: 'git', args: `rev-parse --verify --quiet ${SHA}:${path}`, ...answer })),
    { tool: 'git', args: 'status --porcelain', stdout: '' },
    { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
  ])
}

// A1 under verification of SHA with no findings to re-check, and the review of `sha` whose launch fixed X1 and X2.
function reviewedDriver(sha = SHA, state = {}) {
  const setup = recheckDriver({ findings: null, ...state })

  setup.entry.review = {
    sha,
    at: at(70),
    run: 7,
    reusedFrom: null,
    skipped: null,
    findings: [REVIEW_HIGH, REVIEW_MEDIUM],
    fixed: [],
    leftOut: 0,
    candidates: [
      { id: 'X1', key: SENT_KEYS[0] },
      { id: 'X2', key: SENT_KEYS[1] },
    ],
  }

  return setup
}

// The verifier's PASS on SHA, with `external` mapping each id to its result.
function candidatesVerdict(external, overrides = {}) {
  return agentResult({
    output: {
      verdict: 'PASS',
      sha: SHA,
      summary: 'Every checklist item holds.',
      checklist: [{ item: 'docs updated', status: 'pass', evidence: 'README.md:3' }],
      blocking: [],
      nonBlocking: [],
      recheck: [],
      criteria: [],
      external: Object.entries(external).map(([id, result]) => ({ id, result, evidence: `${id} is ${result}: ${CONFIRMED_EVIDENCE}` })),
      ...overrides,
    },
  })
}

test('verified: a PASS that confirms a candidate of the external review is a FAIL, and the candidate is a finding with its key', async () => {
  const setup = reviewedDriver()
  const { manifest, entry } = setup
  const confirmed = { id: 'X1', result: 'confirmed', evidence: CONFIRMED_EVIDENCE }

  await rechecked(setup, candidatesVerdict({}, { external: [confirmed, { id: 'X2', result: 'refuted', evidence: 'refund.ts:20' }] }))

  assert.equal(entry.verdict.verdict, 'FAIL')
  assert.deepEqual(entry.verdict.blocking, [CONFIRMED_FINDING])
  assert.deepEqual(entry.findings.items, [{ id: 'F1', text: CONFIRMED_FINDING, answer: null, fromReview: SENT_KEYS[0] }])
  assert.equal(entry.fixReason, 'verifier findings')
  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.ok(entry.fixNote.includes(`- F1: ${CONFIRMED_FINDING}\n`), entry.fixNote)
  assert.deepEqual(kindsSince(manifest), ['verify-done', 'needs-fix'])
  assert.equal(eventsSince(manifest)[0].result, 'PASS', "verify-done keeps the verifier's own verdict")
  assert.deepEqual(entry.verdict.external, [
    { ...REVIEW_HIGH, id: 'X1', key: SENT_KEYS[0], result: 'confirmed', evidence: CONFIRMED_EVIDENCE },
    { ...REVIEW_MEDIUM, id: 'X2', key: SENT_KEYS[1], result: 'refuted', evidence: 'refund.ts:20' },
  ])

  // recheckDriver's git answers no rule with exit 1, as for a file that is not there.
  assert.deepEqual(memoryTimed(entry.reviewMemory), {
    sent: SENT_KEYS,
    refuted: [{ key: SENT_KEYS[1], blob: null, evidence: 'refund.ts:20', run: 'A1-04-verify' }],
  })
})

test("verified: the verifier's own findings come first, then the criteria's, then the confirmed candidates", async () => {
  const setup = reviewedDriver(SHA, { verifyCriteria: VERIFY_CRITERIA.slice(0, 1) })
  const { entry } = setup
  const criteria = [{ id: 'V1', result: 'fail', evidence: 'lib/a.mjs:12 adds a branch with no test.' }]

  await rechecked(setup, candidatesVerdict({ X1: 'unverifiable', X2: 'confirmed' }, { verdict: 'FAIL', blocking: [NEW_FINDING], criteria }))

  assert.deepEqual(entry.findings.items, [
    { id: 'F1', text: NEW_FINDING, answer: null },
    {
      id: 'F2',
      text: 'V1 (required criterion): A new branch in the code has a test that fails without it. lib/a.mjs:12 adds a branch with no test.',
      answer: null,
    },
    {
      id: 'F3',
      text: `External review finding (medium, review.errors) at src/orders/refund.ts:18: A refused refund is dropped. Failure scenario: A refund the bank refuses leaves the order marked as refunded. Proposed fix: Keep the order open until the bank confirms. The verifier confirmed it: X2 is confirmed: ${CONFIRMED_EVIDENCE}`,
      answer: null,
      fromReview: SENT_KEYS[1],
    },
  ])

  assert.deepEqual(
    entry.verdict.external.map((record) => [record.id, record.result]),
    [
      ['X1', 'unverifiable'],
      ['X2', 'confirmed'],
    ],
  )
})

test('verified: a PASS with every candidate refuted, left out or answered with a made-up id ends on the gate', async () => {
  const refutedAs = (key, id) => ({ key, blob: null, evidence: `${id} is refuted: ${CONFIRMED_EVIDENCE}`, run: 'A1-04-verify' })
  const cases = {
    refuted: {
      external: { X1: 'refuted', X2: 'refuted' },
      results: ['refuted', 'refuted'],
      remembered: [refutedAs(SENT_KEYS[0], 'X1'), refutedAs(SENT_KEYS[1], 'X2')],
    },
    unverifiable: {
      external: { X2: 'unverifiable', X1: 'refuted' },
      results: ['refuted', 'unverifiable'],
      remembered: [refutedAs(SENT_KEYS[0], 'X1')],
    },
    'left out and made up': { external: { X9: 'confirmed', F1: 'confirmed' }, results: ['unanswered', 'unanswered'], remembered: [] },
  }

  for (const [name, { external, results, remembered }] of Object.entries(cases)) {
    const setup = reviewedDriver()
    const { manifest, entry } = setup

    await rechecked(setup, candidatesVerdict(external))

    assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'gate-pending'], name)
    assert.equal(entry.verdict.verdict, 'PASS', name)
    assert.deepEqual(entry.verdict.blocking, [], name)
    assert.equal(entry.findings, null, name)
    assert.deepEqual(kindsSince(manifest), ['verify-done', 'verified'], name)
    assert.deepEqual(
      entry.verdict.external.map((record) => [record.id, record.key, record.title, record.result]),
      [
        ['X1', SENT_KEYS[0], REVIEW_HIGH.title, results[0]],
        ['X2', SENT_KEYS[1], REVIEW_MEDIUM.title, results[1]],
      ],
      name,
    )

    assert.deepEqual(memoryTimed(entry.reviewMemory), { sent: SENT_KEYS, refuted: remembered }, name)
  }
})

test('verified: a verdict without external, or a review of another head, blocks nothing and remembers no key', async () => {
  const unanswered = reviewedDriver()
  const { external: _, ...output } = candidatesVerdict({}).output

  await rechecked(unanswered, agentResult({ output }))

  assert.deepEqual(placeOf(unanswered.entry), ['merge', 'waiting', 'gate-pending'])
  assert.deepEqual(
    unanswered.entry.verdict.external.map((record) => record.result),
    ['unanswered', 'unanswered'],
  )

  assert.deepEqual(unanswered.entry.reviewMemory, { sent: SENT_KEYS, refuted: [] })

  const older = reviewedDriver(NEW_HEAD)

  await rechecked(older, candidatesVerdict({ X1: 'confirmed', X2: 'confirmed' }))

  assert.deepEqual(placeOf(older.entry), ['merge', 'waiting', 'gate-pending'])
  assert.deepEqual(older.entry.verdict.external, [])
  assert.equal(Object.hasOwn(older.entry, 'reviewMemory'), false)
})

test('verified: a refuted candidate is remembered with the blob of its file at the verified head, its evidence and the run', async () => {
  const setup = reviewedDriver()
  const { entry, tools } = setup
  const evidence = `src/orders/refund.ts:20 keeps the order open. ${'The bank answers later. '.repeat(50)}`

  answerBlobs(setup, { 'src/orders/refund.ts': { stdout: `${REFUND_BLOB}\n` } })
  await rechecked(
    setup,
    candidatesVerdict(
      {},
      {
        external: [
          { id: 'X1', result: 'unverifiable', evidence: 'No test covers it.' },
          { id: 'X2', result: 'refuted', evidence },
        ],
      },
    ),
  )

  assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'gate-pending'])
  assert.deepEqual(memoryTimed(entry.reviewMemory), {
    sent: SENT_KEYS,
    refuted: [{ key: SENT_KEYS[1], blob: REFUND_BLOB, evidence: evidence.slice(0, 1000), run: 'A1-04-verify' }],
  })

  assert.ok(evidence.length > 1000)
  assert.deepEqual(blobReads(tools), [`${SHA}:src/orders/refund.ts`])
})

test('verified: a re-check that calls a finding from the review wrong is remembered with its file in its real case, any other one is not', async () => {
  const total = { ...REVIEW_HIGH, file: 'src/Orders/Total.ts' }
  const key = matchKey(total)
  const items = [
    {
      id: 'F1',
      text: 'External review finding (high).',
      answer: { outcome: 'disputed', action: 'Total.ts:40 skips it.' },
      fromReview: key,
    },
    { id: 'F2', text: NEW_FINDING, answer: { outcome: 'disputed', action: 'README.md:3 names the new flag.' } },
  ]

  const answeredIn = (file) => ({ external: [{ ...total, file, id: 'X1', key, result: 'confirmed', evidence: 'Total.ts:44 adds it.' }] })
  const cases = {
    'from the review': { findings: [total, REVIEW_MEDIUM], verdicts: [], reads: [`${SHA}:src/Orders/Total.ts`] },
    'from the newest verdict that answered it': {
      findings: [REVIEW_MEDIUM],
      verdicts: [answeredIn('src/Orders/Older.ts'), answeredIn('src/Orders/Total.ts'), { external: [] }, {}],
      reads: [`${SHA}:src/Orders/Total.ts`],
    },
    'from neither': { findings: [REVIEW_MEDIUM], verdicts: [], reads: [] },
  }

  const recheck = [
    { id: 'F1', status: 'wrong', evidence: 'F1 is wrong: Total.ts:40 skips a refunded line.' },
    { id: 'F2', status: 'wrong', evidence: 'F2 is wrong: README.md:3 names the new flag.' },
  ]

  for (const [name, { findings, verdicts, reads }] of Object.entries(cases)) {
    const setup = reviewedDriver(SHA, { findings: { at: at(60), items }, verdicts })

    setup.entry.review = { ...setup.entry.review, findings, candidates: [{ id: 'X1', key: SENT_KEYS[1] }] }
    answerBlobs(setup, { 'src/Orders/Total.ts': { stdout: `${TOTAL_BLOB}\n` } })
    await rechecked(setup, candidatesVerdict({ X1: 'unverifiable' }, { recheck }))

    const remembered = reads.length === 0 ? [] : [{ key, blob: TOTAL_BLOB, evidence: recheck[0].evidence, run: 'A1-04-verify' }]

    assert.deepEqual(memoryTimed(setup.entry.reviewMemory), { sent: [SENT_KEYS[1]], refuted: remembered }, name)
    assert.deepEqual(blobReads(setup.tools), reads, name)
  }
})

test('verified: a verifier that touched the tree or reported another SHA remembers no refutation', async () => {
  const stale = reviewedDriver()
  const touched = reviewedDriver()
  const blob = { tool: 'git', args: `rev-parse --verify --quiet ${SHA}:`, stdout: `${REFUND_BLOB}\n` }

  answerBlobs(stale, { 'src/orders/refund.ts': { stdout: `${REFUND_BLOB}\n` } })
  touched.tools.answer([
    blob,
    { tool: 'git', args: 'status --porcelain', stdout: ' M lib/a.mjs' },
    { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
    { tool: 'git', args: 'reset', stdout: '' },
    { tool: 'git', args: 'clean', stdout: '' },
  ])

  await rechecked(stale, candidatesVerdict({ X1: 'refuted', X2: 'refuted' }, { sha: NEW_HEAD }))
  await rechecked(touched, candidatesVerdict({ X1: 'refuted', X2: 'refuted' }))

  assert.deepEqual(kindsSince(stale.manifest), ['verify-done', 'verify-stale'])
  assert.deepEqual(kindsSince(touched.manifest), ['verify-done', 'verifier-touched-tree'])

  for (const setup of [stale, touched]) {
    assert.deepEqual(setup.entry.reviewMemory, { sent: SENT_KEYS, refuted: [] })
    assert.deepEqual(blobReads(setup.tools), [])
  }
})

test('verified: a blob read that fails remembers nothing, and the verdict ends as it would without the read', async () => {
  const verdicts = { PASS: { X1: 'unverifiable', X2: 'refuted' }, FAIL: { X1: 'confirmed', X2: 'refuted' } }

  for (const [name, external] of Object.entries(verdicts)) {
    const failing = reviewedDriver()
    const reading = reviewedDriver()

    answerBlobs(failing, { 'src/orders/refund.ts': { stderr: 'fatal: bad object', code: 128 } })
    answerBlobs(reading, { 'src/orders/refund.ts': { stdout: `${REFUND_BLOB}\n` } })
    await rechecked(failing, candidatesVerdict(external))
    await rechecked(reading, candidatesVerdict(external))

    const outcome = ({ manifest, entry }) => ({
      place: placeOf(entry),
      kinds: kindsSince(manifest),
      verdict: entry.verdict.verdict,
      blocking: entry.verdict.blocking,
      external: entry.verdict.external,
      findings: entry.findings?.items ?? null,
      fixReason: entry.fixReason,
      lastError: entry.lastError,
    })

    assert.deepEqual(outcome(failing), outcome(reading), name)
    assert.deepEqual(blobReads(failing.tools), [`${SHA}:src/orders/refund.ts`], name)
    assert.deepEqual(failing.entry.reviewMemory, { sent: SENT_KEYS, refuted: [] }, name)
    assert.deepEqual(
      reading.entry.reviewMemory.refuted.map((record) => [record.key, record.blob]),
      [[SENT_KEYS[1], REFUND_BLOB]],
      name,
    )
  }
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

  assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'])
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

  assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'])
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

  assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'])
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

    assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'], JSON.stringify(verify))
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

  assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'])
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

    assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
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
  assert.deepEqual(placeOf(entry), ['pre-verify', 'needs-you', 'errors'])
  assert.equal(entry.status.code, 'errors')
  assert.ok(Number.isFinite(Date.parse(entry.status.since)), entry.status.since)
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

  assert.deepEqual(placeOf(entry), ['pre-verify', 'waiting', 'ci'])
  assert.deepEqual(agentCalls, [])

  answer([CATALOG_RULE])
  await driver.advance(pr)

  assert.deepEqual(placeOf(entry), ['verify', 'running', 'verify'])
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
  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
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
    assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'], name)
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

    assert.deepEqual(placeOf(entry), ['merge', 'waiting', 'gate-pending'], result)
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

  assert.deepEqual(placeOf(touched.entry), ['implement', 'waiting', 'slot'], 'a FAIL is honoured from a touched tree')
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

  assert.deepEqual(placeOf(disputed.entry), ['verify', 'needs-you', 'dispute'])
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

    assert.deepEqual(placeOf(passing.entry), ['merge', 'waiting', 'gate-pending'])
    assert.deepEqual(passing.entry.verdict.criteria, [])
    assert.deepEqual(kindsSince(passing.manifest), ['verify-done', 'verified'])
  }
})

test('verified: a manifest reload while the verifier runs changes nothing, the criteria fixed at its launch judge the verdict', async () => {
  const pass = { verdict: 'PASS', sha: SHA, summary: 'Every item holds.', checklist: [], blocking: [], nonBlocking: [], recheck: [] }
  const removed = verifiableDriver({ gates: gatesWith({ verify: { required: [BRANCH_TEST] } }) })

  await removed.driver.advance(removed.pr)

  assert.deepEqual(placeOf(removed.entry), ['verify', 'running', 'verify'])

  Object.assign(removed.manifest, { gates: gatesWith() })

  await removed.driver.onDone(
    removed.pr,
    'verify',
    agentResult({ output: { ...pass, criteria: [{ id: 'V1', result: 'fail', evidence: 'lib/a.mjs:12 adds a branch with no test.' }] } }),
    { sha: SHA, run: 'A1-02-verify' },
  )

  assert.deepEqual(placeOf(removed.entry), ['implement', 'waiting', 'slot'])
  assert.equal(removed.entry.verdict.verdict, 'FAIL')
  assert.deepEqual(removed.entry.findings.items, [
    { id: 'F1', text: `V1 (required criterion): ${BRANCH_TEST} lib/a.mjs:12 adds a branch with no test.`, answer: null },
  ])

  const added = verifiableDriver()

  await added.driver.advance(added.pr)

  assert.deepEqual(placeOf(added.entry), ['verify', 'running', 'verify'])

  Object.assign(added.manifest, { gates: gatesWith({ verify: { required: [NO_SEMICOLONS] } }) })

  await added.driver.onDone(added.pr, 'verify', agentResult({ output: { ...pass, criteria: [] } }), { sha: SHA, run: 'A1-02-verify' })

  assert.deepEqual(placeOf(added.entry), ['merge', 'waiting', 'gate-pending'])
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
    { id: 'A1', kind: 'note-queued', stage: 'implement', status: 'waiting', code: 'slot' },
  ])

  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
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

test('retry: a PR escalated over a dispute is refused, and the reason names rollout note', async () => {
  const setup = recheckDriver({ interruptedRole: 'verify' })
  const { manifest, driver, entry } = setup

  await rechecked(setup, recheckVerdict({ F1: 'resolved', F2: 'open' }))

  const before = structuredClone(entry)

  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [
    { id: 'A1', kind: 'command-rejected', command: 'retry', reason: 'this PR waits for your answer: rollout note A1 "..."' },
  ])

  assert.deepEqual(entry, before)
  assert.deepEqual(placeOf(entry), ['verify', 'needs-you', 'dispute'])
})

const RECHECKED = { F1: 'resolved', F2: 'wrong' }
const PASS = { verdict: 'PASS', blocking: [] }

// What git shows after a verifier changed the worktree, until the reset.
const TOUCHED_TREE = [
  { tool: 'git', args: 'status --porcelain', stdout: ' M lib/a.mjs' },
  { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
  { tool: 'git', args: 'reset', stdout: '' },
  { tool: 'git', args: 'clean', stdout: '' },
]

test('verifier run: pass on the claimed head, tree untouched', async () => {
  const setup = recheckDriver()

  await rechecked(setup, recheckVerdict(RECHECKED, PASS))

  assert.deepEqual(placeOf(setup.entry), ['merge', 'waiting', 'gate-pending'])
  assert.equal(setup.entry.verified.sha, SHA)
})

test('verifier run: pass, a note waits in the queue', async () => {
  const setup = recheckDriver({ pendingNote: 'Keep the README short.' })

  await rechecked(setup, recheckVerdict(RECHECKED, PASS))

  assert.deepEqual(placeOf(setup.entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([setup.entry.fix.reason, setup.entry.verified], ['maintainer-note', null])
})

test('verifier run: fail, or a required criterion that does not pass', async () => {
  const failing = recheckDriver()
  const criterion = recheckDriver({ verifyCriteria: VERIFY_CRITERIA })

  await rechecked(failing, recheckVerdict(RECHECKED))
  await rechecked(criterion, criteriaVerdict({ V1: 'fail', V2: 'pass', V3: 'pass' }))

  for (const [name, setup] of Object.entries({ failing, criterion })) {
    assert.deepEqual(placeOf(setup.entry), ['implement', 'waiting', 'slot'], name)
    assert.equal(setup.entry.fix.reason, 'verifier-findings', name)
  }
})

test('verifier run: dispute', async () => {
  const setup = recheckDriver()

  await rechecked(setup, recheckVerdict({ F1: 'resolved', F2: 'open' }))

  assert.deepEqual(placeOf(setup.entry), ['verify', 'needs-you', 'dispute'])
  assert.deepEqual(setup.entry.status.findings, ['F2'])
})

test('verifier run: pass-discarded', async () => {
  const setup = recheckDriver()

  setup.tools.answer(TOUCHED_TREE)
  await rechecked(setup, recheckVerdict(RECHECKED, PASS))

  assert.deepEqual(placeOf(setup.entry), ['verify', 'waiting', 'slot'])
  assert.deepEqual([setup.entry.reportUnchecked, setup.entry.implementCutOff, setup.entry.verified], [false, false, null])
})

test('verifier run: stale', async () => {
  const setup = recheckDriver()

  await rechecked(setup, recheckVerdict(RECHECKED, { ...PASS, sha: NEW_HEAD }))

  assert.deepEqual(placeOf(setup.entry), ['pre-verify', 'waiting', 'ci'])
  assert.equal(setup.entry.status.sha, SHA)
})

test('verifier run: failed', async () => {
  const setup = recheckDriver()

  await rechecked(setup, agentResult({ ok: false, output: null, error: 'error_during_execution' }))

  assert.deepEqual(placeOf(setup.entry), ['verify', 'waiting', 'backoff'])
  assert.equal(setup.entry.status.until, setup.entry.retryAfter)
})

test('verified: a note queued while the verifier ran goes to a fix when its PASS is discarded from a touched tree', async () => {
  const setup = recheckDriver()
  const { manifest, driver, entry } = setup

  driver.running.set('A1', 'verify')
  assert.deepEqual(apply(manifest, driver, { cmd: 'note', id: 'A1', text: 'Keep the README short.' }), [
    { id: 'A1', kind: 'note-queued', stage: 'verify', status: 'running', code: 'verify' },
  ])

  setup.tools.answer(TOUCHED_TREE)
  await rechecked(setup, recheckVerdict(RECHECKED, PASS))
  driver.running.delete('A1')

  assert.deepEqual(kindsSince(manifest).slice(-3), ['verify-done', 'verifier-touched-tree', 'needs-fix'])
  assert.deepEqual(placeOf(entry), ['implement', 'waiting', 'slot'])
  assert.deepEqual([entry.fix.reason, entry.fixReason], ['maintainer-note', 'answer from the maintainer'])
})
