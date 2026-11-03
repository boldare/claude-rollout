import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { briefDrift, createDriver, doneDetail } from '../lib/driver.mjs'
import { endRun, readLedger } from '../lib/ledger.mjs'
import { readEvents } from '../lib/view.mjs'
import { previewPath, worktreePath } from '../lib/worktree.mjs'
import { at, samplePrs, waitFor } from './fixtures.mjs'
import {
  agentResult,
  driverFor,
  apply,
  SHA,
  prRoute,
  runsRoute,
  gateFacts,
  tickDriver,
  eventsSince,
  kindsSince,
  GREEN_EVIDENCE,
  gateCheckEvent,
  modelDriver,
  launched,
  NEW_HEAD,
  CLAIMED,
  verifiableDriver,
  gatesWith,
  COMMANDS_GATE,
  commandRun,
  commandSeam,
  preVerified,
} from './driver-helpers.mjs'

function headline(role, output) {
  return doneDetail(role, 'A1-01-run', agentResult({ output })).result
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

test('launch: one implement run is one record in the ledger, with the model it asked for and the model that ran', async () => {
  const blocked = { kind: 'needs-decision', question: 'Keep the old flag?', evidence: 'cli.mjs:12 reads it.' }
  const report = agentResult({ model: 'claude-sonnet-5-5', output: { status: 'BLOCKED', summary: 'A question.', blocked } })
  const setup = modelDriver({ A1: { state: 'pending' } }, { result: () => Promise.resolve(report) })

  const { logName: run } = await launched(setup, 'implement')
  await waitFor(() => !setup.driver.running.has('A1'), 'the run to end')

  const runs = setup.driver.ledger.data.runs
  const record = runs[run]

  assert.deepEqual(Object.keys(runs), [run])
  assert.ok(Date.parse(record.startedAt) <= Date.parse(record.endedAt), JSON.stringify(record))
  assert.deepEqual(
    [record.id, record.role, record.effort, record.requestedModel, record.model, record.resume, record.log],
    ['A1', 'implement', 'high', 'sonnet', 'claude-sonnet-5-5', false, `logs/${run}.jsonl`],
  )

  assert.deepEqual(
    [record.ok, record.result, record.costUsd, record.seconds, record.denials, record.stopped],
    [true, 'BLOCKED', 1.25, 60, 0, false],
  )

  assert.deepEqual(setup.entry.blocked, { ...blocked, run })
  assert.deepEqual(readLedger(setup.manifest).runs[run], record, 'the job saves it')
})

test('note: a note applied to a blocked PR goes into the fix run that starts from it', async () => {
  const blocked = { kind: 'needs-decision', question: 'Keep the old flag?', evidence: '' }
  const attempts = { implement: 1, fix: 0, verify: 0, brief: 0 }
  const setup = modelDriver({
    A1: { state: 'blocked', blocked: { ...blocked, run: 'A1-01-implement' }, pr: 11, sessionId: 'session-1', attempts },
  })

  apply(setup.manifest, setup.driver, { cmd: 'note', id: 'A1', text: 'Keep it as an alias.' })

  assert.equal(setup.entry.state, 'needs_fix')
  assert.equal(setup.entry.noteHistory.at(-1).run, null)

  const fix = await launched(setup, 'fix', { reason: setup.entry.fixReason, note: setup.entry.fixNote })

  assert.equal(fix.logName, 'A1-02-fix')
  assert.deepEqual(
    setup.entry.noteHistory.map(({ at: _, ...note }) => note),
    [{ by: 'maintainer', kind: 'needs-decision', question: 'Keep the old flag?', text: 'Keep it as an alias.', run: 'A1-02-fix' }],
  )
})

test('note: a note queued while an implement run works waits for the next run, which takes it', async () => {
  let finish
  const old = { at: at(1), by: 'maintainer', kind: null, question: null, text: 'From an older ledger.' }
  const setup = modelDriver(
    { A1: { state: 'pending', noteHistory: [old] } },
    {
      result: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    },
  )

  const implement = await launched(setup, 'implement')

  apply(setup.manifest, setup.driver, { cmd: 'note', id: 'A1', text: 'Keep the old flag.' })

  assert.equal(setup.entry.pendingNote, 'Keep the old flag.')
  assert.equal(setup.entry.noteHistory.at(-1).run, null, 'the run at work never reads it')

  finish(agentResult({ ok: false, error: 'error_during_execution' }))
  await waitFor(() => !setup.driver.running.has('A1'), 'the run to end')

  assert.equal(setup.entry.noteHistory.at(-1).run, null)

  const fix = await launched(setup, 'fix', { reason: 'r' })

  assert.notEqual(fix.logName, implement.logName)
  assert.equal(setup.entry.noteHistory.at(-1).run, fix.logName)
  assert.equal(Object.hasOwn(setup.entry.noteHistory[0], 'run'), false, 'a record from an older ledger stays without a run')
})

test('launch: attempts exhausted after an ended run escalate with the time and that run, and a delegate run does not count', async () => {
  const setup = modelDriver(
    { A1: { state: 'pending' } },
    { result: () => Promise.resolve(agentResult({ ok: false, error: 'error_during_execution' })) },
  )

  const implement = await launched(setup, 'implement')
  await waitFor(() => !setup.driver.running.has('A1'), 'the run to end')

  const later = new Date(Date.now() + 60_000).toISOString()
  endRun(setup.driver.ledger.data, { id: 'A1', role: 'delegate' }, { run: 'A1-01-delegate', ok: true }, later)
  setup.entry.attempts.implement = setup.manifest.policy.attempts.implement

  const before = Date.now()
  setup.driver.launch(setup.pr, 'implement')

  assert.equal(setup.entry.state, 'escalated')
  assert.equal(setup.entry.escalation, 'implement attempts exhausted')
  assert.equal(setup.entry.escalationRun, implement.logName)
  assert.ok(Date.parse(setup.entry.escalatedAt) >= before, setup.entry.escalatedAt)
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

const CLAIM_PASSES = [
  gateCheckEvent('ci', 'pass', GREEN_EVIDENCE),
  gateCheckEvent('policy', 'pass', 'no violations'),
  gateCheckEvent('code-scanning', 'pass', 'no new alerts at or above medium'),
]

function commandCheckEvent(stage, item, level, result, evidence) {
  return { id: 'A1', kind: 'gate-check', stage, item, level, result, sha: SHA.slice(0, 7), evidence }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })

  return { promise, resolve }
}

test('checkClaim: with pre-verify commands it runs them as a gate job in the PR worktree instead of starting the verifier', async () => {
  const seam = commandSeam({ 'npm test': () => new Promise(() => {}) })
  const { manifest, driver, pr, entry, agentCalls } = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })

  await driver.advance(pr)

  assert.equal(driver.running.get('A1'), 'gate')
  assert.equal(entry.state, 'ready_claimed')
  assert.deepEqual(agentCalls, [])
  assert.deepEqual(seam.calls, [{ id: 'A1', command: 'npm test', cwd: worktreePath(manifest, pr) }])
  assert.deepEqual(eventsSince(manifest), CLAIM_PASSES)
})

test('checkClaim: without ready or pre-verify commands the verifier starts at once and no command runs', async () => {
  const seam = commandSeam()
  const { manifest, driver, pr, entry, agentCalls } = verifiableDriver({ runCommand: seam.runCommand })

  await driver.advance(pr)

  assert.equal(entry.state, 'verifying')
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])
  assert.deepEqual(seam.calls, [])
  assert.equal(entry.preVerify, null)
  assert.deepEqual(kindsSince(manifest), ['gate-check', 'gate-check', 'gate-check', 'verify-start'])
})

test('pre-verify: a failed required command sends the PR back with its output, and the commands after it never run', async () => {
  const tail = 'not ok 3 - parses an empty list\n# tests 12, fail 1\n'
  const seam = commandSeam({ 'npm test': commandRun({ exitCode: 1, tail }) })
  const gates = gatesWith({ preVerify: { required: ['npm test', 'npm run build'], recommended: ['npm run lint'] } })
  const setup = verifiableDriver({ gates, runCommand: seam.runCommand })
  const { manifest, entry, agentCalls } = setup

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm test'])
  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'pre-verify check')
  assert.deepEqual(agentCalls, [])
  assert.deepEqual(eventsSince(manifest), [
    ...CLAIM_PASSES,
    commandCheckEvent('preVerify', 'npm test', 'required', 'fail', `exit 1: ${tail.trim()}`),
    { id: 'A1', kind: 'needs-fix', reason: 'pre-verify check' },
  ])

  for (const part of [
    'The driver ran the required commands at `a1a1a1a`.',
    '### `npm test`\n\nexit 1\n\n```\nnot ok 3 - parses an empty list\n# tests 12, fail 1\n```',
    '- The driver runs every command again on the new head.',
    '- Never weaken, skip or delete tests or checks to get green.',
  ]) {
    assert.ok(entry.fixNote.includes(part), part)
  }

  assert.equal(entry.preVerify.sha, SHA)
  assert.deepEqual(
    entry.preVerify.results.map((record) => [record.command, record.level, record.result, record.summary, record.tail]),
    [['npm test', 'required', 'fail', 'exit 1', tail]],
  )
})

test('pre-verify: a failed recommended command only informs, and the next advance starts the verifier with it in the prompt', async () => {
  const tail = 'lib/a.mjs\n  3:7  error  Expected blank line before this statement\n'
  const seam = commandSeam({ 'npm run lint': commandRun({ exitCode: 1, tail }) })
  const setup = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })
  const { manifest, driver, pr, entry, agentCalls, prompts } = setup

  await preVerified(setup)

  assert.equal(entry.state, 'ready_claimed')
  assert.deepEqual(agentCalls, [])
  assert.deepEqual(eventsSince(manifest), [
    ...CLAIM_PASSES,
    commandCheckEvent('preVerify', 'npm test', 'required', 'pass', 'exit 0'),
    commandCheckEvent('preVerify', 'npm run lint', 'recommended', 'fail', `exit 1: ${tail.trim()}`),
  ])

  const before = readEvents(manifest).length

  await driver.advance(pr)

  assert.equal(entry.state, 'verifying')
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])
  assert.deepEqual(seam.commands(), ['npm test', 'npm run lint'])
  assert.deepEqual(kindsSince(manifest, before), ['verify-start'])
  assert.ok(prompts[0].includes('\n## Recommended commands that failed\n'), prompts[0])
  assert.ok(prompts[0].includes(`### \`npm run lint\`\n\nexit 1\n\n\`\`\`\n${tail.trim()}\n\`\`\``), prompts[0])
})

test('pre-verify: a command that leaves tracked changes fails, and the worktree goes back to the claimed head', async () => {
  const outcomes = {}
  const seam = commandSeam(outcomes)
  const setup = verifiableDriver({
    gates: gatesWith({ preVerify: { required: ['npm test'] } }),
    runCommand: seam.runCommand,
  })

  const { entry, tools } = setup

  // alignWorktree reads the status first, so the command changes it.
  outcomes['npm test'] = () => {
    tools.answer([
      { tool: 'git', args: 'status --porcelain', stdout: ' M package-lock.json' },
      { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
      { tool: 'git', args: '', stdout: '' },
    ])

    return Promise.resolve(commandRun({ tail: 'tests 12, pass 12\n' }))
  }

  await preVerified(setup)

  const [record] = entry.preVerify.results
  const gitCalls = tools
    .calls()
    .filter((call) => call.tool === 'git')
    .map((call) => call.args.join(' '))

  assert.equal(entry.state, 'needs_fix')
  assert.equal(record.result, 'fail')
  assert.deepEqual(record.changes, ['M package-lock.json'])
  assert.equal(record.summary, 'exit 0, left tracked changes: M package-lock.json')
  assert.ok(entry.fixNote.includes('The driver reset the worktree to that head.'), entry.fixNote)
  assert.ok(
    gitCalls.some((line) => line.endsWith(`reset --quiet --hard ${SHA}`)),
    gitCalls.join('\n'),
  )

  assert.ok(gitCalls.some((line) => line.endsWith('clean -fdq')))
})

test('pre-verify: results are dropped when the state or the claim changed meanwhile, or the job was stopped', async () => {
  const cases = [
    { name: 'state changed', change: (entry) => (entry.state = 'needs_fix') },
    { name: 'claim moved', change: (entry) => (entry.claimedSha = NEW_HEAD) },
    { name: 'stopped', outcome: commandRun({ exitCode: null, signal: 'SIGTERM', stopped: true }) },
  ]

  for (const { name, change = () => {}, outcome = commandRun({ exitCode: 1, tail: 'boom' }) } of cases) {
    const job = deferred()
    const seam = commandSeam({ 'npm test': () => job.promise })
    const { manifest, driver, pr, entry } = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })

    await driver.advance(pr)
    change(entry)

    const state = entry.state

    job.resolve(outcome)
    await waitFor(() => !driver.running.has('A1'), `the job to end (${name})`)

    assert.deepEqual(eventsSince(manifest), CLAIM_PASSES, name)
    assert.equal(entry.preVerify, null, name)
    assert.equal(entry.state, state, name)
    assert.deepEqual(seam.commands(), ['npm test'], name)
  }
})

test('pre-verify: a PR merged while its commands ran is cleaned up, with no result', async () => {
  const job = deferred()
  const seam = commandSeam({ 'npm test': () => job.promise })
  const { manifest, driver, pr, entry, cleaned } = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })

  await driver.advance(pr)
  entry.state = 'merged'
  job.resolve(commandRun({ exitCode: 1 }))
  await waitFor(() => !driver.running.has('A1'), 'the job to end')

  assert.deepEqual(cleaned, ['A1'])
  assert.equal(entry.preVerify, null)
  assert.deepEqual(eventsSince(manifest), CLAIM_PASSES)
})

test('pre-verify: a job that throws logs on-done-error, keeps the PR ready_claimed and backs off', async () => {
  const seam = commandSeam({
    'npm test': () => {
      throw new Error('repo.agentToken agent-token does not exist')
    },
  })

  const setup = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })
  const { manifest, driver, pr, entry } = setup

  await preVerified(setup)

  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.preVerify, null)
  assert.equal(entry.failStreak, 1)
  assert.ok(Date.parse(entry.retryAfter) > Date.now(), entry.retryAfter)
  assert.equal(entry.lastError, 'repo.agentToken agent-token does not exist')
  assert.deepEqual(eventsSince(manifest), [
    ...CLAIM_PASSES,
    { id: 'A1', kind: 'on-done-error', error: 'Error: repo.agentToken agent-token does not exist' },
  ])

  const before = readEvents(manifest).length

  await driver.advance(pr)

  assert.equal(readEvents(manifest).length, before)
  assert.deepEqual(seam.commands(), ['npm test'])
})

test('pre-verify: a pass lives in this driver process only, so another driver on the same rollout runs the commands again', async () => {
  const seam = commandSeam()
  const setup = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })
  const { manifest, gate } = setup

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm test', 'npm run lint'])
  assert.equal(setup.entry.preVerify.sha, SHA)

  const restarted = createDriver(manifest, {
    notify: () => {},
    cleanup: async () => {},
    collectFacts: async () => ({ ...gateFacts(manifest, gate.pr), ...gate.facts }),
    runAgent: () => new Promise(() => {}),
    runCommand: seam.runCommand,
  })

  await preVerified(setup, restarted)

  assert.deepEqual(seam.commands(), ['npm test', 'npm run lint', 'npm test', 'npm run lint'])
  assert.equal(restarted.ledger.prs.A1.state, 'ready_claimed')
})

test('pre-verify: a new head or changed commands run the commands again', async () => {
  const seam = commandSeam()
  const setup = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })
  const { manifest, pr, entry, gate, tools, github } = setup
  const gitDir = join(worktreePath(manifest, pr), '.git-dir')

  await preVerified(setup)

  manifest.gates = gatesWith({ preVerify: { required: ['npm test', 'npm run build'], recommended: ['npm run lint'] } })

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm test', 'npm run lint', 'npm test', 'npm run build', 'npm run lint'])

  entry.claimedSha = NEW_HEAD
  entry.claimedAt = at(5)
  gate.pr = { headRefOid: NEW_HEAD }
  github.answer([prRoute({ head: { sha: NEW_HEAD } }), runsRoute(NEW_HEAD)])
  tools.answer([
    { tool: 'git', args: 'rev-parse --absolute-git-dir', stdout: gitDir },
    { tool: 'git', args: 'rev-parse HEAD', stdout: NEW_HEAD },
    { tool: 'git', args: '', stdout: '' },
  ])

  await preVerified(setup)

  assert.equal(seam.calls.length, 8)
  assert.equal(entry.preVerify.sha, NEW_HEAD)
  assert.equal(entry.state, 'ready_claimed')
})

test('pre-verify: the evidence keeps the whole summary and the end of the output, 300 characters at most', async () => {
  const tail = `${'x'.repeat(1000)}\nthe last line of the output\n`
  const seam = commandSeam({ 'npm test': commandRun({ exitCode: 1, tail }) })
  const setup = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })

  await preVerified(setup)

  const event = eventsSince(setup.manifest).find((item) => item.item === 'npm test')

  assert.equal(event.evidence.length, 300)
  assert.ok(event.evidence.startsWith('exit 1: xxx'), event.evidence)
  assert.ok(event.evidence.endsWith('x\nthe last line of the output'), event.evidence)
})

const READY_GATE = gatesWith({
  ready: { required: ['npm ci'], recommended: ['npm run docs'] },
  preVerify: { required: ['npm test'], recommended: ['npm run lint'] },
})

test('ready: the ready commands run first, required then recommended, before the pre-verify commands, and each event carries its stage', async () => {
  const seam = commandSeam()
  const setup = verifiableDriver({ gates: READY_GATE, runCommand: seam.runCommand })
  const { manifest, driver, pr, entry, agentCalls } = setup

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm ci', 'npm run docs', 'npm test', 'npm run lint'])
  assert.deepEqual(
    entry.preVerify.results.map((record) => [record.command, record.stage, record.level]),
    [
      ['npm ci', 'ready', 'required'],
      ['npm run docs', 'ready', 'recommended'],
      ['npm test', 'preVerify', 'required'],
      ['npm run lint', 'preVerify', 'recommended'],
    ],
  )

  assert.deepEqual(eventsSince(manifest), [
    ...CLAIM_PASSES,
    commandCheckEvent('ready', 'npm ci', 'required', 'pass', 'exit 0'),
    commandCheckEvent('ready', 'npm run docs', 'recommended', 'pass', 'exit 0'),
    commandCheckEvent('preVerify', 'npm test', 'required', 'pass', 'exit 0'),
    commandCheckEvent('preVerify', 'npm run lint', 'recommended', 'pass', 'exit 0'),
  ])

  await driver.advance(pr)

  assert.equal(entry.state, 'verifying')
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])
  assert.equal(seam.calls.length, 4)
})

test('ready: a failed required ready command sends the PR back as a ready check, and no pre-verify command or verifier runs', async () => {
  const tail = 'npm error code ERESOLVE\n'
  const seam = commandSeam({ 'npm ci': commandRun({ exitCode: 1, tail }) })
  const setup = verifiableDriver({ gates: READY_GATE, runCommand: seam.runCommand })
  const { manifest, entry, agentCalls } = setup

  entry.ready = { status: 'READY', headSha: SHA, gates: [] }

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm ci'])
  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'ready check')
  assert.deepEqual(agentCalls, [])
  assert.deepEqual(eventsSince(manifest), [
    ...CLAIM_PASSES,
    commandCheckEvent('ready', 'npm ci', 'required', 'fail', `exit 1: ${tail.trim()}`),
    { id: 'A1', kind: 'needs-fix', reason: 'ready check' },
  ])

  for (const part of [
    'The driver ran the required commands at `a1a1a1a`. These failed:',
    '### `npm ci`\n\nexit 1\n\n```\nnpm error code ERESOLVE\n```',
    'This is a ready command of your self-check (step 7). Your READY report does not list it in `gates`.',
  ]) {
    assert.ok(entry.fixNote.includes(part), part)
  }
})

test('ready: a failed recommended ready command lets the pre-verify commands run, and the verifier sees it', async () => {
  const tail = 'docs/a.html: broken link #gates\n'
  const seam = commandSeam({ 'npm run docs': commandRun({ exitCode: 1, tail }) })
  const setup = verifiableDriver({ gates: READY_GATE, runCommand: seam.runCommand })
  const { manifest, driver, pr, entry, agentCalls, prompts } = setup

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm ci', 'npm run docs', 'npm test', 'npm run lint'])
  assert.equal(entry.state, 'ready_claimed')
  assert.deepEqual(agentCalls, [])
  assert.deepEqual(eventsSince(manifest).slice(CLAIM_PASSES.length + 1, CLAIM_PASSES.length + 2), [
    commandCheckEvent('ready', 'npm run docs', 'recommended', 'fail', `exit 1: ${tail.trim()}`),
  ])

  await driver.advance(pr)

  assert.equal(entry.state, 'verifying')
  assert.deepEqual(agentCalls, [{ id: 'A1', role: 'verify' }])

  const section = prompts[0].indexOf('\n## Recommended commands that failed\n')

  assert.ok(section > -1, prompts[0])
  assert.ok(prompts[0].indexOf(`### \`npm run docs\`\n\nexit 1\n\n\`\`\`\n${tail.trim()}\n\`\`\``, section) > section, prompts[0])
})

test('ready: with ready commands only, the job runs, and the note says the READY report claimed exit 0 for a command that failed', async () => {
  const seam = commandSeam({ 'npm test': commandRun({ exitCode: 1, tail: 'not ok 3 - parses an empty list\n' }) })
  const gates = gatesWith({ ready: { required: ['npm test'] } })
  const setup = verifiableDriver({ gates, runCommand: seam.runCommand })
  const { entry } = setup

  entry.ready = { status: 'READY', headSha: SHA, gates: [{ command: 'npm test', exitCode: 0, tail: 'tests 12, pass 12' }] }

  await preVerified(setup)

  assert.equal(entry.ready.headSha, entry.claimedSha)
  assert.deepEqual(seam.commands(), ['npm test'])
  assert.equal(entry.state, 'needs_fix')
  assert.equal(entry.fixReason, 'ready check')
  assert.ok(entry.fixNote.includes('Your READY report says it exited 0 at this head.'), entry.fixNote)
  assert.ok(entry.fixNote.includes("The driver's run decides."), entry.fixNote)
})

test('ready: a command in both gates.ready.required and gates.preVerify.required runs twice and logs two events', async () => {
  const seam = commandSeam()
  const gates = gatesWith({ ready: { required: ['npm test'] }, preVerify: { required: ['npm test'] } })
  const setup = verifiableDriver({ gates, runCommand: seam.runCommand })

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm test', 'npm test'])
  assert.deepEqual(eventsSince(setup.manifest), [
    ...CLAIM_PASSES,
    commandCheckEvent('ready', 'npm test', 'required', 'pass', 'exit 0'),
    commandCheckEvent('preVerify', 'npm test', 'required', 'pass', 'exit 0'),
  ])
})

test('ready: a change to gates.ready alone runs the commands again on the same head', async () => {
  const seam = commandSeam()
  const setup = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })
  const { manifest, driver, pr, entry, agentCalls } = setup

  await preVerified(setup)

  manifest.gates = gatesWith({ ready: { recommended: ['npm run docs'] }, preVerify: COMMANDS_GATE.preVerify })

  await preVerified(setup)

  assert.deepEqual(seam.commands(), ['npm test', 'npm run lint', 'npm run docs', 'npm test', 'npm run lint'])
  assert.equal(entry.claimedSha, SHA)
  assert.equal(entry.state, 'ready_claimed')
  assert.deepEqual(agentCalls, [])

  await driver.advance(pr)

  assert.equal(seam.calls.length, 5)
  assert.equal(entry.state, 'verifying')
})

// verifiableDriver's fake git once a command left `leftover` in the
// worktree. git reports it until a reset, and the reset cleans the tree.
function leftoverRules(gitDir, leftover) {
  const clean = [
    { tool: 'git', args: 'rev-parse --absolute-git-dir', stdout: gitDir },
    { tool: 'git', args: 'rev-parse HEAD', stdout: SHA },
    { tool: 'git', args: '', stdout: '' },
  ]

  return [
    { tool: 'git', args: 'status --porcelain', stdout: leftover },
    { tool: 'git', args: 'reset --quiet --hard', stdout: '', next: clean },
    ...clean,
  ]
}

function gitLines(tools) {
  return tools
    .calls()
    .filter((call) => call.tool === 'git')
    .map((call) => call.args.join(' '))
}

test('pre-verify: a job that starts saves the cleanup it owes, and a job that ends clears it', async () => {
  const job = deferred()
  const seam = commandSeam({ 'npm test': () => job.promise })
  const { manifest, driver, pr, entry } = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })

  await driver.advance(pr)

  assert.equal(entry.preVerifyCleanup, SHA)
  assert.equal(readLedger(manifest).prs.A1.preVerifyCleanup, SHA)

  job.resolve(commandRun())
  await waitFor(() => !driver.running.has('A1'), 'the job to end')

  assert.equal(entry.preVerifyCleanup, null)
  assert.equal(readLedger(manifest).prs.A1.preVerifyCleanup, null)
})

test('pre-verify: what a stopped job left in the worktree is cleaned before the next driver runs the commands again', async () => {
  const outcomes = {}
  const seam = commandSeam(outcomes)
  const setup = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })
  const { manifest, pr, tools, gate } = setup

  // The first run writes a file and is stopped. The run after it passes.
  outcomes['npm test'] = () => {
    outcomes['npm test'] = commandRun()
    tools.answer(leftoverRules(join(worktreePath(manifest, pr), '.git-dir'), '?? test-output.log'))

    return Promise.resolve(commandRun({ exitCode: null, signal: 'SIGTERM', stopped: true }))
  }

  await preVerified(setup)

  assert.equal(readLedger(manifest).prs.A1.preVerifyCleanup, SHA)

  const restarted = createDriver(manifest, {
    notify: () => {},
    cleanup: async () => {},
    collectFacts: async () => ({ ...gateFacts(manifest, gate.pr), ...gate.facts }),
    runAgent: () => new Promise(() => {}),
    runCommand: seam.runCommand,
  })

  await preVerified(setup, restarted)

  const entry = restarted.ledger.prs.A1

  assert.ok(gitLines(tools).some((line) => line.endsWith(`reset --quiet --hard ${SHA}`)))
  assert.ok(gitLines(tools).some((line) => line.endsWith('clean -fdq')))
  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.preVerifyCleanup, null)
  assert.deepEqual(seam.commands(), ['npm test', 'npm test', 'npm run lint'])
  assert.equal(kindsSince(manifest).includes('needs-fix'), false)
  assert.deepEqual(
    entry.preVerify.results.map((record) => [record.command, record.result]),
    [
      ['npm test', 'pass'],
      ['npm run lint', 'pass'],
    ],
  )
})

test('pre-verify: what a job that threw after a command left is cleaned before the commands run again', async () => {
  const outcomes = {}
  const seam = commandSeam(outcomes)
  const setup = verifiableDriver({ gates: COMMANDS_GATE, runCommand: seam.runCommand })
  const { manifest, pr, entry, tools } = setup
  const leftover = leftoverRules(join(worktreePath(manifest, pr), '.git-dir'), '?? test-output.log')

  // The command writes a file, and git fails once when the driver reads the worktree after it.
  outcomes['npm test'] = () => {
    outcomes['npm test'] = commandRun()
    tools.answer([{ tool: 'git', args: 'status --porcelain', code: 128, stderr: 'fatal: index file corrupt', next: leftover }])

    return Promise.resolve(commandRun())
  }

  await preVerified(setup)

  assert.equal(kindsSince(manifest).at(-1), 'on-done-error')
  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.preVerifyCleanup, SHA)

  entry.retryAfter = null

  await preVerified(setup)

  assert.ok(gitLines(tools).some((line) => line.endsWith(`reset --quiet --hard ${SHA}`)))
  assert.equal(entry.state, 'ready_claimed')
  assert.equal(entry.preVerifyCleanup, null)
  assert.deepEqual(seam.commands(), ['npm test', 'npm test', 'npm run lint'])
  assert.equal(kindsSince(manifest).includes('needs-fix'), false)
})

test('pre-verify: a cleanup owed for a worktree that is gone only clears', async () => {
  const { manifest, driver, tools, github } = tickDriver({
    A1: { ...CLAIMED, state: 'needs_fix', fixReason: 'pre-verify check', preVerifyCleanup: SHA },
  })

  const entry = driver.ledger.prs.A1

  await driver.advance(manifest.prs.find((item) => item.id === 'A1'))

  assert.equal(entry.preVerifyCleanup, null)
  assert.deepEqual(tools.calls(), [])
  assert.deepEqual(github.requests(), [])
})
