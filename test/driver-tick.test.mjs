import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEvents } from '../lib/view.mjs'
import { at, samplePrs } from './fixtures.mjs'
import { MERGE_SHA, FETCH, GREEN_RUNS, prJson, viewRule, tickDriver, eventsSince, kindsSince } from './driver-helpers.mjs'

const FETCH_FAILS = { tool: 'git', args: 'fetch', code: 128, stderr: 'fatal: unable to access the remote' }

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
