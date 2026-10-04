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
const WITH_BLOCK_REASON = new Set(['blocked', 'escalated'])

export function slug(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

function reasonOf(s) {
  // Verified, but another PR holds "ready" under merge: manual.
  if (s.state === 'verified' && s.gate?.after) {
    return slug(`after-pr-${s.gate.after}`)
  }

  if (WITH_FIX_REASON.has(s.state)) {
    return slug(s.fixReason)
  }

  if (WITH_BLOCK_REASON.has(s.state)) {
    return slug(s.blocked?.kind)
  }

  return ''
}

export function stageLabels(s) {
  if (!s.pr || !LABELLED.has(s.state)) {
    return []
  }

  const reason = reasonOf(s)
  const stage = `${STAGE_PREFIX}${slug(s.state)}`

  return reason ? [stage, `${REASON_PREFIX}${reason}`] : [stage]
}

function ours(label) {
  return label.startsWith(STAGE_PREFIX) || label.startsWith(REASON_PREFIX)
}

// Labels to add and remove so the PR carries exactly the wanted ones of ours.
// Anyone else's labels are left alone.
export function labelChanges(current, wanted) {
  return {
    add: wanted.filter((label) => !current.includes(label)),
    remove: current.filter((label) => ours(label) && !wanted.includes(label)),
  }
}
