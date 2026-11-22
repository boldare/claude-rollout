import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  closeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { runRecords } from './runs.mjs'
import { jsonLines } from './transcript.mjs'
import { fromVersionTwo } from './transitions.ts'

export const LEDGER_VERSION = 3

// Local state of one rollout. GitHub stays the source of truth for PRs,
// heads, checks and merges. The ledger remembers what GitHub cannot:
// agent sessions, reports, verdicts, approvals, attempts and cost.
export function freshPr(stage = 'brief', at = new Date().toISOString()) {
  return {
    stage,
    status: { kind: 'waiting', code: 'slot', since: at },
    attempts: { implement: 0, fix: 0, verify: 0, brief: 0 },
    sessionId: null,
    sessionCostUsd: 0,
    modelRaised: false,
    pr: null,
    claimedSha: null,
    claimedAt: null,
    ready: null,
    reportUnchecked: false,
    verified: null,
    verdict: null,
    approved: null,
    gate: null,
    pendingNote: null,
    briefAnswers: [],
    briefHeads: [],
    briefDrift: [],
    previewConflict: null,
    implementCutOff: false,
    lastError: null,
    retryAfter: null,
    costUsd: 0,
    notified: {},
    verdicts: [],
    feedbackHandled: [],
    delegate: { runs: 0, lastQuestion: null, limitNotified: false, answers: [], question: null },
    noteHistory: [],
    stageLabels: [],
    stageLabelError: null,
    escalationRun: null,
    findings: null,
    preVerify: null,
    preVerifyCleanup: null,
    commands: null,
    verifyCriteria: null,
    fix: null,
    hold: null,
  }
}

// What the ledger knows of a PR, on top of a fresh one. Older entries lack the newer fields.
export function withDefaults(known) {
  const fresh = freshPr()

  return {
    ...fresh,
    ...known,
    attempts: { ...fresh.attempts, ...known.attempts },
    delegate: { ...fresh.delegate, ...known.delegate },
    notified: { ...fresh.notified, ...known.notified },
  }
}

// A fresh PR of version 2. Only the steps of the migration use it, so a
// version 1 entry reaches the 2→3 step with no stage.
export function versionTwoPr() {
  return {
    state: 'pending',
    attempts: { implement: 0, fix: 0, verify: 0, brief: 0 },
    sessionId: null,
    modelRaised: false,
    pr: null,
    claimedSha: null,
    claimedAt: null,
    ready: null,
    verified: null,
    verdict: null,
    approved: null,
    gate: null,
    pendingNote: null,
    briefAnswers: [],
    briefHeads: [],
    briefDrift: [],
    previewConflict: null,
    interruptedRole: null,
    lastError: null,
    retryAfter: null,
    costUsd: 0,
    notified: {},
    held: null,
    verdicts: [],
    feedbackHandled: [],
    delegate: { runs: 0, lastQuestion: null, limitNotified: false, answers: [] },
    noteHistory: [],
    stageLabels: [],
    stageLabelError: null,
    escalation: null,
    escalatedAt: null,
    escalationRun: null,
    findings: null,
    preVerify: null,
    preVerifyCleanup: null,
    commands: null,
    verifyCriteria: null,
    fix: null,
    hold: null,
  }
}

// A hold from before holds had an author is the maintainer's.
function heldWithDefaults(held) {
  if (!held) {
    return null
  }

  return { ...held, by: held.by ?? 'maintainer', reason: held.reason ?? null }
}

// A version 2 entry on top of a fresh one of version 2. Older ledgers lack the newer fields.
function versionTwoWithDefaults(known) {
  const fresh = versionTwoPr()

  return {
    ...fresh,
    ...known,
    attempts: { ...fresh.attempts, ...known.attempts },
    delegate: { ...fresh.delegate, ...known.delegate },
    notified: { ...fresh.notified, ...known.notified },
    held: heldWithDefaults(known.held),
  }
}

// A ledger without a version is version 1, the shape from before versions.
function versionOf(data) {
  if (data.version === undefined) {
    return 1
  }

  if (!Number.isInteger(data.version) || data.version < 1) {
    throw new Error(`ledger.json has an invalid version: ${JSON.stringify(data.version)}`)
  }

  if (data.version > LEDGER_VERSION) {
    throw new Error(
      `ledger.json is version ${data.version}, written by a newer driver than this one (version ${LEDGER_VERSION}). Update claude-rollout to open it.`,
    )
  }

  return data.version
}

function readStored(file) {
  if (!existsSync(file)) {
    return null
  }

  const data = JSON.parse(readFileSync(file, 'utf8'))
  versionOf(data)

  return data
}

// Each step is pure: it returns a new ledger and reads no file. `briefs`
// holds the ids of the PRs whose brief file exists.
export const MIGRATIONS = [
  {
    from: 1,
    to: 2,
    // No run of an earlier driver is alive when a driver opens the ledger.
    // Old notes get no stamps, so the view keeps guessing those. The 2→3
    // step makes the guesses for blocks and escalations.
    apply(data, { events }) {
      const copy = structuredClone(data)
      const prs = Object.entries(copy.prs ?? {}).map(([id, entry]) => [id, versionTwoWithDefaults(entry)])

      return { ...copy, version: 2, prs: Object.fromEntries(prs), runs: runRecords(events) }
    },
  },
  {
    from: 2,
    to: 3,
    apply(data, { events, briefs, at }) {
      const copy = structuredClone(data)
      const prs = Object.entries(copy.prs ?? {}).map(([id, entry]) => [
        id,
        fromVersionTwo(versionTwoWithDefaults(entry), { id, briefWritten: briefs.has(id), runs: copy.runs, events, at }),
      ])

      return { ...copy, version: 3, prs: Object.fromEntries(prs) }
    },
  },
]

function eventsOf(manifest) {
  const file = join(manifest.dir, 'events.jsonl')

  return existsSync(file) ? jsonLines(readFileSync(file, 'utf8')) : []
}

// The ids of the PRs whose brief file exists.
export function writtenBriefs(manifest) {
  return new Set(manifest.all.filter((pr) => existsSync(pr.brief)).map((pr) => pr.id))
}

// The ledger of this version. One that already is comes back as it is.
export function migrated(data, { events, briefs, at }) {
  const version = versionOf(data)
  let current = data

  for (const step of MIGRATIONS.filter((candidate) => candidate.from >= version)) {
    current = step.apply(current, { events, briefs, at })
  }

  return current
}

export function migrate(data, manifest) {
  if (versionOf(data) === LEDGER_VERSION) {
    return data
  }

  return migrated(data, { events: eventsOf(manifest), briefs: writtenBriefs(manifest), at: new Date().toISOString() })
}

// A run without an end belongs to a driver that is gone: only the driver
// opens the ledger, and only one driver runs per rollout.
function stopOrphans(data) {
  let changed = false

  for (const record of Object.values(data.runs ?? {})) {
    if (!record.endedAt && !record.stopped) {
      record.stopped = true
      changed = true
    }
  }

  return changed
}

// The rollout's brake was the boolean paused before it became a hold like a PR's.
function pausedToHold(data) {
  let changed = false

  if (Object.hasOwn(data, 'paused')) {
    if (data.paused === true && !data.hold) {
      data.hold = { at: new Date().toISOString(), by: 'maintainer', reason: null }
    }

    delete data.paused
    changed = true
  }

  if (data.hold === undefined) {
    data.hold = null
    changed = true
  }

  return changed
}

export function openLedger(manifest) {
  const file = join(manifest.dir, 'ledger.json')
  let data = readStored(file) ?? { version: LEDGER_VERSION, prs: {}, runs: {}, hold: null }
  let changed = false

  if (versionOf(data) < LEDGER_VERSION) {
    data = migrate(data, manifest)
    changed = true
  }

  // A red base is a rule of the merge gate, so a stored halt holds nothing.
  if (Object.hasOwn(data, 'halted')) {
    delete data.halted
    changed = true
  }

  changed = pausedToHold(data) || changed
  changed = stopOrphans(data) || changed

  const openedAt = new Date().toISOString()

  for (const pr of manifest.all) {
    data.prs[pr.id] = withDefaults(data.prs[pr.id] ?? freshPr(existsSync(pr.brief) ? 'implement' : 'brief', openedAt))
  }

  for (const dir of ['logs', 'inbox']) {
    mkdirSync(join(manifest.dir, dir), { recursive: true })
  }

  let lastNote = ''

  // Without a note, the last one stays, so a save keeps the line of the last tick.
  function beat(note = lastNote) {
    lastNote = note
    writeFileSync(join(manifest.dir, 'heartbeat'), `${new Date().toISOString()} ${note}`.trim())
  }

  function save() {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(tmp, file)
    beat()
  }

  function event(id, kind, detail = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), id, kind, ...detail })
    appendFileSync(join(manifest.dir, 'events.jsonl'), `${line}\n`)
  }

  if (changed) {
    save()
  }

  return { data, prs: data.prs, save, beat, event }
}

// The heartbeat note of a measured tick: its milliseconds, its GitHub
// requests, how many of them a 304 answered and the rate limit left.
export function tickNote({ ms, requests, cached, remaining }) {
  return `tick ${ms} requests=${requests} cached=${cached} remaining=${remaining ?? '-'}`
}

const TICK_NOTE = /^tick (\d+) requests=(\d+) cached=(\d+) remaining=(\d+|-)$/

// The numbers of a tickNote, or null for any other note.
export function parseTickNote(note) {
  const match = TICK_NOTE.exec(note ?? '')

  if (!match) {
    return null
  }

  const [, ms, requests, cached, remaining] = match

  return { ms: Number(ms), requests: Number(requests), cached: Number(cached), remaining: remaining === '-' ? null : Number(remaining) }
}

// Never migrates or writes: a ledger from before versions comes back as stored.
export function readLedger(manifest) {
  return readStored(join(manifest.dir, 'ledger.json'))
}

function blankRun(run, { id, role, step }) {
  return {
    id,
    role,
    step,
    reason: null,
    startedAt: null,
    endedAt: null,
    effort: null,
    model: null,
    requestedModel: null,
    resume: null,
    log: `logs/${run}.jsonl`,
    ok: null,
    result: null,
    costUsd: null,
    seconds: null,
    awakeSeconds: null,
    denials: null,
    stopped: false,
    error: null,
  }
}

// `model` is the one the start asks for. endRun records the one that ran.
export function startRun(
  data,
  { run, id, role, step = null, reason = null, effort = null, model = null, resume = false },
  at = new Date().toISOString(),
) {
  if (!run) {
    return
  }

  data.runs = data.runs ?? {}
  data.runs[run] = { ...blankRun(run, { id, role, step }), reason, startedAt: at, effort, requestedModel: model, resume }
}

// `detail` is the *-done event's own, from doneDetail, so the record and the
// event never disagree. A run with no record yet gets one without a start.
export function endRun(data, { id, role, step = null }, detail, at = new Date().toISOString()) {
  if (!detail.run) {
    return
  }

  data.runs = data.runs ?? {}

  const record = data.runs[detail.run] ?? blankRun(detail.run, { id, role, step })

  data.runs[detail.run] = {
    ...record,
    step: record.step ?? step,
    endedAt: at,
    ok: detail.ok === true,
    result: detail.result ?? null,
    error: detail.error ?? null,
    model: detail.model ?? null,
    costUsd: detail.cost ?? 0,
    seconds: detail.seconds ?? null,
    awakeSeconds: detail.awakeSeconds ?? null,
    denials: detail.denials ?? 0,
    stopped: detail.stopped === true,
  }
}

// The process of a run that has not ended, for the next start to end if the
// run outlives this driver. A run that ended needs none.
export function recordProcess(data, run, recorded) {
  const record = data.runs?.[run]

  if (record && !record.endedAt) {
    record.process = recorded
  }
}

// Commands from other processes (the /rollout skill, a terminal) go through
// an inbox of small files, so they never race the driver's ledger writes.
export function postCommand(manifest, command) {
  mkdirSync(join(manifest.dir, 'inbox'), { recursive: true })

  const name = `${Date.now()}-${randomUUID().slice(0, 8)}.json`
  const tmp = join(manifest.dir, 'inbox', `.${name}`)
  writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), ...command }))
  renameSync(tmp, join(manifest.dir, 'inbox', name))

  return name
}

// postCommand writes a dot-prefixed temp file first, so only renamed files count.
function commandFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

// Never throws. A file it cannot delete comes back as invalid, never as its
// command, because a file that stays would apply again on every tick.
export function drainInbox(manifest) {
  const dir = join(manifest.dir, 'inbox')
  let names

  try {
    names = commandFiles(dir)
  } catch {
    return []
  }

  const commands = []

  for (const name of names) {
    const path = join(dir, name)
    let command

    try {
      command = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      command = { cmd: 'invalid', file: name, error: String(error) }
    }

    try {
      rmSync(path)
    } catch (error) {
      command = { cmd: 'invalid', file: name, error: `cannot delete it: ${error.message}` }
    }

    commands.push(command)
  }

  return commands
}

// Lets the driver sleep until a command arrives instead of a whole tick.
// Never throws or rejects. Without a working watcher a wait still sees the
// commands already there when it starts.
export function watchInbox(manifest, { settleMs = 500 } = {}) {
  const dir = join(manifest.dir, 'inbox')
  const woken = new Set()
  const timers = new Set()
  let waiter = null
  let watcher = null

  function names() {
    try {
      return commandFiles(dir)
    } catch {
      return []
    }
  }

  function later(ms, callback) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      callback()
    }, ms)

    timers.add(timer)
  }

  function finish(outcome) {
    if (!waiter) {
      return
    }

    const { resolve } = waiter
    waiter = null

    for (const timer of timers) {
      clearTimeout(timer)
    }

    timers.clear()
    resolve(outcome)
  }

  // The settle delay batches a burst of commands into one tick. A name
  // wakes only one wait, so a file drainInbox cannot remove does not spin
  // the loop: the next wait falls back to the tick.
  function look() {
    if (!waiter || waiter.settling) {
      return
    }

    const fresh = names().filter((name) => !woken.has(name))

    if (fresh.length === 0) {
      return
    }

    waiter.settling = true
    later(settleMs, () => {
      for (const name of [...fresh, ...names()]) {
        woken.add(name)
      }

      finish('command')
    })
  }

  function unwatch() {
    try {
      watcher?.close()
    } catch {
      // Already closed.
    }

    watcher = null
  }

  try {
    mkdirSync(dir, { recursive: true })
    watcher = watch(dir, { persistent: false }, () => {
      try {
        look()
      } catch {
        // Swallowed: a throw in a watcher callback would kill the driver.
      }
    })

    watcher.on('error', unwatch)
  } catch {
    unwatch()
  }

  function wait(ms) {
    finish('timeout')

    return new Promise((resolve) => {
      waiter = { resolve, settling: false }
      later(ms, () => finish('timeout'))
      look()
    })
  }

  function close() {
    unwatch()
    finish('timeout')
  }

  return { wait, close }
}

// Reserves a log file for one agent run. Its name is the run id, so it
// must never repeat, even after attempts are refunded or reset.
export function reserveRunName(manifest, base) {
  const dir = join(manifest.dir, 'logs')
  mkdirSync(dir, { recursive: true })

  for (let index = 1; ; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`

    try {
      closeSync(openSync(join(dir, `${name}.jsonl`), 'wx'))

      return name
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error
      }
    }
  }
}

export function recordVerdict(entry, verdict) {
  entry.verdict = verdict
  entry.verdicts = [...(entry.verdicts ?? []), verdict].slice(-10)
}

// The fix note, the implementer's answers and the next verifier name a
// finding by its id. Every FAIL numbers its own findings from F1.
// `fromReview` lines up with `blocking`: the key of the external review's
// finding a confirmed candidate came from, anything else for every other one.
export function recordFindings(entry, blocking, at, fromReview = []) {
  entry.findings = {
    at,
    items: blocking.map((text, index) => {
      const item = { id: `F${index + 1}`, text, answer: null }

      return typeof fromReview[index] === 'string' ? { ...item, fromReview: fromReview[index] } : item
    }),
  }
}

// Every READY report until the next verdict may answer, so one that answers
// nothing keeps the earlier answers. A finding not disputed counts as fixed.
export function recordAnswers(entry, addressed) {
  if (!entry.findings) {
    return
  }

  for (const item of addressed) {
    const finding = entry.findings.items.find((candidate) => candidate.id === item.id)

    if (finding) {
      finding.answer = { outcome: item.outcome === 'disputed' ? 'disputed' : 'fixed', action: item.action }
    }
  }
}

// The verifier names a finding by its id only. The verdict keeps its text
// and the answer it was checked against, because the next FAIL renumbers.
export function recheckedFindings(entry, recheck) {
  const items = entry.findings?.items ?? []

  return recheck.map(({ id, status, evidence }) => {
    const finding = items.find((item) => item.id === id)

    return { id, status, evidence, finding: finding?.text ?? null, answer: finding?.answer ?? null }
  })
}

// One driver per rollout directory. A second one would resume the same
// agent sessions in the same worktrees and overwrite the ledger.
export function acquireLock(manifest) {
  const file = join(manifest.dir, 'driver.lock')

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx')
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      closeSync(fd)

      return () => rmSync(file, { force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error
      }

      const holder = lockHolder(manifest)

      if (holder) {
        throw new Error(`a driver is already running for this rollout (pid ${holder.pid}); stop it first`, { cause: error })
      }

      rmSync(file, { force: true })
    }
  }

  throw new Error('could not take the driver lock')
}

export function lockHolder(manifest) {
  const file = join(manifest.dir, 'driver.lock')

  if (!existsSync(file)) {
    return null
  }

  try {
    const lock = JSON.parse(readFileSync(file, 'utf8'))

    // process.kill succeeds for 0, -1, "0" and "-1", which name no driver.
    if (!Number.isInteger(lock?.pid) || lock.pid <= 1) {
      return null
    }

    process.kill(lock.pid, 0)

    return lock
  } catch {
    return null
  }
}
