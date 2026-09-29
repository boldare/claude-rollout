import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainInbox, freshPr, postCommand, recordVerdict, reserveRunName, watchInbox } from '../lib/ledger.mjs'

function scratch() {
  return { dir: mkdtempSync(join(tmpdir(), 'rollout-')) }
}

// A path where a directory cannot be created.
function unusable() {
  const file = join(scratch().dir, 'file')
  writeFileSync(file, '')

  return { dir: file }
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
