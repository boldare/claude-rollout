// Labels that show on GitHub where a PR stands in the rollout: one for the
// stage (the ledger state) and, while the PR waits on something, one for the
// reason. Someone who opens the PR sees "rejected by the verifier" or "CI is
// red" without the local ledger. Only these two prefixes are ours to change.

export const STAGE_PREFIX = 'rollout-stage:'
export const REASON_PREFIX = 'rollout-reason:'

// States in which the PR exists. Before it (pending, briefing) there is
// nothing to label, and a merged PR keeps no stage.
const LABELLED = new Set([
  'implementing',
  'ready_claimed',
  'verifying',
  'needs_fix',
  'fixing',
  'verified',
  'blocked',
  'escalated',
  'interrupted',
])
const WITH_FIX_REASON = new Set(['needs_fix', 'fixing'])

export function slug(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

function reasonOf(entry) {
  // Verified, but another PR holds "ready" under merge: manual.
  if (entry.state === 'verified' && entry.gate?.after) {
    return slug(`after-pr-${entry.gate.after}`)
  }

  if (WITH_FIX_REASON.has(entry.state)) {
    return slug(entry.fixReason)
  }

  if (entry.state === 'blocked') {
    return slug(entry.blocked?.kind)
  }

  // Not blocked.kind: a block answered earlier stays in the ledger.
  if (entry.state === 'escalated') {
    return slug(entry.escalation)
  }

  return ''
}

export function stageLabels(entry) {
  if (!entry.pr || !LABELLED.has(entry.state)) {
    return []
  }

  const reason = reasonOf(entry)
  const stage = `${STAGE_PREFIX}${slug(entry.state)}`

  return reason ? [stage, `${REASON_PREFIX}${reason}`] : [stage]
}

export function ourLabel(label) {
  return label.startsWith(STAGE_PREFIX) || label.startsWith(REASON_PREFIX)
}

// Labels to add and remove so the PR carries exactly the wanted ones of ours.
// Anyone else's labels are left alone.
export function labelChanges(current, wanted) {
  return {
    add: wanted.filter((label) => !current.includes(label)),
    remove: current.filter((label) => ourLabel(label) && !wanted.includes(label)),
  }
}
