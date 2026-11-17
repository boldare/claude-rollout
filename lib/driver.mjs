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
import { applyCommands } from './driver/commands.ts'
import {
  claimReport,
  EVIDENCE_CHARS,
  headsKey,
  launch,
  launchDelegate,
  launchPreVerify,
  onBriefDone,
  onDelegateDone,
  onDone,
  owedCleanup,
  passHolds,
  preVerifyJob,
} from './driver/runs.ts'
import { sleptMs } from './machine.mjs'
import { labelChanges, ourLabel, stageLabels } from './stage.mjs'

export { briefDrift, doneDetail } from './driver/runs.ts'

const MAX_TICK_ERRORS = 5
const UNAVAILABLE_NOTICE_MINUTES = 30
const AFTER_SLEEP_MS = 2 * 60_000
const SLOW_TICK_QUIET_MS = 10 * 60_000
// The gate codes that ask a maintainer for an approval. changes-requested is
// left out: the maintainer who asked for changes has seen the PR.
const APPROVAL_NOTICE_CODES = ['awaiting-github-review', 'stale-github-review', 'awaiting-inbox-approval']
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
    runAgent,
    runCommand,
    isStopping: () => stopping,
    reads: () => reads,
    toFix,
    gateCheck,
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

    // A PR waiting for its verifier is read as a claim is: its commands passed, or its verifier failed or was cut off.
    const waitsToVerify = entry.stage === 'verify' && entry.status?.kind === 'waiting'

    if (
      !entry.pr ||
      running.has(pr.id) ||
      !(['verified', 'ready_claimed', 'needs_fix'].includes(entry.state) || waitsToVerify) ||
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

    const job = preVerifyJob(runContext, entry)

    if (job.steps.length > 0 && !passHolds(entry, job)) {
      launchPreVerify(runContext, pr, job)
      return
    }

    // Fixed at launch: the verifier's prompt and the judgment of its verdict read this list, never a reloaded manifest or catalog.
    entry.verifyCriteria = [...verifyCriteria(manifest.gates.verify), ...(await catalogCriteria(pr, facts))]
    launch(runContext, pr, 'verify', { sha: entry.claimedSha })
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
          await checkClaim(pr)
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
      applyCommands(commandContext)
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
    applyCommands: () => applyCommands(commandContext),
    launch: (pr, role, options) => launch(runContext, pr, role, options),
    onDone: (pr, role, result, options) => onDone(runContext, pr, role, result, options),
    onBriefDone: (pr, result, heads, gates) => onBriefDone(runContext, pr, result, heads, gates),
    onDelegateDone: (pr, result, options) => onDelegateDone(runContext, pr, result, options),
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
