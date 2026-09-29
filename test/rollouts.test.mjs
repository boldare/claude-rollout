import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loadManifest } from '../lib/manifest.mjs'
import {
  changeSignature,
  eventsSince,
  findRollout,
  listRollouts,
  rolloutPr,
  rolloutRoot,
  rolloutSnapshot,
  transcriptPage,
  watchRollout,
  withEstimates,
} from '../lib/rollouts.mjs'
import { START, at, interruptedTranscript, jsonLines, makeRollout, makeRolloutRoot, sampleEvents } from './fixtures.mjs'

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

function demoRollout() {
  return findRollout(makeRolloutRoot(), 'demo')
}

function writeLog(M, run, lines) {
  writeFileSync(join(M.dir, 'logs', `${run}.jsonl`), jsonLines(lines))
}

const RESULT_LINE = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 3, duration_ms: 1000, num_turns: 2 }

// The demo plus two A3 runs that reported no cost: one stopped, one timed out.
function killedRuns() {
  const events = sampleEvents()
  const partial = events.pop()
  const killed = [
    { at: at(83), id: 'A3', kind: 'implement-start', run: 'A3-01-implement', log: 'logs/A3-01-implement.jsonl', effort: 'high' },
    { at: at(88), id: 'A3', kind: 'implement-done', run: 'A3-01-implement', ok: false, stopped: true, cost: 0, seconds: 300 },
    { at: at(89), id: 'A3', kind: 'verify-start', run: 'A3-02-verify', log: 'logs/A3-02-verify.jsonl', effort: 'high' },
    { at: at(95), id: 'A3', kind: 'verify-done', run: 'A3-02-verify', ok: false, cost: 0, seconds: 360, error: 'timeout after 60 min' },
  ]
  const M = loadManifest(makeRollout({ events: [...events, ...killed, partial] }))

  writeLog(M, 'A3-01-implement', interruptedTranscript())
  writeLog(M, 'A3-02-verify', interruptedTranscript())

  return M
}

function estimatesByRun(runs) {
  return Object.fromEntries(runs.map((run) => [run.run, run.estimateUsd]))
}

test('transcriptPage: pages of display items with their index in the log', () => {
  const M = demoRollout()
  const last = transcriptPage(M, 'A1-01-implement', { from: 'end', limit: 3 })

  assert.equal(last.run, 'A1-01-implement')
  assert.equal(last.total, 8)
  assert.equal(last.from, 5)
  assert.ok(last.bytes > 0)
  assert.equal(last.model, 'opus')
  assert.deepEqual(last.usage, {})
  assert.equal(last.final.costUsd, 4.25)
  assert.equal(last.estimateUsd, null)
  assert.deepEqual(
    last.items.map((item) => item.index),
    [5, 6, 7],
  )
  assert.deepEqual(last.items[0], {
    index: 5,
    kind: 'tool',
    id: 'tool-3',
    name: 'Read',
    command: null,
    summary: 'README.md',
    inputText: '{\n  "file_path": "README.md"\n}',
    cut: 0,
  })
  assert.deepEqual(last.items[1], {
    index: 6,
    kind: 'tool-result',
    toolUseId: 'tool-2',
    name: 'Bash',
    text: 'rollout guard: the driver merges PRs',
    isError: true,
    refused: true,
    cut: 0,
  })
  assert.equal(last.items[2].name, 'Read')

  const middle = transcriptPage(M, 'A1-01-implement', { from: 2, limit: 3 })
  assert.deepEqual(
    middle.items.map((item) => item.index),
    [2, 3, 4],
  )

  const past = transcriptPage(M, 'A1-01-implement', { from: 99 })
  assert.deepEqual([past.items, past.from, past.total], [[], 99, 8])

  const whole = transcriptPage(M, 'A1-01-implement')
  assert.equal(whole.from, 0)
  assert.equal(whole.items.length, 8)
  assert.deepEqual(whole.items[0], { index: 0, kind: 'init', model: 'opus', sessionId: 'session-1' })
  assert.deepEqual(whole.items[1], { index: 1, kind: 'text', text: 'Reading the brief.', cut: 0 })
  assert.equal(whole.items[2].command, 'npm test')
  assert.equal(whole.items[2].summary, 'npm test')

  for (const item of whole.items) {
    assert.equal('input' in item, false, item.kind)
  }
})

test('transcriptPage: long fields are cut, and a refusal past the cut still counts', () => {
  const M = demoRollout()
  const long = `${'x'.repeat(25_000 - 'rollout guard: no'.length)}rollout guard: no`
  const command = 'y'.repeat(10_500)
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: long }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-2', name: 'Grep', input: { pattern: 'p'.repeat(300) } }] } },
    { type: 'assistant', message: { content: [{ type: 'text' }] } },
  ]

  writeLog(M, 'A3-01-implement', lines)

  const [tool, result, grep, text] = transcriptPage(M, 'A3-01-implement').items

  assert.equal(result.text.length, 10_000)
  assert.equal(result.cut, 15_000)
  assert.equal(result.refused, true)
  assert.equal(result.name, 'Bash')
  assert.equal(tool.command.length, 10_000)
  assert.equal(tool.summary.length, 200)
  assert.equal(tool.inputText.length, 10_000)
  assert.equal(tool.cut, 500 + JSON.stringify({ command }, null, 2).length - 10_000)
  assert.equal(grep.summary, 'p'.repeat(200))
  assert.equal(grep.command, null)
  assert.deepEqual(text, { index: 3, kind: 'text', text: '', cut: 0 })
})

test('transcriptPage: null for a name outside logs/ or a missing log', () => {
  const M = demoRollout()

  for (const run of ['../ledger', 'Z9-01-implement', '.hidden', null]) {
    assert.equal(transcriptPage(M, run), null, String(run))
  }
})

test('estimates: runs that reported no cost get one, and it stays out of the totals', () => {
  const M = killedRuns()
  const { view } = rolloutSnapshot(M, 'demo', START).state
  const expected = {
    'A2-01-brief-write': null,
    'A1-01-implement': null,
    'A1-02-verify': null,
    'A2-01-implement': null,
    'A3-01-implement': 2.67,
    'A3-02-verify': 2.67,
  }

  assert.deepEqual(estimatesByRun(view.runs), expected)
  assert.equal(view.costs.estimatedUsd, 5.34)
  assert.equal(view.costs.estimatedRuns, 2)
  assert.equal(view.costs.totalUsd, 7.75)
  assert.deepEqual(estimatesByRun(rolloutPr(M, 'A3').runs), { 'A3-01-implement': 2.67, 'A3-02-verify': 2.67 })
  assert.deepEqual(estimatesByRun(rolloutPr(M, 'A1').runs), { 'A1-01-implement': null, 'A1-02-verify': null })

  const message = { id: 'msg-5', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1_000_000 } }
  appendFileSync(join(M.dir, 'logs', 'A3-02-verify.jsonl'), `\n${JSON.stringify({ type: 'assistant', message })}\n`)

  assert.deepEqual(estimatesByRun(rolloutPr(M, 'A3').runs), { 'A3-01-implement': 2.67, 'A3-02-verify': 6.67 })
  assert.equal(rolloutSnapshot(M, 'demo', START).state.view.costs.estimatedUsd, 9.34)
})

test('withEstimates: only interrupted or failed runs without a cost and with an unfinished log', () => {
  const M = demoRollout()
  const run = (name, status, costUsd) => ({ run: name, id: 'A3', role: 'fix', status, costUsd })

  writeLog(M, 'A3-01-fix', interruptedTranscript())
  writeLog(M, 'A3-02-fix', [...interruptedTranscript(), RESULT_LINE])
  writeLog(M, 'A3-03-fix', interruptedTranscript())
  writeLog(M, 'A3-04-fix', interruptedTranscript())

  const runs = [
    run('A3-01-fix', 'interrupted', null),
    run('A3-02-fix', 'interrupted', 0),
    run('A3-03-fix', 'failed', 1.5),
    run('A3-04-fix', 'ok', 0),
    run('A3-09-fix', 'interrupted', 0),
    run(null, 'failed', 0),
  ]
  const estimated = withEstimates(M, runs)

  assert.deepEqual(
    estimated.map((item) => item.estimateUsd),
    [2.67, null, null, null, null, null],
  )
  assert.deepEqual(estimated[0], { ...runs[0], estimateUsd: 2.67 })
  assert.equal('estimateUsd' in runs[0], false)
  assert.equal(withEstimates(M, [run('A1-01-implement', 'failed', 0)])[0].estimateUsd, null)
})

test('rolloutRoot: --root, then a non-empty ROLLOUT_ROOT, then ~/.rollouts', () => {
  const env = { ROLLOUT_ROOT: '/tmp/from-env' }

  assert.equal(rolloutRoot('/tmp/from-flag', env), '/tmp/from-flag')
  assert.equal(rolloutRoot(undefined, env), '/tmp/from-env')
  assert.equal(rolloutRoot(undefined, { ROLLOUT_ROOT: '' }), join(homedir(), '.rollouts'))
  assert.equal(rolloutRoot(undefined, {}), join(homedir(), '.rollouts'))
  assert.equal(rolloutRoot('~/elsewhere', env), join(homedir(), 'elsewhere'))
  assert.equal(rolloutRoot(undefined, { ROLLOUT_ROOT: '~/from-env' }), join(homedir(), 'from-env'))
})
