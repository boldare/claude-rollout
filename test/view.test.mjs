import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLedger } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { matchKey } from '../lib/review.ts'
import { timeText } from '../lib/sentences.ts'
import { isRunName, parseTranscript, readTranscript, succeeded, transcriptParser } from '../lib/transcript.mjs'
import { runRecords, runsFromEvents, runsFromLedger } from '../lib/runs.mjs'
import {
  commandPreview,
  costs,
  liveness,
  parseEvents,
  prDetail,
  prRows,
  readEvents,
  refusalOf,
  rolloutView,
  rowsMatching,
  runsOf,
} from '../lib/view.mjs'
import {
  REVIEW_MANIFEST,
  START,
  answeredReview,
  at,
  interruptedTranscript,
  jsonLines,
  laterReview,
  makeRollout,
  sampleEvents,
  samplePrs,
  sampleReview,
  sampleTranscript,
} from './fixtures.mjs'

const BIN = fileURLToPath(new URL('../bin/rollout.mjs', import.meta.url))

function start(id, role, run, minute, extra = {}) {
  return { at: at(minute), id, kind: `${role}-start`, run, log: `logs/${run}.jsonl`, effort: 'high', ...extra }
}

function done(id, role, run, minute, extra = {}) {
  return {
    at: at(minute),
    id,
    kind: `${role}-done`,
    run,
    ok: true,
    result: null,
    cost: 1,
    seconds: 60,
    denials: 0,
    stopped: false,
    error: null,
    ...extra,
  }
}

function statuses(runs) {
  return runs.map((run) => `${run.run}:${run.status}`)
}

test('liveness: the lock means running, the heartbeat gives its age and note', () => {
  const dir = makeRollout({ heartbeat: 'tick-error boom' })
  const beat = new Date(START)
  utimesSync(join(dir, 'heartbeat'), beat, beat)

  assert.deepEqual(liveness(loadManifest(dir), START + 42_000), {
    running: true,
    pid: process.pid,
    heartbeatAgeSeconds: 42,
    heartbeatNote: 'tick-error boom',
    tick: null,
  })
})

test('liveness: a measured tick gives its numbers, and the note stays as it is', () => {
  const note = 'tick 4210 requests=7 cached=5 remaining=4870'
  const manifest = loadManifest(makeRollout({ heartbeat: note }))
  const { heartbeatNote, tick } = liveness(manifest)

  assert.equal(heartbeatNote, note)
  assert.deepEqual(tick, { ms: 4210, requests: 7, cached: 5, remaining: 4870 })
  assert.equal(liveness(loadManifest(makeRollout({ heartbeat: 'tick 900 requests=0 cached=0 remaining=-' }))).tick.remaining, null)
})

test('liveness: no lock and no heartbeat', () => {
  const manifest = loadManifest(makeRollout({ lock: false, heartbeat: null }))
  assert.deepEqual(liveness(manifest), { running: false, pid: null, heartbeatAgeSeconds: null, heartbeatNote: '', tick: null })
})

test('parseEvents skips blank lines, partial lines and JSON that is not an object', () => {
  const text = ['{"id":"A1","kind":"held"}', '', '42', 'null', '[1]', '"text"', '{"id":"-","kind":"paused"}', '{"id":"A2","ki'].join('\n')
  assert.deepEqual(
    parseEvents(text).map((event) => event.kind),
    ['held', 'paused'],
  )
})

test('readEvents reads events.jsonl and is empty without it', () => {
  assert.equal(readEvents(loadManifest(makeRollout())).length, 9)
  assert.deepEqual(readEvents(loadManifest(makeRollout({ events: null }))), [])
})

test('runsFromEvents pairs starts and dones by run id, with the model the start names', () => {
  const runs = runsFromEvents([
    start('A1', 'implement', 'A1-01-implement', 0, { model: 'claude-opus-5-5' }),
    start('A2', 'implement', 'A2-01-implement', 1),
    done('A2', 'implement', 'A2-01-implement', 5, { result: 'READY', cost: 2 }),
    done('A1', 'implement', 'A1-01-implement', 9, { result: 'READY', cost: 3, seconds: 540, denials: 2 }),
  ])

  assert.deepEqual(runs[0], {
    run: 'A1-01-implement',
    id: 'A1',
    role: 'implement',
    step: null,
    effort: 'high',
    model: 'claude-opus-5-5',
    startedAt: at(0),
    endedAt: at(9),
    seconds: 540,
    costUsd: 3,
    ok: true,
    result: 'READY',
    error: null,
    denials: 2,
    status: 'ok',
  })

  assert.deepEqual(statuses(runs), ['A1-01-implement:ok', 'A2-01-implement:ok'])
  assert.equal(runs[1].model, null, 'a start from before runs named their model')
})

test('runsFromEvents pairs old events by log name, PR and role', () => {
  const old = (minute) => ({
    at: at(minute),
    id: 'A1',
    kind: 'implement-start',
    effort: 'high',
    resume: false,
    log: 'logs/A1-01-implement.jsonl',
  })

  const runs = runsFromEvents(
    [
      old(0),
      { at: at(4), id: '-', kind: 'driver-start' },
      old(5),
      { at: at(30), id: 'A1', kind: 'implement-done', ok: true, cost: 3, seconds: 1500 },
    ],
    { driverRunning: true },
  )

  assert.deepEqual(statuses(runs), ['A1-01-implement:interrupted', 'A1-01-implement:ok'])
  assert.equal(runs[1].costUsd, 3)
  assert.equal(runs[1].result, null)
  assert.equal(runs[1].denials, 0)
})

test('runsFromEvents: the brief writer and reviewer are two runs', () => {
  const runs = runsFromEvents([
    start('A1', 'brief', 'A1-01-brief-write', 0, { step: 'write' }),
    done('A1', 'brief', 'A1-01-brief-write', 10, { step: 'write', result: 'BRIEF', cost: 1.5 }),
    start('A1', 'brief', 'A1-01-brief-review', 11, { step: 'review' }),
    done('A1', 'brief', 'A1-01-brief-review', 20, { step: 'review', result: 'BRIEF', cost: 2.5 }),
  ])

  assert.deepEqual(
    runs.map((run) => [run.run, run.step, run.costUsd, run.status]),
    [
      ['A1-01-brief-write', 'write', 1.5, 'ok'],
      ['A1-01-brief-review', 'review', 2.5, 'ok'],
    ],
  )
})

test('runsFromEvents: a run without a done is running only while the driver that started it runs', () => {
  const events = [start('A1', 'implement', 'A1-01-implement', 0), start('A2', 'verify', 'A2-02-verify', 1)]
  const restarted = [start('A1', 'fix', 'A1-02-fix', 0), { at: at(1), id: '-', kind: 'driver-start' }, start('A2', 'fix', 'A2-02-fix', 2)]

  assert.deepEqual(statuses(runsFromEvents(events, { driverRunning: true })), ['A1-01-implement:running', 'A2-02-verify:running'])
  assert.deepEqual(statuses(runsFromEvents(events)), ['A1-01-implement:interrupted', 'A2-02-verify:interrupted'])
  assert.deepEqual(statuses(runsFromEvents(restarted, { driverRunning: true })), ['A1-02-fix:interrupted', 'A2-02-fix:running'])
})

test('runsFromEvents: stopped runs are interrupted, other failures failed', () => {
  const runs = runsFromEvents([
    start('A1', 'fix', 'A1-02-fix', 0),
    done('A1', 'fix', 'A1-02-fix', 1, { ok: false, stopped: true, cost: 0, error: 'driver stopping' }),
    start('A2', 'verify', 'A2-02-verify', 2),
    done('A2', 'verify', 'A2-02-verify', 3, { ok: false, error: 'timeout after 60 min' }),
  ])

  assert.deepEqual(statuses(runs), ['A1-02-fix:interrupted', 'A2-02-verify:failed'])
  assert.equal(runs[1].error, 'timeout after 60 min')
  assert.equal(runs[1].ok, false)
})

test('runsFromEvents: a done without a start still counts', () => {
  const runs = runsFromEvents([
    done('A1', 'verify', 'A1-03-verify', 5, { cost: 2 }),
    { at: at(6), id: 'A2', kind: 'fix-done', ok: false, cost: 0.5, seconds: 30 },
  ])

  assert.deepEqual(
    runs.map((run) => [run.run, run.role, run.startedAt, run.endedAt, run.costUsd, run.status]),
    [
      ['A1-03-verify', 'verify', null, at(5), 2, 'ok'],
      [null, 'fix', null, at(6), 0.5, 'failed'],
    ],
  )
})

// Events whose runs all have names of their own, the way a driver with run ids writes them.
function restartedEvents() {
  return [
    start('A1', 'implement', 'A1-01-implement', 0, { model: 'sonnet' }),
    done('A1', 'implement', 'A1-01-implement', 9, { result: 'READY', cost: 3, denials: 2 }),
    start('A1', 'fix', 'A1-02-fix', 10),
    { at: at(11), id: '-', kind: 'driver-start' },
    start('A2', 'brief', 'A2-01-brief-write', 12, { step: 'write' }),
    done('A2', 'brief', 'A2-01-brief-write', 15, { step: 'write', ok: false, stopped: true, cost: 0 }),
    start('A3', 'verify', 'A3-01-verify', 16),
    done('A3', 'verify', 'A3-01-verify', 18, { ok: false, error: 'timeout after 60 min' }),
    start('A3', 'delegate', 'A3-02-delegate', 19),
    done('A1', 'verify', 'A1-03-verify', 20, { cost: 2 }),
  ]
}

test('runsFromLedger gives back what runsFromEvents gives, from the records runRecords makes', () => {
  const sample = parseEvents(jsonLines(sampleEvents()))

  for (const events of [sample, restartedEvents()]) {
    for (const driverRunning of [true, false]) {
      const options = { driverRunning }

      assert.deepEqual(
        runsFromLedger({ runs: runRecords(events, options) }, options),
        runsFromEvents(events, options),
        String(driverRunning),
      )
    }
  }

  assert.deepEqual(statuses(runsFromLedger({ runs: runRecords(restartedEvents(), { driverRunning: true }) }, { driverRunning: true })), [
    'A1-01-implement:ok',
    'A1-02-fix:interrupted',
    'A2-01-brief-write:interrupted',
    'A3-01-verify:failed',
    'A3-02-delegate:running',
    'A1-03-verify:ok',
  ])
})

test('runRecords: the record of each named run, the later of two with one name, and none for a run without a name', () => {
  const records = runRecords([
    { at: at(0), id: 'A1', kind: 'implement-start', effort: 'high', log: 'logs/A1-01-implement.jsonl' },
    { at: at(1), id: 'A1', kind: 'implement-done', ok: false, cost: 0.5 },
    start('A2', 'verify', 'A2-01-verify', 2, { model: 'opus' }),
    { at: at(3), id: 'A1', kind: 'implement-start', effort: 'xhigh', log: 'logs/A1-01-implement.jsonl' },
    { at: at(4), id: 'A3', kind: 'fix-done', ok: true, cost: 1 },
    { at: at(5), id: 'A3', kind: 'verify-start' },
  ])

  assert.deepEqual(Object.keys(records), ['A2-01-verify', 'A1-01-implement'])
  assert.equal(records['A1-01-implement'].effort, 'xhigh')
  assert.deepEqual(records['A2-01-verify'], {
    id: 'A2',
    role: 'verify',
    step: null,
    reason: null,
    startedAt: at(2),
    endedAt: null,
    effort: 'high',
    model: null,
    requestedModel: 'opus',
    resume: null,
    log: 'logs/A2-01-verify.jsonl',
    ok: null,
    result: null,
    costUsd: null,
    seconds: null,
    awakeSeconds: null,
    denials: null,
    stopped: true,
    error: null,
  })
})

test('runsOf reads the runs of a version 2 ledger from the ledger, and those of an older one from the events', () => {
  const events = [start('A1', 'fix', 'A1-02-fix', 0)]
  const runs = runRecords([start('A2', 'verify', 'A2-01-verify', 1)])

  assert.deepEqual(statuses(runsOf({ version: 2, prs: {}, runs }, events, { driverRunning: true })), ['A2-01-verify:interrupted'])
  assert.deepEqual(statuses(runsOf({ prs: {}, runs }, events, { driverRunning: true })), ['A1-02-fix:running'])
  assert.deepEqual(statuses(runsOf({ version: 2, prs: {} }, events)), [])
})

test('costs: PR totals from the ledger, roles and a cumulative line from runs', () => {
  const manifest = loadManifest(makeRollout())
  const runs = runsFromEvents([
    start('A1', 'implement', 'A1-01-implement', 0),
    done('A1', 'implement', 'A1-01-implement', 60, { cost: 4.25 }),
    start('A2', 'brief', 'A2-01-brief-write', 1, { step: 'write' }),
    done('A2', 'brief', 'A2-01-brief-write', 20, { cost: 0.1 }),
    start('A2', 'brief', 'A2-01-brief-review', 21, { step: 'review' }),
    done('A2', 'brief', 'A2-01-brief-review', 30, { cost: 0.2 }),
    start('A1', 'verify', 'A1-02-verify', 61),
  ])

  assert.deepEqual(costs(manifest, { prs: { A1: { costUsd: 4.25 }, A2: { costUsd: 0.3 } } }, runs), {
    totalUsd: 4.55,
    byPr: { A1: 4.25, A2: 0.3, A3: 0 },
    byRole: { brief: 0.3, implement: 4.25, fix: 0, verify: 0, delegate: 0 },
    overTime: [
      { at: at(20), totalUsd: 0.1 },
      { at: at(30), totalUsd: 0.3 },
      { at: at(60), totalUsd: 4.55 },
    ],
  })
})

test('delegate runs: start and done pair into one run, its cost goes to the delegate, and prDetail reads its answers', () => {
  const manifest = loadManifest(makeRollout({ policy: { delegate: {} } }))
  const runs = runsFromEvents([
    start('A1', 'delegate', 'A1-01-delegate', 0, { blocked: 'needs-decision' }),
    done('A1', 'delegate', 'A1-01-delegate', 5, { cost: 0.75, result: 'ANSWER' }),
  ])

  const answers = [
    {
      at: at(5),
      kind: 'needs-decision',
      question: 'Keep the old flag?',
      decision: 'answer',
      answer: 'Keep it as an alias.',
      planRefs: ['Decisions'],
      reasoning: 'The plan keeps it.',
      run: 'A1-01-delegate',
    },
  ]

  const ledger = { prs: { A1: { costUsd: 0.75, delegate: { runs: 1, lastQuestion: 'abc', limitNotified: false, answers } } } }

  assert.deepEqual(
    runs.map((run) => [run.run, run.role, run.startedAt, run.endedAt, run.status, run.result, run.costUsd]),
    [['A1-01-delegate', 'delegate', at(0), at(5), 'ok', 'ANSWER', 0.75]],
  )

  assert.equal(costs(manifest, ledger, runs).byRole.delegate, 0.75)
  assert.deepEqual(prDetail(manifest, ledger, [], runs, 'A1').delegate, { maxPerPr: 2, runs: 1, answers })
  assert.deepEqual(prDetail(loadManifest(makeRollout()), { prs: {} }, [], [], 'A1').delegate, { maxPerPr: null, runs: 0, answers: [] })
})

test('prRows: a held PR waits for its release, and a PR missing from the ledger is fresh', () => {
  const now = START + 100 * 60_000
  const view = rolloutView(loadManifest(makeRollout()), now)
  const [first, second, third] = view.rows

  assert.deepEqual(first.status, {
    stage: 'merge',
    kind: 'waiting',
    code: 'held',
    sentence: 'held since 2026-09-01 11:21 UTC by maintainer',
    since: at(82),
    wayOut: { kind: 'release', text: 'rollout release A1' },
    marker: null,
    question: null,
  })

  assert.equal(first.head, 'a1a1a1a')
  assert.equal(first.url, 'https://github.com/example/widgets/pull/11')
  assert.equal(first.lastEventAt, at(81))
  assert.equal(first.gate.mergeState, 'CLEAN')
  assert.equal(second.activeRun, 'A2-01-implement')
  assert.deepEqual(second.deps, [{ id: 'A1', stage: 'merge' }])
  assert.deepEqual(third, {
    id: 'A3',
    title: 'feat: A3',
    branch: 'feat/a3',
    status: {
      stage: 'brief',
      kind: 'waiting',
      code: 'slot',
      sentence: 'waits for a free slot',
      since: new Date(now).toISOString(),
      wayOut: null,
      marker: null,
      question: null,
    },
    effects: {
      retry: { applies: true, lines: ['brief · waiting: slot', 'after retry: brief · waiting: slot'] },
      note: { applies: true, lines: ['brief · waiting: slot', 'after note: queued, the next writing agent reads it'] },
    },
    hold: null,
    pr: null,
    url: null,
    head: '-',
    deps: [],
    attempts: { implement: 0, fix: 0, verify: 0, brief: 0 },
    costUsd: 0,
    lastEventAt: null,
    activeRun: null,
    gate: null,
    waiting: null,
    answered: null,
  })
})

test('prRows: a legacy, a filled and a raw ledger give the same stage and status on read, and none of them is written', () => {
  const prs = {
    A1: { state: 'verified', pr: 11, verified: { sha: 'a1a1a1a', at: at(80) }, approved: null, gate: null },
    A2: { state: 'blocked', blocked: { kind: 'needs-decision', question: 'Which API?', evidence: 'Both exist.' } },
    A3: { state: 'escalated', escalation: 'repeated errors', lastError: 'gh failed' },
  }

  const now = START + 100 * 60_000

  for (const legacy of [true, false]) {
    const manifest = loadManifest(makeRollout({ legacy, prs, events: [] }))
    const file = join(manifest.dir, 'ledger.json')
    const before = readFileSync(file, 'utf8')
    const ledger = readLedger(manifest)
    const stored = structuredClone(ledger)
    const rows = prRows(manifest, ledger, [], [], { running: true, stoppedAt: null, now })

    assert.deepEqual(
      rows.map((row) => [row.status.stage, row.status.kind, row.status.code, row.status.sentence]),
      [
        ['merge', 'waiting', 'gate-pending', 'verified, the merge gate has not checked it yet'],
        ['implement', 'needs-you', 'decision', 'the implementer asks: Which API?'],
        ['brief', 'needs-you', 'errors', 'repeated errors: gh failed'],
      ],
      `legacy: ${legacy}`,
    )

    assert.deepEqual(ledger, stored, 'the ledger object stays as read')
    assert.equal(readFileSync(file, 'utf8'), before, 'the file stays as written')
  }

  const raw = prRows(loadManifest(makeRollout()), { prs }, [], [])

  assert.equal(raw[1].status.code, 'decision')
  assert.equal(prs.A2.stage, undefined, 'a raw ledger passed in stays as it is')
})

test('prRows: the marker shows the hold of a running or needs-you PR, the rollout hold before its own', () => {
  const own = { at: at(7), by: 'maintainer', reason: 'checking' }
  const rollout = { at: at(8), by: 'driver', reason: 'usage limit reached' }
  const entry = (stage, status) => ({ stage, status: { since: at(5), ...status }, hold: own })
  const ledger = {
    version: 3,
    prs: {
      A1: entry('implement', { kind: 'running', code: 'implement', run: 'A1-01-implement' }),
      A2: entry('merge', { kind: 'needs-you', code: 'approve' }),
      A3: entry('brief', { kind: 'waiting', code: 'held', scope: 'pr' }),
    },
  }

  const manifest = loadManifest(makeRollout())
  const markers = (hold) => prRows(manifest, { ...ledger, hold }, [], []).map((row) => row.status.marker)

  assert.deepEqual(markers(null), [{ scope: 'pr', ...own }, { scope: 'pr', ...own }, null])
  assert.deepEqual(markers(rollout), [{ scope: 'rollout', ...rollout }, { scope: 'rollout', ...rollout }, null])
  assert.equal(prRows(manifest, ledger, [], [])[2].status.sentence, 'held since 2026-09-01 10:07 UTC by maintainer: checking')
})

test('prRows: an approval waits for you, from the time of its status, asked by the driver', () => {
  const manifest = loadManifest(makeRollout())
  const a1 = { stage: 'merge', status: { kind: 'needs-you', code: 'approve', since: at(40) }, pr: 11, hold: null }
  const [row] = prRows(manifest, { version: 3, prs: { A1: a1 } }, [], [])

  assert.deepEqual(row.waiting, { since: at(40), run: null, byDriver: true, lastError: null, delegate: null })
  assert.deepEqual(row.status.wayOut, { kind: 'approve', text: 'rollout approve A1' })
})

test('prRows: with no driver running, a running status shows as driver-stopped since the last heartbeat', () => {
  const manifest = loadManifest(makeRollout())
  const stoppedAt = at(90)
  const rows = prRows(manifest, readLedger(manifest), [], [], { running: false, stoppedAt, now: START })
  const [, a2] = rows

  assert.deepEqual(
    [a2.status.stage, a2.status.kind, a2.status.code, a2.status.since],
    ['implement', 'waiting', 'driver-stopped', stoppedAt],
  )

  assert.equal(a2.status.sentence, 'the driver is not running')
  assert.equal(rows[0].status.code, 'held', 'a waiting status stays')

  const never = prRows(manifest, readLedger(manifest), [], [], { running: false, stoppedAt: null, now: START })[1]

  assert.equal(never.status.since, readLedger(manifest).prs.A2.status.since, 'no heartbeat keeps the stored time')
})

test('rowsMatching: by stage, by needs you, and by both', () => {
  const row = (id, stage, kind) => ({ id, status: { stage, kind } })
  const rows = [
    row('A1', 'merge', 'needs-you'),
    row('A2', 'merge', 'waiting'),
    row('A3', 'implement', 'needs-you'),
    row('A4', 'merged', null),
  ]

  const ids = (filters) => rowsMatching(rows, filters).map((item) => item.id)

  assert.deepEqual(ids({}), ['A1', 'A2', 'A3', 'A4'])
  assert.deepEqual(ids({ stage: 'merge' }), ['A1', 'A2'])
  assert.deepEqual(ids({ needsYou: true }), ['A1', 'A3'])
  assert.deepEqual(ids({ stage: 'merge', needsYou: true }), ['A1'])
  assert.deepEqual(ids({ stage: 'merged' }), ['A4'])
})

test('prRows: a PR that needs you says since when, which run asked and what the delegate did', () => {
  const manifest = loadManifest(makeRollout({ policy: { delegate: { kinds: ['needs-decision'], maxPerPr: 2 } } }))
  const now = START + 100 * 60_000
  const question = 'Should a hook that throws stop the run?'
  const events = [
    start('A1', 'implement', 'A1-01-implement', 0),
    done('A1', 'implement', 'A1-01-implement', 30, { result: 'BLOCKED' }),
    { at: at(30), id: 'A1', kind: 'blocked', reason: 'needs-decision' },
    start('A1', 'delegate', 'A1-02-delegate', 31),
    done('A1', 'delegate', 'A1-02-delegate', 35),
    start('A2', 'verify', 'A2-01-verify', 0),
    done('A2', 'verify', 'A2-01-verify', 10, { result: 'PASS' }),
    { at: at(12), id: 'A2', kind: 'blocked', reason: 'gate' },
    start('A3', 'fix', 'A3-03-fix', 40),
    done('A3', 'fix', 'A3-03-fix', 50, { result: 'READY' }),
    { at: at(51), id: 'A3', kind: 'escalated', role: 'fix' },
  ]

  const runs = runsFromEvents(events)
  const escalate = {
    at: at(35),
    kind: 'needs-decision',
    question,
    decision: 'escalate',
    reasoning: '  the plan does not decide ',
    run: 'A1-02-delegate',
  }

  const prs = (a1) => ({
    A1: { state: 'blocked', blocked: { kind: 'needs-decision', question, evidence: 'Two sections disagree.' }, ...a1 },
    A2: { state: 'blocked', blocked: { kind: 'gate', question: 'a check failed', evidence: '' } },
    A3: { state: 'escalated', escalation: 'fix attempts exhausted', lastError: 'fix attempts exhausted (3)' },
  })

  const waiting = (ledgerPrs, id, eventList = events, runList = runs) =>
    prRows(manifest, { prs: ledgerPrs }, eventList, runList, { running: true, stoppedAt: null, now }).find((row) => row.id === id).waiting

  assert.deepEqual(waiting(prs({ delegate: { runs: 1, answers: [escalate] } }), 'A1'), {
    since: at(30),
    run: 'A1-01-implement',
    byDriver: false,
    lastError: null,
    delegate: { state: 'escalate', reason: 'the plan does not decide' },
  })

  const delegateOf = (a1, runList = runs) => waiting(prs(a1), 'A1', events, runList).delegate

  assert.deepEqual(delegateOf({ delegate: { runs: 0, answers: [] } }), { state: 'next', reason: '' })
  assert.deepEqual(delegateOf({ delegate: { runs: 2, answers: [] } }), { state: 'spent', reason: '2 of 2 runs' })
  assert.deepEqual(delegateOf({ delegate: { runs: 1, answers: [{ ...escalate, question: 'an older one' }] } }), {
    state: 'next',
    reason: '',
  })

  assert.deepEqual(delegateOf({ delegate: { runs: 1, answers: [] } }, runsFromEvents(events.slice(0, 4), { driverRunning: true })), {
    state: 'running',
    reason: '',
  })

  // The gate's block is the driver's own: it waits since its status began, which the migration of a raw ledger sets to now.
  assert.deepEqual(waiting(prs({}), 'A2'), {
    since: new Date(now).toISOString(),
    run: null,
    byDriver: true,
    lastError: null,
    delegate: { state: 'skips', reason: '' },
  })

  assert.deepEqual(waiting(prs({}), 'A3'), {
    since: at(51),
    run: 'A3-03-fix',
    byDriver: false,
    lastError: 'fix attempts exhausted (3)',
    delegate: null,
  })

  assert.equal(waiting(prs({}), 'A1', [], []).since, new Date(now).toISOString())
  assert.equal(prRows(loadManifest(makeRollout()), { prs: prs({}) }, events, runs)[0].waiting.delegate, null, 'no delegate policy')
})

test('prRows: the delegate does not run next while a note is pending', () => {
  const manifest = loadManifest(makeRollout({ policy: { delegate: { kinds: ['needs-decision'], maxPerPr: 2 } } }))
  const a1 = {
    state: 'blocked',
    blocked: { kind: 'needs-decision', question: 'Keep the old flag?', evidence: '' },
    delegate: { runs: 0, answers: [] },
  }

  const delegateOf = (entry) => prRows(manifest, { prs: { A1: entry } }, [], []).find((row) => row.id === 'A1').waiting.delegate

  assert.deepEqual(delegateOf({ ...a1, pendingNote: 'Wait for me.' }), { state: 'skips', reason: '' })
  assert.deepEqual(delegateOf(a1), { state: 'next', reason: '' })
})

test('prRows follows the manifest order, and a merged PR has a stage and a sentence only', () => {
  const manifest = loadManifest(makeRollout())
  const ledger = {
    prs: {
      A1: { state: 'merged', mergeSha: 'feedface00', attempts: {} },
      A2: { state: 'blocked', blocked: { kind: 'brief-questions', question: 'Which API?' } },
      A3: { state: 'needs_fix', fixReason: 'CI is red', gate: { action: 'fix', reasons: ['x'] } },
    },
  }

  const rows = prRows(manifest, ledger, [], [])

  assert.deepEqual(
    rows.map((row) => [row.id, row.status.stage, row.status.code, row.status.sentence]),
    [
      ['A1', 'merged', null, 'merged as feedfac'],
      ['A2', 'brief', 'brief-questions', 'the brief needs your answer: Which API?'],
      ['A3', 'implement', 'slot', 'waits for a free slot'],
    ],
  )

  assert.deepEqual(rows[0].status, {
    stage: 'merged',
    kind: null,
    code: null,
    sentence: 'merged as feedfac',
    since: null,
    wayOut: null,
    marker: null,
    question: null,
  })

  assert.equal(prRows(manifest, { prs: { A1: { state: 'merged' } } }, [], [])[0].status.sentence, 'merged')
  assert.deepEqual(prDetail(manifest, ledger, [], [], 'A3').fix.reason, 'ci-red')
})

test('prRows: the question only while the status asks one', () => {
  const manifest = loadManifest(makeRollout())
  const blocked = { kind: 'needs-decision', question: 'Which API?', evidence: 'Both exist.' }
  const ledger = {
    prs: {
      A1: { state: 'blocked', blocked },
      A2: { state: 'needs_fix', blocked },
      A3: { state: 'blocked', blocked: { kind: 'brief-questions' } },
    },
  }

  assert.deepEqual(
    prRows(manifest, ledger, [], []).map((row) => row.status.question),
    [{ kind: 'needs-decision', text: 'Which API?', evidence: 'Both exist.' }, null, { kind: 'brief-questions', text: '', evidence: '' }],
  )
})

function answeredRow(entry, events, driverRunning = true) {
  const runs = runsFromEvents(events, { driverRunning })
  const ledger = { prs: { A1: entry } }

  return prRows(loadManifest(makeRollout()), ledger, [], runs)[0].answered
}

function answeredEntry(state, note = {}) {
  return {
    state,
    noteHistory: [{ at: at(10), by: 'maintainer', kind: 'needs-decision', question: 'Which API?', text: 'the old one', ...note }],
  }
}

test('prRows: answered without a run after the answer', () => {
  assert.deepEqual(answeredRow(answeredEntry('needs_fix'), []), { at: at(10), by: 'maintainer', run: null, role: null })
})

test('prRows: answered names the fix or brief run that picked the answer up while it runs', () => {
  assert.deepEqual(answeredRow(answeredEntry('fixing'), [start('A1', 'fix', 'A1-02-fix', 11)]), {
    at: at(10),
    by: 'maintainer',
    run: 'A1-02-fix',
    role: 'fix',
  })

  assert.deepEqual(answeredRow(answeredEntry('briefing', { kind: 'brief-questions' }), [start('A1', 'brief', 'A1-02-brief-write', 10)]), {
    at: at(10),
    by: 'maintainer',
    run: 'A1-02-brief-write',
    role: 'brief',
  })
})

test('prRows: answered is null once the run that picked it up ended', () => {
  const events = [start('A1', 'fix', 'A1-02-fix', 11), done('A1', 'fix', 'A1-02-fix', 20)]

  assert.equal(answeredRow(answeredEntry('verifying'), events), null)
})

test('prRows: answered skips runs from before the answer, delegate runs and verify runs', () => {
  const events = [
    start('A1', 'implement', 'A1-01-implement', 5),
    start('A1', 'delegate', 'A1-02-delegate', 11),
    start('A1', 'verify', 'A1-03-verify', 12),
  ]

  assert.deepEqual(answeredRow(answeredEntry('needs_fix'), events), { at: at(10), by: 'maintainer', run: null, role: null })
})

test('prRows: answered is null for a plain note and for a PR blocked again, escalated or merged', () => {
  assert.equal(answeredRow(answeredEntry('needs_fix', { kind: null, question: null }), []), null)

  for (const state of ['blocked', 'escalated', 'merged']) {
    assert.equal(answeredRow(answeredEntry(state), []), null, state)
  }
})

test("prRows: answered names the delegate when the delegate's answer applied", () => {
  assert.deepEqual(answeredRow(answeredEntry('needs_fix', { by: 'delegate' }), []), { at: at(10), by: 'delegate', run: null, role: null })
})

test('prRows: a stamped note names the run it went into, where the heuristic picks another', () => {
  const events = [start('A1', 'fix', 'A1-02-fix', 11), done('A1', 'fix', 'A1-02-fix', 12), start('A1', 'fix', 'A1-03-fix', 13)]
  const waits = { at: at(10), by: 'maintainer', run: null, role: null }

  assert.equal(answeredRow(answeredEntry('fixing'), events), null, 'the heuristic takes the first run after the note, which ended')
  assert.deepEqual(answeredRow(answeredEntry('fixing', { run: 'A1-03-fix' }), events), { ...waits, run: 'A1-03-fix', role: 'fix' })
  assert.deepEqual(answeredRow(answeredEntry('fixing', { run: null }), events), waits)
  assert.equal(answeredRow(answeredEntry('verifying', { run: 'A1-02-fix' }), events), null)

  const nameless = [{ at: at(12), id: 'A1', kind: 'fix-done', ok: true, cost: 1 }]

  assert.deepEqual(answeredRow(answeredEntry('needs_fix', { run: null }), nameless), waits, 'null names no run')
})

test('prRows: a stamped block or escalation names its run and time, where the heuristic picks others', () => {
  const manifest = loadManifest(makeRollout())
  const events = [
    start('A1', 'implement', 'A1-01-implement', 0),
    done('A1', 'implement', 'A1-01-implement', 5, { result: 'BLOCKED' }),
    start('A1', 'fix', 'A1-02-fix', 6),
    done('A1', 'fix', 'A1-02-fix', 20, { result: 'READY' }),
    { at: at(21), id: 'A1', kind: 'blocked', reason: 'needs-decision' },
    start('A3', 'verify', 'A3-02-verify', 30),
    done('A3', 'verify', 'A3-02-verify', 40, { result: 'FAIL' }),
    start('A3', 'fix', 'A3-03-fix', 41),
    done('A3', 'fix', 'A3-03-fix', 50, { result: 'READY' }),
    { at: at(51), id: 'A3', kind: 'escalated', role: 'fix' },
  ]

  const runs = runsFromEvents(events)
  const blocked = { kind: 'needs-decision', question: 'Which API?', evidence: '' }
  const escalated = { state: 'escalated', escalation: 'disputed finding', lastError: 'F2 is open' }
  const asked = (entry, id) => {
    const { since, run, byDriver } = prRows(manifest, { prs: { [id]: entry } }, events, runs).find((row) => row.id === id).waiting

    return { since, run, byDriver }
  }

  assert.deepEqual(asked({ state: 'blocked', blocked }, 'A1'), { since: at(21), run: 'A1-02-fix', byDriver: false })
  assert.deepEqual(asked({ state: 'blocked', blocked: { ...blocked, run: 'A1-01-implement' } }, 'A1'), {
    since: at(21),
    run: 'A1-01-implement',
    byDriver: false,
  })

  assert.deepEqual(asked({ state: 'blocked', blocked: { ...blocked, run: null } }, 'A1'), { since: at(21), run: null, byDriver: true })

  assert.deepEqual(asked(escalated, 'A3'), { since: at(51), run: 'A3-03-fix', byDriver: false })
  assert.deepEqual(asked({ ...escalated, escalatedAt: at(40), escalationRun: 'A3-02-verify' }, 'A3'), {
    since: at(40),
    run: 'A3-02-verify',
    byDriver: false,
  })

  assert.deepEqual(asked({ ...escalated, escalatedAt: at(40), escalationRun: null }, 'A3'), { since: at(40), run: null, byDriver: false })

  const detail = prDetail(
    manifest,
    { prs: { A3: { ...escalated, escalatedAt: at(40), escalationRun: 'A3-02-verify' } } },
    events,
    runs,
    'A3',
  )

  assert.deepEqual(detail.waiting, {
    since: at(40),
    run: 'A3-02-verify',
    byDriver: false,
    lastError: 'F2 is open',
    delegate: null,
  })

  assert.deepEqual([detail.escalationRun, detail.noteHistory], ['A3-02-verify', []])
})

test('prDetail on a ledger from before version 2: the runs from the events, answered and waiting from the heuristic', () => {
  const note = { at: at(10), by: 'maintainer', kind: 'needs-decision', question: 'Which API?', text: 'the old one' }
  const prs = {
    A1: { state: 'blocked', blocked: { kind: 'needs-decision', question: 'Which API?', evidence: '' } },
    A2: { state: 'fixing', noteHistory: [note] },
    A3: { state: 'escalated', escalation: 'fix attempts exhausted', lastError: 'fix attempts exhausted (3)' },
  }

  const events = [
    start('A1', 'implement', 'A1-01-implement', 0),
    done('A1', 'implement', 'A1-01-implement', 30, { result: 'BLOCKED' }),
    { at: at(30), id: 'A1', kind: 'blocked', reason: 'needs-decision' },
    start('A2', 'fix', 'A2-02-fix', 12),
    start('A3', 'fix', 'A3-03-fix', 40),
    done('A3', 'fix', 'A3-03-fix', 50, { result: 'READY' }),
    { at: at(51), id: 'A3', kind: 'escalated', role: 'fix' },
  ]

  const manifest = loadManifest(makeRollout({ legacy: true, prs, events }))
  const ledger = readLedger(manifest)
  const runs = runsOf(ledger, readEvents(manifest), { driverRunning: true })
  const detail = (id) => prDetail(manifest, ledger, readEvents(manifest), runs, id)

  assert.equal(ledger.version, undefined)
  assert.equal(ledger.runs, undefined)
  assert.deepEqual(statuses(runs), ['A1-01-implement:ok', 'A2-02-fix:running', 'A3-03-fix:ok'])
  assert.deepEqual(detail('A1').waiting, {
    since: at(30),
    run: 'A1-01-implement',
    byDriver: false,
    lastError: null,
    delegate: null,
  })

  assert.deepEqual(detail('A2').answered, { at: at(10), by: 'maintainer', run: 'A2-02-fix', role: 'fix' })
  assert.deepEqual(detail('A2').noteHistory, [note])
  assert.deepEqual(detail('A3').waiting, {
    since: at(51),
    run: 'A3-03-fix',
    byDriver: false,
    lastError: 'fix attempts exhausted (3)',
    delegate: null,
  })

  assert.equal(detail('A3').escalationRun, 'A3-03-fix')
})

test('prDetail: the merge commit, the fix reason and the last error, for the overview', () => {
  const manifest = loadManifest(makeRollout())
  const ledger = {
    prs: {
      A1: { state: 'merged', mergeSha: 'feedface00' },
      A2: { state: 'fixing', fixReason: 'CI is red' },
      A3: { state: 'escalated', lastError: 'gh pr create failed' },
    },
  }

  const pick = (id) => {
    const { mergeSha, fixReason, lastError } = prDetail(manifest, ledger, [], [], id)

    return { mergeSha, fixReason, lastError }
  }

  assert.deepEqual(pick('A1'), { mergeSha: 'feedface00', fixReason: null, lastError: null })
  assert.deepEqual(pick('A2'), { mergeSha: null, fixReason: 'CI is red', lastError: null })
  assert.deepEqual(pick('A3'), { mergeSha: null, fixReason: null, lastError: 'gh pr create failed' })
})

test('prDetail: verdicts fall back to the latest verdict for old ledgers', () => {
  const manifest = loadManifest(makeRollout())
  const verdict = { verdict: 'PASS', sha: 'abc', summary: 'ok' }
  const history = [{ verdict: 'FAIL' }, verdict]
  const verdicts = (state) => prDetail(manifest, { prs: { A1: state } }, [], [], 'A1').verdicts

  assert.deepEqual(verdicts({ verdict }), [verdict])
  assert.deepEqual(verdicts({ verdict, verdicts: [] }), [verdict])
  assert.deepEqual(verdicts({ verdict, verdicts: history }), history)
  assert.deepEqual(verdicts({}), [])
  assert.equal(prDetail(manifest, { prs: {} }, [], [], 'Z9'), null)
})

test('prDetail: approval channel, brief paths, feedback and runs', () => {
  const dir = makeRollout()
  const manifest = loadManifest(dir)
  const onGitHub = { ...manifest, policy: { ...manifest.policy, approval: 'github' }, repo: { ...manifest.repo, maintainers: ['maint'] } }
  const feedback = [{ id: 'c1', body: 'rename this', action: 'renamed', sha: 'abc', at: at(90) }]
  const ledger = { prs: { A1: { author: 'demo-bot', feedbackHandled: feedback }, A2: { author: 'maint' } } }
  const runs = runsFromEvents([start('A1', 'implement', 'A1-01-implement', 0), start('A2', 'implement', 'A2-01-implement', 1)])

  mkdirSync(join(dir, 'briefs'))
  writeFileSync(join(dir, 'briefs', 'A1.md'), '# A1\n')

  const detail = prDetail(onGitHub, ledger, [], runs, 'A1')
  assert.equal(detail.approval, 'github')
  assert.deepEqual(detail.maintainers, ['maint'])
  assert.deepEqual(detail.brief, {
    path: join(dir, 'briefs', 'A1.md'),
    exists: true,
    notesPath: join(dir, 'briefs', 'A1.review-notes.md'),
    notesExist: false,
  })

  assert.deepEqual(detail.feedback, feedback)
  assert.deepEqual(
    detail.runs.map((run) => run.run),
    ['A1-01-implement'],
  )

  assert.equal(prDetail(onGitHub, ledger, [], runs, 'A2').approval, 'inbox')
  assert.equal(prDetail(onGitHub, ledger, [], runs, 'A3').approval, 'github')
  assert.equal(prDetail(manifest, ledger, [], runs, 'A1').approval, 'inbox')
  assert.equal(prDetail(manifest, ledger, [], runs, 'A1').merge, 'human')

  for (const merge of ['manual', 'auto']) {
    for (const variant of [manifest, onGitHub]) {
      const variantDetail = prDetail({ ...variant, policy: { ...variant.policy, merge } }, ledger, [], runs, 'A1')

      assert.equal(variantDetail.approval, null, merge)
      assert.equal(variantDetail.merge, merge)
    }
  }
})

test('parseTranscript: text, tool calls, results, refusals and the final report', () => {
  const { items, final } = parseTranscript(jsonLines([...sampleTranscript(), '{"type":"assis']))

  assert.deepEqual(items, [
    { kind: 'init', model: 'opus', sessionId: 'session-1' },
    { kind: 'text', text: 'Reading the brief.' },
    { kind: 'tool', id: 'tool-1', name: 'Bash', input: { command: 'npm test' }, command: 'npm test' },
    { kind: 'tool-result', toolUseId: 'tool-1', text: 'tests 12, pass 12', isError: false, refused: false },
    { kind: 'tool', id: 'tool-2', name: 'Bash', input: { command: 'gh pr merge 11' }, command: 'gh pr merge 11' },
    { kind: 'tool', id: 'tool-3', name: 'Read', input: { file_path: 'README.md' }, command: null },
    { kind: 'tool-result', toolUseId: 'tool-2', text: 'rollout guard: the driver merges PRs', isError: true, refused: true },
    { kind: 'tool-result', toolUseId: 'tool-3', text: 'line one\n[image]\nline two', isError: false, refused: false },
  ])

  assert.deepEqual(final, {
    ok: true,
    subtype: 'success',
    costUsd: 4.25,
    seconds: 2340,
    turns: 31,
    denials: 1,
    report: { status: 'READY', pr: 11, headSha: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' },
    text: 'Done.',
  })
})

test('parseTranscript: the init model and no usage for a log without it', () => {
  const { model, usage } = parseTranscript(jsonLines(sampleTranscript()))

  assert.equal(model, 'opus')
  assert.deepEqual(usage, {})
  assert.deepEqual(parseTranscript(''), { items: [], final: null, model: null, usage: {} })
})

test('parseTranscript: usage per model, deduplicated by message, with the output estimated', () => {
  const { final, model, usage } = parseTranscript(jsonLines(interruptedTranscript()))

  assert.equal(final, null)
  assert.equal(model, 'claude-opus-5-5')
  assert.deepEqual(usage, {
    'claude-opus-5-5': { input: 100000, cacheRead: 1000000, cacheWrite5m: 0, cacheWrite1h: 200000, output: 20000 },
    'claude-haiku-4-5-20251001': { input: 10000, cacheRead: 0, cacheWrite5m: 40000, cacheWrite1h: 0, output: 2000 },
  })
})

test('parseTranscript: messages without a model or an id, and thinking without an init', () => {
  const assistant = (message) => ({ type: 'assistant', message: { content: [], ...message } })
  const lines = [
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens_delta: 50 },
    assistant({ model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } }),
    assistant({ model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } }),
    assistant({ usage: { input_tokens: 7 } }),
  ]

  assert.deepEqual(parseTranscript(jsonLines(lines)).usage, {
    'claude-sonnet-5': { input: 20, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 50 },
    unknown: { input: 7, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
  })

  const onlyThinking = [{ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }, lines[0]]

  assert.deepEqual(parseTranscript(jsonLines(onlyThinking)).usage, {
    'claude-opus-5-5': { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 50 },
  })

  assert.deepEqual(parseTranscript(jsonLines([lines[0]])).usage, {})
})

test('parseTranscript: the last result wins, and without one there is no final', () => {
  const failed = { type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 1, duration_ms: 1000, num_turns: 3 }
  const passed = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 2,
    duration_ms: 2000,
    num_turns: 5,
    structured_output: {},
  }

  assert.equal(parseTranscript(jsonLines([passed, failed])).final.subtype, 'error_max_turns')
  assert.equal(parseTranscript(jsonLines([passed, failed])).final.ok, false)
  assert.equal(parseTranscript(jsonLines([failed, passed])).final.ok, true)
  assert.equal(parseTranscript(jsonLines([{ ...passed, structured_output: undefined }])).final.ok, false)
  assert.deepEqual(parseTranscript(jsonLines(sampleTranscript().slice(0, 3))).final, null)
})

test('succeeded: only a result with a report and no error', () => {
  assert.equal(succeeded({ structured_output: { status: 'READY' } }), true)

  for (const result of [null, undefined, { is_error: true, structured_output: { status: 'READY' } }, { result: 'done' }]) {
    assert.equal(succeeded(result), false, JSON.stringify(result))
  }
})

test('transcriptParser: fed line by line, it reads what parseTranscript reads, and keeps reading', () => {
  for (const lines of [sampleTranscript(), interruptedTranscript().slice(0, -1)]) {
    const parser = transcriptParser()

    for (const line of lines) {
      parser.push(line)
    }

    assert.deepEqual(parser.result(), parseTranscript(jsonLines(lines)))
  }

  const parser = transcriptParser()
  const [init, ...rest] = sampleTranscript()

  parser.push(init)
  assert.deepEqual(parser.result().items, [{ kind: 'init', model: 'opus', sessionId: 'session-1' }])
  assert.equal(parser.result().final, null)

  for (const line of rest) {
    parser.push(line)
  }

  assert.equal(parser.result().items.length, 8)
  assert.equal(parser.result().final.costUsd, 4.25)
  parser.push({ type: 'system', subtype: 'init', model: 'haiku', session_id: 'session-9' })
  assert.equal(parser.result().model, 'opus')
})

test('readTranscript reads logs/<run>.jsonl and refuses names outside it', () => {
  const manifest = loadManifest(makeRollout())

  for (const name of ['../ledger', 'a/b', '.hidden', 'a..b', '', null]) {
    assert.throws(() => readTranscript(manifest, name), /invalid run name/, String(name))
    assert.equal(isRunName(name), false, String(name))
  }

  assert.equal(isRunName('A1-01-implement'), true)

  assert.equal(readTranscript(manifest, 'Z9-01-implement'), null)
  assert.equal(readTranscript(manifest, 'A1-01-implement').final.costUsd, 4.25)
})

test('rolloutView: null without a ledger, the whole model with one', () => {
  assert.equal(rolloutView(loadManifest(makeRollout({ prs: null }))), null)

  const hold = { at: at(5), by: 'maintainer', reason: null }
  const view = rolloutView(loadManifest(makeRollout({ hold })))
  assert.equal(view.rollout, 'demo')
  assert.equal(view.merge, 'human')
  assert.equal(view.driver.running, true)
  assert.deepEqual(view.driver.hold, hold)
  assert.equal(Object.hasOwn(view.driver, 'paused'), false)
  assert.equal(Object.hasOwn(view.driver, 'halted'), false)
  assert.equal(rolloutView(loadManifest(makeRollout())).driver.hold, null)
  assert.equal(rolloutView(loadManifest(makeRollout({ legacy: true }))).driver.hold, null)
  assert.equal(view.events.length, 9)
  assert.deepEqual(statuses(view.runs), ['A2-01-brief-write:ok', 'A1-01-implement:ok', 'A1-02-verify:ok', 'A2-01-implement:running'])
  assert.equal(view.costs.totalUsd, 7.75)
  assert.deepEqual(view.costs.byRole, { brief: 1.5, implement: 4.25, fix: 0, verify: 2, delegate: 0 })
})

test('rolloutView: a version 2 ledger is migrated in memory, and ledger.json stays as it is, byte for byte', () => {
  const dir = makeRollout()
  const file = join(dir, 'ledger.json')
  const blocked = { kind: 'needs-decision', question: 'Which API?', evidence: 'Both exist.', run: 'A2-01-implement' }
  const older = { version: 2, prs: { A1: samplePrs().A1, A2: { state: 'blocked', pr: 12, blocked } }, runs: {}, hold: null }

  writeFileSync(file, `${JSON.stringify(older, null, 2)}\n`)

  const before = readFileSync(file)
  const view = rolloutView(loadManifest(dir))

  assert.deepEqual(
    view.rows.map((row) => [row.id, row.status.stage, row.status.code]),
    [
      ['A1', 'merge', 'held'],
      ['A2', 'implement', 'decision'],
      ['A3', 'brief', 'slot'],
    ],
  )

  assert.deepEqual(view.rows[1].waiting.run, 'A2-01-implement')
  assert.deepEqual(readFileSync(file), before)
})

test('rolloutView: reads the events through the reader it is given, and only with a ledger', () => {
  const manifest = loadManifest(makeRollout())
  const events = [{ at: at(1), id: 'A1', kind: 'note' }]
  const calls = []
  const reader = (given) => {
    calls.push(given)

    return events
  }

  const view = rolloutView(manifest, START, reader)

  assert.equal(calls.length, 1)
  assert.equal(calls[0], manifest)
  assert.equal(view.events, events)

  assert.equal(rolloutView(loadManifest(makeRollout({ prs: null })), START, reader), null)
  assert.equal(calls.length, 1)
})

// An empty COLUMNS counts as unset, and the output is a pipe, so lines stay whole unless a test sets a width.
function cliWith(env, ...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dirname(BIN), env: { ...process.env, COLUMNS: '', ...env } })
}

function cli(...args) {
  return cliWith({}, ...args)
}

// The lines of the status list that start with a PR id.
function prLines(stdout) {
  return stdout.split('\n').filter((line) => /^A\d /.test(line))
}

// An entry as a driver of this version writes it, so the view keeps it as it is.
function written(entry) {
  return { hold: null, ...entry }
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

const OBSTACLE = {
  kind: 'environment',
  text: 'The sandbox cannot reach the registry\nIt answers 403 for every package.',
  evidence: 'npm ci: 403 Forbidden',
  run: 'A2-01-implement',
  delegate: null,
}

// Three PRs that need you, with sentences and way outs long enough to cut at 80 columns.
function needyRollout(hold = null) {
  const status = (kind, code, extra = {}) => ({ kind, code, since: minutesAgo(5), ...extra })

  return makeRollout({
    prs: {
      A1: written({ stage: 'merge', status: status('needs-you', 'approve'), pr: 11, hold }),
      A2: written({ stage: 'implement', status: status('needs-you', 'obstacle', { question: OBSTACLE }), pr: 12 }),
      A3: written({ stage: 'verify', status: status('needs-you', 'dispute', { findings: ['F1', 'F2'], text: '' }), pr: 13 }),
    },
  })
}

test('help lists hold, release and preflight, and the filters of status', () => {
  const result = cli('help')

  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes('rollout.mjs hold | release <id>... | --all [--dir D]'), result.stdout)
  assert.ok(result.stdout.includes('rollout.mjs status    [--dir D] [--stage S] [--needs-you]'), result.stdout)
  assert.match(result.stdout, /rollout\.mjs preflight/)
})

test('status and card read the fixture, partial events line included', () => {
  const dir = makeRollout()
  const status = cli('status', '--dir', dir)
  const card = cli('card', 'A1', '--dir', dir)

  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /^id {2}stage · status {18}info$/m)
  assert.match(
    status.stdout,
    /^A1 {2}merge · waiting: held {11}held since 2026-09-01 11:21 UTC by maintainer · \d+h \(rollout release A1\)$/m,
  )

  assert.match(status.stdout, /^A2 {2}implement · running: implement {2}the implementer is working · \d+m$/m)
  assert.match(status.stdout, /^A3 {2}brief · waiting: slot {11}waits for a free slot · \d+m$/m)
  assert.match(status.stdout, /recent events:\n[\s\S]*A2 {3}implement-start/)
  assert.doesNotMatch(status.stdout, /HELD|PAUSED/)
  assert.equal(card.status, 0, card.stderr)
  assert.ok(
    card.stdout.includes(
      [
        'merge · waiting: held   PR: https://github.com/example/widgets/pull/11   cost: $6.25',
        'held since 2026-09-01 11:21 UTC by maintainer',
        'since 2026-09-01 11:22 UTC',
        'way out: rollout release A1',
        'held since 2026-09-01T11:21:00.000Z by maintainer (rollout.mjs release A1)',
      ].join('\n'),
    ),
    card.stdout,
  )

  assert.match(card.stdout, /verifier: PASS on a1a1a1a/)
})

test('status --stage and --needs-you choose the rows, both together those that match both, and an unknown stage exits 1', () => {
  const dir = makeRollout({
    prs: {
      A1: written({ stage: 'merge', status: { kind: 'needs-you', code: 'approve', since: at(85) }, pr: 11 }),
      A2: { state: 'implementing' },
      A3: { state: 'blocked', blocked: { kind: 'needs-decision', question: 'Which API?', evidence: '' } },
    },
  })

  const ids = (...args) => prLines(cli('status', '--dir', dir, ...args).stdout).map((line) => line.split(' ')[0])

  assert.deepEqual(ids(), ['A1', 'A2', 'A3'])
  assert.deepEqual(ids('--needs-you'), ['A1', 'A3'])
  assert.deepEqual(ids('--stage', 'merge'), ['A1'])
  assert.deepEqual(ids('--stage', 'implement'), ['A2', 'A3'])
  assert.deepEqual(ids('--stage', 'implement', '--needs-you'), ['A3'])

  const none = cli('status', '--dir', dir, '--stage', 'verify')

  assert.equal(none.status, 0, none.stderr)
  assert.match(none.stdout, /\n\nno PR matches\n/)
  assert.match(none.stdout, /^rollout demo {2}driver: running/)
  assert.match(none.stdout, /recent events:/)

  const unknown = cli('status', '--dir', dir, '--stage', 'nope')

  assert.equal(unknown.status, 1)
  assert.equal(unknown.stderr, 'unknown stage nope, known: brief, implement, pre-verify, verify, merge, merged\n')
})

test('status with COLUMNS=200 prints every sentence and way out whole', () => {
  const dir = needyRollout()
  const { rows } = rolloutView(loadManifest(dir))
  const lines = prLines(cliWith({ COLUMNS: '200' }, 'status', '--dir', dir).stdout)

  assert.equal(lines.length, 3)

  rows.forEach((row, index) => {
    const line = lines[index]

    assert.ok(line.length > 80, line)
    assert.ok(line.includes(`${row.status.sentence} · 5m (${row.status.wayOut.text})`), line)
  })
})

test('status with COLUMNS=80 keeps every PR line within 80, and cuts a sentence after a whole word', () => {
  const dir = needyRollout()
  const { rows } = rolloutView(loadManifest(dir))
  const stdout = cliWith({ COLUMNS: '80' }, 'status', '--dir', dir).stdout
  const lines = prLines(stdout)
  const infoAt = stdout
    .split('\n')
    .find((line) => line.startsWith('id '))
    .indexOf('info')

  const cut = lines.filter((line) => line.includes('…'))

  assert.equal(lines.length, 3)
  assert.ok(
    lines.every((line) => line.length <= 80),
    lines.join('\n'),
  )

  assert.ok(cut.length >= 2, stdout)

  for (const line of cut) {
    const { sentence } = rows.find((row) => line.startsWith(`${row.id} `)).status
    const shown = line.slice(infoAt, line.indexOf('…'))

    assert.ok(sentence.startsWith(shown), `${shown} | ${sentence}`)
    assert.equal(sentence[shown.length], ' ', `${shown} | ${sentence}`)
  }

  assert.match(lines[2], /the verifier… · 5m \(rollout note A3 "\.\.\."\)$/)
  assert.equal(lines[0].slice(infoAt), 'verified, waits… · 5m (rollout approve A1)')
  // A way out too long to keep whole leaves too little room, so the whole info is cut.
  assert.equal(lines[1].slice(infoAt), 'the implementer is blocked (environment):…')
})

test('card: the stage and status, the whole sentence, since when, the way out and the whole question', () => {
  const hold = { at: at(7), by: 'maintainer', reason: 'checking' }
  const dir = needyRollout(hold)
  const obstacle = cli('card', 'A2', '--dir', dir)
  const approve = cli('card', 'A1', '--dir', dir)
  const since = timeText(readLedger(loadManifest(dir)).prs.A2.status.since)

  assert.equal(obstacle.status, 0, obstacle.stderr)
  assert.ok(
    obstacle.stdout.startsWith(
      [
        '# A2 feat: A2  (feat/a2)',
        'implement · needs-you: obstacle   PR: https://github.com/example/widgets/pull/12   cost: $0.00',
        'the implementer is blocked (environment): The sandbox cannot reach the registry',
        `since ${since}`,
        'way out: remove the cause, then rollout retry A2, or rollout note A2 "..."',
      ].join('\n'),
    ),
    obstacle.stdout,
  )

  assert.ok(
    obstacle.stdout.includes(
      '\nquestion (environment): The sandbox cannot reach the registry\nIt answers 403 for every package.\nnpm ci: 403 Forbidden\n',
    ),
    obstacle.stdout,
  )

  assert.doesNotMatch(obstacle.stdout, /BLOCKED/)
  assert.match(approve.stdout, /^merge · needs-you: approve \[held\] {3}PR: /m)
  assert.match(approve.stdout, /^way out: rollout approve A1$/m)
  assert.match(approve.stdout, /^held since 2026-09-01T10:07:00\.000Z by maintainer: checking \(rollout\.mjs release A1\)$/m)
  assert.match(cli('status', '--dir', dir).stdout, /^A1 {2}merge · needs-you: approve \[held\] {2}verified, waits for your approval/m)
})

test('status: with no driver, the header says since when it is down, and a running status shows as driver-stopped', () => {
  const dir = makeRollout({ lock: false })
  const beat = new Date(START + 95 * 60_000)

  utimesSync(join(dir, 'heartbeat'), beat, beat)

  const stopped = cli('status', '--dir', dir)
  const never = cli('status', '--dir', makeRollout({ lock: false, heartbeat: null }))

  assert.equal(stopped.status, 0, stopped.stderr)
  assert.match(
    stopped.stdout,
    /^rollout demo {2}driver: NOT RUNNING since 2026-09-01 11:35 UTC\. Statuses are from its last tick\. Start it with rollout\.mjs run$/m,
  )

  assert.match(stopped.stdout, /^A2 {2}implement · waiting: driver-stopped {2}the driver is not running · \d+h$/m)
  assert.match(stopped.stdout, /^A1 {2}merge · waiting: held /m)
  assert.match(never.stdout, /^rollout demo {2}driver: NOT RUNNING \(last heartbeat never\)$/m)
  assert.match(cli('card', 'A2', '--dir', dir).stdout, /^implement · waiting: driver-stopped {3}PR: -/m)
})

test('status prints the hold of the rollout with who set it, since when and why, and card prints a PR hold the same way', () => {
  const byMaintainer = cli('status', '--dir', makeRollout({ hold: { at: at(5), by: 'maintainer', reason: null } }))
  const byDriver = cli('status', '--dir', makeRollout({ hold: { at: at(6), by: 'driver', reason: 'usage limit reached' } }))
  const card = cli(
    'card',
    'A1',
    '--dir',
    makeRollout({ prs: { A1: { state: 'pending', held: { at: at(7), by: 'driver', reason: 'why' } } } }),
  )

  assert.equal(byMaintainer.status, 0, byMaintainer.stderr)
  assert.ok(byMaintainer.stdout.includes(`\nHELD since ${at(5)} by maintainer (rollout.mjs release --all)\n`), byMaintainer.stdout)
  assert.ok(byDriver.stdout.includes(`\nHELD since ${at(6)} by driver: usage limit reached (rollout.mjs release --all)\n`), byDriver.stdout)
  assert.ok(card.stdout.includes(`\nheld since ${at(7)} by driver: why (rollout.mjs release A1)\n`), card.stdout)
})

test('status and card without a ledger, or with an empty events file', () => {
  const bare = makeRollout({ prs: null })
  const quiet = makeRollout({ events: [] })

  assert.match(cli('status', '--dir', bare).stdout, /^no ledger yet in /)
  assert.equal(cli('card', 'A1', '--dir', bare).stdout, 'no state yet\n')
  assert.equal(cli('status', '--dir', quiet).status, 0)
  assert.doesNotMatch(cli('status', '--dir', quiet).stdout, /recent events/)
})

test('status and card refuse a ledger a newer driver wrote, with the reason on stderr', () => {
  const dir = makeRollout()
  const file = join(dir, 'ledger.json')

  writeFileSync(file, JSON.stringify({ version: 99, prs: {}, runs: {}, paused: false, halted: null }))

  const before = readFileSync(file, 'utf8')

  for (const args of [
    ['status', '--dir', dir],
    ['card', 'A1', '--dir', dir],
  ]) {
    const result = cli(...args)

    assert.equal(result.status, 1, args[0])
    assert.match(result.stderr, /^ledger\.json is version 99, written by a newer driver than this one \(version 3\)\./, args[0])
  }

  assert.equal(readFileSync(file, 'utf8'), before)
})

// A FAIL that re-checked the findings of the FAIL before it, as the driver records it.
const RECHECKED = {
  verdict: 'FAIL',
  sha: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  summary: 'A disputed finding is still open.',
  checklist: [{ item: 'docs updated', status: 'fail', evidence: 'README.md:3' }],
  blocking: ['The retry flag is still not documented.'],
  nonBlocking: [],
  recheck: [
    {
      id: 'F1',
      status: 'resolved',
      evidence: 'cli.mjs:42 logs it.',
      finding: 'cli.mjs:40 swallows the error.',
      answer: { outcome: 'fixed', action: 'It is logged at cli.mjs:42.' },
    },
    {
      id: 'F2',
      status: 'open',
      evidence: 'The brief lists the flag in the docs.',
      finding: 'The retry flag is not documented.',
      answer: { outcome: 'disputed', action: 'The brief keeps the flag internal.' },
    },
    { id: 'F3', status: 'wrong', evidence: 'A decision allows it.', finding: 'a.mjs:9 is unused.', answer: null },
  ],
  at: at(90),
  run: 'A1-04-verify',
}

test('prDetail keeps the re-checked findings of a verdict, with their text and answer', () => {
  const manifest = loadManifest(makeRollout())
  const detail = prDetail(manifest, { prs: { A1: { verdict: RECHECKED, verdicts: [RECHECKED] } } }, [], [], 'A1')

  assert.deepEqual(detail.verdict.recheck, RECHECKED.recheck)
  assert.deepEqual(detail.verdicts[0].recheck, RECHECKED.recheck)
})

test('card: every re-checked finding with its status, the answer and the evidence, and a verdict without them as before', () => {
  const dir = makeRollout({ prs: { A1: { ...samplePrs().A1, state: 'escalated', verdict: RECHECKED, verdicts: [RECHECKED] } } })
  const card = cli('card', 'A1', '--dir', dir)
  const lines = [
    '  [fail] docs updated',
    '  re-check F1 [resolved]: cli.mjs:40 swallows the error.',
    '    answer (fixed): It is logged at cli.mjs:42.',
    '    evidence: cli.mjs:42 logs it.',
    '  re-check F2 [open]: The retry flag is not documented.',
    '    answer (disputed): The brief keeps the flag internal.',
    '    evidence: The brief lists the flag in the docs.',
    '  re-check F3 [wrong]: a.mjs:9 is unused.',
    '    evidence: A decision allows it.',
    '  BLOCKING: The retry flag is still not documented.',
  ]

  assert.equal(card.status, 0, card.stderr)
  assert.ok(card.stdout.includes(lines.join('\n')), card.stdout)

  const plain = cli('card', 'A1', '--dir', makeRollout())

  assert.equal(plain.status, 0, plain.stderr)
  assert.ok(plain.stdout.includes('\nverifier: PASS on a1a1a1a — Every checklist item holds.\n  [pass] tests pass\n\n'), plain.stdout)
  assert.doesNotMatch(plain.stdout, /re-check/)
})

// A PASS the driver judged a FAIL: a required criterion failed, a recommended one could not be verified.
const JUDGED = {
  ...RECHECKED,
  summary: 'Every checklist item holds.',
  checklist: [{ item: 'tests pass', status: 'pass', evidence: 'npm test: 12 pass' }],
  blocking: ['V1 (required criterion): A new branch in the code has a test that fails without it. lib/a.mjs:12 has no test.'],
  recheck: [],
  criteria: [
    {
      id: 'V1',
      level: 'required',
      text: 'A new branch in the code has a test that fails without it.',
      result: 'fail',
      evidence: 'lib/a.mjs:12 has no test.',
    },
    { id: 'V2', level: 'required', text: 'No semicolons in prose.', result: 'pass', evidence: 'grep finds none.' },
    { id: 'V3', level: 'recommended', text: 'Docs: every new option has its row.', result: 'unverifiable', evidence: 'No option changed.' },
  ],
}

test('prDetail keeps the criteria of a verdict, with their level, text and result', () => {
  const manifest = loadManifest(makeRollout())
  const detail = prDetail(manifest, { prs: { A1: { verdict: JUDGED, verdicts: [RECHECKED, JUDGED] } } }, [], [], 'A1')

  assert.deepEqual(detail.verdict.criteria, JUDGED.criteria)
  assert.deepEqual(detail.verdicts[1].criteria, JUDGED.criteria)
  assert.equal(detail.verdicts[0].criteria, undefined)
})

test('card: every project criterion after the checklist, with evidence only for one that did not pass', () => {
  const dir = makeRollout({ prs: { A1: { ...samplePrs().A1, state: 'needs_fix', verdict: JUDGED, verdicts: [JUDGED] } } })
  const card = cli('card', 'A1', '--dir', dir)
  const lines = [
    'verifier: FAIL on a1a1a1a — Every checklist item holds.',
    '  [pass] tests pass',
    '  criterion V1 (required) [fail]: A new branch in the code has a test that fails without it.',
    '    evidence: lib/a.mjs:12 has no test.',
    '  criterion V2 (required) [pass]: No semicolons in prose.',
    '  criterion V3 (recommended) [unverifiable]: Docs: every new option has its row.',
    '    evidence: No option changed.',
    '  BLOCKING: V1 (required criterion): A new branch in the code has a test that fails without it. lib/a.mjs:12 has no test.',
  ]

  assert.equal(card.status, 0, card.stderr)
  assert.ok(card.stdout.includes(lines.join('\n')), card.stdout)
  assert.doesNotMatch(card.stdout, /grep finds none/)

  const rechecked = cli('card', 'A1', '--dir', makeRollout({ prs: { A1: { ...samplePrs().A1, verdict: RECHECKED } } }))

  assert.equal(rechecked.status, 0, rechecked.stderr)
  assert.ok(rechecked.stdout.includes('  [fail] docs updated\n  re-check F1 [resolved]'), rechecked.stdout)
  assert.doesNotMatch(rechecked.stdout, /criterion/)
})

// A required command that passed and a recommended one that failed, on A1's head.
// A ready record, a pre-verify one and one from before ready commands, without a stage.
const PRE_VERIFY = {
  sha: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
  at: at(79),
  results: [
    {
      command: 'npm ci',
      stage: 'ready',
      level: 'required',
      result: 'pass',
      summary: 'exit 0',
      exitCode: 0,
      signal: null,
      timedOut: false,
      seconds: 20,
      tail: 'added 300 packages\n',
      changes: [],
    },
    {
      command: 'npm test',
      stage: 'preVerify',
      level: 'required',
      result: 'pass',
      summary: 'exit 0',
      exitCode: 0,
      signal: null,
      timedOut: false,
      seconds: 40,
      tail: 'tests 12, pass 12\n',
      changes: [],
    },
    {
      command: 'npm run lint',
      level: 'recommended',
      result: 'fail',
      summary: 'exit 1',
      exitCode: 1,
      signal: null,
      timedOut: false,
      seconds: 5,
      tail: 'line 1\nline 2\n\nline 3\nline 4\n   \nline 5\nline 6\n\n',
      changes: [],
    },
  ],
}

test('prDetail: the pre-verify results of the claimed head, and none for another head', () => {
  const manifest = loadManifest(makeRollout())
  const detail = (state) => prDetail(manifest, { prs: { A1: state } }, [], [], 'A1').preVerify

  assert.deepEqual(detail({ claimedSha: PRE_VERIFY.sha, preVerify: PRE_VERIFY }), PRE_VERIFY)
  assert.equal(detail({ claimedSha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', preVerify: PRE_VERIFY }), null)
  assert.equal(detail({ claimedSha: PRE_VERIFY.sha }), null)
  assert.equal(detail({}), null)
})

test('card: the commands the driver ran after the verifier, each with its stage, and the last lines of output of a failed command', () => {
  const dir = makeRollout({ prs: { A1: { ...samplePrs().A1, preVerify: PRE_VERIFY } } })
  const card = cli('card', 'A1', '--dir', dir)
  const block = [
    '  [pass] tests pass',
    '',
    'commands the driver ran at a1a1a1a:',
    '  [pass] ready required: npm ci (exit 0)',
    '  [pass] preVerify required: npm test (exit 0)',
    '  [fail] preVerify recommended: npm run lint (exit 1)',
    '    line 2',
    '    line 3',
    '    line 4',
    '    line 5',
    '    line 6',
    '',
    'Approve with: ',
  ]

  assert.equal(card.status, 0, card.stderr)
  assert.ok(card.stdout.includes(block.join('\n')), card.stdout)
  assert.doesNotMatch(card.stdout, /tests 12, pass 12|added 300 packages/)

  const moved = makeRollout({
    prs: { A1: { ...samplePrs().A1, claimedSha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', preVerify: PRE_VERIFY } },
  })

  assert.doesNotMatch(cli('card', 'A1', '--dir', moved).stdout, /commands the driver ran/)
  assert.doesNotMatch(cli('card', 'A1', '--dir', makeRollout()).stdout, /commands the driver ran/)
})

const OLDER_HEAD = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'
const SKIP_REASON = 'the review run ended as failure'
const ESCAPED_TITLE = 'A flag named tmp\n\u001b[31mred'

function skippedReview(reason = SKIP_REASON) {
  return { ...sampleReview(), reusedFrom: null, skipped: reason, findings: [], fixed: [] }
}

function reviewRollout(review, { manifest = REVIEW_MANIFEST, ...entry } = {}) {
  return makeRollout({ manifest, prs: { A1: { ...samplePrs().A1, review, ...entry } } })
}

function shownReview(dir) {
  const manifest = loadManifest(dir)

  return prDetail(manifest, readLedger(manifest), [], [], 'A1').review
}

test('prDetail: the review of the claimed head, its findings by severity, the ones below minSeverity noted, then the fixed ones', () => {
  assert.deepEqual(shownReview(reviewRollout(sampleReview())), {
    sha: samplePrs().A1.claimedSha,
    reusedFrom: sampleReview().reusedFrom,
    skipped: null,
    minSeverity: 'medium',
    counts: { high: 1, medium: 1, low: 1 },
    leftOut: 0,
    summary: '3 findings (1 high, 1 medium, 1 low), 1 fixed',
    findings: [
      {
        severity: 'high',
        criterion: 'review.correctness',
        file: 'src/orders/total.ts',
        line: 42,
        title: 'The total ignores a refunded line',
        note: '',
      },
      {
        severity: 'medium',
        criterion: 'review.errors',
        file: 'src/orders/load.ts',
        line: 7,
        title: 'A failed read is retried forever',
        note: '',
      },
      {
        severity: 'low',
        criterion: 'review.naming',
        file: 'src/orders/total.ts',
        line: 12,
        title: 'A flag named tmp',
        note: 'shown only, below medium',
      },
    ],
    fixed: [
      {
        severity: 'medium',
        criterion: 'review.correctness',
        file: 'src/orders/total.ts',
        line: 30,
        title: 'The discount is applied twice',
        note: 'fixed',
      },
    ],
  })
})

test('prDetail: no review without the manifest key, without a stored review, or for a review of another head', () => {
  assert.equal(shownReview(reviewRollout(sampleReview(), { manifest: {} })), null)
  assert.equal(shownReview(makeRollout({ manifest: REVIEW_MANIFEST })), null)
  assert.equal(shownReview(reviewRollout(null)), null)
  assert.equal(shownReview(reviewRollout({ ...sampleReview(), sha: OLDER_HEAD })), null)
  assert.equal(shownReview(reviewRollout(sampleReview(), { claimedSha: OLDER_HEAD })), null)
})

test('prDetail: a skipped review gives its reason as the summary, with no rows', () => {
  const review = shownReview(reviewRollout(skippedReview()))

  assert.equal(review.skipped, SKIP_REASON)
  assert.equal(review.summary, `skipped: ${SKIP_REASON}`)
  assert.equal(review.reusedFrom, null)
  assert.deepEqual([review.findings, review.fixed], [[], []])
  assert.deepEqual(review.counts, { high: 0, medium: 0, low: 0 })
})

test('prDetail: the review summary names what was left out and fixed, and one finding is singular', () => {
  const [low, high, medium] = sampleReview().findings
  const summary = (fields) => shownReview(reviewRollout({ ...sampleReview(), ...fields })).summary

  assert.equal(summary({ leftOut: 2 }), '3 findings (1 high, 1 medium, 1 low), 2 left out, 1 fixed')
  assert.equal(summary({ findings: [high], fixed: [] }), '1 finding (1 high)')
  assert.equal(summary({ findings: [low, medium, medium], fixed: [] }), '3 findings (2 medium, 1 low)')
  assert.equal(summary({ findings: [] }), 'no findings, 1 fixed')
  assert.equal(summary({ findings: [], fixed: [] }), 'no findings')
})

test("prDetail: the review splits at the manifest's minSeverity, and one severity keeps the file's order", () => {
  const [low, high, medium] = sampleReview().findings
  const second = { ...high, line: 50, title: 'A second high one' }

  function rows(minSeverity) {
    const manifest = { gates: { verify: { externalFindings: { check: 'agent review', minSeverity } } } }
    const review = shownReview(reviewRollout({ ...sampleReview(), findings: [low, high, medium, second] }, { manifest }))

    return review.findings.map((row) => [row.line, row.note])
  }

  assert.deepEqual(rows('low'), [
    [42, ''],
    [50, ''],
    [7, ''],
    [12, ''],
  ])

  assert.deepEqual(rows('high'), [
    [42, ''],
    [50, ''],
    [7, 'shown only, below high'],
    [12, 'shown only, below high'],
  ])
})

test('prDetail: a review text with a line break or a terminal escape comes out with no control character', () => {
  const [low] = sampleReview().findings
  const found = shownReview(
    reviewRollout({ ...sampleReview(), findings: [{ ...low, title: ESCAPED_TITLE, criterion: 'review.\tnaming' }] }),
  )

  const skipped = shownReview(reviewRollout(skippedReview('the review run\r\nended as failure')))
  const shown = [found.summary, skipped.summary, ...found.findings.flatMap((row) => [row.criterion, row.file, row.title])]

  assert.equal(found.findings[0].title, 'A flag named tmp [31mred')
  assert.equal(found.findings[0].criterion, 'review. naming')
  assert.equal(skipped.summary, `skipped: ${SKIP_REASON}`)
  assert.deepEqual(
    shown.filter((text) => /\p{Cc}/u.test(text)),
    [],
  )
})

// The note of each finding of A1's review as [line, note], with `fields` in A1's entry.
function reviewNotes(fields) {
  return shownReview(reviewRollout(fields.review, fields)).findings.map((row) => [row.line, row.note])
}

// sampleReview() with only its medium finding fixed as X1, as when its high one was a finding to re-check.
function mediumOnly() {
  const review = sampleReview()
  const [, high, medium] = review.findings

  return { review: { ...review, candidates: [{ id: 'X1', key: matchKey(medium) }] }, high }
}

test("prDetail: a candidate notes the latest verdict's answer for the review's head, its evidence on one line", () => {
  const answered = answeredReview()
  const [confirmed, refuted] = answered.verdict.external
  const review = shownReview(reviewRollout(answered.review, answered))

  assert.deepEqual(reviewNotes(answered), [
    [42, 'X1 confirmed'],
    [7, 'X2 refuted: src/orders/load.ts:9 caps the retries at three.'],
    [12, 'shown only, below medium'],
  ])

  assert.equal(review.summary, '3 findings (1 high, 1 medium, 1 low), 1 fixed')
  assert.deepEqual(
    review.fixed.map((row) => row.note),
    ['fixed'],
  )

  const others = [
    { ...confirmed, result: 'unverifiable', evidence: 'The tests do not run here.' },
    { ...refuted, result: 'unanswered', evidence: '' },
  ]

  assert.deepEqual(reviewNotes({ ...answered, verdict: { ...answered.verdict, external: others } }).slice(0, 2), [
    [42, 'X1 unverifiable'],
    [7, 'X2 unanswered'],
  ])
})

test('prDetail: a candidate with no answer of the latest verdict for its head and its key is sent, with no answer yet', () => {
  const answered = answeredReview()
  const [confirmed, refuted] = answered.verdict.external
  const verdicts = {
    'of another head': { ...answered.verdict, sha: OLDER_HEAD },
    'with no external': samplePrs().A1.verdict,
    'of another launch': {
      ...answered.verdict,
      external: [
        { ...confirmed, key: 'another key' },
        { ...refuted, id: 'X3' },
      ],
    },
    none: null,
  }

  for (const [name, verdict] of Object.entries(verdicts)) {
    assert.deepEqual(
      reviewNotes({ ...answered, verdict, verdicts: verdict ? [verdict] : [] }).slice(0, 2),
      [
        [42, 'X1 sent, no answer yet'],
        [7, 'X2 sent, no answer yet'],
      ],
      name,
    )
  }
})

test('prDetail: a finding left out at launch notes the finding it already is, and after a PASS that it was re-checked as one', () => {
  const { review, high } = mediumOnly()
  const findings = {
    at: at(80),
    items: [
      { id: 'F1', text: 'README.md:3 still names the old flag.', answer: null },
      { id: 'F2', text: 'External review finding (high).', answer: null, fromReview: matchKey(high) },
    ],
  }

  assert.deepEqual(reviewNotes({ review, findings }).slice(0, 2), [
    [42, 'not sent, already finding F2'],
    [7, 'X1 sent, no answer yet'],
  ])

  assert.deepEqual(reviewNotes({ review, findings: null }).slice(0, 2), [
    [42, 'not sent, re-checked as a finding'],
    [7, 'X1 sent, no answer yet'],
  ])

  assert.deepEqual(reviewNotes({ review: sampleReview(), findings }), [
    [42, 'not sent, already finding F2'],
    [7, ''],
    [12, 'shown only, below medium'],
  ])
})

test('prDetail: a remembered refutation of a finding not sent notes its evidence on one line, before and after a launch', () => {
  const answered = answeredReview()
  const [, high, medium] = answered.review.findings
  const refutation = (finding, evidence) => ({
    key: matchKey(finding),
    blob: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
    evidence,
    run: 'A1-03-verify',
    at: at(60),
  })

  const reviewMemory = {
    sent: [matchKey(high), matchKey(medium)],
    refuted: [refutation(medium, 'src/orders/load.ts:9 caps the retries\nat three.'), refutation(high, 'Total.ts:44 skips it.')],
  }

  const held = { ...answered, reviewMemory, review: { ...answered.review, candidates: [] } }

  assert.deepEqual(reviewNotes(held), [
    [42, 'not sent, already finding F1'],
    [7, 'refuted earlier: src/orders/load.ts:9 caps the retries at three.'],
    [12, 'shown only, below medium'],
  ])

  const beforeLaunch = { review: sampleReview(), reviewMemory, findings: null }

  assert.deepEqual(reviewNotes(beforeLaunch).slice(0, 2), [
    [42, 'refuted earlier: Total.ts:44 skips it.'],
    [7, 'refuted earlier: src/orders/load.ts:9 caps the retries at three.'],
  ])

  const noEvidence = { ...reviewMemory, refuted: [refutation(medium, '')] }

  assert.deepEqual(reviewNotes({ ...beforeLaunch, reviewMemory: noEvidence }).slice(0, 2), [
    [42, ''],
    [7, 'refuted earlier'],
  ])

  assert.deepEqual(reviewNotes({ ...answered, reviewMemory }).slice(0, 2), [
    [42, 'X1 confirmed'],
    [7, 'X2 refuted: src/orders/load.ts:9 caps the retries at three.'],
  ])
})

test('prDetail: with 20 candidates, a finding after the 20th is over 20, and one before it was re-checked as a finding', () => {
  const [, high] = sampleReview().findings
  const findings = Array.from({ length: 22 }, (_, i) => ({ ...high, title: `High finding ${i + 1}`, line: i + 1 }))
  const firstTwenty = findings.slice(0, 20).map((finding, i) => ({ id: `X${i + 1}`, key: matchKey(finding) }))
  const notes = reviewNotes({ review: { ...sampleReview(), findings, candidates: firstTwenty } })

  assert.deepEqual(notes.slice(18), [
    [19, 'X19 sent, no answer yet'],
    [20, 'X20 sent, no answer yet'],
    [21, 'not sent, over 20'],
    [22, 'not sent, over 20'],
  ])

  const laterTwenty = findings.slice(1, 21).map((finding, i) => ({ id: `X${i + 1}`, key: matchKey(finding) }))
  const rechecked = reviewNotes({ review: { ...sampleReview(), findings, candidates: laterTwenty }, findings: null })

  assert.deepEqual(rechecked[0], [1, 'not sent, re-checked as a finding'])
  assert.deepEqual(rechecked.slice(19), [
    [20, 'X19 sent, no answer yet'],
    [21, 'X20 sent, no answer yet'],
    [22, 'not sent, over 20'],
  ])
})

// The status of A1's row, with `review` and `entry` in A1's entry.
function statusWithReview(review, { manifest = REVIEW_MANIFEST, ...entry } = {}) {
  const loaded = loadManifest(reviewRollout(review, { manifest, ...entry }))

  return prRows(loaded, readLedger(loaded), [], []).find((row) => row.id === 'A1').status
}

function earlierRefutation(finding, evidence) {
  return { key: matchKey(finding), blob: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad', evidence, run: 'A1-03-verify', at: at(60) }
}

test('prRows: a review read after the verification marks the status with the findings at or above minSeverity no verifier got', () => {
  const [low, high, medium] = sampleReview().findings
  const lowest = { gates: { verify: { externalFindings: { check: 'agent review', minSeverity: 'low' } } } }
  const marker = (fields) => statusWithReview(laterReview(), fields).reviewMarker

  assert.deepEqual(statusWithReview(laterReview()), { ...statusWithReview(sampleReview()), reviewMarker: 'review: 2 new' })
  assert.equal(marker({ reviewMemory: { sent: [matchKey(high)], refuted: [] } }), 'review: 1 new')
  assert.equal(marker({ reviewMemory: { sent: [], refuted: [earlierRefutation(medium, 'Capped.')] } }), 'review: 1 new')
  assert.equal(marker({ manifest: lowest }), 'review: 3 new')
  assert.equal(marker({ manifest: lowest, reviewMemory: { sent: [matchKey(low)], refuted: [] } }), 'review: 2 new')
})

test('prRows: no review marker without the key, before the verification, for an older head, for a skip, with nothing new or once merged', () => {
  const [, high, medium] = sampleReview().findings
  const newHead = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3'
  const moved = { claimedSha: newHead, verified: { ...samplePrs().A1.verified, sha: newHead } }
  const cases = {
    'no manifest key': [laterReview(), { manifest: {} }],
    'a read before the verification': [sampleReview(), {}],
    'a review of the head before a same-patch move': [laterReview(), moved],
    'a review of a head other than the claimed one': [laterReview(), { claimedSha: OLDER_HEAD }],
    'a skip': [{ ...skippedReview(), at: at(85) }, {}],
    'every key sent or refuted': [laterReview(), { reviewMemory: { sent: [matchKey(high)], refuted: [earlierRefutation(medium, '')] } }],
    'a merged PR': [laterReview(), { state: 'merged', mergeSha: 'feedface00' }],
  }

  for (const [name, [review, fields]] of Object.entries(cases)) {
    assert.equal(Object.hasOwn(statusWithReview(review, fields), 'reviewMarker'), false, name)
  }

  assert.equal(statusWithReview(laterReview(), { state: 'merged', mergeSha: 'feedface00' }).stage, 'merged')
})

test('prDetail: a review read after the verification notes a finding no verifier got as new, and one sent in an earlier round as such', () => {
  const answered = answeredReview()
  const [, high, medium] = sampleReview().findings
  const later = laterReview()

  assert.deepEqual(reviewNotes({ review: later }), [
    [42, 'new since the verification'],
    [7, 'new since the verification'],
    [12, 'shown only, below medium'],
  ])

  assert.deepEqual(reviewNotes({ review: later, reviewMemory: { sent: [matchKey(high)], refuted: [] } }).slice(0, 2), [
    [42, 'went to a verifier earlier'],
    [7, 'new since the verification'],
  ])

  const refuted = { sent: [matchKey(high), matchKey(medium)], refuted: [earlierRefutation(medium, 'src/orders/load.ts:9 caps\nthem.')] }

  assert.deepEqual(reviewNotes({ review: later, reviewMemory: refuted }).slice(0, 2), [
    [42, 'went to a verifier earlier'],
    [7, 'refuted earlier: src/orders/load.ts:9 caps them.'],
  ])

  assert.deepEqual(reviewNotes({ review: later, reviewMemory: { sent: [], refuted: refuted.refuted } }).slice(0, 2), [
    [42, 'new since the verification'],
    [7, 'refuted earlier: src/orders/load.ts:9 caps them.'],
  ])

  assert.deepEqual(reviewNotes({ ...answered, review: later, reviewMemory: refuted }).slice(0, 2), [
    [42, 'not sent, already finding F1'],
    [7, 'refuted earlier: src/orders/load.ts:9 caps them.'],
  ])

  assert.deepEqual(reviewNotes({ review: sampleReview(), reviewMemory: { sent: [matchKey(high)], refuted: [] } }).slice(0, 2), [
    [42, ''],
    [7, ''],
  ])
})

test('prDetail: the summary of a review read after the verification ends with how many findings no verifier got', () => {
  const [, high, medium] = sampleReview().findings
  const summary = (review, fields) => shownReview(reviewRollout(review, fields)).summary

  assert.equal(summary(laterReview()), '3 findings (1 high, 1 medium, 1 low), 1 fixed, 2 new since the verification')
  assert.equal(
    summary({ ...laterReview(), leftOut: 2 }, { reviewMemory: { sent: [matchKey(high)], refuted: [] } }),
    '3 findings (1 high, 1 medium, 1 low), 2 left out, 1 fixed, 1 new since the verification',
  )

  assert.equal(
    summary(laterReview(), { reviewMemory: { sent: [matchKey(high), matchKey(medium)], refuted: [] } }),
    '3 findings (1 high, 1 medium, 1 low), 1 fixed',
  )

  assert.equal(summary(sampleReview()), '3 findings (1 high, 1 medium, 1 low), 1 fixed')
  assert.equal(summary({ ...skippedReview(), at: at(85) }), `skipped: ${SKIP_REASON}`)
})

test('card: each finding of the external review notes what became of it', () => {
  const answered = answeredReview()
  const card = cli('card', 'A1', '--dir', reviewRollout(answered.review, answered))
  const block = [
    'external review of a1a1a1a: 3 findings (1 high, 1 medium, 1 low), 1 fixed',
    '  line numbers refer to 9f8e7d6, the commit the review read',
    '  [high] review.correctness src/orders/total.ts:42: The total ignores a refunded line (X1 confirmed)',
    '  [medium] review.errors src/orders/load.ts:7: A failed read is retried forever (X2 refuted: src/orders/load.ts:9 caps the retries at three.)',
    '  [low] review.naming src/orders/total.ts:12: A flag named tmp (shown only, below medium)',
    '  [medium] review.correctness src/orders/total.ts:30: The discount is applied twice (fixed)',
    '',
  ]

  assert.equal(card.status, 0, card.stderr)
  assert.ok(card.stdout.includes(block.join('\n')), card.stdout)
})

test('card: the external review of the claimed head after the commands the driver ran, and before the approve hint', () => {
  const card = cli('card', 'A1', '--dir', reviewRollout(sampleReview(), { preVerify: PRE_VERIFY }))
  const block = [
    'commands the driver ran at a1a1a1a:',
    '  [pass] ready required: npm ci (exit 0)',
    '  [pass] preVerify required: npm test (exit 0)',
    '  [fail] preVerify recommended: npm run lint (exit 1)',
    '    line 2',
    '    line 3',
    '    line 4',
    '    line 5',
    '    line 6',
    '',
    'external review of a1a1a1a: 3 findings (1 high, 1 medium, 1 low), 1 fixed',
    '  line numbers refer to 9f8e7d6, the commit the review read',
    '  [high] review.correctness src/orders/total.ts:42: The total ignores a refunded line',
    '  [medium] review.errors src/orders/load.ts:7: A failed read is retried forever',
    '  [low] review.naming src/orders/total.ts:12: A flag named tmp (shown only, below medium)',
    '  [medium] review.correctness src/orders/total.ts:30: The discount is applied twice (fixed)',
    '',
    'Approve with: ',
  ]

  assert.equal(card.status, 0, card.stderr)
  assert.ok(card.stdout.includes(block.join('\n')), card.stdout)
})

test('card: a skipped review prints its heading line only', () => {
  const card = cli('card', 'A1', '--dir', reviewRollout(skippedReview()))
  const lines = card.stdout.split('\n')
  const heading = lines.findIndex((line) => line.startsWith('external review'))

  assert.equal(card.status, 0, card.stderr)
  assert.deepEqual(lines.slice(heading - 1, heading + 2), ['', `external review of a1a1a1a: skipped: ${SKIP_REASON}`, ''])
})

test('card: no external review without the manifest key, without a stored review, or for a review of an older head', () => {
  const dirs = [
    reviewRollout(sampleReview(), { manifest: {} }),
    makeRollout({ manifest: REVIEW_MANIFEST }),
    reviewRollout(sampleReview(), { claimedSha: OLDER_HEAD }),
  ]

  for (const dir of dirs) {
    const card = cli('card', 'A1', '--dir', dir)

    assert.equal(card.status, 0, card.stderr)
    assert.doesNotMatch(card.stdout, /^external review/m)
  }
})

test('card: a review title with a line break or a terminal escape prints on one line', () => {
  const [low] = sampleReview().findings
  const card = cli('card', 'A1', '--dir', reviewRollout({ ...sampleReview(), findings: [{ ...low, title: ESCAPED_TITLE }], fixed: [] }))

  assert.equal(card.status, 0, card.stderr)
  assert.ok(
    card.stdout.includes('\n  [low] review.naming src/orders/total.ts:12: A flag named tmp [31mred (shown only, below medium)\n'),
    card.stdout,
  )

  assert.ok(!card.stdout.includes('\u001b'), card.stdout)
})

const DECISION = { kind: 'needs-decision', question: 'Keep the old flag?', evidence: '' }

function effectsOf(options) {
  const view = rolloutView(loadManifest(makeRollout({ events: [], ...options })))

  return Object.fromEntries(view.rows.map((row) => [row.id, row.effects]))
}

test('effects: retry and note on each row, as lines: what applies, what is queued and what is refused', () => {
  const { A1, A2 } = samplePrs()
  const effects = effectsOf({ prs: { A1: { ...A1, held: null }, A2, A3: { state: 'blocked', pr: 13, blocked: DECISION } } })

  assert.deepEqual(effects.A1, {
    retry: { applies: true, lines: ['merge · waiting: gate-pending', 'after retry: merge · waiting: gate-pending'] },
    note: {
      applies: true,
      lines: [
        'merge · waiting: gate-pending',
        'after note: implement · waiting: slot (maintainer-note)',
        'verification and approval are dropped',
      ],
    },
  })

  assert.deepEqual(effects.A2, {
    retry: { applies: false, lines: ['implement · running: implement', 'refused: an agent is working on this PR'] },
    note: { applies: true, lines: ['implement · running: implement', 'after note: queued, the next writing agent reads it'] },
  })

  assert.deepEqual(effects.A3, {
    retry: { applies: false, lines: ['implement · needs-you: decision', 'refused: this PR waits for your answer: rollout note A3 "..."'] },
    note: { applies: true, lines: ['implement · needs-you: decision', 'after note: implement · waiting: slot (maintainer-note)'] },
  })
})

test('effects: a merged PR refuses both, and a hold shows in the status after', () => {
  const { A1 } = samplePrs()
  const effects = effectsOf({ prs: { A1, A2: { state: 'merged', pr: 12 } } })

  assert.deepEqual(effects.A2, {
    retry: { applies: false, lines: ['merged', 'refused: already merged'] },
    note: { applies: false, lines: ['merged', 'refused: already merged'] },
  })

  assert.deepEqual(effects.A1.note.lines.slice(1), [
    'after note: implement · waiting: held (maintainer-note)',
    'verification and approval are dropped',
  ])
})

test('effects: with the driver stopped, the effect starts from the runs it will resume, and the command waits in the inbox', () => {
  const effects = effectsOf({ prs: { A2: { ...samplePrs().A2, sessionId: 'session-1' } }, lock: false })
  const waits = 'the driver is not running: the command waits in the inbox until it starts'

  assert.deepEqual(effects.A2, {
    retry: { applies: true, lines: ['implement · waiting: driver-stopped', 'after retry: implement · waiting: slot (no-report)', waits] },
    note: { applies: true, lines: ['implement · waiting: driver-stopped', 'after note: queued, the next writing agent reads it', waits] },
  })
})

test('effects: a note on a PR the delegate works on answers the question, with the driver running or stopped', () => {
  const delegating = {
    state: 'blocked',
    pr: 13,
    blocked: DECISION,
    stage: 'implement',
    status: { kind: 'running', code: 'delegate', question: 'needs-decision', run: 'A3-01-delegate', since: at(5) },
    fix: null,
    hold: null,
  }

  const answer = 'after note: implement · waiting: slot (maintainer-note)'
  const running = effectsOf({ prs: { A3: delegating } }).A3
  const stopped = effectsOf({ prs: { A3: delegating }, lock: false }).A3

  assert.deepEqual(running, {
    retry: { applies: false, lines: ['implement · running: delegate', 'refused: an agent is working on this PR'] },
    note: { applies: true, lines: ['implement · running: delegate', answer] },
  })

  assert.deepEqual(stopped.note.lines.slice(0, 2), ['implement · waiting: driver-stopped', answer])
  assert.deepEqual(stopped.retry.lines.slice(1), ['refused: this PR waits for your answer: rollout note A3 "..."'])
})

test('commandPreview: the same lines for retry and note, approve with its command, and null with no ledger yet', () => {
  const { A1 } = samplePrs()
  const manifest = loadManifest(
    makeRollout({ prs: { A1: { ...A1, held: null, approved: null }, A3: { state: 'blocked', pr: 13, blocked: DECISION } } }),
  )

  const rows = Object.fromEntries(rolloutView(manifest).rows.map((row) => [row.id, row]))
  const approve = { cmd: 'approve', id: 'A1', sha: A1.verified.sha, patchId: A1.verified.patchId }

  assert.deepEqual(commandPreview(manifest, { cmd: 'retry', id: 'A3' }), rows.A3.effects.retry)
  assert.deepEqual(commandPreview(manifest, { cmd: 'note', id: 'A1', text: 'Rename the field.' }), rows.A1.effects.note)
  assert.deepEqual(commandPreview(manifest, approve), {
    applies: true,
    lines: ['merge · waiting: gate-pending', 'after approve: merge · waiting: merge-delay'],
  })

  assert.deepEqual(commandPreview(manifest, { cmd: 'approve', id: 'A3' }), {
    applies: false,
    lines: ['implement · needs-you: decision', 'refused: nothing to approve: A3 is implement · needs-you: decision'],
  })

  assert.equal(refusalOf(commandPreview(manifest, { cmd: 'retry', id: 'A3' })), 'this PR waits for your answer: rollout note A3 "..."')
  assert.equal(refusalOf(commandPreview(manifest, approve)), null)
  assert.equal(commandPreview(loadManifest(makeRollout({ prs: null })), { cmd: 'retry', id: 'A1' }), null)
})
