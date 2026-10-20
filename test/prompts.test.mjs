import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshPr, recordAnswers, recordFindings } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import {
  briefReviewPrompt,
  briefWritePrompt,
  codeScanningNote,
  delegatePrompt,
  findingsNote,
  fixPrompt,
  implementPrompt,
  preVerifyNote,
  resumeFreshPrompt,
  verifyPrompt,
  verifyRecipe,
} from '../lib/prompts.mjs'
import { makeRollout } from './fixtures.mjs'

const STATE = { ...freshPr(), pr: 12, ready: { status: 'READY' } }

function render({ public: isPublic, denylist }) {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]

  manifest.repo.public = isPublic
  manifest.repo.denylist = denylist

  return {
    implement: implementPrompt(manifest, pr, STATE),
    briefWrite: briefWritePrompt(manifest, pr, STATE),
    briefReview: briefReviewPrompt(manifest, pr, STATE, '# draft'),
    verify: verifyPrompt(manifest, pr, STATE, 'a1a1a1a'),
    delegate: delegatePrompt(manifest, pr, { ...STATE, blocked: { kind: 'needs-decision', question: 'Q', evidence: 'E' } }),
  }
}

function assertFilled(prompts) {
  for (const [name, text] of Object.entries(prompts)) {
    assert.equal(text.includes('{{'), false, name)
  }
}

test('prompts: every role is told that its run ends with its turn', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const prompts = {
    ...render({ public: false, denylist: [] }),
    fix: fixPrompt(manifest, pr, STATE, { reason: 'ci', note: 'n', head: 'abc' }),
    resumeFresh: resumeFreshPrompt(manifest, pr, STATE, { reason: 'session missing', note: 'n' }),
  }

  for (const [name, text] of Object.entries(prompts)) {
    assert.ok(text.includes('Your run ends when your turn ends'), name)
    assert.ok(text.includes('never end a turn to wait'), name)
  }

  assert.ok(prompts.implement.includes('Wait for CI in the foreground too (step 6).'))
  assertFilled(prompts)
})

test('prompts: a public repo keeps the public-repository rules', () => {
  const prompts = render({ public: true, denylist: ['acme-client'] })

  assert.ok(prompts.implement.includes('## Public repository'))
  assert.ok(prompts.implement.includes('Never write absolute local paths'))
  assert.ok(prompts.briefWrite.includes('**Public repository.**'))
  assert.ok(prompts.briefReview.includes('could copy into the public repo'))
  assert.ok(prompts.verify.includes('or absolute local paths anywhere in the diff or PR text'))
  assert.ok(prompts.verify.includes('gh pr view 12 --json title,body'))

  for (const [name, text] of Object.entries(prompts)) {
    assert.ok(text.includes('"acme-client"'), name)
  }

  assertFilled(prompts)
})

test('prompts: a private repo keeps only the denylist', () => {
  const prompts = render({ public: false, denylist: ['acme-client'] })

  for (const [name, text] of Object.entries(prompts)) {
    assert.equal(text.includes('Public repository'), false, name)
    assert.equal(text.includes('public repo'), false, name)
    assert.equal(text.includes('local paths'), false, name)
    assert.ok(text.includes('"acme-client"'), name)
  }

  assert.ok(prompts.verify.includes('gh pr view 12 --json title,body'))
  assertFilled(prompts)
})

test('prompts: a private repo without a denylist gets neither rule', () => {
  const prompts = render({ public: false, denylist: [] })

  for (const [name, text] of Object.entries(prompts)) {
    assert.equal(text.includes('Public repository'), false, name)
    assert.equal(text.includes('local paths'), false, name)
    assert.doesNotMatch(text, /denylist/i, name)
  }

  assert.ok(prompts.briefReview.includes('4. Check for scope leaking in from other PRs.\n'))
  assert.ok(prompts.verify.includes('- The PR text: `gh pr view 12 --json title,body`.'))
  assertFilled(prompts)
})

test('prompts: the brief writer sees every earlier answer, oldest first, under one heading', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const briefAnswers = [
    { question: 'Which default for the delay?', answer: '120 seconds.' },
    { question: 'Keep the old flag?', answer: 'Yes, as an alias.' },
    { question: null, answer: 'The plan moved to a new file.' },
  ]

  const text = briefWritePrompt(manifest, pr, { ...STATE, briefAnswers })
  const order = [
    'Which default for the delay?',
    '120 seconds.',
    'Keep the old flag?',
    'Yes, as an alias.',
    'The plan moved to a new file.',
  ].map((part) => text.indexOf(part))

  assert.equal(text.split('## Answers from the maintainer').length, 2)
  assert.ok(order.every((index) => index > -1))
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  )

  assert.ok(text.includes('A note from the maintainer:\n\nThe plan moved to a new file.'))

  const fresh = briefWritePrompt(manifest, pr, freshPr())

  assert.equal(fresh.includes('## Answers from the maintainer'), false)
  assert.equal(fresh.includes('{{'), false)
})

function stepNumbers(text) {
  return [...text.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]))
}

test('prompts: every step starts its own line and the recipe sits indented under its step', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]

  manifest.repo.verify = { common: ['npm ci', 'npm test', 'npm run format:check'] }

  const implement = implementPrompt(manifest, pr, STATE)
  const verify = verifyPrompt(manifest, pr, STATE, 'a1a1a1a')

  assert.deepEqual(stepNumbers(implement), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(stepNumbers(verify), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.ok(implement.includes('\n   1. `npm ci`\n   2. `npm test`\n'))
  assert.ok(verify.includes('\n   1. `npm ci`\n   2. `npm test`\n'))
  assert.ok(briefWritePrompt(manifest, pr, STATE).includes('\n  1. `npm ci`\n  2. `npm test`\n'))
})

test('prompts: the brief writers know which dependencies are merged and which are only verified', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all.find((item) => item.id === 'A2')
  const entry = { briefAnswers: [], noteHistory: [] }
  const heads = [{ id: 'A1', sha: 'a1a1a1a1a1a1a1a1', patchId: 'patch-a1' }]

  assert.match(
    briefWritePrompt(manifest, pr, entry),
    /that worktree, at `origin\/main`, which already contains the merged dependencies \(A1\)\./,
  )

  assert.match(
    briefWritePrompt(manifest, pr, entry, heads),
    /at `origin\/main` with the dependencies that are verified but not merged yet merged into it locally: A1 at `a1a1a1a`\. They can still change before they merge\./,
  )

  assert.match(
    briefReviewPrompt(manifest, pr, entry, '# A2', heads),
    /a worktree at `origin\/main` with the dependencies that are verified but not merged yet/,
  )

  assert.equal(briefWritePrompt(manifest, pr, entry, heads).includes('{{'), false)
})

test('prompts: the implementer hears of a dependency that changed after the brief saw it', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all.find((item) => item.id === 'A2')
  const quiet = implementPrompt(manifest, pr, { briefDrift: [], noteHistory: [] })
  const drifted = implementPrompt(manifest, pr, { briefDrift: [{ id: 'A1', sha: 'a1a1a1a1a1a1' }], noteHistory: [] })

  assert.doesNotMatch(quiet, /The brief and its dependencies/)
  assert.match(drifted, /## The brief and its dependencies\n\nThe brief was written before these dependencies merged/)
  assert.match(drifted, /- A1: the brief saw `a1a1a1a`\./)
  assert.equal(drifted.includes('{{'), false)
})

test('prompts: the brief writer states the .claude/ rule for both values of allowClaudeConfig', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const refused = briefWritePrompt(manifest, { ...pr, allowClaudeConfig: false }, STATE)
  const allowed = briefWritePrompt(manifest, { ...pr, allowClaudeConfig: true }, STATE)

  assert.ok(
    refused.includes(
      "- **Claude Code files.** This PR must not touch `.claude/`. Agents of this rollout load the project's Claude Code settings.",
    ),
  )

  assert.ok(allowed.includes('- **Claude Code files.** This PR may change files under `.claude/`.'))
  assert.match(allowed, /the maintainer reviews that diff separately/)
  assert.equal(refused.includes('{{'), false)
  assert.equal(allowed.includes('{{'), false)
})

test('prompts: the brief writer assumes no plan language', () => {
  const manifest = loadManifest(makeRollout())
  const text = briefWritePrompt(manifest, manifest.all[0], STATE)

  assert.doesNotMatch(text, /Decyzje/)
  assert.doesNotMatch(text, /Polish/)
  assert.ok(text.includes('always in English'))
})

test('prompts: the verifier skips steps that rewrite files for npm, pnpm, yarn and bun', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const kept = [
    'npm ci',
    'npm test',
    'npm run format:check',
    'pnpm format:check',
    'pnpm install --frozen-lockfile',
    'yarn install --frozen-lockfile',
    'yarn install --immutable',
    'yarn --frozen-lockfile',
    'bun install --frozen-lockfile',
    'bun test',
  ]

  const dropped = [
    'pnpm lint:fix',
    'eslint --fix .',
    'prettier --write .',
    'npm run format',
    'npm run format -- --log-level warn',
    'pnpm format',
    'pnpm run format',
    'yarn format',
    'yarn run format',
    'bun run format',
    'npm install',
    'npm i',
    'pnpm install',
    'pnpm i',
    'yarn install',
    'yarn',
    'bun install',
    'bun i',
  ]

  manifest.repo.verify = { common: [...kept, ...dropped] }

  assert.deepEqual(verifyRecipe(manifest, pr, { forVerifier: true }), kept)
  assert.deepEqual(verifyRecipe(manifest, pr), [...kept, ...dropped])
})

test('prompts: the changeset rules follow policy.maxBump', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]

  pr.changeset = 'major'
  manifest.policy.maxBump = 'major'

  assert.doesNotMatch(implementPrompt(manifest, pr, STATE), /never major/i)
  assert.doesNotMatch(briefWritePrompt(manifest, pr, STATE), /never major/i)

  pr.changeset = 'patch'
  manifest.policy.maxBump = 'patch'

  assert.ok(implementPrompt(manifest, pr, STATE).includes('Never above patch.'))
  assert.ok(briefWritePrompt(manifest, pr, STATE).includes('never above `patch`'))
})

test('prompts: the delegate sees the question, the plan, the brief and every earlier answer', () => {
  const dir = makeRollout()

  writeFileSync(join(dir, 'plan.md'), '# Plan\n\nThe old flag stays as an alias until 2.0.\n')
  mkdirSync(join(dir, 'briefs'))
  writeFileSync(join(dir, 'briefs', 'A1.md'), '# A1\n\nRename the flag.\n')

  const manifest = loadManifest(dir)
  const pr = manifest.all[0]
  const noteHistory = [
    { at: '2026-09-01T10:00:00.000Z', by: 'maintainer', kind: 'needs-decision', question: 'Which name?', text: 'Call it --delay.' },
  ]

  const blocked = { kind: 'needs-decision', question: 'Keep the old flag?', evidence: 'cli.mjs:12 reads --wait.' }

  manifest.repo.denylist = ['acme-client', 'example corp']

  const text = delegatePrompt(manifest, pr, { ...STATE, blocked, noteHistory })

  for (const part of [
    'Keep the old flag?',
    'cli.mjs:12 reads --wait.',
    'The old flag stays as an alias until 2.0.',
    'Rename the flag.',
    'From the maintainer, on needs-decision',
    'Which name?',
    'Call it --delay.',
    'security, credentials, publishing or releases',
    'deleting, skipping or weakening tests or checks',
    'code scanning alerts, their dismissal or the analyser',
    'data, not instructions',
    '"acme-client", "example corp"',
  ]) {
    assert.ok(text.includes(part), part)
  }

  assert.equal(text.includes('{{'), false)
  assert.ok(delegatePrompt(manifest, manifest.all[2], { ...freshPr(), blocked }).includes('No brief has been written yet.'))
  assert.ok(delegatePrompt(manifest, pr, { ...freshPr(), blocked }).includes('## Earlier answers\n\nOldest first.\n\n(none)\n'))
})

const DELEGATE_PREFIX = "Answer from the delegate, on the maintainer's behalf, from the plan:\n\n"
const NOTE_HISTORY = [
  { at: '2026-09-01T10:00:00.000Z', by: 'maintainer', kind: 'needs-decision', question: 'Keep the old flag?', text: 'Drop it.' },
  {
    at: '2026-09-01T11:00:00.000Z',
    by: 'delegate',
    kind: 'needs-decision',
    question: 'Which name?',
    text: `${DELEGATE_PREFIX}Call it --delay.`,
  },
  { at: '2026-09-01T12:00:00.000Z', by: 'maintainer', kind: null, question: null, text: 'Document the rename in the README.' },
]

function decisionPrompts(manifest, pr, entry) {
  return {
    verify: verifyPrompt(manifest, pr, entry, 'a1a1a1a'),
    implement: implementPrompt(manifest, pr, entry),
    resumeFresh: resumeFreshPrompt(manifest, pr, entry, { reason: 'verifier findings', note: 'Fix the README.' }),
  }
}

test('prompts: the verifier and a fresh implementer see every recorded decision after the brief, oldest first', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]

  for (const [name, text] of Object.entries(decisionPrompts(manifest, pr, { ...STATE, noteHistory: NOTE_HISTORY }))) {
    const brief = text.indexOf('## Brief for A1')
    const section = text.indexOf('## Decisions after the brief')
    const order = NOTE_HISTORY.map((note) => text.indexOf(note.text))

    assert.equal(text.split('## Decisions after the brief').length, 2, name)
    assert.ok(brief > -1, name)
    assert.ok(section > brief, name)
    assert.ok(order[0] > section, name)
    assert.deepEqual(
      order,
      [...order].sort((left, right) => left - right),
      name,
    )

    assert.ok(
      text.includes('### 1. From the maintainer, on needs-decision\n\nQuestion:\n\nKeep the old flag?\n\nAnswer:\n\nDrop it.'),
      name,
    )

    assert.ok(
      text.includes(`### 2. From the delegate, on needs-decision\n\nQuestion:\n\nWhich name?\n\nAnswer:\n\n${DELEGATE_PREFIX}`),
      name,
    )

    assert.ok(text.includes('### 3. From the maintainer\n\nNote:\n\nDocument the rename in the README.'), name)
    assert.equal(text.includes('{{'), false, name)
  }

  for (const entry of [STATE, freshPr()]) {
    for (const [name, text] of Object.entries(decisionPrompts(manifest, pr, entry))) {
      assert.equal(text.includes('Decisions after the brief'), false, name)
      assert.equal(text.includes('{{'), false, name)
    }
  }
})

test('codeScanningNote: a false positive goes to the maintainer as a code-scanning block', () => {
  const manifest = loadManifest(makeRollout())
  const note = codeScanningNote(manifest, ['#4 js/shell-command-injection-from-environment at bin/rollout.mjs:357'])

  for (const part of [
    '- #4 js/shell-command-injection-from-environment at bin/rollout.mjs:357',
    'Never silence the analyser',
    '`gh api repos/example/widgets/code-scanning/alerts/<number>`',
    'report BLOCKED with kind `code-scanning`',
  ]) {
    assert.ok(note.includes(part), part)
  }

  assert.equal(note.includes('needs-decision'), false)
})

const FINDINGS = ['README.md:3 still names the old flag.', 'No test covers an empty list.', 'cli.mjs:40 swallows the error.']

// A1's state after a FAIL with FINDINGS, where the implementer fixed F1,
// left F2 unanswered and disputed F3.
function answered(state = STATE) {
  const entry = structuredClone(state)

  recordFindings(entry, FINDINGS, '2026-09-01T10:00:00.000Z')
  recordAnswers(entry, [
    { id: 'F1', action: 'Renamed it in README.md:3.', outcome: 'fixed' },
    { id: 'F3', action: 'The error is logged at cli.mjs:42.', outcome: 'disputed' },
  ])

  return entry
}

test('findingsNote: numbers the findings in order, lists the failed checklist items and asks for an answer to each', () => {
  const checklist = [
    { item: 'tests pass', status: 'pass', evidence: 'npm test: 12 pass' },
    { item: 'docs updated', status: 'fail', evidence: 'README.md:3' },
    { item: 'CI green', status: 'unverifiable', evidence: 'no run yet' },
  ]

  const note = findingsNote(answered().findings.items, checklist, '')
  const order = ['- F1: README.md:3', '- F2: No test', '- F3: cli.mjs:40'].map((part) => note.indexOf(part))

  assert.ok(note.startsWith('An independent verifier rejected the PR. Blocking findings:\n- F1: '), note)
  assert.ok(order[0] > -1, note)
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  )

  assert.ok(note.includes('Failed checklist items:\n- docs updated: fail: README.md:3\n- CI green: unverifiable: no run yet\n'), note)
  assert.equal(note.includes('tests pass'), false)

  for (const part of [
    '`addressed`',
    '`outcome` `fixed`',
    '`outcome` `disputed`',
    'A disputed finding it still finds open goes to the maintainer.',
  ]) {
    assert.ok(note.includes(part), part)
  }

  assert.equal(note.includes('left this in the worktree'), false)
  assert.ok(findingsNote([], checklist, '').includes('Blocking findings:\n(none)\n'))

  const touched = findingsNote([], [], 'M lib/a.mjs')

  assert.ok(touched.includes('Failed checklist items:\n(none)\n'), touched)
  assert.ok(touched.endsWith('\n\nThe verifier left this in the worktree (it has been reset):\nM lib/a.mjs'), touched)
})

test('prompts: the verifier re-checks the previous findings after the brief and the decisions, as claims with their answers', () => {
  const manifest = loadManifest(makeRollout())
  const text = verifyPrompt(manifest, manifest.all[0], answered({ ...STATE, noteHistory: NOTE_HISTORY }), 'a1a1a1a')
  const brief = text.indexOf('## Brief for A1')
  const decisions = text.indexOf('## Decisions after the brief')
  const section = text.indexOf('## Findings to re-check')
  const order = ['### F1', '### F2', '### F3'].map((heading) => text.indexOf(heading))

  assert.equal(text.split('## Findings to re-check').length, 2)
  assert.ok(brief > -1)
  assert.ok(decisions > brief)
  assert.ok(section > decisions)
  assert.ok(order[0] > section)
  assert.deepEqual(
    order,
    [...order].sort((left, right) => left - right),
  )

  for (const part of [
    'They are claims to check, not decisions.',
    '### F1\n\nFinding:\n\nREADME.md:3 still names the old flag.\n\nAnswer (fixed):\n\nRenamed it in README.md:3.',
    '### F2\n\nFinding:\n\nNo test covers an empty list.\n\nNo answer from the implementer.',
    '### F3\n\nFinding:\n\ncli.mjs:40 swallows the error.\n\nAnswer (disputed):\n\nThe error is logged at cli.mjs:42.',
  ]) {
    assert.ok(text.indexOf(part, section) > section, part)
  }

  for (const step of [
    '\n4. When the prompt ends with findings to re-check, check each one yourself at this SHA and report its id in `recheck`, with evidence.',
    '\n   - `open`: the defect is still there, whatever the answer says. An `open` finding also goes into `blocking`.\n',
    '\n8. Verdict: PASS only when every checklist item passes, no re-checked finding is `open` and there is no blocking finding.',
  ]) {
    assert.ok(text.includes(step), step)
  }

  assert.equal(text.includes('{{'), false)
})

test('prompts: with no findings to re-check the verifier gets no such section', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]

  for (const entry of [STATE, freshPr(), { ...STATE, findings: { at: '2026-09-01T10:00:00.000Z', items: [] } }]) {
    const text = verifyPrompt(manifest, pr, entry, 'a1a1a1a')

    assert.equal(text.includes('## Findings to re-check'), false)
    assert.equal(text.includes('{{'), false)
  }
})

const HEAD = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'

// One record of a pre-verify command, as commandResult makes it: a pass unless overridden.
function commandRecord(overrides = {}) {
  return {
    command: 'npm test',
    level: 'required',
    result: 'pass',
    summary: 'exit 0',
    exitCode: 0,
    signal: null,
    timedOut: false,
    seconds: 3,
    tail: 'tests 12, pass 12\n',
    changes: [],
    ...overrides,
  }
}

const LINT_FAILED = commandRecord({
  command: 'npm run lint',
  level: 'recommended',
  result: 'fail',
  summary: 'exit 1',
  exitCode: 1,
  tail: 'lib/a.mjs\n  3:7  error  Expected blank line before this statement\n',
})

function withCommands(manifest, required, recommended) {
  manifest.gates = { preVerify: { scope: false, required, recommended } }

  return manifest
}

test('prompts: the implementer learns which commands the driver runs after READY, by level', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const both = implementPrompt(withCommands(manifest, ['npm ci', 'npm test'], ['npm run lint']), pr, STATE)
  const section = both.indexOf('## Commands the driver runs after READY')

  assert.ok(section > both.indexOf('Or `status: BLOCKED` with `blocked`.'), 'after step 8')
  assert.ok(section < both.indexOf('## Writing'), 'before the writing rules')
  assert.deepEqual(stepNumbers(both), [1, 2, 3, 4, 5, 6, 7, 8])

  for (const part of [
    'After your READY report, the driver runs these commands itself in this worktree at the head you reported, one at a time. Its own result decides, whatever your report says.',
    'Required. A failure sends the PR back to you with the exit code and the end of the output:\n\n- `npm ci`\n- `npm test`\n\n',
    'Recommended. A failure never sends the PR back, and the verifier sees it:\n\n- `npm run lint`\n\n## Writing',
  ]) {
    assert.ok(both.includes(part), part)
  }

  const required = implementPrompt(withCommands(manifest, ['npm test'], []), pr, STATE)

  assert.ok(
    required.includes(
      'Required. A failure sends the PR back to you with the exit code and the end of the output:\n\n- `npm test`\n\n## Writing',
    ),
  )

  assert.equal(required.includes('Recommended. A failure'), false)

  const recommended = implementPrompt(withCommands(manifest, [], ['npm run lint']), pr, STATE)

  assert.ok(recommended.includes('whatever your report says.\n\nRecommended. A failure never sends the PR back'))
  assert.equal(recommended.includes('Required. A failure'), false)

  const resumed = resumeFreshPrompt(manifest, pr, STATE, { reason: 'session missing', note: 'n' })

  assert.ok(resumed.includes('## Commands the driver runs after READY\n\n'))
  assertFilled({ both, required, recommended, resumed })
})

test('prompts: without pre-verify commands the implementer gets no such section', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]

  for (const text of [implementPrompt(manifest, pr, STATE), implementPrompt(withCommands(manifest, [], []), pr, STATE)]) {
    assert.equal(text.includes('Commands the driver runs'), false)
    assert.ok(text.includes('Or `status: BLOCKED` with `blocked`.\n\n\n\n## Writing'))
    assert.equal(text.includes('{{'), false)
  }
})

test('prompts: the verifier sees the recommended commands that failed at its SHA, between the decisions and the findings to re-check', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const preVerify = { sha: HEAD, at: '2026-09-01T10:00:00.000Z', results: [commandRecord(), LINT_FAILED] }
  const text = verifyPrompt(manifest, pr, answered({ ...STATE, noteHistory: NOTE_HISTORY, preVerify }), HEAD)
  const decisions = text.indexOf('## Decisions after the brief')
  const section = text.indexOf('\n## Recommended commands that failed\n')
  const findings = text.indexOf('## Findings to re-check')

  assert.ok(decisions > -1)
  assert.ok(section > decisions)
  assert.ok(findings > section)
  assert.ok(text.trimEnd().endsWith('Answer (disputed):\n\nThe error is logged at cli.mjs:42.'), 'the findings stay last')
  assert.ok(text.includes('`## Recommended commands that failed` follows the decisions'), 'the inputs name the section')

  for (const part of [
    'The driver ran these recommended commands itself at this SHA, and they failed. These are its own results, not claims. A failure alone does not block the PR.',
    '### `npm run lint`\n\nexit 1\n\n```\nlib/a.mjs\n  3:7  error  Expected blank line before this statement\n```\n',
  ]) {
    assert.ok(text.indexOf(part, section) > section, part)
  }

  assert.equal(text.includes('### `npm test`'), false, 'a command that passed is not listed')
  assert.equal(text.includes('{{'), false)
})

test('prompts: the verifier gets no failed commands for another SHA, for passes only or for a failed required command', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const at = '2026-09-01T10:00:00.000Z'
  const requiredFailed = commandRecord({ result: 'fail', summary: 'exit 1', exitCode: 1 })
  const entries = [
    { ...STATE, preVerify: { sha: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', at, results: [LINT_FAILED] } },
    { ...STATE, preVerify: { sha: HEAD, at, results: [commandRecord()] } },
    { ...STATE, preVerify: { sha: HEAD, at, results: [requiredFailed] } },
    STATE,
    freshPr(),
  ]

  for (const entry of entries) {
    const text = verifyPrompt(manifest, pr, entry, HEAD)

    assert.equal(text.includes('\n## Recommended commands that failed\n'), false, JSON.stringify(entry.preVerify))
    assert.equal(text.includes('{{'), false)
  }
})

test('preVerifyNote: every failed command with its summary and output, the reset it caused, and the two rules', () => {
  const failed = commandRecord({ result: 'fail', summary: 'exit 1', exitCode: 1, tail: 'not ok 3 - parses an empty list\n' })
  const changed = commandRecord({
    command: 'npm run build',
    result: 'fail',
    summary: 'exit 0, left tracked changes: M dist/index.js',
    tail: 'built in 2s\n',
    changes: ['M dist/index.js'],
  })

  assert.equal(
    preVerifyNote(HEAD, [failed, changed]),
    [
      'The driver ran the required pre-verify commands at `a1a1a1a`. These failed:',
      '### `npm test`\n\nexit 1\n\n```\nnot ok 3 - parses an empty list\n```',
      '### `npm run build`\n\nexit 0, left tracked changes: M dist/index.js\n\n```\nbuilt in 2s\n```\n\nThe driver reset the worktree to that head.',
      '- The driver runs every command again on the new head.\n- Never weaken, skip or delete tests or checks to get green.',
    ].join('\n\n'),
  )
})

test('preVerifyNote: output with a code fence of its own gets a longer fence', () => {
  const failed = commandRecord({ result: 'fail', summary: 'exit 1', exitCode: 1, tail: 'expected:\n```\n{}\n```\n' })

  assert.ok(preVerifyNote(HEAD, [failed]).includes('exit 1\n\n````\nexpected:\n```\n{}\n```\n````'))
})
