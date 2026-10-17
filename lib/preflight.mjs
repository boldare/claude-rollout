import { spawnSync } from 'node:child_process'
import { accessSync, closeSync, constants, openSync, readSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { ghEnv, remoteRepo } from './github.mjs'
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

// Every executable `name` on PATH, in PATH order.
function onPath(name, pathValue) {
  const found = []

  for (const dir of (pathValue ?? '').split(delimiter).filter(Boolean)) {
    const file = join(dir, name)

    try {
      accessSync(file, constants.X_OK)

      if (statSync(file).isFile() && !found.includes(file)) {
        found.push(file)
      }
    } catch {
      // not here
    }
  }

  return found
}

function firstLine(file) {
  const buffer = Buffer.alloc(256)
  const fd = openSync(file, 'r')

  try {
    const length = readSync(fd, buffer, 0, buffer.length, 0)

    return buffer.subarray(0, length).toString('latin1').split('\n')[0]
  } finally {
    closeSync(fd)
  }
}

// Claude Code installs as a native binary or as a node script. Any other
// script is a wrapper, such as the shim a terminal like cmux puts first on PATH.
function isWrapper(file) {
  const line = firstLine(file)

  return line.startsWith('#!') && !/\bnode\b/.test(line)
}

// Agents started through a wrapper run with whatever it adds (settings, MCP
// servers, session hooks) and end when it ends them. An explicit path in
// claudeBin is the maintainer's choice and is never questioned.
export function claudeWrapperWarning(claudeBin, pathValue) {
  if (claudeBin.includes('/')) {
    return null
  }

  const [first, ...rest] = onPath(claudeBin, pathValue)

  if (!first || !isWrapper(first)) {
    return null
  }

  const real = rest.find((file) => !isWrapper(file))
  const example = real ? `, for example ${real}` : ''

  return `${claudeBin} on PATH is a wrapper script (${first}). Agents would run through it, with whatever it adds, and stop when it stops them. Set claudeBin in manifest.yaml to the Claude Code binary${example}`
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

// write:org and admin:org include read:org, and GitHub lists only the selected scope.
const READ_ORG_SCOPES = ['read:org', 'write:org', 'admin:org']

const FINE_GRAINED_PROBLEM =
  'agent token is fine-grained: GitHub gives it no Checks permission, so agents cannot follow CI. Use a classic token with the repo, workflow and read:org scopes'

// The scopes of a classic token from the X-Oauth-Scopes header of `gh api -i`,
// or null without the header. `[ \t]*` keeps an empty header from reading the next line.
function oauthScopes(response) {
  const match = response.match(/^x-oauth-scopes:[ \t]*([^\r\n]*)/im)

  if (!match) {
    return null
  }

  return match[1]
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '')
}

function scopesText(scopes) {
  if (scopes === null) {
    return '?'
  }

  return scopes.length > 0 ? scopes.join(', ') : 'none'
}

function scopeWarnings(scopes) {
  const warnings = []

  if (!scopes.includes('workflow')) {
    warnings.push('agent token lacks the workflow scope: PRs that change .github/workflows cannot be pushed')
  }

  if (!scopes.some((scope) => READ_ORG_SCOPES.includes(scope))) {
    warnings.push(
      'agent token lacks the read:org scope: gh cannot edit or read a PR with a team review request, so agents cannot update their PR description',
    )
  }

  return warnings
}

// The account's role says what it may do, not what its token reaches. `gh api -i`
// prints the status line on a 4xx too, and nothing when GitHub never answered.
async function repositoryProbe(manifest, env) {
  const repo = manifest.repo.github
  const result = await sh('gh', ['api', '-i', `repos/${repo}`], { env })
  const status = result.stdout.match(/^HTTP\/\S+ (\d{3})/)?.[1] ?? 'no answer'

  if (status === '200') {
    return { line: `ok   agent token can see ${repo}`, problems: [] }
  }

  return {
    line: `FAIL agent token cannot see ${repo} (${status})`,
    problems: [`agent token cannot see ${repo} (${status}): give the token the repo scope and its account access to the repository`],
  }
}

// The login and scopes come from the agents' token, the role from your gh login.
// The token itself never reaches a line, problem or warning.
export async function agentTokenCheck(manifest) {
  const lines = []
  const problems = []
  const env = agentEnv(manifest)
  const fineGrained = (env.GH_TOKEN ?? '').startsWith('github_pat_')
  const who = await sh('gh', ['api', 'user', '--jq', '.login'], { env })
  const login = who.stdout.trim()
  const permission = await sh('gh', ['api', `repos/${manifest.repo.github}/collaborators/${login}/permission`, '--jq', '.permission'], {
    env: ghEnv(manifest),
  })

  const role = permission.stdout.trim()
  const scopes = oauthScopes((await sh('gh', ['api', '-i', 'user'], { env })).stdout)
  const ok = who.code === 0 && !manifest.repo.maintainers.includes(login) && role === 'write'

  lines.push(`${ok ? 'ok  ' : 'FAIL'} agent identity: ${login || '?'} (permission ${role || '?'}, scopes ${scopesText(scopes)})`)

  if (!ok) {
    problems.push('agent token must belong to a non-maintainer account with write (not admin) permission')
  }

  // GitHub gives fine-grained tokens no Checks permission, so gh pr checks cannot read a PR's checks.
  if (fineGrained) {
    lines.push('FAIL agent token is fine-grained, so agents cannot follow CI')
    problems.push(FINE_GRAINED_PROBLEM)
  }

  const probe = await repositoryProbe(manifest, env)

  lines.push(probe.line)
  problems.push(...probe.problems)

  // The fine-grained problem already names the scopes.
  const warnings = fineGrained ? [] : scopeWarnings(scopes ?? [])

  return { lines, problems, warnings }
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

function runGuard(manifest, command) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } })

  return spawnSync('sh', ['-c', guardCommand(manifest, 'implement')], { input: payload, encoding: 'utf8' })
}
