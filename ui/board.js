import { badge, cell, element, externalLink, link, secondsSince, stateBadge, table, wrap } from './dom.js'
import { ago, money } from './format.js'
import { stateCounts } from './model.js'

const HEADINGS = ['PR', 'title', 'state', 'GitHub', 'deps', 'attempts b/i/f/v', 'cost', 'last event', 'info']

function chip(href, text, active) {
  return link(href, text, active ? 'chip active' : 'chip')
}

function stateChips(rows, ctx) {
  const selected = ctx.route.state
  const chips = element('nav', undefined, 'chips')

  chips.append(chip(ctx.linkWith({ state: null }), `all ${rows.length}`, selected === null))

  for (const { state, count } of stateCounts(rows)) {
    chips.append(chip(ctx.linkWith({ state }), `${state} ${count}`, selected === state))
  }

  return chips
}

function stateCell(row) {
  const node = wrap('td', stateBadge(row.state))

  if (row.held) {
    node.append(badge('held', 'held'))
  }

  if (row.activeRun) {
    node.append(badge(row.activeRun, 'active-run'))
  }

  return node
}

function depsCell(row, ctx) {
  const node = element('td', row.deps.length === 0 ? '-' : undefined)

  for (const dep of row.deps) {
    node.append(wrap('span', link(ctx.linkWith({ pr: dep.id, tab: null }), dep.id), ' ', stateBadge(dep.state)), ' ')
  }

  return node
}

function attempts(row) {
  const { brief, implement, fix, verify } = row.attempts ?? {}

  return [brief, implement, fix, verify].map((count) => count ?? 0).join('/')
}

function boardRow(row, ctx) {
  const node = wrap(
    'tr',
    cell(link(ctx.linkWith({ pr: row.id, tab: null }), row.id)),
    cell(row.title),
    stateCell(row),
    cell(row.pr ? externalLink(row.url, `#${row.pr}`) : '-'),
    depsCell(row, ctx),
    cell(attempts(row), 'number'),
    cell(money(row.costUsd), 'number'),
    cell(ago(secondsSince(row.lastEventAt, ctx.now))),
    cell(row.info, 'info'),
  )

  node.className = 'clickable'
  node.addEventListener('click', (event) => {
    if (!event.target.closest('a')) {
      ctx.go(ctx.linkWith({ pr: row.id, tab: null }))
    }
  })

  return node
}

export function renderBoard(ctx) {
  const { rows } = ctx.view
  const selected = ctx.route.state
  const shown = selected ? rows.filter((row) => row.state === selected) : rows
  const section = element('section', undefined, 'board')

  section.append(
    stateChips(rows, ctx),
    table(
      HEADINGS,
      shown.map((row) => boardRow(row, ctx)),
    ),
  )

  if (shown.length === 0) {
    section.append(element('p', selected ? `No PR is ${selected}.` : 'No PRs.', 'muted'))
  }

  return section
}
