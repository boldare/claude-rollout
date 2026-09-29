import { money } from './format.js'

export const PAGE_SIZE = 200
export const FOLLOW_MS = 3000

const PREVIEW_LENGTH = 120
const KIB = 1024
const MIB = 1024 * 1024

function has(changes, key) {
  return Object.prototype.hasOwnProperty.call(changes, key)
}

function tabOf(tab) {
  return tab ?? 'overview'
}

function leavesPage(route, changes) {
  const newPr = has(changes, 'pr') && changes.pr !== route.pr
  const newTab = has(changes, 'tab') && tabOf(changes.tab) !== tabOf(route.tab)

  return newPr || newTab
}

// A run belongs to one PR's Runs tab, and a page belongs to one run.
export function transcriptRoute(route, changes) {
  const next = { ...route, ...changes }

  if (leavesPage(route, changes)) {
    next.run = has(changes, 'run') ? changes.run : null
    next.from = has(changes, 'from') ? changes.from : null
  }

  if (has(changes, 'run') && changes.run !== route.run && !has(changes, 'from')) {
    next.from = null
  }

  return next
}

export function pageLinks(page) {
  const end = page.from + page.items.length
  const atStart = page.from <= 0

  return {
    first: atStart ? null : 0,
    previous: atStart ? null : Math.max(0, page.from - PAGE_SIZE),
    next: end < page.total ? end : null,
    latest: 'end',
  }
}

export function pageLabel(page) {
  if (page.total === 0) {
    return 'no items yet'
  }

  if (page.items.length === 0) {
    return `no items here, ${page.total} in the log`
  }

  return `items ${page.from + 1}–${page.from + page.items.length} of ${page.total}`
}

export function resultPreview(text) {
  if (!text) {
    return { line: '', lines: 0 }
  }

  const first = text.split('\n').find((line) => line.trim() !== '') ?? ''
  const trimmed = first.trim()
  const line = trimmed.length > PREVIEW_LENGTH ? `${trimmed.slice(0, PREVIEW_LENGTH - 1)}…` : trimmed

  return { line, lines: text.split('\n').length }
}

export function shouldFollow(route, runs) {
  if (!route.run || route.from !== 'end' || !Array.isArray(runs)) {
    return false
  }

  return runs.some((run) => run.run === route.run && run.status === 'running')
}

export function logSize(bytes) {
  if (bytes < KIB) {
    return `${bytes} B`
  }

  if (bytes < MIB) {
    return `${Math.round(bytes / KIB)} KB`
  }

  return `${(bytes / MIB).toFixed(1)} MB`
}

export function estimateNote(estimateUsd, status) {
  if (estimateUsd === null || estimateUsd === undefined) {
    return null
  }

  if (status === 'running') {
    return `≈${money(estimateUsd)} so far, estimated from the token usage in the log`
  }

  return `≈${money(estimateUsd)}, estimated from the token usage in the log. The run reported no cost.`
}
