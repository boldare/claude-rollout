export const STATES = [
  'pending',
  'briefing',
  'implementing',
  'ready_claimed',
  'verifying',
  'verified',
  'needs_fix',
  'fixing',
  'blocked',
  'escalated',
  'interrupted',
  'merged',
]

export const ERROR_KINDS = [
  'tick-error',
  'error',
  'on-done-error',
  'reply-failed',
  'manifest-rejected',
  'fetch-failed',
  'outside-deps-failed',
  'watch-base-failed',
  'report-unchecked',
]

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

  if (driver.halted) {
    return 'halted'
  }

  if (driver.paused) {
    return 'paused'
  }

  return driver.running ? 'running' : 'stopped'
}

export function stateCounts(rows) {
  const counts = new Map()

  for (const row of rows) {
    counts.set(row.state, (counts.get(row.state) ?? 0) + 1)
  }

  const known = STATES.filter((state) => counts.has(state))
  const unknown = [...counts.keys()].filter((state) => !STATES.includes(state)).sort()

  return [...known, ...unknown].map((state) => ({ state, count: counts.get(state) }))
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
