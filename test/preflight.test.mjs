import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { originCheck, probeTools, sshHostname } from '../lib/preflight.mjs'

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
