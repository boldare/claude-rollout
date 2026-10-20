import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  briefGates,
  briefOutcome,
  commandResult,
  inheritsParent,
  preVerifyOutcome,
  readyClaim,
  speaksForItself,
  summarizeChecks,
} from '../lib/checks.mjs'
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
const TESTS = { command: 'npm test', stage: 'preVerify', level: 'required' }

// What runCommand resolves with for a command that passed.
function finished(overrides = {}) {
  return { exitCode: 0, signal: null, timedOut: false, stopped: false, tail: 'tests 12, pass 12\n', seconds: 4, ...overrides }
}

test('commandResult: exit 0 on an untouched tree passes, and the record keeps what the run reported', () => {
  assert.deepEqual(commandResult(TESTS, finished(), UNTOUCHED, HEAD), {
    command: 'npm test',
    stage: 'preVerify',
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

  const ready = commandResult({ ...TESTS, stage: 'ready' }, finished(), UNTOUCHED, HEAD)

  assert.equal(ready.stage, 'ready')
  assert.deepEqual(Object.keys(ready).slice(0, 3), ['command', 'stage', 'level'])
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
    { command: 'npm run build', stage: 'preVerify', level: 'recommended' },
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
  const lint = { command: 'npm run lint', stage: 'preVerify', level: 'recommended' }
  const failedTests = commandResult(TESTS, finished({ exitCode: 1 }), UNTOUCHED, HEAD)
  const failedLint = commandResult(lint, finished({ exitCode: 1 }), UNTOUCHED, HEAD)
  const passedBuild = commandResult({ command: 'npm run build', stage: 'preVerify', level: 'required' }, finished(), UNTOUCHED, HEAD)
  const passedDocs = commandResult({ command: 'npm run docs', stage: 'preVerify', level: 'recommended' }, finished(), UNTOUCHED, HEAD)

  assert.deepEqual(preVerifyOutcome([passedBuild, failedTests, failedLint, passedDocs]), {
    failedRequired: [failedTests],
    failedRecommended: [failedLint],
    reason: 'pre-verify check',
  })

  assert.deepEqual(preVerifyOutcome([passedBuild, failedLint]), { failedRequired: [], failedRecommended: [failedLint], reason: null })
  assert.deepEqual(preVerifyOutcome([passedBuild, passedDocs]), { failedRequired: [], failedRecommended: [], reason: null })
  assert.deepEqual(preVerifyOutcome([]), { failedRequired: [], failedRecommended: [], reason: null })
})

test('preVerifyOutcome: the reason follows the stage of the first failed required record, and a record without a stage is a pre-verify one', () => {
  const failed = finished({ exitCode: 1 })
  const readyRequired = commandResult({ command: 'npm ci', stage: 'ready', level: 'required' }, failed, UNTOUCHED, HEAD)
  const readyRecommended = commandResult({ command: 'npm run lint', stage: 'ready', level: 'recommended' }, failed, UNTOUCHED, HEAD)
  const preVerifyRequired = commandResult(TESTS, failed, UNTOUCHED, HEAD)
  const { stage: _, ...old } = preVerifyRequired

  assert.equal(preVerifyOutcome([readyRequired]).reason, 'ready check')
  assert.equal(preVerifyOutcome([readyRecommended, preVerifyRequired]).reason, 'pre-verify check')
  assert.equal(preVerifyOutcome([readyRequired, preVerifyRequired]).reason, 'ready check')
  assert.equal(preVerifyOutcome([preVerifyRequired, readyRequired]).reason, 'pre-verify check')
  assert.equal(preVerifyOutcome([old]).reason, 'pre-verify check')
  assert.equal(preVerifyOutcome([readyRecommended]).reason, null)
})

const READY_TESTS = commandResult({ command: 'npm test', stage: 'ready', level: 'required' }, finished({ exitCode: 1 }), UNTOUCHED, HEAD)

function report(gates, headSha = HEAD) {
  return { status: 'READY', headSha, gates }
}

test('readyClaim: nothing for a pre-verify record, without a report, or for a report about another head', () => {
  const gates = [{ command: 'npm test', exitCode: 0, tail: '' }]

  assert.equal(readyClaim(commandResult(TESTS, finished({ exitCode: 1 }), UNTOUCHED, HEAD), report(gates), HEAD), null)
  assert.equal(readyClaim(READY_TESTS, undefined, HEAD), null)
  assert.equal(readyClaim(READY_TESTS, null, HEAD), null)
  assert.equal(readyClaim(READY_TESTS, report(gates, MOVED), HEAD), null)
})

test('readyClaim: not listed when no entry of gates has the command, and a missing gates counts as empty', () => {
  assert.deepEqual(readyClaim(READY_TESTS, report([{ command: 'npm run lint', exitCode: 0, tail: '' }]), HEAD), { listed: false })
  assert.deepEqual(readyClaim(READY_TESTS, report([]), HEAD), { listed: false })
  assert.deepEqual(readyClaim(READY_TESTS, { status: 'READY', headSha: HEAD }, HEAD), { listed: false })
})

test('readyClaim: the exit code of the first entry with the same command, both sides trimmed', () => {
  const gates = [
    { command: 'npm run lint', exitCode: 2, tail: '' },
    { command: '  npm test ', exitCode: 0, tail: 'tests 12, pass 12' },
    { command: 'npm test', exitCode: 1, tail: '' },
  ]

  assert.deepEqual(readyClaim(READY_TESTS, report(gates), HEAD), { listed: true, exitCode: 0 })
  assert.deepEqual(readyClaim({ ...READY_TESTS, command: ' npm test  ' }, report(gates.slice(2)), HEAD), { listed: true, exitCode: 1 })
  assert.deepEqual(readyClaim(READY_TESTS, report([{ command: 'npm test', exitCode: 3, tail: '' }]), HEAD), { listed: true, exitCode: 3 })
})

const RULES = 'When the PR changes a rule, every file that states the old one is in Expected files.'
const COMMANDS = 'Every verification command exists or is marked new in this PR.'
const LEAN = 'The brief has no filler.'
const GATES = briefGates({ runChecks: true, required: [RULES, COMMANDS], recommended: [LEAN] })

function briefReport(overrides = {}) {
  return {
    brief: '# A1\n',
    questions: [],
    notes: 'Checked.',
    expectedFiles: ['lib/a.mjs'],
    changesetBump: 'minor',
    checks: [],
    criteria: [
      { id: 'B1', result: 'pass', evidence: 'docs/a.md is listed.' },
      { id: 'B2', result: 'pass', evidence: 'npm test exists.' },
      { id: 'B3', result: 'pass', evidence: 'Short.' },
    ],
    ...overrides,
  }
}

function reported(id, result, evidence) {
  return briefReport().criteria.map((item) => (item.id === id ? { id, result, evidence } : item))
}

test('briefGates: ids B1 and on across both lists, the required ones first', () => {
  assert.deepEqual(briefGates({ runChecks: true, required: [RULES, COMMANDS], recommended: [LEAN] }), {
    runChecks: true,
    criteria: [
      { id: 'B1', level: 'required', text: RULES },
      { id: 'B2', level: 'required', text: COMMANDS },
      { id: 'B3', level: 'recommended', text: LEAN },
    ],
  })

  assert.deepEqual(briefGates({ runChecks: false, required: [], recommended: [LEAN, RULES] }).criteria, [
    { id: 'B1', level: 'recommended', text: LEAN },
    { id: 'B2', level: 'recommended', text: RULES },
  ])

  assert.deepEqual(briefGates({ runChecks: false, required: [], recommended: [] }), { runChecks: false, criteria: [] })
})

test('briefOutcome: every criterion passed and every check can pass adds nothing', () => {
  const checks = [
    { command: 'npm test', exitCode: 0, canPass: true, evidence: '676 pass' },
    { command: 'npm run lint', exitCode: 1, canPass: true, evidence: 'fails only on the file this PR adds' },
  ]

  const outcome = briefOutcome(GATES, briefReport({ checks }))

  assert.deepEqual(outcome.questions, [])
  assert.deepEqual(outcome.failedRecommended, [])
  assert.deepEqual(outcome.checks, [
    { ...checks[0], result: 'pass' },
    { ...checks[1], result: 'pass' },
  ])

  assert.deepEqual(outcome.criteria, [
    { id: 'B1', level: 'required', text: RULES, result: 'pass', evidence: 'docs/a.md is listed.' },
    { id: 'B2', level: 'required', text: COMMANDS, result: 'pass', evidence: 'npm test exists.' },
    { id: 'B3', level: 'recommended', text: LEAN, result: 'pass', evidence: 'Short.' },
  ])
})

test("briefOutcome: a required criterion that failed, is unverifiable or was not reported adds a question after the reviewer's own", () => {
  const failed = briefOutcome(GATES, briefReport({ questions: ['Which API?'], criteria: reported('B1', 'fail', 'README.md is missing.') }))

  assert.deepEqual(failed.questions, ['Which API?', `B1 (required brief criterion, fail): ${RULES} Evidence: README.md is missing.`])

  const unverifiable = briefOutcome(GATES, briefReport({ criteria: reported('B2', 'unverifiable', 'No package.json.') }))

  assert.deepEqual(unverifiable.questions, [`B2 (required brief criterion, unverifiable): ${COMMANDS} Evidence: No package.json.`])

  const missing = briefOutcome(GATES, briefReport({ criteria: briefReport().criteria.filter((item) => item.id !== 'B2') }))

  assert.deepEqual(missing.questions, [`B2 (required brief criterion, fail): ${COMMANDS} Evidence: not reported by the reviewer`])
  assert.deepEqual(missing.criteria[1], {
    id: 'B2',
    level: 'required',
    text: COMMANDS,
    result: 'fail',
    evidence: 'not reported by the reviewer',
  })
})

test('briefOutcome: a reviewer question that names the id as a whole word is not asked again, and B20 does not name B2', () => {
  const gates = briefGates({ runChecks: false, required: [RULES, COMMANDS], recommended: [] })
  const criteria = [
    { id: 'B1', result: 'pass', evidence: 'Listed.' },
    { id: 'B2', result: 'fail', evidence: 'build:docs does not exist.' },
  ]

  for (const question of ['B2: keep build:docs?', 'About B2, keep build:docs?', 'Keep build:docs (B2)?']) {
    assert.deepEqual(briefOutcome(gates, briefReport({ questions: [question], criteria })).questions, [question], question)
  }

  for (const question of ['B20: keep build:docs?', 'AB2 or not?', 'B2x is fine?']) {
    assert.deepEqual(
      briefOutcome(gates, briefReport({ questions: [question], criteria })).questions,
      [question, `B2 (required brief criterion, fail): ${COMMANDS} Evidence: build:docs does not exist.`],
      question,
    )
  }
})

test('briefOutcome: a check that cannot pass adds a question unless the reviewer quoted its command, and canPass alone decides', () => {
  const checks = [
    { command: 'npm run build:docs', exitCode: 127, canPass: false, evidence: 'missing script: build:docs' },
    { command: 'npm test', exitCode: 1, canPass: true, evidence: 'fails on the test this PR fixes' },
    { command: 'npm run slow', exitCode: -1, canPass: false, evidence: 'did not finish in 10 minutes' },
  ]

  const outcome = briefOutcome(GATES, briefReport({ checks }))

  assert.deepEqual(
    outcome.checks.map((check) => check.result),
    ['fail', 'pass', 'fail'],
  )

  assert.deepEqual(outcome.questions, [
    'The check `npm run build:docs` cannot pass after a change within the expected files (exit 127). Evidence: missing script: build:docs',
    'The check `npm run slow` cannot pass after a change within the expected files (exit -1). Evidence: did not finish in 10 minutes',
  ])

  const quoted = briefOutcome(GATES, briefReport({ checks, questions: ['Should `npm run build:docs` become npm run docs?'] }))

  assert.deepEqual(quoted.questions, [
    'Should `npm run build:docs` become npm run docs?',
    'The check `npm run slow` cannot pass after a change within the expected files (exit -1). Evidence: did not finish in 10 minutes',
  ])
})

test('briefOutcome: without runChecks the reported checks are ignored', () => {
  const gates = briefGates({ runChecks: false, required: [RULES], recommended: [] })
  const checks = [{ command: 'npm run build:docs', exitCode: 127, canPass: false, evidence: 'missing script' }]
  const outcome = briefOutcome(gates, briefReport({ checks, criteria: [{ id: 'B1', result: 'pass', evidence: 'Listed.' }] }))

  assert.deepEqual(outcome.checks, [])
  assert.deepEqual(outcome.questions, [])
})

test('briefOutcome: the first report of an id counts, and ids that were not sent are ignored', () => {
  const criteria = [
    { id: 'B9', result: 'fail', evidence: 'Not a criterion.' },
    { id: 'B1', result: 'pass', evidence: 'First.' },
    { id: 'B1', result: 'fail', evidence: 'Second.' },
    { id: 'B2', result: 'pass', evidence: 'Exists.' },
    { id: 'B3', result: 'pass', evidence: 'Short.' },
  ]

  const outcome = briefOutcome(GATES, briefReport({ criteria }))

  assert.deepEqual(
    outcome.criteria.map((record) => [record.id, record.result, record.evidence]),
    [
      ['B1', 'pass', 'First.'],
      ['B2', 'pass', 'Exists.'],
      ['B3', 'pass', 'Short.'],
    ],
  )

  assert.deepEqual(outcome.questions, [])
})

test('briefOutcome: a recommended criterion that does not pass goes to failedRecommended and asks nothing', () => {
  for (const [result, evidence] of [
    ['fail', 'Three filler sentences in Goal.'],
    ['unverifiable', 'No style guide.'],
  ]) {
    const outcome = briefOutcome(GATES, briefReport({ criteria: reported('B3', result, evidence) }))

    assert.deepEqual(outcome.questions, [])
    assert.deepEqual(outcome.failedRecommended, [{ id: 'B3', level: 'recommended', text: LEAN, result, evidence }])
  }

  const missing = briefOutcome(GATES, briefReport({ criteria: briefReport().criteria.slice(0, 2) }))

  assert.deepEqual(missing.failedRecommended, [
    { id: 'B3', level: 'recommended', text: LEAN, result: 'fail', evidence: 'not reported by the reviewer' },
  ])
})

test('briefOutcome: a report without checks or criteria reads as empty lists', () => {
  const legacy = { brief: '# A1\n', questions: ['Which API?'], notes: '', expectedFiles: [], changesetBump: 'minor' }

  assert.deepEqual(briefOutcome(briefGates({ runChecks: true, required: [], recommended: [] }), legacy), {
    checks: [],
    criteria: [],
    questions: ['Which API?'],
    failedRecommended: [],
  })

  assert.deepEqual(briefOutcome(briefGates({ runChecks: true, required: [RULES], recommended: [] }), legacy).questions, [
    'Which API?',
    `B1 (required brief criterion, fail): ${RULES} Evidence: not reported by the reviewer`,
  ])
})
