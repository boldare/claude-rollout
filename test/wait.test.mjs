import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postCommand } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { ROLES } from '../lib/view.mjs'
import {
  QUIET_KINDS,
  WAKE_KINDS,
  classify,
  formatItem,
  parseReadyWithin,
  parseSince,
  timedItems,
  standingItems,
  waitForAttention,
  wakes,
} from '../lib/wait.mjs'
import { makeRollout } from './fixtures.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const BIN = join(ROOT, 'bin', 'rollout.mjs')
const NOON = Date.parse('2026-09-01T12:00:00.000Z')
const MINUTE = 60_000

function iso(ms) {
  return new Date(ms).toISOString()
}

// Every kind the driver can write: the literal second argument of say() and
// ledger.event(), and the few it builds from a variable.
function writtenKinds() {
  const lib = join(ROOT, 'lib')
  const sources = readdirSync(lib)
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => readFileSync(join(lib, file), 'utf8'))
    .join('\n')

  const literal = new Set()
  const dynamic = new Set()

  for (const match of sources.matchAll(/\b(?:say|ledger\.event)\(\s*[^,]+?,\s*([^,)]+)/g)) {
    const argument = match[1].trim()
    const quoted = argument.match(/^'([a-z-]+)'$/)

    if (quoted) {
      literal.add(quoted[1])
    } else {
      dynamic.add(argument)
    }
  }

  const steps = [...sources.matchAll(/driverStep\('([a-z-]+)'/g)].map((match) => `${match[1]}-failed`)
  const actions = [...readFileSync(join(lib, 'judge.mjs'), 'utf8').matchAll(/verdict\('([a-z]+)'/g)].map((match) => `gate-${match[1]}`)

  // `kind` is say's own parameter and driverStep's `${step}-failed`.
  const expansions = {
    kind: steps,
    '`${role}-start`': ROLES.map((role) => `${role}-start`),
    '`${role}-done`': ROLES.map((role) => `${role}-done`),
    '`gate-${verdict.action}`': [...actions, 'gate-ready'],
  }

  assert.deepEqual([...dynamic].sort(), Object.keys(expansions).sort(), 'a new way of naming an event kind needs its expansion here')

  return new Set([...literal, ...Object.values(expansions).flat()])
}

test('wait: every kind the driver writes either wakes or stays quiet', () => {
  const written = writtenKinds()

  assert.ok(written.size > 50, `found only ${written.size} kinds`)

  for (const kind of written) {
    assert.notEqual(classify(kind), null, `${kind} is written by the driver but neither in WAKE_KINDS nor QUIET_KINDS (lib/wait.mjs)`)
  }

  for (const kind of [...Object.keys(WAKE_KINDS), ...QUIET_KINDS]) {
    assert.ok(written.has(kind), `${kind} is in lib/wait.mjs but the driver never writes it`)
  }

  for (const kind of QUIET_KINDS) {
    assert.ok(!Object.hasOwn(WAKE_KINDS, kind), `${kind} is both quiet and waking`)
  }
})

test('wait: the rules inside a waking kind', () => {
  assert.equal(wakes({ kind: 'blocked', reason: 'ci' }), true)
  assert.equal(wakes({ kind: 'blocked', reason: 'needs-decision', delegate: true }), false)
  assert.equal(wakes({ kind: 'error', count: 1 }), true)
  assert.equal(wakes({ kind: 'error', count: 2 }), false)
  assert.equal(wakes({ kind: 'paused', reason: 'credit balance is too low' }), true)
  assert.equal(wakes({ kind: 'paused' }), false)
  assert.equal(wakes({ kind: 'verified', sha: 'a1a1a1a' }), false)
  assert.equal(wakes({ kind: 'gate-wait', reasons: [] }), false)
  assert.equal(wakes({ kind: 'something-new' }), false)
})

test('wait: --since takes lines or an ISO time, --ready-within whole minutes', () => {
  assert.equal(parseSince(undefined), null)
  assert.deepEqual(parseSince('42'), { lines: 42 })
  assert.deepEqual(parseSince('2026-09-01T12:00:00.000Z'), { time: NOON })
  assert.throws(() => parseSince('yesterday'), /--since must be/)
  assert.throws(() => parseSince('5m'), /--since must be/)
  assert.equal(parseReadyWithin(undefined), 15)
  assert.equal(parseReadyWithin('0'), 0)
  assert.throws(() => parseReadyWithin('1.5'), /--ready-within must be/)
})

function ledgerOf(prs, extra = {}) {
  return { prs, paused: false, halted: null, ...extra }
}

const RUN = [{ at: iso(NOON - 60 * MINUTE), id: '-', kind: 'driver-start', prs: ['A1', 'A2'] }]

function standing(prs, { events = RUN, pending = [], extra = {}, merge = 'manual' } = {}) {
  const manifest = loadManifest(makeRollout({ policy: { merge } }))

  return standingItems(manifest, ledgerOf(prs, extra), events, { now: NOON, readyWithinMs: 15 * MINUTE, pending })
}

test('wait: at start, what already waits is reported, for the PRs of this run only', () => {
  const items = standing({
    A1: { state: 'blocked', blocked: { kind: 'ci', question: 'CI is red\nthree times.' } },
    A2: { state: 'verified', verified: { at: iso(NOON - MINUTE) }, gate: { action: 'ready', reasons: ['ready: merge it on GitHub'] } },
    A3: { state: 'escalated', lastError: 'fix attempts exhausted' },
  })

  assert.deepEqual(items.map(formatItem), [
    '2026-09-01T12:00:00.000Z A1   blocked ci: CI is red three times.',
    '2026-09-01T12:00:00.000Z A2   ready-to-merge ready: merge it on GitHub',
  ])
})

test('wait: at start, halted, paused, escalated and a stalled verified PR are reported', () => {
  const items = standing(
    {
      A1: { state: 'escalated', lastError: 'fix attempts exhausted' },
      A2: { state: 'verified', verified: { at: iso(NOON - 20 * MINUTE) }, gate: { action: 'wait', reasons: ['main is not green'] } },
    },
    { extra: { halted: 'main is red after merging A0', paused: true } },
  )

  assert.deepEqual(
    items.map((item) => `${item.id} ${item.kind}`),
    ['- halted', '- paused', 'A1 escalated', 'A2 verified-stalled'],
  )

  assert.equal(items[3].at, iso(NOON - 5 * MINUTE))
  assert.match(items[3].text, /not ready to merge 15 min later\. Gate wait: main is not green/)
})

test('wait: at start, a command waiting in the inbox counts as the answer', () => {
  const prs = { A1: { state: 'blocked', blocked: { kind: 'ci', question: 'Red.' } }, A2: { state: 'escalated' } }
  const pending = [{ cmd: 'note', id: 'A1', text: 'Rerun it.' }, { cmd: 'retry', id: 'A2' }, { cmd: 'unhalt' }]

  assert.deepEqual(standing(prs, { pending, extra: { halted: 'red' } }), [])
})

test('wait: at start, a question the delegate has waits for its escalation', () => {
  const prs = { A1: { state: 'blocked', blocked: { kind: 'needs-decision', question: 'Keep the flag?' } } }
  const blocked = { at: iso(NOON - 5 * MINUTE), id: 'A1', kind: 'blocked', reason: 'needs-decision', delegate: true }
  const escalated = { at: iso(NOON - 2 * MINUTE), id: 'A1', kind: 'delegate-escalated', blocked: 'needs-decision' }

  assert.deepEqual(standing(prs, { events: [...RUN, blocked] }), [])
  assert.deepEqual(
    standing(prs, { events: [...RUN, blocked, escalated] }).map((item) => item.kind),
    ['blocked'],
  )
})

test('wait: a verified PR stalls once, unless it is ready, merging, queued or held', () => {
  const verified = { state: 'verified', verified: { at: iso(NOON) }, gate: { action: 'wait', reasons: ['CI pending'] } }
  const ledger = ledgerOf({
    A1: verified,
    A2: { ...verified, gate: { action: 'wait', reasons: ['after PR #11'], after: 11 } },
    A3: { ...verified, held: { at: iso(NOON) } },
    A4: { ...verified, gate: { action: 'merge', reasons: [] } },
  })

  const ids = ['A1', 'A2', 'A3', 'A4']
  const window = (after, upTo, merge = 'manual') =>
    timedItems(ledger, [], ids, { after, upTo, readyWithinMs: 15 * MINUTE, merge }).map((item) => item.id)

  assert.deepEqual(window(NOON, NOON + 14 * MINUTE), [])
  assert.deepEqual(window(NOON, NOON + 15 * MINUTE), ['A1'])
  assert.deepEqual(window(NOON + 15 * MINUTE, NOON + 60 * MINUTE), [])
  assert.deepEqual(window(NOON, NOON + 15 * MINUTE, 'human'), [])
  ledger.prs.A1.approved = { patchId: 'patch-a1' }
  ledger.prs.A1.verified.patchId = 'patch-a1'
  assert.deepEqual(window(NOON, NOON + 15 * MINUTE, 'human'), ['A1'])
})

// A rollout whose driver is this test process, with a fake clock that each
// sleep moves on and a script of what happens at each poll.
function waiting({
  prs = { A1: { state: 'implementing' }, A2: { state: 'pending' } },
  events = RUN,
  lock = true,
  merge = 'manual',
  policy = {},
} = {}) {
  const dir = makeRollout({ prs, events: null, lock, policy: { merge, ...policy } })
  const file = join(dir, 'events.jsonl')
  const manifest = loadManifest(dir)
  const script = []
  let now = NOON
  let polls = 0

  writeFileSync(file, events.map((event) => `${JSON.stringify(event)}\n`).join(''))

  function append(event, { newline = true } = {}) {
    appendFileSync(file, `${JSON.stringify({ at: iso(now), ...event })}${newline ? '\n' : ''}`)
  }

  async function sleep(ms) {
    now += ms
    polls += 1

    if (polls > 2_000) {
      throw new Error('the wait never ended')
    }

    script.shift()?.()
  }

  function run(options = {}) {
    return waitForAttention(manifest, { clock: () => now, sleep, ...options })
  }

  return { dir, manifest, script, append, run, polls: () => polls, now: () => now, jump: (ms) => (now += ms) }
}

function kinds(result) {
  return result.items.map((item) => `${item.id} ${item.kind}`)
}

function savedAt(dir, ms) {
  utimesSync(join(dir, 'ledger.json'), new Date(ms), new Date(ms))
}

test('wait: at start, an event the ledger does not show yet is reported, once', async () => {
  const events = [
    ...RUN,
    { at: iso(NOON - 3_000), id: 'A1', kind: 'escalated', reason: 'repeated errors' },
    { at: iso(NOON - 2_000), id: 'A2', kind: 'blocked', reason: 'ci' },
  ]

  const prs = { A1: { state: 'fixing' }, A2: { state: 'blocked', blocked: { kind: 'ci', question: 'Red.' } } }
  const rollout = waiting({ prs, events })

  savedAt(rollout.dir, NOON - 4_000)

  assert.deepEqual(kinds(await rollout.run()), ['A2 blocked', 'A1 escalated'])
})

test('wait: a wait from the printed cursor repeats nothing the last one printed', async () => {
  const rollout = waiting({
    prs: { A1: { state: 'blocked', blocked: { kind: 'ci', question: 'Red.' } } },
    events: [...RUN, { at: iso(NOON - 500), id: 'A1', kind: 'blocked', reason: 'ci' }],
  })

  savedAt(rollout.dir, NOON - 10_000)

  const first = await rollout.run()

  assert.deepEqual(kinds(first), ['A1 blocked'])

  rollout.script.push(() => rollout.append({ id: 'A1', kind: 'escalated', role: 'fix' }))

  assert.deepEqual(kinds(await rollout.run({ since: parseSince(first.cursor) })), ['A1 escalated'])
})

test('wait: after a driver that died, the next wait from the cursor exits 2 and repeats nothing', async () => {
  const rollout = waiting()

  rollout.script.push(() => {
    rollout.append({ id: 'A1', kind: 'escalated', role: 'fix' })
    rmSync(join(rollout.dir, 'driver.lock'))
  })

  const first = await rollout.run()

  assert.deepEqual(kinds(first), ['A1 escalated'])

  const second = await rollout.run({ since: parseSince(first.cursor) })

  assert.equal(second.exit, 2)
  assert.deepEqual(second.items, [])
})

test('wait: --since in lines never repeats a line younger than a second', async () => {
  const rollout = waiting({ events: [...RUN, { at: iso(NOON - 200), id: 'A1', kind: 'blocked', reason: 'ci' }] })

  rollout.script.push(
    () => {},
    () => rollout.append({ id: 'A2', kind: 'ready-to-merge', pr: 12 }),
  )

  assert.deepEqual(kinds(await rollout.run({ since: { lines: 2 } })), ['A2 ready-to-merge'])
})

test('wait: a question the delegate took and no delegate run picked up wakes once, as delegate-idle', async () => {
  const prs = { A1: { state: 'blocked', blocked: { kind: 'needs-decision', question: 'Keep the flag?' } } }
  const blocked = { at: iso(NOON - 14 * MINUTE), id: 'A1', kind: 'blocked', reason: 'needs-decision', delegate: true }
  const idle = waiting({ prs, events: [...RUN, blocked] })
  const result = await idle.run()

  assert.deepEqual(kinds(result), ['A1 delegate-idle'])
  assert.equal(result.items[0].at, iso(NOON + MINUTE))

  const started = { at: iso(NOON - 13 * MINUTE), id: 'A1', kind: 'delegate-start', run: 'A1-01-delegate' }
  const busy = waiting({ prs, events: [...RUN, blocked, started] })

  busy.script.push(...Array.from({ length: 60 }, () => () => {}))
  busy.script.push(() => busy.append({ id: 'A1', kind: 'delegate-escalated', blocked: 'needs-decision' }))

  assert.deepEqual(kinds(await busy.run()), ['A1 delegate-escalated'])
  assert.ok(busy.now() > NOON + 2 * MINUTE)

  const stopped = { at: iso(NOON - 13 * MINUTE), id: 'A1', kind: 'delegate-done', run: 'A1-01-delegate', ok: false, stopped: true }
  const dropped = waiting({ prs, events: [...RUN, blocked, started, stopped] })

  assert.deepEqual(kinds(await dropped.run()), ['A1 delegate-idle'])
  assert.equal(standing(prs, { events: [...RUN, { ...blocked, at: iso(NOON - 20 * MINUTE) }] })[0].kind, 'delegate-idle')
})

test('wait: under merge: human a verified PR waits for approval and wakes at once', async () => {
  const verified = {
    state: 'verified',
    pr: 11,
    verified: { at: iso(NOON - MINUTE), patchId: 'patch-a1' },
    gate: { action: 'wait', reasons: ['awaiting approval'] },
  }

  assert.deepEqual(
    standing({ A1: verified }, { merge: 'human' }).map((item) => `${item.id} ${item.kind}`),
    ['A1 verified'],
  )

  assert.deepEqual(standing({ A1: { ...verified, approved: { patchId: 'patch-a1' } } }, { merge: 'human' }), [])
  assert.deepEqual(standing({ A1: verified }, { merge: 'manual' }), [])

  const rollout = waiting({ merge: 'human' })

  rollout.script.push(
    () => {},
    () => rollout.append({ id: 'A1', kind: 'verified', sha: 'a1a1a1a' }),
  )

  assert.deepEqual(kinds(await rollout.run()), ['A1 verified'])
})

test('wait: the heartbeat limit is three ticks when that is longer than 30 minutes', async () => {
  const slow = waiting({ policy: { tickSeconds: 1200 } })
  const result = await slow.run()

  assert.equal(result.exit, 2)
  assert.ok(slow.now() - NOON > 60 * MINUTE && slow.now() - NOON < 61 * MINUTE, `${(slow.now() - NOON) / MINUTE} min`)
})

test('wait: it sleeps through quiet events and returns at the first that needs someone', async () => {
  const rollout = waiting()

  rollout.script.push(
    () => rollout.append({ id: 'A1', kind: 'implement-done', ok: true }),
    () => rollout.append({ id: 'A1', kind: 'error', error: 'boom', count: 2 }),
    () => rollout.append({ id: 'A1', kind: 'blocked', reason: 'needs-decision', delegate: true }),
    () => {
      rollout.append({ id: 'A1', kind: 'delegate-escalated', blocked: 'needs-decision' })
      rollout.append({ id: 'A2', kind: 'command-rejected', command: 'retry', reason: 'already merged' })
    },
    () => rollout.append({ id: 'A2', kind: 'escalated', role: 'fix' }),
  )

  const result = await rollout.run()

  assert.equal(result.exit, 0)
  assert.deepEqual(
    result.items.map((item) => `${item.id} ${item.kind}`),
    ['A1 delegate-escalated', 'A2 command-rejected'],
  )

  assert.equal(result.cursor, iso(rollout.now() - 1000))
})

test('wait: the printed cursor resumes after what it reported, with nothing lost or repeated', async () => {
  const rollout = waiting()

  rollout.script.push(
    () => rollout.append({ id: 'A1', kind: 'blocked', reason: 'ci' }),
    () => rollout.append({ id: 'A1', kind: 'note-queued', state: 'blocked' }),
  )

  const first = await rollout.run()

  assert.deepEqual(
    first.items.map((item) => item.kind),
    ['blocked'],
  )

  rollout.append({ id: 'A1', kind: 'escalated', role: 'fix' })
  rollout.jump(5_000)

  const second = await rollout.run({ since: parseSince(first.cursor) })

  assert.deepEqual(
    second.items.map((item) => item.kind),
    ['escalated'],
  )
})

test('wait: --since in lines replays from that line', async () => {
  const events = [...RUN, { at: iso(NOON - 30 * MINUTE), id: 'A1', kind: 'blocked', reason: 'ci' }]
  const rollout = waiting({ events })

  assert.deepEqual(
    (await rollout.run({ since: { lines: 1 } })).items.map((item) => item.kind),
    ['blocked'],
  )

  rollout.script.push(() => rollout.append({ id: 'A2', kind: 'ready-to-merge', pr: 12 }))

  assert.deepEqual(
    (await rollout.run({ since: { lines: 2 } })).items.map((item) => item.kind),
    ['ready-to-merge'],
  )
})

test('wait: a line still being written is read once it is complete', async () => {
  const rollout = waiting()

  rollout.script.push(
    () => rollout.append({ id: 'A1', kind: 'escalated', role: 'fix' }, { newline: false }),
    () => {},
    () => appendFileSync(join(rollout.dir, 'events.jsonl'), '\n'),
  )

  const result = await rollout.run()

  assert.equal(result.items[0].kind, 'escalated')
  assert.equal(rollout.polls(), 3)
})

test('wait: a verified PR that never gets ready wakes it once, as verified-stalled', async () => {
  const prs = {
    A1: { state: 'verified', verified: { at: iso(NOON - 14 * MINUTE) }, gate: { action: 'wait', reasons: ['main is not green'] } },
  }

  const rollout = waiting({ prs })
  const result = await rollout.run()

  assert.deepEqual(
    result.items.map((item) => `${item.id} ${item.kind}`),
    ['A1 verified-stalled'],
  )

  assert.ok(rollout.now() >= NOON + MINUTE && rollout.now() < NOON + MINUTE + 5_000, iso(rollout.now()))
})

test('wait: the driver stopping after finished is the end, without finished it exits 2', async () => {
  const finished = waiting()

  finished.script.push(() => {
    finished.append({ id: '-', kind: 'finished', cost: 12.5, release: null })
    rmSync(join(finished.dir, 'driver.lock'))
  })

  const done = await finished.run()

  assert.equal(done.exit, 0)
  assert.deepEqual(
    done.items.map((item) => item.kind),
    ['finished'],
  )

  const stopped = waiting()

  stopped.script.push(() => rmSync(join(stopped.dir, 'driver.lock')))

  const gone = await stopped.run()

  assert.equal(gone.exit, 2)
  assert.deepEqual(gone.items, [])
  assert.match(gone.message, /no driver is running for demo and it has not finished/)
})

test('wait: a finished rollout with no driver reports its finished event at once', async () => {
  const rollout = waiting({ events: [...RUN, { at: iso(NOON - MINUTE), id: '-', kind: 'finished', cost: 3 }], lock: false })
  const result = await rollout.run()

  assert.equal(result.exit, 0)
  assert.equal(result.items[0].kind, 'finished')
})

test('wait: a driver that is just starting gets a few seconds to take its lock', async () => {
  const late = waiting({ lock: false })

  late.script.push(
    () => {},
    () => {},
    () => writeFileSync(join(late.dir, 'driver.lock'), JSON.stringify({ pid: process.pid, at: iso(late.now()) })),
    () => late.append({ id: 'A1', kind: 'escalated', role: 'implement' }),
  )

  assert.equal((await late.run()).items[0].kind, 'escalated')

  const never = waiting({ lock: false })
  const result = await never.run()

  assert.equal(result.exit, 2)
  assert.ok(never.now() - NOON >= 15_000 && never.now() - NOON < 20_000)
})

test('wait: a heartbeat that stops for 30 awake minutes exits 2, a sleep of the machine does not count', async () => {
  const sleeper = waiting()

  sleeper.script.push(() => sleeper.jump(8 * 60 * MINUTE))

  for (let i = 0; i < 20; i += 1) {
    sleeper.script.push(() => {})
  }

  sleeper.script.push(() => sleeper.append({ id: 'A1', kind: 'escalated', role: 'fix' }))

  assert.equal((await sleeper.run()).exit, 0)

  const hung = waiting()
  const result = await hung.run()

  assert.equal(result.exit, 2)
  assert.match(result.message, /wrote no heartbeat for 30 min/)
  assert.ok(hung.now() - NOON > 30 * MINUTE && hung.now() - NOON < 31 * MINUTE)
})

test('wait: a fresh heartbeat keeps a long wait going', async () => {
  const rollout = waiting()
  const beat = join(rollout.dir, 'heartbeat')

  for (let i = 1; i <= 1_200; i += 1) {
    rollout.script.push(() => {
      if (i % 30 === 0) {
        utimesSync(beat, new Date(NOON + i * 1000), new Date(NOON + i * 1000))
      }
    })
  }

  rollout.script.push(() => rollout.append({ id: 'A1', kind: 'halted', failing: ['test'] }))

  const result = await rollout.run()

  assert.equal(result.exit, 0)
  assert.equal(result.items[0].kind, 'halted')
})

function cli(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dirname(BIN), timeout: 30_000 })
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

test('wait CLI: exit 1 for a missing directory or a bad flag', () => {
  const missing = cli('wait', '--dir', join(makeRollout(), 'nothing-here'))

  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no manifest\.yaml/)

  const bad = cli('wait', '--dir', makeRollout(), '--since', 'yesterday')

  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /--since must be a number of lines or an ISO time/)
})

test('wait CLI: what waits at start, one line each, then the cursor to go on from', () => {
  const dir = makeRollout({ prs: { A1: { state: 'blocked', blocked: { kind: 'ci', question: 'CI is red.' } } } })
  const result = cli('wait', '--dir', dir)
  const lines = result.stdout.trim().split('\n')

  assert.equal(result.status, 0, result.stderr)
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z A1 {3}blocked ci: CI is red\.$/)
  assert.match(lines[1], new RegExp(`^next: rollout\\.mjs wait --dir ${dir} --since \\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z$`))
})

test('wait CLI: a note in the inbox is the answer, and a dead driver exits 2', () => {
  const dir = makeRollout({ prs: { A1: { state: 'blocked', blocked: { kind: 'ci', question: 'CI is red.' } } } })

  writeFileSync(join(dir, 'driver.lock'), JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }))
  utimesSync(join(dir, 'driver.lock'), new Date(Date.now() - MINUTE), new Date(Date.now() - MINUTE))
  postCommand(loadManifest(dir), { cmd: 'note', id: 'A1', text: 'Rerun it.' })

  const result = cli('wait', '--dir', dir)

  assert.equal(result.status, 2)
  assert.match(result.stderr, /^rollout wait: no driver is running for demo and it has not finished/)
  assert.match(result.stdout, /^next: rollout\.mjs wait --dir /)
})

test('wait CLI: agents cannot wait', () => {
  const result = spawnSync(process.execPath, [BIN, 'wait', '--dir', makeRollout()], {
    encoding: 'utf8',
    env: { ...process.env, ROLLOUT_ROLE: 'implement' },
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /agents cannot drive the rollout/)
})
