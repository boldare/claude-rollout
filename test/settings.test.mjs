import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifest } from '../lib/manifest.mjs'
import { agentSettings, guardCommand, readOnlyRole } from '../lib/settings.mjs'
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
