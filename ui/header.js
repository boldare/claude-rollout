import { renderRolloutControls } from './controls.js'
import { badge, element, link, secondsSince, withClass, wrap } from './dom.js'
import { ago, money } from './format.js'
import { driverStatus, errorCount } from './model.js'

const STALE_HEARTBEAT_SECONDS = 300
const VIEWS = ['board', 'timeline', 'events', 'costs', 'plan']
const REPOSITORY = 'https://github.com/boldare/claude-rollout'
const BOLDARE = 'https://www.boldare.com/'

function heartbeatAge(driver, state, now) {
  if (driver.heartbeatAgeSeconds === null || driver.heartbeatAgeSeconds === undefined) {
    return null
  }

  return driver.heartbeatAgeSeconds + Math.floor(secondsSince(state.at, now) ?? 0)
}

function heartbeat(driver, age) {
  const note = driver.heartbeatNote ? ` (${driver.heartbeatNote})` : ''
  const stale = age !== null && age > STALE_HEARTBEAT_SECONDS

  return element('span', `Heartbeat ${ago(age)}${note}`, stale ? 'warning' : '')
}

function driverPart(driver, age) {
  const status = driverStatus(driver)
  const part = element('span', undefined, 'fact')

  part.append(badge(status, `driver driver-${status}`))

  if (driver?.running) {
    part.append(element('span', `PID ${driver.pid ?? '-'}`), heartbeat(driver, age))
  }

  if (driver?.halted) {
    part.append(element('span', `Halted: ${driver.halted}`, 'error'))
  }

  return part
}

function fact(label, value) {
  const part = element('span', undefined, 'fact')
  part.append(element('span', label, 'label'), typeof value === 'string' ? element('span', value) : value)

  return part
}

function errorsLink(count, href) {
  return link(href, `${count} ${count === 1 ? 'error' : 'errors'}`, count > 0 ? 'error' : '')
}

// The header and the rollout list say the same things the same way. The list leaves out a zero error count.
export function rolloutFacts({ driver, heartbeatAgeSeconds, merge, costUsd, merged, total, errors, errorsHref }) {
  const node = wrap(
    'div',
    driverPart(driver, heartbeatAgeSeconds),
    fact('merge', merge ?? '-'),
    fact('cost', money(costUsd)),
    fact('merged', `${merged}/${total}`),
  )

  if (errors !== null) {
    node.append(errorsLink(errors, errorsHref))
  }

  return withClass(node, 'facts')
}

function facts(ctx) {
  const { view, state, now } = ctx

  return rolloutFacts({
    driver: view.driver,
    heartbeatAgeSeconds: heartbeatAge(view.driver, state, now),
    merge: view.merge,
    costUsd: view.costs.totalUsd,
    merged: view.rows.filter((row) => row.state === 'merged').length,
    total: view.rows.length,
    errors: errorCount(ctx.events),
    errorsHref: ctx.linkWith({ view: 'events', kind: 'errors', id: null, pr: null, tab: null }),
  })
}

function streamLine(ctx) {
  const parts = []

  if (ctx.status === 'reconnecting') {
    parts.push(element('p', 'Reconnecting to the stream…', 'banner warning'))
  }

  if (ctx.problem) {
    parts.push(element('p', ctx.problem, 'banner error'))
  }

  if (ctx.notice) {
    parts.push(element('p', ctx.notice.text, ctx.notice.error ? 'banner error' : 'banner'))
  }

  return parts
}

export function renderListHeader() {
  const header = element('header', undefined, 'header')
  header.append(withClass(wrap('div', element('h1', 'Rollouts')), 'title'))

  return header
}

export function renderHeader(ctx) {
  const name = ctx.view?.rollout ?? ctx.state?.name ?? ctx.route.r
  const header = element('header', undefined, 'header')
  const title = wrap('div', element('h1', name), link(ctx.linkTo({}), 'All rollouts'))

  document.title = name

  if (ctx.state?.readOnly) {
    title.append(badge('read-only', 'read-only'))
  }

  header.append(withClass(title, 'title'))

  if (ctx.state && !ctx.view) {
    header.append(element('p', 'Not started: no ledger yet', 'muted'))
  }

  if (ctx.view) {
    header.append(facts(ctx))
  }

  const controls = ctx.state ? renderRolloutControls(ctx) : null

  if (controls) {
    header.append(controls)
  }

  header.append(...streamLine(ctx))

  return header
}

// On a PR page the view it came from stays marked, and its tab leads back there.
export function renderViewTabs(ctx) {
  const nav = element('nav', undefined, 'views')

  for (const view of VIEWS) {
    const active = ctx.route.view === view
    nav.append(link(ctx.linkWith({ view, pr: null, tab: null }), view, active ? 'tab active' : 'tab'))
  }

  return nav
}

export function renderTop(...parts) {
  return withClass(wrap('div', ...parts), 'top')
}

// A span, not an img: style.css paints each mark through a mask so it follows the scheme.
function markLink(href, className, label) {
  const mark = element('span', undefined, `mark ${className}`)
  const node = link(href, undefined)

  node.append(mark)
  node.target = '_blank'
  node.rel = 'noreferrer noopener'
  node.setAttribute('aria-label', label)

  return node
}

export function renderFooter() {
  const footer = element('footer', undefined, 'footer')

  footer.append(
    element('span', 'MIT · Boldare 2026'),
    markLink(BOLDARE, 'logo', 'Boldare'),
    markLink(REPOSITORY, 'github', 'claude-rollout on GitHub'),
  )

  return footer
}
