import { REVIEW_SEVERITIES } from './state.ts'
import type { CommitStamp, Review, ReviewFinding, ReviewMemory, ReviewSeverity, SentCandidate } from './state.ts'

// The result of an external review: the review.json its workflow uploads as an
// artifact. This module checks the file against its contract and cuts its
// texts. It also keys a finding, splits the findings at a severity, picks
// the candidates a verifier gets and finds the ones no verifier got. Pure: no
// I/O and no clock.

export const REVIEW_FILE = 'review.json'
export const REVIEW_ARTIFACT = 'review-{pr}'
export const MAX_FINDINGS = 50
export const MAX_CANDIDATES = 20

export const TEXT_LIMITS = {
  criterion: 100,
  title: 200,
  file: 300,
  failure_scenario: 1000,
  fix: 1000,
  reused_from: 64,
}

const TEXT_FIELDS = ['criterion', 'title', 'file', 'failure_scenario', 'fix'] as const
const MIN_REVISION = 7

type TextField = (typeof TEXT_FIELDS)[number]
type JsonObject = Record<string, unknown>
type ListName = 'findings' | 'fixed'

export type ReviewFile = Pick<Review, 'reusedFrom' | 'findings' | 'fixed' | 'leftOut'>
export type ReviewRead = { available: true; review: ReviewFile } | { available: false; reason: string }

export function artifactName(template: string, pr: number): string {
  return template.replaceAll('{pr}', String(pr))
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSeverity(value: unknown): value is ReviewSeverity {
  return REVIEW_SEVERITIES.some((severity) => severity === value)
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }

  return `${text.slice(0, limit - 1)}…`
}

function rank(finding: Pick<ReviewFinding, 'severity'>): number {
  return REVIEW_SEVERITIES.indexOf(finding.severity)
}

// Array.prototype.sort is stable, so one severity keeps the file's order.
function bySeverity(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((left, right) => rank(left) - rank(right))
}

function refused(reason: string): ReviewRead {
  return { available: false, reason }
}

// The finding, or the reason the item is refused. Only an item of findings has a status to check.
function readItem(item: unknown, where: string, withStatus: boolean): ReviewFinding | string {
  if (!isObject(item)) {
    return `${where} is not an object`
  }

  if (!isSeverity(item.severity)) {
    return `${where}.severity is not high, medium or low`
  }

  const missing = TEXT_FIELDS.find((field) => typeof item[field] !== 'string')

  if (missing !== undefined) {
    return `${where}.${missing} is missing or not a string`
  }

  const { line } = item

  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
    return `${where}.line is not a whole number of 1 or more`
  }

  let status: ReviewFinding['status'] = null

  if (withStatus) {
    if (item.status !== 'new' && item.status !== 'open') {
      return `${where}.status is not new or open`
    }

    status = item.status
  }

  const text = (field: TextField) => cut(item[field] as string, TEXT_LIMITS[field])

  return {
    severity: item.severity,
    criterion: text('criterion'),
    title: text('title'),
    file: text('file'),
    line,
    failureScenario: text('failure_scenario'),
    fix: text('fix'),
    status,
  }
}

function readList(list: unknown[], name: ListName): ReviewFinding[] | string {
  const findings: ReviewFinding[] = []

  for (const [i, item] of list.entries()) {
    const finding = readItem(item, `${name}[${i}]`, name === 'findings')

    if (typeof finding === 'string') {
      return finding
    }

    findings.push(finding)
  }

  return bySeverity(findings)
}

// input_digest, dropped, refutation and any unknown field are never read, so they can hold anything.
export function parseReview(text: string, { sha }: { sha: string }): ReviewRead {
  let file: unknown

  try {
    file = JSON.parse(text)
  } catch {
    return refused('review.json is not JSON')
  }

  if (!isObject(file)) {
    return refused('review.json is not an object')
  }

  if (file.schema_version !== 1) {
    return refused('schema_version is not 1')
  }

  const { revision, reused_from: reusedFrom = null, findings, fixed } = file

  if (typeof revision !== 'string') {
    return refused('revision is missing or not a string')
  }

  if (revision.length < MIN_REVISION) {
    return refused(`revision is shorter than ${MIN_REVISION} characters`)
  }

  if (!sha.startsWith(revision)) {
    return refused(`revision ${revision.slice(0, MIN_REVISION)} is not the head`)
  }

  if (reusedFrom !== null && typeof reusedFrom !== 'string') {
    return refused('reused_from is not a string')
  }

  if (!Array.isArray(findings)) {
    return refused('findings is missing or not a list')
  }

  if (!Array.isArray(fixed)) {
    return refused('fixed is missing or not a list')
  }

  const open = readList(findings, 'findings')

  if (typeof open === 'string') {
    return refused(open)
  }

  const closed = readList(fixed, 'fixed')

  if (typeof closed === 'string') {
    return refused(closed)
  }

  return {
    available: true,
    review: {
      reusedFrom: reusedFrom === null ? null : cut(reusedFrom, TEXT_LIMITS.reused_from),
      findings: open.slice(0, MAX_FINDINGS),
      fixed: closed.slice(0, MAX_FINDINGS),
      leftOut: Math.max(open.length - MAX_FINDINGS, 0),
    },
  }
}

// The rule the review itself matches a finding by between two of its runs. The line is left out, because lines move.
export function matchKey(finding: Pick<ReviewFinding, 'criterion' | 'file' | 'title'>): string {
  return [finding.criterion, finding.file, finding.title].map((part) => part.toLowerCase().replace(/\s+/g, ' ')).join('\n')
}

export function candidates(
  review: Pick<Review, 'findings'>,
  minSeverity: ReviewSeverity,
): { candidates: ReviewFinding[]; below: ReviewFinding[] } {
  const limit = REVIEW_SEVERITIES.indexOf(minSeverity)
  const sorted = bySeverity(review.findings)

  return {
    candidates: sorted.filter((finding) => rank(finding) <= limit),
    below: sorted.filter((finding) => rank(finding) > limit),
  }
}

// `recheck` holds the keys of the current findings to re-check, which the verifier checks by their F id instead.
// `held` holds the keys of the refutations that still hold. Both go before the cap, so neither takes one of the places.
export function selectCandidates(
  review: Pick<Review, 'findings'>,
  minSeverity: ReviewSeverity,
  recheck: string[],
  held: string[] = [],
): { id: string; key: string }[] {
  const keys = candidates(review, minSeverity)
    .candidates.map(matchKey)
    .filter((key) => !recheck.includes(key) && !held.includes(key))

  return [...new Set(keys)].slice(0, MAX_CANDIDATES).map((key, i) => ({ id: `X${i + 1}`, key }))
}

// A refutation holds only while the file it was made on has the same blob id at the head. `blobs` maps a key to the
// blob read at the head. A file that is gone, or was not there, has no id to match.
export function heldRefutations(refuted: ReviewMemory['refuted'], blobs: ReadonlyMap<string, string | null>): string[] {
  return refuted.filter((record) => record.blob !== null && record.blob === blobs.get(record.key)).map((record) => record.key)
}

// The claim check reads the review before it launches the verifier. So only a read of the verified head after the
// verification fed no verifier.
export function readAfterVerification(review: Pick<Review, 'sha' | 'at'>, verified: CommitStamp | null | undefined): boolean {
  if (!verified || verified.sha !== review.sha) {
    return false
  }

  return Date.parse(review.at) > Date.parse(verified.at)
}

// The findings at or above minSeverity whose key never went to a verifier. A refuted key went to one, so no blob is compared.
export function newFindings(
  review: Pick<Review, 'findings'>,
  minSeverity: ReviewSeverity,
  memory: ReviewMemory | null | undefined,
): ReviewFinding[] {
  const seen = new Set([...(memory?.sent ?? []), ...(memory?.refuted ?? []).map((record) => record.key)])

  return candidates(review, minSeverity).candidates.filter((finding) => !seen.has(matchKey(finding)))
}

// The prompt and the judgment of the verdict both read this, so they never disagree.
export function sentCandidates(review: Pick<Review, 'findings' | 'candidates'>): SentCandidate[] {
  return review.candidates.flatMap((candidate) => {
    const finding = review.findings.find((item) => matchKey(item) === candidate.key)

    return finding ? [{ ...finding, ...candidate }] : []
  })
}

// The review's texts come from outside. A line break or a terminal escape in one must not break a card line,
// a line of the verifier's prompt or a finding of the fix note.
export function oneLine(text: string): string {
  return text.replace(/\p{Cc}+/gu, ' ')
}
