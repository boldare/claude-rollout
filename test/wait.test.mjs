import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postCommand } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import {
  PROGRESS_NOTICES,
  SILENT_WAKES,
  formatItem,
  parseReadyWithin,
  parseSince,
  standingItems,
  timedItems,
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

// The arguments of a call whose parenthesis opens at `from`, as source text.
function callArguments(source, from) {
  const args = []
  let current = ''
  let depth = 1
  let quote = null

  for (let i = from; i < source.length; i += 1) {
    const char = source[i]

    if (quote) {
      current += char

      if (char === '\\') {
        current += source[i + 1]
        i += 1
      } else if (char === quote) {
        quote = null
      }

      continue
    }

    if (["'", '"', '`'].includes(char)) {
      quote = char
    } else if ('([{'.includes(char)) {
      depth += 1
    } else if (')]}'.includes(char)) {
      depth -= 1
    }

    if (depth === 0) {
      break
    }

    if (char === ',' && depth === 1) {
      args.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }

  return current.trim() ? [...args, current.trim()] : args
}

// Every say() in lib/: its kind, with the few built from a variable expanded,
// and whether it can carry a message, the notice the user gets.
function sayCalls() {
  const lib = join(ROOT, 'lib')
  const source = readdirSync(lib)
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => readFileSync(join(lib, file), 'utf8'))
    .join('\n')

  const steps = [...source.matchAll(/driverStep\('([a-z-]+)'/g)].map((match) => `${match[1]}-failed`)
  const expansions = {
    kind: steps,
    '`gate-${verdict.action}`': ['gate-*'],
    '`${role}-start`': ['role-start'],
    '`${role}-done`': ['role-done'],
  }

  const calls = []

  for (const match of source.matchAll(/(?<!function )\bsay\(/g)) {
    const [, kind, , message] = callArguments(source, match.index + match[0].length)
    const quoted = kind.match(/^'([a-z-]+)'$/)
    const named = quoted ? [quoted[1]] : expansions[kind]

    assert.ok(named, `say() names its kind with ${kind}, which this test cannot expand`)

    for (const each of named) {
      calls.push({ kind: each, notice: message !== undefined && message !== 'null' })
    }
  }

  return calls
}

// What the driver tells the user about and wait wakes on. A new notice
// fails here until it is either added or made a PROGRESS_NOTICES entry.
const WAKING_NOTICES = [
  'approval-rejected',
  'awaiting-approval',
  'blocked',
  'delegate-escalated',
  'delegate-limit',
  'escalated',
  'fetch-failed',
  'finished',
  'github-blocks-merge',
  'github-unavailable',
  'halted',
  'manifest-rejected',
  'merge-refused',
  'outside-deps-failed',
  'paused',
  'ready-to-merge',
  'waiting-outside-dep',
  'watch-base-failed',
  'would-merge',
]

test('wait: every notice the driver sends either wakes it or is progress, by decision', () => {
  const calls = sayCalls()
  const notices = new Set(calls.filter((call) => call.notice).map((call) => call.kind))

  assert.ok(calls.length > 60, `found only ${calls.length} say() calls`)
  assert.deepEqual([...notices].sort(), [...WAKING_NOTICES, ...Object.keys(PROGRESS_NOTICES)].sort())

  for (const kind of WAKING_NOTICES) {
    assert.ok(!Object.hasOwn(PROGRESS_NOTICES, kind), `${kind} is both waking and progress`)
  }
})

test('wait: the events that wake without a notice are written without one, each for a reason', () => {
  const calls = sayCalls()

  for (const [kind, reason] of Object.entries({ ...SILENT_WAKES, ...PROGRESS_NOTICES })) {
    assert.ok(
      calls.some((call) => call.kind === kind),
      `${kind} is in lib/wait.mjs but the driver never writes it`,
    )

    assert.ok(reason.length > 10, `${kind} needs its reason`)
  }

  for (const kind of Object.keys(SILENT_WAKES)) {
    assert.ok(!calls.some((call) => call.kind === kind && call.notice), `${kind} is a notice now, so it wakes without SILENT_WAKES`)
  }

  // say() and the failed tick, whose event carries notified by hand. A
  // notice sent anywhere else needs the mark on its event too.
  const direct = readdirSync(join(ROOT, 'lib'))
    .filter((file) => file.endsWith('.mjs'))
    .flatMap((file) => [...readFileSync(join(ROOT, 'lib', file), 'utf8').matchAll(/(?<!function )\bnotify\(/g)])

  assert.equal(direct.length, 2, 'a new notify() call needs notified: true on its event, then count it here')
})

test('wait: it wakes on the notified mark, on the silent wakes, and on nothing else', () => {
  assert.equal(wakes({ kind: 'blocked', reason: 'ci', notified: true }), true)
  assert.equal(wakes({ kind: 'blocked', reason: 'needs-decision', delegate: true }), false)
  assert.equal(wakes({ kind: 'error', count: 1 }), false)
  assert.equal(wakes({ kind: 'tick-error', count: 4 }), false)
  assert.equal(wakes({ kind: 'tick-error', count: 5, notified: true }), true)
  assert.equal(wakes({ kind: 'merged', pr: 11, notified: true }), false)
  assert.equal(wakes({ kind: 'merged', pr: 11, by: 'maintainer' }), false)
  assert.equal(wakes({ kind: 'verified', sha: 'a1a1a1a', notified: true }), false)
  assert.equal(wakes({ kind: 'merged-outside-driver', pr: 11 }), true)
  assert.equal(wakes({ kind: 'command-rejected', command: 'retry' }), true)
  assert.equal(wakes({ kind: 'paused' }), false)
  assert.equal(wakes({ kind: 'something-new', notified: true }), true)
  assert.equal(wakes({ kind: 'something-new' }), false)
})

test('wait: --since takes the ISO time a wait printed, --ready-within whole minutes', () => {
  assert.equal(parseSince(undefined), null)
  assert.equal(parseSince('2026-09-01T12:00:00.000Z'), NOON)
  assert.throws(() => parseSince('42'), /--since must be the ISO time a wait printed/)
  assert.throws(() => parseSince('yesterday'), /--since must be/)
  assert.equal(parseReadyWithin(undefined), 15)
  assert.equal(parseReadyWithin('0'), 0)
  assert.throws(() => parseReadyWithin('1.5'), /--ready-within must be/)
})

function ledgerOf(prs, extra = {}) {
  return { prs, paused: false, halted: null, ...extra }
}

const RUN = [{ at: iso(NOON - 60 * MINUTE), id: '-', kind: 'driver-start', prs: ['A1', 'A2'], pid: process.pid, noticeMarks: true }]

// A verified PR whose gate verdict is from after its verification.
function verifiedPr(gate, { at = NOON - MINUTE, ...extra } = {}) {
  return { state: 'verified', pr: 11, verified: { at: iso(at), patchId: 'patch-a1' }, gate: { at: iso(at + 1000), ...gate }, ...extra }
}

function standing(prs, { events = RUN, pending = [], extra = {}, merge = 'manual', saved } = {}) {
  const manifest = loadManifest(makeRollout({ policy: { merge } }))

  return standingItems(manifest, ledgerOf(prs, extra), events, { now: NOON, readyWithinMs: 15 * MINUTE, pending, savedAt: saved })
}

function idKinds(items) {
  return items.map((item) => `${item.id} ${item.kind}`)
}

test('wait: at start, what already waits is reported, for the PRs of this run only', () => {
  const items = standing({
    A1: { state: 'blocked', blocked: { kind: 'ci', question: 'CI is red\nthree times.' } },
    A2: verifiedPr({ action: 'ready', reasons: ['ready: merge it on GitHub'] }),
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
      A2: verifiedPr({ action: 'wait', reasons: ['main is not green'] }, { at: NOON - 20 * MINUTE }),
    },
    { extra: { halted: 'main is red after merging A0', paused: true } },
  )

  assert.deepEqual(idKinds(items), ['- halted', '- paused', 'A1 escalated'])

  const running = standing({ A2: verifiedPr({ action: 'wait', reasons: ['main is not green'] }, { at: NOON - 20 * MINUTE }) })

  assert.deepEqual(idKinds(running), ['A2 verified-stalled'])
  assert.equal(running[0].at, iso(NOON - 5 * MINUTE))
  assert.match(running[0].text, /not ready to merge 15 min later\. Gate wait: main is not green/)
})

test('wait: a ready gate from before the last verification is no ready-to-merge', () => {
  const stale = verifiedPr({ action: 'ready', reasons: ['ready'] })
  stale.gate.at = iso(NOON - 2 * MINUTE)

  assert.deepEqual(standing({ A1: stale }), [])
})

test('wait: at start, approve, note and retry in the inbox answer their PR, hold and release do not', () => {
  const prs = { A1: { state: 'blocked', blocked: { kind: 'ci', question: 'Red.' } }, A2: { state: 'escalated' } }
  const answered = [{ cmd: 'note', id: 'A1', text: 'Rerun it.' }, { cmd: 'retry', id: 'A2' }, { cmd: 'unhalt' }]

  assert.deepEqual(standing(prs, { pending: answered, extra: { halted: 'red' } }), [])
  assert.deepEqual(
    idKinds(
      standing(prs, {
        pending: [
          { cmd: 'hold', id: 'A1' },
          { cmd: 'release', id: 'A2' },
        ],
      }),
    ),
    ['A1 blocked', 'A2 escalated'],
  )
})

test('wait: at start, an answer the driver took but has not saved settles what came before it', () => {
  const prs = { A1: { state: 'blocked', blocked: { kind: 'ci', question: 'Red.' } } }
  const answer = { at: iso(NOON - 3_000), id: 'A1', kind: 'note-queued', state: 'blocked' }
  const question = { at: iso(NOON - 2_000), id: 'A1', kind: 'blocked', reason: 'tests', notified: true }

  assert.deepEqual(standing(prs, { events: [...RUN, answer], saved: NOON - 4_000 }), [])
  assert.deepEqual(idKinds(standing(prs, { events: [...RUN, answer, question], saved: NOON - 4_000 })), ['A1 blocked'])
})

test('wait: at start, a question the delegate has waits for its escalation or its limit', () => {
  const prs = { A1: { state: 'blocked', blocked: { kind: 'needs-decision', question: 'Keep the flag?' } } }
  const blocked = { at: iso(NOON - 5 * MINUTE), id: 'A1', kind: 'blocked', reason: 'needs-decision', delegate: true }
  const started = { at: iso(NOON - 4 * MINUTE), id: 'A1', kind: 'delegate-start', run: 'A1-02-delegate' }
  const escalated = { at: iso(NOON - 2 * MINUTE), id: 'A1', kind: 'delegate-escalated', blocked: 'needs-decision', notified: true }
  const limit = { at: iso(NOON - 2 * MINUTE), id: 'A1', kind: 'delegate-limit', runs: 2, maxPerPr: 2, notified: true }

  assert.deepEqual(standing(prs, { events: [...RUN, blocked, started] }), [])
  assert.deepEqual(idKinds(standing(prs, { events: [...RUN, blocked, escalated] })), ['A1 blocked'])
  assert.deepEqual(idKinds(standing(prs, { events: [...RUN, blocked, started, limit] })), ['A1 blocked'])
})

test('wait: at start, under merge: human a verified PR without your approval is reported', () => {
  const unapproved = verifiedPr({ action: 'wait', reasons: ['awaiting human approval'] })

  assert.deepEqual(idKinds(standing({ A1: unapproved }, { merge: 'human' })), ['A1 awaiting-approval'])
  assert.deepEqual(standing({ A1: { ...unapproved, approved: { patchId: 'patch-a1', at: iso(NOON) } } }, { merge: 'human' }), [])
  assert.deepEqual(standing({ A1: unapproved }, { merge: 'manual' }), [])
})

test('wait: at start, a PR of a narrowed run that waits for a dependency outside it is reported', () => {
  const only = [{ ...RUN[0], prs: ['A2'] }]

  assert.deepEqual(idKinds(standing({ A1: { state: 'verified' }, A2: { state: 'pending' } }, { events: only })), ['A2 waiting-outside-dep'])
  assert.deepEqual(standing({ A1: { state: 'merged' }, A2: { state: 'pending' } }, { events: only }), [])
})

function stalls(ledger, events, { after, upTo, merge = 'manual', notBefore } = {}) {
  return timedItems(ledger, events, Object.keys(ledger.prs), { after, upTo, readyWithinMs: 15 * MINUTE, merge, notBefore }).map(
    (item) => `${item.id} ${item.kind} ${item.at}`,
  )
}

test('wait: a verified PR stalls once, unless it is ready, merging, queued or held', () => {
  const wait = { action: 'wait', reasons: ['CI pending'] }
  const ledger = ledgerOf({
    A1: verifiedPr(wait, { at: NOON }),
    A2: verifiedPr({ ...wait, after: 11 }, { at: NOON }),
    A3: verifiedPr(wait, { at: NOON, held: { at: iso(NOON) } }),
    A4: verifiedPr({ action: 'merge', reasons: [] }, { at: NOON }),
  })

  assert.deepEqual(stalls(ledger, RUN, { after: NOON, upTo: NOON + 14 * MINUTE }), [])
  assert.deepEqual(stalls(ledger, RUN, { after: NOON, upTo: NOON + 15 * MINUTE }), [`A1 verified-stalled ${iso(NOON + 15 * MINUTE)}`])
  assert.deepEqual(stalls(ledger, RUN, { after: NOON + 15 * MINUTE, upTo: NOON + 60 * MINUTE }), [])
  assert.deepEqual(stalls(ledgerOf(ledger.prs, { paused: true }), RUN, { after: NOON, upTo: NOON + 15 * MINUTE }), [])
  assert.deepEqual(stalls(ledgerOf(ledger.prs, { halted: 'red' }), RUN, { after: NOON, upTo: NOON + 15 * MINUTE }), [])
})

test('wait: under merge: human the stall window starts with your approval', () => {
  const pr = verifiedPr({ action: 'wait', reasons: ['GitHub refused the merge (ruleset)'] }, { at: NOON })
  const unapproved = ledgerOf({ A1: pr })
  const approved = ledgerOf({ A1: { ...pr, approved: { patchId: 'patch-a1', at: iso(NOON + 30 * MINUTE) } } })

  assert.deepEqual(stalls(unapproved, RUN, { after: -Infinity, upTo: NOON + 60 * MINUTE, merge: 'human' }), [])
  assert.deepEqual(stalls(approved, RUN, { after: NOON + 31 * MINUTE, upTo: NOON + 44 * MINUTE, merge: 'human' }), [])
  assert.deepEqual(stalls(approved, RUN, { after: NOON + 31 * MINUTE, upTo: NOON + 45 * MINUTE, merge: 'human' }), [
    `A1 verified-stalled ${iso(NOON + 45 * MINUTE)}`,
  ])
})

test('wait: the stall window starts over when the PR can move again', () => {
  const ledger = ledgerOf({ A1: verifiedPr({ action: 'wait', reasons: ['CI pending'] }, { at: NOON }) })
  const later = NOON + 40 * MINUTE
  const window = (events, notBefore) =>
    stalls(ledger, [...RUN, ...events], { after: NOON + 15 * MINUTE, upTo: later + 15 * MINUTE, notBefore })

  const expected = [`A1 verified-stalled ${iso(later + 15 * MINUTE)}`]

  for (const [id, kind] of [
    ['A1', 'retry'],
    ['A1', 'released'],
    ['A1', 'rebased'],
    ['A1', 'head-moved-same-patch'],
    ['-', 'resumed'],
    ['-', 'unhalted'],
    ['-', 'driver-start'],
    ['-', 'machine-slept'],
  ]) {
    assert.deepEqual(window([{ at: iso(later), id, kind }]), expected, kind)
  }

  assert.deepEqual(window([{ at: iso(later), id: 'A2', kind: 'retry' }]), [])
  assert.deepEqual(window([], later), expected)

  const queue = [
    { at: iso(NOON + MINUTE), id: 'A1', kind: 'gate-wait', reasons: ['after PR #12'], after: 12 },
    { at: iso(later), id: 'A1', kind: 'gate-wait', reasons: ['CI pending'] },
  ]

  assert.deepEqual(window(queue), expected)
})

test('wait: a delegate run the driver died in counts as over once the driver starts again', () => {
  const ledger = ledgerOf({ A1: { state: 'blocked', blocked: { kind: 'needs-decision', question: 'Keep the flag?' } } })
  const events = [
    ...RUN,
    { at: iso(NOON - 30 * MINUTE), id: 'A1', kind: 'blocked', reason: 'needs-decision', delegate: true },
    { at: iso(NOON - 29 * MINUTE), id: 'A1', kind: 'delegate-start', run: 'A1-01-delegate' },
  ]

  assert.deepEqual(stalls(ledger, events, { after: -Infinity, upTo: NOON }), [])

  const restarted = [...events, { at: iso(NOON - 20 * MINUTE), id: '-', kind: 'driver-start', prs: ['A1'], pid: 2, noticeMarks: true }]

  assert.deepEqual(stalls(ledger, restarted, { after: -Infinity, upTo: NOON }), [`A1 delegate-idle ${iso(NOON - 5 * MINUTE)}`])
})

// A rollout whose driver is this test process, with a fake clock that each
// sleep moves on and a script of what happens at each poll. The first poll
// of every wait is its one-second settle at the start.
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
  savedAt(dir, NOON - 10 * MINUTE)

  function append(event, { newline = true } = {}) {
    appendFileSync(file, `${JSON.stringify({ at: iso(now), ...event })}${newline ? '\n' : ''}`)
  }

  async function sleep(ms) {
    now += ms
    polls += 1

    if (polls > 3_000) {
      throw new Error('the wait never ended')
    }

    script.shift()?.()
  }

  function run(options = {}) {
    return waitForAttention(manifest, { clock: () => now, sleep, ...options })
  }

  // Steps that do nothing, so the next one happens inside the poll loop.
  function idle(count) {
    script.push(...Array.from({ length: count }, () => () => {}))
  }

  return { dir, manifest, script, append, run, idle, polls: () => polls, now: () => now, jump: (ms) => (now += ms) }
}

function kinds(result) {
  return idKinds(result.items)
}

function savedAt(dir, ms) {
  utimesSync(join(dir, 'ledger.json'), new Date(ms), new Date(ms))
}

function beat(dir, ms) {
  utimesSync(join(dir, 'heartbeat'), new Date(ms), new Date(ms))
}

test('wait: at start, a waking event the ledger does not show yet is reported, once', async () => {
  const events = [
    ...RUN,
    { at: iso(NOON - 3_000), id: 'A1', kind: 'escalated', reason: 'repeated errors', notified: true },
    { at: iso(NOON - 2_000), id: 'A2', kind: 'blocked', reason: 'ci', notified: true },
  ]

  const prs = { A1: { state: 'fixing' }, A2: { state: 'blocked', blocked: { kind: 'ci', question: 'Red.' } } }
  const rollout = waiting({ prs, events })

  savedAt(rollout.dir, NOON - 4_000)

  assert.deepEqual(kinds(await rollout.run()), ['A2 blocked', 'A1 escalated'])
})

test('wait: a wait from the printed cursor repeats nothing the last one printed', async () => {
  const rollout = waiting({
    prs: { A1: { state: 'blocked', blocked: { kind: 'ci', question: 'Red.' } } },
    events: [...RUN, { at: iso(NOON - 500), id: 'A1', kind: 'blocked', reason: 'ci', notified: true }],
  })

  const first = await rollout.run()

  assert.deepEqual(kinds(first), ['A1 blocked'])

  rollout.script.push(() => rollout.append({ id: 'A1', kind: 'escalated', role: 'fix', notified: true }))

  assert.deepEqual(kinds(await rollout.run({ since: first.cursor })), ['A1 escalated'])
})

test('wait: it sleeps through events nobody is told about and returns at the first notice', async () => {
  const rollout = waiting()

  rollout.script.push(
    () => rollout.append({ id: 'A1', kind: 'implement-done', ok: true }),
    () => rollout.append({ id: 'A1', kind: 'error', error: 'boom', count: 1 }),
    () => rollout.append({ id: 'A1', kind: 'blocked', reason: 'needs-decision', delegate: true }),
    () => rollout.append({ id: '-', kind: 'tick-error', count: 4 }),
    () => {
      rollout.append({ id: 'A1', kind: 'delegate-escalated', blocked: 'needs-decision', notified: true })
      rollout.append({ id: 'A2', kind: 'command-rejected', command: 'retry', reason: 'already merged' })
    },
    () => rollout.append({ id: 'A2', kind: 'escalated', role: 'fix', notified: true }),
  )

  const result = await rollout.run()

  assert.equal(result.exit, 0)
  assert.deepEqual(kinds(result), ['A1 delegate-escalated', 'A2 command-rejected'])
  assert.equal(result.cursor, rollout.now() - 1000)
})

test('wait: a failure the driver keeps retrying wakes it when the driver notifies, at the fifth in a row', async () => {
  const rollout = waiting()

  for (let count = 1; count <= 5; count += 1) {
    rollout.idle(29)
    rollout.script.push(() => {
      rollout.append({ id: '-', kind: 'tick-error', count, ...(count === 5 ? { notified: true } : {}) })
      beat(rollout.dir, rollout.now())
    })
  }

  const result = await rollout.run()

  assert.deepEqual(kinds(result), ['- tick-error'])
  assert.ok(rollout.now() - NOON > 4 * MINUTE && rollout.now() - NOON < 6 * MINUTE, `${(rollout.now() - NOON) / MINUTE} min`)
})

test('wait: the printed cursor resumes after what it reported, with nothing lost or repeated', async () => {
  const rollout = waiting()

  rollout.script.push(
    () => {},
    () => rollout.append({ id: 'A1', kind: 'blocked', reason: 'ci', notified: true }),
    () => rollout.append({ id: 'A1', kind: 'note-queued', state: 'blocked' }),
  )

  const first = await rollout.run()

  assert.deepEqual(kinds(first), ['A1 blocked'])

  rollout.append({ id: 'A1', kind: 'escalated', role: 'fix', notified: true })
  rollout.jump(5_000)

  assert.deepEqual(kinds(await rollout.run({ since: first.cursor })), ['A1 escalated'])
})

test('wait: a line still being written is read once it is complete', async () => {
  const rollout = waiting()

  rollout.script.push(
    () => {},
    () => rollout.append({ id: 'A1', kind: 'escalated', role: 'fix', notified: true }, { newline: false }),
    () => {},
    () => appendFileSync(join(rollout.dir, 'events.jsonl'), '\n'),
  )

  const result = await rollout.run()

  assert.equal(result.items[0].kind, 'escalated')
  assert.equal(rollout.polls(), 4)
})

test('wait: a verified PR that never gets ready wakes it once, as verified-stalled', async () => {
  const rollout = waiting({ prs: { A1: verifiedPr({ action: 'wait', reasons: ['main is not green'] }, { at: NOON - 14 * MINUTE }) } })
  const result = await rollout.run()

  assert.deepEqual(kinds(result), ['A1 verified-stalled'])
  assert.ok(rollout.now() >= NOON + MINUTE && rollout.now() < NOON + MINUTE + 5_000, iso(rollout.now()))
})

// What the driver writes on each tick while GitHub refuses the merge: the
// gate decides to merge again, then GitHub refuses, notified once per head.
function refusedTick(rollout, { first = false } = {}) {
  rollout.append({ id: 'A1', kind: 'gate-merge', reasons: [] })
  rollout.append({ id: 'A1', kind: 'merge-refused', error: 'ruleset', ...(first ? { notified: true } : {}) })
  beat(rollout.dir, rollout.now())
}

test('wait: under merge: human, GitHub refusing the merge after a late approval wakes it, and so does the stall after that', async () => {
  const pr = verifiedPr({ action: 'wait', reasons: ['awaiting human approval'] }, { at: NOON })
  const rollout = waiting({ prs: { A1: pr }, merge: 'human' })
  const first = await rollout.run()

  assert.deepEqual(kinds(first), ['A1 awaiting-approval'])

  const approved = {
    ...pr,
    approved: { patchId: 'patch-a1', at: iso(NOON + 30 * MINUTE) },
    gate: { action: 'wait', reasons: ['GitHub refused the merge (ruleset)'], at: iso(NOON + 31 * MINUTE) },
  }

  let firstRefusal = null

  rollout.jump(30 * MINUTE)
  writeFileSync(join(rollout.dir, 'ledger.json'), JSON.stringify(ledgerOf({ A1: approved })))
  rollout.idle(29)
  rollout.script.push(() => {
    firstRefusal = rollout.now()
    refusedTick(rollout, { first: true })
  })

  for (let i = 1; i <= 600; i += 1) {
    rollout.script.push(() => {
      if (i % 30 === 0) {
        refusedTick(rollout)
      }
    })
  }

  const refused = await rollout.run({ since: first.cursor })

  assert.deepEqual(kinds(refused), ['A1 merge-refused'])

  const stalled = await rollout.run({ since: refused.cursor })

  assert.deepEqual(kinds(stalled), ['A1 verified-stalled'])
  assert.equal(stalled.items[0].at, iso(firstRefusal + 15 * MINUTE))
})

test('wait: a poll that catches the PR merging for a moment at the end of its window does not lose the stall', async () => {
  const waitingGate = { action: 'wait', reasons: ['CI pending'] }
  const rollout = waiting({ prs: { A1: verifiedPr(waitingGate, { at: NOON - 14 * MINUTE }) } })
  const ledger = (gate) =>
    writeFileSync(join(rollout.dir, 'ledger.json'), JSON.stringify(ledgerOf({ A1: verifiedPr(gate, { at: NOON - 14 * MINUTE }) })))

  rollout.idle(30)
  rollout.script.push(
    () => ledger({ action: 'merge', reasons: [] }),
    () => ledger(waitingGate),
  )

  const result = await rollout.run()

  assert.deepEqual(kinds(result), ['A1 verified-stalled'])
  assert.equal(result.items[0].at, iso(NOON + MINUTE))
  // The settle, 30 polls up to the end of the window, the one that caught the merge, and the next.
  assert.equal(rollout.polls(), 32)
})

test('wait: after a machine sleep the stall window starts over', async () => {
  const rollout = waiting({ prs: { A1: verifiedPr({ action: 'wait', reasons: ['CI pending'] }, { at: NOON - 5 * MINUTE }) } })

  rollout.idle(2)
  rollout.script.push(() => rollout.jump(8 * 60 * MINUTE))
  rollout.idle(5)
  rollout.script.push(() => beat(rollout.dir, rollout.now()))

  const result = await rollout.run()

  assert.deepEqual(kinds(result), ['A1 verified-stalled'])
  assert.ok(rollout.now() - NOON > 8 * 60 * MINUTE + 15 * MINUTE, `${(rollout.now() - NOON) / MINUTE} min`)
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

  busy.idle(60)
  busy.script.push(() => busy.append({ id: 'A1', kind: 'delegate-escalated', blocked: 'needs-decision', notified: true }))

  assert.deepEqual(kinds(await busy.run()), ['A1 delegate-escalated'])
  assert.ok(busy.now() > NOON + 2 * MINUTE)

  const stopped = { at: iso(NOON - 13 * MINUTE), id: 'A1', kind: 'delegate-done', run: 'A1-01-delegate', ok: false, stopped: true }

  assert.deepEqual(kinds(await waiting({ prs, events: [...RUN, blocked, started, stopped] }).run()), ['A1 delegate-idle'])
})

test('wait: a driver that died in a delegate run and comes back at its limit wakes it', async () => {
  const prs = { A1: { state: 'blocked', blocked: { kind: 'needs-decision', question: 'Keep the flag?' } } }
  const events = [
    ...RUN,
    { at: iso(NOON - 50 * MINUTE), id: 'A1', kind: 'blocked', reason: 'needs-decision', delegate: true },
    { at: iso(NOON - 49 * MINUTE), id: 'A1', kind: 'delegate-start', run: 'A1-02-delegate' },
  ]

  const rollout = waiting({ prs, events })

  rollout.script.push(
    () => {},
    () => rollout.append({ id: '-', kind: 'driver-start', prs: ['A1', 'A2'], pid: process.pid, noticeMarks: true }),
    () => rollout.append({ id: 'A1', kind: 'delegate-limit', runs: 2, maxPerPr: 2, notified: true }),
  )

  assert.deepEqual(kinds(await rollout.run()), ['A1 delegate-limit'])
})

test('wait: a new driver that holds the lock is followed from its own start, never from the run before', async () => {
  const old = [
    { ...RUN[0], pid: 1 },
    { at: iso(NOON - 30 * MINUTE), id: '-', kind: 'finished', cost: 3, notified: true },
  ]

  const rollout = waiting({ events: old })

  savedAt(rollout.dir, NOON - 31 * MINUTE)
  rollout.idle(3)
  rollout.script.push(
    () => {
      savedAt(rollout.dir, rollout.now())
      rollout.append({ id: '-', kind: 'driver-start', prs: ['A1', 'A2'], pid: process.pid, noticeMarks: true })
    },
    () => {},
    () => {},
    () => rollout.append({ id: 'A2', kind: 'ready-to-merge', pr: 12, notified: true }),
  )

  const result = await rollout.run()

  assert.deepEqual(kinds(result), ['A2 ready-to-merge'])
})

test('wait: a driver older than the notified marks cannot be followed, and the next wait reports the state', async () => {
  const result = await waiting({ events: [{ ...RUN[0], noticeMarks: undefined }] }).run()

  assert.equal(result.exit, 2)
  assert.equal(result.cursor, null)
  assert.match(
    result.message,
    /is older than rollout wait and does not mark what it tells you\. Stop it \(rollout\.mjs stop\) and run it again/,
  )
})

test('wait: the driver stopping after finished is the end, without finished it exits 2', async () => {
  const finished = waiting()

  finished.idle(1)
  finished.script.push(() => {
    finished.append({ id: '-', kind: 'finished', cost: 12.5, release: null, notified: true })
    rmSync(join(finished.dir, 'driver.lock'))
  })

  const done = await finished.run()

  assert.equal(done.exit, 0)
  assert.deepEqual(kinds(done), ['- finished'])

  const stopped = waiting()

  stopped.idle(1)
  stopped.script.push(() => rmSync(join(stopped.dir, 'driver.lock')))

  const gone = await stopped.run()

  assert.equal(gone.exit, 2)
  assert.deepEqual(gone.items, [])
  assert.match(gone.message, /no driver is running for demo and it has not finished/)
  assert.equal(stopped.polls(), 2, 'the lock goes in the poll loop, after the settle')

  const resumed = await stopped.run({ since: gone.cursor })

  assert.equal(resumed.exit, 2)
  assert.deepEqual(resumed.items, [])
})

test('wait: a rollout finished with every PR merged and no driver reports its finished event at once', async () => {
  const merged = { A1: { state: 'merged' }, A2: { state: 'merged' }, A3: { state: 'merged' } }
  const finished = { at: iso(NOON - MINUTE), id: '-', kind: 'finished', cost: 3, notified: true }
  const rollout = waiting({ prs: merged, events: [...RUN, finished], lock: false })
  const result = await rollout.run()

  assert.equal(result.exit, 0)
  assert.equal(result.items[0].kind, 'finished')
  assert.ok(rollout.polls() <= 1)
})

test('wait: after a narrowed run finished, the driver of the next run gets its grace and is followed', async () => {
  const prs = { A1: { state: 'merged' }, A2: { state: 'pending' } }
  const finished = { at: iso(NOON - MINUTE), id: '-', kind: 'finished', cost: 3, notified: true }
  const rollout = waiting({ prs, events: [{ ...RUN[0], prs: ['A1'], pid: 1 }, finished], lock: false })

  savedAt(rollout.dir, NOON - 2 * MINUTE)
  rollout.script.push(
    () => {},
    () => writeFileSync(join(rollout.dir, 'driver.lock'), JSON.stringify({ pid: process.pid, at: iso(rollout.now()) })),
    () => {
      savedAt(rollout.dir, rollout.now())
      rollout.append({ id: '-', kind: 'driver-start', prs: ['A2'], pid: process.pid, noticeMarks: true })
    },
    () => {},
    () => {},
    () => rollout.append({ id: 'A2', kind: 'blocked', reason: 'brief-questions', notified: true }),
  )

  assert.deepEqual(kinds(await rollout.run()), ['A2 blocked'])
})

test('wait: a driver that is just starting gets a few seconds to take its lock', async () => {
  const late = waiting({ lock: false })

  late.script.push(
    () => {},
    () => {},
    () => writeFileSync(join(late.dir, 'driver.lock'), JSON.stringify({ pid: process.pid, at: iso(late.now()) })),
    () => {},
    () => late.append({ id: 'A1', kind: 'escalated', role: 'implement', notified: true }),
  )

  assert.equal((await late.run()).items[0].kind, 'escalated')

  const never = waiting({ lock: false })
  const result = await never.run()

  assert.equal(result.exit, 2)
  assert.ok(never.now() - NOON >= 15_000 && never.now() - NOON < 20_000)
})

test('wait: a heartbeat that stops for 30 awake minutes exits 2, a sleep of the machine does not count', async () => {
  const sleeper = waiting()

  sleeper.idle(2)
  sleeper.script.push(() => sleeper.jump(8 * 60 * MINUTE))
  sleeper.idle(20)
  sleeper.script.push(() => sleeper.append({ id: 'A1', kind: 'escalated', role: 'fix', notified: true }))

  assert.equal((await sleeper.run()).exit, 0)

  const hung = waiting()
  const result = await hung.run()

  assert.equal(result.exit, 2)
  assert.match(result.message, /wrote no heartbeat for 30 min/)
  assert.ok(hung.now() - NOON > 30 * MINUTE && hung.now() - NOON < 31 * MINUTE)
})

test('wait: the heartbeat limit is three ticks when that is longer than 30 minutes', async () => {
  const slow = waiting({ policy: { tickSeconds: 1200 } })
  const result = await slow.run()

  assert.equal(result.exit, 2)
  assert.ok(slow.now() - NOON > 60 * MINUTE && slow.now() - NOON < 61 * MINUTE, `${(slow.now() - NOON) / MINUTE} min`)
})

test('wait: a fresh heartbeat keeps a long wait going', async () => {
  const rollout = waiting()

  for (let i = 1; i <= 1_200; i += 1) {
    rollout.script.push(() => {
      if (i % 30 === 0) {
        beat(rollout.dir, NOON + i * 1000)
      }
    })
  }

  rollout.script.push(() => rollout.append({ id: 'A1', kind: 'halted', failing: ['test'], notified: true }))

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

// A rollout whose driver died a minute ago, so wait answers at once.
function deadRollout(options = {}) {
  const dir = makeRollout({ events: RUN, ...options })

  writeFileSync(join(dir, 'driver.lock'), JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }))
  utimesSync(join(dir, 'driver.lock'), new Date(Date.now() - MINUTE), new Date(Date.now() - MINUTE))

  return dir
}

test('wait CLI: exit 1 for a missing directory or a bad flag', () => {
  const missing = cli('wait', '--dir', join(makeRollout(), 'nothing-here'))

  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no manifest\.yaml/)

  const bad = cli('wait', '--dir', makeRollout(), '--since', '42')

  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /--since must be the ISO time a wait printed/)
})

test('wait CLI: what waits at start, one line each, then the command to go on with', () => {
  const dir = makeRollout({ dir: join(mkdtempSync(join(tmpdir(), 'rollout-')), "Bob's rollout"), events: RUN })

  writeFileSync(
    join(dir, 'ledger.json'),
    JSON.stringify(ledgerOf({ A1: { state: 'blocked', blocked: { kind: 'ci', question: 'CI is red.' } } })),
  )

  const result = cli('wait', '--dir', dir, '--ready-within', '30')
  const lines = result.stdout.trim().split('\n')
  const next = lines[1].match(/^next: rollout\.mjs wait --dir (.+) --since (\S+) --ready-within 30$/)

  assert.equal(result.status, 0, result.stderr)
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z A1 {3}blocked ci: CI is red\.$/)
  assert.ok(next, lines[1])
  assert.equal(spawnSync('/bin/sh', ['-c', `printf %s ${next[1]}`], { encoding: 'utf8' }).stdout, dir)
  assert.ok(Number.isFinite(parseSince(next[2])))
})

test('wait CLI: a note in the inbox is the answer, a broken inbox file is skipped, and a dead driver exits 2', () => {
  const dir = deadRollout({ prs: { A1: { state: 'blocked', blocked: { kind: 'ci', question: 'CI is red.' } } } })

  postCommand(loadManifest(dir), { cmd: 'note', id: 'A1', text: 'Rerun it.' })
  writeFileSync(join(dir, 'inbox', '0000-broken.json'), 'null')

  const result = cli('wait', '--dir', dir)

  assert.equal(result.status, 2)
  assert.match(result.stderr, /^rollout wait: no driver is running for demo and it has not finished/)
  assert.match(result.stdout, /^next: rollout\.mjs wait --dir /)
})

test('wait CLI: an invalid manifest.yaml does not stop it, it follows what the driver logged', () => {
  const dir = deadRollout({ events: [{ ...RUN[0], merge: 'manual', tickSeconds: 60 }] })

  writeFileSync(join(dir, 'manifest.yaml'), 'rollout: demo\nrollout: twice\n')

  const result = cli('wait', '--dir', dir)

  assert.equal(result.status, 2)
  assert.match(result.stderr, /manifest\.yaml has an error, following the driver's last good one/)
  assert.match(result.stdout, /^next: rollout\.mjs wait --dir /m)
})

test('wait CLI: agents cannot wait', () => {
  const result = spawnSync(process.execPath, [BIN, 'wait', '--dir', makeRollout()], {
    encoding: 'utf8',
    env: { ...process.env, ROLLOUT_ROLE: 'implement' },
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /agents cannot drive the rollout/)
})

test('wait: a directory without a driver-start falls back to the manifest only when it is valid', () => {
  const dir = makeRollout({ events: null })

  mkdirSync(join(dir, 'inbox'), { recursive: true })
  writeFileSync(join(dir, 'manifest.yaml'), 'rollout: [\n')

  const result = cli('wait', '--dir', dir)

  assert.equal(result.status, 1)
})

test('wait: a stall starts over when the gate stops holding the PR on purpose', () => {
  const ledger = ledgerOf({ A1: verifiedPr({ action: 'wait', reasons: ['main is not green'] }, { at: NOON }) })
  const left = NOON + 40 * MINUTE
  const window = (events) => stalls(ledger, [...RUN, ...events], { after: NOON + 15 * MINUTE, upTo: left + 15 * MINUTE })
  const expected = [`A1 verified-stalled ${iso(left + 15 * MINUTE)}`]

  const ready = [
    { at: iso(NOON + MINUTE), id: 'A1', kind: 'gate-ready', reasons: ['ready: merge it on GitHub'] },
    { at: iso(left), id: 'A1', kind: 'gate-wait', reasons: ['main is not green'] },
  ]

  // As the driver writes them: the gate merges again on every tick, and only
  // the first refusal of the head is a notice.
  const merging = [
    { at: iso(NOON + MINUTE), id: 'A1', kind: 'gate-merge', reasons: [] },
    { at: iso(left), id: 'A1', kind: 'merge-refused', error: 'ruleset', notified: true },
    { at: iso(left + MINUTE), id: 'A1', kind: 'gate-merge', reasons: [] },
    { at: iso(left + MINUTE), id: 'A1', kind: 'merge-refused', error: 'ruleset' },
    { at: iso(left + 2 * MINUTE), id: 'A1', kind: 'gate-merge', reasons: [] },
    { at: iso(left + 2 * MINUTE), id: 'A1', kind: 'merge-refused', error: 'ruleset' },
  ]

  assert.deepEqual(window(ready), expected)
  assert.deepEqual(window(merging), expected)
  assert.deepEqual(window([{ at: iso(left), id: 'A1', kind: 'gate-wait', reasons: ['CI pending'] }]), [])
})

test('wait: a ready gate from before the last verification does not keep a PR from stalling', () => {
  const stale = verifiedPr({ action: 'ready', reasons: ['ready'] }, { at: NOON })
  stale.gate.at = iso(NOON - MINUTE)

  assert.deepEqual(stalls(ledgerOf({ A1: stale }), RUN, { after: NOON, upTo: NOON + 15 * MINUTE }), [
    `A1 verified-stalled ${iso(NOON + 15 * MINUTE)}`,
  ])
})

test('wait: at start, a command in the inbox settles only what came before it was posted', () => {
  const prs = { A1: { state: 'fixing' } }
  const note = { cmd: 'note', id: 'A1', text: 'Rerun it.', at: iso(NOON - 60 * MINUTE) }
  const escalated = { at: iso(NOON - 2_000), id: 'A1', kind: 'escalated', reason: 'repeated errors', notified: true }

  assert.deepEqual(idKinds(standing(prs, { events: [...RUN, escalated], pending: [note], saved: NOON - 4_000 })), ['A1 escalated'])
  assert.deepEqual(standing(prs, { events: [...RUN, escalated], pending: [{ ...note, at: iso(NOON) }], saved: NOON - 4_000 }), [])
})

test('wait: at start, an unhalt or resume in the inbox settles the halt or pause written after the save', () => {
  const halted = { at: iso(NOON - 2_000), id: 'A1', kind: 'halted', failing: ['test'], notified: true }
  const paused = { at: iso(NOON - 2_000), id: '-', kind: 'paused', reason: 'credit balance is too low', notified: true }
  const events = [...RUN, halted, paused]
  const posted = iso(NOON - 1_000)

  assert.deepEqual(idKinds(standing({}, { events, saved: NOON - 4_000 })), ['A1 halted', '- paused'])
  assert.deepEqual(
    standing(
      {},
      {
        events,
        saved: NOON - 4_000,
        pending: [
          { cmd: 'unhalt', at: posted },
          { cmd: 'resume', at: posted },
        ],
      },
    ),
    [],
  )
})

test('wait: at start, a waking event of a PR outside the run is left out', () => {
  const outside = { at: iso(NOON - 2_000), id: 'A3', kind: 'escalated', reason: 'repeated errors', notified: true }

  assert.deepEqual(standing({}, { events: [...RUN, outside], saved: NOON - 4_000 }), [])

  // A halt names the PR whose merge turned the base red, which may be outside the run, but it stops the whole rollout.
  const halted = { ...outside, kind: 'halted', failing: ['test'] }

  assert.deepEqual(idKinds(standing({}, { events: [...RUN, halted], saved: NOON - 4_000 })), ['A3 halted'])
})

test('wait: at start, a held PR is not ready to merge, and an approval of an older patch is no approval', () => {
  const ready = verifiedPr({ action: 'ready', reasons: ['ready'] })

  assert.deepEqual(standing({ A1: { ...ready, held: { at: iso(NOON) } } }), [])

  const older = verifiedPr({ action: 'wait', reasons: ['awaiting human approval'] }, { approved: { patchId: 'patch-old', at: iso(NOON) } })

  assert.deepEqual(idKinds(standing({ A1: older }, { merge: 'human' })), ['A1 awaiting-approval'])
})

test('wait: a wait from a cursor reports a stall whose window ended since then', async () => {
  const rollout = waiting({ prs: { A1: verifiedPr({ action: 'wait', reasons: ['CI pending'] }, { at: NOON - 20 * MINUTE }) } })
  const result = await rollout.run({ since: NOON - 10 * MINUTE })

  assert.deepEqual(kinds(result), ['A1 verified-stalled'])
  assert.equal(rollout.polls(), 0)
})

test('wait: it reads the ledger again when the driver saves it', async () => {
  const rollout = waiting()

  rollout.idle(2)
  rollout.script.push(() => {
    writeFileSync(
      join(rollout.dir, 'ledger.json'),
      JSON.stringify(ledgerOf({ A1: verifiedPr({ action: 'wait', reasons: ['CI pending'] }, { at: rollout.now() }) })),
    )
  })

  for (let i = 0; i < 600; i += 1) {
    rollout.script.push(() => {
      if (i % 30 === 0) {
        beat(rollout.dir, rollout.now())
      }
    })
  }

  const result = await rollout.run()

  assert.deepEqual(kinds(result), ['A1 verified-stalled'])
})

test('wait CLI: an exit 2 before the first report prints no cursor, so the next wait reports the state', () => {
  const dir = makeRollout({ events: [{ ...RUN[0], noticeMarks: undefined }] })
  const result = cli('wait', '--dir', dir)

  assert.equal(result.status, 2)
  assert.match(result.stderr, /is older than rollout wait/)
  assert.equal(result.stdout.trim(), `next: rollout.mjs wait --dir ${dir}`)
})

test('wait: a start or a replay that catches the PR merging for a moment does not lose a stall that ended before it', async () => {
  const merging = verifiedPr({ action: 'merge', reasons: [] }, { at: NOON - 30 * MINUTE })
  const stuck = verifiedPr({ action: 'wait', reasons: ['GitHub refused the merge (ruleset)'] }, { at: NOON - 30 * MINUTE })
  const settle = (rollout) => () => writeFileSync(join(rollout.dir, 'ledger.json'), JSON.stringify(ledgerOf({ A1: stuck })))

  const fresh = waiting({ prs: { A1: merging } })

  fresh.script.push(settle(fresh))

  const started = await fresh.run()

  assert.deepEqual(kinds(started), ['A1 verified-stalled'])
  assert.equal(started.items[0].at, iso(NOON - 15 * MINUTE))
  assert.equal(fresh.polls(), 2)

  const resumed = waiting({ prs: { A1: merging } })

  resumed.script.push(settle(resumed))

  const replayed = await resumed.run({ since: NOON - 20 * MINUTE })

  assert.deepEqual(kinds(replayed), ['A1 verified-stalled'])
  assert.equal(resumed.polls(), 1)
})

test('wait: a PR whose answer waits in the inbox does not stall while the wait polls', async () => {
  const rollout = waiting({ prs: { A1: verifiedPr({ action: 'wait', reasons: ['CI pending'] }, { at: NOON - 30 * MINUTE }) } })

  postCommand(rollout.manifest, { cmd: 'retry', id: 'A1' })
  rollout.idle(3)
  rollout.script.push(() => rollout.append({ id: 'A2', kind: 'escalated', role: 'fix', notified: true }))

  assert.deepEqual(kinds(await rollout.run()), ['A2 escalated'])
})

// A1's window ended long ago, and an answer to it is on its way into the
// ledger. The wait must not wake on the state the answer replaces.
function answering({ events = RUN } = {}) {
  const stalled = verifiedPr({ action: 'wait', reasons: ['CI pending'] }, { at: NOON - 60 * MINUTE })
  const rollout = waiting({ prs: { A1: stalled, A2: { state: 'pending' } }, events })

  savedAt(rollout.dir, NOON - 10_000)

  return {
    ...rollout,
    drain: () => rmSync(join(rollout.dir, 'inbox'), { recursive: true, force: true }),
    save: (entry) => {
      writeFileSync(join(rollout.dir, 'ledger.json'), JSON.stringify(ledgerOf({ A1: entry, A2: { state: 'pending' } })))
      savedAt(rollout.dir, rollout.now())
    },
    // Ends the wait with an event that has nothing to do with A1.
    end: () => rollout.append({ id: 'A2', kind: 'escalated', role: 'implement', notified: true }),
  }
}

test('wait: an answer the driver took and has not saved keeps an old stall from waking it', async () => {
  const fixing = { state: 'needs_fix', pr: 11, verified: null }

  const drained = answering()

  postCommand(drained.manifest, { cmd: 'note', id: 'A1', text: 'Drop the flaky check.' })
  drained.script.push(() => {
    drained.drain()
    drained.append({ id: 'A1', kind: 'needs-fix', reason: 'request from the maintainer' })
    drained.append({ id: 'A1', kind: 'note-queued', state: 'needs_fix' })
  })

  drained.idle(3)
  drained.script.push(() => drained.save(fixing))
  drained.idle(3)
  drained.script.push(() => drained.end())

  assert.deepEqual(kinds(await drained.run()), ['A2 escalated'])

  const unsaved = answering({
    events: [
      ...RUN,
      { at: iso(NOON - 2_000), id: 'A1', kind: 'needs-fix', reason: 'request from the maintainer' },
      { at: iso(NOON - 2_000), id: 'A1', kind: 'note-queued', state: 'needs_fix' },
    ],
  })

  unsaved.idle(4)
  unsaved.script.push(() => unsaved.save(fixing))
  unsaved.idle(3)
  unsaved.script.push(() => unsaved.end())

  assert.deepEqual(kinds(await unsaved.run()), ['A2 escalated'])
})

test('wait: an answer younger than the settle keeps an old stall from waking it too', async () => {
  const retried = answering()

  postCommand(retried.manifest, { cmd: 'retry', id: 'A1' })
  retried.idle(1)
  retried.script.push(() => {
    retried.drain()
    retried.append({ id: 'A1', kind: 'retry', state: 'verified' })
  })

  retried.idle(5)
  retried.script.push(() => retried.end())

  assert.deepEqual(kinds(await retried.run()), ['A2 escalated'])
})

test('wait: an answer counts only until the ledger is saved, so a new stall after it wakes it', async () => {
  const rollout = answering()
  let verifiedAgain = null

  postCommand(rollout.manifest, { cmd: 'note', id: 'A1', text: 'Drop the flaky check.' })
  rollout.script.push(() => {
    rollout.drain()
    rollout.append({ id: 'A1', kind: 'needs-fix', reason: 'request from the maintainer' })
    rollout.append({ id: 'A1', kind: 'note-queued', state: 'needs_fix' })
  })

  rollout.idle(3)
  rollout.script.push(() => rollout.save({ state: 'needs_fix', pr: 11, verified: null }))
  rollout.idle(3)
  rollout.script.push(() => {
    verifiedAgain = rollout.now()
    rollout.save(verifiedPr({ action: 'wait', reasons: ['CI pending'] }, { at: verifiedAgain }))
  })

  const result = await rollout.run()

  assert.deepEqual(kinds(result), ['A1 verified-stalled'])
  assert.equal(result.items[0].at, iso(verifiedAgain + 15 * MINUTE))
})
