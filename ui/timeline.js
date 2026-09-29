import { element, link, withClass, wrap } from './dom.js'
import { clock, duration, money } from './format.js'
import { timelineLayout } from './timeline-layout.js'

const TICKS = 4
const ROLES = ['brief', 'implement', 'fix', 'verify']
const STATUSES = ['failed', 'interrupted', 'running']
const MARKER_TYPES = ['ready', 'rebase', 'feedback', 'merge']

function percent(fraction) {
  return `${fraction * 100}%`
}

function placed(node, left, width) {
  node.style.left = percent(left)

  if (width !== undefined) {
    node.style.width = percent(width)
  }

  return node
}

function barTitle(bar, run, now) {
  const role = bar.step ? `${bar.role} ${bar.step}` : bar.role
  const seconds = Math.max(0, (bar.to - bar.from) / 1000)
  const cost = run ? money(run.costUsd) : '-'

  return [
    bar.run ?? 'unnamed run',
    role,
    duration(seconds),
    cost,
    bar.status ?? 'unknown',
    clock(new Date(bar.from).toISOString(), now),
  ].join(' · ')
}

function barNode(bar, lane, ctx, runsByName) {
  const target = { pr: lane.id, tab: 'runs', run: bar.run }

  if (bar.status === 'running') {
    target.from = 'end'
  }

  const node = link(ctx.linkWith(target), undefined, `bar role-${bar.role} status-${bar.status}`)
  const title = barTitle(bar, runsByName.get(bar.run), ctx.now)

  node.title = title
  node.setAttribute('aria-label', title)

  return placed(node, bar.left, bar.width)
}

function markerNode(marker, now) {
  const node = element('span', undefined, `marker marker-${marker.type}`)
  node.title = `${marker.kind} ${clock(marker.at, now)}`

  return placed(node, marker.left)
}

function laneNode(lane, ctx, runsByName) {
  const track = element('div', undefined, 'track')

  track.append(...lane.bars.map((bar) => barNode(bar, lane, ctx, runsByName)))
  track.append(...lane.markers.map((marker) => markerNode(marker, ctx.now)))

  return withClass(wrap('div', link(ctx.linkWith({ pr: lane.id, tab: null }), lane.id, 'lane-label'), track), 'lane')
}

function axisNode(layout, now) {
  const axis = element('div', undefined, 'axis')

  for (let i = 0; i <= TICKS; i += 1) {
    const fraction = i / TICKS
    const time = new Date(layout.start + fraction * (layout.end - layout.start)).toISOString()
    axis.append(placed(element('span', clock(time, now), 'tick'), fraction))
  }

  return withClass(wrap('div', element('span', '', 'lane-label'), axis), 'lane axis-row')
}

function restartsNode(layout, now) {
  const overlay = element('div', undefined, 'restarts')

  for (const restart of layout.restarts) {
    const line = element('span', undefined, 'restart')
    line.title = `driver-start ${clock(restart.at, now)}`
    overlay.append(placed(line, restart.left))
  }

  return overlay
}

function legendItem(swatchClass, text) {
  return wrap('span', element('span', undefined, `swatch ${swatchClass}`), text)
}

function legend() {
  const node = element('div', undefined, 'legend')

  node.append(
    ...ROLES.map((role) => legendItem(`bar role-${role}`, role)),
    ...STATUSES.map((status) => legendItem(`bar role-none status-${status}`, status)),
    ...MARKER_TYPES.map((type) => legendItem(`marker marker-${type}`, type)),
    legendItem('restart', 'driver restart'),
  )

  return node
}

export function renderTimeline(ctx) {
  const { view, events, now } = ctx
  const layout = timelineLayout({ rows: view.rows, runs: view.runs, events, now, live: view.driver.running })
  const section = element('section', undefined, 'timeline')

  if (layout.start === null) {
    section.append(element('p', 'No runs or events with a time yet.', 'muted'))
    return section
  }

  const runsByName = new Map(view.runs.map((run) => [run.run, run]))
  const lanes = element('div', undefined, 'lanes')

  lanes.append(...layout.lanes.map((lane) => laneNode(lane, ctx, runsByName)), axisNode(layout, now), restartsNode(layout, now))
  section.append(legend(), withClass(wrap('div', lanes), 'scroll'))
  section.append(element('p', 'Gaps between bars are time spent waiting: for CI, a review or the next tick.', 'muted'))

  return section
}
