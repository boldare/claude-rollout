import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { delegateAllowed, delegateTakes } from './driver.mjs'
import { commandEffect } from './driver/commands.ts'
import { approvalChannel, approveRefusal } from './judge.mjs'
import { freshPr, lockHolder, migrated, parseTickNote, readLedger, withDefaults, writtenBriefs } from './ledger.mjs'
import { candidates, matchKey, MAX_CANDIDATES, newFindings, oneLine, readAfterVerification } from './review.ts'
import { runsFromEvents, runsFromLedger } from './runs.mjs'
import { mergedSentence, statusSentence, wayOut } from './sentences.ts'
import { REVIEW_SEVERITIES } from './state.ts'
import { jsonLines } from './transcript.mjs'
import { waitsOnBlock, waitsOnEscalation, recoverRun, statusQuestion } from './transitions.ts'

// A read-only model of one rollout directory, shared by the CLI and the UI
// so they never disagree. It only reads files: no GitHub, git, child
// processes or console output. A ledger of an older version is migrated in
// memory, as the driver migrates it when it starts, and never written.

export const ROLES = ['brief', 'implement', 'fix', 'verify', 'delegate']
const RESUMING_ROLES = ['brief', 'implement', 'fix']
const QUESTION_CODES = ['brief-questions', 'decision', 'obstacle']
const MARKED_KINDS = ['running', 'needs-you']
const REASON_LIMIT = 200
// A note's effect does not depend on its words, only on there being some.
const ANY_NOTE = 'a note'
const REFUSED = 'refused: '
const DROPPED = {
  'verification approval': 'verification and approval are dropped',
  verification: 'verification is dropped',
  approval: 'approval is dropped',
}

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

// An entry of a migrated ledger, as the driver reads it. A PR with no entry
// yet is a fresh one on the stage its brief file gives.
function entryOf(ledger, pr, at) {
  return withDefaults(ledger.prs?.[pr.id] ?? freshPr(existsSync(pr.brief) ? 'implement' : 'brief', at))
}

function depState(manifest, ledger, id, at) {
  return entryOf(ledger, manifest.all.find((pr) => pr.id === id) ?? { id, brief: '' }, at)
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

// The findings no verifier got, of a review read after the verification of the claimed head. Without the
// manifest key nothing reads a stored review.
function newSinceVerification(manifest, entry) {
  const settings = manifest.gates.verify.externalFindings
  const { review } = entry

  if (!settings || !review || review.sha !== entry.claimedSha || !readAfterVerification(review, entry.verified)) {
    return 0
  }

  return newFindings(review, settings.minSeverity, entry.reviewMemory).length
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
  const shown = {
    stage: entry.stage,
    kind: status.kind,
    code: status.code,
    sentence: statusSentence(status, facts),
    since: status.since,
    wayOut: wayOut(status, facts),
    marker: markerOf(status, entry, ledger),
    question: questionOf(entry.status),
  }

  const fresh = newSinceVerification(manifest, entry)

  // Absent rather than null, so the status of a PR with nothing new keeps its shape.
  return fresh > 0 ? { ...shown, reviewMarker: `review: ${fresh} new` } : shown
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

// The last answer to a question, and the run that picked it up while it
// works. Once that run ends, the status shows what came next.
function answeredOf(entry, id, runs) {
  const last = entry.noteHistory?.at(-1)
  const waitsOrDone = entry.stage === 'merged' || waitsOnBlock(entry) || waitsOnEscalation(entry)

  if (!last || typeof last.kind !== 'string' || last.kind === '' || waitsOrDone) {
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

  if (!policy || !waitsOnBlock(entry)) {
    return null
  }

  if (runs.some((run) => run.id === id && run.role === 'delegate' && run.status === 'running')) {
    return { state: 'running', reason: '' }
  }

  const question = statusQuestion(entry.status)
  const last = entry.delegate.answers.at(-1)

  if (question && last && last.kind === question.kind && last.question === question.text) {
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

// A question carries the run that asked, null for one the driver raised
// itself, and an escalation names its run beside the entry. Null for any
// other status: the driver raised it.
function askedOf(entry) {
  const { status } = entry
  const question = statusQuestion(status)

  if (question) {
    return { since: status.since, run: question.run, byDriver: question.run === null }
  }

  if (waitsOnEscalation(entry)) {
    return { since: status.since, run: entry.escalationRun ?? null, byDriver: false }
  }

  return null
}

// Since when a PR waits for the maintainer, and which run asked. Only an
// escalation has a last error: older ones stay in the ledger.
function waitingOf(manifest, entry, id, { runs }, status) {
  if (status.kind !== 'needs-you') {
    return null
  }

  return {
    ...(askedOf(entry) ?? { since: status.since, run: null, byDriver: true }),
    lastError: waitsOnEscalation(entry) ? (entry.lastError ?? null) : null,
    delegate: delegateOf(manifest, entry, runs, id),
  }
}

function placeText(stage, status) {
  return status ? `${stage} · ${status.kind}: ${status.code}` : 'merged'
}

// Only a driver that runs has anything at work. Its own merge is no agent's.
function atWorkOf(entry, runs, id) {
  if (entry.status?.kind === 'running' && entry.status.code === 'delegate') {
    return 'delegate'
  }

  if (entry.status?.kind === 'running' && entry.status.code !== 'merge') {
    return 'agent'
  }

  return runs.some((run) => run.id === id && run.role === 'delegate' && run.status === 'running') ? 'delegate' : null
}

function afterText(cmd, before, effect) {
  const stays = effect.stage === before.stage && effect.status?.kind === before.status?.kind && effect.status?.code === before.status?.code

  if (effect.queued && stays) {
    return `after ${cmd}: queued, the next writing agent reads it`
  }

  const fix = effect.fix ? ` (${effect.fix.reason})` : ''

  return `after ${cmd}: ${placeText(effect.stage, effect.status)}${fix}`
}

// The effect as lines: what the row shows, then what the command does, or why it is refused.
function effectLines(shown, before, cmd, effect, driverRunning) {
  const lines = [shown.kind ? placeText(shown.stage, shown) : shown.stage]

  if (!effect.applies) {
    lines.push(`${REFUSED}${effect.instead ? `${effect.reason}: ${effect.instead}` : effect.reason}`)
    return lines
  }

  lines.push(afterText(cmd, before, effect))

  if (effect.drops.length > 0) {
    lines.push(DROPPED[effect.drops.join(' ')])
  }

  if (!driverRunning) {
    lines.push('the driver is not running: the command waits in the inbox until it starts')
  }

  return lines
}

// A dead driver's runs resume when it starts, so the effect starts from that.
function commandLines(manifest, ledger, pr, { entry, shown }, command, { runs, driver }) {
  const copy = structuredClone(entry)

  if (!driver.running) {
    recoverRun(copy, { refund: true, at: driver.at })
  }

  const facts = {
    at: driver.at,
    atWork: driver.running ? atWorkOf(copy, runs, pr.id) : null,
    briefWritten: existsSync(pr.brief),
    limits: manifest.policy.attempts,
    mergeDelaySeconds: manifest.policy.mergeDelaySeconds,
    approveRefusal: (candidate) => approveRefusal(manifest, candidate),
  }

  const effect = commandEffect({ prs: { [pr.id]: copy }, hold: ledger.hold ?? null }, command, facts)

  return { applies: effect.applies, lines: effectLines(shown, copy, command.cmd, effect, driver.running) }
}

function effectsOf(manifest, ledger, pr, shownEntry, context) {
  return {
    retry: commandLines(manifest, ledger, pr, shownEntry, { cmd: 'retry', id: pr.id }, context),
    note: commandLines(manifest, ledger, pr, shownEntry, { cmd: 'note', id: pr.id, text: ANY_NOTE }, context),
  }
}

// `ledger` is the migrated one.
function rowFor(manifest, ledger, pr, context) {
  const { lastEventAt, runs, driver } = context
  const entry = entryOf(ledger, pr, driver.at)
  const status = statusOf(manifest, ledger, entry, pr.id, driver)
  const active = runs.findLast((run) => run.id === pr.id && run.status === 'running')

  return {
    id: pr.id,
    title: pr.title,
    branch: pr.branch,
    status,
    effects: effectsOf(manifest, ledger, pr, { entry, shown: status }, context),
    hold: entry.hold ?? null,
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

// `driver` is { running, stoppedAt, now }, as rowDriver gives it. The
// migration reads `events`, which need not be on disk.
export function prRows(manifest, ledger, events, runs, driver) {
  const times = lastEventTimes(events)
  const shown = driverOf(driver)
  const current = migrated(ledger, { events, briefs: writtenBriefs(manifest), at: shown.at })

  return manifest.all.map((pr) => rowFor(manifest, current, pr, { lastEventAt: times.get(pr.id), runs, driver: shown }))
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

function reviewRow(finding, note) {
  return {
    severity: finding.severity,
    criterion: oneLine(finding.criterion),
    file: oneLine(finding.file),
    line: finding.line,
    title: oneLine(finding.title),
    note,
  }
}

function reviewSummary({ skipped, counts, findings, leftOut, fixed, fresh }) {
  if (skipped !== null) {
    return `skipped: ${skipped}`
  }

  const severities = REVIEW_SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => `${counts[severity]} ${severity}`)
  const noun = findings.length === 1 ? 'finding' : 'findings'
  const parts = [findings.length === 0 ? 'no findings' : `${findings.length} ${noun} (${severities.join(', ')})`]

  if (leftOut > 0) {
    parts.push(`${leftOut} left out`)
  }

  if (fixed.length > 0) {
    parts.push(`${fixed.length} fixed`)
  }

  if (fresh > 0) {
    parts.push(`${fresh} new since the verification`)
  }

  return parts.join(', ')
}

function answerNote(record) {
  if (record.result === 'refuted' && record.evidence) {
    return `${record.id} refuted: ${oneLine(record.evidence)}`
  }

  return `${record.id} ${record.result}`
}

// What became of each finding at or above minSeverity, in the order the view lists them. A finding left out
// at launch as a finding to re-check must not read as over the limit once a PASS has cleared the findings.
function candidateNotes(entry, review, found) {
  const sent = review.candidates
  const keys = found.map((finding) => matchKey(finding))
  const lastSent = sent.length === MAX_CANDIDATES ? keys.indexOf(sent.at(-1).key) : -1
  const answers = entry.verdict?.sha === review.sha ? (entry.verdict.external ?? []) : []
  const items = entry.findings?.items ?? []
  const refuted = entry.reviewMemory?.refuted ?? []
  const sentEarlier = entry.reviewMemory?.sent ?? []
  const later = readAfterVerification(review, entry.verified)

  return keys.map((key, index) => {
    const candidate = sent.find((item) => item.key === key)

    if (candidate) {
      const record = answers.find((item) => item.id === candidate.id && item.key === key)

      return record ? answerNote(record) : `${candidate.id} sent, no answer yet`
    }

    const finding = items.find((item) => item.fromReview === key)

    if (finding) {
      return `not sent, already finding ${finding.id}`
    }

    // A fact of the PR, so it shows before a launch too.
    const earlier = refuted.find((record) => record.key === key)

    if (earlier) {
      return earlier.evidence ? `refuted earlier: ${oneLine(earlier.evidence)}` : 'refuted earlier'
    }

    if (lastSent !== -1 && index > lastSent) {
      return `not sent, over ${MAX_CANDIDATES}`
    }

    // A review read after the verification went to no verifier, so only an earlier round can have sent its key.
    if (later && sent.length === 0) {
      return sentEarlier.includes(key) ? 'went to a verifier earlier' : 'new since the verification'
    }

    return sent.length > 0 ? 'not sent, re-checked as a finding' : ''
  })
}

// Without the manifest key nothing reads a stored review, and there is no level to split it at.
// A review of an older head says nothing about the one claimed now.
function reviewOf(manifest, entry) {
  const settings = manifest.gates.verify.externalFindings
  const { review } = entry

  if (!settings || !review || review.sha !== entry.claimedSha) {
    return null
  }

  const { minSeverity } = settings
  const split = candidates(review, minSeverity)
  const below = `shown only, below ${minSeverity}`
  const notes = candidateNotes(entry, review, split.candidates)
  const findings = [
    ...split.candidates.map((finding, i) => reviewRow(finding, notes[i])),
    ...split.below.map((finding) => reviewRow(finding, below)),
  ]

  const fixed = review.fixed.map((finding) => reviewRow(finding, 'fixed'))
  const counts = Object.fromEntries(
    REVIEW_SEVERITIES.map((severity) => [severity, findings.filter((row) => row.severity === severity).length]),
  )

  const skipped = review.skipped ? oneLine(review.skipped) : null
  const { leftOut } = review
  const fresh = newSinceVerification(manifest, entry)

  return {
    sha: review.sha,
    reusedFrom: review.reusedFrom ? oneLine(review.reusedFrom) : null,
    skipped,
    minSeverity,
    counts,
    leftOut,
    summary: reviewSummary({ skipped, counts, findings, leftOut, fixed, fresh }),
    findings,
    fixed,
  }
}

// The trace comment in one line, for the card and the PR page, or null when the driver writes none.
function traceLine(manifest, entry) {
  if (manifest.policy.trace !== 'comment') {
    return null
  }

  const record = entry.trace

  if (record?.error) {
    return `the last write failed: ${oneLine(record.error)}`
  }

  if (record?.at) {
    return `written at ${record.at}`
  }

  return 'not written yet'
}

// Who approved, and whether the approval shows on GitHub too, in one line for the card and the PR page.
function approvedByLine(entry) {
  const approved = entry.approved

  if (!approved) {
    return null
  }

  const who = approved.by || 'an unknown login'

  if (approved.channel === 'github') {
    return `${who}, with a review on GitHub`
  }

  if (typeof approved.review === 'number') {
    return `${who}, on GitHub too as review ${approved.review}`
  }

  if (approved.reviewError) {
    return `${who}, not on GitHub: ${oneLine(approved.reviewError)}`
  }

  return `${who}, not on GitHub`
}

export function prDetail(manifest, ledger, events, runs, id, driver) {
  const pr = manifest.all.find((item) => item.id === id)

  if (!pr) {
    return null
  }

  const shown = driverOf(driver)
  const current = migrated(ledger, { events, briefs: writtenBriefs(manifest), at: shown.at })
  const entry = entryOf(current, pr, shown.at)
  const notesPath = pr.brief.replace(/\.md$/, '.review-notes.md')

  return {
    ...rowFor(manifest, current, pr, { lastEventAt: lastEventTimes(events).get(id), runs, driver: shown }),
    author: entry.author ?? null,
    approval: approvalChannel(manifest, entry.author),
    merge: manifest.policy.merge,
    maintainers: manifest.repo.maintainers,
    verified: entry.verified ?? null,
    approved: entry.approved ?? null,
    approvedBy: approvedByLine(entry),
    mergeSha: entry.mergeSha ?? null,
    fix: entry.fix ?? null,
    fixReason: entry.fixReason ?? null,
    lastError: entry.lastError ?? null,
    noteHistory: entry.noteHistory ?? [],
    escalationRun: entry.escalationRun ?? null,
    ready: entry.ready ?? null,
    brief: { path: pr.brief, exists: existsSync(pr.brief), notesPath, notesExist: existsSync(notesPath) },
    workflowFiles: entry.workflowFiles ?? [],
    outOfScope: entry.outOfScope ?? [],
    verdict: entry.verdict ?? null,
    verdicts: verdictsOf(entry),
    preVerify: preVerifyOf(entry),
    review: reviewOf(manifest, entry),
    trace: traceLine(manifest, entry),
    feedback: entry.feedbackHandled ?? [],
    delegate: { maxPerPr: manifest.policy.delegate?.maxPerPr ?? null, runs: entry.delegate.runs, answers: entry.delegate.answers },
    runs: runs.filter((run) => run.id === id),
  }
}

// What the rows are built from, or null with no ledger yet.
function viewInputs(manifest, now, eventsOf) {
  const ledger = readLedger(manifest)

  if (!ledger) {
    return null
  }

  const events = eventsOf(manifest)
  const driver = liveness(manifest, now)
  const shown = rowDriver(manifest, now, driver.running)
  const runs = runsOf(ledger, events, { driverRunning: driver.running })

  return { ledger, events, driver, shown, runs }
}

// The effect of a retry, a note or an approve as the CLI and the server
// print it before they send it: the same lines a row's effects hold.
export function commandPreview(manifest, command, now = Date.now()) {
  const inputs = viewInputs(manifest, now, readEvents)

  if (!inputs) {
    return null
  }

  const { ledger, events, runs, shown } = inputs
  const pr = manifest.all.find((item) => item.id === command.id)
  const context = { runs, driver: driverOf(shown) }
  const current = migrated(ledger, { events, briefs: writtenBriefs(manifest), at: context.driver.at })
  const entry = entryOf(current, pr, context.driver.at)
  const status = statusOf(manifest, current, entry, pr.id, context.driver)

  return commandLines(manifest, current, pr, { entry, shown: status }, { at: context.driver.at, ...command }, context)
}

// The reason of a refused preview, and what to do instead, as its last line names them.
export function refusalOf(preview) {
  return preview.applies ? null : preview.lines.at(-1).slice(REFUSED.length)
}

export function rolloutView(manifest, now = Date.now(), eventsOf = readEvents) {
  const inputs = viewInputs(manifest, now, eventsOf)

  if (!inputs) {
    return null
  }

  const { ledger, events, driver, shown, runs } = inputs

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
