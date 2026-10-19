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

test('guardCommand: the shell expands nothing in the skill path', () => {
  const root = mkdtempSync(join(tmpdir(), 'rollout-quote-'))
  const manifest = loadManifest(makeRollout())

  // Markers are relative because a directory name cannot hold a slash. The
  // command runs in root, so any expansion would create them there.
  manifest.home = join(root, "it's a `touch tick` $(touch pwned)")
  mkdirSync(join(manifest.home, 'hooks'), { recursive: true })
  copyFileSync(fileURLToPath(new URL('../hooks/guard-bash.mjs', import.meta.url)), join(manifest.home, 'hooks', 'guard-bash.mjs'))

  for (const role of ['implement', 'verify']) {
    const result = spawnSync('sh', ['-c', guardCommand(manifest, role)], {
      cwd: root,
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 1 --admin' } }),
      encoding: 'utf8',
    })

    assert.equal(result.status, 2, `${role}: ${result.stderr}`)
    assert.match(result.stderr, /^rollout guard: /)
  }

  assert.equal(existsSync(join(root, 'pwned')), false)
  assert.equal(existsSync(join(root, 'tick')), false)
})

test('the delegate is read-only: the verifier guard and no file edits', () => {
  const manifest = loadManifest(makeRollout())
  const { deny, allow } = agentSettings(manifest, 'delegate').permissions

  assert.equal(readOnlyRole('delegate'), true)

  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    assert.ok(deny.includes(tool), tool)
  }

  assert.deepEqual(allow, agentSettings(manifest, 'verify').permissions.allow)
  assert.ok(guardCommand(manifest, 'delegate').endsWith(' verifier || exit 2'))
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
