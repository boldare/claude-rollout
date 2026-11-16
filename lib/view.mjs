import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { delegateAllowed, delegateTakes } from './driver.mjs'
import { approvalChannel } from './judge.mjs'
import { lockHolder, parseTickNote, readLedger, withDefaults } from './ledger.mjs'
import { runsFromEvents, runsFromLedger } from './runs.mjs'
import { mergedSentence, statusSentence, wayOut } from './sentences.ts'
import { jsonLines } from './transcript.mjs'
import { fillFromState } from './transitions.ts'

// A read-only model of one rollout directory, shared by the CLI and the UI
// so they never disagree. It only reads files: no GitHub, git, child
// processes or console output.

export const ROLES = ['brief', 'implement', 'fix', 'verify', 'delegate']
const RESUMING_ROLES = ['brief', 'implement', 'fix']
const WAITS_OR_DONE = ['blocked', 'escalated', 'merged']
// The driver raises these blocks itself (lib/driver.mjs). Any other kind comes
// from the report of the run that ended last.
const DRIVER_BLOCKS = ['closed', 'gate', 'code-scanning']
// The needs-you codes a run's report or an escalation raises. The block or the
// escalation knows since when and which run asked. The other codes are the driver's.
const ASKED_CODES = ['brief-questions', 'decision', 'obstacle', 'dispute', 'attempts-exhausted', 'errors']
const QUESTION_CODES = ['brief-questions', 'decision', 'obstacle']
const MARKED_KINDS = ['running', 'needs-you']
const REASON_LIMIT = 200

function round(value) {
  return Number(value.toFixed(4))
}

export function liveness(manifest, now = Date.now()) {
  const holder = lockHolder(manifest)
  const beat = join(manifest.dir, 'heartbeat')
  let heartbeatAgeSeconds = null
  let heartbeatNote = ''

  if (existsSync(beat)) {
    heartbeatAgeSeconds = Math.round((now - statSync(beat).mtimeMs) / 1000)
    heartbeatNote = readFileSync(beat, 'utf8').split(' ').slice(1).join(' ')
  }

  return { running: Boolean(holder), pid: holder?.pid ?? null, heartbeatAgeSeconds, heartbeatNote, tick: parseTickNote(heartbeatNote) }
}

function heartbeatAt(manifest) {
  const beat = join(manifest.dir, 'heartbeat')

  return existsSync(beat) ? new Date(statSync(beat).mtimeMs).toISOString() : null
}

// What the rows need of the driver: whether it runs, the time of its last
// heartbeat while it does not, and the time of the view.
export function rowDriver(manifest, now = Date.now(), running = liveness(manifest, now).running) {
  return { running, stoppedAt: running ? null : heartbeatAt(manifest), now }
}

export function parseEvents(text) {
  return jsonLines(text)
}

export function readEvents(manifest) {
  const file = join(manifest.dir, 'events.jsonl')

  return existsSync(file) ? parseEvents(readFileSync(file, 'utf8')) : []
}

// A ledger from before version 2 records no runs, so its runs come from the events.
export function runsOf(ledger, events, options) {
  return ledger.version >= 2 ? runsFromLedger(ledger, options) : runsFromEvents(events, options)
}

export function costs(manifest, ledger, runs) {
  const byPr = {}

  for (const pr of manifest.all) {
    byPr[pr.id] = ledger.prs?.[pr.id]?.costUsd ?? 0
  }

  const byRole = Object.fromEntries(ROLES.map((role) => [role, 0]))

  for (const run of runs) {
    byRole[run.role] = round(byRole[run.role] + (run.costUsd ?? 0))
  }

  const ended = runs.filter((run) => run.endedAt).sort((left, right) => Date.parse(left.endedAt) - Date.parse(right.endedAt))
  const overTime = []
  let total = 0

  for (const run of ended) {
    total += run.costUsd ?? 0
    overTime.push({ at: run.endedAt, totalUsd: round(total) })
  }

  return { totalUsd: round(Object.values(byPr).reduce((sum, cost) => sum + cost, 0)), byPr, byRole, overTime }
}

// Without the driver's liveness a view counts the driver as running.
function driverOf(driver) {
  const now = driver?.now ?? Date.now()

  return { running: driver?.running ?? true, stoppedAt: driver?.stoppedAt ?? null, at: new Date(now).toISOString() }
}

// The entry as the driver fills it on open, so a ledger an older driver or a
// test wrote shows a stage and a status too. The fill writes into a copy:
// the stored entry stays as it is.
function prState(ledger, pr, at) {
  const entry = withDefaults(ledger.prs?.[pr.id] ?? {})

  return fillFromState(entry, { id: pr.id, briefWritten: existsSync(pr.brief), runs: ledger.runs, at })
}

function depState(manifest, ledger, id, at) {
  return prState(ledger, manifest.all.find((pr) => pr.id === id) ?? { id, brief: '' }, at)
}

function headOf(entry) {
  return (entry.verified?.sha ?? entry.claimedSha ?? '').slice(0, 7) || '-'
}

// Decision 33: a dead driver runs nothing, so a running status it left shows
// as stopped, since its last heartbeat.
function shownStatus(entry, driver) {
  const { status } = entry

  if (driver.running || status.kind !== 'running') {
    return status
  }

  return { kind: 'waiting', code: 'driver-stopped', since: driver.stoppedAt ?? status.since }
}

function namedHold(status, entry, ledger) {
  if (status.code !== 'held') {
    return null
  }

  return status.scope === 'rollout' ? (ledger.hold ?? null) : entry.hold
}

// A hold on a running or a needs-you PR, as the driver's tick has it: the
// rollout's wins over the PR's own. A waiting status needs no marker, because
// the driver writes held in its place.
function markerOf(status, entry, ledger) {
  const hold = ledger.hold ?? entry.hold

  if (!hold || !MARKED_KINDS.includes(status.kind)) {
    return null
  }

  return { scope: ledger.hold ? 'rollout' : 'pr', at: hold.at, by: hold.by, reason: hold.reason ?? null }
}

function questionOf(status) {
  if (!QUESTION_CODES.includes(status.code)) {
    return null
  }

  const { kind, text, evidence } = status.question

  return { kind, text, evidence }
}

function mergedStatus(entry) {
  const sentence = mergedSentence(entry.mergeSha ?? null)

  return { stage: 'merged', kind: null, code: null, sentence, since: null, wayOut: null, marker: null, question: null }
}

// The status a row shows, with its sentence and its way out from lib/sentences.ts.
function statusOf(manifest, ledger, entry, id, driver) {
  if (entry.stage === 'merged') {
    return mergedStatus(entry)
  }

  const status = shownStatus(entry, driver)
  const facts = { id, base: manifest.repo.base, hold: namedHold(status, entry, ledger) }

  return {
    stage: entry.stage,
    kind: status.kind,
    code: status.code,
    sentence: statusSentence(status, facts),
    since: status.since,
    wayOut: wayOut(status, facts),
    marker: markerOf(status, entry, ledger),
    question: questionOf(entry.status),
  }
}

// The CLI's filters. Both together keep the rows that match both.
export function rowsMatching(rows, { stage = null, needsYou = false } = {}) {
  return rows.filter((row) => (!stage || row.status.stage === stage) && (!needsYou || row.status.kind === 'needs-you'))
}

function lastEventTimes(events) {
  const times = new Map()

  for (const event of events) {
    times.set(event.id, event.at)
  }

  return times
}

// The driver stamps a note with the run it went into, and with null until
// that run starts. A run without a name also has a null run, so null is no
// name to look for. Older notes have no stamp: the first brief, implement or
// fix run that started after the note picked it up.
function pickedUpBy(note, id, runs) {
  if (Object.hasOwn(note, 'run')) {
    return note.run === null ? null : runs.find((run) => run.run === note.run)
  }

  const answeredAt = Date.parse(note.at)

  return runs.find((run) => run.id === id && RESUMING_ROLES.includes(run.role) && run.startedAt && Date.parse(run.startedAt) >= answeredAt)
}

// The last answer to a blocked PR, and the run that picked it up while it works.
// Once that run ends, the state shows what came next.
function answeredOf(entry, id, runs) {
  const last = entry.noteHistory?.at(-1)

  if (!last || typeof last.kind !== 'string' || last.kind === '' || WAITS_OR_DONE.includes(entry.state)) {
    return null
  }

  const pickedUp = pickedUpBy(last, id, runs)

  if (pickedUp && pickedUp.status !== 'running') {
    return null
  }

  return { at: last.at, by: last.by, run: pickedUp?.run ?? null, role: pickedUp?.role ?? null }
}

function cut(text) {
  const value = typeof text === 'string' ? text.trim() : ''

  return value.length > REASON_LIMIT ? `${value.slice(0, REASON_LIMIT - 1)}…` : value
}

// What the delegate does about the question a PR is blocked on: it runs, it
// answered or passed it on, it runs next, or it cannot take it. It asks the
// driver's own rules, so the board never promises a run the driver will not start.
function delegateOf(manifest, entry, runs, id) {
  const policy = manifest.policy.delegate

  if (!policy || entry.state !== 'blocked' || !entry.blocked) {
    return null
  }

  if (runs.some((run) => run.id === id && run.role === 'delegate' && run.status === 'running')) {
    return { state: 'running', reason: '' }
  }

  const last = entry.delegate.answers.at(-1)

  if (last && last.kind === entry.blocked.kind && last.question === (entry.blocked.question ?? '')) {
    return { state: last.decision, reason: cut(last.decision === 'answer' ? last.answer : last.reasoning) }
  }

  if (!delegateAllowed(manifest, entry)) {
    return { state: 'skips', reason: '' }
  }

  if (!delegateTakes(manifest, entry)) {
    return { state: 'spent', reason: `${entry.delegate.runs} of ${policy.maxPerPr} runs` }
  }

  return { state: 'next', reason: '' }
}

// The driver stamps a block with the run that asked, null for a block it
// raises itself, and an escalation with its time and run. Older entries have
// no stamps: a block or an escalation follows the run that ended last before it.
function askedOf(entry, id, events, runs) {
  const blocked = entry.state === 'blocked'

  if (!blocked && entry.escalatedAt) {
    return { since: entry.escalatedAt, run: entry.escalationRun ?? null, byDriver: false }
  }

  const since = events.findLast((event) => event.id === id && event.kind === entry.state)?.at ?? null

  if (blocked && entry.blocked && Object.hasOwn(entry.blocked, 'run')) {
    return { since, run: entry.blocked.run, byDriver: entry.blocked.run === null }
  }

  const byDriver = blocked && DRIVER_BLOCKS.includes(entry.blocked?.kind)
  const ended = (run) => run.endedAt && (!since || Date.parse(run.endedAt) <= Date.parse(since))
  const asked = runs.findLast(
    (run) => run.id === id && run.role !== 'delegate' && (!blocked || RESUMING_ROLES.includes(run.role)) && ended(run),
  )

  return { since, run: byDriver ? null : (asked?.run ?? null), byDriver }
}

// Since when a PR waits for the maintainer, and which run asked. Only an
// escalation has an escalation and a last error: older ones stay in the ledger.
function waitingOf(manifest, entry, id, { events, runs }, status) {
  if (status.kind !== 'needs-you') {
    return null
  }

  const asked = ASKED_CODES.includes(status.code) ? askedOf(entry, id, events, runs) : { since: status.since, run: null, byDriver: true }
  const escalated = entry.state === 'escalated'

  return {
    ...asked,
    escalation: escalated ? (entry.escalation ?? null) : null,
    lastError: escalated ? (entry.lastError ?? null) : null,
    delegate: delegateOf(manifest, entry, runs, id),
  }
}

function rowFor(manifest, ledger, pr, context) {
  const { lastEventAt, runs, driver } = context
  const entry = prState(ledger, pr, driver.at)
  const status = statusOf(manifest, ledger, entry, pr.id, driver)
  const active = runs.findLast((run) => run.id === pr.id && run.status === 'running')

  return {
    id: pr.id,
    title: pr.title,
    branch: pr.branch,
    state: entry.state,
    status,
    held: entry.held ?? null,
    pr: entry.pr ?? null,
    url: entry.pr ? `https://github.com/${manifest.repo.github}/pull/${entry.pr}` : null,
    head: headOf(entry),
    deps: pr.deps.map((dep) => ({ id: dep, stage: depState(manifest, ledger, dep, driver.at).stage })),
    attempts: entry.attempts,
    costUsd: entry.costUsd,
    lastEventAt: lastEventAt ?? null,
    activeRun: active?.run ?? null,
    gate: entry.gate ?? null,
    waiting: waitingOf(manifest, entry, pr.id, context, status),
    answered: answeredOf(entry, pr.id, runs),
  }
}

// `driver` is { running, stoppedAt, now }, as rowDriver gives it.
export function prRows(manifest, ledger, events, runs, driver) {
  const times = lastEventTimes(events)
  const shown = driverOf(driver)

  return manifest.all.map((pr) => rowFor(manifest, ledger, pr, { lastEventAt: times.get(pr.id), runs, events, driver: shown }))
}

// Ledgers from before the verdict history hold only the latest verdict.
function verdictsOf(entry) {
  if (entry.verdicts?.length > 0) {
    return entry.verdicts
  }

  return entry.verdict ? [entry.verdict] : []
}

// Results for an older head say nothing about the one claimed now.
function preVerifyOf(entry) {
  return entry.preVerify && entry.preVerify.sha === entry.claimedSha ? entry.preVerify : null
}

export function prDetail(manifest, ledger, events, runs, id, driver) {
  const pr = manifest.all.find((item) => item.id === id)

  if (!pr) {
    return null
  }

  const shown = driverOf(driver)
  const entry = prState(ledger, pr, shown.at)
  const notesPath = pr.brief.replace(/\.md$/, '.review-notes.md')

  return {
    ...rowFor(manifest, ledger, pr, { lastEventAt: lastEventTimes(events).get(id), runs, events, driver: shown }),
    author: entry.author ?? null,
    approval: approvalChannel(manifest, entry.author),
    merge: manifest.policy.merge,
    maintainers: manifest.repo.maintainers,
    verified: entry.verified ?? null,
    approved: entry.approved ?? null,
    mergeSha: entry.mergeSha ?? null,
    fix: entry.fix ?? null,
    fixReason: entry.fixReason ?? null,
    lastError: entry.lastError ?? null,
    blocked: entry.blocked ?? null,
    noteHistory: entry.noteHistory ?? [],
    escalation: entry.escalation ?? null,
    escalatedAt: entry.escalatedAt ?? null,
    escalationRun: entry.escalationRun ?? null,
    ready: entry.ready ?? null,
    brief: { path: pr.brief, exists: existsSync(pr.brief), notesPath, notesExist: existsSync(notesPath) },
    workflowFiles: entry.workflowFiles ?? [],
    outOfScope: entry.outOfScope ?? [],
    verdict: entry.verdict ?? null,
    verdicts: verdictsOf(entry),
    preVerify: preVerifyOf(entry),
    feedback: entry.feedbackHandled ?? [],
    delegate: { maxPerPr: manifest.policy.delegate?.maxPerPr ?? null, runs: entry.delegate.runs, answers: entry.delegate.answers },
    runs: runs.filter((run) => run.id === id),
  }
}

export function rolloutView(manifest, now = Date.now(), eventsOf = readEvents) {
  const ledger = readLedger(manifest)

  if (!ledger) {
    return null
  }

  const events = eventsOf(manifest)
  const driver = liveness(manifest, now)
  const shown = rowDriver(manifest, now, driver.running)
  const runs = runsOf(ledger, events, { driverRunning: driver.running })

  return {
    rollout: manifest.rollout,
    merge: manifest.policy.merge,
    driver: { ...driver, hold: ledger.hold ?? null, stoppedAt: shown.stoppedAt },
    rows: prRows(manifest, ledger, events, runs, shown),
    runs,
    costs: costs(manifest, ledger, runs),
    events,
  }
}
