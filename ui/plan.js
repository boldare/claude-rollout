import { cell, element, link, stateBadge, table, wrap } from './dom.js'

const HEADINGS = ['PR', 'state', 'section in the plan', 'source']

// Before the first run there is no state and no PR page to open.
function sectionRow(pr, ctx) {
  const row = ctx.view?.rows.find((item) => item.id === pr.id)
  const heading = pr.plan ? cell(pr.plan.heading) : cell(element('span', 'no section', 'muted'))
  const source = cell(pr.plan?.source ?? '-', 'info')

  if (!row) {
    return wrap('tr', cell(pr.id), cell('-'), heading, source)
  }

  const target = ctx.linkWith({ pr: pr.id, tab: 'plan' })
  const node = wrap('tr', cell(link(target, pr.id)), cell(stateBadge(row.state)), heading, source)

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

function planBody(plan, ctx) {
  if (!plan || plan.status === null) {
    return [element('p', 'Loading…', 'muted')]
  }

  if (plan.status !== 200 || !plan.body) {
    return [element('p', plan.body?.error ?? `The server answered ${plan.status}.`, 'error')]
  }

  const { prs, sources } = plan.body
  const blocks = sources.length === 0 ? [element('p', 'The manifest has no briefing sources.', 'muted')] : sources.map(sourceBlock)

  return [
    element('h2', 'PRs and their sections'),
    table(
      HEADINGS,
      prs.map((pr) => sectionRow(pr, ctx)),
    ),
    ...blocks,
  ]
}

export function renderPlan(ctx) {
  const section = element('section', undefined, 'plan')

  section.append(...planBody(ctx.plan, ctx))

  return section
}
