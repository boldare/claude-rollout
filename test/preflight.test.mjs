import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManifest } from '../lib/manifest.mjs'
import { originCheck, probeTools, sshHostname, storedLoginCheck } from '../lib/preflight.mjs'
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

const M = { repo: { github: 'My-Org/my-lib' } }

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
    const result = await originCheck(M, url, spy.resolve)

    assert.deepEqual(result, { ok: true, text: 'my-org/my-lib on github.com' }, url)
  }

  assert.deepEqual(spy.calls, [])
})

test('origin through an SSH alias passes when it resolves to github.com', async () => {
  const spy = resolverSpy('GitHub.com')
  const result = await originCheck(M, 'git@github-work:my-org/my-lib.git', spy.resolve)

  assert.deepEqual(result, { ok: true, text: 'my-org/my-lib on github.com through SSH host github-work' })
  assert.deepEqual(spy.calls, ['github-work'])
})

test('origin through an SSH alias fails when it resolves elsewhere', async () => {
  const spy = resolverSpy('gitlab.example.com')
  const result = await originCheck(M, 'git@github-work:my-org/my-lib.git', spy.resolve)

  assert.equal(result.ok, false)
  assert.match(result.text, /gitlab\.example\.com/)
})

test('origin through an SSH alias fails when ssh -G fails', async () => {
  const spy = resolverSpy(new Error('exited 255'))
  const result = await originCheck(M, 'git@github-work:my-org/my-lib.git', spy.resolve)

  assert.equal(result.ok, false)
  assert.match(result.text, /github-work/)
  assert.match(result.text, /ssh -G/)
})

test('origin with another repo name fails before resolving', async () => {
  const spy = resolverSpy('github.com')
  const result = await originCheck(M, 'git@github.com:my-org/my-lib-next.git', spy.resolve)
  const alias = await originCheck(M, 'git@github-work:my-org/my-lib-next.git', spy.resolve)

  assert.equal(result.ok, false)
  assert.match(result.text, /my-org\/my-lib-next/)
  assert.equal(alias.ok, false)
  assert.deepEqual(spy.calls, [])
})

test('origin over HTTPS on another host fails without resolving', async () => {
  const spy = resolverSpy('github.com')

  for (const url of ['https://gitlab.com/my-org/my-lib.git', 'https://github-work/my-org/my-lib.git']) {
    const result = await originCheck(M, url, spy.resolve)

    assert.equal(result.ok, false, url)
  }

  assert.deepEqual(spy.calls, [])
})

test('origin texts never print credentials', async () => {
  const spy = resolverSpy('github.com')

  for (const url of ['https://x-access-token:secret@gitlab.com/my-org/my-lib.git', 'https://x:secret@example.com/a']) {
    const result = await originCheck(M, url, spy.resolve)

    assert.equal(result.ok, false, url)
    assert.doesNotMatch(result.text, /secret/, url)
  }
})

test('a missing or local origin fails', async () => {
  const spy = resolverSpy('github.com')
  const missing = await originCheck(M, '', spy.resolve)
  const local = await originCheck(M, '/srv/git/my-lib.git', spy.resolve)

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
  const M = loadManifest(makeRollout())

  M.repo.pathPrepend = [bin]
  M.repo.agentToken = join(M.dir, 'agent-token')
  writeFileSync(M.repo.agentToken, 'synthetic-agent-token\n')
  fakeGh(bin, finds)

  try {
    await run(M, () =>
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
    await withStoredLogin('keyring', async (M, calls) => {
      const result = await storedLoginCheck(M)
      const [first] = calls()

      assert.equal(result.lines[0], STORED_OK)
      assert.deepEqual(result.problems, [])
      assert.deepEqual(first.args, ['auth', 'status'])
      assert.equal(first.GH_TOKEN, undefined)
      assert.equal(first.GH_HOST, undefined)
      assert.equal(first.GH_CONFIG_DIR, join(M.dir, '.gh-agents'))
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
  await withStoredLogin('always', async (M) => {
    const result = await storedLoginCheck(M)

    assert.equal(result.lines[0], STORED_FAIL)
    assert.deepEqual(result.problems, ['agents could fall back to a stored gh login'])
  })
})

test('stored login: the GH_HOST fallback is an info line, never a problem', async () => {
  await withStoredLogin('keyring', async (M, calls) => {
    const result = await storedLoginCheck(M)
    const [, probe] = calls()

    assert.equal(result.lines.length, 2)
    assert.equal(result.lines[0], STORED_OK)
    assert.match(result.lines[1], /^info with GH_HOST set, gh would fall back to your keyring login/)
    assert.deepEqual(result.problems, [])
    assert.deepEqual(probe.args, ['auth', 'status'])
    assert.equal(probe.GH_HOST, 'github.com')
    assert.equal(probe.GH_TOKEN, undefined)
  })

  await withStoredLogin('token', async (M) => {
    const result = await storedLoginCheck(M)

    assert.deepEqual(result.lines, [STORED_OK])
    assert.deepEqual(result.problems, [])
  })
})
