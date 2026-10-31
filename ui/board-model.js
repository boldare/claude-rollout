import { duration, money } from './format.js'
import { isWaiting } from './model.js'
import { resultPreview } from './transcript-model.js'

// The open part of a board row: the run in progress, or else the PR's last
// run, with the last few things its agent did. The log has no times, so a line
// says what was done and how it ended, not when.
export const PANEL_ITEMS = 40
export const COMMAND_LINES = 5

const SHORT_RESULT = 24
const MESSAGE_LENGTH = 300
const PASSING = ['PASS', 'READY', 'BRIEF', 'ok']
const FAILING = ['FAIL', 'BLOCKED', 'failed']

const DELEGATE_TEXTS = {
  running: () => 'running',
  escalate: ({ reason }) => (reason ? `escalated, ${reason}` : 'escalated'),
  failed: ({ reason }) => (reason ? `failed, ${reason}` : 'failed'),
  answer: () => 'answered',
  dropped: () => 'its answer came after a note',
  skips: (_, kind) => `does not take ${kind}`,
  spent: ({ reason }) => `no runs left, ${reason} used`,
  next: () => 'answers first, on the next tick',
}

export function panelRun(row, runs) {
  const own = (runs ?? []).filter((run) => run.id === row.id && run.run)

  return own.findLast((run) => run.status === 'running') ?? own.at(-1) ?? null
}

function lineCount(lines) {
  return lines === 1 ? '1 line' : `${lines} lines`
}

// A waiting row opens by itself, any other row when the maintainer opens it,
// and their choice sticks either way. A row with nothing to show stays shut.
export function rowOpen(row, run, choices) {
  if (!run && !isWaiting(row)) {
    return false
  }

  return choices.get(row.id) ?? isWaiting(row)
}

export function delegateText(delegate, kind) {
  const text = DELEGATE_TEXTS[delegate.state]

  return text ? text(delegate, kind) : delegate.state
}

function answerer(row) {
  return row.blocked?.kind === 'brief-questions' ? 'brief writer' : 'implementer'
}

export function answerPlaceholder(row) {
  if (answerer(row) === 'brief writer') {
    return 'Answer the questions for the brief writer. It goes to the agent as a note.'
  }

  return 'Write what the implementer should do. It goes to the agent as a note.'
}

// The driver applies a note on its next tick, so a stopped driver applies it when it starts.
export function answerHint(row, driverRunning) {
  const when = driverRunning ? "on the driver's next tick" : 'once the driver runs'

  return `The ${answerer(row)} resumes with it ${when}.`
}

// A one-line answer, like ok, reads better than its line count.
function outcomeOf(result, running) {
  if (!result) {
    return { tag: null, text: running ? 'running…' : 'no result' }
  }

  const { line, lines } = resultPreview(result.text)

  if (result.refused) {
    return { tag: 'refused', text: lineCount(lines) }
  }

  if (result.isError) {
    return { tag: 'error', text: lineCount(lines) }
  }

  if (lines === 0) {
    return { tag: null, text: 'empty' }
  }

  return { tag: null, text: lines === 1 && line.length <= SHORT_RESULT ? line : lineCount(lines) }
}

function messageOf(text) {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > MESSAGE_LENGTH ? `${flat.slice(0, MESSAGE_LENGTH - 1)}…` : flat
}

// Tool calls with how they ended, and the agent's own text, newest last.
export function commandLines(items, { running = false, count = COMMAND_LINES } = {}) {
  const results = new Map(items.filter((item) => item.kind === 'tool-result').map((item) => [item.toolUseId, item]))
  const lines = []

  for (const item of items) {
    if (item.kind === 'tool') {
      lines.push({
        kind: 'tool',
        name: item.name,
        target: item.summary || item.command || '',
        outcome: outcomeOf(results.get(item.id), running),
      })
    } else if (item.kind === 'text' && item.text?.trim()) {
      lines.push({ kind: 'text', text: messageOf(item.text) })
    }
  }

  return lines.slice(-count)
}

function costOf(run) {
  if (typeof run.estimateUsd === 'number') {
    return `≈${money(run.estimateUsd)} est.`
  }

  return money(run.costUsd)
}

// How long a finished run took, what it cost and how often the guard said no.
export function tookText(run) {
  const parts = [duration(run.seconds), costOf(run)]

  if (typeof run.denials === 'number') {
    parts.push(run.denials === 1 ? '1 denial' : `${run.denials} denials`)
  }

  return parts.join(' · ')
}

// The tone of a run's result, as the verdict badges have it.
export function resultTone(result) {
  if (PASSING.includes(result)) {
    return 'pass'
  }

  if (FAILING.includes(result)) {
    return 'fail'
  }

  return result === 'interrupted' ? 'warn' : 'none'
}
