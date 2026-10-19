import { cell, element, link, stateBadge, table, wrap } from './dom.js'
import { sentence } from './format.js'
import { markdownDocument } from './markdown.js'

const HEADINGS = ['PR', 'state', 'section in the plan', 'source']

// One line per slice, in the order the PR page shows them.
function sliceLines(slices, field) {
  return wrap('div', ...slices.map((slice) => element('div', slice[field])))
}

// Before the first run there is no state and no PR page to open.
function sectionRow(pr, ctx) {
  const row = ctx.view?.rows.find((item) => item.id === pr.id)
  const found = pr.plan.length > 0
  const heading = cell(found ? sliceLines(pr.plan, 'heading') : element('span', 'No section', 'muted'))
  const source = cell(found ? sliceLines(pr.plan, 'source') : '-', 'info')

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

// A transcript source is the assistant's last long text, which is markdown too.
function sourceBlock(source, ctx) {
  const meta = [source.kind, source.tag ? `tag ${source.tag}` : null, source.path].filter(Boolean).join(' · ')
  const node = element('article', undefined, 'plan-source')
  const body = source.error
    ? element('p', source.error, 'error')
    : markdownDocument(source.text, { key: `plan|${source.title}`, level: 3, ctx })

  node.append(element('h2', source.title), element('p', meta, 'muted'), body)

  return node
}

function planBody(plan, ctx) {
  if (!plan || plan.status === null) {
    return [element('p', 'Loading…', 'muted')]
  }

  if (plan.status !== 200 || !plan.body) {
    return [element('p', plan.body?.error ? sentence(plan.body.error) : `The server answered ${plan.status}.`, 'error')]
  }

  const { prs, sources } = plan.body
  const blocks =
    sources.length === 0
      ? [element('p', 'The manifest has no briefing sources.', 'muted')]
      : sources.map((source) => sourceBlock(source, ctx))

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
