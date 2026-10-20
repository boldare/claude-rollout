import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { lockHolder, pendingCommands, readLedger } from './ledger.mjs'
import { sleptMs } from './machine.mjs'
import { ROLES } from './view.mjs'

// rollout wait: blocks until the rollout needs someone, the maintainer or the
// session that follows the rollout, prints what and exits. Like status, it
// only reads the rollout directory.

const ALWAYS = () => true

// The kinds of event that need someone, each with its rule. A test reads every
// kind the driver writes and fails on one that is neither here nor in
// QUIET_KINDS, so a new kind of event gets a decision.
export const WAKE_KINDS = {
  'ready-to-merge': ALWAYS,
  // A dry run stops where it would merge.
  'would-merge': ALWAYS,
  // A question the delegate takes needs someone only when it hands it back.
  blocked: (event) => event.delegate !== true,
  'delegate-escalated': ALWAYS,
  escalated: ALWAYS,
  halted: ALWAYS,
  // The first of a streak. An escalated PR whose sync keeps failing writes one every tick.
  error: (event) => !(event.count > 1),
  finished: ALWAYS,
  'merged-outside-driver': ALWAYS,
  'command-rejected': ALWAYS,
  'approval-rejected': ALWAYS,
  'manifest-rejected': ALWAYS,
  // An account limit. A pause someone asked for has no reason.
  paused: (event) => Boolean(event.reason),
  // Under merge: human a verified PR waits for your approval. Otherwise it
  // wakes later, as verified-stalled, if it never gets to ready-to-merge.
  verified: (event, { merge }) => merge === 'human',
}

// Progress, the driver's answers to commands that applied, and failures it
// retries and escalates by itself.
export const QUIET_KINDS = [
  'approved',
  'brief-answered',
  'brief-missing',
  'brief-waits',
  'brief-written',
  'claim-moved',
  'code-scanning-unavailable',
  'code-scanning-wait',
  'delegate-answered',
  'delegate-dropped',
  // Always after a blocked the delegate did not take, which woke already.
  'delegate-limit',
  'driver-start',
  'fetch-failed',
  'gate-check',
  'github-back',
  'github-unavailable',
  'head-moved-reverify',
  'head-moved-same-patch',
  'held',
  'local-config-removed',
  'machine-slept',
  'manifest-reloaded',
  // Repeats on every tick while GitHub refuses. The verified PR stalls, and that wakes once.
  'merge-refused',
  'merge-unconfirmed',
  'merged',
  'merged-outside-run',
  'needs-fix',
  'note-queued',
  'on-done-error',
  'outside-deps-failed',
  'ready-claimed',
  'rebased',
  'recovered-interrupted',
  'released',
  'reply-failed',
  'report-unchecked',
  'resumed',
  'retry',
  'review-answered',
  'review-feedback',
  'tick-error',
  'unhalted',
  'verifier-touched-tree',
  'verify-stale',
  'waiting-outside-dep',
  'watch-base-failed',
]

// Agent runs (brief-start, verify-done …) and gate actions (gate-wait, gate-ready …).
const QUIET_FAMILIES = [new RegExp(`^(${ROLES.join('|')})-(start|done)$`), /^gate-[a-z]+$/]

export const DEFAULT_READY_WITHIN_MINUTES = 15

const POLL_MS = 2_000
// The driver stamps an event and then appends it. An event is read once its
// time is a second old, so every event up to the printed cursor is in the file.
const SETTLE_MS = 1_000
// A driver started a moment ago may not hold its lock yet.
const START_GRACE_MS = 15_000
const STALE_HEARTBEAT_MINUTES = 30
const TEXT_LIMIT = 300

// 'wake', 'quiet', or null for a kind this table does not know.
export function classify(kind) {
  if (Object.hasOwn(WAKE_KINDS, kind)) {
    return 'wake'
  }

  if (QUIET_KINDS.includes(kind) || QUIET_FAMILIES.some((family) => family.test(kind))) {
    return 'quiet'
  }

  return null
}

// An unknown kind, from a newer driver, never wakes.
export function wakes(event, { merge = null } = {}) {
  return classify(event.kind) === 'wake' && WAKE_KINDS[event.kind](event, { merge })
}

function iso(ms) {
  return new Date(ms).toISOString()
}

function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_LIMIT)
}

function eventItem(event) {
  const { at, id, kind, ...detail } = event
  const text = Object.keys(detail).length > 0 ? JSON.stringify(detail).slice(0, TEXT_LIMIT) : ''

  return { at, id: id ?? '-', kind, text }
}

export function formatItem(item) {
  return [item.at, String(item.id).padEnd(4), item.kind, item.text].filter(Boolean).join(' ')
}

// `--since`: a count of lines already read, or an ISO time.
export function parseSince(text) {
  if (text === undefined) {
    return null
  }

  if (/^\d+$/.test(text)) {
    return { lines: Number(text) }
  }

  const time = Date.parse(text)

  if (/^\d{4}-\d{2}-\d{2}/.test(text) && Number.isFinite(time)) {
    return { time }
  }

  throw new Error(`--since must be a number of lines or an ISO time, got ${text}`)
}

export function parseReadyWithin(text) {
  if (text === undefined) {
    return DEFAULT_READY_WITHIN_MINUTES
  }

  if (/^\d+$/.test(text)) {
    return Number(text)
  }

  throw new Error(`--ready-within must be a whole number of minutes, got ${text}`)
}

// The PRs of the driver's current run. --only narrows it, and a PR outside it
// keeps whatever state an earlier run left.
function runIds(manifest, events) {
  const start = events.findLast((event) => ['driver-start', 'manifest-reloaded'].includes(event.kind) && Array.isArray(event.prs))

  return start ? start.prs : manifest.prs.map((pr) => pr.id)
}

// A question the delegate took: null when the delegate does not have it,
// else { idleSince }, the time since which no delegate run works on it (null
// while one runs or ran). A run stopped by the driver comes back, or not.
function delegateHold(events, id) {
  const index = events.findLastIndex((event) => event.id === id && ['blocked', 'delegate-escalated'].includes(event.kind))
  const blocked = events[index]

  if (blocked?.kind !== 'blocked' || blocked.delegate !== true) {
    return null
  }

  const runs = events.slice(index + 1).filter((event) => event.id === id && ['delegate-start', 'delegate-done'].includes(event.kind))
  const last = runs.at(-1)

  if (!last) {
    return { idleSince: Date.parse(blocked.at) }
  }

  return { idleSince: last.kind === 'delegate-done' && last.stopped ? Date.parse(last.at) : null }
}

function finishedRun(events) {
  return events.findLast((event) => ['driver-start', 'finished'].includes(event.kind))?.kind === 'finished'
}

// A verified PR the gate keeps from ready-to-merge, often a red base branch
// or a check that never reports. One queued behind the ready PR waits for that
// merge, a held one for its release, and under merge: human one without your
// approval for you. A question the delegate took and no delegate run picked up.
// Each wakes once, when its window ends between `after` and `upTo`.
export function timedItems(ledger, events, ids, { after, upTo, readyWithinMs, merge = null }) {
  const items = []
  const minutes = Math.round(readyWithinMs / 60_000)
  const inWindow = (start) => start + readyWithinMs > after && start + readyWithinMs <= upTo

  for (const id of ids) {
    const entry = ledger?.prs?.[id]

    // A paused rollout and a held PR start no delegate run.
    if (entry?.state === 'blocked' && !ledger.paused && !entry.held) {
      const hold = delegateHold(events, id)

      if (hold?.idleSince != null && inWindow(hold.idleSince)) {
        items.push({
          at: iso(hold.idleSince + readyWithinMs),
          id,
          kind: 'delegate-idle',
          text: oneLine(`no delegate run for ${minutes} min on ${entry.blocked?.kind ?? '?'}: ${entry.blocked?.question ?? ''}`),
        })
      }

      continue
    }

    if (entry?.state !== 'verified' || !entry.verified?.at || entry.held) {
      continue
    }

    if (['ready', 'merge'].includes(entry.gate?.action) || entry.gate?.after || (merge === 'human' && !approvedNow(entry))) {
      continue
    }

    const verifiedAt = Date.parse(entry.verified.at)

    if (inWindow(verifiedAt)) {
      const gate = entry.gate ? `${entry.gate.action}: ${entry.gate.reasons.join('; ')}` : 'no gate verdict yet'

      items.push({
        at: iso(verifiedAt + readyWithinMs),
        id,
        kind: 'verified-stalled',
        text: oneLine(`verified at ${entry.verified.at}, not ready to merge ${minutes} min later. Gate ${gate}`),
      })
    }
  }

  return items
}

function approvedNow(entry) {
  return Boolean(entry.approved && entry.verified && entry.approved.patchId === entry.verified.patchId)
}

function prItem(id, entry, events, merge) {
  if (entry.state === 'blocked' && !delegateHold(events, id)) {
    return { kind: 'blocked', text: `${entry.blocked?.kind ?? '?'}: ${entry.blocked?.question ?? ''}` }
  }

  if (entry.state === 'escalated') {
    return { kind: 'escalated', text: entry.lastError ?? entry.escalation ?? '' }
  }

  if (entry.state === 'verified' && entry.gate?.action === 'ready' && !entry.held) {
    return { kind: 'ready-to-merge', text: entry.gate.reasons.join('; ') }
  }

  if (entry.state === 'verified' && merge === 'human' && !approvedNow(entry) && !entry.held) {
    return { kind: 'verified', text: `PR #${entry.pr} waits for your approval (rollout.mjs card ${id})` }
  }

  return null
}

// What already waits for someone when wait starts. A command still in the
// inbox counts as the answer, because the driver applies it within a second.
export function standingItems(manifest, ledger, events, { now, readyWithinMs, pending = [] }) {
  if (!ledger) {
    return []
  }

  const at = iso(now)
  const answered = new Set(pending.filter((command) => command.id).map((command) => command.id))
  const rolloutCommands = new Set(pending.filter((command) => !command.id).map((command) => command.cmd))
  const items = []

  if (ledger.halted && !rolloutCommands.has('unhalt')) {
    items.push({ at, id: '-', kind: 'halted', text: oneLine(ledger.halted) })
  }

  if (ledger.paused && !rolloutCommands.has('resume')) {
    const reason = events.findLast((event) => event.kind === 'paused')?.reason

    items.push({ at, id: '-', kind: 'paused', text: oneLine(reason ?? 'paused (rollout resume)') })
  }

  const ids = runIds(manifest, events).filter((id) => !answered.has(id))

  for (const id of ids) {
    const entry = ledger.prs?.[id]
    const item = entry ? prItem(id, entry, events, manifest.policy.merge) : null

    if (item) {
      items.push({ at, id, ...item, text: oneLine(item.text) })
    }
  }

  items.push(...timedItems(ledger, events, ids, { after: -Infinity, upTo: now, readyWithinMs, merge: manifest.policy.merge }))

  return items
}

function readBytes(file, offset, length) {
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')

  try {
    readSync(fd, buffer, 0, length, offset)
  } finally {
    closeSync(fd)
  }

  return buffer
}

function parseLine(line) {
  try {
    const value = JSON.parse(line)

    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

// Reads events.jsonl forward from where it stopped. A line counts once it is
// complete and its time is at most `upTo`, so the cursor never passes an event
// the driver is still writing.
function eventReader(file) {
  const records = []
  let offset = 0
  let lines = 0

  function read(upTo) {
    if (!existsSync(file) || statSync(file).size <= offset) {
      return []
    }

    const buffer = readBytes(file, offset, statSync(file).size - offset)
    const fresh = []
    let start = 0

    for (let end = buffer.indexOf(0x0a, start); end !== -1; end = buffer.indexOf(0x0a, start)) {
      const event = parseLine(buffer.subarray(start, end).toString('utf8'))

      if (event && Date.parse(event.at) > upTo) {
        break
      }

      if (event) {
        const record = { index: lines, event }
        records.push(record)
        fresh.push(record)
      }

      lines += 1
      start = end + 1
    }

    offset += start

    return fresh
  }

  return { read, records: () => records, events: () => records.map((record) => record.event) }
}

// The time a --since in lines stands for, for verified PRs that stall.
function sinceTime(since, records) {
  if (since.time !== undefined) {
    return since.time
  }

  const last = records.findLast((record) => record.index < since.lines)

  return last ? Date.parse(last.event.at) : -Infinity
}

function isNew(since, record) {
  if (since === null) {
    return true
  }

  if (since.time !== undefined) {
    return Date.parse(record.event.at) > since.time
  }

  return record.index >= since.lines
}

// The event behind a standing item says nothing new: the item came first.
const SAME_AS = { 'delegate-escalated': 'blocked' }

function withoutRepeats(standing, events) {
  const shown = new Set(standing.map((item) => `${item.id} ${item.kind}`))

  return events.filter((item) => !shown.has(`${item.id} ${SAME_AS[item.kind] ?? item.kind}`))
}

function mtimeMs(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

// Waits until something needs someone. Returns { exit, items, cursor, message }:
// exit 0 with the items, or 2 with a message when no driver runs and the
// rollout has not finished. Every event up to `cursor` has been looked at, so a
// wait with that cursor as --since goes on after it.
export async function waitForAttention(manifest, options = {}) {
  const { since = null, readyWithinMs = DEFAULT_READY_WITHIN_MINUTES * 60_000, clock = Date.now, sleep = delay, pollMs = POLL_MS } = options

  const lockFile = join(manifest.dir, 'driver.lock')
  const beatFile = join(manifest.dir, 'heartbeat')
  const ledgerFile = join(manifest.dir, 'ledger.json')
  const reader = eventReader(join(manifest.dir, 'events.jsonl'))
  const merge = manifest.policy.merge
  const staleMs = Math.max(STALE_HEARTBEAT_MINUTES * 60_000, 3 * manifest.policy.tickSeconds * 1000)
  const startedAt = clock()
  const fresh = (records) => records.filter((record) => isNew(since, record) && wakes(record.event, { merge }))
  const timed = (after, upTo) =>
    timedItems(readLedger(manifest), reader.events(), runIds(manifest, reader.events()), { after, upTo, readyWithinMs, merge })

  let cutoff
  let items

  if (since === null) {
    // The ledger as it is at the start, saved at the end of a tick after the
    // tick's events. Every event stamped before the start is in the file a
    // second later, and the ones after the last save are not in the ledger.
    const savedAt = mtimeMs(ledgerFile) ?? -Infinity
    const ledger = readLedger(manifest)
    const pending = pendingCommands(manifest)

    await sleep(SETTLE_MS)
    cutoff = startedAt
    reader.read(cutoff)

    const standing = standingItems(manifest, ledger, reader.events(), { now: cutoff, readyWithinMs, pending })
    const answered = new Set(pending.map((command) => command.id).filter(Boolean))
    const ids = new Set(['-', ...runIds(manifest, reader.events())])
    const unsaved = reader
      .events()
      .filter((event) => Date.parse(event.at) > savedAt && ids.has(event.id) && !answered.has(event.id) && wakes(event, { merge }))

    items = [...standing, ...withoutRepeats(standing, unsaved.map(eventItem))]
  } else {
    cutoff = startedAt - SETTLE_MS
    items = fresh(reader.read(cutoff)).map((record) => eventItem(record.event))
    items.push(...timed(sinceTime(since, reader.records()), cutoff))
  }

  if (items.length > 0) {
    return { exit: 0, items, cursor: iso(cutoff) }
  }

  // Events are appended before the lock goes, so a read now has every one the driver wrote.
  function gone() {
    const records = reader.read(Infinity)
    const last = Math.max(cutoff, ...records.map((record) => Date.parse(record.event.at)).filter(Number.isFinite))
    const woken = fresh(records).map((record) => eventItem(record.event))
    const finished = reader.events().findLast((event) => event.kind === 'finished')

    if (woken.length > 0) {
      return { exit: 0, items: woken, cursor: iso(last) }
    }

    if (finishedRun(reader.events())) {
      return { exit: 0, items: [eventItem(finished)], cursor: iso(last) }
    }

    return {
      exit: 2,
      items: [],
      cursor: iso(last),
      message: `no driver is running for ${manifest.rollout} and it has not finished (start it with: rollout.mjs run --dir ${manifest.dir})`,
    }
  }

  // No lock file yet, or one created empty and written a moment later: a driver that is starting.
  const lockAge = startedAt - (mtimeMs(lockFile) ?? startedAt)

  if (!lockHolder(manifest) && lockAge < START_GRACE_MS) {
    while (!lockHolder(manifest) && clock() - startedAt < START_GRACE_MS) {
      await sleep(pollMs)
    }
  }

  if (!lockHolder(manifest)) {
    return gone()
  }

  let beat = mtimeMs(beatFile)
  let quietMs = 0
  let lastReading = clock()
  let after = cutoff

  for (;;) {
    await sleep(pollMs)

    const reading = clock()
    const gap = Math.max(0, reading - lastReading)
    lastReading = reading
    cutoff = Math.max(cutoff, reading - SETTLE_MS)

    const woken = [...fresh(reader.read(cutoff)).map((record) => eventItem(record.event)), ...timed(after, cutoff)]
    after = cutoff

    if (woken.length > 0) {
      return { exit: 0, items: woken, cursor: iso(cutoff) }
    }

    const holder = lockHolder(manifest)

    if (!holder) {
      return gone()
    }

    // Awake time only: after a sleep, the driver needs a tick to beat again.
    const nextBeat = mtimeMs(beatFile)

    if (nextBeat !== beat) {
      beat = nextBeat
      quietMs = 0
    } else {
      quietMs += gap - sleptMs(gap, pollMs)
    }

    if (quietMs > staleMs) {
      return {
        exit: 2,
        items: [],
        cursor: iso(cutoff),
        message: `the driver (pid ${holder.pid}) wrote no heartbeat for ${Math.round(quietMs / 60_000)} min, so it may hang (rollout.mjs status --dir ${manifest.dir})`,
      }
    }
  }
}
