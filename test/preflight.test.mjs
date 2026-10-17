import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManifest } from '../lib/manifest.mjs'
import { agentTokenCheck, claudeWrapperWarning, originCheck, probeTools, sshHostname, storedLoginCheck } from '../lib/preflight.mjs'
import { makeRollout } from './fixtures.mjs'

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

// Answers by the exact joined arguments, logs what gh saw and never reads
// stdin, which sh() leaves open. An unknown call fails.
function fakeAnsweringGh(dir, answers) {
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
const answers = ${JSON.stringify(answers)}
const answer = answers[args.join(' ')] ?? { stderr: 'unexpected call\\n', code: 1 }
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify({ args, GH_TOKEN: process.env.GH_TOKEN }) + '\\n')
process.stdout.write(answer.stdout ?? '')
process.stderr.write(answer.stderr ?? '')
process.exitCode = answer.code ?? 0
`,
    { mode: 0o755 },
  )
}

const REASONS = { 200: 'OK', 403: 'Forbidden', 404: 'Not Found' }

// What `gh api -i` prints: a status line, headers ending in \r\n, a blank line and the body.
function response(status, headers, body) {
  return `HTTP/2.0 ${status} ${REASONS[status]}\n${headers.map((header) => `${header}\r\n`).join('')}\r\n${JSON.stringify(body)}`
}

function repositoryAnswer(probe) {
  if (probe === null) {
    return { stderr: 'error connecting to api.github.com\n', code: 1 }
  }

  const stdout = response(probe, ['Content-Type: application/json; charset=utf-8'], { full_name: 'example/widgets' })

  if (probe === 200) {
    return { stdout }
  }

  return { stdout, stderr: `gh: ${REASONS[probe]} (HTTP ${probe})\n`, code: 1 }
}

// scopes null leaves the X-Oauth-Scopes header out, and probe null is a probe GitHub never answered.
function agentAnswers({ permission = 'write', scopes = 'repo, workflow, read:org', probe = 200 } = {}) {
  const scopeHeader = scopes === null ? [] : [`X-Oauth-Scopes: ${scopes}`]
  const headers = ['Content-Type: application/json; charset=utf-8', 'X-Accepted-Oauth-Scopes: ', ...scopeHeader, 'X-Ratelimit-Limit: 5000']

  return {
    'api user --jq .login': { stdout: 'demo-bot\n' },
    'api repos/example/widgets/collaborators/demo-bot/permission --jq .permission': { stdout: `${permission}\n` },
    'api -i user': { stdout: response(200, headers, { login: 'demo-bot' }) },
    'api -i repos/example/widgets': repositoryAnswer(probe),
  }
}

const CLASSIC_TOKEN = 'ghp_synthetic0123456789abcdef'
const FINE_GRAINED_TOKEN = 'github_pat_synthetic0123456789abcdef'

function withAgentToken(token, answers, run) {
  return withAgentGh(token, (bin) => fakeAnsweringGh(bin, answers), run)
}

const IDENTITY_PROBLEM = 'agent token must belong to a non-maintainer account with write (not admin) permission'
const WORKFLOW_WARNING = 'agent token lacks the workflow scope: PRs that change .github/workflows cannot be pushed'
const READ_ORG_WARNING =
  'agent token lacks the read:org scope: gh cannot edit or read a PR with a team review request, so agents cannot update their PR description'

test('agent token: a classic token that sees the repository passes', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentAnswers(), async (manifest, calls) => {
    const result = await agentTokenCheck(manifest)
    const probe = calls().find((call) => call.args.join(' ') === 'api -i repos/example/widgets')
    const role = calls().find((call) => call.args[1].endsWith('/permission'))

    assert.deepEqual(result, {
      lines: [
        'ok   agent identity: demo-bot (permission write, scopes repo, workflow, read:org)',
        'ok   agent token can see example/widgets',
      ],
      problems: [],
      warnings: [],
    })

    assert.deepEqual(probe.args, ['api', '-i', 'repos/example/widgets'])
    assert.equal(probe.GH_TOKEN, CLASSIC_TOKEN)
    assert.notEqual(role.GH_TOKEN, CLASSIC_TOKEN)
  })
})

test('agent token: a token that cannot see the repository fails with the status', async () => {
  for (const status of [404, 403]) {
    await withAgentToken(CLASSIC_TOKEN, agentAnswers({ probe: status }), async (manifest) => {
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
  await withAgentToken(CLASSIC_TOKEN, agentAnswers({ probe: null }), async (manifest) => {
    const result = await agentTokenCheck(manifest)

    assert.ok(result.lines.includes('FAIL agent token cannot see example/widgets (no answer)'))
    assert.deepEqual(result.problems, [
      'agent token cannot see example/widgets (no answer): give the token the repo scope and its account access to the repository',
    ])
  })
})

test('agent token: a fine-grained token fails without scope warnings and is never printed', async () => {
  await withAgentToken(FINE_GRAINED_TOKEN, agentAnswers({ scopes: null }), async (manifest, calls) => {
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
    assert.ok(calls().some((call) => call.args.join(' ') === 'api -i repos/example/widgets'))
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
    await withAgentToken(CLASSIC_TOKEN, agentAnswers({ scopes }), async (manifest) => {
      const result = await agentTokenCheck(manifest)

      assert.deepEqual(result.warnings, warnings, scopes)
      assert.deepEqual(result.problems, [], scopes)
    })
  }
})

test('agent token: an empty or missing scopes header is no scopes', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentAnswers({ scopes: '' }), async (manifest) => {
    const result = await agentTokenCheck(manifest)

    assert.equal(result.lines[0], 'ok   agent identity: demo-bot (permission write, scopes none)')
    assert.deepEqual(result.warnings, [WORKFLOW_WARNING, READ_ORG_WARNING])
  })

  await withAgentToken(CLASSIC_TOKEN, agentAnswers({ scopes: null }), async (manifest) => {
    const result = await agentTokenCheck(manifest)

    assert.equal(result.lines[0], 'ok   agent identity: demo-bot (permission write, scopes ?)')
    assert.deepEqual(result.warnings, [WORKFLOW_WARNING, READ_ORG_WARNING])
  })
})

test('agent token: an account with admin permission fails the identity check', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentAnswers({ permission: 'admin' }), async (manifest) => {
    const result = await agentTokenCheck(manifest)

    assert.equal(result.lines[0], 'FAIL agent identity: demo-bot (permission admin, scopes repo, workflow, read:org)')
    assert.deepEqual(result.problems, [IDENTITY_PROBLEM])
  })
})

test('agent token: a maintainer account fails the identity check', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentAnswers(), async (manifest) => {
    manifest.repo.maintainers = ['demo-bot']

    const result = await agentTokenCheck(manifest)

    assert.match(result.lines[0], /^FAIL agent identity: demo-bot /)
    assert.deepEqual(result.problems, [IDENTITY_PROBLEM])
  })
})

test('agent token: a missing token file throws', async () => {
  await withAgentToken(CLASSIC_TOKEN, agentAnswers(), async (manifest) => {
    rmSync(manifest.repo.agentToken)

    await assert.rejects(agentTokenCheck(manifest), /repo\.agentToken .* does not exist/)
  })
})
