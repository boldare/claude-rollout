import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../lib/server.mjs'
import { makeRolloutRoot } from './fixtures.mjs'

const BIN = fileURLToPath(new URL('../bin/rollout.mjs', import.meta.url))
const UI = fileURLToPath(new URL('../ui/', import.meta.url))
const CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'"

async function serve(t, options = {}) {
  const root = options.root ?? makeRolloutRoot()
  const server = await startServer({ root, ...options })

  t.after(() => server.close())

  return { server, root }
}

function bearer(server) {
  return { authorization: `Bearer ${server.token}` }
}

// fetch drops a custom Host header and normalizes paths, so the Host,
// encoding and traversal tests send raw requests.
function raw(port, path, { method = 'GET', host = `127.0.0.1:${port}`, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, method, path, agent: false, headers: { host, ...headers } }, (response) => {
      let body = ''

      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })

    outgoing.on('error', reject)
    outgoing.end()
  })
}

async function get(server, path, headers = bearer(server)) {
  const response = await fetch(`${server.origin}${path}`, { headers })
  const body = await response.text()

  return { status: response.status, headers: response.headers, body, json: () => JSON.parse(body) }
}

function parseMessage(block) {
  let event = 'message'
  const data = []

  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) {
      event = line.slice('event: '.length)
    } else if (line.startsWith('data: ')) {
      data.push(line.slice('data: '.length))
    }
  }

  return data.length > 0 ? { event, data: JSON.parse(data.join('\n')) } : null
}

// Reads the stream with fetch like the page does. Every wait has its own
// timeout, so a broken watcher fails the test instead of hanging it.
async function openStream(t, server, name) {
  const controller = new AbortController()
  const response = await fetch(`${server.origin}/api/rollouts/${name}/stream`, { headers: bearer(server), signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let pending = null

  t.after(() => controller.abort())

  async function read(timeoutMs) {
    if (!pending) {
      pending = reader.read()
      pending.catch(() => {})
    }

    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out waiting for the stream')), Math.max(timeoutMs, 0))
    })

    try {
      const { value, done } = await Promise.race([pending, timeout])
      pending = null

      if (done) {
        throw new Error('stream ended')
      }

      buffer += decoder.decode(value, { stream: true })
    } finally {
      clearTimeout(timer)
    }
  }

  function take() {
    for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
      const message = parseMessage(buffer.slice(0, end))
      buffer = buffer.slice(end + 2)

      if (message) {
        return message
      }
    }

    return null
  }

  async function next(matches = () => true, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs

    for (;;) {
      for (let message = take(); message; message = take()) {
        if (matches(message)) {
          return message
        }
      }

      await read(deadline - Date.now())
    }
  }

  return { response, next }
}

// On macOS a new fs.watch starts listening a moment after it returns, later
// still on a busy machine. Touching the heartbeat until a state arrives
// proves the watcher is live before a test counts on it.
async function watcherLive(stream, dir) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    writeFileSync(join(dir, 'heartbeat'), `${new Date().toISOString()} tick ${attempt}`)

    try {
      await stream.next((message) => message.event === 'state', 500)
      return
    } catch {
      // Not live yet.
    }
  }

  throw new Error('the watcher never reported a change')
}

function replaceLedger(dir, text) {
  const tmp = join(dir, 'ledger.json.test.tmp')

  writeFileSync(tmp, text)
  renameSync(tmp, join(dir, 'ledger.json'))
}

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)

    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

function scriptsUnder(dir) {
  return filesUnder(dir).filter((file) => file.endsWith('.js'))
}

function cliEnv(role) {
  const env = { ...process.env }

  delete env.ROLLOUT_ROLE

  if (role) {
    env.ROLLOUT_ROLE = role
  }

  return env
}

function firstLine(stream, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error(`no line within ${timeoutMs} ms: ${text}`)), timeoutMs)

    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      text += chunk

      if (text.includes('\n')) {
        clearTimeout(timer)
        resolve(text.split('\n')[0])
      }
    })
  })
}

test('startServer binds 127.0.0.1 on a random port and builds the URL from a 43-character token', async (t) => {
  const { server } = await serve(t)

  assert.ok(server.origin.startsWith('http://127.0.0.1:'), server.origin)
  assert.equal(server.origin, `http://127.0.0.1:${server.port}`)
  assert.ok(server.port > 0)
  assert.match(server.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(server.url, `${server.origin}/#t=${server.token}`)
})

test('startServer rejects when the port is taken', async (t) => {
  const { server, root } = await serve(t)

  await assert.rejects(startServer({ root, port: server.port }), { code: 'EADDRINUSE' })
})

test('/ is the page, with the security headers and no CORS', async (t) => {
  const { server } = await serve(t)
  const page = await raw(server.port, '/')

  assert.equal(page.status, 200)
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.equal(page.headers['x-content-type-options'], 'nosniff')
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.equal(page.headers['content-security-policy'], CSP)
  assert.equal(page.headers['access-control-allow-origin'], undefined)
  assert.match(page.body, /<title>rollout<\/title>/)
})

test('static: traversal, escapes and malformed escapes never leave ui/', async (t) => {
  const { server } = await serve(t)

  for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/..%5cpackage.json']) {
    const response = await raw(server.port, path)
    assert.equal(response.status, 404, path)
    assert.deepEqual(JSON.parse(response.body), { error: 'not found' }, path)
  }

  const malformed = await raw(server.port, '/%E0%A4%A')
  assert.equal(malformed.status, 400)
  assert.deepEqual(JSON.parse(malformed.body), { error: 'bad path' })
})

test('static: nested files, but no dotfiles, unknown types or directories', async (t) => {
  const uiDir = mkdtempSync(join(tmpdir(), 'rollout-ui-'))

  mkdirSync(join(uiDir, 'sub'))
  mkdirSync(join(uiDir, 'folder.js'))
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>temp</title>\n')
  writeFileSync(join(uiDir, 'sub', 'x.js'), 'export const x = 1\n')
  writeFileSync(join(uiDir, '.secret.js'), 'export const secret = 1\n')
  writeFileSync(join(uiDir, 'notes.txt'), 'notes\n')

  const { server } = await serve(t, { uiDir })
  const nested = await raw(server.port, '/sub/x.js')

  assert.equal(nested.status, 200)
  assert.equal(nested.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(nested.body, 'export const x = 1\n')
  assert.match((await raw(server.port, '/')).body, /temp/)

  for (const path of ['/.secret.js', '/sub/.secret.js', '/notes.txt', '/sub', '/sub/', '/folder.js', '/missing.js', '/sub//x.js']) {
    assert.equal((await raw(server.port, path)).status, 404, path)
  }

  writeFileSync(join(uiDir, 'sub', 'x.js'), 'export const x = 2\n')
  assert.equal((await raw(server.port, '/sub/x.js')).body, 'export const x = 2\n')
})

test('api: only the Bearer token opens it, and /%61pi is the same path', async (t) => {
  const { server } = await serve(t)
  const wrongOfSameLength = `Bearer ${'x'.repeat(server.token.length)}`

  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: wrongOfSameLength }, { authorization: server.token }]) {
    const response = await get(server, '/api/rollouts', headers)
    assert.equal(response.status, 401, JSON.stringify(headers))
    assert.deepEqual(response.json(), { error: 'unauthorized' })
  }

  assert.equal((await get(server, `/api/rollouts?t=${server.token}`, {})).status, 401)
  assert.equal((await get(server, '/api/rollouts')).status, 200)

  const escaped = await raw(server.port, '/%61pi/rollouts')
  assert.equal(escaped.status, 401)
  assert.equal((await raw(server.port, '/%61pi/rollouts', { headers: bearer(server) })).status, 200)
})

test('Host: only 127.0.0.1 and localhost on this port, on static and API paths alike', async (t) => {
  const { server } = await serve(t)
  const { port } = server

  for (const host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `localhost.evil.example:${port}`]) {
    for (const path of ['/', '/app.js', '/api/rollouts']) {
      const response = await raw(port, path, { host, headers: bearer(server) })
      assert.equal(response.status, 403, `${host} ${path}`)
      assert.deepEqual(JSON.parse(response.body), { error: 'bad host' })
    }
  }

  for (const host of [`localhost:${port}`, `LOCALHOST:${port}`, `127.0.0.1:${port}`]) {
    assert.equal((await raw(port, '/', { host })).status, 200, host)
    assert.equal((await raw(port, '/api/rollouts', { host, headers: bearer(server) })).status, 200, host)
  }
})

test('Origin: every non-GET needs this origin, then gets 405, and nothing carries CORS headers', async (t) => {
  const { server } = await serve(t)
  const { port } = server
  const responses = []

  async function send(method, path, headers) {
    const response = await raw(port, path, { method, headers })
    responses.push(response)

    return response
  }

  for (const origin of [undefined, 'http://evil.example', `http://127.0.0.1:${port + 1}`, 'null']) {
    const headers = origin ? { ...bearer(server), origin } : bearer(server)
    const response = await send('POST', '/api/rollouts', headers)
    assert.equal(response.status, 403, origin)
    assert.deepEqual(JSON.parse(response.body), { error: 'bad origin' })
  }

  const preflight = await send('OPTIONS', '/api/rollouts', { origin: 'http://evil.example', 'access-control-request-method': 'POST' })
  assert.equal(preflight.status, 403)

  for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
    const response = await send('POST', '/api/rollouts', { ...bearer(server), origin })
    assert.equal(response.status, 405, origin)
    assert.deepEqual(JSON.parse(response.body), { error: 'method not allowed' })
  }

  assert.equal((await send('POST', '/api/rollouts', { origin: server.origin })).status, 401)
  assert.equal((await send('DELETE', '/', { origin: server.origin })).status, 405)
  await send('GET', '/api/rollouts', { ...bearer(server), origin: 'http://evil.example' })

  for (const response of responses) {
    const cors = Object.keys(response.headers).filter((name) => name.startsWith('access-control-'))
    assert.deepEqual(cors, [])
  }
})

test('api: the list, a rollout state, events after N, a PR, and the errors', async (t) => {
  const { server, root } = await serve(t)
  const list = (await get(server, '/api/rollouts')).json()

  assert.equal(list.root, root)
  assert.deepEqual(
    list.rollouts.map((rollout) => [rollout.name, rollout.error === null]),
    [
      ['broken', false],
      ['demo', true],
      ['fresh', true],
    ],
  )

  const state = await get(server, '/api/rollouts/demo')
  const { view } = state.json()
  assert.equal(state.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(state.json().name, 'demo')
  assert.equal(view.rows.length, 3)
  assert.equal(view.eventCount, 9)
  assert.equal(view.runs.length, 4)
  assert.equal(view.costs.totalUsd, 7.75)
  assert.equal(view.events, undefined)
  assert.equal((await get(server, '/api/rollouts/fresh')).json().view, null)

  const after = (await get(server, '/api/rollouts/demo/events?after=5')).json()
  assert.equal(after.from, 5)
  assert.equal(after.events.length, 4)
  assert.equal((await get(server, '/api/rollouts/demo/events')).json().events.length, 9)
  assert.deepEqual((await get(server, '/api/rollouts/demo/events?after=99')).json().from, 0)

  for (const value of ['x', '-1', '1.5', '']) {
    assert.equal((await get(server, `/api/rollouts/demo/events?after=${value}`)).status, 400, value)
  }

  const pr = (await get(server, '/api/rollouts/demo/prs/A1')).json()
  assert.equal(pr.pr, 11)
  assert.equal(pr.verdicts.length, 1)
  assert.equal(pr.briefText, '# A1\n')
  assert.equal(pr.notesText, null)

  const unknownPr = await get(server, '/api/rollouts/demo/prs/Z9')
  assert.equal(unknownPr.status, 404)
  assert.deepEqual(unknownPr.json(), { error: 'unknown PR' })

  for (const name of ['nope', 'demo.worktrees', '..%2fdemo', '.demo']) {
    const response = await raw(server.port, `/api/rollouts/${name}`, { headers: bearer(server) })
    assert.equal(response.status, 404, name)
    assert.deepEqual(JSON.parse(response.body), { error: 'unknown rollout' })
  }

  for (const path of ['/api', '/api/other', '/api/rollouts/demo/other', '/api/rollouts/demo/prs', '/api/rollouts/demo/prs/A1/x']) {
    assert.equal((await get(server, path)).status, 404, path)
  }

  const broken = await get(server, '/api/rollouts/broken')
  assert.equal(broken.status, 500)
  assert.match(broken.json().error, /invalid manifest/)
  assert.equal((await get(server, '/api/rollouts')).status, 200)
})

test('stream: state and every event on connect, then appended events and a renamed ledger', async (t) => {
  const { server, root } = await serve(t, { pollMs: 60_000 })
  const dir = join(root, 'demo')
  const stream = await openStream(t, server, 'demo')

  assert.equal(stream.response.status, 200)
  assert.equal(stream.response.headers.get('content-type'), 'text/event-stream; charset=utf-8')
  assert.equal(stream.response.headers.get('cache-control'), 'no-store')

  const state = await stream.next()
  assert.equal(state.event, 'state')
  assert.equal(state.data.view.eventCount, 9)

  const events = await stream.next()
  assert.equal(events.event, 'events')
  assert.equal(events.data.from, 0)
  assert.equal(events.data.events.length, 9)

  await watcherLive(stream, dir)
  appendFileSync(join(dir, 'events.jsonl'), `\n${JSON.stringify({ at: new Date().toISOString(), id: 'A3', kind: 'note' })}\n`)

  const appended = await stream.next((message) => message.event === 'events')
  assert.equal(appended.data.from, 9)
  assert.deepEqual(
    appended.data.events.map((event) => event.kind),
    ['note'],
  )

  const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'))
  replaceLedger(dir, JSON.stringify({ ...ledger, prs: { ...ledger.prs, A3: { state: 'implementing' } } }))

  const renamed = await stream.next((message) => message.event === 'state' && message.data.view.rows[2].state === 'implementing')
  assert.equal(renamed.data.view.eventCount, 10)
})

test('stream: subscribers share a hub but each gets its own tail', async (t) => {
  const { server, root } = await serve(t, { pollMs: 60_000 })
  const file = join(root, 'demo', 'events.jsonl')
  const early = await openStream(t, server, 'demo')

  await early.next((message) => message.event === 'events')
  await watcherLive(early, join(root, 'demo'))
  appendFileSync(file, '\n{"id":"A3","kind":"first"}\n')
  assert.equal((await early.next((message) => message.event === 'events')).data.from, 9)

  const late = await openStream(t, server, 'demo')
  assert.equal((await late.next((message) => message.event === 'events')).data.events.length, 10)

  appendFileSync(file, '{"id":"A3","kind":"second"}\n')

  for (const stream of [early, late]) {
    const tail = await stream.next((message) => message.event === 'events')
    assert.equal(tail.data.from, 10)
    assert.deepEqual(
      tail.data.events.map((event) => event.kind),
      ['second'],
    )
  }
})

test('stream: an unreadable ledger or a vanished rollout is a problem, and the stream stays open', async (t) => {
  const { server, root } = await serve(t, { pollMs: 60_000 })
  const dir = join(root, 'demo')
  const good = readFileSync(join(dir, 'ledger.json'), 'utf8')
  const stream = await openStream(t, server, 'demo')

  await stream.next((message) => message.event === 'events')
  await watcherLive(stream, dir)
  replaceLedger(dir, '{"prs":')

  const problem = await stream.next((message) => message.event === 'problem')
  assert.match(problem.data.error, /JSON/)

  replaceLedger(dir, good)
  assert.equal((await stream.next((message) => message.event === 'state')).data.view.rows.length, 3)

  renameSync(join(dir, 'manifest.yaml'), join(dir, 'manifest.yaml.bak'))
  assert.deepEqual((await stream.next((message) => message.event === 'problem')).data, { error: 'unknown rollout' })

  renameSync(join(dir, 'manifest.yaml.bak'), join(dir, 'manifest.yaml'))
  assert.equal((await stream.next((message) => message.event === 'state')).data.name, 'demo')
})

test('stream: a driver that dies without touching a file shows as stopped', async (t) => {
  const { server, root } = await serve(t, { pollMs: 200 })
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })

  t.after(() => child.kill())
  await once(child, 'spawn')

  const stream = await openStream(t, server, 'demo')
  writeFileSync(join(root, 'demo', 'driver.lock'), JSON.stringify({ pid: child.pid, at: new Date().toISOString() }))
  await stream.next((message) => message.event === 'state' && message.data.view.driver.pid === child.pid)

  const exited = once(child, 'exit')
  child.kill()
  await exited

  const stopped = await stream.next((message) => message.event === 'state' && message.data.view.driver.running === false, 2000)
  assert.equal(stopped.data.view.driver.pid, null)
})

test('stream: needs the token, and close() ends open streams', async (t) => {
  const root = makeRolloutRoot()
  const server = await startServer({ root })

  t.after(() => server.close())

  const refused = await get(server, '/api/rollouts/demo/stream', {})
  assert.equal(refused.status, 401)
  assert.deepEqual(refused.json(), { error: 'unauthorized' })
  assert.equal((await get(server, '/api/rollouts/nope/stream')).status, 404)

  const stream = await openStream(t, server, 'demo')
  await stream.next((message) => message.event === 'events')

  let timer
  const tooSlow = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('close() hung')), 3000)
  })

  await Promise.race([server.close(), tooSlow]).finally(() => clearTimeout(timer))
  await assert.rejects(
    stream.next(() => true, 2000),
    /stream ended|terminated|aborted/,
  )
  await server.close()
})

test('page: every asset and module of ui/index.html is served, and every ui script parses', async (t) => {
  const { server } = await serve(t)
  const html = readFileSync(join(UI, 'index.html'), 'utf8')
  const queue = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1])
  const seen = new Set()

  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/)
  assert.ok(queue.length > 0)

  while (queue.length > 0) {
    const path = new URL(queue.shift(), server.origin).pathname

    if (seen.has(path)) {
      continue
    }

    seen.add(path)

    const response = await raw(server.port, path)
    assert.equal(response.status, 200, path)

    if (path.endsWith('.js')) {
      assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8', path)

      for (const match of response.body.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([./][^'"]*)['"]/g)) {
        queue.push(new URL(match[1], `${server.origin}${path}`).pathname)
      }
    }
  }

  assert.ok(seen.has('/app.js'))

  for (const file of scriptsUnder(UI)) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${file}: ${result.stderr}`)
  }
})

test('cli: help lists ui', () => {
  const result = spawnSync(process.execPath, [BIN, 'help'], { encoding: 'utf8', env: cliEnv() })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /rollout\.mjs ui +\[--root ROOT\] \[--port N\] \[--no-open\]/)
})

test('cli: ui prints a URL with the token, never writes it, and exits 0 on SIGTERM', async (t) => {
  const root = makeRolloutRoot()
  const child = spawn(process.execPath, [BIN, 'ui', '--root', root, '--port', '0', '--no-open'], {
    env: cliEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''

  child.stderr.on('data', (chunk) => (stderr += chunk))
  t.after(() => child.kill())

  const line = await firstLine(child.stdout)
  const match = /^rollout ui: (http:\/\/127\.0\.0\.1:\d+)\/#t=([^ ]+) \(Ctrl-C stops it\)$/.exec(line)

  assert.ok(match, `${line}\n${stderr}`)

  const [, origin, token] = match
  assert.equal(token.length, 43)

  const response = await fetch(`${origin}/api/rollouts`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).root, root)

  for (const file of filesUnder(root)) {
    assert.equal(readFileSync(file).includes(token), false, file)
  }

  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  assert.deepEqual(await exited, [0, null])
})

test('cli: ui is refused to agents and rejects a bad port', () => {
  const root = makeRolloutRoot()
  const run = (args, role) =>
    spawnSync(process.execPath, [BIN, 'ui', '--root', root, '--no-open', ...args], { encoding: 'utf8', env: cliEnv(role), timeout: 10_000 })

  const agent = run(['--port', '0'], 'implement')
  assert.equal(agent.status, 1)
  assert.match(agent.stderr, /agents cannot drive the rollout/)

  for (const port of ['abc', '70000', '-1', '1.5']) {
    const result = run([`--port=${port}`])
    assert.equal(result.status, 1, port)
    assert.match(result.stderr, /--port must be a number from 0 to 65535/, port)
  }
})
