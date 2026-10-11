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
import { approveRefusal } from '../lib/judge.mjs'
import { lockHolder, postCommand, readLedger } from '../lib/ledger.mjs'
import { stopDriver } from '../lib/control.mjs'
import { runDriver } from '../lib/driver.mjs'
import { batteryWarning } from '../lib/machine.mjs'
import { liveness, prDetail, readEvents, rolloutView, runsFromEvents } from '../lib/view.mjs'
import { makeEnv, sh } from '../lib/sh.mjs'
import { agentEnv } from '../lib/identity.mjs'
import { ghEnv } from '../lib/github.mjs'
import { guardSelfTest, originCheck, probeTools, sshHostname, storedLoginCheck } from '../lib/preflight.mjs'
import { agentSettings } from '../lib/settings.mjs'
import { startServer } from '../lib/server.mjs'
import { rolloutRoot } from '../lib/rollouts.mjs'
import { execFile } from 'node:child_process'

const CLI_OPTIONS = {
  allowPositionals: true,
  // --no-open is the negative of open.
  allowNegative: true,
  options: {
    dir: { type: 'string', default: process.env.ROLLOUT_DIR ?? process.cwd() },
    only: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    root: { type: 'string' },
    port: { type: 'string' },
    open: { type: 'boolean', default: true },
    'read-only': { type: 'boolean', default: false },
  },
}

function parseCli() {
  try {
    return parseArgs(CLI_OPTIONS)
  } catch (error) {
    console.error(`rollout: ${error.message}`)
    console.error(usage())
    process.exit(1)
  }
}

const { values, positionals } = parseCli()

const [command, ...rest] = positionals

function currentManifest() {
  return loadManifest(values.dir, {
    only: values.only ? values.only.split(',').map((id) => id.trim()) : null,
    dryRun: values['dry-run'],
  })
}

function requireId(manifest) {
  const id = rest[0]

  if (!id || !manifest.all.some((pr) => pr.id === id)) {
    console.error(`unknown or missing PR id: ${id ?? '(none)'}; known: ${manifest.all.map((pr) => pr.id).join(', ')}`)
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

function status(manifest) {
  const view = rolloutView(manifest)

  if (!view) {
    console.log(`no ledger yet in ${manifest.dir}; start the driver with: rollout.mjs run --dir ${manifest.dir}`)
    return
  }

  const { driver } = view
  const driverText = driver.running
    ? `running (pid ${driver.pid}, last heartbeat ${driver.heartbeatAgeSeconds}s ago${driver.heartbeatNote ? `: ${driver.heartbeatNote}` : ''})`
    : `NOT RUNNING (last heartbeat ${driver.heartbeatAgeSeconds === null ? 'never' : `${Math.round(driver.heartbeatAgeSeconds / 60)} min ago`})`

  console.log(`rollout ${manifest.rollout}  driver: ${driverText}`)

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

function approvalLine(manifest, entry) {
  if (entry.approval === 'github') {
    return `a maintainer review on GitHub (${entry.maintainers.join(', ')})`
  }

  if (entry.approval === 'inbox') {
    return 'rollout approve'
  }

  return `none under policy.merge ${manifest.policy.merge}`
}

function approveHint(manifest, entry, id) {
  if (entry.approval === 'github') {
    return `Approve with a review on GitHub: https://github.com/${manifest.repo.github}/pull/${entry.pr}/files`
  }

  if (entry.approval === 'inbox') {
    return `Approve with: rollout.mjs approve ${id} --dir ${manifest.dir}`
  }

  return approveRefusal(manifest, entry)
}

function printDelegate(delegate) {
  if (delegate.maxPerPr === null && delegate.answers.length === 0) {
    return
  }

  const runs = delegate.maxPerPr === null ? `off, ${delegate.runs} runs` : `${delegate.runs} of ${delegate.maxPerPr} runs`
  console.log(`\ndelegate: ${runs}`)

  for (const answer of delegate.answers) {
    const text = ['answer', 'dropped'].includes(answer.decision) ? answer.answer : answer.reasoning
    console.log(`  ${answer.decision} on ${answer.kind} at ${answer.at} (${answer.run}): ${(text ?? '').slice(0, 300)}`)

    if (answer.planRefs?.length > 0) {
      console.log(`    plan: ${answer.planRefs.join(', ')}`)
    }
  }
}

function card(manifest, id) {
  const ledger = readLedger(manifest)

  if (!ledger) {
    console.log('no state yet')
    return
  }

  const events = readEvents(manifest)
  const runs = runsFromEvents(events, { driverRunning: liveness(manifest).running })
  const entry = prDetail(manifest, ledger, events, runs, id)

  console.log(`# ${id} ${entry.title}  (${entry.branch})`)
  console.log(`state: ${entry.state}   PR: ${entry.url ?? '-'}   cost: $${entry.costUsd.toFixed(2)}`)

  if (entry.held) {
    console.log(`held since ${entry.held.at} (rollout.mjs release ${id})`)
  }

  console.log(
    `verified: ${entry.verified ? `${entry.verified.sha} (patch ${entry.verified.patchId?.slice(0, 10)})` : 'no'}   approved: ${entry.approved ? entry.approved.sha : 'no'}`,
  )

  console.log(`author: ${entry.author ?? '?'}   approval: ${approvalLine(manifest, entry)}`)

  if (entry.gate) {
    console.log(`gate: ${entry.gate.action}${entry.gate.reasons.length ? ` — ${entry.gate.reasons.join('; ')}` : ''}`)
  }

  const { brief } = entry
  console.log(`brief: ${brief.exists ? brief.path : 'not written yet'}${brief.notesExist ? `   reviewer notes: ${brief.notesPath}` : ''}`)

  if (entry.blocked && entry.state === 'blocked') {
    console.log(`\nBLOCKED (${entry.blocked.kind}): ${entry.blocked.question}\n${entry.blocked.evidence ?? ''}`)
  }

  printDelegate(entry.delegate)

  if (entry.ready) {
    console.log(`\nimplementer: ${entry.ready.summary}`)

    for (const item of entry.ready.deviations ?? []) {
      console.log(`  deviation: ${item.file}: ${item.reason}`)
    }

    for (const item of entry.ready.expected ?? []) {
      console.log(`  expected: ${item.claim} → ${item.observed}`)
    }
  }

  if (entry.workflowFiles?.length) {
    console.log(`\nCI/WORKFLOW FILES CHANGED (review the diff before approving): ${entry.workflowFiles.join(', ')}`)
  }

  if (entry.outOfScope?.length) {
    console.log(`\nfiles outside the manifest scope: ${entry.outOfScope.join(', ')}`)
  }

  if (entry.verdict) {
    console.log(`\nverifier: ${entry.verdict.verdict} on ${entry.verdict.sha?.slice(0, 7)} — ${entry.verdict.summary}`)

    for (const item of entry.verdict.checklist ?? []) {
      console.log(`  [${item.status}] ${item.item}`)
    }

    for (const item of entry.verdict.blocking ?? []) {
      console.log(`  BLOCKING: ${item}`)
    }

    for (const item of entry.verdict.nonBlocking ?? []) {
      console.log(`  note: ${item}`)
    }
  }

  if (entry.state === 'verified') {
    console.log(`\n${approveHint(manifest, entry, id)}`)
  }
}

async function preflight(manifest) {
  const env = makeEnv(manifest)
  const problems = []
  const warnings = []

  async function probe(label, cmd, args, { problem = label, ...options } = {}) {
    const result = await sh(cmd, args, { env, cwd: manifest.repo.path, ...options })
    const text = (result.stdout || result.stderr).trim().split('\n')[0]
    console.log(`${result.code === 0 ? 'ok  ' : 'FAIL'} ${label}: ${text}`)

    if (result.code !== 0) {
      problems.push(problem)
    }

    return result
  }

  console.log(`manifest ok: ${manifest.rollout}, ${manifest.prs.length} PR(s): ${manifest.prs.map((pr) => pr.id).join(', ')}`)

  const toWrite = manifest.prs.filter((pr) => !existsSync(pr.brief)).map((pr) => pr.id)

  if (toWrite.length > 0) {
    console.log(`ok   briefs the driver will write when their dependencies merge: ${toWrite.join(', ')}`)
  }

  await probe('claude', manifest.claudeBin, ['--version'], {
    problem: `claude (${manifest.claudeBin}) did not run: put it on PATH or repo.pathPrepend, or set claudeBin in manifest.yaml`,
  })

  for (const tool of probeTools(manifest)) {
    await probe(tool, tool, ['--version'])
  }

  await probe('gh auth', 'gh', ['auth', 'status'], { env: ghEnv(manifest) })
  await probe('git fetch', 'git', ['-C', manifest.repo.path, 'fetch', '--quiet', 'origin'])

  const remote = await sh('git', ['-C', manifest.repo.path, 'remote', 'get-url', 'origin'], { env })
  const origin = await originCheck(manifest, remote.code === 0 ? remote.stdout.trim() : '', (host) => sshHostname(manifest, host))
  console.log(`${origin.ok ? 'ok  ' : 'FAIL'} origin: ${origin.text}`)

  if (!origin.ok) {
    problems.push(origin.text)
  }

  const repo = await sh('gh', ['api', `repos/${manifest.repo.github}`], { env: ghEnv(manifest) })

  if (repo.code === 0) {
    const info = JSON.parse(repo.stdout)

    if (manifest.repo.merge.method === 'squash' && !info.allow_squash_merge) {
      problems.push('squash merges are disabled on the repository')
    }

    if (
      manifest.repo.merge.method === 'squash' &&
      (info.squash_merge_commit_title !== 'PR_TITLE' || info.squash_merge_commit_message !== 'BLANK')
    ) {
      warnings.push(
        `repository squash default is ${info.squash_merge_commit_title}/${info.squash_merge_commit_message}; the driver passes --subject and an empty --body, so its merges are one line anyway`,
      )
    }

    if (manifest.repo.merge.admin && !info.permissions?.admin) {
      problems.push('merge.admin is set but the gh account is not a repository admin')
    }

    if (info.private === false && manifest.repo.public === false) {
      problems.push('the repository is public but repo.public is false')
    }

    if (info.private === true && manifest.repo.public === true) {
      warnings.push('the repository is private: set repo.public: false to drop the public-repository rules from the prompts')
    }
  } else {
    problems.push('cannot read the repository with gh')
  }

  if (manifest.repo.agentToken) {
    try {
      const botEnv = agentEnv(manifest)
      const who = await sh('gh', ['api', 'user', '--jq', '.login'], { env: botEnv })
      const login = who.stdout.trim()
      const permission = await sh('gh', ['api', `repos/${manifest.repo.github}/collaborators/${login}/permission`, '--jq', '.permission'], {
        env: ghEnv(manifest),
      })

      const scopes = (await sh('gh', ['api', '-i', 'user'], { env: botEnv })).stdout.match(/^x-oauth-scopes:\s*(.*)$/im)?.[1]?.trim() ?? '?'
      const ok = who.code === 0 && !manifest.repo.maintainers.includes(login) && permission.stdout.trim() === 'write'
      console.log(
        `${ok ? 'ok  ' : 'FAIL'} agent identity: ${login || '?'} (permission ${permission.stdout.trim() || '?'}, scopes ${scopes})`,
      )

      if (!ok) {
        problems.push('agent token must belong to a non-maintainer account with write (not admin) permission')
      }

      const stored = await storedLoginCheck(manifest)

      for (const line of stored.lines) {
        console.log(line)
      }

      problems.push(...stored.problems)

      if (!/\bworkflow\b/.test(scopes)) {
        warnings.push('agent token lacks the workflow scope: PRs that change .github/workflows cannot be pushed')
      }
    } catch (error) {
      problems.push(`agent token: ${error.message}`)
    }
  } else {
    warnings.push('no repo.agentToken: agents act on GitHub as you')

    if (manifest.repo.maintainers.length > 0) {
      warnings.push(
        "repo.maintainers without repo.agentToken: comments agents post under your login count as your review feedback (the driver's own replies carry a marker and are skipped)",
      )
    }
  }

  if (manifest.policy.merge === 'auto') {
    warnings.push('policy.merge is auto: the driver merges without asking')
  }

  const battery = await batteryWarning()

  if (battery) {
    warnings.push(battery)
  }

  const guard = guardSelfTest(manifest)

  for (const line of guard.lines) {
    console.log(line)
  }

  problems.push(...guard.problems)

  if (values.live) {
    await liveGuardTest(manifest, problems)
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

// Starts a cheap headless agent with the worker settings in a scratch
// directory and asks it to run forbidden commands. The guard must stop them.
async function liveGuardTest(manifest, problems) {
  const scratch = mkdtempSync(join(tmpdir(), 'rollout-guard-'))
  const prompt =
    'This is a permissions test. Run each of these Bash commands exactly as written, one per tool call, and report what happened to each: 1) `gh pr --repo o/r merge 999999 --admin` 2) `echo x && git push origin x:main --dry-run` 3) `pnpm --filter nothing publish --dry-run` 4) `gh api -X PUT repos/o/r/pulls/999999/merge` 5) `echo allowed`.'

  const result = await sh(
    manifest.claudeBin,
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
      JSON.stringify(agentSettings(manifest, 'implement')),
    ],
    { cwd: scratch, env: makeEnv(manifest, { ROLLOUT_BRANCH: 'rollout/guard-test' }), timeout: 5 * 60_000 },
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

  if (values.open) {
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

  // Before currentManifest(): ui works over a root of rollouts, not one --dir. Agents
  // are refused above because the printed URL carries the token.
  if (command === 'ui') {
    await ui()
    return
  }

  const manifest = currentManifest()

  switch (command) {
    case 'run': {
      const warning = await batteryWarning()

      if (warning) {
        console.log(`warn ${warning}`)
      }

      await runDriver(manifest)
      break
    }

    case 'status':
      status(manifest)
      break

    case 'card':
      card(manifest, requireId(manifest))
      break

    case 'approve': {
      const id = requireId(manifest)
      const entry = readLedger(manifest)?.prs[id]
      const refusal = approveRefusal(manifest, entry ?? {})

      if (refusal) {
        console.error(`${id}: ${refusal}`)
        process.exit(1)
      }

      if (entry?.state !== 'verified' || !entry.verified) {
        console.error(`${id} is ${entry?.state ?? 'unknown'}, not verified; nothing to approve`)
        process.exit(1)
      }

      postCommand(manifest, { cmd: 'approve', id, sha: entry.verified.sha, patchId: entry.verified.patchId })
      console.log(
        `approving ${id} PR #${entry.pr} at ${entry.verified.sha} (patch ${entry.verified.patchId.slice(0, 12)}); the driver merges ${manifest.policy.mergeDelaySeconds}s after it accepts`,
      )

      break
    }

    case 'note': {
      const id = requireId(manifest)
      const text = rest.slice(1).join(' ').trim()

      if (!text) {
        console.error('note needs the answer text')
        process.exit(1)
      }

      postCommand(manifest, { cmd: 'note', id, text })
      console.log('queued for the implementer')
      break
    }

    case 'retry':
    case 'hold':
    case 'release':
      postCommand(manifest, { cmd: command, id: requireId(manifest) })
      console.log('queued')
      break

    case 'stop': {
      if (!lockHolder(manifest)) {
        console.log('no driver is running')
        break
      }

      const answer = stopDriver(manifest)

      if (answer.status !== 202) {
        console.error(answer.body.error)
        process.exit(1)
      }

      const { pid } = answer.body

      for (let waited = 0; waited < 30 && lockHolder(manifest); waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      console.log(lockHolder(manifest) ? `driver ${pid} is still stopping` : `driver ${pid} stopped; agents resume on the next run`)
      break
    }

    case 'pause':
    case 'resume':
    case 'unhalt':
      postCommand(manifest, { cmd: command })
      console.log('queued')
      break

    case 'preflight':
      await preflight(manifest)
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
