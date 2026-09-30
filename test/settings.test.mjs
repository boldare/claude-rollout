import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadManifest } from '../lib/manifest.mjs'
import { agentSettings } from '../lib/settings.mjs'
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
