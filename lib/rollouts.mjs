import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { readLedger } from './ledger.mjs'
import { loadManifest } from './manifest.mjs'
import { costs, liveness, prDetail, readEvents, rolloutView, runsFromEvents } from './view.mjs'

// The read side of a root that holds many rollout directories, for the UI
// server. Like lib/view.mjs it only reads files.
const ROLLOUT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const WATCHED_FILES = ['manifest.yaml', 'ledger.json', 'events.jsonl', 'heartbeat', 'driver.lock']

// Names come from URLs, so they must stay one directory below the root.
function validName(name) {
  return typeof name === 'string' && ROLLOUT_NAME.test(name) && !name.includes('..')
}

function hasManifest(root, name) {
  return existsSync(join(root, name, 'manifest.yaml'))
}

function entriesOf(root) {
  try {
    return readdirSync(root)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

function summary(M, name, started) {
  const ledger = readLedger(M)
  const driver = { ...liveness(M), paused: Boolean(ledger?.paused), halted: ledger?.halted ?? null }

  return {
    name,
    rollout: M.rollout,
    started,
    driver,
    merged: M.all.filter((pr) => ledger?.prs?.[pr.id]?.state === 'merged').length,
    total: M.all.length,
    costUsd: ledger ? costs(M, ledger, []).totalUsd : 0,
    error: null,
  }
}

function listed(root, name) {
  const started = existsSync(join(root, name, 'ledger.json'))

  try {
    return summary(loadManifest(join(root, name)), name, started)
  } catch (error) {
    return { name, rollout: null, started, driver: null, merged: 0, total: 0, costUsd: 0, error: error.message }
  }
}

export function listRollouts(root) {
  return entriesOf(root)
    .filter((name) => validName(name) && hasManifest(root, name))
    .sort()
    .map((name) => listed(root, name))
}

export function findRollout(root, name) {
  if (!validName(name) || !hasManifest(root, name)) {
    return null
  }

  return loadManifest(join(root, name))
}

export function rolloutSnapshot(M, name, now = Date.now()) {
  const at = new Date(now).toISOString()
  const view = rolloutView(M, now)

  if (!view) {
    return { state: { name, at, view: null }, events: readEvents(M) }
  }

  const { events, ...rest } = view

  return { state: { name, at, view: { ...rest, eventCount: events.length } }, events }
}

// A client that holds more events than the file has saw a file that was
// replaced, so it starts over.
export function eventsSince(events, from) {
  if (from > events.length) {
    return { from: 0, events }
  }

  return { from, events: events.slice(from) }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export function rolloutPr(M, id) {
  const events = readEvents(M)
  const runs = runsFromEvents(events, { driverRunning: liveness(M).running })
  const detail = prDetail(M, readLedger(M) ?? { prs: {} }, events, runs, id)

  if (!detail) {
    return null
  }

  return { ...detail, briefText: readText(detail.brief.path), notesText: readText(detail.brief.notesPath) }
}

// Liveness is part of it because a driver killed hard leaves its lock
// behind and changes no file.
export function changeSignature(M) {
  const files = WATCHED_FILES.map((file) => {
    const stat = statSync(join(M.dir, file), { throwIfNoEntry: false })

    return stat ? `${stat.mtimeMs}:${stat.size}` : '-'
  })

  const { running, pid } = liveness(M)

  return [...files, running, pid].join('|')
}

// The driver renames ledger.json over the old one, which a watcher on the
// file itself stops following, so this watches the directory. The poll
// catches what no watcher sees: a dead driver pid, or a watcher that failed.
// Never throws.
export function watchRollout(dir, onChange, { debounceMs = 250, pollMs = 5000 } = {}) {
  let watcher = null
  let debounce = null
  let closed = false

  function fire() {
    if (closed) {
      return
    }

    try {
      onChange()
    } catch {
      // Swallowed: a throw in a timer or watcher callback would kill the server.
    }
  }

  function schedule() {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      fire()
    }, debounceMs)
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
    watcher = watch(dir, { persistent: false }, schedule)
    watcher.on('error', unwatch)
  } catch {
    unwatch()
  }

  const poll = setInterval(fire, pollMs)
  poll.unref()

  function close() {
    closed = true
    unwatch()
    clearTimeout(debounce)
    clearInterval(poll)
  }

  return { close }
}
