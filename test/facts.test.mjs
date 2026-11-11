import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectFacts, setFetch } from '../lib/github.mjs'
import { policyViolations } from '../lib/judge.mjs'
import { MAINTAINER_TOKEN, prRoute, runsRoute } from './driver-helpers.mjs'
import { fakeGitHub, withProcessEnv } from './fixtures.mjs'

// Real git on a local bare origin and a clone of it. The driver's reads run
// under whatever config a case puts in place. The fixture's own git never does.
const COMMITTER = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']
const PR = { id: 'A1', branch: 'feat/a1', deps: [], changeset: 'none' }

const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x00, 0xff, 0x0a, 0x00])

// A blank line 6 sits next to the change on line 5, and line 16 changes ten lines further down.
const CORE = Array.from({ length: 30 }, (_, i) => (i === 5 ? '' : `line ${i + 1}`))

const GUIDE = Array.from({ length: 12 }, (_, i) => `The guide, paragraph ${i + 1}.`)

const BASE_FILES = {
  'lib/core.js': lines(CORE),
  'docs/guide.md': lines(GUIDE),
  'assets/logo.bin': LOGO,
  'gone.txt': 'bye\n',
  link: 'was a file\n',
  'tool.sh': '#!/bin/sh\necho tool\n',
  'tail.txt': 'first\nlast\n',
  'latin.txt': 'caf\n',
}

function lines(list) {
  return `${list.join('\n')}\n`
}

// No config of the machine and none a case set in process.env.
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))

  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra }
}

function git(cwd, ...args) {
  return execFileSync('git', [...COMMITTER, '-C', cwd, ...args], { env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitBytes(cwd, args, { env = cleanEnv(), input } = {}) {
  return execFileSync('git', [...COMMITTER, '-C', cwd, ...args], { env, input, stdio: ['pipe', 'pipe', 'pipe'] })
}

function write(repo, files) {
  for (const [path, content] of Object.entries(files)) {
    const file = join(repo, path)

    if (content === null) {
      rmSync(file)
    } else {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
  }
}

function commit(repo, message) {
  git(repo, 'add', '--all')
  git(repo, 'commit', '--quiet', '-m', message)

  return git(repo, 'rev-parse', 'HEAD').trim()
}

// A commit on origin/main that is only in repo.path, the way a PR head is once ensureCommit has it.
function prHead(repo, files, message = 'feat: a change') {
  git(repo, 'checkout', '--quiet', '--detach', 'origin/main')
  write(repo, files)

  return commit(repo, message)
}

function moveMain(repo, files) {
  const sha = prHead(repo, files, 'chore: move main')

  git(repo, 'push', '--quiet', 'origin', 'HEAD:main')

  return sha
}

function fixture(context) {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-facts-'))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')

  context.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
  git(dir, 'clone', '--quiet', origin, repo)
  write(repo, BASE_FILES)
  commit(repo, 'chore: base')
  git(repo, 'push', '--quiet', 'origin', 'HEAD:main')

  return { dir, repo }
}

function manifestFor(repo, { forbid = [], denylist = [] } = {}) {
  return {
    repo: {
      path: repo,
      github: 'example/widgets',
      base: 'main',
      pathPrepend: [],
      baseQuietPaths: [],
      requiredChecks: [],
      codeScanning: { action: 'ignore' },
      forbid,
      denylist,
    },
  }
}

// The facts of PR #11 at `sha`. A request no route answers gets a 400, and the read throws.
async function factsAt(manifest, sha) {
  const baseTip = git(manifest.repo.path, 'rev-parse', 'origin/main').trim()
  const github = fakeGitHub([
    prRoute({ head: { sha } }),
    { path: 'repos/example/widgets/pulls/11/reviews', body: [] },
    runsRoute(sha),
    runsRoute(baseTip),
  ])

  setFetch(github.fetch, { token: async () => MAINTAINER_TOKEN })

  return collectFacts(manifest, PR, { pr: 11 }, { data: { halted: null }, prs: {} })
}

function gitFacts({ files, addedLines, commits, patchId }) {
  return { files, addedLines, commits, patchId }
}

const NON_ASCII_NAME = 'docs/notatki-\u017c.md'

function hostileHead(repo) {
  const core = CORE.map((line, i) => ([4, 15].includes(i) ? `${line} changed` : line))
  const handbook = GUIDE.map((line, i) => (i === 3 ? 'The handbook, a new paragraph.' : line))

  return prHead(
    repo,
    {
      'lib/core.js': lines(core),
      'docs/guide.md': null,
      'docs/handbook.md': lines(handbook),
      'docs/extra-one.md': 'one\n',
      'docs/extra-two.md': 'two\n',
      'assets/logo.bin': Buffer.concat([LOGO, Buffer.from([0x00, 0x01])]),
      [NON_ASCII_NAME]: 'notes\n',
      'notes/plus.txt': lines(['++ looks like a file header', 'after it']),
    },
    'feat: caf\u00e9 notes',
  )
}

function plainDiff(repo, sha, env) {
  return gitBytes(repo, ['diff', '-U0', `origin/main...${sha}`], { env }).toString('latin1')
}

test('facts: no git config changes the files, the added lines, the commits or the patch id', async (context) => {
  const { dir, repo } = fixture(context)
  const sha = hostileHead(repo)
  const manifest = manifestFor(repo)
  const clean = gitFacts(await factsAt(manifest, sha))
  const script = join(dir, 'external-diff.sh')

  writeFileSync(script, '#!/bin/sh\necho external diff\n', { mode: 0o755 })

  assert.deepEqual(clean.files, [
    { status: 'modified', path: 'assets/logo.bin' },
    { status: 'added', path: 'docs/extra-one.md' },
    { status: 'added', path: 'docs/extra-two.md' },
    { status: 'renamed', path: 'docs/handbook.md', previousPath: 'docs/guide.md' },
    { status: 'added', path: NON_ASCII_NAME },
    { status: 'modified', path: 'lib/core.js' },
    { status: 'added', path: 'notes/plus.txt' },
  ])

  assert.deepEqual(
    clean.addedLines.filter((line) => line.path !== 'assets/logo.bin'),
    [
      { path: 'docs/extra-one.md', text: 'one' },
      { path: 'docs/extra-two.md', text: 'two' },
      { path: 'docs/handbook.md', text: 'The handbook, a new paragraph.' },
      { path: NON_ASCII_NAME, text: 'notes' },
      { path: 'lib/core.js', text: 'line 5 changed' },
      { path: 'lib/core.js', text: 'line 16 changed' },
      { path: 'notes/plus.txt', text: '++ looks like a file header' },
      { path: 'notes/plus.txt', text: 'after it' },
    ],
  )

  assert.ok(clean.addedLines.some((line) => line.path === 'assets/logo.bin'))
  assert.deepEqual(clean.commits, [{ sha, message: 'feat: caf\u00e9 notes' }])
  assert.match(clean.patchId, /^[0-9a-f]{40}$/)

  const hostile = [
    ['diff.external', script],
    ['diff.noprefix', 'true'],
    ['diff.mnemonicPrefix', 'true'],
    ['color.ui', 'always'],
    ['diff.renames', 'false'],
    ['diff.renameLimit', '1'],
    ['diff.context', '10'],
    ['diff.interHunkContext', '10'],
    ['diff.suppressBlankEmpty', 'true'],
    ['diff.orderFile', join(dir, 'missing-order-file')],
    ['core.quotePath', 'false'],
    ['log.showSignature', 'true'],
    ['i18n.logOutputEncoding', 'ISO-8859-2'],
  ]

  const controlled = ['diff.noprefix', 'diff.external', 'color.ui']
  const globalFile = join(dir, 'hostile.gitconfig')

  for (const [key, value] of hostile) {
    git(dir, 'config', '--file', globalFile, key, value)

    if (controlled.includes(key)) {
      assert.notEqual(plainDiff(repo, sha, cleanEnv({ GIT_CONFIG_GLOBAL: globalFile })), plainDiff(repo, sha, cleanEnv()), key)
    }

    await withProcessEnv({ GIT_CONFIG_GLOBAL: globalFile }, async () => {
      assert.deepEqual(gitFacts(await factsAt(manifest, sha)), clean, `${key} in the global config`)
    })

    rmSync(globalFile)
    git(repo, 'config', key, value)
    assert.deepEqual(gitFacts(await factsAt(manifest, sha)), clean, `${key} in the local config`)
    git(repo, 'config', '--unset', key)

    await withProcessEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: value }, async () => {
      assert.deepEqual(gitFacts(await factsAt(manifest, sha)), clean, `${key} in GIT_CONFIG_COUNT`)
    })
  }

  await withProcessEnv({ GIT_EXTERNAL_DIFF: script, GIT_DIFF_OPTS: '--unified=10' }, async () => {
    assert.deepEqual(gitFacts(await factsAt(manifest, sha)), clean, 'GIT_EXTERNAL_DIFF and GIT_DIFF_OPTS')
  })
})

test('facts: names reach forbid, the workflow rule and the denylist as they are', async (context) => {
  const { repo } = fixture(context)
  const manifest = manifestFor(repo, { forbid: ['secrets/**'], denylist: ['zebracorn'] })
  const workflow = '.github/workflows/d\u00e9pl.yml'
  const secret = 'secrets/klucz-\u0142.txt'
  const named = prHead(repo, { [workflow]: 'on: push\n', [secret]: 'key\n', [NON_ASCII_NAME]: 'a zebracorn was here\n' })

  assert.deepEqual(policyViolations(manifest, PR, await factsAt(manifest, named)), [
    `touches ${workflow}; CI and workflow files need allowWorkflows on the PR in the manifest`,
    `touches forbidden path ${secret}`,
    `mentions a denylisted term in ${NON_ASCII_NAME}`,
  ])

  const odd = ['secrets/a b.txt', 'secrets/a\tb.txt', 'secrets/a"b.txt', 'secrets/a\nb.txt']
  const oddHead = prHead(repo, Object.fromEntries(odd.map((path) => [path, 'key\n'])))
  const violations = policyViolations(manifest, PR, await factsAt(manifest, oddHead))

  assert.deepEqual(violations.toSorted(), odd.map((path) => `touches forbidden path ${path}`).toSorted())
})

test('facts: a word below an added line that looks like a header, and one in a file an attribute marks -diff, are read', async (context) => {
  const { repo } = fixture(context)
  const manifest = manifestFor(repo, { denylist: ['quokkaflux'] })
  const plus = prHead(repo, { 'notes/plus.txt': lines(['++ looks like a file header', '-- and so does this', 'a quokkaflux below them']) })

  assert.deepEqual(policyViolations(manifest, PR, await factsAt(manifest, plus)), ['mentions a denylisted term in notes/plus.txt'])

  const markdown = prHead(repo, { 'docs/hidden.md': 'a quokkaflux in markdown\n' })
  const attributes = join(repo, '.gitattributes')

  writeFileSync(attributes, '*.md -diff\n')
  context.after(() => rmSync(attributes, { force: true }))

  assert.deepEqual(policyViolations(manifest, PR, await factsAt(manifest, markdown)), ['mentions a denylisted term in docs/hidden.md'])

  rmSync(attributes)
})

test('facts: a last line without a newline, a file turned into a symlink, a mode-only change and a deletion parse', async (context) => {
  const { repo } = fixture(context)
  const manifest = manifestFor(repo)

  git(repo, 'checkout', '--quiet', '--detach', 'origin/main')
  write(repo, { 'tail.txt': 'first\nlast without a newline', 'gone.txt': null, link: null })
  symlinkSync('target.txt', join(repo, 'link'))
  git(repo, 'add', '--all')
  git(repo, 'update-index', '--chmod=+x', 'tool.sh')
  git(repo, 'commit', '--quiet', '-m', 'feat: shapes')

  const facts = await factsAt(manifest, git(repo, 'rev-parse', 'HEAD').trim())

  assert.deepEqual(facts.files, [
    { status: 'removed', path: 'gone.txt' },
    { status: 'type-changed', path: 'link' },
    { status: 'modified', path: 'tail.txt' },
    { status: 'modified', path: 'tool.sh' },
  ])

  assert.deepEqual(facts.addedLines, [
    { path: 'link', text: 'target.txt' },
    { path: 'tail.txt', text: 'last without a newline' },
  ])
})

test('facts: a patch id tells patches apart and stays with the patch when the base moves', async (context) => {
  const { repo } = fixture(context)
  const manifest = manifestFor(repo)
  const idAt = async (sha) => (await factsAt(manifest, sha)).patchId
  const one = prHead(repo, { 'lib/core.js': lines(CORE.with(0, 'line 1, one way')) })
  const other = prHead(repo, { 'lib/core.js': lines(CORE.with(0, 'line 1, another way')) })
  const oneId = await idAt(one)

  assert.match(oneId, /^[0-9a-f]{40}$/)
  assert.notEqual(oneId, await idAt(other))

  const piped = gitBytes(repo, ['patch-id', '--verbatim'], { input: gitBytes(repo, ['diff', `origin/main...${one}`]) })

  assert.equal(oneId, piped.toString().split(' ')[0])

  moveMain(repo, { 'other.txt': 'elsewhere\n' })
  git(repo, 'checkout', '--quiet', '--detach', 'origin/main')
  git(repo, 'cherry-pick', one)

  const picked = git(repo, 'rev-parse', 'HEAD').trim()

  assert.notEqual(picked, one)
  assert.equal(await idAt(picked), oneId)
})

test('facts: a patch id comes from the bytes and the full blob ids, whatever the abbreviation', async (context) => {
  const { repo } = fixture(context)
  const manifest = manifestFor(repo)
  const idAt = async (sha) => (await factsAt(manifest, sha)).patchId
  const small = prHead(repo, { 'assets/logo.bin': Buffer.concat([LOGO, Buffer.from([0x01])]) })
  const large = prHead(repo, { 'assets/logo.bin': Buffer.concat([LOGO, Buffer.from([0x01, 0x02])]) })
  const smallId = await idAt(small)

  assert.notEqual(smallId, await idAt(large))

  git(repo, 'config', 'core.abbrev', '12')
  assert.equal(await idAt(small), smallId)
  git(repo, 'config', '--unset', 'core.abbrev')

  const acute = prHead(repo, { 'latin.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) })
  const grave = prHead(repo, { 'latin.txt': Buffer.from([0x63, 0x61, 0x66, 0xe8, 0x0a]) })

  assert.notEqual(await idAt(acute), await idAt(grave))
})
