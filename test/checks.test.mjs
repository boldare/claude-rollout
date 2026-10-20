import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commandResult, inheritsParent, preVerifyOutcome, speaksForItself, summarizeChecks } from '../lib/checks.mjs'
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

const quiet = (overrides = {}) => ({
  runs: [],
  requiredGlobs: ['test*'],
  parentCount: 1,
  files: ['docs/journal/2026-10.md'],
  globs: ['docs/journal/**'],
  ...overrides,
})

test('a commit with no required run, one parent and only quiet files inherits its parent', () => {
  assert.equal(inheritsParent(quiet()), true)
  assert.equal(inheritsParent(quiet({ files: [] })), true)
  assert.equal(inheritsParent(quiet({ files: ['docs/journal/a.md', 'docs/journal/sub/b.md'] })), true)
  assert.equal(inheritsParent(quiet({ runs: [run(1, 'docs deploy', 'completed', 'success')] })), true)
  assert.equal(inheritsParent(quiet({ runs: [run(1, 'docs deploy', 'in_progress')] })), true)
  assert.equal(inheritsParent(quiet({ runs: [run(1, 'docs deploy', 'completed', 'cancelled')] })), true)
})

test('a commit speaks for itself when a required check ran, a run failed, it has two parents, a loud file or no globs', () => {
  assert.equal(inheritsParent(quiet({ files: ['lib/driver.mjs'] })), false)
  assert.equal(inheritsParent(quiet({ files: ['docs/journal/a.md', 'lib/driver.mjs'] })), false)
  assert.equal(inheritsParent(quiet({ parentCount: 2 })), false)
  assert.equal(inheritsParent(quiet({ parentCount: 0 })), false)
  assert.equal(inheritsParent(quiet({ runs: [run(1, 'test (24)', 'in_progress')] })), false)
  assert.equal(inheritsParent(quiet({ runs: [run(1, 'docs deploy', 'completed', 'failure')] })), false)
  assert.equal(inheritsParent(quiet({ globs: [] })), false)
})

test('speaksForItself: a required run in any state or a failed run, never a cancellation', () => {
  assert.equal(speaksForItself([run(1, 'test (24)', 'queued')], ['test*']), true)
  assert.equal(speaksForItself([run(1, 'lint', 'completed', 'timed_out')], ['test*']), true)
  assert.equal(speaksForItself([run(1, 'lint', 'completed', 'cancelled'), run(2, 'docs', 'completed', 'skipped')], ['test*']), false)
  assert.equal(speaksForItself([], ['test*']), false)
})

test('a cancelled run does not replace a completed run of the same check', () => {
  const cancelled = run(5, 'check', 'completed', 'cancelled')
  const succeeded = run(1, 'check', 'completed', 'success')
  const smoke = run(2, 'smoke', 'completed', 'success')

  assert.equal(summarizeChecks([succeeded, cancelled, smoke], ['check', 'smoke*']).state, 'green')
  assert.equal(summarizeChecks([cancelled, succeeded, smoke], ['check', 'smoke*']).state, 'green')
})

test('a check with only cancelled runs is red and counts as not run', () => {
  const runs = [run(5, 'check', 'completed', 'cancelled'), run(2, 'smoke', 'completed', 'success')]
  const summary = summarizeChecks(runs, ['check', 'smoke*'])
  assert.equal(summary.state, 'red')
  assert.match(summary.failing.join(), /required check check did not run/)
})

test('a later failure still replaces an earlier success of the same check', () => {
  const runs = [run(1, 'check', 'completed', 'success'), run(5, 'check', 'completed', 'failure'), run(2, 'smoke', 'completed', 'success')]
  assert.equal(summarizeChecks(runs, ['check', 'smoke*']).state, 'red')
})

test('a cancelled run does not hide the failure of the same check', () => {
  const runs = [run(1, 'check', 'completed', 'failure'), run(5, 'check', 'completed', 'cancelled'), run(2, 'smoke', 'completed', 'success')]
  const summary = summarizeChecks(runs, ['check', 'smoke*'])
  assert.equal(summary.state, 'red')
  assert.match(summary.failing.join(), /check: failure/)
})

test('a later in-progress run still replaces a success of the same check', () => {
  const runs = [run(1, 'check', 'completed', 'success'), run(5, 'check', 'in_progress'), run(2, 'smoke', 'completed', 'success')]
  assert.equal(summarizeChecks(runs, ['check', 'smoke*']).state, 'pending')
})

// Every order of the given items.
function permutations(items) {
  if (items.length <= 1) {
    return [items]
  }

  return items.flatMap((item, index) => permutations(items.toSpliced(index, 1)).map((rest) => [item, ...rest]))
}

test('the order the API lists the runs in never changes the summary', () => {
  const runs = [run(1, 'check', 'completed', 'success'), run(5, 'check', 'in_progress'), run(7, 'check', 'completed', 'cancelled')]
  const states = permutations(runs).map((order) => summarizeChecks(order, ['check']).state)

  assert.equal(states.length, 6)
  assert.deepEqual(new Set(states), new Set(['pending']))
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

const HEAD = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const MOVED = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'
const UNTOUCHED = { clean: true, status: '', head: HEAD }
const TESTS = { command: 'npm test', level: 'required' }

// What runCommand resolves with for a command that passed.
function finished(overrides = {}) {
  return { exitCode: 0, signal: null, timedOut: false, stopped: false, tail: 'tests 12, pass 12\n', seconds: 4, ...overrides }
}

test('commandResult: exit 0 on an untouched tree passes, and the record keeps what the run reported', () => {
  assert.deepEqual(commandResult(TESTS, finished(), UNTOUCHED, HEAD), {
    command: 'npm test',
    level: 'required',
    result: 'pass',
    summary: 'exit 0',
    exitCode: 0,
    signal: null,
    timedOut: false,
    seconds: 4,
    tail: 'tests 12, pass 12\n',
    changes: [],
  })
})

test('commandResult: an exit code other than 0, a signal, a timeout or a spawn error fails, and the summary names the first that applies', () => {
  const cases = [
    [{ exitCode: 1 }, 'exit 1'],
    [{ exitCode: 3 }, 'exit 3'],
    [{ exitCode: null, signal: 'SIGKILL' }, 'killed by SIGKILL'],
    [{ exitCode: null, signal: 'SIGTERM', timedOut: true }, 'timed out'],
    [{ exitCode: 0, timedOut: true }, 'timed out'],
    [{ exitCode: null, tail: 'spawn sh ENOENT' }, 'did not start'],
  ]

  for (const [overrides, summary] of cases) {
    const record = commandResult(TESTS, finished(overrides), UNTOUCHED, HEAD)

    assert.equal(record.result, 'fail', summary)
    assert.equal(record.summary, summary)
    assert.deepEqual(record.changes, [], summary)
    assert.equal(record.tail, overrides.tail ?? 'tests 12, pass 12\n', summary)
  }
})

test('commandResult: tracked changes or a moved HEAD fail a command that exited 0, and untracked files alone do not', () => {
  const tracked = commandResult(TESTS, finished(), { clean: false, status: 'M lib/a.mjs\n D README.md\n?? coverage/', head: HEAD }, HEAD)

  assert.equal(tracked.result, 'fail')
  assert.deepEqual(tracked.changes, ['M lib/a.mjs', 'D README.md'])
  assert.equal(tracked.summary, 'exit 0, left tracked changes: M lib/a.mjs, D README.md')

  const untracked = commandResult(TESTS, finished(), { clean: false, status: '?? coverage/\n?? notes.txt', head: HEAD }, HEAD)

  assert.equal(untracked.result, 'pass')
  assert.deepEqual(untracked.changes, [])
  assert.equal(untracked.summary, 'exit 0')

  const moved = commandResult(TESTS, finished(), { clean: true, status: '', head: MOVED }, HEAD)

  assert.equal(moved.result, 'fail')
  assert.deepEqual(moved.changes, ['HEAD moved to b2b2b2b'])
  assert.equal(moved.summary, 'exit 0, left tracked changes: HEAD moved to b2b2b2b')

  const both = commandResult(
    { command: 'npm run build', level: 'recommended' },
    finished({ exitCode: 2 }),
    {
      clean: false,
      status: 'M dist/index.js',
      head: MOVED,
    },
    HEAD,
  )

  assert.equal(both.level, 'recommended')
  assert.equal(both.result, 'fail')
  assert.equal(both.summary, 'exit 2, left tracked changes: M dist/index.js, HEAD moved to b2b2b2b')
})

test('preVerifyOutcome: the failed records of each level, and nothing failed when every command passed', () => {
  const failedTests = commandResult(TESTS, finished({ exitCode: 1 }), UNTOUCHED, HEAD)
  const failedLint = commandResult({ command: 'npm run lint', level: 'recommended' }, finished({ exitCode: 1 }), UNTOUCHED, HEAD)
  const passedBuild = commandResult({ command: 'npm run build', level: 'required' }, finished(), UNTOUCHED, HEAD)
  const passedDocs = commandResult({ command: 'npm run docs', level: 'recommended' }, finished(), UNTOUCHED, HEAD)

  assert.deepEqual(preVerifyOutcome([passedBuild, failedTests, failedLint, passedDocs]), {
    failedRequired: [failedTests],
    failedRecommended: [failedLint],
  })

  assert.deepEqual(preVerifyOutcome([passedBuild, failedLint]), { failedRequired: [], failedRecommended: [failedLint] })
  assert.deepEqual(preVerifyOutcome([passedBuild, passedDocs]), { failedRequired: [], failedRecommended: [] })
  assert.deepEqual(preVerifyOutcome([]), { failedRequired: [], failedRecommended: [] })
})
