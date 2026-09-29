import { test } from 'node:test'
import assert from 'node:assert/strict'
import { highestBump, judge, outOfScope, policyViolations } from '../lib/judge.mjs'

const M = {
  label: 'rollout:demo',
  policy: { merge: 'human', maxBump: 'minor' },
  repo: {
    base: 'main',
    forbid: ['**/CHANGELOG.md', '.github/workflows/release.yml'],
    alwaysInScope: ['.changeset/*.md'],
    denylist: ['acme corp', '/Users/'],
    neverMerge: { branches: ['changeset-release/*'], titles: ['chore: version packages'] },
  },
}

const pr = { id: 'A1', branch: 'fix/thing', scope: ['packages/core/src/**'] }
const PATCH = 'p1'

function facts(overrides = {}) {
  return {
    halted: null,
    pr: {
      number: 7,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      headRefName: 'fix/thing',
      headRefOid: 'abc1234def',
      labels: ['rollout:demo'],
      title: 'fix: thing',
      body: 'Summary',
      mergeable: 'MERGEABLE',
    },
    depsPending: [],
    files: [
      { status: 'modified', path: 'packages/core/src/recorder.ts' },
      { status: 'added', path: '.changeset/quiet-owls.md' },
    ],
    addedLines: [{ path: 'packages/core/src/recorder.ts', text: 'const a = 1' }],
    commits: [{ sha: 'abc1234def', message: 'fix: thing' }],
    changesets: [{ path: '.changeset/quiet-owls.md', text: '---\n"@demo/core": minor\n---\n\nThing.\n' }],
    patchId: PATCH,
    baseIsAncestor: true,
    checks: { state: 'green', missing: [], pending: [], failing: [] },
    mainChecks: { state: 'green', missing: [], pending: [], failing: [] },
    ...overrides,
  }
}

const verifiedAndApproved = { verified: { sha: 'abc1234def', patchId: PATCH }, approved: { patchId: PATCH } }

test('merges when everything holds', () => {
  assert.equal(judge(M, pr, verifiedAndApproved, facts()).action, 'merge')
})

test('waits for approval bound to the current patch', () => {
  const stale = { verified: { patchId: PATCH }, approved: { patchId: 'older' } }
  const verdict = judge(M, pr, stale, facts())
  assert.equal(verdict.action, 'wait')
  assert.match(verdict.reasons.join(), /approval/)
})

test('merges without approval when policy is auto', () => {
  const auto = { ...M, policy: { ...M.policy, merge: 'auto' } }
  assert.equal(judge(auto, pr, { verified: { patchId: PATCH } }, facts()).action, 'merge')
})

test('never merges the release PR', () => {
  const release = facts({ pr: { ...facts().pr, headRefName: 'changeset-release/main', title: 'chore: version packages' } })
  assert.equal(judge(M, { ...pr, branch: 'changeset-release/main' }, verifiedAndApproved, release).action, 'block')
})

test('waits when verification belongs to another patch', () => {
  const verdict = judge(M, pr, { verified: { patchId: 'other' }, approved: { patchId: PATCH } }, facts())
  assert.equal(verdict.action, 'wait')
  assert.match(verdict.reasons.join(), /not verified/)
})

test('rebases when the branch is behind the base', () => {
  assert.equal(judge(M, pr, verifiedAndApproved, facts({ baseIsAncestor: false })).action, 'rebase')
})

test('rebases on conflicts', () => {
  const conflicting = facts({ pr: { ...facts().pr, mergeable: 'CONFLICTING' } })
  assert.equal(judge(M, pr, verifiedAndApproved, conflicting).action, 'rebase')
})

test('waits while mergeability is computed', () => {
  const unknown = facts({ pr: { ...facts().pr, mergeable: 'UNKNOWN' } })
  assert.equal(judge(M, pr, verifiedAndApproved, unknown).action, 'wait')
})

test('sends red CI back to the implementer', () => {
  const red = facts({ checks: { state: 'red', missing: [], pending: [], failing: ['smoke: failure'] } })
  const verdict = judge(M, pr, verifiedAndApproved, red)
  assert.equal(verdict.action, 'fix')
  assert.match(verdict.reasons.join(), /smoke: failure/)
})

test('waits for missing required checks', () => {
  const missing = facts({ checks: { state: 'pending', missing: ['smoke*'], pending: [], failing: [] } })
  assert.equal(judge(M, pr, verifiedAndApproved, missing).action, 'wait')
})

test('does not merge onto a red base branch', () => {
  const verdict = judge(M, pr, verifiedAndApproved, facts({ mainChecks: { state: 'red', missing: [], pending: [], failing: ['check'] } }))
  assert.equal(verdict.action, 'wait')
})

test('a halted rollout waits instead of blocking verified PRs', () => {
  assert.equal(judge(M, pr, verifiedAndApproved, facts({ halted: 'main red' })).action, 'wait')
})

test('changeset parsing follows @changesets/parse: comments, CRLF, flow style; unknown means violation', () => {
  assert.equal(highestBump('---\n"@demo/core": major # breaking\n---\n'), 'major')
  assert.equal(highestBump('---\r\n"@demo/core": minor\r\n---\r\n'), 'minor')
  assert.equal(highestBump('\n---\n{ "@demo/core": major }\n---\n'), 'major')
  assert.equal(highestBump('---\n"@demo/core": huge\n---\n'), null)
  const odd = facts({ changesets: [{ path: '.changeset/odd.md', text: 'no frontmatter' }] })
  assert.match(policyViolations(M, pr, odd).join(), /cannot determine the bump/)
})

test('the denylist covers file paths', () => {
  const named = facts({ files: [...facts().files, { status: 'added', path: 'examples/acme corp/Form.tsx' }] })
  assert.match(policyViolations(M, pr, named).join(), /file path/)
})

test('workflow files need allowWorkflows', () => {
  const ci = facts({ files: [...facts().files, { status: 'modified', path: '.github/workflows/ci.yml' }] })
  assert.match(policyViolations(M, pr, ci).join(), /allowWorkflows/)
  assert.deepEqual(policyViolations(M, { ...pr, allowWorkflows: true }, ci), [])
})

test('dependencies must be merged first', () => {
  assert.equal(judge(M, pr, verifiedAndApproved, facts({ depsPending: ['A6'] })).action, 'wait')
})

test('draft, wrong base, wrong branch and missing label block', () => {
  for (const change of [{ isDraft: true }, { baseRefName: 'develop' }, { headRefName: 'other' }, { labels: [] }]) {
    const verdict = judge(M, pr, verifiedAndApproved, facts({ pr: { ...facts().pr, ...change } }))
    assert.equal(verdict.action, 'block', JSON.stringify(change))
  }
})

test('policy: forbidden paths, versions, changesets, denylist, multi-line commits', () => {
  const bad = facts({
    files: [
      { status: 'modified', path: 'packages/core/CHANGELOG.md' },
      { status: 'removed', path: '.changeset/old.md' },
      { status: 'modified', path: 'packages/core/package.json' },
    ],
    addedLines: [
      { path: 'packages/core/package.json', text: '  "version": "1.0.0",' },
      { path: 'README.md', text: 'Tested on the ACME Corp app' },
    ],
    commits: [{ sha: 'abc1234def', message: 'fix: thing\n\nCo-Authored-By: someone' }],
    changesets: [{ path: '.changeset/big.md', text: '---\n"@demo/core": major\n---\n' }],
  })
  const violations = policyViolations(M, pr, bad).join('\n')

  assert.match(violations, /forbidden path packages\/core\/CHANGELOG\.md/)
  assert.match(violations, /package version/)
  assert.match(violations, /removes an existing changeset/)
  assert.match(violations, /no new changeset/)
  assert.match(violations, /major bump/)
  assert.match(violations, /denylisted term in README\.md/)
  assert.match(violations, /more than one line/)
  assert.equal(judge(M, pr, verifiedAndApproved, bad).action, 'fix')
})

test('policy: the denylist also covers the PR body', () => {
  const leaky = facts({ pr: { ...facts().pr, body: 'see /Users/someone/project' } })
  assert.match(policyViolations(M, pr, leaky).join(), /PR body/)
})

test('a clean PR has no violations', () => {
  assert.deepEqual(policyViolations(M, pr, facts()), [])
})

test('changeset bump parsing', () => {
  assert.equal(highestBump('---\n"a": patch\n\'b\': minor\n---\n'), 'minor')
  assert.equal(highestBump('---\n"a": major\n---\n'), 'major')
  assert.equal(highestBump('no frontmatter'), null)
  assert.equal(highestBump('---\n---\n'), null)
})

test('out-of-scope files are reported, changesets are always allowed', () => {
  const extra = facts({ files: [...facts().files, { status: 'modified', path: 'README.md' }] })
  assert.deepEqual(outOfScope(M, pr, extra), ['README.md'])
})

const GM = { ...M, policy: { ...M.policy, approval: 'github' }, repo: { ...M.repo, maintainers: ['maint'] } }
const botFacts = (reviews, overrides = {}) => facts({ pr: { ...facts().pr, author: 'bot' }, reviews, ...overrides })
const onVerified = { verified: { sha: 'abc1234def', patchId: PATCH, at: '2026-09-27T09:00:00Z' }, patchSince: '2026-09-27T09:00:00Z' }

test('github approval: a maintainer review given after the patch appeared merges', () => {
  const reviews = [{ user: 'maint', state: 'APPROVED', commit: 'rebased999', at: '2026-09-27T10:00:00Z' }]
  assert.equal(judge(GM, pr, onVerified, botFacts(reviews)).action, 'merge')
})

test('github approval: none, stale, non-maintainer or changes requested waits', () => {
  const cases = [
    [],
    [{ user: 'maint', state: 'APPROVED', commit: 'abc1234def', at: '2026-09-27T08:00:00Z' }],
    [{ user: 'someone', state: 'APPROVED', commit: 'abc1234def', at: '2026-09-27T10:00:00Z' }],
    [
      { user: 'maint', state: 'APPROVED', commit: 'abc1234def', at: '2026-09-27T10:00:00Z' },
      { user: 'maint', state: 'CHANGES_REQUESTED', commit: 'abc1234def', at: '2026-09-27T11:00:00Z' },
    ],
  ]

  for (const reviews of cases) {
    assert.equal(judge(GM, pr, onVerified, botFacts(reviews)).action, 'wait', JSON.stringify(reviews))
  }
})

test('github approval: an inbox approval does not replace a GitHub review for agent PRs', () => {
  assert.equal(judge(GM, pr, { ...onVerified, approved: { patchId: PATCH } }, botFacts([])).action, 'wait')
})

test('github approval: maintainer-authored PRs fall back to rollout approve', () => {
  const own = facts({ pr: { ...facts().pr, author: 'maint' }, reviews: [] })
  assert.equal(judge(GM, pr, { ...onVerified, approved: { patchId: PATCH } }, own).action, 'merge')
  assert.equal(judge(GM, pr, onVerified, own).action, 'wait')
})

test('without a bypass, a merge waits while GitHub reports BLOCKED', () => {
  const reviews = [{ user: 'maint', state: 'APPROVED', commit: 'abc1234def', at: '2026-09-27T10:00:00Z' }]
  const blockedByGitHub = botFacts(reviews, { pr: { ...facts().pr, author: 'bot', mergeStateStatus: 'BLOCKED' } })
  const verdict = judge({ ...GM, repo: { ...GM.repo, merge: { admin: 'auto' } } }, pr, onVerified, blockedByGitHub)
  assert.equal(verdict.action, 'wait')
  assert.match(verdict.reasons.join(), /GitHub still blocks/)
})

test('with a bypass (maintainer-authored PR), BLOCKED is expected and merges', () => {
  const own = facts({ pr: { ...facts().pr, author: 'maint', mergeStateStatus: 'BLOCKED' }, reviews: [] })
  const verdict = judge({ ...GM, repo: { ...GM.repo, merge: { admin: 'auto' } } }, pr, { ...onVerified, approved: { patchId: PATCH } }, own)
  assert.equal(verdict.action, 'merge')
})

test('manual mode: the gate says merge without any approval; the maintainer merges', () => {
  const MM = { ...GM, policy: { ...GM.policy, merge: 'manual' } }
  const blocked = botFacts([], { pr: { ...facts().pr, author: 'bot', mergeStateStatus: 'BLOCKED' } })
  assert.equal(judge(MM, pr, onVerified, blocked).action, 'merge')
  assert.equal(
    judge(MM, pr, onVerified, facts({ checks: { state: 'pending', missing: [], pending: ['CodeQL'], failing: [] } })).action,
    'wait',
  )
})

test('a PR in a repo without changesets needs none', () => {
  const plain = facts({ files: [{ status: 'modified', path: 'packages/core/src/recorder.ts' }], changesets: [] })
  assert.deepEqual(policyViolations(M, { ...pr, changeset: 'none' }, plain), [])
  assert.match(policyViolations(M, pr, plain).join(), /no new changeset/)
})
