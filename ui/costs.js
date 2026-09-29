import { element, svgElement, withClass, wrap } from './dom.js'
import { clock, money } from './format.js'

const WIDTH = 600
const HEIGHT = 160

function barRow(label, value, max, fillClass) {
  const fill = element('span', undefined, `fill ${fillClass}`)
  fill.style.width = `${max > 0 ? (value / max) * 100 : 0}%`

  const track = withClass(wrap('span', fill), 'bar-track')

  return withClass(wrap('div', element('span', label, 'bar-label'), track, element('span', money(value), 'number')), 'cost-bar')
}

function barList(entries, fillClass) {
  const max = entries.reduce((high, [, value]) => Math.max(high, value), 0)
  const node = element('div', undefined, 'cost-bars')

  for (const [label, value] of entries) {
    node.append(barRow(label, value, max, fillClass(label)))
  }

  return node
}

// A step line, because the total only moves when a run ends.
function stepPoints(overTime) {
  const times = overTime.map((point) => Date.parse(point.at))
  const first = times[0]
  const span = times[times.length - 1] - first
  const max = overTime.reduce((high, point) => Math.max(high, point.totalUsd), 0)
  const xOf = (time) => (span > 0 ? ((time - first) / span) * WIDTH : WIDTH)
  const yOf = (usd) => (max > 0 ? HEIGHT - (usd / max) * HEIGHT : HEIGHT)
  const points = [`0,${HEIGHT}`]
  let previous = HEIGHT

  for (let i = 0; i < overTime.length; i += 1) {
    const left = xOf(times[i])
    const top = yOf(overTime[i].totalUsd)

    points.push(`${left},${previous}`, `${left},${top}`)
    previous = top
  }

  points.push(`${WIDTH},${previous}`)

  return points.join(' ')
}

function costLine(overTime, now) {
  const svg = svgElement('svg', { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img', class: 'cost-line' })
  const title = svgElement('title')
  const last = overTime[overTime.length - 1]

  title.textContent = `cumulative cost from finished runs, ${money(last.totalUsd)} at ${clock(last.at, now)}`
  svg.append(title, svgElement('polyline', { points: stepPoints(overTime) }))

  const axis = withClass(wrap('div', element('span', clock(overTime[0].at, now)), element('span', clock(last.at, now))), 'line-axis')

  return wrap('figure', element('figcaption', `cumulative, from finished runs: up to ${money(last.totalUsd)}`), svg, axis)
}

function estimateLine(costs) {
  const runs = costs.estimatedRuns === 1 ? '1 run' : `${costs.estimatedRuns} runs`

  return `Runs that reported no cost: about ${money(costs.estimatedUsd)} over ${runs}, estimated from the token usage in their logs. Not in the totals.`
}

export function renderCosts(ctx) {
  const { costs } = ctx.view
  const section = element('section', undefined, 'costs')
  const byPr = Object.entries(costs.byPr).sort((first, second) => second[1] - first[1])

  section.append(element('p', `total ${money(costs.totalUsd)} (from the ledger)`, 'total'))

  if (costs.estimatedRuns > 0) {
    section.append(element('p', estimateLine(costs), 'estimate'))
  }

  section.append(
    element('h2', 'per PR'),
    barList(byPr, () => 'fill-pr'),
    element('h2', 'per role, from finished runs'),
  )

  if (costs.overTime.length === 0) {
    section.append(element('p', 'No finished runs yet, so there is no per-role cost or cost over time.', 'muted'))
    return section
  }

  section.append(
    barList(Object.entries(costs.byRole), (role) => `role-${role}`),
    element('p', 'Run costs come from run events, the total from the ledger. The two can differ.', 'muted'),
    element('h2', 'cost over time, from finished runs'),
    costLine(costs.overTime, ctx.now),
  )

  return section
}
