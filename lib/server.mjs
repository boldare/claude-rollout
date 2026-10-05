import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { driverCommand as defaultDriverCommand, parseCommand, runCommand } from './control.mjs'
import { HOME } from './manifest.mjs'
import {
  changeSignature,
  eventsSince,
  findRollout,
  listRollouts,
  rolloutPr,
  rolloutSnapshot,
  transcriptPage,
  watchRollout,
} from './rollouts.mjs'
import { readEvents } from './view.mjs'

// The local web UI over every rollout under one root. Agents run as the same
// user and can reach any local port, so every API call needs a token that
// lives only in this process, and the Host and Origin checks keep other web
// pages out.
const COMMON_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const JSON_TYPE = 'application/json; charset=utf-8'
const STREAM_TYPE = 'text/event-stream; charset=utf-8'
const PING_MS = 20_000
const WHOLE_NUMBER = /^\d+$/
const MAX_PAGE = 500
const MAX_BODY = 65_536

function send(res, status, type, body) {
  res.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function sendJson(res, status, value) {
  send(res, status, JSON_TYPE, JSON.stringify(value))
}

function fail(res, status, reason) {
  sendJson(res, status, { error: reason })
}

// Decoded once, so the token rule and the router see the same segments and
// an escaped /%61pi cannot skip the token.
function parsePath(url, origin) {
  try {
    const { pathname, searchParams } = new URL(url, origin)

    return { segments: pathname.split('/').slice(1).map(decodeURIComponent), query: searchParams }
  } catch {
    return null
  }
}

function authorized(context, header) {
  const match = /^Bearer (\S+)$/.exec(header ?? '')

  if (!match) {
    return false
  }

  const given = Buffer.from(match[1])

  return given.length === context.tokenBytes.length && timingSafeEqual(given, context.tokenBytes)
}

function safeSegment(segment) {
  return segment !== '' && !segment.startsWith('.') && !/[/\\\0]/.test(segment)
}

function readStatic(file) {
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    return null
  }

  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

function staticFile(context, segments) {
  const parts = segments.length === 1 && segments[0] === '' ? ['index.html'] : segments

  if (!parts.every(safeSegment)) {
    return null
  }

  const file = resolve(context.uiDir, ...parts)

  return file.startsWith(`${context.uiDir}${sep}`) && STATIC_TYPES[extname(file)] ? file : null
}

function serveStatic(context, res, segments) {
  const file = staticFile(context, segments)
  const body = file ? readStatic(file) : null

  if (body === null) {
    fail(res, 404, 'not found')
    return
  }

  send(res, 200, STATIC_TYPES[extname(file)], body)
}

function message(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function write(subscriber, text) {
  if (!subscriber.res.writableEnded && !subscriber.res.destroyed) {
    subscriber.res.write(text)
  }
}

function endStream(subscriber) {
  clearInterval(subscriber.ping)

  if (!subscriber.res.writableEnded && !subscriber.res.destroyed) {
    subscriber.res.end()
  }
}

function snapshot(context, manifest, name) {
  const { state, events } = rolloutSnapshot(manifest, name)

  return { state: { ...state, readOnly: context.readOnly }, events }
}

function push(context, hub) {
  const manifest = findRollout(context.root, hub.name)

  if (!manifest) {
    throw new Error('unknown rollout')
  }

  hub.manifest = manifest

  const { state, events } = snapshot(context, manifest, hub.name)

  for (const subscriber of hub.subscribers) {
    write(subscriber, message('state', state))

    const since = eventsSince(events, subscriber.sent)

    if (since.events.length > 0 || since.from !== subscriber.sent) {
      write(subscriber, message('events', since))
      subscriber.sent = since.from + since.events.length
    }
  }
}

// The signature is stored before the push, so a ledger that stays broken
// reports one problem instead of one per poll.
function refresh(context, hub) {
  try {
    const signature = changeSignature(hub.manifest)

    if (signature === hub.signature) {
      return
    }

    hub.signature = signature
    push(context, hub)
  } catch (error) {
    for (const subscriber of hub.subscribers) {
      write(subscriber, message('problem', { error: error.message }))
    }
  }
}

function openHub(context, manifest, name, signature) {
  const hub = { name, manifest, signature, subscribers: new Set(), watcher: null }
  const { debounceMs, pollMs } = context

  hub.watcher = watchRollout(manifest.dir, () => refresh(context, hub), { debounceMs, pollMs })
  context.hubs.set(name, hub)

  return hub
}

function unsubscribe(context, hub, subscriber) {
  clearInterval(subscriber.ping)
  hub.subscribers.delete(subscriber)

  if (hub.subscribers.size > 0) {
    return
  }

  hub.watcher.close()

  if (context.hubs.get(hub.name) === hub) {
    context.hubs.delete(hub.name)
  }
}

function subscribe(context, req, res, { manifest, name }) {
  const existing = context.hubs.get(name)
  // Taken before the snapshot, so a change in between differs from it and is pushed.
  const signature = existing ? null : changeSignature(manifest)
  const { state, events } = snapshot(context, manifest, name)
  const hub = existing ?? openHub(context, manifest, name, signature)
  const subscriber = { res, sent: events.length, ping: null }

  res.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': STREAM_TYPE })
  write(subscriber, message('state', state))
  write(subscriber, message('events', { from: 0, events }))
  subscriber.ping = setInterval(() => write(subscriber, ': ping\n\n'), PING_MS)
  hub.subscribers.add(subscriber)
  res.on('close', () => unsubscribe(context, hub, subscriber))
}

function showState(context, req, res, { manifest, name }) {
  sendJson(res, 200, snapshot(context, manifest, name).state)
}

function showEvents(context, req, res, { manifest, query }) {
  const after = query.get('after') ?? '0'

  if (!WHOLE_NUMBER.test(after)) {
    fail(res, 400, 'after must be a whole number')
    return
  }

  sendJson(res, 200, eventsSince(readEvents(manifest), Number(after)))
}

function showPr(context, req, res, { manifest, id }) {
  const detail = rolloutPr(manifest, id)

  if (!detail) {
    fail(res, 404, 'unknown PR')
    return
  }

  sendJson(res, 200, detail)
}

function pageQuery(query) {
  const from = query.get('from') ?? '0'
  const limit = query.get('limit') ?? '200'

  if (from !== 'end' && !WHOLE_NUMBER.test(from)) {
    return { error: 'from must be a whole number or end' }
  }

  if (!WHOLE_NUMBER.test(limit) || Number(limit) < 1 || Number(limit) > MAX_PAGE) {
    return { error: 'limit must be a whole number from 1 to 500' }
  }

  return { from: from === 'end' ? 'end' : Number(from), limit: Number(limit) }
}

function showRun(context, req, res, { manifest, query, id }) {
  const options = pageQuery(query)

  if (options.error) {
    fail(res, 400, options.error)
    return
  }

  const page = transcriptPage(manifest, id, options)

  if (!page) {
    fail(res, 404, 'unknown run')
    return
  }

  sendJson(res, 200, page)
}

function rolloutRoute(rest) {
  if (rest.length === 0) {
    return showState
  }

  if (rest.length === 1 && rest[0] === 'events') {
    return showEvents
  }

  if (rest.length === 1 && rest[0] === 'stream') {
    return subscribe
  }

  if (rest.length === 2 && rest[0] === 'prs') {
    return showPr
  }

  if (rest.length === 2 && rest[0] === 'runs') {
    return showRun
  }

  return null
}

function commandPath(segments) {
  return segments.length === 4 && segments[0] === 'api' && segments[1] === 'rollouts' && segments[3] === 'commands'
}

function jsonContent(header) {
  const mediaType = String(header ?? '').split(';')[0]

  return mediaType.trim().toLowerCase() === 'application/json'
}

// Resolves to null for a body over the limit. The rest is still read, so the
// client gets the answer instead of a reset connection.
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.length

      if (size <= MAX_BODY) {
        chunks.push(chunk)
      }
    })

    req.on('end', () => resolveBody(size > MAX_BODY ? null : Buffer.concat(chunks)))
    req.on('error', reject)
    req.on('close', () => reject(new Error('the request was aborted')))
  })
}

function parseJson(buffer) {
  try {
    return { value: JSON.parse(buffer.toString('utf8')) }
  } catch {
    return null
  }
}

async function serveCommand(context, req, res, { segments }) {
  if (req.method !== 'POST') {
    fail(res, 405, 'method not allowed')
    return
  }

  if (context.readOnly) {
    fail(res, 403, 'read-only')
    return
  }

  if (!jsonContent(req.headers['content-type'])) {
    fail(res, 415, 'content type must be application/json')
    return
  }

  const buffer = await readBody(req)

  if (buffer === null) {
    fail(res, 413, 'body too large')
    return
  }

  const parsed = parseJson(buffer)

  if (!parsed) {
    fail(res, 400, 'invalid JSON')
    return
  }

  const manifest = findRollout(context.root, segments[2])

  if (!manifest) {
    fail(res, 404, 'unknown rollout')
    return
  }

  const { command, error } = parseCommand(manifest, parsed.value)

  if (error) {
    fail(res, 400, error)
    return
  }

  const { status, body } = await runCommand(manifest, command, context)
  sendJson(res, status, body)
}

function serveApi(context, req, res, { segments, query }) {
  const [, collection, name, ...rest] = segments

  if (collection !== 'rollouts') {
    fail(res, 404, 'not found')
    return
  }

  if (name === undefined) {
    sendJson(res, 200, { root: context.root, rollouts: listRollouts(context.root) })
    return
  }

  const route = rolloutRoute(rest)

  if (!route) {
    fail(res, 404, 'not found')
    return
  }

  const manifest = findRollout(context.root, name)

  if (!manifest) {
    fail(res, 404, 'unknown rollout')
    return
  }

  route(context, req, res, { manifest, name, query, id: rest[1] })
}

function handle(context, req, res) {
  if (!context.hosts.has(String(req.headers.host ?? '').toLowerCase())) {
    fail(res, 403, 'bad host')
    return
  }

  if (req.method !== 'GET' && !context.origins.has(req.headers.origin)) {
    fail(res, 403, 'bad origin')
    return
  }

  const path = parsePath(req.url, context.origin)

  if (!path) {
    fail(res, 400, 'bad path')
    return
  }

  const toApi = path.segments[0] === 'api'

  if (toApi && !authorized(context, req.headers.authorization)) {
    fail(res, 401, 'unauthorized')
    return
  }

  if (toApi && commandPath(path.segments)) {
    return serveCommand(context, req, res, path)
  }

  if (req.method !== 'GET') {
    fail(res, 405, 'method not allowed')
    return
  }

  if (toApi) {
    serveApi(context, req, res, path)
    return
  }

  serveStatic(context, res, path.segments)
}

async function respond(context, req, res) {
  try {
    await handle(context, req, res)
  } catch (error) {
    if (res.headersSent) {
      res.destroy()
      return
    }

    fail(res, 500, error.message)
  }
}

function closeAll(context, server) {
  for (const hub of context.hubs.values()) {
    hub.watcher.close()

    for (const subscriber of hub.subscribers) {
      endStream(subscriber)
    }
  }

  context.hubs.clear()

  return new Promise((resolveClose) => {
    server.close(() => resolveClose())
    server.closeAllConnections()
  })
}

export function startServer({
  root,
  port = 0,
  uiDir = join(HOME, 'ui'),
  debounceMs = 250,
  pollMs = 5000,
  readOnly = false,
  driverCommand = defaultDriverCommand,
  batteryWarning,
}) {
  const token = randomBytes(32).toString('base64url')
  const context = {
    root,
    uiDir: resolve(uiDir),
    debounceMs,
    pollMs,
    tokenBytes: Buffer.from(token),
    hubs: new Map(),
    readOnly,
    driverCommand,
    batteryWarning,
    stopping: new Map(),
  }

  const server = createServer((req, res) => respond(context, req, res))

  server.on('clientError', (_error, socket) => socket.destroy())

  return new Promise((resolveStart, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)

      const address = server.address()
      const origin = `http://${address.address}:${address.port}`

      context.origin = origin
      context.hosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`])
      context.origins = new Set([origin, `http://localhost:${address.port}`])
      resolveStart({ origin, url: `${origin}/#t=${token}`, port: address.port, token, close: () => closeAll(context, server) })
    })
  })
}
