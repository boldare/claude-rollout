import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireLock,
  drainInbox,
  freshPr,
  lockHolder,
  postCommand,
  recheckedFindings,
  recordAnswers,
  recordFindings,
  recordVerdict,
  reserveRunName,
  watchInbox,
} from '../lib/ledger.mjs'
import { liveness } from '../lib/view.mjs'

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

test('freshPr has no hold, verdict history, handled feedback or findings', () => {
  assert.equal(freshPr().held, null)
  assert.deepEqual(freshPr().verdicts, [])
  assert.deepEqual(freshPr().feedbackHandled, [])
  assert.equal(freshPr().findings, null)
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
