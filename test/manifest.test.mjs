import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadManifest, validateManifest } from '../lib/manifest.mjs'
import { makeRollout } from './fixtures.mjs'

const base = {
  rollout: 'demo',
  repo: { path: '/tmp/x', github: 'o/r', requiredChecks: ['check'] },
  prs: [
    { id: 'A', branch: 'a', title: 'a', brief: 'a.md', effort: { implement: 'high', verify: 'high' }, changeset: 'minor' },
    { id: 'B', branch: 'b', title: 'b', brief: 'b.md', effort: { implement: 'max', verify: 'xhigh' }, changeset: 'patch', deps: ['A'] },
  ],
}

test('loadManifest: claude from PATH and a public repo by default', () => {
  const M = loadManifest(makeRollout())

  assert.equal(M.claudeBin, 'claude')
  assert.equal(M.repo.public, true)
})

test('loadManifest: an explicit claudeBin still expands ~/', () => {
  const M = loadManifest(makeRollout({ manifest: { claudeBin: '~/tools/claude' } }))

  assert.equal(M.claudeBin, `${homedir()}/tools/claude`)
})

test('validateManifest: a manifest that is not a mapping gets one error', () => {
  for (const raw of [null, undefined, 'demo', [], 42]) {
    assert.deepEqual(validateManifest(raw), ['the manifest must be a mapping with rollout, repo and prs'])
  }
})

test('validateManifest: a prs entry that is not a mapping gets one error', () => {
  const raw = structuredClone(base)

  raw.prs = [null, raw.prs[0]]
  assert.deepEqual(validateManifest(raw), ['prs[0] must be a mapping'])

  raw.prs = ['x']
  assert.deepEqual(validateManifest(raw), ['prs[0] must be a mapping'])
})

test('validateManifest: deps that is not a list is not iterated', () => {
  for (const deps of ['A', 'AB', null, { A: true }]) {
    const raw = structuredClone(base)

    raw.prs[1].deps = deps
    assert.deepEqual(validateManifest(raw), ['prs.B.deps must be a list of PR ids'])
  }
})

test('validateManifest: effort.brief, when set, is a known level', () => {
  for (const brief of ['ultra', null]) {
    const raw = structuredClone(base)

    raw.prs[0].effort.brief = brief
    assert.deepEqual(validateManifest(raw), ['prs.A.effort.brief must be one of low, medium, high, xhigh, max'])
  }

  const raw = structuredClone(base)

  raw.prs[0].effort.brief = 'low'
  assert.deepEqual(validateManifest(raw), [])
  assert.deepEqual(validateManifest(structuredClone(base)), [])
})

test('validateManifest: an empty or comment-only manifest.yaml is an invalid manifest', () => {
  for (const content of ['', '# nothing yet\n']) {
    const dir = makeRollout()

    writeFileSync(join(dir, 'manifest.yaml'), content)
    assert.throws(
      () => loadManifest(dir),
      (error) => !(error instanceof TypeError) && error instanceof Error && /invalid manifest[\s\S]*must be a mapping/.test(error.message),
    )
  }
})
