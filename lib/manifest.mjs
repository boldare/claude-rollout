import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { rolloutNamePattern } from '../hooks/guard-bash.mjs'
import { DEFAULT_ALLOWED_DOMAINS, RUNTIME_VARIABLES } from './sandbox.mjs'
import { expandHome } from './sh.mjs'

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const BUMPS = ['patch', 'minor', 'major']
export const SEVERITIES = ['low', 'medium', 'high', 'critical']
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
  notify: { desktop: true, command: null, webhook: null },
}

const DELEGATE_DEFAULTS = { kinds: ['brief-questions', 'needs-decision'], maxPerPr: 2, effort: 'high' }
const DELEGATE_KINDS = ['brief-questions', 'needs-decision', 'brief-contradiction', 'stuck']
const NEVER_DELEGATED = ['ci', 'environment', 'closed', 'gate', 'code-scanning']

const REPO_DEFAULTS = {
  base: 'main',
  pathPrepend: [],
  requiredChecks: [],
  ignoredChecks: [],
  baseQuietPaths: [],
  merge: { method: 'squash', admin: 'auto' },
  maintainers: [],
  agentToken: null,
  neverMerge: { branches: ['changeset-release/*'], titles: ['chore: version packages'] },
  forbid: [],
  alwaysInScope: ['.changeset/*.md'],
  denylist: [],
  codeScanning: { action: 'fix', minSeverity: 'medium' },
  verify: {},
  public: true,
}

const SANDBOX_DEFAULTS = {
  runtime: 'host',
  image: null,
  oauthTokenFile: null,
  allowedDomains: DEFAULT_ALLOWED_DOMAINS,
  passEnv: [],
  memory: '4g',
  cpus: 2,
  pidsLimit: 512,
}

// A host name never starts with a hyphen, which dig would read as an option.
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const SANDBOX_CHECKS = {
  runtime: {
    check: (value) => ['host', 'docker'].includes(value),
    error: 'must be host or docker',
  },
  image: {
    check: (value) => typeof value === 'string' && /^\S+$/.test(value),
    error: 'must be an image tag without whitespace, such as rollout-agent:2.1.309',
  },
  oauthTokenFile: {
    check: (value) => typeof value === 'string' && value !== '',
    error: 'must be the path of a file that holds a Claude Code OAuth token',
  },
  allowedDomains: {
    check: (value) => Array.isArray(value) && value.every((host) => typeof host === 'string' && HOST_NAME.test(host)),
    error: 'must be a list of host names, such as api.anthropic.com',
  },
  memory: {
    check: (value) => typeof value === 'string' && /^[1-9]\d*[kmg]$/i.test(value),
    error: 'must be a size such as 4g or 512m',
  },
  cpus: {
    check: (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
    error: 'must be a positive number',
  },
  pidsLimit: {
    check: (value) => Number.isInteger(value) && value > 0,
    error: 'must be a positive integer',
  },
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

function webhookError(webhook) {
  if (webhook === null) {
    return null
  }

  if (typeof webhook !== 'string' || !URL.canParse(webhook) || !['http:', 'https:'].includes(new URL(webhook).protocol)) {
    return 'policy.notify.webhook must be an http or https URL, or null for none'
  }

  const url = new URL(webhook)

  if (url.username !== '' || url.password !== '') {
    return 'policy.notify.webhook must have no user name or password, because fetch refuses them'
  }

  return null
}

// A key set to null counts as set, because loadManifest would spread it over the default.
function notifyErrors(notify) {
  if (!plainObject(notify)) {
    return ['policy.notify must be a mapping with desktop, command and webhook']
  }

  const errors = Object.keys(notify)
    .filter((key) => !Object.hasOwn(POLICY_DEFAULTS.notify, key))
    .map((key) => `policy.notify: unknown key ${key}`)

  if (notify.desktop !== undefined && typeof notify.desktop !== 'boolean') {
    errors.push('policy.notify.desktop must be true or false')
  }

  if (notify.command !== undefined && notify.command !== null && !(typeof notify.command === 'string' && notify.command.trim() !== '')) {
    errors.push('policy.notify.command must be a shell command, or null for none')
  }

  const webhook = notify.webhook === undefined ? null : webhookError(notify.webhook)

  if (webhook) {
    errors.push(webhook)
  }

  return errors
}

// Only the implementer's model can differ per PR: a verifier on a weaker
// model would check less than the code was written with.
function modelErrors(model, where) {
  if (model === undefined) {
    return []
  }

  if (!plainObject(model)) {
    return [`${where}.model must be a mapping like { implement: sonnet }`]
  }

  const errors = Object.keys(model)
    .filter((key) => key !== 'implement')
    .map((key) => `${where}.model.${key}: only implement can differ, every other role runs on the rollout's model`)

  if (typeof model.implement !== 'string' || !model.implement) {
    errors.push(`${where}.model.implement must be a model name, such as sonnet`)
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

  if (raw.mcpConfig !== undefined && (typeof raw.mcpConfig !== 'string' || !raw.mcpConfig)) {
    errors.push('mcpConfig must be the path of a JSON file with the MCP servers the agents get')
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

  if (!quietPaths(raw.repo?.baseQuietPaths)) {
    errors.push('repo.baseQuietPaths must be a list of path globs')
  }

  errors.push(...ignoredChecksErrors(raw.repo))
  errors.push(...codeScanningErrors(raw.repo?.codeScanning))
  errors.push(...gatesErrors(raw.gates))
  errors.push(...sandboxErrors(raw))

  if (raw.policy?.delegate !== undefined && raw.policy.delegate !== null) {
    errors.push(...delegateErrors(raw.policy.delegate))
  }

  if (raw.policy?.notify !== undefined) {
    errors.push(...notifyErrors(raw.policy.notify))
  }

  errors.push(...namingErrors(raw, prs))

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

    errors.push(...modelErrors(pr.model, where))

    if (pr.allowClaudeConfig !== undefined && typeof pr.allowClaudeConfig !== 'boolean') {
      errors.push(`${where}.allowClaudeConfig must be true or false`)
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

// The guard refuses every agent command that names the rollout, and an
// implementer's commands carry these values. The start of a value stands in
// for the space, slash or quote before it in a command.
function namingErrors(raw, prs) {
  if (raw.rollout === '' || !nameLike(raw.rollout)) {
    return []
  }

  const name = String(raw.rollout)
  const pattern = rolloutNamePattern(name)
  const names = (value) => nameLike(value) && pattern.test(String(value))
  const refused = `names the rollout ${name}, and the guard refuses every command that does`
  const errors = []
  const base = raw.repo?.base ?? REPO_DEFAULTS.base

  if (names(base)) {
    errors.push(`repo.base ${base} ${refused}: rename the rollout`)
  }

  if (names(raw.repo?.github)) {
    errors.push(`repo.github ${raw.repo.github} ${refused}: rename the rollout`)
  }

  for (const pr of prs) {
    const where = `prs.${pr.id ?? '?'}`

    if (names(pr.branch)) {
      errors.push(`${where}.branch ${pr.branch} ${refused}: rename the branch`)
    }

    if (names(pr.title)) {
      errors.push(`${where}.title "${pr.title}" ${refused}: reword the title`)
    }
  }

  return errors
}

function nameLike(value) {
  return typeof value === 'string' || typeof value === 'number'
}

// An empty `baseQuietPaths:` key is null in YAML. It counts as set, and
// loadManifest would spread it over the default, so the gate would read null.
function quietPaths(globs) {
  if (globs === undefined) {
    return true
  }

  return Array.isArray(globs) && globs.every((glob) => typeof glob === 'string')
}

// An empty `ignoredChecks:` key is null in YAML. It counts as set, so a forgotten value is an error, not the default.
function ignoredChecksErrors(repo) {
  const ignored = repo?.ignoredChecks

  if (ignored === undefined) {
    return []
  }

  if (!STRING_LIST.check(ignored)) {
    return ['repo.ignoredChecks must be a list of check run names (globs), e.g. [Dependabot]']
  }

  if (!Array.isArray(repo.requiredChecks)) {
    return []
  }

  return ignored
    .filter((name) => repo.requiredChecks.includes(name))
    .map((name) => `repo.ignoredChecks: ${name} is also in repo.requiredChecks, and a check cannot be both required and ignored`)
}

// An empty `codeScanning:` key is null in YAML. It counts as set, so a forgotten value is an error, not the default.
function codeScanningErrors(codeScanning) {
  if (codeScanning === undefined) {
    return []
  }

  if (!plainObject(codeScanning)) {
    return ['repo.codeScanning must be a mapping with action and minSeverity']
  }

  const errors = []

  if (codeScanning.action !== undefined && !['fix', 'block', 'ignore'].includes(codeScanning.action)) {
    errors.push('repo.codeScanning.action must be fix, block or ignore')
  }

  if (codeScanning.minSeverity !== undefined && !SEVERITIES.includes(codeScanning.minSeverity)) {
    errors.push('repo.codeScanning.minSeverity must be low, medium, high or critical')
  }

  return errors
}

const STRING_LIST = {
  check: (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== ''),
  error: 'must be a list of non-empty strings',
  default: () => [],
}

// A path inside the target repo, read from its base branch, so it is never resolved or expanded here.
function repoPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false
  }

  return !value.startsWith('/') && !value.startsWith('~') && !value.split('/').includes('..')
}

const GATE_TYPES = {
  boolean: {
    check: (value) => typeof value === 'boolean',
    error: 'must be true or false',
    default: () => false,
  },
  commands: STRING_LIST,
  criteria: STRING_LIST,
  path: {
    check: repoPath,
    error: 'must be a path relative to the repository root, with no .. segment and no leading / or ~',
    default: () => null,
  },
}

const GATE_KEYS = {
  brief: { runChecks: 'boolean', required: 'criteria', recommended: 'criteria' },
  ready: { required: 'commands', recommended: 'commands' },
  preVerify: { scope: 'boolean', required: 'commands', recommended: 'commands' },
  verify: { required: 'criteria', recommended: 'criteria', criteriaFrom: 'path' },
}

// An empty key is null in YAML. It counts as set, so a forgotten value is an error, not the default.
function gateStageErrors(stage, keys, values) {
  if (values === undefined) {
    return []
  }

  if (!plainObject(values)) {
    return [`gates.${stage} must be a mapping`]
  }

  const unknown = Object.keys(values)
    .filter((key) => !Object.hasOwn(keys, key))
    .map((key) => `gates.${stage}: unknown key ${key}`)

  const invalid = Object.entries(keys)
    .filter(([key, type]) => values[key] !== undefined && !GATE_TYPES[type].check(values[key]))
    .map(([key, type]) => `gates.${stage}.${key} ${GATE_TYPES[type].error}`)

  return [...unknown, ...invalid]
}

function gatesErrors(gates) {
  if (gates === undefined) {
    return []
  }

  if (!plainObject(gates)) {
    return ['gates must be a mapping']
  }

  const errors = Object.keys(gates)
    .filter((stage) => !Object.hasOwn(GATE_KEYS, stage))
    .map((stage) => `gates: unknown key ${stage}`)

  for (const [stage, keys] of Object.entries(GATE_KEYS)) {
    errors.push(...gateStageErrors(stage, keys, gates[stage]))
  }

  return errors
}

function stageGates(keys, values) {
  return Object.fromEntries(Object.entries(keys).map(([key, type]) => [key, values?.[key] ?? GATE_TYPES[type].default()]))
}

// Every stage with every key, so the driver never meets a missing one.
function gatesOf(gates) {
  return Object.fromEntries(Object.entries(GATE_KEYS).map(([stage, keys]) => [stage, stageGates(keys, gates?.[stage])]))
}

function passEnvError(name) {
  if (typeof name !== 'string' || !VARIABLE_NAME.test(name)) {
    return `sandbox.passEnv: ${name} is not a variable name`
  }

  if (RUNTIME_VARIABLES.includes(name)) {
    return `sandbox.passEnv: ${name} is set by the runtime`
  }

  if (name.startsWith('ROLLOUT_')) {
    return `sandbox.passEnv: ${name} is a rollout variable, and agents get none but ROLLOUT_ROLE`
  }

  return null
}

function passEnvErrors(passEnv) {
  if (passEnv === undefined) {
    return []
  }

  if (!Array.isArray(passEnv)) {
    return ['sandbox.passEnv must be a list of variable names']
  }

  return passEnv.map(passEnvError).filter(Boolean)
}

// What the container lacks: the maintainer's Claude login, the maintainer's
// GitHub login and the rollout directory, where an MCP server would run from.
function dockerErrors(raw) {
  const { sandbox } = raw
  const apiKey = Array.isArray(sandbox.passEnv) && sandbox.passEnv.includes('ANTHROPIC_API_KEY')
  const errors = []

  if (sandbox.oauthTokenFile === undefined && !apiKey) {
    errors.push('sandbox.runtime docker needs sandbox.oauthTokenFile or ANTHROPIC_API_KEY in sandbox.passEnv, so claude can sign in')
  }

  if (!raw.repo?.agentToken) {
    errors.push('sandbox.runtime docker needs repo.agentToken: in the container agents act on GitHub only as the bot account')
  }

  if (raw.mcpConfig !== undefined) {
    errors.push('sandbox.runtime docker does not take mcpConfig yet: the container mounts nothing of the rollout directory')
  }

  return errors
}

// An empty key is null in YAML. It counts as set, so a forgotten value is an error, not the default.
function sandboxErrors(raw) {
  const { sandbox } = raw

  if (sandbox === undefined) {
    return []
  }

  if (!plainObject(sandbox)) {
    return ['sandbox must be a mapping']
  }

  const errors = Object.keys(sandbox)
    .filter((key) => !Object.hasOwn(SANDBOX_DEFAULTS, key))
    .map((key) => `sandbox: unknown key ${key}`)

  for (const [key, { check, error }] of Object.entries(SANDBOX_CHECKS)) {
    if (sandbox[key] !== undefined && !check(sandbox[key])) {
      errors.push(`sandbox.${key} ${error}`)
    }
  }

  errors.push(...passEnvErrors(sandbox.passEnv))

  if (sandbox.runtime === 'docker') {
    errors.push(...dockerErrors(raw))
  }

  return errors
}

// validateManifest has no directory to resolve the token file against, so its checks are here.
function tokenFileError(path) {
  const stats = statSync(path, { throwIfNoEntry: false })

  if (!stats) {
    return `sandbox.oauthTokenFile ${path} does not exist`
  }

  if (stats.mode & 0o077) {
    return `sandbox.oauthTokenFile ${path} is open to other users: chmod 600 ${path}`
  }

  return null
}

// Every load gets new lists. The token file resolves against the rollout directory, like mcpConfig.
function sandboxOf(raw, rolloutDir) {
  const sandbox = {
    ...SANDBOX_DEFAULTS,
    ...raw,
    allowedDomains: [...(raw.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS)],
    passEnv: [...(raw.passEnv ?? [])],
    oauthTokenFile: raw.oauthTokenFile ? resolve(rolloutDir, expandHome(raw.oauthTokenFile)) : null,
  }

  const error = sandbox.runtime === 'docker' && sandbox.oauthTokenFile ? tokenFileError(sandbox.oauthTokenFile) : null

  if (error) {
    throw new Error(error)
  }

  return sandbox
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
  repo.codeScanning = { ...REPO_DEFAULTS.codeScanning, ...raw.repo.codeScanning }
  repo.agentToken = repo.agentToken ? resolve(expandHome(repo.agentToken)) : null
  repo.pushUrl = repo.pushUrl ?? `https://github.com/${repo.github}.git`

  const policy = { ...POLICY_DEFAULTS, ...raw.policy }

  for (const key of ['attempts', 'timeouts', 'budgetUsd', 'notify']) {
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
    allowClaudeConfig: false,
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

  const model = raw.model ?? 'opus'

  // Relative to the rollout directory, like a brief.
  const mcpConfig = raw.mcpConfig ? resolve(rolloutDir, expandHome(raw.mcpConfig)) : null

  if (mcpConfig && !existsSync(mcpConfig)) {
    throw new Error(`mcpConfig ${mcpConfig} does not exist`)
  }

  const sandbox = sandboxOf(raw.sandbox ?? {}, rolloutDir)

  for (const pr of all) {
    pr.effort = { brief: 'xhigh', ...pr.effort }
    pr.model = { implement: model, ...pr.model }

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
    model,
    mcpConfig,
    label: `rollout:${raw.rollout}`,
    repo,
    policy,
    gates: gatesOf(raw.gates),
    sandbox,
    all,
    prs: only ? all.filter((pr) => only.has(pr.id)) : all,
    only: options.only ?? null,
    dryRun: Boolean(options.dryRun),
  }
}
