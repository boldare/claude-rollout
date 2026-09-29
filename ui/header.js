import { renderRolloutControls } from './controls.js'
import { badge, element, link, secondsSince, withClass, wrap } from './dom.js'
import { ago, money } from './format.js'
import { driverStatus, errorCount } from './model.js'

const STALE_HEARTBEAT_SECONDS = 300
const VIEWS = ['board', 'timeline', 'events', 'costs']

function heartbeatAge(driver, state, now) {
  if (driver.heartbeatAgeSeconds === null || driver.heartbeatAgeSeconds === undefined) {
    return null
  }

  return driver.heartbeatAgeSeconds + Math.floor(secondsSince(state.at, now) ?? 0)
}

function heartbeat(driver, state, now) {
  const age = heartbeatAge(driver, state, now)
  const note = driver.heartbeatNote ? ` (${driver.heartbeatNote})` : ''
  const stale = age !== null && age > STALE_HEARTBEAT_SECONDS

  return element('span', `heartbeat ${ago(age)}${note}`, stale ? 'warning' : '')
}

function driverPart(driver, state, now) {
  const status = driverStatus(driver)
  const part = element('span', undefined, 'fact')

  part.append(badge(status, `driver driver-${status}`))

  if (driver.running) {
    part.append(element('span', `pid ${driver.pid ?? '-'}`), heartbeat(driver, state, now))
  }

  if (driver.halted) {
    part.append(element('span', `halted: ${driver.halted}`, 'error'))
  }

  return part
}

function fact(label, value) {
  const part = element('span', undefined, 'fact')
  part.append(element('span', label, 'label'), typeof value === 'string' ? element('span', value) : value)

  return part
}

function errorsLink(ctx) {
  const count = errorCount(ctx.events)
  const target = ctx.linkWith({ view: 'events', kind: 'errors', id: null, pr: null, tab: null })

  return link(target, `${count} ${count === 1 ? 'error' : 'errors'}`, count > 0 ? 'error' : '')
}

function facts(ctx) {
  const { view, state, now } = ctx
  const merged = view.rows.filter((row) => row.state === 'merged').length

  return wrap(
    'div',
    driverPart(view.driver, state, now),
    fact('merge', view.merge ?? '-'),
    fact('cost', money(view.costs.totalUsd)),
    fact('merged', `${merged}/${view.rows.length}`),
    errorsLink(ctx),
  )
}

function streamLine(ctx) {
  const parts = []

  if (ctx.status === 'reconnecting') {
    parts.push(element('p', 'reconnecting to the stream…', 'banner warning'))
  }

  if (ctx.problem) {
    parts.push(element('p', ctx.problem, 'banner error'))
  }

  if (ctx.notice) {
    parts.push(element('p', ctx.notice.text, ctx.notice.error ? 'banner error' : 'banner'))
  }

  return parts
}

export function renderHeader(ctx) {
  const name = ctx.view?.rollout ?? ctx.state?.name ?? ctx.route.r
  const header = element('header', undefined, 'header')
  const title = wrap('div', element('h1', name), link(ctx.linkTo({}), 'all rollouts'))

  document.title = name

  if (ctx.state?.readOnly) {
    title.append(badge('read-only', 'read-only'))
  }

  header.append(withClass(title, 'title'))

  if (ctx.state && !ctx.view) {
    header.append(element('p', 'not started: no ledger yet', 'muted'))
  }

  if (ctx.view) {
    header.append(withClass(facts(ctx), 'facts'))
  }

  const controls = ctx.state ? renderRolloutControls(ctx) : null

  if (controls) {
    header.append(controls)
  }

  header.append(...streamLine(ctx))

  return header
}

export function renderViewTabs(ctx) {
  const nav = element('nav', undefined, 'tabs')

  for (const view of VIEWS) {
    const active = !ctx.route.pr && ctx.route.view === view
    nav.append(link(ctx.linkWith({ view, pr: null, tab: null }), view, active ? 'tab active' : 'tab'))
  }

  return nav
}
