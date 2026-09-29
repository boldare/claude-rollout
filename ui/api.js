import { parseSse } from './sse.js'

const FIRST_WAIT_MS = 1000
const MAX_WAIT_MS = 30_000
// The server pings every 20 s, so this long without a byte means a dead connection.
const STALL_MS = 45_000

function authorization(token) {
  return { Authorization: `Bearer ${token}` }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function apiGet(token, path, { signal } = {}) {
  const response = await fetch(path, { headers: authorization(token), signal })

  return { status: response.status, body: parseJson(await response.text()) }
}

// The browser adds the Origin header, which the server needs on every POST.
export async function apiPost(token, path, body) {
  const headers = { ...authorization(token), 'Content-Type': 'application/json' }
  const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })

  return { status: response.status, body: parseJson(await response.text()) }
}

async function errorOf(response) {
  const body = parseJson(await response.text().catch(() => ''))

  return body?.error ?? `The server answered ${response.status}.`
}

// The browser's own SSE client cannot send the Authorization header, so the
// stream is read with fetch and a body reader instead.
export function followStream(token, name, { onState, onEvents, onProblem, onStatus }) {
  const handlers = { state: onState, events: onEvents, problem: onProblem }
  const path = `/api/rollouts/${encodeURIComponent(name)}/stream`
  let controller = null
  let stall = null
  let retry = null
  let wait = FIRST_WAIT_MS
  let closed = false

  function armStall() {
    clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), STALL_MS)
  }

  function notify(callback, ...args) {
    if (!closed) {
      callback(...args)
    }
  }

  function dispatch(messages) {
    for (const message of messages) {
      if (closed) {
        return
      }

      handlers[message.event]?.(message.data)
    }
  }

  function reconnect() {
    clearTimeout(stall)

    if (closed) {
      return
    }

    onStatus('reconnecting')
    retry = setTimeout(connect, wait)
    wait = Math.min(wait * 2, MAX_WAIT_MS)
  }

  async function read(response) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { value, done } = await reader.read()

      if (done || closed) {
        return
      }

      armStall()

      const { messages, rest } = parseSse(buffer + decoder.decode(value, { stream: true }))
      buffer = rest
      dispatch(messages)
    }
  }

  async function answered(response) {
    if (response.status >= 400 && response.status < 500) {
      clearTimeout(stall)
      notify(onStatus, response.status, await errorOf(response))
      return
    }

    if (!response.ok) {
      notify(onProblem, { error: await errorOf(response) })
      reconnect()
      return
    }

    wait = FIRST_WAIT_MS
    notify(onStatus, 'live')
    await read(response)
    reconnect()
  }

  async function connect() {
    controller = new AbortController()
    armStall()

    try {
      await answered(await fetch(path, { headers: authorization(token), signal: controller.signal }))
    } catch {
      reconnect()
    }
  }

  function close() {
    closed = true
    clearTimeout(stall)
    clearTimeout(retry)
    controller?.abort()
  }

  connect()

  return { close }
}
