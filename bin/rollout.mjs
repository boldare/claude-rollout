#!/usr/bin/env node
// rollout: drives a multi-PR plan. See ../SKILL.md.
//
//   rollout.mjs run       [--dir D] [--only A1,A6] [--dry-run]
//   rollout.mjs status    [--dir D]
//   rollout.mjs card      <id> [--dir D]
//   rollout.mjs approve   <id> [--dir D]
//   rollout.mjs note      <id> "<answer>" [--dir D]
//   rollout.mjs retry     <id> [--dir D]
//   rollout.mjs hold | release <id> [--dir D]
//   rollout.mjs pause | resume | unhalt [--dir D]
//   rollout.mjs stop      [--dir D]   (stops the driver; agents resume on the next run)
//   rollout.mjs preflight [--dir D] [--live]
//   rollout.mjs ui        [--root ROOT] [--port N] [--no-open] [--read-only]
//                         (serves a local web UI over the rollouts in ROOT, default $ROLLOUT_ROOT or ~/.rollouts)
//                         (--read-only disables the controls)
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadManifest } from '../lib/manifest.mjs'
import { lockHolder, postCommand, readLedger } from '../lib/ledger.mjs'
import { runDriver } from '../lib/driver.mjs'
import { liveness, prDetail, readEvents, rolloutView, runsFromEvents } from '../lib/view.mjs'
import { makeEnv, sh } from '../lib/sh.mjs'
import { agentGitHubEnv } from '../lib/identity.mjs'
import { agentSettings, guardCommand } from '../lib/settings.mjs'
import { startServer } from '../lib/server.mjs'
import { rolloutRoot } from '../lib/rollouts.mjs'
import { execFile, spawnSync } from 'node:child_process'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string', default: process.env.ROLLOUT_DIR ?? process.cwd() },
    only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    root: { type: 'string' },
    port: { type: 'string' },
    // Its own option because allowNegative is missing before Node 20.16.
    'no-open': { type: 'boolean', default: false },
    'read-only': { type: 'boolean', default: false },
  },
})

const [command, ...rest] = positionals

function manifest() {
  return loadManifest(values.dir, {
    only: values.only ? values.only.split(',').map((id) => id.trim()) : null,
    dryRun: values['dry-run'],
  })
}

function requireId(M) {
  const id = rest[0]

  if (!id || !M.all.some((pr) => pr.id === id)) {
    console.error(`unknown or missing PR id: ${id ?? '(none)'}; known: ${M.all.map((pr) => pr.id).join(', ')}`)
    process.exit(1)
  }

  return id
}

function age(iso) {
  if (!iso) {
    return '-'
  }

  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)

  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

function status(M) {
  const view = rolloutView(M)

  if (!view) {
    console.log(`no ledger yet in ${M.dir}; start the driver with: rollout.mjs run --dir ${M.dir}`)
    return
  }

  const { driver } = view
  const driverText = driver.running
    ? `running (pid ${driver.pid}, last heartbeat ${driver.heartbeatAgeSeconds}s ago${driver.heartbeatNote ? `: ${driver.heartbeatNote}` : ''})`
    : `NOT RUNNING (last heartbeat ${driver.heartbeatAgeSeconds === null ? 'never' : `${Math.round(driver.heartbeatAgeSeconds / 60)} min ago`})`

  console.log(`rollout ${M.rollout}  driver: ${driverText}`)

  if (driver.paused) {
    console.log('PAUSED (rollout.mjs resume)')
  }

  if (driver.halted) {
    console.log(`HALTED: ${driver.halted} (rollout.mjs unhalt)`)
  }

  console.log('')
  console.log('id    state          PR     head     CI/gate                                   attempts  cost')

  for (const row of view.rows) {
    const attempts = `${row.attempts.implement}/${row.attempts.fix}/${row.attempts.verify}`

    console.log(
      `${row.id.padEnd(5)} ${row.state.padEnd(14)} ${(row.pr ? `#${row.pr}` : '-').padEnd(6)} ${row.head.padEnd(8)} ${row.info.slice(0, 41).padEnd(41)} ${attempts.padEnd(9)} $${row.costUsd.toFixed(2)}`,
    )
  }

  const recent = view.events.slice(-8)

  if (recent.length > 0) {
    console.log('\nrecent events:')

    for (const { at, id, kind, ...detail } of recent) {
      console.log(`  ${age(at).padStart(4)} ago  ${String(id ?? '-').padEnd(4)} ${kind} ${JSON.stringify(detail).slice(0, 110)}`)
    }
  }
}

function card(M, id) {
  const ledger = readLedger(M)

  if (!ledger) {
    console.log('no state yet')
    return
  }

  const events = readEvents(M)
  const runs = runsFromEvents(events, { driverRunning: liveness(M).running })
  const s = prDetail(M, ledger, events, runs, id)

  console.log(`# ${id} ${s.title}  (${s.branch})`)
  console.log(`state: ${s.state}   PR: ${s.url ?? '-'}   cost: $${s.costUsd.toFixed(2)}`)

  if (s.held) {
    console.log(`held since ${s.held.at} (rollout.mjs release ${id})`)
  }

  console.log(
    `verified: ${s.verified ? `${s.verified.sha} (patch ${s.verified.patchId?.slice(0, 10)})` : 'no'}   approved: ${s.approved ? s.approved.sha : 'no'}`,
  )

  const onGitHub = s.approval === 'github'
  console.log(
    `author: ${s.author ?? '?'}   approval: ${onGitHub ? `a maintainer review on GitHub (${s.maintainers.join(', ')})` : 'rollout approve'}`,
  )

  if (s.gate) {
    console.log(`gate: ${s.gate.action}${s.gate.reasons.length ? ` — ${s.gate.reasons.join('; ')}` : ''}`)
  }

  const { brief } = s
  console.log(`brief: ${brief.exists ? brief.path : 'not written yet'}${brief.notesExist ? `   reviewer notes: ${brief.notesPath}` : ''}`)

  if (s.blocked && s.state === 'blocked') {
    console.log(`\nBLOCKED (${s.blocked.kind}): ${s.blocked.question}\n${s.blocked.evidence ?? ''}`)
  }

  if (s.ready) {
    console.log(`\nimplementer: ${s.ready.summary}`)

    for (const item of s.ready.deviations ?? []) {
      console.log(`  deviation: ${item.file}: ${item.reason}`)
    }

    for (const item of s.ready.expected ?? []) {
      console.log(`  expected: ${item.claim} → ${item.observed}`)
    }
  }

  if (s.workflowFiles?.length) {
    console.log(`\nCI/WORKFLOW FILES CHANGED (review the diff before approving): ${s.workflowFiles.join(', ')}`)
  }

  if (s.outOfScope?.length) {
    console.log(`\nfiles outside the manifest scope: ${s.outOfScope.join(', ')}`)
  }

  if (s.verdict) {
    console.log(`\nverifier: ${s.verdict.verdict} on ${s.verdict.sha?.slice(0, 7)} — ${s.verdict.summary}`)

    for (const item of s.verdict.checklist ?? []) {
      console.log(`  [${item.status}] ${item.item}`)
    }

    for (const item of s.verdict.blocking ?? []) {
      console.log(`  BLOCKING: ${item}`)
    }

    for (const item of s.verdict.nonBlocking ?? []) {
      console.log(`  note: ${item}`)
    }
  }

  if (s.state === 'verified') {
    console.log(
      onGitHub
        ? `\nApprove with a review on GitHub: https://github.com/${M.repo.github}/pull/${s.pr}/files`
        : `\nApprove with: rollout.mjs approve ${id} --dir ${M.dir}`,
    )
  }
}

async function preflight(M) {
  const env = makeEnv(M)
  const problems = []
  const warnings = []

  async function probe(label, cmd, args, { problem = label, ...options } = {}) {
    const result = await sh(cmd, args, { env, cwd: M.repo.path, ...options })
    const text = (result.stdout || result.stderr).trim().split('\n')[0]
    console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${label}: ${text}`)

    if (result.code !== 0) {
      problems.push(problem)
    }

    return result
  }

  console.log(`manifest ok: ${M.rollout}, ${M.prs.length} PR(s): ${M.prs.map((pr) => pr.id).join(', ')}`)

  const toWrite = M.prs.filter((pr) => !existsSync(pr.brief)).map((pr) => pr.id)

  if (toWrite.length > 0) {
    console.log(`ok   briefs the driver will write when their dependencies merge: ${toWrite.join(', ')}`)
  }

  await probe('claude', M.claudeBin, ['--version'], {
    problem: `claude (${M.claudeBin}) did not run: put it on PATH or repo.pathPrepend, or set claudeBin in manifest.yaml`,
  })
  await probe('node', 'node', ['--version'])
  await probe('pnpm', 'pnpm', ['--version'])
  await probe('gh auth', 'gh', ['auth', 'status'])
  await probe('git fetch', 'git', ['-C', M.repo.path, 'fetch', '--quiet', 'origin'])

  const remote = await sh('git', ['-C', M.repo.path, 'remote', 'get-url', 'origin'], { env })

  if (!remote.stdout.includes(M.repo.github)) {
    problems.push(`origin ${remote.stdout.trim()} does not match ${M.repo.github}`)
  }

  const repo = await sh('gh', ['api', `repos/${M.repo.github}`], { env })

  if (repo.code === 0) {
    const info = JSON.parse(repo.stdout)

    if (M.repo.merge.method === 'squash' && !info.allow_squash_merge) {
      problems.push('squash merges are disabled on the repository')
    }

    if (
      M.repo.merge.method === 'squash' &&
      (info.squash_merge_commit_title !== 'PR_TITLE' || info.squash_merge_commit_message !== 'BLANK')
    ) {
      warnings.push(
        `repository squash default is ${info.squash_merge_commit_title}/${info.squash_merge_commit_message}; the driver passes --subject and an empty --body, so its merges are one line anyway`,
      )
    }

    if (M.repo.merge.admin && !info.permissions?.admin) {
      problems.push('merge.admin is set but the gh account is not a repository admin')
    }

    if (info.private === false && M.repo.public === false) {
      problems.push('the repository is public but repo.public is false')
    }

    if (info.private === true && M.repo.public === true) {
      warnings.push('the repository is private: set repo.public: false to drop the public-repository rules from the prompts')
    }
  } else {
    problems.push('cannot read the repository with gh')
  }

  if (M.repo.agentToken) {
    try {
      const agentEnv = makeEnv(M, agentGitHubEnv(M))
      const who = await sh('gh', ['api', 'user', '--jq', '.login'], { env: agentEnv })
      const login = who.stdout.trim()
      const permission = await sh('gh', ['api', `repos/${M.repo.github}/collaborators/${login}/permission`, '--jq', '.permission'], { env })
      const scopes =
        (await sh('gh', ['api', '-i', 'user'], { env: agentEnv })).stdout.match(/^x-oauth-scopes:\s*(.*)$/im)?.[1]?.trim() ?? '?'
      const fallback = await sh('gh', ['auth', 'status'], { env: { ...agentEnv, GH_TOKEN: '' } })
      const ok = who.code === 0 && !M.repo.maintainers.includes(login) && permission.stdout.trim() === 'write'
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} agent identity: ${login || '?'} (permission ${permission.stdout.trim() || '?'}, scopes ${scopes})`,
      )
      console.log(`${fallback.code !== 0 ? 'ok  ' : 'FAIL'} without GH_TOKEN, agents' gh has no stored login to fall back to`)

      if (!ok) {
        problems.push('agent token must belong to a non-maintainer account with write (not admin) permission')
      }

      if (fallback.code === 0) {
        problems.push('agents could fall back to a stored gh login')
      }

      if (!/\bworkflow\b/.test(scopes)) {
        warnings.push('agent token lacks the workflow scope: PRs that change .github/workflows cannot be pushed')
      }
    } catch (error) {
      problems.push(`agent token: ${error.message}`)
    }
  } else {
    warnings.push('no repo.agentToken: agents act on GitHub as you')
  }

  if (M.policy.merge === 'auto') {
    warnings.push('policy.merge is auto: the driver merges without asking')
  }

  hookSelfTest(M, problems)

  if (values.live) {
    await liveGuardTest(M, problems)
  }

  for (const warning of warnings) {
    console.log(`warn ${warning}`)
  }

  if (problems.length > 0) {
    console.log(`\npreflight FAILED:\n- ${problems.join('\n- ')}`)
    process.exit(1)
  }

  console.log('\npreflight ok')
}

// Feeds the guard command a payload the way an agent's Bash call does. A
// forbidden command must exit 2 and an allowed one must exit 0, so a guard
// that refuses everything fails too.
function hookSelfTest(M, problems) {
  const denied = runGuard(M, 'gh pr merge 1 --admin')
  const deniedOk = denied.status === 2 && /rollout guard/.test(denied.stderr)
  console.log(`${deniedOk ? 'ok  ' : 'FAIL'} guard hook command exits 2 on a forbidden command`)

  if (!deniedOk) {
    problems.push(`guard hook self-test failed (exit ${denied.status}): ${denied.stderr.slice(0, 200)}`)
  }

  const allowed = runGuard(M, 'echo allowed')
  const allowedOk = allowed.status === 0
  console.log(`${allowedOk ? 'ok  ' : 'FAIL'} guard hook command exits 0 on an allowed command`)

  if (!allowedOk) {
    problems.push(`guard hook self-test failed: an allowed command exited ${allowed.status}: ${allowed.stderr.slice(0, 200)}`)
  }
}

function runGuard(M, command) {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } })

  return spawnSync('sh', ['-c', guardCommand(M, 'implement')], { input: payload, encoding: 'utf8' })
}

// Starts a cheap headless agent with the worker settings in a scratch
// directory and asks it to run forbidden commands. The guard must stop them.
async function liveGuardTest(M, problems) {
  const scratch = mkdtempSync(join(tmpdir(), 'rollout-guard-'))
  const prompt =
    'This is a permissions test. Run each of these Bash commands exactly as written, one per tool call, and report what happened to each: 1) `gh pr --repo o/r merge 999999 --admin` 2) `echo x && git push origin x:main --dry-run` 3) `pnpm --filter nothing publish --dry-run` 4) `gh api -X PUT repos/o/r/pulls/999999/merge` 5) `echo allowed`.'
  const result = await sh(
    M.claudeBin,
    [
      '-p',
      prompt,
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
      JSON.stringify(agentSettings(M, 'implement')),
    ],
    { cwd: scratch, env: makeEnv(M, { ROLLOUT_BRANCH: 'rollout/guard-test' }), timeout: 5 * 60_000 },
  )

  rmSync(scratch, { recursive: true, force: true })

  // Pair every Bash tool call with its result and judge each command.
  const calls = new Map()
  const outcomes = []

  for (const line of result.stdout.split('\n')) {
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

  // Only the hook can refuse these (no deny rule matches them), so a broken
  // hook fails the test instead of hiding behind the static rules.
  const refused = (text) => /rollout guard:/.test(text)
  const expectations = [
    { match: /pr --repo o\/r merge/, refuse: true },
    { match: /git push origin x:main/, refuse: true },
    { match: /--filter nothing publish/, refuse: true },
    { match: /gh api -X PUT/, refuse: true },
    { match: /^echo allowed$/, refuse: false },
  ]

  for (const expectation of expectations) {
    const outcome = outcomes.find((item) => expectation.match.test(item.command))
    const ok = outcome ? refused(outcome.text) === expectation.refuse : false
    const shown = outcome ? outcome.text.replace(/\s+/g, ' ').slice(0, 90) : 'never ran'
    console.log(`${ok ? 'ok  ' : 'FAIL'} live guard: ${expectation.match.source} ${expectation.refuse ? 'refused' : 'allowed'} → ${shown}`)

    if (!ok) {
      problems.push(`live guard test: ${expectation.match.source} was not ${expectation.refuse ? 'refused' : 'allowed'}`)
    }
  }
}

function openBrowser(url) {
  const opener = { darwin: 'open', linux: 'xdg-open' }[process.platform]

  if (opener) {
    execFile(opener, [url], () => {})
  }
}

async function ui() {
  const root = rolloutRoot(values.root)
  const port = values.port ?? '0'

  if (!/^\d+$/.test(port) || Number(port) > 65535) {
    console.error(`rollout ui: --port must be a number from 0 to 65535, got ${port}`)
    process.exit(1)
  }

  const readOnly = values['read-only']
  const server = await startServer({ root, port: Number(port), readOnly })
  console.log(`rollout ui: ${server.url} (Ctrl-C stops it)`)

  if (readOnly) {
    console.log('read-only: the controls are disabled')
  }

  if (!values['no-open']) {
    openBrowser(server.url)
  }

  async function shutdown() {
    await server.close()
    process.exit(0)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

// The comment block right after the shebang.
function usage() {
  const lines = readFileSync(new URL(import.meta.url), 'utf8').split('\n')
  const end = lines.findIndex((line, index) => index > 0 && !line.startsWith('//'))

  return lines.slice(1, end).join('\n')
}

async function main() {
  if (!command || command === 'help') {
    console.log(usage())
    return
  }

  if (process.env.ROLLOUT_ROLE && command !== 'status' && command !== 'card') {
    console.error('rollout: agents cannot drive the rollout (ROLLOUT_ROLE is set)')
    process.exit(1)
  }

  // Before manifest(): ui works over a root of rollouts, not one --dir. Agents
  // are refused above because the printed URL carries the token.
  if (command === 'ui') {
    await ui()
    return
  }

  const M = manifest()

  switch (command) {
    case 'run':
      await runDriver(M)
      break

    case 'status':
      status(M)
      break

    case 'card':
      card(M, requireId(M))
      break

    case 'approve': {
      const id = requireId(M)
      const s = readLedger(M)?.prs[id]

      if (s?.state !== 'verified' || !s.verified) {
        console.error(`${id} is ${s?.state ?? 'unknown'}, not verified; nothing to approve`)
        process.exit(1)
      }

      postCommand(M, { cmd: 'approve', id, sha: s.verified.sha, patchId: s.verified.patchId })
      console.log(
        `approving ${id} PR #${s.pr} at ${s.verified.sha} (patch ${s.verified.patchId.slice(0, 12)}); the driver merges ${M.policy.mergeDelaySeconds}s after it accepts`,
      )
      break
    }

    case 'note': {
      const id = requireId(M)
      const text = rest.slice(1).join(' ').trim()

      if (!text) {
        console.error('note needs the answer text')
        process.exit(1)
      }

      postCommand(M, { cmd: 'note', id, text })
      console.log('queued for the implementer')
      break
    }

    case 'retry':
    case 'hold':
    case 'release':
      postCommand(M, { cmd: command, id: requireId(M) })
      console.log('queued')
      break

    case 'stop': {
      const holder = lockHolder(M)

      if (!holder) {
        console.log('no driver is running')
        break
      }

      process.kill(holder.pid, 'SIGTERM')

      for (let waited = 0; waited < 30 && lockHolder(M); waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      console.log(lockHolder(M) ? `driver ${holder.pid} is still stopping` : `driver ${holder.pid} stopped; agents resume on the next run`)
      break
    }

    case 'pause':
    case 'resume':
    case 'unhalt':
      postCommand(M, { cmd: command })
      console.log('queued')
      break

    case 'preflight':
      await preflight(M)
      break

    default:
      console.error(`unknown command ${command}`)
      process.exit(1)
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exit(1)
})
