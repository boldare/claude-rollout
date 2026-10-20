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

// Local state of one rollout. GitHub stays the source of truth for PRs,
// heads, checks and merges; the ledger remembers what GitHub cannot:
// agent sessions, reports, verdicts, approvals, attempts and cost.
export function freshPr() {
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
    findings: null,
    preVerify: null,
    preVerifyCleanup: null,
  }
}

export function openLedger(manifest) {
  const file = join(manifest.dir, 'ledger.json')
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { prs: {}, paused: false, halted: null }

  for (const pr of manifest.all) {
    const known = data.prs[pr.id] ?? {}
    data.prs[pr.id] = { ...freshPr(), ...known, attempts: { ...freshPr().attempts, ...known.attempts } }
  }

  for (const dir of ['logs', 'inbox']) {
    mkdirSync(join(manifest.dir, dir), { recursive: true })
  }

  function beat(note = '') {
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

  return { data, prs: data.prs, save, beat, event }
}

export function readLedger(manifest) {
  const file = join(manifest.dir, 'ledger.json')

  if (!existsSync(file)) {
    return null
  }

  return JSON.parse(readFileSync(file, 'utf8'))
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
export function recordFindings(entry, blocking, at) {
  entry.findings = { at, items: blocking.map((text, index) => ({ id: `F${index + 1}`, text, answer: null })) }
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
