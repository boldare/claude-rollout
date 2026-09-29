import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadManifest, raiseEffort } from './manifest.mjs'
import { acquireLock, drainInbox, freshPr, openLedger, recordVerdict, reserveRunName, watchInbox } from './ledger.mjs'
import { approvalChannel, githubApproval, judge, outOfScope, policyViolations } from './judge.mjs'
import { briefReviewPrompt, briefWritePrompt, fixPrompt, implementPrompt, resumeFreshPrompt, verifyPrompt } from './prompts.mjs'
import { children, runAgent, stopAllAgents } from './spawn.mjs'
import { notify } from './notify.mjs'
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

function minutesSince(iso) {
  return iso ? (Date.now() - Date.parse(iso)) / 60_000 : Infinity
}

function now() {
  return new Date().toISOString()
}

const HEADLINES = {
  implement: (output) => output?.status ?? null,
  fix: (output) => output?.status ?? null,
  verify: (output) => output?.verdict ?? null,
  brief: (output) => (output?.questions?.length > 0 ? 'QUESTIONS' : 'BRIEF'),
}

// The detail of every *-done event. `run` pairs it with its *-start.
export function doneDetail(role, run, result) {
  return {
    run,
    ok: result.ok,
    result: result.ok ? HEADLINES[role](result.output) : null,
    cost: result.costUsd,
    seconds: result.seconds,
    denials: result.denials?.length ?? 0,
    stopped: Boolean(result.stopped),
    error: result.error?.slice(0, 200) ?? null,
  }
}

export function createDriver(M) {
  const L = openLedger(M)
  const running = new Map()
  let stopping = false
  let manifestMtime = statSync(`${M.dir}/manifest.yaml`).mtimeMs

  // Edits to manifest.yaml apply on the next tick without a restart (and
  // without stopping running agents). An invalid edit is reported and ignored.
  function reloadManifest() {
    const mtime = statSync(`${M.dir}/manifest.yaml`).mtimeMs

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

  function toFix(pr, reason, note) {
    const s = L.prs[pr.id]
    s.state = 'needs_fix'
    s.fixReason = reason
    s.fixNote = note
    say(pr.id, 'needs-fix', { reason })
  }

  function queueNote(id, text) {
    const s = L.prs[id]
    s.pendingNote = [s.pendingNote, text].filter(Boolean).join('\n\n')
  }

  // Commands from /rollout: approve, note, retry, hold, release, pause, resume, unhalt.
  function applyCommands() {
    for (const command of drainInbox(M)) {
      if ((command.cmd === 'hold' || command.cmd === 'release') && !command.id) {
        say('-', 'command-rejected', { command: command.cmd, reason: 'needs a PR id' })
        continue
      }

      const s = command.id ? L.prs[command.id] : null
      const pr = command.id ? M.all.find((item) => item.id === command.id) : null

      if (command.id && !s) {
        say('-', 'command-rejected', { command: command.cmd, reason: `unknown PR ${command.id}` })
        continue
      }

      switch (command.cmd) {
        case 'approve':
          approve(pr, s, command)
          break

        case 'note':
          if (s.state === 'blocked' && s.blocked?.kind === 'brief-questions') {
            queueNote(command.id, command.text)
            s.state = 'pending'
            s.blocked = null
            say(command.id, 'brief-answered')
          } else if (running.has(command.id) || s.state === 'pending') {
            queueNote(command.id, command.text)
            say(command.id, 'note-queued', { state: s.state })
          } else if (s.state === 'verified' || s.state === 'ready_claimed') {
            s.verified = null
            s.attempts.fix = Math.min(s.attempts.fix, M.policy.attempts.fix - 1)
            toFix(pr, 'request from the maintainer', command.text)
          } else if (s.state === 'merged') {
            say(command.id, 'command-rejected', { command: 'note', reason: 'already merged' })
          } else {
            s.attempts.fix = Math.min(s.attempts.fix, M.policy.attempts.fix - 1)
            toFix(pr, 'answer from the maintainer', command.text)
          }
          break

        case 'retry':
          s.attempts = { implement: 0, fix: 0, verify: 0, brief: 0 }
          s.tickErrors = 0
          s.retryAfter = null
          s.state = s.pr || s.sessionId ? 'interrupted' : 'pending'
          s.interruptedRole = s.claimedSha && !s.verified ? 'verify' : 'fix'
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

        default:
          say('-', 'command-rejected', { command: command.cmd })
      }
    }
  }

  // An approval names the exact verified head and patch the maintainer saw
  // on the card, and must be posted after that verification finished.
  function approve(pr, s, command) {
    const reject = (reason) => say(pr.id, 'approval-rejected', { reason }, `approval rejected: ${reason}`)

    if (s.state !== 'verified' || !s.verified) {
      return reject(`state is ${s.state}, not verified`)
    }

    if (s.author && approvalChannel(M, { pr: { author: s.author } }) === 'github') {
      return reject(`PR #${s.pr} is approved on GitHub: review it there`)
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

    s.approved = { patchId: s.verified.patchId, sha: s.verified.sha, at: now() }
    say(
      pr.id,
      'approved',
      { sha: s.verified.sha.slice(0, 7) },
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
    })().catch((error) => ({ ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0 }))

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

    const answers = s.pendingNote
    s.pendingNote = null
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
        result = { ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0 }
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
          prompt: briefWritePrompt(M, pr, s, answers),
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
      }
    })().catch((error) => ({ ok: false, error: String(error), costUsd: 0, denials: [], seconds: 0 }))

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
        `the brief needs your decision: ${out.questions[0].slice(0, 100)} (rollout card ${pr.id}, then rollout note ${pr.id} "...")`,
      )
      return
    }

    mkdirSync(dirname(pr.brief), { recursive: true })
    writeFileSync(pr.brief, `${out.brief.trim()}\n`)
    writeFileSync(pr.brief.replace(/\.md$/, '.review-notes.md'), `${out.notes.trim()}\n`)
    s.briefScope = out.expectedFiles
    s.briefAt = now()
    s.failStreak = 0
    s.state = 'pending'
    say(pr.id, 'brief-written', { files: out.expectedFiles.length, bump: out.changesetBump })
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

    if (result.account) {
      L.data.paused = true
      say('-', 'paused', { reason: result.error?.slice(0, 200) }, 'account limit reached; rollout paused (rollout resume)')
    }

    if (!result.stopped) {
      s.failStreak = (s.failStreak ?? 0) + 1
      s.retryAfter = new Date(Date.now() + Math.min(2 ** s.failStreak, 30) * 60_000).toISOString()
    }

    // A session that never reached disk (the machine died right after the
    // start) cannot be resumed; the next run starts a fresh one.
    if (role !== 'verify' && result.sessionMissing) {
      s.sessionId = null
    }

    s.state = 'interrupted'
    s.interruptedRole = role
  }

  async function onDone(pr, role, result, { sha, run }) {
    const s = L.prs[pr.id]
    s.costUsd = Number((s.costUsd + (result.costUsd ?? 0)).toFixed(4))
    say(pr.id, `${role}-done`, doneDetail(role, run, result))

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
      say(pr.id, 'blocked', { reason: s.blocked.kind }, `blocked (${s.blocked.kind}): ${s.blocked.question.slice(0, 120)}`)
      return
    }

    const problem = await checkReport(pr, out)

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
  // PR from this branch into the base.
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
      return `PR #${out.pr} could not be read (${String(error).slice(0, 200)}). Report the number of your PR.`
    }

    return null
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

    const how =
      M.policy.merge === 'manual'
        ? 'review it; the driver tells you when it is ready to merge'
        : approvalChannel(M, { pr: { author: s.author } }) === 'github'
          ? 'review and approve it on GitHub'
          : `check the card, then: rollout approve ${pr.id}`
    say(pr.id, 'verified', { sha: sha.slice(0, 7) }, `verified PR #${s.pr}: ${how}`)

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
      say(pr.id, wasOurs ? 'merged' : 'merged-outside-driver', { pr: s.pr })

      const mergeSha = await gh.mergeCommit(M, s.pr).catch(() => null)

      if (mergeSha) {
        s.mergeSha = mergeSha
        L.data.lastMerge = { id: pr.id, sha: mergeSha, at: now() }
      }

      await cleanup(pr)
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
      const facts = await gh.collectFacts(M, pr, s, L)

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

  async function cleanup(pr) {
    await removeWorktree(M, pr).catch(() => {})
    await gh.deleteRemoteBranch(M, pr.branch).catch(() => {})
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

  async function checkClaim(pr) {
    const s = L.prs[pr.id]
    const p = await gh.viewPr(M, s.pr)
    s.author = p.author

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

    const facts = await gh.collectFacts(M, pr, s, L)

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

      default:
        break
    }
  }

  async function mergeCandidate(pr) {
    const s = L.prs[pr.id]
    const facts = await gh.collectFacts(M, pr, s, L)
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

    if (verdict.action === 'block') {
      s.state = 'blocked'
      s.blocked = { kind: 'gate', question: verdict.reasons.join('; '), evidence: '' }
      say(pr.id, 'blocked', { reason: 'gate' }, `gate blocked: ${verdict.reasons.join('; ').slice(0, 120)}`)
      return false
    }

    if (verdict.action === 'fix') {
      s.verified = null
      toFix(pr, 'merge gate', `The merge gate sent the PR back:\n- ${verdict.reasons.join('\n- ')}`)
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

    // A short delay after approval, so an approval nobody expected can be
    // noticed (it is always notified) and stopped with rollout pause.
    const approvedAt = approvalChannel(M, facts) === 'github' ? githubApproval(M, s, facts).at : s.approved?.at
    const approvedFor = (Date.now() - Date.parse(approvedAt ?? now())) / 1000

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
  // per PR and escalate that PR alone.
  async function guarded(pr, task) {
    const s = L.prs[pr.id]

    try {
      const result = await task()
      s.tickErrors = 0

      return result
    } catch (error) {
      s.tickErrors = (s.tickErrors ?? 0) + 1
      s.lastError = String(error?.message ?? error).slice(0, 1000)
      say(pr.id, 'error', { error: s.lastError.slice(0, 300), count: s.tickErrors })

      if (s.tickErrors >= MAX_TICK_ERRORS && !running.has(pr.id)) {
        s.state = 'escalated'
        say(pr.id, 'escalated', { reason: 'repeated errors' }, `repeated errors, needs you: ${s.lastError.slice(0, 100)}`)
      }

      return false
    }
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

  async function tick() {
    L.beat('tick')

    try {
      reloadManifest()
      applyCommands()
      await gh.fetchOrigin(M)
      await gh.refreshOutsideDeps(M, L)
      await watchBase()

      for (const pr of M.prs) {
        await guarded(pr, () => sync(pr))
        await guarded(pr, () => handleFeedback(pr))
      }

      // The gate runs before slots are handed out: a conflict it finds on a
      // high-priority PR then competes for a slot in this same tick, ahead
      // of new briefs for lower-priority PRs.
      await mergeNext()

      if (!L.data.paused && !stopping) {
        const order = [...M.prs].sort((a, b) => b.priority - a.priority || a.order - b.order)

        for (const pr of order) {
          await guarded(pr, () => advance(pr))
        }
      }
    } finally {
      L.save()
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

  return { L, running, start, tick, applyCommands, finished, finish, stop, isStopping: () => stopping }
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
    try {
      await driver.tick()
    } catch (error) {
      driver.L.event('-', 'tick-error', { error: String(error?.stack ?? error).slice(0, 2000) })
      driver.L.beat(`tick-error ${String(error?.message ?? error).slice(0, 200)}`)
      console.error(`tick error: ${error?.message ?? error}`)
    }

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
