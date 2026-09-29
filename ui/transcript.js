import { badge, element, link, withClass, wrap } from './dom.js'
import { duration, money } from './format.js'
import { estimateNote, logSize, pageLabel, pageLinks, resultPreview } from './transcript-model.js'

const PAGE_LINKS = ['first', 'previous', 'next', 'latest']

function tokens(count) {
  return (count ?? 0).toLocaleString('en-US')
}

function roleOf(run) {
  return run.role === 'brief' && run.step ? `brief ${run.step}` : run.role
}

function line(...parts) {
  return withClass(wrap('p', ...parts), 'transcript-line')
}

function runLine(page, run) {
  const node = line(element('strong', page.run))

  if (run) {
    node.append(` · ${roleOf(run)} · effort ${run.effort ?? '-'} · `, element('span', run.status ?? '-', `status-${run.status}`))
  }

  return node
}

function logLine(page) {
  return line(`model ${page.model ?? '-'} · ${page.total} items · ${logSize(page.bytes)}`)
}

function finalLine(final) {
  const outcome = final.ok ? 'ok' : (final.subtype ?? 'failed')
  const denials = final.denials === 1 ? '1 denial' : `${final.denials} denials`
  const facts = [money(final.costUsd), duration(final.seconds), `${final.turns ?? '-'} turns`, denials]

  return line(element('strong', outcome), ` · ${facts.join(' · ')}`)
}

function usageLine(model, usage) {
  const cacheWrite = usage.cacheWrite5m + usage.cacheWrite1h
  const facts = [
    `input ${tokens(usage.input)}`,
    `cache read ${tokens(usage.cacheRead)}`,
    `cache write ${tokens(cacheWrite)}`,
    `output ~${tokens(usage.output)}`,
  ]

  return withClass(line(`${model}: ${facts.join(' · ')}`), 'transcript-line muted')
}

function unfinishedLines(page, status) {
  const nodes = [line(element('strong', status === 'running' ? 'no result yet' : 'ended without a result'))]

  for (const [model, usage] of Object.entries(page.usage ?? {})) {
    nodes.push(usageLine(model, usage))
  }

  const note = estimateNote(page.estimateUsd, status)

  if (note) {
    nodes.push(withClass(line(note), 'transcript-line estimate'))
  }

  return nodes
}

function transcriptHeader(page, run) {
  const header = element('div', undefined, 'transcript-header')
  const status = run?.status ?? null

  header.append(runLine(page, run), logLine(page))

  if (page.final) {
    header.append(finalLine(page.final))
  } else {
    header.append(...unfinishedLines(page, status))
  }

  return header
}

function navigation(page, ctx) {
  const links = pageLinks(page)
  const nav = element('nav', undefined, 'transcript-nav')

  for (const key of PAGE_LINKS) {
    if (links[key] !== null) {
      nav.append(link(ctx.linkWith({ from: links[key] }), key))
    }
  }

  nav.append(element('span', pageLabel(page), 'muted'))

  return nav
}

// Following re-renders the page every few seconds, so every details element
// keeps the state the reader gave it.
function remembered(details, ctx, key, openByDefault) {
  details.open = ctx.openTranscript.has(key) ? ctx.openTranscript.get(key) : openByDefault
  details.addEventListener('toggle', () => ctx.openTranscript.set(key, details.open))

  return details
}

function cutNote(item, run) {
  return element('p', `cut ${item.cut} characters, the full text is in logs/${run}.jsonl`, 'muted cut-note')
}

function textItem(item) {
  return element('p', item.text, 'text transcript-text')
}

function toolItem(item, run, ctx) {
  const node = element('div', undefined, 'transcript-tool')
  const call = withClass(wrap('p', element('strong', item.name)), 'tool-line')
  const target = item.name === 'Bash' && item.command !== null ? item.command : item.summary

  if (target) {
    call.append(' ', element('code', target))
  }

  const input = wrap('details', element('summary', 'input'), element('pre', item.inputText))

  node.append(call, remembered(input, ctx, `${run}|${item.index}|input`, false))

  return node
}

function resultSummary(item) {
  const preview = resultPreview(item.text)
  const summary = wrap('summary')

  if (item.refused) {
    summary.append(badge('guard refused', 'refused'), ' ')
  } else if (item.isError) {
    summary.append(badge('error', 'result-error'), ' ')
  }

  const lines = preview.lines === 1 ? '1 line' : `${preview.lines} lines`

  summary.append(`result of ${item.name ?? 'a tool'}: ${preview.line} (${lines})`)

  return summary
}

function resultItem(item, run, ctx) {
  const details = wrap('details', resultSummary(item), element('pre', item.text))
  let className = 'transcript-result'

  if (item.refused) {
    className = 'transcript-result refused'
  } else if (item.isError) {
    className = 'transcript-result is-error'
  }

  return remembered(withClass(details, className), ctx, `${run}|${item.index}`, item.refused)
}

function initItem(item) {
  return element('p', `session ${item.sessionId ?? '-'} started, model ${item.model ?? '-'}`, 'muted transcript-init')
}

function itemNode(item, run, ctx) {
  if (item.kind === 'text') {
    return textItem(item)
  }

  if (item.kind === 'tool') {
    return toolItem(item, run, ctx)
  }

  if (item.kind === 'tool-result') {
    return resultItem(item, run, ctx)
  }

  return initItem(item)
}

function itemNodes(page, ctx) {
  const nodes = []

  for (const item of page.items) {
    nodes.push(itemNode(item, page.run, ctx))

    if (item.cut > 0) {
      nodes.push(cutNote(item, page.run))
    }
  }

  return nodes
}

function finalReport(page) {
  const node = element('div', undefined, 'transcript-final')

  node.append(element('h4', 'final report'))

  if (page.final.report !== null) {
    node.append(element('pre', JSON.stringify(page.final.report, null, 2)))
  }

  node.append(element('p', page.final.text, 'text'))

  return node
}

function problem(transcript) {
  if (transcript.status === 404) {
    return element('p', 'No log for this run.', 'muted')
  }

  return element('p', transcript.body?.error ?? `The server answered ${transcript.status}.`, 'error')
}

export function renderTranscript(ctx) {
  const { transcript } = ctx
  const section = element('section', undefined, 'transcript')

  if (!transcript || transcript.status === null) {
    section.append(element('p', 'Loading…'))
    return section
  }

  if (transcript.status !== 200 || !transcript.body) {
    section.append(problem(transcript))
    return section
  }

  const page = transcript.body
  const run = (ctx.view?.runs ?? []).find((item) => item.run === page.run)

  section.append(transcriptHeader(page, run), navigation(page, ctx), ...itemNodes(page, ctx))

  if (page.final && page.from + page.items.length === page.total) {
    section.append(finalReport(page))
  }

  return section
}
