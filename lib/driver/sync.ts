import * as transitions from '../transitions.ts'
import type { PrEntry } from '../transitions.ts'
import type { Hold, IsoTime, Merged, NeedsYouCode, OpenStage } from '../state.ts'
import { applyNote } from './commands.ts'
import type { CommandsContext } from './commands.ts'
import type { RunPr } from './runs.ts'

// What the PR is on GitHub: a merge, a close or a reopen made there, a head
// that moved after the verification, and the maintainer's review comments.
// Each sets the PR's stage and status through lib/transitions.ts. Nothing here
// reads the clock, the disk or GitHub itself: the context brings it, as
// lib/driver.mjs builds it.

// The needs-you statuses the gate reads again every tick. A review in
// progress shows over them, and only rollout retry takes the others away.
const GATE_READS = [
  'approve',
  'review',
  'changes-requested',
  'merge-by-hand',
  'github-blocked',
  'gate-blocked',
  'code-scanning-alerts',
] as const satisfies readonly NeedsYouCode[]

type Say = (id: string, kind: string, detail?: object, message?: string | null) => void

export interface SyncManifest {
  repo: { maintainers: string[] }
  policy: { feedbackQuietMinutes: number }
}

// A PR as viewPr in lib/github.mjs returns it, as far as sync reads it.
interface GitHubPr {
  state: string
  headRefOid: string
  labels: string[]
  author: string | null
  mergedAt: IsoTime | null
}

// What sync reads of the facts the gate collects.
interface HeadFacts {
  pr: { headRefOid: string } | null
  patchId: string | null
}

// A maintainer's comment as feedbackFor in lib/github.mjs returns it.
interface FeedbackItem {
  id: string
  commentId?: number | string | null
  at: IsoTime
  body: string
  path?: string | null
  line?: number | null
  hunk?: string | null
}

// The fields of an entry this module reads beside the ones transitions.ts types.
export interface SyncEntry extends PrEntry {
  author?: string | null
  stageLabels?: string[]
  feedbackSeen?: string[]
  feedbackInFix?: { id: string; commentId: number | string | null; body: string }[]
  feedbackWaiting?: boolean
}

interface SyncLedger {
  data: { hold: Hold | null; lastMerge?: { id: string; sha: string; at: IsoTime } | null }
  prs: Record<string, SyncEntry>
}

// The context lib/driver.mjs builds once. tsc reads no .mjs file, so every
// function of a .mjs module comes in here, typed by what this module passes and reads.
export interface SyncContext {
  manifest: SyncManifest
  ledger: SyncLedger
  running: CommandsContext['running']
  commandContext: CommandsContext
  say: Say
  now: () => IsoTime
  cleanup: (pr: RunPr) => Promise<unknown>
  // Stops the agent run of the PR. The run's own end cleans up after it.
  stopRun: (id: string) => void
  // The GitHub reads of the running tick, null between ticks.
  reads: () => unknown
  localConfigRemoved: (pr: RunPr, paths: string[] | null | undefined) => void
  ourLabel: (label: string) => boolean
  collectFacts: (manifest: SyncManifest, pr: RunPr, entry: SyncEntry, ledger: SyncLedger, options: { reads: unknown }) => Promise<HeadFacts>
  github: {
    viewPr: (manifest: SyncManifest, number: number, options: { reads: unknown }) => Promise<GitHubPr>
    mergeCommit: (manifest: SyncManifest, number: number) => Promise<string | null>
    feedbackFor: (manifest: SyncManifest, number: number, options: { reads: unknown }) => Promise<FeedbackItem[]>
  }
  worktree: {
    alignWorktree: (manifest: SyncManifest, pr: RunPr, sha: string) => Promise<{ removed?: string[] }>
  }
}

// What reverify reads, so the gate can call it with its own context.
interface ReverifyContext {
  ledger: { prs: Record<string, PrEntry> }
  say: Say
  now: () => IsoTime
}

function listed(list: readonly string[], value: string): boolean {
  return list.includes(value)
}

function isClosed(entry: PrEntry): boolean {
  return entry.status?.kind === 'needs-you' && entry.status.code === 'closed'
}

function minutesSince({ now }: SyncContext, iso: IsoTime): number {
  return (Date.parse(now()) - Date.parse(iso)) / 60_000
}

// GitHub wins: merges, closes, reopens and moved heads made outside the driver.
export async function sync(context: SyncContext, pr: RunPr): Promise<void> {
  const { manifest, ledger, running } = context
  const entry = ledger.prs[pr.id]
  const number = entry.pr

  if (!number || entry.stage === 'merged') {
    return
  }

  const githubPr = await context.github.viewPr(manifest, number, { reads: context.reads() })
  entry.author = githubPr.author
  // What the PR really carries: a label removed or added by hand is put
  // right on the next label sync.
  entry.stageLabels = githubPr.labels.filter((label) => context.ourLabel(label))

  if (githubPr.state === 'MERGED') {
    await merged(context, pr, { number, from: entry.stage, githubPr })
    return
  }

  if (running.has(pr.id)) {
    return
  }

  if (githubPr.state === 'CLOSED') {
    closed(context, pr, number)
    return
  }

  if (isClosed(entry)) {
    reopened(context, pr)
  }

  if (entry.stage === 'merge' && entry.verified && githubPr.headRefOid !== entry.verified.sha) {
    await headMoved(context, pr, githubPr.headRefOid)
  }
}

// The driver's own merge is the one its gate asked for. One on GitHub counts
// as verified only at a head the driver verified, whatever its patch.
async function merged(
  context: SyncContext,
  pr: RunPr,
  { number, from, githubPr }: { number: number; from: OpenStage; githubPr: GitHubPr },
): Promise<void> {
  const { manifest, ledger, running, say, now } = context
  const entry = ledger.prs[pr.id]
  const byDriver = from === 'merge' && entry.gate?.action === 'merge'
  const record: Merged = {
    by: byDriver ? 'driver' : 'github',
    at: githubPr.mergedAt ?? now(),
    sha: null,
    from,
    verified: byDriver || entry.verified?.sha === githubPr.headRefOid,
  }

  // Read before the stop: a stopped run ends on its own time, and its end
  // cleans up after it. The pre-verify commands are no agent and run to their end.
  const job = running.get(pr.id)
  const stopped = job && job !== 'gate' ? job : null

  transitions.toMerged(entry, { merged: record })

  if (stopped) {
    context.stopRun(pr.id)
  }

  if (byDriver) {
    say(pr.id, 'merged', { pr: number }, `merged PR #${number}`)
  } else {
    say(pr.id, 'merged-outside-driver', { pr: number, from, verified: record.verified, stopped })
  }

  const mergeSha = await context.github.mergeCommit(manifest, number).catch(() => null)

  if (mergeSha) {
    record.sha = mergeSha
    entry.mergeSha = mergeSha
    ledger.data.lastMerge = { id: pr.id, sha: mergeSha, at: now() }
  }

  if (!job) {
    await context.cleanup(pr)
  }
}

function closed({ ledger, say, now }: SyncContext, pr: RunPr, number: number): void {
  const entry = ledger.prs[pr.id]

  if (isClosed(entry)) {
    return
  }

  transitions.toClosed(entry, {
    at: now(),
    text: `PR #${number} was closed on GitHub. Reopen it and the driver picks it up on the next tick, or drop it from the manifest.`,
  })

  say(pr.id, 'blocked', { reason: 'closed' }, `PR #${number} was closed`)
}

// A note kept while the PR was closed was recorded when it came. It applies
// by the row of the status the reopen brings back.
function reopened(context: SyncContext, pr: RunPr): void {
  const entry = context.ledger.prs[pr.id]
  const note = entry.pendingNote

  transitions.toReopened(entry, context.now())

  if (note) {
    entry.pendingNote = null
    applyNote(context.commandContext, pr.id, note, 'maintainer', { record: false })
  }
}

// The same patch on a new head keeps its verification and its approval.
async function headMoved(context: SyncContext, pr: RunPr, head: string): Promise<void> {
  const { manifest, ledger, say } = context
  const entry = ledger.prs[pr.id]
  const facts = await context.collectFacts(manifest, pr, entry, ledger, { reads: context.reads() })

  if (entry.verified && facts.pr?.headRefOid === head && facts.patchId === entry.verified.patchId) {
    entry.verified.sha = head
    entry.claimedSha = head

    if (entry.approved?.patchId === facts.patchId) {
      entry.approved.sha = head
    }

    const aligned = await context.worktree.alignWorktree(manifest, pr, head).catch(() => null)

    context.localConfigRemoved(pr, aligned?.removed)
    say(pr.id, 'head-moved-same-patch', { sha: head.slice(0, 7) })
    return
  }

  reverify(context, pr, head, 'new-patch', 'PR head changed after verification; verifying again')
}

// Another patch is verified and approved again from the start.
export function reverify({ ledger, say, now }: ReverifyContext, pr: { id: string }, sha: string, reason: string, message: string): void {
  transitions.claimNewHead(ledger.prs[pr.id], { sha, at: now() })
  say(pr.id, 'head-moved-reverify', { sha: sha.slice(0, 7), reason }, message)
}

// Maintainer review comments follow the note table, once the maintainer has
// been quiet for a few minutes, so a review in progress is not cut short.
// While an agent or the commands work, or the PR is closed, they wait unread.
// Handled comments are remembered by id.
export async function handleFeedback(context: SyncContext, pr: RunPr): Promise<void> {
  const { manifest, ledger, running, say } = context
  const entry = ledger.prs[pr.id]
  const number = entry.pr

  if (!number || entry.stage === 'merged' || running.has(pr.id) || isClosed(entry) || manifest.repo.maintainers.length === 0) {
    return
  }

  const seen = new Set(entry.feedbackSeen ?? [])
  const fresh = (await context.github.feedbackFor(manifest, number, { reads: context.reads() })).filter((item) => !seen.has(item.id))

  if (fresh.length === 0) {
    entry.feedbackWaiting = false
    reviewEnded(context, entry)
    return
  }

  const latest = fresh[fresh.length - 1].at

  entry.feedbackWaiting = true
  reviewWaits(context, entry, latest)

  if (minutesSince(context, latest) < manifest.policy.feedbackQuietMinutes) {
    return
  }

  entry.feedbackSeen = [...seen, ...fresh.map((item) => item.id)]
  entry.feedbackInFix = [
    ...(entry.feedbackInFix ?? []),
    ...fresh.map((item) => ({ id: item.id, commentId: item.commentId ?? null, body: item.body.slice(0, 200) })),
  ]

  entry.feedbackWaiting = false
  say(pr.id, 'review-feedback', { comments: fresh.length })
  applyNote(context.commandContext, pr.id, feedbackNote(number, fresh), 'maintainer', { channel: 'github', record: false })
}

// The gate leaves a PR alone while a maintainer reviews it. A hold shows instead.
function reviewWaits({ ledger, now }: SyncContext, entry: SyncEntry, lastCommentAt: IsoTime): void {
  const status = entry.status
  const over = status?.kind === 'waiting' || (status?.kind === 'needs-you' && listed(GATE_READS, status.code))

  if (entry.stage === 'merge' && over && !entry.held && !ledger.data.hold) {
    transitions.setStatus(entry, 'merge', { kind: 'waiting', code: 'review-in-progress', lastCommentAt }, now())
  }
}

function reviewEnded({ now }: SyncContext, entry: SyncEntry): void {
  if (entry.status?.code === 'review-in-progress') {
    transitions.mergeStatus(entry, now())
  }
}

function feedbackNote(number: number, items: FeedbackItem[]): string {
  const lines = items.map((item, index) => {
    const where = item.path ? `\`${item.path}:${item.line ?? '?'}\`` : 'the PR as a whole'
    const hunk = item.hunk
      ? `\n   Code it refers to:\n   \`\`\`diff\n${item.hunk
          .split('\n')
          .slice(-8)
          .map((line) => `   ${line}`)
          .join('\n')}\n   \`\`\``
      : ''

    return `${index + 1}. [${item.id}] ${where}\n   "${item.body.trim()}"${hunk}`
  })

  return [
    `The maintainer reviewed PR #${number} and asked for changes. Address every comment below.`,
    'Change the code where asked. A comment that asks for a general change ("check the other places too") applies to the whole PR, not only the marked line.',
    'If a comment is unclear or you disagree, say so in your report instead of guessing.',
    'Do not reply on GitHub yourself: the driver answers each thread from your report. In the report, list every comment id below in `addressed` with what you did.',
    '',
    ...lines,
  ].join('\n')
}
