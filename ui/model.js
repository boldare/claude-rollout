// STAGES mirrors lib/state.ts, BLOCK_CODES lib/transitions.ts and ERROR_KINDS
// lib/kinds.mjs, which the browser cannot import. test/kinds.test.mjs keeps them equal.
export const STAGES = ['brief', 'implement', 'pre-verify', 'verify', 'merge', 'merged']

export const BLOCK_CODES = ['brief-questions', 'decision', 'obstacle', 'closed', 'code-scanning-alerts', 'gate-blocked']

export const ERROR_KINDS = [
  'tick-error',
  'error',
  'on-done-error',
  'reply-failed',
  'manifest-rejected',
  'fetch-failed',
  'outside-deps-failed',
  'watch-base-failed',
  'github-unavailable',
  'report-unchecked',
]

const RESUMED = { brief: ', writer resumed', implement: ', implementer resumed', fix: ', implementer resumed' }
const DETAIL_LIMIT = 200
const HIDDEN_FIELDS = new Set(['at', 'id', 'kind'])

export function mergeEvents(current, { from, events }) {
  return [...current.slice(0, from), ...events]
}

function isError(event) {
  return ERROR_KINDS.includes(event.kind)
}

export function errorCount(events) {
  return events.filter(isError).length
}

export function driverStatus(driver) {
  if (!driver) {
    return 'unknown'
  }

  if (driver.hold) {
    return 'held'
  }

  return driver.running ? 'running' : 'stopped'
}

// A waiting status needs nobody: only a needs-you one waits for the maintainer.
export function needsYou(row) {
  return row.status?.kind === 'needs-you'
}

function onStage(row, stage) {
  return row.status?.stage === stage
}

// All, the PRs that need you, then each stage that has a PR, in lifecycle order.
export function filterChips(rows) {
  const chips = [
    { filter: null, label: 'all', count: rows.length },
    { filter: 'needs-you', label: 'needs you', count: rows.filter(needsYou).length },
  ]

  for (const stage of STAGES) {
    const count = rows.filter((row) => onStage(row, stage)).length

    if (count > 0) {
      chips.push({ filter: stage, label: stage, count })
    }
  }

  return chips
}

// The filter is null, needs-you or a stage.
export function shownRows(rows, filter) {
  if (filter === null || filter === undefined) {
    return rows
  }

  if (filter === 'needs-you') {
    return rows.filter(needsYou)
  }

  return rows.filter((row) => onStage(row, filter))
}

function rowOf(state, id) {
  return JSON.stringify(state?.view?.rows?.find((row) => row.id === id))
}

// The row holds every field of the PR the driver moves, its last event time included.
export function rowChanged(before, after, id) {
  return rowOf(before, id) !== rowOf(after, id)
}

export function answeredText(answered) {
  if (!answered) {
    return null
  }

  const who = answered.by === 'delegate' ? 'delegate answered' : 'answered'

  return `${who}${RESUMED[answered.role] ?? ''}`
}

function kindMatches(event, kind) {
  if (kind === null) {
    return true
  }

  if (kind === 'errors') {
    return isError(event)
  }

  return event.kind === kind
}

export function filterEvents(events, { id = null, kind = null } = {}) {
  return events.filter((event) => (id === null || event.id === id) && kindMatches(event, kind)).reverse()
}

function detailValue(value) {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)

  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text
}

export function eventDetail(event) {
  return Object.entries(event)
    .filter(([key, value]) => !HIDDEN_FIELDS.has(key) && value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${detailValue(value)}`)
    .join(' ')
}
