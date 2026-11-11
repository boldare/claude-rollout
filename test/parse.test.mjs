import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, GitHubError } from '../lib/gh.mjs'
import {
  alertsFrom,
  baseChecks,
  checksFor,
  codeScanningFor,
  codeScanningUnavailable,
  collectFacts,
  commentAsAgents,
  deleteRemoteBranch,
  DRIVER_MARKER,
  ensureLabel,
  feedbackFor,
  findPr,
  findReleasePr,
  forgetPr,
  ghError,
  githubUnavailable,
  maintainerFeedback,
  merge,
  mergeCommit,
  mergeRefusal,
  parseAddedLines,
  parseCommits,
  parseNameStatus,
  patchId,
  prNotFound,
  refreshOutsideDeps,
  remoteRepo,
  replyAsAgents,
  reviewsFor,
  setFetch,
  setStageLabels,
  tickReads,
  unmergedHeads,
  viewPr,
} from '../lib/github.mjs'
import { githubApproval } from '../lib/judge.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { fakeGitHub, fakeTools, makeRollout, withProcessEnv } from './fixtures.mjs'

function nulRecords(...records) {
  return records.map((record) => `${record.join('\0')}\0`).join('')
}

test('name-status reads NUL records with renames, deletions, type changes and names that hold any byte but NUL', () => {
  const out = nulRecords(
    ['M', 'README.md'],
    ['A', '.changeset/a.md'],
    ['D', 'packages/core/src/quick-hash.ts'],
    ['R087', 'old/x.ts', 'new/x.ts'],
    ['T', 'bin/link'],
    ['A', 'secrets/a\tb.txt'],
    ['A', 'secrets/a\nb.txt'],
    ['M', 'docs/"quoted".md'],
  )

  assert.deepEqual(parseNameStatus(out), [
    { status: 'modified', path: 'README.md' },
    { status: 'added', path: '.changeset/a.md' },
    { status: 'removed', path: 'packages/core/src/quick-hash.ts' },
    { status: 'renamed', path: 'new/x.ts', previousPath: 'old/x.ts' },
    { status: 'type-changed', path: 'bin/link' },
    { status: 'added', path: 'secrets/a\tb.txt' },
    { status: 'added', path: 'secrets/a\nb.txt' },
    { status: 'modified', path: 'docs/"quoted".md' },
  ])

  assert.deepEqual(parseNameStatus(''), [])
})

test('name-status throws on an unknown status and on a record cut short', () => {
  assert.throws(() => parseNameStatus(nulRecords(['M', 'a.txt'], ['X', 'b.txt'])), /unknown status "X"/)
  assert.throws(() => parseNameStatus(nulRecords(['U', 'a.txt'])), /unknown status "U"/)
  assert.throws(() => parseNameStatus(nulRecords(['M', 'a.txt'], ['R100', 'old.txt'])), /ends inside the record of "R100"/)
  assert.throws(() => parseNameStatus(nulRecords(['M'])), /ends inside the record of "M"/)
})

// One section of each shape `diff -U0 --text` prints, in the order of SECTION_FILES.
const SECTIONS = [
  'diff --git a/notes.md b/notes.md',
  'index 1111111..2222222 100644',
  '--- a/notes.md',
  '+++ b/notes.md',
  '@@ -2 +2,4 @@',
  '-old line',
  '\\ No newline at end of file',
  '+++ starts like a file header',
  '+-- starts like the other one',
  '+diff --git a/x b/x',
  '+after them',
  '@@ -9,0 +12 @@ function context',
  '+second hunk',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index 3333333..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-bye',
  '-again',
  'diff --git a/link b/link',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/link',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-was a file',
  'diff --git a/link b/link',
  'new file mode 120000',
  'index 0000000..5555555',
  '--- /dev/null',
  '+++ b/link',
  '@@ -0,0 +1 @@',
  '+target.txt',
  '\\ No newline at end of file',
  'diff --git a/run.sh b/run.sh',
  'old mode 100644',
  'new mode 100755',
  'diff --git a/old/name.txt b/new/name.txt',
  'similarity index 90%',
  'rename from old/name.txt',
  'rename to new/name.txt',
  'index 6666666..7777777 100644',
  '--- a/old/name.txt',
  '+++ b/new/name.txt',
  '@@ -3 +3 @@',
  '-three',
  '+drei',
  'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
  'new file mode 100644',
  'index 0000000..8888888',
  '--- /dev/null',
  '+++ "b/caf\\303\\251.md"',
  '@@ -0,0 +1 @@',
  '+quoted name',
]

const SECTION_FILES = [
  { status: 'modified', path: 'notes.md' },
  { status: 'removed', path: 'gone.txt' },
  { status: 'type-changed', path: 'link' },
  { status: 'modified', path: 'run.sh' },
  { status: 'renamed', path: 'new/name.txt', previousPath: 'old/name.txt' },
  { status: 'added', path: 'caf\u00e9.md' },
]

function diffOf(lines) {
  return `${lines.join('\n')}\n`
}

test('added lines are read by hunk counts, never by what a line looks like', () => {
  assert.deepEqual(parseAddedLines(diffOf(SECTIONS), SECTION_FILES), [
    { path: 'notes.md', text: '++ starts like a file header' },
    { path: 'notes.md', text: '-- starts like the other one' },
    { path: 'notes.md', text: 'diff --git a/x b/x' },
    { path: 'notes.md', text: 'after them' },
    { path: 'notes.md', text: 'second hunk' },
    { path: 'link', text: 'target.txt' },
    { path: 'new/name.txt', text: 'drei' },
    { path: 'caf\u00e9.md', text: 'quoted name' },
  ])

  assert.deepEqual(parseAddedLines('', []), [])
})

test('added lines throw on a diff that does not fit the file list or its hunk counts', () => {
  const notes = SECTIONS.slice(0, 13)
  const gone = SECTIONS.slice(13, 21)
  const [notesFile, goneFile] = SECTION_FILES

  assert.equal(parseAddedLines(diffOf([...notes, ...gone]), [notesFile, goneFile]).length, 5)

  const cases = [
    [[...notes, ...gone], [notesFile], /^line 14 of the diff starts a section the file list does not have/],
    [notes, [notesFile, goneFile], /^the diff ends after section 1 of 2$/],
    [notes, [{ status: 'type-changed', path: 'notes.md' }], /^the diff ends after section 1 of 2$/],
    [['index 1111111..2222222', ...notes], [notesFile], /^line 1 of the diff comes before the first section/],
    [notes.toSpliced(6, 0, 'stray'), [notesFile], /^line 7 of the diff does not fit its hunk: "stray"$/],
    [notes.toSpliced(6, 0, ''), [notesFile], /^line 7 of the diff does not fit its hunk: ""$/],
    [[...notes, '+one too many'], [notesFile], /^line 14 of the diff follows a finished hunk/],
    [notes.slice(0, -1), [notesFile], /^the diff ends inside a hunk of "notes\.md"$/],
    [notes.toSpliced(4, 1, '@@ -2 +2,x @@'), [notesFile], /^line 5 of the diff is not a hunk header/],
  ]

  for (const [diffLines, files, message] of cases) {
    assert.throws(() => parseAddedLines(diffOf(diffLines), files), { message }, String(message))
  }

  const binary = ['diff --git a/logo.png b/logo.png', 'index 1111111..2222222 100644', 'Binary files a/logo.png and b/logo.png differ']

  assert.throws(
    () => parseAddedLines(diffOf(binary), [{ status: 'modified', path: 'logo.png' }]),
    /line 3 of the diff is a binary patch, which --text should have printed as lines/,
  )

  const literal = ['diff --git a/logo.png b/logo.png', 'index 1111111..2222222 100644', 'GIT binary patch', 'literal 3']

  assert.throws(() => parseAddedLines(diffOf(literal), [{ status: 'modified', path: 'logo.png' }]), /line 3 of the diff is a binary patch/)
})

test('commits split on record separators and keep bodies', () => {
  const out = 'aaa\x1ffix: one\n\x1e\nbbb\x1ffix: two\n\nbody line\n\x1e\n'
  assert.deepEqual(parseCommits(out), [
    { sha: 'aaa', message: 'fix: one' },
    { sha: 'bbb', message: 'fix: two\n\nbody line' },
  ])
})

const maintained = { repo: { maintainers: ['maint'] } }

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

  assert.deepEqual(maintainerFeedback(maintained, { inline, reviews, conversation }), [
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
  const feedback = maintainerFeedback(maintained, {
    inline: [inlineComment(11, 'maint', '2026-01-01T00:00:00Z', 'Renamed (abc1234)\r\n\r\n<!-- rollout-driver -->')],
    reviews: [review(21, 'maint', '2026-01-01T00:01:00Z', 'COMMENTED', 'Done\n\n<!-- rollout-driver -->\n')],
    conversation: [conversationComment(31, 'maint', '2026-01-01T00:02:00Z', 'Review comments addressed:\n\n<!-- rollout-driver -->')],
  })

  assert.deepEqual(feedback, [])
})

test('maintainer feedback still counts a marker that is not the last line', () => {
  const feedback = maintainerFeedback(maintained, {
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

const MAINTAINER_TOKEN = 'synthetic-maintainer-token'
const AGENT_TOKEN = 'synthetic-agent-token'
const PR_11 = 'repos/example/widgets/pulls/11'
const PULLS = 'repos/example/widgets/pulls'
const REPOSITORY = { path: 'repos/example/widgets', body: { full_name: 'example/widgets' } }

// Every client built from now on reads this fake GitHub.
function useGitHub(routes = []) {
  const github = fakeGitHub(routes)

  setFetch(github.fetch, { token: async () => MAINTAINER_TOKEN })

  return github
}

// Enough of a manifest for the GitHub reads and writes, with no rollout directory.
function plainManifest(repo = {}) {
  return {
    label: 'rollout:demo',
    repo: { path: tmpdir(), github: 'example/widgets', pathPrepend: [], agentToken: null, maintainers: [], ...repo },
  }
}

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }

  assert.fail('the call did not fail')
}

// The GitHubError the client throws when the fake answers one GET of PR 11 with `answer`.
function githubError(answer) {
  const github = fakeGitHub([{ path: PR_11, ...answer }])
  const client = createClient(plainManifest(), { fetch: github.fetch, token: async () => MAINTAINER_TOKEN, timeoutMs: 50 })

  return rejection(client.request('GET', PR_11))
}

test('the driver posts as the agents, marks what it posts and never reads it back as feedback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-gh-'))
  const github = useGitHub([
    { method: 'POST', path: 'repos/example/widgets/pulls/7/comments/101/replies', status: 201, body: { id: 102 } },
    { method: 'POST', path: 'repos/example/widgets/issues/7/comments', status: 201, body: { id: 103 } },
  ])

  try {
    const manifest = plainManifest({ agentToken: join(dir, 'agent-token'), maintainers: ['maint'] })

    writeFileSync(manifest.repo.agentToken, `${AGENT_TOKEN}\n`)
    await replyAsAgents(manifest, 7, 101, 'Renamed the helper (abc1234)')
    await commentAsAgents(manifest, 7, 'Review comments addressed:\n\n- "x": done (abc1234)')

    const [reply, comment] = github.requests()

    assert.deepEqual(reply.body, { body: `Renamed the helper (abc1234)\n\n${DRIVER_MARKER}` })
    assert.deepEqual(comment.body, { body: `Review comments addressed:\n\n- "x": done (abc1234)\n\n${DRIVER_MARKER}` })

    for (const request of [reply, comment]) {
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.authorization, `Bearer ${AGENT_TOKEN}`)
    }

    const feedback = maintainerFeedback(manifest, {
      inline: [{ ...inlineComment(12, 'maint', '2026-01-01T00:00:00Z', reply.body.body), in_reply_to_id: 101 }],
      reviews: [],
      conversation: [conversationComment(31, 'maint', '2026-01-01T00:01:00Z', comment.body.body)],
    })

    assert.deepEqual(feedback, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Records its arguments and the GH_REPO and GH_HOST it saw.
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const { GH_REPO, GH_HOST } = process.env
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), GH_REPO, GH_HOST }) + '\\n')
`

const HEAD = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
const MERGE_SHA = 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0'

test('every request goes to api.github.com for the manifest repo, and gh pr merge is pinned to it, whatever the environment says', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-gh-'))
  const github = useGitHub([
    { method: 'POST', path: 'repos/example/widgets/labels', status: 201, body: {} },
    { method: 'DELETE', path: 'repos/example/widgets/git/refs/heads/feat/x', status: 204 },
    { method: 'POST', path: 'repos/example/widgets/pulls/7/comments/101/replies', status: 201, body: {} },
    { method: 'POST', path: 'repos/example/widgets/issues/7/comments', status: 201, body: {} },
    { path: PR_11, body: { number: 11, state: 'closed', merged_at: '2026-10-01T12:00:00Z', merge_commit_sha: MERGE_SHA } },
  ])

  try {
    writeFileSync(join(dir, 'gh'), FAKE_GH, { mode: 0o755 })

    const manifest = plainManifest({ path: dir, pathPrepend: [dir], merge: { method: 'squash', admin: false } })
    const facts = { pr: { number: 11, headRefOid: HEAD, title: 'feat: A1', author: 'demo-bot' } }

    await withProcessEnv({ GH_REPO: 'someone/else', GH_HOST: 'ghe.example.com' }, async () => {
      await ensureLabel(manifest)
      await deleteRemoteBranch(manifest, 'feat/x')
      await replyAsAgents(manifest, 7, 101, 'Done')
      await commentAsAgents(manifest, 7, 'Done')

      assert.equal(await merge(manifest, {}, {}, facts), MERGE_SHA)
    })

    assert.equal(github.requests().length, 5)

    for (const request of github.requests()) {
      assert.ok(request.url.startsWith('https://api.github.com/repos/example/widgets/'), request.url)
    }

    const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

    assert.deepEqual(
      calls.map((call) => call.args.slice(0, 6)),
      [['pr', 'merge', '11', '--squash', '--match-head-commit', HEAD]],
    )

    assert.equal(calls[0].GH_REPO, 'github.com/example/widgets')
    assert.equal(calls[0].GH_HOST, 'github.com')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("merge: with admin auto, gh pr merge gets --admin for a maintainer's PR and not for the agents' PR", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-gh-'))
  const factsBy = (author) => ({ pr: { number: 11, headRefOid: HEAD, title: 'feat: A1', author } })

  useGitHub([{ path: PR_11, body: { number: 11, state: 'closed', merged_at: '2026-10-01T12:00:00Z', merge_commit_sha: MERGE_SHA } }])

  try {
    writeFileSync(join(dir, 'gh'), FAKE_GH, { mode: 0o755 })

    const manifest = plainManifest({ path: dir, pathPrepend: [dir], merge: { method: 'squash', admin: 'auto' }, maintainers: ['maint'] })

    await merge(manifest, {}, {}, factsBy('maint'))
    await merge(manifest, {}, {}, factsBy('demo-bot'))

    const [byMaintainer, byAgents] = readFileSync(join(dir, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).args)

    assert.deepEqual(byMaintainer.slice(0, 3), ['pr', 'merge', '11'])
    assert.ok(byMaintainer.includes('--admin'))
    assert.deepEqual(byAgents.slice(0, 3), ['pr', 'merge', '11'])
    assert.ok(!byAgents.includes('--admin'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deleteRemoteBranch encodes each segment of the branch, and keeps its slashes', async () => {
  const github = useGitHub([{ method: 'DELETE', path: 'repos/example/widgets/git/refs/heads/fix/a%20b%231/c', status: 204 }])

  await deleteRemoteBranch(plainManifest(), 'fix/a b#1/c')

  assert.deepEqual(
    github.requests().map((request) => [request.method, request.status]),
    [['DELETE', 204]],
  )
})

const LABELS = 'repos/example/widgets/labels'
const PR_LABELS = 'repos/example/widgets/issues/11/labels'
const STAGE_DESCRIPTION = 'Rollout stage, set by the driver'

test('ensureLabel creates the rollout label', async () => {
  const github = useGitHub([{ method: 'POST', path: LABELS, status: 201, body: { name: 'rollout:demo' } }])

  await ensureLabel(plainManifest())

  assert.deepEqual(github.requests()[0].body, { name: 'rollout:demo', color: '5319e7', description: 'Managed by the rollout driver' })
})

test('setStageLabels creates each label, updates one that exists, adds them and removes the old ones, names encoded', async () => {
  const github = useGitHub([
    { method: 'POST', path: LABELS, status: 422, body: { message: 'Validation Failed' } },
    { method: 'PATCH', path: `${LABELS}/rollout-stage%3Averifying`, body: {} },
    { method: 'POST', path: PR_LABELS, body: [] },
    { method: 'DELETE', path: `${PR_LABELS}/rollout-stage%3Aneeds-fix`, body: [] },
    { method: 'DELETE', path: `${PR_LABELS}/rollout-reason%3Averifier-findings`, status: 404, body: { message: 'Label does not exist' } },
  ])

  await setStageLabels(plainManifest(), 11, {
    add: ['rollout-stage:verifying'],
    remove: ['rollout-stage:needs-fix', 'rollout-reason:verifier-findings'],
  })

  assert.deepEqual(
    github.requests().map((request) => [request.method, request.path, request.body, request.status]),
    [
      ['POST', LABELS, { name: 'rollout-stage:verifying', color: '1d76db', description: STAGE_DESCRIPTION }, 422],
      ['PATCH', `${LABELS}/rollout-stage%3Averifying`, { color: '1d76db', description: STAGE_DESCRIPTION }, 200],
      ['POST', PR_LABELS, { labels: ['rollout-stage:verifying'] }, 200],
      ['DELETE', `${PR_LABELS}/rollout-stage%3Aneeds-fix`, null, 200],
      ['DELETE', `${PR_LABELS}/rollout-reason%3Averifier-findings`, null, 404],
    ],
  )
})

test('setStageLabels rejects what GitHub refuses, other than a label that is off already', async () => {
  useGitHub([
    { method: 'POST', path: LABELS, status: 403, body: { message: 'Resource not accessible by integration' } },
    {
      method: 'DELETE',
      path: `${PR_LABELS}/rollout-stage%3Averified`,
      status: 403,
      body: { message: 'Resource not accessible by integration' },
    },
  ])

  const manifest = plainManifest()

  await assert.rejects(setStageLabels(manifest, 11, { add: ['rollout-stage:verifying'], remove: [] }), /^GitHubError: POST .* HTTP 403/)
  await assert.rejects(setStageLabels(manifest, 11, { add: [], remove: ['rollout-stage:verified'] }), /^GitHubError: DELETE .* HTTP 403/)
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

// A pull request as the REST API answers it, written out here so the mapping
// is checked against GitHub's names and not against a fixture of the same code.
const REST_PR = {
  number: 11,
  state: 'open',
  draft: true,
  title: 'feat: widgets',
  body: 'Adds the widgets.',
  labels: [{ name: 'rollout:demo' }, { name: 'rollout-stage:verified' }],
  user: { login: 'demo-bot' },
  html_url: 'https://github.com/example/widgets/pull/11',
  base: { ref: 'main', sha: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0' },
  head: { ref: 'feat/widgets', sha: HEAD },
  mergeable: true,
  mergeable_state: 'blocked',
  merged_at: null,
  merge_commit_sha: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
}

test('viewPr maps the REST pull request to the names the gate reads', async () => {
  useGitHub([{ path: PR_11, body: REST_PR }])

  assert.deepEqual(await viewPr(plainManifest(), 11), {
    number: 11,
    state: 'OPEN',
    isDraft: true,
    baseRefName: 'main',
    headRefName: 'feat/widgets',
    headRefOid: HEAD,
    labels: ['rollout:demo', 'rollout-stage:verified'],
    title: 'feat: widgets',
    body: 'Adds the widgets.',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    mergedAt: null,
    url: 'https://github.com/example/widgets/pull/11',
    author: 'demo-bot',
  })
})

test('viewPr: the state, mergeable, a missing mergeable_state, a null body and a deleted author', async () => {
  const cases = [
    [
      { state: 'open', merged_at: null },
      { state: 'OPEN', mergedAt: null },
    ],
    [
      { state: 'closed', merged_at: null },
      { state: 'CLOSED', mergedAt: null },
    ],
    [
      { state: 'closed', merged_at: '2026-10-01T12:00:00Z' },
      { state: 'MERGED', mergedAt: '2026-10-01T12:00:00Z' },
    ],
    [{ mergeable: true }, { mergeable: 'MERGEABLE' }],
    [{ mergeable: false }, { mergeable: 'CONFLICTING' }],
    [{ mergeable: null }, { mergeable: 'UNKNOWN' }],
    [{ mergeable_state: undefined }, { mergeStateStatus: 'UNKNOWN' }],
    [
      { mergeable_state: 'clean', draft: false },
      { mergeStateStatus: 'CLEAN', isDraft: false },
    ],
    [{ body: null }, { body: '' }],
    [{ user: null }, { author: null }],
  ]

  for (const [fields, expected] of cases) {
    useGitHub([{ path: PR_11, body: { ...REST_PR, ...fields } }])

    const githubPr = await viewPr(plainManifest(), 11)
    const picked = Object.fromEntries(Object.keys(expected).map((name) => [name, githubPr[name]]))

    assert.deepEqual(picked, expected, JSON.stringify(fields))
  }
})

test('viewPr of an unchanged PR asks with its ETag, and the 304 gives the same PR', async () => {
  const github = useGitHub([{ path: PR_11, body: REST_PR }])
  const manifest = plainManifest()
  const first = await viewPr(manifest, 11)
  const second = await viewPr(manifest, 11)

  assert.deepEqual(
    github.requests().map((request) => request.status),
    [200, 304],
  )

  assert.equal(github.requests()[0].headers['if-none-match'], undefined)
  assert.match(github.requests()[1].headers['if-none-match'], /^"\w+"$/)
  assert.deepEqual(second, first)
})

test('mergeCommit is the merge commit of a merged PR, and nothing for an open one, whose merge_commit_sha is a test merge', async () => {
  useGitHub([{ path: PR_11, body: REST_PR }])

  assert.equal(await mergeCommit(plainManifest(), 11), null)

  useGitHub([{ path: PR_11, body: { ...REST_PR, state: 'closed', merged_at: '2026-10-01T12:00:00Z', merge_commit_sha: MERGE_SHA } }])

  assert.equal(await mergeCommit(plainManifest(), 11), MERGE_SHA)
})

test('findPr asks once for the branch from the repository owner, and takes the open PR, then the merged one, then the first', async () => {
  const closed = { ...REST_PR, number: 9, state: 'closed' }
  const merged = { ...REST_PR, number: 10, state: 'closed', merged_at: '2026-10-01T12:00:00Z' }
  const open = { ...REST_PR, number: 11, mergeable: undefined, mergeable_state: undefined }
  const github = useGitHub([{ path: PULLS, query: { head: 'example:feat/widgets' }, body: [closed, merged, open] }])
  const found = await findPr(plainManifest(), 'feat/widgets')

  assert.equal(found.number, 11)
  assert.equal(found.mergeable, 'UNKNOWN')
  assert.equal(found.mergeStateStatus, 'UNKNOWN')
  assert.deepEqual(github.requests()[0].query, { head: 'example:feat/widgets', state: 'all', per_page: '10' })

  useGitHub([{ path: PULLS, body: [closed, merged] }])
  assert.equal((await findPr(plainManifest(), 'feat/widgets')).number, 10)

  useGitHub([{ path: PULLS, body: [closed] }])
  assert.equal((await findPr(plainManifest(), 'feat/widgets')).number, 9)

  useGitHub([{ path: PULLS, body: [] }])
  assert.equal(await findPr(plainManifest(), 'feat/widgets'), null)
})

test('findReleasePr finds the open PR with a never-merge title on any page', async () => {
  const others = Array.from({ length: 100 }, (_, i) => ({ ...REST_PR, number: i + 1, title: `feat: ${i + 1}` }))
  const release = { ...REST_PR, number: 101, title: ' chore: version packages ', head: { ref: 'changeset-release/main', sha: HEAD } }
  const github = useGitHub([{ path: PULLS, query: { state: 'open' }, body: [...others, release] }])
  const manifest = plainManifest({ neverMerge: { titles: ['chore: version packages'] } })

  assert.deepEqual(await findReleasePr(manifest), {
    number: 101,
    title: ' chore: version packages ',
    headRefName: 'changeset-release/main',
    url: 'https://github.com/example/widgets/pull/11',
  })

  assert.equal(github.requests().length, 2)

  useGitHub([{ path: PULLS, query: { state: 'open' }, body: others }])
  assert.equal(await findReleasePr(manifest), null)
})

// One alert as the code scanning API returns it, trimmed.
function alertJson(number, overrides = {}) {
  return {
    number,
    state: 'open',
    html_url: `https://github.com/example/widgets/security/code-scanning/${number}`,
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
    url: `https://github.com/example/widgets/security/code-scanning/${number}`,
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
      url: 'https://github.com/example/widgets/security/code-scanning/5',
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

test('codeScanningUnavailable: a 404 or a 403 that is no rate limit means no code scanning, a 403 rate limit or a 500 does not', async () => {
  const missing = await githubError({ status: 404, body: { message: 'no analysis found' } })
  const off = await githubError({
    status: 403,
    body: { message: 'Advanced Security must be enabled for this repository to use code scanning.' },
  })

  const limited = await githubError({
    status: 403,
    body: { message: 'API rate limit exceeded for user ID 1.' },
    headers: { 'x-ratelimit-remaining': '0' },
  })

  const broken = await githubError({ status: 500, body: { message: 'Server Error' } })

  assert.equal(codeScanningUnavailable(missing), true)
  assert.equal(codeScanningUnavailable(off), true)
  assert.equal(codeScanningUnavailable(limited), false)
  assert.equal(codeScanningUnavailable(broken), false)
  assert.equal(
    codeScanningUnavailable(new Error('gh api repos/example/widgets/code-scanning/alerts exited 1: gh: no analysis found (HTTP 404)')),
    false,
  )
})

// git's own words when the network is down or slow, and shOk's for a command it killed.
const GIT_OUTAGES = [
  "fatal: unable to access 'https://github.com/example/widgets.git/': Could not resolve host: github.com",
  'ssh: connect to host github.com port 22: Connection refused',
  'kex_exchange_identification: read: Connection reset by peer',
  "fatal: unable to access 'https://github.com/example/widgets.git/': Operation timed out after 300000 milliseconds with 0 bytes received",
  'fetch-pack: unexpected disconnect while reading sideband packet\nfatal: early EOF',
  'fatal: the remote end hung up unexpectedly',
  'git -C repo fetch --quiet --prune origin timed out after 600 s',
]

// Failures of the call itself, and what gh used to print for an outage,
// which only git's words or a GitHub request's status now make one.
const NOT_OUTAGES = [
  'HTTP 502: Bad Gateway',
  'gh: Server Error (HTTP 500)',
  'HTTP 429: Too Many Requests',
  'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
  'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com',
  'HTTP 401: Bad credentials (https://api.github.com/graphql)',
  'HTTP 422: Validation Failed',
  'GraphQL: Could not resolve to a PullRequest with the number of 12. (repository.pullRequest)',
  'git@github.com: Permission denied (publickey).',
  'fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.',
  "fatal: unable to access 'https://github.com/example/widgets.git/': The requested URL returned error: 403",
  'fatal: unable to access the remote',
  'gate down',
  " ! [rejected]        fix/timeout -> fix/timeout (fetch first)\nerror: failed to push some refs to 'https://github.com/example/widgets.git'",
]

function failedFetch(text) {
  return new Error(`git -C repo fetch --quiet --prune origin exited 128: ${text}`)
}

test('githubUnavailable: a 5xx, a failed connection, no answer in time and a rate limit from GitHub are an outage', async () => {
  const outages = [
    await githubError({ status: 500, body: { message: 'Server Error' } }),
    await githubError({ status: 502 }),
    await githubError({ error: 'ECONNRESET' }),
    await githubError({ hang: true }),
    await githubError({ status: 429, body: { message: 'Too Many Requests' } }),
    await githubError({ status: 403, body: { message: 'You have exceeded a secondary rate limit.' } }),
  ]

  for (const error of outages) {
    assert.ok(error instanceof GitHubError, String(error))
    assert.equal(githubUnavailable(error), true, String(error))
  }
})

test('githubUnavailable: a 401, a 403 that is no rate limit, a 404 and a 422 from GitHub are not', async () => {
  const failures = [
    await githubError({ status: 401, body: { message: 'Bad credentials' } }),
    await githubError({ status: 403, body: { message: 'Resource not accessible by integration' } }),
    await githubError({ status: 404, body: { message: 'Not Found' } }),
    await githubError({ status: 422, body: { message: 'Validation Failed' } }),
    await githubError({ status: 400, body: { message: 'Problems parsing JSON' } }),
  ]

  for (const error of failures) {
    assert.ok(error instanceof GitHubError, String(error))
    assert.equal(githubUnavailable(error), false, String(error))
  }
})

test("githubUnavailable: git's six messages are an outage", () => {
  for (const text of GIT_OUTAGES) {
    assert.equal(githubUnavailable(text), true, text)
    assert.equal(githubUnavailable(failedFetch(text)), true, text)
  }
})

test("githubUnavailable: gh's old texts for an outage, a refused key and a bare timeout are not", () => {
  for (const text of NOT_OUTAGES) {
    assert.equal(githubUnavailable(text), false, text)
    assert.equal(githubUnavailable(failedFetch(text)), false, text)
  }

  assert.equal(githubUnavailable(new Error('gate down')), false)
})

test('githubUnavailable reads what the tool said, never the command line', () => {
  const failedMerge = new Error('gh pr merge 11 --subject fix: Server Error timed out exited 1: HTTP 422: Validation Failed')

  assert.equal(githubUnavailable(failedMerge), false)
})

test('githubUnavailable: an AggregateError is an outage only when every error in it is one, whatever its message says', async () => {
  const badGateway = await githubError({ status: 502 })
  const reset = await githubError({ error: 'ECONNRESET' })
  const denied = await githubError({ status: 401, body: { message: 'Bad credentials' } })

  assert.equal(githubUnavailable(new AggregateError([badGateway, reset], 'two lookups failed')), true)
  assert.equal(githubUnavailable(new AggregateError([badGateway, denied], 'HTTP 502: Bad Gateway')), false)
  assert.equal(githubUnavailable(new AggregateError([], 'HTTP 502: Bad Gateway')), false)
})

test('githubUnavailable: right after a sleep, every failed GitHub request and every failed gh or git command is an outage', async () => {
  const afterSleep = { afterSleep: true }
  const denied = await githubError({ status: 401, body: { message: 'Bad credentials' } })
  const failedMerge = new Error('gh pr merge 11 --squash exited 1: error connecting to api.github.com')
  const fetch = failedFetch('fatal: unable to access the remote')

  assert.equal(githubUnavailable(denied, afterSleep), true)
  assert.equal(githubUnavailable(failedMerge, afterSleep), true)
  assert.equal(githubUnavailable(fetch, afterSleep), true)
  assert.equal(githubUnavailable(new AggregateError([denied, fetch], 'two lookups failed'), afterSleep), true)

  assert.equal(githubUnavailable(denied), false)
  assert.equal(githubUnavailable(failedMerge), false)
  assert.equal(githubUnavailable(fetch), false)
})

test('githubUnavailable: right after a sleep, an error that is no GitHub request or gh or git command still counts', async () => {
  const afterSleep = { afterSleep: true }
  const gateDown = new Error('gate down')
  const denied = await githubError({ status: 401, body: { message: 'Bad credentials' } })

  assert.equal(githubUnavailable(gateDown, afterSleep), false)
  assert.equal(githubUnavailable('fatal: unable to access the remote', afterSleep), false)
  assert.equal(githubUnavailable(new AggregateError([denied, gateDown], 'two failed'), afterSleep), false)
})

test("ghError: a GitHub request's detail, or what a command printed after its command line", async () => {
  assert.equal(ghError(await githubError({ status: 404, body: { message: 'Not Found' } })), 'HTTP 404: Not Found')
  assert.equal(ghError(new Error('git -C repo fetch origin exited 128: fatal: early EOF')), 'fatal: early EOF')
  assert.equal(ghError('fatal: early EOF'), 'fatal: early EOF')
})

const MERGE_COMMAND = `gh pr merge 11 --squash --match-head-commit ${HEAD} --subject feat: A1 (#11) --body `

test("mergeRefusal: gh's refusal from the merge state and the mutation's error are refusals", () => {
  const refusals = [
    'Pull request example/widgets#11 is not mergeable: the base branch policy prohibits the merge.',
    'GraphQL: Pull Request is not mergeable (mergePullRequest)',
  ]

  for (const text of refusals) {
    assert.equal(mergeRefusal(new Error(`${MERGE_COMMAND} exited 1: ${text}`)), true, text)
  }
})

test('mergeRefusal: "not mergeable" in the --subject of the command line is no refusal when gh said something else', () => {
  const titled = `gh pr merge 11 --squash --match-head-commit ${HEAD} --subject fix: say why a PR is not mergeable (#11) --body `

  assert.equal(mergeRefusal(new Error(`${titled} exited 1: HTTP 422: Validation Failed`)), false)
  assert.equal(
    mergeRefusal(new Error(`${MERGE_COMMAND} exited 1: GraphQL: Head branch was modified. Review and try the merge again.`)),
    false,
  )
})

// What viewPr rejects with for PR 12, and prNotFound's verdict on it.
async function unknownPr(routes) {
  const github = useGitHub(routes)
  const manifest = plainManifest()
  const error = await rejection(viewPr(manifest, 12))

  return { github, error, verdict: () => prNotFound(manifest, error) }
}

const PR_12 = 'repos/example/widgets/pulls/12'

test('prNotFound: a PR that answers 404 while the repository reads is unknown', async () => {
  const { github, verdict } = await unknownPr([{ path: PR_12, status: 404, body: { message: 'Not Found' } }, REPOSITORY])

  assert.equal(await verdict(), true)
  assert.deepEqual(
    github.requests().map((request) => [request.path, request.status]),
    [
      [PR_12, 404],
      ['repos/example/widgets', 200],
    ],
  )
})

test('prNotFound: a 404 for the repository too is no unknown PR, because a token without access gets both', async () => {
  const { verdict } = await unknownPr([
    { path: PR_12, status: 404, body: { message: 'Not Found' } },
    { path: 'repos/example/widgets', status: 404, body: { message: 'Not Found' } },
  ])

  assert.equal(await verdict(), false)
})

test('prNotFound: a repository read that fails otherwise rejects with its own error', async () => {
  const { verdict } = await unknownPr([
    { path: PR_12, status: 404, body: { message: 'Not Found' } },
    { path: 'repos/example/widgets', status: 502 },
  ])

  const error = await rejection(verdict())

  assert.ok(error instanceof GitHubError)
  assert.equal(error.status, 502)
  assert.equal(error.path, 'repos/example/widgets')
})

test('prNotFound: a PR read that fails with anything but a 404 is no unknown PR, and reads no repository', async () => {
  const { github, verdict } = await unknownPr([{ path: PR_12, status: 502 }, REPOSITORY])

  assert.equal(await verdict(), false)
  assert.equal(await prNotFound(plainManifest(), new Error('gh pr view 12 exited 1: HTTP 404: Not Found')), false)
  assert.deepEqual(
    github.requests().map((request) => request.path),
    [PR_12],
  )
})

test('refreshOutsideDeps throws every failed lookup, so one that is not an outage still counts', async () => {
  const dir = makeRollout()

  useGitHub([
    { path: PULLS, query: { head: 'example:feat/a1' }, status: 502 },
    { path: PULLS, query: { head: 'example:feat/a2' }, status: 401, body: { message: 'Bad credentials' } },
  ])

  const manifest = loadManifest(dir, { only: ['A3'] })
  const ledger = { prs: { A1: { state: 'pending' }, A2: { state: 'pending' } }, event: () => {} }
  manifest.prs[0].deps = ['A1', 'A2']

  await assert.rejects(refreshOutsideDeps(manifest, ledger), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 2)
    assert.equal(
      error.message,
      'A1: GET repos/example/widgets/pulls: HTTP 502: Bad Gateway\nA2: GET repos/example/widgets/pulls: HTTP 401: Bad credentials',
    )

    assert.equal(githubUnavailable(error), false)
    assert.equal(githubUnavailable(error.errors[0]), true)

    return true
  })
})

// A fixture rollout whose git answers the rules, as in test/driver-helpers.mjs,
// and whose GitHub answers the routes.
function scanningRollout(rules = [], routes = []) {
  const dir = makeRollout()
  const tools = fakeTools(dir, rules)
  const github = useGitHub(routes)

  return { manifest: loadManifest(dir), github, gitCalls: () => tools.calls().map((call) => call.args.join(' ')) }
}

const ALERTS = 'repos/example/widgets/code-scanning/alerts'
const PR_REF = { ref: 'refs/pull/11/head', state: 'open' }
const BASE_REF = { ref: 'refs/heads/main', state: 'open' }

function alertsRoute(query, body) {
  return { path: ALERTS, query, body }
}

function alertQueries(github) {
  return github
    .requests()
    .filter((request) => request.path === ALERTS)
    .map((request) => request.query)
}

test('codeScanningFor reads the PR head and then the base, one page each', async () => {
  const { manifest, github } = scanningRollout(
    [],
    [
      alertsRoute(PR_REF, [alertJson(3), alertJson(4), alertJson(8, { state: 'dismissed' })]),
      alertsRoute(BASE_REF, [alertJson(3), alertJson(9)]),
    ],
  )

  assert.deepEqual(await codeScanningFor(manifest, 11), { available: true, alerts: [mappedAlert(3), mappedAlert(4)], baseOpen: [3, 9] })
  assert.deepEqual(alertQueries(github), [
    { ...PR_REF, per_page: '100' },
    { ...BASE_REF, per_page: '100' },
  ])
})

test('codeScanningFor skips the base when the PR head has no open alert', async () => {
  const { manifest, github } = scanningRollout([], [alertsRoute(PR_REF, [alertJson(8, { state: 'fixed' })])])

  assert.deepEqual(await codeScanningFor(manifest, 11), { available: true, alerts: [], baseOpen: [] })
  assert.deepEqual(alertQueries(github), [{ ...PR_REF, per_page: '100' }])
})

test('codeScanningFor reads the next page GitHub links', async () => {
  const full = Array.from({ length: 101 }, (_, i) => alertJson(i + 1, { state: i === 0 ? 'fixed' : 'open' }))
  const { manifest, github } = scanningRollout([], [alertsRoute(PR_REF, full), alertsRoute(BASE_REF, [])])
  const scan = await codeScanningFor(manifest, 11)

  assert.equal(scan.alerts.length, 100)
  assert.deepEqual(scan.alerts.at(-1), mappedAlert(101))
  assert.deepEqual(scan.baseOpen, [])
  assert.deepEqual(alertQueries(github), [
    { ...PR_REF, per_page: '100' },
    { ...PR_REF, per_page: '100', page: '2' },
    { ...BASE_REF, per_page: '100' },
  ])
})

test('codeScanningFor: a repo without code scanning is unavailable, a server error or a rate limit rejects', async () => {
  const missing = scanningRollout([], [{ path: ALERTS, status: 404, body: { message: 'no analysis found' } }])

  assert.deepEqual(await codeScanningFor(missing.manifest, 11), {
    available: false,
    reason: 'HTTP 404: no analysis found',
    alerts: [],
    baseOpen: [],
  })

  const off = scanningRollout(
    [],
    [{ path: ALERTS, status: 403, body: { message: 'Advanced Security must be enabled for this repository.' } }],
  )

  assert.equal((await codeScanningFor(off.manifest, 11)).reason, 'HTTP 403: Advanced Security must be enabled for this repository.')

  const broken = scanningRollout([], [{ path: ALERTS, status: 500, body: { message: 'Server Error' } }])

  await assert.rejects(
    codeScanningFor(broken.manifest, 11),
    /^GitHubError: GET repos\/example\/widgets\/code-scanning\/alerts: HTTP 500: Server Error$/,
  )

  const limited = scanningRollout(
    [],
    [{ path: ALERTS, status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'retry-after': '60' } }],
  )

  await assert.rejects(codeScanningFor(limited.manifest, 11), (error) => error.kind === 'rate-limit')
})

const BASE_TIP = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0'

function runsRoute(sha, runs) {
  return {
    path: `repos/example/widgets/commits/${sha}/check-runs`,
    body: { total_count: runs.length, check_runs: runs },
    items: 'check_runs',
  }
}

test('collectFacts reads code scanning for the PR, and not at all under ignore', async () => {
  const view = { ...REST_PR, draft: false, head: { ref: 'feat/a1', sha: HEAD }, labels: [] }
  const rules = [
    { tool: 'git', args: 'rev-parse origin/main', stdout: `${BASE_TIP}\n` },
    { tool: 'git', stdout: '' },
  ]

  const routes = [
    { path: PR_11, body: view },
    { path: `${PR_11}/reviews`, body: [] },
    runsRoute(HEAD, []),
    runsRoute(BASE_TIP, []),
    alertsRoute(PR_REF, []),
  ]

  const ledger = { data: { halted: null }, prs: {} }

  const cases = [
    ['fix', { available: true, alerts: [], baseOpen: [] }, [{ ...PR_REF, per_page: '100' }]],
    ['ignore', null, []],
  ]

  for (const [action, codeScanning, scanningQueries] of cases) {
    const { manifest, github } = scanningRollout(rules, routes)
    manifest.repo.codeScanning = { action, minSeverity: 'medium' }

    const facts = await collectFacts(manifest, manifest.prs[0], { pr: 11 }, ledger)

    assert.deepEqual(facts.codeScanning, codeScanning, action)
    assert.deepEqual(alertQueries(github), scanningQueries, action)
  }

  const closed = scanningRollout([], [{ path: PR_11, body: { ...view, state: 'closed' } }])

  assert.equal((await collectFacts(closed.manifest, closed.manifest.prs[0], { pr: 11 }, ledger)).codeScanning, null)
})

// An open PR at HEAD whose every git read answers empty unless `rules` say otherwise.
function readsRollout(context, rules) {
  const view = { ...REST_PR, draft: false, head: { ref: 'feat/a1', sha: HEAD }, labels: [] }
  const rollout = scanningRollout(
    [...rules, { tool: 'git', args: 'rev-parse origin/main', stdout: `${BASE_TIP}\n` }, { tool: 'git', stdout: '' }],
    [{ path: PR_11, body: view }, { path: `${PR_11}/reviews`, body: [] }, runsRoute(HEAD, []), runsRoute(BASE_TIP, [])],
  )

  rollout.manifest.repo.codeScanning = { action: 'ignore' }
  context.after(() => rmSync(rollout.manifest.dir, { recursive: true, force: true }))

  return rollout
}

test('collectFacts states the options of every git read it makes', async (context) => {
  const { manifest, gitCalls } = readsRollout(context, [])
  const facts = await collectFacts(manifest, manifest.prs[0], { pr: 11 }, { data: { halted: null }, prs: {} })
  const repo = `-C ${manifest.repo.path}`

  assert.equal(facts.patchId, 'empty')
  assert.equal(facts.baseIsAncestor, true)
  assert.deepEqual(gitCalls(), [
    `${repo} cat-file -e ${HEAD}^{commit}`,
    `${repo} diff ${DIFF_FLAGS} -M -l1000 --name-status -z origin/main...${HEAD}`,
    `${repo} diff ${DIFF_FLAGS} -M -l1000 -U0 --text origin/main...${HEAD}`,
    `${repo} log --no-show-signature --no-color --encoding=UTF-8 --format=%H%x1f%B%x1e origin/main..${HEAD}`,
    `${repo} -c diff.suppressBlankEmpty=false -c core.quotePath=true diff ${DIFF_FLAGS} -M -l1000 -U3 --full-index origin/main...${HEAD}`,
    `${repo} merge-base --is-ancestor origin/main ${HEAD}`,
    `${repo} rev-parse origin/main`,
  ])
})

test('collectFacts throws when git cannot tell whether the base is an ancestor', async (context) => {
  const outcomes = [
    [{ code: 1 }, false],
    [
      { code: 128, stderr: 'fatal: Not a valid commit name\n' },
      /^cannot tell whether origin\/main is an ancestor of a1a1\w+: fatal: Not a valid commit name$/,
    ],
    [{ code: 2 }, /^cannot tell whether origin\/main is an ancestor of a1a1\w+: exit 2$/],
  ]

  for (const [answer, expected] of outcomes) {
    const { manifest } = readsRollout(context, [{ tool: 'git', args: 'merge-base --is-ancestor', ...answer }])
    const read = collectFacts(manifest, manifest.prs[0], { pr: 11 }, { data: { halted: null }, prs: {} })

    if (expected === false) {
      assert.equal((await read).baseIsAncestor, false)
    } else {
      await assert.rejects(read, (error) => {
        assert.match(error.message, expected)
        assert.equal(githubUnavailable(error, { afterSleep: true }), false)

        return true
      })
    }
  }
})

const SMALL_DIFF = diffOf([
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1 +1 @@',
  '-one',
  '+two',
])

test('patchId pipes the diff to patch-id and takes only a 40 or 64 digit hex id', async (context) => {
  async function idFrom(stdout) {
    const { manifest, gitCalls } = scanningRollout([
      { tool: 'git', args: 'patch-id', stdout },
      { tool: 'git', args: 'diff', stdout: SMALL_DIFF },
    ])

    context.after(() => rmSync(manifest.dir, { recursive: true, force: true }))

    return { read: patchId(manifest, 'origin/main', HEAD), calls: gitCalls, repo: manifest.repo.path }
  }

  const hex40 = 'a'.repeat(40)
  const zeros = '0'.repeat(40)
  const plain = await idFrom(`${hex40} ${zeros}\n`)

  assert.equal(await plain.read, hex40)
  assert.deepEqual(plain.calls(), [
    `-C ${plain.repo} -c diff.suppressBlankEmpty=false -c core.quotePath=true diff ${DIFF_FLAGS} -M -l1000 -U3 --full-index origin/main...${HEAD}`,
    `-C ${plain.repo} patch-id --verbatim`,
  ])

  assert.equal(await (await idFrom(`${'b'.repeat(64)} ${'0'.repeat(64)}\n`)).read, 'b'.repeat(64))

  const silent = await idFrom('')

  await assert.rejects(silent.read, (error) => {
    assert.equal(error.message, `patch-id printed no id for origin/main...${HEAD}: ""`)
    assert.equal(githubUnavailable(error, { afterSleep: true }), false)

    return true
  })

  for (const stdout of [
    `not-an-id ${zeros}\n`,
    `${'A'.repeat(40)} ${zeros}\n`,
    `${'a'.repeat(39)} ${zeros}\n`,
    'diff --git a/a.txt b/a.txt\n',
  ]) {
    await assert.rejects((await idFrom(stdout)).read, /^Error: patch-id printed no id for origin\/main\.\.\.a1a1\w+: "/, stdout)
  }
})

// Fake commits all have a name of the same length, so no sha is a prefix of
// another and every rule matches the call it was written for.
const GREEN_RUN = { id: 1, name: 'test', status: 'completed', conclusion: 'success' }

const DIFF_FLAGS = [
  '--no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ --diff-algorithm=myers',
  '--indent-heuristic --inter-hunk-context=0 -O/dev/null --no-relative --submodule=short --ignore-submodules=none',
].join(' ')

function historyRules(sha, parent, files) {
  return [
    { tool: 'git', args: `log --no-show-signature --no-color --encoding=UTF-8 -1 --format=%P ${sha}`, stdout: `${parent}\n` },
    {
      tool: 'git',
      args: `diff ${DIFF_FLAGS} --no-renames --name-only -z ${parent} ${sha}`,
      stdout: files.map((file) => `${file}\0`).join(''),
    },
  ]
}

function quietRollout(rules, routes, globs = ['docs/journal/**']) {
  const rollout = scanningRollout(rules, routes)

  rollout.manifest.repo.baseQuietPaths = globs

  return rollout
}

test('baseChecks takes the state of the parent when the tip has no runs and only touches the quiet paths', async () => {
  const { manifest, gitCalls } = quietRollout(historyRules('quiet00', 'quiet01', ['docs/journal/2026-10.md']), [
    runsRoute('quiet00', []),
    runsRoute('quiet01', [GREEN_RUN]),
  ])

  assert.deepEqual(await baseChecks(manifest, 'quiet00'), {
    state: 'green',
    missing: [],
    pending: [],
    failing: [],
    runs: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    sha: 'quiet01',
    skipped: 1,
  })

  assert.equal(gitCalls().filter((call) => call.includes('--name-only')).length, 1)
})

test('baseChecks stays on the tip when it changes a file outside the quiet paths', async () => {
  const { manifest } = quietRollout(historyRules('quiet00', 'quiet01', ['lib/driver.mjs']), [runsRoute('quiet00', [])])
  const checks = await baseChecks(manifest, 'quiet00')

  assert.equal(checks.state, 'pending')
  assert.equal(checks.sha, 'quiet00')
  assert.equal(checks.skipped, 0)
})

test('baseChecks reads no history without quiet paths, and none when the tip has a run', async () => {
  const off = quietRollout([], [runsRoute('quiet00', [])], [])

  assert.equal((await baseChecks(off.manifest, 'quiet00')).skipped, 0)
  assert.deepEqual(
    off.gitCalls().filter((call) => call.startsWith('-C')),
    [],
  )

  const tested = quietRollout([], [runsRoute('quiet00', [GREEN_RUN])])

  assert.equal((await baseChecks(tested.manifest, 'quiet00')).state, 'green')
  assert.deepEqual(
    tested.gitCalls().filter((call) => call.startsWith('-C')),
    [],
  )
})

test('baseChecks skips at most 20 quiet commits in a row', async () => {
  const names = Array.from({ length: 22 }, (_, i) => `quiet${String(i).padStart(2, '0')}`)
  const rules = names.slice(0, -1).flatMap((name, i) => historyRules(name, names[i + 1], ['docs/journal/2026-10.md']))
  const { manifest } = quietRollout(
    rules,
    names.map((name) => runsRoute(name, [])),
  )

  const checks = await baseChecks(manifest, names[0])

  assert.equal(checks.state, 'pending')
  assert.equal(checks.skipped, 20)
  assert.equal(checks.sha, 'quiet20')
})

const DOCS_RUN = { id: 2, name: 'docs deploy', status: 'completed', conclusion: 'success' }

test('baseChecks skips a quiet tip whose only runs are not required checks', async () => {
  const { manifest } = quietRollout(historyRules('quiet00', 'quiet01', ['docs/journal/2026-10.md']), [
    runsRoute('quiet00', [DOCS_RUN]),
    runsRoute('quiet01', [GREEN_RUN]),
  ])

  const checks = await baseChecks(manifest, 'quiet00')

  assert.equal(checks.state, 'green')
  assert.equal(checks.sha, 'quiet01')
  assert.equal(checks.skipped, 1)
})

test("baseChecks reads a tip once per tick's reads, and a commit shape once at all", async () => {
  const { manifest, github, gitCalls } = quietRollout(historyRules('quiet00', 'quiet01', ['docs/journal/2026-10.md']), [
    runsRoute('quiet00', []),
    runsRoute('quiet01', [GREEN_RUN]),
  ])

  const reads = tickReads()
  const runsReads = () => github.requests().filter((request) => request.path.endsWith('/check-runs'))
  const historyCalls = () => gitCalls().filter((call) => call.includes('--format=%P') || call.includes('--name-only')).length

  const first = await baseChecks(manifest, 'quiet00', { reads })
  const second = await baseChecks(manifest, 'quiet00', { reads })

  assert.equal(second, first)
  assert.equal(runsReads().length, 2)
  assert.equal(historyCalls(), 2)

  // A new tick reads the runs again, which can change, but not the history.
  // Runs that did not change answer 304.
  await baseChecks(manifest, 'quiet00', { reads: tickReads() })

  assert.deepEqual(
    runsReads().map((request) => request.status),
    [200, 200, 304, 304],
  )

  assert.equal(historyCalls(), 2)
})

const RUNS = `repos/example/widgets/commits/${HEAD}/check-runs`
const REVIEWS = `${PR_11}/reviews`
const CONVERSATION = 'repos/example/widgets/issues/11/comments'

function passingRuns(count, nameOf) {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, name: nameOf(i + 1), status: 'completed', conclusion: 'success' }))
}

const jobName = (id) => (id === 1 ? 'test' : `job ${id}`)

function queriesOf(github, path) {
  return github
    .requests()
    .filter((request) => request.path === path)
    .map((request) => request.query)
}

test('checksFor sees a failing run on the second page', async () => {
  const lint = { id: 101, name: 'lint', status: 'completed', conclusion: 'failure' }
  const { manifest, github } = scanningRollout([], [runsRoute(HEAD, [...passingRuns(100, jobName), lint])])

  const checks = await checksFor(manifest, HEAD)

  assert.equal(checks.state, 'red')
  assert.deepEqual(checks.failing, ['lint: failure'])
  assert.deepEqual(queriesOf(github, RUNS), [{ per_page: '100' }, { per_page: '100', page: '2' }])
})

test('checksFor finds a required check on the second page', async () => {
  const required = { id: 101, name: 'test', status: 'completed', conclusion: 'success' }
  const { manifest } = scanningRollout([], [runsRoute(HEAD, [...passingRuns(100, (id) => `docs ${id}`), required])])

  const checks = await checksFor(manifest, HEAD)

  assert.equal(checks.state, 'green')
  assert.deepEqual(checks.missing, [])
})

test('reviewsFor reads a maintainer approval on the second page', async () => {
  const others = Array.from({ length: 99 }, (_, i) => review(i + 1, 'demo-bot', '2026-10-01T09:00:00Z', 'COMMENTED', 'ok'))
  const { manifest } = scanningRollout(
    [],
    [
      {
        path: REVIEWS,
        body: [
          ...others,
          review(100, 'maint', '2026-10-01T10:00:00Z', 'CHANGES_REQUESTED', 'fix it'),
          review(101, 'maint', '2026-10-01T12:00:00Z', 'APPROVED', ''),
        ],
      },
    ],
  )

  manifest.repo.maintainers = ['maint']

  const approval = githubApproval(
    manifest,
    { patchSince: '2026-10-01T08:00:00Z' },
    { reviews: await reviewsFor(manifest, 11), pr: { number: 11 } },
  )

  assert.deepEqual(approval, { approved: true, by: 'maint', at: '2026-10-01T12:00:00Z' })
})

test('feedbackFor reads a maintainer comment on the second page', async () => {
  const others = Array.from({ length: 100 }, (_, i) => conversationComment(i + 1, 'demo-bot', '2026-10-01T09:00:00Z', 'status'))
  const { manifest, github } = scanningRollout(
    [],
    [
      { path: CONVERSATION, body: [...others, conversationComment(101, 'maint', '2026-10-01T10:00:00Z', 'Rename it.')] },
      { path: `${PR_11}/comments`, body: [] },
      { path: REVIEWS, body: [] },
    ],
  )

  manifest.repo.maintainers = ['maint']

  assert.deepEqual(await feedbackFor(manifest, 11), [{ id: 'conversation-101', at: '2026-10-01T10:00:00Z', body: 'Rename it.' }])
  assert.deepEqual(queriesOf(github, CONVERSATION), [{ per_page: '100' }, { per_page: '100', page: '2' }])
})

test('feedbackFor sees a maintainer comment that comes after exactly 100 others, on a later read of the same client', async () => {
  const others = Array.from({ length: 100 }, (_, i) => conversationComment(i + 1, 'demo-bot', '2026-10-01T09:00:00Z', 'status'))
  const empty = [
    { path: `${PR_11}/comments`, body: [] },
    { path: REVIEWS, body: [] },
  ]

  const { manifest, github } = scanningRollout([], [{ path: CONVERSATION, body: others }, ...empty])

  manifest.repo.maintainers = ['maint']

  assert.deepEqual(await feedbackFor(manifest, 11), [])

  github.answer([
    { path: CONVERSATION, body: [...others, conversationComment(101, 'maint', '2026-10-01T10:00:00Z', 'Rename it.')] },
    ...empty,
  ])

  assert.deepEqual(await feedbackFor(manifest, 11), [{ id: 'conversation-101', at: '2026-10-01T10:00:00Z', body: 'Rename it.' }])
  assert.deepEqual(
    github
      .requests()
      .filter((request) => request.path === CONVERSATION)
      .map((request) => [request.query.page ?? '1', request.status]),
    [
      ['1', 200],
      ['1', 304],
      ['2', 200],
    ],
  )
})

test('checksFor reads the next page while GitHub links one, and stops at the page that links none', async () => {
  const full = scanningRollout([], [runsRoute(HEAD, passingRuns(100, jobName))])

  assert.equal((await checksFor(full.manifest, HEAD)).runs.length, 100)
  assert.deepEqual(queriesOf(full.github, RUNS), [{ per_page: '100' }])

  const longer = scanningRollout([], [runsRoute(HEAD, passingRuns(201, jobName))])

  assert.equal((await checksFor(longer.manifest, HEAD)).runs.length, 201)
  assert.deepEqual(queriesOf(longer.github, RUNS), [{ per_page: '100' }, { per_page: '100', page: '2' }, { per_page: '100', page: '3' }])
})

test('checksFor rejects a page without a list instead of returning the runs read so far', async () => {
  const next = `<https://api.github.com/${RUNS}?per_page=100&page=2>; rel="next"`
  const { manifest } = scanningRollout(
    [],
    [
      { path: RUNS, query: { page: '2' }, body: { message: 'x' } },
      { path: RUNS, body: { check_runs: passingRuns(100, jobName) }, headers: { link: next } },
    ],
  )

  await assert.rejects(checksFor(manifest, HEAD), /check-runs page 2 has no list/)
})

const BASE_RUNS = `repos/example/widgets/commits/${BASE_TIP}/check-runs`

// PR 11, its reviews, the check runs of its head and of the base tip, and no code scanning alert.
function factRoutes() {
  return [
    { path: PR_11, body: REST_PR },
    { path: REVIEWS, body: [{ ...review(7, 'maint', '2026-10-01T10:00:00Z', 'CHANGES_REQUESTED', 'Rename it.'), commit_id: HEAD }] },
    runsRoute(HEAD, [GREEN_RUN]),
    runsRoute(BASE_TIP, [GREEN_RUN]),
    alertsRoute(PR_REF, []),
  ]
}

// Each read the tick shares, with the path it asks for.
function sharedReads(manifest, reads) {
  return [
    [PR_11, () => viewPr(manifest, 11, { reads })],
    [REVIEWS, () => reviewsFor(manifest, 11, { reads })],
    [RUNS, () => checksFor(manifest, HEAD, { reads })],
    [ALERTS, () => codeScanningFor(manifest, 11, { reads })],
    [BASE_RUNS, () => baseChecks(manifest, BASE_TIP, { reads })],
  ]
}

function pathsOf(github) {
  return github.requests().map((request) => request.path)
}

test("tickReads: with one tick's reads, two parallel calls and a later one ask GitHub once for each fact", async () => {
  const { manifest, github } = scanningRollout([], factRoutes())
  const reads = tickReads()

  for (const [path, read] of sharedReads(manifest, reads)) {
    const [first, second] = await Promise.all([read(), read()])

    assert.deepEqual(second, first, path)
    assert.deepEqual(await read(), first, path)
  }

  assert.deepEqual(pathsOf(github), [PR_11, REVIEWS, RUNS, ALERTS, BASE_RUNS])
  assert.equal(await viewPr(manifest, 11, { reads }), await viewPr(manifest, 11, { reads }))
})

test('tickReads: without reads, every call asks GitHub', async () => {
  const { manifest, github } = scanningRollout([], factRoutes())

  for (const [, read] of sharedReads(manifest)) {
    await Promise.all([read(), read()])
  }

  assert.deepEqual(pathsOf(github), [PR_11, PR_11, REVIEWS, REVIEWS, RUNS, RUNS, ALERTS, ALERTS, BASE_RUNS, BASE_RUNS])
})

test('tickReads: feedbackFor and reviewsFor share one read of the reviews, and the comments are read on every call', async () => {
  const comments = [
    { path: `${PR_11}/comments`, body: [] },
    { path: CONVERSATION, body: [] },
  ]

  const { manifest, github } = scanningRollout([], [...factRoutes(), ...comments])
  const reads = tickReads()
  const count = (path) => pathsOf(github).filter((asked) => asked === path).length

  manifest.repo.maintainers = ['maint']

  const [feedback, reviews] = await Promise.all([feedbackFor(manifest, 11, { reads }), reviewsFor(manifest, 11, { reads })])

  assert.deepEqual(feedback, [{ id: 'review-7', at: '2026-10-01T10:00:00Z', body: 'Rename it.' }])
  assert.deepEqual(reviews, [{ user: 'maint', state: 'CHANGES_REQUESTED', commit: HEAD, at: '2026-10-01T10:00:00Z' }])
  assert.deepEqual(await feedbackFor(manifest, 11, { reads }), feedback)
  assert.deepEqual([REVIEWS, `${PR_11}/comments`, CONVERSATION].map(count), [1, 2, 2])
})

test('forgetPr: the next read of the PR, its reviews and its code scanning asks again, and the check runs stay', async () => {
  const { manifest, github } = scanningRollout([], factRoutes())
  const reads = tickReads()

  for (const [, read] of sharedReads(manifest, reads)) {
    await read()
  }

  forgetPr(reads, 11)
  forgetPr(null, 11)

  for (const [, read] of sharedReads(manifest, reads)) {
    await read()
  }

  assert.deepEqual(pathsOf(github), [PR_11, REVIEWS, RUNS, ALERTS, BASE_RUNS, PR_11, REVIEWS, ALERTS])
})

test('collectFacts: a second call with the same reads asks GitHub nothing', async () => {
  const rules = [
    { tool: 'git', args: 'rev-parse origin/main', stdout: `${BASE_TIP}\n` },
    { tool: 'git', stdout: '' },
  ]

  const { manifest, github } = scanningRollout(rules, factRoutes())
  const ledger = { data: { halted: null }, prs: {} }
  const reads = tickReads()

  manifest.repo.codeScanning = { action: 'fix', minSeverity: 'medium' }

  const first = await collectFacts(manifest, manifest.prs[0], { pr: 11 }, ledger, { reads })

  assert.deepEqual(pathsOf(github), [PR_11, REVIEWS, RUNS, BASE_RUNS, ALERTS])
  assert.deepEqual(await collectFacts(manifest, manifest.prs[0], { pr: 11 }, ledger, { reads }), first)
  assert.equal(github.requests().length, 5)
})

test('unmergedHeads: the verified heads of unmerged dependencies, none while one is held, and a merged one is skipped even when held', () => {
  const pr = { deps: ['A1', 'A3'] }
  const sha = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
  const verified = { state: 'verified', verified: { sha, patchId: 'patch-a1' }, held: null }

  assert.deepEqual(unmergedHeads(pr, { prs: { A1: verified, A3: { state: 'merged' } } }), [{ id: 'A1', sha, patchId: 'patch-a1' }])
  assert.equal(unmergedHeads(pr, { prs: { A1: { ...verified, held: { at: '2026-01-01T00:00:00Z' } }, A3: { state: 'merged' } } }), null)
  assert.deepEqual(unmergedHeads(pr, { prs: { A1: verified, A3: { state: 'merged', held: { at: '2026-01-01T00:00:00Z' } } } }), [
    { id: 'A1', sha, patchId: 'patch-a1' },
  ])
})
