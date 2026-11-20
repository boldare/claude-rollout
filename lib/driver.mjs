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
import { gateCheck } from './driver/claims.ts'
import { applyCommands } from './driver/commands.ts'
import { mergeCandidate, mergeNext } from './driver/gate.ts'
import * as loop from './driver/loop.ts'
import { launch, onBriefDone, onDelegateDone, onDone } from './driver/runs.ts'
import { sleptMs } from './machine.mjs'
import { labelChanges, ourLabel, stageLabels } from './stage.mjs'

export { briefDrift, doneDetail } from './driver/runs.ts'

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

// One question of a blocked PR, so the delegate is asked about it only once.
// It stays here because tsc has no types for node:crypto.
function questionHash(blocked) {
  return createHash('sha256')
    .update(`${blocked.kind}\n${blocked.question ?? ''}`)
    .digest('hex')
    .slice(0, 16)
}

export function delegateAllowed(manifest, entry) {
  return loop.delegateAllowed(manifest, entry, questionHash)
}

// A question the delegate takes notifies once, through its answer or escalation.
export function delegateTakes(manifest, entry) {
  return loop.delegateTakes(manifest, entry, questionHash)
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
  const manifestFile = `${manifest.dir}/manifest.yaml`
  // A default parameter cannot see the ledger this body opens.
  const notify = notifyOption ?? createNotifier(manifest, { log: (kind, detail) => ledger.event('-', kind, detail) })
  const running = new Map()
  const state = loop.freshState({ manifest, ledger }, mtimeOf(manifestFile))

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

  // The contexts below are built before the loop's, and call into it only once the driver runs.
  const toFix = (pr, reason, note) => loop.toFix(loopContext, pr, reason, note)

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
  // the driver's state, the disk and GitHub through these.
  const runContext = {
    manifest,
    ledger,
    running,
    commandContext,
    say,
    notify,
    now,
    cleanup,
    runAgent: (runManifest, pr, options) => loop.stoppableAgent(loopContext, runManifest, pr, options),
    runCommand,
    isStopping: () => state.stopping,
    reads: () => state.reads,
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
    stopRun: (id) => loop.stopRun(loopContext, id),
    reads: () => state.reads,
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
    reads: () => state.reads,
    slots,
    isStopping: () => state.stopping,
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
    isStopping: () => state.stopping,
    reads: () => state.reads,
    guarded: (pr, task) => loop.guarded(loopContext, pr, task),
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

  // The start, the ticks, the advance of every PR and the stop (lib/driver/loop.ts).
  const loopContext = {
    manifest,
    ledger,
    running,
    state,
    say,
    notify,
    now,
    clock,
    commandContext,
    runContext,
    syncContext,
    claimContext,
    gateContext,
    slots,
    lastEndedRun,
    questionHash,
    runAgent,
    stopAllAgents,
    liveChildren: () => children.size,
    sleep,
    pid: process.pid,
    loadManifest,
    manifestMtime: () => mtimeOf(manifestFile),
    existsSync,
    freshPr,
    tickNote,
    sleptMs,
    stageLabels,
    labelChanges,
    runtimeSummary,
    github: gh,
  }

  return {
    ledger,
    running,
    start: () => loop.start(loopContext),
    tick: () => loop.tick(loopContext),
    runTick: () => loop.runTick(loopContext),
    applyCommands: () => applyCommands(commandContext),
    launch: (pr, role, options) => launch(runContext, pr, role, options),
    onDone: (pr, role, result, options) => onDone(runContext, pr, role, result, options),
    onBriefDone: (pr, result, heads, gates) => onBriefDone(runContext, pr, result, heads, gates),
    onDelegateDone: (pr, result, options) => onDelegateDone(runContext, pr, result, options),
    advance: (pr) => loop.advance(loopContext, pr),
    mergeCandidate: (pr, options) => mergeCandidate(gateContext, pr, options),
    mergeNext: () => mergeNext(gateContext),
    finished: () => loop.finished(loopContext),
    finish: () => loop.finish(loopContext),
    stop: () => loop.stop(loopContext),
    isStopping: () => state.stopping,
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
