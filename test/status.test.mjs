import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDriver } from '../lib/driver.mjs'
import { postCommand } from '../lib/ledger.mjs'
import { STAGE_STATUSES } from '../lib/state.ts'
import { readEvents } from '../lib/view.mjs'
import { worktreePath } from '../lib/worktree.mjs'
import { at, samplePrs, waitFor } from './fixtures.mjs'
import {
  agentResult,
  apply,
  CLAIMED,
  COMMANDS_GATE,
  commandSeam,
  FETCH,
  FIRST_ROUND,
  gateFacts,
  launched,
  MERGE_SHA,
  modelDriver,
  NEW_HEAD,
  preVerified,
  prRoute,
  runsRoute,
  SHA,
  tickDriver,
  verifiableDriver,
} from './driver-helpers.mjs'

const PR_11 = 'repos/example/widgets/pulls/11'
const NOT_FOUND = { path: PR_11, status: 404, body: { message: 'Not Found' } }
const CLOSED = prRoute({ state: 'closed' })
const PENDING_RUNS = { check_runs: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }
const GREEN = [prRoute(), runsRoute(SHA)]
const NEVER = () => new Promise(() => {})

const VERIFIED = { ...samplePrs().A1, held: null }
const VERIFYING = {
  state: 'verifying',
  pr: 11,
  claimedSha: SHA,
  claimPatchId: 'patch-a1',
  attempts: { implement: 1, fix: 0, verify: 1, brief: 0 },
}

const VERIFY_AGAIN = {
  state: 'interrupted',
  interruptedRole: 'verify',
  pr: 11,
  claimedSha: SHA,
  attempts: { implement: 1, fix: 0, verify: 1, brief: 0 },
}

const NEEDS_FIX = {
  state: 'needs_fix',
  pr: 11,
  fixReason: 'CI is red',
  fixNote: 'The test fails.',
  attempts: { implement: 1, fix: 1, verify: 0, brief: 0 },
}

const IMPLEMENTING = { state: 'implementing', attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } }
const BRIEFING = { state: 'briefing', attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } }
const DECISION = { kind: 'needs-decision', question: 'Keep the old flag?', evidence: 'cli.mjs:12 still reads it.' }
const BRIEF = {
  brief: '# A1\n',
  questions: [],
  notes: 'Checked.',
  expectedFiles: ['lib/a.mjs'],
  changesetBump: 'none',
  checks: [],
  criteria: [],
}

const FAILED = agentResult({ ok: false, output: null, error: 'error_during_execution' })
const STOPPED = agentResult({ ok: false, output: null, error: 'stopped', stopped: true, costUsd: 0, seconds: 0 })
const CLEAN_TREE = [
  { tool: 'git', args: 'status --porcelain', stdout: '' },
  { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
]

function assertStatus(entry, stage, kind, code) {
  assert.deepEqual([entry.stage, entry.status?.kind ?? null, entry.status?.code ?? null], [stage, kind, code])
}

// One test per stage and code the driver produces. `reach` takes the PR there through the driver and returns its entry.
function pairTest(stage, kind, code, reach) {
  test(`status: ${stage} · ${kind}: ${code}`, async () => {
    assertStatus(await reach(), stage, kind, code)
  })
}

// A tickDriver whose fetch works, with the entry and the PR of `id`.
function setupFor(prs, { rules = [], ...options } = {}, id = 'A1') {
  const setup = tickDriver(prs, { rules: [FETCH, ...rules], ...options })

  return { ...setup, pr: setup.manifest.all.find((item) => item.id === id), entry: setup.driver.ledger.prs[id] }
}

function writeBrief(pr) {
  mkdirSync(dirname(pr.brief), { recursive: true })
  writeFileSync(pr.brief, `# ${pr.id}\n`)
}

function scanAlert(sha) {
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

function scanned(sha) {
  return { codeScanning: { available: true, alerts: [scanAlert(sha)], baseOpen: [] } }
}

function blockedReport(blocked) {
  return agentResult({ output: { status: 'BLOCKED', summary: 'Stopped.', blocked } })
}

// A1 verified, judged by the gate once with `facts` and `pr` on top of facts it merges on.
async function judged(policy, { facts = {}, pr = {}, rules = [], routes = [], ...fields } = {}) {
  const setup = setupFor({ A1: { ...VERIFIED, ...fields } }, { policy, rules, routes })

  setup.gate.facts = facts
  setup.gate.pr = pr
  await setup.driver.mergeCandidate(setup.pr)

  return setup
}

// A tick that throws on A1 for the fifth time in a row.
async function fifthError(fields, options) {
  const setup = setupFor({ A1: { ...fields, tickErrors: 4 } }, options)

  await setup.driver.tick()
  assert.equal(setup.entry.status.code, 'errors')

  return setup
}

async function closedOnGitHub(fields) {
  const setup = setupFor({ A1: fields }, { routes: [CLOSED] })

  await setup.driver.tick()
  assert.equal(setup.entry.status.code, 'closed')

  return setup.entry
}

function held(fields) {
  const setup = setupFor({ A1: fields })

  apply(setup.manifest, setup.driver, { cmd: 'hold', ids: ['A1'] })
  assert.equal(setup.entry.status.scope, 'pr')

  return setup.entry
}

// brief

pairTest('brief', 'running', 'brief-write', async () => {
  const setup = modelDriver({ A1: { state: 'pending' } })

  rmSync(setup.pr.brief)
  await setup.driver.advance(setup.pr)
  await waitFor(() => setup.calls.length === 1, 'the writer')

  assert.equal(setup.entry.status.run, setup.calls[0].logName)

  return setup.entry
})

pairTest('brief', 'running', 'brief-review', async () => {
  const setup = modelDriver(
    { A1: { state: 'pending' } },
    { result: (options) => (options.logName.endsWith('-write') ? Promise.resolve(agentResult({ output: BRIEF })) : NEVER()) },
  )

  rmSync(setup.pr.brief)
  await setup.driver.advance(setup.pr)
  await waitFor(() => setup.calls.length === 2, 'the reviewer')

  assert.equal(setup.entry.status.run, setup.calls[1].logName)

  return setup.entry
})

// A1 blocked on `blocked`, with the delegate at work on it in a run that never ends.
async function delegating(blocked) {
  const setup = setupFor({ A1: { state: 'blocked', blocked, pr: 11 } }, { policy: { concurrency: 1, delegate: {} }, runAgent: NEVER })

  mkdirSync(worktreePath(setup.manifest, setup.pr), { recursive: true })
  writeBrief(setup.pr)
  await setup.driver.advance(setup.pr)

  assert.deepEqual([setup.entry.status.question, setup.entry.status.run], [blocked.kind, 'A1-01-delegate'])

  return setup.entry
}

pairTest('brief', 'running', 'delegate', () =>
  delegating({ kind: 'brief-questions', question: 'Which API?', evidence: 'The plan names two.' }),
)

pairTest('brief', 'waiting', 'dependencies', async () => {
  const { driver, pr, entry } = setupFor({ A1: { state: 'pending' } }, {}, 'A2')

  await driver.advance(pr)

  assert.deepEqual(entry.status.on, ['A1'])

  return entry
})

pairTest('brief', 'waiting', 'dependencies-merge', async () => {
  const dependency = { state: 'verified', pr: 11, claimedSha: SHA, verified: { sha: SHA, patchId: 'patch-a1', at: at(80) } }
  const { driver, pr, entry } = setupFor({ A1: dependency, A2: BRIEFING }, {}, 'A2')
  const heads = [{ id: 'A1', sha: SHA, patchId: 'patch-a1' }]

  driver.onBriefDone(pr, { ok: false, previewConflict: true, error: 'conflict', costUsd: 0, denials: [], seconds: 0 }, heads)
  assertStatus(entry, 'brief', 'waiting', 'dependencies-merge')

  await driver.advance(pr)

  assert.deepEqual(entry.status.heads, heads)

  return entry
})

pairTest('brief', 'waiting', 'outside-dependency', async () => {
  const { driver, pr, entry } = setupFor({ A1: { state: 'pending' } }, { only: ['A2'] }, 'A2')

  await driver.advance(pr)

  assert.deepEqual(entry.status.on, ['A1'])

  return entry
})

pairTest('brief', 'waiting', 'slot', async () => {
  const { driver, pr, entry } = setupFor({ A1: BRIEFING })

  driver.onBriefDone(pr, STOPPED)
  assertStatus(entry, 'brief', 'waiting', 'slot')

  await driver.advance(pr)

  return entry
})

pairTest('brief', 'waiting', 'backoff', async () => {
  const { driver, pr, entry } = setupFor({ A1: BRIEFING })

  driver.onBriefDone(pr, FAILED)

  assert.deepEqual([entry.status.until, entry.status.failures], [entry.retryAfter, 1])

  return entry
})

pairTest('brief', 'waiting', 'held', () => held({ state: 'pending' }))

pairTest('brief', 'needs-you', 'brief-questions', async () => {
  const { driver, pr, entry } = setupFor({ A1: BRIEFING })

  driver.onBriefDone(pr, agentResult({ output: { ...BRIEF, questions: ['Which API?'] } }))

  assert.equal(entry.status.question.text, 'Which API?')

  return entry
})

pairTest('brief', 'needs-you', 'attempts-exhausted', async () => {
  const attempts = { implement: 0, fix: 0, verify: 0, brief: 2 }
  const { driver, pr, entry } = setupFor({ A1: { state: 'pending', attempts } }, { policy: { concurrency: 1 }, runAgent: NEVER })

  await driver.advance(pr)

  assert.deepEqual([entry.status.role, entry.status.limit], ['brief', 2])

  return entry
})

// A run whose log file cannot be created throws in its launch.
pairTest('brief', 'needs-you', 'errors', async () => {
  const setup = setupFor({ A1: { state: 'pending', tickErrors: 4 } }, { policy: { concurrency: 1 }, runAgent: NEVER })

  rmSync(join(setup.manifest.dir, 'logs'), { recursive: true })
  writeFileSync(join(setup.manifest.dir, 'logs'), '')
  await setup.driver.tick()

  assert.equal(setup.entry.status.count, 5)

  return setup.entry
})

// implement

pairTest('implement', 'running', 'implement', async () => {
  const setup = modelDriver({ A1: { state: 'pending' } })

  await setup.driver.advance(setup.pr)
  await waitFor(() => setup.calls.length === 1, 'the implementer')

  assert.equal(setup.entry.status.run, setup.calls[0].logName)

  return setup.entry
})

pairTest('implement', 'running', 'fix', async () => {
  const setup = modelDriver({ A1: NEEDS_FIX })

  await setup.driver.advance(setup.pr)
  await waitFor(() => setup.calls.length === 1, 'the fix run')

  assert.deepEqual([setup.entry.status.reason, setup.entry.fix.reason], ['ci-red', 'ci-red'])

  return setup.entry
})

pairTest('implement', 'running', 'delegate', () => delegating(DECISION))

// A cut-off run with no PR yet waits for the dependencies too.
pairTest('implement', 'waiting', 'dependencies', async () => {
  const cutOff = setupFor(
    { A1: { state: 'pending' }, A2: { state: 'implementing', attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } } },
    {},
    'A2',
  )

  await cutOff.driver.advance(cutOff.pr)

  assertStatus(cutOff.entry, 'implement', 'waiting', 'dependencies')
  assert.equal(cutOff.entry.fix.reason, 'no-report')

  const { driver, pr, entry } = setupFor({ A1: { state: 'pending' } }, {}, 'A2')

  writeBrief(pr)
  await driver.advance(pr)

  assert.deepEqual(entry.status.on, ['A1'])

  return entry
})

pairTest('implement', 'waiting', 'outside-dependency', async () => {
  const { driver, pr, entry } = setupFor({ A1: { state: 'pending' } }, { only: ['A2'] }, 'A2')

  writeBrief(pr)
  await driver.advance(pr)

  return entry
})

pairTest('implement', 'waiting', 'slot', async () => {
  const { driver, pr, entry } = setupFor({ A1: { ...NEEDS_FIX, state: 'fixing' } })

  await driver.onDone(pr, 'fix', STOPPED, { run: 'A1-02-fix' })
  assertStatus(entry, 'implement', 'waiting', 'slot')

  await driver.advance(pr)

  assert.equal(entry.fix.reason, 'ci-red')

  return entry
})

pairTest('implement', 'waiting', 'backoff', async () => {
  const { driver, pr, entry } = setupFor({ A1: IMPLEMENTING })

  await driver.onDone(pr, 'implement', FAILED, { run: 'A1-01-implement' })

  assert.equal(entry.fix.reason, 'no-report')

  return entry
})

pairTest('implement', 'waiting', 'held', () => held(NEEDS_FIX))

pairTest('implement', 'needs-you', 'decision', async () => {
  const { driver, pr, entry } = setupFor({ A1: IMPLEMENTING })

  await driver.onDone(pr, 'implement', blockedReport(DECISION), { run: 'A1-01-implement' })

  assert.deepEqual(entry.status.question, {
    kind: 'needs-decision',
    text: DECISION.question,
    evidence: DECISION.evidence,
    run: 'A1-01-implement',
    delegate: null,
  })

  return entry
})

pairTest('implement', 'needs-you', 'obstacle', async () => {
  const { driver, pr, entry } = setupFor({ A1: IMPLEMENTING })

  await driver.onDone(pr, 'implement', blockedReport({ ...DECISION, kind: 'environment' }), { run: 'A1-01-implement' })

  return entry
})

pairTest('implement', 'needs-you', 'attempts-exhausted', async () => {
  const attempts = { implement: 1, fix: 4, verify: 0, brief: 0 }
  const { driver, pr, entry } = setupFor({ A1: { ...NEEDS_FIX, attempts } }, { policy: { concurrency: 1 }, runAgent: NEVER })

  await driver.advance(pr)

  assert.deepEqual([entry.status.role, entry.fix.reason], ['fix', 'ci-red'])

  return entry
})

pairTest('implement', 'needs-you', 'errors', async () => (await fifthError(NEEDS_FIX, { routes: [NOT_FOUND] })).entry)

pairTest('implement', 'needs-you', 'closed', () => closedOnGitHub(NEEDS_FIX))

// pre-verify

pairTest('pre-verify', 'running', 'commands', async () => {
  const seam = commandSeam({ 'npm test': NEVER })
  const { driver, pr, entry } = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })

  await driver.advance(pr)

  assert.equal(entry.status.sha, SHA)

  return entry
})

pairTest('pre-verify', 'waiting', 'github', async () => {
  const { driver, pr, entry } = setupFor({ A1: IMPLEMENTING }, { routes: [{ path: 'repos/example/widgets/pulls/12', status: 502 }] })
  const ready = agentResult({ output: { status: 'READY', pr: 12, headSha: NEW_HEAD, summary: 'Done.' } })

  await driver.onDone(pr, 'implement', ready, { run: 'A1-01-implement' })

  return entry
})

// The claim moves from the head of the READY report to the one GitHub has.
pairTest('pre-verify', 'waiting', 'ci', async () => {
  const { driver, pr, entry } = setupFor(
    { A1: { ...CLAIMED, claimedSha: NEW_HEAD } },
    { routes: [prRoute(), runsRoute(SHA, PENDING_RUNS)] },
  )

  assert.equal(entry.status.sha, NEW_HEAD)

  await driver.advance(pr)

  assert.deepEqual([entry.status.sha, entry.status.missing, entry.status.pending], [SHA, [], ['test']])

  return entry
})

pairTest('pre-verify', 'waiting', 'code-scanning-pending', async () => {
  const { driver, pr, entry, gate } = setupFor({ A1: CLAIMED }, { routes: GREEN })

  gate.facts = scanned(NEW_HEAD)
  await driver.advance(pr)

  return entry
})

pairTest('pre-verify', 'waiting', 'slot', async () => {
  const { driver, pr, entry } = setupFor({ A1: CLAIMED }, { routes: GREEN })

  await driver.advance(pr)

  return entry
})

pairTest('pre-verify', 'waiting', 'held', () => held(CLAIMED))

pairTest('pre-verify', 'needs-you', 'code-scanning-alerts', async () => {
  const { manifest, driver, pr, entry, gate } = setupFor({ A1: CLAIMED }, { routes: GREEN })

  manifest.repo.codeScanning = { action: 'block', minSeverity: 'medium' }
  gate.facts = scanned(SHA)
  await driver.advance(pr)

  assert.equal(entry.status.alerts.length, 1)

  return entry
})

pairTest('pre-verify', 'needs-you', 'errors', async () => {
  const setup = setupFor({ A1: { ...CLAIMED, tickErrors: 4 } }, { routes: GREEN })

  setup.gate.error = new Error('gate down')
  await setup.driver.tick()

  return setup.entry
})

pairTest('pre-verify', 'needs-you', 'closed', () => closedOnGitHub(CLAIMED))

// verify

pairTest('verify', 'running', 'verify', async () => {
  const { driver, pr, entry } = verifiableDriver()

  await driver.advance(pr)

  assert.equal(entry.status.sha, SHA)

  return entry
})

pairTest('verify', 'waiting', 'slot', async () => {
  const { driver, pr, entry } = setupFor({ A1: VERIFYING })

  await driver.onDone(pr, 'verify', STOPPED, { sha: SHA, run: 'A1-02-verify' })

  return entry
})

pairTest('verify', 'waiting', 'backoff', async () => {
  const { driver, pr, entry } = setupFor({ A1: VERIFYING })

  await driver.onDone(pr, 'verify', FAILED, { sha: SHA, run: 'A1-02-verify' })

  return entry
})

pairTest('verify', 'waiting', 'held', () => held(VERIFY_AGAIN))

pairTest('verify', 'needs-you', 'dispute', async () => {
  const { manifest, driver, pr, entry } = setupFor(
    { A1: { ...VERIFYING, sessionId: 'session-1', findings: FIRST_ROUND } },
    { rules: CLEAN_TREE },
  )

  const fail = {
    verdict: 'FAIL',
    sha: SHA,
    summary: 'A finding is still open.',
    checklist: [],
    blocking: ['README.md:3 still names the old flag.'],
    nonBlocking: [],
    recheck: [{ id: 'F2', status: 'open', evidence: 'Still undocumented.' }],
  }

  mkdirSync(worktreePath(manifest, pr), { recursive: true })
  await driver.onDone(pr, 'verify', agentResult({ output: fail }), { sha: SHA, run: 'A1-02-verify' })

  assert.deepEqual(entry.status.findings, ['F2'])

  return entry
})

pairTest('verify', 'needs-you', 'attempts-exhausted', async () => {
  const { manifest, driver, pr, entry } = verifiableDriver()

  entry.attempts.verify = manifest.policy.attempts.verify
  await driver.advance(pr)

  return entry
})

pairTest('verify', 'needs-you', 'errors', async () => (await fifthError(VERIFY_AGAIN, { routes: [NOT_FOUND] })).entry)

pairTest('verify', 'needs-you', 'closed', () => closedOnGitHub(VERIFY_AGAIN))

// merge

pairTest('merge', 'running', 'merge', async () => {
  const { entry } = await judged({ merge: 'auto' }, { rules: [{ tool: 'gh', args: 'pr merge 11', stdout: '' }], routes: [prRoute()] })

  assert.equal(entry.gate.action, 'merge')

  return entry
})

pairTest('merge', 'waiting', 'dependencies', async () => {
  const { entry } = await judged({ merge: 'auto' }, { facts: { depsPending: ['A3'] } })

  assert.deepEqual(entry.status.on, ['A3'])

  return entry
})

pairTest('merge', 'waiting', 'ci', async () => {
  const checks = { state: 'pending', missing: ['test'], pending: [], failing: [], runs: [] }
  const { entry } = await judged({ merge: 'auto' }, { facts: { checks } })

  assert.deepEqual([entry.status.sha, entry.status.missing], [SHA, ['test']])

  return entry
})

pairTest('merge', 'waiting', 'base-red', async () => {
  const mainChecks = { state: 'red', sha: MERGE_SHA, missing: [], pending: [], failing: ['test'], runs: [] }
  const { entry } = await judged({ merge: 'auto' }, { facts: { mainChecks } })

  assert.deepEqual([entry.status.sha, entry.status.failing], [MERGE_SHA, ['test']])

  return entry
})

pairTest('merge', 'waiting', 'base-pending', async () => {
  const mainChecks = { state: 'pending', sha: MERGE_SHA, missing: [], pending: ['test'], failing: [], runs: [] }
  const { entry } = await judged({ merge: 'auto' }, { facts: { mainChecks } })

  assert.equal(entry.status.sha, MERGE_SHA)

  return entry
})

pairTest('merge', 'waiting', 'gate-pending', async () => {
  const { manifest, driver, pr, entry } = setupFor({ A1: VERIFYING }, { rules: CLEAN_TREE })
  const pass = { verdict: 'PASS', sha: SHA, summary: 'Every item holds.', checklist: [], blocking: [], nonBlocking: [], recheck: [] }

  mkdirSync(worktreePath(manifest, pr), { recursive: true })
  await driver.onDone(pr, 'verify', agentResult({ output: pass }), { sha: SHA, run: 'A1-02-verify' })

  return entry
})

pairTest('merge', 'waiting', 'mergeable-unknown', async () => (await judged({ merge: 'auto' }, { pr: { mergeable: 'UNKNOWN' } })).entry)

pairTest('merge', 'waiting', 'github-merge-state', async () => {
  const { entry } = await judged({ merge: 'auto' }, { pr: { mergeStateStatus: 'BEHIND' } })

  assert.equal(entry.status.mergeState, 'BEHIND')

  return entry
})

pairTest('merge', 'waiting', 'code-scanning-pending', async () => {
  const { entry } = await judged({ merge: 'auto' }, { facts: scanned(NEW_HEAD) })

  assert.equal(entry.status.sha, SHA)

  return entry
})

pairTest('merge', 'waiting', 'merge-delay', async () => {
  const approvedAt = new Date().toISOString()
  const approved = { patchId: 'patch-a1', sha: SHA, at: approvedAt, channel: 'inbox' }
  const { manifest, entry } = await judged({ merge: 'human' }, { approved })

  assert.equal(Date.parse(entry.status.until), Date.parse(approvedAt) + manifest.policy.mergeDelaySeconds * 1000)

  return entry
})

pairTest('merge', 'waiting', 'queued', async () => {
  const { driver, pr, entry } = setupFor({ A1: VERIFIED }, { policy: { merge: 'manual' } })

  await driver.mergeCandidate(pr, { readyTaken: 13 })

  assert.equal(entry.status.after, 13)

  return entry
})

pairTest('merge', 'waiting', 'review-in-progress', async () => {
  const comment = { id: 501, user: { login: 'maint' }, body: 'Please rename the flag.', created_at: new Date().toISOString() }
  const routes = [
    prRoute(),
    { path: `${PR_11}/comments`, body: [] },
    { path: `${PR_11}/reviews`, body: [] },
    { path: 'repos/example/widgets/issues/11/comments', body: [comment] },
  ]

  const { manifest, driver, entry } = setupFor({ A1: VERIFIED }, { routes })

  manifest.repo.maintainers = ['maint']
  await driver.tick()

  assert.equal(entry.status.lastCommentAt, comment.created_at)

  return entry
})

pairTest('merge', 'waiting', 'held', async () => {
  const entry = held(VERIFIED)
  const { driver, pr } = setupFor({ A1: { ...VERIFIED, held: { at: at(83) } } })

  await driver.mergeCandidate(pr)

  assertStatus(driver.ledger.prs.A1, 'merge', 'waiting', 'held')
  assert.equal(driver.ledger.prs.A1.gate.code, 'held')

  return entry
})

pairTest('merge', 'needs-you', 'approve', async () => (await judged({ merge: 'human' }, { approved: null })).entry)

function githubApprovals(setup) {
  setup.manifest.policy.approval = 'github'
  setup.manifest.repo.maintainers = ['maint']
}

pairTest('merge', 'needs-you', 'review', async () => {
  const setup = setupFor({ A1: { ...VERIFIED, approved: null } })

  githubApprovals(setup)
  await setup.driver.mergeCandidate(setup.pr)

  assert.equal(setup.entry.status.stale, false)

  return setup.entry
})

pairTest('merge', 'needs-you', 'changes-requested', async () => {
  const setup = setupFor({ A1: { ...VERIFIED, approved: null } })

  githubApprovals(setup)
  setup.gate.facts = { reviews: [{ user: 'maint', state: 'CHANGES_REQUESTED', at: new Date().toISOString() }] }
  await setup.driver.mergeCandidate(setup.pr)

  return setup.entry
})

pairTest('merge', 'needs-you', 'merge-by-hand', async () => (await judged({ merge: 'manual' })).entry)

pairTest(
  'merge',
  'needs-you',
  'github-blocked',
  async () => (await judged({ merge: 'auto' }, { pr: { mergeStateStatus: 'BLOCKED' } })).entry,
)

pairTest('merge', 'needs-you', 'merge-refused', async () => {
  const refusal = {
    tool: 'gh',
    args: 'pr merge 11',
    code: 1,
    stderr: 'Pull request example/widgets#11 is not mergeable: the base branch policy prohibits the merge.\n',
  }

  const { entry } = await judged({ merge: 'auto' }, { rules: [refusal], routes: [prRoute()] })

  assert.match(entry.status.error, /not mergeable/)

  return entry
})

pairTest('merge', 'needs-you', 'gate-blocked', async () => {
  const { entry } = await judged({ merge: 'auto' }, { pr: { isDraft: true } })

  assert.deepEqual([entry.status.gate, entry.status.reasons], ['draft', ['PR is a draft']])

  return entry
})

pairTest('merge', 'needs-you', 'code-scanning-alerts', async () => {
  const setup = setupFor({ A1: VERIFIED }, { policy: { merge: 'auto' } })

  setup.manifest.repo.codeScanning = { action: 'block', minSeverity: 'medium' }
  setup.gate.facts = scanned(SHA)
  await setup.driver.mergeCandidate(setup.pr)

  assert.equal(setup.entry.status.alerts.length, 1)
  assert.deepEqual(setup.entry.verified, VERIFIED.verified)

  return setup.entry
})

pairTest('merge', 'needs-you', 'errors', async () => {
  const setup = setupFor({ A1: { ...VERIFIED, tickErrors: 4 } }, { routes: [prRoute()] })

  setup.gate.error = new Error('gate down')
  await setup.driver.tick()

  return setup.entry
})

pairTest('merge', 'needs-you', 'closed', () => closedOnGitHub(VERIFIED))

// The rest of the model

test('gate-pending is a waiting code of merge and of no other stage', () => {
  for (const [stage, codes] of Object.entries(STAGE_STATUSES)) {
    assert.equal(codes.waiting.includes('gate-pending'), stage === 'merge', stage)
  }
})

test('a PASS waits for the gate from the time of the verification, and the next gate run replaces it with its verdict', async () => {
  const { manifest, driver, pr, entry, gate } = setupFor({ A1: VERIFYING }, { rules: CLEAN_TREE, policy: { merge: 'auto' } })
  const pass = { verdict: 'PASS', sha: SHA, summary: 'Every item holds.', checklist: [], blocking: [], nonBlocking: [], recheck: [] }

  mkdirSync(worktreePath(manifest, pr), { recursive: true })
  await driver.onDone(pr, 'verify', agentResult({ output: pass }), { sha: SHA, run: 'A1-02-verify' })

  assert.deepEqual(entry.status, { kind: 'waiting', code: 'gate-pending', since: entry.verified.at })

  gate.pr = { mergeable: 'UNKNOWN' }
  await driver.mergeCandidate(pr)

  assertStatus(entry, 'merge', 'waiting', 'mergeable-unknown')
  assert.equal(entry.status.since, entry.gate.at)
})

test('a ledger opened with a verdict older than its verification waits for the gate, and one with a current verdict has its code', () => {
  const verdict = { action: 'wait', code: 'ci-pending', reasons: ['CI pending'], mergeState: 'CLEAN', sha: SHA }
  const older = setupFor({ A1: { ...VERIFIED, gate: { ...verdict, at: at(70) } } }).entry
  const current = setupFor({ A1: { ...VERIFIED, gate: { ...verdict, at: at(85) } } }).entry

  assertStatus(older, 'merge', 'waiting', 'gate-pending')
  assert.equal(older.status.since, at(80))
  assertStatus(current, 'merge', 'waiting', 'ci')
  assert.equal(current.status.since, at(85))
})

test('commands that pass leave the PR on verify · waiting: slot', async () => {
  const setup = verifiableDriver({ gates: COMMANDS_GATE, runCommand: commandSeam().runCommand })

  await preVerified(setup)

  assertStatus(setup.entry, 'verify', 'waiting', 'slot')
})

test('a PR that stays on pre-verify · waiting: ci for five ticks logs one status event, and a new driver logs none', async () => {
  const ready = { status: 'READY', pr: 11, headSha: SHA, summary: 'Done.' }
  const parked = { state: 'interrupted', interruptedRole: 'report', ready, attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } }
  const { manifest, driver, entry } = setupFor({ A1: parked }, { routes: [prRoute(), runsRoute(SHA, PENDING_RUNS)] })
  const statusEvents = () => readEvents(manifest).filter((event) => event.id === 'A1' && event.kind === 'status')

  await driver.tick()

  const kinds = readEvents(manifest)
    .filter((event) => event.id === 'A1')
    .map((event) => event.kind)

  assert.deepEqual(kinds.slice(-2), ['ready-claimed', 'status'])
  assertStatus(entry, 'pre-verify', 'waiting', 'ci')

  for (let i = 0; i < 4; i += 1) {
    await driver.tick()
    assertStatus(entry, 'pre-verify', 'waiting', 'ci')
  }

  const [{ at: _, ...event }] = statusEvents()

  assert.equal(statusEvents().length, 1)
  assert.deepEqual(event, { id: 'A1', kind: 'status', stage: 'pre-verify', status: 'waiting', code: 'ci' })

  const restarted = createDriver(manifest, {
    notify: () => {},
    cleanup: async () => {},
    collectFacts: async () => gateFacts(manifest),
    runAgent: NEVER,
    runCommand: NEVER,
  })

  await restarted.tick()

  assert.equal(statusEvents().length, 1)
})

test('a hold shows on a waiting PR with its scope, leaves a running and a needs-you PR alone, and its release writes the own code in the same tick', async () => {
  const setup = modelDriver({ A1: { state: 'pending' }, A2: { state: 'blocked', blocked: DECISION }, A3: { state: 'needs_fix', pr: 13 } })
  const { manifest, driver, github } = setup
  const [working, asking, waiting] = ['A1', 'A2', 'A3'].map((id) => driver.ledger.prs[id])

  function others() {
    assertStatus(working, 'implement', 'running', 'implement')
    assertStatus(asking, 'implement', 'needs-you', 'decision')
  }

  function heldWith(scope) {
    assertStatus(waiting, 'implement', 'waiting', 'held')
    assert.equal(waiting.status.scope, scope)
    others()
  }

  github.answer([prRoute({ number: 13, head: { ref: 'feat/a3' } })])
  await launched(setup, 'implement')
  manifest.policy.concurrency = 1

  apply(manifest, driver, { cmd: 'hold', ids: ['A3'] })
  heldWith('pr')

  await driver.tick()
  heldWith('pr')

  apply(manifest, driver, { cmd: 'hold', all: true })
  await driver.tick()
  heldWith('rollout')

  apply(manifest, driver, { cmd: 'release', all: true })
  await driver.tick()
  heldWith('pr')

  postCommand(manifest, { cmd: 'release', ids: ['A3'] })
  await driver.tick()

  assertStatus(waiting, 'implement', 'waiting', 'slot')
  others()
})
