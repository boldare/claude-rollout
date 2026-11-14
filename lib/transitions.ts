import type { BudgetRole, CommitStamp, Head, IsoTime, QuestionKind } from './state.ts'

// The values of STATES in kinds.mjs. tsc reads no .mjs file (no allowJs), and
// state.ts types ledger version 3, which has stage and status in place of a
// state. So they are spelled again here until version 3 removes both lists.
type State =
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

// QuestionKind has no closed or gate, because version 3 makes them statuses.
interface Blocked {
  kind: QuestionKind | 'closed' | 'gate'
  question: string
  evidence: string
  run: string | null
}

interface Verification extends CommitStamp {
  patchId?: string | null
}

interface BriefAnswer {
  question: string | null
  answer: string
}

// The version 2 fields this module reads or writes. The optional ones are
// missing from an entry until the driver first sets them.
interface PrEntry {
  state: State
  attempts: Record<BudgetRole, number>
  interruptedRole: BudgetRole | 'report' | null
  blocked?: Blocked | null
  escalation: string | null
  escalatedAt: IsoTime | null
  escalationRun: string | null
  fixReason?: string
  fixNote?: string
  verified: Verification | null
  findings: unknown
  ready: unknown
  pr: number | null
  sessionId: string | null
  claimedSha: string | null
  claimedAt: IsoTime | null
  claimPatchId?: string | null
  ciPendingSince?: IsoTime | null
  briefAnswers: BriefAnswer[]
  briefScope?: string[]
  briefHeads: Head[]
  briefAt?: IsoTime
  previewConflict: string | null
  failStreak?: number
  lastError: string | null
  mergeSha?: string
}

// PR states:
//   pending → implementing → ready_claimed → verifying → verified → merged
//   needs_fix → fixing → ready_claimed      (CI red, policy, verifier, gate, conflict)
//   interrupted → fixing | verifying        (a run ended without a report)
//   blocked, escalated                      (waiting for a human: /rollout note|retry)
//   pending → briefing → pending             (no brief yet: writer + reviewer agents)
//   held is a flag on any state: no runs, rebases, ready notices or merges until release
export const RUNNING: Partial<Record<State, BudgetRole>> = {
  implementing: 'implement',
  fixing: 'fix',
  verifying: 'verify',
  briefing: 'brief',
}

export const DISPUTE = 'disputed finding'

const STARTED: Record<BudgetRole, State> = { brief: 'briefing', implement: 'implementing', fix: 'fixing', verify: 'verifying' }

// The verifier still finds open what the implementer disputed. A note or a
// retry sends the PR to a fix run with the findings.
export function escalatedOverDispute(entry: PrEntry): boolean {
  return entry.state === 'escalated' && entry.escalation === DISPUTE
}

// A PR sent to a fix run is no longer verified, so a retry can never send
// the unchanged patch back to the gate and drop the fix it was sent for.
export function toFix(entry: PrEntry, reason: string, note: string): void {
  entry.state = 'needs_fix'
  entry.fixReason = reason
  entry.fixNote = note
  entry.verified = null
}

export function joinFix(entry: PrEntry, note: string): void {
  entry.fixNote = `${entry.fixNote ?? ''}\n\n${note}`
}

export function answerBrief(entry: PrEntry, question: string | null, text: string): void {
  entry.state = 'pending'
  entry.briefAnswers = [...(entry.briefAnswers ?? []), { question, answer: text }]
  entry.attempts.brief = Math.max(0, entry.attempts.brief - 1)
  entry.blocked = null
}

export function toPending(entry: PrEntry): void {
  entry.state = 'pending'
}

export function briefWaits(entry: PrEntry, key: string): void {
  entry.state = 'pending'
  entry.attempts.brief = Math.max(0, entry.attempts.brief - 1)
  entry.previewConflict = key
}

export function briefWritten(entry: PrEntry, { scope, heads, at }: { scope: string[]; heads: Head[]; at: IsoTime }): void {
  entry.state = 'pending'
  entry.briefScope = scope
  entry.briefHeads = heads
  entry.previewConflict = null
  entry.briefAt = at
  entry.briefAnswers = []
  entry.failStreak = 0
}

export function runStarted(entry: PrEntry, role: BudgetRole): void {
  entry.state = STARTED[role]
}

export function runFailed(entry: PrEntry, role: BudgetRole): void {
  entry.state = 'interrupted'
  entry.interruptedRole = role
}

export function reportWaits(entry: PrEntry): void {
  entry.state = 'interrupted'
  entry.interruptedRole = 'report'
}

export function reportUsed(entry: PrEntry): void {
  entry.interruptedRole = null
}

export function toClaimed(entry: PrEntry, { pr, sha, at }: CommitStamp & { pr: number }): void {
  entry.state = 'ready_claimed'
  entry.pr = pr
  entry.claimedSha = sha
  entry.claimedAt = at
  entry.ciPendingSince = null
  entry.verified = null
}

export function claimNewHead(entry: PrEntry, { sha, at }: CommitStamp): void {
  entry.state = 'ready_claimed'
  entry.verified = null
  entry.claimedSha = sha
  entry.claimedAt = at
  entry.ciPendingSince = null
}

export function verifyAgain(entry: PrEntry): void {
  entry.state = 'ready_claimed'
}

export function toVerified(entry: PrEntry, { sha, at }: CommitStamp): void {
  entry.state = 'verified'
  entry.verified = { sha, patchId: entry.claimPatchId, at }
  entry.attempts.verify = 0
  entry.findings = null
}

export function toBlocked(entry: PrEntry, blocked: Blocked): void {
  entry.state = 'blocked'
  entry.blocked = blocked
}

export function escalateExhausted(
  entry: PrEntry,
  { role, limit, at, run }: { role: BudgetRole; limit: number; at: IsoTime; run: string | null },
): void {
  entry.state = 'escalated'
  entry.escalation = `${role} attempts exhausted`
  entry.escalatedAt = at
  entry.escalationRun = run
  entry.lastError = `${role} attempts exhausted (${limit})`
}

export function escalateDispute(
  entry: PrEntry,
  { note, text, at, run }: { note: string; text: string; at: IsoTime; run: string | null },
): void {
  entry.state = 'escalated'
  entry.escalation = DISPUTE
  entry.escalatedAt = at
  entry.escalationRun = run
  entry.verified = null
  entry.fixReason = 'verifier findings'
  entry.fixNote = note
  entry.lastError = text
}

export function escalateErrors(entry: PrEntry, { at, run }: { at: IsoTime; run: string | null }): void {
  entry.state = 'escalated'
  entry.escalation = 'repeated errors'
  entry.escalatedAt = at
  entry.escalationRun = run
}

export function toMerged(entry: PrEntry, { mergeSha, pr }: { mergeSha?: string; pr?: number } = {}): void {
  entry.state = 'merged'

  if (mergeSha !== undefined) {
    entry.mergeSha = mergeSha
  }

  if (pr !== undefined) {
    entry.pr = pr
  }
}

// For a run state whose run is gone: the driver restarted, or its onDone threw.
export function recoverRun(entry: PrEntry, { refund }: { refund: boolean }): BudgetRole | null {
  const role = RUNNING[entry.state]

  if (!role) {
    return null
  }

  if (role === 'brief') {
    entry.state = 'pending'
  } else {
    entry.state = 'interrupted'
    entry.interruptedRole = role
  }

  if (refund) {
    entry.attempts[role] = Math.max(0, entry.attempts[role] - 1)
  }

  return role
}

// Where a retried PR picks up. A dispute the verifier upheld goes to a fix
// run with the findings. A verification that still holds goes back to the
// gate: sync compares the head with GitHub's first, and the gate refuses a
// stale patch anyway. One for an older head is checked again from the
// claim. A parked READY report needs no agent.
export function resumeAfterRetry(entry: PrEntry): void {
  if (escalatedOverDispute(entry)) {
    entry.state = 'needs_fix'
    entry.interruptedRole = null
  } else if (entry.pr && entry.verified && entry.verified.sha === entry.claimedSha) {
    entry.state = 'verified'
    entry.interruptedRole = null
  } else if (entry.pr && entry.verified) {
    entry.verified = null
    entry.ciPendingSince = null
    entry.state = 'ready_claimed'
    entry.interruptedRole = null
  } else if (entry.interruptedRole === 'report' && entry.ready) {
    entry.state = 'interrupted'
  } else {
    entry.state = entry.pr || entry.sessionId ? 'interrupted' : 'pending'
    entry.interruptedRole = entry.claimedSha && !entry.verified ? 'verify' : 'fix'
  }
}
