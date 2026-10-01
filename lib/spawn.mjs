import { spawn } from 'node:child_process'
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentSettings, readOnlyRole } from './settings.mjs'
import { makeEnv } from './sh.mjs'
import { agentGitHubEnv } from './identity.mjs'

const TRANSIENT = /rate.?limit|usage.?limit|overloaded|api_error|ECONNRESET|ETIMEDOUT|socket hang up/i
const ACCOUNT = /spend limit|credit balance|billing|budget.*exceeded/i
const MISSING_SESSION = /no conversation found|session .*not found/i
const TRANSIENT_KINDS = new Set(['rate_limit', 'overloaded', 'server_error'])
const ACCOUNT_KINDS = new Set(['billing_error', 'account_on_hold', 'authentication_failed'])

// The error kind of one parsed stream-json line, or null.
export function streamError(message) {
  if (!message || typeof message !== 'object') {
    return null
  }

  // A subagent's API error reaches the main agent as a tool result, and the main agent can recover from it.
  if (
    message.type === 'assistant' &&
    message.is_api_error_message === true &&
    typeof message.error === 'string' &&
    message.parent_tool_use_id == null
  ) {
    return message.error
  }

  if (message.type === 'rate_limit_event' && message.rate_limit_info?.status === 'rejected') {
    return 'rate_limit'
  }

  return null
}

export function failureSignals(result, stderr, streamErrors = []) {
  // The run's own cap is neither an outage nor an account limit, whatever the budget regex says.
  if (result?.subtype === 'error_max_budget_usd') {
    return { transient: false, account: false, sessionMissing: false }
  }

  const status = Number(result?.api_error_status) || 0

  return {
    transient: status === 429 || status >= 500 || TRANSIENT.test(stderr) || streamErrors.some((kind) => TRANSIENT_KINDS.has(kind)),
    account: ACCOUNT.test(stderr) || streamErrors.some((kind) => ACCOUNT_KINDS.has(kind)),
    sessionMissing: MISSING_SESSION.test(stderr),
  }
}

// The error text of a failed run. The first rule that yields text wins.
export function failureReason({ result, stderr, spawnError, code, signal, budgetUsd }) {
  if (typeof result?.result === 'string' && result.result) {
    return result.result
  }

  if (spawnError?.message) {
    return spawnError.message
  }

  let label = null

  if (result?.subtype === 'error_max_budget_usd') {
    label = `hit its budget cap ($${budgetUsd})`
  } else if (result?.subtype !== 'success') {
    label = result?.subtype
  }

  const errors = Array.isArray(result?.errors) ? result.errors.filter((error) => typeof error === 'string') : []
  const parts = [signal ? `killed by ${signal}` : null, label, ...errors, (stderr ?? '').trim()].filter(Boolean)

  if (parts.length > 0) {
    return parts.join(': ')
  }

  return `exited with code ${code}`
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
// { ok, output, costUsd, seconds, sessionId, denials, error, stopped, transient,
// account, sessionMissing } and never rejects. Tests pass their own timers to
// fire the deadline by hand.
const SCHEMAS = { implement: 'ready', fix: 'ready', verify: 'verdict', brief: 'brief', delegate: 'delegate' }
const TIMERS = { setTimeout, clearTimeout, setInterval, clearInterval }

export function runAgent(M, pr, { role, prompt, effort, sessionId, resume, cwd, logName }, { timers = TIMERS } = {}) {
  const verifier = readOnlyRole(role)
  const budgetUsd = M.policy.budgetUsd[effort]

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
    String(budgetUsd),
  ]

  const timeoutMinutes = M.policy.timeouts[role]

  if (verifier) {
    args.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit')
  }

  args.push(...(resume ? ['--resume', sessionId] : ['--session-id', sessionId]))

  // No npm credentials reach agents (every publish path fails with ENEEDAUTH).
  // Read-only roles get no branch, but they work in the PR worktree, whose
  // rollout-branch marker lets pre-push through. The guard refuses their pushes.
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
    let spawnError = null
    let killedFor = null
    let stderrAtKill = ''
    const streamErrors = new Set()
    let lastOutput = Date.now()

    function kill(reason) {
      if (killedFor) {
        return
      }

      killedFor = reason
      // Output written after SIGTERM is about the kill, not about why the run failed.
      stderrAtKill = stderr
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
    }

    const watchdog = timers.setInterval(() => {
      if (Date.now() - lastOutput > stallMs) {
        kill(`no output for ${M.policy.stallMinutes} min`)
      }
    }, 30_000)

    const deadline = timers.setTimeout(() => kill(`timeout after ${timeoutMinutes} min`), timeoutMs)

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
          const kind = streamError(message)

          if (kind) {
            streamErrors.add(kind)
          }

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

    // Unhandled, a missing binary (ENOENT) would kill the driver. Node still emits close afterwards.
    child.on('error', (error) => {
      spawnError = error
    })

    child.on('close', (code, signal) => {
      children.delete(child)
      timers.clearInterval(watchdog)
      timers.clearTimeout(deadline)
      log.end()

      const costUsd = result?.total_cost_usd ?? 0
      const output = result?.structured_output ?? null
      const failed = !result || result.is_error || !output
      const reason = failureReason({ result, stderr, spawnError, code, signal, budgetUsd })
      const error = failed ? (killedFor ?? reason) : null
      const signals = failureSignals(result, killedFor ? stderrAtKill : stderr, [...streamErrors])

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
