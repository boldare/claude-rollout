import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { briefGates } from '../lib/checks.mjs'
import { freshPr, recordAnswers, recordFindings } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import {
  briefReviewNotes,
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

test('prompts: the brief writer and the reviewer see every earlier answer, oldest first, under one heading', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const briefAnswers = [
    { question: 'Which default for the delay?', answer: '120 seconds.' },
    { question: 'Keep the old flag?', answer: 'Yes, as an alias.' },
    { question: null, answer: 'The plan moved to a new file.' },
  ]

  const entry = { ...STATE, briefAnswers }
  const prompts = {
    write: briefWritePrompt(manifest, pr, entry),
    review: briefReviewPrompt(manifest, pr, entry, '# A1\n\n## Goal\n\nRename the flag.'),
  }

  for (const [name, text] of Object.entries(prompts)) {
    const order = [
      'Which default for the delay?',
      '120 seconds.',
      'Keep the old flag?',
      'Yes, as an alias.',
      'The plan moved to a new file.',
    ].map((part) => text.indexOf(part))

    assert.equal(text.split('## Answers from the maintainer').length, 2, name)
    assert.ok(
      order.every((index) => index > -1),
      name,
    )

    assert.deepEqual(
      order,
      [...order].sort((left, right) => left - right),
      name,
    )

    assert.ok(text.includes('A note from the maintainer:\n\nThe plan moved to a new file.'), name)
  }

  const answers = prompts.review.indexOf('\n## Answers from the maintainer\n')

  assert.ok(answers > prompts.review.indexOf('\n## Sources\n'), 'the reviewer gets the answers after the sources')
  assert.ok(answers < prompts.review.indexOf('\n## Draft brief\n'), 'and before the draft, whose own sections would swallow them')
  assert.ok(prompts.review.trimEnd().endsWith('## Draft brief\n\n# A1\n\n## Goal\n\nRename the flag.'))

  for (const fresh of [briefWritePrompt(manifest, pr, freshPr()), briefReviewPrompt(manifest, pr, freshPr(), '# A1')]) {
    assert.equal(fresh.includes('## Answers from the maintainer'), false)
    assert.equal(fresh.includes('{{'), false)
  }
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
  assert.deepEqual(stepNumbers(verify), [1, 2, 3, 4, 5, 6, 7, 8, 9])
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
    '\n5. When the prompt ends with findings to re-check, check each one yourself at this SHA and report its id in `recheck`, with evidence.',
    "\n   - `open`: the defect is still there, whatever the answer says. An `open` finding also goes into `blocking`, except one the driver added for a criterion this prompt lists. Such a finding starts with the criterion's id and `(required criterion)`. Report it through `criteria` only, so it is not counted twice. Its `recheck` entry stays.\n",
    '\n9. Verdict: PASS only when every checklist item passes, every required project criterion passes, no re-checked finding is `open` and there is no blocking finding.',
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

// One record of a command the driver ran, as commandResult makes it: a pre-verify pass unless overridden.
function commandRecord(overrides = {}) {
  return {
    command: 'npm test',
    stage: 'preVerify',
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
  manifest.gates = { ready: { required: [], recommended: [] }, preVerify: { scope: false, required, recommended } }

  return manifest
}

function withReady(manifest, required, recommended) {
  manifest.gates = { ready: { required, recommended }, preVerify: { scope: false, required: [], recommended: [] } }

  return manifest
}

function selfCheck(text) {
  return text.slice(text.indexOf('7. **Self-check before READY:**'), text.indexOf('8. **Report**'))
}

const READY_RULES =
  '   - Run each command below in this worktree at the `HEAD` you will report, one at a time and in the order listed, before the other checks of this step. Report each one in `gates`, with the command as written, its exit code and the last lines of its output. Fix a failing required one before READY, as you would a red check: fix the cause and go back to step 3. A failing recommended one never sends the PR back. Report it like the others. After READY the driver runs every one again, and its own result decides, whatever the report says. It also fails a command that leaves tracked changes.'

const SELF_CHECKS = [
  '   - `git status --porcelain` is empty;',
  '   - local `HEAD` equals the PR head (`gh pr view <number> --json headRefOid`);',
  '   - `origin/main` is an ancestor of `HEAD` (`git fetch origin && git merge-base --is-ancestor origin/main HEAD`); if not, rebase, re-verify, push, wait for CI again;',
  '   - every check on that SHA passed.',
]

test('schemas/ready.json: every report has gates, and each entry requires the command, its exit code and the tail of its output', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/ready.json', import.meta.url), 'utf8'))
  const { gates } = schema.properties

  assert.ok(schema.required.includes('gates'))
  assert.equal(gates.type, 'array')
  assert.deepEqual(gates.items.required, ['command', 'exitCode', 'tail'])
  assert.equal(gates.items.properties.command.type, 'string')
  assert.equal(gates.items.properties.exitCode.type, 'integer')
  assert.equal(gates.items.properties.tail.type, 'string')
})

test('prompts: without ready commands step 7 of the implementer reads as it always did', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const expected = `${['7. **Self-check before READY:**', ...SELF_CHECKS].join('\n')}\n`

  for (const text of [implementPrompt(manifest, pr, STATE), implementPrompt(withReady(manifest, [], []), pr, STATE)]) {
    assert.equal(selfCheck(text), expected)
    assert.deepEqual(stepNumbers(text), [1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(text.includes('{{'), false)
  }
})

test('prompts: the ready commands are the first item of step 7, required ones first', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const both = implementPrompt(withReady(manifest, ['npm ci', 'npm test'], ['npm run lint']), pr, STATE)

  assert.equal(
    selfCheck(both),
    `${[
      '7. **Self-check before READY:**',
      READY_RULES,
      '     - required: `npm ci`',
      '     - required: `npm test`',
      '     - recommended: `npm run lint`',
      ...SELF_CHECKS,
    ].join('\n')}\n`,
  )

  assert.deepEqual(stepNumbers(both), [1, 2, 3, 4, 5, 6, 7, 8])

  const required = implementPrompt(withReady(manifest, ['npm test'], []), pr, STATE)

  assert.equal(
    selfCheck(required),
    `${['7. **Self-check before READY:**', READY_RULES, '     - required: `npm test`', ...SELF_CHECKS].join('\n')}\n`,
  )

  assert.deepEqual(stepNumbers(required), [1, 2, 3, 4, 5, 6, 7, 8])

  const recommended = implementPrompt(withReady(manifest, [], ['npm run lint']), pr, STATE)

  assert.equal(
    selfCheck(recommended),
    `${['7. **Self-check before READY:**', READY_RULES, '     - recommended: `npm run lint`', ...SELF_CHECKS].join('\n')}\n`,
  )

  assert.deepEqual(stepNumbers(recommended), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(both.includes('## Commands the driver runs after READY'), false, 'the ready commands are not pre-verify commands')
  assertFilled({ both, required, recommended })
})

test('prompts: a fresh implementer gets the ready commands in its step 7, and a fix run goes back to step 7', () => {
  const manifest = withReady(loadManifest(makeRollout()), ['npm test'], ['npm run lint'])
  const pr = manifest.all[0]
  const resumed = resumeFreshPrompt(manifest, pr, STATE, { reason: 'session missing', note: 'n' })
  const fix = fixPrompt(manifest, pr, STATE, { reason: 'ready check', note: 'n', head: 'abc' })

  assert.ok(selfCheck(resumed).includes(`${READY_RULES}\n     - required: \`npm test\`\n     - recommended: \`npm run lint\`\n`))
  assert.ok(selfCheck(resumed).indexOf('required: `npm test`') < selfCheck(resumed).indexOf('`git status --porcelain` is empty'))
  assert.deepEqual(stepNumbers(resumed), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.ok(fix.includes('run the self-check (step 7)'))
  assertFilled({ resumed, fix })
})

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

const CRITERIA = [
  { id: 'V1', level: 'required', text: 'A new branch in the code has a test that fails without it.' },
  { id: 'V2', level: 'required', text: 'No semicolons in prose.' },
  { id: 'V3', level: 'recommended', text: 'Docs: every new option has its row.' },
]

test('prompts: the verifier gets the project criteria with their id and level, between the failed commands and the findings to re-check', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const preVerify = { sha: HEAD, at: '2026-09-01T10:00:00.000Z', results: [LINT_FAILED] }
  const text = verifyPrompt(manifest, pr, answered({ ...STATE, noteHistory: NOTE_HISTORY, preVerify, verifyCriteria: CRITERIA }), HEAD)
  const commands = text.indexOf('\n## Recommended commands that failed\n')
  const section = text.indexOf('\n## Project criteria\n')
  const findings = text.indexOf('## Findings to re-check')

  assert.ok(commands > -1)
  assert.ok(section > commands)
  assert.ok(findings > section)
  assert.equal(text.split('## Project criteria\n').length, 2)
  assert.ok(text.trimEnd().endsWith('Answer (disputed):\n\nThe error is logged at cli.mjs:42.'), 'the findings stay last')

  const block = [
    '## Project criteria',
    '',
    "The maintainer set these criteria for this PR, in the manifest or in the project's criteria catalog. Report each one in `criteria` by its id. A required one that does not pass blocks the PR. A recommended one never does.",
    '',
    '- V1 (required): A new branch in the code has a test that fails without it.',
    '- V2 (required): No semicolons in prose.',
    '- V3 (recommended): Docs: every new option has its row.',
    '',
    '',
    '## Findings to re-check',
  ]

  assert.ok(text.includes(block.join('\n')), text.slice(section))
  assert.ok(
    text.includes('`## Project criteria` lists them with their id, level and text, before the findings to re-check.'),
    'the inputs name it',
  )

  assert.equal(text.includes('{{'), false)

  const alone = verifyPrompt(manifest, pr, { ...STATE, verifyCriteria: CRITERIA.slice(2) }, HEAD)

  assert.ok(alone.trimEnd().endsWith('\n\n- V3 (recommended): Docs: every new option has its row.'), 'last without findings')
})

test('prompts: without project criteria the verifier gets no such section', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]

  manifest.gates.verify = { required: ['A new branch has a test.'], recommended: [] }

  for (const entry of [STATE, freshPr(), { ...STATE, verifyCriteria: [] }, { ...STATE, verifyCriteria: null }]) {
    const text = verifyPrompt(manifest, pr, entry, HEAD)

    assert.equal(text.includes('\n## Project criteria\n'), false, JSON.stringify(entry.verifyCriteria))
    assert.equal(text.includes('A new branch has a test.'), false, 'the prompt never reads the manifest')
    assert.equal(text.includes('{{'), false)
  }
})

test('prompts: the verifier reports each project criterion in criteria, never in blocking, and PASS needs every required one', () => {
  const manifest = loadManifest(makeRollout())
  const text = verifyPrompt(manifest, manifest.all[0], STATE, HEAD)
  const checklist = text.indexOf("\n3. Go through the brief's acceptance checklist")
  const criteria = text.indexOf('\n4. When the prompt lists project criteria, check each one against the whole PR at this SHA.')
  const recheck = text.indexOf('\n5. When the prompt ends with findings to re-check')

  assert.ok(checklist > -1)
  assert.ok(criteria > checklist)
  assert.ok(recheck > criteria)

  for (const part of [
    'Report each one in `criteria` by its id: `pass`, `fail` or `unverifiable`, with evidence (command output or file:line). Without project criteria, `criteria` is empty.',
    '\n   - A criterion the PR gives no occasion for passes, with the reason as evidence. For example: the PR adds no branch to the code.\n',
    '\n   - A criterion that does not pass goes only into `criteria`, never also into `blocking`. The driver adds the blocking finding itself.\n',
    '\n9. Verdict: PASS only when every checklist item passes, every required project criterion passes, no re-checked finding is `open` and there is no blocking finding.',
  ]) {
    assert.ok(text.includes(part), part)
  }
})

test('schemas/verdict.json: criteria is required, and each entry needs an id, a result of three values and evidence', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/verdict.json', import.meta.url), 'utf8'))
  const criteria = schema.properties.criteria

  assert.ok(schema.required.includes('criteria'))
  assert.equal(criteria.type, 'array')
  assert.deepEqual(criteria.items.required, ['id', 'result', 'evidence'])
  assert.deepEqual(criteria.items.properties.result.enum, ['pass', 'fail', 'unverifiable'])
  assert.match(criteria.description, /"Project criteria"/)
  assert.match(schema.properties.blocking.description, /A project criterion that does not pass goes into criteria only\./)
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
      'The driver ran the required commands at `a1a1a1a`. These failed:',
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

const READY_FAILED = commandRecord({
  stage: 'ready',
  result: 'fail',
  summary: 'exit 1',
  exitCode: 1,
  tail: 'not ok 3 - parses an empty list\n',
})

const READY_OUTPUT = '### `npm test`\n\nexit 1\n\n```\nnot ok 3 - parses an empty list\n```'

function readyReport(gates, headSha = HEAD) {
  return { status: 'READY', headSha, gates }
}

test('preVerifyNote: a failed ready command says what the READY report claimed for it at this head', () => {
  const ready = 'This is a ready command of your self-check (step 7).'
  const cases = [
    [
      readyReport([{ command: 'npm test', exitCode: 0, tail: '' }]),
      `${ready} Your READY report says it exited 0 at this head. The driver's run decides.`,
    ],
    [readyReport([{ command: ' npm test', exitCode: 2, tail: '' }]), `${ready} Your READY report says it exited 2 at this head.`],
    [readyReport([{ command: 'npm run lint', exitCode: 0, tail: '' }]), `${ready} Your READY report does not list it in \`gates\`.`],
    [readyReport([]), `${ready} Your READY report does not list it in \`gates\`.`],
    [{ status: 'READY', headSha: HEAD }, `${ready} Your READY report does not list it in \`gates\`.`],
    [readyReport([{ command: 'npm test', exitCode: 0, tail: '' }], 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'), ready],
    [undefined, ready],
  ]

  for (const [report, paragraph] of cases) {
    assert.equal(
      preVerifyNote(HEAD, [READY_FAILED], report),
      [
        'The driver ran the required commands at `a1a1a1a`. These failed:',
        READY_OUTPUT,
        paragraph,
        '- The driver runs every command again on the new head.\n- Never weaken, skip or delete tests or checks to get green.',
      ].join('\n\n'),
      JSON.stringify(report),
    )
  }
})

test('preVerifyNote: the claim follows the reset of a ready command, and a pre-verify command gets no claim', () => {
  const changed = { ...READY_FAILED, summary: 'exit 0, left tracked changes: M dist/index.js', exitCode: 0, changes: ['M dist/index.js'] }
  const report = readyReport([{ command: 'npm test', exitCode: 0, tail: '' }])

  assert.ok(
    preVerifyNote(HEAD, [changed], report).includes(
      "\n\nThe driver reset the worktree to that head.\n\nThis is a ready command of your self-check (step 7). Your READY report says it exited 0 at this head. The driver's run decides.\n\n",
    ),
  )

  const preVerify = preVerifyNote(HEAD, [{ ...READY_FAILED, stage: 'preVerify' }], report)
  const old = preVerifyNote(HEAD, [{ ...READY_FAILED, stage: undefined }], report)

  for (const text of [preVerify, old]) {
    assert.equal(text.includes('ready command'), false)
    assert.ok(text.includes(`${READY_OUTPUT}\n\n- The driver runs every command again on the new head.`))
  }
})

const STEP_2 =
  '2. Check that verification commands exist (package.json scripts at the root and in `examples/`, `scripts/`), or are marked "new in this PR".'

function briefManifest(brief) {
  return loadManifest(makeRollout({ manifest: { gates: { brief } } }))
}

function stepLine(text, number) {
  return text.split('\n').find((line) => line.startsWith(`${number}. `))
}

test('prompts: without runChecks step 2 of the brief review only checks that the commands exist', () => {
  const manifest = loadManifest(makeRollout())
  const pr = manifest.all[0]
  const checked = briefManifest({ runChecks: true })
  const texts = {
    default: briefReviewPrompt(manifest, pr, STATE, '# draft'),
    criteria: briefReviewPrompt(briefManifest({ required: ['Rule one.'] }), pr, STATE, '# draft'),
    launched: briefReviewPrompt(checked, pr, STATE, '# draft', [], briefGates({ runChecks: false, required: [], recommended: [] })),
  }

  for (const [name, text] of Object.entries(texts)) {
    assert.equal(stepLine(text, 2), STEP_2, name)
    assert.ok(text.includes(`${STEP_2}\n3. Check completeness`), name)
    assert.deepEqual(stepNumbers(text), [1, 2, 3, 4, 5, 6], name)
    assert.equal(text.includes('Then run every verification command'), false, name)
  }

  assertFilled(texts)
})

test('prompts: with runChecks step 2 of the brief review runs the existing commands, judges whether each can pass and reports them in checks', () => {
  const manifest = briefManifest({ runChecks: true })
  const pr = manifest.all[0]
  const text = briefReviewPrompt(manifest, pr, STATE, '# draft')
  const step = stepLine(text, 2)

  assert.ok(step.startsWith(`${STEP_2} Then run every verification command and every acceptance command of the draft`), step)
  assert.deepEqual(stepNumbers(text), [1, 2, 3, 4, 5, 6])

  for (const part of [
    'that exists in this worktree, one at a time, in the foreground.',
    'A command that a dependency merged into this worktree adds exists.',
    'Skip a command marked "new in this PR" and a command that rewrites tracked files, and leave the worktree as you found it.',
    "For each command you ran, decide whether it can pass after a change within the brief's expected files.",
    'One that fails here only because the PR is not written yet can still pass.',
    'When you cannot fix it, ask a question that quotes the command.',
    'Report in `checks` each command you ran as it stands in your final brief.',
  ]) {
    assert.ok(step.includes(part), part)
  }

  assert.ok(text.includes('the `checks` and `criteria` results (each empty when this prompt asks for none), and notes on what you changed'))

  assert.equal(text.includes('## Project criteria'), false)
  assert.equal(briefWritePrompt(manifest, pr, STATE).includes('Then run every verification command'), false, 'the writer runs nothing')
  assertFilled({ text })
})

test('prompts: with criteria the brief reviewer gets a Project criteria section before the sources, and the writer a rule that lists them', () => {
  const manifest = briefManifest({ required: ['Rule one.', 'Rule two.'], recommended: ['Rule three.'] })
  const pr = manifest.all[0]
  const review = briefReviewPrompt(manifest, pr, STATE, '# draft')
  const write = briefWritePrompt(manifest, pr, STATE)
  const section = review.indexOf('\n## Project criteria\n')

  assert.ok(section > review.indexOf('Return the corrected, complete brief'), 'after the return paragraph')
  assert.ok(section < review.indexOf('\n## Sources\n'), 'before the sources')
  assert.ok(
    review.includes('## Project criteria\n\nCheck the draft against each criterion and fix the brief until every required one passes.'),
  )

  for (const part of [
    'A criterion that does not apply to this PR passes, and the evidence says why.',
    'An answer from the maintainer that settles a criterion is evidence for it.',
    'Report each one in `criteria` with its id, `pass`, `fail` or `unverifiable`, and the evidence.',
    'When a required one cannot pass, ask a question that names its id.',
    'The driver asks the maintainer about every required criterion that does not pass, and adds every recommended one that does not pass to the review notes.',
    '\n\n- B1 (required): Rule one.\n- B2 (required): Rule two.\n- B3 (recommended): Rule three.\n\n## Sources',
  ]) {
    assert.ok(review.indexOf(part) > section, part)
  }

  assert.ok(
    write.includes(
      'with a command or a file:line.\n- **Project criteria.** The reviewer checks the brief against these. A required one that does not pass becomes a question to the maintainer.\n  - B1 (required): Rule one.\n  - B2 (required): Rule two.\n  - B3 (recommended): Rule three.\n- If a real product decision is missing',
    ),
  )

  assertFilled({ review, write })
})

test('prompts: without criteria neither brief prompt lists any', () => {
  const pr = loadManifest(makeRollout()).all[0]
  const texts = {}

  for (const [name, manifest] of Object.entries({ default: loadManifest(makeRollout()), checks: briefManifest({ runChecks: true }) })) {
    texts[`${name} review`] = briefReviewPrompt(manifest, pr, STATE, '# draft')
    texts[`${name} write`] = briefWritePrompt(manifest, pr, STATE)
  }

  const launched = briefManifest({ required: ['Rule one.'] })

  texts['launched review'] = briefReviewPrompt(launched, pr, STATE, '# draft', [], briefGates())
  texts['launched write'] = briefWritePrompt(launched, pr, STATE, [], briefGates())

  for (const [name, text] of Object.entries(texts)) {
    assert.equal(text.includes('Project criteria'), false, name)
    assert.equal(text.includes('(required): '), false, name)
  }

  assert.ok(texts['default review'].includes('what is still uncertain.\n\n\n\n## Sources'))
  assertFilled(texts)
})

test('briefReviewNotes: the notes alone, or with the recommended criteria that did not pass after a blank line', () => {
  const failed = [
    { id: 'B3', level: 'recommended', text: 'Rule three.', result: 'unverifiable', evidence: 'No style guide.' },
    { id: 'B4', level: 'recommended', text: 'Rule four.', result: 'fail', evidence: 'not reported by the reviewer' },
  ]

  const section = [
    '## Recommended brief criteria that did not pass',
    '',
    '- B3 (unverifiable): Rule three. Evidence: No style guide.',
    '- B4 (fail): Rule four. Evidence: not reported by the reviewer',
  ].join('\n')

  assert.equal(briefReviewNotes('  Checked every path.\n', []), 'Checked every path.')
  assert.equal(briefReviewNotes('', []), '')
  assert.equal(briefReviewNotes('Checked every path.\n', failed), `Checked every path.\n\n${section}`)
  assert.equal(briefReviewNotes(' \n', failed), section)
})

test('schemas/brief.json: every report has checks and criteria, with every field of their items required', () => {
  const schema = JSON.parse(readFileSync(new URL('../schemas/brief.json', import.meta.url), 'utf8'))
  const { checks, criteria } = schema.properties

  function types(items) {
    return Object.fromEntries(Object.entries(items.properties).map(([key, value]) => [key, value.type]))
  }

  assert.deepEqual(schema.required, ['brief', 'expectedFiles', 'changesetBump', 'questions', 'notes', 'checks', 'criteria'])
  assert.equal(checks.type, 'array')
  assert.deepEqual(types(checks.items), { command: 'string', exitCode: 'integer', canPass: 'boolean', evidence: 'string' })
  assert.deepEqual(checks.items.required, ['command', 'exitCode', 'canPass', 'evidence'])
  assert.equal(criteria.type, 'array')
  assert.deepEqual(types(criteria.items), { id: 'string', result: 'string', evidence: 'string' })
  assert.deepEqual(criteria.items.properties.result.enum, ['pass', 'fail', 'unverifiable'])
  assert.deepEqual(criteria.items.required, ['id', 'result', 'evidence'])
})
