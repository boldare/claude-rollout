// The state of one PR as data: where it is (stage) and what happens there
// (status). Nothing here decides anything. Erasable syntax only, so Node runs
// this file as it is and the lists below are the one place a code is spelled.

export const STAGES = ['brief', 'implement', 'pre-verify', 'verify', 'merge', 'merged'] as const
export type Stage = (typeof STAGES)[number]
export type OpenStage = Exclude<Stage, 'merged'>

export const STATUS_KINDS = ['running', 'waiting', 'needs-you'] as const
export type StatusKind = (typeof STATUS_KINDS)[number]

// A run's role. The delegate has no attempts of its own, only a run count.
export const ROLES = ['brief', 'implement', 'fix', 'verify', 'delegate'] as const
export type Role = (typeof ROLES)[number]
export type BudgetRole = Exclude<Role, 'delegate'>

// Who acted. `github` is whoever acted on GitHub, outside the driver. `agent`
// is any other agent the driver runs: a brief writer, an implementer or a verifier.
export const ACTORS = ['maintainer', 'driver', 'delegate', 'github', 'agent'] as const
export type Actor = (typeof ACTORS)[number]

// Where an approval or a note came in: a command in the rollout's inbox, or GitHub.
export const CHANNELS = ['inbox', 'github'] as const
export type Channel = (typeof CHANNELS)[number]

// An ISO 8601 time in UTC, as toISOString() and GitHub write it. It is a plain
// string, because tsc cannot check the format of a time made at run time or read from JSON.
export type IsoTime = string

export type GitHubLogin = string

// Some members of a union. Unlike Extract, it refuses a member the union does not have.
export type Subset<Union, Members extends Union> = Members

// Why the implementer is sent back. A fix in progress keeps its reason when a
// note joins it or its run fails.
export const FIX_REASONS = [
  'verifier-findings',
  'ci-red',
  'ci-stalled',
  'policy',
  'scope',
  'commands',
  'code-scanning',
  'report-mismatch',
  'worktree',
  'rebase-conflict',
  'maintainer-note',
  'maintainer-review',
  'delegate-answer',
  'retry',
  'no-report',
] as const
export type FixReason = (typeof FIX_REASONS)[number]

export interface Fix {
  reason: FixReason
  note: string
  since: IsoTime
}

// One brake, in two scopes: on a PR and on the rollout. The driver holds the
// rollout itself on an account limit.
export interface Hold {
  at: IsoTime
  by: Subset<Actor, 'maintainer' | 'driver'>
  reason: string | null
}

export interface Head {
  id: string
  sha: string
  patchId: string | null
}

// What an agent asked, as its READY schema names it, or what the brief's agents asked.
export const QUESTION_KINDS = [
  'brief-questions',
  'needs-decision',
  'brief-contradiction',
  'stuck',
  'ci',
  'environment',
  'code-scanning',
  'unknown',
] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

export interface Question {
  kind: QuestionKind
  text: string
  evidence: string
  run: string | null
  // Set once the delegate handed the question back or failed on it.
  delegate: { outcome: 'escalated' | 'failed'; reason: string } | null
}

// The gate's block codes. Each is a fact on GitHub that the driver reads again every tick.
export const GATE_BLOCK_CODES = ['no-pr', 'pr-not-open', 'never-merge', 'draft', 'wrong-base', 'wrong-head', 'missing-label'] as const
export type GateBlockCode = (typeof GATE_BLOCK_CODES)[number]

// Every status code with the data its sentence needs. A code is added here
// and nowhere else: the stage unions, the sentences and the tests follow.
export interface RunningDetails {
  'brief-write': { code: 'brief-write' }
  'brief-review': { code: 'brief-review' }
  implement: { code: 'implement' }
  fix: { code: 'fix'; reason: FixReason }
  delegate: { code: 'delegate'; question: QuestionKind }
  commands: { code: 'commands'; sha: string }
  verify: { code: 'verify'; sha: string }
  merge: { code: 'merge'; sha: string }
}

export interface WaitingDetails {
  slot: { code: 'slot' }
  backoff: { code: 'backoff'; until: IsoTime; failures: number }
  held: { code: 'held'; scope: 'pr' | 'rollout' }
  dependencies: { code: 'dependencies'; on: string[] }
  'dependencies-merge': { code: 'dependencies-merge'; heads: Head[] }
  'outside-dependency': { code: 'outside-dependency'; on: string[] }
  github: { code: 'github' }
  ci: { code: 'ci'; sha: string; missing: string[]; pending: string[] }
  'code-scanning-pending': { code: 'code-scanning-pending'; sha: string }
  'external-review': { code: 'external-review'; sha: string }
  'base-red': { code: 'base-red'; sha: string; failing: string[] }
  'base-pending': { code: 'base-pending'; sha: string }
  'gate-pending': { code: 'gate-pending' }
  'mergeable-unknown': { code: 'mergeable-unknown' }
  'github-merge-state': { code: 'github-merge-state'; mergeState: string }
  'merge-delay': { code: 'merge-delay'; until: IsoTime }
  queued: { code: 'queued'; after: number }
  'review-in-progress': { code: 'review-in-progress'; lastCommentAt: IsoTime }
}

export interface NeedsYouDetails {
  'brief-questions': { code: 'brief-questions'; question: Question }
  decision: { code: 'decision'; question: Question }
  obstacle: { code: 'obstacle'; question: Question }
  dispute: { code: 'dispute'; findings: string[]; text: string }
  'attempts-exhausted': { code: 'attempts-exhausted'; role: BudgetRole; limit: number }
  errors: { code: 'errors'; error: string; count: number }
  closed: { code: 'closed' }
  'code-scanning-alerts': { code: 'code-scanning-alerts'; alerts: string[] }
  approve: { code: 'approve' }
  review: { code: 'review'; stale: boolean }
  'changes-requested': { code: 'changes-requested' }
  'merge-by-hand': { code: 'merge-by-hand'; mergeState: string }
  'github-blocked': { code: 'github-blocked' }
  'merge-refused': { code: 'merge-refused'; error: string }
  'gate-blocked': { code: 'gate-blocked'; gate: GateBlockCode; reasons: string[] }
}

export type RunningCode = keyof RunningDetails
export type WaitingCode = keyof WaitingDetails
export type NeedsYouCode = keyof NeedsYouDetails

// What every status carries, whatever its kind.
export interface StatusBase<Kind extends StatusKind> {
  kind: Kind
  since: IsoTime
}

// The driver's own work. No agent runs under these codes, so they name no run.
export type OwnWorkCode = Subset<RunningCode, 'commands' | 'merge'>

export type RunningOf<Code extends RunningCode> = Code extends OwnWorkCode
  ? RunningDetails[Code] & StatusBase<'running'>
  : RunningDetails[Code] & StatusBase<'running'> & { run: string }
export type WaitingOf<Code extends WaitingCode> = WaitingDetails[Code] & StatusBase<'waiting'>
export type NeedsYouOf<Code extends NeedsYouCode> = NeedsYouDetails[Code] & StatusBase<'needs-you'>

// What takes a needs-you status away. The CLI and the UI print it beside the status.
export type WayOut = 'note' | 'retry' | 'retry-or-note' | 'approve' | 'github'

export const WAY_OUT: Record<NeedsYouCode, WayOut> = {
  'brief-questions': 'note',
  decision: 'note',
  dispute: 'note',
  obstacle: 'retry-or-note',
  'attempts-exhausted': 'retry-or-note',
  errors: 'retry',
  'merge-refused': 'retry',
  approve: 'approve',
  review: 'github',
  'changes-requested': 'github',
  'merge-by-hand': 'github',
  'github-blocked': 'github',
  'gate-blocked': 'github',
  'code-scanning-alerts': 'github',
  closed: 'github',
}

// The codes each stage can have, as data: the types below, the sentences and
// the parity test all read this one table. A hold turns a waiting status into
// `held`. On a running or needs-you status it shows as a marker from `hold`.
export const STAGE_STATUSES = {
  brief: {
    running: ['brief-write', 'brief-review', 'delegate'],
    waiting: ['dependencies', 'dependencies-merge', 'outside-dependency', 'slot', 'backoff', 'held'],
    'needs-you': ['brief-questions', 'attempts-exhausted', 'errors'],
  },
  implement: {
    running: ['implement', 'fix', 'delegate'],
    waiting: ['dependencies', 'outside-dependency', 'slot', 'backoff', 'held'],
    'needs-you': ['decision', 'obstacle', 'attempts-exhausted', 'errors', 'closed'],
  },
  'pre-verify': {
    running: ['commands'],
    waiting: ['github', 'ci', 'code-scanning-pending', 'external-review', 'slot', 'held'],
    'needs-you': ['code-scanning-alerts', 'errors', 'closed'],
  },
  verify: {
    running: ['verify'],
    waiting: ['slot', 'backoff', 'held'],
    'needs-you': ['dispute', 'attempts-exhausted', 'errors', 'closed'],
  },
  merge: {
    running: ['merge'],
    waiting: [
      'dependencies',
      'ci',
      'base-red',
      'base-pending',
      'gate-pending',
      'mergeable-unknown',
      'github-merge-state',
      'code-scanning-pending',
      'merge-delay',
      'queued',
      'review-in-progress',
      'held',
    ],
    'needs-you': [
      'approve',
      'review',
      'changes-requested',
      'merge-by-hand',
      'github-blocked',
      'merge-refused',
      'gate-blocked',
      'code-scanning-alerts',
      'errors',
      'closed',
    ],
  },
} as const satisfies Record<
  OpenStage,
  { running: readonly RunningCode[]; waiting: readonly WaitingCode[]; 'needs-you': readonly NeedsYouCode[] }
>

type CodesAt<At extends OpenStage, Kind extends StatusKind> = (typeof STAGE_STATUSES)[At][Kind][number]

export type StatusAt<At extends OpenStage> =
  RunningOf<CodesAt<At, 'running'>> | WaitingOf<CodesAt<At, 'waiting'>> | NeedsYouOf<CodesAt<At, 'needs-you'>>

export type BriefStatus = StatusAt<'brief'>
export type ImplementStatus = StatusAt<'implement'>
export type PreVerifyStatus = StatusAt<'pre-verify'>
export type VerifyStatus = StatusAt<'verify'>
export type MergeStatus = StatusAt<'merge'>
export type Status = StatusAt<OpenStage>

// What the view may show in place of a stored status: a dead driver cannot write one.
export type ShownStatus = Status | (StatusBase<'waiting'> & { code: 'driver-stopped' })

// A commit, and when the driver recorded something about it.
export interface CommitStamp {
  sha: string
  at: IsoTime
}

// A READY report's claim, as the driver confirmed it on GitHub. The patch id is
// null until pre-verify computes it. Verify and merge require it.
export interface Claim extends CommitStamp {
  patchId: string | null
}

// A PASS binds the patch, not the head: the same patch on a new head keeps it.
export interface Verification extends CommitStamp {
  patchId: string
  run: string
}

export interface Approval extends CommitStamp {
  patchId: string
  channel: Channel
  // The maintainer who approved on GitHub. Null for an approval from the inbox.
  by: GitHubLogin | null
}

export interface Merged {
  by: Subset<Actor, 'driver' | 'github'>
  at: IsoTime
  // Null when GitHub did not give the merge commit back.
  sha: string | null
  // Where the PR was when it merged, so a merge before verification stays visible.
  from: OpenStage
  verified: boolean
}

export interface Finding {
  id: string
  text: string
  answer: { outcome: 'fixed' | 'disputed'; action: string } | null
  // The key of the external review's finding a confirmed candidate came from. Missing on every other finding.
  fromReview?: string
}

export const REVIEW_SEVERITIES = ['high', 'medium', 'low'] as const
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number]

// One finding of an external review as review.json gives it, with its texts cut to their limits.
export interface ReviewFinding {
  severity: ReviewSeverity
  criterion: string
  title: string
  file: string
  line: number
  failureScenario: string
  fix: string
  // Whether the review's previous run reported it too. Null in the list of fixed ones.
  status: 'new' | 'open' | null
}

// What the driver read for one head. It lives as long as the claim: a new head drops it.
export interface Review extends CommitStamp {
  // The review's check run this result came from, so a new run of the same head is read again.
  run: number | null
  // The commit the review read when its result was carried to this head. Line numbers refer to it.
  reusedFrom: string | null
  // Why there is no result. Null when the file was read.
  skipped: string | null
  findings: ReviewFinding[]
  fixed: ReviewFinding[]
  // How many findings the file had beyond the 50 the driver keeps.
  leftOut: number
  // The candidates fixed at the launch of the last verifier of this head. The prompt and the judgment of the verdict read this list.
  candidates: { id: string; key: string }[]
}

// What the driver remembers of a PR's reviews. It lives as long as the PR.
export interface ReviewMemory {
  // The keys that went to a verifier, whatever it answered. The last 500.
  sent: string[]
  // The last 200. `blob` is the file's blob id at the head the verifier read, null when the file was not there.
  refuted: { key: string; blob: string | null; evidence: string; run: string; at: IsoTime }[]
}

export const CANDIDATE_RESULTS = ['confirmed', 'refuted', 'unverifiable', 'unanswered'] as const
export type CandidateResult = (typeof CANDIDATE_RESULTS)[number]

export type SentCandidate = ReviewFinding & { id: string; key: string }

// A candidate the verifier left out is unanswered, with no evidence.
export type CandidateAnswer = SentCandidate & { result: CandidateResult; evidence: string }

export const VERDICTS = ['PASS', 'FAIL'] as const
export type VerdictValue = (typeof VERDICTS)[number]

export const RECHECK_RESULTS = ['resolved', 'open', 'wrong'] as const
export type RecheckResult = (typeof RECHECK_RESULTS)[number]

export const CRITERION_LEVELS = ['required', 'recommended'] as const
export type CriterionLevel = (typeof CRITERION_LEVELS)[number]

export const CRITERION_RESULTS = ['pass', 'fail', 'unverifiable'] as const
export type CriterionResult = (typeof CRITERION_RESULTS)[number]

export const MERGE_POLICIES = ['human', 'manual', 'auto'] as const
export type MergePolicy = (typeof MERGE_POLICIES)[number]

// The trace of a PR, as schemas/trace.json spells it for a tool that audits merges. Its members are snake_case
// because the contract is read outside this repo. A fact the ledger does not hold is still written, as null, 0 or [].
export interface TracePr {
  id: string
  number: number | null
  base: string | null
  author: GitHubLogin | null
}

export interface TracePolicy {
  merge: MergePolicy
  approval: Channel
}

export interface TracePlace {
  stage: Stage
  status: StatusKind | null
  code: string | null
}

export interface TraceRun {
  run: string
  role: Role
  step: string | null
  effort: string | null
  // The model that ran, null until the run ends.
  model: string | null
  sha: string | null
  started_at: IsoTime | null
  ended_at: IsoTime | null
  seconds: number | null
  cost_usd: number
  ok: boolean | null
  result: string | null
}

export interface TraceCost {
  total_usd: number
  // Only the roles that have a run.
  by_role: Partial<Record<Role, number>>
}

export interface TraceVerified {
  sha: string | null
  patch_id: string | null
  at: IsoTime
}

export interface TraceCriterion {
  id: string
  level: CriterionLevel
  result: CriterionResult
}

export interface TraceRecheck {
  // The F id the verifier answered, null when it is not one.
  finding: string | null
  result: RecheckResult
  // Whether the finding came from the external review. Null when the record does not say.
  from_review: boolean | null
}

export interface TraceVerification {
  run: string | null
  sha: string | null
  at: IsoTime | null
  verdict: VerdictValue
  blocking: number
  criteria: TraceCriterion[]
  rechecks: TraceRecheck[]
}

export interface TraceReview {
  sha: string | null
  run: number | null
  skipped: string | null
  reused_from: string | null
  findings: number
  candidates: number
}

export interface TraceAnswer {
  run: string | null
  sha: string | null
  id: string
  result: CandidateResult
}

export interface TraceFindingRecheck {
  run: string | null
  sha: string | null
  result: RecheckResult
}

export interface TraceReviewFinding {
  criterion: string | null
  file: string | null
  title: string | null
  severity: ReviewSeverity
  answers: TraceAnswer[]
  rechecks: TraceFindingRecheck[]
}

export interface TraceApproval {
  channel: Channel | null
  by: GitHubLogin | null
  sha: string | null
  patch_id: string | null
  at: IsoTime
  github_review: number | null
}

export interface TraceMerged {
  sha: string | null
  at: IsoTime
  by: Merged['by']
}

// A fact the trace leaves out, once per field. A reader matches on the field.
export interface TraceMissing {
  field: string
  reason: string
}

export interface Trace {
  schema_version: 1
  updated_at: IsoTime
  pr: TracePr
  policy: TracePolicy
  place: TracePlace
  head: string | null
  attempts: Record<BudgetRole, number>
  runs: TraceRun[]
  cost: TraceCost
  verified: TraceVerified | null
  verifications: TraceVerification[]
  review: TraceReview | null
  review_findings: TraceReviewFinding[]
  approval: TraceApproval | null
  merged: TraceMerged | null
  missing: TraceMissing[]
}

// The comment that carries a PR's trace, as an entry is to record it.
export interface TraceRecord {
  // The id of the comment that carries the trace, or null before the first write.
  comment: number | null
  // The digest of the trace written last.
  digest: string | null
  at: IsoTime | null
  // The last write's error, or null once a write went through.
  error: string | null
}

export interface NoteRecord {
  at: IsoTime
  by: Subset<Actor, 'maintainer' | 'delegate'>
  channel: Channel
  text: string
  // What it answered, when the PR waited on a question or a dispute.
  answers: NeedsYouCode | null
  // The run that first read it. Null while it waits in the queue.
  run: string | null
}

// What every entry carries, whatever its stage.
export interface EntryBase<At extends Stage = Stage> {
  stage: At
  attempts: Record<BudgetRole, number>
  refunds: number
  failures: number
  hold: Hold | null
  notes: NoteRecord[]
  costUsd: number
  author: GitHubLogin | null
  lastError: string | null
}

export interface BriefEntry extends EntryBase<'brief'> {
  status: BriefStatus
  pr: null
  answers: { question: string | null; answer: string }[]
}

// A fix is owed exactly when `fix` is set. Without one the next run is the first implement run.
export interface ImplementEntry extends EntryBase<'implement'> {
  status: ImplementStatus
  pr: number | null
  sessionId: string | null
  fix: Fix | null
  findings: Finding[]
  claim: Claim | null
}

export interface PreVerifyEntry extends EntryBase<'pre-verify'> {
  status: PreVerifyStatus
  pr: number
  sessionId: string | null
  claim: Claim
  // The commands' pass for this head, kept so a restart does not run them again.
  commands: (CommitStamp & { key: string }) | null
}

export interface VerifyEntry extends EntryBase<'verify'> {
  status: VerifyStatus
  pr: number
  sessionId: string | null
  claim: Claim & { patchId: string }
  findings: Finding[]
}

export interface MergeEntry extends EntryBase<'merge'> {
  status: MergeStatus
  pr: number
  sessionId: string | null
  claim: Claim & { patchId: string }
  verification: Verification
  approval: Approval | null
}

export interface MergedEntry extends EntryBase<'merged'> {
  status: null
  pr: number | null
  merged: Merged
}

// Entry and Ledger are the shape the stored ledger moves to. Version 3 takes
// only an entry's stage and status from it, so the comments on its members describe that later shape.
export type Entry = BriefEntry | ImplementEntry | PreVerifyEntry | VerifyEntry | MergeEntry | MergedEntry

// How a run ended, by role. Every result has one row in the transition table.
export type RunFailure = 'stopped' | 'transient' | 'account-limit' | 'session-missing' | 'error'
export type BriefResult = 'written' | 'questions' | 'preview-conflict' | 'failed'
export type ImplementResult = 'ready' | 'blocked' | 'failed'
export type ReportCheck = 'claimed' | 'report-mismatch' | 'github-unavailable'
export type CommandsResult = 'passed' | 'failed-required' | 'dropped'
export type VerifyResult = 'pass' | 'fail' | 'dispute' | 'pass-discarded' | 'stale' | 'failed'
export type DelegateResult = 'answer' | 'escalate' | 'failed' | 'dropped'

// One run in the ledger. `process` lets the next driver end a run that outlived the last one.
export interface RunRecord {
  run: string
  id: string
  role: Role
  startedAt: IsoTime
  endedAt: IsoTime | null
  process: { pid: number; startTime: string } | { container: string } | null
}

export const COMMANDS = ['approve', 'note', 'retry', 'hold', 'release'] as const
export type CommandName = (typeof COMMANDS)[number]

// What a command takes from a PR it sends back to implement.
export type Drop = 'verification' | 'approval'

// What a command would do, computed from the ledger alone. The driver applies
// it, and the CLI and the UI print it before the command is sent.
export type CommandEffect =
  | { applies: true; stage: Stage; status: Status | null; drops: Drop[]; queued: boolean }
  | { applies: false; reason: string; instead: string | null }

export interface Ledger {
  version: 3
  prs: Record<string, Entry>
  runs: Record<string, RunRecord>
  hold: Hold | null
  githubUnavailable: { since: IsoTime; notified: boolean } | null
  lastMerge: (CommitStamp & { id: string; baseRedNotified: boolean }) | null
}
