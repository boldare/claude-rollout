import { cell, element, link, stateBadge, table, wrap } from './dom.js'

const HEADINGS = ['PR', 'state', 'section in the plan', 'source']

function sectionRow(row, ctx) {
  const target = ctx.linkWith({ pr: row.id, tab: 'plan' })
  const heading = row.plan ? cell(row.plan.heading) : cell(element('span', 'no section', 'muted'))
  const node = wrap('tr', cell(link(target, row.id)), cell(stateBadge(row.state)), heading, cell(row.plan?.source ?? '-', 'info'))

  node.className = 'clickable'
  node.addEventListener('click', (event) => {
    if (!event.target.closest('a, button')) {
      ctx.go(target)
    }
  })

  return node
}

function sourceBlock(source) {
  const meta = [source.kind, source.tag ? `tag ${source.tag}` : null, source.path].filter(Boolean).join(' · ')
  const node = element('article', undefined, 'plan-source')

  node.append(element('h2', source.title), element('p', meta, 'muted'))
  node.append(source.error ? element('p', source.error, 'error') : element('pre', source.text, 'document'))

  return node
}

function sourceBlocks(plan) {
  if (!plan || plan.status === null) {
    return [element('p', 'Loading…', 'muted')]
  }

  if (plan.status !== 200 || !plan.body) {
    return [element('p', plan.body?.error ?? `The server answered ${plan.status}.`, 'error')]
  }

  if (plan.body.sources.length === 0) {
    return [element('p', 'The manifest has no briefing sources.', 'muted')]
  }

  return plan.body.sources.map(sourceBlock)
}

export function renderPlan(ctx) {
  const section = element('section', undefined, 'plan')

  section.append(
    element('h2', 'PRs and their sections'),
    table(
      HEADINGS,
      ctx.view.rows.map((row) => sectionRow(row, ctx)),
    ),
    ...sourceBlocks(ctx.plan),
  )

  return section
}
