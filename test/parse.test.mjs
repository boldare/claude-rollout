import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  alertsFrom,
  codeScanningFor,
  codeScanningUnavailable,
  collectFacts,
  commentAsAgents,
  deleteRemoteBranch,
  ensureLabel,
  githubUnavailable,
  maintainerFeedback,
  parseAddedLines,
  parseCommits,
  parseNameStatus,
  refreshOutsideDeps,
  remoteRepo,
  replyAsAgents,
} from '../lib/github.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { fakeTools, makeRollout } from './fixtures.mjs'

test('name-status with renames and deletions', () => {
  const files = parseNameStatus('M\tREADME.md\nA\t.changeset/a.md\nD\tpackages/core/src/quick-hash.ts\nR087\told/x.ts\tnew/x.ts\n')
  assert.deepEqual(files, [
    { status: 'modified', path: 'README.md' },
    { status: 'added', path: '.changeset/a.md' },
    { status: 'removed', path: 'packages/core/src/quick-hash.ts' },
    { status: 'renamed', path: 'new/x.ts', previousPath: 'old/x.ts' },
  ])
})

test('added lines keep their file and skip headers and deletions', () => {
  const diff = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -3 +3 @@',
    '-  "version": "0.4.0",',
    '+  "version": "0.5.0",',
    'diff --git a/gone.txt b/gone.txt',
    '--- a/gone.txt',
    '+++ /dev/null',
    '-bye',
  ].join('\n')

  assert.deepEqual(parseAddedLines(diff), [{ path: 'package.json', text: '  "version": "0.5.0",' }])
})

test('commits split on record separators and keep bodies', () => {
  const out = 'aaa\x1ffix: one\n\x1e\nbbb\x1ffix: two\n\nbody line\n\x1e\n'
  assert.deepEqual(parseCommits(out), [
    { sha: 'aaa', message: 'fix: one' },
    { sha: 'bbb', message: 'fix: two\n\nbody line' },
  ])
})

const manifest = { repo: { maintainers: ['maint'] } }

function inlineComment(id, login, createdAt, body) {
  return { id, user: { login }, created_at: createdAt, body, path: 'lib/a.mjs', line: 3, diff_hunk: '@@ -1 +1 @@', in_reply_to_id: null }
}

function review(id, login, submittedAt, state, body) {
  return { id, user: { login }, submitted_at: submittedAt, state, body }
}

function conversationComment(id, login, createdAt, body) {
  return { id, user: { login }, created_at: createdAt, body }
}

test('maintainer feedback keeps maintainer items in time order', () => {
  const inline = [
    {
      id: 11,
      user: { login: 'maint' },
      created_at: '2026-01-01T00:03:00Z',
      body: 'Rename this',
      path: 'lib/a.mjs',
      line: null,
      original_line: 12,
      diff_hunk: '@@ -10,3 +10,3 @@',
      in_reply_to_id: null,
    },
    inlineComment(12, 'someone', '2026-01-01T00:00:00Z', 'Nice'),
  ]
  const reviews = [
    review(21, 'maint', '2026-01-01T00:01:00Z', 'COMMENTED', 'Split the module'),
    review(22, 'maint', '2026-01-01T00:02:00Z', 'APPROVED', 'LGTM'),
    review(23, 'maint', '2026-01-01T00:04:00Z', 'CHANGES_REQUESTED', '  \n'),
    review(24, 'someone', '2026-01-01T00:00:00Z', 'CHANGES_REQUESTED', 'No'),
  ]
  const conversation = [
    conversationComment(31, 'maint', '2026-01-01T00:02:30Z', 'Also update the docs'),
    conversationComment(32, 'someone', '2026-01-01T00:00:00Z', 'Me too'),
  ]

  assert.deepEqual(maintainerFeedback(manifest, { inline, reviews, conversation }), [
    { id: 'review-21', at: '2026-01-01T00:01:00Z', body: 'Split the module' },
    { id: 'conversation-31', at: '2026-01-01T00:02:30Z', body: 'Also update the docs' },
    {
      id: 'inline-11',
      commentId: 11,
      at: '2026-01-01T00:03:00Z',
      body: 'Rename this',
      path: 'lib/a.mjs',
      line: 12,
      hunk: '@@ -10,3 +10,3 @@',
      replyTo: null,
    },
  ])
})

test('maintainer feedback skips bodies whose last line is the driver marker', () => {
  const feedback = maintainerFeedback(manifest, {
    inline: [inlineComment(11, 'maint', '2026-01-01T00:00:00Z', 'Renamed (abc1234)\r\n\r\n<!-- rollout-driver -->')],
    reviews: [review(21, 'maint', '2026-01-01T00:01:00Z', 'COMMENTED', 'Done\n\n<!-- rollout-driver -->\n')],
    conversation: [conversationComment(31, 'maint', '2026-01-01T00:02:00Z', 'Review comments addressed:\n\n<!-- rollout-driver -->')],
  })

  assert.deepEqual(feedback, [])
})

test('maintainer feedback still counts a marker that is not the last line', () => {
  const feedback = maintainerFeedback(manifest, {
    inline: [],
    reviews: [review(21, 'maint', '2026-01-01T00:00:00Z', 'COMMENTED', null)],
    conversation: [
      conversationComment(31, 'maint', '2026-01-01T00:01:00Z', 'Why does `<!-- rollout-driver -->` end every reply?'),
      conversationComment(32, 'maint', '2026-01-01T00:02:00Z', 'You wrote:\n\n> <!-- rollout-driver -->'),
      conversationComment(33, 'maint', '2026-01-01T00:03:00Z', 'Done\n\n<!-- rollout-driver -->\n\nBut please also rename it'),
    ],
  })

  assert.deepEqual(
    feedback.map((item) => item.id),
    ['conversation-31', 'conversation-32', 'conversation-33'],
  )
})

// Records its args and, for --body-file, its stdin. Reading stdin otherwise
// would hang, because sh() leaves it open when it has no input.
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const stdin = args.includes('--body-file') ? readFileSync(0, 'utf8') : null
const { GH_REPO, GH_HOST } = process.env
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify({ args, stdin, GH_REPO, GH_HOST }) + '\\n')
`

test('the driver marks what it posts and never reads it back as feedback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-gh-'))

  try {
    writeFileSync(join(dir, 'gh'), FAKE_GH, { mode: 0o755 })
    const manifest = { repo: { path: dir, github: 'example/demo', pathPrepend: [dir], agentToken: null, maintainers: ['maint'] } }

    await replyAsAgents(manifest, 7, 101, 'Renamed the helper (abc1234)')
    await commentAsAgents(manifest, 7, 'Review comments addressed:\n\n- "x": done (abc1234)')

    const [reply, comment] = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const replyBody = reply.args.at(-1).replace(/^body=/, '')

    assert.equal(reply.args.at(-2), '-f')
    assert.ok(replyBody.startsWith('Renamed the helper (abc1234)'))
    assert.ok(replyBody.endsWith('\n\n<!-- rollout-driver -->'))
    assert.deepEqual(comment.args, ['pr', 'comment', '7', '--body-file', '-'])
    assert.ok(comment.stdin.startsWith('Review comments addressed:\n\n- "x": done (abc1234)'))
    assert.ok(comment.stdin.endsWith('\n\n<!-- rollout-driver -->'))

    const feedback = maintainerFeedback(manifest, {
      inline: [{ ...inlineComment(12, 'maint', '2026-01-01T00:00:00Z', replyBody), in_reply_to_id: 101 }],
      reviews: [],
      conversation: [conversationComment(31, 'maint', '2026-01-01T00:01:00Z', comment.stdin)],
    })

    assert.deepEqual(feedback, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the driver pins every gh call to the manifest repo on github.com', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-gh-'))
  const inherited = { GH_REPO: process.env.GH_REPO, GH_HOST: process.env.GH_HOST }
  process.env.GH_REPO = 'someone/else'
  process.env.GH_HOST = 'ghe.example.com'

  try {
    writeFileSync(join(dir, 'gh'), FAKE_GH, { mode: 0o755 })
    const manifest = {
      label: 'rollout:demo',
      repo: { path: dir, github: 'example/demo', pathPrepend: [dir], agentToken: null, maintainers: ['maint'] },
    }

    await ensureLabel(manifest)
    await deleteRemoteBranch(manifest, 'feat/x')
    await replyAsAgents(manifest, 7, 101, 'Done')
    await commentAsAgents(manifest, 7, 'Done')

    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

    assert.equal(calls.length, 4)

    for (const call of calls) {
      assert.equal(call.GH_REPO, 'github.com/example/demo')
      assert.equal(call.GH_HOST, 'github.com')
    }
  } finally {
    for (const [name, value] of Object.entries(inherited)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }

    rmSync(dir, { recursive: true, force: true })
  }
})

const GITHUB_SSH = { protocol: 'ssh', host: 'github.com', repo: 'my-org/my-lib' }
const GITHUB_HTTPS = { protocol: 'https', host: 'github.com', repo: 'my-org/my-lib' }

test('remote URLs in SSH form give host and repo', () => {
  assert.deepEqual(remoteRepo('git@github.com:my-org/my-lib.git'), GITHUB_SSH)
  assert.deepEqual(remoteRepo('ssh://git@github.com/my-org/my-lib'), GITHUB_SSH)
  assert.deepEqual(remoteRepo('git+ssh://git@github.com/my-org/my-lib.git'), GITHUB_SSH)
  assert.deepEqual(remoteRepo('ssh://git@GitHub-Work:2222/My-Org/My-Lib.git'), {
    protocol: 'ssh',
    host: 'github-work',
    repo: 'my-org/my-lib',
  })
})

test('remote URLs in HTTPS form give host and repo', () => {
  assert.deepEqual(remoteRepo('https://github.com/my-org/my-lib.git'), GITHUB_HTTPS)
  assert.deepEqual(remoteRepo('https://github.com/my-org/my-lib/'), GITHUB_HTTPS)
  assert.deepEqual(remoteRepo('http://github.com/my-org/my-lib'), GITHUB_HTTPS)
  assert.deepEqual(remoteRepo('https://x-access-token:secret@GitHub.com/My-Org/My-Lib.git/'), GITHUB_HTTPS)
})

test('remote URLs keep a longer name and another host', () => {
  assert.equal(remoteRepo('git@github.com:my-org/my-lib-next.git').repo, 'my-org/my-lib-next')
  assert.equal(remoteRepo('https://gitlab.com/my-org/my-lib.git').host, 'gitlab.com')
})

test('remote URLs that are not SSH or HTTPS owner/name give null', () => {
  const rejected = [
    '',
    '/srv/git/my-lib.git',
    './x:my-org/my-lib',
    'file:///srv/git/my-lib.git',
    'git://github.com/my-org/my-lib.git',
    'https://github.com/my-org',
    'https://gitlab.com/group/sub/my-lib.git',
    'ssh://git@github.com:my-org/my-lib.git',
    '-oProxyCommand=x:my-org/my-lib',
    'ssh://-oProxyCommand=x/my-org/my-lib',
  ]

  for (const url of rejected) {
    assert.equal(remoteRepo(url), null, url)
  }

  assert.equal(remoteRepo(null), null)
  assert.equal(remoteRepo(42), null)
})

const HEAD = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'

// One alert as the code scanning API returns it, trimmed.
function alertJson(number, overrides = {}) {
  return {
    number,
    state: 'open',
    html_url: `https://github.com/example/demo/security/code-scanning/${number}`,
    rule: { id: 'js/shell-command-injection-from-environment', severity: 'warning', security_severity_level: 'medium' },
    tool: { name: 'CodeQL' },
    most_recent_instance: {
      ref: 'refs/pull/11/head',
      commit_sha: HEAD,
      state: 'open',
      location: { path: 'bin/rollout.mjs', start_line: 357 },
      message: { text: 'This shell command depends on an uncontrolled absolute path.' },
    },
    ...overrides,
  }
}

function mappedAlert(number) {
  return {
    number,
    rule: 'js/shell-command-injection-from-environment',
    securitySeverity: 'medium',
    severity: 'warning',
    tool: 'CodeQL',
    path: 'bin/rollout.mjs',
    line: 357,
    message: 'This shell command depends on an uncontrolled absolute path.',
    url: `https://github.com/example/demo/security/code-scanning/${number}`,
    sha: HEAD,
  }
}

test('alertsFrom keeps open alerts, the first line of each message and null for what is missing', () => {
  const repeated = alertJson(4)
  repeated.most_recent_instance.message.text =
    '\n  This shell command depends on an uncontrolled absolute path.  \nThis shell command depends on an uncontrolled absolute path.\n'
  const plain = alertJson(5, {
    rule: { id: 'js/redundant-operation', severity: 'error' },
    most_recent_instance: { commit_sha: HEAD, message: { text: 'Both operands are identical.' } },
  })
  const bare = { number: 6, state: 'open' }
  const fixed = alertJson(7, { state: 'fixed' })

  assert.deepEqual(alertsFrom([repeated, plain, bare, fixed, null]), [
    mappedAlert(4),
    {
      number: 5,
      rule: 'js/redundant-operation',
      securitySeverity: null,
      severity: 'error',
      tool: 'CodeQL',
      path: null,
      line: null,
      message: 'Both operands are identical.',
      url: 'https://github.com/example/demo/security/code-scanning/5',
      sha: HEAD,
    },
    {
      number: 6,
      rule: null,
      securitySeverity: null,
      severity: null,
      tool: null,
      path: null,
      line: null,
      message: '',
      url: null,
      sha: null,
    },
  ])

  for (const json of [null, undefined, { message: 'Not Found' }, 'alerts']) {
    assert.deepEqual(alertsFrom(json), [], JSON.stringify(json))
  }
})

test('codeScanningUnavailable: a 404 or a 403 means no code scanning, a rate limit or a 500 does not', () => {
  const prefix = 'gh api -X GET repos/example/demo/code-scanning/alerts exited 1: '

  for (const text of [
    'gh: no analysis found (HTTP 404)',
    'gh: Advanced Security must be enabled for this repository to use code scanning. (HTTP 403)',
  ]) {
    assert.equal(codeScanningUnavailable(text), true, text)
    assert.equal(codeScanningUnavailable(new Error(`${prefix}${text}`)), true, text)
  }

  for (const text of ['gh: API rate limit exceeded for user ID 1. (HTTP 403)', 'gh: Server Error (HTTP 500)']) {
    assert.equal(codeScanningUnavailable(text), false, text)
    assert.equal(codeScanningUnavailable(new Error(`${prefix}${text}`)), false, text)
  }
})

// What gh, git, curl and ssh print when GitHub or the network is down.
const OUTAGES = [
  'HTTP 502: Bad Gateway',
  'gh: Server Error (HTTP 500)',
  'HTTP 429: Too Many Requests',
  'non-200 OK status code: 502 Bad Gateway body: ""',
  "fatal: unable to access 'https://github.com/example/demo.git/': The requested URL returned error: 503",
  "fatal: unable to access 'https://github.com/example/demo.git/': The requested URL returned error: 429",
  'Server Error',
  'GraphQL: Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.',
  'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
  'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)',
  "fatal: unable to access 'https://github.com/example/demo.git/': Could not resolve host: github.com",
  'ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known',
  'Get "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host',
  'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com',
  "fatal: unable to access 'https://github.com/example/demo.git/': Failed to connect to github.com port 443 after 75000 ms",
  "curl: (7) Couldn't connect to server",
  'dial tcp 192.0.2.10:443: connect: connection refused',
  'read tcp 192.0.2.2:50000->192.0.2.10:443: read: connection reset by peer',
  'dial tcp 192.0.2.10:443: connect: network is unreachable',
  'Get "https://api.github.com/graphql": net/http: TLS handshake timeout',
  'ssh: connect to host github.com port 22: No route to host',
  "fatal: unable to access 'https://github.com/example/demo.git/': Operation timed out after 300000 milliseconds with 0 bytes received",
  'kex_exchange_identification: read: Connection timed out',
  'git -C repo fetch --quiet --prune origin timed out after 600 s',
  'dial tcp: lookup api.github.com on 192.0.2.53:53: read udp 192.0.2.2:5353->192.0.2.53:53: i/o timeout',
  'Get "https://api.github.com/graphql": net/http: request canceled (Client.Timeout exceeded while awaiting headers)',
  'Post "https://api.github.com/graphql": context deadline exceeded',
]

// Failures of the call itself. They still count as errors.
const NOT_OUTAGES = [
  'HTTP 401: Bad credentials (https://api.github.com/graphql)',
  'HTTP 403: Resource not accessible by integration (https://api.github.com/repos/example/demo/pulls/11)',
  'HTTP 404: Not Found (https://api.github.com/repos/example/demo/pulls/12)',
  'HTTP 422: Validation Failed',
  'GraphQL: Could not resolve to a PullRequest with the number of 12. (repository.pullRequest)',
  "GraphQL: Could not resolve to a Repository with the name 'example/demo'. (repository)",
  'no pull requests found for branch "feat/a1"',
  'git@github.com: Permission denied (publickey).',
  'fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.',
  "fatal: unable to access 'https://github.com/example/demo.git/': The requested URL returned error: 403",
  'fatal: unable to access the remote',
  'fake gh: no rule for pr view 11 --json number',
  'gate down',
  " ! [rejected]        fix/timeout -> fix/timeout (fetch first)\nerror: failed to push some refs to 'https://github.com/example/demo.git'",
]

function failedView(text) {
  return new Error(`gh pr view 11 --json number exited 1: ${text}`)
}

test('githubUnavailable: a 5xx, a 429, a rate limit, DNS, a failed connection and a timeout are an outage', () => {
  for (const text of OUTAGES) {
    assert.equal(githubUnavailable(text), true, text)
    assert.equal(githubUnavailable(failedView(text)), true, text)
  }
})

test('githubUnavailable: 401, 403, 404, 422, an unknown PR, a refused key and a bare timeout are not', () => {
  for (const text of NOT_OUTAGES) {
    assert.equal(githubUnavailable(text), false, text)
    assert.equal(githubUnavailable(failedView(text)), false, text)
  }

  assert.equal(githubUnavailable(new Error('gate down')), false)
})

test('githubUnavailable reads what the tool said, never the command line', () => {
  const merge = new Error('gh pr merge 11 --subject fix: Server Error timed out exited 1: HTTP 422: Validation Failed')

  assert.equal(githubUnavailable(merge), false)
})

test('githubUnavailable: an AggregateError is an outage only when every error in it is one, whatever its message says', () => {
  const badGateway = failedView('HTTP 502: Bad Gateway')
  const refused = failedView('dial tcp 192.0.2.10:443: connect: connection refused')
  const denied = failedView('HTTP 401: Bad credentials')

  assert.equal(githubUnavailable(new AggregateError([badGateway, refused], 'two lookups failed')), true)
  assert.equal(githubUnavailable(new AggregateError([badGateway, denied], 'HTTP 502: Bad Gateway')), false)
  assert.equal(githubUnavailable(new AggregateError([], 'HTTP 502: Bad Gateway')), false)
})

test('githubUnavailable: right after a sleep, every failed gh or git command is an outage', () => {
  const afterSleep = { afterSleep: true }
  const view = failedView('fatal: unable to access the remote')
  const fetch = new Error('git -C repo fetch --quiet --prune origin exited 128: fatal: unable to access the remote')

  assert.equal(githubUnavailable(view, afterSleep), true)
  assert.equal(githubUnavailable(fetch, afterSleep), true)
  assert.equal(githubUnavailable(new AggregateError([view, fetch], 'two lookups failed'), afterSleep), true)

  assert.equal(githubUnavailable(view), false)
  assert.equal(githubUnavailable(fetch), false)
})

test('githubUnavailable: right after a sleep, an error that is no gh or git command still counts', () => {
  const afterSleep = { afterSleep: true }
  const gateDown = new Error('gate down')

  assert.equal(githubUnavailable(gateDown, afterSleep), false)
  assert.equal(githubUnavailable('fatal: unable to access the remote', afterSleep), false)
  assert.equal(githubUnavailable(new AggregateError([failedView('HTTP 401: Bad credentials'), gateDown], 'two failed'), afterSleep), false)
})

test('refreshOutsideDeps throws every failed lookup, so one that is not an outage still counts', async () => {
  const dir = makeRollout()
  fakeTools(dir, [
    { tool: 'gh', args: 'pr list --head feat/a1', code: 1, stderr: 'HTTP 502: Bad Gateway' },
    { tool: 'gh', args: 'pr list --head feat/a2', code: 1, stderr: 'HTTP 401: Bad credentials' },
  ])
  const manifest = loadManifest(dir, { only: ['A3'] })
  const ledger = { prs: { A1: { state: 'pending' }, A2: { state: 'pending' } }, event: () => {} }
  manifest.prs[0].deps = ['A1', 'A2']

  await assert.rejects(refreshOutsideDeps(manifest, ledger), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 2)
    assert.match(
      error.message,
      /^A1: gh pr list --head feat\/a1 .*HTTP 502: Bad Gateway\nA2: gh pr list --head feat\/a2 .*HTTP 401: Bad credentials$/,
    )
    assert.equal(githubUnavailable(error), false)
    assert.equal(githubUnavailable(error.errors[0]), true)

    return true
  })
})

// A fixture rollout whose gh answers from the rules, as in test/driver.test.mjs.
function scanningRollout(rules) {
  const dir = makeRollout()
  const tools = fakeTools(dir, rules)

  return { manifest: loadManifest(dir), calls: () => tools.calls().map((call) => call.args.join(' ')) }
}

const PR_ALERTS = 'repos/example/demo/code-scanning/alerts -f ref=refs/pull/11/head -f state=open -f per_page=100'
const BASE_ALERTS = 'repos/example/demo/code-scanning/alerts -f ref=refs/heads/main -f state=open -f per_page=100'

test('codeScanningFor reads the PR head and then the base, one page each', async () => {
  const { manifest, calls } = scanningRollout([
    { tool: 'gh', args: PR_ALERTS, stdout: [alertJson(3), alertJson(4), alertJson(8, { state: 'dismissed' })] },
    { tool: 'gh', args: BASE_ALERTS, stdout: [alertJson(3), alertJson(9)] },
  ])

  assert.deepEqual(await codeScanningFor(manifest, 11), { available: true, alerts: [mappedAlert(3), mappedAlert(4)], baseOpen: [3, 9] })
  assert.deepEqual(calls(), [`api -X GET ${PR_ALERTS} -f page=1`, `api -X GET ${BASE_ALERTS} -f page=1`])
})

test('codeScanningFor skips the base when the PR head has no open alert', async () => {
  const { manifest, calls } = scanningRollout([{ tool: 'gh', args: PR_ALERTS, stdout: [alertJson(8, { state: 'fixed' })] }])

  assert.deepEqual(await codeScanningFor(manifest, 11), { available: true, alerts: [], baseOpen: [] })
  assert.deepEqual(calls(), [`api -X GET ${PR_ALERTS} -f page=1`])
})

test('codeScanningFor reads the next page after a full one', async () => {
  const full = Array.from({ length: 100 }, (_, i) => alertJson(i + 1, { state: i === 0 ? 'fixed' : 'open' }))
  const { manifest, calls } = scanningRollout([
    { tool: 'gh', args: `${PR_ALERTS} -f page=2`, stdout: [alertJson(101)] },
    { tool: 'gh', args: PR_ALERTS, stdout: full },
    { tool: 'gh', args: BASE_ALERTS, stdout: [] },
  ])
  const scan = await codeScanningFor(manifest, 11)

  assert.equal(scan.alerts.length, 100)
  assert.deepEqual(scan.alerts.at(-1), mappedAlert(101))
  assert.deepEqual(scan.baseOpen, [])
  assert.deepEqual(calls(), [
    `api -X GET ${PR_ALERTS} -f page=1`,
    `api -X GET ${PR_ALERTS} -f page=2`,
    `api -X GET ${BASE_ALERTS} -f page=1`,
  ])
})

test('codeScanningFor: a repo without code scanning is unavailable, a server error rejects', async () => {
  const missing = scanningRollout([{ tool: 'gh', args: 'code-scanning/alerts', code: 1, stderr: 'gh: no analysis found (HTTP 404)' }])

  assert.deepEqual(await codeScanningFor(missing.manifest, 11), {
    available: false,
    reason: 'gh: no analysis found (HTTP 404)',
    alerts: [],
    baseOpen: [],
  })

  const broken = scanningRollout([{ tool: 'gh', args: 'code-scanning/alerts', code: 1, stderr: 'gh: Server Error (HTTP 500)' }])

  await assert.rejects(codeScanningFor(broken.manifest, 11), /exited 1: gh: Server Error \(HTTP 500\)/)
})

test('collectFacts reads code scanning for the PR, and not at all under ignore', async () => {
  const view = { number: 11, state: 'OPEN', headRefOid: HEAD, labels: [], author: { login: 'demo-bot' } }
  const rules = [
    { tool: 'gh', args: 'pr view 11', stdout: view },
    { tool: 'gh', args: 'pulls/11/reviews', stdout: [] },
    { tool: 'gh', args: 'check-runs', stdout: { check_runs: [] } },
    { tool: 'gh', args: PR_ALERTS, stdout: [] },
    { tool: 'git', stdout: '' },
  ]
  const ledger = { data: { halted: null }, prs: {} }

  const cases = [
    ['fix', { available: true, alerts: [], baseOpen: [] }, [`api -X GET ${PR_ALERTS} -f page=1`]],
    ['ignore', null, []],
  ]

  for (const [action, codeScanning, scanningCalls] of cases) {
    const { manifest, calls } = scanningRollout(rules)
    manifest.repo.codeScanning = { action, minSeverity: 'medium' }

    const facts = await collectFacts(manifest, manifest.prs[0], { pr: 11 }, ledger)

    assert.deepEqual(facts.codeScanning, codeScanning, action)
    assert.deepEqual(
      calls().filter((call) => call.includes('code-scanning')),
      scanningCalls,
      action,
    )
  }

  const closed = scanningRollout([{ tool: 'gh', args: 'pr view 11', stdout: { ...view, state: 'CLOSED' } }])

  assert.equal((await collectFacts(closed.manifest, closed.manifest.prs[0], { pr: 11 }, ledger)).codeScanning, null)
})
