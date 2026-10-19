// Markdown to a plain tree that markdown.js builds with elements. Plans and
// briefs are agent output, so nothing here becomes HTML: raw HTML stays text
// and only http and https links keep an address. The subset is what plans and
// briefs use, with GitHub's tables, task items and strikethrough. Indented code
// is left out on purpose: a plan's slice of a list keeps its indent, and agents
// fence their code. So any indent is only nesting.
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/
const HEADING = /^\s*(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const SETEXT = /^\s*(?:=+|-+)\s*$/
const RULE = /^\s*([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^\s*> ?(.*)$/
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])(?:([ \t]+)(.*))?$/
const TASK = /^\[([ xX])\][ \t]+(.*)$/
const DELIMITER_CELL = /^\s*:?-+:?\s*$/
const ESCAPABLE = /[!-/:-@[-`{-~]/
const SPACE = /\s/
const PUNCTUATION = /[\p{P}\p{S}]/u
const WEB = /^https?:\/\//i
const AUTOLINK = /<(https?:\/\/[^\s<>]*)>/iy
const BARE_URL = /https?:\/\/[^\s<]+/iy
const URL_START = /[\s*_~(]/
const URL_TRAILING = /[?!.,:;*_~'"]/
const TAB = '    '
// Deeper quotes, lists or emphasis stay text, so a hostile document cannot overflow the stack.
const MAX_NESTING = 32

function isBlank(line) {
  return line.trim() === ''
}

function indentOf(line) {
  return line.search(/\S/)
}

// Takes off up to `width` leading spaces, so a line indented less keeps its text.
function dedent(line, width) {
  return line.slice(Math.min(Math.max(indentOf(line), 0), width))
}

function expandTabs(line) {
  return line.replace(/^[ \t]+/, (lead) => lead.replaceAll('\t', TAB))
}

// A backtick fence cannot carry a backtick in its info string, so ```a``` is inline code.
function opensFence(match) {
  return match !== null && !(match[2][0] === '`' && match[3].includes('`'))
}

// A fence closes only on the same character, at least as many times, with nothing after it.
function closesFence(match, marker) {
  return match !== null && match[2][0] === marker[0] && match[2].length >= marker.length && match[3].trim() === ''
}

// A rule like "- - -" is never an empty item. An item's content starts past the marker and the spaces after it.
function itemOf(line) {
  const match = RULE.test(line) ? null : ITEM.exec(line)

  if (!match) {
    return null
  }

  const [, indent, marker, number, gap = '', text = ''] = match

  return {
    indent: indent.length,
    content: indent.length + marker.length + Math.max(1, Math.min(gap.length, 4)),
    kind: marker.at(-1),
    ordered: number !== undefined,
    start: number === undefined ? null : Number(number),
    text,
  }
}

// A line that opens a block of its own, so a table row or a lazy line stops there.
function opensBlock(line) {
  return opensFence(FENCE.exec(line)) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)
}

function cellsOf(line) {
  const row = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')

  return row.split(/(?<!\\)\|/).map((cell) => cell.trim())
}

function alignOf(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')

  if (left && right) {
    return 'center'
  }

  if (right) {
    return 'right'
  }

  return left ? 'left' : null
}

// A table starts at a row with pipes over a delimiter row with as many cells.
function headerOf(lines, start) {
  const head = lines[start]
  const delimiter = lines[start + 1]

  if (delimiter === undefined || !head.includes('|') || !delimiter.includes('|')) {
    return null
  }

  const names = cellsOf(head)
  const cells = cellsOf(delimiter)

  if (cells.length !== names.length || !cells.every((cell) => DELIMITER_CELL.test(cell))) {
    return null
  }

  return { names, align: cells.map(alignOf) }
}

// What may end a paragraph without a blank line. A list may, unless its item is empty or counts from a number other than 1.
function interrupts(lines, i) {
  const item = itemOf(lines[i])
  const startsList = item !== null && item.text !== '' && (item.start ?? 1) === 1

  return opensBlock(lines[i]) || startsList || headerOf(lines, i) !== null
}

function heading(level, text) {
  return { type: 'heading', level, inline: parseInline(text.trim()) }
}

function fenceAt(lines, start) {
  const open = FENCE.exec(lines[start])

  if (!opensFence(open)) {
    return null
  }

  const [, indent, marker] = open
  let end = start + 1

  while (end < lines.length && !closesFence(FENCE.exec(lines[end]), marker)) {
    end += 1
  }

  const text = lines
    .slice(start + 1, end)
    .map((line) => dedent(line, indent.length))
    .join('\n')

  return { block: { type: 'code', text }, next: end + 1 }
}

function headingAt(lines, start) {
  const match = HEADING.exec(lines[start])

  return match && { block: heading(match[1].length, match[2] ?? ''), next: start + 1 }
}

function ruleAt(lines, start) {
  return RULE.test(lines[start]) ? { block: { type: 'rule' }, next: start + 1 } : null
}

// A line without ">" still belongs to the quote while it carries on the paragraph above it.
function quoteAt(lines, start, depth) {
  if (!QUOTE.test(lines[start])) {
    return null
  }

  const inner = []
  let i = start

  while (i < lines.length) {
    const match = QUOTE.exec(lines[i])

    if (match) {
      inner.push(match[1])
    } else if (!isBlank(lines[i]) && !isBlank(inner.at(-1)) && !interrupts(lines, i)) {
      inner.push(lines[i])
    } else {
      break
    }

    i += 1
  }

  return { block: { type: 'quote', blocks: blocksOf(inner, depth + 1) }, next: i }
}

// An item takes every line indented past its marker, blank lines between them, and lines that carry on its paragraph.
function itemEnd(lines, start, item) {
  let i = start + 1

  while (i < lines.length) {
    const line = lines[i]
    const nested = isBlank(line) || indentOf(line) > item.indent
    const lazy = !isBlank(lines[i - 1]) && !interrupts(lines, i) && !itemOf(line)

    if (!nested && !lazy) {
      break
    }

    i += 1
  }

  return i
}

function listItem(item, rest, depth) {
  const task = TASK.exec(item.text)
  const body = [task ? task[2] : item.text, ...rest.map((line) => dedent(line, item.content))]

  return { checked: task ? task[1] !== ' ' : null, blocks: blocksOf(body, depth + 1) }
}

// Another bullet character or another delimiter after the number starts a new list.
function listAt(lines, start, depth) {
  const first = itemOf(lines[start])

  if (!first) {
    return null
  }

  const items = []
  let item = first
  let i = start

  while (item && item.kind === first.kind) {
    const end = itemEnd(lines, i, item)

    items.push(listItem(item, lines.slice(i + 1, end), depth))
    i = end
    item = i < lines.length ? itemOf(lines[i]) : null
  }

  return { block: { type: 'list', ordered: first.ordered, start: first.start, items }, next: i }
}

// Short rows get empty cells and long ones lose the extra cells, as on GitHub.
function fitted(cells, width) {
  return Array.from({ length: width }, (_, i) => parseInline(cells[i] ?? ''))
}

function tableAt(lines, start) {
  const header = headerOf(lines, start)

  if (!header) {
    return null
  }

  let end = start + 2

  while (end < lines.length && lines[end].includes('|') && !opensBlock(lines[end]) && !itemOf(lines[end])) {
    end += 1
  }

  const width = header.names.length
  const rows = lines.slice(start + 2, end).map((line) => fitted(cellsOf(line), width))

  return { block: { type: 'table', align: header.align, head: fitted(header.names, width), rows }, next: end }
}

// An underline of "=" or "-" makes the paragraph above it a heading, as on GitHub.
function paragraphAt(lines, start) {
  const text = [lines[start].trimStart()]
  let i = start + 1

  while (i < lines.length && !isBlank(lines[i])) {
    if (SETEXT.test(lines[i])) {
      return { block: heading(lines[i].trim()[0] === '=' ? 1 : 2, text.join('\n')), next: i + 1 }
    }

    if (interrupts(lines, i)) {
      break
    }

    text.push(lines[i].trimStart())
    i += 1
  }

  return { block: { type: 'paragraph', inline: parseInline(text.join('\n').trimEnd()) }, next: i }
}

const READERS = [fenceAt, headingAt, ruleAt, quoteAt, listAt, tableAt]

function readBlock(lines, i, depth) {
  for (const read of READERS) {
    const found = read(lines, i, depth)

    if (found) {
      return found
    }
  }

  return paragraphAt(lines, i)
}

function blocksOf(lines, depth) {
  if (depth > MAX_NESTING) {
    return [{ type: 'code', text: lines.join('\n') }]
  }

  const blocks = []
  let i = 0

  while (i < lines.length) {
    if (isBlank(lines[i])) {
      i += 1
      continue
    }

    const { block, next } = readBlock(lines, i, depth)

    blocks.push(block)
    i = next
  }

  return blocks
}

export function parseMarkdown(text) {
  return blocksOf(text.replace(/\r\n?/g, '\n').split('\n').map(expandTabs), 0)
}

// Inline spans

function textNode(text) {
  return { type: 'text', text }
}

// Neighbouring text joins one node.
function append(nodes, node) {
  const last = nodes.at(-1)

  if (node.type === 'text' && last?.type === 'text') {
    last.text += node.text
    return
  }

  nodes.push(node)
}

function runLength(text, start, char) {
  let end = start

  while (text[end] === char) {
    end += 1
  }

  return end - start
}

// The next run of exactly `length` of `char`, as a code span closes only on as many backticks as opened it.
function findRun(text, from, char, length) {
  let i = text.indexOf(char, from)

  while (i !== -1) {
    const run = runLength(text, i, char)

    if (run === length) {
      return i
    }

    i = text.indexOf(char, i + run)
  }

  return -1
}

// Past a code span, or past its backticks when nothing closes it, since those are then text.
function afterCode(text, start) {
  const length = runLength(text, start, '`')
  const close = findRun(text, start + length, '`', length)

  return close === -1 ? start + length : close + length
}

function escapeAt(text, start) {
  const next = text[start + 1]

  if (next === '\n') {
    return { node: { type: 'break' }, next: start + 2 }
  }

  return next !== undefined && ESCAPABLE.test(next) ? { node: textNode(next), next: start + 2 } : null
}

// Spaces before a line end are dropped, and two or more make a hard break.
function spacesAt(text, start) {
  const end = start + runLength(text, start, ' ')

  if (text[end] !== '\n') {
    return { node: textNode(text.slice(start, end)), next: end }
  }

  return { node: end - start >= 2 ? { type: 'break' } : textNode('\n'), next: end + 1 }
}

// One space on both sides is padding, so `` `x` `` shows the backticks.
function codeAt(text, start) {
  const length = runLength(text, start, '`')
  const close = findRun(text, start + length, '`', length)

  if (close === -1) {
    return { node: textNode('`'.repeat(length)), next: start + length }
  }

  const code = text.slice(start + length, close).replaceAll('\n', ' ')
  const padded = code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== ''

  return { node: { type: 'code', text: padded ? code.slice(1, -1) : code }, next: close + length }
}

// CommonMark's flanking rules: what sits on each side of a run of "*", "_" or "~" says whether it can open or close.
function flanking(text, start, length) {
  const before = text[start - 1] ?? ' '
  const after = text[start + length] ?? ' '
  const left = !SPACE.test(after) && (!PUNCTUATION.test(after) || SPACE.test(before) || PUNCTUATION.test(before))
  const right = !SPACE.test(before) && (!PUNCTUATION.test(before) || SPACE.test(after) || PUNCTUATION.test(after))

  return { left, right, before, after }
}

// "_" never opens or closes inside a word, so snake_case_names stay text.
function opens(char, flank) {
  return char === '_' ? flank.left && (!flank.right || PUNCTUATION.test(flank.before)) : flank.left
}

function closes(char, flank) {
  return char === '_' ? flank.right && (!flank.left || PUNCTUATION.test(flank.after)) : flank.right
}

// A single "~" is "about" in a plan ("~5 min"), so only "~~" strikes through.
function fitsOpener(char, length) {
  return char === '~' ? length === 2 : length <= 3
}

function fitsCloser(char, openLength, length) {
  return char === '~' ? length === 2 : length >= openLength
}

// CommonMark's rule of three: a run that can both open and close does not pair with one whose
// length adds up to a multiple of three, so `*foo**bar*` is one emphasis.
function breaksRuleOfThree(char, opener, closer, openLength, closeLength) {
  const either = (opens(char, opener) && closes(char, opener)) || (opens(char, closer) && closes(char, closer))

  return either && (openLength + closeLength) % 3 === 0 && !(openLength % 3 === 0 && closeLength % 3 === 0)
}

// Where the closing run starts. A longer run closes with its last characters, so `**a *b***` nests.
function closerOf(text, from, char, openLength, opener) {
  let i = from

  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }

    if (text[i] === '`') {
      i = afterCode(text, i)
      continue
    }

    if (text[i] !== char) {
      i += 1
      continue
    }

    const length = runLength(text, i, char)
    const close = i + length - openLength
    const flank = flanking(text, i, length)

    if (
      close > from &&
      fitsCloser(char, openLength, length) &&
      closes(char, flank) &&
      !breaksRuleOfThree(char, opener, flank, openLength, length)
    ) {
      return close
    }

    i += length
  }

  return -1
}

function emphasis(char, length, children) {
  if (char === '~') {
    return { type: 'del', children }
  }

  if (length === 3) {
    return { type: 'em', children: [{ type: 'strong', children }] }
  }

  return { type: length === 2 ? 'strong' : 'em', children }
}

// The text is read left to right, so once a kind of opener finds no closer, no later one of that kind can.
// Remembering that keeps a text full of unclosed stars linear.
function emphasisAt(text, start, state) {
  const char = text[start]
  const length = runLength(text, start, char)
  const literal = { node: textNode(char.repeat(length)), next: start + length }
  const opener = flanking(text, start, length)
  const kind = `${char}${length}${closes(char, opener)}`

  if (!fitsOpener(char, length) || !opens(char, opener) || state.unclosed.has(kind)) {
    return literal
  }

  const close = closerOf(text, start + length, char, length, opener)

  if (close === -1) {
    state.unclosed.add(kind)
    return literal
  }

  const children = inlineOf(text.slice(start + length, close), { links: state.links, depth: state.depth + 1 })

  return { node: emphasis(char, length, children), next: close + length }
}

function link(target, children) {
  return { type: 'link', target, href: WEB.test(target) ? target : null, children }
}

// Every bracket's partner in one pass, so a text full of open brackets stays linear.
// Brackets inside code are text, parens inside code are part of a link target.
function pairsOf(text, open, close, skipCode) {
  const pairs = new Map()
  const stack = []
  let i = 0

  while (i < text.length) {
    const char = text[i]

    if (char === '\\') {
      i += 2
      continue
    }

    if (skipCode && char === '`') {
      i = afterCode(text, i)
      continue
    }

    if (char === open) {
      stack.push(i)
    }

    if (char === close && stack.length > 0) {
      pairs.set(stack.pop(), i)
    }

    i += 1
  }

  return pairs
}

// The destination is the first word in the parens, or the text in <…>. A title after it is dropped.
function destination(inside) {
  const trimmed = inside.trim()
  const angled = /^<([^<>\n]*)>/.exec(trimmed)

  return angled ? angled[1] : trimmed.split(/\s/)[0]
}

// A link's text holds no other link, since a link inside a link cannot be clicked.
function linkAt(text, start, state) {
  state.brackets ??= pairsOf(text, '[', ']', true)
  const close = state.brackets.get(start)

  if (close === undefined || text[close + 1] !== '(') {
    return null
  }

  state.parens ??= pairsOf(text, '(', ')', false)
  const end = state.parens.get(close + 1)

  if (end === undefined) {
    return null
  }

  const target = destination(text.slice(close + 2, end))

  return { node: link(target, inlineOf(text.slice(start + 1, close), { links: false, depth: state.depth + 1 })), next: end + 1 }
}

// The page loads nothing from elsewhere, so an image is a link to it, named by its alt text.
function imageAt(text, start, state) {
  const found = text[start + 1] === '[' ? linkAt(text, start + 1, state) : null

  if (found && found.node.children.length === 0) {
    found.node.children = [textNode(found.node.target)]
  }

  return found
}

function autolinkAt(text, start) {
  AUTOLINK.lastIndex = start
  const match = AUTOLINK.exec(text)

  return match && { node: link(match[1], [textNode(match[1])]), next: start + match[0].length }
}

// Punctuation that ends a sentence is no part of a link, and nor is a closing paren without its opening one.
function trimUrl(url) {
  const opened = url.split('(').length - 1
  let closed = url.split(')').length - 1
  let end = url.length

  while (end > 0) {
    const last = url[end - 1]
    const unbalanced = last === ')' && closed > opened

    if (!unbalanced && !URL_TRAILING.test(last)) {
      break
    }

    closed -= unbalanced ? 1 : 0
    end -= 1
  }

  return url.slice(0, end)
}

function bareUrlAt(text, start) {
  if (start > 0 && !URL_START.test(text[start - 1])) {
    return null
  }

  BARE_URL.lastIndex = start
  const match = BARE_URL.exec(text)

  if (!match) {
    return null
  }

  const url = trimUrl(match[0])

  return { node: link(url, [textNode(url)]), next: start + url.length }
}

const SPANS = { '\\': escapeAt, ' ': spacesAt, '`': codeAt, '*': emphasisAt, _: emphasisAt, '~': emphasisAt }
const LINKS = { '[': linkAt, '!': imageAt, '<': autolinkAt, h: bareUrlAt, H: bareUrlAt }
// Every character a span can start with, so plain text between them is taken in one piece.
const SPAN_START = /[\\ `*_~[!<hH]/g

function spanAt(text, i, state) {
  const read = SPANS[text[i]] ?? (state.links ? LINKS[text[i]] : undefined)

  return read ? read(text, i, state) : null
}

function inlineOf(text, { links, depth }) {
  if (depth > MAX_NESTING) {
    return text === '' ? [] : [textNode(text)]
  }

  const state = { links, depth, unclosed: new Set(), brackets: null, parens: null }
  const nodes = []
  let i = 0

  while (i < text.length) {
    const found = spanAt(text, i, state)

    if (found) {
      append(nodes, found.node)
      i = found.next
      continue
    }

    SPAN_START.lastIndex = i + 1
    const next = SPAN_START.exec(text)?.index ?? text.length

    append(nodes, textNode(text.slice(i, next)))
    i = next
  }

  return nodes
}

export function parseInline(text) {
  return inlineOf(text, { links: true, depth: 0 })
}
