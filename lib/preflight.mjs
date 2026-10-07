import { spawnSync } from 'node:child_process'
import { remoteRepo } from './github.mjs'
import { agentEnv } from './identity.mjs'
import { guardCommand } from './settings.mjs'
import { makeEnv, sh } from './sh.mjs'

const MANAGERS = new Map([
  ['npm', 'npm'],
  ['npx', 'npm'],
  ['pnpm', 'pnpm'],
  ['pnpx', 'pnpm'],
  ['yarn', 'yarn'],
  ['bun', 'bun'],
  ['bunx', 'bun'],
])

function firstWord(command) {
  return command
    .trim()
    .split(/\s+/)
    .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
}

// node, then the package managers that repo.install and repo.verify.common start with.
export function probeTools(manifest) {
  const common = manifest.repo.verify?.common
  const commands = [manifest.repo.install, ...(Array.isArray(common) ? common : [])].filter((command) => typeof command === 'string')
  const tools = ['node']

  for (const command of commands) {
    const manager = MANAGERS.get(firstWord(command))

    if (manager && !tools.includes(manager)) {
      tools.push(manager)
    }
  }

  return tools
}

export async function sshHostname(manifest, host) {
  const result = await sh('ssh', ['-G', host], { env: makeEnv(manifest) })

  if (result.code !== 0) {
    const stderr = result.stderr.trim()

    throw new Error(`ssh -G ${host} exited ${result.code}${stderr ? `: ${stderr}` : ''}`)
  }

  const line = result.stdout.split('\n').find((candidate) => /^hostname\s/i.test(candidate))

  if (!line) {
    throw new Error(`ssh -G ${host} exited 0 without a hostname line`)
  }

  return line
    .replace(/^hostname\s+/i, '')
    .trim()
    .toLowerCase()
}

// A credential in the URL must never reach the output.
function withoutUserinfo(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/).*@/is, '$1')
  }

  return url.replace(/^[^:/]*@/, '')
}

// Texts name the host and repo instead of the URL, so a token in an HTTPS URL is never printed.
export async function originCheck(manifest, url, resolveHost) {
  const remote = remoteRepo(url)

  if (!remote) {
    return { ok: false, text: `origin ${url ? withoutUserinfo(url) : '(none)'} is not a GitHub SSH or HTTPS URL` }
  }

  const { protocol, host, repo } = remote

  if (repo !== manifest.repo.github.toLowerCase()) {
    return { ok: false, text: `origin is ${repo} on ${host}, not ${manifest.repo.github}` }
  }

  if (host === 'github.com') {
    return { ok: true, text: `${repo} on github.com` }
  }

  if (protocol === 'https') {
    return { ok: false, text: `origin is on ${host}, not github.com` }
  }

  let resolved

  try {
    resolved = String(await resolveHost(host)).toLowerCase()
  } catch (error) {
    return { ok: false, text: `cannot resolve origin's SSH host ${host} with ssh -G: ${error.message}` }
  }

  if (resolved !== 'github.com') {
    return { ok: false, text: `origin's SSH host ${host} resolves to ${resolved}, not github.com` }
  }

  return { ok: true, text: `${repo} on github.com through SSH host ${host}` }
}

// Feeds the guard command a payload the way an agent's Bash call does. A
// forbidden command must exit 2 and an allowed one must exit 0, so a guard
// that refuses everything fails too. The `rollout guard` text matters because
// the hook command exits 2 even when the guard never ran.
export function guardSelfTest(manifest) {
  const lines = []
  const problems = []
  const denied = runGuard(manifest, 'gh pr merge 1 --admin')
  const deniedOk = denied.status === 2 && /rollout guard/.test(denied.stderr)

  lines.push(`${deniedOk ? 'ok  ' : 'FAIL'} guard hook command exits 2 on a forbidden command`)

  if (!deniedOk) {
    problems.push(`guard hook self-test failed (exit ${denied.status}): ${denied.stderr.slice(0, 200)}`)
  }

  const allowed = runGuard(manifest, 'echo allowed')
  const allowedOk = allowed.status === 0

  lines.push(`${allowedOk ? 'ok  ' : 'FAIL'} guard hook command exits 0 on an allowed command`)

  if (!allowedOk) {
    problems.push(`guard hook self-test failed: an allowed command exited ${allowed.status}: ${allowed.stderr.slice(0, 200)}`)
  }

  return { lines, problems }
}

// An agent that drops GH_TOKEN must find no login to fall back to. The
// GH_HOST probe only informs: agents never get GH_HOST, and the guard refuses
// setting it.
export async function storedLoginCheck(manifest) {
  const lines = []
  const problems = []
  const env = agentEnv(manifest)

  delete env.GH_TOKEN

  const dropped = await sh('gh', ['auth', 'status'], { env })
  const droppedOk = dropped.code !== 0

  lines.push(`${droppedOk ? 'ok  ' : 'FAIL'} without GH_TOKEN, agents' gh has no stored login to fall back to`)

  if (!droppedOk) {
    problems.push('agents could fall back to a stored gh login')
  }

  const withHost = await sh('gh', ['auth', 'status'], { env: { ...env, GH_HOST: 'github.com' } })

  if (withHost.code === 0) {
    lines.push('info with GH_HOST set, gh would fall back to your keyring login. Agents never get GH_HOST and the guard refuses setting it')
  }

  return { lines, problems }
}

// GitHub starts every fine-grained personal access token with github_pat_.
export function isFineGrained(token) {
  return typeof token === 'string' && token.startsWith('github_pat_')
}

// `gh api -i` prints the status line and the headers before the body, on errors too.
export function parseApiResponse(stdout) {
  const status = Number(stdout.match(/^HTTP\/\S+ (\d{3})/)?.[1] ?? 0)
  const body = stdout
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join('\n\n')
    .trim()

  try {
    return { status, json: body ? JSON.parse(body) : null }
  } catch {
    return { status, json: null }
  }
}

export async function ghApi(env, path) {
  const result = await sh('gh', ['api', '-i', path], { env })

  return parseApiResponse(result.stdout)
}

// The admin role reaches these through the token's permissions of the same
// name. A token that gets 403 or 404 from each lacks them.
const ADMIN_PROBES = [
  ['Administration', (github) => `repos/${github}/actions/permissions`],
  ['Secrets', (github) => `repos/${github}/actions/secrets`],
  ['Webhooks', (github) => `repos/${github}/hooks`],
  ['organization Administration', (github) => `orgs/${github.split('/')[0]}/rulesets`],
]

function finding(ok, text, problem = text) {
  return { ok, text, problem }
}

function answer(status) {
  return status || 'no answer'
}

async function permissionFindings(github, bot) {
  const findings = []

  for (const [permission, pathOf] of ADMIN_PROBES) {
    const path = pathOf(github)
    const { status } = await bot(path)

    if (status === 403 || status === 404) {
      findings.push(finding(true, `agent token cannot use ${permission} (${path}: ${status})`))
    } else if (status >= 200 && status < 300) {
      findings.push(
        finding(
          false,
          `agent token can use ${permission} (${path}: ${status})`,
          `agent token has the ${permission} permission: take it away`,
        ),
      )
    } else {
      findings.push(finding(false, `cannot tell whether the agent token can use ${permission} (${path}: ${answer(status)})`))
    }
  }

  return findings
}

// current_user_can_bypass describes the account behind the token, and a push
// is checked against that account's role, whatever the token allows.
async function rulesetFindings(manifest, login, bot) {
  const { github, base } = manifest.repo
  const rules = await bot(`repos/${github}/rules/branches/${encodeURIComponent(base)}?per_page=100`)

  if (rules.status !== 200 || !Array.isArray(rules.json)) {
    return [finding(false, `cannot read the rules on ${base} with the agent token (${answer(rules.status)})`)]
  }

  const ids = [...new Set(rules.json.map((rule) => rule.ruleset_id))]

  if (ids.length === 0) {
    return [finding(true, `no ruleset applies to ${base}`)]
  }

  const findings = []

  for (const id of ids) {
    const ruleset = await bot(`repos/${github}/rulesets/${id}`)
    const name = ruleset.json?.name ?? id
    const bypass = ruleset.json?.current_user_can_bypass

    if (ruleset.status !== 200) {
      findings.push(finding(false, `cannot read ruleset ${id} on ${base} with the agent token (${answer(ruleset.status)})`))
    } else if (bypass === 'never') {
      findings.push(finding(true, `${login} cannot bypass ruleset ${name} on ${base}`))
    } else {
      findings.push(
        finding(
          false,
          `${login} can bypass ruleset ${name} on ${base} (${bypass ?? 'unknown'})`,
          `${login} can bypass ruleset ${name}: take its role and its account off the bypass list`,
        ),
      )
    }
  }

  return findings
}

// Only an admin may read branch protection, so this runs as the maintainer.
async function protectionFinding(manifest, maintainer) {
  const { github, base } = manifest.repo
  const protection = await maintainer(`repos/${github}/branches/${encodeURIComponent(base)}/protection`)

  if (protection.status === 404 && protection.json?.message === 'Branch not protected') {
    return finding(true, `no branch protection on ${base}`)
  }

  if (protection.status !== 200) {
    return finding(false, `cannot read the branch protection on ${base} as you (${answer(protection.status)}): it needs the admin role`)
  }

  if (protection.json?.enforce_admins?.enabled === true) {
    return finding(true, `branch protection on ${base} holds for admins too`)
  }

  return finding(
    false,
    `admins bypass the branch protection on ${base}`,
    `branch protection on ${base} lets admins bypass it: turn on "Do not allow bypassing the above settings"`,
  )
}

// With repo.agentAdmin the agents' account may be an admin, an organization
// owner say, as long as its token cannot act as one: a fine-grained token
// without the admin permissions, and no rule on the base the account may
// bypass. Whatever preflight cannot read fails.
export async function adminAgentCheck(manifest, { login, fineGrained, bot, maintainer }) {
  const findings = []

  if (fineGrained) {
    findings.push(finding(true, 'agent token is fine-grained'))
    findings.push(...(await permissionFindings(manifest.repo.github, bot)))
    findings.push(...(await rulesetFindings(manifest, login, bot)))
    findings.push(await protectionFinding(manifest, maintainer))
  } else {
    findings.push(
      finding(
        false,
        'agent token is not fine-grained',
        'repo.agentAdmin needs a fine-grained agent token: a classic one can do all the admin role can',
      ),
    )
  }

  return {
    lines: findings.map((item) => `${item.ok ? 'ok  ' : 'FAIL'} ${item.text}`),
    problems: findings.filter((item) => !item.ok).map((item) => item.problem),
  }
}

function runGuard(manifest, command) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } })

  return spawnSync('sh', ['-c', guardCommand(manifest, 'implement')], { input: payload, encoding: 'utf8' })
}
