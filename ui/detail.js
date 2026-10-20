import { renderPrControls } from './controls.js'
import { badge, cell, element, externalLink, link, list, secondsSince, stateBadge, table, withClass, wrap } from './dom.js'
import { clock, duration, money, sentence } from './format.js'
import { markdownDocument } from './markdown.js'
import { renderTranscript } from './transcript.js'
import { estimateNote } from './transcript-model.js'

const TABS = ['overview', 'runs', 'verifier', 'review', 'plan', 'brief']
const RUN_HEADINGS = ['run', 'role', 'effort', 'model', 'start', 'duration', 'cost', 'result', 'denials', 'error']
const CHECK_HEADINGS = ['item', 'status', 'evidence']
const RECHECK_HEADINGS = ['finding', 'answer', 'status', 'evidence']
const RECHECK_CLASSES = { resolved: 'check-pass', open: 'check-fail', wrong: 'check-unverifiable' }
const PRE_VERIFY_HEADINGS = ['command', 'stage', 'level', 'result', 'evidence']
const CRITERIA_HEADINGS = ['criterion', 'level', 'result', 'evidence']

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
    return element('span', 'None', 'muted')
  }

  return list(items, className)
}

function stamp(mark) {
  if (!mark) {
    return element('span', 'No', 'muted')
  }

  return element('span', `${short(mark.sha)} at ${clock(mark.at)}`)
}

function prLink(pr, text) {
  return pr.pr ? externalLink(pr.url, text ?? `#${pr.pr}`) : element('span', 'No PR yet', 'muted')
}

function detailHeader(pr, ctx) {
  const header = element('div', undefined, 'detail-header')
  const title = wrap('h2', `${pr.id} `, element('span', pr.title, 'muted'))
  const facts = wrap('div', stateBadge(pr.state))

  if (pr.held) {
    facts.append(badge('held', 'held'))
  }

  facts.append(prLink(pr), element('span', `Branch ${pr.branch}`), element('span', `Head ${pr.head}`))

  if (pr.activeRun) {
    facts.append(badge(pr.activeRun, 'active-run'))
  }

  header.append(link(ctx.linkWith({ pr: null, tab: null }), `← Back to ${ctx.route.view}`), title, withClass(facts, 'facts'))

  const controls = renderPrControls(pr, ctx)

  if (controls) {
    header.append(controls)
  }

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
    return field('gate', element('span', 'No decision yet', 'muted'))
  }

  return [
    field('gate', element('strong', gate.action), element('span', ` at ${clock(gate.at)}`, 'muted')),
    field('reasons', namedList(gate.reasons ?? [])),
    field('GitHub merge state', `${gate.mergeState ?? '-'}, as the driver saw it at ${clock(gate.at)}`),
    field('gate SHA', short(gate.sha)),
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

function delegateRuns(delegate) {
  if (delegate.maxPerPr === null) {
    return `off, ${delegate.runs} runs`
  }

  return `${delegate.runs} of ${delegate.maxPerPr} runs`
}

function delegateAnswer(entry) {
  const text = ['answer', 'dropped'].includes(entry.decision) ? entry.answer : entry.reasoning
  const refs = entry.planRefs?.length > 0 ? [list(entry.planRefs.map((ref) => `plan: ${ref}`))] : []

  return field(
    entry.run ?? 'delegate',
    wrap('div', badge(entry.decision, 'role-delegate'), element('span', ` ${entry.kind} at ${clock(entry.at)}`, 'muted')),
    element('div', entry.question ?? '', 'text'),
    element('div', text ?? '', 'text'),
    ...refs,
  )
}

function delegateFields(pr) {
  const delegate = pr.delegate

  if (!delegate || (delegate.maxPerPr === null && delegate.answers.length === 0)) {
    return []
  }

  return [field('delegate', delegateRuns(delegate)), ...delegate.answers.map(delegateAnswer)]
}

function approvalField(pr) {
  if (pr.approval === 'github') {
    return field('approval', 'a GitHub review on ', prLink(pr))
  }

  if (pr.approval === 'inbox') {
    return field('approval', 'In the inbox: ', element('code', `rollout approve ${pr.id}`))
  }

  return field('approval', element('span', `Not needed under policy.merge ${pr.merge}`, 'muted'))
}

function depsField(pr, ctx) {
  const deps = pr.deps.map((dep) => wrap('span', link(ctx.linkWith({ pr: dep.id, tab: null }), dep.id), ' ', stateBadge(dep.state)))

  return field('deps', namedList(deps, 'inline'))
}

// The board's info line repeats the gate, the question and the stamps below, so the page shows only the part of it
// that has no field of its own.
function stateFields(pr) {
  if (pr.state === 'merged' && pr.mergeSha) {
    return [field('merged as', short(pr.mergeSha))]
  }

  if (['needs_fix', 'fixing'].includes(pr.state) && pr.fixReason) {
    return [field('fix reason', element('span', pr.fixReason, 'text'))]
  }

  if (['escalated', 'interrupted'].includes(pr.state) && pr.lastError) {
    return [field('last error', element('span', pr.lastError, 'text'))]
  }

  return []
}

function renderOverview(pr, ctx) {
  const heldField = pr.held ? [field('held', `since ${clock(pr.held.at)}`)] : []

  return fields(
    stateFields(pr),
    gateFields(pr.gate),
    blockedFields(pr.blocked),
    delegateFields(pr),
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

function runName(run, ctx) {
  if (!run.run) {
    return '-'
  }

  return link(ctx.linkWith({ run: run.run, from: run.status === 'running' ? 'end' : null }), run.run)
}

function costCell(run) {
  if (typeof run.estimateUsd !== 'number') {
    return cell(money(run.costUsd), 'number')
  }

  const node = cell(`≈${money(run.estimateUsd)} est.`, 'number estimate')
  node.title = estimateNote(run.estimateUsd, run.status)

  return node
}

function runRow(run, ctx) {
  const { now } = ctx
  const role = run.role === 'brief' && run.step ? `brief ${run.step}` : run.role
  const live = run.status === 'running' ? 'live' : ''

  const row = wrap(
    'tr',
    cell(runName(run, ctx)),
    cell(role),
    cell(run.effort ?? '-'),
    cell(run.model ?? '-'),
    cell(clock(run.startedAt, now)),
    cell(duration(runSeconds(run, now)), `number ${live}`),
    costCell(run),
    cell(run.result ?? run.status ?? '-', `status-${run.status}`),
    cell(String(run.denials ?? '-'), 'number'),
    cell(run.error ?? '', 'text'),
  )

  if (run.run && run.run === ctx.route.run) {
    row.className = 'selected'
  }

  return row
}

function runsTable(pr, ctx) {
  if (pr.runs.length === 0) {
    return element('p', 'No runs yet.', 'muted')
  }

  return table(
    RUN_HEADINGS,
    pr.runs.map((run) => runRow(run, ctx)),
    'runs',
  )
}

function renderRuns(pr, ctx) {
  if (!ctx.route.run) {
    return runsTable(pr, ctx)
  }

  return wrap('div', runsTable(pr, ctx), renderTranscript(ctx))
}

function checklist(items) {
  const rows = items.map((check) =>
    wrap('tr', cell(check.item, 'text'), cell(check.status, `check-${check.status}`), cell(check.evidence ?? '', 'text')),
  )

  return table(CHECK_HEADINGS, rows, 'checklist')
}

function recheckRow(item) {
  const answer = item.answer ? `${item.answer.outcome}: ${item.answer.action}` : 'no answer'
  const statusClass = Object.hasOwn(RECHECK_CLASSES, item.status) ? RECHECK_CLASSES[item.status] : ''

  return wrap(
    'tr',
    cell(`${item.id}: ${item.finding ?? '(unknown id)'}`, 'text'),
    cell(answer, 'text'),
    cell(item.status, statusClass),
    cell(item.evidence ?? '', 'text'),
  )
}

function criterionRow(record) {
  return wrap(
    'tr',
    cell(`${record.id}: ${record.text}`, 'text'),
    cell(record.level),
    cell(record.result, resultClass(record)),
    cell(record.evidence ?? '', 'text'),
  )
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

  if (verdict.criteria?.length > 0) {
    body.append(element('h4', 'project criteria'), table(CRITERIA_HEADINGS, verdict.criteria.map(criterionRow), 'checklist'))
  }

  if (verdict.recheck?.length > 0) {
    body.append(element('h4', 're-checked findings'), table(RECHECK_HEADINGS, verdict.recheck.map(recheckRow), 'checklist'))
  }

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

// A recommended command or criterion that does not pass blocks nothing, so it reads as a warning, not as a failure.
function resultClass(record) {
  if (record.result === 'pass') {
    return 'check-pass'
  }

  return record.level === 'recommended' ? 'warning' : `check-${record.result}`
}

// A record from before ready commands has no stage and is a pre-verify one.
function preVerifyRow(record) {
  const evidence = [record.summary, record.tail?.trim()].filter(Boolean).join('\n')

  return wrap(
    'tr',
    cell(record.command, 'text'),
    cell(record.stage ?? 'preVerify'),
    cell(record.level),
    cell(record.result, resultClass(record)),
    cell(evidence, 'text'),
  )
}

function preVerifyTable(preVerify) {
  if (!preVerify) {
    return []
  }

  return [element('h3', 'commands the driver ran'), table(PRE_VERIFY_HEADINGS, preVerify.results.map(preVerifyRow), 'checklist')]
}

function renderVerifier(pr, ctx) {
  if (!pr.verdict) {
    return wrap('div', element('p', 'No verdict yet.', 'muted'), ...preVerifyTable(pr.preVerify))
  }

  const section = wrap('div', element('h3', 'latest verdict'), verdictBody(pr.verdict), ...preVerifyTable(pr.preVerify))
  const history = [...(pr.verdicts ?? [])].reverse()

  section.append(element('h3', 'history'), ...history.map((verdict) => historyEntry(pr, verdict, ctx)))

  return section
}

function feedbackEntry(entry) {
  const action = entry.action ?? 'not reported by the implementer'
  const node = element('article', undefined, 'feedback')

  node.append(
    element('pre', entry.body ?? ''),
    fields(field('implementer', element('span', action, 'text')), field('SHA', short(entry.sha)), field('at', clock(entry.at))),
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

// Under the tab's h3, so the document's own headings start at h4.
function textBlock(text, empty, key, ctx) {
  return text === null || text === undefined ? element('p', empty, 'muted') : markdownDocument(text, { key, level: 4, ctx })
}

function renderBrief(pr, ctx) {
  return wrap(
    'div',
    element('h3', 'Brief'),
    textBlock(pr.briefText, 'No brief file yet.', `brief|${pr.id}`, ctx),
    element('h3', 'Reviewer notes'),
    textBlock(pr.notesText, 'No reviewer notes.', `notes|${pr.id}`, ctx),
  )
}

function wholePlan(ctx) {
  return wrap('p', link(ctx.linkWith({ view: 'plan', pr: null, tab: null }), 'The whole plan'))
}

// Says where the UI looked and what it looks for, with the PR's own id, so the plan can be fixed.
function noSectionHint(pr) {
  if (pr.planSources.length === 0) {
    return 'This PR gets no briefing source, so there is no plan to look in.'
  }

  return [
    `No source this PR gets has a section for it (${pr.planSources.join(', ')}).`,
    `A section starts with the PR id in a heading, like "### ${pr.id} …", or in bold at the start of a paragraph or a list item, like "**${pr.id} …**".`,
    "A source whose tag no other PR lists is the PR's in full.",
  ].join(' ')
}

function sliceParts(slice, pr, ctx) {
  return [
    element('h3', slice.heading, 'plan-heading'),
    element('p', `From ${slice.source}`, 'muted'),
    textBlock(slice.text || null, 'The section is empty.', `slice|${pr.id}|${slice.source}`, ctx),
  ]
}

function renderPlanTab(pr, ctx) {
  if (pr.plan.length === 0) {
    return wrap('div', element('p', noSectionHint(pr), 'muted'), wholePlan(ctx))
  }

  return wrap('div', ...pr.plan.flatMap((slice) => sliceParts(slice, pr, ctx)), wholePlan(ctx))
}

const TAB_RENDERERS = {
  overview: renderOverview,
  runs: renderRuns,
  verifier: renderVerifier,
  review: renderReview,
  plan: renderPlanTab,
  brief: renderBrief,
}

function problem(text, ctx) {
  return wrap('section', element('p', text, 'error'), link(ctx.linkWith({ pr: null, tab: null }), `Back to ${ctx.route.view}`))
}

export function renderDetail(ctx) {
  const { detail } = ctx

  if (!detail || detail.status === null) {
    return element('p', 'Loading…')
  }

  if (detail.status === 404) {
    return problem('Unknown PR', ctx)
  }

  if (detail.status !== 200 || !detail.body) {
    return problem(detail.body?.error ? sentence(detail.body.error) : `The server answered ${detail.status}.`, ctx)
  }

  const pr = detail.body
  const section = element('section', undefined, 'detail')

  section.append(detailHeader(pr, ctx), tabs(ctx), TAB_RENDERERS[ctx.route.tab](pr, ctx))

  return section
}
