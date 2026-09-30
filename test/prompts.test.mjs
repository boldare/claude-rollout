import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshPr } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { briefReviewPrompt, briefWritePrompt, implementPrompt, verifyPrompt } from '../lib/prompts.mjs'
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
