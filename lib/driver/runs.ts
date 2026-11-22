import * as transitions from '../transitions.ts'
import type { PrEntry } from '../transitions.ts'
import { matchKey, sentCandidates } from '../review.ts'
import type {
  BudgetRole,
  CandidateAnswer,
  Finding,
  Head,
  Hold,
  IsoTime,
  QuestionKind,
  ReviewMemory,
  Role,
  RunningCode,
  SentCandidate,
} from '../state.ts'
import { applyNote } from './commands.ts'
import type { CommandsContext } from './commands.ts'

// The runs the driver starts and how each one ends: the launch of a brief,
// implement, fix, verify or delegate run, the pre-verify commands, and the
// handlers that read their results. Each result sets the PR's stage and
// status through lib/transitions.ts. Nothing here reads the clock, the disk
// or GitHub itself: the context brings it, as lib/driver.mjs builds it.

export const EVIDENCE_CHARS = 300
const REFUTATION_EVIDENCE_CHARS = 1000
const AGENT_RUNS: ReadonlySet<RunningCode> = new Set(['brief-write', 'brief-review', 'implement', 'fix', 'verify'] as const)

type Effort = string
type BriefStep = 'write' | 'review'

export interface RunPr {
  id: string
  brief: string
  branch: string
  model: { implement: string }
  effort: { implement: Effort; verify: Effort; brief: Effort }
}

interface CommandLists {
  required: string[]
  recommended: string[]
}

interface BriefGateConfig {
  runChecks?: boolean
  required?: string[]
  recommended?: string[]
}

export interface RunManifest {
  rollout: string
  model: string
  repo: { base: string }
  policy: { attempts: Record<BudgetRole, number>; merge: string; delegate: { effort: Effort } | null }
  gates: { brief: BriefGateConfig; ready: CommandLists; preVerify: CommandLists }
}

// What an agent reported, by the schema of its role.
interface Blocked {
  kind: QuestionKind
  question: string
  evidence: string
}

interface Addressed {
  id: string
  action: string
  outcome?: string
}

export interface ReadyReport {
  status: 'READY' | 'BLOCKED'
  pr?: number
  headSha?: string
  summary: string
  blocked?: Blocked
  addressed?: Addressed[]
  deviations?: unknown[]
  gates?: unknown[]
}

interface Recheck {
  id: string
  status: string
  evidence: string
}

interface Verdict {
  verdict: 'PASS' | 'FAIL'
  sha: string
  summary?: string
  checklist?: unknown[]
  blocking?: string[]
  nonBlocking?: string[]
  recheck?: Recheck[]
  criteria?: unknown[]
  external?: unknown[]
}

interface BriefReport {
  brief: string
  questions?: string[]
  notes: string
  expectedFiles: string[]
  changesetBump: string
  checks?: unknown[]
  criteria?: unknown[]
}

interface DelegateReport {
  decision: 'answer' | 'escalate'
  answer: string
  planRefs: string[]
  reasoning: string
}

// What runAgent resolves with. It never rejects.
export interface AgentResult<Report> {
  ok: boolean
  output?: Report | null
  costUsd?: number
  seconds?: number
  awakeSeconds?: number
  denials?: unknown[]
  error?: string | null
  stopped?: boolean
  transient?: boolean
  account?: boolean
  sessionMissing?: boolean
  model?: string | null
  logError?: string | null
  previewConflict?: boolean
  run?: string
  // What Claude Code reported, set when the run's own cost differs from it.
  reportedCost?: number
}

interface AgentOptions {
  role: Role
  prompt: string
  effort: Effort
  model: string
  sessionId: string
  resume?: boolean
  cwd: string
  logName: string
}

interface Reports {
  implement: ReadyReport
  fix: ReadyReport
  verify: Verdict
  brief: BriefReport
  delegate: DelegateReport
}

// The fields each role's headline reads.
interface Headlined {
  status?: string
  verdict?: string
  questions?: unknown[]
  decision?: string
}

interface CommandRun {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  stopped: boolean
  tail: string
  seconds: number
}

interface CommandStep {
  command: string
  stage: 'ready' | 'preVerify'
  level: 'required' | 'recommended'
}

interface CommandRecord extends CommandStep {
  result: 'pass' | 'fail'
  summary: string
  tail: string
  changes: string[]
}

// The commands of one pre-verify job, captured at its start.
export interface CommandsJob {
  sha: string
  steps: CommandStep[]
  key: string
}

interface CommandsOutcome {
  stopped: boolean
  results: CommandRecord[]
}

interface Tree {
  clean: boolean
  status: string
  head: string
}

interface BriefCriterion {
  id: string
  level: 'required' | 'recommended'
  text: string
}

interface BriefGates {
  runChecks: boolean
  criteria: BriefCriterion[]
}

interface BriefOutcome {
  checks: { command: string; exitCode: number; evidence: string; result: string }[]
  criteria: (BriefCriterion & { result: string; evidence: string })[]
  questions: string[]
  failedRecommended: unknown[]
}

interface CriterionResult {
  id: string
  level: string
  result: string
  evidence: string
}

interface CriteriaOutcome {
  results: CriterionResult[]
  failedRequired: CriterionResult[]
  findings: string[]
}

interface CandidatesOutcome {
  results: CandidateAnswer[]
  confirmed: CandidateAnswer[]
  findings: { text: string; key: string }[]
}

interface FeedbackItem {
  id: string
  commentId: number | string | null
  body: string
}

// A run as the ledger records it, as far as this module reads it.
interface StoredRun {
  id: string
  role: Role
  startedAt: IsoTime | null
  endedAt: IsoTime | null
  ok: boolean | null
  error: string | null
}

// The fields of an entry this module reads beside the ones transitions.ts types.
export type RunEntry = PrEntry & {
  costUsd: number
  modelRaised?: boolean
  briefDrift?: { id: string; sha: string }[]
  findings: { at: IsoTime; items: Finding[] } | null
  ready: ReadyReport | null
  author?: string | null
  feedbackInFix?: FeedbackItem[]
  feedbackHandled?: unknown[]
  verifyCriteria?: unknown[] | null
  preVerify?: { sha: string; at: IsoTime; results: CommandRecord[] } | null
  preVerifyCleanup?: string | null
  // A verdict from before the external review has no external.
  verdicts?: { external?: Pick<CandidateAnswer, 'key' | 'file'>[] }[]
}

interface RunLedger {
  data: { hold: Hold | null; runs?: Record<string, StoredRun> }
  prs: Record<string, RunEntry>
  save: () => void
}

interface RunStart {
  run: string
  id: string
  role: Role
  step?: BriefStep
  reason?: string | null
  effort: Effort
  model: string
  resume?: boolean
}

type DoneDetail = ReturnType<typeof doneDetail>
type Say = (id: string, kind: string, detail?: object, message?: string | null) => void
type GateCheck = { stage: string; level: string; item: string; result: string; evidence: string }

// The context lib/driver.mjs builds once. tsc reads no .mjs file, so every
// function of a .mjs module or of Node comes in here, typed by what this
// module passes and reads.
export interface RunsContext {
  manifest: RunManifest
  ledger: RunLedger
  running: CommandsContext['running']
  commandContext: CommandsContext
  say: Say
  notify: (title: string, message: string) => void
  now: () => IsoTime
  cleanup: (pr: RunPr) => Promise<unknown>
  runAgent: <AgentRole extends Role>(
    manifest: RunManifest,
    pr: RunPr,
    options: AgentOptions & { role: AgentRole },
  ) => Promise<AgentResult<Reports[AgentRole]>>
  runCommand: (manifest: RunManifest, pr: RunPr, options: { command: string; cwd: string }) => Promise<CommandRun>
  isStopping: () => boolean
  // The GitHub reads of the running tick, null between ticks.
  reads: () => unknown

  // The driver's own steps, which code that stays in lib/driver.mjs uses too.
  toFix: (pr: RunPr, reason: string, note: string) => void
  gateCheck: (pr: RunPr, entry: RunEntry, check: GateCheck) => void
  lastEndedRun: (id: string) => string | null
  localConfigRemoved: (pr: RunPr, paths: string[] | null | undefined) => void
  questionHash: (blocked: { kind: string; question?: string | null }) => string
  delegateTakes: (entry: RunEntry) => boolean
  approvalChannel: (author: string | null | undefined) => 'github' | 'inbox' | null

  github: {
    forgetPr: (reads: unknown, number: number | null) => void
    viewPr: (manifest: RunManifest, number: number) => Promise<{ headRefName: string; baseRefName: string; state: string }>
    prNotFound: (manifest: RunManifest, error: unknown) => Promise<boolean>
    replyAsAgents: (manifest: RunManifest, number: number | null, commentId: number | string, body: string) => Promise<void>
    commentAsAgents: (manifest: RunManifest, number: number | null, body: string) => Promise<void>
    unmergedHeads: (pr: RunPr, ledger: RunLedger) => Head[] | null
    blobAt: (manifest: RunManifest, sha: string, path: string) => Promise<string | null>
  }

  prompts: {
    implementPrompt: (manifest: RunManifest, pr: RunPr, entry: RunEntry) => string
    fixPrompt: (
      manifest: RunManifest,
      pr: RunPr,
      entry: RunEntry,
      options: { reason?: string; note: string; head: string | null; previous: string | null },
    ) => string
    resumeFreshPrompt: (
      manifest: RunManifest,
      pr: RunPr,
      entry: RunEntry,
      options: { reason?: string; note: string; previous: string | null },
    ) => string
    verifyPrompt: (manifest: RunManifest, pr: RunPr, entry: RunEntry, sha?: string) => string
    briefWritePrompt: (manifest: RunManifest, pr: RunPr, entry: RunEntry, heads: Head[], gates: BriefGates) => string
    briefReviewPrompt: (manifest: RunManifest, pr: RunPr, entry: RunEntry, draft: string, heads: Head[], gates: BriefGates) => string
    briefReviewNotes: (notes: string, failed: unknown[]) => string
    delegatePrompt: (manifest: RunManifest, pr: RunPr, entry: RunEntry) => string
    findingsNote: (items: Finding[], checklist: unknown[] | undefined, leftovers: string) => string
    preVerifyNote: (sha: string, failed: CommandRecord[], report: ReadyReport | null) => string
  }

  worktree: {
    worktreePath: (manifest: RunManifest, pr: RunPr) => string
    prepareWorktree: (manifest: RunManifest, pr: RunPr) => Promise<string>
    preparePreview: (manifest: RunManifest, pr: RunPr, heads: Head[]) => Promise<string | null>
    removePreview: (manifest: RunManifest, pr: RunPr) => Promise<void>
    inspectWorktree: (manifest: RunManifest, pr: RunPr) => Promise<Tree>
    resetWorktree: (manifest: RunManifest, pr: RunPr, sha: string) => Promise<string[]>
  }

  records: {
    reserveRunName: (manifest: RunManifest, base: string) => string
    startRun: (data: RunLedger['data'], start: RunStart) => void
    endRun: (data: RunLedger['data'], run: { id: string; role: Role; step?: BriefStep }, detail: DoneDetail) => void
    recordAnswers: (entry: RunEntry, addressed: Addressed[]) => void
    recordVerdict: (entry: RunEntry, verdict: object) => void
    recordFindings: (entry: RunEntry, blocking: string[], at: IsoTime, fromReview?: (string | null)[]) => void
    recheckedFindings: (entry: RunEntry, recheck: Recheck[]) => unknown[]
  }

  checks: {
    briefGates: (config: BriefGateConfig) => BriefGates
    briefOutcome: (gates: BriefGates, report: BriefReport) => BriefOutcome
    commandResult: (step: CommandStep, run: CommandRun, tree: Tree, sha: string) => CommandRecord
    criteriaOutcome: (sent: unknown[], reported: unknown[]) => CriteriaOutcome
    candidatesOutcome: (sent: SentCandidate[], reported: unknown[]) => CandidatesOutcome
    preVerifyOutcome: (results: CommandRecord[]) => { failedRequired: CommandRecord[]; reason: string | null }
  }

  files: {
    existsSync: (path: string) => boolean
    mkdirSync: (path: string, options: { recursive: true }) => unknown
    writeFileSync: (path: string, text: string) => void
    dirname: (path: string) => string
  }

  raiseEffort: (effort: Effort, attempt: number) => Effort
  sentences: (...parts: string[]) => string
  randomUUID: () => string
}

const HEADLINES: Record<Role, (output: Headlined | null | undefined) => string | null> = {
  implement: (output) => output?.status ?? null,
  fix: (output) => output?.status ?? null,
  verify: (output) => output?.verdict ?? null,
  brief: (output) => ((output?.questions?.length ?? 0) > 0 ? 'QUESTIONS' : 'BRIEF'),
  delegate: (output) => output?.decision?.toUpperCase() ?? null,
}

// The detail of every *-done event. `run` pairs it with its *-start, and
// `model` is the one the run reported, so costs compare across models.
export function doneDetail(role: Role, run: string, result: AgentResult<Headlined>) {
  return {
    run,
    model: result.model ?? null,
    ok: result.ok,
    result: result.ok ? HEADLINES[role](result.output) : null,
    cost: result.costUsd,
    ...(result.reportedCost === undefined ? {} : { reportedCost: result.reportedCost }),
    seconds: result.seconds,
    awakeSeconds: result.awakeSeconds ?? null,
    denials: result.denials?.length ?? 0,
    stopped: Boolean(result.stopped),
    error: result.error?.slice(0, 200) ?? null,
  }
}

// The dependencies a brief was written ahead of that merged with another
// patch than the one the brief saw, or with none the ledger knows.
export function briefDrift(heads: Head[] | null | undefined, entries: Record<string, { verified?: { patchId?: string | null } | null }>) {
  return (heads ?? [])
    .filter((head) => !head.patchId || entries[head.id]?.verified?.patchId !== head.patchId)
    .map((head) => ({ id: head.id, sha: head.sha }))
}

function headLabel(head: Head): string {
  return `${head.id}@${head.sha.slice(0, 7)}`
}

export function headsKey(heads: Head[]): string {
  return heads.map((head) => `${head.id}@${head.sha}`).join(',')
}

// What a job that threw before its agent ended reports.
function thrown(error: unknown): AgentResult<never> {
  return { ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }
}

// Claude Code reports a resumed session's cost from the session's start, so a
// resumed run owns only what the session's reported cost rose by.
function ownCost<Report>(entry: RunEntry, role: Role, resume: boolean, result: AgentResult<Report>): AgentResult<Report> {
  const reported = result.costUsd ?? 0
  const earlier = entry.sessionCostUsd

  if (role !== 'verify' && reported > 0) {
    entry.sessionCostUsd = reported
  }

  if (!resume) {
    return result
  }

  const own = Math.max(0, Number((reported - earlier).toFixed(4)))

  return own === reported ? result : { ...result, costUsd: own, reportedCost: reported }
}

function addCost(entry: RunEntry, result: AgentResult<unknown>): void {
  entry.costUsd = Number((entry.costUsd + (result.costUsd ?? 0)).toFixed(4))
}

// The whole summary, then as much of the end of the output as fits.
function commandEvidence(record: CommandRecord): string {
  const tail = record.tail.trim()
  const room = EVIDENCE_CHARS - record.summary.length - 2

  if (!tail || room <= 0) {
    return record.summary
  }

  return `${record.summary}: ${tail.slice(-room)}`
}

// The current findings the implementer disputed and the verifier still finds
// open. A finding the re-check leaves out is not upheld.
function upheldDisputes(entry: RunEntry, recheck: Recheck[]): Finding[] {
  return (entry.findings?.items ?? []).filter(
    (item) => item.answer?.outcome === 'disputed' && recheck.some((check) => check.id === item.id && check.status === 'open'),
  )
}

// The next FAIL renumbers the findings, so the text names the dispute by its
// words too. Only the first one's text and reason fit.
function disputeText(context: RunsContext, upheld: Finding[]): string {
  const [first] = upheld
  const intro = `the verifier still finds ${upheld.map((item) => item.id).join(', ')} open, which the implementer disputed`
  const finding = upheld.length === 1 ? [`${intro}: ${first.text}`] : [intro, `${first.id}: ${first.text}`]

  return context.sentences(...finding, `The implementer: ${first.answer?.action ?? ''}`).slice(0, 1000)
}

// Every note reaches an agent through the next brief, implement or fix run:
// as pendingNote, the fix note or a brief answer. An agent at work never
// reads one. Records from older ledgers have no `run` and stay that way.
function stampNotes(entry: RunEntry, run: string): void {
  for (const record of entry.noteHistory ?? []) {
    if (record.run === null) {
      record.run = run
    }
  }
}

// A PR's model.implement runs its implement and fix runs until one of them
// also raises the effort: a second implement attempt or a third fix. That
// run and every later one go to the rollout's model, also after rollout
// retry, because the PR proved too hard for the first.
function implementerModel(context: RunsContext, pr: RunPr, entry: RunEntry, raised: boolean): string {
  entry.modelRaised = entry.modelRaised || raised

  return entry.modelRaised ? context.manifest.model : pr.model.implement
}

// The error of the PR's last implement or fix run, when it ran for the fix
// owed now and ended without a report. Read before the next run is recorded.
function previousRun(context: RunsContext, pr: RunPr, entry: RunEntry): string | null {
  const fix = entry.fix

  if (!fix || fix.reason === 'no-report') {
    return null
  }

  let last: StoredRun | null = null

  for (const record of Object.values(context.ledger.data.runs ?? {})) {
    const implementer = record.role === 'implement' || record.role === 'fix'

    if (record.id === pr.id && implementer && record.startedAt && (!last || record.startedAt >= (last.startedAt ?? ''))) {
      last = record
    }
  }

  if (!last?.startedAt || !last.endedAt || last.ok !== false || Date.parse(last.startedAt) < Date.parse(fix.since)) {
    return null
  }

  return last.error || 'unknown'
}

// A job ends outside any tick, where nothing catches a throw, and an
// unhandled rejection would end the driver and orphan every agent. So a
// failed write here is only printed. The tick's own save tries again.
async function endJob(context: RunsContext, pr: RunPr, work: Promise<unknown>, onError: (error: unknown) => void): Promise<void> {
  let failure: { error: unknown } | null = null

  try {
    await work
  } catch (error) {
    failure = { error }
  }

  context.running.delete(pr.id)

  if (failure) {
    try {
      onError(failure.error)
    } catch (handlerError) {
      console.error(`${pr.id} job error not handled: ${String(errorMessage(handlerError))}`)
    }
  }

  try {
    context.ledger.save()
  } catch (saveError) {
    console.error(`${pr.id} ledger not saved at the end of a job: ${String(errorMessage(saveError))}`)
  }
}

function errorMessage(error: unknown): unknown {
  return error instanceof Error ? error.message : error
}

function logFailed({ say }: RunsContext, pr: RunPr, run: string, result: AgentResult<unknown>): void {
  if (result.logError) {
    say(pr.id, 'log-failed', { run, error: result.logError })
  }
}

// A brief, implement, fix or verify run still holds the PR.
function agentAtWork(entry: RunEntry): boolean {
  const status = entry.status

  return status?.kind === 'running' && AGENT_RUNS.has(status.code)
}

export interface LaunchOptions {
  reason?: string
  note?: string
  sha?: string
}

export function launch(context: RunsContext, pr: RunPr, role: BudgetRole, { reason, note, sha }: LaunchOptions = {}): void {
  const { manifest, ledger, say, now, prompts } = context
  const entry = ledger.prs[pr.id]

  if (context.isStopping()) {
    return
  }

  if (role === 'brief') {
    launchBrief(context, pr)
    return
  }

  // An implement or fix run needs a brief. With no PR yet, the way on is to write one.
  if (!context.files.existsSync(pr.brief) && !entry.pr) {
    transitions.toPending(entry, now())
    say(pr.id, 'brief-missing', { role })
    return
  }

  if (entry.attempts[role] >= manifest.policy.attempts[role]) {
    transitions.escalateExhausted(entry, { role, limit: manifest.policy.attempts[role], at: now(), run: context.lastEndedRun(pr.id) })
    say(pr.id, 'escalated', { role }, `${role} attempts exhausted, needs you (rollout retry or note)`)
    return
  }

  entry.attempts[role] += 1

  let prompt: string
  let effort: Effort
  let model: string
  let resume = false
  let sessionId: string

  if (role === 'implement') {
    sessionId = context.randomUUID()
    entry.sessionId = sessionId
    entry.sessionCostUsd = 0
    effort = context.raiseEffort(pr.effort.implement, entry.attempts.implement - 1)
    model = implementerModel(context, pr, entry, entry.attempts.implement > 1)
    entry.briefDrift = briefDrift(entry.briefHeads, ledger.prs)
    prompt = prompts.implementPrompt(manifest, pr, entry)
    // A pending note is already in noteHistory, which the prompt lists.
    entry.pendingNote = null
  } else if (role === 'fix') {
    const text = [note, entry.pendingNote].filter(Boolean).join('\n\n')
    const previous = previousRun(context, pr, entry)

    effort = context.raiseEffort(pr.effort.implement, Math.max(0, entry.attempts.fix - 2))
    model = implementerModel(context, pr, entry, entry.attempts.fix > 2)

    if (entry.sessionId) {
      sessionId = entry.sessionId
      resume = true
      prompt = prompts.fixPrompt(manifest, pr, entry, { reason, note: text, head: entry.claimedSha, previous })
    } else {
      sessionId = context.randomUUID()
      entry.sessionId = sessionId
      entry.sessionCostUsd = 0
      prompt = prompts.resumeFreshPrompt(manifest, pr, entry, { reason, note: text, previous })
    }

    entry.pendingNote = null
  } else {
    sessionId = context.randomUUID()
    effort = pr.effort.verify
    model = manifest.model
    prompt = prompts.verifyPrompt(manifest, pr, entry, sha)
  }

  transitions.runStarted(entry, role, { at: now(), sha })
  const total = entry.attempts.implement + entry.attempts.fix + entry.attempts.verify
  const logName = `${pr.id}-${String(total).padStart(2, '0')}-${role}`
  const run = context.records.reserveRunName(manifest, logName)
  transitions.runName(entry, run)

  if (role !== 'verify') {
    stampNotes(entry, run)
  }

  say(pr.id, `${role}-start`, { run, log: `logs/${run}.jsonl`, effort, model, resume, reason })
  context.records.startRun(ledger.data, { run, id: pr.id, role, reason, effort, model, resume })

  const job = (async () => {
    const cwd = role === 'verify' ? context.worktree.worktreePath(manifest, pr) : await context.worktree.prepareWorktree(manifest, pr)

    return context.runAgent(manifest, pr, { role, prompt, effort, model, sessionId, resume, cwd, logName: run })
  })().catch(thrown)

  context.running.set(pr.id, role)
  endJob(
    context,
    pr,
    job.then((result) => onDone(context, pr, role, ownCost(entry, role, resume, result), { sha, run })),
    (error) => {
      say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) })

      if (agentAtWork(ledger.prs[pr.id])) {
        transitions.runFailed(ledger.prs[pr.id], role, now())
        ledger.prs[pr.id].lastError = String(error)
      }
    },
  )
}

// Two read-only agents on a worktree of the current base: a writer drafts
// the brief from the plan and design notes, a reviewer checks every claim
// against the code and returns the final text. The driver writes the file.
// Dependencies that are verified but not merged yet go into a preview
// worktree, so the brief is written while they wait for approval.
function launchBrief(context: RunsContext, pr: RunPr): void {
  const { manifest, ledger, say, now, records } = context
  const entry = ledger.prs[pr.id]

  if (entry.attempts.brief >= manifest.policy.attempts.brief) {
    transitions.escalateExhausted(entry, {
      role: 'brief',
      limit: manifest.policy.attempts.brief,
      at: now(),
      run: context.lastEndedRun(pr.id),
    })

    say(pr.id, 'escalated', { role: 'brief' }, 'could not write a brief, needs you (rollout retry or write briefs/' + pr.id + '.md)')
    return
  }

  entry.attempts.brief += 1
  transitions.runStarted(entry, 'brief', { at: now() })

  if (entry.pendingNote) {
    entry.briefAnswers = [...(entry.briefAnswers ?? []), { question: null, answer: entry.pendingNote }]
    entry.pendingNote = null
  }

  const effort = pr.effort.brief
  const model = manifest.model
  const heads = context.github.unmergedHeads(pr, ledger) ?? []
  const gates = context.checks.briefGates(manifest.gates.brief)
  const ahead = heads.length > 0 ? { ahead: heads.map(headLabel) } : {}
  const base = `${pr.id}-${String(entry.attempts.brief).padStart(2, '0')}-brief`

  function startStep(step: BriefStep): string {
    const run = records.reserveRunName(manifest, `${base}-${step}`)
    say(pr.id, 'brief-start', { run, log: `logs/${run}.jsonl`, step, effort, model, ...ahead })
    records.startRun(ledger.data, { run, id: pr.id, role: 'brief', step, effort, model })

    return run
  }

  // Every brief-start gets its brief-done, also when the step throws
  // before its agent ends.
  async function finishStep(
    step: BriefStep,
    run: string,
    work: () => Promise<AgentResult<BriefReport>>,
  ): Promise<AgentResult<BriefReport>> {
    let result: AgentResult<BriefReport>

    try {
      result = await work()
    } catch (error) {
      result = thrown(error)
    }

    const detail = { ...doneDetail('brief', run, result), step }
    say(pr.id, 'brief-done', detail)
    records.endRun(ledger.data, { id: pr.id, role: 'brief', step }, detail)
    logFailed(context, pr, run, result)

    return result
  }

  const writeRun = startStep('write')
  transitions.runName(entry, writeRun)
  stampNotes(entry, writeRun)

  async function write(): Promise<AgentResult<BriefReport>> {
    let cwd = ''
    const writer = await finishStep('write', writeRun, async () => {
      const prepared =
        heads.length > 0 ? await context.worktree.preparePreview(manifest, pr, heads) : await context.worktree.prepareWorktree(manifest, pr)

      // Not a failed run: the brief waits until the dependencies merge.
      if (!prepared) {
        const error = `${heads.map(headLabel).join(', ')} do not merge cleanly onto origin/${manifest.repo.base}`

        return { ok: false, previewConflict: true, error, costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }
      }

      cwd = prepared

      return context.runAgent(manifest, pr, {
        role: 'brief',
        prompt: context.prompts.briefWritePrompt(manifest, pr, entry, heads, gates),
        effort,
        model,
        sessionId: context.randomUUID(),
        cwd,
        logName: writeRun,
      })
    })

    if (!writer.ok) {
      return writer
    }

    const draft = (writer.output as BriefReport).brief
    const prompt = context.prompts.briefReviewPrompt(manifest, pr, entry, draft, heads, gates)
    const reviewRun = startStep('review')
    transitions.reviewStarted(entry, { run: reviewRun, at: now() })
    const reviewer = await finishStep('review', reviewRun, () =>
      context.runAgent(manifest, pr, { role: 'brief', prompt, effort, model, sessionId: context.randomUUID(), cwd, logName: reviewRun }),
    )

    return {
      ...reviewer,
      costUsd: (writer.costUsd ?? 0) + (reviewer.costUsd ?? 0),
      seconds: (writer.seconds ?? 0) + (reviewer.seconds ?? 0),
      awakeSeconds: (writer.awakeSeconds ?? 0) + (reviewer.awakeSeconds ?? 0),
      run: reviewRun,
    }
  }

  const job = (async () => {
    try {
      return await write()
    } finally {
      if (heads.length > 0) {
        await context.worktree.removePreview(manifest, pr).catch(() => {})
      }
    }
  })().catch(thrown)

  context.running.set(pr.id, 'brief')
  endJob(
    context,
    pr,
    job.then((result) => onBriefDone(context, pr, result, heads, gates)),
    (error) => {
      say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) })
      transitions.toPending(ledger.prs[pr.id], now())
    },
  )
}

// A brief has no claim and no head of its own, so gateCheck's dedupe does not
// fit it. The dependency heads it saw tie each result to its code instead.
function briefGateChecks({ say }: RunsContext, pr: RunPr, heads: Head[], outcome: BriefOutcome): void {
  const ahead = heads.map(headLabel)
  const checks = outcome.checks.map((check) => ({
    item: check.command,
    level: 'required',
    result: check.result,
    evidence: `exit ${check.exitCode}: ${check.evidence}`,
  }))

  const criteria = outcome.criteria.map((criterion) => ({ ...criterion, item: criterion.id }))

  for (const record of [...checks, ...criteria]) {
    say(pr.id, 'gate-check', {
      stage: 'brief',
      item: record.item,
      level: record.level,
      result: record.result,
      ahead,
      evidence: record.evidence.slice(0, EVIDENCE_CHARS),
    })
  }
}

// `gates` are the ones the brief's agents saw, from launchBrief.
export function onBriefDone(
  context: RunsContext,
  pr: RunPr,
  result: AgentResult<BriefReport>,
  heads: Head[] = [],
  gates: BriefGates = context.checks.briefGates(context.manifest.gates.brief),
): void {
  const { ledger, say, now, files } = context
  const entry = ledger.prs[pr.id]

  addCost(entry, result)

  // The attempt goes back, and these heads are not tried again: a new
  // verification or a merge moves them on.
  if (result.previewConflict) {
    transitions.briefWaits(entry, headsKey(heads), { heads, at: now() })
    say(pr.id, 'brief-waits', { ahead: heads.map(headLabel) })
    return
  }

  if (!result.ok) {
    failed(context, pr, 'brief', result)
    transitions.toPending(entry, now())
    return
  }

  const out = result.output as BriefReport
  const outcome = context.checks.briefOutcome(gates, out)

  briefGateChecks(context, pr, heads, outcome)

  if (outcome.questions.length > 0) {
    transitions.toBlocked(
      entry,
      { kind: 'brief-questions', question: outcome.questions.join('\n'), evidence: out.notes, run: result.run ?? null },
      { at: now() },
    )

    say(
      pr.id,
      'blocked',
      { reason: 'brief-questions' },
      context.delegateTakes(entry)
        ? null
        : `the brief needs your decision: ${outcome.questions[0].slice(0, 100)} (rollout card ${pr.id}, then rollout note ${pr.id} "...")`,
    )

    return
  }

  files.mkdirSync(files.dirname(pr.brief), { recursive: true })
  files.writeFileSync(pr.brief, `${out.brief.trim()}\n`)
  files.writeFileSync(
    pr.brief.replace(/\.md$/, '.review-notes.md'),
    `${context.prompts.briefReviewNotes(out.notes, outcome.failedRecommended)}\n`,
  )

  transitions.briefWritten(entry, { scope: out.expectedFiles, heads, at: now() })
  say(pr.id, 'brief-written', { files: out.expectedFiles.length, bump: out.changesetBump })
}

// Whether the delegate's run `run` is still the one at work on the PR. A
// maintainer's note while it ran hands the question back and moves the PR on.
function delegating(entry: RunEntry, run: string): boolean {
  const status = entry.status

  return status?.kind === 'running' && status.code === 'delegate' && status.run === run
}

// A read-only agent answers the question a PR is blocked on from the plan,
// or hands it back to the maintainer. The PR is running: delegate meanwhile.
export function launchDelegate(context: RunsContext, pr: RunPr): void {
  const { manifest, ledger, say, now, records } = context
  const entry = ledger.prs[pr.id]
  const policy = manifest.policy.delegate
  const asked = transitions.statusQuestion(entry.status)

  if (context.isStopping() || !policy || !asked) {
    return
  }

  const blocked = { kind: asked.kind, question: asked.text, evidence: asked.evidence }
  const question = context.questionHash({ kind: asked.kind, question: asked.text })
  const effort = policy.effort
  const model = manifest.model

  entry.delegate.runs += 1

  const run = records.reserveRunName(manifest, `${pr.id}-${String(entry.delegate.runs).padStart(2, '0')}-delegate`)

  transitions.delegateStarted(entry, { run, at: now() })
  // `blocked` and not `kind`, which would overwrite the event's own kind.
  say(pr.id, 'delegate-start', { run, log: `logs/${run}.jsonl`, effort, model, blocked: blocked.kind })
  records.startRun(ledger.data, { run, id: pr.id, role: 'delegate', reason: blocked.kind, effort, model })

  // The prompt is built in the job, so a missing briefing source fails this run instead of throwing in advance.
  const job = (async () => {
    const path = context.worktree.worktreePath(manifest, pr)
    const cwd = context.files.existsSync(path) ? path : await context.worktree.prepareWorktree(manifest, pr)
    const prompt = context.prompts.delegatePrompt(manifest, pr, entry)

    return context.runAgent(manifest, pr, {
      role: 'delegate',
      prompt,
      effort,
      model,
      sessionId: context.randomUUID(),
      resume: false,
      cwd,
      logName: run,
    })
  })().catch(thrown)

  context.running.set(pr.id, 'delegate')
  endJob(
    context,
    pr,
    job.then((result) => onDelegateDone(context, pr, result, { run, question, blocked })),
    (error) => say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) }),
  )
}

interface DelegatedQuestion {
  kind: QuestionKind
  question: string
  evidence: string
}

export async function onDelegateDone(
  context: RunsContext,
  pr: RunPr,
  result: AgentResult<DelegateReport>,
  { run, question, blocked }: { run: string; question: string; blocked: DelegatedQuestion },
): Promise<void> {
  const { ledger, say, now } = context
  const entry = ledger.prs[pr.id]

  addCost(entry, result)

  const detail = doneDetail('delegate', run, result)
  say(pr.id, 'delegate-done', detail)
  context.records.endRun(ledger.data, { id: pr.id, role: 'delegate' }, detail)
  logFailed(context, pr, run, result)

  if (entry.stage === 'merged') {
    await context.cleanup(pr)
    return
  }

  if (result.stopped) {
    entry.delegate.runs = Math.max(0, entry.delegate.runs - 1)

    if (delegating(entry, run)) {
      transitions.delegateReturned(entry, { outcome: null, reason: '', at: now() })
    }

    return
  }

  entry.delegate.lastQuestion = question

  const out: Partial<DelegateReport> = result.output ?? {}
  const report = {
    answer: typeof out.answer === 'string' ? out.answer : '',
    planRefs: Array.isArray(out.planRefs) ? out.planRefs : [],
    reasoning: typeof out.reasoning === 'string' ? out.reasoning : '',
  }

  function recordAnswer(decision: string, fields = {}): void {
    const answer = { at: now(), kind: blocked.kind, question: blocked.question ?? '', decision, ...report, ...fields, run }
    entry.delegate.answers = [...entry.delegate.answers, answer].slice(-20)
  }

  // A maintainer's note applied while the delegate ran. The note wins.
  if (!delegating(entry, run)) {
    recordAnswer('dropped')
    say(pr.id, 'delegate-dropped', { run, ...transitions.statusDetail(entry) })
    return
  }

  if (!result.ok) {
    recordAnswer('failed', { reasoning: result.error ?? '' })
    entry.lastError = result.error ?? null
    backOff(context, entry, result)
    escalateFromDelegate(context, pr, blocked, run, `the run failed: ${result.error}`)
    transitions.delegateReturned(entry, { outcome: 'failed', reason: result.error ?? '', at: now() })
    return
  }

  entry.failStreak = 0

  const answer = report.answer.trim()

  if (out.decision === 'answer' && answer) {
    recordAnswer('answer')
    applyNote(
      context.commandContext,
      pr.id,
      `Answer from the delegate, on the maintainer's behalf, from the plan:\n\n${answer}`,
      'delegate',
    )

    say(
      pr.id,
      'delegate-answered',
      { run, blocked: blocked.kind, planRefs: report.planRefs },
      context.sentences(`delegate answered: ${answer.slice(0, 100)}`, `Override with rollout note ${pr.id}`),
    )

    return
  }

  const reason = out.decision === 'answer' ? 'the delegate gave an empty answer' : report.reasoning

  recordAnswer('escalate')
  escalateFromDelegate(context, pr, blocked, run, reason)
  transitions.delegateReturned(entry, { outcome: 'escalated', reason, at: now() })
}

function escalateFromDelegate({ say, sentences }: RunsContext, pr: RunPr, blocked: DelegatedQuestion, run: string, reason: string): void {
  say(
    pr.id,
    'delegate-escalated',
    { run, blocked: blocked.kind, reason: reason.slice(0, 300) },
    sentences(
      `the delegate passes this to you (${blocked.kind}): ${(blocked.question ?? '').slice(0, 100)}`,
      reason.trim() ? `Reason: ${reason.slice(0, 100)}` : '',
      `Answer with rollout note ${pr.id}`,
    ),
  )
}

function failed(context: RunsContext, pr: RunPr, role: BudgetRole, result: AgentResult<unknown>): void {
  const entry = context.ledger.prs[pr.id]
  entry.lastError = result.error ?? null

  // Runs that did no work (a stop, an outage, a quota wall) give their
  // attempt back, a bounded number of times; every failure backs off.
  const idle = result.stopped || result.transient || result.account || ((result.costUsd ?? 0) < 0.01 && (result.seconds ?? 0) < 60)

  if (idle) {
    transitions.refundAttempt(entry, role)
  }

  backOff(context, entry, result)

  if (role !== 'verify' && result.sessionMissing) {
    entry.sessionId = null
    entry.sessionCostUsd = 0
  }

  transitions.runFailed(entry, role, context.now())
}

// A hold already in place stays as it is, a maintainer's above all. Every
// account failure still notifies.
function holdForAccount(context: RunsContext, result: Pick<AgentResult<unknown>, 'error'>): void {
  const { manifest, ledger, say } = context
  const notice = 'account limit reached, the rollout is held (rollout release --all)'

  if (ledger.data.hold) {
    context.notify(`rollout ${manifest.rollout}`, `-: ${notice}`)
    return
  }

  const reason = result.error?.slice(0, 200) || 'account limit'

  ledger.data.hold = { at: context.now(), by: 'driver', reason }
  say('-', 'held', { scope: 'rollout', by: 'driver', reason }, notice)
}

function backOff(context: RunsContext, entry: RunEntry, result: Pick<AgentResult<unknown>, 'account' | 'stopped' | 'error'>): void {
  if (result.account) {
    holdForAccount(context, result)
  }

  if (!result.stopped) {
    entry.failStreak = (entry.failStreak ?? 0) + 1
    entry.retryAfter = new Date(Date.parse(context.now()) + Math.min(2 ** entry.failStreak, 30) * 60_000).toISOString()
  }
}

export async function onDone(
  context: RunsContext,
  pr: RunPr,
  role: Exclude<BudgetRole, 'brief'>,
  result: AgentResult<ReadyReport | Verdict>,
  { sha = '', run }: { sha?: string; run: string },
): Promise<void> {
  const { ledger, say, now } = context
  const entry = ledger.prs[pr.id]

  // A run can end in the middle of a tick, after sync read the PR at its
  // head from before the push. checkClaim would take that read and move the
  // claim back to the old head.
  context.github.forgetPr(context.reads(), entry.pr)

  const reported = result.output && 'pr' in result.output ? result.output.pr : undefined

  if (reported && reported !== entry.pr) {
    context.github.forgetPr(context.reads(), reported)
  }

  addCost(entry, result)

  const detail = doneDetail(role, run, result)
  say(pr.id, `${role}-done`, detail)
  context.records.endRun(ledger.data, { id: pr.id, role }, detail)
  logFailed(context, pr, run, result)

  if (entry.stage === 'merged') {
    await context.cleanup(pr)
    return
  }

  if (!result.ok) {
    failed(context, pr, role, result)
    return
  }

  entry.failStreak = 0

  // The role picks the schema the agent reported in.
  if (role === 'verify') {
    await verified(context, pr, entry, result.output as Verdict, sha, run)
    return
  }

  const out = result.output as ReadyReport

  entry.ready = out

  if (out.status === 'BLOCKED') {
    const blocked = { ...(out.blocked ?? { kind: 'unknown' as const, question: out.summary, evidence: '' }), run }

    transitions.toBlocked(entry, blocked, { at: now() })
    say(
      pr.id,
      'blocked',
      { reason: blocked.kind },
      context.delegateTakes(entry) ? null : `blocked (${blocked.kind}): ${blocked.question.slice(0, 120)}`,
    )

    return
  }

  // A GitHub outage is no fault of the report, and a fix run would spend
  // an attempt on it. The report waits in entry.ready for a later tick.
  try {
    await claimReport(context, pr, entry, out)
  } catch (error) {
    transitions.reportWaits(entry, now())
    entry.lastError = String(errorMessage(error)).slice(0, 1000)
    say(pr.id, 'report-unchecked', { error: entry.lastError.slice(0, 300) })
  }
}

// A note queued while an agent or the commands worked goes to the implementer
// first, so no verifier holds the PR to an answer the implementer has not seen.
function noteFirst(context: RunsContext, pr: RunPr, entry: RunEntry): void {
  if (entry.pendingNote) {
    context.toFix(pr, 'answer from the maintainer', '')
  }
}

// Claimed or sent to a fix, the report is used up. entry.ready keeps the last
// report of every PR, so a stale 'report' role would claim it again.
export async function claimReport(context: RunsContext, pr: RunPr, entry: RunEntry, out: ReadyReport): Promise<void> {
  const { say } = context

  // Before the check, so a report it sends back or one parked for a later
  // tick still answers the findings.
  context.records.recordAnswers(entry, out.addressed ?? [])

  const problem = await checkReport(context, pr, out)
  transitions.reportUsed(entry)

  // checkReport names a report without a pr or a headSha as a problem too.
  if (problem || !out.pr || !out.headSha) {
    context.toFix(pr, 'report does not match GitHub', problem ?? '')
    return
  }

  transitions.toClaimed(entry, { pr: out.pr, sha: out.headSha, at: context.now() })
  say(pr.id, 'ready-claimed', { pr: out.pr, sha: out.headSha.slice(0, 7) })
  await answerFeedback(context, pr, entry, out.headSha, out.addressed ?? [])
  noteFirst(context, pr, entry)
}

// The READY report's PR number is the model's claim: it must name an open
// PR from this branch into the base. It names an unknown PR only when the
// PR read answers 404 and the repository still reads (gh.prNotFound). Any
// other error is thrown, a 404 for both included: a token that lost access
// to a private repo gets one for each.
async function checkReport(context: RunsContext, pr: RunPr, out: ReadyReport): Promise<string | null> {
  const { manifest, github } = context

  if (!out.pr || !out.headSha) {
    return 'Your READY report lacks `pr` or `headSha`. Finish the protocol and report again.'
  }

  try {
    const githubPr = await github.viewPr(manifest, out.pr)

    if (githubPr.headRefName !== pr.branch || githubPr.baseRefName !== manifest.repo.base || githubPr.state !== 'OPEN') {
      return `PR #${out.pr} is ${githubPr.state}, ${githubPr.headRefName} → ${githubPr.baseRefName}; expected an open PR ${pr.branch} → ${manifest.repo.base}.`
    }
  } catch (error) {
    if (!(await github.prNotFound(manifest, error))) {
      throw error
    }

    return `PR #${out.pr} could not be read (${String(error).slice(0, 200)}). Report the number of your PR.`
  }

  return null
}

// After a fix that answered review comments: reply in each inline thread
// and summarize the rest, as the agents' account.
async function answerFeedback(context: RunsContext, pr: RunPr, entry: RunEntry, headSha: string, addressed: Addressed[]): Promise<void> {
  const { manifest, github, say } = context
  const pending = entry.feedbackInFix ?? []

  if (pending.length === 0) {
    return
  }

  const actions = new Map(addressed.map((item) => [item.id, item.action]))
  const rest = []

  for (const item of pending) {
    const action = actions.get(item.id) ?? 'not reported by the implementer; please check'
    const text = `${action} (${headSha.slice(0, 7)})`

    if (item.commentId) {
      await github
        .replyAsAgents(manifest, entry.pr, item.commentId, text)
        .catch((error) => say(pr.id, 'reply-failed', { error: String(error).slice(0, 200) }))
    } else {
      rest.push(`- "${item.body.slice(0, 80)}": ${text}`)
    }
  }

  if (rest.length > 0) {
    await github
      .commentAsAgents(manifest, entry.pr, `Review comments addressed:\n\n${rest.join('\n')}`)
      .catch((error) => say(pr.id, 'reply-failed', { error: String(error).slice(0, 200) }))
  }

  const handled = pending.map((item) => ({
    id: item.id,
    body: item.body,
    action: actions.get(item.id) ?? null,
    sha: headSha,
    at: context.now(),
  }))

  entry.feedbackHandled = [...(entry.feedbackHandled ?? []), ...handled].slice(-50)
  entry.feedbackInFix = []
  say(pr.id, 'review-answered', { comments: pending.length })
}

function nextStep(context: RunsContext, pr: RunPr, entry: RunEntry): string {
  const channel = context.approvalChannel(entry.author)

  if (channel === 'github') {
    return 'review and approve it on GitHub'
  }

  if (channel === 'inbox') {
    return `check the card, then: rollout approve ${pr.id}`
  }

  if (context.manifest.policy.merge === 'manual') {
    return 'review it; the driver tells you when it is ready to merge'
  }

  return 'the driver merges it once the gate passes'
}

async function verified(context: RunsContext, pr: RunPr, entry: RunEntry, out: Verdict, sha: string, run: string): Promise<void> {
  const { manifest, say, now, worktree, records } = context
  const tree = await worktree.inspectWorktree(manifest, pr)
  const touched = !tree.clean || tree.head !== sha

  if (touched) {
    context.localConfigRemoved(pr, await worktree.resetWorktree(manifest, pr, sha))
  }

  const criteria = context.checks.criteriaOutcome(entry.verifyCriteria ?? [], out.criteria ?? [])
  // The candidates fixed at the launch of this verifier. A review of another head listed none in its prompt.
  const sent = entry.review?.sha === sha ? sentCandidates(entry.review) : []
  const external = context.checks.candidatesOutcome(sent, out.external ?? [])
  // The verifier's own findings come first, so they keep their numbers. Only the confirmed candidates carry a review key.
  const unkeyed = [...(out.blocking ?? []), ...criteria.findings]
  const judged = {
    ...out,
    verdict: criteria.failedRequired.length > 0 || external.confirmed.length > 0 ? 'FAIL' : out.verdict,
    blocking: [...unkeyed, ...external.findings.map((finding) => finding.text)],
    criteria: criteria.results,
    external: external.results,
  }

  const fromReview = [...unkeyed.map(() => null), ...external.findings.map((finding) => finding.key)]
  const sentKeys = sent.map((candidate) => candidate.key)
  // A verifier that changed the tree or read another SHA says nothing about the files at this head.
  const refuted = !touched && out.sha === sha ? await refutations(context, entry, external.results, out.recheck ?? [], { sha, run }) : []

  records.recordVerdict(entry, { ...judged, recheck: records.recheckedFindings(entry, out.recheck ?? []), at: now(), run })
  transitions.candidatesSent(entry, sentKeys)
  transitions.candidatesRefuted(entry, refuted)

  for (const record of criteria.results) {
    context.gateCheck(pr, entry, {
      stage: 'verify',
      level: record.level,
      item: record.id,
      result: record.result,
      evidence: record.evidence,
    })
  }

  // A FAIL is honoured even from a verifier that touched the tree: trusting
  // it cannot cause a merge. A PASS must come from an untouched tree.
  if (judged.verdict === 'FAIL') {
    rejected(context, pr, entry, judged, touched ? tree.status : '', fromReview)
    return
  }

  // The commands' pass still holds for this head, so the next verifier
  // starts once a slot is free.
  if (touched) {
    transitions.wake(entry, 'verify', now())
    say(
      pr.id,
      'verifier-touched-tree',
      { head: tree.head.slice(0, 7), status: tree.status.slice(0, 200) },
      'the verifier changed the worktree; PASS discarded, verifying again',
    )

    noteFirst(context, pr, entry)
    return
  }

  if (out.sha !== sha || sha !== entry.claimedSha) {
    transitions.verifyAgain(entry, now())
    say(pr.id, 'verify-stale', { verified: out.sha, claimed: entry.claimedSha })
    return
  }

  transitions.toVerified(entry, { sha, at: now() })

  say(pr.id, 'verified', { sha: sha.slice(0, 7) }, `verified PR #${entry.pr}: ${nextStep(context, pr, entry)}`)
  noteFirst(context, pr, entry)
}

type Refutation = ReviewMemory['refuted'][number]
type Refuted = Pick<Refutation, 'key' | 'evidence'> & { file: string }

function refutedCandidates(results: CandidateAnswer[]): Refuted[] {
  return results.filter((record) => record.result === 'refuted').map(({ key, file, evidence }) => ({ key, file, evidence }))
}

// The key holds the file in lower case, so the path in its real case comes from the review or an earlier answer.
function reviewFile(entry: RunEntry, key: string): string | null {
  const finding = entry.review?.findings.find((item) => matchKey(item) === key)

  if (finding) {
    return finding.file
  }

  const answer = (entry.verdicts ?? [])
    .toReversed()
    .flatMap((verdict) => verdict.external ?? [])
    .find((record) => record.key === key)

  return answer?.file ?? null
}

// The findings that came from a confirmed candidate and that a re-check calls wrong.
function wrongReviewFindings(entry: RunEntry, recheck: Recheck[]): Refuted[] {
  const items = entry.findings?.items ?? []

  return recheck.flatMap((item) => {
    const key = items.find((finding) => finding.id === item.id)?.fromReview

    if (item.status !== 'wrong' || key === undefined) {
      return []
    }

    const file = reviewFile(entry, key)

    return file === null ? [] : [{ key, file, evidence: item.evidence ?? '' }]
  })
}

// Each blob is read at the head the verifier was launched on. A read that fails leaves its record out, so the
// candidate goes to the next verifier again. It never throws: endJob would only log it, and the verdict would be lost.
async function refutations(
  context: RunsContext,
  entry: RunEntry,
  results: CandidateAnswer[],
  recheck: Recheck[],
  { sha, run }: { sha: string; run: string },
): Promise<Refutation[]> {
  const records: Refutation[] = []

  for (const { key, file, evidence } of [...refutedCandidates(results), ...wrongReviewFindings(entry, recheck)]) {
    const blob = await context.github.blobAt(context.manifest, sha, file).catch(() => undefined)

    if (blob !== undefined) {
      records.push({ key, blob, evidence: evidence.slice(0, REFUTATION_EVIDENCE_CHARS), run, at: context.now() })
    }
  }

  return records
}

// The upheld disputes are read before the FAIL's own findings replace them.
// They go to the maintainer, so no fix attempt is spent on them.
// `fromReview` lines up with `out.blocking`.
function rejected(
  context: RunsContext,
  pr: RunPr,
  entry: RunEntry,
  out: Verdict & { blocking: string[] },
  leftovers: string,
  fromReview: (string | null)[],
): void {
  const { say, now } = context
  const upheld = upheldDisputes(entry, out.recheck ?? [])

  context.records.recordFindings(entry, out.blocking, now(), fromReview)

  const note = context.prompts.findingsNote(entry.findings?.items ?? [], out.checklist, leftovers)

  if (upheld.length === 0) {
    context.toFix(pr, 'verifier findings', note)
    return
  }

  const ids = upheld.map((item) => item.id)

  transitions.escalateDispute(entry, {
    note,
    text: disputeText(context, upheld),
    at: now(),
    run: context.lastEndedRun(pr.id),
    findings: ids,
  })

  say(
    pr.id,
    'escalated',
    { reason: transitions.DISPUTE, findings: ids },
    `the verifier still finds ${ids.join(', ')} open, which the implementer disputed. It needs your decision (rollout card ${pr.id}, then rollout note ${pr.id} "...")`,
  )
}

// The commands in the order they run, the ready ones first, captured at the
// start, so a manifest reload never changes a running job. A pass holds for
// the head and the lists of its key.
export function preVerifyJob(context: RunsContext, entry: RunEntry): CommandsJob {
  const { ready, preVerify } = context.manifest.gates
  const lists: [CommandStep['stage'], CommandStep['level'], string[]][] = [
    ['ready', 'required', ready.required],
    ['ready', 'recommended', ready.recommended],
    ['preVerify', 'required', preVerify.required],
    ['preVerify', 'recommended', preVerify.recommended],
  ]

  const steps = lists.flatMap(([stage, level, commands]) => commands.map((command) => ({ command, stage, level })))
  const key = JSON.stringify({ ready: [ready.required, ready.recommended], preVerify: [preVerify.required, preVerify.recommended] })

  return { sha: entry.claimedSha ?? '', steps, key }
}

// Whether the commands passed for the claimed head with these lists, by this driver or an earlier one.
export function passHolds(entry: RunEntry, job: CommandsJob): boolean {
  return entry.commands?.sha === entry.claimedSha && entry.commands?.key === job.key
}

// The driver runs the commands itself, so a PR never changes the checks it
// is judged by. Its `gate` entry in running takes a slot, keeps advance and
// retry away and queues notes.
export function launchPreVerify(context: RunsContext, pr: RunPr, job: CommandsJob): void {
  const { ledger, say } = context

  // Saved before any command runs: if the job is cut short, the ledger alone
  // tells the next advance, also after a restart, that what the commands
  // left is the driver's own and not the implementer's.
  ledger.prs[pr.id].preVerifyCleanup = job.sha
  transitions.setStatus(ledger.prs[pr.id], 'pre-verify', { kind: 'running', code: 'commands', sha: job.sha }, context.now())
  ledger.save()
  context.running.set(pr.id, 'gate')

  endJob(
    context,
    pr,
    runPreVerify(context, pr, job).then((outcome) => onPreVerifyDone(context, pr, job, outcome)),
    (error) => {
      const entry = ledger.prs[pr.id]

      say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) })
      entry.lastError = String(errorMessage(error)).slice(0, 1000)
      backOff(context, entry, {})
      transitions.commandsEnded(entry, context.now())
    },
  )
}

// Every command runs at the claimed head: one that leaves tracked changes
// fails, and the worktree goes back to the head before the next one.
async function runPreVerify(context: RunsContext, pr: RunPr, { sha, steps }: CommandsJob): Promise<CommandsOutcome> {
  const { manifest, worktree } = context
  const cwd = worktree.worktreePath(manifest, pr)
  const results = []

  for (const step of steps) {
    // A stopped job leaves its cleanup to the next run: the driver exits
    // as soon as its children end.
    if (context.isStopping()) {
      return { stopped: true, results }
    }

    const run = await context.runCommand(manifest, pr, { command: step.command, cwd })

    if (run.stopped) {
      return { stopped: true, results }
    }

    const record = context.checks.commandResult(step, run, await worktree.inspectWorktree(manifest, pr), sha)

    if (record.changes.length > 0) {
      context.localConfigRemoved(pr, await worktree.resetWorktree(manifest, pr, sha))
    }

    results.push(record)

    if (record.result === 'fail' && record.level === 'required') {
      break
    }
  }

  await cleanUpCommands(context, pr, sha)

  return { stopped: false, results }
}

// What the commands left is the driver's own, so it goes. Untracked files
// would fail the next alignWorktree. Ignored output stays.
async function cleanUpCommands(context: RunsContext, pr: RunPr, sha: string): Promise<void> {
  const { manifest, worktree } = context
  const tree = await worktree.inspectWorktree(manifest, pr)

  if (!tree.clean || tree.head !== sha) {
    context.localConfigRemoved(pr, await worktree.resetWorktree(manifest, pr, sha))
  }

  context.ledger.prs[pr.id].preVerifyCleanup = null
}

// A job that a stop, a crash or an error cut short left its cleanup to the
// next advance, which does it before an agent or a command uses the
// worktree. A worktree that is gone, as after a merge, needs none.
export async function owedCleanup(context: RunsContext, pr: RunPr, entry: RunEntry): Promise<void> {
  if (!context.files.existsSync(context.worktree.worktreePath(context.manifest, pr))) {
    entry.preVerifyCleanup = null
    return
  }

  await cleanUpCommands(context, pr, entry.preVerifyCleanup ?? '')
}

// A stop, another stage or a new head while the commands ran drops their
// results. A pass is written to the entry, so a restart keeps it.
async function onPreVerifyDone(context: RunsContext, pr: RunPr, { sha, key }: CommandsJob, outcome: CommandsOutcome): Promise<void> {
  const { now } = context
  const entry = context.ledger.prs[pr.id]

  if (entry.stage === 'merged') {
    await context.cleanup(pr)
    return
  }

  if (outcome.stopped || context.isStopping() || !transitions.claimWaits(entry) || entry.claimedSha !== sha) {
    transitions.commandsEnded(entry, now())
    return
  }

  entry.preVerify = { sha, at: now(), results: outcome.results }

  for (const record of outcome.results) {
    context.gateCheck(pr, entry, {
      stage: record.stage,
      level: record.level,
      item: record.command,
      result: record.result,
      evidence: commandEvidence(record),
    })
  }

  const { failedRequired, reason } = context.checks.preVerifyOutcome(outcome.results)

  if (failedRequired.length > 0) {
    context.toFix(pr, reason ?? '', context.prompts.preVerifyNote(sha, failedRequired, entry.ready))
    return
  }

  transitions.commandsPassed(entry, { sha, key, at: now() })
  noteFirst(context, pr, entry)
}
