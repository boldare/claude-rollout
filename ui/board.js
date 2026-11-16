import { badge, cell, element, externalLink, link, rowClick, secondsSince, stageBadge, statusBadge, table, withClass, wrap } from './dom.js'
import { ago, duration, money, roleLabel, serverAnswered } from './format.js'
import { renderPanelControls } from './controls.js'
import { answerHint, answerPlaceholder, commandLines, delegateText, panelRun, resultTone, rowOpen, tookText } from './board-model.js'
import { answeredText, filterChips, needsYou, shownRows } from './model.js'

const HEADINGS = ['', 'PR', 'title', 'stage · status', 'GitHub', 'deps', 'attempts b/i/f/v', 'cost', 'last event', 'info']
// The way outs a maintainer takes with a note, which the panel's answer box sends.
const ANSWERED_WAYS = ['note', 'retry-or-note']

function chip(href, text, active) {
  return link(href, text, active ? 'chip active' : 'chip')
}

function chipsNav(rows, ctx) {
  const selected = ctx.route.filter ?? null
  const chips = element('nav', undefined, 'chips')

  for (const { filter, label, count } of filterChips(rows)) {
    chips.append(chip(ctx.linkWith({ filter }), `${label} ${count}`, selected === filter))
  }

  return chips
}

// The stage and the status read as the CLI prints them. A merged PR has no status.
function statusCell(row) {
  const { status } = row
  const node = wrap('td', stageBadge(status.stage))

  if (status.kind) {
    node.append(statusBadge(status))
  }

  if (status.marker) {
    node.append(badge('held', 'held'))
  }

  if (row.activeRun) {
    node.append(badge(row.activeRun, 'active-run'))
  }

  const answered = answeredText(row.answered)

  if (answered) {
    node.append(badge(answered, 'answered'))
  }

  return node
}

// In the CLI's order: the sentence, how long it has held, the way out.
function infoCell(row, ctx) {
  const { status } = row
  const node = wrap('td', element('span', status.sentence, 'sentence'))

  if (status.since) {
    node.append(' ', element('span', duration(secondsSince(status.since, ctx.now)), 'since'))
  }

  if (status.wayOut) {
    node.append(' ', element('code', status.wayOut.text, 'way-out'))
  }

  return withClass(node, 'info')
}

function depsCell(row, ctx) {
  const node = element('td', row.deps.length === 0 ? '-' : undefined, 'deps')

  for (const dep of row.deps) {
    node.append(wrap('span', link(ctx.linkWith({ pr: dep.id, tab: null }), dep.id), ' ', stageBadge(dep.stage)), ' ')
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

  if (!run && !needsYou(row)) {
    return node
  }

  const button = element('button', undefined, 'row-toggle')
  const what = needsYou(row) ? `what ${row.id} needs` : `the last run of ${row.id}`

  button.type = 'button'
  button.setAttribute('aria-expanded', String(open))
  button.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} ${what}`)
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
    statusCell(row),
    cell(row.pr ? externalLink(row.url, `#${row.pr}`) : '-', 'github'),
    depsCell(row, ctx),
    cell(attempts(row), 'number'),
    cell(money(row.costUsd), 'number'),
    cell(ago(secondsSince(row.lastEventAt, ctx.now)), 'age'),
    infoCell(row, ctx),
  )

  node.className = ['clickable', needsYou(row) ? 'needs-you' : '', open ? 'open' : ''].filter(Boolean).join(' ')

  return rowClick(node, ctx.linkWith({ pr: row.id, tab: null }), ctx.go)
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

  facts.append(runFact('role', roleLabel(run)), runFact('effort', run.effort ?? '-'))

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
    return [element('p', serverAnswered(tail.status, tail.body), 'error')]
  }

  const lines = commandLines(tail.body.items, { running: run.status === 'running' })
  const head = wrap('p', element('span', 'last commands', 'label'), element('span', `${tail.body.total} items in the log`))

  if (lines.length === 0) {
    return [withClass(head, 'commands-head'), element('p', 'Nothing done yet.', 'muted')]
  }

  return [withClass(head, 'commands-head'), withClass(wrap('ul', ...lines.map(commandLine)), 'commands')]
}

function transcriptLink(row, run, ctx) {
  const running = run.status === 'running'

  return link(ctx.linkWith({ pr: row.id, tab: 'runs', run: run.run, from: running ? 'end' : null }), 'Open the transcript')
}

// A held row releases here and a stuck one retries, as on the PR page.
function panelFooter(row, run, ctx) {
  const footer = wrap('div', transcriptLink(row, run, ctx))

  if (run.status === 'running') {
    footer.append(element('span', 'Follows the run every 3 s while open', 'muted'))
  }

  const controls = renderPanelControls(row, ctx)

  if (controls) {
    footer.append(controls)
  }

  return withClass(footer, 'panel-footer')
}

function runPanel(row, run, ctx) {
  return wrap('div', runFacts(run, ctx), ...commandsPart(run, ctx), panelFooter(row, run, ctx))
}

function waitingFacts(row, ctx) {
  const { waiting, status } = row
  const facts = wrap('div', statusBadge(status))
  const asker = waiting.byDriver ? 'the driver' : waiting.run

  if (asker) {
    facts.append(runFact('asked by', asker))
  }

  if (waiting.delegate) {
    facts.append(runFact('delegate', delegateText(waiting.delegate, status.question?.kind ?? status.code)))
  }

  if (waiting.since) {
    facts.append(runFact('waiting', duration(secondsSince(waiting.since, ctx.now))))
  }

  return withClass(facts, 'facts')
}

function panelSection(label, text, className = 'text') {
  return withClass(wrap('div', element('p', label, 'label'), element('p', text, className)), 'panel-section')
}

// The status, then what the maintainer is asked, in the agent's own words.
// "fix attempts exhausted (3)" is in the sentence already, a dispute's text is not.
function waitingSections(row) {
  const { waiting, status } = row
  const sections = [panelSection('status', status.sentence)]

  if (status.question) {
    sections.push(panelSection('question', status.question.text || '-', 'text question'))
  }

  if (status.question?.evidence) {
    sections.push(panelSection('evidence', status.question.evidence, 'text quiet'))
  }

  if (waiting.lastError && !status.sentence.includes(waiting.lastError)) {
    sections.push(panelSection('last error', waiting.lastError, 'text quiet'))
  }

  return sections
}

function readOnlyAnswer(row) {
  const line = wrap('p', 'Read-only: answer in a terminal with ', element('code', `rollout note ${row.id} "…"`), '.')

  return withClass(line, 'muted')
}

// The draft lives in ctx.drafts and the box keeps its focus and caret, because every update rebuilds the page.
function answerBox(row, ctx) {
  const id = `answer-${row.id}`
  const label = element('label', 'your answer', 'label')
  const box = element('textarea')
  const send = element('button', 'Send', 'primary')
  const ready = () => box.value.trim() !== '' && !ctx.sending

  label.htmlFor = id
  box.id = id
  box.rows = 3
  box.placeholder = answerPlaceholder(row)
  box.value = ctx.drafts.get(row.id) ?? ''
  box.dataset.keep = id
  send.type = 'button'
  send.disabled = !ready()

  function submit() {
    if (ready()) {
      ctx.sendAnswer(row.id, box.value)
    }
  }

  box.addEventListener('input', () => {
    ctx.drafts.set(row.id, box.value)
    send.disabled = !ready()
  })

  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  })

  send.addEventListener('click', submit)

  const hint = ctx.sent.has(row.id) ? 'Sent. It shows here until the driver applies it.' : answerHint(row, ctx.view.driver?.running)

  return [withClass(wrap('div', label, box), 'answer'), wrap('div', send, element('span', hint, 'muted'))]
}

// A way out on GitHub links to the PR there. Any other is a command to run.
function wayOutLine(row) {
  const { wayOut } = row.status
  const text = wayOut.kind === 'github' ? externalLink(row.url, wayOut.text) : element('code', wayOut.text)

  return withClass(wrap('p', element('span', 'way out', 'label'), ' ', text), 'way-out-line')
}

// A note answers only the statuses whose way out is one. The others show their way out.
function answerPart(row, ctx) {
  if (!ANSWERED_WAYS.includes(row.status.wayOut?.kind)) {
    return [wayOutLine(row), element('div')]
  }

  return ctx.readOnly ? [readOnlyAnswer(row), element('div')] : answerBox(row, ctx)
}

function waitingActions(row, run, ctx) {
  const [answer, actions] = answerPart(row, ctx)
  const end = element('span', undefined, 'end')
  const controls = renderPanelControls(row, ctx)

  if (controls) {
    end.append(controls)
  }

  if (run) {
    end.append(transcriptLink(row, run, ctx))
  }

  actions.append(end)

  return [answer, withClass(actions, 'panel-footer actions')]
}

function needsYouPanel(row, run, ctx) {
  const asked = (ctx.view.runs ?? []).find((item) => item.run === row.waiting.run) ?? run

  return wrap('div', waitingFacts(row, ctx), ...waitingSections(row), ...waitingActions(row, asked, ctx))
}

function panelRow(row, run, ctx) {
  const asks = needsYou(row) && row.waiting
  const panel = asks ? needsYouPanel(row, run, ctx) : runPanel(row, run, ctx)
  const content = wrap('td', withClass(panel, asks ? 'run-panel needs-you' : 'run-panel'))

  content.colSpan = HEADINGS.length

  return withClass(wrap('tr', content), needsYou(row) ? 'panel-row needs-you' : 'panel-row')
}

function boardRows(row, ctx) {
  const run = panelRun(row, ctx.view.runs)
  const open = rowOpen(row, run, ctx.rowChoices)
  const rows = [boardRow(row, run, open, ctx)]

  if (open) {
    rows.push(panelRow(row, run, ctx))
  }

  return rows
}

function emptyText(filter) {
  if (!filter) {
    return 'No PRs.'
  }

  return filter === 'needs-you' ? 'No PR needs you.' : `No PR is on ${filter}.`
}

export function renderBoard(ctx) {
  const { rows } = ctx.view
  const selected = ctx.route.filter ?? null
  const shown = shownRows(rows, selected)
  const section = element('section', undefined, 'board')

  section.append(
    chipsNav(rows, ctx),
    table(
      HEADINGS,
      shown.flatMap((row) => boardRows(row, ctx)),
    ),
  )

  if (shown.length === 0) {
    section.append(element('p', emptyText(selected), 'muted'))
  }

  return section
}
