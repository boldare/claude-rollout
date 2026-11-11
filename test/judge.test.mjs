import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalChannel,
  approveRefusal,
  codeScanningFindings,
  currentGate,
  GATE_CODES,
  githubApproval,
  highestBump,
  judge,
  outOfScope,
  policyViolations,
  undeclaredOutOfScope,
} from '../lib/judge.mjs'

const manifest = {
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

function assertVerdict(verdict, action, code, message) {
  assert.equal(verdict.action, action, message)
  assert.equal(verdict.code, code, message)
}

test('merges when everything holds', () => {
  assertVerdict(judge(manifest, pr, verifiedAndApproved, facts()), 'merge', 'merge')
})

test('waits for approval bound to the current patch', () => {
  const stale = { verified: { patchId: PATCH }, approved: { patchId: 'older' } }
  const verdict = judge(manifest, pr, stale, facts())
  assertVerdict(verdict, 'wait', 'awaiting-inbox-approval')
  assert.match(verdict.reasons.join(), /approval/)
})

test('merges without approval when policy is auto', () => {
  const auto = { ...manifest, policy: { ...manifest.policy, merge: 'auto' } }
  assertVerdict(judge(auto, pr, { verified: { patchId: PATCH } }, facts()), 'merge', 'merge')
})

test('never merges the release PR', () => {
  const release = facts({ pr: { ...facts().pr, headRefName: 'changeset-release/main', title: 'chore: version packages' } })
  assertVerdict(judge(manifest, { ...pr, branch: 'changeset-release/main' }, verifiedAndApproved, release), 'block', 'never-merge')
})

test('waits when verification belongs to another patch', () => {
  const verdict = judge(manifest, pr, { verified: { patchId: 'other' }, approved: { patchId: PATCH } }, facts())
  assertVerdict(verdict, 'wait', 'not-verified')
  assert.match(verdict.reasons.join(), /not verified/)
})

test('rebases when the branch is behind the base', () => {
  assertVerdict(judge(manifest, pr, verifiedAndApproved, facts({ baseIsAncestor: false })), 'rebase', 'behind-base')
})

test('rebases on conflicts', () => {
  const conflicting = facts({ pr: { ...facts().pr, mergeable: 'CONFLICTING' } })
  assertVerdict(judge(manifest, pr, verifiedAndApproved, conflicting), 'rebase', 'behind-base')
})

test('waits while mergeability is computed', () => {
  const unknown = facts({ pr: { ...facts().pr, mergeable: 'UNKNOWN' } })
  assertVerdict(judge(manifest, pr, verifiedAndApproved, unknown), 'wait', 'mergeable-unknown')
})

test('sends red CI back to the implementer', () => {
  const red = facts({ checks: { state: 'red', missing: [], pending: [], failing: ['smoke: failure'] } })
  const verdict = judge(manifest, pr, verifiedAndApproved, red)
  assertVerdict(verdict, 'fix', 'ci-red')
  assert.match(verdict.reasons.join(), /smoke: failure/)
})

test('waits for missing required checks', () => {
  const missing = facts({ checks: { state: 'pending', missing: ['smoke*'], pending: [], failing: [] } })
  assertVerdict(judge(manifest, pr, verifiedAndApproved, missing), 'wait', 'ci-pending')
})

test('does not merge onto a red base branch', () => {
  const verdict = judge(
    manifest,
    pr,
    verifiedAndApproved,
    facts({ mainChecks: { state: 'red', missing: [], pending: [], failing: ['check'] } }),
  )

  assertVerdict(verdict, 'wait', 'base-not-green')
})

test('the wait on a base that is not green names the commit it was read from', () => {
  const pending = { state: 'pending', missing: [], pending: [], failing: [], sha: 'abc1234def5678', skipped: 1 }
  const one = judge(manifest, pr, verifiedAndApproved, facts({ mainChecks: pending }))

  assertVerdict(one, 'wait', 'base-not-green')
  assert.match(one.reasons.join(), /main is not green \(pending at abc1234, 1 quiet commit skipped\)/)

  const three = judge(manifest, pr, verifiedAndApproved, facts({ mainChecks: { ...pending, skipped: 3 } }))

  assertVerdict(three, 'wait', 'base-not-green')
  assert.match(three.reasons.join(), /pending at abc1234, 3 quiet commits skipped/)

  const tip = judge(manifest, pr, verifiedAndApproved, facts({ mainChecks: { ...pending, skipped: 0 } }))

  assertVerdict(tip, 'wait', 'base-not-green')
  assert.match(tip.reasons.join(), /main is not green \(pending\)/)

  const bare = judge(manifest, pr, verifiedAndApproved, facts({ mainChecks: { state: 'pending' } }))

  assertVerdict(bare, 'wait', 'base-not-green')
  assert.match(bare.reasons.join(), /\(pending\)/)
})

test('a halted rollout waits instead of blocking verified PRs', () => {
  assertVerdict(judge(manifest, pr, verifiedAndApproved, facts({ halted: 'main red' })), 'wait', 'halted')
})

test('changeset parsing follows @changesets/parse: comments, CRLF, flow style; unknown means violation', () => {
  assert.equal(highestBump('---\n"@demo/core": major # breaking\n---\n'), 'major')
  assert.equal(highestBump('---\r\n"@demo/core": minor\r\n---\r\n'), 'minor')
  assert.equal(highestBump('\n---\n{ "@demo/core": major }\n---\n'), 'major')
  assert.equal(highestBump('---\n"@demo/core": huge\n---\n'), null)
  const odd = facts({ changesets: [{ path: '.changeset/odd.md', text: 'no frontmatter' }] })
  assert.match(policyViolations(manifest, pr, odd).join(), /cannot determine the bump/)
})

test('the denylist covers file paths', () => {
  const named = facts({ files: [...facts().files, { status: 'added', path: 'examples/acme corp/Form.tsx' }] })
  assert.match(policyViolations(manifest, pr, named).join(), /file path/)
})

test('workflow files need allowWorkflows', () => {
  const ci = facts({ files: [...facts().files, { status: 'modified', path: '.github/workflows/ci.yml' }] })
  assert.match(policyViolations(manifest, pr, ci).join(), /allowWorkflows/)
  assert.deepEqual(policyViolations(manifest, { ...pr, allowWorkflows: true }, ci), [])
})

test('Claude Code files need allowClaudeConfig, and a rename out of .claude/ counts', () => {
  const changed = facts({ files: [...facts().files, { status: 'modified', path: '.claude/settings.json' }] })
  const renamed = facts({
    files: [...facts().files, { status: 'renamed', path: 'docs/settings.json', previousPath: '.claude/settings.json' }],
  })

  for (const prFacts of [changed, renamed]) {
    const violations = policyViolations(manifest, pr, prFacts)

    assert.equal(violations.length, 1)
    assert.match(violations[0], /allowClaudeConfig/)
    assert.match(violations[0], /^touches \.claude\/settings\.json: agents of this rollout load the project's Claude Code settings/)
    assert.deepEqual(policyViolations(manifest, { ...pr, allowClaudeConfig: true }, prFacts), [])
  }
})

test('dependencies must be merged first', () => {
  assertVerdict(judge(manifest, pr, verifiedAndApproved, facts({ depsPending: ['A6'] })), 'wait', 'deps-pending')
})

test('draft, wrong base, wrong branch and missing label block', () => {
  const changes = [
    [{ isDraft: true }, 'draft'],
    [{ baseRefName: 'develop' }, 'wrong-base'],
    [{ headRefName: 'other' }, 'wrong-head'],
    [{ labels: [] }, 'missing-label'],
  ]

  for (const [change, code] of changes) {
    const verdict = judge(manifest, pr, verifiedAndApproved, facts({ pr: { ...facts().pr, ...change } }))
    assertVerdict(verdict, 'block', code, JSON.stringify(change))
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
    const verdict = judge(manifest, pr, verifiedAndApproved, facts({ pr: { ...merged, ...change } }))

    assertVerdict(verdict, 'wait', 'merged-on-github', JSON.stringify(change))
    assert.deepEqual(verdict.reasons, ['merged on GitHub (the next sync records it)'])
  }

  const closed = judge(manifest, pr, verifiedAndApproved, facts({ pr: { ...facts().pr, state: 'CLOSED' } }))

  assertVerdict(closed, 'block', 'pr-not-open')
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

  const violations = policyViolations(manifest, pr, bad).join('\n')

  assert.match(violations, /forbidden path packages\/core\/CHANGELOG\.md/)
  assert.match(violations, /package version/)
  assert.match(violations, /removes an existing changeset/)
  assert.match(violations, /no new changeset/)
  assert.match(violations, /major bump/)
  assert.match(violations, /denylisted term in README\.md/)
  assert.match(violations, /more than one line/)
  assertVerdict(judge(manifest, pr, verifiedAndApproved, bad), 'fix', 'policy-violations')
})

test('policy: the denylist also covers the PR body', () => {
  const leaky = facts({ pr: { ...facts().pr, body: 'see /Users/someone/project' } })
  assert.match(policyViolations(manifest, pr, leaky).join(), /PR body/)
})

test('a clean PR has no violations', () => {
  assert.deepEqual(policyViolations(manifest, pr, facts()), [])
})

test('changeset bump parsing', () => {
  assert.equal(highestBump('---\n"a": patch\n\'b\': minor\n---\n'), 'minor')
  assert.equal(highestBump('---\n"a": major\n---\n'), 'major')
  assert.equal(highestBump('no frontmatter'), null)
  assert.equal(highestBump('---\n---\n'), null)
})

test('out-of-scope files are reported, changesets are always allowed', () => {
  const extra = facts({ files: [...facts().files, { status: 'modified', path: 'README.md' }] })
  assert.deepEqual(outOfScope(manifest, pr, extra), ['README.md'])
})

test('undeclaredOutOfScope: a file out of scope stays unless deviations name its exact path', () => {
  const outside = ['README.md', 'docs/usage.md', 'scripts/release.sh']
  const reason = 'needed for the change'

  assert.deepEqual(undeclaredOutOfScope(outside), outside)
  assert.deepEqual(undeclaredOutOfScope(outside, [{ file: 'README.md', reason }]), ['docs/usage.md', 'scripts/release.sh'])
  assert.deepEqual(
    undeclaredOutOfScope(outside, [
      { file: 'docs/usage.md', reason },
      { file: 'README.md', reason },
    ]),
    ['scripts/release.sh'],
  )

  assert.deepEqual(
    undeclaredOutOfScope(outside, [
      { file: 'docs', reason },
      { file: 'docs/', reason },
      { file: 'docs/**', reason },
    ]),
    outside,
  )

  assert.deepEqual(undeclaredOutOfScope(outside, [{ file: 'scripts/*.sh', reason }]), outside)
  assert.deepEqual(undeclaredOutOfScope([], [{ file: 'README.md', reason }]), [])
  assert.deepEqual(undeclaredOutOfScope(['README.md'], null), ['README.md'])
  assert.deepEqual(undeclaredOutOfScope(['README.md'], undefined), ['README.md'])
})

const GM = { ...manifest, policy: { ...manifest.policy, approval: 'github' }, repo: { ...manifest.repo, maintainers: ['maint'] } }
const botFacts = (reviews, overrides = {}) => facts({ pr: { ...facts().pr, author: 'bot' }, reviews, ...overrides })
const onVerified = { verified: { sha: 'abc1234def', patchId: PATCH, at: '2026-09-27T09:00:00Z' }, patchSince: '2026-09-27T09:00:00Z' }

test('github approval: a maintainer review given after the patch appeared merges', () => {
  const reviews = [{ user: 'maint', state: 'APPROVED', commit: 'rebased999', at: '2026-09-27T10:00:00Z' }]
  assertVerdict(judge(GM, pr, onVerified, botFacts(reviews)), 'merge', 'merge')
})

test('github approval: none, stale, non-maintainer or changes requested waits', () => {
  const cases = [
    [[], 'awaiting-github-review'],
    [[{ user: 'maint', state: 'APPROVED', commit: 'abc1234def', at: '2026-09-27T08:00:00Z' }], 'stale-github-review'],
    [[{ user: 'someone', state: 'APPROVED', commit: 'abc1234def', at: '2026-09-27T10:00:00Z' }], 'awaiting-github-review'],
    [
      [
        { user: 'maint', state: 'APPROVED', commit: 'abc1234def', at: '2026-09-27T10:00:00Z' },
        { user: 'maint', state: 'CHANGES_REQUESTED', commit: 'abc1234def', at: '2026-09-27T11:00:00Z' },
      ],
      'changes-requested',
    ],
  ]

  for (const [reviews, code] of cases) {
    assertVerdict(judge(GM, pr, onVerified, botFacts(reviews)), 'wait', code, JSON.stringify(reviews))
  }
})

test('github approval: an inbox approval does not replace a GitHub review for agent PRs', () => {
  assertVerdict(judge(GM, pr, { ...onVerified, approved: { patchId: PATCH } }, botFacts([])), 'wait', 'awaiting-github-review')
})

test('github approval: maintainer-authored PRs fall back to rollout approve', () => {
  const own = facts({ pr: { ...facts().pr, author: 'maint' }, reviews: [] })
  assertVerdict(judge(GM, pr, { ...onVerified, approved: { patchId: PATCH } }, own), 'merge', 'merge')
  assertVerdict(judge(GM, pr, onVerified, own), 'wait', 'awaiting-inbox-approval')
})

test('without a bypass, a merge waits while GitHub reports BLOCKED', () => {
  const reviews = [{ user: 'maint', state: 'APPROVED', commit: 'abc1234def', at: '2026-09-27T10:00:00Z' }]
  const blockedByGitHub = botFacts(reviews, { pr: { ...facts().pr, author: 'bot', mergeStateStatus: 'BLOCKED' } })
  const verdict = judge({ ...GM, repo: { ...GM.repo, merge: { admin: 'auto' } } }, pr, onVerified, blockedByGitHub)
  assertVerdict(verdict, 'wait', 'github-blocked')
  assert.match(verdict.reasons.join(), /GitHub still blocks/)
})

test('with a bypass (maintainer-authored PR), BLOCKED is expected and merges', () => {
  const own = facts({ pr: { ...facts().pr, author: 'maint', mergeStateStatus: 'BLOCKED' }, reviews: [] })
  const verdict = judge({ ...GM, repo: { ...GM.repo, merge: { admin: 'auto' } } }, pr, { ...onVerified, approved: { patchId: PATCH } }, own)
  assertVerdict(verdict, 'merge', 'merge')
})

test('manual mode: the gate says merge without any approval; the maintainer merges', () => {
  const MM = { ...GM, policy: { ...GM.policy, merge: 'manual' } }
  const blocked = botFacts([], { pr: { ...facts().pr, author: 'bot', mergeStateStatus: 'BLOCKED' } })
  assertVerdict(judge(MM, pr, onVerified, blocked), 'merge', 'merge')
  assertVerdict(
    judge(MM, pr, onVerified, facts({ checks: { state: 'pending', missing: [], pending: ['CodeQL'], failing: [] } })),
    'wait',
    'ci-pending',
  )
})

test('a PR in a repo without changesets needs none', () => {
  const plain = facts({ files: [{ status: 'modified', path: 'packages/core/src/recorder.ts' }], changesets: [] })
  assert.deepEqual(policyViolations(manifest, { ...pr, changeset: 'none' }, plain), [])
  assert.match(policyViolations(manifest, pr, plain).join(), /no new changeset/)
})

test('a held PR waits: no merge, no rebase, no ready notice in manual mode', () => {
  const held = { ...verifiedAndApproved, held: { at: '2026-09-27T09:00:00Z' } }
  const verdict = judge(manifest, pr, held, facts())

  assertVerdict(verdict, 'wait', 'held')
  assert.match(verdict.reasons.join(), /held/)
  assertVerdict(judge(manifest, pr, held, facts({ baseIsAncestor: false })), 'wait', 'held')
  assertVerdict(judge({ ...manifest, policy: { ...manifest.policy, merge: 'manual' } }, pr, held, facts()), 'wait', 'held')
  assertVerdict(judge(manifest, pr, { ...held, held: null }, facts()), 'merge', 'merge')
})

const withMerge = (base, merge) => ({ ...base, policy: { ...base.policy, merge } })

test('approvalChannel: inbox or GitHub under human, none under manual and auto', () => {
  assert.equal(approvalChannel(manifest, 'bot'), 'inbox')
  assert.equal(approvalChannel(GM, 'bot'), 'github')
  assert.equal(approvalChannel(GM, 'maint'), 'inbox')
  assert.equal(approvalChannel(GM, undefined), 'github')

  for (const merge of ['manual', 'auto']) {
    assert.equal(approvalChannel(withMerge(manifest, merge), 'bot'), null, merge)
    assert.equal(approvalChannel(withMerge(GM, merge), 'bot'), null, merge)
  }
})

test('approveRefusal: manual and auto refuse, and so does a PR approved on GitHub', () => {
  assert.equal(
    approveRefusal(withMerge(manifest, 'manual'), { pr: 7, author: 'bot' }),
    'policy.merge is manual: no approval is needed. Merge the PR on GitHub once the driver says it is ready',
  )

  assert.equal(
    approveRefusal(withMerge(GM, 'auto'), { pr: 7, author: 'maint' }),
    'policy.merge is auto: no approval is needed. The driver merges once the gate passes, and rollout hold stops it',
  )

  assert.equal(approveRefusal(GM, { pr: 7, author: 'bot' }), 'PR #7 is approved on GitHub: review it there')
  assert.equal(approveRefusal(GM, { pr: 7, author: 'maint' }), null)
  assert.equal(approveRefusal(GM, { pr: 7 }), null)
  assert.equal(approveRefusal(manifest, { pr: 7, author: 'bot' }), null)
})

test('a record of a GitHub approval never passes for rollout approve', () => {
  const verdict = judge(manifest, pr, { ...onVerified, approved: { patchId: PATCH, channel: 'github' } }, facts())

  assertVerdict(verdict, 'wait', 'awaiting-inbox-approval')
  assert.match(verdict.reasons.join(), /rollout approve/)
  assertVerdict(judge(manifest, pr, { ...onVerified, approved: { patchId: PATCH, channel: 'inbox' } }, facts()), 'merge', 'merge')
})

const withScanning = (codeScanning) => ({
  ...manifest,
  repo: { ...manifest.repo, codeScanning: { ...manifest.repo.codeScanning, ...codeScanning } },
})

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
    url: 'https://github.com/example/widgets/security/code-scanning/4',
    sha: 'abc1234def',
    ...overrides,
  }
}

function scanned(alerts, baseOpen = [], overrides = {}) {
  return facts({ codeScanning: { available: true, alerts, baseOpen }, ...overrides })
}

const ALERT_REASON =
  'CodeQL js/shell-command-injection-from-environment (medium) bin/rollout.mjs:357: This shell command depends on an uncontrolled absolute path. https://github.com/example/widgets/security/code-scanning/4'

const NONE = { action: 'none', reasons: [] }

test('codeScanningFindings: a new security alert at the threshold sends the PR back', () => {
  assert.deepEqual(codeScanningFindings(manifest, scanned([alert()])), { action: 'fix', reasons: [ALERT_REASON] })
})

test('codeScanningFindings: an alert also open on the base is not new', () => {
  assert.deepEqual(codeScanningFindings(manifest, scanned([alert()], [4])), NONE)
  assert.deepEqual(codeScanningFindings(manifest, scanned([alert()], [3])), { action: 'fix', reasons: [ALERT_REASON] })
})

test('codeScanningFindings: alerts below the threshold do not count', () => {
  const low = alert({ securitySeverity: 'low', severity: 'error' })
  const warning = alert({ securitySeverity: null, severity: 'warning' })

  assert.deepEqual(codeScanningFindings(manifest, scanned([low, warning])), NONE)
  assert.equal(codeScanningFindings(withScanning({ minSeverity: 'low' }), scanned([low, warning])).action, 'fix')
})

test('codeScanningFindings: without a security level, error ranks as medium and note never counts', () => {
  const error = alert({ securitySeverity: null, severity: 'error', path: null, line: null })
  const note = alert({ securitySeverity: null, severity: 'note' })

  assert.deepEqual(codeScanningFindings(manifest, scanned([error])), {
    action: 'fix',
    reasons: [
      'CodeQL js/shell-command-injection-from-environment (medium) ?:?: This shell command depends on an uncontrolled absolute path. https://github.com/example/widgets/security/code-scanning/4',
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
  const verdict = codeScanningFindings(manifest, scanned([stale, unknown, alert({ number: 6 })]))

  assert.deepEqual(verdict, {
    action: 'wait',
    reasons: [
      'code scanning has not analysed abc1234 yet (alert #4 is from def5678)',
      'code scanning has not analysed abc1234 yet (alert #5 is from unknown)',
    ],
  })

  assertVerdict(judge(manifest, pr, verifiedAndApproved, scanned([stale, unknown, alert({ number: 6 })])), 'wait', 'code-scanning')
})

test('codeScanningFindings: no code scanning, or none available, finds nothing', () => {
  assert.deepEqual(codeScanningFindings(manifest, facts()), NONE)
  assert.deepEqual(codeScanningFindings(manifest, facts({ codeScanning: null })), NONE)
  assert.deepEqual(
    codeScanningFindings(
      manifest,
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
  const flagged = { action: 'fix', code: 'code-scanning', reasons: [ALERT_REASON] }

  assert.deepEqual(judge(manifest, pr, verifiedAndApproved, scanned([alert()], [], { checks: red })), {
    action: 'fix',
    code: 'ci-red',
    reasons: ['smoke: failure', 'CI is red on the PR head'],
  })

  assert.deepEqual(judge(manifest, pr, verifiedAndApproved, scanned([alert()], [], { checks: pending })), {
    action: 'wait',
    code: 'ci-pending',
    reasons: ['CI pending (missing: -; running: test)'],
  })

  assert.deepEqual(judge(manifest, pr, verifiedAndApproved, scanned([alert()])), flagged)
  assert.deepEqual(judge(manifest, pr, verifiedAndApproved, scanned([alert()], [], { mainChecks: redBase })), flagged)
  assert.deepEqual(judge(withScanning({ action: 'block' }), pr, verifiedAndApproved, scanned([alert()])), { ...flagged, action: 'block' })
  assertVerdict(judge(manifest, pr, verifiedAndApproved, scanned([alert()], [4])), 'merge', 'merge')
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

const STALE_APPROVAL = { user: 'maint', state: 'APPROVED', commit: 'abc1234def', at: '2026-09-27T08:00:00Z' }
const APPROVAL = { ...STALE_APPROVAL, at: '2026-09-27T10:00:00Z' }
const CHANGES_REQUESTED = { ...APPROVAL, state: 'CHANGES_REQUESTED', at: '2026-09-27T11:00:00Z' }

test('githubApproval: changes requested, a stale approval and no approval each have a code, an approval has who and when', () => {
  assert.deepEqual(githubApproval(GM, onVerified, botFacts([APPROVAL, CHANGES_REQUESTED])), {
    approved: false,
    code: 'changes-requested',
    reason: 'a maintainer requested changes on GitHub',
  })

  assert.deepEqual(githubApproval(GM, onVerified, botFacts([STALE_APPROVAL])), {
    approved: false,
    code: 'stale-github-review',
    reason: 'the GitHub approval is for an older patch; approve PR #7 again',
  })

  assert.deepEqual(githubApproval(GM, onVerified, botFacts([])), {
    approved: false,
    code: 'awaiting-github-review',
    reason: 'awaiting a maintainer review on GitHub (approve PR #7)',
  })

  assert.deepEqual(githubApproval(GM, onVerified, botFacts([APPROVAL])), { approved: true, by: 'maint', at: APPROVAL.at })
})

test('githubApproval: a maintainer review dismissed after their approval takes the approval away', () => {
  const dismissed = { ...APPROVAL, state: 'DISMISSED', at: '2026-09-27T11:00:00Z' }

  assert.deepEqual(githubApproval(GM, onVerified, botFacts([APPROVAL, dismissed])), {
    approved: false,
    code: 'awaiting-github-review',
    reason: 'awaiting a maintainer review on GitHub (approve PR #7)',
  })

  assertVerdict(judge(GM, pr, onVerified, botFacts([APPROVAL, dismissed])), 'wait', 'awaiting-github-review')
})

test('judge: without a bypass, CLEAN, HAS_HOOKS and UNSTABLE merge, and BLOCKED, DIRTY, UNKNOWN and DRAFT wait', () => {
  const noBypass = { ...GM, repo: { ...GM.repo, merge: { admin: 'auto' } } }
  const verdictFor = (mergeStateStatus) =>
    judge(noBypass, pr, onVerified, botFacts([APPROVAL], { pr: { ...facts().pr, author: 'bot', mergeStateStatus } }))

  for (const state of ['CLEAN', 'HAS_HOOKS', 'UNSTABLE']) {
    assertVerdict(verdictFor(state), 'merge', 'merge', state)
  }

  assertVerdict(verdictFor('BLOCKED'), 'wait', 'github-blocked')

  for (const state of ['DIRTY', 'UNKNOWN', 'DRAFT']) {
    assertVerdict(verdictFor(state), 'wait', 'github-merge-state', state)
  }
})

test('judge: every gate code, each with its action', () => {
  const withPr = (change) => facts({ pr: { ...facts().pr, ...change } })
  const red = { state: 'red', missing: [], pending: [], failing: ['check'] }
  const pending = { state: 'pending', missing: ['smoke*'], pending: [], failing: [] }
  const forbidden = facts({ files: [...facts().files, { status: 'modified', path: 'packages/core/CHANGELOG.md' }] })
  // No bypass, so GitHub's merge state has the last word, as in the BLOCKED test above.
  const noBypass = { ...GM, repo: { ...GM.repo, merge: { admin: 'auto' } } }
  const mergeState = (mergeStateStatus) => botFacts([APPROVAL], { pr: { ...facts().pr, author: 'bot', mergeStateStatus } })

  const rows = [
    ['halted', 'wait', judge(manifest, pr, verifiedAndApproved, facts({ halted: 'main red' }))],
    ['held', 'wait', judge(manifest, pr, { ...verifiedAndApproved, held: { at: '2026-09-27T09:00:00Z' } }, facts())],
    ['no-pr', 'block', judge(manifest, pr, verifiedAndApproved, facts({ pr: null }))],
    ['merged-on-github', 'wait', judge(manifest, pr, verifiedAndApproved, withPr({ state: 'MERGED' }))],
    ['pr-not-open', 'block', judge(manifest, pr, verifiedAndApproved, withPr({ state: 'CLOSED' }))],
    ['never-merge', 'block', judge(manifest, pr, verifiedAndApproved, withPr({ title: 'chore: version packages' }))],
    ['draft', 'block', judge(manifest, pr, verifiedAndApproved, withPr({ isDraft: true }))],
    ['wrong-base', 'block', judge(manifest, pr, verifiedAndApproved, withPr({ baseRefName: 'develop' }))],
    ['wrong-head', 'block', judge(manifest, pr, verifiedAndApproved, withPr({ headRefName: 'other' }))],
    ['missing-label', 'block', judge(manifest, pr, verifiedAndApproved, withPr({ labels: [] }))],
    ['deps-pending', 'wait', judge(manifest, pr, verifiedAndApproved, facts({ depsPending: ['A6'] }))],
    ['not-verified', 'wait', judge(manifest, pr, { ...verifiedAndApproved, verified: { patchId: 'other' } }, facts())],
    ['awaiting-github-review', 'wait', judge(GM, pr, onVerified, botFacts([]))],
    ['stale-github-review', 'wait', judge(GM, pr, onVerified, botFacts([STALE_APPROVAL]))],
    ['changes-requested', 'wait', judge(GM, pr, onVerified, botFacts([APPROVAL, CHANGES_REQUESTED]))],
    ['awaiting-inbox-approval', 'wait', judge(manifest, pr, onVerified, facts())],
    ['policy-violations', 'fix', judge(manifest, pr, verifiedAndApproved, forbidden)],
    ['behind-base', 'rebase', judge(manifest, pr, verifiedAndApproved, facts({ baseIsAncestor: false }))],
    ['mergeable-unknown', 'wait', judge(manifest, pr, verifiedAndApproved, withPr({ mergeable: 'UNKNOWN' }))],
    ['ci-red', 'fix', judge(manifest, pr, verifiedAndApproved, facts({ checks: red }))],
    ['ci-pending', 'wait', judge(manifest, pr, verifiedAndApproved, facts({ checks: pending }))],
    ['code-scanning', 'block', judge(withScanning({ action: 'block' }), pr, verifiedAndApproved, scanned([alert()]))],
    ['base-not-green', 'wait', judge(manifest, pr, verifiedAndApproved, facts({ mainChecks: red }))],
    ['github-blocked', 'wait', judge(noBypass, pr, onVerified, mergeState('BLOCKED'))],
    ['github-merge-state', 'wait', judge(noBypass, pr, onVerified, mergeState('BEHIND'))],
    ['merge', 'merge', judge(manifest, pr, verifiedAndApproved, facts())],
  ]

  for (const [code, action, verdict] of rows) {
    assertVerdict(verdict, action, code, code)
    assert.ok(GATE_CODES.includes(verdict.code), code)
  }

  assert.deepEqual(rows.map(([, , verdict]) => verdict.code).sort(), [...GATE_CODES].sort())
})
