import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commentAsAgents,
  deleteRemoteBranch,
  ensureLabel,
  maintainerFeedback,
  parseAddedLines,
  parseCommits,
  parseNameStatus,
  remoteRepo,
  replyAsAgents,
} from '../lib/github.mjs'

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

const M = { repo: { maintainers: ['maint'] } }

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

  assert.deepEqual(maintainerFeedback(M, { inline, reviews, conversation }), [
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
  const feedback = maintainerFeedback(M, {
    inline: [inlineComment(11, 'maint', '2026-01-01T00:00:00Z', 'Renamed (abc1234)\r\n\r\n<!-- rollout-driver -->')],
    reviews: [review(21, 'maint', '2026-01-01T00:01:00Z', 'COMMENTED', 'Done\n\n<!-- rollout-driver -->\n')],
    conversation: [conversationComment(31, 'maint', '2026-01-01T00:02:00Z', 'Review comments addressed:\n\n<!-- rollout-driver -->')],
  })

  assert.deepEqual(feedback, [])
})

test('maintainer feedback still counts a marker that is not the last line', () => {
  const feedback = maintainerFeedback(M, {
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
    const M = { repo: { path: dir, github: 'example/demo', pathPrepend: [dir], agentToken: null, maintainers: ['maint'] } }

    await replyAsAgents(M, 7, 101, 'Renamed the helper (abc1234)')
    await commentAsAgents(M, 7, 'Review comments addressed:\n\n- "x": done (abc1234)')

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

    const feedback = maintainerFeedback(M, {
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
    const M = {
      label: 'rollout:demo',
      repo: { path: dir, github: 'example/demo', pathPrepend: [dir], agentToken: null, maintainers: ['maint'] },
    }

    await ensureLabel(M)
    await deleteRemoteBranch(M, 'feat/x')
    await replyAsAgents(M, 7, 101, 'Done')
    await commentAsAgents(M, 7, 'Done')

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
