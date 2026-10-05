import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalChannel,
  approveRefusal,
  codeScanningFindings,
  currentGate,
  highestBump,
  judge,
  outOfScope,
  policyViolations,
} from '../lib/judge.mjs'

const M = {
  label: 'rollout:demo',
  policy: { merge: 'human', maxBump: 'minor' },
  repo: {
    base: 'main',
    forbid: ['**/CHANGELOG.md', '.github/workflows/release.yml'],
    alwaysInScope: ['.changeset/*.md'],
    denylist: ['acme corp', '/Users/'],
    neverMerge: { branches: ['changeset-release/*'], titles: ['chore: version packages'] },
    codeScanning: { action: 'fix', minSeverity: 'medium' },
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

test('a PR merged on GitHub waits for sync whatever else is off, and a closed one still blocks', () => {
  const merged = { ...facts().pr, state: 'MERGED' }
  const changes = [
    {},
    { isDraft: true },
    { baseRefName: 'develop' },
    { headRefName: 'other' },
    { labels: [] },
    { title: 'chore: version packages' },
  ]

  for (const change of changes) {
    const verdict = judge(M, pr, verifiedAndApproved, facts({ pr: { ...merged, ...change } }))

    assert.equal(verdict.action, 'wait', JSON.stringify(change))
    assert.deepEqual(verdict.reasons, ['merged on GitHub (the next sync records it)'])
    assert.doesNotMatch(verdict.reasons.join(), /awaiting|approve PR|GitHub still blocks/)
  }

  const closed = judge(M, pr, verifiedAndApproved, facts({ pr: { ...facts().pr, state: 'CLOSED' } }))

  assert.equal(closed.action, 'block')
  assert.deepEqual(closed.reasons, ['PR is CLOSED'])
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

test('a held PR waits: no merge, no rebase, no ready notice in manual mode', () => {
  const held = { ...verifiedAndApproved, held: { at: '2026-09-27T09:00:00Z' } }
  const verdict = judge(M, pr, held, facts())

  assert.equal(verdict.action, 'wait')
  assert.match(verdict.reasons.join(), /held/)
  assert.doesNotMatch(verdict.reasons.join(), /awaiting|approve PR|GitHub still blocks/)
  assert.equal(judge(M, pr, held, facts({ baseIsAncestor: false })).action, 'wait')
  assert.equal(judge({ ...M, policy: { ...M.policy, merge: 'manual' } }, pr, held, facts()).action, 'wait')
  assert.equal(judge(M, pr, { ...held, held: null }, facts()).action, 'merge')
})

const withMerge = (manifest, merge) => ({ ...manifest, policy: { ...manifest.policy, merge } })

test('approvalChannel: inbox or GitHub under human, none under manual and auto', () => {
  assert.equal(approvalChannel(M, 'bot'), 'inbox')
  assert.equal(approvalChannel(GM, 'bot'), 'github')
  assert.equal(approvalChannel(GM, 'maint'), 'inbox')
  assert.equal(approvalChannel(GM, undefined), 'github')

  for (const merge of ['manual', 'auto']) {
    assert.equal(approvalChannel(withMerge(M, merge), 'bot'), null, merge)
    assert.equal(approvalChannel(withMerge(GM, merge), 'bot'), null, merge)
  }
})

test('approveRefusal: manual and auto refuse, and so does a PR approved on GitHub', () => {
  assert.equal(
    approveRefusal(withMerge(M, 'manual'), { pr: 7, author: 'bot' }),
    'policy.merge is manual: no approval is needed. Merge the PR on GitHub once the driver says it is ready',
  )
  assert.equal(
    approveRefusal(withMerge(GM, 'auto'), { pr: 7, author: 'maint' }),
    'policy.merge is auto: no approval is needed. The driver merges once the gate passes, and rollout hold stops it',
  )
  assert.equal(approveRefusal(GM, { pr: 7, author: 'bot' }), 'PR #7 is approved on GitHub: review it there')
  assert.equal(approveRefusal(GM, { pr: 7, author: 'maint' }), null)
  assert.equal(approveRefusal(GM, { pr: 7 }), null)
  assert.equal(approveRefusal(M, { pr: 7, author: 'bot' }), null)
})

test('a record of a GitHub approval never passes for rollout approve', () => {
  const verdict = judge(M, pr, { ...onVerified, approved: { patchId: PATCH, channel: 'github' } }, facts())

  assert.equal(verdict.action, 'wait')
  assert.match(verdict.reasons.join(), /rollout approve/)
  assert.equal(judge(M, pr, { ...onVerified, approved: { patchId: PATCH, channel: 'inbox' } }, facts()).action, 'merge')
})

const withScanning = (codeScanning) => ({ ...M, repo: { ...M.repo, codeScanning: { ...M.repo.codeScanning, ...codeScanning } } })

function alert(overrides = {}) {
  return {
    number: 4,
    rule: 'js/shell-command-injection-from-environment',
    securitySeverity: 'medium',
    severity: 'warning',
    tool: 'CodeQL',
    path: 'bin/rollout.mjs',
    line: 357,
    message: 'This shell command depends on an uncontrolled absolute path.',
    url: 'https://github.com/example/demo/security/code-scanning/4',
    sha: 'abc1234def',
    ...overrides,
  }
}

function scanned(alerts, baseOpen = [], overrides = {}) {
  return facts({ codeScanning: { available: true, alerts, baseOpen }, ...overrides })
}

const ALERT_REASON =
  'CodeQL js/shell-command-injection-from-environment (medium) bin/rollout.mjs:357: This shell command depends on an uncontrolled absolute path. https://github.com/example/demo/security/code-scanning/4'
const NONE = { action: 'none', reasons: [] }

test('codeScanningFindings: a new security alert at the threshold sends the PR back', () => {
  assert.deepEqual(codeScanningFindings(M, scanned([alert()])), { action: 'fix', reasons: [ALERT_REASON] })
})

test('codeScanningFindings: an alert also open on the base is not new', () => {
  assert.deepEqual(codeScanningFindings(M, scanned([alert()], [4])), NONE)
  assert.deepEqual(codeScanningFindings(M, scanned([alert()], [3])), { action: 'fix', reasons: [ALERT_REASON] })
})

test('codeScanningFindings: alerts below the threshold do not count', () => {
  const low = alert({ securitySeverity: 'low', severity: 'error' })
  const warning = alert({ securitySeverity: null, severity: 'warning' })

  assert.deepEqual(codeScanningFindings(M, scanned([low, warning])), NONE)
  assert.equal(codeScanningFindings(withScanning({ minSeverity: 'low' }), scanned([low, warning])).action, 'fix')
})

test('codeScanningFindings: without a security level, error ranks as medium and note never counts', () => {
  const error = alert({ securitySeverity: null, severity: 'error', path: null, line: null })
  const note = alert({ securitySeverity: null, severity: 'note' })

  assert.deepEqual(codeScanningFindings(M, scanned([error])), {
    action: 'fix',
    reasons: [
      'CodeQL js/shell-command-injection-from-environment (medium) ?:?: This shell command depends on an uncontrolled absolute path. https://github.com/example/demo/security/code-scanning/4',
    ],
  })
  assert.deepEqual(codeScanningFindings(withScanning({ minSeverity: 'high' }), scanned([error])), NONE)

  for (const severity of ['note', 'none', null]) {
    assert.deepEqual(codeScanningFindings(withScanning({ minSeverity: 'low' }), scanned([{ ...note, severity }])), NONE, severity)
  }
})

test('codeScanningFindings: an alert from an older commit waits for the analysis of the head', () => {
  const stale = alert({ sha: 'def5678abc' })
  const unknown = alert({ number: 5, sha: null })
  const verdict = codeScanningFindings(M, scanned([stale, unknown, alert({ number: 6 })]))

  assert.deepEqual(verdict, {
    action: 'wait',
    reasons: [
      'code scanning has not analysed abc1234 yet (alert #4 is from def5678)',
      'code scanning has not analysed abc1234 yet (alert #5 is from unknown)',
    ],
  })
  assert.doesNotMatch(verdict.reasons.join(), /awaiting|approve/)
})

test('codeScanningFindings: no code scanning, or none available, finds nothing', () => {
  assert.deepEqual(codeScanningFindings(M, facts()), NONE)
  assert.deepEqual(codeScanningFindings(M, facts({ codeScanning: null })), NONE)
  assert.deepEqual(
    codeScanningFindings(
      M,
      facts({ codeScanning: { available: false, reason: 'no analysis found (HTTP 404)', alerts: [alert()], baseOpen: [] } }),
    ),
    NONE,
  )
})

test('codeScanningFindings: block blocks, and ignore never reads the facts', () => {
  assert.deepEqual(codeScanningFindings(withScanning({ action: 'block' }), scanned([alert()])), {
    action: 'block',
    reasons: [ALERT_REASON],
  })

  const unread = facts()
  Object.defineProperty(unread, 'codeScanning', {
    get() {
      throw new Error('ignore read the code scanning facts')
    },
  })

  assert.deepEqual(codeScanningFindings(withScanning({ action: 'ignore' }), scanned([alert()])), NONE)
  assert.deepEqual(codeScanningFindings(withScanning({ action: 'ignore' }), unread), NONE)
})

test('judge: code scanning comes after red and pending CI, and before the base and the merge', () => {
  const red = { state: 'red', missing: [], pending: [], failing: ['smoke: failure'] }
  const pending = { state: 'pending', missing: [], pending: ['test'], failing: [] }
  const redBase = { state: 'red', missing: [], pending: [], failing: ['check'] }
  const flagged = { action: 'fix', reasons: [ALERT_REASON], kind: 'code-scanning' }

  assert.deepEqual(judge(M, pr, verifiedAndApproved, scanned([alert()], [], { checks: red })), {
    action: 'fix',
    reasons: ['smoke: failure', 'CI is red on the PR head'],
  })
  assert.deepEqual(judge(M, pr, verifiedAndApproved, scanned([alert()], [], { checks: pending })), {
    action: 'wait',
    reasons: ['CI pending (missing: -; running: test)'],
  })
  assert.deepEqual(judge(M, pr, verifiedAndApproved, scanned([alert()])), flagged)
  assert.deepEqual(judge(M, pr, verifiedAndApproved, scanned([alert()], [], { mainChecks: redBase })), flagged)
  assert.deepEqual(judge(withScanning({ action: 'block' }), pr, verifiedAndApproved, scanned([alert()])), { ...flagged, action: 'block' })
  assert.equal(judge(M, pr, verifiedAndApproved, scanned([alert()], [4])).action, 'merge')
})

test('currentGate: the verdict counts only while the PR is verified and the gate ran since', () => {
  const gate = { action: 'ready', reasons: ['ready'], at: '2026-01-01T10:05:00.000Z' }
  const entry = { state: 'verified', verified: { at: '2026-01-01T10:00:00.000Z' }, gate }

  assert.equal(currentGate(entry), gate)
  assert.deepEqual(currentGate({ ...entry, gate: { ...gate, at: entry.verified.at } }), { ...gate, at: entry.verified.at })
  assert.equal(currentGate({ ...entry, verified: { at: '2026-01-01T11:00:00.000Z' } }), null)
  assert.equal(currentGate({ ...entry, state: 'needs_fix' }), null)
  assert.equal(currentGate({ ...entry, gate: null }), null)
})
