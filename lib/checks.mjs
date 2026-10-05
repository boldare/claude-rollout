import { matchesAny } from './glob.mjs'

const OK = new Set(['success', 'skipped', 'neutral'])

// Reduces GitHub check runs for one commit to green, red or pending.
// Every required glob must be matched by at least one run that succeeded
// (skipped alone means nothing was tested), and every run on the commit,
// required or not, must finish OK: "all jobs pass". No runs is pending.
// A cancelled run never replaces a completed one of the same name: a
// cancellation on another branch for the same commit says nothing about the code.
export function summarizeChecks(checkRuns, requiredGlobs) {
  const latest = new Map()

  for (const run of checkRuns) {
    const known = latest.get(run.name)

    if (!known || supersedes(run, known)) {
      latest.set(run.name, run)
    }
  }

  const runs = [...latest.values()]
  const pending = runs.filter((run) => run.status !== 'completed').map((run) => run.name)
  const failing = runs.filter((run) => run.status === 'completed' && !OK.has(run.conclusion)).map((run) => `${run.name}: ${run.conclusion}`)
  const missing = []

  for (const glob of requiredGlobs) {
    const matched = runs.filter((run) => matchesAny(run.name, [glob]))

    if (matched.length === 0) {
      missing.push(glob)
    } else if (matched.every((run) => run.status === 'completed') && !matched.some((run) => run.conclusion === 'success')) {
      failing.push(`required check ${glob} did not run (${matched.map((run) => `${run.name}: ${run.conclusion}`).join(', ')})`)
    }
  }

  let state = 'green'

  if (failing.length > 0) {
    state = 'red'
  } else if (runs.length === 0 || missing.length > 0 || pending.length > 0) {
    state = 'pending'
  }

  return {
    state,
    missing,
    pending,
    failing,
    runs: runs.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion })),
  }
}

function supersedes(run, known) {
  const runDecided = run.status === 'completed' && run.conclusion !== 'cancelled'
  const knownDecided = known.status === 'completed' && known.conclusion !== 'cancelled'

  if (knownDecided && run.conclusion === 'cancelled') {
    return false
  }

  if (runDecided && known.conclusion === 'cancelled') {
    return true
  }

  return run.id > known.id
}
