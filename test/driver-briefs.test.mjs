import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { prDetail } from '../lib/view.mjs'
import { worktreePath } from '../lib/worktree.mjs'
import { waitFor } from './fixtures.mjs'
import { agentResult, driverFor, apply, SHA, eventsSince, kindsSince, modelDriver, launched } from './driver-helpers.mjs'

const RULE = 'When the PR changes a rule or a behaviour, every file that states the old one is in Expected files.'
const LEAN = 'The brief has no filler.'

function briefOutput(overrides = {}) {
  return {
    brief: '# A1\n\nThe brief.\n',
    questions: [],
    notes: 'Checked every path.',
    expectedFiles: ['lib/a.mjs'],
    changesetBump: 'minor',
    checks: [],
    criteria: [],
    ...overrides,
  }
}

// A1 while its brief is written, with gates.brief as given or the default.
function briefDoneDriver(brief, options = {}) {
  const { manifest, driver } = driverFor({ A1: { state: 'briefing', attempts: { implement: 0, fix: 0, verify: 0, brief: 1 } } }, options)

  if (brief) {
    manifest.gates.brief = brief
  }

  const pr = manifest.all.find((item) => item.id === 'A1')

  return { manifest, driver, pr, entry: driver.ledger.prs.A1, notes: pr.brief.replace(/\.md$/, '.review-notes.md') }
}

function briefCheckEvent(item, level, result, evidence, ahead = []) {
  return { id: 'A1', kind: 'gate-check', stage: 'brief', item, level, result, ahead, evidence }
}

test('onBriefDone: a required brief criterion that does not pass blocks on brief-questions, and no brief is written', () => {
  const notices = []
  const { manifest, driver, pr, entry, notes } = briefDoneDriver(
    { runChecks: false, required: [RULE], recommended: [LEAN] },
    { notify: (_, message) => notices.push(message) },
  )

  const criteria = [
    { id: 'B1', result: 'fail', evidence: 'docs/a.md states the old rule.' },
    { id: 'B2', result: 'pass', evidence: 'Short.' },
  ]

  driver.onBriefDone(pr, agentResult({ output: briefOutput({ criteria }) }))

  assert.equal(entry.state, 'blocked')
  assert.equal(entry.blocked.kind, 'brief-questions')
  assert.equal(entry.blocked.question, `B1 (required brief criterion, fail): ${RULE} Evidence: docs/a.md states the old rule.`)
  assert.equal(entry.blocked.evidence, 'Checked every path.')
  assert.equal(existsSync(pr.brief), false)
  assert.equal(existsSync(notes), false)
  assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'blocked'])
  assert.equal(notices.length, 1)
  assert.ok(notices[0].startsWith('A1: the brief needs your decision: B1 (required brief criterion, fail): When the PR'), notices[0])
})

test("onBriefDone: a reviewer question that names the failed criterion is not doubled, and the others follow the reviewer's own", () => {
  const failed = [{ id: 'B1', result: 'unverifiable', evidence: 'The plan does not say.' }]
  const named = briefDoneDriver({ runChecks: false, required: [RULE], recommended: [] })

  named.driver.onBriefDone(
    named.pr,
    agentResult({ output: briefOutput({ questions: ['B1: does docs/a.md keep the old rule?'], criteria: failed }) }),
  )

  assert.equal(named.entry.state, 'blocked')
  assert.equal(named.entry.blocked.question, 'B1: does docs/a.md keep the old rule?')

  const other = briefDoneDriver({ runChecks: false, required: [RULE], recommended: [] })

  other.driver.onBriefDone(other.pr, agentResult({ output: briefOutput({ questions: ['Which API?'], criteria: failed }) }))

  assert.equal(
    other.entry.blocked.question,
    `Which API?\nB1 (required brief criterion, unverifiable): ${RULE} Evidence: The plan does not say.`,
  )
})

test('onBriefDone: a check that cannot pass blocks, and one that can pass logs pass whatever its exit code', () => {
  const { manifest, driver, pr, entry } = briefDoneDriver({ runChecks: true, required: [], recommended: [] })
  const checks = [
    { command: 'npm run build:docs', exitCode: 1, canPass: false, evidence: 'missing script: build:docs' },
    { command: 'npm test', exitCode: 1, canPass: true, evidence: 'fails only on the test this PR adds' },
  ]

  driver.onBriefDone(pr, agentResult({ output: briefOutput({ checks }) }))

  assert.equal(entry.state, 'blocked')
  assert.equal(entry.blocked.kind, 'brief-questions')
  assert.equal(
    entry.blocked.question,
    'The check `npm run build:docs` cannot pass after a change within the expected files (exit 1). Evidence: missing script: build:docs',
  )

  assert.equal(existsSync(pr.brief), false)
  assert.deepEqual(eventsSince(manifest).slice(0, 2), [
    briefCheckEvent('npm run build:docs', 'required', 'fail', 'exit 1: missing script: build:docs'),
    briefCheckEvent('npm test', 'required', 'pass', 'exit 1: fails only on the test this PR adds'),
  ])
})

test('onBriefDone: a recommended brief criterion that does not pass writes the brief and adds it to the review notes', () => {
  const { manifest, driver, pr, entry, notes } = briefDoneDriver({ runChecks: false, required: [RULE], recommended: [LEAN] })
  const criteria = [
    { id: 'B1', result: 'pass', evidence: 'docs/a.md is listed.' },
    { id: 'B2', result: 'unverifiable', evidence: 'No style guide.' },
  ]

  driver.onBriefDone(pr, agentResult({ output: briefOutput({ criteria }) }))

  assert.equal(entry.state, 'pending')
  assert.equal(readFileSync(pr.brief, 'utf8'), '# A1\n\nThe brief.\n')
  assert.equal(
    readFileSync(notes, 'utf8'),
    'Checked every path.\n\n## Recommended brief criteria that did not pass\n\n- B2 (unverifiable): The brief has no filler. Evidence: No style guide.\n',
  )

  assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'brief-written'])
})

test('onBriefDone: one gate-check per check and criterion, with stage brief and the heads the brief saw instead of a SHA', () => {
  const { manifest, driver, pr, entry } = briefDoneDriver({ runChecks: true, required: [RULE], recommended: [LEAN] })
  const heads = [{ id: 'A3', sha: 'c3c3c3c3c3c3c3c3', patchId: 'patch-a3' }]
  const notified = structuredClone(entry.notified)
  const output = briefOutput({
    checks: [{ command: 'npm test', exitCode: 0, canPass: true, evidence: 'x'.repeat(400) }],
    criteria: [
      { id: 'B1', result: 'pass', evidence: 'docs/a.md is listed.' },
      { id: 'B2', result: 'fail', evidence: 'Two filler sentences in Goal.' },
    ],
  })

  driver.onBriefDone(pr, agentResult({ output }), heads)

  const events = eventsSince(manifest).filter((event) => event.kind === 'gate-check')

  assert.deepEqual(events, [
    briefCheckEvent('npm test', 'required', 'pass', `exit 0: ${'x'.repeat(292)}`, ['A3@c3c3c3c']),
    briefCheckEvent('B1', 'required', 'pass', 'docs/a.md is listed.', ['A3@c3c3c3c']),
    briefCheckEvent('B2', 'recommended', 'fail', 'Two filler sentences in Goal.', ['A3@c3c3c3c']),
  ])

  assert.ok(events.every((event) => !Object.hasOwn(event, 'sha')))
  assert.deepEqual(entry.notified, notified, 'the preVerify dedupe is untouched')
  assert.deepEqual(entry.briefHeads, heads)
  assert.equal(entry.state, 'pending')
})

test('onBriefDone: without gates.brief the brief and its notes are written as before, with no gate-check', () => {
  const legacy = {
    brief: '# A1\n\nThe brief.\n',
    questions: [],
    notes: '  Checked every path.\n',
    expectedFiles: ['lib/a.mjs'],
    changesetBump: 'minor',
  }

  const reported = briefOutput({
    notes: '  Checked every path.\n',
    checks: [{ command: 'npm run build:docs', exitCode: 1, canPass: false, evidence: 'missing script' }],
    criteria: [{ id: 'B1', result: 'fail', evidence: 'Not a criterion of this rollout.' }],
  })

  for (const output of [legacy, reported]) {
    const { manifest, driver, pr, entry, notes } = briefDoneDriver(null)

    assert.deepEqual(manifest.gates.brief, { runChecks: false, required: [], recommended: [] })

    driver.onBriefDone(pr, agentResult({ output }))

    assert.equal(entry.state, 'pending')
    assert.equal(readFileSync(pr.brief, 'utf8'), '# A1\n\nThe brief.\n')
    assert.equal(readFileSync(notes, 'utf8'), 'Checked every path.\n')
    assert.deepEqual(kindsSince(manifest), ['brief-written'])
  }
})

test('launch: a brief keeps the gates.brief it started with when the manifest changes while the writer runs', async () => {
  let finishWriter
  const writer = new Promise((resolve) => {
    finishWriter = resolve
  })

  const review = briefOutput({
    checks: [{ command: 'npm run build:docs', exitCode: 1, canPass: false, evidence: 'missing script' }],
    criteria: [{ id: 'B1', result: 'pass', evidence: 'docs/a.md is listed.' }],
  })

  const setup = modelDriver(
    { A1: { state: 'pending' } },
    { result: (options) => (options.logName.endsWith('-write') ? writer : Promise.resolve(agentResult({ output: review }))) },
  )

  rmSync(setup.pr.brief)
  setup.manifest.gates.brief = { runChecks: false, required: [RULE], recommended: [] }

  const write = await launched(setup, 'brief')

  assert.ok(write.prompt.includes(`- B1 (required): ${RULE}`))

  setup.manifest.gates.brief = { runChecks: true, required: ['Every command exists.', RULE], recommended: [] }
  finishWriter(agentResult({ output: briefOutput() }))
  await waitFor(() => !setup.driver.running.has('A1'), 'the brief to finish')

  const reviewer = setup.calls.at(-1)

  assert.ok(reviewer.logName.endsWith('-review'))
  assert.ok(reviewer.prompt.includes(`- B1 (required): ${RULE}`))
  assert.equal(reviewer.prompt.includes('Every command exists.'), false)
  assert.equal(reviewer.prompt.includes('Then run every verification command'), false)

  assert.equal(setup.entry.state, 'pending')
  assert.equal(readFileSync(setup.pr.brief, 'utf8'), '# A1\n\nThe brief.\n')
  assert.deepEqual(
    eventsSince(setup.manifest)
      .filter((event) => event.kind === 'gate-check')
      .map((event) => [event.item, event.result]),
    [['B1', 'pass']],
  )
})

test('launch: both brief steps are recorded as runs, and brief questions are blocked on the review step', async () => {
  const review = briefOutput({ questions: ['Which API does the brief keep?'] })
  const setup = modelDriver(
    { A1: { state: 'pending' } },
    { result: (options) => Promise.resolve(agentResult({ output: options.logName.endsWith('-write') ? briefOutput() : review })) },
  )

  rmSync(setup.pr.brief)
  await launched(setup, 'brief')
  await waitFor(() => !setup.driver.running.has('A1'), 'the brief to finish')

  const runs = setup.driver.ledger.data.runs

  assert.equal(setup.entry.state, 'blocked')
  assert.equal(setup.entry.blocked.kind, 'brief-questions')
  assert.equal(setup.entry.blocked.run, 'A1-01-brief-review')
  assert.deepEqual(
    Object.entries(runs).map(([name, run]) => [name, run.role, run.step, run.requestedModel, run.ok, run.result, run.costUsd]),
    [
      ['A1-01-brief-write', 'brief', 'write', 'opus', true, 'BRIEF', 1.25],
      ['A1-01-brief-review', 'brief', 'review', 'opus', true, 'QUESTIONS', 1.25],
    ],
  )

  assert.ok(Object.values(runs).every((run) => run.startedAt && run.endedAt && run.stopped === false))
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
  assert.equal(entry.noteHistory.at(-1).run, null, 'a delegate run takes no note')
  assert.deepEqual(
    Object.entries(driver.ledger.data.runs).map(([name, run]) => [name, run.role, run.reason, run.ok, run.result, Boolean(run.endedAt)]),
    [['A1-01-delegate', 'delegate', 'needs-decision', true, 'ANSWER', true]],
  )

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
  assert.deepEqual(entry.blocked, { ...blocked, run: 'A1-02-fix' })
  assert.equal(entry.delegate.runs, 0)
})

test('onDone: a BLOCKED report is blocked on the run that sent it, also without a blocked of its own', async () => {
  for (const [role, run] of [
    ['implement', 'A1-01-implement'],
    ['fix', 'A1-02-fix'],
  ]) {
    const { driver, pr, entry } = delegateDriver({ state: 'fixing', pr: 11, blocked: null }, { policy: {} })

    await driver.onDone(pr, role, blockedReport(DECISION), { run })

    assert.deepEqual(entry.blocked, { ...DECISION, run }, role)
    assert.equal(driver.ledger.data.runs[run].result, 'BLOCKED', role)
  }

  const { driver, pr, entry } = delegateDriver({ state: 'implementing', blocked: null }, { policy: {} })

  await driver.onDone(pr, 'implement', blockedReport(undefined), { run: 'A1-01-implement' })

  assert.deepEqual(entry.blocked, { kind: 'unknown', question: 'Blocked on a question.', evidence: '', run: 'A1-01-implement' })
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

test('delegate: with a note pending or the question taken already, the board shows no next run and the driver starts none', async () => {
  const board = (manifest, driver) => prDetail(manifest, driver.ledger, [], [], 'A1').waiting.delegate
  const escalate = delegateReport({ decision: 'escalate', answer: '', planRefs: [], reasoning: 'The plan is silent on the flag.' })
  const taken = delegateDriver({ pr: 11 }, { results: [escalate] })

  assert.deepEqual(board(taken.manifest, taken.driver), { state: 'next', reason: '' })

  await advanced(taken.driver, taken.pr)
  assert.equal(taken.calls.length, 1)
  assert.match(taken.entry.delegate.lastQuestion, /^[0-9a-f]{16}$/)

  // A ledger whose answers were trimmed still holds the question the delegate took.
  taken.entry.delegate.answers = []
  assert.deepEqual(board(taken.manifest, taken.driver), { state: 'skips', reason: '' })

  await advanced(taken.driver, taken.pr)
  assert.equal(taken.calls.length, 1)

  const noted = delegateDriver({ pr: 11, pendingNote: 'Wait for me.' })

  assert.deepEqual(board(noted.manifest, noted.driver), { state: 'skips', reason: '' })

  await advanced(noted.driver, noted.pr)
  assert.equal(noted.calls.length, 0)
})
