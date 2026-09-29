import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { loadManifest } from '../lib/manifest.mjs'
import { makeRollout } from './fixtures.mjs'

test('loadManifest: claude from PATH and a public repo by default', () => {
  const M = loadManifest(makeRollout())

  assert.equal(M.claudeBin, 'claude')
  assert.equal(M.repo.public, true)
})

test('loadManifest: an explicit claudeBin still expands ~/', () => {
  const M = loadManifest(makeRollout({ manifest: { claudeBin: '~/tools/claude' } }))

  assert.equal(M.claudeBin, `${homedir()}/tools/claude`)
})
