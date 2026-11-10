import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCatalog, setFetch } from '../lib/github.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import {
  agentTokenCheck,
  BOUNDARY_PROBES,
  BOUNDARY_SCRIPT,
  boundaryVerdict,
  catalogCheck,
  claudeWrapperWarning,
  imageToolCheck,
  originCheck,
  probeTools,
  runtimeCheck,
  sshHostname,
  storedLoginCheck,
  userSettingsCheck,
  VERIFIED_VERSIONS,
  versionWarning,
} from '../lib/preflight.mjs'
import { fakeGitHub, makeRollout } from './fixtures.mjs'

function tools(install, verify) {
  return probeTools({ repo: { install, verify } })
}

// One directory per entry, each with an executable `claude` holding that text.
function pathWith(context, ...texts) {
  const root = mkdtempSync(join(tmpdir(), 'rollout-claude-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))

  return texts
    .map((text, index) => {
      const dir = join(root, String(index))
      mkdirSync(dir)
      writeFileSync(join(dir, 'claude'), text)
      chmodSync(join(dir, 'claude'), 0o755)

      return dir
    })
    .join(':')
}

const WRAPPER = '#!/usr/bin/env bash\nexec /opt/terminal/claude-wrapper "$@"\n'
const NATIVE = '\u00cf\u00fa\u00ed\u00fe binary'
const NPM = '#!/usr/bin/env node\nimport("./cli.js")\n'

test('claude wrapper: a shell script first on PATH warns and names the binary behind it', (context) => {
  const path = pathWith(context, WRAPPER, NATIVE)
  const [wrapper, native] = path.split(':').map((dir) => join(dir, 'claude'))
  const warning = claudeWrapperWarning('claude', path)

  assert.ok(warning.startsWith(`claude on PATH is a wrapper script (${wrapper}).`), warning)
  assert.ok(warning.endsWith(`Set claudeBin in manifest.yaml to the Claude Code binary, for example ${native}`), warning)
})

test('claude wrapper: without a binary behind it the warning names none', (context) => {
  const warning = claudeWrapperWarning('claude', pathWith(context, WRAPPER))

  assert.ok(warning.endsWith('Set claudeBin in manifest.yaml to the Claude Code binary'), warning)
})

test('claude wrapper: the native binary and the npm node script pass', (context) => {
  assert.equal(claudeWrapperWarning('claude', pathWith(context, NATIVE, WRAPPER)), null)
  assert.equal(claudeWrapperWarning('claude', pathWith(context, NPM)), null)
})

test('claude wrapper: an explicit claudeBin path and a missing claude pass', (context) => {
  const path = pathWith(context, WRAPPER)

  assert.equal(claudeWrapperWarning(join(path, 'claude'), path), null)
  assert.equal(claudeWrapperWarning('claude', ''), null)
  assert.equal(claudeWrapperWarning('claude', undefined), null)
})

// A synthetic user settings file in a temp dir, holding `text` as it is.
function settingsFile(context, text) {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-settings-'))
  const file = join(dir, 'settings.json')

  context.after(() => rmSync(dir, { recursive: true, force: true }))

  if (text !== null) {
    writeFileSync(file, text)
  }

  return file
}

test('userSettingsCheck: apiKeyHelper and env warn, naming the variables and never their values', (context) => {
  const settings = {
    apiKeyHelper: '/opt/keys/print-key.sh',
    env: { SYNTHETIC_API_KEY: 'synthetic-secret-1', PROXY_URL: 'synthetic-secret-2' },
  }

  const file = settingsFile(context, JSON.stringify(settings))
  const check = userSettingsCheck(file)

  assert.deepEqual(check.lines, [])
  assert.deepEqual(check.warnings, [
    `${file} sets apiKeyHelper and env (SYNTHETIC_API_KEY, PROXY_URL). Agents start with --setting-sources project, so they get none of it. Put what they need in the environment that starts the driver`,
  ])

  for (const value of ['/opt/keys/print-key.sh', 'synthetic-secret-1', 'synthetic-secret-2']) {
    assert.equal(check.warnings[0].includes(value), false, value)
  }
})

test('userSettingsCheck: env alone or apiKeyHelper alone warns', (context) => {
  const envOnly = settingsFile(context, JSON.stringify({ env: { SYNTHETIC_FLAG: '1' }, model: 'opus' }))
  const helperOnly = settingsFile(context, JSON.stringify({ apiKeyHelper: 'print-key', env: {} }))

  assert.deepEqual(userSettingsCheck(envOnly), {
    lines: [],
    warnings: [
      `${envOnly} sets env (SYNTHETIC_FLAG). Agents start with --setting-sources project, so they get none of it. Put what they need in the environment that starts the driver`,
    ],
  })

  assert.deepEqual(userSettingsCheck(helperOnly), {
    lines: [],
    warnings: [
      `${helperOnly} sets apiKeyHelper. Agents start with --setting-sources project, so they get none of it. Put what they need in the environment that starts the driver`,
    ],
  })
})

test('userSettingsCheck: neither is one ok line, and a missing or invalid file says nothing', (context) => {
  const plain = settingsFile(context, JSON.stringify({ apiKeyHelper: '', env: {}, permissions: { allow: [] } }))

  assert.deepEqual(userSettingsCheck(plain), {
    lines: [`ok   user settings: agents load none, and ${plain} sets no apiKeyHelper or env`],
    warnings: [],
  })

  for (const text of [null, '{ not json', '']) {
    assert.deepEqual(userSettingsCheck(settingsFile(context, text)), { lines: [], warnings: [] }, String(text))
  }
})

test('probe tools come from the install command', () => {
  assert.deepEqual(tools('pnpm install --frozen-lockfile', {}), ['node', 'pnpm'])
  assert.deepEqual(tools('yarn install --immutable', {}), ['node', 'yarn'])
})

test('probe tools map npx to npm and dedupe', () => {
  assert.deepEqual(tools('npm ci', { common: ['npx prettier --check .', 'npm test'] }), ['node', 'npm'])
})

test('probe tools come from verify steps alone', () => {
  assert.deepEqual(tools(undefined, { common: ['bun test'] }), ['node', 'bun'])
})

test('probe tools skip leading environment assignments', () => {
  assert.deepEqual(tools('CI=1 pnpm install', {}), ['node', 'pnpm'])
})

test('probe tools keep every manager in first-seen order', () => {
  assert.deepEqual(tools('npm ci', { common: ['pnpm test'] }), ['node', 'npm', 'pnpm'])
})

test('probe tools ignore unknown words', () => {
  assert.deepEqual(tools('make setup', { common: ['constructor x'] }), ['node'])
})

test('probe tools are only node without install or verify steps', () => {
  assert.deepEqual(tools(undefined, {}), ['node'])
  assert.deepEqual(tools(undefined, null), ['node'])
})

const myLib = { repo: { github: 'My-Org/my-lib' } }

function resolverSpy(result) {
  const calls = []

  async function resolve(host) {
    calls.push(host)

    if (result instanceof Error) {
      throw result
    }

    return result
  }

  return { calls, resolve }
}

test('origin on github.com passes without resolving', async () => {
  const spy = resolverSpy('github.com')

  for (const url of ['git@github.com:my-org/my-lib.git', 'https://github.com/my-org/my-lib.git', 'git@GitHub.com:MY-ORG/My-Lib.git']) {
    const result = await originCheck(myLib, url, spy.resolve)

    assert.deepEqual(result, { ok: true, text: 'my-org/my-lib on github.com' }, url)
  }

  assert.deepEqual(spy.calls, [])
})

test('origin through an SSH alias passes when it resolves to github.com', async () => {
  const spy = resolverSpy('GitHub.com')
  const result = await originCheck(myLib, 'git@github-work:my-org/my-lib.git', spy.resolve)

  assert.deepEqual(result, { ok: true, text: 'my-org/my-lib on github.com through SSH host github-work' })
  assert.deepEqual(spy.calls, ['github-work'])
})

test('origin through an SSH alias fails when it resolves elsewhere', async () => {
  const spy = resolverSpy('gitlab.example.com')
  const result = await originCheck(myLib, 'git@github-work:my-org/my-lib.git', spy.resolve)

  assert.equal(result.ok, false)
  assert.match(result.text, /gitlab\.example\.com/)
})

test('origin through an SSH alias fails when ssh -G fails', async () => {
  const spy = resolverSpy(new Error('exited 255'))
  const result = await originCheck(myLib, 'git@github-work:my-org/my-lib.git', spy.resolve)

  assert.equal(result.ok, false)
  assert.match(result.text, /github-work/)
  assert.match(result.text, /ssh -G/)
})

test('origin with another repo name fails before resolving', async () => {
  const spy = resolverSpy('github.com')
  const result = await originCheck(myLib, 'git@github.com:my-org/my-lib-next.git', spy.resolve)
  const alias = await originCheck(myLib, 'git@github-work:my-org/my-lib-next.git', spy.resolve)

  assert.equal(result.ok, false)
  assert.match(result.text, /my-org\/my-lib-next/)
  assert.equal(alias.ok, false)
  assert.deepEqual(spy.calls, [])
})

test('origin over HTTPS on another host fails without resolving', async () => {
  const spy = resolverSpy('github.com')

  for (const url of ['https://gitlab.com/my-org/my-lib.git', 'https://github-work/my-org/my-lib.git']) {
    const result = await originCheck(myLib, url, spy.resolve)

    assert.equal(result.ok, false, url)
  }

  assert.deepEqual(spy.calls, [])
})

test('origin texts never print credentials', async () => {
  const spy = resolverSpy('github.com')

  for (const url of ['https://x-access-token:secret@gitlab.com/my-org/my-lib.git', 'https://x:secret@example.com/a']) {
    const result = await originCheck(myLib, url, spy.resolve)

    assert.equal(result.ok, false, url)
    assert.doesNotMatch(result.text, /secret/, url)
  }
})

test('a missing or local origin fails', async () => {
  const spy = resolverSpy('github.com')
  const missing = await originCheck(myLib, '', spy.resolve)
  const local = await originCheck(myLib, '/srv/git/my-lib.git', spy.resolve)

  assert.equal(missing.ok, false)
  assert.match(missing.text, /\(none\)/)
  assert.equal(local.ok, false)
  assert.deepEqual(spy.calls, [])
})

async function withFakeSsh(script, run) {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-ssh-'))

  try {
    writeFileSync(join(dir, 'ssh'), script, { mode: 0o755 })
    await run(dir, { repo: { pathPrepend: [dir] } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('ssh hostname reads the hostname line of ssh -G', async () => {
  const script = `#!/usr/bin/env node
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'args.json'), JSON.stringify(process.argv.slice(2)))
console.log('user git\\nhostname GitHub.com\\nport 22')
`

  await withFakeSsh(script, async (dir, fakeM) => {
    assert.equal(await sshHostname(fakeM, 'github-work'), 'github.com')
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')), ['-G', 'github-work'])
  })
})

test('ssh hostname fails with the host when ssh -G fails', async () => {
  const script = `#!/usr/bin/env node
console.error('bad configuration option')
process.exit(255)
`

  await withFakeSsh(script, async (_, fakeM) => {
    await assert.rejects(sshHostname(fakeM, 'github-work'), /ssh -G github-work exited 255: bad configuration option/)
  })
})

// Records what gh saw. `auth status` finds a login with a token, and with
// `keyring` also whenever GH_HOST is set, the way gh reads the maintainer's
// keyring login even from an empty config dir.
function fakeGh(dir, finds) {
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const { GH_TOKEN, GH_HOST, GH_CONFIG_DIR, GH_REPO } = process.env
const finds = ${JSON.stringify(finds)}
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), GH_TOKEN, GH_HOST, GH_CONFIG_DIR, GH_REPO }) + '\\n')

if (finds !== 'always' && !GH_TOKEN && !(finds === 'keyring' && GH_HOST)) {
  console.error('You are not logged into any GitHub hosts.')
  process.exitCode = 1
}
`,
    { mode: 0o755 },
  )
}

// The fake gh written by writeGh comes first on repo.pathPrepend, and token is
// the content of repo.agentToken.
async function withAgentGh(token, writeGh, run) {
  const bin = mkdtempSync(join(tmpdir(), 'rollout-gh-'))
  const manifest = loadManifest(makeRollout())

  manifest.repo.pathPrepend = [bin]
  manifest.repo.agentToken = join(manifest.dir, 'agent-token')
  writeFileSync(manifest.repo.agentToken, `${token}\n`)
  writeGh(bin)

  try {
    await run(manifest, () =>
      readFileSync(join(bin, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    )
  } finally {
    rmSync(bin, { recursive: true, force: true })
    rmSync(manifest.dir, { recursive: true, force: true })
  }
}

function withStoredLogin(finds, run) {
  return withAgentGh('synthetic-agent-token', (bin) => fakeGh(bin, finds), run)
}

const STORED_OK = "ok   without GH_TOKEN, agents' gh has no stored login to fall back to"
const STORED_FAIL = "FAIL without GH_TOKEN, agents' gh has no stored login to fall back to"

test("stored login: the check uses the agents' env and passes when it finds no login", async () => {
  const inherited = process.env.GH_HOST

  process.env.GH_HOST = 'github.com'

  try {
    await withStoredLogin('keyring', async (manifest, calls) => {
      const result = await storedLoginCheck(manifest)
      const [first] = calls()

      assert.equal(result.lines[0], STORED_OK)
      assert.deepEqual(result.problems, [])
      assert.deepEqual(first.args, ['auth', 'status'])
      assert.equal(first.GH_TOKEN, undefined)
      assert.equal(first.GH_HOST, undefined)
      assert.equal(first.GH_CONFIG_DIR, join(manifest.dir, '.gh-agents'))
      assert.equal(first.GH_REPO, 'github.com/example/widgets')
    })
  } finally {
    if (inherited === undefined) {
      delete process.env.GH_HOST
    } else {
      process.env.GH_HOST = inherited
    }
  }
})

test('stored login: a login found without GH_TOKEN is a problem', async () => {
  await withStoredLogin('always', async (manifest) => {
    const result = await storedLoginCheck(manifest)

    assert.equal(result.lines[0], STORED_FAIL)
    assert.deepEqual(result.problems, ['agents could fall back to a stored gh login'])
  })
})

test('stored login: the GH_HOST fallback is an info line, never a problem', async () => {
  await withStoredLogin('keyring', async (manifest, calls) => {
    const result = await storedLoginCheck(manifest)
    const [, probe] = calls()

    assert.equal(result.lines.length, 2)
    assert.equal(result.lines[0], STORED_OK)
    assert.match(result.lines[1], /^info with GH_HOST set, gh would fall back to your keyring login/)
    assert.deepEqual(result.problems, [])
    assert.deepEqual(probe.args, ['auth', 'status'])
    assert.equal(probe.GH_HOST, 'github.com')
    assert.equal(probe.GH_TOKEN, undefined)
  })

  await withStoredLogin('token', async (manifest) => {
    const result = await storedLoginCheck(manifest)

    assert.deepEqual(result.lines, [STORED_OK])
    assert.deepEqual(result.problems, [])
  })
})

const MAINTAINER_TOKEN = 'synthetic-maintainer-token'
const REPOSITORY = 'repos/example/widgets'
const PERMISSION = 'repos/example/widgets/collaborators/demo-bot/permission'

// The repository read of the probe: a status, or null for no answer at all.
function probeRoute(probe) {
  if (probe === null) {
    return { path: REPOSITORY, error: 'ECONNREFUSED' }
  }

  if (probe === 200) {
    return { path: REPOSITORY, body: { full_name: 'example/widgets' } }
  }

  return { path: REPOSITORY, status: probe, body: { message: probe === 404 ? 'Not Found' : 'Forbidden' } }
}

// scopes null leaves the X-Oauth-Scopes header out, and probe null is a probe GitHub never answered.
function agentRoutes({ permission = 'write', scopes = 'repo, workflow, read:org', probe = 200 } = {}) {
  const scopeHeader = scopes === null ? {} : { 'x-oauth-scopes': scopes }

  return [
    { path: 'user', body: { login: 'demo-bot' }, headers: { 'x-accepted-oauth-scopes': '', ...scopeHeader, 'x-ratelimit-limit': '5000' } },
    { path: PERMISSION, body: { permission, user: { login: 'demo-bot' } } },
    probeRoute(probe),
  ]
}

const CLASSIC_TOKEN = 'ghp_synthetic0123456789abcdef'
const FINE_GRAINED_TOKEN = 'github_pat_synthetic0123456789abcdef'

// A fixture rollout whose repo.agentToken holds `token`, and a fake GitHub
// that answers `routes`. No gh runs.
async function withAgentToken(token, routes, run) {
  const manifest = loadManifest(makeRollout())
  const github = fakeGitHub(routes)

  manifest.repo.agentToken = join(manifest.dir, 'agent-token')
  writeFileSync(manifest.repo.agentToken, `${token}\n`)
  setFetch(github.fetch, { token: async () => MAINTAINER_TOKEN })

  try {
    await run(manifest, github)
  } finally {
    rmSync(manifest.dir, { recursive: true, force: true })
  }
}

function bearerOf(github, path) {
  return github.requests().find((request) => request.path === path)?.headers.authorization
}

const IDENTITY_PROBLEM = 'agent token must belong to a non-maintainer account with write (not admin) permission'
const WORKFLOW_WARNING = 'agent token lacks the workflow scope: PRs that change .github/workflows cannot be pushed'
const READ_ORG_WARNING =
  'agent token lacks the read:org scope: gh cannot edit or read a PR with a team review request, so agents cannot update their PR description'

test('agent token: a classic token that sees the repository passes', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentRoutes(), async (manifest, github) => {
    const result = await agentTokenCheck(manifest)

    assert.deepEqual(result, {
      lines: [
        'ok   agent identity: demo-bot (permission write, scopes repo, workflow, read:org)',
        'ok   agent token can see example/widgets',
      ],
      problems: [],
      warnings: [],
    })

    assert.equal(bearerOf(github, 'user'), `Bearer ${CLASSIC_TOKEN}`)
    assert.equal(bearerOf(github, REPOSITORY), `Bearer ${CLASSIC_TOKEN}`)
    assert.equal(bearerOf(github, PERMISSION), `Bearer ${MAINTAINER_TOKEN}`)
  })
})

test('agent token: a token that cannot see the repository fails with the status', async () => {
  for (const status of [404, 403]) {
    await withAgentToken(CLASSIC_TOKEN, agentRoutes({ probe: status }), async (manifest) => {
      const result = await agentTokenCheck(manifest)

      assert.ok(result.lines.includes(`FAIL agent token cannot see example/widgets (${status})`), status)
      assert.deepEqual(
        result.problems,
        [`agent token cannot see example/widgets (${status}): give the token the repo scope and its account access to the repository`],
        status,
      )
    })
  }
})

test('agent token: a repository probe without an answer fails', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentRoutes({ probe: null }), async (manifest) => {
    const result = await agentTokenCheck(manifest)

    assert.ok(result.lines.includes('FAIL agent token cannot see example/widgets (no answer)'))
    assert.deepEqual(result.problems, [
      'agent token cannot see example/widgets (no answer): give the token the repo scope and its account access to the repository',
    ])
  })
})

test('agent token: a fine-grained token fails without scope warnings and is never printed', async () => {
  await withAgentToken(FINE_GRAINED_TOKEN, agentRoutes({ scopes: null }), async (manifest, github) => {
    const result = await agentTokenCheck(manifest)
    const printed = JSON.stringify(result)

    assert.deepEqual(result.lines, [
      'ok   agent identity: demo-bot (permission write, scopes ?)',
      'FAIL agent token is fine-grained, so agents cannot follow CI',
      'ok   agent token can see example/widgets',
    ])

    assert.deepEqual(result.problems, [
      'agent token is fine-grained: GitHub gives it no Checks permission, so agents cannot follow CI. Use a classic token with the repo, workflow and read:org scopes',
    ])

    assert.deepEqual(result.warnings, [])
    assert.ok(github.requests().some((request) => request.path === REPOSITORY))
    assert.equal(printed.includes(FINE_GRAINED_TOKEN), false)
    assert.equal(printed.includes(FINE_GRAINED_TOKEN.slice('github_pat_'.length)), false)
  })
})

test('agent token: a classic token without read:org, write:org or admin:org warns', async () => {
  const cases = [
    ['repo, workflow', [READ_ORG_WARNING]],
    ['repo, workflow, read:org', []],
    ['repo, workflow, write:org', []],
    ['repo, workflow, admin:org', []],
    ['repo, read:org', [WORKFLOW_WARNING]],
    ['repo, read:org_extra, workflows', [WORKFLOW_WARNING, READ_ORG_WARNING]],
  ]

  for (const [scopes, warnings] of cases) {
    await withAgentToken(CLASSIC_TOKEN, agentRoutes({ scopes }), async (manifest) => {
      const result = await agentTokenCheck(manifest)

      assert.deepEqual(result.warnings, warnings, scopes)
      assert.deepEqual(result.problems, [], scopes)
    })
  }
})

test('agent token: an empty or missing scopes header is no scopes', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentRoutes({ scopes: '' }), async (manifest) => {
    const result = await agentTokenCheck(manifest)

    assert.equal(result.lines[0], 'ok   agent identity: demo-bot (permission write, scopes none)')
    assert.deepEqual(result.warnings, [WORKFLOW_WARNING, READ_ORG_WARNING])
  })

  await withAgentToken(CLASSIC_TOKEN, agentRoutes({ scopes: null }), async (manifest) => {
    const result = await agentTokenCheck(manifest)

    assert.equal(result.lines[0], 'ok   agent identity: demo-bot (permission write, scopes ?)')
    assert.deepEqual(result.warnings, [WORKFLOW_WARNING, READ_ORG_WARNING])
  })
})

test('agent token: an account with admin permission fails the identity check', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentRoutes({ permission: 'admin' }), async (manifest) => {
    const result = await agentTokenCheck(manifest)

    assert.equal(result.lines[0], 'FAIL agent identity: demo-bot (permission admin, scopes repo, workflow, read:org)')
    assert.deepEqual(result.problems, [IDENTITY_PROBLEM])
  })
})

test('agent token: a maintainer account fails the identity check', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentRoutes(), async (manifest) => {
    manifest.repo.maintainers = ['demo-bot']

    const result = await agentTokenCheck(manifest)

    assert.match(result.lines[0], /^FAIL agent identity: demo-bot /)
    assert.deepEqual(result.problems, [IDENTITY_PROBLEM])
  })
})

test('agent token: a token GitHub refuses fails the identity check and reads no role', async () => {
  const refused = { path: 'user', status: 401, body: { message: 'Bad credentials' } }

  await withAgentToken(CLASSIC_TOKEN, [refused, ...agentRoutes()], async (manifest, github) => {
    const result = await agentTokenCheck(manifest)

    assert.equal(result.lines[0], 'FAIL agent identity: ? (permission ?, scopes ?)')
    assert.deepEqual(result.problems, [IDENTITY_PROBLEM])
    assert.equal(bearerOf(github, PERMISSION), undefined)
  })
})

test('agent token: a missing token file throws before any request', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentRoutes(), async (manifest, github) => {
    rmSync(manifest.repo.agentToken)

    await assert.rejects(agentTokenCheck(manifest), /repo\.agentToken .* does not exist/)
    assert.deepEqual(github.requests(), [])
  })
})

const COMMITTER = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']

const CATALOG = [
  '- id: docs-stale',
  '  criterion: Unchanged text in an edited doc agrees with the change.',
  "  paths: ['docs/**', '*.md']",
  '- id: ui-states',
  '  criterion: Every new UI control has an empty, loading and error state.',
  '  tags: [ui]',
  '- id: tests-fail-first',
  '  criterion: A new branch in the code has a test that fails without it.',
  '',
].join('\n')

const ONE_ENTRY = '- id: changelog\n  criterion: The changelog names every user-visible change.\n'

function git(cwd, ...args) {
  return execFileSync('git', [...COMMITTER, '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commitFiles(repo, files) {
  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(repo, file), text)
    git(repo, 'add', file)
  }

  git(repo, 'commit', '--quiet', '-m', `change ${Object.keys(files).join(', ')}`)
}

// A local bare origin whose main holds `files`, and a clone that fetched it. No GitHub.
function catalogRepo(context, files) {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-catalog-'))
  const origin = join(dir, 'origin.git')
  const repo = join(dir, 'repo')

  context.after(() => rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  execFileSync('git', ['clone', '--quiet', origin, repo], { stdio: 'ignore' })
  commitFiles(repo, { 'README.md': '# Widgets\n', ...files })
  git(repo, 'push', '--quiet', 'origin', 'HEAD:main')
  git(repo, 'fetch', '--quiet', 'origin')

  const manifest = { repo: { path: repo, base: 'main', pathPrepend: [] }, gates: { verify: { criteriaFrom: 'criteria.yaml' } } }

  return { dir, origin, repo, manifest }
}

const ids = (entries) => entries.map((entry) => entry.id)

test('catalogCheck: a valid catalog on origin/<base> prints its entry count', async (context) => {
  const { manifest } = catalogRepo(context, { 'criteria.yaml': CATALOG })

  assert.deepEqual(await catalogCheck(manifest), { lines: ['ok   criteria catalog criteria.yaml on origin/main: 3 entries'], problems: [] })

  const single = catalogRepo(context, { 'criteria.yaml': ONE_ENTRY })

  assert.deepEqual((await catalogCheck(single.manifest)).lines, ['ok   criteria catalog criteria.yaml on origin/main: 1 entry'])

  const none = catalogRepo(context, { 'criteria.yaml': '[]\n' })

  assert.deepEqual((await catalogCheck(none.manifest)).lines, ['ok   criteria catalog criteria.yaml on origin/main: 0 entries'])
})

test('catalogCheck: a catalog missing from origin/<base> fails and names the path and the ref, also when the clone has the file', async (context) => {
  const { repo, manifest } = catalogRepo(context, {})

  writeFileSync(join(repo, 'criteria.yaml'), CATALOG)

  const result = await catalogCheck(manifest)
  const [problem] = result.problems

  assert.match(problem, /^gates\.verify\.criteriaFrom criteria\.yaml cannot be read from origin\/main: fatal: .*criteria\.yaml/)
  assert.deepEqual(result, { lines: [`FAIL criteria catalog: ${problem}`], problems: [problem] })
  await assert.rejects(readCatalog(manifest), { message: problem })
})

test('catalogCheck: an invalid catalog fails and names every error', async (context) => {
  const { manifest } = catalogRepo(context, { 'criteria.yaml': '- id: V1\n  criterion: x\n- id: docs-stale\n  level: recommended\n' })
  const problem = [
    'gates.verify.criteriaFrom criteria.yaml on origin/main is invalid:',
    "entry 1 (V1): V<n> and B<n> ids are the driver's own numbering.",
    'entry 2 (docs-stale): unknown key level.',
    'entry 2 (docs-stale): criterion must be a non-empty string',
  ].join(' ')

  assert.deepEqual(await catalogCheck(manifest), { lines: [`FAIL criteria catalog: ${problem}`], problems: [problem] })
})

test('catalogCheck: without criteriaFrom it prints nothing and runs no git', async () => {
  const manifest = {
    repo: { path: join(tmpdir(), 'rollout-no-such-repo'), base: 'main', pathPrepend: [] },
    gates: { verify: { criteriaFrom: null } },
  }

  assert.deepEqual(await catalogCheck(manifest), { lines: [], problems: [] })
})

test('readCatalog: the base branch decides, not the checked-out PR head or an uncommitted edit', async (context) => {
  const { repo, manifest } = catalogRepo(context, { 'criteria.yaml': CATALOG })

  git(repo, 'checkout', '--quiet', '-b', 'feat/a1')
  commitFiles(repo, { 'criteria.yaml': ONE_ENTRY })
  git(repo, 'push', '--quiet', 'origin', 'feat/a1')
  writeFileSync(join(repo, 'criteria.yaml'), `${ONE_ENTRY}- id: lenient\n  criterion: Anything goes.\n`)

  assert.deepEqual(ids(await readCatalog(manifest)), ['docs-stale', 'ui-states', 'tests-fail-first'])
  assert.deepEqual((await catalogCheck(manifest)).lines, ['ok   criteria catalog criteria.yaml on origin/main: 3 entries'])
})

test('readCatalog: a change merged into the base applies once the clone fetches it', async (context) => {
  const { dir, origin, repo, manifest } = catalogRepo(context, { 'criteria.yaml': CATALOG })
  const elsewhere = join(dir, 'elsewhere')

  execFileSync('git', ['clone', '--quiet', origin, elsewhere], { stdio: 'ignore' })
  commitFiles(elsewhere, { 'criteria.yaml': `${CATALOG}${ONE_ENTRY}` })
  git(elsewhere, 'push', '--quiet', 'origin', 'HEAD:main')

  assert.deepEqual(ids(await readCatalog(manifest)), ['docs-stale', 'ui-states', 'tests-fail-first'])

  git(repo, 'fetch', '--quiet', 'origin')

  assert.deepEqual(ids(await readCatalog(manifest)), ['docs-stale', 'ui-states', 'tests-fail-first', 'changelog'])
})

test('VERIFIED_VERSIONS: the claude and gh versions the driver was verified on', () => {
  assert.deepEqual(VERIFIED_VERSIONS, { claude: '2.1.303', gh: '2.40.0' })
})

test('versionWarning: warns below the floor and compares the parts as numbers', () => {
  const warning = versionWarning('claude', '2.1.302 (Claude Code)', '2.1.303')

  assert.match(warning, /2\.1\.302/)
  assert.match(warning, /2\.1\.303/)

  for (const output of ['2.1.303 (Claude Code)', '2.2.0 (Claude Code)', '2.1.1000 (Claude Code)']) {
    assert.equal(versionWarning('claude', output, '2.1.303'), null, output)
  }

  assert.equal(versionWarning('gh', 'gh version 2.103.3 (2026-10-26)\nhttps://github.com/cli/cli/releases/tag/v2.103.3', '2.40.0'), null)
  assert.match(versionWarning('gh', 'gh version 2.39.9 (2023-11-01)', '2.40.0'), /2\.39\.9/)
})

test('versionWarning: warns when the output holds no version', () => {
  for (const output of ['', 'command not found']) {
    const warning = versionWarning('claude', output, '2.1.303')

    assert.match(warning, /no version/, output)
    assert.match(warning, /2\.1\.303/, output)
  }
})

test('runtimeCheck under the host runtime: no lines, no problems, one warning that names the Docker runtime', async () => {
  for (const sandbox of [{ runtime: 'host' }, undefined]) {
    const { lines, problems, warnings } = await runtimeCheck({ sandbox, dir: '/rollouts/demo' }, '2.1.309 (Claude Code)')

    assert.deepEqual(lines, [])
    assert.deepEqual(problems, [])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /^sandbox\.runtime is host: agents, installs and gate commands run as you/)
    assert.match(warnings[0], /Set sandbox\.runtime: docker/)
    assert.match(warnings[0], /security\.html#boundaries$/)
  }
})

test('imageToolCheck: fails on a failed run, no version or one below the floor, unlike the host check', () => {
  const ran = (stdout, code = 0, stderr = '') => ({ code, stdout, stderr })

  assert.deepEqual(imageToolCheck('claude', ran('2.1.309 (Claude Code)\n'), '/rollouts/demo'), {
    found: '2.1.309',
    line: 'ok   claude in the image: 2.1.309',
    problem: null,
  })

  const old = imageToolCheck('gh', ran('gh version 2.39.9 (2023-11-01)\n'), '/rollouts/demo')

  assert.equal(old.line, 'FAIL gh in the image: 2.39.9, older than 2.40.0')
  assert.equal(
    old.problem,
    'gh 2.39.9 in the image is older than 2.40.0: update it on the host and rebuild with rollout.mjs sandbox build --dir /rollouts/demo',
  )

  const silent = imageToolCheck('claude', ran('Claude Code\n'), '/rollouts/demo')

  assert.equal(silent.line, 'FAIL claude in the image printed no version ("Claude Code")')
  assert.match(silent.problem, /sandbox build --dir \/rollouts\/demo$/)

  const failed = imageToolCheck('claude', ran('', 127, 'exec: "claude": executable file not found in $PATH\n'), '/rollouts/demo')

  assert.equal(failed.line, 'FAIL claude in the image: exec: "claude": executable file not found in $PATH')
  assert.ok(failed.problem)
})

const CONTAINER_PROBES = BOUNDARY_PROBES.map((probe) => probe.name).filter((name) => name !== 'stop')

// The stdout of a container where every probe passed, with one probe's line
// replaced, or dropped when `line` is null.
function probeOutput(name = null, line = null) {
  const lines = CONTAINER_PROBES.flatMap((other) => {
    if (other !== name) {
      return [`probe ${other} ok`]
    }

    return line === null ? [] : [line]
  })

  return `${[...lines, 'probes-done'].join('\n')}\n`
}

function passingReport(changes = {}) {
  return {
    stdout: probeOutput(),
    stderr: '',
    done: true,
    stopMs: 400,
    ownerUid: 501,
    hostUid: 501,
    sameObject: false,
    mirrorChanged: false,
    ...changes,
  }
}

// Every way the probe can fail on its own.
function failuresOf(name) {
  if (name === 'stop') {
    return [{ stopMs: 6000 }, { stopMs: null }, { done: false, stopMs: null }]
  }

  const reported = [{ stdout: probeOutput(name, `probe ${name} fail synthetic detail`) }, { stdout: probeOutput(name, null) }]

  if (name === 'owner') {
    return [...reported, { ownerUid: 0 }, { ownerUid: null }]
  }

  if (name === 'mirror-object') {
    return [...reported, { sameObject: true }, { mirrorChanged: true }]
  }

  return reported
}

test('boundaryVerdict: a report where everything passed gives one ok line per probe, in order', () => {
  assert.equal(BOUNDARY_PROBES.length, 12)
  assert.deepEqual(boundaryVerdict(passingReport()), {
    lines: BOUNDARY_PROBES.map((probe) => `ok   boundary: ${probe.text}`),
    problems: [],
  })
})

test('boundaryVerdict: each probe that fails alone, in every way it can, gives exactly one problem that names it', () => {
  for (const { name } of BOUNDARY_PROBES) {
    for (const changes of failuresOf(name)) {
      const { lines, problems } = boundaryVerdict(passingReport(changes))
      const shown = `${name} ${JSON.stringify(changes)}`

      assert.equal(problems.length, 1, shown)
      assert.ok(problems[0].startsWith(`boundary probe ${name}: `), `${shown}: ${problems[0]}`)
      assert.equal(lines.length, 12, shown)
      assert.equal(lines.filter((line) => line.startsWith('FAIL boundary: ')).length, 1, shown)
    }
  }
})

test('boundaryVerdict: the details say what went wrong', () => {
  const problem = (changes) => boundaryVerdict(passingReport(changes)).problems[0]

  assert.equal(
    problem({ stdout: probeOutput('etc-readonly', 'probe etc-readonly fail the write succeeded') }),
    'boundary probe etc-readonly: the write succeeded',
  )

  assert.equal(problem({ stdout: probeOutput('no-mirror', null) }), 'boundary probe no-mirror: never reported')
  assert.equal(problem({ ownerUid: 0 }), 'boundary probe owner: owned by uid 0, you are 501')
  assert.equal(problem({ ownerUid: null }), 'boundary probe owner: no file')
  assert.equal(problem({ sameObject: true }), 'boundary probe mirror-object: the clone and the mirror share one file')
  assert.equal(problem({ mirrorChanged: true }), "boundary probe mirror-object: the mirror's copy changed")
  assert.equal(problem({ stopMs: 6000 }), 'boundary probe stop: took 6000 ms')
  assert.equal(problem({ stopMs: null }), 'boundary probe stop: did not end')
  assert.equal(problem({ done: false, stopMs: null }), 'boundary probe stop: the container never reached the stop')

  const { lines } = boundaryVerdict(passingReport({ ownerUid: 0 }))

  assert.ok(lines.includes('FAIL boundary: a file created in the clone belongs to you (owned by uid 0, you are 501)'), lines.join('\n'))
})

test('boundaryVerdict: a container that ended before its probes is one line and one problem', () => {
  const report = passingReport({
    stdout: '',
    stderr: 'docker: Error response from daemon: no such image\nmore\n',
    done: false,
    stopMs: null,
  })

  const text = 'boundary: the container ended before its probes (docker: Error response from daemon: no such image)'

  assert.deepEqual(boundaryVerdict(report), { lines: [`FAIL ${text}`], problems: [text] })
})

test('BOUNDARY_SCRIPT: valid sh without set -e that names every container probe and tests a file inside each absent path', () => {
  execFileSync('sh', ['-n', '-c', BOUNDARY_SCRIPT])

  for (const name of CONTAINER_PROBES) {
    assert.match(BOUNDARY_SCRIPT, new RegExp(`\\b${name}\\b`), name)
  }

  for (const path of ['"$2/manifest.yaml"', '"$3/.git"', '"$4/HEAD"']) {
    assert.ok(BOUNDARY_SCRIPT.includes(path), path)
  }

  assert.doesNotMatch(BOUNDARY_SCRIPT, /set -e/)
  assert.match(BOUNDARY_SCRIPT, /^echo probes-done$/m)
})
