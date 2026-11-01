import { apiPost, followStream, resource, unreachable } from './api.js'
import { renderBoard } from './board.js'
import { PANEL_ITEMS, panelRun, rowOpen } from './board-model.js'
import { commandNotice } from './commands.js'
import { renderCosts } from './costs.js'
import { renderDetail } from './detail.js'
import { element, link, rowClick, wrap } from './dom.js'
import { renderEvents } from './events.js'
import { sentence, serverAnswered } from './format.js'
import { renderFooter, renderHeader, renderListHeader, renderTop, renderViewTabs, rolloutFacts } from './header.js'
import { isWaiting, mergeEvents, rowChanged } from './model.js'
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
const listResource = resource(token, { onUnauthorized: stopAll })
const detailResource = resource(token, { onUnauthorized: stopAll })
const planResource = resource(token, { onUnauthorized: stopAll })
const transcriptResource = resource(token, { onUnauthorized: stopAll })
const panelResource = resource(token, { onUnauthorized: stopAll })

let route = parseRoute(location.hash)
let stopped = false
let pendingRender = false
let composing = false
let listing = null
let listTimer = null
let transcriptBusy = false
let followTimer = null
let followed = false
let noticeTimer = null
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
    rowChoices: new Map(),
    remembered: new Map(),
    panels: new Map(),
    drafts: new Map(),
    sent: new Set(),
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

// A rebuild in the middle of a composed character would drop it, so the render waits for compositionend.
function scheduleRender() {
  if (pendingRender) {
    return
  }

  pendingRender = true
  requestAnimationFrame(() => {
    pendingRender = false

    if (!composing) {
      render()
    }
  })
}

function stopAll() {
  stopped = true
  stopList()
  closeStream()
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

  return rowClick(item, target, go)
}

function renderList() {
  document.title = 'Rollouts'

  if (!listing) {
    showLine('Loading…')
    return
  }

  if (listing.status !== 200 || !listing.body) {
    showLine(serverAnswered(listing.status, listing.body))
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

// No answer means the list was stopped, so the chain of reads ends there.
async function refreshList() {
  const answer = await listResource.load('/api/rollouts')

  if (!answer) {
    return
  }

  listing = answer
  render()
  listTimer = setTimeout(refreshList, REFRESH_MS)
}

function startList() {
  stopList()
  refreshList()
}

function stopList() {
  listResource.cancel()
  clearTimeout(listTimer)
}

// The detail, the plan, the transcript and the panels belong to the session this replaces.
function closeStream() {
  session.stream?.close()
  detailResource.cancel()
  planResource.cancel()
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
      const previous = current.state

      current.state = state
      current.problem = null

      // The heartbeat pushes a state at every tick, so the PR page reads again only when its row changed or its last read failed.
      if (route.pr && (rowChanged(previous, state, route.pr) || detailFailed())) {
        loadDetail()
      }

      loadPlan()
      recheckFollow({ fetchWhenStopped: true })
      forgetSent()
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

    return answer.status === 202
  } catch (error) {
    if (current === session) {
      showNotice(current, { text: unreachable(error), error: true })
    }

    return false
  }
}

// The box empties once the server took the note. Until the driver applies it, the row says it was sent.
async function sendAnswer(id, text) {
  const current = session
  const taken = await send(current, { cmd: 'note', id, text })

  if (taken && current === session) {
    current.drafts.delete(id)
    current.sent.add(id)
    scheduleRender()
  }
}

function detailKey() {
  return route.r && route.pr ? `${route.r}\n${route.pr}` : null
}

function detailFailed() {
  const status = session.detail?.status ?? null

  return status !== null && status !== 200
}

async function fetchDetail(key) {
  const answer = await detailResource.load(apiPath(route.r, 'prs', route.pr), key)

  if (!answer) {
    return
  }

  session.detail = answer
  scheduleRender()
}

function loadDetail() {
  const key = detailKey()
  detailResource.cancel()

  if (!key) {
    session.detail = null
    return
  }

  if (session.detail?.key !== key) {
    session.detail = { key, status: null, body: null }
  }

  fetchDetail(key)
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

async function fetchPlan(key) {
  const answer = await planResource.load(apiPath(route.r, 'plan'), key)

  if (!answer) {
    return
  }

  session.plan = answer
  scheduleRender()
}

function loadPlan() {
  const key = planKey()
  planResource.cancel()

  if (!key) {
    return
  }

  if (session.plan?.key !== key) {
    session.plan = { key, status: null, body: null }
  }

  fetchPlan(key)
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
  transcriptResource.cancel()
  transcriptBusy = false
  stopFollowing()
}

// A timeout chain rather than an interval, so at most one request is in flight.
function scheduleFollow() {
  stopFollowing()

  if (transcriptBusy || !following()) {
    return
  }

  followTimer = setTimeout(() => {
    followTimer = null
    fetchTranscript(transcriptKey())
  }, FOLLOW_MS)
}

// Without an answer transcriptBusy stays as it is, because a newer load may already be in flight.
async function fetchTranscript(key) {
  const path = `${apiPath(route.r, 'runs', route.run)}?from=${route.from ?? 0}&limit=${PAGE_SIZE}`

  transcriptBusy = true

  const answer = await transcriptResource.load(path, key)

  if (!answer) {
    return
  }

  session.transcript = answer
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

  fetchTranscript(key)
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
    .filter((row) => !isWaiting(row) && session.rowChoices.get(row.id) && (!route.state || row.state === route.state))
    .map((row) => panelRun(row, view.runs))
    .filter(Boolean)
}

async function fetchPanel(run) {
  const current = session
  const path = `${apiPath(route.r, 'runs', run.run)}?from=end&limit=${PANEL_ITEMS}`

  panelsBusy.add(run.run)

  const answer = await panelResource.load(path, run.run)

  panelsBusy.delete(run.run)

  if (!answer || current !== session) {
    return
  }

  session.panels.set(run.run, { ...answer, runStatus: run.status })
  scheduleRender()
}

function stopPanels() {
  panelResource.cancel()
  clearTimeout(panelTimer)
  panelTimer = null
  panelsBusy.clear()
}

// A timeout chain, like the transcript's, so a slow answer never piles up requests.
function schedulePanelPoll() {
  if (panelTimer || !panelRuns().some((run) => run.status === 'running')) {
    return
  }

  panelTimer = setTimeout(() => {
    panelTimer = null

    for (const run of panelRuns().filter((item) => item.status === 'running' && !panelsBusy.has(item.run))) {
      fetchPanel(run)
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

    fetchPanel(run)
  }

  schedulePanelPoll()
}

// The toggle flips what the row shows now, whether that came from a click or from the default of a waiting row.
function toggleRow(id) {
  const view = session.state?.view
  const row = view?.rows.find((item) => item.id === id)

  if (!row) {
    return
  }

  session.rowChoices.set(id, !rowOpen(row, panelRun(row, view.runs), session.rowChoices))
  syncPanels()
  scheduleRender()
}

// A row that stopped waiting no longer says its note was sent.
function forgetSent() {
  const waiting = new Set((session.state?.view?.rows ?? []).filter(isWaiting).map((row) => row.id))

  for (const id of session.sent) {
    if (!waiting.has(id)) {
      session.sent.delete(id)
    }
  }
}

function nearBottom() {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - STICK_PX
}

function failure() {
  const { status, error } = session.failure
  const text = status === 404 ? 'unknown rollout' : (error ?? serverAnswered(status))

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
    rowChoices: session.rowChoices,
    panels: session.panels,
    drafts: session.drafts,
    sent: session.sent,
    toggleRow,
    sendAnswer,
    readOnly: session.state?.readOnly !== false,
    sending: session.sending,
    notice: session.notice,
    send: (command) => send(current, command),
    remembered: session.remembered,
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

// The box being typed in, with its caret, so the rebuilt page puts both back.
function keptFocus() {
  const active = document.activeElement
  const key = active?.dataset?.keep

  if (!key) {
    return null
  }

  return { key, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection, scroll: active.scrollTop }
}

function restoreFocus(kept) {
  const node = kept ? app.querySelector(`[data-keep="${CSS.escape(kept.key)}"]`) : null

  if (!node) {
    return
  }

  node.focus({ preventScroll: true })
  node.setSelectionRange(kept.start, kept.end, kept.direction)
  node.scrollTop = kept.scroll
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
  const kept = keptFocus()

  renderRollout()
  restoreFocus(kept)

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
  document.addEventListener('compositionstart', () => {
    composing = true
  })

  document.addEventListener('compositionend', () => {
    composing = false
    scheduleRender()
  })

  setInterval(() => scheduleRender(), TICK_MS)
  onRoute()
}

start()
