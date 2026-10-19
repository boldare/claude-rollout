import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { briefDrift, createDriver, doneDetail } from '../lib/driver.mjs'
import { postCommand } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { verifyPrompt } from '../lib/prompts.mjs'
import { stageLabels } from '../lib/stage.mjs'
import { readEvents } from '../lib/view.mjs'
import { previewPath, worktreePath } from '../lib/worktree.mjs'
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
  const manifest = loadManifest(makeRollout({ prs, events: [], policy }))

  return { manifest, driver: createDriver(manifest, { notify: () => {}, ...options }) }
}

// Posts the commands, applies them and returns the events they caused.
function apply(manifest, driver, ...commands) {
  const before = readEvents(manifest).length

  for (const command of commands) {
    postCommand(manifest, command)
  }

  driver.applyCommands()

  return readEvents(manifest)
    .slice(before)
    .map(({ at: _, ...event }) => event)
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
    url: 'https://github.com/example/widgets/pull/11',
    author: { login: 'demo-bot' },
    ...overrides,
  }
}

function viewRule(overrides = {}) {
  const json = prJson(overrides)

  return { tool: 'gh', args: `pr view ${json.number}`, stdout: json }
}

// Facts on which the gate merges A1, in the shape collectFacts returns.
function gateFacts(manifest, pr = {}) {
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
    pr: { ...prJson(), author: 'demo-bot', labels: [manifest.label], ...pr },
    checks: green,
    mainChecks: green,
    reviews: [],
  }
}

// A driver whose gh and git are fakes, with no slot for an agent. Its gate
// reads gateFacts with `gate.pr` and `gate.facts` on top, or throws `gate.error`.
// `gate.pr` may be a function of the manifest PR and its ledger entry.
function tickDriver(prs, { rules = [], only = null, policy = {}, clock, runAgent } = {}) {
  const dir = makeRollout({ prs, events: [], policy: { concurrency: 0, ...policy } })
  const tools = fakeTools(dir, rules)
  const manifest = loadManifest(dir, { only })
  const gate = { calls: 0, error: null, pr: {}, facts: {} }
  const notices = []
  const cleaned = []
  const driver = createDriver(manifest, {
    notify: (_, message) => notices.push(message),
    cleanup: async (pr) => cleaned.push(pr.id),
    collectFacts: async (_, pr, entry) => {
      gate.calls += 1

      if (gate.error) {
        throw gate.error
      }

      return { ...gateFacts(manifest, typeof gate.pr === 'function' ? gate.pr(pr, entry) : gate.pr), ...gate.facts }
    },
    clock,
    runAgent,
  })

  return { manifest, driver, tools, gate, notices, cleaned }
}

function eventsSince(manifest, from = 0) {
  return readEvents(manifest)
    .slice(from)
    .map(({ at: _, ...event }) => event)
}

function kindsSince(manifest, from = 0) {
  return eventsSince(manifest, from).map((event) => event.kind)
}

const GREEN_EVIDENCE = 'required checks passed, runs: test (success)'

function gateCheckEvent(item, result, evidence, sha = SHA) {
  return { id: 'A1', kind: 'gate-check', stage: 'preVerify', item, level: 'required', result, sha: sha.slice(0, 7), evidence }
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
    agentResult({ ok: false, costUsd: 0, seconds: 3, awakeSeconds: 2, denials: [{}, {}], error: 'x'.repeat(300), stopped: undefined }),
  )

  assert.deepEqual(failed, {
    run: 'A1-02-verify',
    model: null,
    ok: false,
    result: null,
    cost: 0,
    seconds: 3,
    awakeSeconds: 2,
    denials: 2,
    stopped: false,
    error: 'x'.repeat(200),
  })

  assert.equal(doneDetail('fix', 'A1-03-fix', { ok: false, stopped: true }).stopped, true)
  assert.equal(doneDetail('fix', 'A1-03-fix', { ok: false }).denials, 0)
  assert.equal(doneDetail('fix', 'A1-03-fix', { ok: false }).error, null)
  assert.equal(doneDetail('fix', 'A1-03-fix', { ok: false }).awakeSeconds, null)
})

test('doneDetail never overwrites the event envelope', () => {
  const detail = doneDetail('implement', 'A1-01-implement', agentResult({ output: { status: 'READY' } }))

  for (const key of ['at', 'id', 'kind']) {
    assert.ok(!(key in detail), key)
  }
})

test('hold parks a PR and release lifts it', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'needs_fix' } })

  assert.deepEqual(apply(manifest, driver, { cmd: 'hold', id: 'A1' }), [{ id: 'A1', kind: 'held', state: 'needs_fix', running: null }])
  assert.ok(Date.parse(driver.ledger.prs.A1.held.at))

  assert.deepEqual(apply(manifest, driver, { cmd: 'release', id: 'A1' }), [{ id: 'A1', kind: 'released', state: 'needs_fix' }])
  assert.equal(driver.ledger.prs.A1.held, null)
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
      { id: '-', kind: 'command-rejected', command: 'hold', reason: 'needs a PR id' },
      { id: '-', kind: 'command-rejected', command: 'release', reason: 'needs a PR id' },
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
  assert.equal(driver.ledger.data.paused, false)
  assert.equal(Object.prototype.held, undefined)
  assert.equal(Object.prototype.state, undefined)
  assert.equal(Object.prototype.attempts, undefined)
})

test('a PR still in the ledger but gone from the manifest is unknown, and a pause naming one still pauses', () => {
  const { manifest, driver } = driverFor({ A1: { state: 'pending' }, B9: { state: 'needs_fix' } })
  const before = structuredClone(driver.ledger.prs.B9)

  const events = apply(
    manifest,
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

  assert.deepEqual(driver.ledger.prs.B9, before)
  assert.equal(driver.ledger.data.paused, true)
})

test('retry rejects a merged PR and changes nothing', () => {
  const attempts = { implement: 1, fix: 2, verify: 1, brief: 1 }
  const { manifest, driver } = driverFor({ A1: { state: 'merged', pr: 7, attempts } })

  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [
    { id: 'A1', kind: 'command-rejected', command: 'retry', reason: 'already merged' },
  ])

  assert.equal(driver.ledger.prs.A1.state, 'merged')
  assert.deepEqual(driver.ledger.prs.A1.attempts, attempts)
})

test('retry rejects a PR whose agent is running and changes nothing', () => {
  const attempts = { implement: 1, fix: 2, verify: 0, brief: 0 }
  const { manifest, driver } = driverFor({ A1: { state: 'fixing', attempts } })
  driver.running.set('A1', 'fix')

  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [
    { id: 'A1', kind: 'command-rejected', command: 'retry', reason: 'an agent is working on this PR' },
  ])

  assert.equal(driver.ledger.prs.A1.state, 'fixing')
  assert.deepEqual(driver.ledger.prs.A1.attempts, attempts)
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

  entry.state = 'blocked'
  entry.blocked = { kind: 'brief-questions', question: 'Q2', evidence: '' }
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

test('launch never starts an implementer or a fixer without a brief and a GitHub PR', () => {
  const attempts = { implement: 1, fix: 1, verify: 0, brief: 1 }
  const { manifest, driver } = driverFor({ A1: { state: 'interrupted', interruptedRole: 'fix', sessionId: 'session-1', attempts } })
  const pr = manifest.all.find((item) => item.id === 'A1')
  manifest.claudeBin = join(manifest.dir, 'no-such-claude')
  const before = readEvents(manifest).length

  driver.launch(pr, 'fix', { reason: 'r', note: 'n' })
  driver.launch(pr, 'implement')

  const entry = driver.ledger.prs.A1

  assert.equal(driver.running.size, 0)
  assert.deepEqual(entry.attempts, attempts)
  assert.equal(entry.state, 'pending')
  assert.equal(entry.sessionId, 'session-1')
  assert.deepEqual(
    readEvents(manifest)
      .slice(before)
      .map(({ at: _, ...event }) => event),
    [
      { id: 'A1', kind: 'brief-missing', role: 'fix' },
      { id: 'A1', kind: 'brief-missing', role: 'implement' },
    ],
  )
})

// A1 with a brief, a ready worktree and model.implement sonnet. Every agent
// call is recorded, and `result` decides how each run ends: never by default.
function modelDriver(prs, { result = () => new Promise(() => {}) } = {}) {
  const calls = []
  const setup = tickDriver(prs, {
    policy: { concurrency: 5 },
    runAgent: (_, pr, options) => {
      calls.push(options)
      return result(options)
    },
  })

  const pr = setup.manifest.all.find((item) => item.id === 'A1')
  const wt = worktreePath(setup.manifest, pr)
  const gitDir = join(wt, '.git-dir')

  pr.model = { implement: 'sonnet' }
  mkdirSync(gitDir, { recursive: true })
  mkdirSync(dirname(pr.brief), { recursive: true })
  writeFileSync(pr.brief, '# A1\n')
  writeFileSync(join(wt, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'rollout-ready'), '')
  setup.tools.answer([
    { tool: 'git', args: 'rev-parse --absolute-git-dir', stdout: gitDir },
    { tool: 'git', args: '', stdout: '' },
  ])

  return { ...setup, pr, entry: setup.driver.ledger.prs.A1, calls }
}

async function launched(setup, role, options) {
  const before = setup.calls.length

  setup.driver.launch(setup.pr, role, options)
  await waitFor(() => setup.calls.length > before, `${role} run`)

  return setup.calls.at(-1)
}

test('launch: model.implement runs the first implement attempt and two fixes, the rollout model every run from the third fix on', async () => {
  const setup = modelDriver({ A1: { state: 'pending' } })
  const models = []

  models.push((await launched(setup, 'implement')).model)

  for (let i = 0; i < 4; i++) {
    models.push((await launched(setup, 'fix', { reason: 'r' })).model)
  }

  models.push((await launched(setup, 'implement')).model)

  assert.deepEqual(models, ['sonnet', 'sonnet', 'sonnet', 'opus', 'opus', 'opus'])
  assert.deepEqual(
    setup.calls.map((call) => call.effort),
    ['high', 'high', 'high', 'xhigh', 'max', 'xhigh'],
  )

  assert.equal(setup.entry.modelRaised, true)
  assert.deepEqual(
    eventsSince(setup.manifest)
      .filter((event) => event.kind.endsWith('-start'))
      .map((event) => [event.kind, event.model]),
    [
      ['implement-start', 'sonnet'],
      ['fix-start', 'sonnet'],
      ['fix-start', 'sonnet'],
      ['fix-start', 'opus'],
      ['fix-start', 'opus'],
      ['implement-start', 'opus'],
    ],
  )
})

test('launch: a second implement attempt goes to the rollout model, and the PR stays on it after rollout retry', async () => {
  const setup = modelDriver(
    { A1: { state: 'pending', attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } } },
    { result: () => Promise.resolve(agentResult({ ok: false, costUsd: 0, error: 'error_during_execution' })) },
  )

  assert.equal((await launched(setup, 'implement')).model, 'opus')
  await waitFor(() => !setup.driver.running.has('A1'), 'the run to end')

  apply(setup.manifest, setup.driver, { cmd: 'retry', id: 'A1' })
  setup.entry.retryAfter = null

  assert.equal(setup.entry.attempts.implement, 0)
  assert.equal((await launched(setup, 'implement')).model, 'opus')
  assert.equal((await launched(setup, 'fix', { reason: 'r' })).model, 'opus')
})

test('launch: the verifier and the brief writer run on the rollout model whatever the PR implements on', async () => {
  const setup = modelDriver({ A1: { state: 'pending', pr: 11, claimedSha: SHA } })

  assert.equal((await launched(setup, 'verify', { sha: SHA })).model, 'opus')

  rmSync(setup.pr.brief)

  const writer = await launched(setup, 'brief')

  assert.equal(writer.role, 'brief')
  assert.equal(writer.model, 'opus')
  assert.ok(eventsSince(setup.manifest).some((event) => event.kind === 'brief-start' && event.model === 'opus'))
})

test('doneDetail: the model the run reported', () => {
  assert.equal(doneDetail('implement', 'A1-01-implement', agentResult({ model: 'claude-sonnet-5-5' })).model, 'claude-sonnet-5-5')
})

// A2 depends on A1, which is verified and waits for its merge. Every agent call is
// recorded and never ends, and git answers everything unless `rules` come first.
function aheadDriver({ a1 = { ...samplePrs().A1, held: null }, a2 = { state: 'pending' }, rules = [] } = {}) {
  const calls = []
  const setup = tickDriver(
    { A1: a1, A2: a2 },
    {
      policy: { concurrency: 2 },
      runAgent: (_, pr, options) => {
        calls.push({ id: pr.id, ...options })
        return new Promise(() => {})
      },
    },
  )

  setup.tools.answer([...rules, { tool: 'git', args: '', stdout: '' }])

  return { ...setup, pr: setup.manifest.all.find((item) => item.id === 'A2'), entry: setup.driver.ledger.prs.A2, calls }
}

test('advance: a brief starts once its dependency is verified, in a preview with the verified head merged in', async () => {
  const { manifest, driver, tools, pr, calls } = aheadDriver()

  await driver.advance(pr)
  await waitFor(() => calls.length === 1, 'the brief writer')

  assert.equal(calls[0].role, 'brief')
  assert.equal(calls[0].cwd, previewPath(manifest, pr))
  assert.match(calls[0].prompt, /verified but not merged yet merged into it locally: A1 at `a1a1a1a`/)

  const start = eventsSince(manifest).find((event) => event.kind === 'brief-start')
  assert.deepEqual(start.ahead, ['A1@a1a1a1a'])

  const gitCalls = tools.calls().filter((call) => call.tool === 'git')
  assert.ok(
    gitCalls.some(
      (call) => call.args.join(' ') === `-C ${manifest.repo.path} worktree add --quiet --detach ${previewPath(manifest, pr)} origin/main`,
    ),
  )

  assert.ok(gitCalls.some((call) => call.args.includes('merge') && call.args.at(-1) === SHA && call.args.includes('commit.gpgsign=false')))
  assert.ok(!gitCalls.some((call) => call.args.includes(worktreePath(manifest, pr))), 'the PR worktree is not made')
})

test('advance: a held dependency holds the brief, and release lets it start', async () => {
  const { manifest, driver, pr, entry, calls } = aheadDriver({ a1: samplePrs().A1 })

  await driver.advance(pr)
  assert.equal(entry.state, 'pending')
  assert.deepEqual(calls, [])

  apply(manifest, driver, { cmd: 'release', id: 'A1' })
  await driver.advance(pr)
  await waitFor(() => calls.length === 1, 'the brief writer')

  assert.equal(calls[0].role, 'brief')
  assert.equal(calls[0].cwd, previewPath(manifest, pr))

  apply(manifest, driver, { cmd: 'hold', id: 'A1' })
  await driver.advance(pr)
  assert.equal(entry.state, 'briefing')
  assert.equal(driver.running.get('A2'), 'brief')
})

test('advance: a dependency neither merged nor verified holds the brief, and an implementer always waits for the merge', async () => {
  const unverified = aheadDriver({ a1: { state: 'needs_fix', pr: 11 } })

  await unverified.driver.advance(unverified.pr)
  assert.equal(unverified.entry.state, 'pending')
  assert.deepEqual(unverified.calls, [])

  const briefed = aheadDriver()
  mkdirSync(dirname(briefed.pr.brief), { recursive: true })
  writeFileSync(briefed.pr.brief, '# A2\n')

  await briefed.driver.advance(briefed.pr)
  assert.equal(briefed.entry.state, 'pending')
  assert.deepEqual(briefed.calls, [])
})

test('advance: heads that conflict in the preview give the attempt back and wait for a new verification', async () => {
  const { manifest, driver, pr, entry, calls } = aheadDriver({
    rules: [{ tool: 'git', args: 'merge --quiet --no-ff', code: 1, stderr: 'CONFLICT' }],
  })

  await driver.advance(pr)
  await waitFor(() => entry.state === 'pending' && !driver.running.has('A2'), 'the brief to wait')

  assert.deepEqual(calls, [])
  assert.equal(entry.attempts.brief, 0)
  assert.equal(entry.previewConflict, `A1@${SHA}`)
  assert.deepEqual(
    eventsSince(manifest)
      .filter((event) => event.kind.startsWith('brief-'))
      .map((event) => [event.kind, event.ok ?? null]),
    [
      ['brief-start', null],
      ['brief-done', false],
      ['brief-waits', null],
    ],
  )

  await driver.advance(pr)
  assert.equal(entry.state, 'pending')

  driver.ledger.prs.A1.verified = { sha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', patchId: 'patch-a1-2', at: at(90) }
  await driver.advance(pr)
  assert.equal(entry.state, 'briefing')
})

test('briefDrift: a dependency that merged with another patch than the brief saw, or with none known', () => {
  const heads = [
    { id: 'A1', sha: 'a1', patchId: 'p1' },
    { id: 'A3', sha: 'a3', patchId: 'p3' },
    { id: 'A4', sha: 'a4', patchId: null },
  ]

  const entries = { A1: { verified: { patchId: 'p1' } }, A3: { verified: { patchId: 'p3-fixed' } }, A4: { verified: { patchId: 'p4' } } }

  assert.deepEqual(briefDrift(heads, entries), [
    { id: 'A3', sha: 'a3' },
    { id: 'A4', sha: 'a4' },
  ])

  assert.deepEqual(briefDrift(undefined, entries), [])
})

test('launch: the implementer hears of a dependency that changed after its brief', async () => {
  const setup = modelDriver({ A1: { state: 'pending' }, A3: { state: 'merged', verified: { sha: 'c3', patchId: 'patch-a3-fixed' } } })

  setup.entry.briefHeads = [{ id: 'A3', sha: 'c3c3c3c3c3c3', patchId: 'patch-a3' }]

  const call = await launched(setup, 'implement')

  assert.deepEqual(setup.entry.briefDrift, [{ id: 'A3', sha: 'c3c3c3c3c3c3' }])
  assert.match(call.prompt, /## The brief and its dependencies/)
  assert.match(call.prompt, /- A3: the brief saw `c3c3c3c`\./)
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
  assert.deepEqual(notices, ['A1: approved PR #11; merging in 120s unless you pause'])
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
  assert.deepEqual(first.sent, ['A1: PR #11 approved on GitHub by maint; merging in 120s unless you pause'])
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
  assert.deepEqual(again.sent, ['A1: PR #11 approved on GitHub by maint; merging in 120s unless you pause'])
})

test('tick: a failed fetch counts against no PR, skips the gate and lets the other PRs advance', async () => {
  const { manifest, driver, tools, gate } = tickDriver(samplePrs(), { rules: [FETCH_FAILS, viewRule()] })

  await driver.tick()

  const events = eventsSince(manifest)

  assert.deepEqual(
    events.map((event) => event.kind),
    ['fetch-failed'],
  )

  assert.equal(events[0].id, '-')
  assert.equal(events[0].count, 1)
  assert.match(events[0].error, /unable to access the remote/)
  assert.equal(gate.calls, 0)
  assert.equal(driver.ledger.prs.A2.state, 'interrupted')

  for (const pr of manifest.prs) {
    assert.equal(driver.ledger.prs[pr.id].tickErrors ?? 0, 0, pr.id)
  }

  tools.answer([FETCH, viewRule()])
  await driver.tick()

  assert.equal(gate.calls, 1)
  assert.deepEqual(kindsSince(manifest, events.length), [])
})

test('tick: a driver-wide step that fails five ticks in a row notifies once, and a success starts the count over', async () => {
  const { manifest, driver, tools, notices } = tickDriver(samplePrs(), { rules: [FETCH_FAILS, viewRule()] })
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

  const counts = eventsSince(manifest)
    .filter((event) => event.kind === 'fetch-failed')
    .map((event) => event.count)

  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 1])
  assert.equal(notices.length, 1)
})

test('tick: outside dependencies are looked up one by one, and one already merged is not looked up', async () => {
  const mergedA2 = { ...prJson({ number: 12, state: 'MERGED', headRefName: 'feat/a2' }), labels: [{ name: 'rollout:demo' }] }
  const { manifest, driver, tools } = tickDriver(
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

  manifest.prs.find((pr) => pr.id === 'A3').deps = ['A1', 'A2']
  await driver.tick()

  const events = eventsSince(manifest)
  const failed = events.filter((event) => event.kind === 'outside-deps-failed')

  assert.deepEqual(lookups(0), ['feat/a1', 'feat/a2'])
  assert.equal(driver.ledger.prs.A1.state, 'pending')
  assert.equal(driver.ledger.prs.A2.state, 'merged')
  assert.equal(driver.ledger.prs.A2.pr, 12)
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
  assert.deepEqual(kindsSince(manifest, events.length), [])
})

test('tick: a failed base watch halts nothing and is tried again on the next tick', async () => {
  const { manifest, driver, tools } = tickDriver(
    { ...samplePrs(), A3: { state: 'merged', pr: 13, mergeSha: MERGE_SHA } },
    { rules: [FETCH, viewRule()] },
  )

  driver.ledger.data.lastMerge = { id: 'A3', sha: MERGE_SHA, at: at(90) }

  await driver.tick()

  const failed = eventsSince(manifest).filter((event) => event.kind === 'watch-base-failed')

  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, '-')
  assert.match(failed[0].error, /no rule for api .*check-runs/)
  assert.equal(driver.ledger.data.halted, null)
  assert.equal(driver.ledger.prs.A2.state, 'interrupted')

  tools.answer([FETCH, viewRule(), { tool: 'gh', args: `commits/${MERGE_SHA}/check-runs`, stdout: GREEN_RUNS }])
  await driver.tick()

  assert.equal(driver.ledger.data.lastMerge.checked, 'green')
  assert.equal(eventsSince(manifest).filter((event) => event.kind === 'watch-base-failed').length, 1)
})

test('tick: the base watch reads only the merge commit, never a quiet ancestor', async () => {
  const red = { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }] }
  const { manifest, driver, tools } = tickDriver(
    { ...samplePrs(), A3: { state: 'merged', pr: 13, mergeSha: MERGE_SHA } },
    { rules: [FETCH, viewRule(), { tool: 'gh', args: `commits/${MERGE_SHA}/check-runs`, stdout: { check_runs: [] } }] },
  )

  // A quiet merge commit with a red parent: a walk would halt, or go green from a green one.
  manifest.repo.baseQuietPaths = ['**']
  driver.ledger.data.lastMerge = { id: 'A3', sha: MERGE_SHA, at: at(90) }
  tools.answer([
    FETCH,
    viewRule(),
    { tool: 'gh', args: `commits/${MERGE_SHA}/check-runs`, stdout: { check_runs: [] } },
    { tool: 'gh', args: 'check-runs', stdout: red },
  ])

  await driver.tick()

  assert.equal(driver.ledger.data.halted, null)
  assert.equal(driver.ledger.data.lastMerge.checked, undefined)
  assert.ok(!tools.calls().some((call) => call.tool === 'git' && call.args.includes('--format=%P')))
})

test('tick: a deleted manifest.yaml is rejected once, and loads again when it is back', async () => {
  const { manifest, driver, notices } = tickDriver(samplePrs(), { rules: [FETCH, viewRule()] })
  const file = join(manifest.dir, 'manifest.yaml')
  const text = readFileSync(file, 'utf8')
  const manifestKinds = () => kindsSince(manifest).filter((kind) => kind.startsWith('manifest-'))

  rmSync(file)
  await driver.tick()
  await driver.tick()

  assert.deepEqual(manifestKinds(), ['manifest-rejected'])
  assert.deepEqual(notices, ['-: manifest.yaml has an error; keeping the previous one'])
  assert.equal(driver.ledger.prs.A2.state, 'interrupted')

  writeFileSync(file, text)
  await driver.tick()

  assert.deepEqual(manifestKinds(), ['manifest-rejected', 'manifest-reloaded'])
})

test('guarded: a PR counts one error per tick, a clean tick resets it, and five erroring ticks escalate it once', async () => {
  const viewFails = { tool: 'gh', args: 'pr view 11', code: 1, stderr: 'HTTP 404: Not Found' }
  const { manifest, driver, tools, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH, viewFails] })
  const entry = driver.ledger.prs.A1
  const errorCounts = (from) =>
    eventsSince(manifest, from)
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
  assert.equal(entry.escalation, 'repeated errors')
  assert.equal(kindsSince(manifest).filter((kind) => kind === 'escalated').length, 1)
  assert.equal(notices.length, 1)
  assert.ok(notices[0].startsWith('A1: repeated errors'), notices[0])

  const before = readEvents(manifest).length
  tools.answer([FETCH, viewFails])
  await driver.tick()

  assert.deepEqual(errorCounts(before), [6])
  assert.equal(entry.state, 'escalated')
  assert.equal(notices.length, 1)
  assert.equal(kindsSince(manifest).filter((kind) => kind === 'escalated').length, 1)
})

const VIEW_502 = { tool: 'gh', args: 'pr view 11', code: 1, stderr: 'HTTP 502: Bad Gateway' }
const FETCH_UNREACHABLE = {
  tool: 'git',
  args: 'fetch',
  code: 128,
  stderr: "fatal: unable to access 'https://github.com/example/widgets.git/': Could not resolve host: github.com",
}

// Runs the ticks and returns how many github-unavailable events each one logged.
async function unavailablePerTick(manifest, driver, ticks) {
  const counts = []

  for (let i = 0; i < ticks; i += 1) {
    const before = readEvents(manifest).length
    await driver.tick()
    counts.push(kindsSince(manifest, before).filter((kind) => kind === 'github-unavailable').length)
  }

  return counts
}

test('tick: six ticks of HTTP 502 escalate nothing, and an outage of 30 minutes notifies once and again when it ends', async () => {
  const { manifest, driver, tools, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH, VIEW_502] })
  const entry = driver.ledger.prs.A1
  gate.error = new Error('gh api -X GET repos/example/widgets/pulls/11/reviews -f per_page=100 exited 1: gh: Server Error (HTTP 500)')

  assert.deepEqual(await unavailablePerTick(manifest, driver, 6), [1, 1, 1, 1, 1, 1])
  assert.deepEqual(kindsSince(manifest), Array(6).fill('github-unavailable'))
  assert.equal(entry.state, 'verified')
  assert.equal(entry.tickErrors ?? 0, 0)
  assert.equal(entry.lastError, null)
  assert.equal(gate.calls, 6)
  assert.deepEqual(notices, [])

  const [first] = eventsSince(manifest)
  const outage = driver.ledger.data.githubUnavailable

  assert.deepEqual({ ...first, error: null }, { id: '-', kind: 'github-unavailable', source: 'A1', error: null, minutes: 0 })
  assert.match(first.error, /^gh pr view 11 --json .* exited 1: HTTP 502: Bad Gateway$/)
  assert.equal(outage.notified, false)
  assert.deepEqual(JSON.parse(readFileSync(join(manifest.dir, 'ledger.json'), 'utf8')).githubUnavailable, outage)

  outage.since = new Date(Date.parse(outage.since) - 31 * 60_000).toISOString()
  await driver.tick()

  assert.deepEqual(notices, [
    '-: GitHub has been unreachable for 31 minutes. The driver keeps trying every tick. Last error: HTTP 502: Bad Gateway',
  ])

  assert.equal(driver.ledger.data.githubUnavailable.notified, true)

  await driver.tick()

  assert.equal(notices.length, 1)

  tools.answer([FETCH, viewRule()])
  gate.error = null
  const before = readEvents(manifest).length
  await driver.tick()

  assert.deepEqual(eventsSince(manifest, before), [{ id: '-', kind: 'github-back', minutes: 31 }])
  assert.deepEqual(notices.slice(1), ['-: GitHub answers again after 31 minutes'])
  assert.equal(driver.ledger.data.githubUnavailable, null)

  const after = readEvents(manifest).length
  await driver.tick()

  assert.deepEqual(kindsSince(manifest, after), [])
  assert.equal(notices.length, 2)
})

test('guarded: an outage neither counts nor resets the errors of a PR, and a short one ends with github-back and no notice', async () => {
  const { manifest, driver, tools, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, tickErrors: 3 } }, { rules: [FETCH, VIEW_502] })
  const entry = driver.ledger.prs.A1

  await driver.tick()

  assert.equal(entry.tickErrors, 3)
  assert.deepEqual(kindsSince(manifest), ['github-unavailable'])

  gate.error = new Error('gate down')
  const mixed = readEvents(manifest).length
  await driver.tick()

  assert.equal(entry.tickErrors, 4)
  assert.deepEqual(
    eventsSince(manifest, mixed).map((event) => [event.kind, event.count]),
    [
      ['github-unavailable', undefined],
      ['error', 4],
    ],
  )

  tools.answer([FETCH, viewRule()])
  gate.error = null
  const before = readEvents(manifest).length
  await driver.tick()

  assert.equal(entry.tickErrors, 0)
  assert.deepEqual(eventsSince(manifest, before), [{ id: '-', kind: 'github-back', minutes: 0 }])
  assert.equal(driver.ledger.data.githubUnavailable, null)
  assert.deepEqual(notices, [])
})

test('tick: a fetch lost to an outage skips the gate, logs no fetch-failed and leaves the count of fetch failures alone', async () => {
  const { manifest, driver, tools, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH_UNREACHABLE, viewRule()] })

  assert.deepEqual(await unavailablePerTick(manifest, driver, 5), [1, 1, 1, 1, 1])
  assert.deepEqual(
    eventsSince(manifest).map((event) => [event.kind, event.source]),
    Array(5).fill(['github-unavailable', 'fetch']),
  )

  assert.equal(gate.calls, 0)
  assert.deepEqual(notices, [])

  for (const fetch of [FETCH_FAILS, FETCH_UNREACHABLE, FETCH_FAILS]) {
    tools.answer([fetch, viewRule()])
    await driver.tick()
  }

  assert.deepEqual(
    eventsSince(manifest)
      .filter((event) => event.kind === 'fetch-failed')
      .map((event) => event.count),
    [1, 2],
  )

  assert.equal(gate.calls, 0)
  assert.deepEqual(notices, [])
})

const HOUR = 60 * 60_000
const VIEW_401 = { tool: 'gh', args: 'pr view 11', code: 1, stderr: 'HTTP 401: Bad credentials' }

// A wall clock the test moves by hand.
function fakeClock() {
  let time = Date.parse('2026-01-01T00:00:00Z')

  return {
    clock: () => time,
    move: (ms) => {
      time += ms
    },
  }
}

test('tick: for two minutes after a sleep, failed gh and git calls are an outage', async () => {
  const time = fakeClock()
  const { manifest, driver, tools, notices } = tickDriver(samplePrs(), { rules: [FETCH, viewRule()], clock: time.clock })
  const entry = driver.ledger.prs.A1

  await driver.tick()
  time.move(90_000)
  await driver.tick()

  assert.deepEqual(kindsSince(manifest), [])

  tools.answer([FETCH_FAILS, VIEW_401])
  time.move(2 * HOUR)
  const woke = readEvents(manifest).length
  await driver.tick()

  const wake = eventsSince(manifest, woke)

  assert.deepEqual(wake[0], { id: '-', kind: 'machine-slept', minutes: 119 })
  assert.deepEqual(
    wake.map((event) => [event.kind, event.source]),
    [
      ['machine-slept', undefined],
      ['github-unavailable', 'fetch'],
    ],
  )

  assert.equal(entry.tickErrors ?? 0, 0)

  time.move(60_000)
  const inside = readEvents(manifest).length
  await driver.tick()

  assert.deepEqual(kindsSince(manifest, inside), ['github-unavailable'])
  assert.equal(entry.tickErrors ?? 0, 0)

  time.move(61_000)
  const after = readEvents(manifest).length
  await driver.tick()

  assert.deepEqual(
    eventsSince(manifest, after).map((event) => [event.id, event.kind, event.count]),
    [
      ['-', 'fetch-failed', 1],
      ['A1', 'error', 1],
      ['-', 'github-back', undefined],
    ],
  )

  assert.equal(entry.tickErrors, 1)
  assert.deepEqual(notices, [])
})

test('tick: after a sleep, an error that is no failed gh or git call still counts', async () => {
  const time = fakeClock()
  const { manifest, driver, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH, viewRule()], clock: time.clock })

  await driver.tick()
  time.move(2 * HOUR)
  gate.error = new Error('gate down')
  const woke = readEvents(manifest).length
  await driver.tick()

  assert.deepEqual(
    eventsSince(manifest, woke).map((event) => [event.id, event.kind, event.count]),
    [
      ['-', 'machine-slept', undefined],
      ['A1', 'error', 1],
    ],
  )

  assert.equal(driver.ledger.prs.A1.tickErrors, 1)
  assert.deepEqual(notices, [])
})

test('runTick: a failed tick never rejects, and the fifth in a row notifies once', async () => {
  const { manifest, driver, notices } = tickDriver(samplePrs(), { rules: [FETCH, viewRule()] })
  const save = driver.ledger.save
  const tickErrors = () => eventsSince(manifest).filter((event) => event.kind === 'tick-error')

  function failSave() {
    throw new Error('disk full')
  }

  driver.ledger.save = failSave

  for (let i = 0; i < 5; i += 1) {
    await driver.runTick()
  }

  assert.deepEqual(
    tickErrors().map((event) => event.count),
    [1, 2, 3, 4, 5],
  )

  assert.match(tickErrors()[0].error, /disk full/)
  assert.deepEqual(notices, ['5 ticks in a row failed: disk full'])
  assert.match(readFileSync(join(manifest.dir, 'heartbeat'), 'utf8'), / tick-error disk full$/)

  await driver.runTick()

  assert.equal(tickErrors().at(-1).count, 6)
  assert.equal(notices.length, 1)

  driver.ledger.save = save
  await driver.runTick()
  driver.ledger.save = failSave
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
  const { manifest, driver, tools } = tickDriver(
    { A1: IMPLEMENTING },
    { rules: [FETCH, { tool: 'gh', args: 'pr view 12', code: 1, stderr: 'HTTP 502: Bad Gateway' }] },
  )

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

  tools.answer([FETCH, viewRule({ number: 12, headRefOid: NEW_HEAD })])
  await driver.tick()

  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.interruptedRole, null)
  assert.equal(entry.pr, 12)
  assert.equal(entry.claimedSha, NEW_HEAD)
  assert.equal(entry.attempts.fix, 0)
  assert.equal(driver.running.size, 0)
  assert.deepEqual(kindsSince(manifest, events.length), ['ready-claimed'])
})

test('onDone: a READY report that names a PR GitHub does not know still goes to a fix run', async () => {
  const unknown = [
    'GraphQL: Could not resolve to a PullRequest with the number of 12. (repository.pullRequest)',
    'no pull requests found for branch "feat/a1"',
  ]

  for (const stderr of unknown) {
    const { manifest, driver } = tickDriver({ A1: IMPLEMENTING }, { rules: [{ tool: 'gh', args: 'pr view 12', code: 1, stderr }] })
    const entry = driver.ledger.prs.A1

    await driver.onDone(
      manifest.prs.find((item) => item.id === 'A1'),
      'implement',
      READY,
      { run: 'A1-01-implement' },
    )

    assert.equal(entry.state, 'needs_fix', stderr)
    assert.equal(entry.fixReason, 'report does not match GitHub')
    assert.match(entry.fixNote, /^PR #12 could not be read/)
    assert.deepEqual(eventsSince(manifest).at(-1), { id: 'A1', kind: 'needs-fix', reason: 'report does not match GitHub' })
    assert.deepEqual(kindsSince(manifest), ['implement-done', 'needs-fix'])
  }
})

test('onDone: a READY report whose PR answers 404 waits, and counts as an error of the PR on the next tick', async () => {
  const notFound = { tool: 'gh', args: 'pr view 12', code: 1, stderr: 'HTTP 404: Not Found' }
  const { manifest, driver } = tickDriver({ A1: IMPLEMENTING }, { rules: [FETCH, notFound] })
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
    { rules: [FETCH, viewRule({ number: 12, headRefOid: NEW_HEAD, state: 'CLOSED' })] },
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
    const { manifest, driver, gate } = tickDriver({ A1: { ...samplePrs().A1, ...state } }, { rules: [FETCH, viewRule()] })
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
  const { manifest, driver } = tickDriver({ A1: stale }, { rules: [FETCH, viewRule()] })
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
    { rules: [FETCH, viewRule()] },
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
  const { manifest, driver } = tickDriver({ A1: parked }, { rules: [FETCH, viewRule({ number: 12, headRefOid: NEW_HEAD })] })
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

test('mergeCandidate: a merge GitHub has not confirmed stays verified until a sync sees it merged', async () => {
  const earlier = { id: 'A3', sha: MERGE_SHA.replaceAll('f', 'c'), at: at(70), checked: 'green' }
  const { manifest, driver, tools, notices, cleaned } = tickDriver(
    { A1: { ...samplePrs().A1, held: null }, A3: { state: 'merged', pr: 13, mergeSha: earlier.sha } },
    {
      policy: { merge: 'auto' },
      rules: [
        { tool: 'gh', args: 'pr merge 11', stdout: '' },
        { tool: 'gh', args: '--json state,mergeCommit', stdout: { state: 'OPEN', mergeCommit: null } },
      ],
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
  assert.deepEqual(eventsSince(manifest), [{ id: 'A1', kind: 'gate-wait', reasons: ['merged on GitHub (the next sync records it)'] }])
  assert.deepEqual(notices, [])
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
  assert.equal(driver.ledger.prs.A3.gate.action, 'wait')
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

const REBASED = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'

// A3's worktree as prepareWorktree leaves it, with a fake git under which
// its rebase onto the new base succeeds at REBASED.
function rebasableWorktree(manifest, tools) {
  const wt = worktreePath(
    manifest,
    manifest.prs.find((pr) => pr.id === 'A3'),
  )

  const gitDir = join(wt, '.git-dir')

  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'rollout-ready'), '')
  tools.answer([
    { tool: 'git', args: 'rev-parse --absolute-git-dir', stdout: gitDir },
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

test('checkClaim: a claimed PR merged or closed since sync is left to the next sync', async () => {
  const claimed = { state: 'ready_claimed', pr: 11, claimedSha: SHA, attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } }

  for (const state of ['MERGED', 'CLOSED']) {
    const { manifest, driver, tools, gate } = tickDriver({ A1: claimed }, { rules: [viewRule({ state })] })

    await driver.advance(manifest.prs.find((item) => item.id === 'A1'))

    assert.equal(driver.ledger.prs.A1.state, 'ready_claimed', state)
    assert.deepEqual(kindsSince(manifest), [], state)
    assert.ok(!tools.calls().some((call) => call.args.join(' ').includes('check-runs')), state)
    assert.equal(gate.calls, 0, state)
  }

  const { manifest, driver, tools, gate } = tickDriver(
    { A1: claimed },
    { rules: [viewRule(), { tool: 'gh', args: `commits/${SHA}/check-runs`, stdout: GREEN_RUNS }] },
  )

  gate.pr = { state: 'MERGED' }

  await driver.advance(manifest.prs.find((item) => item.id === 'A1'))

  assert.ok(tools.calls().some((call) => call.args.join(' ').includes('check-runs')))
  assert.equal(gate.calls, 1)
  assert.equal(driver.ledger.prs.A1.state, 'ready_claimed')
  assert.equal(driver.ledger.prs.A1.claimPatchId, undefined)
  assert.deepEqual(eventsSince(manifest), [gateCheckEvent('ci', 'pass', GREEN_EVIDENCE)])
})

const PREFIX = "Answer from the delegate, on the maintainer's behalf, from the plan:\n\n"
const DECISION = { kind: 'needs-decision', question: 'Keep the old flag?', evidence: 'cli.mjs:12 still reads it.' }
const BRIEF_QUESTIONS = { kind: 'brief-questions', question: 'Which API?', evidence: 'The plan names two.' }
const ANSWERED = 'A1: delegate answered: Keep it as an alias. Override with rollout note A1'

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

  const { manifest, driver } = driverFor(
    { A1: { state: 'blocked', blocked: DECISION, ...state } },
    { policy, runAgent, notify: (_, message) => notices.push(message) },
  )

  const pr = manifest.all.find((item) => item.id === 'A1')

  mkdirSync(worktreePath(manifest, pr), { recursive: true })

  if (brief) {
    mkdirSync(dirname(pr.brief), { recursive: true })
    writeFileSync(pr.brief, '# A1\n')
  }

  return { manifest, driver, pr, entry: driver.ledger.prs.A1, notices, calls }
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
    const { manifest, driver, pr, entry, notices, calls } = delegateDriver({ pr: 11, ...state }, { policy })

    await advanced(driver, pr)

    assert.deepEqual(calls, [])
    assert.deepEqual(kindsSince(manifest), [])
    assert.deepEqual(notices, [])
    assert.equal(entry.state, 'blocked')
    assert.equal(entry.delegate.runs, 0)
  }
})

test('delegate: an answer to brief questions gives the brief attempt back and notifies', async () => {
  const { manifest, driver, pr, entry, notices, calls } = delegateDriver(
    { blocked: BRIEF_QUESTIONS, attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } },
    { brief: false },
  )

  await advanced(driver, pr)

  assert.equal(entry.state, 'pending')
  assert.equal(entry.blocked, null)
  assert.equal(entry.attempts.brief, 0)
  assert.deepEqual(entry.briefAnswers, [{ question: 'Which API?', answer: `${PREFIX}Keep it as an alias.` }])
  assert.deepEqual(kindsSince(manifest), ['delegate-start', 'delegate-done', 'brief-answered', 'delegate-answered'])
  assert.deepEqual(eventsSince(manifest)[0], {
    id: 'A1',
    kind: 'delegate-start',
    run: 'A1-01-delegate',
    log: 'logs/A1-01-delegate.jsonl',
    effort: 'high',
    model: 'opus',
    blocked: 'brief-questions',
  })

  assert.deepEqual(notices, [ANSWERED])

  assert.equal(calls.length, 1)
  assert.equal(calls[0].role, 'delegate')
  assert.equal(calls[0].cwd, worktreePath(manifest, pr))
  assert.equal(calls[0].effort, 'high')
  assert.equal(calls[0].resume, false)
  assert.equal(calls[0].logName, 'A1-01-delegate')
  assert.ok(calls[0].prompt.includes('Which API?'))

  assert.equal(entry.delegate.runs, 1)
  assert.equal(entry.costUsd, 1.25)
  assert.deepEqual(
    entry.delegate.answers.map((answer) => [answer.decision, answer.kind, answer.question, answer.answer, answer.run]),
    [['answer', 'brief-questions', 'Which API?', '  Keep it as an alias.  ', 'A1-01-delegate']],
  )

  assert.deepEqual(
    entry.noteHistory.map((note) => [note.by, note.kind, note.question]),
    [['delegate', 'brief-questions', 'Which API?']],
  )
})

test('delegate: an answer to needs-decision sends the PR to a fix run with the answer', async () => {
  const { manifest, driver, pr, entry, notices } = delegateDriver({ pr: 11, sessionId: 'session-1' })

  await advanced(driver, pr)

  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'answer from the delegate')
  assert.ok(entry.fixNote.startsWith(PREFIX), entry.fixNote)
  assert.deepEqual(kindsSince(manifest), ['delegate-start', 'delegate-done', 'needs-fix', 'delegate-answered'])
  assert.deepEqual(eventsSince(manifest).at(-1), {
    id: 'A1',
    kind: 'delegate-answered',
    run: 'A1-01-delegate',
    blocked: 'needs-decision',
    planRefs: ['Decisions: flags'],
  })

  assert.deepEqual(notices, [ANSWERED])
})

test('delegate: an answer without a final period notifies the same sentence', async () => {
  const { driver, pr, notices } = delegateDriver({ pr: 11 }, { results: [delegateReport({ answer: 'Keep it as an alias' })] })

  await advanced(driver, pr)

  assert.deepEqual(notices, [ANSWERED])
})

test('delegate: an escalation keeps the PR blocked, notifies once, and the same question starts no second run', async () => {
  const escalate = delegateReport({ decision: 'escalate', answer: '', planRefs: [], reasoning: 'The plan is silent on the flag.' })
  const { manifest, driver, pr, entry, notices, calls } = delegateDriver({ pr: 11 }, { results: [escalate] })

  await advanced(driver, pr)
  await advanced(driver, pr)

  assert.equal(calls.length, 1)
  assert.equal(entry.state, 'blocked')
  assert.deepEqual(eventsSince(manifest).slice(2), [
    { id: 'A1', kind: 'delegate-escalated', run: 'A1-01-delegate', blocked: 'needs-decision', reason: 'The plan is silent on the flag.' },
  ])

  assert.deepEqual(notices, [
    'A1: the delegate passes this to you (needs-decision): Keep the old flag? Reason: The plan is silent on the flag. Answer with rollout note A1',
  ])

  assert.deepEqual(
    entry.delegate.answers.map((answer) => answer.decision),
    ['escalate'],
  )
})

test('delegate: an escalation with an empty reason notifies no Reason part', async () => {
  const escalate = delegateReport({ decision: 'escalate', answer: '', planRefs: [], reasoning: '' })
  const { driver, pr, notices } = delegateDriver({ pr: 11 }, { results: [escalate] })

  await advanced(driver, pr)

  assert.deepEqual(notices, ['A1: the delegate passes this to you (needs-decision): Keep the old flag? Answer with rollout note A1'])
})

test('delegate: an empty answer is an escalation', async () => {
  const { manifest, driver, pr, entry } = delegateDriver({ pr: 11 }, { results: [delegateReport({ answer: '  ' })] })

  await advanced(driver, pr)

  assert.equal(entry.state, 'blocked')
  assert.equal(eventsSince(manifest).at(-1).reason, 'the delegate gave an empty answer')
})

test('delegate: at maxPerPr it starts nothing and notifies once', async () => {
  const { manifest, driver, pr, entry, notices, calls } = delegateDriver({
    pr: 11,
    delegate: { runs: 2, lastQuestion: null, limitNotified: false, answers: [] },
  })

  await advanced(driver, pr)
  await advanced(driver, pr)

  assert.deepEqual(calls, [])
  assert.deepEqual(eventsSince(manifest), [{ id: 'A1', kind: 'delegate-limit', runs: 2, maxPerPr: 2 }])
  assert.equal(notices.length, 1)
  assert.ok(notices[0].includes('policy.delegate.maxPerPr'), notices[0])
  assert.equal(entry.delegate.limitNotified, true)
})

function blockedReport(blocked) {
  return agentResult({ output: { status: 'BLOCKED', summary: 'Blocked on a question.', blocked } })
}

test('delegate: a BLOCKED code-scanning report never starts the delegate and notifies once', async () => {
  const { manifest, driver, pr, entry, notices, calls } = delegateDriver(
    { state: 'fixing', pr: 11, blocked: null },
    { policy: { delegate: { kinds: ['brief-questions', 'needs-decision', 'brief-contradiction', 'stuck'] } } },
  )

  const blocked = { kind: 'code-scanning', question: 'Alert 4 is a false positive.', evidence: 'The path is a constant.' }

  await driver.onDone(pr, 'fix', blockedReport(blocked), { run: 'A1-02-fix' })
  await advanced(driver, pr)
  await advanced(driver, pr)

  assert.deepEqual(calls, [])
  assert.deepEqual(kindsSince(manifest), ['fix-done', 'blocked'])
  assert.equal(notices.length, 1)
  assert.ok(notices[0].startsWith('A1: blocked (code-scanning): '), notices[0])
  assert.equal(entry.state, 'blocked')
  assert.equal(entry.delegate.runs, 0)
})

test('delegate: a question it takes notifies once, through its answer or escalation', async () => {
  const escalate = delegateReport({ decision: 'escalate', answer: '', planRefs: [], reasoning: 'The plan is silent.' })
  const reports = [
    { results: [], expected: ANSWERED },
    {
      results: [escalate],
      expected:
        'A1: the delegate passes this to you (needs-decision): Keep the old flag? Reason: The plan is silent. Answer with rollout note A1',
    },
  ]

  for (const { results, expected } of reports) {
    const { manifest, driver, pr, notices } = delegateDriver({ state: 'fixing', pr: 11, blocked: null }, { results })

    await driver.onDone(pr, 'fix', blockedReport(DECISION), { run: 'A1-02-fix' })

    assert.deepEqual(kindsSince(manifest), ['fix-done', 'blocked'])
    assert.deepEqual(notices, [])

    await advanced(driver, pr)

    assert.deepEqual(notices, [expected])
  }

  const { manifest, driver, pr, notices } = delegateDriver({ state: 'briefing', blocked: null }, { brief: false })
  const questions = { brief: '', questions: ['Which API?'], notes: 'The plan names two.', expectedFiles: [], changesetBump: 'none' }

  driver.onBriefDone(pr, agentResult({ output: questions }))

  assert.deepEqual(kindsSince(manifest), ['blocked'])
  assert.deepEqual(notices, [])

  await advanced(driver, pr)

  assert.deepEqual(notices, [ANSWERED])
})

test('delegate: blocked still notifies when the delegate will not take the question', async () => {
  const notice = 'A1: blocked (needs-decision): Keep the old flag?'
  const cases = [
    { state: {}, policy: {} },
    { state: { pendingNote: 'Wait for me.' } },
    { state: { delegate: { runs: 2, lastQuestion: null, limitNotified: false, answers: [] } } },
  ]

  for (const { state, policy } of cases) {
    const { driver, pr, notices, calls } = delegateDriver({ state: 'fixing', pr: 11, blocked: null, ...state }, { policy })

    await driver.onDone(pr, 'fix', blockedReport(DECISION), { run: 'A1-02-fix' })

    assert.deepEqual(notices, [notice])
    assert.deepEqual(calls, [])
  }

  const escalate = delegateReport({ decision: 'escalate', answer: '', planRefs: [], reasoning: 'The plan is silent.' })
  const { driver, pr, notices, calls } = delegateDriver({ state: 'fixing', pr: 11, blocked: null }, { results: [escalate] })

  await driver.onDone(pr, 'fix', blockedReport(DECISION), { run: 'A1-02-fix' })
  await advanced(driver, pr)
  await driver.onDone(pr, 'fix', blockedReport(DECISION), { run: 'A1-03-fix' })
  await advanced(driver, pr)

  assert.equal(notices.length, 2)
  assert.ok(notices[0].includes('passes this to you (needs-decision)'), notices[0])
  assert.equal(notices[1], notice)
  assert.equal(calls.length, 1)
})

test('delegate: a maintainer note while it runs applies at once, and the late answer is dropped', async () => {
  let finish
  const late = new Promise((resolve) => {
    finish = resolve
  })

  const { manifest, driver, pr, entry, notices } = delegateDriver({ pr: 11 }, { results: [late] })

  await driver.advance(pr)
  assert.equal(driver.running.get('A1'), 'delegate')

  assert.deepEqual(apply(manifest, driver, { cmd: 'note', id: 'A1', text: 'Drop the old flag.' }), [
    { id: 'A1', kind: 'needs-fix', reason: 'answer from the maintainer' },
  ])

  assert.equal(entry.state, 'needs_fix')

  finish(delegateReport())
  await waitFor(() => driver.running.size === 0, 'the delegate to finish')

  const kinds = kindsSince(manifest)

  assert.deepEqual(kinds.slice(-2), ['delegate-done', 'delegate-dropped'])
  assert.ok(!kinds.includes('delegate-answered'))
  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixNote, 'Drop the old flag.')
  assert.deepEqual(eventsSince(manifest).at(-1), { id: 'A1', kind: 'delegate-dropped', run: 'A1-01-delegate', state: 'needs_fix' })
  assert.deepEqual(
    entry.delegate.answers.map((answer) => answer.decision),
    ['dropped'],
  )

  assert.deepEqual(notices, [])
})

test('delegate: a failed run escalates, backs off, and the same question starts no second run', async () => {
  const failure = agentResult({ ok: false, output: null, error: 'killed by SIGKILL', costUsd: 0.5, seconds: 300 })
  const { manifest, driver, pr, entry, notices, calls } = delegateDriver({ pr: 11 }, { results: [failure] })

  await advanced(driver, pr)

  assert.equal(entry.state, 'blocked')
  assert.equal(entry.failStreak, 1)
  assert.ok(Date.parse(entry.retryAfter) > Date.now())
  assert.equal(entry.lastError, 'killed by SIGKILL')
  assert.deepEqual(kindsSince(manifest), ['delegate-start', 'delegate-done', 'delegate-escalated'])
  assert.equal(eventsSince(manifest).at(-1).reason, 'the run failed: killed by SIGKILL')
  assert.equal(notices.length, 1)
  assert.deepEqual(
    entry.delegate.answers.map((answer) => [answer.decision, answer.reasoning]),
    [['failed', 'killed by SIGKILL']],
  )

  entry.retryAfter = null
  await advanced(driver, pr)

  assert.equal(calls.length, 1)
})

test('delegate: a stopped run gives its run back, and a PR merged meanwhile is cleaned up', async () => {
  const cleaned = []
  const { driver, pr, entry } = delegateDriver({ pr: 11, delegate: { runs: 1, lastQuestion: null, limitNotified: false, answers: [] } })
  const context = { run: 'A1-01-delegate', question: 'q', blocked: DECISION }

  await driver.onDelegateDone(pr, agentResult({ ok: false, stopped: true, output: null, error: 'driver stopping' }), context)

  assert.equal(entry.delegate.runs, 0)
  assert.equal(entry.delegate.lastQuestion, null)
  assert.deepEqual(entry.delegate.answers, [])

  const merged = driverFor({ A1: { state: 'merged', pr: 11 } }, { cleanup: async (item) => cleaned.push(item.id) })

  await merged.driver.onDelegateDone(pr, delegateReport(), context)

  assert.deepEqual(cleaned, ['A1'])
  assert.equal(merged.driver.ledger.prs.A1.state, 'merged')
  assert.deepEqual(merged.driver.ledger.prs.A1.delegate.answers, [])
})

test('retry resets the delegate run count and keeps its answers, and waits while the delegate runs', () => {
  const answers = [{ decision: 'escalate', question: 'Keep the old flag?' }]
  const { manifest, driver, entry } = delegateDriver({ pr: 11, delegate: { runs: 2, lastQuestion: 'abc', limitNotified: true, answers } })

  driver.running.set('A1', 'delegate')
  assert.deepEqual(apply(manifest, driver, { cmd: 'retry', id: 'A1' }), [
    { id: 'A1', kind: 'command-rejected', command: 'retry', reason: 'an agent is working on this PR' },
  ])

  driver.running.delete('A1')
  apply(manifest, driver, { cmd: 'retry', id: 'A1' })

  assert.deepEqual(entry.delegate, { runs: 0, lastQuestion: 'abc', limitNotified: false, answers })
})

const STOPPED = agentResult({ ok: false, output: null, error: 'stopped', costUsd: 0, seconds: 0 })

// Stands in for the fix run that follows an answer: the PR is claimed again
// and verified. The failed result keeps verified() and its git calls out.
async function verifiedAgain(driver, pr, entry) {
  entry.state = 'ready_claimed'
  driver.launch(pr, 'verify', { sha: SHA })
  await waitFor(() => driver.running.size === 0, 'the verifier to finish')
}

function assertDecisionsAfterBrief(prompt, parts) {
  const brief = prompt.indexOf('## Brief for A1')
  const section = prompt.indexOf('## Decisions after the brief')

  assert.ok(brief > -1)
  assert.ok(section > brief)

  for (const part of parts) {
    assert.ok(prompt.indexOf(part, section) > section, part)
  }
}

test('note: an answer given while the PR was blocked reaches the next verifier, after the brief', async () => {
  const { manifest, driver, pr, entry, calls } = delegateDriver(
    { pr: 11, sessionId: 'session-1', claimedSha: SHA },
    { policy: {}, results: [STOPPED] },
  )

  assert.deepEqual(apply(manifest, driver, { cmd: 'note', id: 'A1', text: 'Drop the old flag.' }), [
    { id: 'A1', kind: 'needs-fix', reason: 'answer from the maintainer' },
  ])

  await verifiedAgain(driver, pr, entry)

  assert.equal(calls.length, 1)
  assert.equal(calls[0].role, 'verify')
  assertDecisionsAfterBrief(calls[0].prompt, ['From the maintainer, on needs-decision', DECISION.question, 'Drop the old flag.'])
})

test('delegate: its answer reaches the next verifier, after the brief', async () => {
  const { driver, pr, entry, calls } = delegateDriver(
    { pr: 11, sessionId: 'session-1', claimedSha: SHA },
    { policy: { delegate: {} }, results: [delegateReport(), STOPPED] },
  )

  await advanced(driver, pr)
  assert.equal(entry.fixReason, 'answer from the delegate')

  await verifiedAgain(driver, pr, entry)

  assert.deepEqual(
    calls.map((call) => call.role),
    ['delegate', 'verify'],
  )

  assertDecisionsAfterBrief(calls[1].prompt, ['From the delegate, on needs-decision', DECISION.question, 'Keep it as an alias.'])
})

test('checkClaim: a note queued while a verifier ran goes to a fix run first, with no agent and no gh or git call', async () => {
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
    const manifest = loadManifest(dir)
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

const CLAIMED = { state: 'ready_claimed', pr: 11, claimedSha: SHA, attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } }

// A claimed A1 with green CI on its head, and the given code scanning facts.
function claimDriver(facts) {
  const setup = tickDriver({ A1: CLAIMED }, { rules: [viewRule(), { tool: 'gh', args: `commits/${SHA}/check-runs`, stdout: GREEN_RUNS }] })
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
  const unavailable = { codeScanning: { available: false, reason: 'gh: no analysis found (HTTP 404)', alerts: [], baseOpen: [] } }
  const { manifest, driver, pr, entry, notices } = claimDriver(unavailable)

  await driver.advance(pr)
  await driver.advance(pr)

  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.claimPatchId, samplePrs().A1.verified.patchId)
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
    gateCheckEvent('policy', 'pass', 'no violations'),
    { id: 'A1', kind: 'code-scanning-unavailable', reason: 'gh: no analysis found (HTTP 404)' },
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

// A claimed A1 with green CI, a free slot and a worktree at its head, so checkClaim
// can start the verifier. Its scope is lib/** and it changes README.md. The agent never finishes.
function verifiableDriver({ gates, deviations } = {}) {
  const agentCalls = []
  const setup = tickDriver(
    { A1: CLAIMED },
    {
      policy: { concurrency: 1 },
      runAgent: (_, pr, options) => {
        agentCalls.push({ id: pr.id, role: options.role })
        return new Promise(() => {})
      },
    },
  )

  const pr = setup.manifest.prs.find((item) => item.id === 'A1')
  const entry = setup.driver.ledger.prs.A1
  const wt = worktreePath(setup.manifest, pr)
  const gitDir = join(wt, '.git-dir')

  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(wt, '.git'), `gitdir: ${gitDir}\n`)
  writeFileSync(join(gitDir, 'rollout-ready'), '')
  setup.tools.answer([
    viewRule(),
    { tool: 'gh', args: `commits/${SHA}/check-runs`, stdout: GREEN_RUNS },
    { tool: 'git', args: 'rev-parse --absolute-git-dir', stdout: gitDir },
    { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
    { tool: 'git', args: '', stdout: '' },
  ])

  entry.briefScope = ['lib/**']
  entry.ready = { status: 'READY', deviations }
  setup.gate.facts = { files: [{ status: 'modified', path: 'README.md' }] }

  if (gates) {
    setup.manifest.gates = gates
  }

  return { ...setup, pr, entry, agentCalls }
}

const SCOPE_GATE = { preVerify: { scope: true } }

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

  assert.deepEqual(manifest.gates, { preVerify: { scope: false } })

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
  const { manifest, driver, tools, pr, entry } = claimDriver({})
  const runs = {
    check_runs: [
      { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'lint', status: 'completed', conclusion: 'failure' },
    ],
  }

  tools.answer([viewRule(), { tool: 'gh', args: `commits/${SHA}/check-runs`, stdout: runs }])

  await driver.advance(pr)

  assert.equal(entry.state, 'needs_fix')
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'fail', 'failing: lint: failure'),
    { id: 'A1', kind: 'needs-fix', reason: 'CI is red' },
  ])
})

test('checkClaim: CI that does not settle logs a failed ci check right before it goes back to the implementer', async () => {
  const { manifest, driver, tools, pr, entry } = claimDriver({})
  const running = { check_runs: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }

  entry.ciPendingSince = new Date(Date.now() - 60 * 60_000).toISOString()
  tools.answer([viewRule(), { tool: 'gh', args: `commits/${SHA}/check-runs`, stdout: running }])

  await driver.advance(pr)

  assert.equal(entry.state, 'needs_fix')
  assert.deepEqual(eventsSince(manifest), [
    gateCheckEvent('ci', 'fail', 'not settled after 20 minutes (missing: none, running: test)'),
    { id: 'A1', kind: 'needs-fix', reason: 'CI did not settle' },
  ])
})

test('checkClaim: a pass is logged once per claim, and again for a new claim', async () => {
  const { manifest, driver, tools, gate, pr, entry } = claimDriver({})
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
  tools.answer([viewRule({ headRefOid: REBASED }), { tool: 'gh', args: `commits/${REBASED}/check-runs`, stdout: GREEN_RUNS }])

  await driver.advance(pr)

  assert.deepEqual(eventsSince(manifest, before), passes(REBASED))
  assert.deepEqual(entry.notified.gateChecks, {
    claimedAt: at(3),
    sha: REBASED,
    seen: ['ci:pass', 'policy:pass', 'code-scanning:pass'],
  })
})

// Sync's head-moved-same-patch moves claimedSha and keeps claimedAt. A gate block and rollout retry can then bring the PR back here.
test('checkClaim: a new head under the same claim logs its passes again', async () => {
  const { manifest, driver, tools, gate, pr, entry } = claimDriver({})

  entry.claimedAt = at(1)

  await driver.advance(pr)

  const before = readEvents(manifest).length
  entry.claimedSha = REBASED
  gate.pr = { headRefOid: REBASED }
  tools.answer([viewRule({ headRefOid: REBASED }), { tool: 'gh', args: `commits/${REBASED}/check-runs`, stdout: GREEN_RUNS }])

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
  const { manifest, driver, tools, pr } = claimDriver({})
  const runs = {
    check_runs: [
      { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'docs', status: 'completed', conclusion: 'skipped' },
    ],
  }

  tools.answer([viewRule(), { tool: 'gh', args: `commits/${SHA}/check-runs`, stdout: runs }])

  await driver.advance(pr)

  assert.deepEqual(eventsSince(manifest)[0], gateCheckEvent('ci', 'pass', 'required checks passed, runs: test (success), docs (skipped)'))
})

test('checkClaim: every gate-check event is short and names the stage and the level', async () => {
  const { manifest, driver, tools, pr } = claimDriver({})
  const many = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `job-${i}`, status: 'completed', conclusion: 'failure' }))

  tools.answer([viewRule(), { tool: 'gh', args: `commits/${SHA}/check-runs`, stdout: { check_runs: many } }])

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
    { id: 'A1', kind: 'gate-fix', reasons: [ALERT_REASON] },
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
    { id: 'A1', kind: 'gate-block', reasons: [ALERT_REASON] },
    { id: 'A1', kind: 'blocked', reason: 'code-scanning' },
  ])

  assert.deepEqual(notices, [`A1: blocked (code-scanning): ${ALERT_REASON.slice(0, 120)}`])
})

test('mergeCandidate: an analysis of an older commit waits with no notification', async () => {
  const { manifest, driver, gate, notices } = tickDriver({ A1: { ...samplePrs().A1, held: null } })
  gate.facts = scanned([scanAlert({ sha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2' })])

  assert.equal(await driver.mergeCandidate(manifest.prs.find((item) => item.id === 'A1')), false)
  assert.equal(driver.ledger.prs.A1.state, 'verified')
  assert.equal(driver.ledger.prs.A1.gate.kind, 'code-scanning')
  assert.deepEqual(notices, [])
})

const REJECTED = { ...samplePrs().A1, state: 'needs_fix', fixReason: 'verifier findings', verified: null, approved: null }
const REJECTED_LABELS = ['rollout-stage:needs-fix', 'rollout-reason:verifier-findings']
const LABELS_OK = [
  { tool: 'gh', args: 'label create', stdout: '' },
  { tool: 'gh', args: 'pr edit 11', stdout: '' },
]

// `gh pr view` for A1 carrying these labels, next to the rollout's own.
function viewWithLabels(labels) {
  return viewRule({ labels: ['rollout:demo', ...labels].map((name) => ({ name })) })
}

function labelEdits(tools) {
  return tools
    .calls()
    .filter((call) => call.tool === 'gh' && call.args[0] === 'pr' && call.args[1] === 'edit')
    .map((call) => call.args.slice(2).join(' '))
}

test('tick: a PR sent back by the verifier gets its stage and reason as labels, once', async () => {
  const { driver, tools } = tickDriver({ A1: REJECTED }, { rules: [FETCH, viewRule(), ...LABELS_OK] })

  await driver.tick()
  tools.answer([FETCH, viewWithLabels(REJECTED_LABELS), ...LABELS_OK])
  await driver.tick()

  assert.deepEqual(labelEdits(tools), ['11 --add-label rollout-stage:needs-fix --add-label rollout-reason:verifier-findings'])
  assert.ok(tools.calls().some((call) => call.args.join(' ').startsWith('label create rollout-reason:verifier-findings --color d93f0b')))
  assert.deepEqual(driver.ledger.prs.A1.stageLabels, REJECTED_LABELS)
})

test('tick: when the PR moves on, the old stage and reason come off', async () => {
  const { driver, tools } = tickDriver({ A1: REJECTED }, { rules: [FETCH, viewRule(), ...LABELS_OK] })

  await driver.tick()
  tools.answer([FETCH, viewWithLabels(REJECTED_LABELS), ...LABELS_OK])
  driver.ledger.prs.A1.state = 'verifying'
  await driver.tick()

  assert.deepEqual(
    labelEdits(tools).at(-1),
    '11 --add-label rollout-stage:verifying --remove-label rollout-stage:needs-fix --remove-label rollout-reason:verifier-findings',
  )
})

test('tick: the labels the PR really carries count, so one removed or added by hand is put right', async () => {
  const { driver, tools } = tickDriver(
    { A1: REJECTED },
    { rules: [FETCH, viewWithLabels(['rollout-reason:verifier-findings', 'rollout-stage:verified', 'bug']), ...LABELS_OK] },
  )

  await driver.tick()

  assert.deepEqual(labelEdits(tools), ['11 --add-label rollout-stage:needs-fix --remove-label rollout-stage:verified'])
})

test('tick: during a GitHub outage no label call is made', async () => {
  const { driver, tools } = tickDriver({ A1: REJECTED }, { rules: [FETCH, VIEW_502, ...LABELS_OK] })

  await driver.tick()

  assert.ok(driver.ledger.data.githubUnavailable)
  assert.deepEqual(labelEdits(tools), [])
  assert.ok(!tools.calls().some((call) => call.args[0] === 'label'))
})

test('tick: a label GitHub refuses is kept on the PR row, counts no error and is tried again', async () => {
  const refused = { tool: 'gh', args: 'pr edit 11', code: 1, stderr: 'HTTP 403: Resource not accessible' }
  const { manifest, driver, tools } = tickDriver({ A1: REJECTED }, { rules: [FETCH, viewRule(), LABELS_OK[0], refused] })
  const before = readEvents(manifest).length

  await driver.tick()

  assert.match(driver.ledger.prs.A1.stageLabelError, /HTTP 403/)
  assert.deepEqual(driver.ledger.prs.A1.stageLabels, [])
  assert.ok(!eventsSince(manifest, before).some((event) => event.kind === 'error' && /pr edit/.test(event.error ?? '')))

  tools.answer([FETCH, viewRule(), ...LABELS_OK])
  await driver.tick()

  assert.equal(driver.ledger.prs.A1.stageLabelError, null)
  assert.equal(labelEdits(tools).length, 2)
})

const FIRST_ROUND = {
  at: at(50),
  items: [
    { id: 'F1', text: 'cli.mjs:40 swallows the error.', answer: { outcome: 'fixed', action: 'It is logged at cli.mjs:42.' } },
    { id: 'F2', text: 'The retry flag is not documented.', answer: { outcome: 'disputed', action: 'The brief keeps the flag internal.' } },
  ],
}

const UNANSWERED = { ...FIRST_ROUND, items: FIRST_ROUND.items.map((item) => ({ ...item, answer: null })) }
const NEW_FINDING = 'README.md:3 still names the old flag.'

// A1 under verification of SHA, with the findings of the FAIL before it and
// the implementer's answers. Its fake git shows a clean worktree at SHA.
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

  return { ...setup, pr: setup.manifest.prs.find((item) => item.id === 'A1'), entry: setup.driver.ledger.prs.A1 }
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

// A1 in a fix run after a FAIL whose findings are not answered yet.
function answeringDriver(rules, state = {}) {
  const setup = tickDriver(
    { A1: { state: 'fixing', pr: 11, claimedSha: SHA, sessionId: 'session-1', findings: UNANSWERED, ...state } },
    { rules },
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
  const { manifest, driver, pr, entry } = answeringDriver([viewRule({ headRefOid: NEW_HEAD })])
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
  const cases = [
    { state: 'needs_fix', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 11.' },
    { state: 'interrupted', stderr: 'HTTP 502: Bad Gateway' },
  ]

  for (const { state, stderr } of cases) {
    const { driver, pr, entry } = answeringDriver([{ tool: 'gh', args: 'pr view 11', code: 1, stderr }])

    await driver.onDone(pr, 'fix', readyReport(NEW_HEAD, ANSWERS), { run: 'A1-03-fix' })

    assert.equal(entry.state, state)
    assert.deepEqual(entry.findings, FIRST_ROUND, state)
  }
})

test('claimReport: a finding id in addressed never reaches GitHub, and the review comment is answered as before', async () => {
  const { manifest, driver, pr, entry, tools } = answeringDriver(
    [viewRule({ headRefOid: NEW_HEAD }), { tool: 'gh', args: 'api -X POST', stdout: '{}' }],
    { feedbackInFix: [{ id: 'inline-5', commentId: 55, body: 'Rename this helper.' }] },
  )

  const addressed = [{ id: 'inline-5', action: 'Renamed it to parseTicket.' }, ANSWERS[0]]
  const reply = `api -X POST repos/${manifest.repo.github}/pulls/11/comments/55/replies -f body=Renamed it to parseTicket. (b2b2b2b)`

  await driver.onDone(pr, 'fix', readyReport(NEW_HEAD, addressed), { run: 'A1-03-fix' })

  const calls = tools
    .calls()
    .filter((call) => call.tool === 'gh')
    .map((call) => call.args.join(' '))

  const writes = calls.filter((line) => !line.startsWith('pr view 11 '))

  assert.equal(writes.length, 1)
  assert.ok(writes[0].startsWith(reply), writes[0])
  assert.ok(
    calls.every((line) => !line.includes('F1') && !line.includes(ANSWERS[0].action)),
    calls.join('\n'),
  )

  assert.deepEqual(entry.findings.items[0].answer, { outcome: 'fixed', action: ANSWERS[0].action })
  assert.deepEqual(
    entry.feedbackHandled.map((item) => [item.id, item.action]),
    [['inline-5', 'Renamed it to parseTicket.']],
  )
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
    [{ by: 'maintainer', kind: 'disputed finding', question: dispute, text: 'Document the flag in the README.' }],
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
