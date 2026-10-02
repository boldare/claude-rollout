import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { freshPr } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import {
  briefReviewPrompt,
  briefWritePrompt,
  codeScanningNote,
  delegatePrompt,
  implementPrompt,
  verifyPrompt,
  verifyRecipe,
} from '../lib/prompts.mjs'
import { makeRollout } from './fixtures.mjs'

const STATE = { ...freshPr(), pr: 12, ready: { status: 'READY' } }

function render({ public: isPublic, denylist }) {
  const M = loadManifest(makeRollout())
  const pr = M.all[0]

  M.repo.public = isPublic
  M.repo.denylist = denylist

  return {
    implement: implementPrompt(M, pr, STATE),
    briefWrite: briefWritePrompt(M, pr, STATE),
    briefReview: briefReviewPrompt(M, pr, STATE, '# draft'),
    verify: verifyPrompt(M, pr, STATE, 'a1a1a1a'),
    delegate: delegatePrompt(M, pr, { ...STATE, blocked: { kind: 'needs-decision', question: 'Q', evidence: 'E' } }),
  }
}

function assertFilled(prompts) {
  for (const [name, text] of Object.entries(prompts)) {
    assert.equal(text.includes('{{'), false, name)
  }
}

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
  assertFilled(prompts)
})

test('prompts: the brief writer sees every earlier answer, oldest first, under one heading', () => {
  const M = loadManifest(makeRollout())
  const pr = M.all[0]
  const briefAnswers = [
    { question: 'Which default for the delay?', answer: '120 seconds.' },
    { question: 'Keep the old flag?', answer: 'Yes, as an alias.' },
    { question: null, answer: 'The plan moved to a new file.' },
  ]
  const text = briefWritePrompt(M, pr, { ...STATE, briefAnswers })
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
    [...order].sort((a, b) => a - b),
  )
  assert.ok(text.includes('A note from the maintainer:\n\nThe plan moved to a new file.'))

  const fresh = briefWritePrompt(M, pr, freshPr())

  assert.equal(fresh.includes('## Answers from the maintainer'), false)
  assert.equal(fresh.includes('{{'), false)
})

function stepNumbers(text) {
  return [...text.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]))
}

test('prompts: every step starts its own line and the recipe sits indented under its step', () => {
  const M = loadManifest(makeRollout())
  const pr = M.all[0]

  M.repo.verify = { common: ['npm ci', 'npm test', 'npm run format:check'] }

  const implement = implementPrompt(M, pr, STATE)
  const verify = verifyPrompt(M, pr, STATE, 'a1a1a1a')

  assert.deepEqual(stepNumbers(implement), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.deepEqual(stepNumbers(verify), [1, 2, 3, 4, 5, 6, 7])
  assert.ok(implement.includes('\n   1. `npm ci`\n   2. `npm test`\n'))
  assert.ok(verify.includes('\n   1. `npm ci`\n   2. `npm test`\n'))
  assert.ok(briefWritePrompt(M, pr, STATE).includes('\n  1. `npm ci`\n  2. `npm test`\n'))
})

test('prompts: the brief writer assumes no plan language', () => {
  const M = loadManifest(makeRollout())
  const text = briefWritePrompt(M, M.all[0], STATE)

  assert.doesNotMatch(text, /Decyzje/)
  assert.doesNotMatch(text, /Polish/)
  assert.ok(text.includes('always in English'))
})

test('prompts: the verifier skips steps that rewrite files for npm, pnpm, yarn and bun', () => {
  const M = loadManifest(makeRollout())
  const pr = M.all[0]
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

  M.repo.verify = { common: [...kept, ...dropped] }

  assert.deepEqual(verifyRecipe(M, pr, { forVerifier: true }), kept)
  assert.deepEqual(verifyRecipe(M, pr), [...kept, ...dropped])
})

test('prompts: the changeset rules follow policy.maxBump', () => {
  const M = loadManifest(makeRollout())
  const pr = M.all[0]

  pr.changeset = 'major'
  M.policy.maxBump = 'major'

  assert.doesNotMatch(implementPrompt(M, pr, STATE), /never major/i)
  assert.doesNotMatch(briefWritePrompt(M, pr, STATE), /never major/i)

  pr.changeset = 'patch'
  M.policy.maxBump = 'patch'

  assert.ok(implementPrompt(M, pr, STATE).includes('Never above patch.'))
  assert.ok(briefWritePrompt(M, pr, STATE).includes('never above `patch`'))
})

test('prompts: the delegate sees the question, the plan, the brief and every earlier answer', () => {
  const dir = makeRollout()

  writeFileSync(join(dir, 'plan.md'), '# Plan\n\nThe old flag stays as an alias until 2.0.\n')
  mkdirSync(join(dir, 'briefs'))
  writeFileSync(join(dir, 'briefs', 'A1.md'), '# A1\n\nRename the flag.\n')

  const M = loadManifest(dir)
  const pr = M.all[0]
  const noteHistory = [
    { at: '2026-09-01T10:00:00.000Z', by: 'maintainer', kind: 'needs-decision', question: 'Which name?', text: 'Call it --delay.' },
  ]
  const blocked = { kind: 'needs-decision', question: 'Keep the old flag?', evidence: 'cli.mjs:12 reads --wait.' }

  M.repo.denylist = ['acme-client', 'example corp']

  const text = delegatePrompt(M, pr, { ...STATE, blocked, noteHistory })

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
  assert.ok(delegatePrompt(M, M.all[2], { ...freshPr(), blocked }).includes('No brief has been written yet.'))
  assert.ok(delegatePrompt(M, pr, { ...freshPr(), blocked }).includes('## Earlier answers\n\nOldest first.\n\n(none)\n'))
})

test('codeScanningNote: a false positive goes to the maintainer as a code-scanning block', () => {
  const M = loadManifest(makeRollout())
  const note = codeScanningNote(M, ['#4 js/shell-command-injection-from-environment at bin/rollout.mjs:357'])

  for (const part of [
    '- #4 js/shell-command-injection-from-environment at bin/rollout.mjs:357',
    'Never silence the analyser',
    '`gh api repos/example/demo/code-scanning/alerts/<number>`',
    'report BLOCKED with kind `code-scanning`',
  ]) {
    assert.ok(note.includes(part), part)
  }

  assert.equal(note.includes('needs-decision'), false)
})
