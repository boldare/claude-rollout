import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { currentGate } from './judge.mjs'
import { lockHolder, pendingCommands, readLedger } from './ledger.mjs'
import { loadManifest } from './manifest.mjs'
import { sleptMs } from './machine.mjs'
import { expandHome } from './sh.mjs'

// rollout wait: blocks until the rollout needs someone, the maintainer or the
// session that follows the rollout, prints what and exits. Like status, it
// only reads the rollout directory.
//
// The driver marks every event it tells the user about with notified, and
// wait wakes on that mark. So the driver alone decides what needs someone,
// and wait keeps only the exceptions below, each with its reason.

// Notices that report progress: the user hears of them, nobody has to act.
export const PROGRESS_NOTICES = {
  approved: 'the merge follows by itself after the merge delay',
  'delegate-answered': 'the PR goes on with the answer, a note can still override it',
  'github-back': 'the outage notice before it woke already',
  'head-moved-reverify': 'a new verification follows by itself',
  merged: 'the driver merged it as planned',
  verified: 'the gate decides what follows, and ready-to-merge, awaiting-approval or a stall wakes',
  'verifier-touched-tree': 'a new verification follows by itself',
}

// Events that need someone though the driver tells no one.
export const SILENT_WAKES = {
  'command-rejected': 'whoever sent the command expects it to apply',
  'merged-outside-driver': 'a merge the plan did not expect, of a PR that was not ready',
}

// What answers a standing item: a command still in the inbox, which the
// driver applies within a second, or the driver's answer to one it already
// took and has not saved yet.
const ANSWER_COMMANDS = ['approve', 'note', 'retry']
const ANSWER_EVENTS = ['approved', 'brief-answered', 'needs-fix', 'note-queued', 'retry']
const ROLLOUT_ANSWERS = { halted: { command: 'unhalt', event: 'unhalted' }, paused: { command: 'resume', event: 'resumed' } }

// After these a PR can move again, so the window of a timed item starts over.
const ROLLOUT_RESTARTS = ['driver-start', 'machine-slept', 'resumed', 'unhalted']
const PR_RESTARTS = ['head-moved-same-patch', 'rebased', 'released', 'retry']

export const DEFAULT_READY_WITHIN_MINUTES = 15

const POLL_MS = 2_000
// The driver stamps an event and then appends it. An event is read once its
// time is a second old, so every event up to the printed cursor is in the file.
const SETTLE_MS = 1_000
// A driver started a moment ago may not hold its lock yet.
const START_GRACE_MS = 15_000
const STALE_HEARTBEAT_MINUTES = 30
const DEFAULT_TICK_SECONDS = 60
const TEXT_LIMIT = 300

export function wakes(event) {
  if (Object.hasOwn(SILENT_WAKES, event.kind)) {
    return true
  }

  return event.notified === true && !Object.hasOwn(PROGRESS_NOTICES, event.kind)
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
  const { at, id, kind, notified: _, ...detail } = event
  const text = Object.keys(detail).length > 0 ? JSON.stringify(detail).slice(0, TEXT_LIMIT) : ''

  return { at, id: id ?? '-', kind, text }
}

export function formatItem(item) {
  return [item.at, String(item.id).padEnd(4), item.kind, item.text].filter(Boolean).join(' ')
}

// `--since`: the ISO time a wait printed as its cursor.
export function parseSince(text) {
  if (text === undefined) {
    return null
  }

  const time = Date.parse(text)

  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && Number.isFinite(time)) {
    return time
  }

  throw new Error(`--since must be the ISO time a wait printed, got ${text}`)
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

function parseLine(line) {
  try {
    const value = JSON.parse(line)

    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function readEvents(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').map(parseLine).filter(Boolean)
  } catch {
    return []
  }
}

function lastStart(events) {
  return events.findLast((event) => event.kind === 'driver-start')
}

// The PRs of the driver's current run. --only narrows it, and a PR outside it
// keeps whatever state an earlier run left.
function runIds(manifest, events) {
  const start = events.findLast((event) => ['driver-start', 'manifest-reloaded'].includes(event.kind) && Array.isArray(event.prs))

  return start ? start.prs : manifest.prs.map((pr) => pr.id)
}

// An invalid edit of manifest.yaml leaves the driver on its last good one, so
// wait follows it with what the driver logged: its PRs, merge mode and tick.
// Throws for a directory without a manifest, or one no driver ever started.
export function manifestForWait(dir) {
  try {
    return { manifest: loadManifest(dir), warning: null }
  } catch (error) {
    const rolloutDir = resolve(expandHome(dir))
    const logged = readEvents(join(rolloutDir, 'events.jsonl')).findLast(
      (event) => ['driver-start', 'manifest-reloaded'].includes(event.kind) && event.merge && Array.isArray(event.prs),
    )

    if (!existsSync(join(rolloutDir, 'manifest.yaml')) || !logged) {
      throw error
    }

    const prs = logged.prs.map((id) => ({ id, deps: [] }))
    const manifest = {
      dir: rolloutDir,
      rollout: basename(rolloutDir),
      policy: { merge: logged.merge, tickSeconds: logged.tickSeconds ?? DEFAULT_TICK_SECONDS },
      prs,
      all: prs,
    }

    return { manifest, warning: `manifest.yaml has an error, following the driver's last good one: ${oneLine(error.message)}` }
  }
}

// A question the delegate took: null when the delegate does not have it,
// else { idleSince }, the time since which no delegate run works on it (null
// while one runs). A run ends with delegate-done, or when a driver starts
// again after it: the run died with the driver before.
function delegateHold(events, id) {
  const index = events.findLastIndex((event) => event.id === id && ['blocked', 'delegate-escalated', 'delegate-limit'].includes(event.kind))
  const blocked = events[index]

  if (blocked?.kind !== 'blocked' || blocked.delegate !== true) {
    return null
  }

  const after = events.slice(index + 1)
  const lastRun = after.findLast((event) => event.id === id && ['delegate-start', 'delegate-done'].includes(event.kind))

  if (!lastRun) {
    return { idleSince: Date.parse(blocked.at) }
  }

  if (lastRun.kind === 'delegate-done') {
    return { idleSince: lastRun.stopped ? Date.parse(lastRun.at) : null }
  }

  const restart = after.findLast((event) => event.kind === 'driver-start' && Date.parse(event.at) >= Date.parse(lastRun.at))

  return { idleSince: restart ? Date.parse(restart.at) : null }
}

// True for a gate verdict that holds a verified PR on purpose (ready for you,
// merging, or queued behind the ready PR), false for one that does not, null
// for an event that is no verdict. GitHub refusing a merge ends the merge,
// but only the first refusal of a head counts: the gate tries again on every
// tick, and a window that started over each time would never end.
function holdsOnPurpose(event) {
  if (event.kind === 'merge-refused') {
    return event.notified === true ? false : null
  }

  if (!String(event.kind).startsWith('gate-') || event.kind === 'gate-check') {
    return null
  }

  return ['gate-ready', 'gate-merge'].includes(event.kind) || event.after !== undefined
}

// When the gate last stopped holding the PR on purpose: the first verdict
// that does not, after one that did.
function leftHoldAt(events, id) {
  let held = false
  let left = -Infinity

  for (const event of events) {
    const holds = event.id === id ? holdsOnPurpose(event) : null

    if (holds === null) {
      continue
    }

    if (held && !holds) {
      left = Date.parse(event.at)
    }

    held = holds
  }

  return left
}

function restartedAt(events, id) {
  const restart = events.findLast(
    (event) => (event.id === id && PR_RESTARTS.includes(event.kind)) || (event.id === '-' && ROLLOUT_RESTARTS.includes(event.kind)),
  )

  return Math.max(restart ? Date.parse(restart.at) : -Infinity, leftHoldAt(events, id))
}

function approvedNow(entry) {
  return Boolean(entry.approved && entry.verified && entry.approved.patchId === entry.verified.patchId)
}

// When a verified PR started to wait on something that should resolve by
// itself, or null for one that waits on purpose: ready for you, merging,
// queued behind the ready PR, or under merge: human without your approval.
function stallStart(entry, merge) {
  if (entry.state !== 'verified' || !entry.verified?.at) {
    return null
  }

  const gate = currentGate(entry)

  if (['ready', 'merge'].includes(gate?.action) || gate?.after) {
    return null
  }

  if (merge !== 'human') {
    return Date.parse(entry.verified.at)
  }

  return approvedNow(entry) ? Math.max(Date.parse(entry.verified.at), Date.parse(entry.approved.at ?? entry.verified.at)) : null
}

function gateText(entry) {
  const gate = currentGate(entry)

  return gate ? `${gate.action}: ${gate.reasons.join('; ')}` : 'no gate verdict yet'
}

// A verified PR the gate keeps from ready-to-merge, often a red base branch
// or a check that never reports, and a question the delegate took that no
// delegate run works on. The window starts when the PR could move again,
// never before `notBefore`, and the item wakes once, when the window ends
// between `after` and `upTo`. Nothing counts while the PR is held or the
// rollout paused, and a stall nothing while it is halted.
export function timedItems(ledger, events, ids, { after, upTo, readyWithinMs, merge = null, notBefore = -Infinity }) {
  const items = []
  const minutes = Math.round(readyWithinMs / 60_000)
  const inWindow = (start) => start + readyWithinMs > after && start + readyWithinMs <= upTo

  for (const id of ids) {
    const entry = ledger?.prs?.[id]

    if (!entry || entry.held || ledger.paused) {
      continue
    }

    const restarted = Math.max(restartedAt(events, id), notBefore)
    const item = entry.state === 'blocked' ? idleItem(entry, events, id, minutes) : stallItem(entry, ledger, merge, minutes)

    if (!item) {
      continue
    }

    const start = Math.max(item.since, restarted)

    if (inWindow(start)) {
      items.push({ at: iso(start + readyWithinMs), id, kind: item.kind, text: oneLine(item.text(start)) })
    }
  }

  return items
}

function idleItem(entry, events, id, minutes) {
  const since = delegateHold(events, id)?.idleSince

  if (since == null) {
    return null
  }

  const question = `${entry.blocked?.kind ?? '?'}: ${entry.blocked?.question ?? ''}`

  return { since, kind: 'delegate-idle', text: () => `no delegate run for ${minutes} min on ${question}` }
}

function stallItem(entry, ledger, merge, minutes) {
  const since = stallStart(entry, merge)

  if (since === null || ledger.halted) {
    return null
  }

  return {
    since,
    kind: 'verified-stalled',
    text: (start) => `waiting since ${iso(start)}, not ready to merge ${minutes} min later. Gate ${gateText(entry)}`,
  }
}

// Deps outside the run that are not merged: the PR cannot start.
function outsideDeps(manifest, ledger, id, ids) {
  const deps = manifest.prs.find((pr) => pr.id === id)?.deps ?? []

  return deps.filter((dep) => !ids.includes(dep) && ledger.prs?.[dep]?.state !== 'merged')
}

function prItem(id, entry, { manifest, ledger, events, ids }) {
  const gate = currentGate(entry)

  if (entry.state === 'blocked' && !delegateHold(events, id)) {
    return { kind: 'blocked', text: `${entry.blocked?.kind ?? '?'}: ${entry.blocked?.question ?? ''}` }
  }

  if (entry.state === 'escalated') {
    return { kind: 'escalated', text: entry.lastError ?? entry.escalation ?? '' }
  }

  if (entry.held) {
    return null
  }

  // A halt stops every merge, and the gate keeps its verdict from before it.
  if (entry.state === 'verified' && gate?.action === 'ready' && !ledger.halted) {
    return { kind: 'ready-to-merge', text: gate.reasons.join('; ') }
  }

  if (entry.state === 'verified' && manifest.policy.merge === 'human' && !approvedNow(entry)) {
    return { kind: 'awaiting-approval', text: `PR #${entry.pr} waits for your approval (rollout.mjs card ${id})` }
  }

  const outside = entry.state === 'pending' ? outsideDeps(manifest, ledger, id, ids) : []

  if (outside.length > 0) {
    return { kind: 'waiting-outside-dep', text: `waits for ${outside.join(', ')}, which is not in this run (--only) and not merged` }
  }

  return null
}

// The PRs and rollout items the inbox or an unsaved answer settles, each with
// the time up to which it settles them: when the command was posted or the
// answer written.
function answers(pending, unsaved) {
  const prs = new Map()
  const rollout = new Map()
  const settle = (map, key, at) => map.set(key, Math.max(map.get(key) ?? -Infinity, at))

  for (const command of pending) {
    const at = Date.parse(command.at) || Infinity

    if (ANSWER_COMMANDS.includes(command.cmd) && command.id) {
      settle(prs, command.id, at)
    }

    for (const [item, answer] of Object.entries(ROLLOUT_ANSWERS)) {
      if (command.cmd === answer.command) {
        settle(rollout, item, at)
      }
    }
  }

  for (const event of unsaved) {
    if (ANSWER_EVENTS.includes(event.kind)) {
      settle(prs, event.id, Date.parse(event.at))
    }

    for (const [item, answer] of Object.entries(ROLLOUT_ANSWERS)) {
      if (event.kind === answer.event) {
        settle(rollout, item, Date.parse(event.at))
      }
    }
  }

  return { prs, rollout }
}

function answeredBefore(map, key, at) {
  return map.has(key) && Date.parse(at) <= map.get(key)
}

// The event behind a standing item says nothing new: the item came first.
const SAME_AS = { 'delegate-escalated': 'blocked', 'delegate-limit': 'blocked' }

function withoutRepeats(standing, events) {
  const shown = new Set(standing.map((item) => `${item.id} ${item.kind}`))

  return events.filter((item) => !shown.has(`${item.id} ${SAME_AS[item.kind] ?? item.kind}`))
}

// What already waits for someone when wait starts: the state the ledger saved
// at `savedAt`, and the waking events written after that save. An answer in
// the inbox or after the save settles what came before it. The timed cases
// count only while a driver runs: a stopped driver moves no PR, so its
// downtime is no stall.
export function standingItems(manifest, ledger, events, { now, readyWithinMs, pending = [], savedAt = -Infinity, driverRuns = true }) {
  if (!ledger) {
    return []
  }

  const at = iso(now)
  const ids = runIds(manifest, events)
  const unsaved = events.filter((event) => Date.parse(event.at) > savedAt)
  const answered = answers(pending, unsaved)
  const items = []

  if (ledger.halted && !answered.rollout.has('halted')) {
    items.push({ at, id: '-', kind: 'halted', text: oneLine(ledger.halted) })
  }

  if (ledger.paused && !answered.rollout.has('paused')) {
    const reason = events.findLast((event) => event.kind === 'paused')?.reason

    items.push({ at, id: '-', kind: 'paused', text: oneLine(reason ?? 'paused (rollout resume)') })
  }

  const open = ids.filter((id) => !answered.prs.has(id))

  for (const id of open) {
    const entry = ledger.prs?.[id]
    const item = entry ? prItem(id, entry, { manifest, ledger, events, ids }) : null

    if (item) {
      items.push({ at, id, ...item, text: oneLine(item.text) })
    }
  }

  if (driverRuns) {
    items.push(...timedItems(ledger, events, open, { after: -Infinity, upTo: now, readyWithinMs, merge: manifest.policy.merge }))
  }

  // halted names the PR whose merge turned the base red, which may be outside the run.
  const inRun = new Set(['-', ...ids])
  const woken = unsaved.filter(
    (event) =>
      (inRun.has(event.id) || event.kind === 'halted') &&
      wakes(event) &&
      !answeredBefore(answered.prs, event.id, event.at) &&
      !answeredBefore(answered.rollout, event.kind, event.at),
  )

  return [...items, ...withoutRepeats(items, woken.map(eventItem))]
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

// Reads events.jsonl forward from where it stopped. A line counts once it is
// complete and its time is at most `upTo`, so the cursor never passes an event
// the driver is still writing.
function eventReader(file) {
  const events = []
  let offset = 0

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
        events.push(event)
        fresh.push(event)
      }

      start = end + 1
    }

    offset += start

    return fresh
  }

  // The complete lines after the cursor, read without moving it.
  function peek() {
    if (!existsSync(file) || statSync(file).size <= offset) {
      return []
    }

    const text = readBytes(file, offset, statSync(file).size - offset).toString('utf8')
    const end = text.lastIndexOf('\n')

    return end === -1 ? [] : text.slice(0, end).split('\n').map(parseLine).filter(Boolean)
  }

  return { read, peek, events: () => events }
}

// The events stamped after `time`, found from the end of the file.
function eventsAfter(events, time) {
  let start = events.length

  while (start > 0 && Date.parse(events[start - 1].at) > time) {
    start -= 1
  }

  return events.slice(start)
}

function mtimeMs(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

// The ledger is read again only once a save changed it.
function ledgerReader(manifest) {
  const file = join(manifest.dir, 'ledger.json')
  let seen
  let ledger = null

  return () => {
    const mtime = mtimeMs(file)

    if (mtime !== seen) {
      seen = mtime
      ledger = readLedger(manifest)
    }

    return ledger
  }
}

function freshItems(events, since) {
  return events.filter((event) => (since === null || Date.parse(event.at) > since) && wakes(event)).map(eventItem)
}

function finishedRun(events) {
  return events.findLast((event) => ['driver-start', 'finished'].includes(event.kind))?.kind === 'finished'
}

// A run that finished with every PR merged: no driver comes after it. After
// a narrowed run another may, for the PRs left.
function rolloutDone(manifest, events) {
  const ledger = readLedger(manifest)

  return finishedRun(events) && manifest.prs.every((pr) => ledger?.prs?.[pr.id]?.state === 'merged')
}

// A word the shell takes as it is, else the word in single quotes.
export function shellWord(text) {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`
}

// No driver holds the lock. Events are appended before the lock goes, so a
// read now has every one the driver wrote.
function gone(wait, cursor) {
  const fresh = wait.reader.read(Infinity)
  const last = Math.max(cursor, ...fresh.map((event) => Date.parse(event.at)).filter(Number.isFinite))
  const woken = freshItems(fresh, wait.since)
  const events = wait.reader.events()

  if (woken.length > 0) {
    return { exit: 0, items: woken, cursor: last }
  }

  if (finishedRun(events)) {
    return { exit: 0, items: [eventItem(events.findLast((event) => event.kind === 'finished'))], cursor: last }
  }

  return {
    exit: 2,
    items: [],
    cursor: last,
    message: `no driver is running for ${wait.manifest.rollout} and it has not finished (start it with: rollout.mjs run --dir ${shellWord(wait.manifest.dir)})`,
  }
}

// Waits until the driver that holds the lock has written its driver-start,
// so no report comes from the run before it. A driver that is starting gets
// START_GRACE_MS to take the lock, and after a rollout that is done none is
// expected. Returns { holder }, null as the holder when no driver runs, or
// { result } for a driver that wait cannot follow.
async function awaitDriver(wait) {
  const { manifest, clock, sleep, pollMs } = wait
  const startedAt = clock()
  const lockFile = join(manifest.dir, 'driver.lock')
  const lockAge = startedAt - (mtimeMs(lockFile) ?? startedAt)

  for (;;) {
    const holder = lockHolder(manifest)
    const events = readEvents(join(manifest.dir, 'events.jsonl'))
    const start = lastStart(events)
    const waited = clock() - startedAt

    if (!holder && (rolloutDone(manifest, events) || lockAge >= START_GRACE_MS || waited >= START_GRACE_MS)) {
      return { holder: null }
    }

    if (holder && start?.pid === holder.pid) {
      return start.noticeMarks ? { holder } : { result: outdated(wait, holder) }
    }

    if (holder && waited >= wait.staleMs) {
      return { result: stuck(wait, `the driver (pid ${holder.pid}) has not finished starting for ${Math.round(waited / 60_000)} min`) }
    }

    await sleep(pollMs)
  }
}

function outdated(wait, holder) {
  return stuck(
    wait,
    `the driver (pid ${holder.pid}) is older than rollout wait and does not mark what it tells you. Stop it (rollout.mjs stop) and run it again`,
  )
}

// Nothing was looked at, so the cursor stays where it was: with none, the
// next wait reports the state again.
function stuck(wait, message) {
  return { exit: 2, items: [], cursor: wait.since, message }
}

// What waits at the start, from the ledger as the last save left it and the
// events written since. Every event stamped up to the start is in the file a
// second later, and that start is the cursor.
async function startReport(wait) {
  const { manifest, reader } = wait
  const at = wait.clock()
  const savedAt = mtimeMs(join(manifest.dir, 'ledger.json')) ?? -Infinity
  const ledger = readLedger(manifest)
  const pending = pendingCommands(manifest)

  await wait.sleep(SETTLE_MS)
  reader.read(at)

  const items = standingItems(manifest, ledger, reader.events(), {
    now: at,
    readyWithinMs: wait.readyWithinMs,
    pending,
    savedAt,
    driverRuns: wait.driverRuns,
  })

  return { items, cursor: at }
}

// With --since: the waking events after the cursor, and, while a driver runs,
// the timed items whose window ended since then.
function replay(wait) {
  const cutoff = Math.max(wait.since, wait.clock() - SETTLE_MS)
  const fresh = freshItems(wait.reader.read(cutoff), wait.since)
  const timed = wait.driverRuns ? wait.timed(wait.since, cutoff) : []

  return { items: [...fresh, ...timed], cursor: cutoff }
}

// A timed item is judged on every poll against every window that ended after
// --since, or any window without it, so a poll or a start that catches the PR
// merging for a moment does not lose it. Windows start over when the PR can
// move again, so an old one never wakes it.
async function pollLoop(wait, cursor) {
  const beatFile = join(wait.manifest.dir, 'heartbeat')
  let cutoff = cursor
  let beat = mtimeMs(beatFile)
  let quietMs = 0
  let lastReading = wait.clock()
  let wokeAt = -Infinity

  for (;;) {
    await wait.sleep(wait.pollMs)

    const reading = wait.clock()
    const gap = Math.max(0, reading - lastReading)
    const slept = sleptMs(gap, wait.pollMs)
    lastReading = reading
    cutoff = Math.max(cutoff, reading - SETTLE_MS)

    // A machine that slept stood still: timed windows start over on waking.
    if (slept > 0) {
      wokeAt = reading
    }

    const items = [...freshItems(wait.reader.read(cutoff), wait.since), ...wait.timed(wait.since ?? -Infinity, cutoff, wokeAt)]

    if (items.length > 0) {
      return { exit: 0, items, cursor: cutoff }
    }

    const holder = lockHolder(wait.manifest)

    if (!holder) {
      return gone(wait, cutoff)
    }

    // Awake time only: after a sleep, the driver needs a tick to beat again.
    const nextBeat = mtimeMs(beatFile)

    if (nextBeat !== beat) {
      beat = nextBeat
      quietMs = 0
    } else {
      quietMs += gap - slept
    }

    if (quietMs > wait.staleMs) {
      return {
        exit: 2,
        items: [],
        cursor: cutoff,
        message: `the driver (pid ${holder.pid}) wrote no heartbeat for ${Math.round(quietMs / 60_000)} min, so it may hang (rollout.mjs status --dir ${shellWord(wait.manifest.dir)})`,
      }
    }
  }
}

// Waits until something needs someone. Returns { exit, items, cursor, message }:
// exit 0 with the items, or 2 with a message when no driver runs and the
// rollout has not finished, or the driver cannot be followed. Every event up
// to `cursor` (ms) has been looked at, so a wait with that cursor as --since
// goes on after it. It is null when nothing was looked at yet.
export async function waitForAttention(manifest, options = {}) {
  const { since = null, readyWithinMs = DEFAULT_READY_WITHIN_MINUTES * 60_000, clock = Date.now, sleep = delay, pollMs = POLL_MS } = options
  const reader = eventReader(join(manifest.dir, 'events.jsonl'))
  const ledger = ledgerReader(manifest)
  const merge = manifest.policy.merge
  const staleMs = Math.max(STALE_HEARTBEAT_MINUTES * 60_000, 3 * manifest.policy.tickSeconds * 1000)
  // A PR answered in the inbox, or by an answer the driver wrote and has not
  // saved yet, is left out as at the start: its saved state is about to
  // change. The ledger is judged as it is now, so the events younger than the
  // settle are peeked at too: an answer, or a restart of the window such as
  // the driver-start of a driver that has just come back.
  const timed = (after, upTo, notBefore) => {
    const savedAt = mtimeMs(join(manifest.dir, 'ledger.json')) ?? -Infinity
    const events = [...reader.events(), ...reader.peek()]
    const answered = answers(pendingCommands(manifest), eventsAfter(events, savedAt)).prs
    const ids = runIds(manifest, events).filter((id) => !answered.has(id))

    return timedItems(ledger(), events, ids, { after, upTo, readyWithinMs, merge, notBefore })
  }

  const wait = { manifest, since, readyWithinMs, clock, sleep, pollMs, reader, staleMs, timed }
  const driver = await awaitDriver(wait)

  if (driver.result) {
    return driver.result
  }

  wait.driverRuns = Boolean(driver.holder)

  const first = since === null ? await startReport(wait) : replay(wait)

  if (first.items.length > 0) {
    return { exit: 0, ...first }
  }

  if (!driver.holder) {
    return gone(wait, first.cursor)
  }

  return pollLoop(wait, first.cursor)
}
