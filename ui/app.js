import { apiGet, apiPost, followStream } from './api.js'
import { renderBoard } from './board.js'
import { commandNotice } from './commands.js'
import { renderCosts } from './costs.js'
import { renderDetail } from './detail.js'
import { element, link, wrap } from './dom.js'
import { renderEvents } from './events.js'
import { money } from './format.js'
import { renderHeader, renderViewTabs } from './header.js'
import { driverStatus, mergeEvents } from './model.js'
import { renderTimeline } from './timeline.js'
import { FOLLOW_MS, PAGE_SIZE, shouldFollow, transcriptRoute } from './transcript-model.js'

// The whole view state lives in the fragment, next to the token, so it never
// reaches the server, and a reload or a link opened in a new tab still works.
const REFRESH_MS = 5000
const TICK_MS = 30_000
const NOTICE_MS = 15_000
const STICK_PX = 40
const OPEN_THE_URL = 'Open the URL that rollout ui printed in its terminal. It carries the access token.'
const ROUTE_KEYS = ['r', 'view', 'pr', 'tab', 'state', 'id', 'kind', 'run', 'from']
const VIEWS = ['board', 'timeline', 'events', 'costs']
const TABS = ['overview', 'runs', 'verifier', 'review', 'brief']
const DEFAULTS = { view: 'board', tab: 'overview' }
const VIEW_RENDERERS = { board: renderBoard, timeline: renderTimeline, events: renderEvents, costs: renderCosts }

const token = new URLSearchParams(location.hash.slice(1)).get('t')
const app = document.getElementById('app')
const openVerdicts = new Set()
const openTranscript = new Map()

let route = parseRoute(location.hash)
let stopped = false
let pendingRender = false
let listing = null
let listTimer = null
let listTicket = 0
let detailTicket = 0
let transcriptTicket = 0
let transcriptBusy = false
let followTimer = null
let followed = false
let noticeTimer = null
let session = freshSession(null)

function freshSession(name) {
  return {
    name,
    stream: null,
    state: null,
    events: [],
    status: null,
    problem: null,
    failure: null,
    detail: null,
    transcript: null,
    sending: false,
    notice: null,
  }
}

function oneOf(value, allowed) {
  return allowed.includes(value) ? value : allowed[0]
}

function pageFrom(value) {
  if (value === 'end') {
    return 'end'
  }

  return /^\d+$/.test(value ?? '') ? Number(value) : null
}

function parseRoute(hash) {
  const params = new URLSearchParams(hash.slice(1))
  const value = (key) => params.get(key) || null

  return {
    r: value('r'),
    view: oneOf(value('view'), VIEWS),
    pr: value('pr'),
    tab: oneOf(value('tab'), TABS),
    state: value('state'),
    id: value('id'),
    kind: value('kind'),
    run: value('run'),
    from: pageFrom(value('from')),
  }
}

function linkTo(target) {
  const params = new URLSearchParams({ t: token })

  for (const key of ROUTE_KEYS) {
    const value = target[key]

    if (value !== null && value !== undefined && value !== DEFAULTS[key]) {
      params.set(key, value)
    }
  }

  return `#${params}`
}

function linkWith(changes) {
  return linkTo(transcriptRoute(route, changes))
}

function go(href) {
  location.hash = href
}

function apiPath(...segments) {
  return `/api/rollouts/${segments.map(encodeURIComponent).join('/')}`
}

function showLine(text) {
  app.replaceChildren(element('p', text))
}

function scheduleRender() {
  if (pendingRender) {
    return
  }

  pendingRender = true
  requestAnimationFrame(() => {
    pendingRender = false
    render()
  })
}

function stopAll() {
  stopped = true
  stopList()
  closeStream()
  detailTicket += 1
  document.title = 'rollout'
  showLine(OPEN_THE_URL)
}

function rolloutItem(rollout) {
  const item = element('li', undefined, 'rollout')

  if (rollout.error) {
    item.append(element('strong', rollout.name), element('span', rollout.error, 'error'))
    return item
  }

  item.append(
    wrap('strong', link(linkTo({ r: rollout.name }), rollout.name)),
    element('span', driverStatus(rollout.driver)),
    element('span', `${rollout.merged}/${rollout.total} merged`),
    element('span', money(rollout.costUsd)),
  )

  return item
}

function renderList() {
  document.title = 'rollouts'

  if (!listing) {
    showLine('Loading…')
    return
  }

  if (listing.problem) {
    showLine(listing.problem)
    return
  }

  const { root, rollouts } = listing.body

  if (rollouts.length === 0) {
    showLine(`No rollouts in ${root}.`)
    return
  }

  const items = element('ul', undefined, 'rollouts')
  items.append(...rollouts.map(rolloutItem))
  app.replaceChildren(element('h1', 'rollouts'), items)
}

// Resolves to whether another refresh makes sense.
async function loadList(ticket) {
  const { status, body } = await apiGet(token, '/api/rollouts')

  if (ticket !== listTicket) {
    return false
  }

  if (status === 401) {
    stopAll()
    return false
  }

  listing = status === 200 && body ? { body, problem: null } : { body: null, problem: `The server answered ${status}.` }
  render()

  return true
}

async function refreshList(ticket) {
  let again = true

  try {
    again = await loadList(ticket)
  } catch (error) {
    if (ticket !== listTicket) {
      return
    }

    listing = { body: null, problem: `Cannot reach the server: ${error.message}` }
    render()
  }

  if (again && ticket === listTicket) {
    listTimer = setTimeout(() => refreshList(ticket), REFRESH_MS)
  }
}

function startList() {
  stopList()
  refreshList(listTicket)
}

function stopList() {
  listTicket += 1
  clearTimeout(listTimer)
}

function closeStream() {
  session.stream?.close()
  invalidateTranscript()
  followed = false
  session = freshSession(null)
}

function onStatus(status, error) {
  if (status === 401) {
    stopAll()
    return
  }

  if (typeof status === 'number') {
    session.failure = { status, error }
  } else {
    session.status = status
  }

  scheduleRender()
}

function follow(name) {
  closeStream()
  session = freshSession(name)

  const current = session

  current.stream = followStream(token, name, {
    onState(state) {
      current.state = state
      current.problem = null
      loadDetail()
      recheckFollow({ fetchWhenStopped: true })
      scheduleRender()
    },
    onEvents(update) {
      current.events = mergeEvents(current.events, update)
      scheduleRender()
    },
    onProblem(problem) {
      current.problem = problem.error
      scheduleRender()
    },
    onStatus,
  })
}

function showNotice(current, notice) {
  current.sending = false
  current.notice = notice
  noticeTimer = setTimeout(() => {
    current.notice = null
    scheduleRender()
  }, NOTICE_MS)

  scheduleRender()
}

async function send(current, command) {
  clearTimeout(noticeTimer)
  current.notice = null
  current.sending = true
  scheduleRender()

  try {
    const answer = await apiPost(token, apiPath(current.name, 'commands'), command)

    if (current !== session) {
      return
    }

    if (answer.status === 401) {
      stopAll()
      return
    }

    showNotice(current, commandNotice(command, answer, current.state?.view?.driver))
  } catch (error) {
    if (current === session) {
      showNotice(current, { text: `Cannot reach the server: ${error.message}`, error: true })
    }
  }
}

function detailKey() {
  return route.r && route.pr ? `${route.r}\n${route.pr}` : null
}

async function fetchDetail(key, ticket) {
  try {
    const { status, body } = await apiGet(token, apiPath(route.r, 'prs', route.pr))

    if (ticket !== detailTicket) {
      return
    }

    if (status === 401) {
      stopAll()
      return
    }

    session.detail = { key, status, body }
  } catch (error) {
    if (ticket !== detailTicket) {
      return
    }

    session.detail = { key, status: 0, body: { error: `Cannot reach the server: ${error.message}` } }
  }

  scheduleRender()
}

function loadDetail() {
  const key = detailKey()
  detailTicket += 1

  if (!key) {
    session.detail = null
    return
  }

  if (session.detail?.key !== key) {
    session.detail = { key, status: null, body: null }
  }

  fetchDetail(key, detailTicket)
}

function transcriptKey() {
  if (!route.r || !route.pr || !route.run || route.tab !== 'runs') {
    return null
  }

  return `${route.r}\n${route.run}\n${route.from ?? 0}`
}

function runOfKey(key) {
  return key ? key.split('\n').slice(0, 2).join('\n') : null
}

function following() {
  return transcriptKey() !== null && shouldFollow(route, session.state?.view?.runs)
}

function stopFollowing() {
  clearTimeout(followTimer)
  followTimer = null
}

function invalidateTranscript() {
  transcriptTicket += 1
  transcriptBusy = false
  stopFollowing()
}

// A timeout chain rather than an interval, so at most one request is in flight.
function scheduleFollow() {
  stopFollowing()

  if (transcriptBusy || !following()) {
    return
  }

  const ticket = transcriptTicket

  followTimer = setTimeout(() => {
    followTimer = null

    if (ticket === transcriptTicket) {
      fetchTranscript(transcriptKey(), ticket)
    }
  }, FOLLOW_MS)
}

async function fetchTranscript(key, ticket) {
  const path = `${apiPath(route.r, 'runs', route.run)}?from=${route.from ?? 0}&limit=${PAGE_SIZE}`

  transcriptBusy = true

  try {
    const { status, body } = await apiGet(token, path)

    if (ticket !== transcriptTicket) {
      return
    }

    if (status === 401) {
      stopAll()
      return
    }

    session.transcript = { key, status, body }
  } catch (error) {
    if (ticket !== transcriptTicket) {
      return
    }

    session.transcript = { key, status: 0, body: { error: `Cannot reach the server: ${error.message}` } }
  }

  transcriptBusy = false
  scheduleFollow()
  scheduleRender()
}

// Another page of the same run keeps the current one on screen until it arrives.
function loadTranscript() {
  const key = transcriptKey()
  invalidateTranscript()

  if (!key) {
    session.transcript = null
    return
  }

  if (runOfKey(session.transcript?.key) !== runOfKey(key)) {
    session.transcript = { key, status: null, body: null }
  }

  fetchTranscript(key, transcriptTicket)
}

// The fetch after following stops shows the end of the log and the final report.
function recheckFollow({ fetchWhenStopped }) {
  const now = following()

  if (followed && !now && fetchWhenStopped) {
    loadTranscript()
  } else if (!now) {
    stopFollowing()
  } else if (!followTimer) {
    scheduleFollow()
  }

  followed = now
}

function nearBottom() {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - STICK_PX
}

function failure() {
  const { status, error } = session.failure
  const text = status === 404 ? 'unknown rollout' : (error ?? `The server answered ${status}.`)

  document.title = 'rollout'

  return [element('p', text, 'error'), wrap('p', link(linkTo({}), 'all rollouts'))]
}

function context() {
  const current = session

  return {
    route,
    now: Date.now(),
    state: session.state,
    view: session.state?.view ?? null,
    events: session.events,
    status: session.status,
    problem: session.problem,
    detail: session.detail,
    transcript: session.transcript,
    readOnly: session.state?.readOnly !== false,
    sending: session.sending,
    notice: session.notice,
    send: (command) => send(current, command),
    openVerdicts,
    openTranscript,
    linkTo,
    linkWith,
    go,
  }
}

function renderBody(ctx) {
  if (ctx.route.pr) {
    return renderDetail(ctx)
  }

  return VIEW_RENDERERS[ctx.route.view](ctx)
}

function renderRollout() {
  if (session.failure) {
    app.replaceChildren(...failure())
    return
  }

  const ctx = context()
  const header = renderHeader(ctx)

  if (!ctx.state) {
    app.replaceChildren(header, element('p', ctx.problem ? 'No state yet.' : 'Loading…', 'muted'))
    return
  }

  if (!ctx.view) {
    app.replaceChildren(header)
    return
  }

  app.replaceChildren(header, renderViewTabs(ctx), renderBody(ctx))
}

function render() {
  if (stopped) {
    showLine(OPEN_THE_URL)
    return
  }

  if (!route.r) {
    renderList()
    return
  }

  const stick = following() && nearBottom()

  renderRollout()

  if (stick) {
    window.scrollTo(0, document.documentElement.scrollHeight)
  }
}

function onRoute() {
  if (stopped) {
    return
  }

  const previousKey = detailKey()
  const previousTranscript = transcriptKey()
  route = parseRoute(location.hash)

  if (!route.r) {
    closeStream()
    startList()
    render()
    return
  }

  stopList()

  if (route.r !== session.name) {
    follow(route.r)
  }

  if (detailKey() !== previousKey || (route.pr && !session.detail)) {
    loadDetail()
  }

  if (transcriptKey() !== previousTranscript || (transcriptKey() && !session.transcript)) {
    loadTranscript()
  }

  recheckFollow({ fetchWhenStopped: false })
  render()
}

function start() {
  if (!token) {
    showLine(OPEN_THE_URL)
    return
  }

  window.addEventListener('hashchange', onRoute)
  setInterval(() => scheduleRender(), TICK_MS)
  onRoute()
}

start()
