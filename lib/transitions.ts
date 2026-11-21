import { GATE_BLOCK_CODES, QUESTION_KINDS, ROLES, STAGE_STATUSES } from './state.ts'
import type {
  Approval,
  BriefEntry,
  BudgetRole,
  CommitStamp,
  Entry,
  EntryBase,
  Fix,
  FixReason,
  GateBlockCode,
  Head,
  Hold,
  IsoTime,
  Merged,
  MergeStatus,
  NoteRecord,
  NeedsYouCode,
  NeedsYouDetails,
  OpenStage,
  PreVerifyEntry,
  Question,
  QuestionKind,
  Role,
  RunRecord,
  RunningCode,
  Stage,
  Status,
  StatusAt,
  Verification,
  WaitingDetails,
  WaitingOf,
} from './state.ts'

// A block as a report or the driver raises it, with its text in `question`.
// QuestionKind has no closed or gate, because they are statuses.
type Blocked = Pick<Question, 'evidence' | 'run'> & { kind: QuestionKind | 'closed' | 'gate'; question: string }

// Version 2 records no run, and no patch id until pre-verify computed one.
type StoredVerification = Pick<Verification, 'sha' | 'at'> & { patchId?: string | null }

// A stored run record, as far as the migration reads it. A record of version 3
// still has its step. Only RunRecord in state.ts has none, because the brief's
// two steps are running codes there. A record that endRun made with no start
// has no start time.
export type StoredRun = Pick<RunRecord, 'id' | 'role'> & {
  step?: 'write' | 'review' | null
  startedAt?: RunRecord['startedAt'] | null
  endedAt?: RunRecord['endedAt']
}

// The gate's verdict as mergeCandidate stores it in `gate`. A queued one
// names the PR it waits for in `after`. The codes live in judge.mjs, which
// tsc does not read.
interface StoredVerdict {
  action: string
  code: string
  reasons: string[]
  mergeState?: string
  sha?: string | null
  at?: IsoTime
  after?: number
}

// Version 2 keeps no channel on an approval from before channels, and no login on one from the inbox.
type StoredApproval = Pick<Approval, 'sha' | 'at'> & { patchId?: string | null; channel?: Approval['channel']; by?: Approval['by'] }

// A note as version 2 records it: what it answered is the question's kind and text.
export interface StoredNote {
  at: IsoTime
  by: NoteRecord['by']
  kind: string | null
  question: string | null
  text: string
  run: string | null
}

// What the gate read, as collectFacts in github.mjs returns it.
interface GateFacts {
  pr: { headRefOid: string } | null
  depsPending: string[]
  checks: { missing: string[]; pending: string[] }
  mainChecks: { sha?: string | null; failing: string[] }
}

// The fields of a stored entry beside its stage and status, as far as this
// module and the commands read or write them. The optional ones are missing
// from an entry until the driver first sets them.
interface StoredFields {
  fix: Fix | null
  hold: Hold | null
  attempts: EntryBase['attempts']
  escalationRun: string | null
  fixReason?: string
  fixNote?: string
  verified: StoredVerification | null
  approved: StoredApproval | null
  pendingNote: string | null
  noteHistory?: StoredNote[]
  // `question` is the question the delegate works on. Only a running delegate reads it.
  delegate: { runs: number; lastQuestion: string | null; limitNotified: boolean; answers: unknown[]; question: Question | null }
  refunds?: number
  findings: unknown
  ready: unknown
  // The READY report in `ready` waits to be checked against GitHub.
  reportUnchecked: boolean
  // The no-report fix the PR owes comes from a first implement run, so with no session the next run is implement again.
  implementCutOff: boolean
  pr: number | null
  sessionId: string | null
  claimedSha: string | null
  claimedAt: IsoTime | null
  claimPatchId?: string | null
  ciPendingSince?: IsoTime | null
  briefAnswers: BriefEntry['answers']
  briefScope?: string[]
  briefHeads: Head[]
  briefAt?: IsoTime
  previewConflict: string | null
  retryAfter?: IsoTime | null
  failStreak?: number
  tickErrors?: number
  gate?: StoredVerdict | null
  lastError: EntryBase['lastError']
  mergeSha?: string
  commands: PreVerifyEntry['commands']
  // The needs-you status a close replaced, which the reopen brings back.
  closedFrom?: Status | null
  // Missing on a merge an older driver recorded, and on a dependency outside the run.
  merged?: Merged | null
}

type Placement<Member> = Member extends Entry ? Pick<Member, 'stage' | 'status'> : never

// Entry in state.ts is the shape a stored entry moves to. Version 3 takes
// only its stage and status from it, member by member, so a status of
// another stage does not compile.
export type PrEntry = Placement<Entry> & StoredFields

// A status as a transition decides it. The write gives it its time.
type Unstamped<Union> = Union extends unknown ? Omit<Union, 'since'> : never

type Resting = Unstamped<WaitingOf<'backoff' | 'slot'>>

export type RestingStage = (typeof RESTING_STAGES)[number]

// What verifiedOnMerge reads, so a view row's stage and status can be asked too.
interface Placed {
  stage: string
  status: { kind: string | null; code: string | null } | null
}

export const DISPUTE = 'disputed finding'

// A block waits for the maintainer, or for GitHub to lift it.
export const BLOCK_CODES = [
  'brief-questions',
  'decision',
  'obstacle',
  'closed',
  'code-scanning-alerts',
  'gate-blocked',
] as const satisfies readonly NeedsYouCode[]

// An escalation: the driver gave up on the PR until the maintainer acts.
export const ESCALATION_CODES = ['dispute', 'attempts-exhausted', 'errors'] as const satisfies readonly NeedsYouCode[]

// `satisfies` checks each against state.ts and keeps its literal types, where a cast would hide a mismatch.
const ROLE_STAGES = {
  brief: 'brief',
  implement: 'implement',
  fix: 'implement',
  verify: 'verify',
} as const satisfies Record<BudgetRole, OpenStage>

const BUDGET_ROLES = ROLES.filter((role): role is BudgetRole => role !== 'delegate')
const RESTING_STAGES = ['brief', 'implement', 'verify'] as const satisfies readonly OpenStage[]
const SLOT = { kind: 'waiting', code: 'slot' } as const satisfies Unstamped<WaitingOf<'slot'>>
const GITHUB = { kind: 'waiting', code: 'github' } as const satisfies Unstamped<WaitingOf<'github'>>
const HELD_PR = { kind: 'waiting', code: 'held', scope: 'pr' } as const satisfies Unstamped<WaitingOf<'held'>>
const GATE_PENDING = { kind: 'waiting', code: 'gate-pending' } as const satisfies Unstamped<WaitingOf<'gate-pending'>>
const OBSTACLE_KINDS = ['environment', 'ci', 'stuck', 'code-scanning'] as const satisfies readonly QuestionKind[]
// How many times a PR gets back the attempt of a run that did no work.
const MAX_REFUNDS = 5

// includes() on an `as const` list refuses a value outside the list, which is the value it is asked about.
function listed(list: readonly string[], value: string | null | undefined): boolean {
  return list.includes(value ?? '')
}

// The roles of the agents whose run a restart cuts off.
const RECOVERED: Partial<Record<RunningCode, BudgetRole>> = {
  'brief-write': 'brief',
  'brief-review': 'brief',
  implement: 'implement',
  fix: 'fix',
  verify: 'verify',
}

// Today's texts of a fix, as the events and fixReason keep them, to their codes.
export const FIX_REASON_CODES: ReadonlyMap<string, FixReason> = new Map([
  ['verifier findings', 'verifier-findings'],
  ['CI is red', 'ci-red'],
  ['CI did not settle', 'ci-stalled'],
  ['rollout policy', 'policy'],
  ['out of scope', 'scope'],
  ['ready check', 'commands'],
  ['pre-verify check', 'commands'],
  ['code scanning', 'code-scanning'],
  ['report does not match GitHub', 'report-mismatch'],
  ['worktree not at the PR head', 'worktree'],
  ['rebase conflict', 'rebase-conflict'],
  ['answer from the maintainer', 'maintainer-note'],
  ['request from the maintainer', 'maintainer-note'],
  ['maintainer review', 'maintainer-review'],
  ['answer from the delegate', 'delegate-answer'],
  ['request from the delegate', 'delegate-answer'],
  ['retry', 'retry'],
])

// An older driver named every fix of the merge gate "merge gate". Only the
// migration of a ledger it wrote reads these, to name the cause by the verdict's code.
const GATE_FIX_REASONS: ReadonlyMap<string, FixReason> = new Map([
  ['policy-violations', 'policy'],
  ['ci-red', 'ci-red'],
])

// Any other text, an older driver's or a fixture's, counts as the verifier's
// findings. A cut-off run gets no-report from the transition itself. The gate
// code counts only beside "merge gate", for the migration of an older ledger.
export function fixReasonCode(reason: string | null | undefined, gateCode: string | null = null): FixReason {
  if (reason === 'merge gate') {
    return GATE_FIX_REASONS.get(gateCode ?? '') ?? 'verifier-findings'
  }

  return FIX_REASON_CODES.get(reason ?? '') ?? 'verifier-findings'
}

// The detail of a status event. Its status kind is `status`, because a `kind`
// would replace the event's own. A merged PR has neither status nor code.
export function statusDetail(entry: PrEntry) {
  return { stage: entry.stage ?? null, status: entry.status?.kind ?? null, code: entry.status?.code ?? null }
}

// The question of a needs-you status that asks one.
export function statusQuestion(status: Status | null): Question | null {
  if (status?.kind !== 'needs-you') {
    return null
  }

  if (status.code === 'brief-questions' || status.code === 'decision' || status.code === 'obstacle') {
    return status.question
  }

  return null
}

// A block waits for an answer or for GitHub, or the delegate works on its question.
export function waitsOnBlock(entry: Pick<PrEntry, 'status'>): boolean {
  const status = entry.status

  if (status?.kind === 'running') {
    return status.code === 'delegate'
  }

  return status?.kind === 'needs-you' && listed(BLOCK_CODES, status.code)
}

export function waitsOnEscalation(entry: Pick<PrEntry, 'status'>): boolean {
  return entry.status?.kind === 'needs-you' && listed(ESCALATION_CODES, entry.status.code)
}

// A claim waiting for its check: its commands run, or it waits with its report checked.
export function claimWaits(entry: PrEntry): boolean {
  const status = entry.status

  if (entry.stage !== 'pre-verify' || !status) {
    return false
  }

  if (status.kind === 'running') {
    return status.code === 'commands'
  }

  return status.kind === 'waiting' && !entry.reportUnchecked
}

// A verified PR on merge. One that a block or an escalation stops there is not.
export function verifiedOnMerge({ stage, status }: Placed): boolean {
  if (stage !== 'merge') {
    return false
  }

  return status?.kind !== 'needs-you' || !(listed(BLOCK_CODES, status.code) || listed(ESCALATION_CODES, status.code))
}

// What a block for new code scanning alerts asks. A note records it as the
// question it answered, and the agents' prompts list it from there.
export function codeScanningQuestion(pr: number | null): string {
  return `PR #${pr} has new code scanning alerts. Dismiss a false positive on GitHub and the driver reads them again on the next tick, or send instructions with rollout note.`
}

// A write that keeps the stage, the kind and the code keeps the time the
// status began, and only updates its data.
function write<At extends OpenStage>(entry: PrEntry, stage: At, status: Unstamped<StatusAt<At>>, since: IsoTime): void {
  const current = entry.status
  const { kind, code } = status as Unstamped<Status>
  const kept = entry.stage === stage && current?.kind === kind && current.code === code

  entry.stage = stage
  entry.status = { ...status, since: kept ? current.since : since } as Status
}

// Every transition that moves a PR ends here. Only implement owes a fix, and
// a fix other than no-report replaced or used the one a cut-off implement run left.
function place<At extends OpenStage>(
  entry: PrEntry,
  stage: At,
  status: Unstamped<StatusAt<At>>,
  { since, fix = null }: { since: IsoTime; fix?: Fix | null },
): void {
  write(entry, stage, status, since)
  entry.fix = stage === 'implement' ? fix : null

  if (entry.fix?.reason !== 'no-report') {
    entry.implementCutOff = false
  }
}

// A PR with nothing else to wait for on brief, implement and verify waits out
// its back-off, then waits for a slot.
function resting(entry: PrEntry, at: IsoTime): Resting {
  if (entry.retryAfter && Date.parse(entry.retryAfter) > Date.parse(at)) {
    return { kind: 'waiting', code: 'backoff', until: entry.retryAfter, failures: entry.failStreak ?? 0 }
  }

  return SLOT
}

function noReport(at: IsoTime): Fix {
  return { reason: 'no-report', note: '', since: at }
}

export function restsOn(stage: Stage): stage is RestingStage {
  return listed(RESTING_STAGES, stage)
}

// A merged entry has no status. A change on one, which no path makes, lands on merge.
function openStage(entry: PrEntry): OpenStage {
  return entry.stage === 'merged' ? 'merge' : entry.stage
}

// The verifier still finds open what the implementer disputed. A note sends
// the PR to a fix run with the findings.
export function escalatedOverDispute(entry: PrEntry): boolean {
  return entry.status?.kind === 'needs-you' && entry.status.code === 'dispute'
}

// A PR sent to a fix run is no longer verified, so a retry can never send
// the unchanged patch back to the gate and drop the fix it was sent for.
export function toFix(entry: PrEntry, reason: string, note: string, { code, at }: { code: FixReason; at: IsoTime }): void {
  entry.fixReason = reason
  entry.fixNote = note
  entry.verified = null
  place(entry, 'implement', resting(entry, at), { since: at, fix: { reason: code, note, since: at } })
}

export function joinFix(entry: PrEntry, note: string): void {
  entry.fixNote = `${entry.fixNote ?? ''}\n\n${note}`

  if (entry.fix) {
    entry.fix = { ...entry.fix, note: `${entry.fix.note}\n\n${note}` }
  }
}

export function answerBrief(entry: PrEntry, question: string | null, text: string, at: IsoTime): void {
  entry.briefAnswers = [...(entry.briefAnswers ?? []), { question, answer: text }]
  entry.attempts.brief = Math.max(0, entry.attempts.brief - 1)
  place(entry, 'brief', resting(entry, at), { since: at })
}

export function toPending(entry: PrEntry, at: IsoTime): void {
  place(entry, 'brief', resting(entry, at), { since: at })
}

export function briefWaits(entry: PrEntry, key: string, { heads, at }: { heads: Head[]; at: IsoTime }): void {
  entry.attempts.brief = Math.max(0, entry.attempts.brief - 1)
  entry.previewConflict = key
  place(entry, 'brief', { kind: 'waiting', code: 'dependencies-merge', heads }, { since: at })
}

export function briefWritten(entry: PrEntry, { scope, heads, at }: { scope: string[]; heads: Head[]; at: IsoTime }): void {
  entry.briefScope = scope
  entry.briefHeads = heads
  entry.previewConflict = null
  entry.briefAt = at
  entry.briefAnswers = []
  entry.failStreak = 0
  place(entry, 'implement', resting(entry, at), { since: at })
}

// The run's name follows once the driver reserved it, see runName.
export function runStarted(entry: PrEntry, role: BudgetRole, { at, sha = '' }: { at: IsoTime; sha?: string }): void {
  if (role === 'brief') {
    place(entry, 'brief', { kind: 'running', code: 'brief-write', run: '' }, { since: at })
  } else if (role === 'implement') {
    place(entry, 'implement', { kind: 'running', code: 'implement', run: '' }, { since: at })
  } else if (role === 'fix') {
    const reason = entry.fix?.reason ?? 'no-report'

    place(entry, 'implement', { kind: 'running', code: 'fix', reason, run: '' }, { since: at, fix: entry.fix })
  } else {
    place(entry, 'verify', { kind: 'running', code: 'verify', sha, run: '' }, { since: at })
  }
}

// A run that did no work (a stop, an outage, a quota wall, a crash) gives
// its attempt back, MAX_REFUNDS times in a PR at most.
export function refundAttempt(entry: PrEntry, role: BudgetRole): void {
  const refunds = entry.refunds ?? 0

  if (entry.attempts[role] <= 0 || refunds >= MAX_REFUNDS) {
    return
  }

  entry.attempts[role] -= 1
  entry.refunds = refunds + 1
}

// A fix run that fails keeps the fix it ran for, so the next run still has
// its reason and note. Any other run on implement owes a no-report fix.
export function runFailed(entry: PrEntry, role: BudgetRole, at: IsoTime): void {
  const fix = entry.fix

  entry.reportUnchecked = false

  if (role === 'fix' && fix && fix.reason !== 'no-report') {
    entry.implementCutOff = false
    rest(entry, role, { at, fix })
    return
  }

  entry.implementCutOff = role === 'implement'
  rest(entry, role, { at, fix: noReport(at) })
}

// A run that ended without a report rests on the stage of its role. On
// implement it owes `fix`.
function rest(entry: PrEntry, role: BudgetRole, { at, fix }: { at: IsoTime; fix: Fix }): void {
  if (role === 'brief') {
    place(entry, 'brief', resting(entry, at), { since: at })
  } else if (role === 'verify') {
    place(entry, 'verify', resting(entry, at), { since: at })
  } else {
    place(entry, 'implement', resting(entry, at), { since: at, fix })
  }
}

export function reportWaits(entry: PrEntry, at: IsoTime): void {
  entry.reportUnchecked = true
  entry.implementCutOff = false
  place(entry, 'pre-verify', GITHUB, { since: at })
}

export function reportUsed(entry: PrEntry): void {
  entry.reportUnchecked = false
  entry.implementCutOff = false
}

function claimWait(sha: string | null): Unstamped<WaitingOf<'ci'>> {
  return { kind: 'waiting', code: 'ci', sha: sha ?? '', missing: [], pending: [] }
}

export function toClaimed(entry: PrEntry, { pr, sha, at }: CommitStamp & { pr: number }): void {
  entry.pr = pr
  entry.claimedSha = sha
  entry.claimedAt = at
  entry.ciPendingSince = null
  entry.verified = null
  place(entry, 'pre-verify', claimWait(sha), { since: at })
}

// Another patch is verified and approved again from the start.
export function claimNewHead(entry: PrEntry, { sha, at }: CommitStamp): void {
  entry.verified = null
  entry.approved = null
  entry.claimedSha = sha
  entry.claimedAt = at
  entry.ciPendingSince = null
  place(entry, 'pre-verify', claimWait(sha), { since: at })
}

export function verifyAgain(entry: PrEntry, at: IsoTime): void {
  place(entry, 'pre-verify', claimWait(entry.claimedSha), { since: at })
}

// The gate has not judged this verification yet (decision 37).
export function toVerified(entry: PrEntry, { sha, at }: CommitStamp): void {
  entry.verified = { sha, patchId: entry.claimPatchId, at }
  entry.attempts.verify = 0
  entry.findings = null
  place(entry, 'merge', GATE_PENDING, { since: at })
}

function questionOf(blocked: Blocked): Question {
  const known = listed(QUESTION_KINDS, blocked.kind)

  return {
    kind: known ? (blocked.kind as QuestionKind) : 'unknown',
    text: blocked.question ?? '',
    evidence: blocked.evidence ?? '',
    run: blocked.run ?? null,
    delegate: null,
  }
}

// The question waits in `delegate.question` while the delegate works on it,
// and so does the fix the PR owes.
export function delegateStarted(entry: PrEntry, { run, at }: { run: string; at: IsoTime }): void {
  const asked = statusQuestion(entry.status)
  const question = asked?.kind ?? 'unknown'
  const status = { kind: 'running', code: 'delegate', question, run } as const

  entry.delegate.question = asked

  if (question === 'brief-questions') {
    place(entry, 'brief', status, { since: at })
  } else {
    place(entry, 'implement', status, { since: at, fix: entry.fix })
  }
}

// The kind a running delegate names, for an entry with no question kept.
function delegatedKind(status: Status | null): QuestionKind {
  return status?.kind === 'running' && status.code === 'delegate' ? status.question : 'unknown'
}

// The question goes back to the maintainer with what the delegate did about
// it. A null outcome hands it back as it was: a note came, or the run is gone.
export function delegateReturned(
  entry: PrEntry,
  { outcome, reason, at }: { outcome: 'escalated' | 'failed' | null; reason: string; at: IsoTime },
): void {
  const asked = entry.delegate.question ?? { kind: delegatedKind(entry.status), text: '', evidence: '', run: null }
  const question = { ...asked, delegate: outcome ? { outcome, reason } : null }

  entry.delegate.question = null

  if (entry.stage === 'brief') {
    place(entry, 'brief', { kind: 'needs-you', code: 'brief-questions', question }, { since: at })
  } else if (listed(OBSTACLE_KINDS, question.kind)) {
    place(entry, 'implement', { kind: 'needs-you', code: 'obstacle', question }, { since: at, fix: entry.fix })
  } else {
    place(entry, 'implement', { kind: 'needs-you', code: 'decision', question }, { since: at, fix: entry.fix })
  }
}

function gateBlockCode(code: string | null | undefined): GateBlockCode | null {
  return listed(GATE_BLOCK_CODES, code) ? (code as GateBlockCode) : null
}

interface Block {
  since: IsoTime
  fix: Fix | null
  closedOn: Exclude<OpenStage, 'brief'>
  gateBlock: Omit<NeedsYouDetails['gate-blocked'], 'code'>
}

function placeBlock(entry: PrEntry, blocked: Blocked, { since, fix, closedOn, gateBlock }: Block): void {
  if (blocked.kind === 'brief-questions') {
    place(entry, 'brief', { kind: 'needs-you', code: 'brief-questions', question: questionOf(blocked) }, { since })
  } else if (blocked.kind === 'closed') {
    place(entry, closedOn, { kind: 'needs-you', code: 'closed' }, { since, fix })
  } else if (blocked.kind === 'gate') {
    place(entry, 'merge', { kind: 'needs-you', code: 'gate-blocked', ...gateBlock }, { since })
  } else if (blocked.kind === 'code-scanning' && !blocked.run) {
    const alerts = (blocked.evidence ?? '').split('\n').filter(Boolean)

    place(entry, entry.verified ? 'merge' : 'pre-verify', { kind: 'needs-you', code: 'code-scanning-alerts', alerts }, { since })
  } else if (listed(OBSTACLE_KINDS, blocked.kind)) {
    place(entry, 'implement', { kind: 'needs-you', code: 'obstacle', question: questionOf(blocked) }, { since, fix })
  } else {
    place(entry, 'implement', { kind: 'needs-you', code: 'decision', question: questionOf(blocked) }, { since, fix })
  }
}

// A block of the gate carries the verdict's code and reasons. A code
// scanning block of the driver's has no run, an agent's has its run.
export function toBlocked(
  entry: PrEntry,
  blocked: Blocked,
  { at, gate = null }: { at: IsoTime; gate?: Pick<StoredVerdict, 'code' | 'reasons'> | null },
): void {
  const stage = openStage(entry)

  placeBlock(entry, blocked, {
    since: at,
    fix: entry.fix,
    closedOn: stage === 'brief' ? 'implement' : stage,
    gateBlock: { gate: gateBlockCode(gate?.code) ?? 'no-pr', reasons: gate?.reasons ?? [blocked.question] },
  })
}

// A needs-you status the close replaces is kept whole, so the reopen brings
// back the same question, findings or error, and its time.
export function toClosed(entry: PrEntry, { at, text }: { at: IsoTime; text: string }): void {
  const status = entry.status

  entry.closedFrom = status?.kind === 'needs-you' && status.code !== 'closed' ? status : null
  toBlocked(entry, { kind: 'closed', question: text, evidence: '', run: null }, { at })
}

// What the close replaced comes back unchanged. With nothing kept, or a status
// its stage does not have, the PR waits on its stage, and the next tick
// computes the rest.
export function toReopened(entry: PrEntry, at: IsoTime): void {
  const kept = entry.closedFrom ?? null
  const stage = openStage(entry)

  entry.closedFrom = null

  if (!kept || !listed(STAGE_STATUSES[stage][kept.kind], kept.code)) {
    waitOnStage(entry, stage, at)
    return
  }

  entry.status = kept
}

export function escalateExhausted(
  entry: PrEntry,
  { role, limit, at, run }: { role: BudgetRole; limit: number; at: IsoTime; run: string | null },
): void {
  entry.escalationRun = run
  entry.lastError = `${role} attempts exhausted (${limit})`
  place(entry, ROLE_STAGES[role], { kind: 'needs-you', code: 'attempts-exhausted', role, limit }, { since: at, fix: entry.fix })
}

export function escalateDispute(
  entry: PrEntry,
  { note, text, at, run, findings }: { note: string; text: string; at: IsoTime; run: string | null; findings: string[] },
): void {
  entry.escalationRun = run
  entry.verified = null
  entry.fixReason = 'verifier findings'
  entry.fixNote = note
  entry.lastError = text
  place(entry, 'verify', { kind: 'needs-you', code: 'dispute', findings, text }, { since: at })
}

export function escalateErrors(entry: PrEntry, { at, run }: { at: IsoTime; run: string | null }): void {
  entry.escalationRun = run

  const status = { kind: 'needs-you', code: 'errors', error: entry.lastError ?? '', count: entry.tickErrors ?? 0 } as const

  place(entry, openStage(entry), status, { since: at, fix: entry.fix })
}

// A dependency outside the run merges with no record, and adds no key.
export function toMerged(entry: PrEntry, { mergeSha, pr, merged }: { mergeSha?: string; pr?: number; merged?: Merged } = {}): void {
  if (mergeSha !== undefined) {
    entry.mergeSha = mergeSha
  }

  if (pr !== undefined) {
    entry.pr = pr
  }

  if (merged !== undefined) {
    entry.merged = merged
  }

  if (entry.closedFrom) {
    entry.closedFrom = null
  }

  entry.stage = 'merged'
  entry.status = null
  entry.fix = null
}

// For a running status whose run is gone: the driver restarted, or its
// onDone threw. An agent run ends as a stopped one does, so a fix run keeps
// its fix, and `refund` gives back what a stop gives back. Commands a dead
// driver ran are its own work, so they cost no attempt and are run again.
export function recoverRun(entry: PrEntry, { refund, at }: { refund: boolean; at: IsoTime }): BudgetRole | null {
  const status = entry.status

  if (status?.kind !== 'running') {
    return null
  }

  if (status.code === 'commands') {
    write(entry, 'pre-verify', SLOT, at)
    return null
  }

  // The question waits for its answer again, and the delegate may take it again.
  if (status.code === 'delegate') {
    if (refund) {
      entry.delegate.runs = Math.max(0, entry.delegate.runs - 1)
    }

    delegateReturned(entry, { outcome: null, reason: '', at })
    return null
  }

  const role = RECOVERED[status.code]

  if (!role) {
    return null
  }

  if (refund) {
    refundAttempt(entry, role)
  }

  if (role === 'brief') {
    rest(entry, role, { at, fix: noReport(at) })
  } else {
    runFailed(entry, role, at)
  }

  return role
}

// What a verdict's status reads beside the verdict: the gate's facts when it
// runs, else only what the stored verdict kept.
interface VerdictFacts {
  head: string
  depsPending: string[]
  missing: string[]
  pending: string[]
  baseSha: string
  failing: string[]
}

type VerdictStatus = (verdict: StoredVerdict, facts: VerdictFacts) => Unstamped<MergeStatus>

// The verdicts that keep a PR on merge. A merge, a rebase, a fix and a block
// move it on, and merged-on-github waits for the next sync.
const VERDICT_STATUSES: ReadonlyMap<string, VerdictStatus> = new Map<string, VerdictStatus>([
  ['held', () => HELD_PR],
  ['deps-pending', (_, facts) => ({ kind: 'waiting', code: 'dependencies', on: facts.depsPending })],
  ['ci-pending', (_, facts) => ({ kind: 'waiting', code: 'ci', sha: facts.head, missing: facts.missing, pending: facts.pending })],
  ['base-red', (_, facts) => ({ kind: 'waiting', code: 'base-red', sha: facts.baseSha, failing: facts.failing })],
  ['base-pending', (_, facts) => ({ kind: 'waiting', code: 'base-pending', sha: facts.baseSha })],
  ['mergeable-unknown', () => ({ kind: 'waiting', code: 'mergeable-unknown' })],
  ['github-merge-state', (verdict) => ({ kind: 'waiting', code: 'github-merge-state', mergeState: verdict.mergeState ?? '' })],
  ['code-scanning', (_, facts) => ({ kind: 'waiting', code: 'code-scanning-pending', sha: facts.head })],
  ['queued', (verdict) => ({ kind: 'waiting', code: 'queued', after: verdict.after ?? 0 })],
  ['awaiting-inbox-approval', () => ({ kind: 'needs-you', code: 'approve' })],
  ['awaiting-github-review', () => ({ kind: 'needs-you', code: 'review', stale: false })],
  ['stale-github-review', () => ({ kind: 'needs-you', code: 'review', stale: true })],
  ['changes-requested', () => ({ kind: 'needs-you', code: 'changes-requested' })],
  ['github-blocked', () => ({ kind: 'needs-you', code: 'github-blocked' })],
  ['merge-refused', (verdict) => ({ kind: 'needs-you', code: 'merge-refused', error: verdict.reasons?.[0] ?? '' })],
])

// Null for a verdict with no status of its own.
function verdictStatus(verdict: StoredVerdict, facts: VerdictFacts): Unstamped<MergeStatus> | null {
  if (verdict.action === 'ready') {
    return { kind: 'needs-you', code: 'merge-by-hand', mergeState: verdict.mergeState ?? '' }
  }

  const status = verdict.action === 'wait' ? VERDICT_STATUSES.get(verdict.code) : undefined

  return status ? status(verdict, facts) : null
}

// What a stored verdict kept of its facts. It never kept the base's sha or the lists.
function storedFacts(verdict: StoredVerdict): VerdictFacts {
  return { head: verdict.sha ?? '', depsPending: [], missing: [], pending: [], baseSha: '', failing: [] }
}

// Whether the stored verdict speaks for the current verification, as currentGate in judge.mjs decides.
function currentVerdict(entry: PrEntry): boolean {
  const gate = entry.gate
  const verified = entry.verified

  return Boolean(gate?.at && verified?.at && Date.parse(gate.at) >= Date.parse(verified.at))
}

// Decision 37: on merge with no verdict of this tick, the stored verdict for
// the current verification decides, else the PR waits for the gate. A stored
// held counts only while the PR is held, and a hold turns a waiting result into held.
function storedRule(entry: PrEntry, at: IsoTime): { status: Unstamped<MergeStatus>; since: IsoTime } {
  const gate = entry.gate
  const counts = gate && currentVerdict(entry) && (gate.code !== 'held' || entry.hold)
  const stored = counts ? verdictStatus(gate, storedFacts(gate)) : null
  const result = stored && gate?.at ? { status: stored, since: gate.at } : { status: GATE_PENDING, since: entry.verified?.at ?? at }

  if (entry.hold && result.status.kind === 'waiting') {
    return { status: HELD_PR, since: result.since }
  }

  return result
}

// Moves the PR onto merge as the stored rule decides. mergeStatus writes the status of a PR that stays there.
export function toMergeStatus(entry: PrEntry, at: IsoTime): void {
  const { status, since } = storedRule(entry, at)

  place(entry, 'merge', status, { since })
}

// The counts that stop a PR, as rollout retry gives them back.
export function resetBudgets(entry: PrEntry): void {
  entry.attempts = { implement: 0, fix: 0, verify: 0, brief: 0 }
  entry.refunds = 0
  entry.failStreak = 0
  entry.tickErrors = 0
  entry.retryAfter = null
  entry.delegate = { ...entry.delegate, runs: 0, limitNotified: false }
}

// One more attempt of a role whose attempts ran out, never more.
export function freshAttempt(entry: PrEntry, role: BudgetRole, limit: number): void {
  entry.attempts[role] = Math.min(entry.attempts[role], limit - 1)
}

// On verify, the stage alone tells the next advance to verify again, so no
// earlier mark of a parked report or a cut-off implement run stays.
export function wake(entry: PrEntry, stage: RestingStage, at: IsoTime): void {
  if (stage === 'verify') {
    entry.reportUnchecked = false
    entry.implementCutOff = false
  }

  place(entry, stage, resting(entry, at), { since: at, fix: entry.fix })
}

// What a stage waits for once nothing stops it. A PR with a GitHub PR or a
// session and no fix owed resumes as a cut-off fix run would, so no fresh
// implement run replaces that work.
export function waitOnStage(entry: PrEntry, stage: OpenStage, at: IsoTime): void {
  if (stage === 'merge') {
    toMergeStatus(entry, at)
  } else if (stage === 'pre-verify') {
    place(entry, 'pre-verify', parkedReport(entry) ? GITHUB : claimWait(entry.claimedSha), { since: at })
  } else {
    if (stage === 'implement' && !entry.fix && (entry.pr || entry.sessionId)) {
      entry.reportUnchecked = false
      entry.implementCutOff = false
      entry.fix = noReport(at)
    }

    wake(entry, stage, at)
  }
}

// rollout retry on an obstacle: the maintainer removed its cause. The fix
// carries the obstacle and any fix the PR owed, so a lost session still has both.
export function retryFix(entry: PrEntry, at: IsoTime): void {
  const status = entry.status
  const question = status?.kind === 'needs-you' && status.code === 'obstacle' ? status.question : null
  const evidence = question?.evidence ? `Evidence: ${question.evidence}` : ''
  const note = [question?.text, evidence, entry.fix?.note].filter(Boolean).join('\n\n')

  toFix(entry, 'retry', note, { code: 'retry', at })
}

// rollout retry on a refused merge. With no stored verdict, the stored rule
// does not bring merge-refused back, and the gate judges the PR again.
export function retryMerge(entry: PrEntry, at: IsoTime): void {
  entry.gate = null
  place(entry, 'merge', GATE_PENDING, { since: at })
}

// A PR sent back to implement is no longer verified or approved.
export function dropVerification(entry: PrEntry): void {
  entry.verified = null
  entry.approved = null
}

// The merge delay counts from the approval.
export function approveInbox(entry: PrEntry, approval: StoredApproval, { until, at }: { until: IsoTime; at: IsoTime }): void {
  entry.approved = approval
  place(entry, 'merge', { kind: 'waiting', code: 'merge-delay', until }, { since: at })
}

// The status setters below write the stage and the status only, never the fix.

export function setStatus<At extends OpenStage>(entry: PrEntry, stage: At, status: Unstamped<StatusAt<At>>, at: IsoTime): void {
  write(entry, stage, status, at)
}

// The driver reserves a run's name after the run started.
export function runName(entry: PrEntry, run: string): void {
  const status = entry.status

  if (status?.kind === 'running' && 'run' in status) {
    entry.status = { ...status, run }
  }
}

// The reviewer takes over only while the writer's run is still the PR's.
export function reviewStarted(entry: PrEntry, { run, at }: { run: string; at: IsoTime }): void {
  if (entry.status?.kind === 'running' && entry.status.code === 'brief-write') {
    write(entry, 'brief', { kind: 'running', code: 'brief-review', run }, at)
  }
}

// The pass holds for its head and its command lists, across a restart too.
// The verifier then starts as a cut-off one would, once a slot is free and
// the claim is read again.
export function commandsPassed(entry: PrEntry, { sha, key, at }: CommitStamp & { key: string }): void {
  entry.commands = { sha, at, key }
  wake(entry, 'verify', at)
}

// Commands that neither passed nor sent the PR to a fix leave the claim waiting for a slot, to run again.
export function commandsEnded(entry: PrEntry, at: IsoTime): void {
  if (entry.status?.kind === 'running' && entry.status.code === 'commands') {
    write(entry, 'pre-verify', SLOT, at)
  }
}

// The gate's verdict of this tick, live from its facts.
export function gateVerdict(entry: PrEntry, verdict: StoredVerdict, facts: GateFacts, at: IsoTime): void {
  const status = verdictStatus(verdict, {
    head: facts.pr?.headRefOid ?? '',
    depsPending: facts.depsPending ?? [],
    missing: facts.checks?.missing ?? [],
    pending: facts.checks?.pending ?? [],
    baseSha: facts.mainChecks?.sha ?? '',
    failing: facts.mainChecks?.failing ?? [],
  })

  if (status) {
    write(entry, 'merge', status, at)
  }
}

// The stored rule of decision 37, for a PR on merge that no gate run decides.
export function mergeStatus(entry: PrEntry, at: IsoTime): void {
  const { status, since } = storedRule(entry, at)

  write(entry, 'merge', status, since)
}

// A PR in back-off waits it out, on the stages that have one.
export function backOffStatus(entry: PrEntry, at: IsoTime): void {
  if (entry.status?.kind === 'waiting' && restsOn(entry.stage)) {
    write(entry, entry.stage, resting(entry, at), at)
  }
}

// A hold turns a waiting status into held. A running or needs-you status stays as it is.
export function heldStatus(entry: PrEntry, scope: WaitingDetails['held']['scope'], at: IsoTime): void {
  if (entry.status?.kind === 'waiting') {
    write(entry, openStage(entry), { kind: 'waiting', code: 'held', scope }, at)
  }
}

export function holdPr(entry: PrEntry, hold: Hold): void {
  entry.hold = hold
  heldStatus(entry, 'pr', hold.at)
}

export function releasePr(entry: PrEntry): void {
  entry.hold = null
}

function parkedReport(entry: PrEntry): boolean {
  return entry.reportUnchecked && Boolean(entry.ready)
}

// A held status that no hold covers any more goes back to what its stage
// waits for without a decision. The next step that decides writes the rest.
export function unheld(entry: PrEntry, at: IsoTime): void {
  if (entry.status?.kind !== 'waiting' || entry.status.code !== 'held') {
    return
  }

  if (entry.stage === 'merge') {
    mergeStatus(entry, at)
  } else if (entry.stage === 'pre-verify' && parkedReport(entry)) {
    write(entry, 'pre-verify', GITHUB, at)
  } else {
    write(entry, openStage(entry), SLOT, at)
  }
}

// The migration from version 2. Only the code below reads the fields that version 3 removed.

// The state version 2 stored beside the stage and status.
export type VersionTwoState =
  | 'pending'
  | 'briefing'
  | 'implementing'
  | 'ready_claimed'
  | 'verifying'
  | 'verified'
  | 'needs_fix'
  | 'fixing'
  | 'blocked'
  | 'escalated'
  | 'interrupted'
  | 'merged'

// The fields version 3 removed.
interface VersionTwoFields {
  state: VersionTwoState
  held: Partial<Hold> | null
  interruptedRole: BudgetRole | 'report' | null
  blocked?: Partial<Blocked> | null
  escalation: string | null
  escalatedAt: IsoTime | null
}

type VersionTwoEntry = PrEntry & VersionTwoFields

// A version 2 entry as stored: an older driver filled no stage, and wrote none of the fields version 3 added.
type StoredVersionTwo = Omit<StoredFields, 'fix' | 'hold' | 'reportUnchecked' | 'implementCutOff' | 'delegate'> &
  VersionTwoFields & {
    stage?: Stage
    status?: Status | null
    fix?: Fix | null
    hold?: Hold | null
    delegate: Omit<StoredFields['delegate'], 'question'>
  }

// An event as the guesses read it. tsc reads no .mjs file, so the events come in as plain data.
interface StoredEvent {
  at?: IsoTime
  id?: string
  kind?: string
}

// The roles whose report can ask a question.
const ASKING_ROLES = ['brief', 'implement', 'fix'] as const satisfies readonly Role[]

interface MigrationContext {
  id: string
  briefWritten: boolean
  runs: Record<string, StoredRun> | null | undefined
  events: readonly (StoredEvent | string)[]
  at: IsoTime
}

const RUNNING_STATES: Record<RunningCode, VersionTwoState> = {
  'brief-write': 'briefing',
  'brief-review': 'briefing',
  implement: 'implementing',
  fix: 'fixing',
  verify: 'verifying',
  commands: 'ready_claimed',
  merge: 'verified',
  delegate: 'blocked',
}

const NEEDS_YOU_STATES: Record<NeedsYouCode, VersionTwoState> = {
  'brief-questions': 'blocked',
  decision: 'blocked',
  obstacle: 'blocked',
  dispute: 'escalated',
  'attempts-exhausted': 'escalated',
  errors: 'escalated',
  closed: 'blocked',
  'code-scanning-alerts': 'blocked',
  approve: 'verified',
  review: 'verified',
  'changes-requested': 'verified',
  'merge-by-hand': 'verified',
  'github-blocked': 'verified',
  'merge-refused': 'verified',
  'gate-blocked': 'blocked',
}

// A cut-off fix run and an owed fix both wait on implement with a fix. Only the reason tells them apart.
function implementWaiting(entry: PrEntry): VersionTwoState {
  if (entry.fix?.reason === 'no-report') {
    return 'interrupted'
  }

  return entry.fix ? 'needs_fix' : 'pending'
}

const WAITING_STATES: Record<OpenStage, (entry: PrEntry) => VersionTwoState> = {
  brief: () => 'pending',
  implement: implementWaiting,
  // A parked READY report waits for GitHub, under a hold too.
  'pre-verify': (entry) => (entry.reportUnchecked ? 'interrupted' : 'ready_claimed'),
  verify: () => 'interrupted',
  merge: () => 'verified',
}

// The version 2 state of an entry, from its stage, status and fix.
export function stateOf(entry: PrEntry): VersionTwoState {
  const { stage, status } = entry

  if (stage === 'merged') {
    return 'merged'
  }

  if (status?.kind === 'running') {
    return RUNNING_STATES[status.code]
  }

  if (status?.kind === 'needs-you') {
    return NEEDS_YOU_STATES[status.code]
  }

  return WAITING_STATES[stage](entry)
}

// A hold from before holds had an author is the maintainer's.
function holdOf(held: Partial<Hold> | null | undefined): Hold | null {
  if (!held) {
    return null
  }

  return { at: held.at ?? '', by: held.by ?? 'maintainer', reason: held.reason ?? null }
}

function sameHold(hold: Hold | null | undefined, held: Partial<Hold> | null | undefined): boolean {
  const expected = holdOf(held)

  if (!hold || !expected) {
    return !hold && !expected
  }

  return hold.at === expected.at && hold.by === expected.by && hold.reason === expected.reason
}

// The PR's last run of a role, by start.
function lastRun(context: MigrationContext, role: Role): { name: string; record: StoredRun } | null {
  let last: { name: string; record: StoredRun } | null = null

  for (const [name, record] of Object.entries(context.runs ?? {})) {
    const later = !last || (record.startedAt ?? '') >= (last.record.startedAt ?? '')

    if (record.id === context.id && record.role === role && later) {
      last = { name, record }
    }
  }

  return last
}

function lastRunName(context: MigrationContext, role: Role): string {
  return lastRun(context, role)?.name ?? ''
}

// A held PR waits for its release, whatever else it waits for.
function heldOr<Waiting>(entry: PrEntry, status: Waiting): Waiting | typeof HELD_PR {
  return entry.hold ? HELD_PR : status
}

function waitingIn(entry: PrEntry, at: IsoTime): Resting | typeof HELD_PR {
  return heldOr(entry, resting(entry, at))
}

// The fix a needs_fix or a fix escalation owes. A fix is never owed for a cut-off run.
function owedFix(entry: PrEntry, at: IsoTime): Fix {
  return { reason: fixReasonCode(entry.fixReason, entry.gate?.code), note: entry.fixNote ?? '', since: at }
}

function fillBriefing(entry: VersionTwoEntry, context: MigrationContext): void {
  const last = lastRun(context, 'brief')
  const code = last?.record.step === 'review' ? 'brief-review' : 'brief-write'

  place(entry, 'brief', { kind: 'running', code, run: last?.name ?? '' }, { since: context.at })
}

function fillFixing(entry: VersionTwoEntry, context: MigrationContext): void {
  const reason = entry.fixReason ? fixReasonCode(entry.fixReason, entry.gate?.code) : 'no-report'
  const fix = { reason, note: entry.fixNote ?? '', since: context.at }

  place(entry, 'implement', { kind: 'running', code: 'fix', reason, run: lastRunName(context, 'fix') }, { since: context.at, fix })
}

function closedStage(entry: PrEntry): Exclude<OpenStage, 'brief'> {
  if (entry.verified) {
    return 'merge'
  }

  return entry.claimedSha ? 'pre-verify' : 'implement'
}

function storedBlock(entry: VersionTwoEntry): Blocked {
  const blocked = entry.blocked ?? {}

  return { kind: blocked.kind ?? 'unknown', question: blocked.question ?? '', evidence: blocked.evidence ?? '', run: blocked.run ?? null }
}

function fillBlocked(entry: VersionTwoEntry, { at }: MigrationContext): void {
  const blocked = storedBlock(entry)
  const stored = gateBlockCode(entry.gate?.code) ? entry.gate : null

  placeBlock(entry, blocked, {
    since: at,
    fix: null,
    closedOn: closedStage(entry),
    gateBlock: { gate: gateBlockCode(stored?.code) ?? 'no-pr', reasons: stored?.reasons ?? [blocked.question] },
  })
}

// Where an escalation for errors waits: as far as the PR got.
function errorStage(entry: PrEntry, written: boolean): OpenStage {
  if (entry.verified) {
    return 'merge'
  }

  if (entry.claimedSha || parkedReport(entry)) {
    return 'pre-verify'
  }

  return entry.pr || entry.sessionId || written ? 'implement' : 'brief'
}

function fillEscalated(entry: VersionTwoEntry, context: MigrationContext): void {
  const { at } = context
  // As escalateExhausted spelled it in version 2.
  const role = BUDGET_ROLES.find((name) => entry.escalation === `${name} attempts exhausted`)

  if (role) {
    const limit = entry.attempts?.[role] ?? 0
    const fix = role === 'fix' ? owedFix(entry, at) : null

    place(entry, ROLE_STAGES[role], { kind: 'needs-you', code: 'attempts-exhausted', role, limit }, { since: at, fix })
  } else if (entry.escalation === DISPUTE) {
    place(entry, 'verify', { kind: 'needs-you', code: 'dispute', findings: [], text: entry.lastError ?? '' }, { since: at })
  } else {
    const status = { kind: 'needs-you', code: 'errors', error: entry.lastError ?? '', count: entry.tickErrors ?? 0 } as const

    place(entry, errorStage(entry, context.briefWritten), status, { since: at })
  }
}

function fillInterrupted(entry: VersionTwoEntry, { at }: MigrationContext): void {
  if (entry.interruptedRole === 'verify' && entry.claimedSha) {
    place(entry, 'verify', waitingIn(entry, at), { since: at })
  } else if (parkedReport(entry)) {
    place(entry, 'pre-verify', heldOr(entry, GITHUB), { since: at })
  } else {
    place(entry, 'implement', waitingIn(entry, at), { since: at, fix: noReport(at) })
  }
}

function fillMerged(entry: VersionTwoEntry): void {
  entry.stage = 'merged'
  entry.status = null
  entry.fix = null
}

// Each row gives back its own state through stateOf. A waiting status names
// no more than the ledger knows: the next advance writes what the PR waits for.
const FILLS: Record<VersionTwoState, (entry: VersionTwoEntry, context: MigrationContext) => void> = {
  pending: (entry, context) =>
    place(entry, context.briefWritten ? 'implement' : 'brief', waitingIn(entry, context.at), { since: context.at }),
  briefing: fillBriefing,
  implementing: (entry, context) =>
    place(entry, 'implement', { kind: 'running', code: 'implement', run: lastRunName(context, 'implement') }, { since: context.at }),
  fixing: fillFixing,
  needs_fix: (entry, { at }) => place(entry, 'implement', waitingIn(entry, at), { since: at, fix: owedFix(entry, at) }),
  ready_claimed: (entry, { at }) => place(entry, 'pre-verify', heldOr(entry, claimWait(entry.claimedSha)), { since: at }),
  verifying: (entry, context) => {
    const status = { kind: 'running', code: 'verify', sha: entry.claimedSha ?? '', run: lastRunName(context, 'verify') } as const

    place(entry, 'verify', status, { since: context.at })
  },
  verified: (entry, { at }) => {
    const { status, since } = storedRule(entry, at)

    place(entry, 'merge', status, { since })
  },
  blocked: fillBlocked,
  escalated: fillEscalated,
  interrupted: fillInterrupted,
  merged: fillMerged,
}

// A version 2 driver of this kind already wrote a stage, a status, a fix
// and a hold. They count while they still agree with its state and held.
function filled(entry: VersionTwoEntry): boolean {
  return Boolean(entry.stage) && stateOf(entry) === entry.state && sameHold(entry.hold, entry.held)
}

// The last run of the PR, in the order of the records, that ended at or
// before `before`, or at all with no `before`.
function endedRun(context: MigrationContext, roles: (role: Role) => boolean, before: IsoTime | undefined): string | null {
  let found: string | null = null

  for (const [name, record] of Object.entries(context.runs ?? {})) {
    const ended = Boolean(record.endedAt) && (!before || Date.parse(record.endedAt ?? '') <= Date.parse(before))

    if (record.id === context.id && roles(record.role) && ended) {
      found = name
    }
  }

  return found
}

function lastEventAt(context: MigrationContext, kind: VersionTwoState): IsoTime | undefined {
  const events = context.events.filter((event): event is StoredEvent => typeof event === 'object' && event !== null)

  return events.findLast((event) => event.id === context.id && event.kind === kind)?.at
}

// Version 2 stamped no block or escalation of an older driver, so the view
// guessed since when it waits and which run asked. The guesses are made once
// here, from the events and the run records.
function stampAsked(entry: VersionTwoEntry, context: MigrationContext): void {
  const status = entry.status

  if (status?.kind !== 'needs-you') {
    return
  }

  const question = statusQuestion(status)
  const escalation = listed(ESCALATION_CODES, status.code)

  if (!question && !escalation) {
    return
  }

  const eventAt = lastEventAt(context, question ? 'blocked' : 'escalated')
  const stamped = escalation ? entry.escalatedAt : null
  const since = stamped ?? eventAt ?? status.since

  if (question) {
    const blocked = entry.blocked
    const run =
      blocked && Object.hasOwn(blocked, 'run') ? (blocked.run ?? null) : endedRun(context, (role) => listed(ASKING_ROLES, role), eventAt)

    entry.status = { ...status, since, question: { ...question, run } } as Status
    return
  }

  entry.status = { ...status, since }

  if (!stamped) {
    entry.escalationRun = endedRun(context, (role) => role !== 'delegate', eventAt)
  }
}

// The entry of a ledger version 2, in place, as version 3 stores it. A stage,
// status, fix and hold that agree with the stored state and held stay.
// Otherwise they are filled from the fields version 3 removed, which then go.
export function fromVersionTwo(stored: StoredVersionTwo, context: MigrationContext): PrEntry {
  const entry = stored as unknown as VersionTwoEntry

  entry.reportUnchecked = entry.interruptedRole === 'report'
  entry.implementCutOff = entry.interruptedRole === 'implement'

  if (!filled(entry)) {
    const fill = FILLS[entry.state] ?? FILLS.pending

    entry.hold = holdOf(entry.held)
    fill(entry, context)
  }

  const running = entry.status?.kind === 'running' && entry.status.code === 'delegate'

  entry.delegate = { ...entry.delegate, question: running && entry.blocked ? questionOf(storedBlock(entry)) : null }
  stampAsked(entry, context)

  const removed: Partial<VersionTwoFields> = entry

  delete removed.state
  delete removed.interruptedRole
  delete removed.blocked
  delete removed.escalation
  delete removed.escalatedAt
  delete removed.held

  return entry
}
