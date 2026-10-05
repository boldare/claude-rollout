import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadManifest, raiseEffort } from './manifest.mjs'
import { acquireLock, drainInbox, freshPr, openLedger, recordVerdict, reserveRunName, watchInbox } from './ledger.mjs'
import {
  approvalChannel,
  approveRefusal,
  codeScanningFindings,
  currentGate,
  githubApproval,
  judge,
  outOfScope,
  policyViolations,
} from './judge.mjs'
import {
  briefReviewPrompt,
  briefWritePrompt,
  codeScanningNote,
  delegatePrompt,
  fixPrompt,
  implementPrompt,
  resumeFreshPrompt,
  verifyPrompt,
} from './prompts.mjs'
import { children, runAgent as spawnAgent, stopAllAgents } from './spawn.mjs'
import { notify as desktopNotify, sentences } from './notify.mjs'
import {
  alignWorktree,
  enableWorktreeConfig,
  inspectWorktree,
  prepareWorktree,
  rebaseWorktree,
  removeWorktree,
  resetWorktree,
  worktreePath,
} from './worktree.mjs'
import * as gh from './github.mjs'
import { sleptMs } from './machine.mjs'
import { labelChanges, ourLabel, stageLabels } from './stage.mjs'

// PR states:
//   pending → implementing → ready_claimed → verifying → verified → merged
//   needs_fix → fixing → ready_claimed      (CI red, policy, verifier, gate, conflict)
//   interrupted → fixing | verifying        (a run ended without a report)
//   blocked, escalated                      (waiting for a human: /rollout note|retry)
//   pending → briefing → pending             (no brief yet: writer + reviewer agents)
//   held is a flag on any state: no runs, rebases, ready notices or merges until release
const RUNNING = { implementing: 'implement', fixing: 'fix', verifying: 'verify', briefing: 'brief' }
const MAX_TICK_ERRORS = 5
const MAX_REFUNDS = 5
const UNAVAILABLE_NOTICE_MINUTES = 30
const AFTER_SLEEP_MS = 2 * 60_000
const PR_COMMANDS = ['approve', 'note', 'retry', 'hold', 'release']
const ROLLOUT_COMMANDS = ['pause', 'resume', 'unhalt']

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

// The detail of every *-done event. `run` pairs it with its *-start.
export function doneDetail(role, run, result) {
  return {
    run,
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

// One question of a blocked PR, so the delegate is asked about it only once.
function questionHash(blocked) {
  return createHash('sha256')
    .update(`${blocked.kind}\n${blocked.question ?? ''}`)
    .digest('hex')
    .slice(0, 16)
}

async function removePr(manifest, pr) {
  await removeWorktree(manifest, pr).catch(() => {})
  await gh.deleteRemoteBranch(manifest, pr.branch).catch(() => {})
}

export function createDriver(
  manifest,
  {
    cleanup = (pr) => removePr(manifest, pr),
    notify = desktopNotify,
    collectFacts = gh.collectFacts,
    runAgent = spawnAgent,
    clock = Date.now,
  } = {},
) {
  const ledger = openLedger(manifest)
  const running = new Map()
  const stepFailures = new Map()
  const erredThisTick = new Set()
  // Base tips the gate read this tick, shared by every PR it looks at.
  const baseReads = new Map()
  const unavailableThisTick = new Set()
  let outageThisTick = false
  let lastTickEnd = null
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
        ledger.prs[pr.id] = ledger.prs[pr.id] ?? freshPr()
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

  function slots() {
    return running.size < manifest.policy.concurrency
  }

  // A PR sent to a fix run is no longer verified, so a retry can never send
  // the unchanged patch back to the gate and drop the fix it was sent for.
  function toFix(pr, reason, note) {
    const entry = ledger.prs[pr.id]
    entry.state = 'needs_fix'
    entry.fixReason = reason
    entry.fixNote = note
    entry.verified = null
    say(pr.id, 'needs-fix', { reason })
  }

  function queueNote(id, text) {
    const entry = ledger.prs[id]
    entry.pendingNote = [entry.pendingNote, text].filter(Boolean).join('\n\n')
  }

  function answerBrief(pr, question, text) {
    const entry = ledger.prs[pr.id]
    entry.briefAnswers = [...(entry.briefAnswers ?? []), { question, answer: text }]
    entry.attempts.brief = Math.max(0, entry.attempts.brief - 1)
    entry.state = 'pending'
    entry.blocked = null
    say(pr.id, 'brief-answered')
  }

  // Commands from /rollout: approve, note, retry, hold, release, pause, resume, unhalt.
  // Each applies on its own, so a bad one never drops the rest of the batch.
  function applyCommands() {
    for (const command of drainInbox(manifest)) {
      applyCommand(command)
    }
  }

  function applyCommand(command) {
    const refusal = commandRefusal(command)

    if (refusal) {
      say('-', 'command-rejected', refusal)
      return
    }

    const forPr = PR_COMMANDS.includes(command.cmd)
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

    // These ignore any id, because a lost pause is worse than a stray id.
    if (ROLLOUT_COMMANDS.includes(cmd)) {
      return null
    }

    if (!PR_COMMANDS.includes(cmd)) {
      return { command: cmd, reason: 'unknown command' }
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
        resumeAfterRetry(entry)
        say(command.id, 'retry', { state: entry.state })
        break

      case 'hold':
        if (entry.state === 'merged') {
          say(command.id, 'command-rejected', { command: 'hold', reason: 'already merged' })
        } else if (entry.held) {
          say(command.id, 'command-rejected', { command: 'hold', reason: 'already held' })
        } else {
          entry.held = { at: now() }
          say(command.id, 'held', { state: entry.state, running: running.get(command.id) ?? null })
        }

        break

      case 'release':
        if (entry.held) {
          entry.held = null
          say(command.id, 'released', { state: entry.state })
        } else {
          say(command.id, 'command-rejected', { command: 'release', reason: 'not held' })
        }

        break

      case 'pause':
        ledger.data.paused = true
        say('-', 'paused')
        break

      case 'resume':
        ledger.data.paused = false
        say('-', 'resumed')
        break

      case 'unhalt':
        ledger.data.halted = null

        if (ledger.data.lastMerge) {
          ledger.data.lastMerge.checked = 'acknowledged'
        }

        say('-', 'unhalted')
        break
    }
  }

  // Where a retried PR picks up. A verification that still holds goes back
  // to the gate: sync compares the head with GitHub's first, and the gate
  // refuses a stale patch anyway. One for an older head is checked again
  // from the claim. A parked READY report needs no agent.
  function resumeAfterRetry(entry) {
    if (entry.pr && entry.verified && entry.verified.sha === entry.claimedSha) {
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

  // A maintainer's note and a delegate's answer reach the agent the same way.
  // A delegate run is no agent at work here: when its answer applies,
  // `running` still holds it.
  function applyNote(pr, entry, text, by) {
    const id = pr.id
    const agentAtWork = running.has(id) && running.get(id) !== 'delegate'

    if (entry.state !== 'merged') {
      const blocked = entry.state === 'blocked' ? entry.blocked : null
      const note = { at: now(), by, kind: blocked?.kind ?? null, question: blocked?.question ?? null, text }
      entry.noteHistory = [...(entry.noteHistory ?? []), note].slice(-20)
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
    } else {
      entry.attempts.fix = Math.min(entry.attempts.fix, manifest.policy.attempts.fix - 1)
      toFix(pr, `answer from the ${by}`, text)
    }
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
      `approved PR #${entry.pr}; merging in ${manifest.policy.mergeDelaySeconds}s unless you pause`,
    )
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
      entry.state = 'pending'
      say(pr.id, 'brief-missing', { role })
      return
    }

    if (entry.attempts[role] >= manifest.policy.attempts[role]) {
      entry.state = 'escalated'
      entry.escalation = `${role} attempts exhausted`
      entry.lastError = `${role} attempts exhausted (${manifest.policy.attempts[role]})`
      say(pr.id, 'escalated', { role }, `${role} attempts exhausted, needs you (rollout retry or note)`)
      return
    }

    entry.attempts[role] += 1

    let prompt
    let effort
    let resume = false
    let sessionId

    if (role === 'implement') {
      sessionId = randomUUID()
      entry.sessionId = sessionId
      effort = raiseEffort(pr.effort.implement, entry.attempts.implement - 1)
      prompt = implementPrompt(manifest, pr, entry)

      if (entry.pendingNote) {
        prompt += `\n\n## Note from the maintainer\n\n${entry.pendingNote}\n`
        entry.pendingNote = null
      }
    } else if (role === 'fix') {
      const text = [note, entry.pendingNote].filter(Boolean).join('\n\n')
      effort = raiseEffort(pr.effort.implement, Math.max(0, entry.attempts.fix - 2))

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
      prompt = verifyPrompt(manifest, pr, entry, sha)
    }

    entry.state = { implement: 'implementing', fix: 'fixing', verify: 'verifying' }[role]
    const total = entry.attempts.implement + entry.attempts.fix + entry.attempts.verify
    const logName = `${pr.id}-${String(total).padStart(2, '0')}-${role}`
    const run = reserveRunName(manifest, logName)
    say(pr.id, `${role}-start`, { run, log: `logs/${run}.jsonl`, effort, resume, reason })

    const job = (async () => {
      const cwd = role === 'verify' ? worktreePath(manifest, pr) : await prepareWorktree(manifest, pr)

      return runAgent(manifest, pr, { role, prompt, effort, sessionId, resume, cwd, logName: run })
    })().catch((error) => ({ ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }))

    running.set(pr.id, role)
    job
      .then((result) => onDone(pr, role, result, { sha, run }))
      .catch((error) => {
        say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) })

        if (RUNNING[ledger.prs[pr.id].state]) {
          ledger.prs[pr.id].state = 'interrupted'
          ledger.prs[pr.id].interruptedRole = role
          ledger.prs[pr.id].lastError = String(error)
        }
      })
      .finally(() => {
        running.delete(pr.id)
        ledger.save()
      })
  }

  // Two read-only agents on a worktree of the current base: a writer drafts
  // the brief from the plan and design notes, a reviewer checks every claim
  // against the code and returns the final text. The driver writes the file.
  function launchBrief(pr) {
    const entry = ledger.prs[pr.id]

    if (entry.attempts.brief >= manifest.policy.attempts.brief) {
      entry.state = 'escalated'
      entry.escalation = 'brief attempts exhausted'
      entry.lastError = `brief attempts exhausted (${manifest.policy.attempts.brief})`
      say(pr.id, 'escalated', { role: 'brief' }, 'could not write a brief, needs you (rollout retry or write briefs/' + pr.id + '.md)')
      return
    }

    entry.attempts.brief += 1
    entry.state = 'briefing'

    if (entry.pendingNote) {
      entry.briefAnswers = [...(entry.briefAnswers ?? []), { question: null, answer: entry.pendingNote }]
      entry.pendingNote = null
    }

    const effort = pr.effort.brief
    const base = `${pr.id}-${String(entry.attempts.brief).padStart(2, '0')}-brief`

    function startStep(step) {
      const run = reserveRunName(manifest, `${base}-${step}`)
      say(pr.id, 'brief-start', { run, log: `logs/${run}.jsonl`, step, effort })

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

      say(pr.id, 'brief-done', { ...doneDetail('brief', run, result), step })

      return result
    }

    const writeRun = startStep('write')

    const job = (async () => {
      let cwd
      const writer = await finishStep('write', writeRun, async () => {
        cwd = await prepareWorktree(manifest, pr)

        return runAgent(manifest, pr, {
          role: 'brief',
          prompt: briefWritePrompt(manifest, pr, entry),
          effort,
          sessionId: randomUUID(),
          cwd,
          logName: writeRun,
        })
      })

      if (!writer.ok) {
        return writer
      }

      const prompt = briefReviewPrompt(manifest, pr, entry, writer.output.brief)
      const reviewRun = startStep('review')
      const reviewer = await finishStep('review', reviewRun, () =>
        runAgent(manifest, pr, { role: 'brief', prompt, effort, sessionId: randomUUID(), cwd, logName: reviewRun }),
      )

      return {
        ...reviewer,
        costUsd: (writer.costUsd ?? 0) + (reviewer.costUsd ?? 0),
        seconds: (writer.seconds ?? 0) + (reviewer.seconds ?? 0),
        awakeSeconds: (writer.awakeSeconds ?? 0) + (reviewer.awakeSeconds ?? 0),
      }
    })().catch((error) => ({ ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }))

    running.set(pr.id, 'brief')
    job
      .then((result) => onBriefDone(pr, result))
      .catch((error) => {
        say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) })
        ledger.prs[pr.id].state = 'pending'
      })
      .finally(() => {
        running.delete(pr.id)
        ledger.save()
      })
  }

  function onBriefDone(pr, result) {
    const entry = ledger.prs[pr.id]
    entry.costUsd = Number((entry.costUsd + (result.costUsd ?? 0)).toFixed(4))

    if (!result.ok) {
      failed(pr, 'brief', result)
      entry.state = 'pending'
      return
    }

    const out = result.output

    if (out.questions.length > 0) {
      entry.state = 'blocked'
      entry.blocked = { kind: 'brief-questions', question: out.questions.join('\n'), evidence: out.notes }
      say(
        pr.id,
        'blocked',
        { reason: 'brief-questions' },
        delegateTakes(entry)
          ? null
          : `the brief needs your decision: ${out.questions[0].slice(0, 100)} (rollout card ${pr.id}, then rollout note ${pr.id} "...")`,
      )

      return
    }

    mkdirSync(dirname(pr.brief), { recursive: true })
    writeFileSync(pr.brief, `${out.brief.trim()}\n`)
    writeFileSync(pr.brief.replace(/\.md$/, '.review-notes.md'), `${out.notes.trim()}\n`)
    entry.briefScope = out.expectedFiles
    entry.briefAt = now()
    entry.briefAnswers = []
    entry.failStreak = 0
    entry.state = 'pending'
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

    entry.delegate.runs += 1

    const run = reserveRunName(manifest, `${pr.id}-${String(entry.delegate.runs).padStart(2, '0')}-delegate`)
    // `blocked` and not `kind`, which would overwrite the event's own kind.
    say(pr.id, 'delegate-start', { run, log: `logs/${run}.jsonl`, effort, blocked: blocked.kind })

    // The prompt is built in the job, so a missing briefing source fails this run instead of throwing in advance.
    const job = (async () => {
      const path = worktreePath(manifest, pr)
      const cwd = existsSync(path) ? path : await prepareWorktree(manifest, pr)
      const prompt = delegatePrompt(manifest, pr, entry)

      return runAgent(manifest, pr, { role: 'delegate', prompt, effort, sessionId: randomUUID(), resume: false, cwd, logName: run })
    })().catch((error) => ({ ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }))

    running.set(pr.id, 'delegate')
    job
      .then((result) => onDelegateDone(pr, result, { run, question, blocked }))
      .catch((error) => say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) }))
      .finally(() => {
        running.delete(pr.id)
        ledger.save()
      })
  }

  async function onDelegateDone(pr, result, { run, question, blocked }) {
    const entry = ledger.prs[pr.id]
    entry.costUsd = Number((entry.costUsd + (result.costUsd ?? 0)).toFixed(4))
    say(pr.id, 'delegate-done', doneDetail('delegate', run, result))

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

    entry.state = 'interrupted'
    entry.interruptedRole = role
  }

  function backOff(entry, result) {
    if (result.account) {
      ledger.data.paused = true
      say('-', 'paused', { reason: result.error?.slice(0, 200) }, 'account limit reached; rollout paused (rollout resume)')
    }

    if (!result.stopped) {
      entry.failStreak = (entry.failStreak ?? 0) + 1
      entry.retryAfter = new Date(Date.now() + Math.min(2 ** entry.failStreak, 30) * 60_000).toISOString()
    }
  }

  async function onDone(pr, role, result, { sha, run }) {
    const entry = ledger.prs[pr.id]
    entry.costUsd = Number((entry.costUsd + (result.costUsd ?? 0)).toFixed(4))
    say(pr.id, `${role}-done`, doneDetail(role, run, result))

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
      entry.state = 'blocked'
      entry.blocked = out.blocked ?? { kind: 'unknown', question: out.summary, evidence: '' }
      say(
        pr.id,
        'blocked',
        { reason: entry.blocked.kind },
        delegateTakes(entry) ? null : `blocked (${entry.blocked.kind}): ${entry.blocked.question.slice(0, 120)}`,
      )

      return
    }

    // A GitHub outage is no fault of the report, and a fix run would spend
    // an attempt on it. The report waits in entry.ready for a later tick.
    try {
      await claimReport(pr, entry, out)
    } catch (error) {
      entry.state = 'interrupted'
      entry.interruptedRole = 'report'
      entry.lastError = String(error?.message ?? error).slice(0, 1000)
      say(pr.id, 'report-unchecked', { error: entry.lastError.slice(0, 300) })
    }
  }

  // Claimed or sent to a fix, the report is used up. entry.ready keeps the last
  // report of every PR, so a stale 'report' role would claim it again.
  async function claimReport(pr, entry, out) {
    const problem = await checkReport(pr, out)
    entry.interruptedRole = null

    if (problem) {
      toFix(pr, 'report does not match GitHub', problem)
      return
    }

    entry.pr = out.pr
    entry.claimedSha = out.headSha
    entry.claimedAt = now()
    entry.ciPendingSince = null
    entry.verified = null
    entry.state = 'ready_claimed'
    say(pr.id, 'ready-claimed', { pr: out.pr, sha: out.headSha.slice(0, 7) })
    await answerFeedback(pr, entry, out)

    if (entry.pendingNote) {
      toFix(pr, 'answer from the maintainer', '')
    }
  }

  // The READY report's PR number is the model's claim: it must name an open
  // PR from this branch into the base. Only gh saying it knows no such PR
  // makes the report wrong. Any other error is thrown, a 404 included: a
  // token that lost access to a private repo gets one too.
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
      if (!/Could not resolve to a PullRequest|no pull requests? found/i.test(String(error))) {
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
      await resetWorktree(manifest, pr, sha)
    }

    recordVerdict(entry, { ...out, at: now(), run })

    // A FAIL is honoured even from a verifier that touched the tree: trusting
    // it cannot cause a merge. A PASS must come from an untouched tree.
    if (out.verdict === 'FAIL') {
      const leftovers = touched ? `\n\nThe verifier left this in the worktree (it has been reset):\n${tree.status.slice(0, 800)}` : ''
      const failedItems = out.checklist
        .filter((item) => item.status !== 'pass')
        .map((item) => `- ${item.item}: ${item.status}: ${item.evidence}`)
        .join('\n')

      toFix(
        pr,
        'verifier findings',
        `An independent verifier rejected the PR. Blocking findings:\n- ${out.blocking.join('\n- ')}\n\nFailed checklist items:\n${failedItems}${leftovers}`,
      )

      return
    }

    if (touched) {
      entry.state = 'ready_claimed'
      say(
        pr.id,
        'verifier-touched-tree',
        { head: tree.head.slice(0, 7), status: tree.status.slice(0, 200) },
        'the verifier changed the worktree; PASS discarded, verifying again',
      )

      return
    }

    if (out.sha !== sha || sha !== entry.claimedSha) {
      entry.state = 'ready_claimed'
      say(pr.id, 'verify-stale', { verified: out.sha, claimed: entry.claimedSha })
      return
    }

    entry.verified = { sha, patchId: entry.claimPatchId, at: now() }
    entry.attempts.verify = 0
    entry.state = 'verified'

    say(pr.id, 'verified', { sha: sha.slice(0, 7) }, `verified PR #${entry.pr}: ${nextStep(pr, entry)}`)

    if (entry.pendingNote) {
      entry.verified = null
      toFix(pr, 'answer from the maintainer', '')
    }
  }

  // GitHub wins: merges, closes and moved heads made outside the driver.
  async function sync(pr) {
    const entry = ledger.prs[pr.id]

    if (!entry.pr || entry.state === 'merged') {
      return
    }

    const githubPr = await gh.viewPr(manifest, entry.pr)
    entry.author = githubPr.author
    // What the PR really carries: a label removed or added by hand is put
    // right on the next label sync.
    entry.stageLabels = githubPr.labels.filter(ourLabel)

    if (githubPr.state === 'MERGED') {
      const wasOurs = entry.state === 'verified' && entry.gate?.action === 'merge'
      entry.state = 'merged'

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
        entry.state = 'blocked'
        entry.blocked = {
          kind: 'closed',
          question: `PR #${entry.pr} was closed outside the driver. Reopen it and run rollout retry, or drop it from the manifest.`,
          evidence: '',
        }

        say(pr.id, 'blocked', { reason: 'closed' }, `PR #${entry.pr} was closed`)
      }

      return
    }

    if (entry.state === 'verified' && githubPr.headRefOid !== entry.verified.sha) {
      const facts = await collectFacts(manifest, pr, entry, ledger, { baseReads })

      if (facts.pr?.headRefOid === githubPr.headRefOid && facts.patchId === entry.verified.patchId) {
        entry.verified.sha = githubPr.headRefOid
        entry.claimedSha = githubPr.headRefOid

        if (entry.approved?.patchId === facts.patchId) {
          entry.approved.sha = githubPr.headRefOid
        }

        await alignWorktree(manifest, pr, githubPr.headRefOid).catch(() => {})
        say(pr.id, 'head-moved-same-patch', { sha: githubPr.headRefOid.slice(0, 7) })
      } else {
        entry.verified = null
        entry.state = 'ready_claimed'
        entry.claimedSha = githubPr.headRefOid
        entry.claimedAt = now()
        entry.ciPendingSince = null
        say(pr.id, 'head-moved-reverify', { sha: githubPr.headRefOid.slice(0, 7) }, 'PR head changed after verification; verifying again')
      }
    }
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
    const fresh = (await gh.feedbackFor(manifest, entry.pr)).filter((item) => !seen.has(item.id))

    if (fresh.length === 0) {
      entry.feedbackWaiting = false
      return
    }

    entry.feedbackWaiting = true

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
      entry.fixNote = `${entry.fixNote ?? ''}\n\n${note}`
    } else {
      toFix(pr, 'maintainer review', note)
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
    entry.state = 'blocked'
    entry.blocked = {
      kind: 'code-scanning',
      question: `PR #${entry.pr} has new code scanning alerts. Dismiss a false positive on GitHub and run rollout retry, or send instructions with rollout note.`,
      evidence: reasons.join('\n'),
    }

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

  // A PR merged or closed since sync is left to the next sync to record.
  async function checkClaim(pr) {
    const entry = ledger.prs[pr.id]
    const githubPr = await gh.viewPr(manifest, entry.pr)
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

    const ci = await gh.checksFor(manifest, entry.claimedSha)

    if (ci.state === 'pending') {
      entry.ciPendingSince = entry.ciPendingSince ?? now()

      if (minutesSince(entry.ciPendingSince) > manifest.policy.ciStallMinutes) {
        const seen = ci.runs.map((run) => `${run.name} (${run.conclusion ?? run.status})`).join(', ') || 'none'
        const why =
          ci.runs.length === 0
            ? `No check runs appeared for ${entry.claimedSha}. Find out why (workflow syntax? did the push reach GitHub?) and fix it.`
            : `Checks for ${entry.claimedSha} have not settled after ${manifest.policy.ciStallMinutes} minutes. Required globs with no matching run: ${ci.missing.join(', ') || 'none'}; still running: ${ci.pending.join(', ') || 'none'}; runs seen: ${seen}. Job names must keep matching ${manifest.repo.requiredChecks.join(', ')}.`

        toFix(pr, 'CI did not settle', why)
      }

      return
    }

    entry.ciPendingSince = null

    if (ci.state === 'red') {
      toFix(
        pr,
        'CI is red',
        `Failing checks on ${entry.claimedSha}:\n- ${ci.failing.join('\n- ')}\n\nStart from \`gh run view <run-id> --log-failed\`.`,
      )

      return
    }

    const facts = await collectFacts(manifest, pr, entry, ledger, { baseReads })

    if (facts.pr?.state !== 'OPEN') {
      return
    }

    if (facts.pr?.headRefOid !== entry.claimedSha) {
      say(pr.id, 'claim-moved', { claimed: entry.claimedSha.slice(0, 7), head: facts.pr?.headRefOid?.slice(0, 7) })
      entry.claimedSha = facts.pr?.headRefOid ?? entry.claimedSha
      entry.claimedAt = now()
      return
    }

    const violations = policyViolations(manifest, pr, facts)

    if (violations.length > 0) {
      toFix(pr, 'rollout policy', `The PR breaks rollout rules:\n- ${violations.join('\n- ')}`)
      return
    }

    noticeCodeScanning(pr, entry, facts)

    const scanning = codeScanningFindings(manifest, facts)

    if (scanning.action === 'fix') {
      toFix(pr, 'code scanning', codeScanningNote(manifest, scanning.reasons))
      return
    }

    if (scanning.action === 'block') {
      blockForCodeScanning(pr, entry, scanning.reasons)
      return
    }

    if (scanning.action === 'wait') {
      if (entry.notified.codeScanningWait !== entry.claimedSha) {
        entry.notified.codeScanningWait = entry.claimedSha
        say(pr.id, 'code-scanning-wait', { sha: entry.claimedSha.slice(0, 7), reasons: scanning.reasons })
      }

      return
    }

    if (entry.patchSinceId !== facts.patchId) {
      entry.patchSinceId = facts.patchId
      entry.patchSince = now()
    }

    entry.claimPatchId = facts.patchId
    entry.outOfScope = outOfScope(manifest, pr, facts, entry.briefScope ?? [])
    entry.workflowFiles = facts.files.map((file) => file.path).filter((path) => path.startsWith('.github/'))

    if (!slots() || stopping) {
      return
    }

    const aligned = await alignWorktree(manifest, pr, entry.claimedSha)

    if (!aligned.ok) {
      toFix(pr, 'worktree not at the PR head', aligned.reason)
      return
    }

    launch(pr, 'verify', { sha: entry.claimedSha })
  }

  function delegateAllowed(entry) {
    const policy = manifest.policy.delegate

    return (
      Boolean(policy) &&
      policy.kinds.includes(entry.blocked?.kind) &&
      !entry.pendingNote &&
      questionHash(entry.blocked) !== entry.delegate.lastQuestion
    )
  }

  // A question the delegate takes notifies once, through its answer or escalation.
  function delegateTakes(entry) {
    return delegateAllowed(entry) && entry.delegate.runs < manifest.policy.delegate.maxPerPr
  }

  // Each question gets one delegate run, and a PR at most policy.delegate.maxPerPr.
  function askDelegate(pr, entry) {
    const policy = manifest.policy.delegate

    if (!delegateAllowed(entry)) {
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

  async function advance(pr) {
    const entry = ledger.prs[pr.id]

    if (entry.held || running.has(pr.id) || (entry.retryAfter && Date.now() < Date.parse(entry.retryAfter))) {
      return
    }

    // A run state with no run behind it (an onDone that threw) resumes.
    if (entry.state === 'briefing') {
      entry.state = 'pending'
    } else if (RUNNING[entry.state]) {
      entry.interruptedRole = RUNNING[entry.state]
      entry.state = 'interrupted'
    }

    const depsReady = gh.depsPending(manifest, pr, ledger).length === 0

    switch (entry.state) {
      case 'pending':
        if (depsReady && slots()) {
          launch(pr, existsSync(pr.brief) ? 'implement' : 'brief')
        }

        break

      case 'interrupted':
        // A parked READY report needs GitHub again, not a slot or an agent.
        if (entry.interruptedRole === 'report' && entry.ready) {
          await claimReport(pr, entry, entry.ready)
          break
        }

        if (!slots() || (!entry.pr && !depsReady)) {
          break
        }

        if (entry.interruptedRole === 'verify' && entry.claimedSha) {
          entry.state = 'ready_claimed'
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
  // verifier worked would otherwise merge with no window for rollout pause.
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
      `PR #${entry.pr} approved on GitHub by ${approval.by}; merging in ${manifest.policy.mergeDelaySeconds}s unless you pause`,
    )
  }

  // readyTaken: the PR number another candidate holds "ready" with this tick
  // (merge: manual). This one then waits for it, see mergeNext.
  async function mergeCandidate(pr, { readyTaken = null } = {}) {
    const entry = ledger.prs[pr.id]
    const facts = await collectFacts(manifest, pr, entry, ledger, { baseReads })
    noticeCodeScanning(pr, entry, facts)
    noticeGithubApproval(pr, entry, facts)

    const judged = judge(manifest, pr, entry, facts)
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
        reasons: [`after PR #${readyTaken}: one PR is ready at a time, this one is checked again on the base that includes it`],
      }
    } else if (manualMerge) {
      verdict = { action: 'ready', reasons: [`ready: merge it on GitHub (${githubNote})`] }
    }

    const changed = entry.gate?.action !== verdict.action || entry.gate?.reasons.join() !== verdict.reasons.join()
    entry.gate = { ...verdict, mergeState: github, sha: facts.pr?.headRefOid ?? null, at: now(), ...(queued ? { after: readyTaken } : {}) }

    if (queued) {
      // Ready again later is a new notice, even on the same head.
      entry.notified.ready = null
    }

    if (changed) {
      say(pr.id, `gate-${verdict.action}`, { reasons: verdict.reasons })
    }

    if (verdict.action === 'wait') {
      const reason = verdict.reasons.join('; ')

      if (/awaiting|approve PR/.test(reason) && entry.notified.approval !== facts.patchId) {
        entry.notified.approval = facts.patchId
        notify(`rollout ${manifest.rollout}`, `${pr.id}: PR #${entry.pr} is verified; ${reason}`)
      } else if (/GitHub still blocks/.test(reason) && entry.notified.githubBlocked !== facts.pr.headRefOid) {
        entry.notified.githubBlocked = facts.pr.headRefOid
        notify(
          `rollout ${manifest.rollout}`,
          `${pr.id}: PR #${entry.pr} passes the rollout gate, but GitHub's ruleset still blocks the merge`,
        )
      }

      return false
    }

    if (verdict.action === 'block' && verdict.kind === 'code-scanning') {
      blockForCodeScanning(pr, entry, verdict.reasons)
      return false
    }

    if (verdict.action === 'block') {
      entry.state = 'blocked'
      entry.blocked = { kind: 'gate', question: verdict.reasons.join('; '), evidence: '' }
      say(pr.id, 'blocked', { reason: 'gate' }, `gate blocked: ${verdict.reasons.join('; ').slice(0, 120)}`)
      return false
    }

    if (verdict.action === 'fix') {
      entry.verified = null

      if (verdict.kind === 'code-scanning') {
        toFix(pr, 'code scanning', codeScanningNote(manifest, verdict.reasons))
      } else {
        toFix(pr, 'merge gate', `The merge gate sent the PR back:\n- ${verdict.reasons.join('\n- ')}`)
      }

      return false
    }

    if (verdict.action === 'rebase') {
      const rebased = await rebaseWorktree(manifest, pr, facts.pr.headRefOid)

      if (rebased.ok) {
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
    // rollout pause. No record for the current patch means no time has passed.
    const approvedAt = entry.approved?.patchId === facts.patchId ? entry.approved.at : now()
    const approvedFor = (Date.now() - Date.parse(approvedAt)) / 1000

    if (manifest.policy.merge === 'human' && approvedFor < manifest.policy.mergeDelaySeconds) {
      return false
    }

    if (manifest.dryRun) {
      if (entry.notified.wouldMerge !== facts.pr.headRefOid) {
        entry.notified.wouldMerge = facts.pr.headRefOid
        say(pr.id, 'would-merge', { pr: entry.pr, sha: facts.pr.headRefOid.slice(0, 7) }, `dry run: would merge PR #${entry.pr} now`)
      }

      return false
    }

    entry.gate.action = 'merge'
    ledger.save()

    let mergeSha

    try {
      mergeSha = await gh.merge(manifest, pr, entry, facts)
    } catch (error) {
      // GitHub refusing the merge is a state to wait in, not a failure.
      if (/base branch policy prohibits|not mergeable/i.test(String(error))) {
        entry.gate = {
          action: 'wait',
          reasons: ['GitHub refused the merge (ruleset)'],
          mergeState: github,
          sha: facts.pr.headRefOid,
          at: now(),
        }

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

    entry.state = 'merged'
    entry.mergeSha = mergeSha
    ledger.data.lastMerge = { id: pr.id, sha: mergeSha, at: now() }
    say(pr.id, 'merged', { pr: entry.pr, sha: mergeSha?.slice(0, 7) }, `merged PR #${entry.pr}`)
    ledger.save()
    await cleanup(pr)

    return true
  }

  async function mergeNext() {
    if (ledger.data.paused || ledger.data.halted || stopping) {
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

  // A red base branch after one of our merges stops all further merges.
  async function watchBase() {
    const last = ledger.data.lastMerge

    if (!last?.sha || last.checked === 'green' || last.checked === 'acknowledged' || ledger.data.halted) {
      return
    }

    // The merge commit's own runs, never a quiet ancestor's: only they say
    // whether this merge broke the base. With none yet, the next tick looks again.
    const checks = await gh.checksFor(manifest, last.sha)

    if (checks.state === 'red') {
      ledger.data.halted = `${manifest.repo.base} is red after merging ${last.id} (${last.sha.slice(0, 7)}): ${checks.failing.join(', ')}`
      say(
        last.id,
        'halted',
        { failing: checks.failing },
        `${manifest.repo.base} is red after the merge. Merges stopped until you fix it and run rollout unhalt`,
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
        entry.state = 'escalated'
        entry.escalation = 'repeated errors'
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
  // minutes after a sleep any failed gh or git call is one.
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
      const entry = ledger.prs[pr.id]

      if (entry.state === 'briefing') {
        entry.state = 'pending'
        entry.attempts.brief = Math.max(0, entry.attempts.brief - 1)
        say(pr.id, 'recovered-interrupted', { role: 'brief' })
      } else if (RUNNING[entry.state]) {
        entry.interruptedRole = RUNNING[entry.state]
        entry.state = 'interrupted'
        entry.attempts[entry.interruptedRole] = Math.max(0, entry.attempts[entry.interruptedRole] - 1)
        say(pr.id, 'recovered-interrupted', { role: entry.interruptedRole })
      }
    }

    await gh.fetchOrigin(manifest)
    await gh.ensureLabel(manifest)
    await enableWorktreeConfig(manifest)

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

  async function tick() {
    ledger.beat('tick')
    erredThisTick.clear()
    baseReads.clear()
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

      if (!ledger.data.paused && !stopping) {
        const order = [...manifest.prs].sort((left, right) => right.priority - left.priority || left.order - right.order)

        for (const pr of order) {
          await guarded(pr, () => advance(pr))
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
    } finally {
      lastTickEnd = clock()
      ledger.save()
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
