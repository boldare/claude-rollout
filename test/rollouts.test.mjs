import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { changeSignature, eventsSince, findRollout, listRollouts, rolloutPr, rolloutSnapshot, watchRollout } from '../lib/rollouts.mjs'
import { START, makeRolloutRoot } from './fixtures.mjs'

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out')
    }

    await delay(20)
  }
}

// On macOS a fresh fs.watch starts listening a moment after it returns, so
// the change repeats until the watcher reports it.
async function changeUntil(change, check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs

  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('timed out')
    }

    change()
    await delay(250)
  }
}

test('listRollouts: sorted, broken with its error, worktrees skipped', () => {
  const root = makeRolloutRoot()
  const rollouts = listRollouts(root)
  const [broken, demo, fresh] = rollouts

  assert.deepEqual(
    rollouts.map((rollout) => rollout.name),
    ['broken', 'demo', 'fresh'],
  )
  assert.match(broken.error, /invalid manifest/)
  assert.deepEqual(
    { ...broken, error: null },
    { name: 'broken', rollout: null, started: false, driver: null, merged: 0, total: 0, costUsd: 0, error: null },
  )
  assert.equal(demo.rollout, 'demo')
  assert.equal(demo.started, true)
  assert.equal(demo.merged, 0)
  assert.equal(demo.total, 3)
  assert.equal(demo.costUsd, 7.75)
  assert.equal(demo.error, null)
  assert.equal(demo.driver.running, true)
  assert.equal(demo.driver.pid, process.pid)
  assert.equal(demo.driver.heartbeatNote, 'tick')
  assert.equal(demo.driver.paused, false)
  assert.equal(demo.driver.halted, null)
  assert.equal(fresh.started, false)
  assert.equal(fresh.total, 3)
  assert.equal(fresh.costUsd, 0)
  assert.deepEqual(fresh.driver, { running: false, pid: null, heartbeatAgeSeconds: null, heartbeatNote: '', paused: false, halted: null })
})

test('listRollouts: a missing root is empty', () => {
  assert.deepEqual(listRollouts(join(makeRolloutRoot(), 'missing')), [])
})

test('listRollouts counts merged PRs, and an unreadable ledger is an error that keeps started', () => {
  const root = makeRolloutRoot()
  const ledger = join(root, 'demo', 'ledger.json')

  writeFileSync(ledger, JSON.stringify({ prs: { A1: { state: 'merged', costUsd: 2 } }, paused: true, halted: 'base is red' }))

  const [, demo] = listRollouts(root)
  assert.equal(demo.merged, 1)
  assert.equal(demo.costUsd, 2)
  assert.equal(demo.driver.paused, true)
  assert.equal(demo.driver.halted, 'base is red')

  writeFileSync(ledger, '{"prs":')

  const [, broken] = listRollouts(root)
  assert.equal(broken.started, true)
  assert.equal(broken.rollout, null)
  assert.equal(broken.driver, null)
  assert.equal(broken.merged, 0)
  assert.match(broken.error, /JSON/)
})

test('findRollout: only names of rollout directories one level below the root', () => {
  const root = makeRolloutRoot()

  for (const name of ['..', '../demo', 'a/b', '.x', 'demo.worktrees', 'missing', '', null, 42]) {
    assert.equal(findRollout(root, name), null, String(name))
  }

  assert.equal(findRollout(root, 'demo').rollout, 'demo')
  assert.throws(() => findRollout(root, 'broken'), /invalid manifest/)
})

test('rolloutSnapshot: the view without events, and the events beside it', () => {
  const root = makeRolloutRoot()
  const { state, events } = rolloutSnapshot(findRollout(root, 'demo'), 'demo', START)

  assert.equal(state.name, 'demo')
  assert.equal(state.at, new Date(START).toISOString())
  assert.equal(state.view.eventCount, 9)
  assert.equal(state.view.rows.length, 3)
  assert.equal(state.view.costs.totalUsd, 7.75)
  assert.equal('events' in state.view, false)
  assert.equal(events.length, 9)

  const fresh = rolloutSnapshot(findRollout(root, 'fresh'), 'fresh', START)
  assert.deepEqual(fresh, { state: { name: 'fresh', at: new Date(START).toISOString(), view: null }, events: [] })
})

test('eventsSince: the tail after from, or everything when the file was replaced', () => {
  const events = [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }]

  assert.deepEqual(eventsSince(events, 0), { from: 0, events })
  assert.deepEqual(eventsSince(events, 1), { from: 1, events: events.slice(1) })
  assert.deepEqual(eventsSince(events, 3), { from: 3, events: [] })
  assert.deepEqual(eventsSince(events, 4), { from: 0, events })
})

test('rolloutPr: the detail with the brief and notes texts, with or without a ledger', () => {
  const root = makeRolloutRoot()
  const detail = rolloutPr(findRollout(root, 'demo'), 'A1')

  assert.equal(detail.pr, 11)
  assert.equal(detail.verdicts.length, 1)
  assert.equal(detail.briefText, '# A1\n')
  assert.equal(detail.notesText, null)
  assert.deepEqual(
    detail.runs.map((run) => run.run),
    ['A1-01-implement', 'A1-02-verify'],
  )
  assert.equal(rolloutPr(findRollout(root, 'demo'), 'Z9'), null)

  const fresh = rolloutPr(findRollout(root, 'fresh'), 'A1')
  assert.equal(fresh.state, 'pending')
  assert.equal(fresh.briefText, null)
})

test('changeSignature changes on an event append and on a lock change', () => {
  const root = makeRolloutRoot()
  const M = findRollout(root, 'demo')
  const first = changeSignature(M)

  assert.equal(changeSignature(M), first)

  appendFileSync(join(M.dir, 'events.jsonl'), '\n{"kind":"note"}')
  const appended = changeSignature(M)
  assert.notEqual(appended, first)

  rmSync(join(M.dir, 'driver.lock'))
  const unlocked = changeSignature(M)
  assert.notEqual(unlocked, appended)
  assert.match(unlocked, /\|-\|false\|$/)
})

test('watchRollout: onChange after an append and a rename, never after close', async (t) => {
  const dir = join(makeRolloutRoot(), 'demo')
  let calls = 0
  const watcher = watchRollout(dir, () => (calls += 1), { debounceMs: 50, pollMs: 60_000 })

  t.after(() => watcher.close())

  await changeUntil(
    () => appendFileSync(join(dir, 'events.jsonl'), '\n{"kind":"note"}'),
    () => calls > 0,
  )

  await delay(200)

  const beforeRename = calls
  writeFileSync(join(dir, 'ledger.json.tmp'), '{"prs":{}}')
  renameSync(join(dir, 'ledger.json.tmp'), join(dir, 'ledger.json'))
  await waitFor(() => calls > beforeRename)

  watcher.close()
  watcher.close()

  const afterClose = calls
  appendFileSync(join(dir, 'events.jsonl'), '\n{"kind":"note"}')
  await delay(300)
  assert.equal(calls, afterClose)
})

test('watchRollout never throws: a missing directory and a throwing onChange leave the poll running', async (t) => {
  let calls = 0
  const watcher = watchRollout(
    join(makeRolloutRoot(), 'missing'),
    () => {
      calls += 1
      throw new Error('boom')
    },
    { pollMs: 20 },
  )

  t.after(() => watcher.close())
  await waitFor(() => calls >= 3)
})
