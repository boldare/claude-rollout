import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDriver } from '../lib/driver.mjs'
import { GitHubError } from '../lib/gh.mjs'
import { baseChecks, setFetch } from '../lib/github.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { stageLabels } from '../lib/stage.mjs'
import { readEvents } from '../lib/view.mjs'
import { at, fakeGitHub, fakeTools, makeRollout, samplePrs, waitFor } from './fixtures.mjs'
import {
  MAINTAINER_TOKEN,
  MERGE_SHA,
  MERGED_PR,
  FETCH,
  MERGE_RULE,
  SHA,
  apply,
  mergeCalls,
  modelDriver,
  prRoute,
  restPr,
  runsRoute,
  tickDriver,
  eventsSince,
  kindsSince,
} from './driver-helpers.mjs'

const FETCH_FAILS = { tool: 'git', args: 'fetch', code: 128, stderr: 'fatal: unable to access the remote' }
const PR_11 = 'repos/example/widgets/pulls/11'
const RED_RUNS = { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }] }

test('tick: a failed fetch counts against no PR, skips the gate and lets the other PRs advance', async () => {
  const { manifest, driver, tools, gate } = tickDriver(samplePrs(), { rules: [FETCH_FAILS], routes: [prRoute()] })

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

  tools.answer([FETCH])
  await driver.tick()

  assert.equal(gate.calls, 1)
  assert.deepEqual(kindsSince(manifest, events.length), [])
})

test('tick: a driver-wide step that fails five ticks in a row notifies once, and a success starts the count over', async () => {
  const { manifest, driver, tools, notices } = tickDriver(samplePrs(), { rules: [FETCH_FAILS], routes: [prRoute()] })
  const sent = []

  for (let i = 0; i < 6; i += 1) {
    await driver.tick()
    sent.push(notices.length)
  }

  assert.deepEqual(sent, [0, 0, 0, 0, 1, 1])
  assert.match(notices[0], /^-: fetch-failed 5 ticks in a row: git -C /)

  tools.answer([FETCH])
  await driver.tick()
  tools.answer([FETCH_FAILS])
  await driver.tick()

  const counts = eventsSince(manifest)
    .filter((event) => event.kind === 'fetch-failed')
    .map((event) => event.count)

  assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 1])
  assert.equal(notices.length, 1)
})

test('tick: outside dependencies are looked up one by one, and one already merged is not looked up', async () => {
  const pulls = 'repos/example/widgets/pulls'
  const mergedA2 = restPr({ number: 12, ...MERGED_PR, head: { ref: 'feat/a2' }, labels: [{ name: 'rollout:demo' }] })
  const { manifest, driver, github } = tickDriver(
    { A1: { state: 'pending' }, A2: { state: 'pending' } },
    {
      only: ['A3'],
      rules: [FETCH],
      routes: [
        { path: pulls, query: { head: 'example:feat/a1' }, status: 403, body: { message: 'Resource not accessible by integration' } },
        { path: pulls, query: { head: 'example:feat/a2' }, body: [mergedA2] },
      ],
    },
  )

  const lookups = (from) =>
    github
      .requests()
      .slice(from)
      .filter((request) => request.path === pulls)
      .map((request) => request.query.head)

  manifest.prs.find((pr) => pr.id === 'A3').deps = ['A1', 'A2']
  await driver.tick()

  const events = eventsSince(manifest)
  const failed = events.filter((event) => event.kind === 'outside-deps-failed')

  assert.deepEqual(lookups(0), ['example:feat/a1', 'example:feat/a2'])
  assert.equal(driver.ledger.prs.A1.state, 'pending')
  assert.equal(driver.ledger.prs.A2.state, 'merged')
  assert.equal(driver.ledger.prs.A2.pr, 12)
  assert.deepEqual(
    events.filter((event) => event.kind === 'merged-outside-run'),
    [{ id: 'A2', kind: 'merged-outside-run', pr: 12 }],
  )

  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, '-')
  assert.match(failed[0].error, /^A1: GET repos\/example\/widgets\/pulls: HTTP 403/)
  assert.doesNotMatch(failed[0].error, /A2/)

  const before = github.requests().length
  github.answer([{ path: pulls, query: { head: 'example:feat/a1' }, body: [] }])
  await driver.tick()

  assert.deepEqual(lookups(before), ['example:feat/a1'])
  assert.deepEqual(kindsSince(manifest, events.length), [])
})

test('tick: a failed base watch notifies nothing and is tried again on the next tick', async () => {
  const { manifest, driver, github } = tickDriver(
    { ...samplePrs(), A3: { state: 'merged', pr: 13, mergeSha: MERGE_SHA } },
    { rules: [FETCH], routes: [prRoute()] },
  )

  driver.ledger.data.lastMerge = { id: 'A3', sha: MERGE_SHA, at: at(90) }

  await driver.tick()

  const failed = eventsSince(manifest).filter((event) => event.kind === 'watch-base-failed')

  assert.equal(failed.length, 1)
  assert.equal(failed[0].id, '-')
  assert.match(failed[0].error, /fake GitHub: no route for GET repos\/example\/widgets\/commits\/f0f0f0f\w+\/check-runs$/)
  assert.ok(!kindsSince(manifest).includes('base-red'))
  assert.equal(driver.ledger.prs.A2.state, 'interrupted')

  github.answer([prRoute(), runsRoute(MERGE_SHA)])
  await driver.tick()

  assert.equal(driver.ledger.data.lastMerge.checked, 'green')
  assert.equal(eventsSince(manifest).filter((event) => event.kind === 'watch-base-failed').length, 1)
})

test('tick: the base watch reads only the merge commit, never a quiet ancestor', async () => {
  const parent = 'e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0'
  const { manifest, driver, tools, github } = tickDriver(
    { ...samplePrs(), A3: { state: 'merged', pr: 13, mergeSha: MERGE_SHA } },
    {
      rules: [
        FETCH,
        { tool: 'git', args: `log --no-show-signature --no-color --encoding=UTF-8 -1 --format=%P ${MERGE_SHA}`, stdout: `${parent}\n` },
        {
          tool: 'git',
          args: [
            'diff --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ --diff-algorithm=myers --indent-heuristic',
            `--inter-hunk-context=0 -O/dev/null --no-relative --submodule=short --ignore-submodules=none --no-renames --name-only -z ${parent} ${MERGE_SHA}`,
          ].join(' '),
          stdout: 'docs/notes.md\0',
        },
      ],
      routes: [prRoute(), runsRoute(MERGE_SHA, { check_runs: [] }), runsRoute(parent, RED_RUNS)],
    },
  )

  // A quiet merge commit with a red parent: a walk would see red, or go green from a green one.
  manifest.repo.baseQuietPaths = ['**']
  driver.ledger.data.lastMerge = { id: 'A3', sha: MERGE_SHA, at: at(90) }

  await driver.tick()

  assert.ok(!kindsSince(manifest).includes('base-red'))
  assert.equal(driver.ledger.data.lastMerge.checked, undefined)
  assert.ok(!tools.calls().some((call) => call.tool === 'git' && call.args.includes('--format=%P')))
  assert.ok(!github.requests().some((request) => request.path.includes(parent)))
})

test('tick: a red base after a merge notifies once, and for five ticks merges, rebases and sends back nothing, then merges when it is green', async () => {
  const { manifest, driver, tools, gate, notices } = tickDriver(
    { A1: { ...samplePrs().A1, held: null }, A3: { state: 'merged', pr: 13, mergeSha: MERGE_SHA } },
    { rules: [FETCH, MERGE_RULE], routes: [prRoute(), runsRoute(MERGE_SHA, RED_RUNS)] },
  )

  const red = { state: 'red', failing: ['test: failure'], missing: [], pending: [], runs: [], skipped: 0 }

  driver.ledger.data.lastMerge = { id: 'A3', sha: MERGE_SHA, at: at(90) }
  // Behind a red base and red on its own head: without the gate's base-red,
  // A1 would be rebased onto the red base or sent back for its failure.
  gate.facts = { baseIsAncestor: false, checks: red, mainChecks: { ...red, sha: MERGE_SHA } }

  for (let i = 0; i < 5; i += 1) {
    await driver.tick()
  }

  const events = eventsSince(manifest)
  const gateWaits = events.filter((event) => event.kind === 'gate-wait')

  assert.deepEqual(
    events.filter((event) => event.kind === 'base-red').map((event) => event.id),
    ['A3'],
  )

  assert.deepEqual(notices, [
    'A3: main is red after the merge (f0f0f0f): test: failure, required check test did not run (test: failure). Merges wait until it is green',
  ])

  assert.deepEqual(mergeCalls(tools), [])

  for (const kind of ['rebased', 'needs-fix', 'gate-rebase', 'gate-fix']) {
    assert.ok(!events.some((event) => event.kind === kind), kind)
  }

  assert.equal(gateWaits.length, 1)
  assert.equal(gateWaits[0].id, 'A1')
  assert.equal(gateWaits[0].code, 'base-red')
  assert.equal(driver.ledger.prs.A1.state, 'verified')
  assert.equal(driver.ledger.prs.A1.gate.code, 'base-red')
  assert.equal(driver.ledger.data.lastMerge.checked, 'red')

  gate.facts = {}
  await driver.tick()

  assert.equal(mergeCalls(tools).length, 1)
})

test('tick: a failed ignored run on the merge commit next to a green required run leaves the base green, and the gate merges', async () => {
  const runs = [
    { id: 1, name: 'test', status: 'completed', conclusion: 'success' },
    { id: 2, name: 'Dependabot', status: 'completed', conclusion: 'failure' },
  ]

  const { manifest, driver, tools, gate, notices } = tickDriver(
    { A1: { ...samplePrs().A1, held: null }, A3: { state: 'merged', pr: 13, mergeSha: MERGE_SHA } },
    { rules: [FETCH, MERGE_RULE], routes: [prRoute(), runsRoute(MERGE_SHA, { check_runs: runs })] },
  )

  manifest.repo.ignoredChecks = ['Dependabot']
  driver.ledger.data.lastMerge = { id: 'A3', sha: MERGE_SHA, at: at(90) }
  // tickDriver stubs collectFacts, so the gate gets the base as the driver reads it.
  gate.facts = { mainChecks: await baseChecks(manifest, MERGE_SHA) }

  await driver.tick()

  assert.ok(!kindsSince(manifest).includes('base-red'))
  assert.deepEqual(notices, [])
  // The fake PR stays open after the merge, so lastMerge stays A3's.
  assert.equal(driver.ledger.data.lastMerge.checked, 'green')
  assert.equal(mergeCalls(tools).length, 1)
})

test('tick: a pause stops the merge of an approved PR, and a resume lets it merge', async () => {
  const { manifest, driver, tools, gate } = tickDriver(
    { A1: { ...samplePrs().A1, held: null }, A3: { state: 'merged', pr: 13 } },
    { rules: [FETCH, MERGE_RULE], routes: [prRoute()] },
  )

  apply(manifest, driver, { cmd: 'pause' })
  await driver.tick()

  assert.deepEqual(mergeCalls(tools), [])
  assert.equal(gate.calls, 0)

  apply(manifest, driver, { cmd: 'resume' })
  await driver.tick()

  assert.equal(mergeCalls(tools).length, 1)
})

test('tick: a pause starts no agent, and a resume starts the implementer', async () => {
  const setup = modelDriver({ A1: { state: 'pending' }, A3: { state: 'merged', pr: 13 } })
  const { manifest, driver, entry, calls } = setup

  apply(manifest, driver, { cmd: 'pause' })
  await driver.tick()

  assert.ok(!kindsSince(manifest).includes('implement-start'))
  assert.deepEqual(calls, [])
  assert.equal(entry.state, 'pending')

  const before = eventsSince(manifest).length

  apply(manifest, driver, { cmd: 'resume' })
  await driver.tick()

  assert.ok(kindsSince(manifest, before).includes('implement-start'))

  await waitFor(() => setup.calls.length > 0, 'implement run')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].role, 'implement')
})

test('start: run states a stopped driver left are recovered, the label is ensured and driver-start is logged', async () => {
  const labels = 'repos/example/widgets/labels'
  const { manifest, driver, github } = tickDriver(samplePrs(), {
    rules: [FETCH],
    routes: [{ method: 'POST', path: labels, status: 201, body: {} }],
  })

  await driver.start()

  const entry = driver.ledger.prs.A2
  const posts = github.requests().filter((request) => request.method === 'POST' && request.path === labels)

  assert.equal(entry.state, 'interrupted')
  assert.equal(entry.interruptedRole, 'implement')
  assert.equal(entry.attempts.implement, 0)
  assert.deepEqual(eventsSince(manifest)[0], { id: 'A2', kind: 'recovered-interrupted', role: 'implement' })
  assert.equal(posts.length, 1)
  assert.equal(posts[0].body.name, 'rollout:demo')
  assert.deepEqual(kindsSince(manifest), ['recovered-interrupted', 'driver-start'])
})

test('tick: maintainer feedback waits for a quiet window, then sends the PR to a fix run', async () => {
  const comment = { id: 501, user: { login: 'maint' }, body: 'Please rename the flag.' }
  const routesAt = (createdAt) => [
    prRoute(),
    { path: `${PR_11}/comments`, body: [] },
    { path: `${PR_11}/reviews`, body: [] },
    { path: 'repos/example/widgets/issues/11/comments', body: [{ ...comment, created_at: createdAt }] },
  ]

  const { manifest, driver, github } = tickDriver(samplePrs(), { rules: [FETCH], routes: routesAt(new Date().toISOString()) })
  const entry = driver.ledger.prs.A1

  manifest.repo.maintainers = ['maint']
  await driver.tick()

  assert.equal(entry.state, 'verified')
  assert.equal(entry.feedbackWaiting, true)
  assert.ok(!kindsSince(manifest).includes('review-feedback'))

  // minutesSince reads Date.now(), not the driver's clock, so the comment ages instead.
  github.answer(routesAt(new Date(Date.now() - 10 * 60_000).toISOString()))
  await driver.tick()

  assert.ok(kindsSince(manifest).includes('review-feedback'))
  assert.equal(entry.state, 'needs_fix')
})

test('tick: a deleted manifest.yaml is rejected once, and loads again when it is back', async () => {
  const { manifest, driver, notices } = tickDriver(samplePrs(), { rules: [FETCH], routes: [prRoute()] })
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
  const viewFails = { path: PR_11, status: 404, body: { message: 'Not Found' } }
  const { manifest, driver, github, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH], routes: [viewFails] })
  const entry = driver.ledger.prs.A1
  const errorCounts = (from) =>
    eventsSince(manifest, from)
      .filter((event) => event.id === 'A1' && event.kind === 'error')
      .map((event) => event.count)

  gate.error = new Error('gate down')
  await driver.tick()

  assert.deepEqual(errorCounts(0), [1, 1])
  assert.equal(entry.tickErrors, 1)

  github.answer([prRoute()])
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
  github.answer([viewFails])
  await driver.tick()

  assert.deepEqual(errorCounts(before), [6])
  assert.equal(entry.state, 'escalated')
  assert.equal(notices.length, 1)
  assert.equal(kindsSince(manifest).filter((kind) => kind === 'escalated').length, 1)
})

// A load balancer's 502 carries no JSON message.
const VIEW_502 = { path: PR_11, status: 502, body: '<html><body>Bad Gateway</body></html>', headers: { 'content-type': 'text/html' } }
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
  const { manifest, driver, github, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH], routes: [VIEW_502] })
  const entry = driver.ledger.prs.A1
  gate.error = new GitHubError({
    method: 'GET',
    path: 'repos/example/widgets/pulls/11/reviews',
    status: 500,
    kind: 'http',
    detail: 'HTTP 500: Server Error',
  })

  assert.deepEqual(await unavailablePerTick(manifest, driver, 6), [1, 1, 1, 1, 1, 1])
  assert.deepEqual(kindsSince(manifest), Array(6).fill('github-unavailable'))
  assert.equal(entry.state, 'verified')
  assert.equal(entry.tickErrors ?? 0, 0)
  assert.equal(entry.lastError, null)
  assert.equal(gate.calls, 6)
  assert.deepEqual(notices, [])

  const [first] = eventsSince(manifest)
  const outage = driver.ledger.data.githubUnavailable

  assert.deepEqual(first, {
    id: '-',
    kind: 'github-unavailable',
    source: 'A1',
    error: 'GET repos/example/widgets/pulls/11: HTTP 502: Bad Gateway',
    minutes: 0,
  })

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

  github.answer([prRoute()])
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
  const { manifest, driver, github, gate, notices } = tickDriver(
    { A1: { ...samplePrs().A1, tickErrors: 3 } },
    { rules: [FETCH], routes: [VIEW_502] },
  )

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

  github.answer([prRoute()])
  gate.error = null
  const before = readEvents(manifest).length
  await driver.tick()

  assert.equal(entry.tickErrors, 0)
  assert.deepEqual(eventsSince(manifest, before), [{ id: '-', kind: 'github-back', minutes: 0 }])
  assert.equal(driver.ledger.data.githubUnavailable, null)
  assert.deepEqual(notices, [])
})

test('tick: a fetch lost to an outage skips the gate, logs no fetch-failed and leaves the count of fetch failures alone', async () => {
  const { manifest, driver, tools, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH_UNREACHABLE], routes: [prRoute()] })

  assert.deepEqual(await unavailablePerTick(manifest, driver, 5), [1, 1, 1, 1, 1])
  assert.deepEqual(
    eventsSince(manifest).map((event) => [event.kind, event.source]),
    Array(5).fill(['github-unavailable', 'fetch']),
  )

  assert.equal(gate.calls, 0)
  assert.deepEqual(notices, [])

  for (const fetch of [FETCH_FAILS, FETCH_UNREACHABLE, FETCH_FAILS]) {
    tools.answer([fetch])
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
const VIEW_401 = { path: PR_11, status: 401, body: { message: 'Bad credentials' } }

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

test('tick: for two minutes after a sleep, failed GitHub requests and git calls are an outage', async () => {
  const time = fakeClock()
  const { manifest, driver, tools, github, notices } = tickDriver(samplePrs(), { rules: [FETCH], routes: [prRoute()], clock: time.clock })
  const entry = driver.ledger.prs.A1

  await driver.tick()
  time.move(90_000)
  await driver.tick()

  assert.deepEqual(kindsSince(manifest), [])

  tools.answer([FETCH_FAILS])
  github.answer([VIEW_401])
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

test('tick: after a sleep, an error that is no failed GitHub request or gh or git call still counts', async () => {
  const time = fakeClock()
  const { manifest, driver, gate, notices } = tickDriver(samplePrs(), { rules: [FETCH], routes: [prRoute()], clock: time.clock })

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
  const { manifest, driver, notices } = tickDriver(samplePrs(), { rules: [FETCH], routes: [prRoute()] })
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

const BASE_TIP = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'
const LIMITED = { 'x-ratelimit-remaining': '4870' }

// A1 verified, unheld and waiting for rollout approve under merge: human,
// with maintainers set and the real collectFacts. The fake git prints no
// diff, so the patch is 'empty'. The PR carries the labels it should, so no
// label is written.
function countedDriver() {
  const { A1 } = samplePrs()
  const dir = makeRollout({
    prs: { A1: { ...A1, held: null, approved: null, verified: { ...A1.verified, patchId: 'empty' } } },
    events: [],
    policy: { concurrency: 0 },
  })

  fakeTools(dir, [FETCH, { tool: 'git', args: 'rev-parse origin/main', stdout: `${BASE_TIP}\n` }, { tool: 'git', args: '', stdout: '' }])

  const manifest = loadManifest(dir)

  manifest.repo.maintainers = ['maintainer']

  const driver = createDriver(manifest, { notify: () => {}, cleanup: async () => {} })
  const labels = [manifest.label, ...stageLabels(driver.ledger.prs.A1)].map((name) => ({ name }))
  const routes = [
    prRoute({ labels }),
    runsRoute(SHA),
    runsRoute(BASE_TIP),
    { path: `${PR_11}/reviews`, body: [] },
    { path: `${PR_11}/comments`, body: [] },
    { path: 'repos/example/widgets/issues/11/comments', body: [] },
    { path: 'repos/example/widgets/code-scanning/alerts', body: [] },
  ]

  const github = fakeGitHub(routes.map((route) => ({ ...route, headers: LIMITED })))

  setFetch(github.fetch, { token: async () => MAINTAINER_TOKEN })

  return { manifest, driver, github }
}

test('tick: a verified PR waiting for approval reads each GitHub fact once, 7 GETs a tick, and the heartbeat counts them', async () => {
  const { manifest, driver, github } = countedDriver()
  const heartbeat = () => readFileSync(join(manifest.dir, 'heartbeat'), 'utf8')

  await driver.tick()

  assert.equal(driver.ledger.prs.A1.gate.code, 'awaiting-inbox-approval')
  assert.deepEqual(
    github
      .requests()
      .map((request) => `${request.method} ${request.path}`)
      .sort(),
    [
      'GET repos/example/widgets/code-scanning/alerts',
      `GET repos/example/widgets/commits/${SHA}/check-runs`,
      `GET repos/example/widgets/commits/${BASE_TIP}/check-runs`,
      'GET repos/example/widgets/issues/11/comments',
      `GET ${PR_11}`,
      `GET ${PR_11}/comments`,
      `GET ${PR_11}/reviews`,
    ],
  )

  assert.match(heartbeat(), /^\S+ tick \d+ requests=7 cached=0 remaining=4870$/)

  await driver.tick()

  // The fake's 304s carry no rate limit, so the one from the first tick stays.
  assert.deepEqual(
    github
      .requests()
      .slice(7)
      .map((request) => request.status),
    [304, 304, 304, 304, 304, 304, 304],
  )

  assert.match(heartbeat(), /^\S+ tick \d+ requests=7 cached=7 remaining=4870$/)
})

test('tick: a tick longer than policy.tickSeconds logs tick-slow with its numbers, at most once in ten minutes', async () => {
  const time = fakeClock()
  const { manifest, driver, gate } = tickDriver(samplePrs(), { rules: [FETCH], routes: [prRoute()], clock: time.clock })
  const slow = () => eventsSince(manifest).filter((event) => event.kind === 'tick-slow')
  const logged = []

  // Inside the tick: a gap between ticks would read as sleep.
  gate.pr = () => {
    time.move(6 * 60_000)

    return {}
  }

  for (let i = 0; i < 3; i += 1) {
    await driver.tick()
    logged.push(slow().length)
  }

  assert.equal(gate.calls, 3)
  assert.deepEqual(logged, [1, 1, 2])
  // Each tick reads PR 11 and posts a stage label, which the fake refuses.
  assert.deepEqual(slow(), [
    { id: '-', kind: 'tick-slow', ms: 360_000, requests: 2, cached: 0, remaining: null },
    { id: '-', kind: 'tick-slow', ms: 360_000, requests: 2, cached: 1, remaining: null },
  ])

  assert.ok(!kindsSince(manifest).includes('machine-slept'))
  assert.match(readFileSync(join(manifest.dir, 'heartbeat'), 'utf8'), / tick 360000 requests=2 cached=1 remaining=-$/)
})

const REJECTED = { ...samplePrs().A1, state: 'needs_fix', fixReason: 'verifier findings', verified: null, approved: null }
const REJECTED_LABELS = ['rollout-stage:needs-fix', 'rollout-reason:verifier-findings']
const PR_LABELS = 'repos/example/widgets/issues/11/labels'

// GitHub creating any label, adding labels to PR 11 and removing `removed` from it.
function labelRoutes(removed = []) {
  return [
    { method: 'POST', path: 'repos/example/widgets/labels', status: 201, body: {} },
    { method: 'POST', path: PR_LABELS, body: [] },
    ...removed.map((name) => ({ method: 'DELETE', path: `${PR_LABELS}/${encodeURIComponent(name)}`, body: [] })),
  ]
}

// A1's PR carrying these labels, next to the rollout's own.
function prWithLabels(labels) {
  return prRoute({ labels: ['rollout:demo', ...labels].map((name) => ({ name })) })
}

// The label writes on PR 11: the labels each POST adds, the label each DELETE removes.
function labelWrites(github) {
  return github
    .requests()
    .filter((request) => request.path.startsWith(PR_LABELS))
    .map((request) => {
      if (request.method === 'POST') {
        return ['add', ...request.body.labels]
      }

      return [request.method.toLowerCase(), decodeURIComponent(request.path.slice(PR_LABELS.length + 1))]
    })
}

test('tick: a PR sent back by the verifier gets its stage and reason as labels, once', async () => {
  const { driver, github } = tickDriver({ A1: REJECTED }, { rules: [FETCH], routes: [prRoute(), ...labelRoutes()] })

  await driver.tick()
  github.answer([prWithLabels(REJECTED_LABELS), ...labelRoutes()])
  await driver.tick()

  assert.deepEqual(labelWrites(github), [['add', 'rollout-stage:needs-fix', 'rollout-reason:verifier-findings']])
  assert.deepEqual(
    github
      .requests()
      .filter((request) => request.path === 'repos/example/widgets/labels')
      .map((request) => request.body),
    [
      { name: 'rollout-stage:needs-fix', color: '1d76db', description: 'Rollout stage, set by the driver' },
      { name: 'rollout-reason:verifier-findings', color: 'd93f0b', description: 'Rollout stage, set by the driver' },
    ],
  )

  assert.deepEqual(driver.ledger.prs.A1.stageLabels, REJECTED_LABELS)
})

test('tick: when the PR moves on, the old stage and reason come off', async () => {
  const { driver, github } = tickDriver({ A1: REJECTED }, { rules: [FETCH], routes: [prRoute(), ...labelRoutes()] })

  await driver.tick()
  github.answer([prWithLabels(REJECTED_LABELS), ...labelRoutes(REJECTED_LABELS)])
  driver.ledger.prs.A1.state = 'verifying'
  await driver.tick()

  assert.deepEqual(labelWrites(github).slice(1), [
    ['add', 'rollout-stage:verifying'],
    ['delete', 'rollout-stage:needs-fix'],
    ['delete', 'rollout-reason:verifier-findings'],
  ])

  assert.equal(github.requests().at(-1).path, `${PR_LABELS}/rollout-reason%3Averifier-findings`)
})

test('tick: the labels the PR really carries count, so one removed or added by hand is put right', async () => {
  const { driver, github } = tickDriver(
    { A1: REJECTED },
    {
      rules: [FETCH],
      routes: [
        prWithLabels(['rollout-reason:verifier-findings', 'rollout-stage:verified', 'bug']),
        ...labelRoutes(['rollout-stage:verified']),
      ],
    },
  )

  await driver.tick()

  assert.deepEqual(labelWrites(github), [
    ['add', 'rollout-stage:needs-fix'],
    ['delete', 'rollout-stage:verified'],
  ])
})

test('tick: a label that is off already counts as removed', async () => {
  const gone = { method: 'DELETE', path: `${PR_LABELS}/rollout-stage%3Averified`, status: 404, body: { message: 'Label does not exist' } }
  const { driver } = tickDriver(
    { A1: REJECTED },
    { rules: [FETCH], routes: [prWithLabels(['rollout-reason:verifier-findings', 'rollout-stage:verified']), gone, ...labelRoutes()] },
  )

  await driver.tick()

  assert.equal(driver.ledger.prs.A1.stageLabelError, null)
  assert.deepEqual(driver.ledger.prs.A1.stageLabels, REJECTED_LABELS)
})

test('tick: a label that exists already is updated, as gh label create --force did', async () => {
  const exists = { method: 'POST', path: 'repos/example/widgets/labels', status: 422, body: { message: 'Validation Failed' } }
  const updated = (name) => ({ method: 'PATCH', path: `repos/example/widgets/labels/${encodeURIComponent(name)}`, body: {} })
  const { driver, github } = tickDriver(
    { A1: REJECTED },
    { rules: [FETCH], routes: [prRoute(), exists, ...REJECTED_LABELS.map(updated), ...labelRoutes()] },
  )

  await driver.tick()

  assert.deepEqual(
    github
      .requests()
      .filter((request) => request.method === 'PATCH')
      .map((request) => [request.path, request.body]),
    [
      ['repos/example/widgets/labels/rollout-stage%3Aneeds-fix', { color: '1d76db', description: 'Rollout stage, set by the driver' }],
      [
        'repos/example/widgets/labels/rollout-reason%3Averifier-findings',
        { color: 'd93f0b', description: 'Rollout stage, set by the driver' },
      ],
    ],
  )

  assert.deepEqual(driver.ledger.prs.A1.stageLabels, REJECTED_LABELS)
})

test('tick: during a GitHub outage no label call is made', async () => {
  const { driver, github } = tickDriver({ A1: REJECTED }, { rules: [FETCH], routes: [VIEW_502, ...labelRoutes()] })

  await driver.tick()

  assert.ok(driver.ledger.data.githubUnavailable)
  assert.deepEqual(labelWrites(github), [])
  assert.ok(!github.requests().some((request) => request.path.includes('/labels')))
})

test('tick: a label GitHub refuses is kept on the PR row, counts no error and is tried again', async () => {
  const refused = { method: 'POST', path: PR_LABELS, status: 403, body: { message: 'Resource not accessible by integration' } }
  const { manifest, driver, github } = tickDriver({ A1: REJECTED }, { rules: [FETCH], routes: [prRoute(), refused, ...labelRoutes()] })
  const before = readEvents(manifest).length

  await driver.tick()

  assert.match(driver.ledger.prs.A1.stageLabelError, /HTTP 403/)
  assert.deepEqual(driver.ledger.prs.A1.stageLabels, [])
  assert.ok(!eventsSince(manifest, before).some((event) => event.kind === 'error' && /labels/.test(event.error ?? '')))

  github.answer([prRoute(), ...labelRoutes()])
  await driver.tick()

  assert.equal(driver.ledger.prs.A1.stageLabelError, null)
  assert.equal(labelWrites(github).length, 2)
})
