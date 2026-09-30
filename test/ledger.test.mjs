import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, drainInbox, freshPr, lockHolder, postCommand, recordVerdict, reserveRunName, watchInbox } from '../lib/ledger.mjs'
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

function writeLock(M, pid) {
  writeFileSync(join(M.dir, 'driver.lock'), JSON.stringify({ pid, at: new Date().toISOString() }))
}

function withoutAt(commands) {
  return commands.map(({ at: _, ...command }) => command)
}

async function watching(M, task) {
  const inbox = watchInbox(M, { settleMs: 50 })

  try {
    return await task(inbox)
  } finally {
    inbox.close()
  }
}

test('reserveRunName never hands out a name twice', () => {
  const M = scratch()

  assert.equal(reserveRunName(M, 'A1-01-implement'), 'A1-01-implement')
  assert.equal(reserveRunName(M, 'A1-01-implement'), 'A1-01-implement-2')
  assert.equal(reserveRunName(M, 'A1-01-implement'), 'A1-01-implement-3')
  assert.ok(existsSync(join(M.dir, 'logs', 'A1-01-implement.jsonl')))
  assert.ok(existsSync(join(M.dir, 'logs', 'A1-01-implement-2.jsonl')))
})

test('reserveRunName throws when it cannot create the log', () => {
  assert.throws(() => reserveRunName(unusable(), 'A1-01-implement'), /ENOTDIR|EEXIST/)
})

test('recordVerdict keeps the latest verdict and the last 10', () => {
  const s = freshPr()

  for (let i = 1; i <= 12; i += 1) {
    recordVerdict(s, { verdict: 'PASS', run: `A1-${i}-verify` })
  }

  assert.equal(s.verdicts.length, 10)
  assert.equal(s.verdicts[0].run, 'A1-3-verify')
  assert.deepEqual(s.verdict, { verdict: 'PASS', run: 'A1-12-verify' })

  const old = { verdict: { verdict: 'FAIL' } }
  recordVerdict(old, { verdict: 'PASS' })
  assert.deepEqual(old.verdicts, [{ verdict: 'PASS' }])
})

test('freshPr has no hold, verdict history or handled feedback', () => {
  assert.equal(freshPr().held, null)
  assert.deepEqual(freshPr().verdicts, [])
  assert.deepEqual(freshPr().feedbackHandled, [])
})

test('watchInbox wakes soon after a command is posted', async () => {
  const M = scratch()

  await watching(M, async (inbox) => {
    const started = Date.now()
    const timer = setTimeout(() => postCommand(M, { cmd: 'hold', id: 'A1' }), 100)

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
  const M = scratch()

  await watching(M, async (inbox) => {
    postCommand(M, { cmd: 'release', id: 'A1' })
    drainInbox(M)
    writeFileSync(join(M.dir, 'inbox', '.1-temp.json'), '{}')
    writeFileSync(join(M.dir, 'inbox', 'notes.txt'), '')

    assert.equal(await inbox.wait(1_000), 'timeout')
  })
})

test('watchInbox wakes once for files left in inbox/, a burst included', async () => {
  const M = scratch()

  await watching(M, async (inbox) => {
    postCommand(M, { cmd: 'hold', id: 'A1' })
    postCommand(M, { cmd: 'hold', id: 'A2' })

    assert.equal(await inbox.wait(1_000), 'command')
    assert.equal(await inbox.wait(1_000), 'timeout')

    postCommand(M, { cmd: 'release', id: 'A1' })
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
    const M = scratch()
    writeLock(M, pid)

    assert.equal(lockHolder(M), null, `pid ${pid}`)
    assert.equal(liveness(M).running, false, `pid ${pid}`)

    const release = acquireLock(M)

    try {
      assert.equal(JSON.parse(readFileSync(join(M.dir, 'driver.lock'), 'utf8')).pid, process.pid, `pid ${pid}`)
    } finally {
      release()
    }
  }
})

test('lockHolder: a lock naming a live process holds, and acquireLock refuses it', () => {
  const M = scratch()
  writeLock(M, process.pid)

  assert.equal(lockHolder(M).pid, process.pid)
  assert.throws(() => acquireLock(M), /already running/)
})

test('drainInbox skips a directory named like a command, and watchInbox never wakes for it', async () => {
  const M = scratch()
  const folder = join(M.dir, 'inbox', 'x.json')

  mkdirSync(folder, { recursive: true })
  postCommand(M, { cmd: 'hold', id: 'A1' })

  assert.deepEqual(withoutAt(drainInbox(M)), [{ cmd: 'hold', id: 'A1' }])
  assert.deepEqual(drainInbox(M), [])
  assert.ok(existsSync(folder))

  await watching(M, async (inbox) => {
    assert.equal(await inbox.wait(300), 'timeout')
  })
})

test('drainInbox without an inbox returns nothing', () => {
  assert.deepEqual(drainInbox(scratch()), [])
})

test(
  'drainInbox rejects a file it cannot delete instead of returning its command',
  { skip: process.getuid?.() === 0 || process.platform === 'win32' ? 'root and Windows delete it anyway' : false },
  (t) => {
    const M = scratch()
    const inbox = join(M.dir, 'inbox')
    const name = postCommand(M, { cmd: 'retry', id: 'A1' })

    chmodSync(inbox, 0o555)
    t.after(() => chmodSync(inbox, 0o755))

    const commands = drainInbox(M)

    assert.equal(commands.length, 1)
    assert.equal(commands[0].cmd, 'invalid')
    assert.equal(commands[0].file, name)
    assert.match(commands[0].error, /^cannot delete it: /)
    assert.ok(existsSync(join(inbox, name)))
  },
)
