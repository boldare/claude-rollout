import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, GitHubError } from '../lib/gh.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { fakeGitHub, fakeTools, makeRollout } from './fixtures.mjs'

const MAINTAINER_TOKEN = 'synthetic-maintainer-token'
const AGENT_TOKEN = 'synthetic-agent-token'
const TOKEN_ARGS = 'auth token --hostname github.com'
const PR_PATH = 'repos/example/widgets/pulls/11'

// A fixture rollout whose fake gh answers `gh auth token` from the rules.
function rollout(rules = [{ tool: 'gh', args: TOKEN_ARGS, stdout: `${MAINTAINER_TOKEN}\n` }]) {
  const dir = makeRollout()
  const tools = fakeTools(dir, rules)
  const tokenRuns = () => tools.calls().filter((call) => call.tool === 'gh' && call.args.join(' ') === TOKEN_ARGS).length

  return { manifest: loadManifest(dir), tools, tokenRuns }
}

// A client on the fake GitHub with a fixed maintainer's token, so no gh runs.
function fakeClient(routes, options = {}) {
  const github = fakeGitHub(routes)
  const { manifest } = rollout([])
  const client = createClient(manifest, { fetch: github.fetch, token: async () => MAINTAINER_TOKEN, ...options })

  return { github, client, manifest }
}

async function failure(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }

  assert.fail('the request did not fail')
}

test('client: every request sends the API headers and the maintainer token that gh auth token prints', async () => {
  const { manifest, tools } = rollout()
  const github = fakeGitHub([{ path: PR_PATH, body: { number: 11 } }])
  const client = createClient(manifest, { fetch: github.fetch })
  const answer = await client.request('GET', PR_PATH)

  assert.deepEqual(Object.keys(answer).sort(), ['body', 'headers', 'status'])
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, { number: 11 })
  assert.ok(answer.headers instanceof Headers)
  assert.deepEqual(Object.keys(await client.request('GET', PR_PATH)).sort(), ['body', 'headers', 'status'])

  const [request] = github.requests()

  assert.equal(request.url, 'https://api.github.com/repos/example/widgets/pulls/11')
  assert.equal(request.headers.authorization, `Bearer ${MAINTAINER_TOKEN}`)
  assert.equal(request.headers.accept, 'application/vnd.github+json')
  assert.equal(request.headers['x-github-api-version'], '2022-11-28')
  assert.equal(request.headers['user-agent'], 'claude-rollout')
  assert.deepEqual(
    tools.calls().map((call) => call.args),
    [['auth', 'token', '--hostname', 'github.com']],
  )
})

test('client: three parallel first requests run gh auth token once', async () => {
  const { manifest, tokenRuns } = rollout()
  const github = fakeGitHub([{ path: PR_PATH, body: { number: 11 } }])
  const client = createClient(manifest, { fetch: github.fetch })

  await Promise.all([client.request('GET', PR_PATH), client.request('GET', PR_PATH), client.request('GET', PR_PATH)])

  assert.equal(tokenRuns(), 1)
  assert.equal(github.requests().length, 3)
})

test('client: a failed gh auth token names the command and its stderr, never its stdout, and the next request tries again', async () => {
  const works = [{ tool: 'gh', args: TOKEN_ARGS, stdout: `${MAINTAINER_TOKEN}\n` }]
  const { manifest, tokenRuns } = rollout([
    { tool: 'gh', args: TOKEN_ARGS, code: 1, stdout: 'synthetic-half-token', stderr: 'no oauth token found for github.com\n', next: works },
  ])

  const github = fakeGitHub([{ path: PR_PATH, body: { number: 11 } }])
  const client = createClient(manifest, { fetch: github.fetch })
  const error = await failure(client.request('GET', PR_PATH))

  assert.equal(error.message, 'gh auth token --hostname github.com exited 1: no oauth token found for github.com')
  assert.equal(github.requests().length, 0)

  assert.equal((await client.request('GET', PR_PATH)).status, 200)
  assert.equal(tokenRuns(), 2)
  assert.equal(github.requests()[0].headers.authorization, `Bearer ${MAINTAINER_TOKEN}`)
})

test("client: as agents it sends the token file's content, read on each request", async () => {
  const { manifest, tokenRuns } = rollout()
  const github = fakeGitHub([{ path: 'user', body: { login: 'demo-bot' } }])
  const client = createClient(manifest, { fetch: github.fetch })

  manifest.repo.agentToken = join(manifest.dir, 'agent-token')
  writeFileSync(manifest.repo.agentToken, `${AGENT_TOKEN}\n`)
  await client.request('GET', 'user', { as: 'agents' })
  writeFileSync(manifest.repo.agentToken, `${AGENT_TOKEN}-renewed\n`)
  await client.request('GET', 'user', { as: 'agents' })

  assert.deepEqual(
    github.requests().map((request) => request.headers.authorization),
    [`Bearer ${AGENT_TOKEN}`, `Bearer ${AGENT_TOKEN}-renewed`],
  )

  assert.equal(tokenRuns(), 0)
})

test("client: as agents without repo.agentToken it sends the maintainer's token", async () => {
  const { manifest } = rollout()
  const github = fakeGitHub([{ path: 'user', body: { login: 'maint' } }])
  const client = createClient(manifest, { fetch: github.fetch })

  await client.request('GET', 'user', { as: 'agents' })

  assert.equal(github.requests()[0].headers.authorization, `Bearer ${MAINTAINER_TOKEN}`)
})

test("client: a missing token file throws agentToken's own error, before any request", async () => {
  const { github, client, manifest } = fakeClient([{ path: 'user', body: { login: 'demo-bot' } }])

  manifest.repo.agentToken = join(manifest.dir, 'missing-token')

  const error = await failure(client.request('GET', 'user', { as: 'agents' }))

  assert.ok(!(error instanceof GitHubError))
  assert.match(error.message, /^repo\.agentToken .*missing-token does not exist$/)
  assert.deepEqual(github.requests(), [])
})

test('client: a 401 as the maintainer reads the token again and retries once', async () => {
  const { manifest, tokenRuns } = rollout([
    {
      tool: 'gh',
      args: TOKEN_ARGS,
      stdout: 'synthetic-old-token\n',
      next: [{ tool: 'gh', args: TOKEN_ARGS, stdout: 'synthetic-new-token\n' }],
    },
  ])

  const github = fakeGitHub([{ path: PR_PATH, status: 401, body: { message: 'Bad credentials' } }])

  // The first answer is the 401, every later one the PR.
  async function renewed(url, init) {
    const answer = await github.fetch(url, init)
    github.answer([{ path: PR_PATH, body: { number: 11 } }])

    return answer
  }

  const client = createClient(manifest, { fetch: renewed })

  assert.deepEqual((await client.request('GET', PR_PATH)).body, { number: 11 })
  assert.deepEqual(
    github.requests().map((request) => [request.headers.authorization, request.status]),
    [
      ['Bearer synthetic-old-token', 401],
      ['Bearer synthetic-new-token', 200],
    ],
  )

  assert.equal(tokenRuns(), 2)
})

test('client: a second 401 throws status 401, and an agent token gets no retry', async () => {
  const { manifest, tokenRuns } = rollout()
  const github = fakeGitHub([{ path: PR_PATH, status: 401, body: { message: 'Bad credentials' } }])
  const client = createClient(manifest, { fetch: github.fetch })
  const error = await failure(client.request('GET', PR_PATH))

  assert.ok(error instanceof GitHubError)
  assert.equal(error.status, 401)
  assert.equal(error.kind, 'http')
  assert.equal(error.detail, 'HTTP 401: Bad credentials')
  assert.equal(github.requests().length, 2)
  assert.equal(tokenRuns(), 2)

  manifest.repo.agentToken = join(manifest.dir, 'agent-token')
  writeFileSync(manifest.repo.agentToken, `${AGENT_TOKEN}\n`)

  assert.equal((await failure(client.request('GET', PR_PATH, { as: 'agents' }))).status, 401)
  assert.equal(github.requests().length, 3)
})

test('client: a status outside 2xx is a GitHubError with its status, kind and detail', async () => {
  const cases = [
    [{ status: 500, body: { message: 'Server Error' } }, 'http', 'HTTP 500: Server Error'],
    [{ status: 502, body: '<html>Bad Gateway</html>', headers: { 'content-type': 'text/html' } }, 'http', 'HTTP 502: Bad Gateway'],
    [{ status: 429, body: { message: 'Too Many Requests' } }, 'rate-limit', 'HTTP 429: Too Many Requests'],
    [
      { status: 403, body: { message: 'API rate limit exceeded for user ID 1.' }, headers: { 'x-ratelimit-remaining': '0' } },
      'rate-limit',
      'HTTP 403: API rate limit exceeded for user ID 1.',
    ],
    [
      { status: 403, body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } },
      'rate-limit',
      'HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
    ],
    [{ status: 403, body: { message: 'Forbidden' }, headers: { 'retry-after': '60' } }, 'rate-limit', 'HTTP 403: Forbidden'],
    [
      { status: 403, body: { message: 'Resource not accessible by integration' } },
      'http',
      'HTTP 403: Resource not accessible by integration',
    ],
    [{ status: 404, body: { message: 'Not Found' } }, 'http', 'HTTP 404: Not Found'],
    [{ status: 422, body: { message: 'Validation Failed' } }, 'http', 'HTTP 422: Validation Failed'],
  ]

  for (const [route, kind, detail] of cases) {
    const { client } = fakeClient([{ path: PR_PATH, ...route }])
    const error = await failure(client.request('GET', PR_PATH))

    assert.ok(error instanceof GitHubError, detail)
    assert.equal(error.name, 'GitHubError')
    assert.equal(error.status, route.status, detail)
    assert.equal(error.kind, kind, detail)
    assert.equal(error.method, 'GET')
    assert.equal(error.path, PR_PATH)
    assert.equal(error.detail, detail)
    assert.equal(error.message, `GET ${PR_PATH}: ${detail}`)
  }
})

test('client: a failed connection is a network error with no status, and no answer in time is a timeout', async () => {
  const reset = fakeClient([{ path: PR_PATH, error: 'ECONNRESET' }])
  const network = await failure(reset.client.request('GET', PR_PATH))

  assert.ok(network instanceof GitHubError)
  assert.equal(network.kind, 'network')
  assert.equal(network.status, null)
  assert.equal(network.detail, 'network error: ECONNRESET')

  const slow = fakeClient([{ path: PR_PATH, hang: true }], { timeoutMs: 50 })
  const timeout = await failure(slow.client.request('GET', PR_PATH))

  assert.ok(timeout instanceof GitHubError)
  assert.equal(timeout.kind, 'timeout')
  assert.equal(timeout.status, null)
  assert.equal(timeout.message, `GET ${PR_PATH}: no answer within 0.05 s`)
})

test('client: a rejection without a cause is a bug, thrown as it is', async () => {
  const bug = new TypeError('fetch is broken')
  const { manifest } = rollout([])
  const client = createClient(manifest, { fetch: () => Promise.reject(bug), token: async () => MAINTAINER_TOKEN })

  assert.equal(await failure(client.request('GET', PR_PATH)), bug)
})

test('client: no timer outlives a request', async () => {
  const { client } = fakeClient([{ path: PR_PATH, body: { number: 11 } }])
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length
  const before = timers()

  await client.request('GET', PR_PATH)
  await failure(client.request('GET', 'repos/example/widgets/pulls/12'))

  assert.equal(timers(), before)
})

test('client: a body goes out as JSON, and an answer is JSON, text or null by its content type and status', async () => {
  const { github, client } = fakeClient([
    { method: 'POST', path: 'repos/example/widgets/issues/11/comments', status: 201, body: { id: 5 } },
    { method: 'DELETE', path: 'repos/example/widgets/git/refs/heads/feat/a1', status: 204 },
    { path: 'repos/example/widgets/readme', body: '# Widgets\n' },
  ])

  assert.deepEqual((await client.request('POST', 'repos/example/widgets/issues/11/comments', { body: { body: 'Done.' } })).body, { id: 5 })
  assert.equal((await client.request('DELETE', 'repos/example/widgets/git/refs/heads/feat/a1')).body, null)
  assert.equal((await client.request('GET', 'repos/example/widgets/readme')).body, '# Widgets\n')

  const [post] = github.requests()

  assert.equal(post.headers['content-type'], 'application/json')
  assert.deepEqual(post.body, { body: 'Done.' })
})

test('client: the second GET of a URL sends the ETag back, and a 304 answers what the 200 did', async () => {
  const { github, client } = fakeClient([{ path: PR_PATH, body: { number: 11, title: 'feat: A1' } }])
  const first = await client.request('GET', PR_PATH)
  const second = await client.request('GET', PR_PATH)
  const [sent, again] = github.requests()

  assert.deepEqual(
    github.requests().map((request) => request.status),
    [200, 304],
  )

  assert.equal(sent.headers['if-none-match'], undefined)
  assert.match(again.headers['if-none-match'], /^"[0-9a-f]+"$/)
  assert.equal(second.status, 200)
  assert.deepEqual(second.body, first.body)

  second.body.title = 'changed by a caller'

  assert.equal((await client.request('GET', PR_PATH)).body.title, 'feat: A1')
})

test('client: a changed answer comes back as a 200 with the new body', async () => {
  const { github, client } = fakeClient([{ path: PR_PATH, body: { number: 11, title: 'feat: A1' } }])

  await client.request('GET', PR_PATH)
  github.answer([{ path: PR_PATH, body: { number: 11, title: 'feat: A1, renamed' } }])

  assert.deepEqual((await client.request('GET', PR_PATH)).body, { number: 11, title: 'feat: A1, renamed' })
  assert.deepEqual(
    github.requests().map((request) => request.status),
    [200, 200],
  )
})

test('client: the agents and the maintainer keep their own ETags', async () => {
  const { github, client, manifest } = fakeClient([{ path: 'repos/example/widgets', body: { full_name: 'example/widgets' } }])

  manifest.repo.agentToken = join(manifest.dir, 'agent-token')
  writeFileSync(manifest.repo.agentToken, `${AGENT_TOKEN}\n`)

  await client.request('GET', 'repos/example/widgets')
  await client.request('GET', 'repos/example/widgets', { as: 'agents' })

  assert.deepEqual(
    github.requests().map((request) => request.status),
    [200, 200],
  )
})

test('client: after 501 other URLs, the first is asked again without If-None-Match', async () => {
  const routes = Array.from({ length: 502 }, (_, i) => ({ path: `repos/example/widgets/pulls/${i + 1}`, body: { number: i + 1 } }))
  const { github, client } = fakeClient(routes)

  for (let i = 1; i <= 501; i += 1) {
    await client.request('GET', `repos/example/widgets/pulls/${i}`)
  }

  await client.request('GET', 'repos/example/widgets/pulls/501')
  await client.request('GET', 'repos/example/widgets/pulls/1')

  const [again, evicted] = github.requests().slice(-2)

  assert.equal(again.status, 304)
  assert.equal(evicted.headers['if-none-match'], undefined)
  assert.equal(evicted.status, 200)
})

test('client: a 304 keeps the cached answer in use, so the least recently used one goes first', async () => {
  const routes = Array.from({ length: 501 }, (_, i) => ({ path: `repos/example/widgets/pulls/${i + 1}`, body: { number: i + 1 } }))
  const { github, client } = fakeClient(routes)

  for (let i = 1; i <= 500; i += 1) {
    await client.request('GET', `repos/example/widgets/pulls/${i}`)
  }

  await client.request('GET', 'repos/example/widgets/pulls/1')
  await client.request('GET', 'repos/example/widgets/pulls/501')
  await client.request('GET', 'repos/example/widgets/pulls/1')
  await client.request('GET', 'repos/example/widgets/pulls/2')

  assert.deepEqual(
    github
      .requests()
      .slice(-4)
      .map((request) => request.status),
    [304, 200, 304, 200],
  )
})

const LIMIT = 'x-ratelimit-remaining'

test('stats: every round trip counts, a failed connection and the retry after a 401 included, and stats gives a copy', async () => {
  const { github, client } = fakeClient([
    { path: PR_PATH, body: { number: 11 } },
    { path: 'user', status: 401, body: { message: 'Bad credentials' } },
    { path: 'repos/example/widgets', error: 'ECONNRESET' },
  ])

  assert.deepEqual(client.stats(), { requests: 0, cached: 0, remaining: null })

  await client.request('GET', PR_PATH)
  await failure(client.request('GET', 'user'))
  await failure(client.request('GET', 'repos/example/widgets'))

  client.stats().requests = 0

  assert.equal(github.requests().length, 4)
  assert.deepEqual(client.stats(), { requests: 4, cached: 0, remaining: null })
})

test('stats: every 304 answered from the cache counts as cached', async () => {
  const { client } = fakeClient([{ path: PR_PATH, body: { number: 11 } }])

  for (let i = 0; i < 3; i += 1) {
    await client.request('GET', PR_PATH)
  }

  assert.deepEqual(client.stats(), { requests: 3, cached: 2, remaining: null })
})

test("stats: remaining comes from the last maintainer's answer that names it, a 304 and an error included, never from the agents' token", async () => {
  const github = fakeGitHub([
    { path: PR_PATH, body: { number: 11 }, headers: { [LIMIT]: '4870' } },
    { path: 'repos/example/widgets', body: { full_name: 'example/widgets' } },
    { path: 'repos/example/widgets/pulls/12', status: 404, body: { message: 'Not Found' }, headers: { [LIMIT]: '4868' } },
    { path: 'user', body: { login: 'maint' }, headers: { [LIMIT]: '4867' } },
    { path: 'repos/example/widgets/pulls/11/comments', body: [], headers: { [LIMIT]: '12' } },
  ])

  // GitHub's 304s carry the header, the fake's do not.
  async function limited(url, init) {
    const answer = await github.fetch(url, init)

    return answer.status === 304 ? new Response(null, { status: 304, headers: { [LIMIT]: '4869' } }) : answer
  }

  const { manifest } = rollout([])
  const client = createClient(manifest, { fetch: limited, token: async () => MAINTAINER_TOKEN })
  const remaining = []
  const note = () => remaining.push(client.stats().remaining)

  await client.request('GET', PR_PATH)
  note()
  await client.request('GET', PR_PATH)
  note()
  await client.request('GET', 'repos/example/widgets')
  note()
  await failure(client.request('GET', 'repos/example/widgets/pulls/12'))
  note()
  // Without repo.agentToken the agents use the maintainer's token, and its limit.
  await client.request('GET', 'user', { as: 'agents' })
  note()
  manifest.repo.agentToken = join(manifest.dir, 'agent-token')
  writeFileSync(manifest.repo.agentToken, `${AGENT_TOKEN}\n`)
  await client.request('GET', 'repos/example/widgets/pulls/11/comments', { as: 'agents' })
  note()

  assert.deepEqual(remaining, [4870, 4869, 4869, 4868, 4867, 4867])
  assert.equal(github.requests().at(-1).headers.authorization, `Bearer ${AGENT_TOKEN}`)
})

test('resetStats: requests and cached start again from 0, and remaining stays', async () => {
  const { client } = fakeClient([{ path: PR_PATH, body: { number: 11 }, headers: { [LIMIT]: '4870' } }])

  await client.request('GET', PR_PATH)
  await client.request('GET', PR_PATH)
  client.resetStats()

  assert.deepEqual(client.stats(), { requests: 0, cached: 0, remaining: 4870 })

  await client.request('GET', PR_PATH)

  assert.deepEqual(client.stats(), { requests: 1, cached: 1, remaining: 4870 })
})

const REVIEWS = 'repos/example/widgets/pulls/11/reviews'

test('pages: follows the Link header with per_page=100 and stops at the page without rel="next"', async () => {
  const reviews = Array.from({ length: 250 }, (_, i) => ({ id: i + 1 }))
  const { github, client } = fakeClient([{ path: REVIEWS, body: reviews }])

  assert.deepEqual(await client.pages(REVIEWS), reviews)
  assert.deepEqual(
    github.requests().map((request) => request.query),
    [{ per_page: '100' }, { per_page: '100', page: '2' }, { per_page: '100', page: '3' }],
  )
})

test('pages: takes the list out of an object answer and keeps the query', async () => {
  const runs = Array.from({ length: 101 }, (_, i) => ({ id: i + 1 }))
  const path = 'repos/example/widgets/commits/a1a1a1a/check-runs'
  const { github, client } = fakeClient([
    { path, query: { filter: 'latest' }, body: { total_count: 101, check_runs: runs }, items: 'check_runs' },
  ])

  assert.deepEqual(await client.pages(path, { query: { filter: 'latest' }, itemsOf: (body) => body.check_runs }), runs)
  assert.equal(github.requests().length, 2)
})

test('pages: an unchanged list costs 304s and gives the same items, page by page', async () => {
  const reviews = Array.from({ length: 150 }, (_, i) => ({ id: i + 1 }))
  const { github, client } = fakeClient([{ path: REVIEWS, body: reviews }])

  const first = await client.pages(REVIEWS)
  const second = await client.pages(REVIEWS)

  assert.deepEqual(second, first)
  assert.deepEqual(
    github.requests().map((request) => request.status),
    [200, 200, 304, 304],
  )
})

const COMMENTS = 'repos/example/widgets/issues/11/comments'

function comments(count) {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1 }))
}

// Each request as its page and the status it got.
function pageStatuses(github) {
  return github.requests().map((request) => [request.query.page ?? '1', request.status])
}

test('pages: a full page answered 304 is followed by the page after it, so items added since are read', async () => {
  const { github, client } = fakeClient([{ path: COMMENTS, body: comments(100) }])

  assert.deepEqual(await client.pages(COMMENTS), comments(100))

  github.answer([{ path: COMMENTS, body: comments(101) }])
  assert.deepEqual(await client.pages(COMMENTS), comments(101))

  github.answer([{ path: COMMENTS, body: comments(103) }])
  assert.deepEqual(await client.pages(COMMENTS), comments(103))
  assert.deepEqual(await client.pages(COMMENTS), comments(103))

  assert.deepEqual(pageStatuses(github), [
    ['1', 200],
    ['1', 304],
    ['2', 200],
    ['1', 304],
    ['2', 200],
    ['1', 304],
    ['2', 304],
  ])
})

test('pages: a list that stays at a full page costs one read of the empty page after it, then 304s', async () => {
  const { github, client } = fakeClient([{ path: COMMENTS, body: comments(100) }])

  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(await client.pages(COMMENTS), comments(100))
  }

  assert.deepEqual(pageStatuses(github), [
    ['1', 200],
    ['1', 304],
    ['2', 200],
    ['1', 304],
    ['2', 304],
  ])
})

test('pages: a page with no list throws', async () => {
  const { client } = fakeClient([{ path: REVIEWS, body: { message: 'x' } }])

  await assert.rejects(client.pages(REVIEWS), /^Error: repos\/example\/widgets\/pulls\/11\/reviews page 1 has no list$/)
})

test('pages: a Link to another origin throws before any request goes there', async () => {
  const link = '<https://elsewhere.example/repos/example/widgets/pulls/11/reviews?page=2>; rel="next"'
  const { github, client } = fakeClient([{ path: REVIEWS, body: [{ id: 1 }], headers: { link } }])

  await assert.rejects(client.pages(REVIEWS), /refused https:\/\/elsewhere\.example, the token goes only to https:\/\/api\.github\.com/)
  assert.equal(github.requests().length, 1)
})

test('client: a path that leaves api.github.com is refused before any request', async () => {
  const { github, client } = fakeClient([])

  await assert.rejects(client.request('GET', '//elsewhere.example/user'), /refused https:\/\/elsewhere\.example/)
  assert.deepEqual(github.requests(), [])
})

test('client: no token appears in a GitHubError, whatever went wrong', async () => {
  const token = 'synthetic-secret-0123456789'
  const routes = [
    { path: 'repos/example/widgets/pulls/1', status: 401, body: { message: 'Bad credentials' } },
    { path: 'repos/example/widgets/pulls/2', status: 500, body: { message: 'Server Error' } },
    { path: 'repos/example/widgets/pulls/3', status: 403, body: { message: 'API rate limit exceeded' } },
    { path: 'repos/example/widgets/pulls/4', error: 'ECONNRESET' },
    { path: 'repos/example/widgets/pulls/5', hang: true },
  ]

  const { client } = fakeClient(routes, { token: async () => token, timeoutMs: 50 })

  for (let number = 1; number <= 5; number += 1) {
    const error = await failure(client.request('GET', `repos/example/widgets/pulls/${number}`))
    const fields = JSON.stringify({ ...error, message: error.message, stack: error.stack })

    assert.ok(error instanceof GitHubError, String(error))

    for (const text of [error.message, error.detail, String(error), fields]) {
      assert.equal(text.includes(token), false, text)
    }
  }
})

test('client: a token with a line break is refused before fetch can quote it', async () => {
  const token = 'synthetic-secret\nsecond-line'
  const { github, client } = fakeClient([{ path: PR_PATH, body: { number: 11 } }], { token: async () => token })
  const error = await failure(client.request('GET', PR_PATH))

  assert.equal(error.message, "the maintainer's token holds a character an HTTP header cannot carry")
  assert.deepEqual(github.requests(), [])
})
