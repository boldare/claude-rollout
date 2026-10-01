import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { expandHome } from './sh.mjs'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const BUMPS = ['patch', 'minor', 'major']
export const HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const POLICY_DEFAULTS = {
  concurrency: 2,
  merge: 'human',
  maxBump: 'minor',
  attempts: { implement: 2, fix: 4, verify: 3, brief: 2 },
  timeouts: { implement: 240, fix: 90, verify: 60, brief: 60, delegate: 30 },
  stallMinutes: 20,
  ciStallMinutes: 20,
  budgetUsd: { low: 3, medium: 8, high: 20, xhigh: 35, max: 60 },
  tickSeconds: 60,
  mergeDelaySeconds: 120,
  approval: 'inbox',
  feedbackQuietMinutes: 3,
  delegate: null,
}

const DELEGATE_DEFAULTS = { kinds: ['brief-questions', 'needs-decision'], maxPerPr: 2, effort: 'high' }
const DELEGATE_KINDS = ['brief-questions', 'needs-decision', 'brief-contradiction', 'stuck']
const NEVER_DELEGATED = ['ci', 'environment', 'closed', 'gate']

const REPO_DEFAULTS = {
  base: 'main',
  pathPrepend: [],
  requiredChecks: [],
  merge: { method: 'squash', admin: 'auto' },
  maintainers: [],
  agentToken: null,
  neverMerge: { branches: ['changeset-release/*'], titles: ['chore: version packages'] },
  forbid: [],
  alwaysInScope: ['.changeset/*.md'],
  denylist: [],
  verify: {},
  public: true,
}

export function raiseEffort(effort, attempt) {
  const index = Math.min(EFFORTS.indexOf(effort) + Math.max(attempt, 0), EFFORTS.length - 1)

  return EFFORTS[index]
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function depsOf(pr) {
  return Array.isArray(pr?.deps) ? pr.deps : []
}

function delegateKindError(kind) {
  if (NEVER_DELEGATED.includes(kind)) {
    return `policy.delegate.kinds: ${kind} is never delegated`
  }

  if (!DELEGATE_KINDS.includes(kind)) {
    return `policy.delegate.kinds: unknown kind ${kind}`
  }

  return null
}

// A key set to null counts as set, because loadManifest would spread it over the default.
function delegateErrors(delegate) {
  if (!plainObject(delegate)) {
    return ['policy.delegate must be a mapping, or null to turn it off']
  }

  const errors = []

  if (delegate.kinds !== undefined) {
    if (Array.isArray(delegate.kinds)) {
      errors.push(...delegate.kinds.map(delegateKindError).filter(Boolean))
    } else {
      errors.push('policy.delegate.kinds must be a list')
    }
  }

  if (delegate.maxPerPr !== undefined && !(Number.isInteger(delegate.maxPerPr) && delegate.maxPerPr >= 0)) {
    errors.push('policy.delegate.maxPerPr must be an integer of 0 or more')
  }

  if (delegate.effort !== undefined && !EFFORTS.includes(delegate.effort)) {
    errors.push(`policy.delegate.effort must be one of ${EFFORTS.join(', ')}`)
  }

  return errors
}

export function validateManifest(raw) {
  if (!plainObject(raw)) {
    return ['the manifest must be a mapping with rollout, repo and prs']
  }

  const errors = []
  const entries = Array.isArray(raw.prs) ? raw.prs : []

  if (!raw.rollout) {
    errors.push('rollout: name is required')
  }

  if (!raw.repo?.path || !raw.repo?.github) {
    errors.push('repo.path and repo.github are required')
  }

  if (!Array.isArray(raw.repo?.requiredChecks) || raw.repo.requiredChecks.length === 0) {
    errors.push('repo.requiredChecks must name the CI jobs a PR needs (globs), e.g. [check, smoke*]')
  }

  if (entries.length === 0) {
    errors.push('prs: at least one PR is required')
  }

  entries.forEach((entry, i) => {
    if (!plainObject(entry)) {
      errors.push(`prs[${i}] must be a mapping`)
    }
  })

  const prs = entries.filter(plainObject)

  if (!['human', 'auto', 'manual'].includes(raw.policy?.merge ?? POLICY_DEFAULTS.merge)) {
    errors.push('policy.merge must be human (driver merges after approval), manual (the maintainer merges) or auto')
  }

  const approval = raw.policy?.approval ?? POLICY_DEFAULTS.approval

  if (!['inbox', 'github'].includes(approval)) {
    errors.push('policy.approval must be inbox or github')
  }

  if (approval === 'github' && (!raw.repo?.agentToken || !raw.repo?.maintainers?.length)) {
    errors.push(
      'policy.approval github needs repo.agentToken (agents open PRs as another account) and repo.maintainers (whose reviews count)',
    )
  }

  if (raw.repo?.public !== undefined && typeof raw.repo.public !== 'boolean') {
    errors.push('repo.public must be true or false')
  }

  if (raw.policy?.delegate !== undefined && raw.policy.delegate !== null) {
    errors.push(...delegateErrors(raw.policy.delegate))
  }

  const ids = new Set()
  const branches = new Set()
  const maxBump = raw.policy?.maxBump ?? POLICY_DEFAULTS.maxBump

  for (const pr of prs) {
    const where = `prs.${pr.id ?? '?'}`

    for (const field of ['id', 'branch', 'title', 'brief']) {
      if (!pr[field]) {
        errors.push(`${where}.${field} is required`)
      }
    }

    if (ids.has(pr.id)) {
      errors.push(`${where}: duplicate id`)
    }

    if (branches.has(pr.branch)) {
      errors.push(`${where}: duplicate branch ${pr.branch}`)
    }

    ids.add(pr.id)
    branches.add(pr.branch)

    if (pr.deps !== undefined && !Array.isArray(pr.deps)) {
      errors.push(`${where}.deps must be a list of PR ids`)
    }

    for (const role of ['implement', 'verify']) {
      if (!EFFORTS.includes(pr.effort?.[role])) {
        errors.push(`${where}.effort.${role} must be one of ${EFFORTS.join(', ')}`)
      }
    }

    // null counts as set, because loadManifest would spread it over the xhigh default.
    if (pr.effort?.brief !== undefined && !EFFORTS.includes(pr.effort.brief)) {
      errors.push(`${where}.effort.brief must be one of ${EFFORTS.join(', ')}`)
    }

    if (pr.changeset === 'none') {
      // A repo without changesets: no changeset is written or required.
    } else if (!BUMPS.includes(pr.changeset)) {
      errors.push(`${where}.changeset must be one of ${BUMPS.join(', ')} or none`)
    } else if (BUMPS.indexOf(pr.changeset) > BUMPS.indexOf(maxBump)) {
      errors.push(`${where}.changeset ${pr.changeset} is above policy.maxBump ${maxBump}`)
    }
  }

  for (const pr of prs) {
    for (const dep of depsOf(pr)) {
      if (!ids.has(dep)) {
        errors.push(`prs.${pr.id}.deps: unknown PR ${dep}`)
      }
    }
  }

  const cycle = findCycle(prs)

  if (cycle) {
    errors.push(`dependency cycle: ${cycle.join(' -> ')}`)
  }

  return errors
}

function findCycle(prs) {
  const byId = new Map(prs.map((pr) => [pr.id, pr]))
  const state = new Map()
  const stack = []

  function visit(id) {
    if (state.get(id) === 'done') {
      return null
    }

    if (state.get(id) === 'open') {
      return [...stack.slice(stack.indexOf(id)), id]
    }

    state.set(id, 'open')
    stack.push(id)

    for (const dep of depsOf(byId.get(id))) {
      const cycle = visit(dep)

      if (cycle) {
        return cycle
      }
    }

    stack.pop()
    state.set(id, 'done')

    return null
  }

  for (const pr of prs) {
    const cycle = visit(pr.id)

    if (cycle) {
      return cycle
    }
  }

  return null
}

export function loadManifest(dir, options = {}) {
  const rolloutDir = resolve(expandHome(dir))
  const file = join(rolloutDir, 'manifest.yaml')

  if (!existsSync(file)) {
    throw new Error(`no manifest.yaml in ${rolloutDir}`)
  }

  const raw = parse(readFileSync(file, 'utf8'))
  const errors = validateManifest(raw)

  if (errors.length > 0) {
    throw new Error(`invalid manifest:\n- ${errors.join('\n- ')}`)
  }

  const repo = { ...REPO_DEFAULTS, ...raw.repo }
  repo.path = resolve(expandHome(repo.path))
  repo.merge = { ...REPO_DEFAULTS.merge, ...raw.repo.merge }
  repo.neverMerge = { ...REPO_DEFAULTS.neverMerge, ...raw.repo.neverMerge }
  repo.agentToken = repo.agentToken ? resolve(expandHome(repo.agentToken)) : null
  repo.pushUrl = repo.pushUrl ?? `https://github.com/${repo.github}.git`

  const policy = { ...POLICY_DEFAULTS, ...raw.policy }

  for (const key of ['attempts', 'timeouts', 'budgetUsd']) {
    policy[key] = { ...POLICY_DEFAULTS[key], ...raw.policy?.[key] }
  }

  policy.delegate = raw.policy?.delegate ? { ...DELEGATE_DEFAULTS, ...raw.policy.delegate } : null

  const all = raw.prs.map((pr, order) => ({
    deps: [],
    priority: 0,
    scope: [],
    extra: [],
    expect: [],
    smoke: false,
    viewer: false,
    allowWorkflows: false,
    ...pr,
    order,
    brief: resolve(rolloutDir, expandHome(pr.brief)),
  }))

  const only = options.only?.length ? new Set(options.only) : null

  if (only) {
    for (const id of only) {
      if (!all.some((pr) => pr.id === id)) {
        throw new Error(`--only: unknown PR ${id}`)
      }
    }
  }

  for (const pr of all) {
    pr.effort = { brief: 'xhigh', ...pr.effort }

    if (!existsSync(pr.brief) && !raw.briefing?.sources?.length) {
      throw new Error(`prs.${pr.id}: brief ${pr.brief} does not exist and no briefing.sources are configured to write it`)
    }
  }

  return {
    rollout: raw.rollout,
    briefing: raw.briefing ?? null,
    dir: rolloutDir,
    wtRoot: `${rolloutDir}.worktrees`,
    home: HOME,
    claudeBin: expandHome(raw.claudeBin ?? 'claude'),
    model: raw.model ?? 'opus',
    label: `rollout:${raw.rollout}`,
    repo,
    policy,
    all,
    prs: only ? all.filter((pr) => only.has(pr.id)) : all,
    only: options.only ?? null,
    dryRun: Boolean(options.dryRun),
  }
}
