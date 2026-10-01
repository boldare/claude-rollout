import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDriver, doneDetail } from '../lib/driver.mjs'
import { postCommand } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { readEvents } from '../lib/view.mjs'
import { worktreePath } from '../lib/worktree.mjs'
import { at, fakeTools, makeRollout, samplePrs, waitFor } from './fixtures.mjs'

function agentResult(overrides = {}) {
  return { ok: true, output: null, costUsd: 1.25, seconds: 60, denials: [], error: null, stopped: false, ...overrides }
}

function headline(role, output) {
  return doneDetail(role, 'A1-01-run', agentResult({ output })).result
}

// A driver on a fixture rollout. It never sends a desktop notification: a
// test that checks them passes its own notify.
function driverFor(prs, { policy = {}, ...options } = {}) {
  const M = loadManifest(makeRollout({ prs, events: [], policy }))

  return { M, driver: createDriver(M, { notify: () => {}, ...options }) }
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

const SHA = samplePrs().A1.verified.sha
const MERGE_SHA = 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0'
const FETCH = { tool: 'git', args: 'fetch', stdout: '' }
const FETCH_FAILS = { tool: 'git', args: 'fetch', code: 128, stderr: 'fatal: unable to access the remote' }
const GREEN_RUNS = { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] }

// What `gh pr view` prints for PR_FIELDS: A1's PR at the head it was verified at.
function prJson(overrides = {}) {
  return {
    number: 11,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'feat/a1',
    headRefOid: SHA,
    labels: [],
    title: 'feat: A1',
    body: '',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    mergedAt: null,
    url: 'https://github.com/example/demo/pull/11',
    author: { login: 'demo-bot' },
    ...overrides,
  }
}

function viewRule(overrides = {}) {
  const json = prJson(overrides)

  return { tool: 'gh', args: `pr view ${json.number}`, stdout: json }
}

// Facts on which the gate merges A1, in the shape collectFacts returns.
function gateFacts(M, pr = {}) {
  const green = { state: 'green', missing: [], pending: [], failing: [], runs: [] }

  return {
    halted: null,
    depsPending: [],
    files: [],
    addedLines: [],
    commits: [],
    changesets: [],
    baseIsAncestor: true,
    patchId: samplePrs().A1.verified.patchId,
    pr: { ...prJson(), author: 'demo-bot', labels: [M.label], ...pr },
    checks: green,
    mainChecks: green,
    reviews: [],
  }
}

// A driver whose gh and git are fakes, with no slot for an agent. Its gate
// reads gateFacts with `gate.pr` and `gate.facts` on top, or throws `gate.error`.
function tickDriver(prs, { rules = [], only = null, policy = {} } = {}) {
  const dir = makeRollout({ prs, events: [], policy: { concurrency: 0, ...policy } })
  const tools = fakeTools(dir, rules)
  const M = loadManifest(dir, { only })
  const gate = { calls: 0, error: null, pr: {}, facts: {} }
  const notices = []
  const cleaned = []
  const driver = createDriver(M, {
    notify: (_, message) => notices.push(message),
    cleanup: async (pr) => cleaned.push(pr.id),
    collectFacts: async () => {
      gate.calls += 1

      if (gate.error) {
        throw gate.error
      }

      return { ...gateFacts(M, gate.pr), ...gate.facts }
    },
  })

  return { M, driver, tools, gate, notices, cleaned }
}

function eventsSince(M, from = 0) {
  return readEvents(M)
    .slice(from)
    .map(({ at: _, ...event }) => event)
}

function kindsSince(M, from = 0) {
  return eventsSince(M, from).map((event) => event.kind)
}

test('doneDetail: the headline of each role', () => {
  assert.equal(headline('implement', { status: 'READY' }), 'READY')
  assert.equal(headline('fix', { status: 'BLOCKED' }), 'BLOCKED')
  assert.equal(headline('verify', { verdict: 'PASS' }), 'PASS')
  assert.equal(headline('verify', { verdict: 'FAIL' }), 'FAIL')
  assert.equal(headline('brief', { brief: '# A1', questions: [] }), 'BRIEF')
  assert.equal(headline('brief', { brief: '', questions: ['Which API?'] }), 'QUESTIONS')
  assert.equal(headline('delegate', { decision: 'answer' }), 'ANSWER')
  assert.equal(headline('delegate', { decision: 'escalate' }), 'ESCALATE')
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

test('approve is refused under manual and auto, and accepted under human', () => {
  const { sha, patchId } = samplePrs().A1.verified
  const ledger = { A1: { ...samplePrs().A1, held: null, approved: null } }
  const refusals = {
    manual: 'policy.merge is manual: no approval is needed. Merge the PR on GitHub once the driver says it is ready',
    auto: 'policy.merge is auto: no approval is needed. The driver merges once the gate passes, and rollout hold stops it',
  }

  for (const [merge, reason] of Object.entries(refusals)) {
    const notices = []
    const { M, driver } = driverFor(ledger, { notify: (_, message) => notices.push(message) })
    M.policy.merge = merge

    assert.deepEqual(apply(M, driver, { cmd: 'approve', id: 'A1', sha, patchId }), [{ id: 'A1', kind: 'approval-rejected', reason }])
    assert.equal(driver.L.prs.A1.approved, null)
    assert.equal(notices.length, 1, merge)
    assert.ok(notices[0].startsWith('A1: approval rejected: '), notices[0])
  }

  const notices = []
  const { M, driver } = driverFor(ledger, { notify: (_, message) => notices.push(message) })

  assert.deepEqual(apply(M, driver, { cmd: 'approve', id: 'A1', sha, patchId }), [
    { id: 'A1', kind: 'approved', sha: sha.slice(0, 7), channel: 'inbox' },
  ])
  assert.equal(driver.L.prs.A1.approved.channel, 'inbox')
  assert.deepEqual(notices, ['A1: approved PR #11; merging in 120s unless you pause'])
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
  const { M, driver } = driverFor(ledger, {
    notify: (_, message) => notices.push(message),
    collectFacts: async () => ({
      halted: null,
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
        labels: [M.label],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      },
      checks: green,
      mainChecks: green,
      reviews: [...reviews],
    }),
  })
  const pr = M.prs.find((item) => item.id === 'A1')
  const s = driver.L.prs.A1

  // Without a token the manifest refuses approval: github, so the test sets it here.
  M.policy.approval = 'github'
  M.repo.maintainers = ['maint']
  M.dryRun = true

  async function pass() {
    const before = readEvents(M).length
    const sent = notices.length

    await driver.mergeCandidate(pr)

    return {
      kinds: readEvents(M)
        .slice(before)
        .map((event) => event.kind),
      sent: notices.slice(sent),
    }
  }

  s.held = { at: minutesAgo(1) }

  const held = await pass()
  assert.equal(s.approved, null)
  assert.deepEqual(held.sent, [])
  assert.ok(!held.kinds.includes('approved'), held.kinds)

  s.held = null

  const first = await pass()
  assert.deepEqual({ ...s.approved, at: null }, { patchId, sha, at: null, by: 'maint', channel: 'github' })
  assert.ok(Date.now() - Date.parse(s.approved.at) < 60_000, s.approved.at)
  assert.deepEqual(first.sent, ['A1: PR #11 approved on GitHub by maint; merging in 120s unless you pause'])
  assert.ok(!first.kinds.includes('would-merge'), first.kinds)

  const second = await pass()
  assert.deepEqual(second.sent, [])
  assert.ok(!second.kinds.includes('would-merge'), second.kinds)

  s.approved.at = new Date(Date.parse(s.approved.at) - 121_000).toISOString()

  assert.ok((await pass()).kinds.includes('would-merge'))

  reviews.push({ user: 'maint', state: 'CHANGES_REQUESTED', commit: sha, at: minutesAgo(30) })

  await pass()
  assert.equal(s.approved, null)

  reviews.push({ user: 'maint', state: 'APPROVED', commit: sha, at: minutesAgo(10) })

  const again = await pass()
  assert.equal(s.approved.channel, 'github')
  assert.deepEqual(again.sent, ['A1: PR #11 approved on GitHub by maint; merging in 120s unless you pause'])
})

test('tick: a failed fetch counts against no PR, skips the gate and lets the other PRs advance', async () => {
  const { M, driver, tools, gate } = tickDriver(samplePrs(), { rules: [FETCH_FAILS, viewRule()] })

  await driver.tick()

  const events = eventsSince(M)

  assert.deepEqual(
    events.map((event) => event.kind),
    ['fetch-failed'],
  )
  assert.equal(events[0].id, '-')
  assert.equal(events[0].count, 1)
  assert.match(events[0].error, /unable to access the remote/)
  assert.equal(gate.calls, 0)
  assert.equal(driver.L.prs.A2.state, 'interrupted')

  for (const pr of M.prs) {
    assert.equal(driver.L.prs[pr.id].tickErrors ?? 0, 0, pr.id)
  }

  tools.answer([FETCH, viewRule()])
  await driver.tick()

  assert.equal(gate.calls, 1)
  assert.deepEqual(kindsSince(M, events.length), [])
})

test('tick: a driver-wide step that fails five ticks in a row notifies once, and a success starts the count over', async () => {
  const { M, driver, tools, notices } = tickDriver(samplePrs(), { rules: [FETCH_FAILS, viewRule()] })
  const sent = []

  for (let i = 0; i < 6; i += 1) {
    await driver.tick()
    sent.push(notices.length)
  }

  assert.deepEqual(sent, [0, 0, 0, 0, 1, 1])
  assert.match(notices[0], /^-: fetch-failed 5 ticks in a row: git -C /)

  tools.answer([FETCH, viewRule()])
  await driver.tick()
  tools.answer([FETCH_FAILS, viewRule()])
  await driver.tick()

  const counts = eventsSince(M)
    .filter((event) => event.kind === 'fetch-failed')
    .map((event) => event.count)

  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 1])
  assert.equal(notices.length, 1)
})

test('tick: outside dependencies are looked up one by one, and one already merged is not looked up', async () => {
  const mergedA2 = { ...prJson({ number: 12, state: 'MERGED', headRefName: 'feat/a2' }), labels: [{ name: 'rollout:demo' }] }
  const { M, driver, tools } = tickDriver(
    { A1: { state: 'pending' }, A2: { state: 'pending' } },
    {
      only: ['A3'],
      rules: [
        FETCH,
        { tool: 'gh', args: 'pr list --head feat/a1', code: 1, stderr: 'HTTP 401: Bad credentials' },
        { tool: 'gh', args: 'pr list --head feat/a2', stdout: [mergedA2] },
      ],
    },
  )
  const lookups = (from) =>
    tools
      .calls()
      .slice(from)
      .filter((call) => call.tool === 'gh' && call.args[0] === 'pr' && call.args[1] === 'list')
      .map((call) => call.args[3])

  M.prs.find((pr) => pr.id === 'A3').deps = ['A1', 'A2']
  await driver.tick()

  const events = eventsSince(M)
  const failed = events.filter((event) => event.kind === 'outside-deps-failed')

  assert.deepEqual(lookups(0), ['feat/a1', 'feat/a2'])
  assert.equal(driver.L.prs.A1.state, 'pending')
  assert.equal(driver.L.prs.A2.state, 'merged')
  assert.equal(driver.L.prs.A2.pr, 12)
  assert.deepEqual(
    events.filter((event) => event.kind === 'merged-outside-run'),
    [{ id: 'A2', kind: 'merged-outside-run', pr: 12 }],
  )
  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, '-')
  assert.match(failed[0].error, /^A1: gh pr list --head feat\/a1 .*HTTP 401/)
  assert.doesNotMatch(failed[0].error, /A2/)

  const before = tools.calls().length
  tools.answer([FETCH, { tool: 'gh', args: 'pr list --head feat/a1', stdout: [] }])
  await driver.tick()

  assert.deepEqual(lookups(before), ['feat/a1'])
  assert.deepEqual(kindsSince(M, events.length), [])
})

test('tick: a failed base watch halts nothing and is tried again on the next tick', async () => {
  const { M, driver, tools } = tickDriver(
    { ...samplePrs(), A3: { state: 'merged', pr: 13, mergeSha: MERGE_SHA } },
    { rules: [FETCH, viewRule()] },
  )
  driver.L.data.lastMerge = { id: 'A3', sha: MERGE_SHA, at: at(90) }

  await driver.tick()

  const failed = eventsSince(M).filter((event) => event.kind === 'watch-base-failed')

  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, '-')
  assert.match(failed[0].error, /no rule for api .*check-runs/)
  assert.equal(driver.L.data.halted, null)
  assert.equal(driver.L.prs.A2.state, 'interrupted')

  tools.answer([FETCH, viewRule(), { tool: 'gh', args: `commits/${MERGE_SHA}/check-runs`, stdout: GREEN_RUNS }])
  await driver.tick()

  assert.equal(driver.L.data.lastMerge.checked, 'green')
  assert.equal(eventsSince(M).filter((event) => event.kind === 'watch-base-failed').length, 1)
})

test('tick: a deleted manifest.yaml is rejected once, and loads again when it is back', async () => {
  const { M, driver, notices } = tickDriver(samplePrs(), { rules: [FETCH, viewRule()] })
  const file = join(M.dir, 'manifest.yaml')
  const text = readFileSync(file, 'utf8')
  const manifestKinds = () => kindsSince(M).filter((kind) => kind.startsWith('manifest-'))

  rmSync(file)
  await driver.tick()
  await driver.tick()

  assert.deepEqual(manifestKinds(), ['manifest-rejected'])
  assert.deepEqual(notices, ['-: manifest.yaml has an error; keeping the previous one'])
  assert.equal(driver.L.prs.A2.state, 'interrupted')

  writeFileSync(file, text)
  await driver.tick()

  assert.deepEqual(manifestKinds(), ['manifest-rejected', 'manifest-reloaded'])
})

test('guarded: a PR counts one error per tick, a clean tick resets it, and five erroring ticks escalate it once', async () => {
  const viewFails = { tool: 'gh', args: 'pr view 11', code: 1, stderr: 'HTTP 404: Not Found' }
  const { M, driver, tools, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH, viewFails] })
  const entry = driver.L.prs.A1
  const errorCounts = (from) =>
    eventsSince(M, from)
      .filter((event) => event.id === 'A1' && event.kind === 'error')
      .map((event) => event.count)

  gate.error = new Error('gate down')
  await driver.tick()

  assert.deepEqual(errorCounts(0), [1, 1])
  assert.equal(entry.tickErrors, 1)

  tools.answer([FETCH, viewRule()])
  gate.error = null
  await driver.tick()

  assert.equal(entry.tickErrors, 0)

  gate.error = new Error('gate down')

  for (let i = 0; i < 4; i += 1) {
    await driver.tick()
  }

  assert.equal(entry.state, 'verified')
  assert.equal(entry.tickErrors, 4)
  assert.deepEqual(notices, [])

  await driver.tick()

  assert.equal(entry.state, 'escalated')
  assert.equal(kindsSince(M).filter((kind) => kind === 'escalated').length, 1)
  assert.equal(notices.length, 1)
  assert.ok(notices[0].startsWith('A1: repeated errors'), notices[0])

  const before = readEvents(M).length
  tools.answer([FETCH, viewFails])
  await driver.tick()

  assert.deepEqual(errorCounts(before), [6])
  assert.equal(entry.state, 'escalated')
  assert.equal(notices.length, 1)
  assert.equal(kindsSince(M).filter((kind) => kind === 'escalated').length, 1)
})

const VIEW_502 = { tool: 'gh', args: 'pr view 11', code: 1, stderr: 'HTTP 502: Bad Gateway' }
const FETCH_UNREACHABLE = {
  tool: 'git',
  args: 'fetch',
  code: 128,
  stderr: "fatal: unable to access 'https://github.com/example/demo.git/': Could not resolve host: github.com",
}

// Runs the ticks and returns how many github-unavailable events each one logged.
async function unavailablePerTick(M, driver, ticks) {
  const counts = []

  for (let i = 0; i < ticks; i += 1) {
    const before = readEvents(M).length
    await driver.tick()
    counts.push(kindsSince(M, before).filter((kind) => kind === 'github-unavailable').length)
  }

  return counts
}

test('tick: six ticks of HTTP 502 escalate nothing, and an outage of 30 minutes notifies once and again when it ends', async () => {
  const { M, driver, tools, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH, VIEW_502] })
  const entry = driver.L.prs.A1
  gate.error = new Error('gh api -X GET repos/example/demo/pulls/11/reviews -f per_page=100 exited 1: gh: Server Error (HTTP 500)')

  assert.deepEqual(await unavailablePerTick(M, driver, 6), [1, 1, 1, 1, 1, 1])
  assert.deepEqual(kindsSince(M), Array(6).fill('github-unavailable'))
  assert.equal(entry.state, 'verified')
  assert.equal(entry.tickErrors ?? 0, 0)
  assert.equal(entry.lastError, null)
  assert.equal(gate.calls, 6)
  assert.deepEqual(notices, [])

  const [first] = eventsSince(M)
  const outage = driver.L.data.githubUnavailable

  assert.deepEqual({ ...first, error: null }, { id: '-', kind: 'github-unavailable', source: 'A1', error: null, minutes: 0 })
  assert.match(first.error, /^gh pr view 11 --json .* exited 1: HTTP 502: Bad Gateway$/)
  assert.equal(outage.notified, false)
  assert.deepEqual(JSON.parse(readFileSync(join(M.dir, 'ledger.json'), 'utf8')).githubUnavailable, outage)

  outage.since = new Date(Date.parse(outage.since) - 31 * 60_000).toISOString()
  await driver.tick()

  assert.deepEqual(notices, [
    '-: GitHub has been unreachable for 31 minutes. The driver keeps trying every tick. Last error: HTTP 502: Bad Gateway',
  ])
  assert.equal(driver.L.data.githubUnavailable.notified, true)

  await driver.tick()

  assert.equal(notices.length, 1)

  tools.answer([FETCH, viewRule()])
  gate.error = null
  const before = readEvents(M).length
  await driver.tick()

  assert.deepEqual(eventsSince(M, before), [{ id: '-', kind: 'github-back', minutes: 31 }])
  assert.deepEqual(notices.slice(1), ['-: GitHub answers again after 31 minutes'])
  assert.equal(driver.L.data.githubUnavailable, null)

  const after = readEvents(M).length
  await driver.tick()

  assert.deepEqual(kindsSince(M, after), [])
  assert.equal(notices.length, 2)
})

test('guarded: an outage neither counts nor resets the errors of a PR, and a short one ends with github-back and no notice', async () => {
  const { M, driver, tools, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, tickErrors: 3 } }, { rules: [FETCH, VIEW_502] })
  const entry = driver.L.prs.A1

  await driver.tick()

  assert.equal(entry.tickErrors, 3)
  assert.deepEqual(kindsSince(M), ['github-unavailable'])

  gate.error = new Error('gate down')
  const mixed = readEvents(M).length
  await driver.tick()

  assert.equal(entry.tickErrors, 4)
  assert.deepEqual(
    eventsSince(M, mixed).map((event) => [event.kind, event.count]),
    [
      ['github-unavailable', undefined],
      ['error', 4],
    ],
  )

  tools.answer([FETCH, viewRule()])
  gate.error = null
  const before = readEvents(M).length
  await driver.tick()

  assert.equal(entry.tickErrors, 0)
  assert.deepEqual(eventsSince(M, before), [{ id: '-', kind: 'github-back', minutes: 0 }])
  assert.equal(driver.L.data.githubUnavailable, null)
  assert.deepEqual(notices, [])
})

test('tick: a fetch lost to an outage skips the gate, logs no fetch-failed and leaves the count of fetch failures alone', async () => {
  const { M, driver, tools, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH_UNREACHABLE, viewRule()] })

  assert.deepEqual(await unavailablePerTick(M, driver, 5), [1, 1, 1, 1, 1])
  assert.deepEqual(
    eventsSince(M).map((event) => [event.kind, event.source]),
    Array(5).fill(['github-unavailable', 'fetch']),
  )
  assert.equal(gate.calls, 0)
  assert.deepEqual(notices, [])

  for (const fetch of [FETCH_FAILS, FETCH_UNREACHABLE, FETCH_FAILS]) {
    tools.answer([fetch, viewRule()])
    await driver.tick()
  }

  assert.deepEqual(
    eventsSince(M)
      .filter((event) => event.kind === 'fetch-failed')
      .map((event) => event.count),
    [1, 2],
  )
  assert.equal(gate.calls, 0)
  assert.deepEqual(notices, [])
})

test('runTick: a failed tick never rejects, and the fifth in a row notifies once', async () => {
  const { M, driver, notices } = tickDriver(samplePrs(), { rules: [FETCH, viewRule()] })
  const save = driver.L.save
  const tickErrors = () => eventsSince(M).filter((event) => event.kind === 'tick-error')

  function failSave() {
    throw new Error('disk full')
  }

  driver.L.save = failSave

  for (let i = 0; i < 5; i += 1) {
    await driver.runTick()
  }

  assert.deepEqual(
    tickErrors().map((event) => event.count),
    [1, 2, 3, 4, 5],
  )
  assert.match(tickErrors()[0].error, /disk full/)
  assert.deepEqual(notices, ['5 ticks in a row failed: disk full'])
  assert.match(readFileSync(join(M.dir, 'heartbeat'), 'utf8'), / tick-error disk full$/)

  await driver.runTick()

  assert.equal(tickErrors().at(-1).count, 6)
  assert.equal(notices.length, 1)

  driver.L.save = save
  await driver.runTick()
  driver.L.save = failSave
  await driver.runTick()

  assert.deepEqual(
    tickErrors().map((event) => event.count),
    [1, 2, 3, 4, 5, 6, 1],
  )
  assert.equal(notices.length, 1)
})

const IMPLEMENTING = { state: 'implementing', sessionId: 'session-1', attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } }
const NEW_HEAD = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'
const READY = agentResult({ output: { status: 'READY', pr: 12, headSha: NEW_HEAD, summary: 'Done.' } })

test('onDone: a READY report GitHub could not read waits, and a later tick claims it with no agent', async () => {
  const { M, driver, tools } = tickDriver(
    { A1: IMPLEMENTING },
    { rules: [FETCH, { tool: 'gh', args: 'pr view 12', code: 1, stderr: 'HTTP 502: Bad Gateway' }] },
  )
  const pr = M.prs.find((item) => item.id === 'A1')
  const entry = driver.L.prs.A1

  await driver.onDone(pr, 'implement', READY, { run: 'A1-01-implement' })

  const events = eventsSince(M)

  assert.equal(entry.state, 'interrupted')
  assert.equal(entry.interruptedRole, 'report')
  assert.match(entry.lastError, /HTTP 502/)
  assert.deepEqual(
    events.map((event) => event.kind),
    ['implement-done', 'report-unchecked'],
  )
  assert.match(events[1].error, /HTTP 502/)
  assert.equal(entry.attempts.fix, 0)

  tools.answer([FETCH, viewRule({ number: 12, headRefOid: NEW_HEAD })])
  await driver.tick()

  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.interruptedRole, null)
  assert.equal(entry.pr, 12)
  assert.equal(entry.claimedSha, NEW_HEAD)
  assert.equal(entry.attempts.fix, 0)
  assert.equal(driver.running.size, 0)
  assert.deepEqual(kindsSince(M, events.length), ['ready-claimed'])
})

test('onDone: a READY report that names a PR GitHub does not know still goes to a fix run', async () => {
  const unknown = [
    'GraphQL: Could not resolve to a PullRequest with the number of 12. (repository.pullRequest)',
    'no pull requests found for branch "feat/a1"',
  ]

  for (const stderr of unknown) {
    const { M, driver } = tickDriver({ A1: IMPLEMENTING }, { rules: [{ tool: 'gh', args: 'pr view 12', code: 1, stderr }] })
    const entry = driver.L.prs.A1

    await driver.onDone(
      M.prs.find((item) => item.id === 'A1'),
      'implement',
      READY,
      { run: 'A1-01-implement' },
    )

    assert.equal(entry.state, 'needs_fix', stderr)
    assert.equal(entry.fixReason, 'report does not match GitHub')
    assert.match(entry.fixNote, /^PR #12 could not be read/)
    assert.deepEqual(eventsSince(M).at(-1), { id: 'A1', kind: 'needs-fix', reason: 'report does not match GitHub' })
    assert.deepEqual(kindsSince(M), ['implement-done', 'needs-fix'])
  }
})

test('onDone: a READY report whose PR answers 404 waits, and counts as an error of the PR on the next tick', async () => {
  const notFound = { tool: 'gh', args: 'pr view 12', code: 1, stderr: 'HTTP 404: Not Found' }
  const { M, driver } = tickDriver({ A1: IMPLEMENTING }, { rules: [FETCH, notFound] })
  const pr = M.prs.find((item) => item.id === 'A1')
  const entry = driver.L.prs.A1

  await driver.onDone(pr, 'implement', READY, { run: 'A1-01-implement' })

  const events = eventsSince(M)

  assert.equal(entry.state, 'interrupted')
  assert.equal(entry.interruptedRole, 'report')
  assert.equal(entry.attempts.fix, 0)
  assert.deepEqual(
    events.map((event) => event.kind),
    ['implement-done', 'report-unchecked'],
  )
  assert.match(events[1].error, /HTTP 404: Not Found/)

  await driver.tick()

  const later = eventsSince(M, events.length)

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
  const { M, driver } = tickDriver({ A1: parked }, { rules: [FETCH, viewRule({ number: 12, headRefOid: NEW_HEAD, state: 'CLOSED' })] })
  const entry = driver.L.prs.A1

  await driver.tick()

  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'report does not match GitHub')
  assert.equal(entry.interruptedRole, null)
  assert.deepEqual(kindsSince(M), ['needs-fix'])
})

const GATE_BLOCK = { kind: 'gate', question: 'PR is a draft', evidence: '' }

test('retry: a PR whose verification still holds goes back to verified, keeps its hold, and the gate looks again with no agent', async () => {
  for (const state of [
    { state: 'escalated', tickErrors: 5 },
    { state: 'blocked', blocked: GATE_BLOCK },
  ]) {
    const { M, driver, gate } = tickDriver({ A1: { ...samplePrs().A1, ...state } }, { rules: [FETCH, viewRule()] })
    const entry = driver.L.prs.A1

    assert.deepEqual(apply(M, driver, { cmd: 'retry', id: 'A1' }), [{ id: 'A1', kind: 'retry', state: 'verified' }], state.state)
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
  const { M, driver } = tickDriver({ A1: stale }, { rules: [FETCH, viewRule()] })
  const entry = driver.L.prs.A1

  assert.deepEqual(apply(M, driver, { cmd: 'retry', id: 'A1' }), [{ id: 'A1', kind: 'retry', state: 'ready_claimed' }])
  assert.equal(entry.verified, null)
  assert.equal(entry.ciPendingSince, null)
  assert.equal(entry.interruptedRole, null)
  assert.equal(entry.claimedSha, SHA)
})

test('note: an answer to a gate block on a verified PR drops the verification', () => {
  const { M, driver } = tickDriver({ A1: { ...samplePrs().A1, state: 'blocked', blocked: GATE_BLOCK } }, { rules: [FETCH, viewRule()] })
  const entry = driver.L.prs.A1

  assert.deepEqual(apply(M, driver, { cmd: 'note', id: 'A1', text: 'Mark it ready for review.' }), [
    { id: 'A1', kind: 'needs-fix', reason: 'answer from the maintainer' },
  ])
  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixNote, 'Mark it ready for review.')
  assert.equal(entry.verified, null)
})

test('retry: a parked READY report stays parked, and the next tick claims it with no agent', async () => {
  const parked = { ...IMPLEMENTING, state: 'escalated', interruptedRole: 'report', ready: READY.output }
  const { M, driver } = tickDriver({ A1: parked }, { rules: [FETCH, viewRule({ number: 12, headRefOid: NEW_HEAD })] })
  const entry = driver.L.prs.A1

  assert.deepEqual(apply(M, driver, { cmd: 'retry', id: 'A1' }), [{ id: 'A1', kind: 'retry', state: 'interrupted' }])
  assert.equal(entry.interruptedRole, 'report')

  const before = readEvents(M).length
  await driver.tick()

  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.interruptedRole, null)
  assert.equal(entry.pr, 12)
  assert.equal(entry.claimedSha, NEW_HEAD)
  assert.equal(entry.attempts.fix, 0)
  assert.equal(driver.running.size, 0)
  assert.deepEqual(kindsSince(M, before), ['ready-claimed'])
})

test('mergeCandidate: a merge GitHub has not confirmed stays verified until a sync sees it merged', async () => {
  const earlier = { id: 'A3', sha: MERGE_SHA.replaceAll('f', 'c'), at: at(70), checked: 'green' }
  const { M, driver, tools, notices, cleaned } = tickDriver(
    { A1: { ...samplePrs().A1, held: null }, A3: { state: 'merged', pr: 13, mergeSha: earlier.sha } },
    {
      policy: { merge: 'auto' },
      rules: [
        { tool: 'gh', args: 'pr merge 11', stdout: '' },
        { tool: 'gh', args: '--json state,mergeCommit', stdout: { state: 'OPEN', mergeCommit: null } },
      ],
    },
  )
  const pr = M.prs.find((item) => item.id === 'A1')
  const entry = driver.L.prs.A1
  driver.L.data.lastMerge = structuredClone(earlier)

  assert.equal(await driver.mergeCandidate(pr), true)

  const events = eventsSince(M)

  assert.ok(tools.calls().some((call) => call.args.join(' ').startsWith(`pr merge 11 --squash --match-head-commit ${SHA}`)))
  assert.equal(entry.state, 'verified')
  assert.equal(entry.gate.action, 'merge')
  assert.equal(entry.mergeSha, undefined)
  assert.deepEqual(driver.L.data.lastMerge, earlier)
  assert.deepEqual(cleaned, [])
  assert.deepEqual(notices, [])
  assert.deepEqual(events, [
    { id: 'A1', kind: 'gate-merge', reasons: [] },
    { id: 'A1', kind: 'merge-unconfirmed', pr: 11, sha: SHA.slice(0, 7) },
  ])

  tools.answer([
    FETCH,
    { tool: 'gh', args: '--json state,mergeCommit', stdout: { state: 'MERGED', mergeCommit: { oid: MERGE_SHA } } },
    viewRule({ state: 'MERGED' }),
  ])
  await driver.tick()

  assert.equal(entry.state, 'merged')
  assert.equal(entry.mergeSha, MERGE_SHA)
  assert.equal(driver.L.data.lastMerge.id, 'A1')
  assert.equal(driver.L.data.lastMerge.sha, MERGE_SHA)
  assert.deepEqual(cleaned, ['A1'])
  assert.deepEqual(notices, ['A1: merged PR #11'])
  assert.deepEqual(eventsSince(M, events.length), [{ id: 'A1', kind: 'merged', pr: 11 }])
})

test('mergeCandidate: a PR merged on GitHub while the gate reads it waits for sync, with no notification', async () => {
  const { M, driver, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  gate.pr = { state: 'MERGED' }

  assert.equal(await driver.mergeCandidate(M.prs.find((item) => item.id === 'A1')), false)
  assert.equal(driver.L.prs.A1.state, 'verified')
  assert.deepEqual(eventsSince(M), [{ id: 'A1', kind: 'gate-wait', reasons: ['merged on GitHub (the next sync records it)'] }])
  assert.deepEqual(notices, [])
})

test('checkClaim: a claimed PR merged or closed since sync is left to the next sync', async () => {
  const claimed = { state: 'ready_claimed', pr: 11, claimedSha: SHA, attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } }

  for (const state of ['MERGED', 'CLOSED']) {
    const { M, driver, tools, gate } = tickDriver({ A1: claimed }, { rules: [viewRule({ state })] })

    await driver.advance(M.prs.find((item) => item.id === 'A1'))

    assert.equal(driver.L.prs.A1.state, 'ready_claimed', state)
    assert.deepEqual(kindsSince(M), [], state)
    assert.ok(!tools.calls().some((call) => call.args.join(' ').includes('check-runs')), state)
    assert.equal(gate.calls, 0, state)
  }

  const { M, driver, tools, gate } = tickDriver(
    { A1: claimed },
    { rules: [viewRule(), { tool: 'gh', args: `commits/${SHA}/check-runs`, stdout: GREEN_RUNS }] },
  )
  gate.pr = { state: 'MERGED' }

  await driver.advance(M.prs.find((item) => item.id === 'A1'))

  assert.ok(tools.calls().some((call) => call.args.join(' ').includes('check-runs')))
  assert.equal(gate.calls, 1)
  assert.equal(driver.L.prs.A1.state, 'ready_claimed')
  assert.equal(driver.L.prs.A1.claimPatchId, undefined)
  assert.deepEqual(kindsSince(M), [])
})

const PREFIX = "Answer from the delegate, on the maintainer's behalf, from the plan:\n\n"
const DECISION = { kind: 'needs-decision', question: 'Keep the old flag?', evidence: 'cli.mjs:12 still reads it.' }
const BRIEF_QUESTIONS = { kind: 'brief-questions', question: 'Which API?', evidence: 'The plan names two.' }

function delegateReport(overrides = {}) {
  return agentResult({
    output: {
      decision: 'answer',
      answer: '  Keep it as an alias.  ',
      planRefs: ['Decisions: flags'],
      reasoning: 'The plan keeps it.',
      ...overrides,
    },
  })
}

// A blocked A1 under policy.delegate, with its worktree in place so no git
// runs, and a fake runAgent that records its calls. Each call gets the next
// of `results`: a result, or a promise the test resolves.
function delegateDriver(state, { policy = { delegate: {} }, results = [], brief = true } = {}) {
  const notices = []
  const calls = []
  const runAgent = async (_, pr, options) => {
    calls.push({ id: pr.id, ...options })

    return results.shift() ?? delegateReport()
  }
  const { M, driver } = driverFor(
    { A1: { state: 'blocked', blocked: DECISION, ...state } },
    { policy, runAgent, notify: (_, message) => notices.push(message) },
  )
  const pr = M.all.find((item) => item.id === 'A1')

  mkdirSync(worktreePath(M, pr), { recursive: true })

  if (brief) {
    mkdirSync(dirname(pr.brief), { recursive: true })
    writeFileSync(pr.brief, '# A1\n')
  }

  return { M, driver, pr, s: driver.L.prs.A1, notices, calls }
}

async function advanced(driver, pr) {
  await driver.advance(pr)
  await waitFor(() => driver.running.size === 0, 'the delegate to finish')
}

test('delegate: no run while it is off, for a kind it never answers, or with a note pending', async () => {
  const cases = [
    { state: {}, policy: {} },
    { state: { blocked: { kind: 'ci', question: 'CI is red three times.', evidence: '' } }, policy: { delegate: {} } },
    { state: { pendingNote: 'Wait for me.' }, policy: { delegate: {} } },
  ]

  for (const { state, policy } of cases) {
    const { M, driver, pr, s, notices, calls } = delegateDriver({ pr: 11, ...state }, { policy })

    await advanced(driver, pr)

    assert.deepEqual(calls, [])
    assert.deepEqual(kindsSince(M), [])
    assert.deepEqual(notices, [])
    assert.equal(s.state, 'blocked')
    assert.equal(s.delegate.runs, 0)
  }
})

test('delegate: an answer to brief questions gives the brief attempt back and notifies', async () => {
  const { M, driver, pr, s, notices, calls } = delegateDriver(
    { blocked: BRIEF_QUESTIONS, attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } },
    { brief: false },
  )

  await advanced(driver, pr)

  assert.equal(s.state, 'pending')
  assert.equal(s.blocked, null)
  assert.equal(s.attempts.brief, 0)
  assert.deepEqual(s.briefAnswers, [{ question: 'Which API?', answer: `${PREFIX}Keep it as an alias.` }])
  assert.deepEqual(kindsSince(M), ['delegate-start', 'delegate-done', 'brief-answered', 'delegate-answered'])
  assert.deepEqual(eventsSince(M)[0], {
    id: 'A1',
    kind: 'delegate-start',
    run: 'A1-01-delegate',
    log: 'logs/A1-01-delegate.jsonl',
    effort: 'high',
    blocked: 'brief-questions',
  })
  assert.equal(notices.length, 1)
  assert.ok(notices[0].includes('Override with rollout note A1'), notices[0])

  assert.equal(calls.length, 1)
  assert.equal(calls[0].role, 'delegate')
  assert.equal(calls[0].cwd, worktreePath(M, pr))
  assert.equal(calls[0].effort, 'high')
  assert.equal(calls[0].resume, false)
  assert.equal(calls[0].logName, 'A1-01-delegate')
  assert.ok(calls[0].prompt.includes('Which API?'))

  assert.equal(s.delegate.runs, 1)
  assert.equal(s.costUsd, 1.25)
  assert.deepEqual(
    s.delegate.answers.map((entry) => [entry.decision, entry.kind, entry.question, entry.answer, entry.run]),
    [['answer', 'brief-questions', 'Which API?', '  Keep it as an alias.  ', 'A1-01-delegate']],
  )
  assert.deepEqual(
    s.noteHistory.map((entry) => [entry.by, entry.kind, entry.question]),
    [['delegate', 'brief-questions', 'Which API?']],
  )
})

test('delegate: an answer to needs-decision sends the PR to a fix run with the answer', async () => {
  const { M, driver, pr, s, notices } = delegateDriver({ pr: 11, sessionId: 'session-1' })

  await advanced(driver, pr)

  assert.equal(s.state, 'needs_fix')
  assert.equal(s.fixReason, 'answer from the delegate')
  assert.ok(s.fixNote.startsWith(PREFIX), s.fixNote)
  assert.deepEqual(kindsSince(M), ['delegate-start', 'delegate-done', 'needs-fix', 'delegate-answered'])
  assert.deepEqual(eventsSince(M).at(-1), {
    id: 'A1',
    kind: 'delegate-answered',
    run: 'A1-01-delegate',
    blocked: 'needs-decision',
    planRefs: ['Decisions: flags'],
  })
  assert.equal(notices.length, 1)
  assert.ok(notices[0].includes('Override with rollout note A1'), notices[0])
})

test('delegate: an escalation keeps the PR blocked, notifies once, and the same question starts no second run', async () => {
  const escalate = delegateReport({ decision: 'escalate', answer: '', planRefs: [], reasoning: 'The plan is silent on the flag.' })
  const { M, driver, pr, s, notices, calls } = delegateDriver({ pr: 11 }, { results: [escalate] })

  await advanced(driver, pr)
  await advanced(driver, pr)

  assert.equal(calls.length, 1)
  assert.equal(s.state, 'blocked')
  assert.deepEqual(eventsSince(M).slice(2), [
    { id: 'A1', kind: 'delegate-escalated', run: 'A1-01-delegate', blocked: 'needs-decision', reason: 'The plan is silent on the flag.' },
  ])
  assert.equal(notices.length, 1)
  assert.ok(notices[0].includes('passes this to you (needs-decision): Keep the old flag?'), notices[0])
  assert.ok(notices[0].includes('Reason: The plan is silent on the flag.'), notices[0])
  assert.deepEqual(
    s.delegate.answers.map((entry) => entry.decision),
    ['escalate'],
  )
})

test('delegate: an empty answer is an escalation', async () => {
  const { M, driver, pr, s } = delegateDriver({ pr: 11 }, { results: [delegateReport({ answer: '  ' })] })

  await advanced(driver, pr)

  assert.equal(s.state, 'blocked')
  assert.equal(eventsSince(M).at(-1).reason, 'the delegate gave an empty answer')
})

test('delegate: at maxPerPr it starts nothing and notifies once', async () => {
  const { M, driver, pr, s, notices, calls } = delegateDriver({
    pr: 11,
    delegate: { runs: 2, lastQuestion: null, limitNotified: false, answers: [] },
  })

  await advanced(driver, pr)
  await advanced(driver, pr)

  assert.deepEqual(calls, [])
  assert.deepEqual(eventsSince(M), [{ id: 'A1', kind: 'delegate-limit', runs: 2, maxPerPr: 2 }])
  assert.equal(notices.length, 1)
  assert.ok(notices[0].includes('policy.delegate.maxPerPr'), notices[0])
  assert.equal(s.delegate.limitNotified, true)
})

test('delegate: a maintainer note while it runs applies at once, and the late answer is dropped', async () => {
  let finish
  const late = new Promise((resolve) => {
    finish = resolve
  })
  const { M, driver, pr, s, notices } = delegateDriver({ pr: 11 }, { results: [late] })

  await driver.advance(pr)
  assert.equal(driver.running.get('A1'), 'delegate')

  assert.deepEqual(apply(M, driver, { cmd: 'note', id: 'A1', text: 'Drop the old flag.' }), [
    { id: 'A1', kind: 'needs-fix', reason: 'answer from the maintainer' },
  ])
  assert.equal(s.state, 'needs_fix')

  finish(delegateReport())
  await waitFor(() => driver.running.size === 0, 'the delegate to finish')

  const kinds = kindsSince(M)

  assert.deepEqual(kinds.slice(-2), ['delegate-done', 'delegate-dropped'])
  assert.ok(!kinds.includes('delegate-answered'))
  assert.equal(s.state, 'needs_fix')
  assert.equal(s.fixNote, 'Drop the old flag.')
  assert.deepEqual(eventsSince(M).at(-1), { id: 'A1', kind: 'delegate-dropped', run: 'A1-01-delegate', state: 'needs_fix' })
  assert.deepEqual(
    s.delegate.answers.map((entry) => entry.decision),
    ['dropped'],
  )
  assert.deepEqual(notices, [])
})

test('delegate: a failed run escalates, backs off, and the same question starts no second run', async () => {
  const failure = agentResult({ ok: false, output: null, error: 'killed by SIGKILL', costUsd: 0.5, seconds: 300 })
  const { M, driver, pr, s, notices, calls } = delegateDriver({ pr: 11 }, { results: [failure] })

  await advanced(driver, pr)

  assert.equal(s.state, 'blocked')
  assert.equal(s.failStreak, 1)
  assert.ok(Date.parse(s.retryAfter) > Date.now())
  assert.equal(s.lastError, 'killed by SIGKILL')
  assert.deepEqual(kindsSince(M), ['delegate-start', 'delegate-done', 'delegate-escalated'])
  assert.equal(eventsSince(M).at(-1).reason, 'the run failed: killed by SIGKILL')
  assert.equal(notices.length, 1)
  assert.deepEqual(
    s.delegate.answers.map((entry) => [entry.decision, entry.reasoning]),
    [['failed', 'killed by SIGKILL']],
  )

  s.retryAfter = null
  await advanced(driver, pr)

  assert.equal(calls.length, 1)
})

test('delegate: a stopped run gives its run back, and a PR merged meanwhile is cleaned up', async () => {
  const cleaned = []
  const { driver, pr, s } = delegateDriver({ pr: 11, delegate: { runs: 1, lastQuestion: null, limitNotified: false, answers: [] } })
  const context = { run: 'A1-01-delegate', question: 'q', blocked: DECISION }

  await driver.onDelegateDone(pr, agentResult({ ok: false, stopped: true, output: null, error: 'driver stopping' }), context)

  assert.equal(s.delegate.runs, 0)
  assert.equal(s.delegate.lastQuestion, null)
  assert.deepEqual(s.delegate.answers, [])

  const merged = driverFor({ A1: { state: 'merged', pr: 11 } }, { cleanup: async (item) => cleaned.push(item.id) })

  await merged.driver.onDelegateDone(pr, delegateReport(), context)

  assert.deepEqual(cleaned, ['A1'])
  assert.equal(merged.driver.L.prs.A1.state, 'merged')
  assert.deepEqual(merged.driver.L.prs.A1.delegate.answers, [])
})

test('retry resets the delegate run count and keeps its answers, and waits while the delegate runs', () => {
  const answers = [{ decision: 'escalate', question: 'Keep the old flag?' }]
  const { M, driver, s } = delegateDriver({ pr: 11, delegate: { runs: 2, lastQuestion: 'abc', limitNotified: true, answers } })

  driver.running.set('A1', 'delegate')
  assert.deepEqual(apply(M, driver, { cmd: 'retry', id: 'A1' }), [
    { id: 'A1', kind: 'command-rejected', command: 'retry', reason: 'an agent is working on this PR' },
  ])

  driver.running.delete('A1')
  apply(M, driver, { cmd: 'retry', id: 'A1' })

  assert.deepEqual(s.delegate, { runs: 0, lastQuestion: 'abc', limitNotified: false, answers })
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
    url: 'https://github.com/example/demo/security/code-scanning/4',
    sha: SHA,
    ...overrides,
  }
}

function scanned(alerts) {
  return { codeScanning: { available: true, alerts, baseOpen: [] } }
}

const ALERT_REASON =
  'CodeQL js/shell-command-injection-from-environment (medium) bin/rollout.mjs:357: This shell command depends on an uncontrolled absolute path. https://github.com/example/demo/security/code-scanning/4'
const CLAIMED = { state: 'ready_claimed', pr: 11, claimedSha: SHA, attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } }

// A claimed A1 with green CI on its head, and the given code scanning facts.
function claimDriver(facts) {
  const setup = tickDriver({ A1: CLAIMED }, { rules: [viewRule(), { tool: 'gh', args: `commits/${SHA}/check-runs`, stdout: GREEN_RUNS }] })
  setup.gate.facts = facts

  return { ...setup, pr: setup.M.prs.find((item) => item.id === 'A1'), entry: setup.driver.L.prs.A1 }
}

test('checkClaim: a new code scanning alert on the head goes back to the implementer before verification', async () => {
  const { M, driver, pr, entry } = claimDriver(scanned([scanAlert()]))

  await driver.advance(pr)

  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'code scanning')
  assert.ok(entry.fixNote.includes(`- ${ALERT_REASON}`))
  assert.match(entry.fixNote, /Never silence the analyser/)
  assert.match(entry.fixNote, /needs-decision/)
  assert.match(entry.fixNote, /gh api repos\/example\/demo\/code-scanning\/alerts\/<number>/)
  assert.equal(entry.claimPatchId, undefined)
  assert.equal(entry.patchSince, undefined)
  assert.deepEqual(eventsSince(M), [{ id: 'A1', kind: 'needs-fix', reason: 'code scanning' }])
})

test('checkClaim: with action block, a new alert blocks the PR for the maintainer', async () => {
  const { M, driver, pr, entry, notices } = claimDriver(scanned([scanAlert()]))
  M.repo.codeScanning = { action: 'block', minSeverity: 'medium' }

  await driver.advance(pr)

  assert.equal(entry.state, 'blocked')
  assert.equal(entry.blocked.kind, 'code-scanning')
  assert.equal(entry.blocked.evidence, ALERT_REASON)
  assert.match(entry.blocked.question, /^PR #11 has new code scanning alerts\. Dismiss a false positive on GitHub and run rollout retry/)
  assert.equal(entry.verified, null)
  assert.equal(entry.claimPatchId, undefined)
  assert.deepEqual(eventsSince(M), [{ id: 'A1', kind: 'blocked', reason: 'code-scanning' }])
  assert.deepEqual(notices, [`A1: blocked (code-scanning): ${ALERT_REASON.slice(0, 120)}`])
})

test('checkClaim: an alert from an older commit waits for the analysis of the head, logged once', async () => {
  const { M, driver, pr, entry, notices } = claimDriver(scanned([scanAlert({ sha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2' })]))

  await driver.advance(pr)
  await driver.advance(pr)

  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.claimPatchId, undefined)
  assert.deepEqual(eventsSince(M), [
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
  const unavailable = { codeScanning: { available: false, reason: 'gh: no analysis found (HTTP 404)', alerts: [], baseOpen: [] } }
  const { M, driver, pr, entry, notices } = claimDriver(unavailable)

  await driver.advance(pr)
  await driver.advance(pr)

  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.claimPatchId, samplePrs().A1.verified.patchId)
  assert.deepEqual(eventsSince(M), [{ id: 'A1', kind: 'code-scanning-unavailable', reason: 'gh: no analysis found (HTTP 404)' }])
  assert.equal(entry.notified.codeScanningUnavailable, true)
  assert.deepEqual(notices, [])
})

test('checkClaim: no new alert, or one below the threshold, goes on to verification', async () => {
  for (const alerts of [[], [scanAlert({ securitySeverity: 'low' })]]) {
    const { M, driver, pr, entry } = claimDriver(scanned(alerts))

    await driver.advance(pr)

    assert.equal(entry.state, 'ready_claimed', JSON.stringify(alerts))
    assert.equal(entry.claimPatchId, samplePrs().A1.verified.patchId, JSON.stringify(alerts))
    assert.deepEqual(kindsSince(M), [], JSON.stringify(alerts))
  }
})

test('mergeCandidate: a new code scanning alert drops the verification and goes back to the implementer', async () => {
  const { M, driver, gate } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  const entry = driver.L.prs.A1
  gate.facts = scanned([scanAlert()])

  assert.equal(await driver.mergeCandidate(M.prs.find((item) => item.id === 'A1')), false)
  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'code scanning')
  assert.equal(entry.verified, null)
  assert.ok(entry.fixNote.includes(`- ${ALERT_REASON}`))
  assert.match(entry.fixNote, /Never silence the analyser/)
  assert.match(entry.fixNote, /needs-decision/)
  assert.deepEqual(eventsSince(M), [
    { id: 'A1', kind: 'gate-fix', reasons: [ALERT_REASON] },
    { id: 'A1', kind: 'needs-fix', reason: 'code scanning' },
  ])
})

test('mergeCandidate: with action block, a new code scanning alert blocks and drops the verification', async () => {
  const { M, driver, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  const entry = driver.L.prs.A1
  M.repo.codeScanning = { action: 'block', minSeverity: 'medium' }
  gate.facts = scanned([scanAlert()])

  assert.equal(await driver.mergeCandidate(M.prs.find((item) => item.id === 'A1')), false)
  assert.equal(entry.state, 'blocked')
  assert.equal(entry.blocked.kind, 'code-scanning')
  assert.equal(entry.blocked.evidence, ALERT_REASON)
  assert.equal(entry.verified, null)
  assert.deepEqual(eventsSince(M), [
    { id: 'A1', kind: 'gate-block', reasons: [ALERT_REASON] },
    { id: 'A1', kind: 'blocked', reason: 'code-scanning' },
  ])
  assert.deepEqual(notices, [`A1: blocked (code-scanning): ${ALERT_REASON.slice(0, 120)}`])
})

test('mergeCandidate: an analysis of an older commit waits with no notification', async () => {
  const { M, driver, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  gate.facts = scanned([scanAlert({ sha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2' })])

  assert.equal(await driver.mergeCandidate(M.prs.find((item) => item.id === 'A1')), false)
  assert.equal(driver.L.prs.A1.state, 'verified')
  assert.equal(driver.L.prs.A1.gate.kind, 'code-scanning')
  assert.deepEqual(notices, [])
})
