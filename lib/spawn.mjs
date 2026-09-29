import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentSettings, readOnlyRole } from './settings.mjs'
import { makeEnv } from './sh.mjs'
import { agentGitHubEnv } from './identity.mjs'

const TRANSIENT = /rate.?limit|usage.?limit|overloaded|api_error|ECONNRESET|ETIMEDOUT|socket hang up/i
const ACCOUNT = /spend limit|credit balance|billing|budget.*exceeded/i
const MISSING_SESSION = /no conversation found|session .*not found/i

export function failureSignals(result, stderr) {
  const status = Number(result?.api_error_status) || 0

  return {
    transient: status === 429 || status >= 500 || TRANSIENT.test(stderr),
    account: ACCOUNT.test(stderr),
    sessionMissing: MISSING_SESSION.test(stderr),
  }
}

// Live agent processes, so the driver can stop them when it stops: an
// orphaned agent would race its own resumed session after a restart.
export const children = new Set()
let stopped = false

export function stopAllAgents() {
  stopped = true

  for (const child of children) {
    child.stopReason = 'driver-stop'
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
  }
}

function emptyNpmrc(M) {
  const path = join(M.dir, '.npmrc-agents')
  writeFileSync(path, '# rollout agents: no registry credentials\n')

  return path
}

function schema(M, name) {
  return JSON.stringify(JSON.parse(readFileSync(join(M.home, 'schemas', `${name}.json`), 'utf8')))
}

// Runs one headless agent: `claude -p` with a JSON-schema report, its own
// settings and guard hook, a stall watchdog and a hard timeout. Resolves with
// { ok, output, costUsd, sessionId, error, rateLimited }; never rejects.
const SCHEMAS = { implement: 'ready', fix: 'ready', verify: 'verdict', brief: 'brief' }

export function runAgent(M, pr, { role, prompt, effort, sessionId, resume, cwd, logName }) {
  const verifier = readOnlyRole(role)

  // The prompt goes in on stdin: briefs and brief sources get large.
  const args = [
    '-p',
    '--model',
    M.model,
    '--effort',
    effort,
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    schema(M, SCHEMAS[role]),
    '--permission-mode',
    'auto',
    '--permission-prompts',
    'none',
    '--settings',
    JSON.stringify(agentSettings(M, role)),
    '--max-budget-usd',
    String(M.policy.budgetUsd[effort]),
  ]

  const timeoutMinutes = M.policy.timeouts[role]

  if (verifier) {
    args.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit')
  }

  args.push(...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]))

  // No npm credentials reach agents (every publish path fails with ENEEDAUTH),
  // and a verifier gets no branch, so the pre-push hook refuses all its pushes.
  const env = makeEnv(M, {
    ...agentGitHubEnv(M),
    ROLLOUT_BRANCH: verifier ? '' : pr.branch,
    ROLLOUT_ROLE: role,
    ROLLOUT_ID: pr.id,
    ROLLOUT_DIR: M.dir,
    ROLLOUT_HOME: M.home,
    ROLLOUT_NAME: M.rollout,
    NPM_CONFIG_USERCONFIG: emptyNpmrc(M),
    NPM_TOKEN: '',
    NODE_AUTH_TOKEN: '',
  })
  const log = createWriteStream(join(M.dir, 'logs', `${logName}.jsonl`), { flags: 'a' })
  const stallMs = M.policy.stallMinutes * 60_000
  const timeoutMs = timeoutMinutes * 60_000

  return new Promise((resolve) => {
    if (stopped) {
      resolve({
        ok: false,
        stopped: true,
        output: null,
        costUsd: 0,
        sessionId,
        denials: [],
        error: 'driver stopping',
        transient: false,
        account: false,
      })
      return
    }

    const startedAt = Date.now()
    const child = spawn(M.claudeBin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
    let buffer = ''
    let stderr = ''
    let result = null
    let killedFor = null
    let lastOutput = Date.now()

    function kill(reason) {
      if (killedFor) {
        return
      }

      killedFor = reason
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
    }

    const watchdog = setInterval(() => {
      if (Date.now() - lastOutput > stallMs) {
        kill(`no output for ${M.policy.stallMinutes} min`)
      }
    }, 30_000)

    const deadline = setTimeout(() => kill(`timeout after ${timeoutMinutes} min`), timeoutMs)

    child.stdout.on('data', (chunk) => {
      lastOutput = Date.now()
      log.write(chunk)
      buffer += chunk

      let newline = buffer.indexOf('\n')

      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')

        try {
          const message = JSON.parse(line)

          if (message.type === 'result') {
            result = message
          }
        } catch {
          // Partial or non-JSON line; the log keeps it.
        }
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000)
    })

    child.on('close', (code) => {
      children.delete(child)
      clearInterval(watchdog)
      clearTimeout(deadline)
      log.end()

      const costUsd = result?.total_cost_usd ?? 0
      const output = result?.structured_output ?? null
      const failed = !result || result.is_error || !output
      const reason = result?.result ?? ([result?.subtype, stderr.trim()].filter(Boolean).join(': ') || `exited with code ${code}`)
      const error = failed ? (killedFor ?? reason) : null
      const signals = failureSignals(result, killedFor ? '' : stderr)

      resolve({
        ok: !failed,
        output,
        costUsd,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        sessionId: result?.session_id ?? sessionId,
        denials: result?.permission_denials ?? [],
        error: error ? String(error).slice(0, 2000) : null,
        stopped: child.stopReason === 'driver-stop',
        transient: failed && signals.transient,
        account: failed && signals.account,
        sessionMissing: failed && signals.sessionMissing,
      })
    })
  })
}
