import { isBriefedWith, sourceText } from './briefing.mjs'

// The plan the agents work from, for the UI: every briefing source, and each
// PR's slices of it, one per source at most. A PR's section in a source starts
// where its id opens a heading ("### P3 feat: …", "## PR P3: …") or the bold
// lead of a paragraph or a list item ("**P3 `feat/events`** …",
// "- **P3 (api).** …"). Headings inside code fences do not count.
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/
const ITEM = /^(\s*)((?:[-*+]|\d+[.)])\s+)?/
const BOLD = /^(\*\*|__)(.+?)\1(.*)$/
const LIST_MARKER = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?/
const EXCERPT_LIMIT = 160

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The text a reader sees, without links, code spans and emphasis.
function plainText(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/(^|[^\w*])([*_])(\S(?:.*?\S)?)\2(?![\w*])/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim()
}

// A backtick fence cannot carry a backtick in its info string, so ```a``` is inline code.
function opensFence(marker) {
  return marker !== null && !(marker[1][0] === '`' && marker[2].includes('`'))
}

// A fence closes only on the same character, at least as many times, with nothing after it.
function closesFence(marker, fence) {
  return marker !== null && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === ''
}

function isBlank(entry) {
  return entry.kind === 'text' && entry.line.trim() === ''
}

// A line opens a block when it is a list item or follows a blank line, a heading or code.
// Only then can bold at its start be a lead. Bold in the middle of a paragraph is emphasis.
function textEntry(line, previous) {
  const [prefix, indent, marker] = ITEM.exec(line)
  const opens = Boolean(marker) || !previous || previous.kind !== 'text' || isBlank(previous)
  const match = opens ? BOLD.exec(line.slice(prefix.length)) : null
  const bold = match && { text: plainText(match[2]), rest: match[3] }

  return { line, kind: 'text', indent: indent.length, item: Boolean(marker), opens, bold }
}

// One entry per line: a heading, a line of a code fence, or text.
function outlineOf(text) {
  const outline = []
  let fence = null

  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)

    if (fence) {
      fence = closesFence(marker, fence) ? null : fence
      outline.push({ line, kind: 'code' })
      continue
    }

    if (opensFence(marker)) {
      fence = marker[1]
      outline.push({ line, kind: 'code', fence: true, indent: line.search(/\S/), opens: true })
      continue
    }

    const heading = HEADING.exec(line)

    if (heading) {
      outline.push({ line, kind: 'heading', level: heading[1].length, text: plainText(heading[2] ?? '') })
      continue
    }

    outline.push(textEntry(line, outline.at(-1)))
  }

  return outline
}

// P1 must not match P10, P1-extra or P1.1, but "P1. feat" is P1.
// YAML reads `id: 3` as a number.
function namesPr(heading, id) {
  return new RegExp(`^(?:PR\\s+)?${escapeRegExp(String(id))}(?![\\w-]|\\.\\w)`, 'i').test(heading)
}

// The first line of prose. Headings, code and lines with no letter or digit (a rule, a table border) are skipped.
function excerptOf(entries) {
  const entry = entries.find(({ line, kind }) => kind === 'text' && /[\p{L}\p{N}]/u.test(line))

  if (!entry) {
    return null
  }

  const plain = plainText(entry.line.replace(LIST_MARKER, ''))

  return plain.length > EXCERPT_LIMIT ? `${plain.slice(0, EXCERPT_LIMIT - 1)}…` : plain
}

function sectionOf(heading, body) {
  const text = body
    .map((entry) => entry.line)
    .join('\n')
    .trim()

  return { heading, text, excerpt: excerptOf(body) }
}

function upTo(entries, end) {
  return end === -1 ? entries : entries.slice(0, end)
}

// A heading section runs to the next heading of the same or a higher level.
function headingSection(outline, id) {
  const start = outline.findIndex((entry) => entry.kind === 'heading' && namesPr(entry.text, id))

  if (start === -1) {
    return null
  }

  const { level, text: heading } = outline[start]
  const rest = outline.slice(start + 1)

  const end = rest.findIndex((entry) => entry.kind === 'heading' && entry.level <= level)

  return sectionOf(heading, upTo(rest, end))
}

// A list item runs to the next item at its level, or to a block that leaves the list.
function endsItem(item, entry) {
  if (entry.kind === 'heading') {
    return true
  }

  if ((entry.kind === 'code' && !entry.fence) || isBlank(entry)) {
    return false
  }

  return entry.indent <= item.indent && (entry.item || entry.opens)
}

// A bold paragraph runs to the next bold paragraph at its level or the next heading.
function endsParagraph(paragraph, entry) {
  return entry.kind === 'heading' || (Boolean(entry.bold) && !entry.item && entry.indent <= paragraph.indent)
}

function leadSection(outline, id) {
  const start = outline.findIndex((entry) => entry.bold && namesPr(entry.bold.text, id))

  if (start === -1) {
    return null
  }

  const lead = outline[start]
  const ends = lead.item ? endsItem : endsParagraph
  const rest = outline.slice(start + 1)
  const end = rest.findIndex((entry) => ends(lead, entry))
  // What follows the bold on its line, such as ": `index.html`", opens the body.
  // A remark in parentheses, like the deps in "**S2 …** (S1)", is no prose for the excerpt.
  const remainder = lead.bold.rest.replace(/^[\s:.,;\-–—·]+/, '')
  const sameLine = { line: remainder, kind: /^\(.*\)$/.test(remainder.trim()) ? 'remark' : 'text' }

  return sectionOf(lead.bold.text.replace(/[.:]+$/, ''), [sameLine, ...upTo(rest, end)])
}

// Headings win over bold leads, so a summary list that names every PR near the top never hides their own headings.
function sectionIn(outline, id) {
  return headingSection(outline, id) ?? leadSection(outline, id)
}

export function planSection(text, id) {
  return sectionIn(outlineOf(text), id)
}

// A source of the PR's own has no section to look for: all of it is the PR's.
// Its first heading names it when the text starts with one.
function wholeSource(outline, title) {
  const start = outline.findIndex((entry) => !isBlank(entry))

  if (start !== -1 && outline[start].kind === 'heading') {
    return sectionOf(outline[start].text, outline.slice(start + 1))
  }

  return sectionOf(title, outline)
}

function readSource(source) {
  try {
    return { text: sourceText(source), error: null }
  } catch (error) {
    return { text: null, error: error.message }
  }
}

function sourcesOf(manifest) {
  return manifest.briefing?.sources ?? []
}

function titleOf(source) {
  return source.title ?? source.path
}

export function planSources(manifest) {
  return sourcesOf(manifest).map((source) => ({
    title: titleOf(source),
    path: source.path,
    kind: source.kind,
    tag: source.tag ?? null,
    ...readSource(source),
  }))
}

// The titles of the sources a PR's brief writer gets, where its slices come from.
export function prSourceTitles(manifest, pr) {
  return sourcesOf(manifest)
    .filter((source) => isBriefedWith(pr, source))
    .map(titleOf)
}

function outlined(sources) {
  return sources.map((source) => {
    const { text } = readSource(source)

    return { source, outline: text === null ? null : outlineOf(text) }
  })
}

// Who lists each tag. A tag only one PR lists marks sources of that PR's own, such as an addendum for it.
function tagOwners(manifest) {
  const owners = new Map()

  for (const pr of manifest.all ?? []) {
    for (const tag of pr.briefTags ?? []) {
      owners.set(tag, [...(owners.get(tag) ?? []), pr.id])
    }
  }

  return owners
}

function isOwnSource(source, pr, owners) {
  const ids = source.tag ? (owners.get(source.tag) ?? []) : []

  return ids.length === 1 && ids[0] === pr.id
}

function sliceOf({ source, outline }, pr, owners) {
  if (!outline || !isBriefedWith(pr, source)) {
    return null
  }

  const section = sectionIn(outline, pr.id) ?? (isOwnSource(source, pr, owners) ? wholeSource(outline, titleOf(source)) : null)

  return section && { source: titleOf(source), ...section }
}

// One slice per source the PR's brief writer gets, in manifest order.
function slicesIn(outlines, pr, owners) {
  return outlines.map((entry) => sliceOf(entry, pr, owners)).filter(Boolean)
}

export function prPlan(manifest, pr) {
  return slicesIn(outlined(sourcesOf(manifest).filter((source) => isBriefedWith(pr, source))), pr, tagOwners(manifest))
}

// Every PR's slices by id. Each source is outlined once, however many PRs look in it.
export function prPlans(manifest) {
  const outlines = outlined(sourcesOf(manifest))
  const owners = tagOwners(manifest)

  return new Map(manifest.all.map((pr) => [pr.id, slicesIn(outlines, pr, owners)]))
}

// For preflight, among the PRs this run takes (`--only`). Without briefing
// sources every brief is written by hand and there is no plan to look in.
export function prsWithoutPlan(manifest) {
  if (sourcesOf(manifest).length === 0) {
    return []
  }

  const plans = prPlans(manifest)

  return manifest.prs.filter((pr) => plans.get(pr.id).length === 0).map((pr) => pr.id)
}
