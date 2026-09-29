import { cell, element, table, wrap } from './dom.js'
import { clock } from './format.js'
import { ERROR_KINDS, eventDetail, filterEvents } from './model.js'

const ROW_LIMIT = 500
const HEADINGS = ['time', 'PR', 'kind', 'detail']

function option(value, text, selected) {
  const node = element('option', text)
  node.value = value
  node.selected = value === selected

  return node
}

// A filter from the fragment stays selectable even when no event carries it any more.
function withCurrent(values, current) {
  return current === null || values.includes(current) ? values : [...values, current]
}

function filterSelect(label, key, choices, ctx) {
  const current = ctx.route[key] ?? ''
  const select = element('select')

  select.append(...choices.map(({ value, text }) => option(value, text, current)))
  select.addEventListener('change', () => ctx.go(ctx.linkWith({ [key]: select.value || null })))

  return wrap('label', `${label} `, select)
}

function idChoices(ctx) {
  const ids = withCurrent(
    ctx.view.rows.map((row) => row.id),
    ctx.route.id === '-' ? null : ctx.route.id,
  )

  return [{ value: '', text: 'all' }, { value: '-', text: 'driver (-)' }, ...ids.map((id) => ({ value: id, text: id }))]
}

function kindChoices(ctx) {
  const present = [...new Set(ctx.events.map((event) => event.kind).filter((kind) => typeof kind === 'string'))].sort()
  const kinds = withCurrent(present, ctx.route.kind === 'errors' ? null : ctx.route.kind)

  return [{ value: '', text: 'all' }, { value: 'errors', text: 'errors' }, ...kinds.map((kind) => ({ value: kind, text: kind }))]
}

function eventRow(event, now) {
  const node = wrap(
    'tr',
    cell(clock(event.at, now)),
    cell(String(event.id ?? '')),
    cell(String(event.kind ?? '')),
    cell(eventDetail(event), 'detail'),
  )

  if (ERROR_KINDS.includes(event.kind)) {
    node.className = 'error-event'
  }

  return node
}

export function renderEvents(ctx) {
  const matching = filterEvents(ctx.events, { id: ctx.route.id, kind: ctx.route.kind })
  const shown = matching.slice(0, ROW_LIMIT)
  const filters = wrap('div', filterSelect('PR', 'id', idChoices(ctx), ctx), filterSelect('kind', 'kind', kindChoices(ctx), ctx))
  const section = element('section', undefined, 'events')
  const count = matching.length > ROW_LIMIT ? `showing ${ROW_LIMIT} of ${matching.length}` : `${matching.length} shown`

  filters.className = 'filters'
  section.append(
    filters,
    element('p', count, 'muted'),
    table(
      HEADINGS,
      shown.map((event) => eventRow(event, ctx.now)),
      'event-log',
    ),
  )

  return section
}
