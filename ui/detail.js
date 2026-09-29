import { badge, cell, element, externalLink, link, list, secondsSince, stateBadge, table, withClass, wrap } from './dom.js'
import { clock, duration, money } from './format.js'

const TABS = ['overview', 'runs', 'verifier', 'review', 'brief']
const RUN_HEADINGS = ['run', 'role', 'effort', 'start', 'duration', 'cost', 'result', 'denials', 'error']
const CHECK_HEADINGS = ['item', 'status', 'evidence']

function short(sha) {
  return typeof sha === 'string' && sha ? sha.slice(0, 7) : '-'
}

function field(label, ...content) {
  return [element('dt', label), wrap('dd', ...content)]
}

function fields(...pairs) {
  return wrap('dl', ...pairs.flat(2))
}

function namedList(items, className) {
  if (items.length === 0) {
    return element('span', 'none', 'muted')
  }

  return list(items, className)
}

function stamp(mark) {
  if (!mark) {
    return element('span', 'no', 'muted')
  }

  return element('span', `${short(mark.sha)} at ${clock(mark.at)}`)
}

function prLink(pr, text) {
  return pr.pr ? externalLink(pr.url, text ?? `#${pr.pr}`) : element('span', 'no PR yet', 'muted')
}

function detailHeader(pr, ctx) {
  const header = element('div', undefined, 'detail-header')
  const title = wrap('h2', `${pr.id} `, element('span', pr.title, 'muted'))
  const facts = wrap('div', stateBadge(pr.state))

  if (pr.held) {
    facts.append(badge('held', 'held'))
  }

  facts.append(prLink(pr), element('span', `branch ${pr.branch}`), element('span', `head ${pr.head}`))

  if (pr.activeRun) {
    facts.append(badge(pr.activeRun, 'active-run'))
  }

  header.append(link(ctx.linkWith({ pr: null, tab: null }), `← back to ${ctx.route.view}`), title, withClass(facts, 'facts'))

  return header
}

function tabs(ctx) {
  const nav = element('nav', undefined, 'tabs')

  for (const tab of TABS) {
    nav.append(link(ctx.linkWith({ tab }), tab, ctx.route.tab === tab ? 'tab active' : 'tab'))
  }

  return nav
}

function gateFields(gate) {
  if (!gate) {
    return field('gate', element('span', 'no decision yet', 'muted'))
  }

  return [
    field('gate', element('strong', gate.action), element('span', ` at ${clock(gate.at)}`, 'muted')),
    field('reasons', namedList(gate.reasons ?? [])),
    field('GitHub merge state', `${gate.mergeState ?? '-'}, as the driver saw it at ${clock(gate.at)}`),
    field('gate sha', short(gate.sha)),
  ]
}

function blockedFields(blocked) {
  if (!blocked) {
    return []
  }

  return [
    field('blocked', element('strong', blocked.kind ?? '-')),
    field('question', element('span', blocked.question ?? '', 'text')),
    field('evidence', element('span', blocked.evidence ?? '', 'text')),
  ]
}

function approvalField(pr) {
  if (pr.approval === 'github') {
    return field('approval', 'a GitHub review on ', prLink(pr))
  }

  return field('approval', 'in the inbox: ', element('code', `rollout approve ${pr.id}`))
}

function depsField(pr, ctx) {
  const deps = pr.deps.map((dep) => wrap('span', link(ctx.linkWith({ pr: dep.id, tab: null }), dep.id), ' ', stateBadge(dep.state)))

  return field('deps', namedList(deps, 'inline'))
}

function renderOverview(pr, ctx) {
  const heldField = pr.held ? [field('held', `since ${clock(pr.held.at)}`)] : []

  return fields(
    field('info', element('span', pr.info || '-', 'text')),
    gateFields(pr.gate),
    blockedFields(pr.blocked),
    heldField,
    approvalField(pr),
    field('verified', stamp(pr.verified)),
    field('approved', stamp(pr.approved)),
    depsField(pr, ctx),
    field('out of scope', namedList(pr.outOfScope ?? [])),
    field('workflow files', namedList(pr.workflowFiles ?? [], 'warning')),
  )
}

function runSeconds(run, now) {
  if (run.seconds !== null && run.seconds !== undefined) {
    return run.seconds
  }

  if (run.status === 'running') {
    return secondsSince(run.startedAt, now)
  }

  return null
}

function runRow(run, now) {
  const role = run.role === 'brief' && run.step ? `brief ${run.step}` : run.role
  const live = run.status === 'running' ? 'live' : ''

  return wrap(
    'tr',
    cell(run.run ?? '-'),
    cell(role),
    cell(run.effort ?? '-'),
    cell(clock(run.startedAt, now)),
    cell(duration(runSeconds(run, now)), `number ${live}`),
    cell(money(run.costUsd), 'number'),
    cell(run.result ?? run.status ?? '-', `status-${run.status}`),
    cell(String(run.denials ?? '-'), 'number'),
    cell(run.error ?? '', 'text'),
  )
}

function renderRuns(pr, ctx) {
  if (pr.runs.length === 0) {
    return element('p', 'No runs yet.', 'muted')
  }

  return table(
    RUN_HEADINGS,
    pr.runs.map((run) => runRow(run, ctx.now)),
    'runs',
  )
}

function checklist(items) {
  const rows = items.map((check) =>
    wrap('tr', cell(check.item, 'text'), cell(check.status, `check-${check.status}`), cell(check.evidence ?? '', 'text')),
  )

  return table(CHECK_HEADINGS, rows, 'checklist')
}

function verdictBody(verdict) {
  const body = element('div', undefined, 'verdict')
  const line = wrap(
    'p',
    badge(verdict.verdict, `verdict-${String(verdict.verdict).toLowerCase()}`),
    ` ${short(verdict.sha)} at ${clock(verdict.at)}, run ${verdict.run ?? '-'}`,
  )

  body.append(line, element('p', verdict.summary ?? '', 'text'))
  body.append(checklist(verdict.checklist ?? []))
  body.append(element('h4', 'blocking'), namedList(verdict.blocking ?? []))
  body.append(element('h4', 'non-blocking'), namedList(verdict.nonBlocking ?? []))

  return body
}

function verdictKey(pr, verdict) {
  return [pr.id, verdict.at, verdict.sha, verdict.run].join('|')
}

function historyEntry(pr, verdict, ctx) {
  const key = verdictKey(pr, verdict)
  const details = element('details')
  const summary = `${verdict.verdict} ${short(verdict.sha)} at ${clock(verdict.at)}: ${verdict.summary ?? ''}`

  details.open = ctx.openVerdicts.has(key)
  details.append(element('summary', summary), verdictBody(verdict))
  details.addEventListener('toggle', () => {
    if (details.open) {
      ctx.openVerdicts.add(key)
    } else {
      ctx.openVerdicts.delete(key)
    }
  })

  return details
}

function renderVerifier(pr, ctx) {
  if (!pr.verdict) {
    return element('p', 'No verdict yet.', 'muted')
  }

  const section = wrap('div', element('h3', 'latest verdict'), verdictBody(pr.verdict))
  const history = [...(pr.verdicts ?? [])].reverse()

  section.append(element('h3', 'history'), ...history.map((verdict) => historyEntry(pr, verdict, ctx)))

  return section
}

function feedbackEntry(entry) {
  const action = entry.action ?? 'not reported by the implementer'
  const node = element('article', undefined, 'feedback')

  node.append(
    element('pre', entry.body ?? ''),
    fields(field('implementer', element('span', action, 'text')), field('sha', short(entry.sha)), field('at', clock(entry.at))),
  )

  return node
}

function renderReview(pr) {
  const section = wrap('div', wrap('p', prLink(pr, 'Open the PR on GitHub')))
  const feedback = [...(pr.feedback ?? [])].reverse()

  if (feedback.length === 0) {
    section.append(element('p', 'No review comments handled yet.', 'muted'))
    return section
  }

  section.append(...feedback.map(feedbackEntry))

  return section
}

function textBlock(text, empty) {
  return text === null || text === undefined ? element('p', empty, 'muted') : element('pre', text, 'document')
}

function renderBrief(pr) {
  return wrap(
    'div',
    element('h3', 'Brief'),
    textBlock(pr.briefText, 'No brief file yet.'),
    element('h3', 'Reviewer notes'),
    textBlock(pr.notesText, 'No reviewer notes.'),
  )
}

const TAB_RENDERERS = { overview: renderOverview, runs: renderRuns, verifier: renderVerifier, review: renderReview, brief: renderBrief }

function problem(text, ctx) {
  return wrap('section', element('p', text, 'error'), link(ctx.linkWith({ pr: null, tab: null }), `back to ${ctx.route.view}`))
}

export function renderDetail(ctx) {
  const { detail } = ctx

  if (!detail || detail.status === null) {
    return element('p', 'Loading…')
  }

  if (detail.status === 404) {
    return problem('unknown PR', ctx)
  }

  if (detail.status !== 200 || !detail.body) {
    return problem(detail.body?.error ?? `The server answered ${detail.status}.`, ctx)
  }

  const pr = detail.body
  const section = element('section', undefined, 'detail')

  section.append(detailHeader(pr, ctx), tabs(ctx), TAB_RENDERERS[ctx.route.tab](pr, ctx))

  return section
}
