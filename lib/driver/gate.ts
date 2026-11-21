import * as transitions from '../transitions.ts'
import type { PrEntry } from '../transitions.ts'
import type { Hold, IsoTime, NeedsYouCode } from '../state.ts'
import { blockForCodeScanning, noticeCodeScanning } from './claims.ts'
import type { ClaimEntry, ClaimFacts } from './claims.ts'
import type { RunPr } from './runs.ts'
import { reverify } from './sync.ts'

// The merge gate: it judges every PR on merge again each tick, and its
// verdict becomes the PR's status, a fix, a rebase or the merge through
// lib/transitions.ts. The base watch after a merge lives here too. Nothing
// here reads the clock, the disk or GitHub itself: the context brings it, as
// lib/driver.mjs builds it.

// The gate codes that ask a maintainer for an approval. changes-requested is
// left out: the maintainer who asked for changes has seen the PR.
const APPROVAL_NOTICE_CODES = ['awaiting-github-review', 'stale-github-review', 'awaiting-inbox-approval']
// Sync owns a closed PR, and only rollout retry takes the others away.
const NOT_JUDGED = ['closed', 'merge-refused', 'errors'] as const satisfies readonly NeedsYouCode[]
// The gate's fix codes, with the prose a fix keeps in its event and prompt.
// fixReasonCode in lib/transitions.ts gives each prose its code.
const FIX_REASONS: ReadonlyMap<string, string> = new Map([
  ['policy-violations', 'rollout policy'],
  ['ci-red', 'CI is red'],
  ['code-scanning', 'code scanning'],
])

type Say = (id: string, kind: string, detail?: object, message?: string | null) => void
type StoredVerdict = NonNullable<PrEntry['gate']>

export interface GatePr extends RunPr {
  priority: number
  order: number
}

export interface GateManifest {
  rollout: string
  dryRun: boolean
  prs: GatePr[]
  repo: { base: string }
  policy: { merge: string; mergeDelaySeconds: number }
}

interface Verdict {
  action: string
  code: string
  reasons: string[]
}

// What the gate reads of the facts it collects, beside what the claim check reads.
interface GateFacts extends ClaimFacts {
  pr: { state: string; headRefOid: string; author: string | null; mergeStateStatus?: string } | null
  depsPending: string[]
  checks: { missing: string[]; pending: string[] }
  mainChecks: { sha?: string | null; failing: string[] }
}

// The fields of an entry this module reads beside the ones claims.ts types.
export type GateEntry = ClaimEntry & {
  notified: ClaimEntry['notified'] & {
    approval?: string | null
    githubBlocked?: string | null
    ready?: string | null
    wouldMerge?: string | null
  }
  feedbackWaiting?: boolean
}

interface LastMerge {
  id: string
  sha: string
  at: IsoTime
  checked?: string
}

interface GateLedger {
  data: { hold: Hold | null; lastMerge?: LastMerge | null }
  prs: Record<string, GateEntry>
  save: () => void
}

// The context lib/driver.mjs builds once. tsc reads no .mjs file, so every
// function of a .mjs module comes in here, typed by what this module passes and reads.
export interface GateContext {
  manifest: GateManifest
  ledger: GateLedger
  running: Map<string, unknown>
  say: Say
  notify: (title: string, message: string) => void
  now: () => IsoTime
  cleanup: (pr: GatePr) => Promise<unknown>
  isStopping: () => boolean
  // The GitHub reads of the running tick, null between ticks.
  reads: () => unknown

  // The driver's own steps, which code that stays in lib/driver.mjs uses too.
  guarded: (pr: GatePr, task: () => Promise<boolean>) => Promise<boolean>
  toFix: (pr: GatePr, reason: string, note: string) => void

  collectFacts: (
    manifest: GateManifest,
    pr: GatePr,
    entry: GateEntry,
    ledger: GateLedger,
    options: { reads: unknown },
  ) => Promise<GateFacts>
  judge: (manifest: GateManifest, pr: GatePr, entry: GateEntry, facts: GateFacts) => Verdict
  currentGate: (entry: GateEntry) => StoredVerdict | null
  approvalChannel: (manifest: GateManifest, author: string | null | undefined) => 'github' | 'inbox' | null
  githubApproval: (manifest: GateManifest, entry: GateEntry, facts: GateFacts) => { approved: boolean; by?: string | null }
  codeScanningNote: (manifest: GateManifest, reasons: string[]) => string
  github: {
    merge: (manifest: GateManifest, pr: GatePr, entry: GateEntry, facts: GateFacts) => Promise<string | null>
    mergeRefusal: (error: unknown) => boolean
    checksFor: (manifest: GateManifest, sha: string, options: { reads: unknown }) => Promise<{ state: string; failing: string[] }>
  }
  worktree: {
    rebaseWorktree: (
      manifest: GateManifest,
      pr: GatePr,
      sha: string,
    ) => Promise<{ ok: true; head: string } | { ok: false; conflicts: string[]; reason: string }>
  }
}

function listed(list: readonly string[], value: string): boolean {
  return list.includes(value)
}

function candidate({ ledger, running }: GateContext, pr: GatePr): boolean {
  const entry = ledger.prs[pr.id]
  const status = entry.status
  const waitsForYou = status?.kind === 'needs-you' && listed(NOT_JUDGED, status.code)

  return entry.stage === 'merge' && !waitsForYou && !running.has(pr.id) && !entry.feedbackWaiting
}

export async function mergeNext(context: GateContext): Promise<void> {
  const { manifest, ledger } = context

  if (ledger.data.hold || context.isStopping()) {
    return
  }

  const candidates = manifest.prs
    .filter((pr) => candidate(context, pr))
    .sort((left, right) => right.priority - left.priority || left.order - right.order)

  // Under merge: manual one PR is ready at a time. Two PRs merged back to
  // back were each gated on a base without the other, and a conflict git
  // does not see (one changes a file the other copies or calls) would first
  // show on the base branch. The others still go through the gate (rebase,
  // fix) but wait. The PR already announced keeps the slot, as long as its
  // verification still holds (currentGate).
  const manual = manifest.policy.merge === 'manual'

  if (manual) {
    const holdsReady = (pr: GatePr) => Number(context.currentGate(ledger.prs[pr.id])?.action === 'ready')

    candidates.sort((left, right) => holdsReady(right) - holdsReady(left))
  }

  let readyTaken: number | null = null

  for (const pr of candidates) {
    const acted = await context.guarded(pr, () => mergeCandidate(context, pr, { readyTaken }))

    if (acted) {
      return
    }

    if (manual && readyTaken === null && ledger.prs[pr.id].gate?.action === 'ready') {
      readyTaken = ledger.prs[pr.id].pr
    }
  }
}

// The merge delay of a GitHub approval starts when the driver first sees
// it, not at the review's own time. A review given while CI ran or the
// verifier worked would otherwise merge with no window for rollout hold.
function noticeGithubApproval(context: GateContext, pr: GatePr, entry: GateEntry, facts: GateFacts): void {
  const { manifest, say, now } = context
  const author = facts.pr?.author

  if (facts.pr?.state !== 'OPEN' || context.approvalChannel(manifest, author) !== 'github') {
    return
  }

  const approval = context.githubApproval(manifest, entry, facts)

  // Cleared even on a held PR, so the next approval gets its own notice
  // and a full window.
  if (!approval.approved && entry.approved?.channel === 'github') {
    entry.approved = null
    return
  }

  if (entry.hold || !approval.approved || entry.verified?.patchId !== facts.patchId) {
    return
  }

  if (entry.approved?.channel === 'github' && entry.approved.patchId === facts.patchId) {
    return
  }

  const sha = facts.pr.headRefOid

  entry.approved = { patchId: facts.patchId, sha, at: now(), by: approval.by ?? null, channel: 'github' }
  say(
    pr.id,
    'approved',
    { sha: sha.slice(0, 7), by: approval.by, channel: 'github' },
    `PR #${entry.pr} approved on GitHub by ${approval.by}; merging in ${manifest.policy.mergeDelaySeconds}s unless you hold it (rollout hold ${pr.id})`,
  )
}

// readyTaken: the PR number another candidate holds "ready" with this tick
// (merge: manual). This one then waits for it, see mergeNext.
export async function mergeCandidate(
  context: GateContext,
  pr: GatePr,
  { readyTaken = null }: { readyTaken?: number | null } = {},
): Promise<boolean> {
  const { manifest, ledger, say, now } = context
  const entry = ledger.prs[pr.id]
  const facts = await context.collectFacts(manifest, pr, entry, ledger, { reads: context.reads() })
  noticeCodeScanning(context, pr, entry, facts)
  noticeGithubApproval(context, pr, entry, facts)

  const judged = context.judge(manifest, pr, entry, facts)

  // sync moves a verified PR on only when its head moves, so one whose
  // patch id changed under the same head would wait for ever.
  if (judged.code === 'not-verified' && entry.stage === 'merge' && facts.pr) {
    reverify(
      context,
      pr,
      facts.pr.headRefOid,
      'not-verified',
      'the patch id the gate reads no longer matches the verification, verifying again',
    )

    return false
  }

  const github = facts.pr?.mergeStateStatus ?? 'UNKNOWN'
  const githubNote =
    github === 'CLEAN' || github === 'HAS_HOOKS'
      ? 'GitHub: mergeable'
      : `GitHub: ${github}${github === 'BLOCKED' ? ' (a review, an open thread or a ruleset rule is still missing)' : ''}`

  const manualMerge = manifest.policy.merge === 'manual' && judged.action === 'merge'
  const queuedAfter = manualMerge ? readyTaken : null
  let verdict = judged

  if (queuedAfter !== null) {
    verdict = {
      action: 'wait',
      code: 'queued',
      reasons: [`after PR #${queuedAfter}: one PR is ready at a time, this one is checked again on the base that includes it`],
    }
  } else if (manualMerge) {
    verdict = { action: 'ready', code: 'ready', reasons: [`ready: merge it on GitHub (${githubNote})`] }
  }

  // The prose may change while the cause stays, as a check moving from
  // missing to running. That is not a new event.
  const changed = entry.gate?.action !== verdict.action || entry.gate?.code !== verdict.code
  const stored: StoredVerdict = {
    ...verdict,
    mergeState: github,
    sha: facts.pr?.headRefOid ?? null,
    at: now(),
    ...(queuedAfter !== null ? { after: queuedAfter } : {}),
  }

  entry.gate = stored
  transitions.gateVerdict(entry, stored, facts, now())

  if (queuedAfter !== null) {
    // Ready again later is a new notice, even on the same head.
    entry.notified.ready = null
  }

  if (changed) {
    say(pr.id, `gate-${verdict.action}`, { code: verdict.code, reasons: verdict.reasons })
  }

  if (verdict.action === 'wait') {
    waitNotice(context, pr, facts, verdict)
    return false
  }

  if (verdict.action === 'block') {
    gateBlock(context, pr, verdict)
    return false
  }

  if (verdict.action === 'fix') {
    sentBack(context, pr, verdict)
    return false
  }

  if (verdict.action === 'rebase') {
    await rebase(context, pr, facts.pr?.headRefOid ?? '')
    return true
  }

  // Manual mode: everything the gate checks holds, and the maintainer merges.
  if (verdict.action === 'ready') {
    readyNotice(context, pr, facts, { github, githubNote })
    return false
  }

  return mergeApproved(context, pr, facts, stored)
}

function waitNotice({ manifest, ledger, notify }: GateContext, pr: GatePr, facts: GateFacts, verdict: Verdict): void {
  const entry = ledger.prs[pr.id]
  const reason = verdict.reasons.join('; ')
  const head = facts.pr?.headRefOid ?? null

  if (APPROVAL_NOTICE_CODES.includes(verdict.code) && entry.notified.approval !== facts.patchId) {
    entry.notified.approval = facts.patchId
    notify(`rollout ${manifest.rollout}`, `${pr.id}: PR #${entry.pr} is verified; ${reason}`)
  } else if (verdict.code === 'github-blocked' && entry.notified.githubBlocked !== head) {
    entry.notified.githubBlocked = head
    notify(`rollout ${manifest.rollout}`, `${pr.id}: PR #${entry.pr} passes the rollout gate, but GitHub's ruleset still blocks the merge`)
  }
}

// The gate reads a block again every tick. The same block given again keeps
// its status and its time, and logs and notifies nothing.
function gateBlock(context: GateContext, pr: GatePr, verdict: Verdict): void {
  const { ledger, say, now } = context
  const entry = ledger.prs[pr.id]

  if (verdict.code === 'code-scanning') {
    blockForCodeScanning(context, pr, entry, verdict.reasons)
    return
  }

  const status = entry.status
  const again = status?.kind === 'needs-you' && status.code === 'gate-blocked' && status.gate === verdict.code
  const blocked = { kind: 'gate' as const, question: verdict.reasons.join('; '), evidence: '', run: null }

  transitions.toBlocked(entry, blocked, { at: now(), gate: verdict })

  if (!again) {
    say(pr.id, 'blocked', { reason: 'gate' }, `gate blocked: ${verdict.reasons.join('; ').slice(0, 120)}`)
  }
}

function sentBack({ manifest, toFix, codeScanningNote }: GateContext, pr: GatePr, verdict: Verdict): void {
  const reason = FIX_REASONS.get(verdict.code) ?? verdict.code

  if (verdict.code === 'code-scanning') {
    toFix(pr, reason, codeScanningNote(manifest, verdict.reasons))
  } else {
    toFix(pr, reason, `The merge gate sent the PR back:\n- ${verdict.reasons.join('\n- ')}`)
  }
}

async function rebase(context: GateContext, pr: GatePr, head: string): Promise<void> {
  const { manifest, ledger, say, now } = context
  const rebased = await context.worktree.rebaseWorktree(manifest, pr, head)

  if (rebased.ok) {
    transitions.setStatus(ledger.prs[pr.id], 'merge', { kind: 'waiting', code: 'ci', sha: rebased.head, missing: [], pending: [] }, now())
    say(pr.id, 'rebased', { head: rebased.head.slice(0, 7) })
    return
  }

  context.toFix(
    pr,
    'rebase conflict',
    `\`${manifest.repo.base}\` moved and the branch no longer rebases cleanly.\nConflicting files: ${rebased.conflicts.join(', ') || '(see below)'}\n${rebased.reason.slice(0, 1500)}\n\nRebase onto origin/${manifest.repo.base}, resolve keeping both intents (read the merged PRs that touched these files), re-verify and push with --force-with-lease.`,
  )
}

function readyNotice(
  { ledger, say }: GateContext,
  pr: GatePr,
  facts: GateFacts,
  { github, githubNote }: { github: string; githubNote: string },
): void {
  const entry = ledger.prs[pr.id]
  const head = facts.pr?.headRefOid ?? ''

  if (entry.notified.ready !== `${head}:${github}`) {
    entry.notified.ready = `${head}:${github}`
    say(
      pr.id,
      'ready-to-merge',
      { pr: entry.pr, sha: head.slice(0, 7), github },
      `PR #${entry.pr} is ready: verified, CI green, up to date. ${githubNote}`,
    )
  }
}

// After the merge delay, the merge itself. A dry run leaves it to the maintainer.
async function mergeApproved(context: GateContext, pr: GatePr, facts: GateFacts, stored: StoredVerdict): Promise<boolean> {
  const { manifest, ledger, say, now } = context
  const entry = ledger.prs[pr.id]
  const head = facts.pr?.headRefOid ?? ''
  const github = stored.mergeState ?? 'UNKNOWN'

  // A short delay from the first time the driver saw the approval, so one
  // nobody expected can be noticed (both channels notify) and stopped with
  // rollout hold. No record for the current patch means no time has passed.
  const approvedAt = entry.approved?.patchId === facts.patchId ? entry.approved.at : now()
  const approvedFor = (Date.parse(now()) - Date.parse(approvedAt)) / 1000

  if (manifest.policy.merge === 'human' && approvedFor < manifest.policy.mergeDelaySeconds) {
    const until = new Date(Date.parse(approvedAt) + manifest.policy.mergeDelaySeconds * 1000).toISOString()

    transitions.setStatus(entry, 'merge', { kind: 'waiting', code: 'merge-delay', until }, now())
    return false
  }

  // The driver never merges in a dry run, so the merge is the maintainer's.
  if (manifest.dryRun) {
    transitions.setStatus(entry, 'merge', { kind: 'needs-you', code: 'merge-by-hand', mergeState: github }, now())

    if (entry.notified.wouldMerge !== head) {
      entry.notified.wouldMerge = head
      say(pr.id, 'would-merge', { pr: entry.pr, sha: head.slice(0, 7) }, `dry run: would merge PR #${entry.pr} now`)
    }

    return false
  }

  stored.action = 'merge'
  transitions.setStatus(entry, 'merge', { kind: 'running', code: 'merge', sha: head }, now())
  ledger.save()

  let mergeSha

  try {
    mergeSha = await context.github.merge(manifest, pr, entry, facts)
  } catch (error) {
    if (!context.github.mergeRefusal(error)) {
      throw error
    }

    mergeRefused(context, pr, { error, github, head })
    return false
  }

  // Accepted, but GitHub shows no merge commit yet (a merge queue, a slow
  // read). The PR stays on merge with gate.action merge, so the next sync
  // that sees it merged records it as the driver's merge and cleans up.
  if (!mergeSha) {
    say(pr.id, 'merge-unconfirmed', { pr: entry.pr, sha: head.slice(0, 7) })
    ledger.save()

    return true
  }

  recordMerge(context, pr, mergeSha)
  say(pr.id, 'merged', { pr: entry.pr, sha: mergeSha.slice(0, 7) }, `merged PR #${entry.pr}`)
  ledger.save()
  await context.cleanup(pr)

  return true
}

// GitHub refusing the merge is a status to wait in, not a failure. Only
// rollout retry takes it away, so the merge is not tried on every tick.
function mergeRefused(
  { ledger, say, now }: GateContext,
  pr: GatePr,
  { error, github, head }: { error: unknown; github: string; head: string },
): void {
  const entry = ledger.prs[pr.id]
  const text = String(error).slice(0, 200)

  entry.gate = {
    action: 'wait',
    code: 'merge-refused',
    reasons: ['GitHub refused the merge (ruleset)'],
    mergeState: github,
    sha: head,
    at: now(),
  }

  transitions.setStatus(entry, 'merge', { kind: 'needs-you', code: 'merge-refused', error: text }, now())
  say(pr.id, 'merge-refused', { error: text }, `GitHub refused to merge PR #${entry.pr}; check its ruleset requirements`)
}

function recordMerge({ ledger, now }: GateContext, pr: GatePr, mergeSha: string): void {
  const entry = ledger.prs[pr.id]
  const at = now()

  transitions.toMerged(entry, { mergeSha, merged: { by: 'driver', at, sha: mergeSha, from: 'merge', verified: true } })
  ledger.data.lastMerge = { id: pr.id, sha: mergeSha, at }
}

// The gate holds merges, rebases and fixes on a red base, so the watch only
// tells the maintainer, once per merge. Any stored checked, a legacy
// 'acknowledged' too, means this merge was handled.
export async function watchBase(context: GateContext): Promise<void> {
  const { manifest, ledger, say } = context
  const last = ledger.data.lastMerge

  if (!last?.sha || last.checked) {
    return
  }

  // The merge commit's own runs, never a quiet ancestor's: only they say
  // whether this merge broke the base. With none yet, the next tick looks again.
  const checks = await context.github.checksFor(manifest, last.sha, { reads: context.reads() })

  if (checks.state === 'red') {
    last.checked = 'red'
    say(
      last.id,
      'base-red',
      { sha: last.sha.slice(0, 7), failing: checks.failing },
      `${manifest.repo.base} is red after the merge (${last.sha.slice(0, 7)}): ${checks.failing.join(', ')}. Merges wait until it is green`,
    )
  } else if (checks.state === 'green') {
    last.checked = 'green'
  }
}
