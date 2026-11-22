import * as transitions from '../transitions.ts'
import { candidates } from '../review.ts'
import type { ReviewRead } from '../review.ts'
import { REVIEW_SEVERITIES } from '../state.ts'
import type { IsoTime, PreVerifyStatus, Review, ReviewFinding, ReviewSeverity } from '../state.ts'
import { EVIDENCE_CHARS, launch, launchPreVerify, passHolds, preVerifyJob } from './runs.ts'
import type { RunEntry, RunPr, RunsContext } from './runs.ts'

// The claim check after READY: CI on the claimed head, the rollout's rules,
// code scanning and the scope, then a slot for the pre-verify commands, the
// wait for the external review of the head and the verifier. Each outcome
// sets the PR's stage and status through lib/transitions.ts. Nothing here
// reads the clock, the disk or GitHub itself: the context brings it, as
// lib/driver.mjs builds it.

type Say = (id: string, kind: string, detail?: object, message?: string | null) => void
type Unstamped<Union> = Union extends unknown ? Omit<Union, 'since'> : never

const SLOT = { kind: 'waiting', code: 'slot' } as const

// A head with no review run yet gets this long for the review's workflow to start.
const REVIEW_START_MINUTES = 2

export interface ClaimPr extends RunPr {
  briefTags?: string[]
}

export interface ExternalFindings {
  check: string
  artifact: string
  minSeverity: ReviewSeverity
}

export interface ClaimManifest {
  repo: { requiredChecks: string[]; codeScanning: { action: string; minSeverity: string } }
  policy: { ciStallMinutes: number }
  gates: { preVerify: { scope: boolean }; verify: { criteriaFrom?: string | null; externalFindings?: ExternalFindings | null } }
}

interface CheckRun {
  name: string
  status: string
  conclusion: string | null
}

interface ReviewRun {
  id: number
  status: string
  conclusion: string | null
  startedAt: string | null
}

// The check runs on a commit, as checksFor in lib/github.mjs returns them.
interface Checks {
  state: string
  missing: string[]
  pending: string[]
  failing: string[]
  runs: CheckRun[]
  reviewRun?: ReviewRun | null
}

// What the claim check reads of the facts the gate collects.
export interface ClaimFacts {
  pr: { state: string; headRefOid: string } | null
  patchId: string | null
  files: { path: string; previousPath?: string | null }[]
  codeScanning: { available?: boolean; reason?: string } | null
}

interface ScanFindings {
  action: string
  reasons: string[]
}

interface GateCheckMarker {
  claimedAt: IsoTime | null
  sha: string | null
  seen: string[]
}

// The fields of an entry this module reads beside the ones runs.ts types.
export type ClaimEntry = RunEntry & {
  notified: { gateChecks?: GateCheckMarker | null; codeScanningUnavailable?: boolean; codeScanningWait?: string | null }
  patchSinceId?: string | null
  patchSince?: IsoTime | null
  outOfScope?: string[]
  workflowFiles?: string[]
}

interface ClaimLedger {
  prs: Record<string, ClaimEntry>
}

export interface GateCheck {
  stage: string
  level: string
  item: string
  result: string
  evidence: string
}

// The context lib/driver.mjs builds once. tsc reads no .mjs file, so every
// function of a .mjs module comes in here, typed by what this module passes and reads.
export interface ClaimsContext {
  manifest: ClaimManifest
  ledger: ClaimLedger
  runContext: RunsContext
  say: Say
  now: () => IsoTime
  // The GitHub reads of the running tick, null between ticks.
  reads: () => unknown
  slots: () => boolean
  isStopping: () => boolean
  toFix: (pr: ClaimPr, reason: string, note: string) => void
  localConfigRemoved: (pr: ClaimPr, paths: string[] | null | undefined) => void
  collectFacts: (
    manifest: ClaimManifest,
    pr: ClaimPr,
    entry: ClaimEntry,
    ledger: ClaimLedger,
    options: { reads: unknown },
  ) => Promise<ClaimFacts>
  github: {
    viewPr: (
      manifest: ClaimManifest,
      number: number,
      options: { reads: unknown },
    ) => Promise<{ state: string; headRefOid: string; author: string | null }>
    checksFor: (manifest: ClaimManifest, sha: string, options: { reads: unknown }) => Promise<Checks>
    readCatalog: (manifest: ClaimManifest) => Promise<unknown[]>
    reviewFor: (manifest: ClaimManifest, number: number, sha: string, options: { artifact: string; reads: unknown }) => Promise<ReviewRead>
  }
  judge: {
    policyViolations: (manifest: ClaimManifest, pr: ClaimPr, facts: ClaimFacts) => string[]
    codeScanningFindings: (manifest: ClaimManifest, facts: ClaimFacts) => ScanFindings
    outOfScope: (manifest: ClaimManifest, pr: ClaimPr, facts: ClaimFacts, briefScope: string[]) => string[]
    undeclaredOutOfScope: (outside: string[], deviations: unknown[]) => string[]
  }
  codeScanningNote: (manifest: ClaimManifest, reasons: string[]) => string
  checks: {
    verifyCriteria: (gate: ClaimManifest['gates']['verify']) => unknown[]
    selectCriteria: (entries: unknown[], options: { tags: string[]; files: string[] }) => unknown[]
  }
  worktree: {
    alignWorktree: (manifest: ClaimManifest, pr: ClaimPr, sha: string) => Promise<{ ok: boolean; removed?: string[]; reason: string }>
  }
}

function minutesSince({ now }: ClaimsContext, iso: IsoTime | null | undefined): number {
  return iso ? (Date.parse(now()) - Date.parse(iso)) / 60_000 : Infinity
}

// Each check is logged once per claim and head, even across restarts, so a
// claim read every tick logs it once. The head is part of the key because a
// rebase with the same patch moves claimedSha but keeps claimedAt. A fail's
// evidence is in its key, so a new cause is logged again. A fail never clears
// the list: no command resumes a claim after a fail, and a claim read every
// tick would log its whole round every tick.
export function gateCheck(
  { say }: { say: Say },
  pr: { id: string },
  entry: ClaimEntry,
  { stage, level, item, result, evidence }: GateCheck,
) {
  const { claimedAt, claimedSha: sha } = entry
  const current = entry.notified.gateChecks
  const marker = current?.claimedAt === claimedAt && current?.sha === sha ? current : { claimedAt, sha, seen: [] }
  const shown = evidence.slice(0, EVIDENCE_CHARS)
  const key = result === 'fail' ? `${stage}:${level}:${item}:${result}:${shown}` : `${stage}:${level}:${item}:${result}`

  entry.notified.gateChecks = marker

  if (marker.seen.includes(key)) {
    return
  }

  marker.seen.push(key)
  say(pr.id, 'gate-check', { stage, item, level, result, sha: (sha ?? '').slice(0, 7), evidence: shown })
}

// Once per PR, even across restarts: the flag lives in the ledger.
export function noticeCodeScanning({ say }: { say: Say }, pr: { id: string }, entry: ClaimEntry, facts: ClaimFacts): void {
  if (facts.codeScanning?.available !== false || entry.notified.codeScanningUnavailable) {
    return
  }

  entry.notified.codeScanningUnavailable = true
  say(pr.id, 'code-scanning-unavailable', { reason: facts.codeScanning.reason })
}

// The verification stays: the claim check or the gate reads the alerts again
// every tick. A block given again only takes the new alerts.
export function blockForCodeScanning(
  { say, now }: { say: Say; now: () => IsoTime },
  pr: { id: string },
  entry: ClaimEntry,
  reasons: string[],
) {
  const again = entry.status?.kind === 'needs-you' && entry.status.code === 'code-scanning-alerts'

  transitions.toBlocked(
    entry,
    {
      kind: 'code-scanning',
      question: transitions.codeScanningQuestion(entry.pr),
      evidence: reasons.join('\n'),
      run: null,
    },
    { at: now() },
  )

  if (!again) {
    say(pr.id, 'blocked', { reason: 'code-scanning' }, `blocked (code-scanning): ${reasons[0].slice(0, 120)}`)
  }
}

// Off or unavailable checked nothing, so it is a skip, not a pass.
function codeScanningCheck({ manifest }: ClaimsContext, facts: ClaimFacts): { result: string; evidence: string } {
  const { action, minSeverity } = manifest.repo.codeScanning

  if (action === 'ignore') {
    return { result: 'skip', evidence: 'off' }
  }

  if (facts.codeScanning?.available === false) {
    return { result: 'skip', evidence: 'unavailable' }
  }

  return { result: 'pass', evidence: `no new alerts at or above ${minSeverity}` }
}

function runsSeen(ci: Checks): string {
  return ci.runs.map((run) => `${run.name} (${run.conclusion ?? run.status})`).join(', ') || 'none'
}

function scopeNote(undeclared: string[]): string {
  return [
    "These files are outside the PR's scope, and your READY report does not list them in `deviations`:",
    ...undeclared.map((path) => `- ${path}`),
    '',
    'Revert each change, or keep it and list the file in `deviations` of your next READY report, with the reason. If you keep every change, no new commit is needed. The verifier still judges every reason.',
  ].join('\n')
}

function claimStatus({ now }: ClaimsContext, entry: ClaimEntry, status: Unstamped<PreVerifyStatus>): void {
  transitions.setStatus(entry, 'pre-verify', status, now())
}

function preVerifyCheck(context: ClaimsContext, pr: ClaimPr, entry: ClaimEntry, check: Omit<GateCheck, 'stage' | 'level'>): void {
  gateCheck(context, pr, entry, { stage: 'preVerify', level: 'required', ...check })
}

// A PR merged or closed since sync is left to the next sync to record.
// A note queued while a verifier ran goes to the implementer first, so no
// verifier holds the PR to an answer the implementer has not seen.
export async function checkClaim(context: ClaimsContext, pr: ClaimPr): Promise<void> {
  const { manifest, ledger, say, now } = context
  const entry = ledger.prs[pr.id]

  if (entry.pendingNote) {
    context.toFix(pr, 'answer from the maintainer', '')
    return
  }

  const githubPr = await context.github.viewPr(manifest, entry.pr ?? 0, { reads: context.reads() })
  entry.author = githubPr.author

  if (githubPr.state !== 'OPEN') {
    return
  }

  if (githubPr.headRefOid !== entry.claimedSha) {
    say(pr.id, 'claim-moved', { claimed: entry.claimedSha?.slice(0, 7), head: githubPr.headRefOid.slice(0, 7) })
    transitions.claimMoved(entry, { sha: githubPr.headRefOid, at: now() })
  }

  const sha = githubPr.headRefOid
  const ci = await context.github.checksFor(manifest, sha, { reads: context.reads() })

  if (ci.state === 'pending') {
    ciPending(context, pr, ci)
    return
  }

  entry.ciPendingSince = null

  if (ci.state === 'red') {
    preVerifyCheck(context, pr, entry, { item: 'ci', result: 'fail', evidence: `failing: ${ci.failing.join(', ')}` })
    context.toFix(
      pr,
      'CI is red',
      `Failing checks on ${sha}:\n- ${ci.failing.join('\n- ')}\n\nStart from \`gh run view <run-id> --log-failed\`.`,
    )

    return
  }

  // Green lets a run that is not required end skipped or neutral, so the evidence names each run's conclusion.
  preVerifyCheck(context, pr, entry, { item: 'ci', result: 'pass', evidence: `required checks passed, runs: ${runsSeen(ci)}` })

  const facts = await context.collectFacts(manifest, pr, entry, ledger, { reads: context.reads() })

  if (facts.pr?.state !== 'OPEN') {
    return
  }

  if (facts.pr.headRefOid !== entry.claimedSha) {
    say(pr.id, 'claim-moved', { claimed: entry.claimedSha?.slice(0, 7), head: facts.pr.headRefOid.slice(0, 7) })
    transitions.claimMoved(entry, { sha: facts.pr.headRefOid, at: now() })
    claimStatus(context, entry, { kind: 'waiting', code: 'ci', sha: facts.pr.headRefOid, missing: [], pending: [] })
    return
  }

  if (!rulesHold(context, pr, facts)) {
    return
  }

  if (entry.patchSinceId !== facts.patchId) {
    entry.patchSinceId = facts.patchId
    entry.patchSince = now()
  }

  entry.claimPatchId = facts.patchId
  entry.outOfScope = context.judge.outOfScope(manifest, pr, facts, entry.briefScope ?? [])
  entry.workflowFiles = facts.files.map((file) => file.path).filter((path) => path.startsWith('.github/'))

  if (manifest.gates.preVerify.scope && !scopeGatePasses(context, pr, entry)) {
    return
  }

  await startVerification(context, pr, facts, ci)
}

function ciPending(context: ClaimsContext, pr: ClaimPr, ci: Checks): void {
  const { manifest, ledger, now } = context
  const entry = ledger.prs[pr.id]
  const sha = entry.claimedSha ?? ''
  const stall = manifest.policy.ciStallMinutes

  entry.ciPendingSince = entry.ciPendingSince ?? now()
  claimStatus(context, entry, { kind: 'waiting', code: 'ci', sha, missing: ci.missing, pending: ci.pending })

  if (minutesSince(context, entry.ciPendingSince) <= stall) {
    return
  }

  const why =
    ci.runs.length === 0
      ? `No check runs appeared for ${sha}. Find out why (workflow syntax? did the push reach GitHub?) and fix it.`
      : `Checks for ${sha} have not settled after ${stall} minutes. Required globs with no matching run: ${ci.missing.join(', ') || 'none'}; still running: ${ci.pending.join(', ') || 'none'}; runs seen: ${runsSeen(ci)}. Job names must keep matching ${manifest.repo.requiredChecks.join(', ')}.`

  preVerifyCheck(context, pr, entry, {
    item: 'ci',
    result: 'fail',
    evidence: `not settled after ${stall} minutes (missing: ${ci.missing.join(', ') || 'none'}, running: ${ci.pending.join(', ') || 'none'})`,
  })

  context.toFix(pr, 'CI did not settle', why)
}

// The rollout's rules and code scanning. False when the claim goes no further this tick.
function rulesHold(context: ClaimsContext, pr: ClaimPr, facts: ClaimFacts): boolean {
  const { manifest, ledger, say } = context
  const entry = ledger.prs[pr.id]
  const violations = context.judge.policyViolations(manifest, pr, facts)

  if (violations.length > 0) {
    preVerifyCheck(context, pr, entry, { item: 'policy', result: 'fail', evidence: violations.join('; ') })
    context.toFix(pr, 'rollout policy', `The PR breaks rollout rules:\n- ${violations.join('\n- ')}`)
    return false
  }

  preVerifyCheck(context, pr, entry, { item: 'policy', result: 'pass', evidence: 'no violations' })
  noticeCodeScanning(context, pr, entry, facts)

  const scanning = context.judge.codeScanningFindings(manifest, facts)

  if (scanning.action === 'fix') {
    preVerifyCheck(context, pr, entry, { item: 'code-scanning', result: 'fail', evidence: scanning.reasons.join('; ') })
    context.toFix(pr, 'code scanning', context.codeScanningNote(manifest, scanning.reasons))
    return false
  }

  if (scanning.action === 'block') {
    preVerifyCheck(context, pr, entry, { item: 'code-scanning', result: 'fail', evidence: scanning.reasons.join('; ') })
    blockForCodeScanning(context, pr, entry, scanning.reasons)
    return false
  }

  if (scanning.action === 'wait') {
    if (entry.notified.codeScanningWait !== entry.claimedSha) {
      entry.notified.codeScanningWait = entry.claimedSha
      say(pr.id, 'code-scanning-wait', { sha: entry.claimedSha?.slice(0, 7), reasons: scanning.reasons })
    }

    claimStatus(context, entry, { kind: 'waiting', code: 'code-scanning-pending', sha: entry.claimedSha ?? '' })
    return false
  }

  preVerifyCheck(context, pr, entry, { item: 'code-scanning', ...codeScanningCheck(context, facts) })

  return true
}

// A slot, a worktree at the head, then the pre-verify commands or the
// verifier. `ci` is the claim check's read of the head, with the review's run.
async function startVerification(context: ClaimsContext, pr: ClaimPr, facts: ClaimFacts, ci: Checks): Promise<void> {
  const { manifest, ledger, runContext } = context
  const entry = ledger.prs[pr.id]
  const sha = entry.claimedSha ?? ''

  if (!context.slots() || context.isStopping()) {
    claimStatus(context, entry, SLOT)
    return
  }

  const aligned = await context.worktree.alignWorktree(manifest, pr, sha)

  context.localConfigRemoved(pr, aligned.removed)

  if (!aligned.ok) {
    context.toFix(pr, 'worktree not at the PR head', aligned.reason)
    return
  }

  const job = preVerifyJob(runContext, entry)

  if (job.steps.length > 0 && !passHolds(entry, job)) {
    launchPreVerify(runContext, pr, job)
    return
  }

  if (!(await reviewSettled(context, pr, ci))) {
    return
  }

  // Fixed at launch: the verifier's prompt and the judgment of its verdict read this list, never a reloaded manifest or catalog.
  entry.verifyCriteria = [...context.checks.verifyCriteria(manifest.gates.verify), ...(await catalogCriteria(context, pr, facts))]
  launch(runContext, pr, 'verify', { sha })
}

// The last step before the verifier, so the pre-verify commands run while the
// review runs. A review that gives no result is a skip, which never stops the
// PR. False while the claim waits. A result of this head and this run is used
// again, so only a new run of the head, a re-run say, is decided again.
async function reviewSettled(context: ClaimsContext, pr: ClaimPr, ci: Checks): Promise<boolean> {
  const external = context.manifest.gates.verify.externalFindings ?? null

  if (!external) {
    return true
  }

  const entry = context.ledger.prs[pr.id]
  const sha = entry.claimedSha ?? ''
  const run = ci.reviewRun ?? null
  const stored = entry.review

  if (stored && stored.sha === sha && stored.run === (run?.id ?? null)) {
    preVerifyCheck(context, pr, entry, { item: 'external-review', ...reviewCheck(stored, external.minSeverity) })
    return true
  }

  const result = await reviewResult(context, entry, run, external)

  if (!result) {
    claimStatus(context, entry, { kind: 'waiting', code: 'external-review', sha })
    return false
  }

  const review = storedReview(context, sha, run, result)

  transitions.reviewRead(entry, review)
  preVerifyCheck(context, pr, entry, { item: 'external-review', ...reviewCheck(review, external.minSeverity) })

  return true
}

function skip(reason: string): ReviewRead {
  return { available: false, reason }
}

// Null while the review may still give a result. reviewFor throws on an
// outage, never a skip: guarded() records it, and the next tick reads again.
async function reviewResult(
  context: ClaimsContext,
  entry: ClaimEntry,
  run: ReviewRun | null,
  external: ExternalFindings,
): Promise<ReviewRead | null> {
  const stall = context.manifest.policy.ciStallMinutes

  if (!run) {
    return minutesSince(context, entry.claimedAt) < REVIEW_START_MINUTES ? null : skip('no review run on the head')
  }

  if (run.status !== 'completed') {
    return minutesSince(context, run.startedAt ?? entry.claimedAt) <= stall
      ? null
      : skip(`the review has run for more than ${stall} minutes`)
  }

  if (run.conclusion !== 'success') {
    return skip(`the review run ended as ${run.conclusion ?? 'unknown'}`)
  }

  return context.github.reviewFor(context.manifest, entry.pr ?? 0, entry.claimedSha ?? '', {
    artifact: external.artifact,
    reads: context.reads(),
  })
}

function storedReview(context: ClaimsContext, sha: string, run: ReviewRun | null, result: ReviewRead): Review {
  const file = result.available ? result.review : { reusedFrom: null, findings: [], fixed: [], leftOut: 0 }

  return {
    sha,
    at: context.now(),
    run: run?.id ?? null,
    reusedFrom: file.reusedFrom,
    skipped: result.available ? null : result.reason,
    findings: file.findings,
    fixed: file.fixed,
    leftOut: file.leftOut,
    candidates: [],
  }
}

function reviewCheck(review: Review, minSeverity: ReviewSeverity): { result: string; evidence: string } {
  if (review.skipped !== null) {
    return { result: 'skip', evidence: review.skipped }
  }

  const split = candidates(review, minSeverity)
  const parts = [candidateCount(split.candidates)]

  if (split.below.length > 0) {
    parts.push(`${split.below.length} below ${minSeverity}`)
  }

  if (review.leftOut > 0) {
    parts.push(`${review.leftOut} left out`)
  }

  return { result: 'pass', evidence: parts.join(', ') }
}

function candidateCount(found: ReviewFinding[]): string {
  if (found.length === 0) {
    return 'no candidates'
  }

  const noun = found.length === 1 ? 'candidate' : 'candidates'
  const severities = REVIEW_SEVERITIES.flatMap((severity) => {
    const count = found.filter((finding) => finding.severity === severity).length

    return count > 0 ? [`${count} ${severity}`] : []
  })

  return `${found.length} ${noun} (${severities.join(', ')})`
}

// Read at every launch, so a catalog change merged into the base applies to the next verifier. A missing or
// invalid catalog throws, and guarded() records it on this PR.
async function catalogCriteria({ manifest, github, checks }: ClaimsContext, pr: ClaimPr, facts: ClaimFacts): Promise<unknown[]> {
  if (!manifest.gates.verify.criteriaFrom) {
    return []
  }

  const entries = await github.readCatalog(manifest)
  const files = facts.files.flatMap((file) => [file.path, file.previousPath].filter((path): path is string => Boolean(path)))

  return checks.selectCriteria(entries, { tags: pr.briefTags ?? [], files })
}

function scopeGatePasses(context: ClaimsContext, pr: ClaimPr, entry: ClaimEntry): boolean {
  const outside = entry.outOfScope ?? []
  const undeclared = context.judge.undeclaredOutOfScope(outside, entry.ready?.deviations ?? [])

  if (undeclared.length > 0) {
    preVerifyCheck(context, pr, entry, { item: 'scope', result: 'fail', evidence: `undeclared: ${undeclared.join(', ')}` })
    context.toFix(pr, 'out of scope', scopeNote(undeclared))
    return false
  }

  const declared = outside.join(', ')

  preVerifyCheck(context, pr, entry, {
    item: 'scope',
    result: 'pass',
    evidence: declared ? `declared in deviations: ${declared}` : 'no files out of scope',
  })

  return true
}
