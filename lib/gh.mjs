import { STATUS_CODES } from 'node:http'
import { agentToken } from './identity.mjs'
import { makeEnv, sh } from './sh.mjs'

// The driver's GitHub client: REST over fetch. Its errors carry a status and
// a kind, so an outage, an unknown PR and a repository without code scanning
// are told apart by status, not by the words of an error.

const API = 'https://api.github.com/'
const API_ORIGIN = 'https://api.github.com'
const PER_PAGE = 100
const MAX_CACHED = 500
const TOKEN_ARGS = ['auth', 'token', '--hostname', 'github.com']

const HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'claude-rollout',
}

// `status` is null when no answer came. No field and no message ever holds a token.
export class GitHubError extends Error {
  constructor({ method, path, status, kind, detail }) {
    super(`${method} ${path}: ${detail}`)
    this.name = 'GitHubError'
    this.method = method
    this.path = path
    this.status = status
    this.kind = kind
    this.detail = detail
  }
}

// A secondary rate limit can come as a 403 with neither header.
function rateLimited(status, headers, message) {
  if (status === 429) {
    return true
  }

  if (status !== 403) {
    return false
  }

  return headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after') || /rate limit/i.test(message)
}

function answerError(method, path, response, body) {
  const { status, headers } = response
  const message = typeof body?.message === 'string' ? body.message : ''
  const kind = rateLimited(status, headers, message) ? 'rate-limit' : 'http'
  const detail = `HTTP ${status}: ${message || STATUS_CODES[status] || 'no message'}`

  return new GitHubError({ method, path, status, kind, detail })
}

// undici rejects with a cause when the connection fails (`fetch failed`) or
// the body is cut (`terminated`). Any other rejection is a bug and is thrown
// as it is, so it never passes for an outage.
function failure(error, { method, path, aborted, timeoutMs }) {
  if (aborted) {
    return new GitHubError({ method, path, status: null, kind: 'timeout', detail: `no answer within ${timeoutMs / 1000} s` })
  }

  if (error?.cause) {
    const reason = error.cause.code ?? error.cause.message

    return new GitHubError({ method, path, status: null, kind: 'network', detail: `network error: ${reason}` })
  }

  return error
}

// A success whose JSON does not parse must not pass for an empty PR. An
// error status only needs its message, so its text will do.
function parseBody(text, contentType, ok) {
  if (!/\bjson\b/i.test(contentType ?? '')) {
    return text
  }

  if (text === '') {
    return null
  }

  try {
    return JSON.parse(text)
  } catch (error) {
    if (ok) {
      throw error
    }

    return text
  }
}

// fetch quotes a header value it refuses, so a token with a line break in it
// would reach the error.
function headerSafe(token, source) {
  if (!/^[\x21-\x7e]*$/.test(token)) {
    throw new Error(`${source} holds a character an HTTP header cannot carry`)
  }

  return token
}

function apiUrl(path, query) {
  const url = new URL(path, API)

  if (query) {
    url.search = new URLSearchParams(query).toString()
  }

  return url
}

function nextPage(link, url) {
  for (const part of (link ?? '').split(',')) {
    const match = part.match(/<([^>]*)>\s*;\s*rel="([^"]*)"/)

    if (match && match[2].split(/\s+/).includes('next')) {
      return new URL(match[1], url)
    }
  }

  return null
}

async function ghAuthToken(manifest) {
  const result = await sh('gh', TOKEN_ARGS, { env: makeEnv(manifest) })

  // stdout is the token, so only stderr may reach the error.
  if (result.code !== 0) {
    throw new Error(`gh ${TOKEN_ARGS.join(' ')} exited ${result.code}: ${result.stderr.trim()}`)
  }

  return result.stdout.trim()
}

export function createClient(manifest, { fetch: transport = globalThis.fetch, token, timeoutMs = 60_000 } = {}) {
  const readToken = token ?? (() => ghAuthToken(manifest))

  // Answers with an ETag, by `as` and URL. A Map keeps insertion order, so
  // the first key is the least recently used one.
  const cache = new Map()
  let maintainerToken = null

  function forget(reading) {
    if (maintainerToken === reading) {
      maintainerToken = null
    }
  }

  // Parallel first requests share one read. A failed read is not kept, so
  // the next request tries again.
  function maintainer() {
    if (maintainerToken === null) {
      const reading = Promise.resolve()
        .then(() => readToken())
        .catch((error) => {
          forget(reading)
          throw error
        })

      maintainerToken = reading
    }

    return maintainerToken
  }

  // Without repo.agentToken the agents act as the maintainer, as the driver
  // does. The file is read on each request, so a new token applies at once.
  async function credential(as) {
    const agent = as === 'agents' ? agentToken(manifest) : null

    if (agent !== null) {
      return { bearer: headerSafe(agent, 'repo.agentToken'), reading: null }
    }

    const reading = maintainer()

    return { bearer: headerSafe(await reading, "the maintainer's token"), reading }
  }

  function remember(key, entry) {
    cache.delete(key)
    cache.set(key, entry)

    if (cache.size > MAX_CACHED) {
      cache.delete(cache.keys().next().value)
    }
  }

  // One round trip. The timer covers the body too, and never outlives the request.
  async function exchange(method, path, url, { as, body, cached }) {
    const { bearer, reading } = await credential(as)
    const headers = { ...HEADERS, Authorization: `Bearer ${bearer}` }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    if (cached) {
      headers['If-None-Match'] = cached.etag
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await transport(url.href, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })

      const text = [204, 304].includes(response.status) ? null : await response.text()

      return { response, text, reading }
    } catch (error) {
      throw failure(error, { method, path, aborted: controller.signal.aborted, timeoutMs })
    } finally {
      clearTimeout(timer)
    }
  }

  function fromCache(key, cached, response) {
    const headers = new Headers(response.headers)

    remember(key, cached)

    if (cached.link) {
      headers.set('link', cached.link)
    } else {
      headers.delete('link')
    }

    return { status: cached.status, headers, body: parseBody(cached.text, cached.contentType, true), revalidated: true }
  }

  // The answer, with `revalidated` true when it is the cached one after a 304.
  async function call(method, path, url, { as = 'maintainer', body } = {}) {
    if (url.origin !== API_ORIGIN) {
      throw new Error(`${method} ${path}: refused ${url.origin}, the token goes only to ${API_ORIGIN}`)
    }

    const key = `${as} ${url.href}`
    const cached = method === 'GET' ? cache.get(key) : undefined
    let answer = await exchange(method, path, url, { as, body, cached })

    // A token renewed since it was read, with `gh auth refresh` for one.
    if (answer.response.status === 401 && answer.reading) {
      forget(answer.reading)
      answer = await exchange(method, path, url, { as, body, cached })
    }

    const { response, text } = answer

    if (response.status === 304 && cached) {
      return fromCache(key, cached, response)
    }

    const contentType = response.headers.get('content-type')
    const parsed = text === null ? null : parseBody(text, contentType, response.ok)

    if (!response.ok) {
      throw answerError(method, path, response, parsed)
    }

    const etag = response.headers.get('etag')

    if (method === 'GET' && response.status === 200 && etag) {
      remember(key, { etag, status: 200, text, contentType, link: response.headers.get('link') })
    }

    return { status: response.status, headers: response.headers, body: parsed, revalidated: false }
  }

  async function request(method, path, { as = 'maintainer', body, query } = {}) {
    const { revalidated: _, ...answer } = await call(method, path, apiUrl(path, query), { as, body })

    return answer
  }

  async function pages(path, { as = 'maintainer', query, itemsOf = (body) => body } = {}) {
    const items = []
    let url = apiUrl(path, { ...query, per_page: PER_PAGE })

    for (let page = 1; url; page += 1) {
      const answer = await call('GET', path, url, { as })
      const list = itemsOf(answer.body)

      if (!Array.isArray(list)) {
        throw new Error(`${path} page ${page} has no list`)
      }

      items.push(...list)
      url = nextPage(answer.headers.get('link'), url)

      // GitHub's ETag covers the body and not the Link header. A full page
      // answered 304 keeps the links it was cached with, which predate any
      // item added after it.
      if (!url && answer.revalidated && list.length >= PER_PAGE) {
        url = apiUrl(path, { ...query, per_page: PER_PAGE, page: page + 1 })
      }
    }

    return items
  }

  return { request, pages }
}
