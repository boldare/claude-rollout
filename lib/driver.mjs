import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadManifest, raiseEffort } from './manifest.mjs'
import {
  acquireLock,
  drainInbox,
  endRun,
  freshPr,
  openLedger,
  recheckedFindings,
  recordAnswers,
  recordFindings,
  recordVerdict,
  reserveRunName,
  startRun,
  tickNote,
  watchInbox,
} from './ledger.mjs'
import {
  approvalChannel,
  approveRefusal,
  codeScanningFindings,
  currentGate,
  githubApproval,
  judge,
  outOfScope,
  policyViolations,
  undeclaredOutOfScope,
} from './judge.mjs'
import {
  briefReviewNotes,
  briefReviewPrompt,
  briefWritePrompt,
  codeScanningNote,
  delegatePrompt,
  findingsNote,
  fixPrompt,
  implementPrompt,
  preVerifyNote,
  resumeFreshPrompt,
  verifyPrompt,
} from './prompts.mjs'
import { briefGates, briefOutcome, commandResult, criteriaOutcome, preVerifyOutcome, selectCriteria, verifyCriteria } from './checks.mjs'
import { runCommand as spawnCommand } from './runner.mjs'
import { runtimeSummary } from './sandbox.mjs'
import { children, runAgent as spawnAgent, stopAllAgents } from './spawn.mjs'
import { createNotifier, sentences } from './notify.mjs'
import {
  alignWorktree,
  inspectWorktree,
  prepareWorktree,
  preparePreview,
  rebaseWorktree,
  removePreview,
  removeWorktree,
  resetWorktree,
  worktreePath,
} from './worktree.mjs'
import * as gh from './github.mjs'
import * as transitions from './transitions.ts'
import { sleptMs } from './machine.mjs'
import { labelChanges, ourLabel, stageLabels } from './stage.mjs'

const MAX_TICK_ERRORS = 5
const MAX_REFUNDS = 5
const UNAVAILABLE_NOTICE_MINUTES = 30
const AFTER_SLEEP_MS = 2 * 60_000
const SLOW_TICK_QUIET_MS = 10 * 60_000
const PR_COMMANDS = ['approve', 'note', 'retry', 'hold', 'release']
// These take PR ids or all, the whole rollout.
const SCOPED_COMMANDS = ['hold', 'release']
const EVIDENCE_CHARS = 300
// The gate codes that ask a maintainer for an approval. changes-requested is
// left out: the maintainer who asked for changes has seen the PR.
const APPROVAL_NOTICE_CODES = ['awaiting-github-review', 'stale-github-review', 'awaiting-inbox-approval']
const SLOT = { kind: 'waiting', code: 'slot' }

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function minutesSince(iso) {
  return iso ? (Date.now() - Date.parse(iso)) / 60_000 : Infinity
}

function now() {
  return new Date().toISOString()
}

// Null for a missing or unreadable file.
function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

const HEADLINES = {
  implement: (output) => output?.status ?? null,
  fix: (output) => output?.status ?? null,
  verify: (output) => output?.verdict ?? null,
  brief: (output) => (output?.questions?.length > 0 ? 'QUESTIONS' : 'BRIEF'),
  delegate: (output) => output?.decision?.toUpperCase() ?? null,
}

// The detail of every *-done event. `run` pairs it with its *-start, and
// `model` is the one the run reported, so costs compare across models.
export function doneDetail(role, run, result) {
  return {
    run,
    model: result.model ?? null,
    ok: result.ok,
    result: result.ok ? HEADLINES[role](result.output) : null,
    cost: result.costUsd,
    seconds: result.seconds,
    awakeSeconds: result.awakeSeconds ?? null,
    denials: result.denials?.length ?? 0,
    stopped: Boolean(result.stopped),
    error: result.error?.slice(0, 200) ?? null,
  }
}

// The dependencies a brief was written ahead of that merged with another
// patch than the one the brief saw, or with none the ledger knows.
export function briefDrift(heads, entries) {
  return (heads ?? [])
    .filter((head) => !head.patchId || entries[head.id]?.verified?.patchId !== head.patchId)
    .map((head) => ({ id: head.id, sha: head.sha }))
}

// The detail of a status event. Its status kind is `status`, because a `kind`
// would replace the event's own. A merged PR has neither status nor code.
function statusDetail(entry) {
  return { stage: entry.stage ?? null, status: entry.status?.kind ?? null, code: entry.status?.code ?? null }
}

function statusKey(entry) {
  return JSON.stringify(statusDetail(entry))
}

function headLabel(head) {
  return `${head.id}@${head.sha.slice(0, 7)}`
}

function headsKey(heads) {
  return heads.map((head) => `${head.id}@${head.sha}`).join(',')
}

// The whole summary, then as much of the end of the output as fits.
function commandEvidence(record) {
  const tail = record.tail.trim()
  const room = EVIDENCE_CHARS - record.summary.length - 2

  if (!tail || room <= 0) {
    return record.summary
  }

  return `${record.summary}: ${tail.slice(-room)}`
}

// One question of a blocked PR, so the delegate is asked about it only once.
function questionHash(blocked) {
  return createHash('sha256')
    .update(`${blocked.kind}\n${blocked.question ?? ''}`)
    .digest('hex')
    .slice(0, 16)
}

export function delegateAllowed(manifest, entry) {
  const policy = manifest.policy.delegate

  return (
    Boolean(policy) &&
    policy.kinds.includes(entry.blocked?.kind) &&
    !entry.pendingNote &&
    questionHash(entry.blocked) !== entry.delegate.lastQuestion
  )
}

// A question the delegate takes notifies once, through its answer or escalation.
export function delegateTakes(manifest, entry) {
  return delegateAllowed(manifest, entry) && entry.delegate.runs < manifest.policy.delegate.maxPerPr
}

// The current findings the implementer disputed and the verifier still finds
// open. A finding the re-check leaves out is not upheld.
function upheldDisputes(entry, recheck) {
  return (entry.findings?.items ?? []).filter(
    (item) => item.answer?.outcome === 'disputed' && recheck.some((check) => check.id === item.id && check.status === 'open'),
  )
}

// The next FAIL renumbers the findings, so the text names the dispute by its
// words too. Only the first one's text and reason fit.
function disputeText(upheld) {
  const [first] = upheld
  const intro = `the verifier still finds ${upheld.map((item) => item.id).join(', ')} open, which the implementer disputed`
  const finding = upheld.length === 1 ? [`${intro}: ${first.text}`] : [intro, `${first.id}: ${first.text}`]

  return sentences(...finding, `The implementer: ${first.answer.action}`).slice(0, 1000)
}

async function removePr(manifest, pr) {
  await removeWorktree(manifest, pr).catch(() => {})
  // A brief run cut off by a restart can leave its preview behind.
  await removePreview(manifest, pr).catch(() => {})
  await gh.deleteRemoteBranch(manifest, pr.branch).catch(() => {})
}

export function createDriver(
  manifest,
  {
    cleanup = (pr) => removePr(manifest, pr),
    notify: notifyOption = null,
    collectFacts = gh.collectFacts,
    judge: judgeGate = judge,
    runAgent = spawnAgent,
    runCommand = spawnCommand,
    clock = Date.now,
  } = {},
) {
  const ledger = openLedger(manifest)
  // Seeded from the ledger, so a restart logs no status that did not change.
  const loggedStatus = new Map(manifest.all.map((pr) => [pr.id, statusKey(ledger.prs[pr.id])]))
  // A default parameter cannot see the ledger this body opens.
  const notify = notifyOption ?? createNotifier(manifest, { log: (kind, detail) => ledger.event('-', kind, detail) })
  const running = new Map()
  // PR id to the head and the commands, ready and pre-verify, of a gate job
  // with no failed required command. Only in memory, so a restart runs the
  // commands again.
  const preVerifyPasses = new Map()
  const stepFailures = new Map()
  const erredThisTick = new Set()
  // The GitHub reads of the running tick, shared by its steps. Null between
  // ticks, so a step outside a tick reads fresh.
  let reads = null
  const unavailableThisTick = new Set()
  let outageThisTick = false
  let lastTickEnd = null
  let slowSaidAt = null
  let wokeAt = null
  let failedTicks = 0
  let stopping = false
  let manifestMtime = mtimeOf(`${manifest.dir}/manifest.yaml`)

  // Edits to manifest.yaml apply on the next tick without a restart (and
  // without stopping running agents). An invalid edit or a missing file is
  // reported once and ignored.
  function reloadManifest() {
    const mtime = mtimeOf(`${manifest.dir}/manifest.yaml`)

    if (mtime === manifestMtime) {
      return
    }

    manifestMtime = mtime

    try {
      const fresh = loadManifest(manifest.dir, { only: manifest.only, dryRun: manifest.dryRun })

      for (const pr of fresh.all) {
        ledger.prs[pr.id] =
          ledger.prs[pr.id] ??
          transitions.fillFromState(freshPr(), { id: pr.id, briefWritten: existsSync(pr.brief), runs: ledger.data.runs, at: now() })
      }

      Object.assign(manifest, fresh)
      say('-', 'manifest-reloaded', { prs: manifest.prs.map((pr) => pr.id) })
    } catch (error) {
      say(
        '-',
        'manifest-rejected',
        { error: String(error.message ?? error).slice(0, 300) },
        'manifest.yaml has an error; keeping the previous one',
      )
    }
  }

  function say(id, kind, detail = {}, message = null) {
    ledger.event(id, kind, detail)

    const extra = Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail).slice(0, 300)}` : ''
    console.log(`${new Date().toLocaleTimeString()} ${id.padEnd(4)} ${kind}${extra}`)

    if (message) {
      notify(`rollout ${manifest.rollout}`, `${id}: ${message}`)
    }
  }

  function localConfigRemoved(pr, paths) {
    if (paths?.length > 0) {
      say(pr.id, 'local-config-removed', { paths })
    }
  }

  function slots() {
    return running.size < manifest.policy.concurrency
  }

  // A fix the merge gate sends is named by the verdict's code.
  function toFix(pr, reason, note, gateCode = null) {
    transitions.toFix(ledger.prs[pr.id], reason, note, { code: transitions.fixReasonCode(reason, gateCode), at: now() })
    say(pr.id, 'needs-fix', { reason })
  }

  function queueNote(id, text) {
    const entry = ledger.prs[id]
    entry.pendingNote = [entry.pendingNote, text].filter(Boolean).join('\n\n')
  }

  function answerBrief(pr, question, text) {
    transitions.answerBrief(ledger.prs[pr.id], question, text, now())
    say(pr.id, 'brief-answered')
  }

  // Commands from /rollout: approve, note, retry, hold, release. Each applies
  // on its own, and so does each id of a hold or release, so a bad one never
  // drops the rest of the batch.
  function applyCommands() {
    for (const command of drainInbox(manifest)) {
      for (const single of perId(command)) {
        applyCommand(single)
      }
    }
  }

  // A hold or release for PRs becomes one command per id, in order and
  // without repeats. Older CLIs and pages send a lone id. One with no id
  // becomes a bare command, which commandRefusal rejects.
  function perId(command) {
    if (!plainObject(command) || !SCOPED_COMMANDS.includes(command.cmd) || command.all === true) {
      return [command]
    }

    let ids = []

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

  function forRollout(command) {
    return SCOPED_COMMANDS.includes(command.cmd) && command.all === true
  }

  function applyCommand(command) {
    const refusal = commandRefusal(command)

    if (refusal) {
      say('-', 'command-rejected', refusal)
      return
    }

    const forPr = PR_COMMANDS.includes(command.cmd) && !forRollout(command)
    const pr = forPr ? manifest.all.find((item) => item.id === command.id) : null
    const entry = forPr ? ledger.prs[command.id] : null

    try {
      execute(command, pr, entry)
    } catch (error) {
      say(forPr ? command.id : '-', 'command-rejected', { command: command.cmd, reason: String(error?.message ?? error).slice(0, 200) })
    }
  }

  // The detail of the command-rejected event, or null for a command that may apply.
  function commandRefusal(command) {
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

    if (!PR_COMMANDS.includes(cmd)) {
      return { command: cmd, reason: 'unknown command' }
    }

    if (SCOPED_COMMANDS.includes(cmd) && !Object.hasOwn(command, 'id')) {
      return { command: cmd, reason: 'needs PR ids or all' }
    }

    if (typeof id !== 'string' || id === '') {
      return { command: cmd, reason: 'needs a PR id' }
    }

    // Own keys only: ledger.prs.__proto__ is Object.prototype.
    if (!manifest.all.some((pr) => pr.id === id) || !Object.hasOwn(ledger.prs, id)) {
      return { command: cmd, reason: `unknown PR ${id}` }
    }

    if (cmd === 'approve' && !(typeof command.at === 'string' && Number.isFinite(Date.parse(command.at)))) {
      return { command: cmd, reason: 'needs a valid at' }
    }

    return null
  }

  function execute(command, pr, entry) {
    switch (command.cmd) {
      case 'approve':
        approve(pr, entry, command)
        break

      case 'note':
        applyNote(pr, entry, command.text, 'maintainer')
        break

      case 'retry':
        if (entry.state === 'merged') {
          say(command.id, 'command-rejected', { command: 'retry', reason: 'already merged' })
          break
        }

        if (running.has(command.id)) {
          say(command.id, 'command-rejected', { command: 'retry', reason: 'an agent is working on this PR' })
          break
        }

        entry.attempts = { implement: 0, fix: 0, verify: 0, brief: 0 }
        entry.delegate = { ...entry.delegate, runs: 0, limitNotified: false }
        entry.refunds = 0
        entry.failStreak = 0
        entry.tickErrors = 0
        entry.retryAfter = null
        transitions.resumeAfterRetry(entry, { at: now(), briefWritten: existsSync(pr.brief) })
        say(command.id, 'retry', { state: entry.state })
        break

      case 'hold':
        if (forRollout(command)) {
          holdRollout()
        } else {
          holdPr(command.id, entry)
        }

        break

      case 'release':
        if (forRollout(command)) {
          releaseRollout()
        } else {
          releasePr(command.id, entry)
        }

        break
    }
  }

  function holdPr(id, entry) {
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
  function releasePr(id, entry) {
    if (entry.held) {
      transitions.releasePr(entry)
      say(id, 'released', { state: entry.state })
      return
    }

    const reason = ledger.data.hold ? 'not held. The rollout is held: rollout release --all' : 'not held'
    say(id, 'command-rejected', { command: 'release', reason })
  }

  function holdRollout() {
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
  function releaseRollout() {
    if (!ledger.data.hold) {
      say('-', 'command-rejected', { command: 'release', reason: 'not held' })
      return
    }

    ledger.data.hold = null

    const stillHeld = manifest.all.filter((pr) => ledger.prs[pr.id].held && ledger.prs[pr.id].state !== 'merged').map((pr) => pr.id)
    say('-', 'released', { scope: 'rollout', stillHeld })
  }

  // A maintainer's note and a delegate's answer reach the agent the same way.
  // A delegate run is no agent at work here: when its answer applies,
  // `running` still holds it.
  function applyNote(pr, entry, text, by) {
    const id = pr.id
    const agentAtWork = running.has(id) && running.get(id) !== 'delegate'

    if (entry.state !== 'merged') {
      entry.noteHistory = [...(entry.noteHistory ?? []), noteRecord(entry, text, by)].slice(-20)
    }

    if (entry.state === 'blocked' && entry.blocked?.kind === 'brief-questions') {
      answerBrief(pr, entry.blocked.question, text)
    } else if (agentAtWork || entry.state === 'pending') {
      queueNote(id, text)
      say(id, 'note-queued', { state: entry.state })
    } else if (entry.state === 'merged') {
      say(id, 'command-rejected', { command: 'note', reason: 'already merged' })
    } else if (!existsSync(pr.brief) && !entry.pr) {
      answerBrief(pr, null, text)
    } else if (entry.state === 'verified' || entry.state === 'ready_claimed') {
      entry.verified = null
      entry.attempts.fix = Math.min(entry.attempts.fix, manifest.policy.attempts.fix - 1)
      toFix(pr, `request from the ${by}`, text)
    } else if (entry.state === 'needs_fix') {
      entry.attempts.fix = Math.min(entry.attempts.fix, manifest.policy.attempts.fix - 1)
      queueNote(id, text)
      say(id, 'note-queued', { state: 'needs_fix' })
    } else if (transitions.escalatedOverDispute(entry)) {
      entry.attempts.fix = Math.min(entry.attempts.fix, manifest.policy.attempts.fix - 1)
      toFix(pr, 'verifier findings', entry.fixNote)
      queueNote(id, text)
      say(id, 'note-queued', { state: 'needs_fix' })
    } else {
      entry.attempts.fix = Math.min(entry.attempts.fix, manifest.policy.attempts.fix - 1)
      toFix(pr, `answer from the ${by}`, text)
    }
  }

  // What the note answers, for the prompts that list it. Finding ids change
  // on every FAIL, so a dispute is named by the escalation's text.
  function noteRecord(entry, text, by) {
    const at = now()

    if (entry.state === 'blocked') {
      return { at, by, kind: entry.blocked?.kind ?? null, question: entry.blocked?.question ?? null, text, run: null }
    }

    if (transitions.escalatedOverDispute(entry)) {
      return { at, by, kind: transitions.DISPUTE, question: entry.lastError, text, run: null }
    }

    return { at, by, kind: null, question: null, text, run: null }
  }

  // Every note reaches an agent through the next brief, implement or fix run:
  // as pendingNote, the fix note or a brief answer. An agent at work never
  // reads one. Records from older ledgers have no `run` and stay that way.
  function stampNotes(entry, run) {
    for (const record of entry.noteHistory ?? []) {
      if (record.run === null) {
        record.run = run
      }
    }
  }

  // For a dispute this is the verify run: onDone ends it before rejected runs.
  function lastEndedRun(id) {
    const ended = Object.entries(ledger.data.runs ?? {}).filter(
      ([, record]) => record.id === id && record.role !== 'delegate' && record.endedAt,
    )

    ended.sort(([, left], [, right]) => Date.parse(left.endedAt) - Date.parse(right.endedAt))

    return ended.at(-1)?.[0] ?? null
  }

  // An approval names the exact verified head and patch the maintainer saw
  // on the card, and must be posted after that verification finished.
  function approve(pr, entry, command) {
    const reject = (reason) => say(pr.id, 'approval-rejected', { reason }, `approval rejected: ${reason}`)
    const refusal = approveRefusal(manifest, entry)

    if (refusal) {
      return reject(refusal)
    }

    if (entry.state !== 'verified' || !entry.verified) {
      return reject(`state is ${entry.state}, not verified`)
    }

    if (command.patchId !== entry.verified.patchId || command.sha !== entry.verified.sha) {
      return reject('it names a different head than the one verified now; look at the card again')
    }

    if (Date.parse(command.at) < Date.parse(entry.verified.at)) {
      return reject('it was posted before the verification finished')
    }

    if (running.has(pr.id)) {
      return reject('an agent is working on this PR')
    }

    entry.approved = { patchId: entry.verified.patchId, sha: entry.verified.sha, at: now(), channel: 'inbox' }
    say(
      pr.id,
      'approved',
      { sha: entry.verified.sha.slice(0, 7), channel: 'inbox' },
      `approved PR #${entry.pr}; merging in ${manifest.policy.mergeDelaySeconds}s unless you hold it (rollout hold ${pr.id})`,
    )
  }

  // A PR's model.implement runs its implement and fix runs until one of them
  // also raises the effort: a second implement attempt or a third fix. That
  // run and every later one go to the rollout's model, also after rollout
  // retry, because the PR proved too hard for the first.
  function implementerModel(pr, entry, raised) {
    entry.modelRaised = entry.modelRaised || raised

    return entry.modelRaised ? manifest.model : pr.model.implement
  }

  // A job ends outside any tick, where nothing catches a throw, and an
  // unhandled rejection would end the driver and orphan every agent. So a
  // failed write here is only printed. The tick's own save tries again.
  async function endJob(pr, work, onError) {
    let failure = null

    try {
      await work
    } catch (error) {
      failure = { error }
    }

    running.delete(pr.id)

    if (failure) {
      try {
        onError(failure.error)
      } catch (handlerError) {
        console.error(`${pr.id} job error not handled: ${String(handlerError?.message ?? handlerError)}`)
      }
    }

    try {
      ledger.save()
    } catch (saveError) {
      console.error(`${pr.id} ledger not saved at the end of a job: ${String(saveError?.message ?? saveError)}`)
    }
  }

  function logFailed(pr, run, result) {
    if (result.logError) {
      say(pr.id, 'log-failed', { run, error: result.logError })
    }
  }

  function launch(pr, role, { reason, note, sha } = {}) {
    const entry = ledger.prs[pr.id]

    if (stopping) {
      return
    }

    if (role === 'brief') {
      return launchBrief(pr)
    }

    // An implement or fix run needs a brief. With no PR yet, the way on is to write one.
    if (!existsSync(pr.brief) && !entry.pr) {
      transitions.toPending(entry, now())
      say(pr.id, 'brief-missing', { role })
      return
    }

    if (entry.attempts[role] >= manifest.policy.attempts[role]) {
      transitions.escalateExhausted(entry, { role, limit: manifest.policy.attempts[role], at: now(), run: lastEndedRun(pr.id) })
      say(pr.id, 'escalated', { role }, `${role} attempts exhausted, needs you (rollout retry or note)`)
      return
    }

    entry.attempts[role] += 1

    let prompt
    let effort
    let model
    let resume = false
    let sessionId

    if (role === 'implement') {
      sessionId = randomUUID()
      entry.sessionId = sessionId
      effort = raiseEffort(pr.effort.implement, entry.attempts.implement - 1)
      model = implementerModel(pr, entry, entry.attempts.implement > 1)
      entry.briefDrift = briefDrift(entry.briefHeads, ledger.prs)
      prompt = implementPrompt(manifest, pr, entry)
      // A pending note is already in noteHistory, which the prompt lists.
      entry.pendingNote = null
    } else if (role === 'fix') {
      const text = [note, entry.pendingNote].filter(Boolean).join('\n\n')
      effort = raiseEffort(pr.effort.implement, Math.max(0, entry.attempts.fix - 2))
      model = implementerModel(pr, entry, entry.attempts.fix > 2)

      if (entry.sessionId) {
        sessionId = entry.sessionId
        resume = true
        prompt = fixPrompt(manifest, pr, entry, { reason, note: text, head: entry.claimedSha })
      } else {
        sessionId = randomUUID()
        entry.sessionId = sessionId
        prompt = resumeFreshPrompt(manifest, pr, entry, { reason, note: text })
      }

      entry.pendingNote = null
    } else {
      sessionId = randomUUID()
      effort = pr.effort.verify
      model = manifest.model
      prompt = verifyPrompt(manifest, pr, entry, sha)
    }

    transitions.runStarted(entry, role, { at: now(), sha })
    const total = entry.attempts.implement + entry.attempts.fix + entry.attempts.verify
    const logName = `${pr.id}-${String(total).padStart(2, '0')}-${role}`
    const run = reserveRunName(manifest, logName)
    transitions.runName(entry, run)

    if (role !== 'verify') {
      stampNotes(entry, run)
    }

    say(pr.id, `${role}-start`, { run, log: `logs/${run}.jsonl`, effort, model, resume, reason })
    startRun(ledger.data, { run, id: pr.id, role, reason, effort, model, resume })

    const job = (async () => {
      const cwd = role === 'verify' ? worktreePath(manifest, pr) : await prepareWorktree(manifest, pr)

      return runAgent(manifest, pr, { role, prompt, effort, model, sessionId, resume, cwd, logName: run })
    })().catch((error) => ({ ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }))

    running.set(pr.id, role)
    endJob(
      pr,
      job.then((result) => onDone(pr, role, result, { sha, run })),
      (error) => {
        say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) })

        if (transitions.RUNNING[ledger.prs[pr.id].state]) {
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
  function launchBrief(pr) {
    const entry = ledger.prs[pr.id]

    if (entry.attempts.brief >= manifest.policy.attempts.brief) {
      transitions.escalateExhausted(entry, { role: 'brief', limit: manifest.policy.attempts.brief, at: now(), run: lastEndedRun(pr.id) })
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
    const heads = gh.unmergedHeads(pr, ledger) ?? []
    const gates = briefGates(manifest.gates.brief)
    const ahead = heads.length > 0 ? { ahead: heads.map(headLabel) } : {}
    const base = `${pr.id}-${String(entry.attempts.brief).padStart(2, '0')}-brief`

    function startStep(step) {
      const run = reserveRunName(manifest, `${base}-${step}`)
      say(pr.id, 'brief-start', { run, log: `logs/${run}.jsonl`, step, effort, model, ...ahead })
      startRun(ledger.data, { run, id: pr.id, role: 'brief', step, effort, model })

      return run
    }

    // Every brief-start gets its brief-done, also when the step throws
    // before its agent ends.
    async function finishStep(step, run, work) {
      let result

      try {
        result = await work()
      } catch (error) {
        result = { ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }
      }

      const detail = { ...doneDetail('brief', run, result), step }
      say(pr.id, 'brief-done', detail)
      endRun(ledger.data, { id: pr.id, role: 'brief', step }, detail)
      logFailed(pr, run, result)

      return result
    }

    const writeRun = startStep('write')
    transitions.runName(entry, writeRun)
    stampNotes(entry, writeRun)

    async function write() {
      let cwd
      const writer = await finishStep('write', writeRun, async () => {
        cwd = heads.length > 0 ? await preparePreview(manifest, pr, heads) : await prepareWorktree(manifest, pr)

        // Not a failed run: the brief waits until the dependencies merge.
        if (!cwd) {
          const error = `${heads.map(headLabel).join(', ')} do not merge cleanly onto origin/${manifest.repo.base}`

          return { ok: false, previewConflict: true, error, costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }
        }

        return runAgent(manifest, pr, {
          role: 'brief',
          prompt: briefWritePrompt(manifest, pr, entry, heads, gates),
          effort,
          model,
          sessionId: randomUUID(),
          cwd,
          logName: writeRun,
        })
      })

      if (!writer.ok) {
        return writer
      }

      const prompt = briefReviewPrompt(manifest, pr, entry, writer.output.brief, heads, gates)
      const reviewRun = startStep('review')
      transitions.reviewStarted(entry, { run: reviewRun, at: now() })
      const reviewer = await finishStep('review', reviewRun, () =>
        runAgent(manifest, pr, { role: 'brief', prompt, effort, model, sessionId: randomUUID(), cwd, logName: reviewRun }),
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
          await removePreview(manifest, pr).catch(() => {})
        }
      }
    })().catch((error) => ({ ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }))

    running.set(pr.id, 'brief')
    endJob(
      pr,
      job.then((result) => onBriefDone(pr, result, heads, gates)),
      (error) => {
        say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) })
        transitions.toPending(ledger.prs[pr.id], now())
      },
    )
  }

  // A brief has no claim and no head of its own, so gateCheck's dedupe does not
  // fit it. The dependency heads it saw tie each result to its code instead.
  function briefGateChecks(pr, heads, outcome) {
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
  function onBriefDone(pr, result, heads = [], gates = briefGates(manifest.gates.brief)) {
    const entry = ledger.prs[pr.id]
    entry.costUsd = Number((entry.costUsd + (result.costUsd ?? 0)).toFixed(4))

    // The attempt goes back, and these heads are not tried again: a new
    // verification or a merge moves them on.
    if (result.previewConflict) {
      transitions.briefWaits(entry, headsKey(heads), { heads, at: now() })
      say(pr.id, 'brief-waits', { ahead: heads.map(headLabel) })
      return
    }

    if (!result.ok) {
      failed(pr, 'brief', result)
      transitions.toPending(entry, now())
      return
    }

    const out = result.output
    const outcome = briefOutcome(gates, out)

    briefGateChecks(pr, heads, outcome)

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
        delegateTakes(manifest, entry)
          ? null
          : `the brief needs your decision: ${outcome.questions[0].slice(0, 100)} (rollout card ${pr.id}, then rollout note ${pr.id} "...")`,
      )

      return
    }

    mkdirSync(dirname(pr.brief), { recursive: true })
    writeFileSync(pr.brief, `${out.brief.trim()}\n`)
    writeFileSync(pr.brief.replace(/\.md$/, '.review-notes.md'), `${briefReviewNotes(out.notes, outcome.failedRecommended)}\n`)
    transitions.briefWritten(entry, { scope: out.expectedFiles, heads, at: now() })
    say(pr.id, 'brief-written', { files: out.expectedFiles.length, bump: out.changesetBump })
  }

  // A read-only agent answers the question a PR is blocked on from the plan,
  // or hands it back to the maintainer. The PR stays blocked while it runs.
  function launchDelegate(pr) {
    if (stopping) {
      return
    }

    const entry = ledger.prs[pr.id]
    const question = questionHash(entry.blocked)
    const blocked = { ...entry.blocked }
    const effort = manifest.policy.delegate.effort
    const model = manifest.model

    entry.delegate.runs += 1

    const run = reserveRunName(manifest, `${pr.id}-${String(entry.delegate.runs).padStart(2, '0')}-delegate`)
    // `blocked` and not `kind`, which would overwrite the event's own kind.
    say(pr.id, 'delegate-start', { run, log: `logs/${run}.jsonl`, effort, model, blocked: blocked.kind })
    startRun(ledger.data, { run, id: pr.id, role: 'delegate', reason: blocked.kind, effort, model })

    // The prompt is built in the job, so a missing briefing source fails this run instead of throwing in advance.
    const job = (async () => {
      const path = worktreePath(manifest, pr)
      const cwd = existsSync(path) ? path : await prepareWorktree(manifest, pr)
      const prompt = delegatePrompt(manifest, pr, entry)

      return runAgent(manifest, pr, { role: 'delegate', prompt, effort, model, sessionId: randomUUID(), resume: false, cwd, logName: run })
    })().catch((error) => ({ ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }))

    running.set(pr.id, 'delegate')
    endJob(
      pr,
      job.then((result) => onDelegateDone(pr, result, { run, question, blocked })),
      (error) => say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) }),
    )
  }

  async function onDelegateDone(pr, result, { run, question, blocked }) {
    const entry = ledger.prs[pr.id]
    entry.costUsd = Number((entry.costUsd + (result.costUsd ?? 0)).toFixed(4))
    const detail = doneDetail('delegate', run, result)
    say(pr.id, 'delegate-done', detail)
    endRun(ledger.data, { id: pr.id, role: 'delegate' }, detail)
    logFailed(pr, run, result)

    if (entry.state === 'merged') {
      await cleanup(pr)
      return
    }

    if (result.stopped) {
      entry.delegate.runs = Math.max(0, entry.delegate.runs - 1)
      return
    }

    entry.delegate.lastQuestion = question

    const out = result.output ?? {}
    const report = {
      answer: typeof out.answer === 'string' ? out.answer : '',
      planRefs: Array.isArray(out.planRefs) ? out.planRefs : [],
      reasoning: typeof out.reasoning === 'string' ? out.reasoning : '',
    }

    function recordAnswer(decision, fields = {}) {
      const answer = { at: now(), kind: blocked.kind, question: blocked.question ?? '', decision, ...report, ...fields, run }
      entry.delegate.answers = [...entry.delegate.answers, answer].slice(-20)
    }

    // A maintainer's note applied while the delegate ran. The note wins.
    if (entry.state !== 'blocked' || questionHash(entry.blocked) !== question) {
      recordAnswer('dropped')
      say(pr.id, 'delegate-dropped', { run, state: entry.state })
      return
    }

    if (!result.ok) {
      recordAnswer('failed', { reasoning: result.error ?? '' })
      entry.lastError = result.error
      backOff(entry, result)
      escalateFromDelegate(pr, blocked, run, `the run failed: ${result.error}`)
      return
    }

    entry.failStreak = 0

    const answer = report.answer.trim()

    if (out.decision === 'answer' && answer) {
      recordAnswer('answer')
      applyNote(pr, entry, `Answer from the delegate, on the maintainer's behalf, from the plan:\n\n${answer}`, 'delegate')
      say(
        pr.id,
        'delegate-answered',
        { run, blocked: blocked.kind, planRefs: report.planRefs },
        sentences(`delegate answered: ${answer.slice(0, 100)}`, `Override with rollout note ${pr.id}`),
      )

      return
    }

    recordAnswer('escalate')
    escalateFromDelegate(pr, blocked, run, out.decision === 'answer' ? 'the delegate gave an empty answer' : report.reasoning)
  }

  function escalateFromDelegate(pr, blocked, run, reason) {
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

  function failed(pr, role, result) {
    const entry = ledger.prs[pr.id]
    entry.lastError = result.error

    // Runs that did no work (a stop, an outage, a quota wall) give their
    // attempt back, a bounded number of times; every failure backs off.
    const idle = result.stopped || result.transient || result.account || ((result.costUsd ?? 0) < 0.01 && (result.seconds ?? 0) < 60)

    if (idle && (entry.refunds ?? 0) < MAX_REFUNDS) {
      entry.attempts[role] -= 1
      entry.refunds = (entry.refunds ?? 0) + 1
    }

    backOff(entry, result)

    if (role !== 'verify' && result.sessionMissing) {
      entry.sessionId = null
    }

    transitions.runFailed(entry, role, now())
  }

  // A hold already in place stays as it is, a maintainer's above all. Every
  // account failure still notifies.
  function holdForAccount(result) {
    const notice = 'account limit reached, the rollout is held (rollout release --all)'

    if (ledger.data.hold) {
      notify(`rollout ${manifest.rollout}`, `-: ${notice}`)
      return
    }

    const reason = result.error?.slice(0, 200) || 'account limit'

    ledger.data.hold = { at: now(), by: 'driver', reason }
    say('-', 'held', { scope: 'rollout', by: 'driver', reason }, notice)
  }

  function backOff(entry, result) {
    if (result.account) {
      holdForAccount(result)
    }

    if (!result.stopped) {
      entry.failStreak = (entry.failStreak ?? 0) + 1
      entry.retryAfter = new Date(Date.now() + Math.min(2 ** entry.failStreak, 30) * 60_000).toISOString()
    }
  }

  async function onDone(pr, role, result, { sha, run }) {
    const entry = ledger.prs[pr.id]

    // A run can end in the middle of a tick, after sync read the PR at its
    // head from before the push. checkClaim would take that read and move the
    // claim back to the old head.
    gh.forgetPr(reads, entry.pr)

    if (result.output?.pr && result.output.pr !== entry.pr) {
      gh.forgetPr(reads, result.output.pr)
    }

    entry.costUsd = Number((entry.costUsd + (result.costUsd ?? 0)).toFixed(4))
    const detail = doneDetail(role, run, result)
    say(pr.id, `${role}-done`, detail)
    endRun(ledger.data, { id: pr.id, role }, detail)
    logFailed(pr, run, result)

    if (entry.state === 'merged') {
      await cleanup(pr)
      return
    }

    if (!result.ok) {
      failed(pr, role, result)
      return
    }

    entry.failStreak = 0

    const out = result.output

    if (role === 'verify') {
      await verified(pr, entry, out, sha, run)
      return
    }

    entry.ready = out

    if (out.status === 'BLOCKED') {
      transitions.toBlocked(entry, { ...(out.blocked ?? { kind: 'unknown', question: out.summary, evidence: '' }), run }, { at: now() })
      say(
        pr.id,
        'blocked',
        { reason: entry.blocked.kind },
        delegateTakes(manifest, entry) ? null : `blocked (${entry.blocked.kind}): ${entry.blocked.question.slice(0, 120)}`,
      )

      return
    }

    // A GitHub outage is no fault of the report, and a fix run would spend
    // an attempt on it. The report waits in entry.ready for a later tick.
    try {
      await claimReport(pr, entry, out)
    } catch (error) {
      transitions.reportWaits(entry, now())
      entry.lastError = String(error?.message ?? error).slice(0, 1000)
      say(pr.id, 'report-unchecked', { error: entry.lastError.slice(0, 300) })
    }
  }

  // Claimed or sent to a fix, the report is used up. entry.ready keeps the last
  // report of every PR, so a stale 'report' role would claim it again.
  async function claimReport(pr, entry, out) {
    // Before the check, so a report it sends back or one parked for a later
    // tick still answers the findings.
    recordAnswers(entry, out.addressed ?? [])

    const problem = await checkReport(pr, out)
    transitions.reportUsed(entry)

    if (problem) {
      toFix(pr, 'report does not match GitHub', problem)
      return
    }

    transitions.toClaimed(entry, { pr: out.pr, sha: out.headSha, at: now() })
    say(pr.id, 'ready-claimed', { pr: out.pr, sha: out.headSha.slice(0, 7) })
    await answerFeedback(pr, entry, out)

    if (entry.pendingNote) {
      toFix(pr, 'answer from the maintainer', '')
    }
  }

  // The READY report's PR number is the model's claim: it must name an open
  // PR from this branch into the base. It names an unknown PR only when the
  // PR read answers 404 and the repository still reads (gh.prNotFound). Any
  // other error is thrown, a 404 for both included: a token that lost access
  // to a private repo gets one for each.
  async function checkReport(pr, out) {
    if (!out.pr || !out.headSha) {
      return 'Your READY report lacks `pr` or `headSha`. Finish the protocol and report again.'
    }

    try {
      const githubPr = await gh.viewPr(manifest, out.pr)

      if (githubPr.headRefName !== pr.branch || githubPr.baseRefName !== manifest.repo.base || githubPr.state !== 'OPEN') {
        return `PR #${out.pr} is ${githubPr.state}, ${githubPr.headRefName} → ${githubPr.baseRefName}; expected an open PR ${pr.branch} → ${manifest.repo.base}.`
      }
    } catch (error) {
      if (!(await gh.prNotFound(manifest, error))) {
        throw error
      }

      return `PR #${out.pr} could not be read (${String(error).slice(0, 200)}). Report the number of your PR.`
    }

    return null
  }

  function nextStep(pr, entry) {
    const channel = approvalChannel(manifest, entry.author)

    if (channel === 'github') {
      return 'review and approve it on GitHub'
    }

    if (channel === 'inbox') {
      return `check the card, then: rollout approve ${pr.id}`
    }

    if (manifest.policy.merge === 'manual') {
      return 'review it; the driver tells you when it is ready to merge'
    }

    return 'the driver merges it once the gate passes'
  }

  async function verified(pr, entry, out, sha, run) {
    const tree = await inspectWorktree(manifest, pr)
    const touched = !tree.clean || tree.head !== sha

    if (touched) {
      localConfigRemoved(pr, await resetWorktree(manifest, pr, sha))
    }

    const criteria = criteriaOutcome(entry.verifyCriteria ?? [], out.criteria ?? [])
    // The verifier's own findings come first, so they keep their numbers.
    const judged = {
      ...out,
      verdict: criteria.failedRequired.length > 0 ? 'FAIL' : out.verdict,
      blocking: [...(out.blocking ?? []), ...criteria.findings],
      criteria: criteria.results,
    }

    recordVerdict(entry, { ...judged, recheck: recheckedFindings(entry, out.recheck ?? []), at: now(), run })

    for (const record of criteria.results) {
      gateCheck(pr, entry, { stage: 'verify', level: record.level, item: record.id, result: record.result, evidence: record.evidence })
    }

    // A FAIL is honoured even from a verifier that touched the tree: trusting
    // it cannot cause a merge. A PASS must come from an untouched tree.
    if (judged.verdict === 'FAIL') {
      rejected(pr, entry, judged, touched ? tree.status : '')
      return
    }

    if (touched) {
      transitions.verifyAgain(entry, now())
      say(
        pr.id,
        'verifier-touched-tree',
        { head: tree.head.slice(0, 7), status: tree.status.slice(0, 200) },
        'the verifier changed the worktree; PASS discarded, verifying again',
      )

      return
    }

    if (out.sha !== sha || sha !== entry.claimedSha) {
      transitions.verifyAgain(entry, now())
      say(pr.id, 'verify-stale', { verified: out.sha, claimed: entry.claimedSha })
      return
    }

    transitions.toVerified(entry, { sha, at: now() })

    say(pr.id, 'verified', { sha: sha.slice(0, 7) }, `verified PR #${entry.pr}: ${nextStep(pr, entry)}`)

    if (entry.pendingNote) {
      entry.verified = null
      toFix(pr, 'answer from the maintainer', '')
    }
  }

  // The upheld disputes are read before the FAIL's own findings replace them.
  // They go to the maintainer, so no fix attempt is spent on them.
  function rejected(pr, entry, out, leftovers) {
    const upheld = upheldDisputes(entry, out.recheck ?? [])

    recordFindings(entry, out.blocking, now())

    const note = findingsNote(entry.findings.items, out.checklist, leftovers)

    if (upheld.length === 0) {
      toFix(pr, 'verifier findings', note)
      return
    }

    const ids = upheld.map((item) => item.id)

    transitions.escalateDispute(entry, { note, text: disputeText(upheld), at: now(), run: lastEndedRun(pr.id), findings: ids })
    say(
      pr.id,
      'escalated',
      { reason: transitions.DISPUTE, findings: ids },
      `the verifier still finds ${ids.join(', ')} open, which the implementer disputed. It needs your decision (rollout card ${pr.id}, then rollout note ${pr.id} "..." or rollout retry ${pr.id})`,
    )
  }

  // GitHub wins: merges, closes and moved heads made outside the driver.
  async function sync(pr) {
    const entry = ledger.prs[pr.id]

    if (!entry.pr || entry.state === 'merged') {
      return
    }

    const githubPr = await gh.viewPr(manifest, entry.pr, { reads })
    entry.author = githubPr.author
    // What the PR really carries: a label removed or added by hand is put
    // right on the next label sync.
    entry.stageLabels = githubPr.labels.filter(ourLabel)

    if (githubPr.state === 'MERGED') {
      const wasOurs = entry.state === 'verified' && entry.gate?.action === 'merge'
      transitions.toMerged(entry)

      if (wasOurs) {
        say(pr.id, 'merged', { pr: entry.pr }, `merged PR #${entry.pr}`)
      } else {
        say(pr.id, 'merged-outside-driver', { pr: entry.pr })
      }

      const mergeSha = await gh.mergeCommit(manifest, entry.pr).catch(() => null)

      if (mergeSha) {
        entry.mergeSha = mergeSha
        ledger.data.lastMerge = { id: pr.id, sha: mergeSha, at: now() }
      }

      // A running agent still works in the worktree; onDone cleans up after it.
      if (!running.has(pr.id)) {
        await cleanup(pr)
      }

      return
    }

    if (running.has(pr.id)) {
      return
    }

    if (githubPr.state === 'CLOSED') {
      if (entry.state !== 'blocked') {
        transitions.toBlocked(
          entry,
          {
            kind: 'closed',
            question: `PR #${entry.pr} was closed outside the driver. Reopen it and run rollout retry, or drop it from the manifest.`,
            evidence: '',
            run: null,
          },
          { at: now() },
        )

        say(pr.id, 'blocked', { reason: 'closed' }, `PR #${entry.pr} was closed`)
      }

      return
    }

    if (entry.state === 'verified' && githubPr.headRefOid !== entry.verified.sha) {
      const facts = await collectFacts(manifest, pr, entry, ledger, { reads })

      if (facts.pr?.headRefOid === githubPr.headRefOid && facts.patchId === entry.verified.patchId) {
        entry.verified.sha = githubPr.headRefOid
        entry.claimedSha = githubPr.headRefOid

        if (entry.approved?.patchId === facts.patchId) {
          entry.approved.sha = githubPr.headRefOid
        }

        const aligned = await alignWorktree(manifest, pr, githubPr.headRefOid).catch(() => null)

        localConfigRemoved(pr, aligned?.removed)
        say(pr.id, 'head-moved-same-patch', { sha: githubPr.headRefOid.slice(0, 7) })
      } else {
        reverify(pr, githubPr.headRefOid, 'new-patch', 'PR head changed after verification; verifying again')
      }
    }
  }

  // The approval stays, bound to the patch id it was given for. The gate
  // counts it only for that id.
  function reverify(pr, sha, reason, message) {
    transitions.claimNewHead(ledger.prs[pr.id], { sha, at: now() })
    say(pr.id, 'head-moved-reverify', { sha: sha.slice(0, 7), reason }, message)
  }

  // Maintainer review comments become a fix run for the implementer, once
  // the maintainer has been quiet for a few minutes (a review in progress is
  // not interrupted). Handled comments are remembered by id.
  async function handleFeedback(pr) {
    const entry = ledger.prs[pr.id]

    if (
      !entry.pr ||
      running.has(pr.id) ||
      !['verified', 'ready_claimed', 'needs_fix'].includes(entry.state) ||
      manifest.repo.maintainers.length === 0
    ) {
      return
    }

    const seen = new Set(entry.feedbackSeen ?? [])
    const fresh = (await gh.feedbackFor(manifest, entry.pr, { reads })).filter((item) => !seen.has(item.id))

    if (fresh.length === 0) {
      entry.feedbackWaiting = false
      reviewEnded(entry)
      return
    }

    entry.feedbackWaiting = true
    reviewWaits(entry, fresh.at(-1).at)

    if (minutesSince(fresh.at(-1).at) < manifest.policy.feedbackQuietMinutes) {
      return
    }

    const note = feedbackNote(entry.pr, fresh)
    entry.feedbackSeen = [...seen, ...fresh.map((item) => item.id)]
    entry.feedbackInFix = [
      ...(entry.feedbackInFix ?? []),
      ...fresh.map((item) => ({ id: item.id, commentId: item.commentId ?? null, body: item.body.slice(0, 200) })),
    ]

    entry.feedbackWaiting = false
    entry.verified = null
    say(pr.id, 'review-feedback', { comments: fresh.length })

    if (entry.state === 'needs_fix') {
      transitions.joinFix(entry, note)
    } else {
      toFix(pr, 'maintainer review', note)
    }
  }

  // The gate leaves a PR alone while a maintainer reviews it. A hold shows instead.
  function reviewWaits(entry, lastCommentAt) {
    if (entry.stage === 'merge' && entry.status?.kind !== 'running' && !entry.held && !ledger.data.hold) {
      transitions.setStatus(entry, 'merge', { kind: 'waiting', code: 'review-in-progress', lastCommentAt }, now())
    }
  }

  function reviewEnded(entry) {
    if (entry.status?.code === 'review-in-progress') {
      transitions.mergeStatus(entry, now())
    }
  }

  function feedbackNote(number, items) {
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

  function blockForCodeScanning(pr, entry, reasons) {
    // Without a verification, rollout retry resumes through checkClaim, which reads the alerts again before any agent runs.
    entry.verified = null
    transitions.toBlocked(
      entry,
      {
        kind: 'code-scanning',
        question: `PR #${entry.pr} has new code scanning alerts. Dismiss a false positive on GitHub and run rollout retry, or send instructions with rollout note.`,
        evidence: reasons.join('\n'),
        run: null,
      },
      { at: now() },
    )

    say(pr.id, 'blocked', { reason: 'code-scanning' }, `blocked (code-scanning): ${reasons[0].slice(0, 120)}`)
  }

  // Once per PR, even across restarts: the flag lives in the ledger.
  function noticeCodeScanning(pr, entry, facts) {
    if (facts.codeScanning?.available !== false || entry.notified.codeScanningUnavailable) {
      return
    }

    entry.notified.codeScanningUnavailable = true
    say(pr.id, 'code-scanning-unavailable', { reason: facts.codeScanning.reason })
  }

  // After a fix that answered review comments: reply in each inline thread
  // and summarize the rest, as the agents' account.
  async function answerFeedback(pr, entry, out) {
    const pending = entry.feedbackInFix ?? []

    if (pending.length === 0) {
      return
    }

    const actions = new Map((out.addressed ?? []).map((item) => [item.id, item.action]))
    const rest = []

    for (const item of pending) {
      const action = actions.get(item.id) ?? 'not reported by the implementer; please check'
      const text = `${action} (${out.headSha.slice(0, 7)})`

      if (item.commentId) {
        await gh
          .replyAsAgents(manifest, entry.pr, item.commentId, text)
          .catch((error) => say(pr.id, 'reply-failed', { error: String(error).slice(0, 200) }))
      } else {
        rest.push(`- "${item.body.slice(0, 80)}": ${text}`)
      }
    }

    if (rest.length > 0) {
      await gh
        .commentAsAgents(manifest, entry.pr, `Review comments addressed:\n\n${rest.join('\n')}`)
        .catch((error) => say(pr.id, 'reply-failed', { error: String(error).slice(0, 200) }))
    }

    const handled = pending.map((item) => ({
      id: item.id,
      body: item.body,
      action: actions.get(item.id) ?? null,
      sha: out.headSha,
      at: now(),
    }))

    entry.feedbackHandled = [...(entry.feedbackHandled ?? []), ...handled].slice(-50)
    entry.feedbackInFix = []
    say(pr.id, 'review-answered', { comments: pending.length })
  }

  // A pass is logged once per claim and head, even across restarts, so a PR that waits for a slot does not log every tick.
  // The head is part of the key because a rebase with the same patch moves claimedSha but keeps claimedAt.
  // A fail is always logged. A required one starts the list over: rollout retry can resume a claim after a fail without a new claimedAt.
  // A recommended fail starts nothing over, or every pass logged before it would be logged again on the next tick.
  function gateCheck(pr, entry, { stage, level, item, result, evidence }) {
    const { claimedAt, claimedSha: sha } = entry
    const current = entry.notified.gateChecks
    const marker = current?.claimedAt === claimedAt && current?.sha === sha ? current : { claimedAt, sha, seen: [] }
    const key = `${stage}:${level}:${item}:${result}`

    entry.notified.gateChecks = marker

    if (marker.seen.includes(key)) {
      return
    }

    if (result === 'fail' && level === 'required') {
      marker.seen = []
    } else if (result !== 'fail') {
      marker.seen.push(key)
    }

    say(pr.id, 'gate-check', {
      stage,
      item,
      level,
      result,
      sha: sha.slice(0, 7),
      evidence: evidence.slice(0, EVIDENCE_CHARS),
    })
  }

  // Off or unavailable checked nothing, so it is a skip, not a pass.
  function codeScanningCheck(facts) {
    const { action, minSeverity } = manifest.repo.codeScanning

    if (action === 'ignore') {
      return { result: 'skip', evidence: 'off' }
    }

    if (facts.codeScanning?.available === false) {
      return { result: 'skip', evidence: 'unavailable' }
    }

    return { result: 'pass', evidence: `no new alerts at or above ${minSeverity}` }
  }

  function runsSeen(ci) {
    return ci.runs.map((run) => `${run.name} (${run.conclusion ?? run.status})`).join(', ') || 'none'
  }

  function scopeNote(undeclared) {
    return [
      "These files are outside the PR's scope, and your READY report does not list them in `deviations`:",
      ...undeclared.map((path) => `- ${path}`),
      '',
      'Revert each change, or keep it and list the file in `deviations` of your next READY report, with the reason. If you keep every change, no new commit is needed. The verifier still judges every reason.',
    ].join('\n')
  }

  function claimStatus(entry, status) {
    transitions.setStatus(entry, 'pre-verify', status, now())
  }

  // A PR merged or closed since sync is left to the next sync to record.
  // A note queued while a verifier ran goes to the implementer first, so no
  // verifier holds the PR to an answer the implementer has not seen.
  async function checkClaim(pr) {
    const entry = ledger.prs[pr.id]

    if (entry.pendingNote) {
      toFix(pr, 'answer from the maintainer', '')
      return
    }

    const githubPr = await gh.viewPr(manifest, entry.pr, { reads })
    entry.author = githubPr.author

    if (githubPr.state !== 'OPEN') {
      return
    }

    if (githubPr.headRefOid !== entry.claimedSha) {
      say(pr.id, 'claim-moved', { claimed: entry.claimedSha?.slice(0, 7), head: githubPr.headRefOid.slice(0, 7) })
      entry.claimedSha = githubPr.headRefOid
      entry.claimedAt = now()
      entry.ciPendingSince = null
    }

    const ci = await gh.checksFor(manifest, entry.claimedSha, { reads })

    if (ci.state === 'pending') {
      entry.ciPendingSince = entry.ciPendingSince ?? now()
      claimStatus(entry, { kind: 'waiting', code: 'ci', sha: entry.claimedSha, missing: ci.missing, pending: ci.pending })

      if (minutesSince(entry.ciPendingSince) > manifest.policy.ciStallMinutes) {
        const seen = runsSeen(ci)
        const why =
          ci.runs.length === 0
            ? `No check runs appeared for ${entry.claimedSha}. Find out why (workflow syntax? did the push reach GitHub?) and fix it.`
            : `Checks for ${entry.claimedSha} have not settled after ${manifest.policy.ciStallMinutes} minutes. Required globs with no matching run: ${ci.missing.join(', ') || 'none'}; still running: ${ci.pending.join(', ') || 'none'}; runs seen: ${seen}. Job names must keep matching ${manifest.repo.requiredChecks.join(', ')}.`

        gateCheck(pr, entry, {
          stage: 'preVerify',
          level: 'required',
          item: 'ci',
          result: 'fail',
          evidence: `not settled after ${manifest.policy.ciStallMinutes} minutes (missing: ${ci.missing.join(', ') || 'none'}, running: ${ci.pending.join(', ') || 'none'})`,
        })

        toFix(pr, 'CI did not settle', why)
      }

      return
    }

    entry.ciPendingSince = null

    if (ci.state === 'red') {
      gateCheck(pr, entry, {
        stage: 'preVerify',
        level: 'required',
        item: 'ci',
        result: 'fail',
        evidence: `failing: ${ci.failing.join(', ')}`,
      })

      toFix(
        pr,
        'CI is red',
        `Failing checks on ${entry.claimedSha}:\n- ${ci.failing.join('\n- ')}\n\nStart from \`gh run view <run-id> --log-failed\`.`,
      )

      return
    }

    // Green lets a run that is not required end skipped or neutral, so the evidence names each run's conclusion.
    gateCheck(pr, entry, {
      stage: 'preVerify',
      level: 'required',
      item: 'ci',
      result: 'pass',
      evidence: `required checks passed, runs: ${runsSeen(ci)}`,
    })

    const facts = await collectFacts(manifest, pr, entry, ledger, { reads })

    if (facts.pr?.state !== 'OPEN') {
      return
    }

    if (facts.pr?.headRefOid !== entry.claimedSha) {
      say(pr.id, 'claim-moved', { claimed: entry.claimedSha.slice(0, 7), head: facts.pr?.headRefOid?.slice(0, 7) })
      entry.claimedSha = facts.pr?.headRefOid ?? entry.claimedSha
      entry.claimedAt = now()
      claimStatus(entry, { kind: 'waiting', code: 'ci', sha: entry.claimedSha, missing: [], pending: [] })
      return
    }

    const violations = policyViolations(manifest, pr, facts)

    if (violations.length > 0) {
      gateCheck(pr, entry, { stage: 'preVerify', level: 'required', item: 'policy', result: 'fail', evidence: violations.join('; ') })
      toFix(pr, 'rollout policy', `The PR breaks rollout rules:\n- ${violations.join('\n- ')}`)
      return
    }

    gateCheck(pr, entry, { stage: 'preVerify', level: 'required', item: 'policy', result: 'pass', evidence: 'no violations' })
    noticeCodeScanning(pr, entry, facts)

    const scanning = codeScanningFindings(manifest, facts)

    if (scanning.action === 'fix') {
      gateCheck(pr, entry, {
        stage: 'preVerify',
        level: 'required',
        item: 'code-scanning',
        result: 'fail',
        evidence: scanning.reasons.join('; '),
      })

      toFix(pr, 'code scanning', codeScanningNote(manifest, scanning.reasons))
      return
    }

    if (scanning.action === 'block') {
      gateCheck(pr, entry, {
        stage: 'preVerify',
        level: 'required',
        item: 'code-scanning',
        result: 'fail',
        evidence: scanning.reasons.join('; '),
      })

      blockForCodeScanning(pr, entry, scanning.reasons)
      return
    }

    if (scanning.action === 'wait') {
      if (entry.notified.codeScanningWait !== entry.claimedSha) {
        entry.notified.codeScanningWait = entry.claimedSha
        say(pr.id, 'code-scanning-wait', { sha: entry.claimedSha.slice(0, 7), reasons: scanning.reasons })
      }

      claimStatus(entry, { kind: 'waiting', code: 'code-scanning-pending', sha: entry.claimedSha })
      return
    }

    const scanCheck = codeScanningCheck(facts)
    gateCheck(pr, entry, {
      stage: 'preVerify',
      level: 'required',
      item: 'code-scanning',
      result: scanCheck.result,
      evidence: scanCheck.evidence,
    })

    if (entry.patchSinceId !== facts.patchId) {
      entry.patchSinceId = facts.patchId
      entry.patchSince = now()
    }

    entry.claimPatchId = facts.patchId
    entry.outOfScope = outOfScope(manifest, pr, facts, entry.briefScope ?? [])
    entry.workflowFiles = facts.files.map((file) => file.path).filter((path) => path.startsWith('.github/'))

    if (manifest.gates.preVerify.scope && !scopeGatePasses(pr, entry)) {
      return
    }

    if (!slots() || stopping) {
      claimStatus(entry, SLOT)
      return
    }

    const aligned = await alignWorktree(manifest, pr, entry.claimedSha)

    localConfigRemoved(pr, aligned.removed)

    if (!aligned.ok) {
      toFix(pr, 'worktree not at the PR head', aligned.reason)
      return
    }

    const job = preVerifyJob(entry)

    if (job.steps.length > 0 && preVerifyPasses.get(pr.id) !== job.key) {
      launchPreVerify(pr, job)
      return
    }

    // Fixed at launch: the verifier's prompt and the judgment of its verdict read this list, never a reloaded manifest or catalog.
    entry.verifyCriteria = [...verifyCriteria(manifest.gates.verify), ...(await catalogCriteria(pr, facts))]
    launch(pr, 'verify', { sha: entry.claimedSha })
  }

  // Read at every launch, so a catalog change merged into the base applies to the next verifier. A missing or
  // invalid catalog throws, and guarded() records it on this PR.
  async function catalogCriteria(pr, facts) {
    if (!manifest.gates.verify.criteriaFrom) {
      return []
    }

    const entries = await gh.readCatalog(manifest)
    const files = facts.files.flatMap((file) => [file.path, file.previousPath].filter(Boolean))

    return selectCriteria(entries, { tags: pr.briefTags ?? [], files })
  }

  // The commands in the order they run, the ready ones first, captured at the
  // start, so a manifest reload never changes a running job. A pass holds for
  // the head and the lists of its key.
  function preVerifyJob(entry) {
    const { ready, preVerify } = manifest.gates
    const lists = [
      ['ready', 'required', ready.required],
      ['ready', 'recommended', ready.recommended],
      ['preVerify', 'required', preVerify.required],
      ['preVerify', 'recommended', preVerify.recommended],
    ]

    const steps = lists.flatMap(([stage, level, commands]) => commands.map((command) => ({ command, stage, level })))
    const key = JSON.stringify({ ready: [ready.required, ready.recommended], preVerify: [preVerify.required, preVerify.recommended] })

    return { sha: entry.claimedSha, steps, key: `${entry.claimedSha} ${key}` }
  }

  // The driver runs the commands itself, so a PR never changes the checks it
  // is judged by. The PR stays ready_claimed. Its `gate` entry in running
  // takes a slot, keeps advance and retry away and queues notes.
  function launchPreVerify(pr, job) {
    // Saved before any command runs: if the job is cut short, the ledger alone
    // tells the next advance, also after a restart, that what the commands
    // left is the driver's own and not the implementer's.
    ledger.prs[pr.id].preVerifyCleanup = job.sha
    claimStatus(ledger.prs[pr.id], { kind: 'running', code: 'commands', sha: job.sha })
    ledger.save()
    running.set(pr.id, 'gate')

    endJob(
      pr,
      runPreVerify(pr, job).then((outcome) => onPreVerifyDone(pr, job, outcome)),
      (error) => {
        const entry = ledger.prs[pr.id]

        say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) })
        entry.lastError = String(error?.message ?? error).slice(0, 1000)
        backOff(entry, {})
        transitions.commandsEnded(entry, now())
      },
    )
  }

  // Every command runs at the claimed head: one that leaves tracked changes
  // fails, and the worktree goes back to the head before the next one.
  async function runPreVerify(pr, { sha, steps }) {
    const cwd = worktreePath(manifest, pr)
    const results = []

    for (const step of steps) {
      // A stopped job leaves its cleanup to the next run: the driver exits
      // as soon as its children end.
      if (stopping) {
        return { stopped: true, results }
      }

      const run = await runCommand(manifest, pr, { command: step.command, cwd })

      if (run.stopped) {
        return { stopped: true, results }
      }

      const record = commandResult(step, run, await inspectWorktree(manifest, pr), sha)

      if (record.changes.length > 0) {
        localConfigRemoved(pr, await resetWorktree(manifest, pr, sha))
      }

      results.push(record)

      if (record.result === 'fail' && record.level === 'required') {
        break
      }
    }

    await cleanUpCommands(pr, sha)

    return { stopped: false, results }
  }

  // What the commands left is the driver's own, so it goes. Untracked files
  // would fail the next alignWorktree. Ignored output stays.
  async function cleanUpCommands(pr, sha) {
    const tree = await inspectWorktree(manifest, pr)

    if (!tree.clean || tree.head !== sha) {
      localConfigRemoved(pr, await resetWorktree(manifest, pr, sha))
    }

    ledger.prs[pr.id].preVerifyCleanup = null
  }

  // A job that a stop, a crash or an error cut short left its cleanup to the
  // next advance, which does it before an agent or a command uses the
  // worktree. A worktree that is gone, as after a merge, needs none.
  async function owedCleanup(pr, entry) {
    if (!existsSync(worktreePath(manifest, pr))) {
      entry.preVerifyCleanup = null
      return
    }

    await cleanUpCommands(pr, entry.preVerifyCleanup)
  }

  // A stop, a state change or a new head while the commands ran drops their results.
  async function onPreVerifyDone(pr, { sha, key }, outcome) {
    const entry = ledger.prs[pr.id]

    if (entry.state === 'merged') {
      await cleanup(pr)
      return
    }

    if (outcome.stopped || stopping || entry.state !== 'ready_claimed' || entry.claimedSha !== sha) {
      transitions.commandsEnded(entry, now())
      return
    }

    entry.preVerify = { sha, at: now(), results: outcome.results }

    for (const record of outcome.results) {
      gateCheck(pr, entry, {
        stage: record.stage,
        level: record.level,
        item: record.command,
        result: record.result,
        evidence: commandEvidence(record),
      })
    }

    const { failedRequired, reason } = preVerifyOutcome(outcome.results)

    if (failedRequired.length > 0) {
      toFix(pr, reason, preVerifyNote(sha, failedRequired, entry.ready))
      return
    }

    preVerifyPasses.set(pr.id, key)
    transitions.commandsEnded(entry, now())
  }

  function scopeGatePasses(pr, entry) {
    const undeclared = undeclaredOutOfScope(entry.outOfScope, entry.ready?.deviations ?? [])

    if (undeclared.length > 0) {
      gateCheck(pr, entry, {
        stage: 'preVerify',
        level: 'required',
        item: 'scope',
        result: 'fail',
        evidence: `undeclared: ${undeclared.join(', ')}`,
      })

      toFix(pr, 'out of scope', scopeNote(undeclared))
      return false
    }

    const declared = entry.outOfScope.join(', ')
    gateCheck(pr, entry, {
      stage: 'preVerify',
      level: 'required',
      item: 'scope',
      result: 'pass',
      evidence: declared ? `declared in deviations: ${declared}` : 'no files out of scope',
    })

    return true
  }

  // Each question gets one delegate run, and a PR at most policy.delegate.maxPerPr.
  function askDelegate(pr, entry) {
    const policy = manifest.policy.delegate

    if (!delegateAllowed(manifest, entry)) {
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

    if (slots()) {
      launchDelegate(pr)
    }
  }

  // A brief may be written while its dependencies, verified and not held, wait
  // to merge, unless these same heads did not merge cleanly in a preview before.
  function briefAhead(pr, entry) {
    const heads = gh.unmergedHeads(pr, ledger)

    return heads !== null && heads.length > 0 && headsKey(heads) !== entry.previewConflict
  }

  // The dependencies a PR waits for. Ones outside this run (--only) merge only on GitHub.
  function dependencyStatus(pr) {
    const active = new Set(manifest.prs.map((item) => item.id))
    const on = gh.depsPending(manifest, pr, ledger)
    const code = on.every((id) => !active.has(id)) ? 'outside-dependency' : 'dependencies'

    return { kind: 'waiting', code, on }
  }

  // What a pending PR waits for when nothing launches. The brief file decides its stage.
  function pendingStatus(pr, entry, depsReady) {
    if (existsSync(pr.brief)) {
      transitions.setStatus(entry, 'implement', depsReady ? SLOT : dependencyStatus(pr), now())
    } else {
      transitions.setStatus(entry, 'brief', briefWait(pr, entry, depsReady), now())
    }
  }

  // Heads that did not merge cleanly in a preview wait until they merge.
  function briefWait(pr, entry, depsReady) {
    const heads = gh.unmergedHeads(pr, ledger)

    if (heads?.length > 0 && headsKey(heads) === entry.previewConflict) {
      return { kind: 'waiting', code: 'dependencies-merge', heads }
    }

    return !depsReady && !briefAhead(pr, entry) ? dependencyStatus(pr) : SLOT
  }

  // What an interrupted run or an owed fix waits for when it does not launch.
  function idleStatus(pr, entry, depsReady) {
    const forDependencies = entry.stage === 'implement' && !entry.pr && !depsReady

    transitions.setStatus(entry, entry.stage, forDependencies ? dependencyStatus(pr) : SLOT, now())
  }

  async function advance(pr) {
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
      await owedCleanup(pr, entry)
    }

    // A run state with no run behind it (an onDone that threw) resumes.
    transitions.recoverRun(entry, { refund: false, at: now() })

    const depsReady = gh.depsPending(manifest, pr, ledger).length === 0

    switch (entry.state) {
      case 'pending':
        if (slots()) {
          if (existsSync(pr.brief)) {
            if (depsReady) {
              launch(pr, 'implement')
            }
          } else if (depsReady || briefAhead(pr, entry)) {
            launch(pr, 'brief')
          }
        }

        if (entry.state === 'pending' && !running.has(pr.id)) {
          pendingStatus(pr, entry, depsReady)
        }

        break

      case 'interrupted':
        // A parked READY report needs GitHub again, not a slot or an agent.
        if (entry.interruptedRole === 'report' && entry.ready) {
          transitions.setStatus(entry, 'pre-verify', { kind: 'waiting', code: 'github' }, now())
          await claimReport(pr, entry, entry.ready)
          break
        }

        if (!slots() || (!entry.pr && !depsReady)) {
          idleStatus(pr, entry, depsReady)
          break
        }

        if (entry.interruptedRole === 'verify' && entry.claimedSha) {
          transitions.verifyAgain(entry, now())
          await checkClaim(pr)
        } else if (entry.interruptedRole === 'implement' && !entry.sessionId) {
          launch(pr, 'implement')
        } else {
          launch(pr, 'fix', {
            reason: 'previous run ended without a report',
            note: `Your previous run stopped without a final report (${entry.lastError ?? 'unknown'}). Inspect the worktree and the PR, then continue where you stopped.`,
          })
        }

        break

      case 'needs_fix':
        if (slots() && (entry.pr || depsReady)) {
          launch(pr, 'fix', { reason: entry.fixReason, note: entry.fixNote })
        } else {
          idleStatus(pr, entry, depsReady)
        }

        break

      case 'ready_claimed':
        await checkClaim(pr)
        break

      case 'blocked':
        askDelegate(pr, entry)
        break

      default:
        break
    }
  }

  // The merge delay of a GitHub approval starts when the driver first sees
  // it, not at the review's own time. A review given while CI ran or the
  // verifier worked would otherwise merge with no window for rollout hold.
  function noticeGithubApproval(pr, entry, facts) {
    const author = facts.pr?.author

    if (facts.pr?.state !== 'OPEN' || approvalChannel(manifest, author) !== 'github') {
      return
    }

    const approval = githubApproval(manifest, entry, facts)

    // Cleared even on a held PR, so the next approval gets its own notice
    // and a full window.
    if (!approval.approved && entry.approved?.channel === 'github') {
      entry.approved = null
      return
    }

    if (entry.held || !approval.approved || entry.verified?.patchId !== facts.patchId) {
      return
    }

    if (entry.approved?.channel === 'github' && entry.approved.patchId === facts.patchId) {
      return
    }

    entry.approved = { patchId: facts.patchId, sha: facts.pr.headRefOid, at: now(), by: approval.by, channel: 'github' }
    say(
      pr.id,
      'approved',
      { sha: facts.pr.headRefOid.slice(0, 7), by: approval.by, channel: 'github' },
      `PR #${entry.pr} approved on GitHub by ${approval.by}; merging in ${manifest.policy.mergeDelaySeconds}s unless you hold it (rollout hold ${pr.id})`,
    )
  }

  // readyTaken: the PR number another candidate holds "ready" with this tick
  // (merge: manual). This one then waits for it, see mergeNext.
  async function mergeCandidate(pr, { readyTaken = null } = {}) {
    const entry = ledger.prs[pr.id]
    const facts = await collectFacts(manifest, pr, entry, ledger, { reads })
    noticeCodeScanning(pr, entry, facts)
    noticeGithubApproval(pr, entry, facts)

    const judged = judgeGate(manifest, pr, entry, facts)

    // sync moves a verified PR on only when its head moves, so one whose
    // patch id changed under the same head would wait for ever.
    if (judged.code === 'not-verified' && entry.state === 'verified') {
      reverify(pr, facts.pr.headRefOid, 'not-verified', 'the patch id the gate reads no longer matches the verification, verifying again')
      return false
    }

    const github = facts.pr?.mergeStateStatus ?? 'UNKNOWN'
    const githubNote =
      github === 'CLEAN' || github === 'HAS_HOOKS'
        ? 'GitHub: mergeable'
        : `GitHub: ${github}${github === 'BLOCKED' ? ' (a review, an open thread or a ruleset rule is still missing)' : ''}`

    const manualMerge = manifest.policy.merge === 'manual' && judged.action === 'merge'
    const queued = manualMerge && readyTaken !== null
    let verdict = judged

    if (queued) {
      verdict = {
        action: 'wait',
        code: 'queued',
        reasons: [`after PR #${readyTaken}: one PR is ready at a time, this one is checked again on the base that includes it`],
      }
    } else if (manualMerge) {
      verdict = { action: 'ready', code: 'ready', reasons: [`ready: merge it on GitHub (${githubNote})`] }
    }

    // The prose may change while the cause stays, as a check moving from
    // missing to running. That is not a new event.
    const changed = entry.gate?.action !== verdict.action || entry.gate?.code !== verdict.code
    entry.gate = { ...verdict, mergeState: github, sha: facts.pr?.headRefOid ?? null, at: now(), ...(queued ? { after: readyTaken } : {}) }
    transitions.gateVerdict(entry, entry.gate, facts, now())

    if (queued) {
      // Ready again later is a new notice, even on the same head.
      entry.notified.ready = null
    }

    if (changed) {
      say(pr.id, `gate-${verdict.action}`, { code: verdict.code, reasons: verdict.reasons })
    }

    if (verdict.action === 'wait') {
      const reason = verdict.reasons.join('; ')

      if (APPROVAL_NOTICE_CODES.includes(verdict.code) && entry.notified.approval !== facts.patchId) {
        entry.notified.approval = facts.patchId
        notify(`rollout ${manifest.rollout}`, `${pr.id}: PR #${entry.pr} is verified; ${reason}`)
      } else if (verdict.code === 'github-blocked' && entry.notified.githubBlocked !== facts.pr.headRefOid) {
        entry.notified.githubBlocked = facts.pr.headRefOid
        notify(
          `rollout ${manifest.rollout}`,
          `${pr.id}: PR #${entry.pr} passes the rollout gate, but GitHub's ruleset still blocks the merge`,
        )
      }

      return false
    }

    if (verdict.action === 'block' && verdict.code === 'code-scanning') {
      blockForCodeScanning(pr, entry, verdict.reasons)
      return false
    }

    if (verdict.action === 'block') {
      const blocked = { kind: 'gate', question: verdict.reasons.join('; '), evidence: '', run: null }

      transitions.toBlocked(entry, blocked, { at: now(), gate: verdict })
      say(pr.id, 'blocked', { reason: 'gate' }, `gate blocked: ${verdict.reasons.join('; ').slice(0, 120)}`)
      return false
    }

    if (verdict.action === 'fix') {
      entry.verified = null

      if (verdict.code === 'code-scanning') {
        toFix(pr, 'code scanning', codeScanningNote(manifest, verdict.reasons))
      } else {
        toFix(pr, 'merge gate', `The merge gate sent the PR back:\n- ${verdict.reasons.join('\n- ')}`, verdict.code)
      }

      return false
    }

    if (verdict.action === 'rebase') {
      const rebased = await rebaseWorktree(manifest, pr, facts.pr.headRefOid)

      if (rebased.ok) {
        transitions.setStatus(entry, 'merge', { kind: 'waiting', code: 'ci', sha: rebased.head, missing: [], pending: [] }, now())
        say(pr.id, 'rebased', { head: rebased.head.slice(0, 7) })
      } else {
        entry.verified = null
        toFix(
          pr,
          'rebase conflict',
          `\`${manifest.repo.base}\` moved and the branch no longer rebases cleanly.\nConflicting files: ${rebased.conflicts.join(', ') || '(see below)'}\n${rebased.reason.slice(0, 1500)}\n\nRebase onto origin/${manifest.repo.base}, resolve keeping both intents (read the merged PRs that touched these files), re-verify and push with --force-with-lease.`,
        )
      }

      return true
    }

    // Manual mode: everything the gate checks holds; the maintainer merges.
    if (verdict.action === 'ready') {
      if (entry.notified.ready !== `${facts.pr.headRefOid}:${github}`) {
        entry.notified.ready = `${facts.pr.headRefOid}:${github}`
        say(
          pr.id,
          'ready-to-merge',
          { pr: entry.pr, sha: facts.pr.headRefOid.slice(0, 7), github },
          `PR #${entry.pr} is ready: verified, CI green, up to date. ${githubNote}`,
        )
      }

      return false
    }

    // A short delay from the first time the driver saw the approval, so one
    // nobody expected can be noticed (both channels notify) and stopped with
    // rollout hold. No record for the current patch means no time has passed.
    const approvedAt = entry.approved?.patchId === facts.patchId ? entry.approved.at : now()
    const approvedFor = (Date.now() - Date.parse(approvedAt)) / 1000

    if (manifest.policy.merge === 'human' && approvedFor < manifest.policy.mergeDelaySeconds) {
      const until = new Date(Date.parse(approvedAt) + manifest.policy.mergeDelaySeconds * 1000).toISOString()

      transitions.setStatus(entry, 'merge', { kind: 'waiting', code: 'merge-delay', until }, now())
      return false
    }

    // The driver never merges in a dry run, so the merge is the maintainer's.
    if (manifest.dryRun) {
      transitions.setStatus(entry, 'merge', { kind: 'needs-you', code: 'merge-by-hand', mergeState: github }, now())

      if (entry.notified.wouldMerge !== facts.pr.headRefOid) {
        entry.notified.wouldMerge = facts.pr.headRefOid
        say(pr.id, 'would-merge', { pr: entry.pr, sha: facts.pr.headRefOid.slice(0, 7) }, `dry run: would merge PR #${entry.pr} now`)
      }

      return false
    }

    entry.gate.action = 'merge'
    transitions.setStatus(entry, 'merge', { kind: 'running', code: 'merge', sha: facts.pr.headRefOid }, now())
    ledger.save()

    let mergeSha

    try {
      mergeSha = await gh.merge(manifest, pr, entry, facts)
    } catch (error) {
      // GitHub refusing the merge is a state to wait in, not a failure.
      if (gh.mergeRefusal(error)) {
        entry.gate = {
          action: 'wait',
          code: 'merge-refused',
          reasons: ['GitHub refused the merge (ruleset)'],
          mergeState: github,
          sha: facts.pr.headRefOid,
          at: now(),
        }

        transitions.setStatus(entry, 'merge', { kind: 'needs-you', code: 'merge-refused', error: String(error).slice(0, 200) }, now())
        say(
          pr.id,
          'merge-refused',
          { error: String(error).slice(0, 200) },
          `GitHub refused to merge PR #${entry.pr}; check its ruleset requirements`,
        )

        return false
      }

      throw error
    }

    // Accepted, but GitHub shows no merge commit yet (a merge queue, a slow
    // read). The PR stays verified with gate.action merge, so the next sync
    // that sees it merged records it as the driver's merge and cleans up.
    if (!mergeSha) {
      say(pr.id, 'merge-unconfirmed', { pr: entry.pr, sha: facts.pr.headRefOid.slice(0, 7) })
      ledger.save()

      return true
    }

    transitions.toMerged(entry, { mergeSha })
    ledger.data.lastMerge = { id: pr.id, sha: mergeSha, at: now() }
    say(pr.id, 'merged', { pr: entry.pr, sha: mergeSha?.slice(0, 7) }, `merged PR #${entry.pr}`)
    ledger.save()
    await cleanup(pr)

    return true
  }

  async function mergeNext() {
    if (ledger.data.hold || stopping) {
      return
    }

    const candidates = manifest.prs
      .filter((pr) => ledger.prs[pr.id].state === 'verified' && !running.has(pr.id) && !ledger.prs[pr.id].feedbackWaiting)
      .sort((left, right) => right.priority - left.priority || left.order - right.order)

    // Under merge: manual one PR is ready at a time. Two PRs merged back to
    // back were each gated on a base without the other, and a conflict git
    // does not see (one changes a file the other copies or calls) would first
    // show on the base branch. The others still go through the gate (rebase,
    // fix) but wait. The PR already announced keeps the slot, as long as its
    // verification still holds (currentGate).
    const manual = manifest.policy.merge === 'manual'

    if (manual) {
      const holdsReady = (pr) => Number(currentGate(ledger.prs[pr.id])?.action === 'ready')

      candidates.sort((left, right) => holdsReady(right) - holdsReady(left))
    }

    let readyTaken = null

    for (const pr of candidates) {
      const acted = await guarded(pr, () => mergeCandidate(pr, { readyTaken }))

      if (acted) {
        return
      }

      if (manual && readyTaken === null && ledger.prs[pr.id].gate?.action === 'ready') {
        readyTaken = ledger.prs[pr.id].pr
      }
    }
  }

  // The gate holds merges, rebases and fixes on a red base, so the watch only
  // tells the maintainer, once per merge. Any stored checked, a legacy
  // 'acknowledged' too, means this merge was handled.
  async function watchBase() {
    const last = ledger.data.lastMerge

    if (!last?.sha || last.checked) {
      return
    }

    // The merge commit's own runs, never a quiet ancestor's: only they say
    // whether this merge broke the base. With none yet, the next tick looks again.
    const checks = await gh.checksFor(manifest, last.sha, { reads })

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

  // One PR's persistent error must not freeze the others: errors are counted
  // per PR and escalate that PR alone. A PR counts one error per tick, and
  // tick() resets the count after a tick without one. An outage is no error
  // of the PR, so a tick with only outages neither counts nor resets it.
  async function guarded(pr, task) {
    const entry = ledger.prs[pr.id]

    try {
      return await task()
    } catch (error) {
      if (unavailable(pr.id, error)) {
        unavailableThisTick.add(pr.id)

        return false
      }

      if (!erredThisTick.has(pr.id)) {
        erredThisTick.add(pr.id)
        entry.tickErrors = (entry.tickErrors ?? 0) + 1
      }

      entry.lastError = String(error?.message ?? error).slice(0, 1000)
      say(pr.id, 'error', { error: entry.lastError.slice(0, 300), count: entry.tickErrors })

      // sync still runs for an escalated PR. If it keeps failing, that must
      // not escalate and notify again on every tick.
      if (entry.tickErrors >= MAX_TICK_ERRORS && !running.has(pr.id) && entry.state !== 'escalated') {
        transitions.escalateErrors(entry, { at: now(), run: lastEndedRun(pr.id) })
        say(pr.id, 'escalated', { reason: 'repeated errors' }, `repeated errors, needs you: ${entry.lastError.slice(0, 100)}`)
      }

      return false
    }
  }

  // Fetch, outside dependencies and the base watch belong to no PR. A
  // failure is logged and tried again on the next tick, and the fifth in a
  // row notifies. An outage is no failure of the step and leaves its count
  // as it was.
  async function driverStep(step, task) {
    try {
      await task()
      stepFailures.set(step, 0)

      return true
    } catch (error) {
      if (unavailable(step, error)) {
        return false
      }

      const kind = `${step}-failed`
      const count = (stepFailures.get(step) ?? 0) + 1
      const message = String(error?.message ?? error)
      const notice = count === MAX_TICK_ERRORS ? `${kind} ${count} ticks in a row: ${message.slice(0, 100)}` : null
      stepFailures.set(step, count)
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
  function unavailable(source, error) {
    const afterSleep = wokeAt !== null && clock() - wokeAt < AFTER_SLEEP_MS

    if (!gh.githubUnavailable(error, { afterSleep })) {
      return false
    }

    ledger.data.githubUnavailable = ledger.data.githubUnavailable ?? { since: now(), notified: false }

    if (outageThisTick) {
      return true
    }

    outageThisTick = true

    const outage = ledger.data.githubUnavailable
    const message = String(error?.message ?? error)
    const minutes = Math.floor(minutesSince(outage.since))
    let notice = null

    if (minutes >= UNAVAILABLE_NOTICE_MINUTES && !outage.notified) {
      outage.notified = true
      notice = `GitHub has been unreachable for ${minutes} minutes. The driver keeps trying every tick. Last error: ${gh.ghError(error).slice(0, 100)}`
    }

    say('-', 'github-unavailable', { source, error: message.slice(0, 300), minutes }, notice)

    return true
  }

  function githubBack() {
    const outage = ledger.data.githubUnavailable
    const minutes = Math.floor(minutesSince(outage.since))
    const notice = outage.notified ? `GitHub answers again after ${minutes} minutes` : null

    ledger.data.githubUnavailable = null
    say('-', 'github-back', { minutes }, notice)
  }

  async function start() {
    for (const pr of manifest.all) {
      const role = transitions.recoverRun(ledger.prs[pr.id], { refund: true, at: now() })

      if (role) {
        say(pr.id, 'recovered-interrupted', { role })
      }
    }

    await gh.fetchOrigin(manifest)
    await gh.ensureLabel(manifest)

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
      pid: process.pid,
      ...runtimeSummary(manifest),
    })
  }

  // Measured from the end of the last tick, a long tick never reads as sleep.
  function noticeSleep() {
    if (lastTickEnd === null) {
      return
    }

    const slept = sleptMs(clock() - lastTickEnd, manifest.policy.tickSeconds * 1000)

    if (slept > 0) {
      wokeAt = clock()
      say('-', 'machine-slept', { minutes: Math.round(slept / 60_000) })
    }
  }

  // The PR's labels follow its ledger state. sync reads what the PR carries,
  // so a quiet tick makes no extra GitHub call. Labels only inform people:
  // a failure is kept on the PR's row and retried next tick, never counted
  // as the PR's error or allowed to stop the tick.
  async function syncStageLabels(pr) {
    const entry = ledger.prs[pr.id]
    const wanted = stageLabels(entry)
    const changes = labelChanges(entry.stageLabels ?? [], wanted)

    if (!entry.pr || (changes.add.length === 0 && changes.remove.length === 0)) {
      return
    }

    try {
      await gh.setStageLabels(manifest, entry.pr, changes)
      entry.stageLabels = wanted
      entry.stageLabelError = null
    } catch (error) {
      entry.stageLabelError = String(error?.message ?? error).slice(0, 300)
    }
  }

  // At the end of a tick only: a status a step passes through leaves no
  // event, and one that a job's end or start wrote waits for the next tick.
  function logStatusChanges() {
    for (const pr of manifest.all) {
      const entry = ledger.prs[pr.id]
      const key = statusKey(entry)

      if (loggedStatus.get(pr.id) !== key) {
        loggedStatus.set(pr.id, key)
        say(pr.id, 'status', statusDetail(entry))
      }
    }
  }

  // The heartbeat carries the numbers of every tick. A slow one is logged too,
  // at most once in ten minutes, so a slow GitHub does not flood the events.
  function measureTick(startedAt) {
    const { requests, cached, remaining } = gh.clientFor(manifest).stats()
    const ms = Math.round(lastTickEnd - startedAt)

    ledger.beat(tickNote({ ms, requests, cached, remaining }))

    const slow = ms > manifest.policy.tickSeconds * 1000
    const saidLately = slowSaidAt !== null && lastTickEnd - slowSaidAt < SLOW_TICK_QUIET_MS

    if (!slow || saidLately) {
      return
    }

    slowSaidAt = lastTickEnd
    say('-', 'tick-slow', { ms, requests, cached, remaining })
  }

  async function tick() {
    const startedAt = clock()

    ledger.beat()
    // On every tick, never once: setFetch replaces the client.
    gh.clientFor(manifest).resetStats()
    erredThisTick.clear()
    reads = gh.tickReads()
    unavailableThisTick.clear()
    outageThisTick = false

    try {
      noticeSleep()
      reloadManifest()
      applyCommands()
      const fetched = await driverStep('fetch', () => gh.fetchOrigin(manifest))
      await driverStep('outside-deps', () => gh.refreshOutsideDeps(manifest, ledger))
      await driverStep('watch-base', () => watchBase())

      for (const pr of manifest.prs) {
        await guarded(pr, () => sync(pr))
        await guarded(pr, () => handleFeedback(pr))
      }

      // The gate runs before slots are handed out: a conflict it finds on a
      // high-priority PR then competes for a slot in this same tick, ahead
      // of new briefs for lower-priority PRs. A stale base would mislead the
      // gate and the rebase, so a tick without a fetch merges nothing.
      if (fetched) {
        await mergeNext()
      }

      if (!ledger.data.hold && !stopping) {
        const order = [...manifest.prs].sort((left, right) => right.priority - left.priority || left.order - right.order)

        for (const pr of order) {
          await guarded(pr, () => advance(pr))
        }
      } else if (ledger.data.hold) {
        // The rollout's hold shows over a PR's own.
        for (const pr of manifest.prs) {
          transitions.heldStatus(ledger.prs[pr.id], 'rollout', now())
        }
      }

      // During an outage every label call would wait for its timeout.
      if (!outageThisTick) {
        for (const pr of manifest.prs) {
          await syncStageLabels(pr)
        }
      }

      // Here and not in finally: a tick that threw may have skipped a PR's
      // steps, or never reached GitHub.
      for (const pr of manifest.prs) {
        if (!erredThisTick.has(pr.id) && !unavailableThisTick.has(pr.id)) {
          ledger.prs[pr.id].tickErrors = 0
        }
      }

      if (!outageThisTick && ledger.data.githubUnavailable) {
        githubBack()
      }

      for (const pr of manifest.prs) {
        if (!ledger.prs[pr.id].held && !ledger.data.hold) {
          transitions.unheld(ledger.prs[pr.id], now())
        }
      }

      logStatusChanges()
    } finally {
      reads = null
      lastTickEnd = clock()
      ledger.save()
      measureTick(startedAt)
    }
  }

  // Never rejects, so the run loop outlives any tick. The fifth failed tick
  // in a row notifies. The disk may be what failed, so the notice goes out
  // before the writes, and a failed write is only reported.
  async function runTick() {
    try {
      await tick()
      failedTicks = 0
    } catch (error) {
      failedTicks += 1

      const message = String(error?.message ?? error)
      console.error(`tick error: ${message}`)

      if (failedTicks === MAX_TICK_ERRORS) {
        notify(`rollout ${manifest.rollout}`, `${failedTicks} ticks in a row failed: ${message.slice(0, 100)}`)
      }

      try {
        ledger.event('-', 'tick-error', { error: String(error?.stack ?? error).slice(0, 2000), count: failedTicks })
        ledger.beat(`tick-error ${message.slice(0, 200)}`)
      } catch (writeError) {
        console.error(`tick error not logged: ${writeError?.message ?? writeError}`)
      }
    }
  }

  function finished() {
    return running.size === 0 && manifest.prs.every((pr) => ledger.prs[pr.id].state === 'merged')
  }

  async function finish() {
    const release = await gh.findReleasePr(manifest).catch(() => null)
    const cost = manifest.prs.reduce((sum, pr) => sum + ledger.prs[pr.id].costUsd, 0)
    const text = release
      ? `All PRs merged. Release PR #${release.number} is open: review it and merge it yourself to publish.`
      : 'All PRs merged. No release PR is open yet (the release workflow may still be running).'

    say('-', 'finished', { cost: Number(cost.toFixed(2)), release: release?.url ?? null }, text)
  }

  async function stop() {
    stopping = true
    stopAllAgents()

    for (let waited = 0; children.size > 0 && waited < 15; waited += 1) {
      await sleep(1000)
    }

    ledger.save()
  }

  return {
    ledger,
    running,
    start,
    tick,
    runTick,
    applyCommands,
    launch,
    onDone,
    onBriefDone,
    onDelegateDone,
    advance,
    mergeCandidate,
    mergeNext,
    finished,
    finish,
    stop,
    isStopping: () => stopping,
  }
}

export async function runDriver(manifest) {
  const release = acquireLock(manifest)
  const driver = createDriver(manifest)
  let signals = 0

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, async () => {
      signals += 1

      if (signals > 1) {
        release()
        process.exit(130)
      }

      console.log(`${signal}: stopping agents; the next run resumes them`)
      await driver.stop()
      release()
      process.exit(130)
    })
  }

  process.on('exit', release)

  await driver.start()
  const inbox = watchInbox(manifest)

  for (;;) {
    await driver.runTick()

    if (driver.isStopping()) {
      inbox.close()
      return
    }

    if (driver.finished()) {
      await driver.finish()
      release()
      inbox.close()
      return
    }

    await inbox.wait(manifest.policy.tickSeconds * 1000)
  }
}
