import { isBriefedWith, sourceText } from './briefing.mjs'

// The plan the agents work from, for the UI: every briefing source, and each
// PR's own section of it. A section is the heading that starts with the PR
// id ("### P3 feat: …", "## PR P3: …") down to the next heading of the same
// or a higher level. Headings inside code fences do not count.
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s*(```|~~~)/
const EMPHASIS = /[*_`]/g
const EXCERPT_LIMIT = 160

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function headingsOf(lines) {
  const headings = []
  let fenced = false

  lines.forEach((line, index) => {
    if (FENCE.test(line)) {
      fenced = !fenced
      return
    }

    const match = fenced ? null : HEADING.exec(line)

    if (match) {
      headings.push({ index, level: match[1].length, text: match[2] })
    }
  })

  return headings
}

// P1 must not match P10, so the id ends at anything but a word character or a dash.
function namesPr(heading, id) {
  const plain = heading.replace(EMPHASIS, '').trim()

  return new RegExp(`^(?:PR\\s+)?${escapeRegExp(id)}(?![\\w-])`, 'i').test(plain)
}

function excerptOf(body) {
  const line = body.split('\n').find((text) => text.trim() !== '')

  if (!line) {
    return null
  }

  const plain = line
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()

  return plain.length > EXCERPT_LIMIT ? `${plain.slice(0, EXCERPT_LIMIT - 1)}…` : plain
}

export function planSection(text, id) {
  const lines = text.split('\n')
  const headings = headingsOf(lines)
  const position = headings.findIndex((heading) => namesPr(heading.text, id))

  if (position === -1) {
    return null
  }

  const start = headings[position]
  const end = headings.slice(position + 1).find((heading) => heading.level <= start.level)
  const body = lines
    .slice(start.index + 1, end ? end.index : lines.length)
    .join('\n')
    .trim()

  return { heading: start.text, text: body, excerpt: excerptOf(body) }
}

function readSource(source) {
  try {
    return { text: sourceText(source), error: null }
  } catch (error) {
    return { text: null, error: error.message }
  }
}

export function planSources(manifest) {
  return (manifest.briefing?.sources ?? []).map((source) => ({
    title: source.title ?? source.path,
    path: source.path,
    kind: source.kind,
    tag: source.tag ?? null,
    ...readSource(source),
  }))
}

// The first source the PR's brief writer gets that has a section for it.
export function prPlan(manifest, pr) {
  for (const source of manifest.briefing?.sources ?? []) {
    if (!isBriefedWith(pr, source)) {
      continue
    }

    const { text } = readSource(source)
    const section = text === null ? null : planSection(text, pr.id)

    if (section) {
      return { source: source.title ?? source.path, ...section }
    }
  }

  return null
}
