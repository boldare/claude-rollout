import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeChecks } from '../lib/checks.mjs'
import { globToRegExp, matchesAny } from '../lib/glob.mjs'
import { raiseEffort, validateManifest } from '../lib/manifest.mjs'

const run = (id, name, status, conclusion = null) => ({ id, name, status, conclusion })

test('green when every required glob matches and all runs pass', () => {
  const runs = [
    run(1, 'check', 'completed', 'success'),
    run(2, 'smoke (default)', 'completed', 'success'),
    run(3, 'smoke (vite 6)', 'completed', 'skipped'),
  ]
  assert.equal(summarizeChecks(runs, ['check', 'smoke*']).state, 'green')
})

test('pending when a required check has not appeared', () => {
  const summary = summarizeChecks([run(1, 'check', 'completed', 'success')], ['check', 'smoke*'])
  assert.equal(summary.state, 'pending')
  assert.deepEqual(summary.missing, ['smoke*'])
})

test('red when any run fails, required or not', () => {
  const runs = [run(1, 'check', 'completed', 'success'), run(2, 'smoke', 'completed', 'success'), run(3, 'CodeQL', 'completed', 'failure')]
  assert.equal(summarizeChecks(runs, ['check', 'smoke*']).state, 'red')
})

test('a re-run replaces the earlier failure of the same check', () => {
  const runs = [run(1, 'check', 'completed', 'failure'), run(5, 'check', 'completed', 'success'), run(2, 'smoke', 'completed', 'success')]
  assert.equal(summarizeChecks(runs, ['check', 'smoke*']).state, 'green')
})

test('in-progress runs keep it pending', () => {
  const runs = [run(1, 'check', 'completed', 'success'), run(2, 'smoke', 'in_progress')]
  assert.equal(summarizeChecks(runs, ['check', 'smoke*']).state, 'pending')
})

test('no runs at all is pending, not green, even without required globs', () => {
  assert.equal(summarizeChecks([], ['check']).state, 'pending')
  assert.equal(summarizeChecks([], []).state, 'pending')
})

test('a required check that was only skipped is red', () => {
  const runs = [run(1, 'check', 'completed', 'skipped'), run(2, 'smoke', 'completed', 'skipped')]
  const summary = summarizeChecks(runs, ['check', 'smoke*'])
  assert.equal(summary.state, 'red')
  assert.match(summary.failing.join(), /required check check did not run/)
})

test('manifest needs required checks', () => {
  const broken = structuredClone(base)
  delete broken.repo.requiredChecks
  assert.match(validateManifest(broken).join(), /requiredChecks/)
})

test('globs', () => {
  assert.ok(matchesAny('packages/core/CHANGELOG.md', ['**/CHANGELOG.md']))
  assert.ok(matchesAny('CHANGELOG.md', ['**/CHANGELOG.md']))
  assert.ok(matchesAny('.changeset/a.md', ['.changeset/*.md']))
  assert.ok(!matchesAny('.changeset/sub/a.md', ['.changeset/*.md']))
  assert.ok(globToRegExp('packages/*/package.json').test('packages/core/package.json'))
  assert.ok(!globToRegExp('smoke*').test('check'))
})

test('effort raises and caps at max', () => {
  assert.equal(raiseEffort('high', 0), 'high')
  assert.equal(raiseEffort('high', 1), 'xhigh')
  assert.equal(raiseEffort('xhigh', 5), 'max')
})

const base = {
  rollout: 'demo',
  repo: { path: '/tmp/x', github: 'o/r', requiredChecks: ['check'] },
  prs: [
    { id: 'A', branch: 'a', title: 'a', brief: 'a.md', effort: { implement: 'high', verify: 'high' }, changeset: 'minor' },
    { id: 'B', branch: 'b', title: 'b', brief: 'b.md', effort: { implement: 'max', verify: 'xhigh' }, changeset: 'patch', deps: ['A'] },
  ],
}

test('a valid manifest passes', () => {
  assert.deepEqual(validateManifest(base), [])
})

test('manifest validation catches cycles, unknown deps, bad efforts and bumps', () => {
  const broken = structuredClone(base)
  broken.prs[0].deps = ['B']
  broken.prs[1].deps.push('Z')
  broken.prs[1].effort.implement = 'ultra'
  broken.prs[0].changeset = 'major'
  const errors = validateManifest(broken).join('\n')

  assert.match(errors, /cycle/)
  assert.match(errors, /unknown PR Z/)
  assert.match(errors, /effort\.implement/)
  assert.match(errors, /above policy\.maxBump/)
})

test('repo.public must be a boolean', () => {
  for (const value of ['yes', null]) {
    const broken = structuredClone(base)
    broken.repo.public = value
    assert.deepEqual(validateManifest(broken), ['repo.public must be true or false'], String(value))
  }

  for (const value of [true, false]) {
    const marked = structuredClone(base)
    marked.repo.public = value
    assert.deepEqual(validateManifest(marked), [], String(value))
  }
})

test('changeset none is a valid manifest value', () => {
  const plain = structuredClone(base)
  plain.prs[0].changeset = 'none'
  assert.deepEqual(validateManifest(plain), [])
})
