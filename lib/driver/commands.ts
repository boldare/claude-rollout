import { timeText } from '../sentences.ts'
import { COMMANDS } from '../state.ts'
import type {
  Actor,
  BudgetRole,
  Channel,
  CommandEffect,
  CommandName,
  CommitStamp,
  Drop,
  Fix,
  Hold,
  IsoTime,
  NeedsYouCode,
  NoteRecord,
  OpenStage,
  Role,
  Status,
  Subset,
} from '../state.ts'
import * as transitions from '../transitions.ts'
import type { PrEntry, StoredNote } from '../transitions.ts'

// The maintainer's commands from the inbox: approve, note, retry, hold and
// release. retry, note and approve each follow one table keyed by the PR's
// stage and status. commandEffect reads the same rows the driver applies, so
// the CLI and the UI print what a command does before it is sent. Nothing
// here reads the clock, the disk or the environment: the context brings it.

// These take PR ids or all, the whole rollout.
const SCOPED_COMMANDS = ['hold', 'release'] as const satisfies readonly CommandName[]
const AT_WORK = 'an agent is working on this PR'
const STALE_APPROVAL = 'it names a different head than the one verified now; look at the card again'
// What only the maintainer's words answer, which retry cannot give.
const WAITS_FOR_WORDS = ['brief-questions', 'decision', 'dispute'] as const satisfies readonly NeedsYouCode[]
const NOTES_KEPT = 20

type ScopedCommand = (typeof SCOPED_COMMANDS)[number]
type Author = NoteRecord['by']
type Answered = Pick<StoredNote, 'kind' | 'question'>
type Refusal = Extract<CommandEffect, { applies: false }>
// The PR's stage and status when the event is written.
type StatusDetail = ReturnType<typeof transitions.statusDetail>
// What holds a PR's place in the driver's `running`: the role of its run, or
// gate while the pre-verify commands run.
type Job = Role | 'gate'

// The commands that follow a table of rows.
export type TableCommand = Exclude<CommandName, ScopedCommand>

// The pre-verify commands count as an agent: they hold the PR as its runs do.
export type AtWork = Subset<Actor, 'agent' | 'delegate'> | null

// A rejected command can be anything the inbox held, so its name stays unknown.
interface Rejection {
  command: unknown
  reason: string
  file?: string
}

// The events this module writes, by kind, with their detail. lib/kinds.mjs
// lists every kind, but tsc reads no .mjs file, so test/kinds.test.mjs holds
// these kinds to that list instead.
interface CommandEvents {
  'approval-rejected': { reason: string }
  approved: { sha: string; channel: Channel }
  'brief-answered': Record<string, never>
  'command-rejected': Rejection
  held: (StatusDetail & { running: Job | null }) | ({ scope: 'rollout' } & Pick<Hold, 'by' | 'reason'>)
  'needs-fix': { reason: string }
  'note-queued': StatusDetail
  released: StatusDetail | { scope: 'rollout'; stillHeld: string[] }
  retry: StatusDetail
}

type Say = <Kind extends keyof CommandEvents>(id: string, kind: Kind, detail: CommandEvents[Kind], message?: string | null) => void

// The context lib/driver.mjs builds once. Its manifest and ledger are the driver's own objects.
export interface CommandsContext {
  manifest: { all: { id: string }[]; policy: { attempts: Record<BudgetRole, number>; mergeDelaySeconds: number } }
  ledger: { data: { hold: Hold | null }; prs: Record<string, PrEntry> }
  running: Map<string, Job>
  say: Say
  now: () => IsoTime
  inbox: () => unknown[]
  briefWritten: (id: string) => boolean
  approveRefusal: (entry: PrEntry) => string | null
}

// What commandEffect cannot read itself.
export interface EffectFacts {
  at: IsoTime
  atWork: AtWork
  briefWritten: boolean
  limits: Record<BudgetRole, number>
  mergeDelaySeconds: number
  approveRefusal: (entry: PrEntry) => string | null
}

// An approve names the verified head and patch, and the time it was posted. A note brings its text.
export interface EffectCommand extends Partial<CommitStamp> {
  cmd: TableCommand
  id: string
  text?: string
  patchId?: string | null
}

// With the fix after the row: a waiting status carries no fix reason, and the preview prints it.
export type Effect = Refusal | (Extract<CommandEffect, { applies: true }> & { fix: Fix | null })

// An inbox command once its shape is checked. hold and release name a PR, or all of them.
type InboxCommand = { cmd: ScopedCommand; all: true } | { cmd: ScopedCommand; id: string } | EffectCommand

// How a note came in. A review comment on GitHub has the github channel, and
// the comments it carries are kept in feedbackInFix, not in noteHistory.
export interface NoteOptions {
  channel?: Channel
  record?: boolean
}

interface RowInput extends EffectFacts {
  id: string
  by: Author
  // The rollout's hold.
  hold: Hold | null
  say: Say
  channel: Channel
  record: boolean
}

interface Table {
  refusal: (entry: PrEntry, input: RowInput, command: EffectCommand) => Refusal | null
  apply: (entry: PrEntry, input: RowInput, command: EffectCommand) => void
  refused: (input: RowInput, refusal: Refusal, command: EffectCommand) => void
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function listed(list: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && list.includes(value)
}

function isCommand(value: unknown): value is CommandName {
  return listed(COMMANDS, value)
}

function isScoped(value: unknown): value is ScopedCommand {
  return listed(SCOPED_COMMANDS, value)
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function refusal(reason: string, instead: string | null = null): Refusal {
  return { applies: false, reason, instead }
}

// A preview logs nothing.
function quiet(): void {}

// A hold or release for PRs becomes one command per id, in order and
// without repeats. Older CLIs and pages send a lone id. One with no id
// becomes a bare command, which checkCommand rejects.
function perId(command: unknown): unknown[] {
  if (!plainObject(command) || !isScoped(command.cmd) || command.all === true) {
    return [command]
  }

  let ids: unknown[] = []

  if (Array.isArray(command.ids)) {
    ids = command.ids
  } else if (Object.hasOwn(command, 'id')) {
    ids = [command.id]
  }

  if (ids.length === 0) {
    return [{ cmd: command.cmd }]
  }

  return [...new Set(ids)].map((id) => ({ cmd: command.cmd, id }))
}

// Only the fields each command reads, with their types. A field of another type reads as missing.
function inboxCommand(cmd: CommandName, id: string, raw: Record<string, unknown>): InboxCommand {
  if (cmd === 'approve') {
    return { cmd, id, sha: textOf(raw.sha), patchId: raw.patchId === null ? null : textOf(raw.patchId), at: textOf(raw.at) }
  }

  if (cmd === 'note') {
    return { cmd, id, text: textOf(raw.text) ?? '' }
  }

  if (cmd === 'retry') {
    return { cmd, id }
  }

  // A hold or a release of one PR.
  return { cmd, id }
}

// The command with its shape checked, or the detail of its command-rejected event.
function checkCommand(context: CommandsContext, raw: unknown): { command: InboxCommand } | { rejection: Rejection } {
  if (!plainObject(raw)) {
    return { rejection: { command: null, reason: 'not a JSON object' } }
  }

  const { cmd, id } = raw

  if (cmd === 'invalid') {
    return { rejection: { command: cmd, file: textOf(raw.file), reason: textOf(raw.error) ?? '' } }
  }

  // A hold of the whole rollout ignores any id, because a lost hold is worse than a stray id.
  if (isScoped(cmd) && raw.all === true) {
    return { command: { cmd, all: true } }
  }

  if (!isCommand(cmd)) {
    return { rejection: { command: cmd, reason: 'unknown command' } }
  }

  if (isScoped(cmd) && !Object.hasOwn(raw, 'id')) {
    return { rejection: { command: cmd, reason: 'needs PR ids or all' } }
  }

  if (typeof id !== 'string' || id === '') {
    return { rejection: { command: cmd, reason: 'needs a PR id' } }
  }

  // Own keys only: ledger.prs.__proto__ is Object.prototype.
  if (!context.manifest.all.some((pr) => pr.id === id) || !Object.hasOwn(context.ledger.prs, id)) {
    return { rejection: { command: cmd, reason: `unknown PR ${id}` } }
  }

  if (cmd === 'approve' && !(typeof raw.at === 'string' && Number.isFinite(Date.parse(raw.at)))) {
    return { rejection: { command: cmd, reason: 'needs a valid at' } }
  }

  return { command: inboxCommand(cmd, id, raw) }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Commands from /rollout: approve, note, retry, hold, release. Each applies
// on its own, and so does each id of a hold or release, so a bad one never
// drops the rest of the batch.
export function applyCommands(context: CommandsContext): void {
  for (const command of context.inbox()) {
    for (const single of perId(command)) {
      applyCommand(context, single)
    }
  }
}

function applyCommand(context: CommandsContext, raw: unknown): void {
  const { say } = context
  const checked = checkCommand(context, raw)

  if ('rejection' in checked) {
    say('-', 'command-rejected', checked.rejection)
    return
  }

  const { command } = checked
  const where = 'id' in command ? command.id : '-'

  try {
    execute(context, command)
  } catch (error) {
    say(where, 'command-rejected', { command: command.cmd, reason: errorText(error).slice(0, 200) })
  }
}

function execute(context: CommandsContext, command: InboxCommand): void {
  switch (command.cmd) {
    case 'approve':
    case 'retry':
      applyTable(context, TABLES[command.cmd], command, 'maintainer')
      break

    case 'note':
      applyNote(context, command.id, command.text ?? '', 'maintainer')
      break

    case 'hold':
      if ('all' in command) {
        holdRollout(context)
      } else {
        holdPr(context, command.id)
      }

      break

    case 'release':
      if ('all' in command) {
        releaseRollout(context)
      } else {
        releasePr(context, command.id)
      }

      break
  }
}

function holdPr({ ledger, running, say, now }: CommandsContext, id: string): void {
  const entry = ledger.prs[id]

  if (entry.stage === 'merged') {
    say(id, 'command-rejected', { command: 'hold', reason: 'already merged' })
  } else if (entry.hold) {
    say(id, 'command-rejected', { command: 'hold', reason: 'already held' })
  } else {
    transitions.holdPr(entry, { at: now(), by: 'maintainer', reason: null })
    say(id, 'held', { ...transitions.statusDetail(entry), running: running.get(id) ?? null })
  }
}

// The two holds stay apart: releasing a PR never lifts the rollout's hold.
function releasePr({ ledger, say }: CommandsContext, id: string): void {
  const entry = ledger.prs[id]

  if (entry.hold) {
    transitions.releasePr(entry)
    say(id, 'released', transitions.statusDetail(entry))
    return
  }

  const reason = ledger.data.hold ? 'not held. The rollout is held: rollout release --all' : 'not held'
  say(id, 'command-rejected', { command: 'release', reason })
}

function holdRollout({ ledger, say, now }: CommandsContext): void {
  const { hold } = ledger.data

  if (hold) {
    const why = hold.reason ? `: ${hold.reason}` : ''
    say('-', 'command-rejected', { command: 'hold', reason: `already held since ${hold.at} by ${hold.by}${why}` })
    return
  }

  ledger.data.hold = { at: now(), by: 'maintainer', reason: null }
  say('-', 'held', { scope: 'rollout', by: 'maintainer', reason: null })
}

// The PRs held on their own stay held, and the event names them.
function releaseRollout({ manifest, ledger, say }: CommandsContext): void {
  if (!ledger.data.hold) {
    say('-', 'command-rejected', { command: 'release', reason: 'not held' })
    return
  }

  ledger.data.hold = null

  const stillHeld = manifest.all.filter((pr) => ledger.prs[pr.id].hold && ledger.prs[pr.id].stage !== 'merged').map((pr) => pr.id)
  say('-', 'released', { scope: 'rollout', stillHeld })
}

// A maintainer's note, a review comment and a delegate's answer reach the
// agent the same way. A delegate run is no agent at work for a note: when its
// answer applies, `running` still holds it.
export function applyNote(context: CommandsContext, id: string, text: string, by: Author, options: NoteOptions = {}): void {
  applyTable(context, TABLES.note, { cmd: 'note', id, text }, by, options)
}

function atWorkOf(job: Job | undefined): AtWork {
  if (job === undefined) {
    return null
  }

  return job === 'delegate' ? 'delegate' : 'agent'
}

function rowInput(context: CommandsContext, id: string, by: Author, { channel = 'inbox', record = true }: NoteOptions): RowInput {
  const { manifest, ledger, running, say } = context

  return {
    id,
    by,
    say,
    channel,
    record,
    at: context.now(),
    atWork: atWorkOf(running.get(id)),
    briefWritten: context.briefWritten(id),
    limits: manifest.policy.attempts,
    mergeDelaySeconds: manifest.policy.mergeDelaySeconds,
    approveRefusal: context.approveRefusal,
    hold: ledger.data.hold ?? null,
  }
}

// A running status whose run is gone resumes first, as advance would in the same tick.
function applyTable(context: CommandsContext, table: Table, command: EffectCommand, by: Author, options: NoteOptions = {}): void {
  const entry = context.ledger.prs[command.id]

  if (!context.running.has(command.id)) {
    transitions.recoverRun(entry, { refund: false, at: context.now() })
  }

  const input = rowInput(context, command.id, by, options)
  const refused = table.refusal(entry, input, command)

  if (refused) {
    table.refused(input, refused, command)
    return
  }

  table.apply(entry, input, command)
  holdShows(entry, input)
}

// A waiting PR under a hold shows held, the rollout's scope over its own, as the tick writes it.
function holdShows(entry: PrEntry, { hold, at }: RowInput): void {
  if (hold) {
    transitions.heldStatus(entry, 'rollout', at)
  } else if (entry.hold) {
    transitions.heldStatus(entry, 'pr', at)
  }
}

// What the command would do to the PR, from a copy of its entry. The driver
// applies the same rows to the live entry.
export function commandEffect(
  ledger: { prs: Record<string, PrEntry>; hold?: Hold | null },
  command: EffectCommand,
  facts: EffectFacts,
): Effect {
  const entry = structuredClone(ledger.prs[command.id])
  const input: RowInput = {
    ...facts,
    id: command.id,
    by: 'maintainer',
    hold: ledger.hold ?? null,
    say: quiet,
    channel: 'inbox',
    record: true,
  }

  const table = TABLES[command.cmd]
  const refused = table.refusal(entry, input, command)

  if (refused) {
    return refused
  }

  const before = { verified: entry.verified, approved: entry.approved, pendingNote: entry.pendingNote }

  table.apply(entry, input, command)
  holdShows(entry, input)

  const drops: Drop[] = []

  if (before.verified && !entry.verified) {
    drops.push('verification')
  }

  if (before.approved && !entry.approved) {
    drops.push('approval')
  }

  return {
    applies: true,
    stage: entry.stage,
    status: entry.status,
    drops,
    queued: entry.pendingNote !== before.pendingNote,
    fix: entry.fix,
  }
}

// A brief written by hand moves a PR on: its rows are implement's. Questions
// to the brief writer stay on brief.
function rowStage(entry: PrEntry, input: RowInput): OpenStage {
  const stage = entry.stage === 'merged' ? 'merge' : entry.stage

  if (stage === 'brief' && input.briefWritten && entry.status?.code !== 'brief-questions') {
    return 'implement'
  }

  return stage
}

function rejected({ id, say }: RowInput, { reason, instead }: Refusal, command: EffectCommand): void {
  say(id, 'command-rejected', { command: command.cmd, reason: instead ? `${reason}: ${instead}` : reason })
}

function retryRefusal(entry: PrEntry, input: RowInput): Refusal | null {
  const status = entry.status

  if (entry.stage === 'merged' || !status) {
    return refusal('already merged')
  }

  if (status.kind === 'running' || input.atWork) {
    return refusal(AT_WORK)
  }

  if (listed(WAITS_FOR_WORDS, status.code)) {
    return refusal('this PR waits for your answer', `rollout note ${input.id} "..."`)
  }

  return null
}

function retry(entry: PrEntry, input: RowInput): void {
  const { id, say, at } = input
  const status = entry.status as Status
  const stage = rowStage(entry, input)

  transitions.resetBudgets(entry)

  if (status.code === 'obstacle') {
    transitions.retryFix(entry, at)
  } else if ((status.code === 'attempts-exhausted' || status.code === 'backoff') && transitions.restsOn(stage)) {
    transitions.wake(entry, stage, at)
  } else if (status.code === 'errors') {
    transitions.waitOnStage(entry, stage, at)
  } else if (status.code === 'merge-refused') {
    transitions.retryMerge(entry, at)
  }

  say(id, 'retry', transitions.statusDetail(entry))
}

function noteRefusal(entry: PrEntry): Refusal | null {
  return entry.stage === 'merged' || !entry.status ? refusal('already merged') : null
}

const NOTHING_ASKED: Answered = { kind: null, question: null }

// A note on a closed PR answers the status the close replaced, which the reopen brings back.
function answeredWhenClosed(kept: Status | null | undefined): Answered {
  if (kept?.kind !== 'needs-you') {
    return NOTHING_ASKED
  }

  if (kept.code === 'decision' || kept.code === 'obstacle') {
    return { kind: kept.question.kind, question: kept.question.text }
  }

  return kept.code === 'dispute' ? { kind: transitions.DISPUTE, question: kept.text } : NOTHING_ASKED
}

// A block names what it asks by its question, or by the gate's reasons, or
// by what a block for code scanning asks.
function answeredBlock(entry: PrEntry): Answered {
  const status = entry.status
  const question = transitions.statusQuestion(status)

  if (question) {
    return { kind: question.kind, question: question.text }
  }

  if (status?.kind === 'needs-you' && status.code === 'gate-blocked') {
    return { kind: 'gate', question: status.reasons.join('; ') }
  }

  if (status?.kind === 'needs-you' && status.code === 'code-scanning-alerts') {
    return { kind: 'code-scanning', question: transitions.codeScanningQuestion(entry.pr) }
  }

  return NOTHING_ASKED
}

// What the note answers, for the prompts that list it. Finding ids change
// on every FAIL, so a dispute is named by the escalation's text.
function answered(entry: PrEntry): Answered {
  if (entry.status?.code === 'closed') {
    return answeredWhenClosed(entry.closedFrom)
  }

  if (transitions.waitsOnBlock(entry)) {
    return answeredBlock(entry)
  }

  if (transitions.escalatedOverDispute(entry)) {
    return { kind: transitions.DISPUTE, question: entry.lastError }
  }

  return NOTHING_ASKED
}

function queueNote(entry: PrEntry, text: string): void {
  entry.pendingNote = [entry.pendingNote, text].filter(Boolean).join('\n\n')
}

function queued(entry: PrEntry, { id, say }: RowInput, text: string): void {
  queueNote(entry, text)
  say(id, 'note-queued', transitions.statusDetail(entry))
}

function answerBrief(entry: PrEntry, { id, say, at }: RowInput, question: string | null, text: string): void {
  transitions.answerBrief(entry, question, text, at)
  say(id, 'brief-answered', {})
}

// A note on a verified PR, or on a claim waiting for its check, asks for a
// change. On any other PR it answers.
function asksForChange(entry: PrEntry): boolean {
  return transitions.verifiedOnMerge(entry) || transitions.claimWaits(entry)
}

// Its prose names who asked, so events keep their words.
function noteReason({ by, channel }: RowInput, request: boolean): string {
  if (channel === 'github') {
    return 'maintainer review'
  }

  return request ? `request from the ${by}` : `answer from the ${by}`
}

// A fix the note asks for.
function noteFix(entry: PrEntry, input: RowInput, request: boolean, text: string): void {
  const { id, say, at, limits } = input
  const reason = noteReason(input, request)

  transitions.freshAttempt(entry, 'fix', limits.fix)
  transitions.dropVerification(entry)
  transitions.toFix(entry, reason, text, { code: transitions.fixReasonCode(reason), at })
  say(id, 'needs-fix', { reason })
}

// The verifier's findings go to a fix run, and the note rules on the dispute.
function ruling(entry: PrEntry, input: RowInput, text: string): void {
  const { id, say, at, limits } = input

  transitions.freshAttempt(entry, 'fix', limits.fix)
  transitions.dropVerification(entry)
  transitions.toFix(entry, 'verifier findings', entry.fixNote ?? '', { code: 'verifier-findings', at })
  say(id, 'needs-fix', { reason: 'verifier findings' })
  queued(entry, input, text)
}

function noteOnBrief(entry: PrEntry, input: RowInput, status: Status, text: string): void {
  if (status.kind === 'needs-you') {
    answerBrief(entry, input, null, text)
  } else {
    queued(entry, input, text)
  }
}

// A note joins a fix the PR owes, which keeps its reason.
function noteOnImplement(entry: PrEntry, input: RowInput, status: Status, { request, text }: { request: boolean; text: string }): void {
  const { limits, at } = input

  if (status.kind === 'waiting') {
    if (entry.fix) {
      transitions.freshAttempt(entry, 'fix', limits.fix)
    }

    queued(entry, input, text)
  } else if (status.code === 'decision' || status.code === 'obstacle') {
    noteFix(entry, input, request, text)
  } else if (status.code === 'attempts-exhausted' || status.code === 'errors') {
    if (status.code === 'attempts-exhausted') {
      transitions.freshAttempt(entry, status.role, limits[status.role])
    }

    if (entry.fix) {
      transitions.freshAttempt(entry, 'fix', limits.fix)
      transitions.wake(entry, 'implement', at)
      queued(entry, input, text)
    } else {
      noteFix(entry, input, request, text)
    }
  } else {
    queued(entry, input, text)
  }
}

// A note answers the question a delegate works on, as the delegate's own answer does.
function note(entry: PrEntry, input: RowInput, command: EffectCommand): void {
  if (entry.status?.kind === 'running' && entry.status.code === 'delegate') {
    transitions.delegateReturned(entry, { outcome: null, reason: '', at: input.at })
  }

  const status = entry.status as Status
  const text = command.text ?? ''
  const request = asksForChange(entry)

  if (input.record) {
    const record = { at: input.at, by: input.by, ...answered(entry), text, run: null }

    entry.noteHistory = [...(entry.noteHistory ?? []), record].slice(-NOTES_KEPT)
  }

  if (status.code === 'brief-questions') {
    answerBrief(entry, input, status.question.text, text)
    return
  }

  if (status.code === 'closed' || input.atWork === 'agent') {
    queued(entry, input, text)
    return
  }

  const stage = rowStage(entry, input)

  if (stage === 'brief') {
    noteOnBrief(entry, input, status, text)
  } else if (stage === 'implement') {
    noteOnImplement(entry, input, status, { request, text })
  } else if (status.code === 'dispute') {
    ruling(entry, input, text)
  } else {
    if (status.code === 'attempts-exhausted') {
      transitions.freshAttempt(entry, status.role, input.limits[status.role])
    }

    noteFix(entry, input, request, text)
  }
}

function placeOf(entry: PrEntry): string {
  const status = entry.status

  if (entry.stage === 'merged' || !status) {
    return 'merged'
  }

  return `${entry.stage} · ${status.kind}: ${status.code}`
}

function approvable(entry: PrEntry): boolean {
  const status = entry.status

  return entry.stage === 'merge' && (status?.kind === 'waiting' || (status?.kind === 'needs-you' && status.code === 'approve'))
}

// An approval names the exact verified head and patch the maintainer saw on
// the card, and must be posted after that verification finished.
function approvalRefusal(entry: PrEntry, input: RowInput, command: EffectCommand): Refusal | null {
  const policy = input.approveRefusal(entry)
  const { verified, approved } = entry

  if (policy) {
    return refusal(policy)
  }

  if (!verified || !approvable(entry)) {
    return refusal(`nothing to approve: ${input.id} is ${placeOf(entry)}`)
  }

  if (input.atWork) {
    return refusal(AT_WORK)
  }

  if (command.patchId !== verified.patchId || command.sha !== verified.sha) {
    return refusal(STALE_APPROVAL)
  }

  if (Date.parse(command.at ?? '') < Date.parse(verified.at)) {
    return refusal('it was posted before the verification finished')
  }

  if (approved && approved.patchId === verified.patchId && approved.channel !== 'github') {
    return refusal(`already approved at ${timeText(approved.at)}. The merge delay counts from then`)
  }

  return null
}

function approvalRejected({ id, say }: RowInput, { reason }: Refusal): void {
  say(id, 'approval-rejected', { reason }, `approval rejected: ${reason}`)
}

function approve(entry: PrEntry, input: RowInput): void {
  const { id, say, at, mergeDelaySeconds } = input
  const { sha, patchId } = entry.verified as NonNullable<PrEntry['verified']>
  const until = new Date(Date.parse(at) + mergeDelaySeconds * 1000).toISOString()

  transitions.approveInbox(entry, { patchId, sha, at, channel: 'inbox' }, { until, at })
  say(
    id,
    'approved',
    { sha: sha.slice(0, 7), channel: 'inbox' },
    `approved PR #${entry.pr}; merging in ${mergeDelaySeconds}s unless you hold it (rollout hold ${id})`,
  )
}

const TABLES: Record<TableCommand, Table> = {
  retry: { refusal: retryRefusal, apply: retry, refused: rejected },
  note: { refusal: noteRefusal, apply: note, refused: rejected },
  approve: { refusal: approvalRefusal, apply: approve, refused: approvalRejected },
}
