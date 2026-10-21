import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { keepDemoAlive, makeDemoRoot, removeDemoRoot } from '../lib/demo.mjs'
import { findRollout, listRollouts, rolloutSnapshot, transcriptPage } from '../lib/rollouts.mjs'
import { START } from './fixtures.mjs'

function demoRoot(context) {
  const root = makeDemoRoot({ dir: join(mkdtempSync(join(tmpdir(), 'rollout-demo-test-')), 'root'), now: START })

  context.after(() => removeDemoRoot(root))

  return root
}

function rowsOf(root, name) {
  const { state } = rolloutSnapshot(findRollout(root, name), name, START)

  return Object.fromEntries(state.view.rows.map((row) => [row.id, row]))
}

test('makeDemoRoot: a running rollout, a finished one, one of edge states and a broken manifest', (context) => {
  const root = demoRoot(context)
  const summary = Object.fromEntries(listRollouts(root).map((rollout) => [rollout.name, rollout]))

  assert.deepEqual(Object.keys(summary), ['edge-states', 'my-lib-1.1.0', 'my-lib-1.2.0', 'notes-site'])
  assert.equal(summary['my-lib-1.2.0'].driver.running, true)
  assert.equal(summary['my-lib-1.2.0'].driver.pid, process.pid)
  assert.deepEqual([summary['my-lib-1.2.0'].merged, summary['my-lib-1.2.0'].total], [1, 6])
  assert.equal(summary['my-lib-1.1.0'].driver.running, false)
  assert.deepEqual([summary['my-lib-1.1.0'].merged, summary['my-lib-1.1.0'].total], [6, 6])
  assert.equal(summary['edge-states'].driver.running, true)
  assert.match(summary['notes-site'].error, /invalid manifest/)

  for (const name of ['my-lib-1.2.0', 'my-lib-1.1.0', 'edge-states']) {
    const manifest = findRollout(root, name)

    assert.ok(manifest.repo.path.startsWith(root), `${name} keeps its repo inside the demo root`)
  }
})

test('makeDemoRoot: the rows of the Figma mockup, and every state that waits or stops', (context) => {
  const root = demoRoot(context)
  const myLib = rowsOf(root, 'my-lib-1.2.0')
  const edge = rowsOf(root, 'edge-states')

  assert.deepEqual(
    Object.values(myLib).map((row) => row.state),
    ['merged', 'verified', 'implementing', 'pending', 'blocked', 'fixing'],
  )

  assert.equal(myLib.P3.activeRun, 'P3-01-implement')
  assert.equal(myLib.P5.waiting.run, 'P5-01-implement')
  assert.deepEqual(myLib.P5.waiting.delegate, { state: 'escalate', reason: 'the plan does not decide' })
  assert.equal(myLib.P5.waiting.since, new Date(START - 8 * 60_000).toISOString())
  assert.ok(myLib.P1.plan.length > 0, 'the plan has a section for P1')

  assert.deepEqual(
    Object.values(edge).map((row) => row.state),
    ['escalated', 'interrupted', 'verified', 'blocked', 'blocked'],
  )

  assert.ok(edge.E3.held)
  assert.equal(edge.E4.waiting.run, 'E4-01-brief-write')
  assert.equal(edge.E5.waiting.byDriver, true)
})

test('makeDemoRoot: the logs of the runs the board opens parse into commands', (context) => {
  const root = demoRoot(context)
  const manifest = findRollout(root, 'my-lib-1.2.0')

  for (const run of ['P2-02-verify', 'P3-01-implement', 'P5-01-implement', 'P6-02-fix']) {
    const page = transcriptPage(manifest, run, { from: 'end', limit: 40 })

    assert.ok(
      page.items.some((item) => item.kind === 'tool'),
      run,
    )
  }

  assert.equal(transcriptPage(manifest, 'P2-02-verify').final.ok, true)
  assert.equal(transcriptPage(manifest, 'P3-01-implement').final, null, 'the live run has no result yet')
})

test('makeDemoRoot: without a dir it makes one of its own in the temp directory', () => {
  const root = makeDemoRoot()

  try {
    assert.ok(root.startsWith(join(tmpdir(), 'rollout-demo-')), root)
    assert.ok(existsSync(join(root, 'my-lib-1.2.0', 'manifest.yaml')))
  } finally {
    removeDemoRoot(root)
  }

  assert.equal(existsSync(root), false)
})

test('keepDemoAlive: fresh heartbeats and a live run that goes on, until it is stopped', async (context) => {
  const root = demoRoot(context)
  const manifest = findRollout(root, 'my-lib-1.2.0')
  const heartbeat = join(root, 'edge-states', 'heartbeat')
  const before = transcriptPage(manifest, 'P3-01-implement').total
  const beatBefore = statSync(heartbeat).mtimeMs

  await delay(20)

  const stop = keepDemoAlive(root, { intervalMs: 10 })

  await delay(100)
  stop()

  const grown = transcriptPage(manifest, 'P3-01-implement').total

  assert.ok(grown > before, `${grown} items after ${before}`)
  assert.ok(statSync(heartbeat).mtimeMs > beatBefore)
  assert.match(readFileSync(heartbeat, 'utf8'), /^\S+ tick$/)

  await delay(50)
  assert.equal(transcriptPage(manifest, 'P3-01-implement').total, grown, 'nothing more after stop')
})
