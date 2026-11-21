import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  recordProcess,
  recordVerdict,
  reserveRunName,
  startRun,
  tickNote,
  versionTwoPr,
  watchInbox,
  withDefaults,
} from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { runRecords, runsFromEvents, runsFromLedger } from '../lib/runs.mjs'
import { stateOf } from '../lib/transitions.ts'
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
  assert.equal(freshPr().hold, null)
  assert.deepEqual(freshPr().verdicts, [])
  assert.deepEqual(freshPr().feedbackHandled, [])
  assert.equal(freshPr().findings, null)
  assert.equal(freshPr().verifyCriteria, null)
})

test('freshPr has no pass of the commands, and an entry from before it opens with none, the version kept', () => {
  const manifest = loadManifest(makeRollout({ prs: { A1: { state: 'ready_claimed', pr: 11, claimedSha: 'a1a1a1a' } } }))
  const file = join(manifest.dir, 'ledger.json')
  const older = JSON.parse(readFileSync(file, 'utf8'))

  delete older.prs.A1.commands
  writeFileSync(file, JSON.stringify(older))

  assert.equal(freshPr().commands, null)
  assert.equal(Object.hasOwn(readLedger(manifest).prs.A1, 'commands'), false)
  assert.equal(older.version, LEDGER_VERSION)
  assert.equal(LEDGER_VERSION, 3)
  assert.equal(openLedger(manifest).prs.A1.commands, null)
  assert.equal(withDefaults({}).commands, null)
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

test('openLedger migrates a version 1 ledger once: version 3 with the runs of its events, also on disk', () => {
  const manifest = loadManifest(makeRollout({ legacy: true }))
  const { data } = openLedger(manifest)

  assert.equal(LEDGER_VERSION, 3)
  assert.equal(data.version, 3)
  assert.deepEqual(runsFromLedger(data), runsFromEvents(readEvents(manifest)))
  assert.equal(stored(manifest).version, 3)
  assert.deepEqual(stored(manifest).runs, data.runs)

  const late = { at: at(90), id: 'A3', kind: 'implement-start', run: 'A3-01-implement', log: 'logs/A3-01-implement.jsonl' }
  appendFileSync(join(manifest.dir, 'events.jsonl'), '\n' + JSON.stringify(late) + '\n')

  assert.equal(readEvents(manifest).at(-1).run, 'A3-01-implement')
  assert.deepEqual(openLedger(manifest).data.runs, data.runs)
})

test('openLedger: a version 1 ledger without events migrates to no runs, and one without a file starts at version 3 and writes nothing', () => {
  const legacy = loadManifest(makeRollout({ legacy: true, events: null }))

  assert.deepEqual(openLedger(legacy).data.runs, {})

  const fresh = loadManifest(makeRollout({ prs: null }))
  const { data } = openLedger(fresh)

  assert.equal(data.version, 3)
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
  const manifest = loadManifest(makeRollout({ legacy: true }))

  assert.deepEqual(readLedger(manifest).prs.A1.held, { at: at(81) })
  assert.deepEqual(prDetail(manifest, readLedger(manifest), [], [], 'A1').hold, { at: at(81), by: 'maintainer', reason: null })

  const { prs } = openLedger(manifest)

  assert.deepEqual(prs.A1.hold, { at: at(81), by: 'maintainer', reason: null })
  assert.equal(prs.A2.hold, null)

  const byDriver = { at: at(5), by: 'driver', reason: 'usage limit reached' }

  assert.deepEqual(withDefaults({ hold: byDriver }).hold, byDriver)
  assert.equal(withDefaults({ hold: null }).hold, null)
  assert.equal(withDefaults({}).hold, null)
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
  assert.deepEqual(migrated.prs.Z9, { ...versionTwoPr(), ...before.prs.Z9, delegate: migrated.prs.Z9.delegate })
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
    message: /^ledger\.json is version 99, written by a newer driver than this one \(version 3\)\./,
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

test('recordProcess sets the process of an open run, and leaves an ended run and a missing one alone', () => {
  const data = {}
  const recorded = { pid: 4242, startTime: 'Tue Sep  1 10:00:00 2026' }

  startRun(data, { run: 'A1-01-implement', id: 'A1', role: 'implement' }, at(0))
  startRun(data, { run: 'A1-02-verify', id: 'A1', role: 'verify' }, at(1))
  endRun(data, { id: 'A1', role: 'verify' }, doneDetail('verify', 'A1-02-verify', { ok: true, costUsd: 1 }), at(2))

  const ended = structuredClone(data.runs['A1-02-verify'])

  recordProcess(data, 'A1-01-implement', recorded)
  recordProcess(data, 'A1-02-verify', { container: 'rollout-demo-A1-02-verify' })
  recordProcess(data, 'A1-03-fix', recorded)

  assert.deepEqual(data.runs['A1-01-implement'].process, recorded)
  assert.deepEqual(data.runs['A1-02-verify'], ended)
  assert.deepEqual(Object.keys(data.runs), ['A1-01-implement', 'A1-02-verify'])

  endRun(data, { id: 'A1', role: 'implement' }, doneDetail('implement', 'A1-01-implement', { ok: true, costUsd: 1 }), at(3))

  assert.deepEqual(data.runs['A1-01-implement'].process, recorded)
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
  assert.equal(stored(manifest).version, 3)
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

const HEAD = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const CLAIM = { pr: 11, claimedSha: HEAD }
const VERIFICATION = { sha: HEAD, patchId: 'patch-a1', at: at(80) }
const SLOT = { kind: 'waiting', code: 'slot' }

function brief(kind, run = 'A1-02-fix') {
  return { kind, question: 'Which API?', evidence: 'one\ntwo', run }
}

function asked(kind, run = 'A1-02-fix') {
  return { kind, text: 'Which API?', evidence: 'one\ntwo', run, delegate: null }
}

function runOf(role, startedAt, step = null) {
  return { id: 'A1', role, step, startedAt }
}

const RUNS = {
  'A1-01-brief-write': runOf('brief', at(1), 'write'),
  'A1-01-brief-review': runOf('brief', at(10), 'review'),
  'A1-02-implement': runOf('implement', at(30)),
  'A1-01-implement': runOf('implement', at(20)),
  'A1-03-fix': runOf('fix', at(40)),
  'A1-04-verify': runOf('verify', at(50)),
  'A2-01-implement': { ...runOf('implement', at(60)), id: 'A2' },
}

// One row per row of the migration's table: the version 2 entry, how the
// rollout looks, and the stage, status (without its time) and fix the open fills in.
const FILL_ROWS = [
  ['pending with no brief file', { state: 'pending' }, {}, ['brief', SLOT, null]],
  ['pending with a brief written', { state: 'pending' }, { brief: true }, ['implement', SLOT, null]],
  [
    'briefing, by the step of the last brief run',
    { state: 'briefing' },
    {},
    ['brief', { kind: 'running', code: 'brief-review', run: 'A1-01-brief-review' }, null],
  ],
  ['implementing', { state: 'implementing' }, {}, ['implement', { kind: 'running', code: 'implement', run: 'A1-02-implement' }, null]],
  [
    'fixing',
    { state: 'fixing', pr: 11, fixReason: 'CI is red', fixNote: 'test fails' },
    {},
    ['implement', { kind: 'running', code: 'fix', reason: 'ci-red', run: 'A1-03-fix' }, { reason: 'ci-red', note: 'test fails' }],
  ],
  [
    'needs_fix',
    { state: 'needs_fix', pr: 11, fixReason: 'out of scope', fixNote: 'revert' },
    {},
    ['implement', SLOT, { reason: 'scope', note: 'revert' }],
  ],
  [
    'ready_claimed',
    { state: 'ready_claimed', ...CLAIM },
    {},
    ['pre-verify', { kind: 'waiting', code: 'ci', sha: HEAD, missing: [], pending: [] }, null],
  ],
  [
    'verifying',
    { state: 'verifying', ...CLAIM },
    {},
    ['verify', { kind: 'running', code: 'verify', sha: HEAD, run: 'A1-04-verify' }, null],
  ],
  [
    'verified, with no verdict of the gate since the verification, from its time',
    { state: 'verified', ...CLAIM, verified: VERIFICATION },
    { since: VERIFICATION.at },
    ['merge', { kind: 'waiting', code: 'gate-pending' }, null],
  ],
  [
    'blocked on brief questions',
    { state: 'blocked', blocked: brief('brief-questions', 'A1-01-brief-review') },
    {},
    ['brief', { kind: 'needs-you', code: 'brief-questions', question: asked('brief-questions', 'A1-01-brief-review') }, null],
  ],
  [
    'blocked on a decision',
    { state: 'blocked', pr: 11, blocked: brief('brief-contradiction') },
    {},
    ['implement', { kind: 'needs-you', code: 'decision', question: asked('brief-contradiction') }, null],
  ],
  [
    'blocked on an obstacle',
    { state: 'blocked', pr: 11, blocked: brief('code-scanning') },
    {},
    ['implement', { kind: 'needs-you', code: 'obstacle', question: asked('code-scanning') }, null],
  ],
  [
    'blocked by the gate',
    {
      state: 'blocked',
      ...CLAIM,
      blocked: { kind: 'gate', question: 'PR is a draft', evidence: '', run: null },
      gate: { action: 'block', code: 'draft', reasons: ['PR is a draft'], at: at(85) },
    },
    {},
    ['merge', { kind: 'needs-you', code: 'gate-blocked', gate: 'draft', reasons: ['PR is a draft'] }, null],
  ],
  [
    'blocked on the driver code scanning alerts',
    { state: 'blocked', ...CLAIM, blocked: brief('code-scanning', null) },
    {},
    ['pre-verify', { kind: 'needs-you', code: 'code-scanning-alerts', alerts: ['one', 'two'] }, null],
  ],
  [
    'blocked on a closed PR',
    { state: 'blocked', ...CLAIM, blocked: { kind: 'closed', question: 'PR #11 was closed.', evidence: '', run: null } },
    {},
    ['pre-verify', { kind: 'needs-you', code: 'closed' }, null],
  ],
  [
    'escalated out of attempts',
    {
      state: 'escalated',
      pr: 11,
      escalation: 'fix attempts exhausted',
      attempts: { implement: 1, fix: 4, verify: 0, brief: 0 },
      fixReason: 'CI is red',
      fixNote: 'still red',
    },
    {},
    ['implement', { kind: 'needs-you', code: 'attempts-exhausted', role: 'fix', limit: 4 }, { reason: 'ci-red', note: 'still red' }],
  ],
  [
    'escalated over a dispute',
    { state: 'escalated', ...CLAIM, escalation: 'disputed finding', lastError: 'F1 still open' },
    {},
    ['verify', { kind: 'needs-you', code: 'dispute', findings: [], text: 'F1 still open' }, null],
  ],
  [
    'escalated for errors',
    { state: 'escalated', ...CLAIM, escalation: 'repeated errors', lastError: 'boom', tickErrors: 5 },
    {},
    ['pre-verify', { kind: 'needs-you', code: 'errors', error: 'boom', count: 5 }, null],
  ],
  ['interrupted verifier', { state: 'interrupted', ...CLAIM, interruptedRole: 'verify' }, {}, ['verify', SLOT, null]],
  [
    'interrupted with a parked READY report',
    { state: 'interrupted', interruptedRole: 'report', ready: { status: 'READY', pr: 11, headSha: HEAD } },
    {},
    ['pre-verify', { kind: 'waiting', code: 'github' }, null],
  ],
  [
    'interrupted implementer',
    { state: 'interrupted', pr: 11, interruptedRole: 'fix' },
    {},
    ['implement', SLOT, { reason: 'no-report', note: '' }],
  ],
  ['merged', { state: 'merged', pr: 11 }, {}, ['merged', null, null]],
]

// The fields version 3 removed.
const REMOVED = ['state', 'interruptedRole', 'blocked', 'escalation', 'escalatedAt', 'held']

// A raw version 2 ledger with A1 as an older driver wrote it, opened as the driver opens it.
function openedA1(fields, { brief: written = false, runs = RUNS } = {}) {
  const manifest = withLedger({ version: 2, prs: { A1: fields }, runs, hold: null })

  if (written) {
    const path = manifest.all.find((pr) => pr.id === 'A1').brief

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# A1\n')
  }

  return { manifest, entry: openLedger(manifest).prs.A1 }
}

function untimed(value) {
  if (!value) {
    return value
  }

  const { since: _, ...rest } = value

  return rest
}

// A row's `since` names the time the migration takes in place of the time of the open.
for (const [name, fields, rollout, [stage, status, fix]] of FILL_ROWS) {
  test(`openLedger migrates a version 2 entry to version 3: ${name}`, () => {
    const before = Date.now()
    const { manifest, entry } = openedA1(fields, rollout)

    assert.deepEqual([entry.stage, untimed(entry.status), untimed(entry.fix)], [stage, status, fix])
    assert.deepEqual(
      REMOVED.filter((key) => Object.hasOwn(entry, key)),
      [],
    )

    assert.equal(stored(manifest).version, 3)

    for (const stamped of [entry.status, entry.fix].filter(Boolean)) {
      if (rollout.since) {
        assert.equal(stamped.since, rollout.since)
      } else {
        assert.ok(Date.parse(stamped.since) >= before - 1000, stamped.since)
      }
    }
  })
}

test('openLedger: stateOf of every migrated row gives back the stored state', () => {
  for (const [name, fields, rollout] of FILL_ROWS) {
    const { entry } = openedA1(fields, rollout)

    assert.equal(stateOf(entry), fields.state, name)
  }
})

test('openLedger fills the other cases of a run, a block, an escalation and an interruption', () => {
  const errors = { kind: 'needs-you', code: 'errors', error: '', count: 0 }
  const rows = [
    [{ state: 'fixing', pr: 11 }, 'implement', { kind: 'running', code: 'fix', reason: 'no-report', run: 'A1-03-fix' }],
    [{ state: 'blocked', pr: 11, blocked: brief('stuck') }, 'implement', { kind: 'needs-you', code: 'obstacle', question: asked('stuck') }],
    [
      { state: 'blocked', blocked: brief('a kind no schema has') },
      'implement',
      { kind: 'needs-you', code: 'decision', question: asked('unknown') },
    ],
    [
      { state: 'blocked' },
      'implement',
      { kind: 'needs-you', code: 'decision', question: { ...asked('unknown', null), text: '', evidence: '' } },
    ],
    [
      { state: 'blocked', ...CLAIM, blocked: { kind: 'gate', question: 'no PR found', evidence: '', run: null } },
      'merge',
      { kind: 'needs-you', code: 'gate-blocked', gate: 'no-pr', reasons: ['no PR found'] },
    ],
    [
      { state: 'blocked', ...CLAIM, verified: VERIFICATION, blocked: brief('code-scanning', null) },
      'merge',
      { kind: 'needs-you', code: 'code-scanning-alerts', alerts: ['one', 'two'] },
    ],
    [
      { state: 'blocked', pr: 11, blocked: { kind: 'closed', question: 'closed', evidence: '', run: null } },
      'implement',
      { kind: 'needs-you', code: 'closed' },
    ],
    [
      { state: 'escalated', escalation: 'brief attempts exhausted', attempts: { brief: 2 } },
      'brief',
      { kind: 'needs-you', code: 'attempts-exhausted', role: 'brief', limit: 2 },
    ],
    [{ state: 'escalated', ...CLAIM, verified: VERIFICATION, escalation: 'repeated errors' }, 'merge', errors],
    [{ state: 'escalated', sessionId: 'session-1' }, 'implement', errors],
    [{ state: 'escalated' }, 'brief', errors],
    [{ state: 'interrupted', interruptedRole: 'verify' }, 'implement', SLOT],
  ]

  for (const [fields, stage, status] of rows) {
    const { entry } = openedA1(fields)

    assert.deepEqual([entry.stage, untimed(entry.status)], [stage, status], JSON.stringify(fields))
    assert.equal(stateOf(entry), fields.state, JSON.stringify(fields))
  }

  const { entry: writer } = openedA1({ state: 'briefing' }, { runs: {} })

  assert.deepEqual(writer.status, { kind: 'running', code: 'brief-write', run: '', since: writer.status.since })
})

test('openLedger: a held PR waits as held, one in back-off waits it out, and a hold gets its author', () => {
  const later = new Date(Date.now() + 10 * 60_000).toISOString()
  const held = openedA1({ state: 'ready_claimed', ...CLAIM, held: { at: at(5) } }).entry

  assert.deepEqual(untimed(held.status), { kind: 'waiting', code: 'held', scope: 'pr' })
  assert.deepEqual(held.hold, { at: at(5), by: 'maintainer', reason: null })
  assert.equal(stateOf(held), 'ready_claimed')

  const resting = openedA1({ state: 'needs_fix', pr: 11, retryAfter: later, failStreak: 3 }).entry

  assert.deepEqual(untimed(resting.status), { kind: 'waiting', code: 'backoff', until: later, failures: 3 })

  const running = openedA1({ state: 'implementing', held: { at: at(5), by: 'driver', reason: 'limit' } }).entry

  assert.equal(running.status.kind, 'running')
  assert.deepEqual(running.hold, { at: at(5), by: 'driver', reason: 'limit' })
})

test('openLedger: on merge a current verdict of the gate decides the status from its time, an older one leaves gate-pending', () => {
  const verdict = { action: 'wait', code: 'ci-pending', reasons: ['CI pending'], mergeState: 'CLEAN', sha: HEAD }
  const current = openedA1({ state: 'verified', ...CLAIM, verified: VERIFICATION, gate: { ...verdict, at: at(85) } }).entry
  const older = openedA1({ state: 'verified', ...CLAIM, verified: VERIFICATION, gate: { ...verdict, at: at(70) } }).entry

  assert.deepEqual(current.status, { kind: 'waiting', code: 'ci', sha: HEAD, missing: [], pending: [], since: at(85) })
  assert.deepEqual(older.status, { kind: 'waiting', code: 'gate-pending', since: at(80) })
})

test('openLedger: on merge only the verdicts with a status of their own count, a stored held only while held', () => {
  const statusOn = (gate, fields = {}) =>
    openedA1({
      state: 'verified',
      ...CLAIM,
      verified: VERIFICATION,
      gate: { mergeState: 'BLOCKED', sha: HEAD, at: at(85), ...gate },
      ...fields,
    }).entry.status

  const heldPr = { kind: 'waiting', code: 'held', scope: 'pr' }
  const cases = [
    [
      { action: 'ready', code: 'ready', reasons: [] },
      { kind: 'needs-you', code: 'merge-by-hand', mergeState: 'BLOCKED' },
    ],
    [
      { action: 'wait', code: 'merge-refused', reasons: ['GitHub refused the merge (ruleset)'] },
      { kind: 'needs-you', code: 'merge-refused', error: 'GitHub refused the merge (ruleset)' },
    ],
    [
      { action: 'wait', code: 'queued', reasons: [], after: 12 },
      { kind: 'waiting', code: 'queued', after: 12 },
    ],
    [
      { action: 'wait', code: 'base-red', reasons: [] },
      { kind: 'waiting', code: 'base-red', sha: '', failing: [] },
    ],
    [
      { action: 'wait', code: 'stale-github-review', reasons: [] },
      { kind: 'needs-you', code: 'review', stale: true },
    ],
    [
      { action: 'merge', code: 'merge', reasons: [] },
      { kind: 'waiting', code: 'gate-pending' },
    ],
    [
      { action: 'wait', code: 'merged-on-github', reasons: [] },
      { kind: 'waiting', code: 'gate-pending' },
    ],
    [
      { action: 'wait', code: 'held', reasons: [] },
      { kind: 'waiting', code: 'gate-pending' },
    ],
  ]

  for (const [gate, status] of cases) {
    assert.deepEqual(untimed(statusOn(gate)), status, gate.code)
  }

  for (const code of ['held', 'ci-pending']) {
    assert.deepEqual(untimed(statusOn({ action: 'wait', code, reasons: [] }, { held: { at: at(83) } })), heldPr, code)
  }
})

test('the migration from version 2 fills an entry again when its stage disagrees with its state or its hold with held, and keeps one that agrees', () => {
  const manifest = loadManifest(makeRollout({ prs: { A1: { state: 'ready_claimed', ...CLAIM }, A2: { state: 'needs_fix', pr: 12 } } }))
  const ledger = openLedger(manifest)
  const older = structuredClone(ledger.data)

  older.version = 2
  older.prs.A1.state = 'verifying'
  older.prs.A2.state = 'needs_fix'
  older.prs.A2.held = { at: at(5), by: 'maintainer', reason: null }
  older.prs.A3.state = 'pending'

  const kept = structuredClone(ledger.prs.A3)

  writeFileSync(join(manifest.dir, 'ledger.json'), JSON.stringify(older))

  const reopened = openLedger(manifest).prs

  assert.deepEqual([reopened.A1.stage, reopened.A1.status.code], ['verify', 'verify'])
  assert.deepEqual([reopened.A2.status.code, reopened.A2.hold], ['held', { at: at(5), by: 'maintainer', reason: null }])
  assert.deepEqual(reopened.A3, kept)
})

test('openLedger: a version 2 ledger it migrated and saved says version 3', () => {
  const manifest = withLedger({ version: 2, prs: { A1: { state: 'needs_fix', pr: 11 } }, runs: {}, hold: null })
  const ledger = openLedger(manifest)

  ledger.save()

  assert.equal(stored(manifest).version, 3)
  assert.equal(stored(manifest).prs.A1.stage, 'implement')
  assert.match(readFileSync(join(manifest.dir, 'ledger.json'), 'utf8'), /^\{\n {2}"version": 3,/)
})

test('openLedger migrates a version 2 ledger: a held PR gets a hold by the maintainer, paused becomes the rollout hold, and halted goes', () => {
  const manifest = withLedger({
    version: 2,
    prs: { A1: { state: 'ready_claimed', ...CLAIM, held: { at: at(5) } } },
    runs: {},
    paused: true,
    halted: 'main is red',
  })

  const { data, prs } = openLedger(manifest)

  assert.deepEqual(prs.A1.hold, { at: at(5), by: 'maintainer', reason: null })
  assert.equal(Object.hasOwn(prs.A1, 'held'), false)
  assert.deepEqual(untimed(prs.A1.status), { kind: 'waiting', code: 'held', scope: 'pr' })
  assert.deepEqual(data.hold, { at: data.hold.at, by: 'maintainer', reason: null })
  assert.deepEqual([Object.hasOwn(data, 'paused'), Object.hasOwn(data, 'halted')], [false, false])
  assert.equal(stored(manifest).version, 3)
  assert.deepEqual(stored(manifest).prs.A1.hold, prs.A1.hold)
})

test('openLedger migrates a version 1 ledger: a pending PR whose brief file exists opens on implement', () => {
  const manifest = loadManifest(makeRollout({ legacy: true, prs: { A1: { state: 'pending' }, A2: { state: 'pending' } } }))
  const path = manifest.all.find((pr) => pr.id === 'A1').brief

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '# A1\n')

  const { data, prs } = openLedger(manifest)

  assert.equal(data.version, 3)
  assert.deepEqual([prs.A1.stage, untimed(prs.A1.status), prs.A1.fix], ['implement', SLOT, null])
  assert.deepEqual([prs.A2.stage, untimed(prs.A2.status)], ['brief', SLOT])
})

test('MIGRATIONS: the step from 2 to 3 is pure, and the ledger it is given stays as it was', () => {
  const step = MIGRATIONS.find((candidate) => candidate.from === 2)
  const data = {
    version: 2,
    prs: {
      A1: { state: 'blocked', pr: 11, blocked: brief('needs-decision'), held: { at: at(5) } },
      A2: { state: 'interrupted', interruptedRole: 'implement' },
    },
    runs: RUNS,
    hold: null,
  }

  const before = structuredClone(data)
  const result = step.apply(data, { events: [], briefs: new Set(['A2']), at: at(100) })

  assert.deepEqual([step.from, step.to, result.version], [2, 3, 3])
  assert.deepEqual(data, before)
  assert.deepEqual([result.prs.A1.status.code, result.prs.A1.hold.by], ['decision', 'maintainer'])
  assert.deepEqual([result.prs.A2.stage, result.prs.A2.fix.reason, result.prs.A2.implementCutOff], ['implement', 'no-report', true])

  result.prs.A1.status.question.text = 'changed'
  result.prs.A1.hold.at = at(6)
  assert.deepEqual(data, before, 'the result shares nothing with its input')
})

test('openLedger migrates the mark of a parked READY report and of a cut-off implement run', () => {
  const parked = openedA1({ state: 'interrupted', interruptedRole: 'report', ready: { status: 'READY', pr: 11, headSha: HEAD } }).entry

  assert.deepEqual(
    [parked.stage, untimed(parked.status), parked.reportUnchecked, parked.implementCutOff],
    ['pre-verify', { kind: 'waiting', code: 'github' }, true, false],
  )

  const cut = openedA1({ state: 'interrupted', interruptedRole: 'implement' }).entry

  assert.deepEqual(
    [cut.stage, untimed(cut.status), untimed(cut.fix), cut.implementCutOff, cut.reportUnchecked],
    ['implement', SLOT, { reason: 'no-report', note: '' }, true, false],
  )

  const fixRun = openedA1({ state: 'interrupted', pr: 11, interruptedRole: 'fix' }).entry

  assert.deepEqual([untimed(fixRun.fix), fixRun.implementCutOff, fixRun.reportUnchecked], [{ reason: 'no-report', note: '' }, false, false])
})

test('openLedger migrates the question a running delegate works on into delegate.question', () => {
  const running = { kind: 'running', code: 'delegate', question: 'needs-decision', run: 'A1-05-delegate', since: at(60) }
  const { entry } = openedA1({
    state: 'blocked',
    pr: 11,
    blocked: brief('needs-decision'),
    stage: 'implement',
    status: running,
    fix: null,
    hold: null,
  })

  assert.deepEqual([entry.stage, entry.status], ['implement', running])
  assert.deepEqual(entry.delegate.question, asked('needs-decision'))
  assert.equal(entry.delegate.question.text, 'Which API?')

  const waiting = openedA1({ state: 'blocked', pr: 11, blocked: brief('needs-decision') }).entry

  assert.equal(waiting.delegate.question, null)
})

// The guesses of the view for a block or an escalation with no stamps, made once by the migration.
const GUESS_RUNS = {
  'A1-01-implement': { id: 'A1', role: 'implement', startedAt: at(10), endedAt: at(20) },
  'A1-02-verify': { id: 'A1', role: 'verify', startedAt: at(21), endedAt: at(30) },
  'A1-03-fix': { id: 'A1', role: 'fix', startedAt: at(31), endedAt: at(40) },
  'A1-04-delegate': { id: 'A1', role: 'delegate', startedAt: at(41), endedAt: at(45) },
  'A2-01-implement': { id: 'A2', role: 'implement', startedAt: at(41), endedAt: at(46) },
}

const MIGRATED_AT = at(100)

// The step from 2 to 3 on a version 2 ledger with A1 alone.
function guessed(fields, events, runs = GUESS_RUNS) {
  const step = MIGRATIONS.find((candidate) => candidate.from === 2)

  return step.apply({ version: 2, prs: { A1: fields }, runs, hold: null }, { events, briefs: new Set(), at: MIGRATED_AT }).prs.A1
}

test('the migration from version 2 stamps a block with the time of its event and the run the view guessed', () => {
  const unstamped = { state: 'blocked', pr: 11, blocked: { kind: 'needs-decision', question: 'Which API?', evidence: '' } }
  const blockedAt = [
    { at: at(35), id: 'A1', kind: 'blocked' },
    { at: at(50), id: 'A2', kind: 'blocked' },
  ]

  const block = guessed(unstamped, blockedAt)

  assert.deepEqual([block.status.code, block.status.since, block.status.question.run], ['decision', at(35), 'A1-01-implement'])

  const stamped = guessed({ ...unstamped, blocked: brief('needs-decision', 'A1-03-fix') }, blockedAt)

  assert.deepEqual([stamped.status.since, stamped.status.question.run], [at(35), 'A1-03-fix'])

  const driver = guessed({ ...unstamped, blocked: brief('needs-decision', null) }, blockedAt)

  assert.equal(driver.status.question.run, null)

  const noEvent = guessed(unstamped, [])

  assert.deepEqual([noEvent.status.since, noEvent.status.question.run], [MIGRATED_AT, 'A1-03-fix'])

  const noRun = guessed(unstamped, blockedAt, {})

  assert.equal(noRun.status.question.run, null)
})

test('the migration from version 2 stamps an escalation with no time of its own, and keeps the run of one that has it', () => {
  const unstamped = { state: 'escalated', pr: 11, escalation: 'repeated errors', lastError: 'boom', escalationRun: null }
  const escalatedAt = [
    { at: at(42), id: 'A1', kind: 'escalated' },
    { at: at(60), id: 'A1', kind: 'blocked' },
  ]

  const escalation = guessed(unstamped, escalatedAt)

  assert.deepEqual([escalation.status.code, escalation.status.since, escalation.escalationRun], ['errors', at(42), 'A1-03-fix'])

  const noEvent = guessed(unstamped, [])

  assert.deepEqual([noEvent.status.since, noEvent.escalationRun], [MIGRATED_AT, 'A1-03-fix'])

  const stamped = guessed({ ...unstamped, escalatedAt: at(38), escalationRun: 'A1-01-implement' }, escalatedAt)

  assert.deepEqual([stamped.status.since, stamped.escalationRun], [at(38), 'A1-01-implement'])
})
