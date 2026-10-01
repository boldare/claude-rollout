import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDriver } from '../lib/driver.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { startServer } from '../lib/server.mjs'
import { readEvents } from '../lib/view.mjs'
import { alive, makeRollout, makeRolloutRoot, waitFor } from './fixtures.mjs'

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
function raw(port, path, { method = 'GET', host = `127.0.0.1:${port}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, method, path, agent: false, headers: { host, ...headers } }, (response) => {
      let body = ''

      response.setEncoding('utf8')
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })

    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

// fetch sends no Origin and turns a string body into text/plain, so commands go through raw().
async function post(server, name, body, { origin = server.origin, token = server.token, contentType = 'application/json' } = {}) {
  const headers = {}

  if (origin) {
    headers.origin = origin
  }

  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  if (contentType) {
    headers['content-type'] = contentType
  }

  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const response = await raw(server.port, `/api/rollouts/${name}/commands`, { method: 'POST', headers, body: text })

  return { ...response, json: JSON.parse(response.body) }
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
  delete env.ROLLOUT_ROOT
  delete env.ROLLOUT_DIR

  if (role) {
    env.ROLLOUT_ROLE = role
  }

  return env
}

// Async, so this process can reap a child the CLI kills. A zombie still
// answers process.kill(pid, 0), and the CLI would wait for it in vain.
async function runCli(args) {
  const child = spawn(process.execPath, [BIN, ...args], { env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''

  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))

  const [code] = await once(child, 'close')

  return { code, stdout, stderr }
}

function inboxFiles(dir) {
  const inbox = join(dir, 'inbox')

  return existsSync(inbox) ? readdirSync(inbox).filter((name) => !name.startsWith('.')) : []
}

// A driverCommand that must never run.
function refusedDriver(calls) {
  return (_, options) => {
    calls.push(options)

    return { command: process.execPath, args: ['-e', ''] }
  }
}

const FAKE_DRIVER = `
const { writeFileSync } = require('node:fs')

process.on('SIGTERM', () => {
  console.log('fake driver: SIGTERM')
  process.exit(0)
})
writeFileSync('driver.lock', JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
console.log('fake driver: dry-run=' + process.argv.includes('--dry-run') + ' env=' + JSON.stringify(process.env))
setInterval(() => {}, 1000)
`

function fakeDriver() {
  const script = join(mkdtempSync(join(tmpdir(), 'rollout-fake-')), 'driver.cjs')

  writeFileSync(script, FAKE_DRIVER)

  return (_, { dryRun }) => ({ command: process.execPath, args: [script, ...(dryRun ? ['--dry-run'] : [])] })
}

function lines(stream, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error(`no ${count} lines within ${timeoutMs} ms: ${text}`)), timeoutMs)

    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      text += chunk

      if (text.split('\n').length > count) {
        clearTimeout(timer)
        resolve(text.split('\n').slice(0, count))
      }
    })
  })
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

  const notFound = [
    '/api',
    '/api/other',
    '/api/rollouts/demo/other',
    '/api/rollouts/demo/prs',
    '/api/rollouts/demo/prs/A1/x',
    '/api/rollouts/demo/runs',
    '/api/rollouts/demo/runs/A1-01-implement/x',
  ]

  for (const path of notFound) {
    assert.equal((await get(server, path)).status, 404, path)
  }

  const broken = await get(server, '/api/rollouts/broken')
  assert.equal(broken.status, 500)
  assert.match(broken.json().error, /invalid manifest/)
  assert.equal((await get(server, '/api/rollouts')).status, 200)
})

test('api: a page of a run transcript, and the errors', async (t) => {
  const { server } = await serve(t)
  const path = '/api/rollouts/demo/runs/A1-01-implement'
  const last = await get(server, `${path}?from=end&limit=3`)
  const page = last.json()

  assert.equal(last.status, 200)
  assert.equal(page.from, 5)
  assert.equal(page.total, 8)
  assert.equal(page.final.costUsd, 4.25)
  assert.equal(page.estimateUsd, null)

  const whole = (await get(server, path)).json()
  assert.equal(whole.from, 0)
  assert.equal(whole.items.length, 8)

  for (const value of ['x', '-1', '1.5', '']) {
    const response = await get(server, `${path}?from=${value}`)
    assert.equal(response.status, 400, value)
    assert.deepEqual(response.json(), { error: 'from must be a whole number or end' })
  }

  for (const value of ['0', '501', 'x', '']) {
    const response = await get(server, `${path}?limit=${value}`)
    assert.equal(response.status, 400, value)
    assert.deepEqual(response.json(), { error: 'limit must be a whole number from 1 to 500' })
  }

  for (const run of ['Z9-01-implement', '.hidden', '..%2fledger']) {
    const response = await raw(server.port, `/api/rollouts/demo/runs/${run}`, { headers: bearer(server) })
    assert.equal(response.status, 404, run)
    assert.deepEqual(JSON.parse(response.body), { error: 'unknown run' })
  }

  const refused = await get(server, path, {})
  assert.equal(refused.status, 401)
  assert.deepEqual(refused.json(), { error: 'unauthorized' })
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

  const stopped = await stream.next((message) => message.event === 'state' && message.data.view.driver.running === false)
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
    stream.next(() => true),
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

  const crawled = [...seen].filter((path) => path.endsWith('.js')).sort()
  const onDisk = scriptsUnder(UI)
    .map((file) => `/${file.slice(UI.length).split(sep).join('/')}`)
    .sort()

  assert.deepEqual(crawled, onDisk)

  for (const file of scriptsUnder(UI)) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, `${file}: ${result.stderr}`)
  }
})

test('cli: help lists ui', () => {
  const result = spawnSync(process.execPath, [BIN, 'help'], { encoding: 'utf8', env: cliEnv() })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /rollout\.mjs ui +\[--root ROOT\] \[--port N\] \[--no-open\]/)
  assert.ok(result.stdout.includes('rollout.mjs ui        [--root ROOT] [--port N] [--no-open] [--read-only]'), result.stdout)
  assert.match(result.stdout, /--read-only disables the controls/)
  assert.ok(result.stdout.includes('default $ROLLOUT_ROOT or ~/.rollouts'), result.stdout)
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

test('cli: an unknown flag or a missing value prints the error and the usage, without a stack', () => {
  const cases = [
    { args: ['status', '--bogus', '--dir', makeRollout()], error: "rollout: Unknown option '--bogus'" },
    { args: ['status', '--dir'], error: "rollout: Option '--dir <value>' argument missing" },
  ]

  for (const { args, error } of cases) {
    const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: cliEnv(), timeout: 10_000 })

    assert.equal(result.status, 1, result.stderr)
    assert.ok(result.stderr.startsWith(error), result.stderr)
    assert.ok(result.stderr.includes('rollout.mjs status'), result.stderr)
    assert.doesNotMatch(result.stderr, /ERR_PARSE_ARGS|node:internal|\n\s+at /)
  }
})

test('cli: card and approve follow policy.merge', () => {
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: cliEnv(), timeout: 10_000 })
  const refusals = {
    manual: 'policy.merge is manual: no approval is needed. Merge the PR on GitHub once the driver says it is ready',
    auto: 'policy.merge is auto: no approval is needed. The driver merges once the gate passes, and rollout hold stops it',
  }

  for (const [merge, refusal] of Object.entries(refusals)) {
    const dir = makeRollout({ policy: { merge } })
    const card = cli('card', 'A1', '--dir', dir)

    assert.equal(card.status, 0, card.stderr)
    assert.doesNotMatch(card.stdout, /Approve with/)
    assert.ok(card.stdout.includes(`approval: none under policy.merge ${merge}`), card.stdout)
    assert.ok(card.stdout.includes(`policy.merge is ${merge}`), card.stdout)

    const approve = cli('approve', 'A1', '--dir', dir)

    assert.equal(approve.status, 1, approve.stdout)
    assert.equal(approve.stderr, `A1: ${refusal}\n`)
    assert.deepEqual(inboxFiles(dir), [])
  }

  const dir = makeRollout()
  const card = cli('card', 'A1', '--dir', dir)

  assert.equal(card.status, 0, card.stderr)
  assert.ok(card.stdout.includes('Approve with: rollout.mjs approve A1'), card.stdout)
})

test('cli: card lists the delegate runs and answers with their plan references', () => {
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: cliEnv(), timeout: 10_000 })
  const answer = {
    at: '2026-09-01T12:00:00.000Z',
    kind: 'needs-decision',
    question: 'Keep the old flag?',
    decision: 'answer',
    answer: 'Keep it as an alias.',
    planRefs: ['Decisions: flags', 'cli.mjs:12'],
    reasoning: 'The plan keeps it.',
    run: 'A1-01-delegate',
  }
  const escalation = { ...answer, decision: 'escalate', answer: '', planRefs: [], reasoning: 'The plan is silent.', run: 'A1-02-delegate' }
  const delegate = { runs: 1, lastQuestion: 'abc', limitNotified: false, answers: [answer] }
  const card = cli('card', 'A1', '--dir', makeRollout({ policy: { delegate: {} }, prs: { A1: { state: 'needs_fix', delegate } } }))

  assert.equal(card.status, 0, card.stderr)
  assert.ok(
    card.stdout.includes(
      '\ndelegate: 1 of 2 runs\n  answer on needs-decision at 2026-09-01T12:00:00.000Z (A1-01-delegate): Keep it as an alias.\n    plan: Decisions: flags, cli.mjs:12\n',
    ),
    card.stdout,
  )

  const off = cli(
    'card',
    'A1',
    '--dir',
    makeRollout({ prs: { A1: { state: 'blocked', delegate: { ...delegate, runs: 2, answers: [escalation] } } } }),
  )

  assert.ok(
    off.stdout.includes(
      '\ndelegate: off, 2 runs\n  escalate on needs-decision at 2026-09-01T12:00:00.000Z (A1-02-delegate): The plan is silent.\n',
    ),
    off.stdout,
  )
  assert.doesNotMatch(off.stdout, /plan: /)
  assert.doesNotMatch(cli('card', 'A1', '--dir', makeRollout()).stdout, /delegate/)
})

// Never run stop on a default fixture: its lock names this test process.
test('cli: stop without a driver signals nothing', async () => {
  const result = await runCli(['stop', '--dir', makeRollout({ lock: false })])

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'no driver is running\n')
})

test('cli: stop sends SIGTERM to the driver in driver.lock and waits for it', async (t) => {
  const dir = makeRollout({ lock: false })
  const driver = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })

  t.after(() => driver.kill())
  await once(driver, 'spawn')
  writeFileSync(join(dir, 'driver.lock'), JSON.stringify({ pid: driver.pid, at: new Date().toISOString() }))

  const exited = once(driver, 'exit')
  const result = await runCli(['stop', '--dir', dir])

  assert.deepEqual(await exited, [null, 'SIGTERM'])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, `driver ${driver.pid} stopped; agents resume on the next run\n`)
})

test('cli: stop signals only through stopDriver', () => {
  assert.doesNotMatch(readFileSync(BIN, 'utf8'), /process\.kill\(/)
})

async function servedRoot(t, args, env) {
  const child = spawn(process.execPath, [BIN, 'ui', '--port', '0', '--no-open', ...args], {
    env: { ...cliEnv(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  t.after(() => child.kill())

  const line = await firstLine(child.stdout)
  const match = /^rollout ui: (http:\/\/127\.0\.0\.1:\d+)\/#t=([^ ]+) /.exec(line)

  assert.ok(match, line)

  const [, origin, token] = match
  const response = await fetch(`${origin}/api/rollouts`, { headers: { authorization: `Bearer ${token}` } })
  const { root } = await response.json()
  const exited = once(child, 'exit')

  child.kill('SIGTERM')
  assert.deepEqual(await exited, [0, null])

  return root
}

// Every run sets --root or ROLLOUT_ROOT, so none reads the real ~/.rollouts.
test('cli: ui serves ROLLOUT_ROOT without --root', async (t) => {
  const root = makeRolloutRoot()

  assert.equal(await servedRoot(t, [], { ROLLOUT_ROOT: root }), root)
})

test('cli: ui prefers --root over ROLLOUT_ROOT', async (t) => {
  const flagRoot = makeRolloutRoot()
  const envRoot = makeRolloutRoot()

  assert.equal(await servedRoot(t, ['--root', flagRoot], { ROLLOUT_ROOT: envRoot }), flagRoot)
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

test('commands: each inbox command becomes one inbox file with only its own fields', async (t) => {
  const { server, root } = await serve(t, { driverCommand: refusedDriver([]) })
  const dir = join(root, 'demo')
  const cases = [
    [{ cmd: 'pause', id: 'A1' }, { cmd: 'pause' }],
    [{ cmd: 'resume' }, { cmd: 'resume' }],
    [{ cmd: 'unhalt', sha: 'a1a1a1a' }, { cmd: 'unhalt' }],
    [
      { cmd: 'retry', id: 'A2', patchId: 'patch-a1' },
      { cmd: 'retry', id: 'A2' },
    ],
    [
      { cmd: 'note', id: 'A1', text: '  use the old API \n' },
      { cmd: 'note', id: 'A1', text: 'use the old API' },
    ],
    [
      { cmd: 'hold', id: 'A3', sha: 'a1a1a1a', patchId: 'patch-a1' },
      { cmd: 'hold', id: 'A3' },
    ],
    [
      { cmd: 'release', id: 'A1' },
      { cmd: 'release', id: 'A1' },
    ],
  ]

  for (const [body, command] of cases) {
    const response = await post(server, 'demo', body)
    const files = inboxFiles(dir)

    assert.equal(response.status, 202, JSON.stringify(body))
    assert.deepEqual(files.length, 1, JSON.stringify(body))
    assert.deepEqual(response.json, { cmd: command.cmd, queued: files[0] })

    const { at, ...written } = JSON.parse(readFileSync(join(dir, 'inbox', files[0]), 'utf8'))
    assert.ok(Number.isFinite(Date.parse(at)), at)
    assert.deepEqual(written, command)
    rmSync(join(dir, 'inbox', files[0]))
  }

  const mixedCase = await post(server, 'demo', { cmd: 'pause' }, { contentType: 'Application/JSON; charset=utf-8' })
  assert.equal(mixedCase.status, 202)
})

test('commands: a hold posted through the API becomes a held event in the driver', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rollout-root-'))
  const dir = join(root, 'demo')

  makeRollout({ dir, events: [] })

  const { server } = await serve(t, { root, driverCommand: refusedDriver([]) })

  assert.equal((await post(server, 'demo', { cmd: 'hold', id: 'A3' })).status, 202)
  createDriver(loadManifest(dir)).applyCommands()

  const held = readEvents(loadManifest(dir)).filter((event) => event.kind === 'held')
  assert.deepEqual(
    held.map((event) => event.id),
    ['A3'],
  )
  assert.deepEqual(inboxFiles(dir), [])
})

test('commands: the error answers leave no inbox file', async (t) => {
  const calls = []
  const { server, root } = await serve(t, { driverCommand: refusedDriver(calls) })
  const dir = join(root, 'demo')
  const pause = { cmd: 'pause' }
  const cases = [
    ['no token', await post(server, 'demo', pause, { token: null }), 401, 'unauthorized'],
    ['a foreign Origin', await post(server, 'demo', pause, { origin: 'http://evil.example' }), 403, 'bad origin'],
    ['no Origin', await post(server, 'demo', pause, { origin: null }), 403, 'bad origin'],
    [
      'text/plain',
      await post(server, 'demo', pause, { contentType: 'text/plain;charset=UTF-8' }),
      415,
      'content type must be application/json',
    ],
    ['no Content-Type', await post(server, 'demo', pause, { contentType: null }), 415, 'content type must be application/json'],
    [
      'a JSON look-alike',
      await post(server, 'demo', pause, { contentType: 'application/jsonp' }),
      415,
      'content type must be application/json',
    ],
    ['70 000 bytes', await post(server, 'demo', { cmd: 'note', id: 'A1', text: 'x'.repeat(70_000) }), 413, 'body too large'],
    ['invalid JSON', await post(server, 'demo', '{"cmd":'), 400, 'invalid JSON'],
    ['an empty body', await post(server, 'demo', ''), 400, 'invalid JSON'],
    ['an unknown rollout', await post(server, 'nope', pause), 404, 'unknown rollout'],
    ['a rollout outside the root', await post(server, '..%2fdemo', pause), 404, 'unknown rollout'],
    [
      'approve',
      await post(server, 'demo', { cmd: 'approve', id: 'A1', sha: 'a1a1a1a', patchId: 'patch-a1' }),
      400,
      'unknown command approve',
    ],
    ['an array', await post(server, 'demo', [pause]), 400, 'body must be a JSON object'],
    ['an unknown PR', await post(server, 'demo', { cmd: 'hold', id: 'Z9' }), 400, 'unknown or missing PR id'],
    ['a note without text', await post(server, 'demo', { cmd: 'note', id: 'A1', text: ' ' }), 400, 'note needs text'],
    ['a string dryRun', await post(server, 'demo', { cmd: 'start', dryRun: 'yes' }), 400, 'dryRun must be a boolean'],
  ]

  for (const [label, response, status, error] of cases) {
    assert.equal(response.status, status, label)
    assert.deepEqual(response.json, { error }, label)
  }

  const read = await get(server, '/api/rollouts/demo/commands')
  assert.equal(read.status, 405)
  assert.deepEqual(read.json(), { error: 'method not allowed' })

  const put = await raw(server.port, '/api/rollouts/demo/commands', {
    method: 'PUT',
    headers: { ...bearer(server), origin: server.origin, 'content-type': 'application/json' },
    body: JSON.stringify(pause),
  })
  assert.equal(put.status, 405)

  assert.deepEqual(inboxFiles(dir), [])
  assert.deepEqual(calls, [])
})

test('commands: read-only refuses all nine and says so in every state', async (t) => {
  const calls = []
  const { server, root } = await serve(t, { readOnly: true, driverCommand: refusedDriver(calls), pollMs: 60_000 })
  const dir = join(root, 'demo')
  const bodies = [
    { cmd: 'pause' },
    { cmd: 'resume' },
    { cmd: 'unhalt' },
    { cmd: 'retry', id: 'A2' },
    { cmd: 'note', id: 'A1', text: 'hi' },
    { cmd: 'hold', id: 'A3' },
    { cmd: 'release', id: 'A1' },
    { cmd: 'stop' },
    { cmd: 'start', dryRun: true },
  ]

  for (const body of bodies) {
    for (const name of ['demo', 'fresh']) {
      const response = await post(server, name, body)
      assert.equal(response.status, 403, `${name} ${body.cmd}`)
      assert.deepEqual(response.json, { error: 'read-only' })
    }
  }

  assert.deepEqual(inboxFiles(dir), [])
  assert.deepEqual(inboxFiles(join(root, 'fresh')), [])
  assert.deepEqual(calls, [])
  assert.equal(existsSync(join(root, 'fresh', 'driver.log')), false)

  const state = (await get(server, '/api/rollouts/demo')).json()
  assert.equal(state.readOnly, true)
  assert.equal((await get(server, '/api/rollouts/fresh')).json().readOnly, true)

  const stream = await openStream(t, server, 'demo')
  const first = await stream.next((message) => message.event === 'state')
  assert.equal(first.data.readOnly, true)

  await watcherLive(stream, dir)
  replaceLedger(dir, readFileSync(join(dir, 'ledger.json'), 'utf8').replace('"paused": false', '"paused": true'))

  const pushed = await stream.next((message) => message.event === 'state' && message.data.view.driver.paused)
  assert.equal(pushed.data.readOnly, true)
})

test('commands: a default server sends readOnly false', async (t) => {
  const { server } = await serve(t, { driverCommand: refusedDriver([]) })
  const state = (await get(server, '/api/rollouts/demo')).json()

  assert.equal(state.readOnly, false)
  assert.deepEqual(Object.keys(state).slice(0, 3), ['name', 'at', 'view'])

  const stream = await openStream(t, server, 'demo')
  assert.equal((await stream.next((message) => message.event === 'state')).data.readOnly, false)
})

test('commands: start and stop a fake driver through the API', async (t) => {
  const { server, root } = await serve(t, { driverCommand: fakeDriver() })
  const dir = join(root, 'fresh')
  const log = join(dir, 'driver.log')
  let pid = null

  t.after(() => {
    if (pid && alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  })

  const started = await post(server, 'fresh', { cmd: 'start', dryRun: true })
  pid = started.json.pid

  assert.equal(started.status, 202)
  assert.deepEqual(started.json, { cmd: 'start', pid, dryRun: true, log })

  await waitFor(() => existsSync(join(dir, 'driver.lock')), 'the driver lock')

  const again = await post(server, 'fresh', { cmd: 'start' })
  assert.equal(again.status, 409)
  assert.deepEqual(again.json, { error: `a driver is already running (pid ${pid})` })

  const stopped = await post(server, 'fresh', { cmd: 'stop' })
  assert.equal(stopped.status, 202)
  assert.deepEqual(stopped.json, { cmd: 'stop', pid })

  await waitFor(() => readFileSync(log, 'utf8').includes('fake driver: SIGTERM'), 'the SIGTERM line')
  await waitFor(() => !alive(pid), 'the driver to exit')

  const text = readFileSync(log, 'utf8')
  assert.match(text, /fake driver: dry-run=true env=\{/)
  assert.equal(text.includes(server.token), false)

  const gone = await post(server, 'fresh', { cmd: 'stop' })
  assert.equal(gone.status, 409)
  assert.deepEqual(gone.json, { error: 'no driver is running' })
})

test('commands: the fixture lock names the test process, so stop signals nothing', async (t) => {
  const { server } = await serve(t, { driverCommand: refusedDriver([]) })
  const response = await post(server, 'demo', { cmd: 'stop' })

  assert.equal(response.status, 409)
  assert.deepEqual(response.json, { error: 'driver.lock names no driver process' })
})

// Never post stop here: the fixture lock names this test process.
test('cli: ui --read-only says so, sends readOnly true and refuses a pause', async (t) => {
  const root = makeRolloutRoot()
  const child = spawn(process.execPath, [BIN, 'ui', '--root', root, '--port', '0', '--no-open', '--read-only'], {
    env: cliEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  t.after(() => child.kill())

  const [first, second] = await lines(child.stdout, 2)
  const match = /^rollout ui: (http:\/\/127\.0\.0\.1:(\d+))\/#t=([^ ]+) \(Ctrl-C stops it\)$/.exec(first)

  assert.ok(match, first)
  assert.equal(second, 'read-only: the controls are disabled')

  const [, origin, port, token] = match
  const state = await fetch(`${origin}/api/rollouts/demo`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal((await state.json()).readOnly, true)

  const pause = await post({ origin, port: Number(port), token }, 'demo', { cmd: 'pause' })
  assert.equal(pause.status, 403)
  assert.deepEqual(pause.json, { error: 'read-only' })
  assert.deepEqual(inboxFiles(join(root, 'demo')), [])
})
