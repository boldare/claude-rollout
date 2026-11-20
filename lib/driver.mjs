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
import { checkClaim, gateCheck } from './driver/claims.ts'
import { applyCommands } from './driver/commands.ts'
import { mergeCandidate, mergeNext, watchBase } from './driver/gate.ts'
import { claimReport, headsKey, launch, launchDelegate, onBriefDone, onDelegateDone, onDone, owedCleanup } from './driver/runs.ts'
import { handleFeedback, sync } from './driver/sync.ts'
import { sleptMs } from './machine.mjs'
import { labelChanges, ourLabel, stageLabels } from './stage.mjs'

export { briefDrift, doneDetail } from './driver/runs.ts'

const MAX_TICK_ERRORS = 5
const UNAVAILABLE_NOTICE_MINUTES = 30
const AFTER_SLEEP_MS = 2 * 60_000
const SLOW_TICK_QUIET_MS = 10 * 60_000
const SLOT = { kind: 'waiting', code: 'slot' }

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

// The detail of a status event. Its status kind is `status`, because a `kind`
// would replace the event's own. A merged PR has neither status nor code.
function statusDetail(entry) {
  return { stage: entry.stage ?? null, status: entry.status?.kind ?? null, code: entry.status?.code ?? null }
}

function statusKey(entry) {
  return JSON.stringify(statusDetail(entry))
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
  // One controller per agent run, so a merge on GitHub stops that PR's agent alone.
  const agentRuns = new Map()
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

  function toFix(pr, reason, note) {
    transitions.toFix(ledger.prs[pr.id], reason, note, { code: transitions.fixReasonCode(reason), at: now() })
    say(pr.id, 'needs-fix', { reason })
  }

  // The runs start an agent only once its worktree is ready. A PR that merged
  // meanwhile gets a signal that is already aborted, so no agent starts.
  async function stoppableAgent(runManifest, pr, options) {
    const controller = new AbortController()

    if (ledger.prs[pr.id].stage === 'merged') {
      controller.abort()
    }

    agentRuns.set(pr.id, controller)

    try {
      return await runAgent(runManifest, pr, { ...options, signal: controller.signal })
    } finally {
      if (agentRuns.get(pr.id) === controller) {
        agentRuns.delete(pr.id)
      }
    }
  }

  function stopRun(id) {
    agentRuns.get(id)?.abort()
  }

  // The commands read the manifest and the ledger through these, so a reload applies to them too.
  const commandContext = {
    manifest,
    ledger,
    running,
    say,
    now,
    inbox: () => drainInbox(manifest),
    briefWritten: (id) => existsSync(manifest.all.find((pr) => pr.id === id).brief),
    approveRefusal: (entry) => approveRefusal(manifest, entry),
  }

  // For a dispute this is the verify run: onDone ends it before rejected runs.
  function lastEndedRun(id) {
    const ended = Object.entries(ledger.data.runs ?? {}).filter(
      ([, record]) => record.id === id && record.role !== 'delegate' && record.endedAt,
    )

    ended.sort(([, left], [, right]) => Date.parse(left.endedAt) - Date.parse(right.endedAt))

    return ended.at(-1)?.[0] ?? null
  }

  // The runs, their ends and the pre-verify commands (lib/driver/runs.ts) reach
  // the closure's state, the disk and GitHub through these.
  const runContext = {
    manifest,
    ledger,
    running,
    commandContext,
    say,
    notify,
    now,
    cleanup,
    runAgent: stoppableAgent,
    runCommand,
    isStopping: () => stopping,
    reads: () => reads,
    toFix,
    gateCheck: (pr, entry, check) => gateCheck({ say }, pr, entry, check),
    lastEndedRun,
    localConfigRemoved,
    questionHash,
    delegateTakes: (entry) => delegateTakes(manifest, entry),
    approvalChannel: (author) => approvalChannel(manifest, author),
    github: gh,
    prompts: {
      implementPrompt,
      fixPrompt,
      resumeFreshPrompt,
      verifyPrompt,
      briefWritePrompt,
      briefReviewPrompt,
      briefReviewNotes,
      delegatePrompt,
      findingsNote,
      preVerifyNote,
    },
    worktree: { worktreePath, prepareWorktree, preparePreview, removePreview, inspectWorktree, resetWorktree },
    records: { reserveRunName, startRun, endRun, recordAnswers, recordVerdict, recordFindings, recheckedFindings },
    checks: { briefGates, briefOutcome, commandResult, criteriaOutcome, preVerifyOutcome },
    files: { existsSync, mkdirSync, writeFileSync, dirname },
    raiseEffort,
    sentences,
    randomUUID,
  }

  // What the PR is on GitHub (lib/driver/sync.ts).
  const syncContext = {
    manifest,
    ledger,
    running,
    commandContext,
    say,
    now,
    cleanup,
    stopRun,
    reads: () => reads,
    localConfigRemoved,
    ourLabel,
    collectFacts,
    github: gh,
    worktree: { alignWorktree },
  }

  // The claim check after READY (lib/driver/claims.ts).
  const claimContext = {
    manifest,
    ledger,
    runContext,
    say,
    now,
    reads: () => reads,
    slots,
    isStopping: () => stopping,
    toFix,
    localConfigRemoved,
    collectFacts,
    github: gh,
    judge: { policyViolations, codeScanningFindings, outOfScope, undeclaredOutOfScope },
    codeScanningNote,
    checks: { verifyCriteria, selectCriteria },
    worktree: { alignWorktree },
  }

  // The merge gate and the base watch (lib/driver/gate.ts).
  const gateContext = {
    manifest,
    ledger,
    running,
    say,
    notify,
    now,
    cleanup,
    isStopping: () => stopping,
    reads: () => reads,
    guarded,
    toFix,
    collectFacts,
    judge: judgeGate,
    currentGate,
    approvalChannel,
    githubApproval,
    codeScanningNote,
    github: gh,
    worktree: { rebaseWorktree },
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
      launchDelegate(runContext, pr)
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
      await owedCleanup(runContext, pr, entry)
    }

    // A run state with no run behind it (an onDone that threw) resumes.
    transitions.recoverRun(entry, { refund: false, at: now() })

    const depsReady = gh.depsPending(manifest, pr, ledger).length === 0

    switch (entry.state) {
      case 'pending':
        if (slots()) {
          if (existsSync(pr.brief)) {
            if (depsReady) {
              launch(runContext, pr, 'implement')
            }
          } else if (depsReady || briefAhead(pr, entry)) {
            launch(runContext, pr, 'brief')
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
          await claimReport(runContext, pr, entry, entry.ready)
          break
        }

        if (!slots() || (!entry.pr && !depsReady)) {
          idleStatus(pr, entry, depsReady)
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
        if (slots() && (entry.pr || depsReady)) {
          launch(runContext, pr, 'fix', { reason: entry.fixReason, note: entry.fixNote })
        } else {
          idleStatus(pr, entry, depsReady)
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
          askDelegate(pr, entry)
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
      applyCommands(commandContext)
      const fetched = await driverStep('fetch', () => gh.fetchOrigin(manifest))
      await driverStep('outside-deps', () => gh.refreshOutsideDeps(manifest, ledger))
      await driverStep('watch-base', () => watchBase(gateContext))

      for (const pr of manifest.prs) {
        await guarded(pr, () => sync(syncContext, pr))
        await guarded(pr, () => handleFeedback(syncContext, pr))
      }

      // The gate runs before slots are handed out: a conflict it finds on a
      // high-priority PR then competes for a slot in this same tick, ahead
      // of new briefs for lower-priority PRs. A stale base would mislead the
      // gate and the rebase, so a tick without a fetch merges nothing.
      if (fetched) {
        await mergeNext(gateContext)
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
    applyCommands: () => applyCommands(commandContext),
    launch: (pr, role, options) => launch(runContext, pr, role, options),
    onDone: (pr, role, result, options) => onDone(runContext, pr, role, result, options),
    onBriefDone: (pr, result, heads, gates) => onBriefDone(runContext, pr, result, heads, gates),
    onDelegateDone: (pr, result, options) => onDelegateDone(runContext, pr, result, options),
    advance,
    mergeCandidate: (pr, options) => mergeCandidate(gateContext, pr, options),
    mergeNext: () => mergeNext(gateContext),
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
