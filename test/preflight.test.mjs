import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManifest } from '../lib/manifest.mjs'
import {
  adminAgentCheck,
  isFineGrained,
  originCheck,
  parseApiResponse,
  probeTools,
  sshHostname,
  storedLoginCheck,
} from '../lib/preflight.mjs'
import { makeRollout } from './fixtures.mjs'

function tools(install, verify) {
  return probeTools({ repo: { install, verify } })
}

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

async function withStoredLogin(finds, run) {
  const bin = mkdtempSync(join(tmpdir(), 'rollout-gh-'))
  const manifest = loadManifest(makeRollout())

  manifest.repo.pathPrepend = [bin]
  manifest.repo.agentToken = join(manifest.dir, 'agent-token')
  writeFileSync(manifest.repo.agentToken, 'synthetic-agent-token\n')
  fakeGh(bin, finds)

  try {
    await run(manifest, () =>
      readFileSync(join(bin, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    )
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
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
      assert.equal(first.GH_REPO, 'github.com/example/demo')
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

test('fine-grained tokens are the ones with the github_pat_ prefix', () => {
  assert.equal(isFineGrained('github_pat_synthetic'), true)

  for (const token of ['ghp_synthetic', 'gho_synthetic', 'synthetic-agent-token', '', undefined]) {
    assert.equal(isFineGrained(token), false, String(token))
  }
})

test('api responses: the status line and the JSON body, on errors too', () => {
  const ok = 'HTTP/2.0 200 OK\nContent-Type: application/json\n\n[{"ruleset_id":7}]\n'
  const missing = 'HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Branch not protected"}'

  assert.deepEqual(parseApiResponse(ok), { status: 200, json: [{ ruleset_id: 7 }] })
  assert.deepEqual(parseApiResponse(missing), { status: 404, json: { message: 'Branch not protected' } })
  assert.deepEqual(parseApiResponse('HTTP/1.1 502 Bad Gateway\n\n<html>'), { status: 502, json: null })
  assert.deepEqual(parseApiResponse('HTTP/2.0 204 No Content\n\n'), { status: 204, json: null })
  assert.deepEqual(parseApiResponse(''), { status: 0, json: null })
})

const adminRepo = { repo: { github: 'my-org/my-lib', base: 'main' } }
const RULES = 'repos/my-org/my-lib/rules/branches/main?per_page=100'
const PROTECTION = 'repos/my-org/my-lib/branches/main/protection'
const DENIED = { status: 403, json: { message: 'Resource not accessible by personal access token' } }

// Answers by path. A path without an answer gets none, the way a network error looks.
function fakeApi(answers) {
  const calls = []

  async function call(path) {
    calls.push(path)

    return answers[path] ?? { status: 0, json: null }
  }

  return { calls, call }
}

function limitedBot(overrides) {
  return {
    'repos/my-org/my-lib/actions/permissions': DENIED,
    'repos/my-org/my-lib/actions/secrets': DENIED,
    'repos/my-org/my-lib/hooks': DENIED,
    'orgs/my-org/rulesets': DENIED,
    [RULES]: {
      status: 200,
      json: [
        { type: 'deletion', ruleset_source_type: 'Repository', ruleset_id: 7 },
        { type: 'pull_request', ruleset_source_type: 'Repository', ruleset_id: 7 },
        { type: 'non_fast_forward', ruleset_source_type: 'Organization', ruleset_id: 9 },
      ],
    },
    'repos/my-org/my-lib/rulesets/7': { status: 200, json: { name: 'main', current_user_can_bypass: 'never' } },
    'repos/my-org/my-lib/rulesets/9': { status: 200, json: { name: 'org baseline', current_user_can_bypass: 'never' } },
    ...overrides,
  }
}

async function checkAdmin({ bot = {}, maintainer = {}, fineGrained = true, manifest = adminRepo } = {}) {
  const botApi = fakeApi(limitedBot(bot))
  const maintainerApi = fakeApi({ [PROTECTION]: { status: 404, json: { message: 'Branch not protected' } }, ...maintainer })
  const result = await adminAgentCheck(manifest, { login: 'org-bot', fineGrained, bot: botApi.call, maintainer: maintainerApi.call })

  return { ...result, botCalls: botApi.calls, maintainerCalls: maintainerApi.calls }
}

test('admin agent: a fine-grained token without admin permissions or bypass passes', async () => {
  const result = await checkAdmin()

  assert.deepEqual(result.lines, [
    'ok   agent token is fine-grained',
    'ok   agent token cannot use Administration (repos/my-org/my-lib/actions/permissions: 403)',
    'ok   agent token cannot use Secrets (repos/my-org/my-lib/actions/secrets: 403)',
    'ok   agent token cannot use Webhooks (repos/my-org/my-lib/hooks: 403)',
    'ok   agent token cannot use organization Administration (orgs/my-org/rulesets: 403)',
    'ok   org-bot cannot bypass ruleset main on main',
    'ok   org-bot cannot bypass ruleset org baseline on main',
    'ok   no branch protection on main',
  ])

  assert.deepEqual(result.problems, [])
})

test('admin agent: the bot token asks about itself, and only branch protection is read as you', async () => {
  const result = await checkAdmin()

  assert.ok(!result.botCalls.includes(PROTECTION))
  assert.deepEqual(result.maintainerCalls, [PROTECTION])
})

test('admin agent: a classic token fails without a single call', async () => {
  const result = await checkAdmin({ fineGrained: false })

  assert.deepEqual(result.lines, ['FAIL agent token is not fine-grained'])
  assert.deepEqual(result.problems, ['repo.agentAdmin needs a fine-grained agent token: a classic one can do all the admin role can'])
  assert.deepEqual(result.botCalls, [])
  assert.deepEqual(result.maintainerCalls, [])
})

test('admin agent: 404 counts as no access, like 403', async () => {
  const result = await checkAdmin({ bot: { 'orgs/my-org/rulesets': { status: 404, json: { message: 'Not Found' } } } })

  assert.ok(result.lines.includes('ok   agent token cannot use organization Administration (orgs/my-org/rulesets: 404)'))
  assert.deepEqual(result.problems, [])
})

test('admin agent: a token with an admin permission fails and names it', async () => {
  const result = await checkAdmin({
    bot: {
      'repos/my-org/my-lib/actions/permissions': { status: 200, json: { enabled: true } },
      'repos/my-org/my-lib/hooks': { status: 200, json: [] },
    },
  })

  assert.ok(result.lines.includes('FAIL agent token can use Administration (repos/my-org/my-lib/actions/permissions: 200)'))
  assert.deepEqual(result.problems, [
    'agent token has the Administration permission: take it away',
    'agent token has the Webhooks permission: take it away',
  ])
})

test('admin agent: an error or no answer proves nothing and fails', async () => {
  const result = await checkAdmin({
    bot: {
      'repos/my-org/my-lib/actions/secrets': { status: 500, json: null },
      'orgs/my-org/rulesets': { status: 0, json: null },
    },
  })

  assert.deepEqual(result.problems, [
    'cannot tell whether the agent token can use Secrets (repos/my-org/my-lib/actions/secrets: 500)',
    'cannot tell whether the agent token can use organization Administration (orgs/my-org/rulesets: no answer)',
  ])
})

test('admin agent: any bypass but never fails, an unknown one too', async () => {
  for (const bypass of ['always', 'pull_requests_only', 'exempt', undefined]) {
    const result = await checkAdmin({
      bot: { 'repos/my-org/my-lib/rulesets/9': { status: 200, json: { name: 'org baseline', current_user_can_bypass: bypass } } },
    })

    assert.ok(result.lines.includes(`FAIL org-bot can bypass ruleset org baseline on main (${bypass ?? 'unknown'})`), String(bypass))
    assert.deepEqual(result.problems, ['org-bot can bypass ruleset org baseline: take its role and its account off the bypass list'])
  }
})

test('admin agent: rules or a ruleset the token cannot read fail', async () => {
  const noRules = await checkAdmin({ bot: { [RULES]: DENIED } })

  assert.deepEqual(noRules.problems, ['cannot read the rules on main with the agent token (403)'])

  const noRuleset = await checkAdmin({ bot: { 'repos/my-org/my-lib/rulesets/9': { status: 404, json: { message: 'Not Found' } } } })

  assert.deepEqual(noRuleset.problems, ['cannot read ruleset 9 on main with the agent token (404)'])
})

test('admin agent: a base without rulesets passes that part', async () => {
  const result = await checkAdmin({ bot: { [RULES]: { status: 200, json: [] } } })

  assert.ok(result.lines.includes('ok   no ruleset applies to main'))
  assert.deepEqual(result.problems, [])
})

test('admin agent: branch protection must hold for admins, and must be readable', async () => {
  const enforced = await checkAdmin({ maintainer: { [PROTECTION]: { status: 200, json: { enforce_admins: { enabled: true } } } } })

  assert.ok(enforced.lines.includes('ok   branch protection on main holds for admins too'))
  assert.deepEqual(enforced.problems, [])

  const bypassed = await checkAdmin({ maintainer: { [PROTECTION]: { status: 200, json: { enforce_admins: { enabled: false } } } } })

  assert.deepEqual(bypassed.problems, [
    'branch protection on main lets admins bypass it: turn on "Do not allow bypassing the above settings"',
  ])

  // GitHub answers a plain Not Found when you are not an admin.
  const hidden = await checkAdmin({ maintainer: { [PROTECTION]: { status: 404, json: { message: 'Not Found' } } } })

  assert.deepEqual(hidden.problems, ['cannot read the branch protection on main as you (404): it needs the admin role'])
})

test('admin agent: a base with a slash is one path segment', async () => {
  const manifest = { repo: { github: 'my-org/my-lib', base: 'release/1.x' } }
  const result = await checkAdmin({ manifest })

  assert.ok(result.botCalls.includes('repos/my-org/my-lib/rules/branches/release%2F1.x?per_page=100'))
  assert.deepEqual(result.maintainerCalls, ['repos/my-org/my-lib/branches/release%2F1.x/protection'])
})
