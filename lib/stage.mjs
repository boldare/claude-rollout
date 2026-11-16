// Labels that show on GitHub where a PR stands in the rollout: its stage and
// the code of the status the driver stored. Someone who opens the PR sees
// verify and dispute without the local ledger. Only these prefixes are ours
// to change.

export const STAGE_PREFIX = 'rollout-stage:'
export const STATUS_PREFIX = 'rollout-status:'
// What drivers before stage and status labelled with. The next sync removes these labels.
const OLD_REASON_PREFIX = 'rollout-reason:'

// driver-stopped is the view's own, so it never reaches GitHub. Before the PR
// exists there is nothing to label, and a merged PR keeps no stage.
export function stageLabels(entry) {
  if (!entry.pr || !entry.stage || entry.stage === 'merged') {
    return []
  }

  const stage = `${STAGE_PREFIX}${entry.stage}`
  const code = entry.status?.code

  return code ? [stage, `${STATUS_PREFIX}${code}`] : [stage]
}

export function ourLabel(label) {
  return [STAGE_PREFIX, STATUS_PREFIX, OLD_REASON_PREFIX].some((prefix) => label.startsWith(prefix))
}

// Labels to add and remove so the PR carries exactly the wanted ones of ours.
// Anyone else's labels are left alone.
export function labelChanges(current, wanted) {
  return {
    add: wanted.filter((label) => !current.includes(label)),
    remove: current.filter((label) => ourLabel(label) && !wanted.includes(label)),
  }
}
