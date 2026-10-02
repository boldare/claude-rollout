import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { approvalChannel } from './judge.mjs'
import { freshPr, lockHolder, readLedger } from './ledger.mjs'

// A read-only model of one rollout directory, shared by the CLI and the UI
// so they never disagree. It only reads files: no GitHub, git, child
// processes or console output.
const RUN_EVENT = /^(brief|implement|fix|verify|delegate)-(start|done)$/
export const ROLES = ['brief', 'implement', 'fix', 'verify', 'delegate']
const RUN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

function round(value) {
  return Number(value.toFixed(4))
}

// Objects from a JSON-lines file. A partial last line (the driver or an
// agent is still appending) and anything that is not an object are skipped.
function jsonLines(text) {
  const objects = []

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }

    try {
      const value = JSON.parse(line)

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        objects.push(value)
      }
    } catch {
      // Not JSON, or not complete yet.
    }
  }

  return objects
}

export function liveness(M, now = Date.now()) {
  const holder = lockHolder(M)
  const beat = join(M.dir, 'heartbeat')
  let heartbeatAgeSeconds = null
  let heartbeatNote = ''

  if (existsSync(beat)) {
    heartbeatAgeSeconds = Math.round((now - statSync(beat).mtimeMs) / 1000)
    heartbeatNote = readFileSync(beat, 'utf8').split(' ').slice(1).join(' ')
  }

  return { running: Boolean(holder), pid: holder?.pid ?? null, heartbeatAgeSeconds, heartbeatNote }
}

export function parseEvents(text) {
  return jsonLines(text)
}

export function readEvents(M) {
  const file = join(M.dir, 'events.jsonl')

  return existsSync(file) ? parseEvents(readFileSync(file, 'utf8')) : []
}

function newRun(event, role, run) {
  return {
    run,
    id: event.id,
    role,
    step: event.step ?? null,
    effort: event.effort ?? null,
    startedAt: event.at ?? null,
    endedAt: null,
    seconds: null,
    costUsd: null,
    ok: null,
    result: null,
    error: null,
    denials: null,
    status: null,
  }
}

function doneStatus(event) {
  if (event.ok) {
    return 'ok'
  }

  return event.stopped ? 'interrupted' : 'failed'
}

function closeRun(run, event) {
  run.step = run.step ?? event.step ?? null
  run.endedAt = event.at ?? null
  run.seconds = event.seconds ?? null
  run.costUsd = event.cost ?? 0
  run.ok = event.ok === true
  run.result = event.result ?? null
  run.error = event.error ?? null
  run.denials = event.denials ?? 0
  run.status = doneStatus(event)
}

// Pairs *-start and *-done events into runs. Events written before runs had
// ids carry only the log name on the start and nothing on the done, so those
// pair by PR and role instead.
export function runsFromEvents(events, { driverRunning = false } = {}) {
  const runs = []
  const open = []
  const restarted = new Set()

  for (const event of events) {
    if (event.kind === 'driver-start') {
      for (const run of open) {
        restarted.add(run)
      }

      continue
    }

    const match = RUN_EVENT.exec(event.kind)

    if (!match) {
      continue
    }

    const [, role, edge] = match

    if (edge === 'start') {
      const run = newRun(event, role, event.run ?? (event.log ? basename(event.log, '.jsonl') : null))
      runs.push(run)
      open.push(run)
      continue
    }

    const index = open.findLastIndex((run) => run.id === event.id && (event.run ? run.run === event.run : run.role === role))
    let run

    if (index === -1) {
      run = { ...newRun(event, role, event.run ?? null), effort: null, startedAt: null }
      runs.push(run)
    } else {
      run = open.splice(index, 1)[0]
    }

    closeRun(run, event)
  }

  for (const run of open) {
    run.status = restarted.has(run) || !driverRunning ? 'interrupted' : 'running'
  }

  return runs
}

export function costs(M, ledger, runs) {
  const byPr = {}

  for (const pr of M.all) {
    byPr[pr.id] = ledger.prs?.[pr.id]?.costUsd ?? 0
  }

  const byRole = Object.fromEntries(ROLES.map((role) => [role, 0]))

  for (const run of runs) {
    byRole[run.role] = round(byRole[run.role] + (run.costUsd ?? 0))
  }

  const ended = runs.filter((run) => run.endedAt).sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))
  const overTime = []
  let total = 0

  for (const run of ended) {
    total += run.costUsd ?? 0
    overTime.push({ at: run.endedAt, totalUsd: round(total) })
  }

  return { totalUsd: round(Object.values(byPr).reduce((sum, cost) => sum + cost, 0)), byPr, byRole, overTime }
}

// A PR's ledger state with the defaults of a fresh one, like openLedger().
function prState(ledger, id) {
  const known = ledger.prs?.[id] ?? {}

  return { ...freshPr(), ...known, attempts: { ...freshPr().attempts, ...known.attempts } }
}

function headOf(s) {
  return (s.verified?.sha ?? s.claimedSha ?? '').slice(0, 7) || '-'
}

function infoOf(s) {
  let info = s.gate ? `${s.gate.action}: ${s.gate.reasons.join('; ')}` : ''

  if (s.state === 'merged') {
    info = s.mergeSha ? `merged as ${s.mergeSha.slice(0, 7)}` : 'merged'
  } else if (s.state === 'blocked') {
    info = `${s.blocked?.kind}: ${s.blocked?.question ?? ''}`
  } else if (s.state === 'needs_fix' || s.state === 'fixing') {
    info = s.fixReason ?? ''
  } else if (s.state === 'escalated' || s.state === 'interrupted') {
    info = s.lastError ?? ''
  }

  if (s.approved && s.verified && s.approved.patchId === s.verified.patchId) {
    info = `approved; ${info}`
  }

  if (s.held) {
    info = `held; ${info}`
  }

  return info
}

function lastEventTimes(events) {
  const times = new Map()

  for (const event of events) {
    times.set(event.id, event.at)
  }

  return times
}

function rowFor(M, ledger, pr, lastEventAt, runs) {
  const s = prState(ledger, pr.id)
  const active = runs.findLast((run) => run.id === pr.id && run.status === 'running')

  return {
    id: pr.id,
    title: pr.title,
    branch: pr.branch,
    state: s.state,
    held: s.held ?? null,
    pr: s.pr ?? null,
    url: s.pr ? `https://github.com/${M.repo.github}/pull/${s.pr}` : null,
    head: headOf(s),
    info: infoOf(s),
    deps: pr.deps.map((dep) => ({ id: dep, state: prState(ledger, dep).state })),
    attempts: s.attempts,
    costUsd: s.costUsd,
    lastEventAt: lastEventAt ?? null,
    activeRun: active?.run ?? null,
    gate: s.gate ?? null,
  }
}

export function prRows(M, ledger, events, runs) {
  const times = lastEventTimes(events)

  return M.all.map((pr) => rowFor(M, ledger, pr, times.get(pr.id), runs))
}

// Ledgers from before the verdict history hold only the latest verdict.
function verdictsOf(s) {
  if (s.verdicts?.length > 0) {
    return s.verdicts
  }

  return s.verdict ? [s.verdict] : []
}

export function prDetail(M, ledger, events, runs, id) {
  const pr = M.all.find((item) => item.id === id)

  if (!pr) {
    return null
  }

  const s = prState(ledger, id)
  const notesPath = pr.brief.replace(/\.md$/, '.review-notes.md')

  return {
    ...rowFor(M, ledger, pr, lastEventTimes(events).get(id), runs),
    author: s.author ?? null,
    approval: approvalChannel(M, s.author),
    merge: M.policy.merge,
    maintainers: M.repo.maintainers,
    verified: s.verified ?? null,
    approved: s.approved ?? null,
    blocked: s.blocked ?? null,
    ready: s.ready ?? null,
    brief: { path: pr.brief, exists: existsSync(pr.brief), notesPath, notesExist: existsSync(notesPath) },
    workflowFiles: s.workflowFiles ?? [],
    outOfScope: s.outOfScope ?? [],
    verdict: s.verdict ?? null,
    verdicts: verdictsOf(s),
    feedback: s.feedbackHandled ?? [],
    delegate: { maxPerPr: M.policy.delegate?.maxPerPr ?? null, runs: s.delegate.runs, answers: s.delegate.answers },
    runs: runs.filter((run) => run.id === id),
  }
}

function resultText(content) {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content.map((block) => (block?.type === 'text' ? block.text : `[${block?.type}]`)).join('\n')
}

function assistantItems(content) {
  const items = []

  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === 'text') {
      items.push({ kind: 'text', text: part.text })
    } else if (part?.type === 'tool_use') {
      const command = part.name === 'Bash' ? (part.input?.command ?? null) : null
      items.push({ kind: 'tool', id: part.id, name: part.name, input: part.input, command })
    }
  }

  return items
}

function toolResultItems(content) {
  return content
    .filter((part) => part?.type === 'tool_result')
    .map((part) => {
      const text = resultText(part.content)

      return {
        kind: 'tool-result',
        toolUseId: part.tool_use_id,
        text,
        isError: Boolean(part.is_error),
        refused: /rollout guard:/.test(text),
      }
    })
}

// Matches how runAgent reads the same line.
function finalOf(line) {
  return {
    ok: !line.is_error && Boolean(line.structured_output),
    subtype: line.subtype ?? null,
    costUsd: line.total_cost_usd ?? 0,
    seconds: Math.round((line.duration_ms ?? 0) / 1000),
    turns: line.num_turns ?? null,
    denials: line.permission_denials?.length ?? 0,
    report: line.structured_output ?? null,
    text: line.result ?? '',
  }
}

function tokenCount(value) {
  return Number.isFinite(value) ? value : 0
}

// Newer claude versions split cache writes by lifetime. Older ones only give
// the total, which is billed as 5-minute writes.
function lineTokens(usage) {
  const creation = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null

  return {
    input: tokenCount(usage.input_tokens),
    cacheRead: tokenCount(usage.cache_read_input_tokens),
    cacheWrite5m: tokenCount(creation ? creation.ephemeral_5m_input_tokens : usage.cache_creation_input_tokens),
    cacheWrite1h: tokenCount(creation?.ephemeral_1h_input_tokens),
    output: tokenCount(usage.output_tokens),
  }
}

function contentChars(content) {
  let chars = 0

  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      chars += part.text.length
    } else if (part?.type === 'tool_use') {
      chars += (JSON.stringify(part.input) ?? '').length
    }
  }

  return chars
}

function emptyTokens() {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 }
}

function maxTokens(first, second) {
  return Object.fromEntries(Object.keys(first).map((key) => [key, Math.max(first[key], second[key])]))
}

// claude writes one line per content block, and every line of a message
// repeats the usage of the whole message, so lines are grouped by message id.
function assistantMessages(lines) {
  const messages = new Map()

  for (const [index, line] of lines.entries()) {
    const message = line.type === 'assistant' ? line.message : null

    if (!message?.usage || typeof message.usage !== 'object') {
      continue
    }

    const key = message.id ?? Symbol(index)
    const known = messages.get(key) ?? { model: null, tokens: emptyTokens(), chars: 0 }

    known.model = known.model ?? message.model ?? null
    known.tokens = maxTokens(known.tokens, lineTokens(message.usage))
    known.chars += contentChars(message.content)
    messages.set(key, known)
  }

  return [...messages.values()].filter((message) => Object.values(message.tokens).some((count) => count > 0))
}

function thinkingTokens(lines) {
  return lines
    .filter((line) => line.type === 'system' && line.subtype === 'thinking_tokens')
    .reduce((sum, line) => sum + tokenCount(line.estimated_tokens_delta), 0)
}

// Per-line output_tokens misses thinking and tool input, so the output is
// also estimated from the characters written plus the thinking reported.
function usageOf(lines, initModel) {
  const totals = {}

  for (const message of assistantMessages(lines)) {
    const model = message.model ?? initModel ?? 'unknown'
    const total = totals[model] ?? { ...emptyTokens(), chars: 0, thinking: 0 }

    for (const key of Object.keys(message.tokens)) {
      total[key] += message.tokens[key]
    }

    total.chars += message.chars
    totals[model] = total
  }

  const mainModel = initModel ?? Object.keys(totals)[0] ?? null
  const thinking = thinkingTokens(lines)

  if (mainModel !== null && thinking > 0) {
    totals[mainModel] = totals[mainModel] ?? { ...emptyTokens(), chars: 0, thinking: 0 }
    totals[mainModel].thinking = thinking
  }

  const usage = {}

  for (const [model, { chars, thinking: modelThinking, ...tokens }] of Object.entries(totals)) {
    usage[model] = { ...tokens, output: Math.max(tokens.output, Math.ceil(chars / 4) + modelThinking) }
  }

  return usage
}

// One stream-json agent log. Logs written before run ids can hold two runs
// appended to each other, so the last result line wins.
export function parseTranscript(text) {
  const lines = jsonLines(text)
  const items = []
  let final = null

  for (const line of lines) {
    if (line.type === 'system' && line.subtype === 'init') {
      items.push({ kind: 'init', model: line.model ?? null, sessionId: line.session_id ?? null })
    } else if (line.type === 'assistant') {
      items.push(...assistantItems(line.message?.content))
    } else if (line.type === 'user' && Array.isArray(line.message?.content)) {
      items.push(...toolResultItems(line.message.content))
    } else if (line.type === 'result') {
      final = finalOf(line)
    }
  }

  const model = lines.find((line) => line.type === 'system' && line.subtype === 'init')?.model ?? null

  return { items, final, model, usage: usageOf(lines, model) }
}

// The name may come from an HTTP request, so it must stay inside logs/.
export function isRunName(name) {
  return typeof name === 'string' && RUN_NAME.test(name) && !name.includes('..')
}

export function readTranscript(M, run) {
  if (!isRunName(run)) {
    throw new Error('invalid run name')
  }

  const file = join(M.dir, 'logs', `${run}.jsonl`)

  return existsSync(file) ? parseTranscript(readFileSync(file, 'utf8')) : null
}

export function rolloutView(M, now = Date.now()) {
  const ledger = readLedger(M)

  if (!ledger) {
    return null
  }

  const events = readEvents(M)
  const driver = liveness(M, now)
  const runs = runsFromEvents(events, { driverRunning: driver.running })

  return {
    rollout: M.rollout,
    merge: M.policy.merge,
    driver: { ...driver, paused: Boolean(ledger.paused), halted: ledger.halted ?? null },
    rows: prRows(M, ledger, events, runs),
    runs,
    costs: costs(M, ledger, runs),
    events,
  }
}
