import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadManifest, raiseEffort } from './manifest.mjs'
import { acquireLock, drainInbox, freshPr, openLedger, recordVerdict, reserveRunName, watchInbox } from './ledger.mjs'
import { approvalChannel, approveRefusal, codeScanningFindings, githubApproval, judge, outOfScope, policyViolations } from './judge.mjs'
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
import { labelChanges, stageLabels } from './stage.mjs'

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

async function removePr(M, pr) {
  await removeWorktree(M, pr).catch(() => {})
  await gh.deleteRemoteBranch(M, pr.branch).catch(() => {})
}

export function createDriver(
  M,
  {
    cleanup = (pr) => removePr(M, pr),
    notify = desktopNotify,
    collectFacts = gh.collectFacts,
    runAgent = spawnAgent,
    clock = Date.now,
  } = {},
) {
  const L = openLedger(M)
  const running = new Map()
  const stepFailures = new Map()
  const erredThisTick = new Set()
  const unavailableThisTick = new Set()
  let outageThisTick = false
  let lastTickEnd = null
  let wokeAt = null
  let failedTicks = 0
  let stopping = false
  let manifestMtime = mtimeOf(`${M.dir}/manifest.yaml`)

  // Edits to manifest.yaml apply on the next tick without a restart (and
  // without stopping running agents). An invalid edit or a missing file is
  // reported once and ignored.
  function reloadManifest() {
    const mtime = mtimeOf(`${M.dir}/manifest.yaml`)

    if (mtime === manifestMtime) {
      return
    }

    manifestMtime = mtime

    try {
      const fresh = loadManifest(M.dir, { only: M.only, dryRun: M.dryRun })

      for (const pr of fresh.all) {
        L.prs[pr.id] = L.prs[pr.id] ?? freshPr()
      }

      Object.assign(M, fresh)
      say('-', 'manifest-reloaded', { prs: M.prs.map((pr) => pr.id) })
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
    L.event(id, kind, detail)

    const extra = Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail).slice(0, 300)}` : ''
    console.log(`${new Date().toLocaleTimeString()} ${id.padEnd(4)} ${kind}${extra}`)

    if (message) {
      notify(`rollout ${M.rollout}`, `${id}: ${message}`)
    }
  }

  function slots() {
    return running.size < M.policy.concurrency
  }

  // A PR sent to a fix run is no longer verified, so a retry can never send
  // the unchanged patch back to the gate and drop the fix it was sent for.
  function toFix(pr, reason, note) {
    const s = L.prs[pr.id]
    s.state = 'needs_fix'
    s.fixReason = reason
    s.fixNote = note
    s.verified = null
    say(pr.id, 'needs-fix', { reason })
  }

  function queueNote(id, text) {
    const s = L.prs[id]
    s.pendingNote = [s.pendingNote, text].filter(Boolean).join('\n\n')
  }

  function answerBrief(pr, question, text) {
    const s = L.prs[pr.id]
    s.briefAnswers = [...(s.briefAnswers ?? []), { question, answer: text }]
    s.attempts.brief = Math.max(0, s.attempts.brief - 1)
    s.state = 'pending'
    s.blocked = null
    say(pr.id, 'brief-answered')
  }

  // Commands from /rollout: approve, note, retry, hold, release, pause, resume, unhalt.
  // Each applies on its own, so a bad one never drops the rest of the batch.
  function applyCommands() {
    for (const command of drainInbox(M)) {
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
    const pr = forPr ? M.all.find((item) => item.id === command.id) : null
    const s = forPr ? L.prs[command.id] : null

    try {
      execute(command, pr, s)
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

    // Own keys only: L.prs.__proto__ is Object.prototype.
    if (!M.all.some((pr) => pr.id === id) || !Object.hasOwn(L.prs, id)) {
      return { command: cmd, reason: `unknown PR ${id}` }
    }

    if (cmd === 'approve' && !(typeof command.at === 'string' && Number.isFinite(Date.parse(command.at)))) {
      return { command: cmd, reason: 'needs a valid at' }
    }

    return null
  }

  function execute(command, pr, s) {
    switch (command.cmd) {
      case 'approve':
        approve(pr, s, command)
        break

      case 'note':
        applyNote(pr, s, command.text, 'maintainer')
        break

      case 'retry':
        if (s.state === 'merged') {
          say(command.id, 'command-rejected', { command: 'retry', reason: 'already merged' })
          break
        }

        if (running.has(command.id)) {
          say(command.id, 'command-rejected', { command: 'retry', reason: 'an agent is working on this PR' })
          break
        }

        s.attempts = { implement: 0, fix: 0, verify: 0, brief: 0 }
        s.delegate = { ...s.delegate, runs: 0, limitNotified: false }
        s.refunds = 0
        s.failStreak = 0
        s.tickErrors = 0
        s.retryAfter = null
        resumeAfterRetry(s)
        say(command.id, 'retry', { state: s.state })
        break

      case 'hold':
        if (s.state === 'merged') {
          say(command.id, 'command-rejected', { command: 'hold', reason: 'already merged' })
        } else if (s.held) {
          say(command.id, 'command-rejected', { command: 'hold', reason: 'already held' })
        } else {
          s.held = { at: now() }
          say(command.id, 'held', { state: s.state, running: running.get(command.id) ?? null })
        }
        break

      case 'release':
        if (s.held) {
          s.held = null
          say(command.id, 'released', { state: s.state })
        } else {
          say(command.id, 'command-rejected', { command: 'release', reason: 'not held' })
        }
        break

      case 'pause':
        L.data.paused = true
        say('-', 'paused')
        break

      case 'resume':
        L.data.paused = false
        say('-', 'resumed')
        break

      case 'unhalt':
        L.data.halted = null

        if (L.data.lastMerge) {
          L.data.lastMerge.checked = 'acknowledged'
        }

        say('-', 'unhalted')
        break
    }
  }

  // Where a retried PR picks up. A verification that still holds goes back
  // to the gate: sync compares the head with GitHub's first, and the gate
  // refuses a stale patch anyway. One for an older head is checked again
  // from the claim. A parked READY report needs no agent.
  function resumeAfterRetry(s) {
    if (s.pr && s.verified && s.verified.sha === s.claimedSha) {
      s.state = 'verified'
      s.interruptedRole = null
    } else if (s.pr && s.verified) {
      s.verified = null
      s.ciPendingSince = null
      s.state = 'ready_claimed'
      s.interruptedRole = null
    } else if (s.interruptedRole === 'report' && s.ready) {
      s.state = 'interrupted'
    } else {
      s.state = s.pr || s.sessionId ? 'interrupted' : 'pending'
      s.interruptedRole = s.claimedSha && !s.verified ? 'verify' : 'fix'
    }
  }

  // A maintainer's note and a delegate's answer reach the agent the same way.
  // A delegate run is no agent at work here: when its answer applies,
  // `running` still holds it.
  function applyNote(pr, s, text, by) {
    const id = pr.id
    const agentAtWork = running.has(id) && running.get(id) !== 'delegate'

    if (s.state !== 'merged') {
      const blocked = s.state === 'blocked' ? s.blocked : null
      const entry = { at: now(), by, kind: blocked?.kind ?? null, question: blocked?.question ?? null, text }
      s.noteHistory = [...(s.noteHistory ?? []), entry].slice(-20)
    }

    if (s.state === 'blocked' && s.blocked?.kind === 'brief-questions') {
      answerBrief(pr, s.blocked.question, text)
    } else if (agentAtWork || s.state === 'pending') {
      queueNote(id, text)
      say(id, 'note-queued', { state: s.state })
    } else if (s.state === 'merged') {
      say(id, 'command-rejected', { command: 'note', reason: 'already merged' })
    } else if (!existsSync(pr.brief) && !s.pr) {
      answerBrief(pr, null, text)
    } else if (s.state === 'verified' || s.state === 'ready_claimed') {
      s.verified = null
      s.attempts.fix = Math.min(s.attempts.fix, M.policy.attempts.fix - 1)
      toFix(pr, `request from the ${by}`, text)
    } else if (s.state === 'needs_fix') {
      s.attempts.fix = Math.min(s.attempts.fix, M.policy.attempts.fix - 1)
      queueNote(id, text)
      say(id, 'note-queued', { state: 'needs_fix' })
    } else {
      s.attempts.fix = Math.min(s.attempts.fix, M.policy.attempts.fix - 1)
      toFix(pr, `answer from the ${by}`, text)
    }
  }

  // An approval names the exact verified head and patch the maintainer saw
  // on the card, and must be posted after that verification finished.
  function approve(pr, s, command) {
    const reject = (reason) => say(pr.id, 'approval-rejected', { reason }, `approval rejected: ${reason}`)
    const refusal = approveRefusal(M, s)

    if (refusal) {
      return reject(refusal)
    }

    if (s.state !== 'verified' || !s.verified) {
      return reject(`state is ${s.state}, not verified`)
    }

    if (command.patchId !== s.verified.patchId || command.sha !== s.verified.sha) {
      return reject('it names a different head than the one verified now; look at the card again')
    }

    if (Date.parse(command.at) < Date.parse(s.verified.at)) {
      return reject('it was posted before the verification finished')
    }

    if (running.has(pr.id)) {
      return reject('an agent is working on this PR')
    }

    s.approved = { patchId: s.verified.patchId, sha: s.verified.sha, at: now(), channel: 'inbox' }
    say(
      pr.id,
      'approved',
      { sha: s.verified.sha.slice(0, 7), channel: 'inbox' },
      `approved PR #${s.pr}; merging in ${M.policy.mergeDelaySeconds}s unless you pause`,
    )
  }

  function launch(pr, role, { reason, note, sha } = {}) {
    const s = L.prs[pr.id]

    if (stopping) {
      return
    }

    if (role === 'brief') {
      return launchBrief(pr)
    }

    // An implement or fix run needs a brief. With no PR yet, the way on is to write one.
    if (!existsSync(pr.brief) && !s.pr) {
      s.state = 'pending'
      say(pr.id, 'brief-missing', { role })
      return
    }

    if (s.attempts[role] >= M.policy.attempts[role]) {
      s.state = 'escalated'
      s.lastError = `${role} attempts exhausted (${M.policy.attempts[role]})`
      say(pr.id, 'escalated', { role }, `${role} attempts exhausted, needs you (rollout retry or note)`)
      return
    }

    s.attempts[role] += 1

    let prompt
    let effort
    let resume = false
    let sessionId

    if (role === 'implement') {
      sessionId = randomUUID()
      s.sessionId = sessionId
      effort = raiseEffort(pr.effort.implement, s.attempts.implement - 1)
      prompt = implementPrompt(M, pr, s)

      if (s.pendingNote) {
        prompt += `\n\n## Note from the maintainer\n\n${s.pendingNote}\n`
        s.pendingNote = null
      }
    } else if (role === 'fix') {
      const text = [note, s.pendingNote].filter(Boolean).join('\n\n')
      effort = raiseEffort(pr.effort.implement, Math.max(0, s.attempts.fix - 2))

      if (s.sessionId) {
        sessionId = s.sessionId
        resume = true
        prompt = fixPrompt(M, pr, s, { reason, note: text, head: s.claimedSha })
      } else {
        sessionId = randomUUID()
        s.sessionId = sessionId
        prompt = resumeFreshPrompt(M, pr, s, { reason, note: text })
      }

      s.pendingNote = null
    } else {
      sessionId = randomUUID()
      effort = pr.effort.verify
      prompt = verifyPrompt(M, pr, s, sha)
    }

    s.state = { implement: 'implementing', fix: 'fixing', verify: 'verifying' }[role]
    const total = s.attempts.implement + s.attempts.fix + s.attempts.verify
    const logName = `${pr.id}-${String(total).padStart(2, '0')}-${role}`
    const run = reserveRunName(M, logName)
    say(pr.id, `${role}-start`, { run, log: `logs/${run}.jsonl`, effort, resume, reason })

    const job = (async () => {
      const cwd = role === 'verify' ? worktreePath(M, pr) : await prepareWorktree(M, pr)

      return runAgent(M, pr, { role, prompt, effort, sessionId, resume, cwd, logName: run })
    })().catch((error) => ({ ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }))

    running.set(pr.id, role)
    job
      .then((result) => onDone(pr, role, result, { sha, run }))
      .catch((error) => {
        say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) })

        if (RUNNING[L.prs[pr.id].state]) {
          L.prs[pr.id].state = 'interrupted'
          L.prs[pr.id].interruptedRole = role
          L.prs[pr.id].lastError = String(error)
        }
      })
      .finally(() => {
        running.delete(pr.id)
        L.save()
      })
  }

  // Two read-only agents on a worktree of the current base: a writer drafts
  // the brief from the plan and design notes, a reviewer checks every claim
  // against the code and returns the final text. The driver writes the file.
  function launchBrief(pr) {
    const s = L.prs[pr.id]

    if (s.attempts.brief >= M.policy.attempts.brief) {
      s.state = 'escalated'
      s.lastError = `brief attempts exhausted (${M.policy.attempts.brief})`
      say(pr.id, 'escalated', { role: 'brief' }, 'could not write a brief, needs you (rollout retry or write briefs/' + pr.id + '.md)')
      return
    }

    s.attempts.brief += 1
    s.state = 'briefing'

    if (s.pendingNote) {
      s.briefAnswers = [...(s.briefAnswers ?? []), { question: null, answer: s.pendingNote }]
      s.pendingNote = null
    }

    const effort = pr.effort.brief
    const base = `${pr.id}-${String(s.attempts.brief).padStart(2, '0')}-brief`

    function startStep(step) {
      const run = reserveRunName(M, `${base}-${step}`)
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
        cwd = await prepareWorktree(M, pr)

        return runAgent(M, pr, {
          role: 'brief',
          prompt: briefWritePrompt(M, pr, s),
          effort,
          sessionId: randomUUID(),
          cwd,
          logName: writeRun,
        })
      })

      if (!writer.ok) {
        return writer
      }

      const prompt = briefReviewPrompt(M, pr, s, writer.output.brief)
      const reviewRun = startStep('review')
      const reviewer = await finishStep('review', reviewRun, () =>
        runAgent(M, pr, { role: 'brief', prompt, effort, sessionId: randomUUID(), cwd, logName: reviewRun }),
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
        L.prs[pr.id].state = 'pending'
      })
      .finally(() => {
        running.delete(pr.id)
        L.save()
      })
  }

  function onBriefDone(pr, result) {
    const s = L.prs[pr.id]
    s.costUsd = Number((s.costUsd + (result.costUsd ?? 0)).toFixed(4))

    if (!result.ok) {
      failed(pr, 'brief', result)
      s.state = 'pending'
      return
    }

    const out = result.output

    if (out.questions.length > 0) {
      s.state = 'blocked'
      s.blocked = { kind: 'brief-questions', question: out.questions.join('\n'), evidence: out.notes }
      say(
        pr.id,
        'blocked',
        { reason: 'brief-questions' },
        delegateTakes(s)
          ? null
          : `the brief needs your decision: ${out.questions[0].slice(0, 100)} (rollout card ${pr.id}, then rollout note ${pr.id} "...")`,
      )
      return
    }

    mkdirSync(dirname(pr.brief), { recursive: true })
    writeFileSync(pr.brief, `${out.brief.trim()}\n`)
    writeFileSync(pr.brief.replace(/\.md$/, '.review-notes.md'), `${out.notes.trim()}\n`)
    s.briefScope = out.expectedFiles
    s.briefAt = now()
    s.briefAnswers = []
    s.failStreak = 0
    s.state = 'pending'
    say(pr.id, 'brief-written', { files: out.expectedFiles.length, bump: out.changesetBump })
  }

  // A read-only agent answers the question a PR is blocked on from the plan,
  // or hands it back to the maintainer. The PR stays blocked while it runs.
  function launchDelegate(pr) {
    if (stopping) {
      return
    }

    const s = L.prs[pr.id]
    const question = questionHash(s.blocked)
    const blocked = { ...s.blocked }
    const effort = M.policy.delegate.effort

    s.delegate.runs += 1

    const run = reserveRunName(M, `${pr.id}-${String(s.delegate.runs).padStart(2, '0')}-delegate`)
    // `blocked` and not `kind`, which would overwrite the event's own kind.
    say(pr.id, 'delegate-start', { run, log: `logs/${run}.jsonl`, effort, blocked: blocked.kind })

    // The prompt is built in the job, so a missing briefing source fails this run instead of throwing in advance.
    const job = (async () => {
      const path = worktreePath(M, pr)
      const cwd = existsSync(path) ? path : await prepareWorktree(M, pr)
      const prompt = delegatePrompt(M, pr, s)

      return runAgent(M, pr, { role: 'delegate', prompt, effort, sessionId: randomUUID(), resume: false, cwd, logName: run })
    })().catch((error) => ({ ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0, awakeSeconds: 0 }))

    running.set(pr.id, 'delegate')
    job
      .then((result) => onDelegateDone(pr, result, { run, question, blocked }))
      .catch((error) => say(pr.id, 'on-done-error', { error: String(error).slice(0, 300) }))
      .finally(() => {
        running.delete(pr.id)
        L.save()
      })
  }

  async function onDelegateDone(pr, result, { run, question, blocked }) {
    const s = L.prs[pr.id]
    s.costUsd = Number((s.costUsd + (result.costUsd ?? 0)).toFixed(4))
    say(pr.id, 'delegate-done', doneDetail('delegate', run, result))

    if (s.state === 'merged') {
      await cleanup(pr)
      return
    }

    if (result.stopped) {
      s.delegate.runs = Math.max(0, s.delegate.runs - 1)
      return
    }

    s.delegate.lastQuestion = question

    const out = result.output ?? {}
    const report = {
      answer: typeof out.answer === 'string' ? out.answer : '',
      planRefs: Array.isArray(out.planRefs) ? out.planRefs : [],
      reasoning: typeof out.reasoning === 'string' ? out.reasoning : '',
    }

    function record(decision, fields = {}) {
      const entry = { at: now(), kind: blocked.kind, question: blocked.question ?? '', decision, ...report, ...fields, run }
      s.delegate.answers = [...s.delegate.answers, entry].slice(-20)
    }

    // A maintainer's note applied while the delegate ran. The note wins.
    if (s.state !== 'blocked' || questionHash(s.blocked) !== question) {
      record('dropped')
      say(pr.id, 'delegate-dropped', { run, state: s.state })
      return
    }

    if (!result.ok) {
      record('failed', { reasoning: result.error ?? '' })
      s.lastError = result.error
      backOff(s, result)
      escalateFromDelegate(pr, blocked, run, `the run failed: ${result.error}`)
      return
    }

    s.failStreak = 0

    const answer = report.answer.trim()

    if (out.decision === 'answer' && answer) {
      record('answer')
      applyNote(pr, s, `Answer from the delegate, on the maintainer's behalf, from the plan:\n\n${answer}`, 'delegate')
      say(
        pr.id,
        'delegate-answered',
        { run, blocked: blocked.kind, planRefs: report.planRefs },
        sentences(`delegate answered: ${answer.slice(0, 100)}`, `Override with rollout note ${pr.id}`),
      )
      return
    }

    record('escalate')
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
    const s = L.prs[pr.id]
    s.lastError = result.error

    // Runs that did no work (a stop, an outage, a quota wall) give their
    // attempt back, a bounded number of times; every failure backs off.
    const idle = result.stopped || result.transient || result.account || ((result.costUsd ?? 0) < 0.01 && (result.seconds ?? 0) < 60)

    if (idle && (s.refunds ?? 0) < MAX_REFUNDS) {
      s.attempts[role] -= 1
      s.refunds = (s.refunds ?? 0) + 1
    }

    backOff(s, result)

    if (role !== 'verify' && result.sessionMissing) {
      s.sessionId = null
    }

    s.state = 'interrupted'
    s.interruptedRole = role
  }

  function backOff(s, result) {
    if (result.account) {
      L.data.paused = true
      say('-', 'paused', { reason: result.error?.slice(0, 200) }, 'account limit reached; rollout paused (rollout resume)')
    }

    if (!result.stopped) {
      s.failStreak = (s.failStreak ?? 0) + 1
      s.retryAfter = new Date(Date.now() + Math.min(2 ** s.failStreak, 30) * 60_000).toISOString()
    }
  }

  async function onDone(pr, role, result, { sha, run }) {
    const s = L.prs[pr.id]
    s.costUsd = Number((s.costUsd + (result.costUsd ?? 0)).toFixed(4))
    say(pr.id, `${role}-done`, doneDetail(role, run, result))

    if (s.state === 'merged') {
      await cleanup(pr)
      return
    }

    if (!result.ok) {
      failed(pr, role, result)
      return
    }

    s.failStreak = 0

    const out = result.output

    if (role === 'verify') {
      await verified(pr, s, out, sha, run)
      return
    }

    s.ready = out

    if (out.status === 'BLOCKED') {
      s.state = 'blocked'
      s.blocked = out.blocked ?? { kind: 'unknown', question: out.summary, evidence: '' }
      say(
        pr.id,
        'blocked',
        { reason: s.blocked.kind },
        delegateTakes(s) ? null : `blocked (${s.blocked.kind}): ${s.blocked.question.slice(0, 120)}`,
      )
      return
    }

    // A GitHub outage is no fault of the report, and a fix run would spend
    // an attempt on it. The report waits in s.ready for a later tick.
    try {
      await claimReport(pr, s, out)
    } catch (error) {
      s.state = 'interrupted'
      s.interruptedRole = 'report'
      s.lastError = String(error?.message ?? error).slice(0, 1000)
      say(pr.id, 'report-unchecked', { error: s.lastError.slice(0, 300) })
    }
  }

  // Claimed or sent to a fix, the report is used up. s.ready keeps the last
  // report of every PR, so a stale 'report' role would claim it again.
  async function claimReport(pr, s, out) {
    const problem = await checkReport(pr, out)
    s.interruptedRole = null

    if (problem) {
      toFix(pr, 'report does not match GitHub', problem)
      return
    }

    s.pr = out.pr
    s.claimedSha = out.headSha
    s.claimedAt = now()
    s.ciPendingSince = null
    s.verified = null
    s.state = 'ready_claimed'
    say(pr.id, 'ready-claimed', { pr: out.pr, sha: out.headSha.slice(0, 7) })
    await answerFeedback(pr, s, out)

    if (s.pendingNote) {
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
      const p = await gh.viewPr(M, out.pr)

      if (p.headRefName !== pr.branch || p.baseRefName !== M.repo.base || p.state !== 'OPEN') {
        return `PR #${out.pr} is ${p.state}, ${p.headRefName} → ${p.baseRefName}; expected an open PR ${pr.branch} → ${M.repo.base}.`
      }
    } catch (error) {
      if (!/Could not resolve to a PullRequest|no pull requests? found/i.test(String(error))) {
        throw error
      }

      return `PR #${out.pr} could not be read (${String(error).slice(0, 200)}). Report the number of your PR.`
    }

    return null
  }

  function nextStep(pr, s) {
    const channel = approvalChannel(M, s.author)

    if (channel === 'github') {
      return 'review and approve it on GitHub'
    }

    if (channel === 'inbox') {
      return `check the card, then: rollout approve ${pr.id}`
    }

    if (M.policy.merge === 'manual') {
      return 'review it; the driver tells you when it is ready to merge'
    }

    return 'the driver merges it once the gate passes'
  }

  async function verified(pr, s, out, sha, run) {
    const tree = await inspectWorktree(M, pr)
    const touched = !tree.clean || tree.head !== sha

    if (touched) {
      await resetWorktree(M, pr, sha)
    }

    recordVerdict(s, { ...out, at: now(), run })

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
      s.state = 'ready_claimed'
      say(
        pr.id,
        'verifier-touched-tree',
        { head: tree.head.slice(0, 7), status: tree.status.slice(0, 200) },
        'the verifier changed the worktree; PASS discarded, verifying again',
      )
      return
    }

    if (out.sha !== sha || sha !== s.claimedSha) {
      s.state = 'ready_claimed'
      say(pr.id, 'verify-stale', { verified: out.sha, claimed: s.claimedSha })
      return
    }

    s.verified = { sha, patchId: s.claimPatchId, at: now() }
    s.attempts.verify = 0
    s.state = 'verified'

    say(pr.id, 'verified', { sha: sha.slice(0, 7) }, `verified PR #${s.pr}: ${nextStep(pr, s)}`)

    if (s.pendingNote) {
      s.verified = null
      toFix(pr, 'answer from the maintainer', '')
    }
  }

  // GitHub wins: merges, closes and moved heads made outside the driver.
  async function sync(pr) {
    const s = L.prs[pr.id]

    if (!s.pr || s.state === 'merged') {
      return
    }

    const p = await gh.viewPr(M, s.pr)
    s.author = p.author

    if (p.state === 'MERGED') {
      const wasOurs = s.state === 'verified' && s.gate?.action === 'merge'
      s.state = 'merged'

      if (wasOurs) {
        say(pr.id, 'merged', { pr: s.pr }, `merged PR #${s.pr}`)
      } else {
        say(pr.id, 'merged-outside-driver', { pr: s.pr })
      }

      const mergeSha = await gh.mergeCommit(M, s.pr).catch(() => null)

      if (mergeSha) {
        s.mergeSha = mergeSha
        L.data.lastMerge = { id: pr.id, sha: mergeSha, at: now() }
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

    if (p.state === 'CLOSED') {
      if (s.state !== 'blocked') {
        s.state = 'blocked'
        s.blocked = {
          kind: 'closed',
          question: `PR #${s.pr} was closed outside the driver. Reopen it and run rollout retry, or drop it from the manifest.`,
          evidence: '',
        }
        say(pr.id, 'blocked', { reason: 'closed' }, `PR #${s.pr} was closed`)
      }
      return
    }

    if (s.state === 'verified' && p.headRefOid !== s.verified.sha) {
      const facts = await collectFacts(M, pr, s, L)

      if (facts.pr?.headRefOid === p.headRefOid && facts.patchId === s.verified.patchId) {
        s.verified.sha = p.headRefOid
        s.claimedSha = p.headRefOid

        if (s.approved?.patchId === facts.patchId) {
          s.approved.sha = p.headRefOid
        }

        await alignWorktree(M, pr, p.headRefOid).catch(() => {})
        say(pr.id, 'head-moved-same-patch', { sha: p.headRefOid.slice(0, 7) })
      } else {
        s.verified = null
        s.state = 'ready_claimed'
        s.claimedSha = p.headRefOid
        s.claimedAt = now()
        s.ciPendingSince = null
        say(pr.id, 'head-moved-reverify', { sha: p.headRefOid.slice(0, 7) }, 'PR head changed after verification; verifying again')
      }
    }
  }

  // Maintainer review comments become a fix run for the implementer, once
  // the maintainer has been quiet for a few minutes (a review in progress is
  // not interrupted). Handled comments are remembered by id.
  async function handleFeedback(pr) {
    const s = L.prs[pr.id]

    if (!s.pr || running.has(pr.id) || !['verified', 'ready_claimed', 'needs_fix'].includes(s.state) || M.repo.maintainers.length === 0) {
      return
    }

    const seen = new Set(s.feedbackSeen ?? [])
    const fresh = (await gh.feedbackFor(M, s.pr)).filter((item) => !seen.has(item.id))

    if (fresh.length === 0) {
      s.feedbackWaiting = false
      return
    }

    s.feedbackWaiting = true

    if (minutesSince(fresh.at(-1).at) < M.policy.feedbackQuietMinutes) {
      return
    }

    const note = feedbackNote(s.pr, fresh)
    s.feedbackSeen = [...seen, ...fresh.map((item) => item.id)]
    s.feedbackInFix = [
      ...(s.feedbackInFix ?? []),
      ...fresh.map((item) => ({ id: item.id, commentId: item.commentId ?? null, body: item.body.slice(0, 200) })),
    ]
    s.feedbackWaiting = false
    s.verified = null
    say(pr.id, 'review-feedback', { comments: fresh.length })

    if (s.state === 'needs_fix') {
      s.fixNote = `${s.fixNote ?? ''}\n\n${note}`
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

  function blockForCodeScanning(pr, s, reasons) {
    // Without a verification, rollout retry resumes through checkClaim, which reads the alerts again before any agent runs.
    s.verified = null
    s.state = 'blocked'
    s.blocked = {
      kind: 'code-scanning',
      question: `PR #${s.pr} has new code scanning alerts. Dismiss a false positive on GitHub and run rollout retry, or send instructions with rollout note.`,
      evidence: reasons.join('\n'),
    }
    say(pr.id, 'blocked', { reason: 'code-scanning' }, `blocked (code-scanning): ${reasons[0].slice(0, 120)}`)
  }

  // Once per PR, even across restarts: the flag lives in the ledger.
  function noticeCodeScanning(pr, s, facts) {
    if (facts.codeScanning?.available !== false || s.notified.codeScanningUnavailable) {
      return
    }

    s.notified.codeScanningUnavailable = true
    say(pr.id, 'code-scanning-unavailable', { reason: facts.codeScanning.reason })
  }

  // After a fix that answered review comments: reply in each inline thread
  // and summarize the rest, as the agents' account.
  async function answerFeedback(pr, s, out) {
    const pending = s.feedbackInFix ?? []

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
          .replyAsAgents(M, s.pr, item.commentId, text)
          .catch((error) => say(pr.id, 'reply-failed', { error: String(error).slice(0, 200) }))
      } else {
        rest.push(`- "${item.body.slice(0, 80)}": ${text}`)
      }
    }

    if (rest.length > 0) {
      await gh
        .commentAsAgents(M, s.pr, `Review comments addressed:\n\n${rest.join('\n')}`)
        .catch((error) => say(pr.id, 'reply-failed', { error: String(error).slice(0, 200) }))
    }

    const handled = pending.map((item) => ({
      id: item.id,
      body: item.body,
      action: actions.get(item.id) ?? null,
      sha: out.headSha,
      at: now(),
    }))
    s.feedbackHandled = [...(s.feedbackHandled ?? []), ...handled].slice(-50)
    s.feedbackInFix = []
    say(pr.id, 'review-answered', { comments: pending.length })
  }

  // A PR merged or closed since sync is left to the next sync to record.
  async function checkClaim(pr) {
    const s = L.prs[pr.id]
    const p = await gh.viewPr(M, s.pr)
    s.author = p.author

    if (p.state !== 'OPEN') {
      return
    }

    if (p.headRefOid !== s.claimedSha) {
      say(pr.id, 'claim-moved', { claimed: s.claimedSha?.slice(0, 7), head: p.headRefOid.slice(0, 7) })
      s.claimedSha = p.headRefOid
      s.claimedAt = now()
      s.ciPendingSince = null
    }

    const ci = await gh.checksFor(M, s.claimedSha)

    if (ci.state === 'pending') {
      s.ciPendingSince = s.ciPendingSince ?? now()

      if (minutesSince(s.ciPendingSince) > M.policy.ciStallMinutes) {
        const seen = ci.runs.map((run) => `${run.name} (${run.conclusion ?? run.status})`).join(', ') || 'none'
        const why =
          ci.runs.length === 0
            ? `No check runs appeared for ${s.claimedSha}. Find out why (workflow syntax? did the push reach GitHub?) and fix it.`
            : `Checks for ${s.claimedSha} have not settled after ${M.policy.ciStallMinutes} minutes. Required globs with no matching run: ${ci.missing.join(', ') || 'none'}; still running: ${ci.pending.join(', ') || 'none'}; runs seen: ${seen}. Job names must keep matching ${M.repo.requiredChecks.join(', ')}.`
        toFix(pr, 'CI did not settle', why)
      }
      return
    }

    s.ciPendingSince = null

    if (ci.state === 'red') {
      toFix(
        pr,
        'CI is red',
        `Failing checks on ${s.claimedSha}:\n- ${ci.failing.join('\n- ')}\n\nStart from \`gh run view <run-id> --log-failed\`.`,
      )
      return
    }

    const facts = await collectFacts(M, pr, s, L)

    if (facts.pr?.state !== 'OPEN') {
      return
    }

    if (facts.pr?.headRefOid !== s.claimedSha) {
      say(pr.id, 'claim-moved', { claimed: s.claimedSha.slice(0, 7), head: facts.pr?.headRefOid?.slice(0, 7) })
      s.claimedSha = facts.pr?.headRefOid ?? s.claimedSha
      s.claimedAt = now()
      return
    }

    const violations = policyViolations(M, pr, facts)

    if (violations.length > 0) {
      toFix(pr, 'rollout policy', `The PR breaks rollout rules:\n- ${violations.join('\n- ')}`)
      return
    }

    noticeCodeScanning(pr, s, facts)

    const scanning = codeScanningFindings(M, facts)

    if (scanning.action === 'fix') {
      toFix(pr, 'code scanning', codeScanningNote(M, scanning.reasons))
      return
    }

    if (scanning.action === 'block') {
      blockForCodeScanning(pr, s, scanning.reasons)
      return
    }

    if (scanning.action === 'wait') {
      if (s.notified.codeScanningWait !== s.claimedSha) {
        s.notified.codeScanningWait = s.claimedSha
        say(pr.id, 'code-scanning-wait', { sha: s.claimedSha.slice(0, 7), reasons: scanning.reasons })
      }
      return
    }

    if (s.patchSinceId !== facts.patchId) {
      s.patchSinceId = facts.patchId
      s.patchSince = now()
    }

    s.claimPatchId = facts.patchId
    s.outOfScope = outOfScope(M, pr, facts, s.briefScope ?? [])
    s.workflowFiles = facts.files.map((file) => file.path).filter((path) => path.startsWith('.github/'))

    if (!slots() || stopping) {
      return
    }

    const aligned = await alignWorktree(M, pr, s.claimedSha)

    if (!aligned.ok) {
      toFix(pr, 'worktree not at the PR head', aligned.reason)
      return
    }

    launch(pr, 'verify', { sha: s.claimedSha })
  }

  function delegateAllowed(s) {
    const policy = M.policy.delegate

    return (
      Boolean(policy) && policy.kinds.includes(s.blocked?.kind) && !s.pendingNote && questionHash(s.blocked) !== s.delegate.lastQuestion
    )
  }

  // A question the delegate takes notifies once, through its answer or escalation.
  function delegateTakes(s) {
    return delegateAllowed(s) && s.delegate.runs < M.policy.delegate.maxPerPr
  }

  // Each question gets one delegate run, and a PR at most policy.delegate.maxPerPr.
  function askDelegate(pr, s) {
    const policy = M.policy.delegate

    if (!delegateAllowed(s)) {
      return
    }

    if (s.delegate.runs >= policy.maxPerPr) {
      if (!s.delegate.limitNotified) {
        s.delegate.limitNotified = true
        say(
          pr.id,
          'delegate-limit',
          { runs: s.delegate.runs, maxPerPr: policy.maxPerPr },
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
    const s = L.prs[pr.id]

    if (s.held || running.has(pr.id) || (s.retryAfter && Date.now() < Date.parse(s.retryAfter))) {
      return
    }

    // A run state with no run behind it (an onDone that threw) resumes.
    if (s.state === 'briefing') {
      s.state = 'pending'
    } else if (RUNNING[s.state]) {
      s.interruptedRole = RUNNING[s.state]
      s.state = 'interrupted'
    }

    const depsReady = gh.depsPending(M, pr, L).length === 0

    switch (s.state) {
      case 'pending':
        if (depsReady && slots()) {
          launch(pr, existsSync(pr.brief) ? 'implement' : 'brief')
        }
        break

      case 'interrupted':
        // A parked READY report needs GitHub again, not a slot or an agent.
        if (s.interruptedRole === 'report' && s.ready) {
          await claimReport(pr, s, s.ready)
          break
        }

        if (!slots() || (!s.pr && !depsReady)) {
          break
        }

        if (s.interruptedRole === 'verify' && s.claimedSha) {
          s.state = 'ready_claimed'
          await checkClaim(pr)
        } else if (s.interruptedRole === 'implement' && !s.sessionId) {
          launch(pr, 'implement')
        } else {
          launch(pr, 'fix', {
            reason: 'previous run ended without a report',
            note: `Your previous run stopped without a final report (${s.lastError ?? 'unknown'}). Inspect the worktree and the PR, then continue where you stopped.`,
          })
        }
        break

      case 'needs_fix':
        if (slots() && (s.pr || depsReady)) {
          launch(pr, 'fix', { reason: s.fixReason, note: s.fixNote })
        }
        break

      case 'ready_claimed':
        await checkClaim(pr)
        break

      case 'blocked':
        askDelegate(pr, s)
        break

      default:
        break
    }
  }

  // The merge delay of a GitHub approval starts when the driver first sees
  // it, not at the review's own time. A review given while CI ran or the
  // verifier worked would otherwise merge with no window for rollout pause.
  function noticeGithubApproval(pr, s, facts) {
    const author = facts.pr?.author

    if (facts.pr?.state !== 'OPEN' || approvalChannel(M, author) !== 'github') {
      return
    }

    const approval = githubApproval(M, s, facts)

    // Cleared even on a held PR, so the next approval gets its own notice
    // and a full window.
    if (!approval.approved && s.approved?.channel === 'github') {
      s.approved = null
      return
    }

    if (s.held || !approval.approved || s.verified?.patchId !== facts.patchId) {
      return
    }

    if (s.approved?.channel === 'github' && s.approved.patchId === facts.patchId) {
      return
    }

    s.approved = { patchId: facts.patchId, sha: facts.pr.headRefOid, at: now(), by: approval.by, channel: 'github' }
    say(
      pr.id,
      'approved',
      { sha: facts.pr.headRefOid.slice(0, 7), by: approval.by, channel: 'github' },
      `PR #${s.pr} approved on GitHub by ${approval.by}; merging in ${M.policy.mergeDelaySeconds}s unless you pause`,
    )
  }

  async function mergeCandidate(pr) {
    const s = L.prs[pr.id]
    const facts = await collectFacts(M, pr, s, L)
    noticeCodeScanning(pr, s, facts)
    noticeGithubApproval(pr, s, facts)

    const judged = judge(M, pr, s, facts)
    const github = facts.pr?.mergeStateStatus ?? 'UNKNOWN'
    const githubNote =
      github === 'CLEAN' || github === 'HAS_HOOKS'
        ? 'GitHub: mergeable'
        : `GitHub: ${github}${github === 'BLOCKED' ? ' (a review, an open thread or a ruleset rule is still missing)' : ''}`
    const verdict =
      M.policy.merge === 'manual' && judged.action === 'merge'
        ? { action: 'ready', reasons: [`ready: merge it on GitHub (${githubNote})`] }
        : judged
    const changed = s.gate?.action !== verdict.action || s.gate?.reasons.join() !== verdict.reasons.join()
    s.gate = { ...verdict, mergeState: github, sha: facts.pr?.headRefOid ?? null, at: now() }

    if (changed) {
      say(pr.id, `gate-${verdict.action}`, { reasons: verdict.reasons })
    }

    if (verdict.action === 'wait') {
      const reason = verdict.reasons.join('; ')

      if (/awaiting|approve PR/.test(reason) && s.notified.approval !== facts.patchId) {
        s.notified.approval = facts.patchId
        notify(`rollout ${M.rollout}`, `${pr.id}: PR #${s.pr} is verified; ${reason}`)
      } else if (/GitHub still blocks/.test(reason) && s.notified.githubBlocked !== facts.pr.headRefOid) {
        s.notified.githubBlocked = facts.pr.headRefOid
        notify(`rollout ${M.rollout}`, `${pr.id}: PR #${s.pr} passes the rollout gate, but GitHub's ruleset still blocks the merge`)
      }
      return false
    }

    if (verdict.action === 'block' && verdict.kind === 'code-scanning') {
      blockForCodeScanning(pr, s, verdict.reasons)
      return false
    }

    if (verdict.action === 'block') {
      s.state = 'blocked'
      s.blocked = { kind: 'gate', question: verdict.reasons.join('; '), evidence: '' }
      say(pr.id, 'blocked', { reason: 'gate' }, `gate blocked: ${verdict.reasons.join('; ').slice(0, 120)}`)
      return false
    }

    if (verdict.action === 'fix') {
      s.verified = null

      if (verdict.kind === 'code-scanning') {
        toFix(pr, 'code scanning', codeScanningNote(M, verdict.reasons))
      } else {
        toFix(pr, 'merge gate', `The merge gate sent the PR back:\n- ${verdict.reasons.join('\n- ')}`)
      }

      return false
    }

    if (verdict.action === 'rebase') {
      const rebased = await rebaseWorktree(M, pr, facts.pr.headRefOid)

      if (rebased.ok) {
        say(pr.id, 'rebased', { head: rebased.head.slice(0, 7) })
      } else {
        s.verified = null
        toFix(
          pr,
          'rebase conflict',
          `\`${M.repo.base}\` moved and the branch no longer rebases cleanly.\nConflicting files: ${rebased.conflicts.join(', ') || '(see below)'}\n${rebased.reason.slice(0, 1500)}\n\nRebase onto origin/${M.repo.base}, resolve keeping both intents (read the merged PRs that touched these files), re-verify and push with --force-with-lease.`,
        )
      }

      return true
    }

    // Manual mode: everything the gate checks holds; the maintainer merges.
    if (verdict.action === 'ready') {
      if (s.notified.ready !== `${facts.pr.headRefOid}:${github}`) {
        s.notified.ready = `${facts.pr.headRefOid}:${github}`
        say(
          pr.id,
          'ready-to-merge',
          { pr: s.pr, sha: facts.pr.headRefOid.slice(0, 7), github },
          `PR #${s.pr} is ready: verified, CI green, up to date. ${githubNote}`,
        )
      }

      return false
    }

    // A short delay from the first time the driver saw the approval, so one
    // nobody expected can be noticed (both channels notify) and stopped with
    // rollout pause. No record for the current patch means no time has passed.
    const approvedAt = s.approved?.patchId === facts.patchId ? s.approved.at : now()
    const approvedFor = (Date.now() - Date.parse(approvedAt)) / 1000

    if (M.policy.merge === 'human' && approvedFor < M.policy.mergeDelaySeconds) {
      return false
    }

    if (M.dryRun) {
      if (s.notified.wouldMerge !== facts.pr.headRefOid) {
        s.notified.wouldMerge = facts.pr.headRefOid
        say(pr.id, 'would-merge', { pr: s.pr, sha: facts.pr.headRefOid.slice(0, 7) }, `dry run: would merge PR #${s.pr} now`)
      }
      return false
    }

    s.gate.action = 'merge'
    L.save()

    let mergeSha

    try {
      mergeSha = await gh.merge(M, pr, s, facts)
    } catch (error) {
      // GitHub refusing the merge is a state to wait in, not a failure.
      if (/base branch policy prohibits|not mergeable/i.test(String(error))) {
        s.gate = {
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
          `GitHub refused to merge PR #${s.pr}; check its ruleset requirements`,
        )
        return false
      }

      throw error
    }

    // Accepted, but GitHub shows no merge commit yet (a merge queue, a slow
    // read). The PR stays verified with gate.action merge, so the next sync
    // that sees it merged records it as the driver's merge and cleans up.
    if (!mergeSha) {
      say(pr.id, 'merge-unconfirmed', { pr: s.pr, sha: facts.pr.headRefOid.slice(0, 7) })
      L.save()

      return true
    }

    s.state = 'merged'
    s.mergeSha = mergeSha
    L.data.lastMerge = { id: pr.id, sha: mergeSha, at: now() }
    say(pr.id, 'merged', { pr: s.pr, sha: mergeSha?.slice(0, 7) }, `merged PR #${s.pr}`)
    L.save()
    await cleanup(pr)

    return true
  }

  async function mergeNext() {
    if (L.data.paused || L.data.halted || stopping) {
      return
    }

    const candidates = M.prs
      .filter((pr) => L.prs[pr.id].state === 'verified' && !running.has(pr.id) && !L.prs[pr.id].feedbackWaiting)
      .sort((a, b) => b.priority - a.priority || a.order - b.order)

    for (const pr of candidates) {
      const acted = await guarded(pr, () => mergeCandidate(pr))

      if (acted) {
        return
      }
    }
  }

  // A red base branch after one of our merges stops all further merges.
  async function watchBase() {
    const last = L.data.lastMerge

    if (!last?.sha || last.checked === 'green' || last.checked === 'acknowledged' || L.data.halted) {
      return
    }

    const checks = await gh.checksFor(M, last.sha)

    if (checks.state === 'red') {
      L.data.halted = `${M.repo.base} is red after merging ${last.id} (${last.sha.slice(0, 7)}): ${checks.failing.join(', ')}`
      say(
        last.id,
        'halted',
        { failing: checks.failing },
        `${M.repo.base} is red after the merge. Merges stopped until you fix it and run rollout unhalt`,
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
    const s = L.prs[pr.id]

    try {
      return await task()
    } catch (error) {
      if (unavailable(pr.id, error)) {
        unavailableThisTick.add(pr.id)

        return false
      }

      if (!erredThisTick.has(pr.id)) {
        erredThisTick.add(pr.id)
        s.tickErrors = (s.tickErrors ?? 0) + 1
      }

      s.lastError = String(error?.message ?? error).slice(0, 1000)
      say(pr.id, 'error', { error: s.lastError.slice(0, 300), count: s.tickErrors })

      // sync still runs for an escalated PR. If it keeps failing, that must
      // not escalate and notify again on every tick.
      if (s.tickErrors >= MAX_TICK_ERRORS && !running.has(pr.id) && s.state !== 'escalated') {
        s.state = 'escalated'
        say(pr.id, 'escalated', { reason: 'repeated errors' }, `repeated errors, needs you: ${s.lastError.slice(0, 100)}`)
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

    L.data.githubUnavailable = L.data.githubUnavailable ?? { since: now(), notified: false }

    if (outageThisTick) {
      return true
    }

    outageThisTick = true

    const outage = L.data.githubUnavailable
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
    const outage = L.data.githubUnavailable
    const minutes = Math.floor(minutesSince(outage.since))
    const notice = outage.notified ? `GitHub answers again after ${minutes} minutes` : null

    L.data.githubUnavailable = null
    say('-', 'github-back', { minutes }, notice)
  }

  async function start() {
    for (const pr of M.all) {
      const s = L.prs[pr.id]

      if (s.state === 'briefing') {
        s.state = 'pending'
        s.attempts.brief = Math.max(0, s.attempts.brief - 1)
        say(pr.id, 'recovered-interrupted', { role: 'brief' })
      } else if (RUNNING[s.state]) {
        s.interruptedRole = RUNNING[s.state]
        s.state = 'interrupted'
        s.attempts[s.interruptedRole] = Math.max(0, s.attempts[s.interruptedRole] - 1)
        say(pr.id, 'recovered-interrupted', { role: s.interruptedRole })
      }
    }

    await gh.fetchOrigin(M)
    await gh.ensureLabel(M)
    await enableWorktreeConfig(M)

    const active = new Set(M.prs.map((pr) => pr.id))

    for (const pr of M.prs) {
      for (const dep of pr.deps.filter((id) => !active.has(id) && L.prs[id].state !== 'merged')) {
        say(pr.id, 'waiting-outside-dep', { dep }, `${pr.id} waits for ${dep}, which is not in this run (--only) and not merged`)
      }
    }

    L.save()
    say('-', 'driver-start', { prs: M.prs.map((pr) => pr.id), dryRun: M.dryRun, merge: M.policy.merge, pid: process.pid })
  }

  // Measured from the end of the last tick, a long tick never reads as sleep.
  function noticeSleep() {
    if (lastTickEnd === null) {
      return
    }

    const slept = sleptMs(clock() - lastTickEnd, M.policy.tickSeconds * 1000)

    if (slept > 0) {
      wokeAt = clock()
      say('-', 'machine-slept', { minutes: Math.round(slept / 60_000) })
    }
  }

  // The PR's labels follow its ledger state. The ledger remembers what was
  // set, so a quiet tick makes no GitHub call. Labels only inform people:
  // a failure is kept on the PR's row and retried next tick, never counted
  // as the PR's error or allowed to stop the tick.
  async function syncStageLabels(pr) {
    const s = L.prs[pr.id]
    const wanted = stageLabels(s)
    const changes = labelChanges(s.stageLabels ?? [], wanted)

    if (!s.pr || (changes.add.length === 0 && changes.remove.length === 0)) {
      return
    }

    try {
      await gh.setStageLabels(M, s.pr, changes)
      s.stageLabels = wanted
      s.stageLabelError = null
    } catch (error) {
      s.stageLabelError = String(error?.message ?? error).slice(0, 300)
    }
  }

  async function tick() {
    L.beat('tick')
    erredThisTick.clear()
    unavailableThisTick.clear()
    outageThisTick = false

    try {
      noticeSleep()
      reloadManifest()
      applyCommands()
      const fetched = await driverStep('fetch', () => gh.fetchOrigin(M))
      await driverStep('outside-deps', () => gh.refreshOutsideDeps(M, L))
      await driverStep('watch-base', () => watchBase())

      for (const pr of M.prs) {
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

      if (!L.data.paused && !stopping) {
        const order = [...M.prs].sort((a, b) => b.priority - a.priority || a.order - b.order)

        for (const pr of order) {
          await guarded(pr, () => advance(pr))
        }
      }

      for (const pr of M.prs) {
        await syncStageLabels(pr)
      }

      // Here and not in finally: a tick that threw may have skipped a PR's
      // steps, or never reached GitHub.
      for (const pr of M.prs) {
        if (!erredThisTick.has(pr.id) && !unavailableThisTick.has(pr.id)) {
          L.prs[pr.id].tickErrors = 0
        }
      }

      if (!outageThisTick && L.data.githubUnavailable) {
        githubBack()
      }
    } finally {
      lastTickEnd = clock()
      L.save()
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
        notify(`rollout ${M.rollout}`, `${failedTicks} ticks in a row failed: ${message.slice(0, 100)}`)
      }

      try {
        L.event('-', 'tick-error', { error: String(error?.stack ?? error).slice(0, 2000), count: failedTicks })
        L.beat(`tick-error ${message.slice(0, 200)}`)
      } catch (writeError) {
        console.error(`tick error not logged: ${writeError?.message ?? writeError}`)
      }
    }
  }

  function finished() {
    return running.size === 0 && M.prs.every((pr) => L.prs[pr.id].state === 'merged')
  }

  async function finish() {
    const release = await gh.findReleasePr(M).catch(() => null)
    const cost = M.prs.reduce((sum, pr) => sum + L.prs[pr.id].costUsd, 0)
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

    L.save()
  }

  return {
    L,
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
    finished,
    finish,
    stop,
    isStopping: () => stopping,
  }
}

export async function runDriver(M) {
  const release = acquireLock(M)
  const driver = createDriver(M)
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
  const inbox = watchInbox(M)

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

    await inbox.wait(M.policy.tickSeconds * 1000)
  }
}
