import { badge, cell, element, externalLink, link, secondsSince, stateBadge, table, withClass, wrap } from './dom.js'
import { ago, duration, money, stateLabel } from './format.js'
import { renderRowControls } from './controls.js'
import { commandLines, panelRun, resultTone, tookText } from './board-model.js'
import { answeredText, isWaiting, stateCounts } from './model.js'

const HEADINGS = ['', 'PR', 'title', 'state', 'GitHub', 'deps', 'attempts b/i/f/v', 'cost', 'last event', 'info']

function chip(href, text, active) {
  return link(href, text, active ? 'chip active' : 'chip')
}

function stateChips(rows, ctx) {
  const selected = ctx.route.state
  const chips = element('nav', undefined, 'chips')

  chips.append(chip(ctx.linkWith({ state: null }), `all ${rows.length}`, selected === null))

  for (const { state, count } of stateCounts(rows)) {
    chips.append(chip(ctx.linkWith({ state }), `${stateLabel(state)} ${count}`, selected === state))
  }

  return chips
}

function stateCell(row, ctx) {
  const node = wrap('td', stateBadge(row.state))

  if (row.held) {
    node.append(badge('held', 'held'))
  }

  if (row.activeRun) {
    node.append(badge(row.activeRun, 'active-run'))
  }

  if (isWaiting(row)) {
    node.append(badge('needs you', 'waiting'))
  }

  const answered = answeredText(row.answered)

  if (answered) {
    node.append(badge(answered, 'answered'))
  }

  const controls = renderRowControls(row, ctx)

  if (controls) {
    node.append(controls)
  }

  return node
}

function depsCell(row, ctx) {
  const node = element('td', row.deps.length === 0 ? '-' : undefined, 'deps')

  for (const dep of row.deps) {
    node.append(wrap('span', link(ctx.linkWith({ pr: dep.id, tab: null }), dep.id), ' ', stateBadge(dep.state)), ' ')
  }

  return node
}

function attempts(row) {
  const { brief, implement, fix, verify } = row.attempts ?? {}

  return [brief, implement, fix, verify].map((count) => count ?? 0).join('/')
}

// The first line of the PR's section in the plan says what slice of it the PR is.
function titleCell(row) {
  const node = wrap('td', element('div', row.title))
  const first = (row.plan ?? []).find((slice) => slice.excerpt)

  node.className = 'pr-title'

  if (first) {
    const slice = element('div', first.excerpt, 'slice')
    slice.title = `${first.source}: ${first.heading}`
    node.append(slice)
  }

  return node
}

// A PR with nothing to show yet, like a pending one, has no toggle.
function toggleCell(row, run, open, ctx) {
  const node = element('td', undefined, 'toggle')

  if (!run) {
    return node
  }

  const button = element('button', undefined, 'row-toggle')

  button.type = 'button'
  button.setAttribute('aria-expanded', String(open))
  button.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} the last run of ${row.id}`)
  button.addEventListener('click', () => ctx.toggleRow(row.id))
  node.append(button)

  return node
}

function boardRow(row, run, open, ctx) {
  const node = wrap(
    'tr',
    toggleCell(row, run, open, ctx),
    cell(link(ctx.linkWith({ pr: row.id, tab: null }), row.id), 'id'),
    titleCell(row),
    stateCell(row, ctx),
    cell(row.pr ? externalLink(row.url, `#${row.pr}`) : '-', 'github'),
    depsCell(row, ctx),
    cell(attempts(row), 'number'),
    cell(money(row.costUsd), 'number'),
    cell(ago(secondsSince(row.lastEventAt, ctx.now)), 'age'),
    cell(row.info, 'info'),
  )

  node.className = ['clickable', isWaiting(row) ? 'waiting' : '', open ? 'open' : ''].filter(Boolean).join(' ')
  node.addEventListener('click', (event) => {
    if (!event.target.closest('a, button')) {
      ctx.go(ctx.linkWith({ pr: row.id, tab: null }))
    }
  })

  return node
}

function runFact(label, value, className) {
  return withClass(wrap('span', element('span', label, 'label'), element('span', value, className)), 'fact')
}

function runFacts(run, ctx) {
  const running = run.status === 'running'
  const facts = element('div', undefined, 'facts')

  if (running) {
    facts.append(badge(run.run, 'active-run'))
  } else {
    facts.append(
      element('span', run.run, 'run-name'),
      badge(run.result ?? run.status ?? '-', `verdict-${resultTone(run.result ?? run.status)}`),
    )
  }

  facts.append(runFact('role', run.role === 'brief' && run.step ? `brief ${run.step}` : run.role), runFact('effort', run.effort ?? '-'))

  if (run.model) {
    facts.append(runFact('model', run.model))
  }

  if (running) {
    facts.append(runFact('running', duration(secondsSince(run.startedAt, ctx.now)), 'live'))
  } else {
    facts.append(runFact('took', tookText(run)))
  }

  return facts
}

function outcome(line) {
  const node = element('span', undefined, 'outcome')

  if (line.outcome.tag) {
    node.append(badge(line.outcome.tag, line.outcome.tag === 'refused' ? 'refused' : 'result-error'))
  }

  node.append(element('span', line.outcome.text))

  return node
}

function commandLine(line) {
  if (line.kind === 'text') {
    return element('li', line.text, 'message')
  }

  const target = element('code', line.target)
  target.title = line.target

  return wrap('li', element('strong', line.name), target, outcome(line))
}

function commandsPart(run, ctx) {
  const tail = ctx.panels.get(run.run)

  if (!tail || tail.status === null) {
    return [element('p', 'Reading the log…', 'muted')]
  }

  if (tail.status === 404) {
    return [element('p', 'No log yet.', 'muted')]
  }

  if (tail.status !== 200) {
    return [element('p', tail.body?.error ?? `The server answered ${tail.status}.`, 'error')]
  }

  const lines = commandLines(tail.body.items, { running: run.status === 'running' })
  const head = wrap('p', element('span', 'last commands', 'label'), element('span', `${tail.body.total} items in the log`))

  if (lines.length === 0) {
    return [withClass(head, 'commands-head'), element('p', 'Nothing done yet.', 'muted')]
  }

  return [withClass(head, 'commands-head'), withClass(wrap('ul', ...lines.map(commandLine)), 'commands')]
}

function panelFooter(row, run, ctx) {
  const running = run.status === 'running'
  const target = ctx.linkWith({ pr: row.id, tab: 'runs', run: run.run, from: running ? 'end' : null })
  const footer = wrap('p', link(target, 'Open the transcript'))

  if (running) {
    footer.append(element('span', 'Follows the run every 3 s while open', 'muted'))
  }

  return withClass(footer, 'panel-footer')
}

function panelRow(row, run, ctx) {
  const panel = wrap('div', runFacts(run, ctx), ...commandsPart(run, ctx), panelFooter(row, run, ctx))
  const content = wrap('td', withClass(panel, 'run-panel'))

  content.colSpan = HEADINGS.length

  return withClass(wrap('tr', content), isWaiting(row) ? 'panel-row waiting' : 'panel-row')
}

function boardRows(row, ctx) {
  const run = panelRun(row, ctx.view.runs)
  const open = Boolean(run) && ctx.openRows.has(row.id)
  const rows = [boardRow(row, run, open, ctx)]

  if (open) {
    rows.push(panelRow(row, run, ctx))
  }

  return rows
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
      shown.flatMap((row) => boardRows(row, ctx)),
    ),
  )

  if (shown.length === 0) {
    section.append(element('p', selected ? `No PR is ${stateLabel(selected)}.` : 'No PRs.', 'muted'))
  }

  return section
}
