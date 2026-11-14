import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doneDetail } from '../lib/driver.mjs'
import {
  acquireLock,
  drainInbox,
  endRun,
  freshPr,
  LEDGER_VERSION,
  lockHolder,
  migrate,
  MIGRATIONS,
  openLedger,
  parseTickNote,
  postCommand,
  readLedger,
  recheckedFindings,
  recordAnswers,
  recordFindings,
  recordVerdict,
  reserveRunName,
  startRun,
  tickNote,
  watchInbox,
  withDefaults,
} from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { runRecords, runsFromEvents, runsFromLedger } from '../lib/runs.mjs'
import { liveness, prDetail, readEvents } from '../lib/view.mjs'
import { at, makeRollout } from './fixtures.mjs'

function scratch() {
  return { dir: mkdtempSync(join(tmpdir(), 'rollout-')) }
}

// A path where a directory cannot be created.
function unusable() {
  const file = join(scratch().dir, 'file')
  writeFileSync(file, '')

  return { dir: file }
}

function writeLock(manifest, pid) {
  writeFileSync(join(manifest.dir, 'driver.lock'), JSON.stringify({ pid, at: new Date().toISOString() }))
}

function withoutAt(commands) {
  return commands.map(({ at: _, ...command }) => command)
}

async function watching(manifest, task) {
  const inbox = watchInbox(manifest, { settleMs: 50 })

  try {
    return await task(inbox)
  } finally {
    inbox.close()
  }
}

test('reserveRunName never hands out a name twice', () => {
  const manifest = scratch()

  assert.equal(reserveRunName(manifest, 'A1-01-implement'), 'A1-01-implement')
  assert.equal(reserveRunName(manifest, 'A1-01-implement'), 'A1-01-implement-2')
  assert.equal(reserveRunName(manifest, 'A1-01-implement'), 'A1-01-implement-3')
  assert.ok(existsSync(join(manifest.dir, 'logs', 'A1-01-implement.jsonl')))
  assert.ok(existsSync(join(manifest.dir, 'logs', 'A1-01-implement-2.jsonl')))
})

test('reserveRunName throws when it cannot create the log', () => {
  assert.throws(() => reserveRunName(unusable(), 'A1-01-implement'), /ENOTDIR|EEXIST/)
})

test('recordVerdict keeps the latest verdict and the last 10', () => {
  const entry = freshPr()

  for (let i = 1; i <= 12; i += 1) {
    recordVerdict(entry, { verdict: 'PASS', run: `A1-${i}-verify` })
  }

  assert.equal(entry.verdicts.length, 10)
  assert.equal(entry.verdicts[0].run, 'A1-3-verify')
  assert.deepEqual(entry.verdict, { verdict: 'PASS', run: 'A1-12-verify' })

  const old = { verdict: { verdict: 'FAIL' } }
  recordVerdict(old, { verdict: 'PASS' })
  assert.deepEqual(old.verdicts, [{ verdict: 'PASS' }])
})

test('freshPr has no hold, verdict history, handled feedback, findings or verify criteria', () => {
  assert.equal(freshPr().held, null)
  assert.deepEqual(freshPr().verdicts, [])
  assert.deepEqual(freshPr().feedbackHandled, [])
  assert.equal(freshPr().findings, null)
  assert.equal(freshPr().verifyCriteria, null)
})

const FAILED_AT = '2026-09-01T10:00:00.000Z'

test('recordFindings numbers the findings from F1 in order and replaces the earlier ones', () => {
  const entry = freshPr()

  recordFindings(entry, ['cli.mjs:40 swallows the error.', 'No test covers an empty list.'], FAILED_AT)
  recordAnswers(entry, [{ id: 'F1', action: 'It is logged at cli.mjs:42.', outcome: 'fixed' }])
  recordFindings(
    entry,
    ['README.md:3 still names the old flag.', 'The retry flag is not documented.', 'a.mjs:9 is unused.'],
    '2026-09-01T11:00:00.000Z',
  )

  assert.deepEqual(entry.findings, {
    at: '2026-09-01T11:00:00.000Z',
    items: [
      { id: 'F1', text: 'README.md:3 still names the old flag.', answer: null },
      { id: 'F2', text: 'The retry flag is not documented.', answer: null },
      { id: 'F3', text: 'a.mjs:9 is unused.', answer: null },
    ],
  })

  recordFindings(entry, [], FAILED_AT)

  assert.deepEqual(entry.findings, { at: FAILED_AT, items: [] })
})

test('recordAnswers: a later answer wins, an answer without a known outcome counts as fixed, unknown ids are ignored', () => {
  const entry = freshPr()

  recordFindings(entry, ['first', 'second', 'third'], FAILED_AT)
  recordAnswers(entry, [
    { id: 'F1', action: 'Not a defect, the brief allows it.', outcome: 'disputed' },
    { id: 'F2', action: 'Added the test.' },
    { id: 'F9', action: 'No such finding.', outcome: 'fixed' },
    { id: 'inline-7', action: 'Renamed it.' },
    { id: 'F3', action: 'Kept it.', outcome: 'disputed' },
    { id: 'F3', action: 'Removed it after all.', outcome: 'maybe' },
  ])

  recordAnswers(entry, [{ id: 'F1', action: 'Fixed in a.mjs:3 after all.', outcome: 'fixed' }])
  recordAnswers(entry, [])

  assert.deepEqual(entry.findings.items, [
    { id: 'F1', text: 'first', answer: { outcome: 'fixed', action: 'Fixed in a.mjs:3 after all.' } },
    { id: 'F2', text: 'second', answer: { outcome: 'fixed', action: 'Added the test.' } },
    { id: 'F3', text: 'third', answer: { outcome: 'fixed', action: 'Removed it after all.' } },
  ])
})

test('recordAnswers does nothing without findings', () => {
  const entry = freshPr()

  recordAnswers(entry, [{ id: 'F1', action: 'Fixed.', outcome: 'fixed' }])

  assert.equal(entry.findings, null)
})

test('recheckedFindings: each re-checked id with the text and the answer it was checked against', () => {
  const entry = freshPr()

  recordFindings(entry, ['first', 'second'], FAILED_AT)
  recordAnswers(entry, [{ id: 'F2', action: 'Not a defect.', outcome: 'disputed' }])

  assert.deepEqual(
    recheckedFindings(entry, [
      { id: 'F1', status: 'resolved', evidence: 'a.mjs:3' },
      { id: 'F2', status: 'open', evidence: 'b.mjs:9' },
      { id: 'F7', status: 'wrong', evidence: 'There is no F7.' },
    ]),
    [
      { id: 'F1', status: 'resolved', evidence: 'a.mjs:3', finding: 'first', answer: null },
      { id: 'F2', status: 'open', evidence: 'b.mjs:9', finding: 'second', answer: { outcome: 'disputed', action: 'Not a defect.' } },
      { id: 'F7', status: 'wrong', evidence: 'There is no F7.', finding: null, answer: null },
    ],
  )

  assert.deepEqual(recheckedFindings(freshPr(), [{ id: 'F1', status: 'open', evidence: 'x' }]), [
    { id: 'F1', status: 'open', evidence: 'x', finding: null, answer: null },
  ])
})

test('watchInbox wakes soon after a command is posted', async () => {
  const manifest = scratch()

  await watching(manifest, async (inbox) => {
    const started = Date.now()
    const timer = setTimeout(() => postCommand(manifest, { cmd: 'hold', id: 'A1' }), 100)

    try {
      assert.equal(await inbox.wait(10_000), 'command')
      assert.ok(Date.now() - started < 3000, `woke after ${Date.now() - started} ms`)
    } finally {
      clearTimeout(timer)
    }
  })
})

test('watchInbox times out on an empty inbox', async () => {
  await watching(scratch(), async (inbox) => {
    assert.equal(await inbox.wait(300), 'timeout')
  })
})

test('watchInbox ignores temp files and the deletions drainInbox makes', async () => {
  const manifest = scratch()

  await watching(manifest, async (inbox) => {
    postCommand(manifest, { cmd: 'release', id: 'A1' })
    drainInbox(manifest)
    writeFileSync(join(manifest.dir, 'inbox', '.1-temp.json'), '{}')
    writeFileSync(join(manifest.dir, 'inbox', 'notes.txt'), '')

    assert.equal(await inbox.wait(1_000), 'timeout')
  })
})

test('watchInbox wakes once for files left in inbox/, a burst included', async () => {
  const manifest = scratch()

  await watching(manifest, async (inbox) => {
    postCommand(manifest, { cmd: 'hold', id: 'A1' })
    postCommand(manifest, { cmd: 'hold', id: 'A2' })

    assert.equal(await inbox.wait(1_000), 'command')
    assert.equal(await inbox.wait(1_000), 'timeout')

    postCommand(manifest, { cmd: 'release', id: 'A1' })
    assert.equal(await inbox.wait(1_000), 'command')
  })
})

test('watchInbox: close resolves a pending wait', async () => {
  const inbox = watchInbox(scratch(), { settleMs: 50 })
  const pending = inbox.wait(10_000)

  inbox.close()
  assert.equal(await pending, 'timeout')
})

test('watchInbox never throws: without an inbox it only times out', async () => {
  await watching(unusable(), async (inbox) => {
    assert.equal(await inbox.wait(200), 'timeout')
  })
})

test('lockHolder: a lock with pid 0 or -1 names no driver, and acquireLock takes it over', () => {
  for (const pid of [0, -1, '0', '-1']) {
    const manifest = scratch()
    writeLock(manifest, pid)

    assert.equal(lockHolder(manifest), null, `pid ${pid}`)
    assert.equal(liveness(manifest).running, false, `pid ${pid}`)

    const release = acquireLock(manifest)

    try {
      assert.equal(JSON.parse(readFileSync(join(manifest.dir, 'driver.lock'), 'utf8')).pid, process.pid, `pid ${pid}`)
    } finally {
      release()
    }
  }
})

test('lockHolder: a lock naming a live process holds, and acquireLock refuses it', () => {
  const manifest = scratch()
  writeLock(manifest, process.pid)

  assert.equal(lockHolder(manifest).pid, process.pid)
  assert.throws(() => acquireLock(manifest), /already running/)
})

test('drainInbox skips a directory named like a command, and watchInbox never wakes for it', async () => {
  const manifest = scratch()
  const folder = join(manifest.dir, 'inbox', 'x.json')

  mkdirSync(folder, { recursive: true })
  postCommand(manifest, { cmd: 'hold', id: 'A1' })

  assert.deepEqual(withoutAt(drainInbox(manifest)), [{ cmd: 'hold', id: 'A1' }])
  assert.deepEqual(drainInbox(manifest), [])
  assert.ok(existsSync(folder))

  await watching(manifest, async (inbox) => {
    assert.equal(await inbox.wait(300), 'timeout')
  })
})

test('drainInbox without an inbox returns nothing', () => {
  assert.deepEqual(drainInbox(scratch()), [])
})

test(
  'drainInbox rejects a file it cannot delete instead of returning its command',
  { skip: process.getuid?.() === 0 || process.platform === 'win32' ? 'root and Windows delete it anyway' : false },
  (context) => {
    const manifest = scratch()
    const inbox = join(manifest.dir, 'inbox')
    const name = postCommand(manifest, { cmd: 'retry', id: 'A1' })

    chmodSync(inbox, 0o555)
    context.after(() => chmodSync(inbox, 0o755))

    const commands = drainInbox(manifest)

    assert.equal(commands.length, 1)
    assert.equal(commands[0].cmd, 'invalid')
    assert.equal(commands[0].file, name)
    assert.match(commands[0].error, /^cannot delete it: /)
    assert.ok(existsSync(join(inbox, name)))
  },
)

function stored(manifest) {
  return JSON.parse(readFileSync(join(manifest.dir, 'ledger.json'), 'utf8'))
}

function withLedger(ledger) {
  const dir = makeRollout()
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify(ledger))

  return loadManifest(dir)
}

test('openLedger migrates a version 1 ledger once: version 2 with the runs of its events, also on disk', () => {
  const manifest = loadManifest(makeRollout({ legacy: true }))
  const { data } = openLedger(manifest)

  assert.equal(LEDGER_VERSION, 2)
  assert.equal(data.version, 2)
  assert.deepEqual(runsFromLedger(data), runsFromEvents(readEvents(manifest)))
  assert.equal(stored(manifest).version, 2)
  assert.deepEqual(stored(manifest).runs, data.runs)

  const late = { at: at(90), id: 'A3', kind: 'implement-start', run: 'A3-01-implement', log: 'logs/A3-01-implement.jsonl' }
  appendFileSync(join(manifest.dir, 'events.jsonl'), '\n' + JSON.stringify(late) + '\n')

  assert.equal(readEvents(manifest).at(-1).run, 'A3-01-implement')
  assert.deepEqual(openLedger(manifest).data.runs, data.runs)
})

test('openLedger: a version 1 ledger without events migrates to no runs, and one without a file starts at version 2 and writes nothing', () => {
  const legacy = loadManifest(makeRollout({ legacy: true, events: null }))

  assert.deepEqual(openLedger(legacy).data.runs, {})

  const fresh = loadManifest(makeRollout({ prs: null }))
  const { data } = openLedger(fresh)

  assert.equal(data.version, 2)
  assert.deepEqual(data.runs, {})
  assert.deepEqual(Object.keys(data.prs), ['A1', 'A2', 'A3'])
  assert.equal(data.hold, null)
  assert.equal(Object.hasOwn(data, 'paused'), false)
  assert.equal(existsSync(join(fresh.dir, 'ledger.json')), false)
})

test('openLedger turns a stored paused true into a hold by the maintainer, removes the key and saves both', () => {
  const manifest = withLedger({ version: 2, prs: {}, runs: {}, paused: true })
  const before = Date.now()
  const { data } = openLedger(manifest)

  assert.equal(Object.hasOwn(data, 'paused'), false)
  assert.deepEqual(data.hold, { at: data.hold.at, by: 'maintainer', reason: null })
  assert.ok(Date.parse(data.hold.at) >= before - 1000, data.hold.at)
  assert.equal(Object.hasOwn(stored(manifest), 'paused'), false)
  assert.deepEqual(stored(manifest).hold, data.hold)
})

test('openLedger: a stored paused false becomes no hold and no key, also from before versions, and a stored hold stays', () => {
  for (const manifest of [withLedger({ version: 2, prs: {}, runs: {}, paused: false }), loadManifest(makeRollout({ legacy: true }))]) {
    const { data } = openLedger(manifest)

    assert.equal(data.hold, null)
    assert.equal(Object.hasOwn(data, 'paused'), false)
    assert.equal(stored(manifest).hold, null)
    assert.equal(Object.hasOwn(stored(manifest), 'paused'), false)
  }

  const hold = { at: at(5), by: 'driver', reason: 'usage limit reached' }
  const held = withLedger({ version: 2, prs: {}, runs: {}, hold, paused: true })

  assert.deepEqual(openLedger(held).data.hold, hold)
  assert.deepEqual(stored(held).hold, hold)
  assert.equal(Object.hasOwn(stored(held), 'paused'), false)
})

test('openLedger and the view read a PR hold from before authors as one the maintainer set', () => {
  const manifest = loadManifest(makeRollout())

  assert.deepEqual(readLedger(manifest).prs.A1.held, { at: at(81) })
  assert.deepEqual(prDetail(manifest, readLedger(manifest), [], [], 'A1').held, { at: at(81), by: 'maintainer', reason: null })

  const { prs } = openLedger(manifest)

  assert.deepEqual(prs.A1.held, { at: at(81), by: 'maintainer', reason: null })
  assert.equal(prs.A2.held, null)

  const byDriver = { at: at(5), by: 'driver', reason: 'usage limit reached' }

  assert.deepEqual(withDefaults({ held: byDriver }).held, byDriver)
  assert.equal(withDefaults({ held: null }).held, null)
  assert.equal(withDefaults({}).held, null)
})

test('MIGRATIONS: the step from 1 to 2 is pure, fills the defaults of every entry and stamps nothing', () => {
  const [step] = MIGRATIONS
  const events = readEvents(loadManifest(makeRollout()))
  const note = { at: at(10), by: 'maintainer', kind: 'needs-decision', question: 'Which API?', text: 'the old one' }
  const data = {
    prs: {
      A1: { state: 'blocked', blocked: { kind: 'needs-decision', question: 'Which API?', evidence: '' }, noteHistory: [note] },
      Z9: { state: 'escalated', escalation: 'fix attempts exhausted', delegate: { runs: 1 } },
    },
    paused: true,
    halted: null,
    lastMerge: { id: 'A1', sha: 'feedface', at: at(5) },
  }

  const before = structuredClone(data)
  const migrated = step.apply(data, { events })

  assert.deepEqual([step.from, step.to], [1, 2])
  assert.deepEqual(data, before)
  assert.equal(migrated.version, 2)
  assert.deepEqual(migrated.runs, runRecords(events))
  assert.equal(migrated.paused, true)
  assert.deepEqual(migrated.lastMerge, before.lastMerge)
  assert.deepEqual(migrated.prs.Z9.delegate, { runs: 1, lastQuestion: null, limitNotified: false, answers: [] })
  assert.deepEqual(migrated.prs.Z9, withDefaults(before.prs.Z9))
  assert.equal(migrated.prs.Z9.escalatedAt, null)
  assert.deepEqual(migrated.prs.A1.blocked, before.prs.A1.blocked)
  assert.deepEqual(migrated.prs.A1.noteHistory, [note])

  migrated.prs.A1.noteHistory[0].run = 'A1-02-fix'
  assert.deepEqual(data, before, 'the result shares nothing with its input')
})

test('migrate: a ledger at the current version comes back as it is', () => {
  const manifest = loadManifest(makeRollout())
  const data = stored(manifest)

  assert.equal(migrate(data, manifest), data)
})

test('openLedger and readLedger refuse a ledger a newer driver wrote, and change nothing', () => {
  const manifest = withLedger({ version: 99, prs: {}, runs: {}, paused: false, halted: null })
  const file = join(manifest.dir, 'ledger.json')
  const before = readFileSync(file)

  assert.throws(() => openLedger(manifest), /newer driver/)
  assert.throws(() => readLedger(manifest), /newer driver/)
  assert.throws(() => migrate(stored(manifest), manifest), /newer driver/)
  assert.throws(() => readLedger(manifest), {
    message: /^ledger\.json is version 99, written by a newer driver than this one \(version 2\)\./,
  })

  assert.deepEqual(readFileSync(file), before)
  assert.equal(existsSync(join(manifest.dir, 'inbox')), false)
})

test('openLedger and readLedger refuse a version that is not a positive integer', () => {
  for (const version of ['two', 0, 1.5, null]) {
    const manifest = withLedger({ version, prs: {}, paused: false, halted: null })

    assert.throws(() => openLedger(manifest), /invalid version/, String(version))
    assert.throws(() => readLedger(manifest), /invalid version/, String(version))
  }
})

test('readLedger returns a version 1 ledger as stored', () => {
  const manifest = loadManifest(makeRollout({ legacy: true }))
  const before = readFileSync(join(manifest.dir, 'ledger.json'), 'utf8')

  assert.deepEqual(readLedger(manifest), JSON.parse(before))
  assert.equal(readFileSync(join(manifest.dir, 'ledger.json'), 'utf8'), before)
})

test('startRun and endRun write the record of one run, and endRun without a start creates one', () => {
  const data = {}

  startRun(data, { run: 'A1-01-implement', id: 'A1', role: 'implement', effort: 'high', model: 'sonnet' }, at(0))

  assert.deepEqual(data.runs['A1-01-implement'], {
    id: 'A1',
    role: 'implement',
    step: null,
    reason: null,
    startedAt: at(0),
    endedAt: null,
    effort: 'high',
    model: null,
    requestedModel: 'sonnet',
    resume: false,
    log: 'logs/A1-01-implement.jsonl',
    ok: null,
    result: null,
    costUsd: null,
    seconds: null,
    awakeSeconds: null,
    denials: null,
    stopped: false,
    error: null,
  })

  const result = {
    ok: true,
    model: 'claude-sonnet-5-5',
    output: { status: 'READY' },
    costUsd: 2.5,
    seconds: 600,
    awakeSeconds: 540,
    denials: [{ tool_name: 'Bash' }],
  }

  endRun(data, { id: 'A1', role: 'implement' }, doneDetail('implement', 'A1-01-implement', result), at(10))

  assert.deepEqual(data.runs['A1-01-implement'], {
    id: 'A1',
    role: 'implement',
    step: null,
    reason: null,
    startedAt: at(0),
    endedAt: at(10),
    effort: 'high',
    model: 'claude-sonnet-5-5',
    requestedModel: 'sonnet',
    resume: false,
    log: 'logs/A1-01-implement.jsonl',
    ok: true,
    result: 'READY',
    costUsd: 2.5,
    seconds: 600,
    awakeSeconds: 540,
    denials: 1,
    stopped: false,
    error: null,
  })

  const stopped = { ok: false, costUsd: 0, seconds: 3, stopped: true, error: 'driver stopping' }
  endRun(
    data,
    { id: 'A2', role: 'brief', step: 'review' },
    { ...doneDetail('brief', 'A2-01-brief-review', stopped), step: 'review' },
    at(20),
  )

  assert.deepEqual(data.runs['A2-01-brief-review'], {
    id: 'A2',
    role: 'brief',
    step: 'review',
    reason: null,
    startedAt: null,
    endedAt: at(20),
    effort: null,
    model: null,
    requestedModel: null,
    resume: null,
    log: 'logs/A2-01-brief-review.jsonl',
    ok: false,
    result: null,
    costUsd: 0,
    seconds: 3,
    awakeSeconds: null,
    denials: 0,
    stopped: true,
    error: 'driver stopping',
  })

  assert.deepEqual(Object.keys(data.runs), ['A1-01-implement', 'A2-01-brief-review'])
})

test('startRun and endRun change nothing without a run name', () => {
  const data = {}

  startRun(data, { run: '', id: 'A1', role: 'implement' })
  endRun(data, { id: 'A1', role: 'implement' }, doneDetail('implement', null, { ok: false, costUsd: 0 }))

  assert.deepEqual(data, {})
})

test('save replaces ledger.json, so a reader that opened the old file still reads all of it', () => {
  const manifest = loadManifest(makeRollout())
  const ledger = openLedger(manifest)
  const path = join(manifest.dir, 'ledger.json')
  const before = readFileSync(path, 'utf8')
  const reader = openSync(path, 'r')

  try {
    ledger.data.hold = { at: at(5), by: 'maintainer', reason: null }
    ledger.save()

    assert.equal(readFileSync(reader, 'utf8'), before)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).hold.by, 'maintainer')
  } finally {
    closeSync(reader)
  }
})

test('openLedger stops the runs a driver that is gone left open, and saves that', () => {
  const manifest = loadManifest(makeRollout())

  assert.equal(stored(manifest).runs['A2-01-implement'].stopped, false)

  const { data } = openLedger(manifest)

  assert.equal(data.runs['A2-01-implement'].stopped, true)
  assert.equal(data.runs['A1-01-implement'].stopped, false)
  assert.equal(stored(manifest).runs['A2-01-implement'].stopped, true)
  assert.equal(runsFromLedger(data, { driverRunning: true }).at(-1).status, 'interrupted')
})

test('openLedger drops a halt an older driver stored, and saves that', () => {
  const manifest = withLedger({ version: 2, prs: {}, runs: {}, paused: false, halted: 'main is red' })
  const { data } = openLedger(manifest)

  assert.equal(Object.hasOwn(data, 'halted'), false)
  assert.equal(Object.hasOwn(stored(manifest), 'halted'), false)
  assert.equal(stored(manifest).version, 2)
})

test('tickNote and parseTickNote: the numbers of a tick make the round trip, with - for no rate limit, and other notes parse to null', () => {
  const measured = { ms: 4210, requests: 7, cached: 5, remaining: 4870 }
  const unlimited = { ...measured, remaining: null }

  assert.equal(tickNote(measured), 'tick 4210 requests=7 cached=5 remaining=4870')
  assert.equal(tickNote(unlimited), 'tick 4210 requests=7 cached=5 remaining=-')
  assert.deepEqual(parseTickNote(tickNote(measured)), measured)
  assert.deepEqual(parseTickNote(tickNote(unlimited)), unlimited)

  for (const note of [
    'tick',
    'tick-error boom',
    '',
    'tick 4210 requests=7 cached=5',
    'tick 4210 requests=7 cached=5 remaining=4870 extra',
  ]) {
    assert.equal(parseTickNote(note), null, note)
  }
})

test('beat: a save keeps the note of the last beat, and a new ledger starts without one', () => {
  const manifest = loadManifest(makeRollout({ heartbeat: null }))
  const heartbeat = () => readFileSync(join(manifest.dir, 'heartbeat'), 'utf8')
  const ledger = openLedger(manifest)

  ledger.save()

  assert.match(heartbeat(), /^\S+$/)

  ledger.beat('x')
  ledger.save()

  assert.match(heartbeat(), /^\S+ x$/)

  ledger.beat()

  assert.match(heartbeat(), /^\S+ x$/)

  openLedger(manifest).save()

  assert.match(heartbeat(), /^\S+$/)
})
