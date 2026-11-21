import * as transitions from '../transitions.ts'
import type { PrEntry } from '../transitions.ts'
import type { Head, Hold, IsoTime, OpenStage, RunRecord, WaitingOf } from '../state.ts'
import { checkClaim } from './claims.ts'
import type { ClaimPr, ClaimsContext } from './claims.ts'
import { applyCommands } from './commands.ts'
import type { CommandsContext } from './commands.ts'
import { mergeNext, watchBase } from './gate.ts'
import type { GateContext, GatePr } from './gate.ts'
import { claimReport, headsKey, launch, launchDelegate, owedCleanup } from './runs.ts'
import type { RunEntry, RunManifest, RunPr, RunsContext } from './runs.ts'
import { handleFeedback, sync } from './sync.ts'
import type { SyncContext } from './sync.ts'

// The driver's loop: the start, each tick and its steps, the advance of
// every PR and the stop. An error belongs to one PR, and an outage of GitHub
// or the network counts against nothing. Nothing here reads the disk or
// GitHub itself: the context brings them, as lib/driver.mjs builds it.

const MAX_TICK_ERRORS = 5
const UNAVAILABLE_NOTICE_MINUTES = 30
const AFTER_SLEEP_MS = 2 * 60_000
const SLOW_TICK_QUIET_MS = 10 * 60_000
const STOP_WAIT_SECONDS = 15
const SLOT = { kind: 'waiting', code: 'slot' } as const

type Say = (id: string, kind: string, detail?: object, message?: string | null) => void
type Unstamped<Union> = Union extends unknown ? Omit<Union, 'since'> : never
type DependencyStatus = Unstamped<WaitingOf<'dependencies' | 'outside-dependency'>>
type BriefWait = Unstamped<WaitingOf<'dependencies' | 'outside-dependency' | 'dependencies-merge' | 'slot'>>
type QuestionHash = RunsContext['questionHash']
type UnfilledEntry = Parameters<typeof transitions.fillFromState>[0]
type StoredRuns = Parameters<typeof transitions.fillFromState>[1]['runs']
type AgentRunner = RunsContext['runAgent']
type AgentOptions = Parameters<AgentRunner>[2]
type AgentOutcome = Awaited<ReturnType<AgentRunner>>
type RecordedProcess = NonNullable<RunRecord['process']>
type LoopRun = NonNullable<StoredRuns>[string] & { endedAt?: IsoTime | null; process?: RecordedProcess | null }

// What endProcess in lib/sandbox.mjs resolves with. It never rejects.
interface ProcessEnd {
  outcome: 'ended' | 'gone' | 'not-the-run' | 'failed'
  found?: string
  error?: string
}

export interface LoopPr extends ClaimPr, GatePr {
  deps: string[]
}

interface DelegatePolicy {
  kinds: string[]
  maxPerPr: number
}

export interface LoopManifest {
  rollout: string
  dir: string
  only: string[] | null
  dryRun: boolean
  all: LoopPr[]
  prs: LoopPr[]
  policy: { concurrency: number; tickSeconds: number; merge: string; delegate: DelegatePolicy | null }
}

// The fields of an entry this module reads beside the ones runs.ts types.
interface LoopEntry extends RunEntry {
  stageLabels?: string[]
  stageLabelError?: string | null
}

// The start of an outage, kept in the ledger so its clock survives a restart.
interface Outage {
  since: IsoTime
  notified: boolean
}

interface LoopLedger {
  data: { hold: Hold | null; githubUnavailable?: Outage | null; runs?: Record<string, LoopRun> | null }
  prs: Record<string, LoopEntry>
  save: () => void
  beat: (note?: string) => void
  event: (id: string, kind: string, detail: object) => void
}

interface TickStats {
  ms: number
  requests: number
  cached: number
  remaining: number | null
}

// What the loop keeps between its ticks. The other contexts read `stopping`
// and `reads` through it.
export interface LoopState {
  stopping: boolean
  // The GitHub reads of the running tick, shared by its steps. Null between
  // ticks, so a step outside a tick reads fresh.
  reads: unknown
  erredThisTick: Set<string>
  unavailableThisTick: Set<string>
  outageThisTick: boolean
  stepFailures: Map<string, number>
  failedTicks: number
  lastTickEnd: number | null
  slowSaidAt: number | null
  wokeAt: number | null
  manifestMtime: number | null
  loggedStatus: Map<string, string>
  // One controller per agent run, so a merge on GitHub stops that PR's agent alone.
  agentRuns: Map<string, AbortController>
}

// The context lib/driver.mjs builds once. tsc reads no .mjs file, so every
// function of a .mjs module or of Node comes in here, typed by what this
// module passes and reads.
export interface LoopContext {
  manifest: LoopManifest
  ledger: LoopLedger
  running: CommandsContext['running']
  state: LoopState
  say: Say
  notify: (title: string, message: string) => void
  now: () => IsoTime
  clock: () => number

  commandContext: CommandsContext
  runContext: RunsContext
  syncContext: SyncContext
  claimContext: ClaimsContext
  gateContext: GateContext

  // Steps that stay in lib/driver.mjs: the other contexts use them too, and questionHash needs node:crypto.
  slots: () => boolean
  lastEndedRun: (id: string) => string | null
  questionHash: QuestionHash

  // The agent runner the driver was given. stoppableAgent hands it the signal of each run.
  runAgent: (
    manifest: RunManifest,
    pr: RunPr,
    options: AgentOptions & { signal: AbortSignal; onProcess: (recorded: RecordedProcess) => void },
  ) => Promise<AgentOutcome>
  stopAllAgents: () => void
  liveChildren: () => number
  recordProcess: (data: LoopLedger['data'], run: string, recorded: RecordedProcess) => void
  endProcess: (run: string, recorded: RecordedProcess) => Promise<ProcessEnd>
  sleep: (ms: number) => Promise<unknown>
  pid: number

  loadManifest: (dir: string, options: { only: string[] | null; dryRun: boolean }) => LoopManifest
  manifestMtime: () => number | null
  existsSync: (path: string) => boolean
  freshPr: () => UnfilledEntry
  tickNote: (stats: TickStats) => string
  sleptMs: (gapMs: number, intervalMs: number) => number
  stageLabels: (entry: LoopEntry) => string[]
  labelChanges: (current: string[], wanted: string[]) => { add: string[]; remove: string[] }
  runtimeSummary: (manifest: LoopManifest) => object

  github: {
    fetchOrigin: (manifest: LoopManifest) => Promise<void>
    ensureLabel: (manifest: LoopManifest) => Promise<void>
    refreshOutsideDeps: (manifest: LoopManifest, ledger: LoopLedger) => Promise<void>
    githubUnavailable: (error: unknown, options: { afterSleep: boolean }) => boolean
    ghError: (error: unknown) => string
    clientFor: (manifest: LoopManifest) => { stats: () => Omit<TickStats, 'ms'>; resetStats: () => void }
    tickReads: () => unknown
    setStageLabels: (manifest: LoopManifest, number: number, changes: { add: string[]; remove: string[] }) => Promise<void>
    depsPending: (manifest: LoopManifest, pr: LoopPr, ledger: LoopLedger) => string[]
    unmergedHeads: (pr: LoopPr, ledger: LoopLedger) => Head[] | null
    findReleasePr: (manifest: LoopManifest) => Promise<{ url: string; number: number } | null>
  }
}

// A thrown value can be anything, so its message and stack are read with care.
function fieldOf(error: unknown, name: 'message' | 'stack'): unknown {
  return typeof error === 'object' && error !== null && name in error ? (error as Record<string, unknown>)[name] : undefined
}

function messageOf(error: unknown): string {
  return String(fieldOf(error, 'message') ?? error)
}

function minutesSince(iso: IsoTime | null | undefined): number {
  return iso ? (Date.now() - Date.parse(iso)) / 60_000 : Infinity
}

// The detail of a status event. Its status kind is `status`, because a `kind`
// would replace the event's own. A merged PR has neither status nor code.
function statusDetail(entry: PrEntry) {
  return { stage: entry.stage ?? null, status: entry.status?.kind ?? null, code: entry.status?.code ?? null }
}

function statusKey(entry: PrEntry): string {
  return JSON.stringify(statusDetail(entry))
}

// The state of a driver just built. The logged statuses are seeded from the
// ledger, so a restart logs no status that did not change.
export function freshState({ manifest, ledger }: Pick<LoopContext, 'manifest' | 'ledger'>, manifestMtime: number | null): LoopState {
  return {
    stopping: false,
    reads: null,
    erredThisTick: new Set(),
    unavailableThisTick: new Set(),
    outageThisTick: false,
    stepFailures: new Map(),
    failedTicks: 0,
    lastTickEnd: null,
    slowSaidAt: null,
    wokeAt: null,
    manifestMtime,
    loggedStatus: new Map(manifest.all.map((pr) => [pr.id, statusKey(ledger.prs[pr.id])])),
    agentRuns: new Map(),
  }
}

export function delegateAllowed(manifest: Pick<LoopManifest, 'policy'>, entry: PrEntry, questionHash: QuestionHash): boolean {
  const policy = manifest.policy.delegate
  const blocked = entry.blocked

  if (!policy || !blocked) {
    return false
  }

  return policy.kinds.includes(blocked.kind) && !entry.pendingNote && questionHash(blocked) !== entry.delegate.lastQuestion
}

// A question the delegate takes notifies once, through its answer or escalation.
export function delegateTakes(manifest: Pick<LoopManifest, 'policy'>, entry: PrEntry, questionHash: QuestionHash): boolean {
  const policy = manifest.policy.delegate

  if (!policy || !delegateAllowed(manifest, entry, questionHash)) {
    return false
  }

  return entry.delegate.runs < policy.maxPerPr
}

export function toFix(
  { ledger, say, now }: Pick<LoopContext, 'ledger' | 'say' | 'now'>,
  pr: { id: string },
  reason: string,
  note: string,
): void {
  transitions.toFix(ledger.prs[pr.id], reason, note, { code: transitions.fixReasonCode(reason), at: now() })
  say(pr.id, 'needs-fix', { reason })
}

// The runs start an agent only once its worktree is ready. A PR that merged
// meanwhile, or a driver that is stopping, gets a signal that is already
// aborted, so no agent starts.
export async function stoppableAgent(context: LoopContext, manifest: RunManifest, pr: RunPr, options: AgentOptions): Promise<AgentOutcome> {
  const { state } = context
  const controller = new AbortController()

  if (state.stopping || context.ledger.prs[pr.id].stage === 'merged') {
    controller.abort()
  }

  state.agentRuns.set(pr.id, controller)

  // Saved at once, because a hard end can come before the next save. As at the
  // end of a job, a failed save is only printed.
  function onProcess(recorded: RecordedProcess): void {
    context.recordProcess(context.ledger.data, options.logName, recorded)

    try {
      context.ledger.save()
    } catch (error) {
      console.error(`${pr.id} ledger not saved with the process of ${options.logName}: ${messageOf(error)}`)
    }
  }

  try {
    return await context.runAgent(manifest, pr, { ...options, signal: controller.signal, onProcess })
  } finally {
    if (state.agentRuns.get(pr.id) === controller) {
      state.agentRuns.delete(pr.id)
    }
  }
}

export function stopRun({ state }: LoopContext, id: string): void {
  state.agentRuns.get(id)?.abort()
}

// Edits to manifest.yaml apply on the next tick without a restart (and
// without stopping running agents). An invalid edit or a missing file is
// reported once and ignored.
function reloadManifest(context: LoopContext): void {
  const { manifest, ledger, state, say, now } = context
  const mtime = context.manifestMtime()

  if (mtime === state.manifestMtime) {
    return
  }

  state.manifestMtime = mtime

  try {
    const fresh = context.loadManifest(manifest.dir, { only: manifest.only, dryRun: manifest.dryRun })

    for (const pr of fresh.all) {
      // freshPr gives every field of an entry.
      ledger.prs[pr.id] ??= transitions.fillFromState(context.freshPr(), {
        id: pr.id,
        briefWritten: context.existsSync(pr.brief),
        runs: ledger.data.runs,
        at: now(),
      }) as LoopEntry
    }

    Object.assign(manifest, fresh)
    say('-', 'manifest-reloaded', { prs: manifest.prs.map((pr) => pr.id) })
  } catch (error) {
    say('-', 'manifest-rejected', { error: messageOf(error).slice(0, 300) }, 'manifest.yaml has an error; keeping the previous one')
  }
}

// Each question gets one delegate run, and a PR at most policy.delegate.maxPerPr.
function askDelegate(context: LoopContext, pr: LoopPr, entry: LoopEntry): void {
  const { manifest, say } = context
  const policy = manifest.policy.delegate

  if (!policy || !delegateAllowed(manifest, entry, context.questionHash)) {
    return
  }

  if (entry.delegate.runs >= policy.maxPerPr) {
    if (!entry.delegate.limitNotified) {
      entry.delegate.limitNotified = true
      say(
        pr.id,
        'delegate-limit',
        { runs: entry.delegate.runs, maxPerPr: policy.maxPerPr },
        `the delegate used its ${policy.maxPerPr} runs for this PR (policy.delegate.maxPerPr). Answer with rollout note ${pr.id}`,
      )
    }

    return
  }

  if (context.slots()) {
    launchDelegate(context.runContext, pr)
  }
}

// A brief may be written while its dependencies, verified and not held, wait
// to merge, unless these same heads did not merge cleanly in a preview before.
function briefAhead(context: LoopContext, pr: LoopPr, entry: LoopEntry): boolean {
  const heads = context.github.unmergedHeads(pr, context.ledger)

  return heads !== null && heads.length > 0 && headsKey(heads) !== entry.previewConflict
}

// The dependencies a PR waits for. Ones outside this run (--only) merge only on GitHub.
function dependencyStatus({ manifest, ledger, github }: LoopContext, pr: LoopPr): DependencyStatus {
  const active = new Set(manifest.prs.map((item) => item.id))
  const on = github.depsPending(manifest, pr, ledger)
  const code = on.every((id) => !active.has(id)) ? 'outside-dependency' : 'dependencies'

  return { kind: 'waiting', code, on }
}

// What a pending PR waits for when nothing launches. The brief file decides its stage.
function pendingStatus(context: LoopContext, pr: LoopPr, entry: LoopEntry, depsReady: boolean): void {
  const { now } = context

  if (context.existsSync(pr.brief)) {
    transitions.setStatus(entry, 'implement', depsReady ? SLOT : dependencyStatus(context, pr), now())
  } else {
    transitions.setStatus(entry, 'brief', briefWait(context, pr, entry, depsReady), now())
  }
}

// Heads that did not merge cleanly in a preview wait until they merge.
function briefWait(context: LoopContext, pr: LoopPr, entry: LoopEntry, depsReady: boolean): BriefWait {
  const heads = context.github.unmergedHeads(pr, context.ledger)

  if (heads && heads.length > 0 && headsKey(heads) === entry.previewConflict) {
    return { kind: 'waiting', code: 'dependencies-merge', heads }
  }

  return !depsReady && !briefAhead(context, pr, entry) ? dependencyStatus(context, pr) : SLOT
}

// What an interrupted run or an owed fix waits for when it does not launch.
function idleStatus(context: LoopContext, pr: LoopPr, entry: LoopEntry, depsReady: boolean): void {
  const { now } = context

  if (entry.stage === 'implement' && !entry.pr && !depsReady) {
    transitions.setStatus(entry, 'implement', dependencyStatus(context, pr), now())
    return
  }

  // An interrupted run or an owed fix is never on merged.
  transitions.setStatus(entry, entry.stage as OpenStage, SLOT, now())
}

export async function advance(context: LoopContext, pr: LoopPr): Promise<void> {
  const { manifest, ledger, running, runContext, claimContext, now } = context
  const entry = ledger.prs[pr.id]

  if (entry.held) {
    transitions.heldStatus(entry, 'pr', now())
    return
  }

  if (running.has(pr.id)) {
    return
  }

  if (entry.retryAfter && Date.now() < Date.parse(entry.retryAfter)) {
    transitions.backOffStatus(entry, now())
    return
  }

  if (entry.preVerifyCleanup) {
    await owedCleanup(runContext, pr, entry)
  }

  // A run state with no run behind it (an onDone that threw) resumes.
  transitions.recoverRun(entry, { refund: false, at: now() })

  const depsReady = context.github.depsPending(manifest, pr, ledger).length === 0

  switch (entry.state) {
    case 'pending':
      if (context.slots()) {
        if (context.existsSync(pr.brief)) {
          if (depsReady) {
            launch(runContext, pr, 'implement')
          }
        } else if (depsReady || briefAhead(context, pr, entry)) {
          launch(runContext, pr, 'brief')
        }
      }

      if (entry.state === 'pending' && !running.has(pr.id)) {
        pendingStatus(context, pr, entry, depsReady)
      }

      break

    case 'interrupted':
      // A parked READY report needs GitHub again, not a slot or an agent.
      if (entry.interruptedRole === 'report' && entry.ready) {
        transitions.setStatus(entry, 'pre-verify', { kind: 'waiting', code: 'github' }, now())
        await claimReport(runContext, pr, entry, entry.ready)
        break
      }

      if (!context.slots() || (!entry.pr && !depsReady)) {
        idleStatus(context, pr, entry, depsReady)
        break
      }

      if (entry.interruptedRole === 'verify' && entry.claimedSha) {
        transitions.verifyAgain(entry, now())
        await checkClaim(claimContext, pr)
      } else if (entry.interruptedRole === 'implement' && !entry.sessionId) {
        launch(runContext, pr, 'implement')
      } else {
        launch(runContext, pr, 'fix', {
          reason: 'previous run ended without a report',
          note: `Your previous run stopped without a final report (${entry.lastError ?? 'unknown'}). Inspect the worktree and the PR, then continue where you stopped.`,
        })
      }

      break

    case 'needs_fix':
      if (context.slots() && (entry.pr || depsReady)) {
        launch(runContext, pr, 'fix', { reason: entry.fixReason, note: entry.fixNote })
      } else {
        idleStatus(context, pr, entry, depsReady)
      }

      break

    case 'ready_claimed':
      await checkClaim(claimContext, pr)
      break

    // The claim check reads the alerts of its block again every tick.
    case 'blocked':
      if (entry.stage === 'pre-verify' && entry.status?.code === 'code-scanning-alerts') {
        await checkClaim(claimContext, pr)
      } else {
        askDelegate(context, pr, entry)
      }

      break

    default:
      break
  }
}

// One PR's persistent error must not freeze the others: errors are counted
// per PR and escalate that PR alone. A PR counts one error per tick, and
// tick() resets the count after a tick without one. An outage is no error
// of the PR, so a tick with only outages neither counts nor resets it.
export async function guarded(context: LoopContext, pr: { id: string }, task: () => Promise<unknown>): Promise<unknown> {
  const { ledger, running, state, say, now } = context
  const entry = ledger.prs[pr.id]

  try {
    return await task()
  } catch (error) {
    if (unavailable(context, pr.id, error)) {
      state.unavailableThisTick.add(pr.id)

      return false
    }

    if (!state.erredThisTick.has(pr.id)) {
      state.erredThisTick.add(pr.id)
      entry.tickErrors = (entry.tickErrors ?? 0) + 1
    }

    const lastError = messageOf(error).slice(0, 1000)

    entry.lastError = lastError
    say(pr.id, 'error', { error: lastError.slice(0, 300), count: entry.tickErrors })

    // sync still runs for an escalated PR. If it keeps failing, that must
    // not escalate and notify again on every tick.
    if ((entry.tickErrors ?? 0) >= MAX_TICK_ERRORS && !running.has(pr.id) && entry.state !== 'escalated') {
      transitions.escalateErrors(entry, { at: now(), run: context.lastEndedRun(pr.id) })
      say(pr.id, 'escalated', { reason: 'repeated errors' }, `repeated errors, needs you: ${lastError.slice(0, 100)}`)
    }

    return false
  }
}

// Fetch, outside dependencies and the base watch belong to no PR. A
// failure is logged and tried again on the next tick, and the fifth in a
// row notifies. An outage is no failure of the step and leaves its count
// as it was.
async function driverStep(context: LoopContext, step: string, task: () => Promise<unknown>): Promise<boolean> {
  const { state, say } = context

  try {
    await task()
    state.stepFailures.set(step, 0)

    return true
  } catch (error) {
    if (unavailable(context, step, error)) {
      return false
    }

    const kind = `${step}-failed`
    const count = (state.stepFailures.get(step) ?? 0) + 1
    const message = messageOf(error)
    const notice = count === MAX_TICK_ERRORS ? `${kind} ${count} ticks in a row: ${message.slice(0, 100)}` : null
    state.stepFailures.set(step, count)
    say('-', kind, { error: message.slice(0, 300), count }, notice)

    return false
  }
}

// The one place that decides what counts as an outage of GitHub or the
// network. Five minutes of one must not escalate every PR, so it counts
// against nothing, is logged once per tick and notifies only when it
// lasts. Its start is in the ledger, so the clock survives a restart.
// The network comes back a little after the machine wakes, so for two
// minutes after a sleep any failed GitHub request or gh or git call is one.
function unavailable(context: LoopContext, source: string, error: unknown): boolean {
  const { ledger, state, github, say, now } = context
  const afterSleep = state.wokeAt !== null && context.clock() - state.wokeAt < AFTER_SLEEP_MS

  if (!github.githubUnavailable(error, { afterSleep })) {
    return false
  }

  const outage = ledger.data.githubUnavailable ?? { since: now(), notified: false }

  ledger.data.githubUnavailable = outage

  if (state.outageThisTick) {
    return true
  }

  state.outageThisTick = true

  const message = messageOf(error)
  const minutes = Math.floor(minutesSince(outage.since))
  let notice = null

  if (minutes >= UNAVAILABLE_NOTICE_MINUTES && !outage.notified) {
    outage.notified = true
    notice = `GitHub has been unreachable for ${minutes} minutes. The driver keeps trying every tick. Last error: ${github.ghError(error).slice(0, 100)}`
  }

  say('-', 'github-unavailable', { source, error: message.slice(0, 300), minutes }, notice)

  return true
}

function githubBack({ ledger, say }: LoopContext, outage: Outage): void {
  const minutes = Math.floor(minutesSince(outage.since))
  const notice = outage.notified ? `GitHub answers again after ${minutes} minutes` : null

  ledger.data.githubUnavailable = null
  say('-', 'github-back', { minutes }, notice)
}

// A call of the start that an outage loses is logged as a tick logs it, and
// the start goes on. Any other error still ends the start.
async function startStep(context: LoopContext, source: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task()
  } catch (error) {
    if (!unavailable(context, source, error)) {
      throw error
    }
  }
}

function outlivedNotice(run: string, recorded: RecordedProcess, ended: ProcessEnd): string | null {
  if (ended.outcome !== 'failed') {
    return null
  }

  const target = 'pid' in recorded ? `pid ${recorded.pid}` : `container ${recorded.container}`

  return `the driver could not end the process of run ${run} (${target}): ${ended.error}. End it by hand`
}

// A run with no end belongs to a driver that is gone, and its agent may still
// run. It is ended before any role resumes, or it would race its own resumed
// session. A process that could not be ended is kept for the next start.
async function endOutlivedRuns(context: LoopContext): Promise<void> {
  const { ledger, say } = context
  let changed = false

  for (const [run, record] of Object.entries(ledger.data.runs ?? {})) {
    if (record.endedAt || !record.process) {
      continue
    }

    const recorded = record.process
    const ended = await context.endProcess(run, recorded)

    say(record.id, 'outlived-process', { run, role: record.role, ...recorded, ...ended }, outlivedNotice(run, recorded, ended))

    if (ended.outcome !== 'failed') {
      record.process = null
      changed = true
    }
  }

  if (changed) {
    ledger.save()
  }
}

export async function start(context: LoopContext): Promise<void> {
  const { manifest, ledger, github, say, now } = context

  await endOutlivedRuns(context)

  for (const pr of manifest.all) {
    const role = transitions.recoverRun(ledger.prs[pr.id], { refund: true, at: now() })

    if (role) {
      say(pr.id, 'recovered-interrupted', { role })
    }
  }

  // No tick makes the label call again. A label lost to an outage waits for the next start.
  await startStep(context, 'fetch', () => github.fetchOrigin(manifest))
  await startStep(context, 'label', () => github.ensureLabel(manifest))

  const active = new Set(manifest.prs.map((pr) => pr.id))

  for (const pr of manifest.prs) {
    for (const dep of pr.deps.filter((id) => !active.has(id) && ledger.prs[id].state !== 'merged')) {
      say(pr.id, 'waiting-outside-dep', { dep }, `${pr.id} waits for ${dep}, which is not in this run (--only) and not merged`)
    }
  }

  ledger.save()
  say('-', 'driver-start', {
    prs: manifest.prs.map((pr) => pr.id),
    dryRun: manifest.dryRun,
    merge: manifest.policy.merge,
    pid: context.pid,
    ...context.runtimeSummary(manifest),
  })
}

// Measured from the end of the last tick, a long tick never reads as sleep.
function noticeSleep(context: LoopContext): void {
  const { manifest, state, say } = context

  if (state.lastTickEnd === null) {
    return
  }

  const slept = context.sleptMs(context.clock() - state.lastTickEnd, manifest.policy.tickSeconds * 1000)

  if (slept > 0) {
    state.wokeAt = context.clock()
    say('-', 'machine-slept', { minutes: Math.round(slept / 60_000) })
  }
}

// The PR's labels follow its ledger state. sync reads what the PR carries,
// so a quiet tick makes no extra GitHub call. Labels only inform people:
// a failure is kept on the PR's row and retried next tick, never counted
// as the PR's error or allowed to stop the tick.
async function syncStageLabels(context: LoopContext, pr: LoopPr): Promise<void> {
  const { manifest, ledger } = context
  const entry = ledger.prs[pr.id]
  const wanted = context.stageLabels(entry)
  const changes = context.labelChanges(entry.stageLabels ?? [], wanted)

  if (!entry.pr || (changes.add.length === 0 && changes.remove.length === 0)) {
    return
  }

  try {
    await context.github.setStageLabels(manifest, entry.pr, changes)
    entry.stageLabels = wanted
    entry.stageLabelError = null
  } catch (error) {
    entry.stageLabelError = messageOf(error).slice(0, 300)
  }
}

// At the end of a tick only: a status a step passes through leaves no
// event, and one that a job's end or start wrote waits for the next tick.
function logStatusChanges({ manifest, ledger, state, say }: LoopContext): void {
  for (const pr of manifest.all) {
    const entry = ledger.prs[pr.id]
    const key = statusKey(entry)

    if (state.loggedStatus.get(pr.id) !== key) {
      state.loggedStatus.set(pr.id, key)
      say(pr.id, 'status', statusDetail(entry))
    }
  }
}

// The heartbeat carries the numbers of every tick. A slow one is logged too,
// at most once in ten minutes, so a slow GitHub does not flood the events.
function measureTick(context: LoopContext, startedAt: number, endedAt: number): void {
  const { manifest, ledger, state, say } = context
  const { requests, cached, remaining } = context.github.clientFor(manifest).stats()
  const ms = Math.round(endedAt - startedAt)

  ledger.beat(context.tickNote({ ms, requests, cached, remaining }))

  const slow = ms > manifest.policy.tickSeconds * 1000
  const saidLately = state.slowSaidAt !== null && endedAt - state.slowSaidAt < SLOW_TICK_QUIET_MS

  if (!slow || saidLately) {
    return
  }

  state.slowSaidAt = endedAt
  say('-', 'tick-slow', { ms, requests, cached, remaining })
}

export async function tick(context: LoopContext): Promise<void> {
  const { manifest, ledger, state, github, now } = context
  const startedAt = context.clock()

  ledger.beat()
  // On every tick, never once: setFetch replaces the client.
  github.clientFor(manifest).resetStats()
  state.erredThisTick.clear()
  state.reads = github.tickReads()
  state.unavailableThisTick.clear()
  state.outageThisTick = false

  try {
    noticeSleep(context)
    reloadManifest(context)
    applyCommands(context.commandContext)
    const fetched = await driverStep(context, 'fetch', () => github.fetchOrigin(manifest))
    await driverStep(context, 'outside-deps', () => github.refreshOutsideDeps(manifest, ledger))
    await driverStep(context, 'watch-base', () => watchBase(context.gateContext))

    for (const pr of manifest.prs) {
      await guarded(context, pr, () => sync(context.syncContext, pr))
      await guarded(context, pr, () => handleFeedback(context.syncContext, pr))
    }

    // The gate runs before slots are handed out: a conflict it finds on a
    // high-priority PR then competes for a slot in this same tick, ahead
    // of new briefs for lower-priority PRs. A stale base would mislead the
    // gate and the rebase, so a tick without a fetch merges nothing.
    if (fetched) {
      await mergeNext(context.gateContext)
    }

    if (!ledger.data.hold && !state.stopping) {
      const order = [...manifest.prs].sort((left, right) => right.priority - left.priority || left.order - right.order)

      for (const pr of order) {
        await guarded(context, pr, () => advance(context, pr))
      }
    } else if (ledger.data.hold) {
      // The rollout's hold shows over a PR's own.
      for (const pr of manifest.prs) {
        transitions.heldStatus(ledger.prs[pr.id], 'rollout', now())
      }
    }

    // During an outage every label call would wait for its timeout.
    if (!state.outageThisTick) {
      for (const pr of manifest.prs) {
        await syncStageLabels(context, pr)
      }
    }

    // Here and not in finally: a tick that threw may have skipped a PR's
    // steps, or never reached GitHub.
    for (const pr of manifest.prs) {
      if (!state.erredThisTick.has(pr.id) && !state.unavailableThisTick.has(pr.id)) {
        ledger.prs[pr.id].tickErrors = 0
      }
    }

    const outage = ledger.data.githubUnavailable

    if (!state.outageThisTick && outage) {
      githubBack(context, outage)
    }

    for (const pr of manifest.prs) {
      if (!ledger.prs[pr.id].held && !ledger.data.hold) {
        transitions.unheld(ledger.prs[pr.id], now())
      }
    }

    logStatusChanges(context)
  } finally {
    const endedAt = context.clock()

    state.reads = null
    state.lastTickEnd = endedAt
    ledger.save()
    measureTick(context, startedAt, endedAt)
  }
}

// Never rejects, so the run loop outlives any tick. The fifth failed tick
// in a row notifies. The disk may be what failed, so the notice goes out
// before the writes, and a failed write is only reported.
export async function runTick(context: LoopContext): Promise<void> {
  const { manifest, ledger, state } = context

  try {
    await tick(context)
    state.failedTicks = 0
  } catch (error) {
    state.failedTicks += 1

    const message = messageOf(error)
    console.error(`tick error: ${message}`)

    if (state.failedTicks === MAX_TICK_ERRORS) {
      context.notify(`rollout ${manifest.rollout}`, `${state.failedTicks} ticks in a row failed: ${message.slice(0, 100)}`)
    }

    try {
      ledger.event('-', 'tick-error', { error: String(fieldOf(error, 'stack') ?? error).slice(0, 2000), count: state.failedTicks })
      ledger.beat(`tick-error ${message.slice(0, 200)}`)
    } catch (writeError) {
      console.error(`tick error not logged: ${messageOf(writeError)}`)
    }
  }
}

export function finished({ manifest, ledger, running }: LoopContext): boolean {
  return running.size === 0 && manifest.prs.every((pr) => ledger.prs[pr.id].state === 'merged')
}

export async function finish(context: LoopContext): Promise<void> {
  const { manifest, ledger, say } = context
  const release = await context.github.findReleasePr(manifest).catch(() => null)
  const cost = manifest.prs.reduce((sum, pr) => sum + ledger.prs[pr.id].costUsd, 0)
  const text = release
    ? `All PRs merged. Release PR #${release.number} is open: review it and merge it yourself to publish.`
    : 'All PRs merged. No release PR is open yet (the release workflow may still be running).'

  say('-', 'finished', { cost: Number(cost.toFixed(2)), release: release?.url ?? null }, text)
}

// A stop ends every run as a merge on GitHub ends one: the agent processes
// are killed, and the signal of every run is aborted, so an agent with no
// process ends too. The ledger is saved once the runs ended, so it holds
// their results. A run still going after the wait keeps its running status.
// The next start ends the run's process and then resumes the run.
export async function stop(context: LoopContext): Promise<void> {
  const { ledger, running, state } = context

  state.stopping = true
  context.stopAllAgents()

  for (const controller of state.agentRuns.values()) {
    controller.abort()
  }

  for (let waited = 0; (running.size > 0 || context.liveChildren() > 0) && waited < STOP_WAIT_SECONDS; waited += 1) {
    await context.sleep(1000)
  }

  ledger.save()
}
