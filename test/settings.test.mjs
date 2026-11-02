import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifest } from '../lib/manifest.mjs'
import { agentSettings, agentTools, contextArgs, contextEnv, disallowedTools, guardCommand, readOnlyRole } from '../lib/settings.mjs'
import { makeRollout } from './fixtures.mjs'

function pushRules(branch) {
  return [`Bash(git push origin ${branch}*)`, `Bash(git push origin HEAD:${branch}*)`]
}

test('agentSettings: both roles deny pushes to main and to repo.base', () => {
  const manifest = loadManifest(makeRollout())

  manifest.repo.base = 'develop'

  for (const role of ['implement', 'verify']) {
    const { deny } = agentSettings(manifest, role).permissions

    for (const rule of [...pushRules('main'), ...pushRules('develop')]) {
      assert.ok(deny.includes(rule), `${role}: ${rule}`)
    }
  }
})

test('agentSettings: a main base denies each main push once', () => {
  const manifest = loadManifest(makeRollout())

  assert.equal(manifest.repo.base, 'main')

  for (const role of ['implement', 'verify']) {
    const { deny } = agentSettings(manifest, role).permissions

    for (const rule of pushRules('main')) {
      assert.equal(deny.filter((entry) => entry === rule).length, 1, `${role}: ${rule}`)
    }
  }
})

test('guardCommand: the shell expands nothing in the skill path, the rollout directory, the name or the branch', () => {
  const root = mkdtempSync(join(tmpdir(), 'rollout-quote-'))
  const manifest = loadManifest(makeRollout())
  const hostile = "it's a `touch tick` $(touch pwned)"
  const branch = `feat/${hostile}`

  // Markers are relative because a directory name cannot hold a slash. The
  // command runs in root, so any expansion would create them there.
  manifest.home = join(root, hostile)
  manifest.dir = join(root, 'rollouts', hostile)
  manifest.rollout = hostile
  mkdirSync(join(manifest.home, 'hooks'), { recursive: true })
  copyFileSync(fileURLToPath(new URL('../hooks/guard-bash.mjs', import.meta.url)), join(manifest.home, 'hooks', 'guard-bash.mjs'))

  function run(role, command) {
    return spawnSync('sh', ['-c', guardCommand(manifest, role, { branch })], {
      cwd: root,
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
    })
  }

  for (const role of ['implement', 'verify']) {
    const merge = run(role, 'gh pr merge 1 --admin')
    const ledger = run(role, `cat '${join(manifest.dir, 'ledger.json')}'`)

    assert.equal(merge.status, 2, `${role}: ${merge.stderr}`)
    assert.match(merge.stderr, /^rollout guard: /)
    assert.equal(ledger.status, 2, `${role}: ${ledger.stderr}`)
    assert.equal(
      ledger.stderr,
      'rollout guard: the rollout control plane, its hooks and git hook settings are off limits to agents\n',
      role,
    )
  }

  const push = run('implement', 'git push -u origin other')

  assert.equal(push.status, 2, push.stderr)
  assert.equal(push.stderr, `rollout guard: push only to your branch ${branch} (got other)\n`)
  assert.equal(existsSync(join(root, 'pwned')), false)
  assert.equal(existsSync(join(root, 'tick')), false)
})

test('guardCommand: the context is on the command line, and only implement and fix get the branch', () => {
  const manifest = loadManifest(makeRollout())
  const script = join(manifest.home, 'hooks', 'guard-bash.mjs')

  assert.equal(
    guardCommand(manifest, 'implement', { branch: 'feat/a1' }),
    `node '${script}' worker --dir='${manifest.dir}' --home='${manifest.home}' --name='demo' --repo='example/widgets' --branch='feat/a1' || exit 2`,
  )

  for (const role of ['brief', 'implement', 'fix', 'verify', 'delegate']) {
    const command = guardCommand(manifest, role, { branch: 'feat/a1' })
    const branch = readOnlyRole(role) ? "''" : "'feat/a1'"
    const [hook] = agentSettings(manifest, role, { branch: 'feat/a1' }).hooks.PreToolUse.flatMap((entry) => entry.hooks)

    assert.ok(command.endsWith(` --branch=${branch} || exit 2`), `${role}: ${command}`)
    assert.equal(hook.command, command, role)
  }

  assert.ok(guardCommand(manifest, 'implement').endsWith(" --branch='' || exit 2"), 'no branch given')
})

test('the delegate is read-only: the verifier guard and no file edits', () => {
  const manifest = loadManifest(makeRollout())
  const { deny, allow } = agentSettings(manifest, 'delegate').permissions

  assert.equal(readOnlyRole('delegate'), true)

  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    assert.ok(deny.includes(tool), tool)
  }

  assert.deepEqual(allow, agentSettings(manifest, 'verify').permissions.allow)
  assert.match(guardCommand(manifest, 'delegate', { branch: 'feat/a1' }), / verifier --dir=.* --branch='' \|\| exit 2$/)
})

test('agentSettings: no role gets a tool that waits for a later turn, and only read-only roles lose the file tools', () => {
  const manifest = loadManifest(makeRollout())

  for (const role of ['brief', 'implement', 'fix', 'verify', 'delegate']) {
    const { deny } = agentSettings(manifest, role).permissions

    for (const tool of ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'Monitor']) {
      assert.ok(deny.includes(tool), `${role}: ${tool}`)
    }

    assert.deepEqual(
      disallowedTools(role).filter((tool) => !deny.includes(tool)),
      [],
      role,
    )

    assert.equal(deny.includes('Edit'), readOnlyRole(role), role)
  }
})

test('agentSettings: every role gets the guard with a finite timeout and the exit 2 fallback', () => {
  const manifest = loadManifest(makeRollout())

  for (const role of ['brief', 'implement', 'fix', 'verify', 'delegate']) {
    const hooks = agentSettings(manifest, role).hooks.PreToolUse.flatMap((entry) => entry.hooks)

    assert.ok(hooks.length > 0, role)

    for (const hook of hooks) {
      assert.equal(hook.timeout, 30, role)
      assert.ok(hook.command.endsWith(' || exit 2'), `${role}: ${hook.command}`)
    }
  }
})

test('contextArgs: every role gets the project settings only, no MCP servers, no skills and the built-in tools of its role only', () => {
  const manifest = loadManifest(makeRollout())

  for (const role of ['brief', 'implement', 'fix', 'verify', 'delegate']) {
    const args = contextArgs(manifest, role)
    const tools = args.slice(args.indexOf('--tools') + 1)

    assert.deepEqual(
      args.slice(0, args.indexOf('--tools')),
      ['--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands'],
      role,
    )

    assert.deepEqual(tools, agentTools(role), role)
    assert.equal(tools.includes('Edit') || tools.includes('Write'), !readOnlyRole(role), role)

    for (const tool of ['Agent', 'Task', 'Workflow', 'Skill', 'ToolSearch', 'NotebookEdit', ...disallowedTools(role)]) {
      assert.ok(!tools.includes(tool), `${role}: ${tool}`)
    }
  }
})

test('contextArgs: a manifest mcpConfig is the only MCP source, and only implement and fix get it', () => {
  const manifest = { ...loadManifest(makeRollout()), mcpConfig: '/tmp/rollout/mcp.json' }

  for (const role of ['implement', 'fix']) {
    assert.deepEqual(
      contextArgs(manifest, role).slice(0, 6),
      ['--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '/tmp/rollout/mcp.json', '--disable-slash-commands'],
      role,
    )
  }

  for (const role of ['brief', 'verify', 'delegate']) {
    const args = contextArgs(manifest, role)

    assert.deepEqual(args.slice(0, 4), ['--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands'], role)
    assert.ok(!args.includes('--mcp-config'), role)
  }
})

test('contextEnv: no role gets the auto-memory, and only the read-only roles get the 5-minute cache', () => {
  for (const role of ['brief', 'implement', 'fix', 'verify', 'delegate']) {
    const env = contextEnv(role)

    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', role)
    assert.equal(env.CLAUDE_CODE_PROMPT_CACHE_TTL, readOnlyRole(role) ? '5m' : undefined, role)
  }
})
