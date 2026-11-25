import { createHash } from 'node:crypto'
import { TEXT_LIMITS, candidates, oneLine } from './review.ts'
import { CANDIDATE_RESULTS, ROLES } from './state.ts'
import type {
  BudgetRole,
  CandidateResult,
  Channel,
  CriterionLevel,
  CriterionResult,
  GitHubLogin,
  IsoTime,
  Merged,
  MergePolicy,
  RecheckResult,
  ReviewFinding,
  ReviewSeverity,
  Role,
  Stage,
  StatusKind,
  Trace,
  TraceApproval,
  TraceCost,
  TraceMerged,
  TraceMissing,
  TracePlace,
  TracePr,
  TraceRecheck,
  TraceReview,
  TraceReviewFinding,
  TraceRun,
  TraceVerification,
  TraceVerified,
  VerdictValue,
} from './state.ts'

// The trace of a PR: what ran, what was verified, approved and merged, built from the ledger alone. It is meant for a
// comment on the PR, read by a tool that audits merges. So it holds results, ids and keys, never an agent's prose.
// Pure: no I/O and no clock.

export const TRACE_MARKER = '<!-- rollout-trace -->'
export const TRACE_LIMIT = 60_000

// DRIVER_MARKER of lib/github.mjs, which tsc does not read. A test keeps the two equal.
const DRIVER_MARKER = '<!-- rollout-driver -->'
const COMMIT = /^[0-9a-f]{40}$/
const REVISION = /^[0-9a-f]{7,64}$/
const FINDING_ID = /^F[0-9]+$/
// A login or a status code goes into the table only when it cannot break the markdown around it.
const PLAIN = /^[A-Za-z0-9._-]+(\[bot\])?$/
// Only a JSON string can hold these, so replacing them keeps the JSON as it was. No value can then close the fence or
// the details block, or open an HTML comment.
const UNSAFE = /[<>&`]/g
const SKIPPED_LIMIT = 300
const KEPT_VERDICTS = 10
const SHORT_SHA = 7
const COMMIT_ROLES: readonly Role[] = ['implement', 'fix', 'verify']
// The lists the size rule cuts, in the order it cuts them.
const CUT_FIELDS = ['runs', 'verifications', 'review_findings'] as const
const MISSING_FIELDS = [
  'pr.base',
  'pr.author',
  'runs.sha',
  'verifications.rechecks.from_review',
  'review.skipped',
  'review_findings.criterion',
  'review_findings.file',
  'review_findings.title',
  'approval.by',
  'approval.github_review',
  ...CUT_FIELDS,
] as const

const DENIED = 'left out because it holds a word of repo.denylist'
const MERGED_BY: Record<Merged['by'], string> = { driver: 'by the driver', github: 'on GitHub' }

type CutField = (typeof CUT_FIELDS)[number]
type Cut = Record<CutField, number>

interface StoredStatus {
  kind: StatusKind
  code: string
}

interface StoredCriterion {
  id: string
  level: CriterionLevel
  result: CriterionResult
}

type StoredAnswer = Pick<ReviewFinding, 'severity' | 'criterion' | 'file' | 'title'> & {
  id: string
  key: string
  result: CandidateResult
}

interface StoredRecheck {
  id: string
  status: RecheckResult
  fromReview?: string | null
}

interface StoredVerdict {
  verdict: VerdictValue
  sha: string
  blocking?: string[] | null
  criteria?: StoredCriterion[] | null
  external?: StoredAnswer[] | null
  recheck?: StoredRecheck[] | null
  at?: IsoTime | null
  run?: string | null
}

// An answer to a candidate, with the verdict that gave it.
interface Answered {
  verdict: StoredVerdict
  answer: StoredAnswer
}

interface StoredReview {
  sha: string
  run?: number | null
  reusedFrom?: string | null
  skipped?: string | null
  findings?: ReviewFinding[] | null
}

interface StoredApproval {
  sha: string
  at: IsoTime
  patchId?: string | null
  channel?: Channel | null
  by?: GitHubLogin | null
  review?: number | null
}

export interface TraceManifest {
  repo: { base: string; denylist: string[] }
  policy: { merge: MergePolicy; approval: Channel }
  gates: { verify: { externalFindings?: { minSeverity: ReviewSeverity } | null } }
}

// What the builder reads of an entry. Older entries lack the newer members.
export interface TraceEntry {
  stage: Stage
  status?: StoredStatus | null
  attempts?: Partial<Record<BudgetRole, number>> | null
  pr?: number | null
  author?: GitHubLogin | null
  claimedSha?: string | null
  costUsd?: number | null
  verified?: { sha: string; patchId?: string | null; at: IsoTime } | null
  verdict?: StoredVerdict | null
  verdicts?: StoredVerdict[] | null
  review?: StoredReview | null
  approved?: StoredApproval | null
  merged?: Pick<Merged, 'by' | 'at' | 'sha'> | null
}

// One record of ledger.runs.
export interface TraceRunInput {
  id: string
  role: Role
  step?: string | null
  effort?: string | null
  model?: string | null
  sha?: string | null
  startedAt?: IsoTime | null
  endedAt?: IsoTime | null
  seconds?: number | null
  costUsd?: number | null
  ok?: boolean | null
  result?: string | null
}

// A part of the trace, with the missing lines it adds when the trace writes it.
interface Item<Value> {
  value: Value
  lines: TraceMissing[]
}

interface Parts {
  now: IsoTime
  pr: Item<TracePr>
  policy: Trace['policy']
  place: TracePlace
  head: string | null
  attempts: Trace['attempts']
  runs: Item<TraceRun>[]
  cost: TraceCost
  verified: TraceVerified | null
  verifications: Item<TraceVerification>[]
  review: Item<TraceReview | null>
  review_findings: Item<TraceReviewFinding>[]
  approval: Item<TraceApproval | null>
  merged: TraceMerged | null
}

interface Screened {
  text: string | null
  denied: boolean
}

function commit(sha: unknown): string | null {
  return typeof sha === 'string' && COMMIT.test(sha) ? sha : null
}

function round(value: number): number {
  return Number(value.toFixed(4))
}

// review.ts keeps its own copy private.
function cut(text: string, limit: number): string {
  if (text.length <= limit) {
    return text
  }

  return `${text.slice(0, limit - 1)}…`
}

function shownText(text: unknown, limit: number): string | null {
  return typeof text === 'string' ? cut(oneLine(text), limit) : null
}

// Case-blind, as the policy check of lib/judge.mjs.
function screen(text: string | null, denylist: string[]): Screened {
  const lower = text?.toLowerCase()

  if (lower === undefined || !denylist.some((word) => lower.includes(word.toLowerCase()))) {
    return { text, denied: false }
  }

  return { text: null, denied: true }
}

function deniedLines(screened: [string, Screened][]): TraceMissing[] {
  return screened.filter(([, result]) => result.denied).map(([field]) => ({ field, reason: DENIED }))
}

function prOf(manifest: TraceManifest, id: string, entry: TraceEntry): Item<TracePr> {
  const { denylist } = manifest.repo
  const base = screen(manifest.repo.base, denylist)
  const author = screen(entry.author ?? null, denylist)

  return {
    value: { id, number: entry.pr ?? null, base: base.text, author: author.text },
    lines: deniedLines([
      ['pr.base', base],
      ['pr.author', author],
    ]),
  }
}

function attemptsOf(entry: TraceEntry): Trace['attempts'] {
  const attempts = entry.attempts ?? {}

  return { brief: attempts.brief ?? 0, implement: attempts.implement ?? 0, fix: attempts.fix ?? 0, verify: attempts.verify ?? 0 }
}

// A record with no time, or one that does not parse, goes first.
function startOf(record: TraceRunInput): number {
  const stamp = record.startedAt ?? record.endedAt
  const time = stamp ? Date.parse(stamp) : Number.NaN

  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
}

function runItem(run: string, record: TraceRunInput): Item<TraceRun> {
  const ended = (record.endedAt ?? null) !== null
  const lacksSha = ended && COMMIT_ROLES.includes(record.role) && record.sha === undefined

  return {
    value: {
      run,
      role: record.role,
      step: record.step ?? null,
      effort: record.effort ?? null,
      model: ended ? (record.model ?? null) : null,
      sha: commit(record.sha),
      started_at: record.startedAt ?? null,
      ended_at: record.endedAt ?? null,
      seconds: record.seconds ?? null,
      cost_usd: record.costUsd ?? 0,
      ok: ended ? record.ok === true : null,
      result: record.result ?? null,
    },
    lines: lacksSha ? [{ field: 'runs.sha', reason: 'an ended run was recorded before the driver stored its commit' }] : [],
  }
}

function byTime(left: { time: number }, right: { time: number }): number {
  if (left.time === right.time) {
    return 0
  }

  return left.time < right.time ? -1 : 1
}

// The sort is stable, so records of one time keep the order of the map.
function runsOf(id: string, runs: Record<string, TraceRunInput>): Item<TraceRun>[] {
  return Object.entries(runs)
    .filter(([, record]) => record.id === id)
    .map(([run, record]) => ({ run, record, time: startOf(record) }))
    .toSorted(byTime)
    .map(({ run, record }) => runItem(run, record))
}

function costOf(entry: TraceEntry, runs: Item<TraceRun>[]): TraceCost {
  const byRole: TraceCost['by_role'] = {}

  for (const role of ROLES) {
    const own = runs.filter((item) => item.value.role === role)

    if (own.length > 0) {
      byRole[role] = round(own.reduce((sum, item) => sum + item.value.cost_usd, 0))
    }
  }

  return { total_usd: round(entry.costUsd ?? 0), by_role: byRole }
}

function verifiedOf(entry: TraceEntry): TraceVerified | null {
  const { verified } = entry

  if (!verified) {
    return null
  }

  return { sha: commit(verified.sha), patch_id: verified.patchId ?? null, at: verified.at }
}

// A ledger from before the history holds only the last verdict.
function keptVerdicts(entry: TraceEntry): StoredVerdict[] {
  const verdicts = entry.verdicts ?? []

  if (verdicts.length > 0) {
    return verdicts.slice(-KEPT_VERDICTS)
  }

  return entry.verdict ? [entry.verdict] : []
}

function fromReviewOf(fromReview: string | null | undefined): boolean | null {
  if (typeof fromReview === 'string') {
    return true
  }

  return fromReview === null ? false : null
}

function recheckOf(record: StoredRecheck): TraceRecheck {
  return {
    finding: typeof record.id === 'string' && FINDING_ID.test(record.id) ? record.id : null,
    result: record.status,
    from_review: fromReviewOf(record.fromReview),
  }
}

function verificationItem(verdict: StoredVerdict): Item<TraceVerification> {
  const rechecks = verdict.recheck ?? []
  const lacksFromReview = rechecks.some((record) => record.fromReview === undefined)

  return {
    value: {
      run: verdict.run ?? null,
      sha: commit(verdict.sha),
      at: verdict.at ?? null,
      verdict: verdict.verdict,
      blocking: Array.isArray(verdict.blocking) ? verdict.blocking.length : 0,
      criteria: (verdict.criteria ?? []).map(({ id, level, result }) => ({ id, level, result })),
      rechecks: rechecks.map(recheckOf),
    },
    lines: lacksFromReview
      ? [{ field: 'verifications.rechecks.from_review', reason: 'a re-check was recorded before the driver stored its review key' }]
      : [],
  }
}

// Only a review of the claimed head speaks for it, and without the manifest key there is no level to count candidates at.
function reviewOf(manifest: TraceManifest, entry: TraceEntry): Item<TraceReview | null> {
  const settings = manifest.gates.verify.externalFindings
  const { review } = entry

  if (!settings || !review || review.sha !== entry.claimedSha) {
    return { value: null, lines: [] }
  }

  const findings = review.findings ?? []
  const skipped = screen(review.skipped ? shownText(review.skipped, SKIPPED_LIMIT) : null, manifest.repo.denylist)
  const reusedFrom = typeof review.reusedFrom === 'string' && REVISION.test(review.reusedFrom) ? review.reusedFrom : null

  return {
    value: {
      sha: commit(review.sha),
      run: review.run ?? null,
      skipped: skipped.text,
      reused_from: reusedFrom,
      findings: findings.length,
      candidates: candidates({ findings }, settings.minSeverity).candidates.length,
    },
    lines: deniedLines([['review.skipped', skipped]]),
  }
}

function findingItem(key: string, answers: Answered[], verdicts: StoredVerdict[], denylist: string[]): Item<TraceReviewFinding> {
  const [{ answer: first }] = answers
  const criterion = screen(shownText(first.criterion, TEXT_LIMITS.criterion), denylist)
  const file = screen(shownText(first.file, TEXT_LIMITS.file), denylist)
  const title = screen(shownText(first.title, TEXT_LIMITS.title), denylist)
  const rechecks = verdicts.flatMap((verdict) =>
    (verdict.recheck ?? [])
      .filter((record) => typeof record.fromReview === 'string' && record.fromReview === key)
      .map((record) => ({ run: verdict.run ?? null, sha: commit(verdict.sha), result: record.status })),
  )

  return {
    value: {
      criterion: criterion.text,
      file: file.text,
      title: title.text,
      severity: first.severity,
      answers: answers.map(({ verdict, answer }) => ({
        run: verdict.run ?? null,
        sha: commit(verdict.sha),
        id: answer.id,
        result: answer.result,
      })),
      rechecks,
    },
    lines: deniedLines([
      ['review_findings.criterion', criterion],
      ['review_findings.file', file],
      ['review_findings.title', title],
    ]),
  }
}

// One finding per review key, in the order the keys first went to a verifier. Its texts come from its first answer.
function findingsOf(verdicts: StoredVerdict[], denylist: string[]): Item<TraceReviewFinding>[] {
  const byKey = new Map<string, Answered[]>()

  for (const verdict of verdicts) {
    for (const answer of verdict.external ?? []) {
      byKey.set(answer.key, [...(byKey.get(answer.key) ?? []), { verdict, answer }])
    }
  }

  return [...byKey].map(([key, answers]) => findingItem(key, answers, verdicts, denylist))
}

function approvalLines(approved: StoredApproval, by: Screened): TraceMissing[] {
  const lines = deniedLines([['approval.by', by]])

  if (!by.denied && by.text === null) {
    lines.push({ field: 'approval.by', reason: 'the approval holds no login' })
  }

  if (approved.review === undefined) {
    lines.push({ field: 'approval.github_review', reason: 'the approval was recorded before the driver stored its GitHub review' })
  }

  return lines
}

function approvalOf(entry: TraceEntry, denylist: string[]): Item<TraceApproval | null> {
  const { approved } = entry

  if (!approved) {
    return { value: null, lines: [] }
  }

  const by = screen(typeof approved.by === 'string' ? approved.by : null, denylist)

  return {
    value: {
      channel: approved.channel ?? null,
      by: by.text,
      sha: commit(approved.sha),
      patch_id: approved.patchId ?? null,
      at: approved.at,
      github_review: typeof approved.review === 'number' && Number.isInteger(approved.review) ? approved.review : null,
    },
    lines: approvalLines(approved, by),
  }
}

function mergedOf(entry: TraceEntry): TraceMerged | null {
  const { merged } = entry

  if (!merged) {
    return null
  }

  return { sha: commit(merged.sha), at: merged.at, by: merged.by }
}

function partsOf(manifest: TraceManifest, id: string, entry: TraceEntry, runs: Record<string, TraceRunInput>, now: IsoTime): Parts {
  const { denylist } = manifest.repo
  const runItems = runsOf(id, runs)
  const verdicts = keptVerdicts(entry)

  return {
    now,
    pr: prOf(manifest, id, entry),
    policy: { merge: manifest.policy.merge, approval: manifest.policy.approval },
    place: { stage: entry.stage, status: entry.status?.kind ?? null, code: entry.status?.code ?? null },
    head: commit(entry.claimedSha),
    attempts: attemptsOf(entry),
    runs: runItems,
    cost: costOf(entry, runItems),
    verified: verifiedOf(entry),
    verifications: verdicts.map(verificationItem),
    review: reviewOf(manifest, entry),
    review_findings: findingsOf(verdicts, denylist),
    approval: approvalOf(entry, denylist),
    merged: mergedOf(entry),
  }
}

function cutLines(left: Cut): TraceMissing[] {
  return CUT_FIELDS.filter((field) => left[field] > 0).map((field) => {
    const verb = left[field] === 1 ? 'was' : 'were'

    return { field, reason: `the ${left[field]} oldest ${verb} left out to keep the comment within ${TRACE_LIMIT} characters` }
  })
}

// One line per field, in the order of the trace's fields, for the items it writes.
function missingOf(lines: TraceMissing[]): TraceMissing[] {
  return MISSING_FIELDS.flatMap((field) => lines.find((line) => line.field === field) ?? [])
}

function assemble(parts: Parts, left: Cut): Trace {
  const runs = parts.runs.slice(left.runs)
  const verifications = parts.verifications.slice(left.verifications)
  const findings = parts.review_findings.slice(left.review_findings)
  const written = [parts.pr, ...runs, ...verifications, parts.review, ...findings, parts.approval]

  return {
    schema_version: 1,
    updated_at: parts.now,
    pr: parts.pr.value,
    policy: parts.policy,
    place: parts.place,
    head: parts.head,
    attempts: parts.attempts,
    runs: runs.map((item) => item.value),
    cost: parts.cost,
    verified: parts.verified,
    verifications: verifications.map((item) => item.value),
    review: parts.review.value,
    review_findings: findings.map((item) => item.value),
    approval: parts.approval.value,
    merged: parts.merged,
    missing: missingOf([...written.flatMap((item) => item.lines), ...cutLines(left)]),
  }
}

function fits(parts: Parts, left: Cut): boolean {
  return traceBody(assemble(parts, left)).length <= TRACE_LIMIT
}

// Once one item is left out, each further one shortens the body by far more than the count in its missing line can
// grow. So the cuts that fit are all those from some count up, and a binary search finds the fewest. When none fits,
// the whole list goes.
function fewest(parts: Parts, left: Cut, field: CutField): number {
  let low = 0
  let high = parts[field].length

  while (low < high) {
    const middle = Math.floor((low + high) / 2)

    if (fits(parts, { ...left, [field]: middle })) {
      high = middle
    } else {
      low = middle + 1
    }
  }

  return low
}

export function traceOf(
  manifest: TraceManifest,
  id: string,
  entry: TraceEntry,
  runs: Record<string, TraceRunInput>,
  options: { now: IsoTime },
): Trace {
  const parts = partsOf(manifest, id, entry, runs, options.now)
  let left: Cut = { runs: 0, verifications: 0, review_findings: 0 }

  for (const field of CUT_FIELDS) {
    if (fits(parts, left)) {
      break
    }

    left = { ...left, [field]: fewest(parts, left, field) }
  }

  return assemble(parts, left)
}

function short(sha: string): string {
  return `\`${sha.slice(0, SHORT_SHA)}\``
}

function placeOf({ stage, status, code }: TracePlace): string {
  if (status === null) {
    return stage
  }

  if (code === null || !PLAIN.test(code)) {
    return `${stage} · ${status}`
  }

  return `${stage} · ${status}: ${code}`
}

function headerOf(trace: Trace): string {
  const head = trace.head === null ? '' : ` · head ${short(trace.head)}`

  return `**Rollout trace** · \`${placeOf(trace.place)}\`${head}`
}

function counted<Value extends string>(values: (Value | undefined)[], order: readonly Value[]): string {
  return order
    .map((value) => [value, values.filter((item) => item === value).length] as const)
    .filter(([, count]) => count > 0)
    .map(([value, count]) => `${count} ${value}`)
    .join(', ')
}

function runsRow(trace: Trace): string | null {
  if (trace.runs.length === 0) {
    return null
  }

  const roles = counted(
    trace.runs.map((run) => run.role),
    ROLES,
  )

  const older = trace.missing.some((line) => line.field === 'runs') ? ', older ones left out' : ''

  return `${trace.runs.length}: ${roles}${older}`
}

function costRow(cost: TraceCost): string | null {
  return cost.total_usd > 0 ? `${cost.total_usd.toFixed(2)} USD` : null
}

// A PR is verified only by a PASS.
function verifiedRow(verified: TraceVerified | null): string | null {
  if (!verified) {
    return null
  }

  return verified.sha === null ? 'PASS' : `${short(verified.sha)}, PASS`
}

function findingsRow(findings: TraceReviewFinding[]): string | null {
  if (findings.length === 0) {
    return null
  }

  const newest = counted(
    findings.map((finding) => finding.answers.at(-1)?.result),
    CANDIDATE_RESULTS,
  )

  const noun = findings.length === 1 ? 'finding' : 'findings'

  return `${findings.length} ${noun} went to a verifier: ${newest}`
}

function approvalRow(approval: TraceApproval | null): string | null {
  if (!approval) {
    return null
  }

  const words: string[] = []

  if (approval.by !== null && PLAIN.test(approval.by)) {
    words.push(`by \`${approval.by}\``)
  }

  if (approval.sha !== null) {
    words.push(`at ${short(approval.sha)}`)
  }

  return words.length > 0 ? words.join(' ') : 'yes'
}

function mergedRow(merged: TraceMerged | null): string | null {
  if (!merged) {
    return null
  }

  const commitText = merged.sha === null ? '' : ` as ${short(merged.sha)}`

  return `${MERGED_BY[merged.by]}${commitText}`
}

function tableOf(trace: Trace): string[] {
  const cells: [string, string | null][] = [
    ['Runs', runsRow(trace)],
    ['Cost', costRow(trace.cost)],
    ['Verified', verifiedRow(trace.verified)],
    ['External review', findingsRow(trace.review_findings)],
    ['Approved', approvalRow(trace.approval)],
    ['Merged', mergedRow(trace.merged)],
  ]

  const rows = cells.flatMap(([label, text]) => (text === null ? [] : [`| ${label} | ${text} |`]))

  if (rows.length === 0) {
    return []
  }

  return ['| | |', '|---|---|', ...rows, '']
}

function escaped(json: string): string {
  return json.replace(UNSAFE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

// The comment comes from the trace alone, so what a reader parses is what the table sums up.
export function traceBody(trace: Trace): string {
  return [
    TRACE_MARKER,
    headerOf(trace),
    '',
    ...tableOf(trace),
    '<details><summary>Machine-readable trace</summary>',
    '',
    '```json',
    escaped(JSON.stringify(trace, null, 2)),
    '```',
    '',
    '</details>',
    '',
    DRIVER_MARKER,
  ].join('\n')
}

// Two writes of the same facts at two times give one digest.
export function traceDigest(trace: Trace): string {
  const { updated_at: _, ...facts } = trace

  return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
}

// GitHub can give a body back with CRLF line ends. Never throws.
export function readTrace(body: string): unknown {
  if (typeof body !== 'string') {
    return null
  }

  const lines = body.split(/\r?\n/)

  if (lines[0] !== TRACE_MARKER) {
    return null
  }

  const open = lines.indexOf('```json')
  const close = open === -1 ? -1 : lines.indexOf('```', open + 1)

  if (close === -1) {
    return null
  }

  try {
    return JSON.parse(lines.slice(open + 1, close).join('\n'))
  } catch {
    return null
  }
}
