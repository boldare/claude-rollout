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
  const M = loadManifest(makeRollout())

  M.repo.base = 'develop'

  for (const role of ['implement', 'verify']) {
    const { deny } = agentSettings(M, role).permissions

    for (const rule of [...pushRules('main'), ...pushRules('develop')]) {
      assert.ok(deny.includes(rule), `${role}: ${rule}`)
    }
  }
})

test('agentSettings: a main base denies each main push once', () => {
  const M = loadManifest(makeRollout())

  assert.equal(M.repo.base, 'main')

  for (const role of ['implement', 'verify']) {
    const { deny } = agentSettings(M, role).permissions

    for (const rule of pushRules('main')) {
      assert.equal(deny.filter((entry) => entry === rule).length, 1, `${role}: ${rule}`)
    }
  }
})

test('guardCommand: the shell expands nothing in the skill path', () => {
  const root = mkdtempSync(join(tmpdir(), 'rollout-quote-'))
  const M = loadManifest(makeRollout())

  // Markers are relative because a directory name cannot hold a slash. The
  // command runs in root, so any expansion would create them there.
  M.home = join(root, "it's a `touch tick` $(touch pwned)")
  mkdirSync(join(M.home, 'hooks'), { recursive: true })
  copyFileSync(fileURLToPath(new URL('../hooks/guard-bash.mjs', import.meta.url)), join(M.home, 'hooks', 'guard-bash.mjs'))

  for (const role of ['implement', 'verify']) {
    const result = spawnSync('sh', ['-c', guardCommand(M, role)], {
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
  const M = loadManifest(makeRollout())
  const { deny, allow } = agentSettings(M, 'delegate').permissions

  assert.equal(readOnlyRole('delegate'), true)

  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    assert.ok(deny.includes(tool), tool)
  }

  assert.deepEqual(allow, agentSettings(M, 'verify').permissions.allow)
  assert.ok(guardCommand(M, 'delegate').endsWith(' verifier'))
})
