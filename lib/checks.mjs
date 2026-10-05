import { matchesAny } from './glob.mjs'

const OK = new Set(['success', 'skipped', 'neutral'])

// Reduces GitHub check runs for one commit to green, red or pending.
// Every required glob must be matched by at least one run that succeeded
// (skipped alone means nothing was tested), and every run on the commit,
// required or not, must finish OK: "all jobs pass". No runs is pending.
export function summarizeChecks(checkRuns, requiredGlobs) {
  const runs = [...Map.groupBy(checkRuns, (run) => run.name).values()].map(latestRun)
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

// A base commit speaks for itself once a required check ran on it or any of
// its runs failed. Other runs (a docs deploy, say) say nothing about the code,
// and a cancellation says nothing at all. `runs` as summarizeChecks returns them.
export function speaksForItself(runs, requiredGlobs) {
  const required = runs.some((run) => matchesAny(run.name, requiredGlobs))
  const failed = runs.some((run) => run.status === 'completed' && !OK.has(run.conclusion) && run.conclusion !== 'cancelled')

  return required || failed
}

// One commit on the base branch that speaks for its parent: it does not speak
// for itself, has one parent and changes only quiet files. No changed file at
// all is quiet too.
export function inheritsParent({ runs, requiredGlobs, parentCount, files, globs }) {
  if (globs.length === 0 || parentCount !== 1 || speaksForItself(runs, requiredGlobs)) {
    return false
  }

  return files.every((file) => matchesAny(file, globs))
}

// The run that speaks for one check: the one with the highest id, except
// that a cancelled run counts only when the check has no other run. A
// cancellation on another branch for the same commit says nothing about the
// code. A choice over the whole group, so the API's order never matters.
function latestRun(runs) {
  const uncancelled = runs.filter((run) => run.conclusion !== 'cancelled')
  const candidates = uncancelled.length > 0 ? uncancelled : runs

  return candidates.reduce((latest, run) => (run.id > latest.id ? run : latest))
}
