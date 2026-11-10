import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { GitHubError } from './gh.mjs'
import { clientFor, readCatalog, remoteRepo } from './github.mjs'
import { agentEnv, agentToken, readOnlyEnv } from './identity.mjs'
import { imageFor, runOnce, runtimeFor } from './sandbox.mjs'
import { agentSettings, contextArgs, contextEnv, guardCommand } from './settings.mjs'
import { makeEnv, sh } from './sh.mjs'
import { cloneFromMirror, mirrorPath, removeWorktree, worktreePath } from './worktree.mjs'

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

// A floor goes up when a flag the driver uses needs a newer version.
export const VERIFIED_VERSIONS = { claude: '2.1.303', gh: '2.40.0' }

function versionParts(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)

  return match ? match.slice(1, 4).map(Number) : null
}

function below(found, floor) {
  for (let i = 0; i < floor.length; i++) {
    if (found[i] !== floor[i]) {
      return found[i] < floor[i]
    }
  }

  return false
}

// A warning when `output` of `<tool> --version` shows a version below `floor`
// or no version at all, null otherwise.
export function versionWarning(tool, output, floor) {
  const found = versionParts(output)

  if (!found) {
    const quoted = String(output).split('\n')[0].trim().slice(0, 80)

    return `${tool} --version printed no version ("${quoted}"), so preflight cannot tell whether it is at least ${floor}`
  }

  if (!below(found, versionParts(floor))) {
    return null
  }

  return `${tool} ${found.join('.')} is older than ${floor}, the version the driver was verified on. Update it, or flags the driver passes may be missing`
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

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// What a maintainer may expect agents to inherit from their own Claude Code
// settings. Env values can be secrets, so only their names are shown.
export function userSettingsCheck(file) {
  const settings = readJson(file)

  if (!isPlainObject(settings)) {
    return { lines: [], warnings: [] }
  }

  const parts = []

  if (typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper) {
    parts.push('apiKeyHelper')
  }

  const names = isPlainObject(settings.env) ? Object.keys(settings.env) : []

  if (names.length > 0) {
    parts.push(`env (${names.join(', ')})`)
  }

  if (parts.length === 0) {
    return { lines: [`ok   user settings: agents load none, and ${file} sets no apiKeyHelper or env`], warnings: [] }
  }

  return {
    lines: [],
    warnings: [
      `${file} sets ${parts.join(' and ')}. Agents start with --setting-sources project, so they get none of it. Put what they need in the environment that starts the driver`,
    ],
  }
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

  // Only a guard that got the rollout directory on its hook command refuses this.
  const ledger = runGuard(manifest, `cat '${join(manifest.dir, 'ledger.json')}'`)
  const ledgerOk = ledger.status === 2 && /rollout guard/.test(ledger.stderr)

  lines.push(`${ledgerOk ? 'ok  ' : 'FAIL'} guard hook command exits 2 on the rollout directory`)

  if (!ledgerOk) {
    problems.push(`guard hook self-test failed: a command on the rollout directory exited ${ledger.status}: ${ledger.stderr.slice(0, 200)}`)
  }

  return { lines, problems }
}

// write:org and admin:org include read:org, and GitHub lists only the selected scope.
const READ_ORG_SCOPES = ['read:org', 'write:org', 'admin:org']

const FINE_GRAINED_PROBLEM =
  'agent token is fine-grained: GitHub gives it no Checks permission, so agents cannot follow CI. Use a classic token with the repo, workflow and read:org scopes'

// The scopes of a classic token from its X-Oauth-Scopes header, or null
// without the header. An empty header is no scopes.
function oauthScopes(headers) {
  const header = headers.get('x-oauth-scopes')

  if (header === null) {
    return null
  }

  return header
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

// The account's role says what it may do, not what its token reaches. A
// request GitHub never answered has no status.
async function repositoryProbe(manifest, client) {
  const repo = manifest.repo.github
  let status = 200

  try {
    await client.request('GET', `repos/${repo}`, { as: 'agents' })
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error
    }

    status = error.status ?? 'no answer'
  }

  if (status === 200) {
    return { line: `ok   agent token can see ${repo}`, problems: [] }
  }

  return {
    line: `FAIL agent token cannot see ${repo} (${status})`,
    problems: [`agent token cannot see ${repo} (${status}): give the token the repo scope and its account access to the repository`],
  }
}

// The agents' login and scopes, or null when the read failed.
async function agentUser(client) {
  try {
    const { body, headers } = await client.request('GET', 'user', { as: 'agents' })

    return { login: body?.login ?? '', scopes: oauthScopes(headers) }
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error
    }

    return null
  }
}

async function collaboratorRole(manifest, client, login) {
  try {
    const { body } = await client.request('GET', `repos/${manifest.repo.github}/collaborators/${encodeURIComponent(login)}/permission`)

    return body?.permission ?? ''
  } catch (error) {
    if (!(error instanceof GitHubError)) {
      throw error
    }

    return ''
  }
}

// The login and scopes come from the agents' token, the role from your gh login.
// The token itself never reaches a line, problem or warning.
export async function agentTokenCheck(manifest) {
  const lines = []
  const problems = []
  const fineGrained = (agentToken(manifest) ?? '').startsWith('github_pat_')
  const client = clientFor(manifest)
  const user = await agentUser(client)
  const login = user?.login ?? ''
  const role = user ? await collaboratorRole(manifest, client, login) : ''
  const scopes = user?.scopes ?? null
  const ok = user !== null && !manifest.repo.maintainers.includes(login) && role === 'write'

  lines.push(`${ok ? 'ok  ' : 'FAIL'} agent identity: ${login || '?'} (permission ${role || '?'}, scopes ${scopesText(scopes)})`)

  if (!ok) {
    problems.push('agent token must belong to a non-maintainer account with write (not admin) permission')
  }

  // GitHub gives fine-grained tokens no Checks permission, so gh pr checks cannot read a PR's checks.
  if (fineGrained) {
    lines.push('FAIL agent token is fine-grained, so agents cannot follow CI')
    problems.push(FINE_GRAINED_PROBLEM)
  }

  const probe = await repositoryProbe(manifest, client)

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

// Call it after the fetch, so it reads the catalog the next verifier would get.
export async function catalogCheck(manifest) {
  const path = manifest.gates.verify.criteriaFrom

  if (!path) {
    return { lines: [], problems: [] }
  }

  try {
    const entries = await readCatalog(manifest)
    const count = entries.length === 1 ? '1 entry' : `${entries.length} entries`

    return { lines: [`ok   criteria catalog ${path} on origin/${manifest.repo.base}: ${count}`], problems: [] }
  } catch (error) {
    return { lines: [`FAIL criteria catalog: ${error.message}`], problems: [error.message] }
  }
}

function guardPayload(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
}

function runGuard(manifest, command) {
  return spawnSync('sh', ['-c', guardCommand(manifest, 'implement')], { input: guardPayload(command), encoding: 'utf8' })
}

const HOST_RUNTIME_WARNING =
  'sandbox.runtime is host: agents, installs and gate commands run as you, with your files, keys and logins in reach. Set sandbox.runtime: docker to run them in a container, see https://boldare.github.io/claude-rollout/security.html#boundaries'

function isDocker(manifest) {
  return manifest.sandbox?.runtime === 'docker'
}

// The environment buildImage gives docker.
function docker(manifest, args, timeout) {
  return sh('docker', args, { env: makeEnv(manifest), timeout })
}

function firstOutputLine(text) {
  return String(text).trim().split('\n')[0]
}

function outputLine(result) {
  return firstOutputLine(result.stderr) || firstOutputLine(result.stdout)
}

function buildHint(dir) {
  return `rollout.mjs sandbox build --dir ${dir}`
}

// Judges `<tool> --version` run in the image. Unlike versionWarning on the
// host, an old or missing version fails, because agents run the image's tools.
export function imageToolCheck(tool, result, dir) {
  if (result.code !== 0) {
    const shown = outputLine(result)

    return { found: null, line: `FAIL ${tool} in the image: ${shown}`, problem: `${tool} --version failed in the image: ${shown}` }
  }

  const parts = versionParts(result.stdout)

  if (!parts) {
    const quoted = firstOutputLine(result.stdout).slice(0, 80)

    return {
      found: null,
      line: `FAIL ${tool} in the image printed no version ("${quoted}")`,
      problem: `${tool} --version in the image printed no version: rebuild it with ${buildHint(dir)}`,
    }
  }

  const found = parts.join('.')
  const floor = VERIFIED_VERSIONS[tool]

  if (below(parts, versionParts(floor))) {
    return {
      found,
      line: `FAIL ${tool} in the image: ${found}, older than ${floor}`,
      problem: `${tool} ${found} in the image is older than ${floor}: update it on the host and rebuild with ${buildHint(dir)}`,
    }
  }

  return { found, line: `ok   ${tool} in the image: ${found}`, problem: null }
}

// Records a failed step. Every later step needs this one, so the caller stops.
function failedStep(report, line, problem) {
  report.lines.push(`FAIL ${line}`)
  report.problems.push(problem)

  return null
}

// The entrypoint is bypassed on purpose: no firewall, no mount, no token and
// no network for a version.
async function imageTool(manifest, image, tool) {
  const result = await docker(
    manifest,
    ['run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', tool, image, '--version'],
    60_000,
  )

  return imageToolCheck(tool, result, manifest.dir)
}

// The client, the daemon, the image and the tools in it, in that order.
// Returns the image's claude version, or null when a step failed.
async function imageChecks(manifest, report) {
  if (onPath('docker', makeEnv(manifest).PATH).length === 0) {
    return failedStep(
      report,
      'docker: no docker client on PATH',
      'sandbox.runtime docker needs a docker client on PATH: install Docker or colima, or set sandbox.runtime: host',
    )
  }

  const server = await docker(manifest, ['version', '--format', '{{.Server.Version}}'], 30_000)

  if (server.code !== 0) {
    const shown = outputLine(server)

    return failedStep(report, `docker: ${shown}`, `docker version failed: ${shown}. Start the Docker daemon`)
  }

  report.lines.push(`ok   docker: server ${server.stdout.trim()}`)

  let image

  try {
    image = imageFor(manifest)
  } catch (error) {
    return failedStep(report, `image: ${error.message}`, error.message)
  }

  const inspected = await docker(manifest, ['image', 'inspect', '--format', '{{.Id}}', image], 30_000)

  if (inspected.code !== 0) {
    return failedStep(report, `image ${image} is missing`, `image ${image} is missing: build it with ${buildHint(manifest.dir)}`)
  }

  report.lines.push(`ok   image ${image}`)

  const versions = {}

  for (const tool of ['claude', 'gh']) {
    const checked = await imageTool(manifest, image, tool)

    report.lines.push(checked.line)

    if (checked.problem) {
      report.problems.push(checked.problem)

      return null
    }

    versions[tool] = checked.found
  }

  return versions.claude
}

// loadManifest already refused a token file that is missing or open to others.
function claudeTokenCheck(manifest) {
  const file = manifest.sandbox.oauthTokenFile

  if (!file) {
    if (process.env.ANTHROPIC_API_KEY) {
      return { line: 'ok   sandbox.passEnv: ANTHROPIC_API_KEY is set', problem: null }
    }

    return {
      line: 'FAIL sandbox.passEnv: ANTHROPIC_API_KEY is not set',
      problem: "sandbox.passEnv names ANTHROPIC_API_KEY, but it is not set in the driver's environment",
    }
  }

  try {
    const mode = (statSync(file).mode & 0o777).toString(8)

    if (readFileSync(file, 'utf8').trim() === '') {
      return {
        line: `FAIL sandbox.oauthTokenFile: ${file} is empty`,
        problem: `sandbox.oauthTokenFile ${file} is empty: put a Claude token in it`,
      }
    }

    return { line: `ok   sandbox.oauthTokenFile: mode ${mode}, not empty`, problem: null }
  } catch (error) {
    return { line: `FAIL sandbox.oauthTokenFile: ${error.message}`, problem: `sandbox.oauthTokenFile: ${error.message}` }
  }
}

// `hostClaude` is what the host's claude --version printed, or null when it
// did not run.
export async function runtimeCheck(manifest, hostClaude) {
  if (!isDocker(manifest)) {
    return { lines: [], problems: [], warnings: [HOST_RUNTIME_WARNING] }
  }

  const report = { lines: [], problems: [], warnings: [] }
  const inside = await imageChecks(manifest, report)
  const host = hostClaude === null ? null : versionParts(hostClaude)

  if (inside && host && inside !== host.join('.')) {
    report.warnings.push(
      `the image has claude ${inside} and your claude is ${host.join('.')}. Agents run the image's: rebuild with ${buildHint(manifest.dir)}`,
    )
  }

  const token = claudeTokenCheck(manifest)

  report.lines.push(token.line)

  if (token.problem) {
    report.problems.push(token.problem)
  }

  report.lines.push(
    "info claudeBin and repo.pathPrepend apply on the host only. In the container agents run the image's claude, gh and node",
  )

  return report
}

export const BOUNDARY_PROBES = [
  { name: 'skill-readonly', text: 'a write to the skill directory fails' },
  { name: 'etc-readonly', text: 'a write to /etc fails' },
  { name: 'no-rollout-dir', text: 'the rollout directory is not in the container' },
  { name: 'no-repo-path', text: 'repo.path is not in the container' },
  { name: 'no-mirror', text: 'the mirror is not in the container' },
  { name: 'owner', text: 'a file created in the clone belongs to you' },
  { name: 'egress-blocked', text: 'HTTPS to a host outside sandbox.allowedDomains fails' },
  { name: 'egress-allowed', text: 'HTTPS to api.anthropic.com connects' },
  { name: 'guard-refuses', text: 'the guard hook command refuses gh pr merge' },
  { name: 'guard-allows', text: 'the guard hook command lets echo through' },
  { name: 'mirror-object', text: "an object rewritten in the clone leaves the mirror's copy unchanged" },
  { name: 'stop', text: 'docker stop ends the container within 5 s' },
]

const OWNER_PROBE = 'rollout-owner-probe'

// Runs in the container as `sh -c BOUNDARY_SCRIPT sh <words>`. The words are
// the skill, the rollout directory, repo.path, the mirror, a URL outside
// sandbox.allowedDomains (empty when there is none), one inside it, the guard
// hook command, its deny and allow payloads, and an object's path in the git
// dir. No set -e, so a failed probe never skips the next. Each probe prints
// one line. The host checks who owns the file and whether the mirror changed,
// and times the stop.
export const BOUNDARY_SCRIPT = [
  'object="${10}"',
  `detail() { printf '%s' "$1" | tr '\\n' ' ' | cut -c 1-200; }`,
  'write_fails() {',
  '  file="$2/rollout-boundary-probe-$$"',
  '  if ( : > "$file" ) 2>/dev/null; then',
  '    rm -f "$file"',
  '    echo "probe $1 fail the write succeeded"',
  '  else',
  '    echo "probe $1 ok"',
  '  fi',
  '}',
  // A file inside each path, because Docker creates every parent of a mount
  // target as an empty directory.
  'absent() {',
  '  if [ -e "$2" ] || [ -L "$2" ]; then',
  '    echo "probe $1 fail $2 exists"',
  '  else',
  '    echo "probe $1 ok"',
  '  fi',
  '}',
  'write_fails skill-readonly "$1"',
  'write_fails etc-readonly /etc',
  'absent no-rollout-dir "$2/manifest.yaml"',
  'absent no-repo-path "$3/.git"',
  'absent no-mirror "$4/HEAD"',
  `if ( : > ${OWNER_PROBE} ) 2>/dev/null; then`,
  '  echo "probe owner ok"',
  'else',
  '  echo "probe owner fail cannot create a file in the clone"',
  'fi',
  'if [ -z "$5" ]; then',
  '  echo "probe egress-blocked fail no outside host to try"',
  'elif curl -sS -o /dev/null --max-time 10 "$5" 2>/dev/null; then',
  '  echo "probe egress-blocked fail curl reached $5"',
  'else',
  '  echo "probe egress-blocked ok"',
  'fi',
  // curl exits 0 on any HTTP status, so an answer is enough.
  'error=$(curl -sS -o /dev/null --max-time 10 "$6" 2>&1)',
  'status=$?',
  'if [ "$status" = 0 ]; then',
  '  echo "probe egress-allowed ok"',
  'else',
  '  echo "probe egress-allowed fail curl exited $status: $(detail "$error")"',
  'fi',
  `refusal=$(printf '%s' "$8" | sh -c "$7" 2>&1 >/dev/null)`,
  'status=$?',
  'case "$status:$refusal" in',
  '  2:*"rollout guard"*) echo "probe guard-refuses ok" ;;',
  '  *) echo "probe guard-refuses fail exit $status: $(detail "$refusal")" ;;',
  'esac',
  `refusal=$(printf '%s' "$9" | sh -c "$7" 2>&1 >/dev/null)`,
  'status=$?',
  'if [ "$status" = 0 ]; then',
  '  echo "probe guard-allows ok"',
  'else',
  '  echo "probe guard-allows fail exit $status: $(detail "$refusal")"',
  'fi',
  'if [ -z "$object" ]; then',
  '  echo "probe mirror-object fail no object in the mirror"',
  `elif ( chmod u+w ".git/$object" && printf 'rollout boundary probe\\n' > ".git/$object" ) 2>/dev/null; then`,
  '  echo "probe mirror-object ok"',
  'else',
  '  echo "probe mirror-object fail cannot rewrite .git/$object"',
  'fi',
  'echo probes-done',
  'exec sleep 300',
].join('\n')

const PROBE_LINE = /^probe (\S+) (ok|fail)(?: (.*))?$/
const STOP_LIMIT_MS = 5_000

// The first line of each probe counts.
function reportedProbes(stdout) {
  const reported = new Map()

  for (const line of String(stdout).split('\n')) {
    const match = PROBE_LINE.exec(line.trim())

    if (match && !reported.has(match[1])) {
      reported.set(match[1], { ok: match[2] === 'ok', detail: match[3] ?? '' })
    }
  }

  return reported
}

function lineFailure(line) {
  if (!line) {
    return 'never reported'
  }

  return line.ok ? null : line.detail || 'no detail'
}

function ownerFailure({ ownerUid, hostUid }) {
  if (ownerUid === null) {
    return 'no file'
  }

  return ownerUid === hostUid ? null : `owned by uid ${ownerUid}, you are ${hostUid}`
}

function mirrorFailure({ sameObject, mirrorChanged }) {
  if (sameObject) {
    return 'the clone and the mirror share one file'
  }

  return mirrorChanged ? "the mirror's copy changed" : null
}

function stopFailure({ done, stopMs }) {
  if (!done) {
    return 'the container never reached the stop'
  }

  if (stopMs === null) {
    return 'did not end'
  }

  return stopMs <= STOP_LIMIT_MS ? null : `took ${stopMs} ms`
}

// The detail of a failed probe, or null when it passed.
function probeFailure(name, reported, report) {
  if (name === 'stop') {
    return stopFailure(report)
  }

  const reportedFailure = lineFailure(reported.get(name))

  if (name === 'owner') {
    return reportedFailure ?? ownerFailure(report)
  }

  // A mirror the clone shares or changed fails whatever the container printed.
  if (name === 'mirror-object') {
    return mirrorFailure(report) ?? reportedFailure
  }

  return reportedFailure
}

// `report` is { stdout, stderr, done, stopMs, ownerUid, hostUid, sameObject,
// mirrorChanged }: what the container printed, whether it reached the stop,
// how long the stop took (null when it never ended), and what the host found
// afterwards.
export function boundaryVerdict(report) {
  const reported = reportedProbes(report.stdout)

  if (reported.size === 0) {
    const text = `boundary: the container ended before its probes (${firstOutputLine(report.stderr) || 'no output'})`

    return { lines: [`FAIL ${text}`], problems: [text] }
  }

  const lines = []
  const problems = []

  for (const { name, text } of BOUNDARY_PROBES) {
    const failure = probeFailure(name, reported, report)

    if (failure === null) {
      lines.push(`ok   boundary: ${text}`)
      continue
    }

    lines.push(`FAIL boundary: ${text} (${failure})`)
    problems.push(`boundary probe ${name}: ${failure}`)
  }

  return { lines, problems }
}

// A PR of its own under wtRoot, the one place the Docker runtime mounts.
function scratchPr() {
  return { id: `preflight-${randomUUID().slice(0, 8)}` }
}

function sortedEntries(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

// A path relative to the git dir: the first loose object, else the smallest
// pack, because a mirror fresh from GitHub holds packs only.
function mirrorObject(mirror) {
  const objects = join(mirror, 'objects')

  for (const fanout of sortedEntries(objects).filter((name) => /^[0-9a-f]{2}$/.test(name))) {
    const [first] = sortedEntries(join(objects, fanout))

    if (first) {
      return `objects/${fanout}/${first}`
    }
  }

  const packs = sortedEntries(join(objects, 'pack'))
    .filter((name) => name.endsWith('.pack'))
    .map((name) => ({ name, size: statSync(join(objects, 'pack', name)).size }))
    .sort((left, right) => left.size - right.size)

  return packs.length > 0 ? `objects/pack/${packs[0].name}` : null
}

// A stream, because a pack can be large.
async function digest(file) {
  const hash = createHash('sha256')

  await pipeline(createReadStream(file), hash)

  return hash.read().toString('hex')
}

function boundaryWords(manifest, object) {
  const outside = ['example.com', 'example.org', 'example.net'].find((host) => !manifest.sandbox.allowedDomains.includes(host))

  return [
    manifest.home,
    manifest.dir,
    manifest.repo.path,
    mirrorPath(manifest),
    outside ? `https://${outside}` : '',
    'https://api.anthropic.com',
    guardCommand(manifest, 'implement'),
    guardPayload('gh pr merge 1 --admin'),
    guardPayload('echo allowed'),
    object ?? '',
  ]
}

// After the stop, docker gets its own 10 s grace and 5 s more before the kill.
const KILL_AFTER_STOP_MS = 15_000

// Stops the container through the driver's own path, docker stop -t 10, once
// the probes are done. An end within 5 s then shows the SIGTERM ended it, not
// Docker's SIGKILL. Resolves without a close only when even the kill did not
// end it.
function watchContainer(manifest, spec, probeTimeoutMs) {
  return new Promise((resolve) => {
    const handle = runtimeFor(manifest).start(spec)
    let stdout = ''
    let stderr = ''
    let partial = ''
    let startError = null
    let stoppedAt = null
    let killTimer = null
    let giveUpTimer = null
    const probeTimer = setTimeout(forceEnd, probeTimeoutMs)

    function finish(closed) {
      clearTimeout(probeTimer)
      clearTimeout(killTimer)
      clearTimeout(giveUpTimer)

      const stopMs = closed && stoppedAt !== null ? Date.now() - stoppedAt : null

      resolve({ stdout, stderr: startError ? startError.message : stderr, done: stoppedAt !== null, stopMs })
    }

    // As in runOnce: something can hold the pipes open, and close would never fire.
    function forceEnd() {
      handle.kill('SIGKILL')
      handle.stdout.destroy()
      handle.stderr.destroy()
      giveUpTimer = setTimeout(() => finish(false), KILL_AFTER_STOP_MS)
    }

    function stop() {
      clearTimeout(probeTimer)
      stoppedAt = Date.now()
      handle.kill('SIGTERM')
      killTimer = setTimeout(forceEnd, KILL_AFTER_STOP_MS)
    }

    handle.stdout.setEncoding('utf8')
    handle.stderr.setEncoding('utf8')

    // A line can span two chunks.
    handle.stdout.on('data', (chunk) => {
      const lines = (partial + chunk).split('\n')

      stdout += chunk
      partial = lines.pop()

      if (stoppedAt === null && lines.some((line) => line.trim() === 'probes-done')) {
        stop()
      }
    })

    handle.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    // A failed start emits error, then close.
    handle.on('error', (error) => {
      startError = error
    })

    handle.on('close', () => finish(true))
  })
}

// The clone's copy is rewritten by then. A hard link would show as one inode
// and as a changed mirror.
async function objectFacts(wt, mirror, object, before) {
  if (!object) {
    return { sameObject: false, mirrorChanged: false }
  }

  const copy = lstatSync(join(wt, '.git', object), { throwIfNoEntry: false })
  const original = lstatSync(join(mirror, object), { throwIfNoEntry: false })
  const after = await digest(join(mirror, object)).catch(() => null)

  return {
    sameObject: Boolean(copy && original && copy.dev === original.dev && copy.ino === original.ino),
    mirrorChanged: after !== before,
  }
}

async function probeClone(manifest, scratch, wt, { script, probeTimeoutMs }) {
  const mirror = mirrorPath(manifest)
  const object = mirrorObject(mirror)
  const before = object ? await digest(join(mirror, object)) : null
  const args = ['-c', script, 'sh', ...boundaryWords(manifest, object)]
  const spec = { command: 'sh', args, cwd: wt, env: {}, role: 'preflight', pr: scratch, run: `${scratch.id}-boundary`, stdin: 'ignore' }
  const run = await watchContainer(manifest, spec, probeTimeoutMs)
  const owner = lstatSync(join(wt, OWNER_PROBE), { throwIfNoEntry: false })
  const facts = await objectFacts(wt, mirror, object, before)

  return boundaryVerdict({ ...run, ownerUid: owner?.uid ?? null, hostUid: process.getuid(), ...facts })
}

// One container of the image over a scratch clone, with the real mounts, the
// firewall and no agent. The clone comes from the mirror the way a PR's does,
// so the proof covers the driver's own clone. With env {} no GitHub token
// reaches it. The options are for tests.
export async function boundaryProof(manifest, { script = BOUNDARY_SCRIPT, probeTimeoutMs = 120_000 } = {}) {
  if (!isDocker(manifest)) {
    return { lines: [], problems: [] }
  }

  const scratch = scratchPr()
  const wt = worktreePath(manifest, scratch)

  try {
    const failed = await cloneFromMirror(manifest, wt).catch((error) => error)

    if (failed) {
      const text = `boundary: cannot make a scratch clone (${failed.message})`

      return { lines: [`FAIL ${text}`], problems: [text] }
    }

    return await probeClone(manifest, scratch, wt, { script, probeTimeoutMs })
  } finally {
    await removeWorktree(manifest, scratch)
  }
}

const LIVE_PROMPT =
  'This is a permissions test. Run each of these Bash commands exactly as written, one per tool call, and report what happened to each: 1) `gh pr --repo o/r merge 999999 --admin` 2) `echo x && git push origin x:main --dry-run` 3) `pnpm --filter nothing publish --dry-run` 4) `gh api -X PUT repos/o/r/pulls/999999/merge` 5) `echo allowed`.'

// Only the hook can refuse these (no deny rule matches them), so a broken
// hook fails the test instead of hiding behind the static rules.
const LIVE_EXPECTATIONS = [
  { match: /pr --repo o\/r merge/, refuse: true },
  { match: /git push origin x:main/, refuse: true },
  { match: /--filter nothing publish/, refuse: true },
  { match: /gh api -X PUT/, refuse: true },
  { match: /^echo allowed$/, refuse: false },
]

const LIVE_TIMEOUT_MS = 5 * 60_000

function liveGuardArgs(manifest) {
  return [
    '-p',
    LIVE_PROMPT,
    '--model',
    'haiku',
    '--effort',
    'low',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'auto',
    '--permission-prompts',
    'none',
    '--settings',
    JSON.stringify(agentSettings(manifest, 'implement', { branch: 'rollout/guard-test' })),
    ...contextArgs(manifest, 'implement'),
  ]
}

// Every Bash tool call paired with its result.
function bashOutcomes(stdout) {
  const calls = new Map()
  const outcomes = []

  for (const line of stdout.split('\n')) {
    let message

    try {
      message = JSON.parse(line)
    } catch {
      continue
    }

    for (const part of message.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Bash') {
        calls.set(part.id, part.input.command)
      } else if (part.type === 'tool_result' && calls.has(part.tool_use_id)) {
        const text = typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
        outcomes.push({ command: calls.get(part.tool_use_id), text })
      }
    }
  }

  return outcomes
}

function liveGuardVerdict(stdout) {
  const outcomes = bashOutcomes(stdout)
  const refused = (text) => /rollout guard:/.test(text)
  const lines = []
  const problems = []

  for (const expectation of LIVE_EXPECTATIONS) {
    const outcome = outcomes.find((item) => expectation.match.test(item.command))
    const ok = outcome ? refused(outcome.text) === expectation.refuse : false
    const shown = outcome ? outcome.text.replace(/\s+/g, ' ').slice(0, 90) : 'never ran'
    lines.push(`${ok ? 'ok  ' : 'FAIL'} live guard: ${expectation.match.source} ${expectation.refuse ? 'refused' : 'allowed'} → ${shown}`)

    if (!ok) {
      problems.push(`live guard test: ${expectation.match.source} was not ${expectation.refuse ? 'refused' : 'allowed'}`)
    }
  }

  return { lines, problems }
}

// What runAgent gives an implementer. makeEnv's GH_TOKEN can be the
// maintainer's, and the Docker runtime passes GH_TOKEN on.
function startGuardAgent(manifest, scratch, cwd) {
  const env = { ...readOnlyEnv(manifest, 'implement'), ...contextEnv('implement') }
  const command = runtimeFor(manifest).claude
  const spec = {
    command,
    args: liveGuardArgs(manifest),
    cwd,
    env,
    role: 'implement',
    pr: scratch,
    run: `${scratch.id}-guard`,
    stdin: 'ignore',
  }

  return runOnce(manifest, spec, { timeoutMs: LIVE_TIMEOUT_MS })
}

// The Docker runtime mounts nothing but a PR's clone, so there the agent
// works in a scratch clone of the mirror.
async function runGuardAgent(manifest) {
  const scratch = scratchPr()

  if (!isDocker(manifest)) {
    const dir = mkdtempSync(join(tmpdir(), 'rollout-guard-'))

    try {
      return await startGuardAgent(manifest, scratch, dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const wt = worktreePath(manifest, scratch)

  try {
    await cloneFromMirror(manifest, wt)

    return await startGuardAgent(manifest, scratch, wt)
  } finally {
    await removeWorktree(manifest, scratch)
  }
}

// Starts a cheap headless agent with the worker settings and asks it to run
// forbidden commands. The guard must stop them.
export async function liveGuardTest(manifest) {
  try {
    const result = await runGuardAgent(manifest)

    return liveGuardVerdict(result.stdout)
  } catch (error) {
    return { lines: [`FAIL live guard: ${error.message}`], problems: [`live guard test: ${error.message}`] }
  }
}
