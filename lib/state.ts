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

// Who acted. `github` is whoever acted on GitHub, outside the driver.
export const ACTORS = ['maintainer', 'driver', 'delegate', 'github'] as const
export type Actor = (typeof ACTORS)[number]

// Where an approval or a note came in: a command in the rollout's inbox, or GitHub.
export const CHANNELS = ['inbox', 'github'] as const
export type Channel = (typeof CHANNELS)[number]

// An ISO 8601 time in UTC, as toISOString() and GitHub write it. It is a plain
// string, because tsc cannot check the format of a time made at run time or read from JSON.
export type IsoTime = string

export type GitHubLogin = string

// Some members of a union. Unlike Extract, it refuses a member the union does not have.
type Subset<Union, Members extends Union> = Members

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
  'base-red': { code: 'base-red'; sha: string; failing: string[] }
  'base-pending': { code: 'base-pending'; sha: string }
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

export type RunningOf<Code extends RunningCode> = RunningDetails[Code] & StatusBase<'running'> & { run: string }
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
    waiting: ['github', 'ci', 'code-scanning-pending', 'slot', 'held'],
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
  process: { pid: number } | { container: string } | null
}

export const COMMANDS = ['approve', 'note', 'retry', 'hold', 'release'] as const
export type CommandName = (typeof COMMANDS)[number]

// What a command would do, computed from the ledger alone. The driver applies
// it, and the CLI and the UI print it before the command is sent.
export type CommandEffect =
  | { applies: true; stage: Stage; status: Status | null; drops: ('verification' | 'approval')[]; queued: boolean }
  | { applies: false; reason: string; instead: string | null }

export interface Ledger {
  version: 3
  prs: Record<string, Entry>
  runs: Record<string, RunRecord>
  hold: Hold | null
  githubUnavailable: { since: IsoTime; notified: boolean } | null
  lastMerge: (CommitStamp & { id: string; baseRedNotified: boolean }) | null
}
