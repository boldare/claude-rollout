import { parse } from 'yaml'
import { BUMPS, SEVERITIES } from './manifest.mjs'
import { matchesAny } from './glob.mjs'

// Rules every PR must follow no matter what its agent claims. Pure: the
// facts come from gh and git (see github.mjs), never from a model.
export function policyViolations(manifest, pr, facts) {
  const violations = []
  const paths = facts.files.flatMap((file) => [file.path, file.previousPath].filter(Boolean))

  for (const path of paths) {
    if (matchesAny(path, manifest.repo.forbid)) {
      violations.push(`touches forbidden path ${path}`)
    } else if (path.startsWith('.github/') && !pr.allowWorkflows) {
      violations.push(`touches ${path}; CI and workflow files need allowWorkflows on the PR in the manifest`)
    }
  }

  for (const line of facts.addedLines) {
    if (/(^|\/)package\.json$/.test(line.path) && /^\s*"version"\s*:/.test(line.text)) {
      violations.push(`changes a package version in ${line.path}`)
    }
  }

  const changesets = facts.files.filter((file) => isChangeset(file.path))

  if (changesets.some((file) => file.status === 'removed')) {
    violations.push('removes an existing changeset')
  }

  if (pr.changeset !== 'none' && !changesets.some((file) => file.status === 'added')) {
    violations.push('has no new changeset in .changeset/')
  }

  for (const changeset of facts.changesets) {
    const bump = highestBump(changeset.text)

    if (!bump) {
      violations.push(`${changeset.path}: cannot determine the bump from its frontmatter`)
    } else if (BUMPS.indexOf(bump) > BUMPS.indexOf(manifest.policy.maxBump)) {
      violations.push(`${changeset.path} asks for a ${bump} bump (max ${manifest.policy.maxBump})`)
    }
  }

  const texts = [
    ...paths.map((path) => ({ where: `file path ${path}`, text: path })),
    ...facts.addedLines.map((line) => ({ where: line.path, text: line.text })),
    { where: 'PR title', text: facts.pr?.title ?? '' },
    { where: 'PR body', text: facts.pr?.body ?? '' },
    ...facts.commits.map((commit) => ({ where: `commit ${commit.sha.slice(0, 7)}`, text: commit.message })),
  ]

  for (const word of manifest.repo.denylist) {
    const hit = texts.find((entry) => entry.text.toLowerCase().includes(word.toLowerCase()))

    if (hit) {
      violations.push(`mentions a denylisted term in ${hit.where}`)
    }
  }

  for (const commit of facts.commits) {
    if (commit.message.trim().includes('\n')) {
      violations.push(`commit ${commit.sha.slice(0, 7)} has more than one line`)
    }
  }

  return violations
}

export function outOfScope(manifest, pr, facts, briefScope = []) {
  const scope = pr.scope.length > 0 ? pr.scope : briefScope

  if (scope.length === 0) {
    return []
  }

  const allowed = [...scope, ...manifest.repo.alwaysInScope]

  return facts.files.map((file) => file.path).filter((path) => !matchesAny(path, allowed))
}

function isChangeset(path) {
  return /^\.changeset\/[^/]+\.md$/.test(path) && !/^\.changeset\/README\.md$/i.test(path)
}

// Parses the frontmatter the way @changesets/parse does (YAML between ---
// fences, comments, CRLF and flow style allowed). Null when it cannot tell,
// which the policy treats as a violation.
export function highestBump(text) {
  const match = text.match(/\s*---([^]*?)\r?\n\s*---(\s*(?:\n|$)[^]*)/)

  if (!match) {
    return null
  }

  let releases

  try {
    releases = parse(match[1])
  } catch {
    return null
  }

  if (!releases || typeof releases !== 'object' || Array.isArray(releases)) {
    return null
  }

  const bumps = Object.values(releases)

  if (bumps.length === 0 || bumps.some((bump) => !BUMPS.includes(bump))) {
    return null
  }

  return bumps.reduce((high, bump) => (BUMPS.indexOf(bump) > BUMPS.indexOf(high) ? bump : high))
}

// --admin only when the ruleset cannot be met the normal way: a PR the
// maintainer authored cannot get their approval on GitHub.
export function needsAdmin(manifest, facts) {
  const admin = manifest.repo.merge?.admin ?? 'auto'

  if (admin === true) {
    return true
  }

  return admin === 'auto' && (manifest.repo.maintainers ?? []).includes(facts.pr?.author)
}

// Merge states in which GitHub accepts a merge without a bypass.
const MERGEABLE_STATES = ['CLEAN', 'HAS_HOOKS', 'UNSTABLE']

// How the maintainer's approval reaches the gate, or null when none counts.
// Under manual the maintainer's own merge is the approval, and auto merges
// without one. Under human, PRs opened by the agents' account are approved
// with a normal review on GitHub. A maintainer cannot approve their own PR
// there, so maintainer-authored PRs use rollout approve.
export function approvalChannel(manifest, author) {
  if (manifest.policy.merge !== 'human') {
    return null
  }

  if (manifest.policy.approval === 'github' && !manifest.repo.maintainers.includes(author)) {
    return 'github'
  }

  return 'inbox'
}

const NO_APPROVAL = {
  manual: 'policy.merge is manual: no approval is needed. Merge the PR on GitHub once the driver says it is ready',
  auto: 'policy.merge is auto: no approval is needed. The driver merges once the gate passes, and rollout hold stops it',
}

// Why rollout approve does not count for this PR, or null when it does. An
// unknown author never gets the GitHub refusal.
export function approveRefusal(manifest, entry) {
  const refusal = NO_APPROVAL[manifest.policy.merge]

  if (refusal) {
    return refusal
  }

  if (entry.author && approvalChannel(manifest, entry.author) === 'github') {
    return `PR #${entry.pr} is approved on GitHub: review it there`
  }

  return null
}

// The latest review of each maintainer counts. Approved means at least one
// maintainer approved after the current patch appeared, and none asks for
// changes. Time, not the review's commit: GitHub moves a review's commit_id
// to new heads when stale reviews are not dismissed.
export function githubApproval(manifest, entry, facts) {
  const latest = new Map()

  for (const review of facts.reviews) {
    if (!manifest.repo.maintainers.includes(review.user) || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      continue
    }

    const known = latest.get(review.user)

    if (!known || Date.parse(review.at) >= Date.parse(known.at)) {
      latest.set(review.user, review)
    }
  }

  const reviews = [...latest.values()]

  if (reviews.some((review) => review.state === 'CHANGES_REQUESTED')) {
    return { approved: false, reason: 'a maintainer requested changes on GitHub' }
  }

  const since = Date.parse(entry.patchSince ?? entry.verified?.at ?? 0)
  const approval = reviews.find((review) => review.state === 'APPROVED' && Date.parse(review.at) >= since)

  if (approval) {
    return { approved: true, by: approval.user, at: approval.at }
  }

  const stale = reviews.some((review) => review.state === 'APPROVED')

  return {
    approved: false,
    reason: stale
      ? `the GitHub approval is for an older patch; approve PR #${facts.pr.number} again`
      : `awaiting a maintainer review on GitHub (approve PR #${facts.pr.number})`,
  }
}

// An alert without a security level ranks by the analyser's severity. Any
// other severity, such as note or none, never counts.
const PLAIN_SEVERITIES = { error: 'medium', warning: 'low' }

function alertLevel(alert) {
  if (SEVERITIES.includes(alert.securitySeverity)) {
    return alert.securitySeverity
  }

  return PLAIN_SEVERITIES[alert.severity] ?? null
}

function shortSha(sha) {
  return sha ? sha.slice(0, 7) : 'unknown'
}

function shown(value) {
  return value ?? '?'
}

// What new code scanning alerts on the PR head ask for. New means open on the
// head and not open on the base. An alert from an older commit means the
// head has not been analysed yet, so the gate waits for it.
export function codeScanningFindings(manifest, facts) {
  const { action, minSeverity } = manifest.repo.codeScanning

  if (action === 'ignore') {
    return { action: 'none', reasons: [] }
  }

  const scan = facts.codeScanning

  if (!scan || scan.available === false) {
    return { action: 'none', reasons: [] }
  }

  const baseOpen = new Set(scan.baseOpen)
  const floor = SEVERITIES.indexOf(minSeverity)
  const counted = scan.alerts
    .filter((alert) => !baseOpen.has(alert.number))
    .map((alert) => ({ ...alert, level: alertLevel(alert) }))
    .filter((alert) => alert.level !== null && SEVERITIES.indexOf(alert.level) >= floor)

  if (counted.length === 0) {
    return { action: 'none', reasons: [] }
  }

  const head = facts.pr?.headRefOid
  const stale = counted.filter((alert) => alert.sha !== head)

  if (stale.length > 0) {
    return {
      action: 'wait',
      reasons: stale.map(
        (alert) => `code scanning has not analysed ${shortSha(head)} yet (alert #${alert.number} is from ${shortSha(alert.sha)})`,
      ),
    }
  }

  return {
    action,
    reasons: counted.map(
      (alert) =>
        `${shown(alert.tool)} ${shown(alert.rule)} (${alert.level}) ${shown(alert.path)}:${shown(alert.line)}: ${shown(alert.message)} ${shown(alert.url)}`,
    ),
  }
}

// The gate's last verdict while it still speaks for the PR's current
// verification. A fix run or a moved head ends that verification without
// touching its gate, so a "ready" or "after PR #n" from before then holds
// nothing: the next gate run decides again.
export function currentGate(entry) {
  if (entry.state !== 'verified' || !entry.gate?.at || !entry.verified?.at) {
    return null
  }

  return Date.parse(entry.gate.at) >= Date.parse(entry.verified.at) ? entry.gate : null
}

// The merge gate. Returns the next action for a verified PR:
// merge, rebase, fix (send back to the implementer), wait, or block (human).
export function judge(manifest, pr, entry, facts) {
  const reasons = []

  function verdict(action, reason) {
    return { action, reasons: reason ? [...reasons, reason] : reasons }
  }

  if (facts.halted) {
    return verdict('wait', `rollout halted: ${facts.halted}`)
  }

  if (entry.held) {
    return verdict('wait', `held (rollout release ${pr.id})`)
  }

  const githubPr = facts.pr

  if (!githubPr) {
    return verdict('block', 'no PR found for the branch')
  }

  // The maintainer may merge it between sync and the gate. Nothing is left
  // for them to do.
  if (githubPr.state === 'MERGED') {
    return verdict('wait', 'merged on GitHub (the next sync records it)')
  }

  if (githubPr.state !== 'OPEN') {
    return verdict('block', `PR is ${githubPr.state}`)
  }

  if (
    matchesAny(githubPr.headRefName, manifest.repo.neverMerge.branches) ||
    manifest.repo.neverMerge.titles.includes(githubPr.title.trim())
  ) {
    return verdict('block', 'PR matches neverMerge (release PR): publishing is a human decision')
  }

  if (githubPr.isDraft) {
    return verdict('block', 'PR is a draft')
  }

  if (githubPr.baseRefName !== manifest.repo.base) {
    return verdict('block', `PR base is ${githubPr.baseRefName}, expected ${manifest.repo.base}`)
  }

  if (githubPr.headRefName !== pr.branch) {
    return verdict('block', `PR head is ${githubPr.headRefName}, expected ${pr.branch}`)
  }

  if (!githubPr.labels.includes(manifest.label)) {
    return verdict('block', `PR lacks label ${manifest.label}`)
  }

  if (facts.depsPending.length > 0) {
    return verdict('wait', `dependencies not merged: ${facts.depsPending.join(', ')}`)
  }

  if (!entry.verified || entry.verified.patchId !== facts.patchId) {
    return verdict('wait', 'not verified for the current patch')
  }

  // No channel under manual and auto: no approval counts there. A record the
  // driver wrote for a GitHub review must never pass for a rollout approve
  // after the manifest's channel changes. Old records have no channel.
  const channel = approvalChannel(manifest, githubPr.author)
  const approvedInInbox = entry.approved?.patchId === facts.patchId && entry.approved.channel !== 'github'

  if (channel === 'github') {
    const approval = githubApproval(manifest, entry, facts)

    if (!approval.approved) {
      return verdict('wait', approval.reason)
    }
  } else if (channel === 'inbox' && !approvedInInbox) {
    return verdict('wait', 'awaiting human approval (rollout approve)')
  }

  const violations = policyViolations(manifest, pr, facts)

  if (violations.length > 0) {
    reasons.push(...violations)

    return verdict('fix')
  }

  if (!facts.baseIsAncestor || githubPr.mergeable === 'CONFLICTING') {
    return verdict('rebase', `branch is behind ${manifest.repo.base}`)
  }

  if (githubPr.mergeable !== 'MERGEABLE') {
    return verdict('wait', `mergeable state is ${githubPr.mergeable}`)
  }

  if (facts.checks.state === 'red') {
    reasons.push(...facts.checks.failing)

    return verdict('fix', 'CI is red on the PR head')
  }

  if (facts.checks.state !== 'green') {
    return verdict(
      'wait',
      `CI pending (missing: ${facts.checks.missing.join(', ') || '-'}; running: ${facts.checks.pending.join(', ') || '-'})`,
    )
  }

  const scanning = codeScanningFindings(manifest, facts)

  if (scanning.action !== 'none') {
    return { action: scanning.action, reasons: scanning.reasons, kind: 'code-scanning' }
  }

  if (facts.mainChecks.state !== 'green') {
    return verdict('wait', `${manifest.repo.base} is not green (${facts.mainChecks.state})`)
  }

  // Without a bypass, GitHub's own ruleset has the last word (reviews, code
  // scanning, code quality). Waiting here beats a refused merge.
  if (
    manifest.policy.merge !== 'manual' &&
    !needsAdmin(manifest, facts) &&
    githubPr.mergeStateStatus &&
    !MERGEABLE_STATES.includes(githubPr.mergeStateStatus)
  ) {
    return verdict(
      'wait',
      githubPr.mergeStateStatus === 'BLOCKED'
        ? `GitHub still blocks the merge (a ruleset requirement such as code scanning results or a review is not met)`
        : `GitHub merge state is ${githubPr.mergeStateStatus}`,
    )
  }

  return verdict('merge')
}
