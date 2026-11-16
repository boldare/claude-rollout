import { timeText } from '../sentences.ts'
import { COMMANDS } from '../state.ts'
import type { BudgetRole, CommandEffect, Fix, Hold, IsoTime, NoteRecord, OpenStage, Status } from '../state.ts'
import * as transitions from '../transitions.ts'
import type { PrEntry, StoredNote } from '../transitions.ts'

// The maintainer's commands from the inbox: approve, note, retry, hold and
// release. retry, note and approve each follow one table keyed by the PR's
// stage and status. commandEffect reads the same rows the driver applies, so
// the CLI and the UI print what a command does before it is sent. Nothing
// here reads the clock, the disk or the environment: the context brings it.

const PR_COMMANDS: readonly string[] = COMMANDS
// These take PR ids or all, the whole rollout.
const SCOPED_COMMANDS = ['hold', 'release']
const AT_WORK = 'an agent is working on this PR'
const STALE_APPROVAL = 'it names a different head than the one verified now; look at the card again'
// What only the maintainer's words answer, which retry cannot give.
const WAITS_FOR_WORDS = ['brief-questions', 'decision', 'dispute']
// The driver reads these blocks again only after a retry, until it reads them every tick.
const RELEASED_BY_RETRY = ['closed', 'gate-blocked', 'code-scanning-alerts']
// A note on these asks for a change, on any other it answers.
const REQUEST_STATES = ['verified', 'ready_claimed']
const NOTES_KEPT = 20

type Say = (id: string, kind: string, detail?: Record<string, unknown>, message?: string | null) => void
type Author = NoteRecord['by']
type Drop = 'verification' | 'approval'
type Refusal = Extract<CommandEffect, { applies: false }>

// An agent run or the pre-verify commands, a delegate run, or nothing.
export type AtWork = 'agent' | 'delegate' | null

// The context lib/driver.mjs builds once. Its manifest and ledger are the driver's own objects.
export interface CommandsContext {
  manifest: { all: { id: string }[]; policy: { attempts: Record<BudgetRole, number>; mergeDelaySeconds: number } }
  ledger: { data: { hold: Hold | null }; prs: Record<string, PrEntry> }
  running: Map<string, string>
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

export interface EffectCommand {
  cmd: 'retry' | 'note' | 'approve'
  id: string
  text?: string
  sha?: string
  patchId?: string | null
  at?: IsoTime
}

// With the fix after the row: a waiting status carries no fix reason, and the preview prints it.
export type Effect = Refusal | (Extract<CommandEffect, { applies: true }> & { fix: Fix | null })

interface InboxCommand {
  cmd: string
  id?: string
  all?: boolean
  [field: string]: unknown
}

interface RowInput extends EffectFacts {
  id: string
  by: Author
  // The rollout's hold.
  hold: Hold | null
  say: Say
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

function refusal(reason: string, instead: string | null = null): Refusal {
  return { applies: false, reason, instead }
}

// A preview logs nothing.
function quiet(): void {}

// A hold or release for PRs becomes one command per id, in order and
// without repeats. Older CLIs and pages send a lone id. One with no id
// becomes a bare command, which commandRefusal rejects.
function perId(command: unknown): unknown[] {
  if (!plainObject(command) || !listed(SCOPED_COMMANDS, command.cmd) || command.all === true) {
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

function forRollout(command: Record<string, unknown>): boolean {
  return listed(SCOPED_COMMANDS, command.cmd) && command.all === true
}

// The detail of the command-rejected event, or null for a command that may apply.
function commandRefusal(context: CommandsContext, command: unknown): Record<string, unknown> | null {
  if (!plainObject(command)) {
    return { command: null, reason: 'not a JSON object' }
  }

  const { cmd, id } = command

  if (cmd === 'invalid') {
    return { command: cmd, file: command.file, reason: command.error }
  }

  // A hold of the whole rollout ignores any id, because a lost hold is worse than a stray id.
  if (forRollout(command)) {
    return null
  }

  if (!listed(PR_COMMANDS, cmd)) {
    return { command: cmd, reason: 'unknown command' }
  }

  if (listed(SCOPED_COMMANDS, cmd) && !Object.hasOwn(command, 'id')) {
    return { command: cmd, reason: 'needs PR ids or all' }
  }

  if (typeof id !== 'string' || id === '') {
    return { command: cmd, reason: 'needs a PR id' }
  }

  // Own keys only: ledger.prs.__proto__ is Object.prototype.
  if (!context.manifest.all.some((pr) => pr.id === id) || !Object.hasOwn(context.ledger.prs, id)) {
    return { command: cmd, reason: `unknown PR ${id}` }
  }

  if (cmd === 'approve' && !(typeof command.at === 'string' && Number.isFinite(Date.parse(command.at)))) {
    return { command: cmd, reason: 'needs a valid at' }
  }

  return null
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

function applyCommand(context: CommandsContext, command: unknown): void {
  const { say } = context
  const rejection = commandRefusal(context, command)

  if (rejection) {
    say('-', 'command-rejected', rejection)
    return
  }

  const checked = command as InboxCommand
  const where = forRollout(checked) ? '-' : String(checked.id)

  try {
    execute(context, checked)
  } catch (error) {
    say(where, 'command-rejected', { command: checked.cmd, reason: errorText(error).slice(0, 200) })
  }
}

function execute(context: CommandsContext, command: InboxCommand): void {
  const id = String(command.id)

  switch (command.cmd) {
    case 'approve':
      applyTable(context, TABLES.approve, { ...command, cmd: 'approve', id } as EffectCommand, 'maintainer')
      break

    case 'note':
      applyNote(context, id, typeof command.text === 'string' ? command.text : '', 'maintainer')
      break

    case 'retry':
      applyTable(context, TABLES.retry, { cmd: 'retry', id }, 'maintainer')
      break

    case 'hold':
      if (forRollout(command)) {
        holdRollout(context)
      } else {
        holdPr(context, id)
      }

      break

    case 'release':
      if (forRollout(command)) {
        releaseRollout(context)
      } else {
        releasePr(context, id)
      }

      break
  }
}

function holdPr({ ledger, running, say, now }: CommandsContext, id: string): void {
  const entry = ledger.prs[id]

  if (entry.state === 'merged') {
    say(id, 'command-rejected', { command: 'hold', reason: 'already merged' })
  } else if (entry.held) {
    say(id, 'command-rejected', { command: 'hold', reason: 'already held' })
  } else {
    transitions.holdPr(entry, { at: now(), by: 'maintainer', reason: null })
    say(id, 'held', { state: entry.state, running: running.get(id) ?? null })
  }
}

// The two holds stay apart: releasing a PR never lifts the rollout's hold.
function releasePr({ ledger, say }: CommandsContext, id: string): void {
  const entry = ledger.prs[id]

  if (entry.held) {
    transitions.releasePr(entry)
    say(id, 'released', { state: entry.state })
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

  const stillHeld = manifest.all.filter((pr) => ledger.prs[pr.id].held && ledger.prs[pr.id].state !== 'merged').map((pr) => pr.id)
  say('-', 'released', { scope: 'rollout', stillHeld })
}

// A maintainer's note and a delegate's answer reach the agent the same way.
// A delegate run is no agent at work for a note: when its answer applies,
// `running` still holds it.
export function applyNote(context: CommandsContext, id: string, text: string, by: Author): void {
  applyTable(context, TABLES.note, { cmd: 'note', id, text }, by)
}

function atWorkOf(role: string | undefined): AtWork {
  if (role === undefined) {
    return null
  }

  return role === 'delegate' ? 'delegate' : 'agent'
}

function rowInput(context: CommandsContext, id: string, by: Author): RowInput {
  const { manifest, ledger, running, say } = context

  return {
    id,
    by,
    say,
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
function applyTable(context: CommandsContext, table: Table, command: EffectCommand, by: Author): void {
  const entry = context.ledger.prs[command.id]

  if (!context.running.has(command.id)) {
    transitions.recoverRun(entry, { refund: false, at: context.now() })
  }

  const input = rowInput(context, command.id, by)
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
  } else if (entry.held) {
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
  const input: RowInput = { ...facts, id: command.id, by: 'maintainer', hold: ledger.hold ?? null, say: quiet }
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
  } else if (listed(RELEASED_BY_RETRY, status.code)) {
    released(entry, stage, at)
  }

  say(id, 'retry', { state: entry.state })
}

// The same tick's sync, claim check or gate reads the block again. The gate
// never reads a queued note, so one kept while a verified PR was closed sends it to a fix.
function released(entry: PrEntry, stage: OpenStage, at: IsoTime): void {
  if (stage === 'merge' && entry.pendingNote) {
    transitions.dropVerification(entry)
    transitions.toFix(entry, 'answer from the maintainer', '', { code: 'maintainer-note', at })
  } else {
    transitions.waitOnStage(entry, stage, at)
  }
}

function noteRefusal(entry: PrEntry): Refusal | null {
  return entry.stage === 'merged' || !entry.status ? refusal('already merged') : null
}

// What the note answers, for the prompts that list it. Finding ids change
// on every FAIL, so a dispute is named by the escalation's text.
function noteRecord(entry: PrEntry, { at, by }: RowInput, state: string, text: string): StoredNote {
  if (state === 'blocked') {
    return { at, by, kind: entry.blocked?.kind ?? null, question: entry.blocked?.question ?? null, text, run: null }
  }

  if (transitions.escalatedOverDispute(entry)) {
    return { at, by, kind: transitions.DISPUTE, question: entry.lastError, text, run: null }
  }

  return { at, by, kind: null, question: null, text, run: null }
}

function queueNote(entry: PrEntry, text: string): void {
  entry.pendingNote = [entry.pendingNote, text].filter(Boolean).join('\n\n')
}

function queued(entry: PrEntry, { id, say }: RowInput, text: string): void {
  queueNote(entry, text)
  say(id, 'note-queued', { state: entry.state })
}

function answerBrief(entry: PrEntry, { id, say, at }: RowInput, question: string | null, text: string): void {
  transitions.answerBrief(entry, question, text, at)
  say(id, 'brief-answered')
}

// A fix the note asks for. Its prose names who asked, so events keep their words.
function noteFix(entry: PrEntry, input: RowInput, state: string, text: string): void {
  const { id, by, say, at, limits } = input
  const reason = listed(REQUEST_STATES, state) ? `request from the ${by}` : `answer from the ${by}`

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
function noteOnImplement(entry: PrEntry, input: RowInput, status: Status, { state, text }: { state: string; text: string }): void {
  const { limits, at } = input

  if (status.kind === 'waiting') {
    if (entry.fix) {
      transitions.freshAttempt(entry, 'fix', limits.fix)
    }

    queued(entry, input, text)
  } else if (status.code === 'decision' || status.code === 'obstacle') {
    noteFix(entry, input, state, text)
  } else if (status.code === 'attempts-exhausted' || status.code === 'errors') {
    if (status.code === 'attempts-exhausted') {
      transitions.freshAttempt(entry, status.role, limits[status.role])
    }

    if (entry.fix) {
      transitions.freshAttempt(entry, 'fix', limits.fix)
      transitions.wake(entry, 'implement', at)
      queued(entry, input, text)
    } else {
      noteFix(entry, input, state, text)
    }
  } else {
    queued(entry, input, text)
  }
}

function note(entry: PrEntry, input: RowInput, command: EffectCommand): void {
  const status = entry.status as Status
  const text = command.text ?? ''
  const state = transitions.stateOf(entry)

  entry.noteHistory = [...(entry.noteHistory ?? []), noteRecord(entry, input, state, text)].slice(-NOTES_KEPT)

  if (status.code === 'brief-questions') {
    answerBrief(entry, input, entry.blocked?.question ?? status.question.text, text)
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
    noteOnImplement(entry, input, status, { state, text })
  } else if (status.code === 'dispute') {
    ruling(entry, input, text)
  } else {
    if (status.code === 'attempts-exhausted') {
      transitions.freshAttempt(entry, status.role, input.limits[status.role])
    }

    noteFix(entry, input, state, text)
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

const TABLES: Record<EffectCommand['cmd'], Table> = {
  retry: { refusal: retryRefusal, apply: retry, refused: rejected },
  note: { refusal: noteRefusal, apply: note, refused: rejected },
  approve: { refusal: approvalRefusal, apply: approve, refused: approvalRejected },
}
