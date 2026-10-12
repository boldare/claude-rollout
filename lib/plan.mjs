import { isBriefedWith, sourceText } from './briefing.mjs'

// The plan the agents work from, for the UI: every briefing source, and each
// PR's own section of it. A section is the heading that starts with the PR
// id ("### P3 feat: …", "## PR P3: …") down to the next heading of the same
// or a higher level. Headings inside code fences do not count.
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/
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

// One entry per line: a heading, a line of a code fence, or text.
function outlineOf(text) {
  let fence = null

  return text.split('\n').map((line) => {
    const marker = FENCE.exec(line)

    if (fence) {
      fence = closesFence(marker, fence) ? null : fence
      return { line, kind: 'code' }
    }

    if (opensFence(marker)) {
      fence = marker[1]
      return { line, kind: 'code' }
    }

    const heading = HEADING.exec(line)

    if (heading) {
      return { line, kind: 'heading', level: heading[1].length, text: plainText(heading[2] ?? '') }
    }

    return { line, kind: 'text' }
  })
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

function sectionIn(outline, id) {
  const start = outline.findIndex((entry) => entry.kind === 'heading' && namesPr(entry.text, id))

  if (start === -1) {
    return null
  }

  const { level, text: heading } = outline[start]
  const rest = outline.slice(start + 1)
  const end = rest.findIndex((entry) => entry.kind === 'heading' && entry.level <= level)
  const body = end === -1 ? rest : rest.slice(0, end)
  const text = body
    .map((entry) => entry.line)
    .join('\n')
    .trim()

  return { heading, text, excerpt: excerptOf(body) }
}

export function planSection(text, id) {
  return sectionIn(outlineOf(text), id)
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
