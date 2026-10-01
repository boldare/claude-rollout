import { remoteRepo } from './github.mjs'
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
export function probeTools(M) {
  const common = M.repo.verify?.common
  const commands = [M.repo.install, ...(Array.isArray(common) ? common : [])].filter((command) => typeof command === 'string')
  const tools = ['node']

  for (const command of commands) {
    const manager = MANAGERS.get(firstWord(command))

    if (manager && !tools.includes(manager)) {
      tools.push(manager)
    }
  }

  return tools
}

export async function sshHostname(M, host) {
  const result = await sh('ssh', ['-G', host], { env: makeEnv(M) })

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
export async function originCheck(M, url, resolveHost) {
  const remote = remoteRepo(url)

  if (!remote) {
    return { ok: false, text: `origin ${url ? withoutUserinfo(url) : '(none)'} is not a GitHub SSH or HTTPS URL` }
  }

  const { protocol, host, repo } = remote

  if (repo !== M.repo.github.toLowerCase()) {
    return { ok: false, text: `origin is ${repo} on ${host}, not ${M.repo.github}` }
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
