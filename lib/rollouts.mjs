import { existsSync, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { readLedger } from './ledger.mjs'
import { loadManifest } from './manifest.mjs'
import { estimateCost } from './prices.mjs'
import { expandHome } from './sh.mjs'
import { costs, isRunName, liveness, parseTranscript, prDetail, readEvents, rolloutView, runsFromEvents } from './view.mjs'

// The read side of a root that holds many rollout directories, for the UI
// server. Like lib/view.mjs it only reads files.
const ROLLOUT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const WATCHED_FILES = ['manifest.yaml', 'ledger.json', 'events.jsonl', 'heartbeat', 'driver.lock']
const TEXT_LIMIT = 10_000
const SUMMARY_LIMIT = 200
const SUMMARY_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']
const ESTIMATED_STATUSES = ['interrupted', 'failed']
// Keyed by log path. A snapshot then costs one stat per qualifying run, and
// a log that changed is parsed again.
const estimates = new Map()

// Names come from URLs, so they must stay one directory below the root.
function validName(name) {
  return typeof name === 'string' && ROLLOUT_NAME.test(name) && !name.includes('..')
}

// An empty ROLLOUT_ROOT counts as unset.
export function rolloutRoot(flag, env = process.env) {
  return resolve(expandHome(flag ?? (env.ROLLOUT_ROOT || '~/.rollouts')))
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

function summary(manifest, name, started) {
  const ledger = readLedger(manifest)
  const driver = { ...liveness(manifest), paused: Boolean(ledger?.paused), halted: ledger?.halted ?? null }

  return {
    name,
    rollout: manifest.rollout,
    started,
    driver,
    merged: manifest.all.filter((pr) => ledger?.prs?.[pr.id]?.state === 'merged').length,
    total: manifest.all.length,
    costUsd: ledger ? costs(manifest, ledger, []).totalUsd : 0,
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

export function rolloutSnapshot(manifest, name, now = Date.now()) {
  const at = new Date(now).toISOString()
  const view = rolloutView(manifest, now)

  if (!view) {
    return { state: { name, at, view: null }, events: readEvents(manifest) }
  }

  const { events, ...rest } = view
  const runs = withEstimates(manifest, rest.runs)
  const estimated = runs.map((run) => run.estimateUsd).filter((usd) => usd !== null)
  const estimatedUsd = Number(estimated.reduce((sum, usd) => sum + usd, 0).toFixed(4))
  const viewCosts = { ...rest.costs, estimatedUsd, estimatedRuns: estimated.length }

  return { state: { name, at, view: { ...rest, runs, costs: viewCosts, eventCount: events.length } }, events }
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

export function rolloutPr(manifest, id) {
  const events = readEvents(manifest)
  const runs = runsFromEvents(events, { driverRunning: liveness(manifest).running })
  const detail = prDetail(manifest, readLedger(manifest) ?? { prs: {} }, events, runs, id)

  if (!detail) {
    return null
  }

  return {
    ...detail,
    runs: withEstimates(manifest, detail.runs),
    briefText: readText(detail.brief.path),
    notesText: readText(detail.brief.notesPath),
  }
}

function logFile(manifest, run) {
  return join(manifest.dir, 'logs', `${run}.jsonl`)
}

function cutText(value) {
  if (typeof value !== 'string' || value.length <= TEXT_LIMIT) {
    return { text: value, cut: 0 }
  }

  return { text: value.slice(0, TEXT_LIMIT), cut: value.length - TEXT_LIMIT }
}

function toolSummary(input) {
  const value = SUMMARY_FIELDS.map((key) => input?.[key]).find((field) => typeof field === 'string')

  return value ? value.slice(0, SUMMARY_LIMIT) : ''
}

function toolItem(item, index) {
  const command = cutText(item.command)
  const input = cutText(JSON.stringify(item.input ?? {}, null, 2))

  return {
    index,
    kind: item.kind,
    id: item.id,
    name: item.name,
    command: command.text,
    summary: toolSummary(item.input),
    inputText: input.text,
    cut: command.cut + input.cut,
  }
}

function resultItem(item, index, toolNames) {
  const { text, cut } = cutText(item.text ?? '')

  return {
    index,
    kind: item.kind,
    toolUseId: item.toolUseId,
    name: toolNames.get(item.toolUseId) ?? null,
    text,
    isError: item.isError,
    refused: item.refused,
    cut,
  }
}

function pageItem(item, index, toolNames) {
  if (item.kind === 'init') {
    return { index, kind: item.kind, model: item.model, sessionId: item.sessionId }
  }

  if (item.kind === 'tool') {
    return toolItem(item, index)
  }

  if (item.kind === 'tool-result') {
    return resultItem(item, index, toolNames)
  }

  const { text, cut } = cutText(item.text ?? '')

  return { index, kind: item.kind, text, cut }
}

function toolNamesOf(items) {
  return new Map(items.filter((item) => item.kind === 'tool').map((item) => [item.id, item.name]))
}

export function transcriptPage(manifest, run, { from = 0, limit = 200 } = {}) {
  if (!isRunName(run)) {
    return null
  }

  let log

  try {
    log = readFileSync(logFile(manifest, run))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }

  const { items, final, model, usage } = parseTranscript(log.toString('utf8'))
  const start = from === 'end' ? Math.max(0, items.length - limit) : from
  const toolNames = toolNamesOf(items)
  const page = items.slice(start, start + limit).map((item, offset) => pageItem(item, start + offset, toolNames))

  return {
    run,
    bytes: log.length,
    total: items.length,
    from: start,
    items: page,
    final,
    model,
    usage,
    estimateUsd: final ? null : estimateCost(usage),
  }
}

function qualifies(run) {
  return ESTIMATED_STATUSES.includes(run.status) && isRunName(run.run) && (run.costUsd === 0 || run.costUsd === null)
}

function estimateOf(manifest, run) {
  if (!qualifies(run)) {
    return null
  }

  const file = logFile(manifest, run.run)
  const stat = statSync(file, { throwIfNoEntry: false })

  if (!stat) {
    return null
  }

  const signature = `${stat.mtimeMs}:${stat.size}`
  const cached = estimates.get(file)

  if (cached?.signature === signature) {
    return cached.estimateUsd
  }

  const { final, usage } = parseTranscript(readFileSync(file, 'utf8'))
  const estimateUsd = final ? null : estimateCost(usage)

  estimates.set(file, { signature, estimateUsd })

  return estimateUsd
}

// Runs killed by a stop, the stall watchdog or the timeout report no cost.
// The estimate is shown beside the reported costs and never added to them.
export function withEstimates(manifest, runs) {
  return runs.map((run) => ({ ...run, estimateUsd: estimateOf(manifest, run) }))
}

// Liveness is part of it because a driver killed hard leaves its lock
// behind and changes no file.
export function changeSignature(manifest) {
  const files = WATCHED_FILES.map((file) => {
    const stat = statSync(join(manifest.dir, file), { throwIfNoEntry: false })

    return stat ? `${stat.mtimeMs}:${stat.size}` : '-'
  })

  const { running, pid } = liveness(manifest)

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
