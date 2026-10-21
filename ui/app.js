import { apiGet, apiPost, followStream } from './api.js'
import { renderBoard } from './board.js'
import { PANEL_ITEMS, panelRun } from './board-model.js'
import { commandNotice } from './commands.js'
import { renderCosts } from './costs.js'
import { renderDetail } from './detail.js'
import { element, link, wrap } from './dom.js'
import { renderEvents } from './events.js'
import { sentence } from './format.js'
import { renderFooter, renderHeader, renderListHeader, renderTop, renderViewTabs, rolloutFacts } from './header.js'
import { mergeEvents } from './model.js'
import { renderPlan } from './plan.js'
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
const VIEWS = ['board', 'timeline', 'events', 'costs', 'plan']
const TABS = ['overview', 'runs', 'verifier', 'review', 'plan', 'brief']
const DEFAULTS = { view: 'board', tab: 'overview' }
const VIEW_RENDERERS = { board: renderBoard, timeline: renderTimeline, events: renderEvents, costs: renderCosts, plan: renderPlan }

const token = new URLSearchParams(location.hash.slice(1)).get('t')
const app = document.getElementById('app')
const openVerdicts = new Set()
const openTranscript = new Map()
const sourceDocs = new Set()

let route = parseRoute(location.hash)
let stopped = false
let pendingRender = false
let listing = null
let listTimer = null
let listTicket = 0
let detailTicket = 0
let planTicket = 0
let transcriptTicket = 0
let transcriptBusy = false
let followTimer = null
let followed = false
let noticeTimer = null
let panelTicket = 0
let panelTimer = null
let session = freshSession(null)

const panelsBusy = new Set()

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
    plan: null,
    transcript: null,
    openRows: new Set(),
    panels: new Map(),
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
  stopPanels()
  closeStream()
  detailTicket += 1
  planTicket += 1
  document.title = 'rollout'
  showLine(OPEN_THE_URL)
}

function rolloutSummary(rollout) {
  if (!rollout.started && !rollout.driver?.running) {
    return element('span', 'Not started: no ledger yet', 'facts')
  }

  return rolloutFacts({
    driver: rollout.driver,
    heartbeatAgeSeconds: rollout.driver?.heartbeatAgeSeconds ?? null,
    merge: rollout.merge,
    costUsd: rollout.costUsd,
    merged: rollout.merged,
    total: rollout.total,
    errors: rollout.errors > 0 ? rollout.errors : null,
    errorsHref: linkTo({ r: rollout.name, view: 'events', kind: 'errors' }),
  })
}

// The whole row opens the rollout, as a board row opens its PR. A click on a link in it follows the link.
function rolloutItem(rollout) {
  const item = element('li', undefined, 'rollout')

  if (rollout.error) {
    item.append(element('strong', rollout.name), element('span', sentence(rollout.error), 'error'))
    return item
  }

  const target = linkTo({ r: rollout.name })

  item.className = 'rollout clickable'
  item.append(wrap('strong', link(target, rollout.name)), rolloutSummary(rollout))
  item.addEventListener('click', (event) => {
    if (!event.target.closest('a, button')) {
      go(target)
    }
  })

  return item
}

function renderList() {
  document.title = 'Rollouts'

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
  app.replaceChildren(renderTop(renderListHeader()), items, renderFooter())
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
  stopPanels()
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
      loadPlan()
      recheckFollow({ fetchWhenStopped: true })
      syncPanels()
      scheduleRender()
    },
    onEvents(update) {
      current.events = mergeEvents(current.events, update)
      scheduleRender()
    },
    onProblem(problem) {
      current.problem = sentence(problem.error)
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

// The plan file is not watched, so every state push reads it again while the view is open.
// Before the first run the plan is all there is to show, whatever the view.
function planKey() {
  if (!route.r || route.pr) {
    return null
  }

  return route.view === 'plan' || notStarted() ? route.r : null
}

function notStarted() {
  return Boolean(session.state) && !session.state.view
}

async function fetchPlan(key, ticket) {
  try {
    const { status, body } = await apiGet(token, apiPath(route.r, 'plan'))

    if (ticket !== planTicket) {
      return
    }

    if (status === 401) {
      stopAll()
      return
    }

    session.plan = { key, status, body }
  } catch (error) {
    if (ticket !== planTicket) {
      return
    }

    session.plan = { key, status: 0, body: { error: `Cannot reach the server: ${error.message}` } }
  }

  scheduleRender()
}

function loadPlan() {
  const key = planKey()
  planTicket += 1

  if (!key) {
    return
  }

  if (session.plan?.key !== key) {
    session.plan = { key, status: null, body: null }
  }

  fetchPlan(key, planTicket)
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

// The runs the open rows of the board show. Each panel reads the end of its run's log.
function panelRuns() {
  const view = session.state?.view

  if (!view || route.pr || route.view !== 'board') {
    return []
  }

  return view.rows
    .filter((row) => session.openRows.has(row.id) && (!route.state || row.state === route.state))
    .map((row) => panelRun(row, view.runs))
    .filter(Boolean)
}

async function fetchPanel(run, ticket) {
  const current = session
  const path = `${apiPath(route.r, 'runs', run.run)}?from=end&limit=${PANEL_ITEMS}`
  let tail

  panelsBusy.add(run.run)

  try {
    const { status, body } = await apiGet(token, path)

    tail = { status, body, runStatus: run.status }
  } catch (error) {
    tail = { status: 0, body: { error: `Cannot reach the server: ${error.message}` }, runStatus: run.status }
  }

  panelsBusy.delete(run.run)

  if (ticket !== panelTicket || current !== session) {
    return
  }

  if (tail.status === 401) {
    stopAll()
    return
  }

  session.panels.set(run.run, tail)
  scheduleRender()
}

function stopPanels() {
  panelTicket += 1
  clearTimeout(panelTimer)
  panelTimer = null
  panelsBusy.clear()
}

// A timeout chain, like the transcript's, so a slow answer never piles up requests.
function schedulePanelPoll() {
  if (panelTimer || !panelRuns().some((run) => run.status === 'running')) {
    return
  }

  const ticket = panelTicket

  panelTimer = setTimeout(() => {
    panelTimer = null

    if (ticket !== panelTicket) {
      return
    }

    for (const run of panelRuns().filter((item) => item.status === 'running' && !panelsBusy.has(item.run))) {
      fetchPanel(run, ticket)
    }

    schedulePanelPoll()
  }, FOLLOW_MS)
}

// Reads a run an open row has not read yet, or again once it ended, and drops the rest.
function syncPanels() {
  const wanted = panelRuns()
  const names = new Set(wanted.map((run) => run.run))

  for (const name of session.panels.keys()) {
    if (!names.has(name)) {
      session.panels.delete(name)
    }
  }

  for (const run of wanted) {
    const known = session.panels.get(run.run)

    if (panelsBusy.has(run.run) || known?.runStatus === run.status) {
      continue
    }

    if (!known) {
      session.panels.set(run.run, { status: null, body: null, runStatus: run.status })
    }

    fetchPanel(run, panelTicket)
  }

  schedulePanelPoll()
}

function toggleRow(id) {
  if (session.openRows.has(id)) {
    session.openRows.delete(id)
  } else {
    session.openRows.add(id)
  }

  syncPanels()
  scheduleRender()
}

function nearBottom() {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - STICK_PX
}

function failure() {
  const { status, error } = session.failure
  const text = status === 404 ? 'unknown rollout' : (error ?? `The server answered ${status}.`)

  document.title = 'rollout'

  return [element('p', text, 'error'), wrap('p', link(linkTo({}), 'All rollouts'))]
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
    plan: session.plan,
    transcript: session.transcript,
    openRows: session.openRows,
    panels: session.panels,
    toggleRow,
    readOnly: session.state?.readOnly !== false,
    sending: session.sending,
    notice: session.notice,
    send: (command) => send(current, command),
    openVerdicts,
    openTranscript,
    sourceDocs,
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
    app.replaceChildren(renderTop(header), element('p', ctx.problem ? 'No state yet.' : 'Loading…', 'muted'))
    return
  }

  if (!ctx.view) {
    app.replaceChildren(renderTop(header), ...(ctx.route.pr ? [] : [renderPlan(ctx)]), renderFooter())
    return
  }

  app.replaceChildren(renderTop(header, renderViewTabs(ctx)), renderBody(ctx), renderFooter())
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
  const previousPlan = planKey()
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

  if (planKey() !== previousPlan) {
    loadPlan()
  }

  if (transcriptKey() !== previousTranscript || (transcriptKey() && !session.transcript)) {
    loadTranscript()
  }

  recheckFollow({ fetchWhenStopped: false })
  syncPanels()
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
