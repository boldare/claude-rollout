// Each mutation removes one brake of the driver and names the test file that
// must then fail. A brake whose test still passes could be dropped by a
// refactor without a red suite. This file is not part of `npm test`, because
// it runs the named suites again for every mutation.
//
//   node test/mutations.mjs [--only <id>]
//
// It works on a temp copy of the tracked files, so the checkout is never written.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// Blocks of judge() as Prettier leaves them, for the mutations that move the
// base-red check further down the gate.
const BASE_RED_BLOCK = [
  "  if (facts.mainChecks.state === 'red') {",
  '    return verdict(',
  "      'wait',",
  "      'base-red',",
  "      `${manifest.repo.base} is red at ${shortSha(facts.mainChecks.sha)}: ${facts.mainChecks.failing.join(', ')}. Merges wait until it is green`,",
  '    )',
  '  }',
  '',
].join('\n')

const BEHIND_BASE_BLOCK = [
  "  if (!facts.baseIsAncestor || githubPr.mergeable === 'CONFLICTING') {",
  "    return verdict('rebase', 'behind-base', `branch is behind ${manifest.repo.base}`)",
  '  }',
  '',
].join('\n')

const MERGEABLE_UNKNOWN_BLOCK = [
  "  if (githubPr.mergeable !== 'MERGEABLE') {",
  "    return verdict('wait', 'mergeable-unknown', `mergeable state is ${githubPr.mergeable}`)",
  '  }',
  '',
].join('\n')

const CI_RED_BLOCK = [
  "  if (facts.checks.state === 'red') {",
  '    reasons.push(...facts.checks.failing)',
  '',
  "    return verdict('fix', 'ci-red', 'CI is red on the PR head')",
  '  }',
  '',
].join('\n')

const MUTATIONS = [
  {
    id: 'merge-ignores-pause',
    file: 'lib/driver.mjs',
    find: 'if (ledger.data.paused || stopping) {',
    replace: 'if (stopping) {',
    tests: ['test/driver-tick.test.mjs'],
  },
  {
    id: 'advance-ignores-pause',
    file: 'lib/driver.mjs',
    find: 'if (!ledger.data.paused && !stopping) {',
    replace: 'if (!stopping) {',
    tests: ['test/driver-tick.test.mjs'],
  },
  {
    id: 'base-red-after-behind-base',
    file: 'lib/judge.mjs',
    find: [BASE_RED_BLOCK, BEHIND_BASE_BLOCK].join('\n'),
    replace: [BEHIND_BASE_BLOCK, BASE_RED_BLOCK].join('\n'),
    tests: ['test/judge.test.mjs'],
  },
  {
    id: 'base-red-after-ci-red',
    file: 'lib/judge.mjs',
    find: [BASE_RED_BLOCK, BEHIND_BASE_BLOCK, MERGEABLE_UNKNOWN_BLOCK, CI_RED_BLOCK].join('\n'),
    replace: [BEHIND_BASE_BLOCK, MERGEABLE_UNKNOWN_BLOCK, CI_RED_BLOCK, BASE_RED_BLOCK].join('\n'),
    tests: ['test/judge.test.mjs'],
  },
  {
    id: 'merge-not-recorded',
    file: 'lib/driver.mjs',
    // The same statements in sync sit at 8 spaces and do not match.
    find: "    entry.state = 'merged'\n    entry.mergeSha = mergeSha\n    ledger.data.lastMerge = { id: pr.id, sha: mergeSha, at: now() }\n",
    replace: '',
    tests: ['test/driver-gate.test.mjs'],
  },
  {
    id: 'merge-always-admin',
    file: 'lib/github.mjs',
    find: 'if (needsAdmin(manifest, facts)) {',
    replace: 'if (true) {',
    tests: ['test/parse.test.mjs'],
  },
  {
    id: 'start-throws',
    file: 'lib/driver.mjs',
    find: 'async function start() {',
    replace: "async function start() {\n    throw new Error('mutation: start throws')",
    tests: ['test/driver-tick.test.mjs'],
  },
  {
    id: 'moved-head-keeps-verification',
    file: 'lib/driver.mjs',
    find: "if (entry.state === 'verified' && githubPr.headRefOid !== entry.verified.sha) {",
    replace: 'if (false) {',
    tests: ['test/driver-claims.test.mjs'],
  },
  {
    id: 'closed-pr-not-blocked',
    file: 'lib/driver.mjs',
    find: "if (githubPr.state === 'CLOSED') {",
    replace: 'if (false) {',
    tests: ['test/driver-claims.test.mjs'],
  },
  {
    id: 'mergeable-states-widened',
    file: 'lib/judge.mjs',
    find: "const MERGEABLE_STATES = ['CLEAN', 'HAS_HOOKS', 'UNSTABLE']",
    replace: "const MERGEABLE_STATES = ['CLEAN', 'UNKNOWN', 'DIRTY', 'DRAFT']",
    tests: ['test/judge.test.mjs'],
  },
  {
    id: 'dismissed-review-ignored',
    file: 'lib/judge.mjs',
    find: "['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']",
    replace: "['APPROVED', 'CHANGES_REQUESTED']",
    tests: ['test/judge.test.mjs'],
  },
  {
    id: 'patch-id-constant',
    file: 'lib/github.mjs',
    find: 'const id = out.trim().split(/\\s+/)[0]',
    replace: "const id = '0'.repeat(40)",
    tests: ['test/facts.test.mjs'],
  },
  {
    id: 'ledger-save-in-place',
    file: 'lib/ledger.mjs',
    find: 'const tmp = `${file}.${process.pid}.tmp`',
    replace: 'const tmp = file',
    tests: ['test/ledger.test.mjs'],
  },
  {
    id: 'feedback-no-quiet-window',
    file: 'lib/driver.mjs',
    find: 'if (minutesSince(fresh.at(-1).at) < manifest.policy.feedbackQuietMinutes) {',
    replace: 'if (false) {',
    tests: ['test/driver-tick.test.mjs'],
  },
  {
    id: 'feedback-does-not-hold-merge',
    file: 'lib/driver.mjs',
    find: ' && !ledger.prs[pr.id].feedbackWaiting)',
    replace: ')',
    tests: ['test/driver-gate.test.mjs'],
  },
  {
    id: 'guard-gh-forbidden-shrunk',
    file: 'hooks/guard-bash.mjs',
    find: "  'variable',\n  'workflow',\n  'ruleset',\n",
    replace: '',
    tests: ['test/guard.test.mjs'],
  },
  {
    id: 'guard-publish-words-shrunk',
    file: 'hooks/guard-bash.mjs',
    find: "  'unpublish',\n  'dist-tag',\n  'deprecate',\n  'owner',\n",
    replace: '',
    tests: ['test/guard.test.mjs'],
  },
  {
    id: 'guard-push-forbidden-shrunk',
    file: 'hooks/guard-bash.mjs',
    find: "'--mirror', '--all', '--tags', '--delete', '-d', '--prune', ",
    replace: "'--all', '--delete', '-d', ",
    tests: ['test/guard.test.mjs'],
  },
  {
    id: 'guard-http-hosts-shrunk',
    file: 'hooks/guard-bash.mjs',
    find: "['api.github.com', 'uploads.github.com', 'registry.npmjs.org', 'registry.yarnpkg.com']",
    replace: "['api.github.com']",
    tests: ['test/guard.test.mjs'],
  },
  {
    id: 'merge-delay-dropped',
    file: 'lib/driver.mjs',
    find: "if (manifest.policy.merge === 'human' && approvedFor < manifest.policy.mergeDelaySeconds) {",
    replace: 'if (false) {',
    tests: ['test/driver-commands.test.mjs'],
  },
  {
    id: 'not-verified-stays-verified',
    file: 'lib/driver.mjs',
    find: "if (judged.code === 'not-verified' && entry.state === 'verified') {",
    replace: 'if (false) {',
    tests: ['test/driver-gate.test.mjs'],
  },
  {
    id: 'job-end-save-unguarded',
    file: 'lib/driver.mjs',
    find: '} catch (saveError) {',
    replace: '} catch (saveError) {\n      throw saveError',
    tests: ['test/driver-runs.test.mjs'],
  },
  {
    id: 'ignored-checks-drop-unmatched',
    file: 'lib/checks.mjs',
    find: 'checkRuns.filter((run) => !matchesAny(run.name, ignoredGlobs))',
    replace: 'checkRuns.filter(() => ignoredGlobs.length === 0)',
    tests: ['test/checks.test.mjs'],
  },
]

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TEST_TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 64 * 1024 * 1024
const TAIL_LINES = 40

function cliOptions() {
  try {
    return parseArgs({ options: { only: { type: 'string' } }, strict: true }).values
  } catch (error) {
    console.error(`mutations: ${error.message}`)
    console.error('usage: node test/mutations.mjs [--only <id>]')
    return null
  }
}

function selectedMutations() {
  const values = cliOptions()

  if (!values) {
    return null
  }

  if (values.only === undefined) {
    return MUTATIONS
  }

  const chosen = MUTATIONS.filter((mutation) => mutation.id === values.only)

  if (chosen.length === 0) {
    console.error(`mutations: no mutation has the id ${values.only}`)
    return null
  }

  return chosen
}

// Working-tree content, so uncommitted edits count. A tracked path deleted
// from the working tree is left out.
function copyTrackedFiles(copy) {
  const listed = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)

  for (const path of listed) {
    const source = join(ROOT, path)

    if (!existsSync(source)) {
      continue
    }

    mkdirSync(dirname(join(copy, path)), { recursive: true })
    copyFileSync(source, join(copy, path))
  }

  symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'))
}

function occurrences(text, find) {
  return text.split(find).length - 1
}

function staleMutations(copy, selected) {
  const stale = []

  for (const mutation of selected) {
    const path = join(copy, mutation.file)
    const count = existsSync(path) ? occurrences(readFileSync(path, 'utf8'), mutation.find) : 0

    if (count !== 1) {
      stale.push(`stale ${mutation.id}: ${mutation.file} holds the text ${count} times`)
    }
  }

  return stale
}

function baselinePasses(copy, selected) {
  const files = [...new Set(selected.flatMap((mutation) => mutation.tests))]
  const run = spawnSync(process.execPath, ['--test', ...files], { cwd: copy, encoding: 'utf8', maxBuffer: OUTPUT_LIMIT })

  if (run.status === 0) {
    return true
  }

  const output = `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`

  console.error(`mutations: the suites fail before any mutation: ${files.join(' ')}`)
  console.error(output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n'))

  return false
}

// A syntax error fails any test, so a file that does not parse proves nothing.
function outcomeOf(copy, mutation) {
  const path = join(copy, mutation.file)

  if (spawnSync(process.execPath, ['--check', path], { stdio: 'ignore' }).status !== 0) {
    return 'broken'
  }

  const run = spawnSync(process.execPath, ['--test', ...mutation.tests], { cwd: copy, stdio: 'ignore', timeout: TEST_TIMEOUT_MS })

  return run.status === 0 && !run.signal && !run.error ? 'survived' : 'killed'
}

function runMutation(copy, mutation) {
  const path = join(copy, mutation.file)
  const original = readFileSync(path, 'utf8')
  // A function replacement, so a $ in the text is never a pattern.
  const mutated = original.replace(mutation.find, () => mutation.replace)

  writeFileSync(path, mutated)

  try {
    return outcomeOf(copy, mutation)
  } finally {
    writeFileSync(path, original)
  }
}

function runAll(copy, selected) {
  const stale = staleMutations(copy, selected)

  if (stale.length > 0) {
    stale.forEach((line) => console.error(line))
    return false
  }

  if (!baselinePasses(copy, selected)) {
    return false
  }

  let allKilled = true

  for (const mutation of selected) {
    const outcome = runMutation(copy, mutation)

    console.log(`${outcome} ${mutation.id} ${mutation.tests.join(' ')}`)
    allKilled = allKilled && outcome === 'killed'
  }

  return allKilled
}

function main() {
  const selected = selectedMutations()

  if (!selected) {
    return 1
  }

  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.error('mutations: no node_modules in the checkout, run npm ci first')
    return 1
  }

  const copy = mkdtempSync(join(tmpdir(), 'rollout-mutations-'))

  try {
    copyTrackedFiles(copy)

    return runAll(copy, selected) ? 0 : 1
  } finally {
    // Removes the node_modules link, never its target.
    rmSync(copy, { recursive: true, force: true })
  }
}

process.exitCode = main()
