import { element, withClass, wrap } from './dom.js'
import { parseMarkdown } from './markdown-parse.js'

const MAX_DEPTH = 3

function inlineNodes(nodes) {
  return nodes.map(inlineNode)
}

// A link that is not http or https stays text, with its target on hover.
function linkNode(node) {
  const children = inlineNodes(node.children)

  if (!node.href) {
    const span = withClass(wrap('span', ...children), 'unlinked')
    span.title = node.target

    return span
  }

  const anchor = wrap('a', ...children)

  anchor.href = node.href
  anchor.title = node.href
  anchor.target = '_blank'
  anchor.rel = 'noreferrer noopener'

  return anchor
}

const INLINE = {
  text: (node) => node.text,
  code: (node) => element('code', node.text),
  strong: (node) => wrap('strong', ...inlineNodes(node.children)),
  em: (node) => wrap('em', ...inlineNodes(node.children)),
  del: (node) => wrap('del', ...inlineNodes(node.children)),
  break: () => element('br'),
  link: linkNode,
}

function inlineNode(node) {
  return INLINE[node.type](node)
}

// The document's top heading sits one level under the page's heading above it, whatever level it has in the file.
function headingNode(block, layout) {
  const depth = Math.max(1, block.level - layout.top + 1)
  const tag = `h${Math.min(6, layout.level + depth - 1)}`

  return withClass(wrap(tag, ...inlineNodes(block.inline)), `depth-${Math.min(depth, MAX_DEPTH)}`)
}

// A disabled checkbox is greyed out until a ticked one barely shows, so the box is drawn.
function taskBox(checked) {
  const box = element('span', checked ? '✓' : '', checked ? 'task-box done' : 'task-box')

  box.setAttribute('role', 'img')
  box.setAttribute('aria-label', checked ? 'done' : 'open')

  return box
}

// The box goes into the item's first paragraph, so it sits on the line of its text.
function itemNode(item, layout) {
  const node = wrap('li', ...blockNodes(item.blocks, layout))

  if (item.checked === null) {
    return node
  }

  const first = node.firstElementChild
  const holder = first?.tagName === 'P' ? first : node

  holder.prepend(taskBox(item.checked))
  node.className = 'task'

  return node
}

function listNode(block, layout) {
  const node = wrap(block.ordered ? 'ol' : 'ul', ...block.items.map((item) => itemNode(item, layout)))

  if (block.ordered && block.start !== 1) {
    node.start = block.start
  }

  return node
}

// The CSP blocks style attributes, so alignment is a class.
function cellNode(tag, cell, align) {
  return withClass(wrap(tag, ...inlineNodes(cell)), align ? `align-${align}` : '')
}

function rowNode(tag, cells, align) {
  return wrap('tr', ...cells.map((cell, i) => cellNode(tag, cell, align[i])))
}

function tableNode(block) {
  const head = wrap('thead', rowNode('th', block.head, block.align))
  const body = wrap('tbody', ...block.rows.map((cells) => rowNode('td', cells, block.align)))

  return withClass(wrap('div', wrap('table', head, body)), 'scroll')
}

const BLOCK = {
  heading: headingNode,
  paragraph: (block) => wrap('p', ...inlineNodes(block.inline)),
  code: (block) => element('pre', block.text),
  rule: () => element('hr'),
  quote: (block, layout) => wrap('blockquote', ...blockNodes(block.blocks, layout)),
  list: listNode,
  table: tableNode,
}

function blockNodes(blocks, layout) {
  return blocks.map((block) => BLOCK[block.type](block, layout))
}

function topLevel(blocks) {
  const levels = blocks.filter((block) => block.type === 'heading').map((block) => block.level)

  return levels.length > 0 ? Math.min(...levels) : 1
}

export function renderMarkdown(text, level) {
  const blocks = parseMarkdown(text)

  return withClass(wrap('div', ...blockNodes(blocks, { level, top: topLevel(blocks) })), 'markdown')
}

// A document reads formatted, with a button for its source. Every update rebuilds the page,
// so the choice lives in ctx.sourceDocs, by rollout and by document.
export function markdownDocument(text, { key, level, ctx }) {
  const id = `${ctx.route.r}|${key}`
  const node = element('div', undefined, 'markdown-doc')
  const toggle = element('button', undefined, 'doc-toggle')

  function show() {
    const source = ctx.sourceDocs.has(id)

    toggle.textContent = source ? 'Formatted' : 'Source'
    node.replaceChildren(toggle, source ? element('pre', text, 'markdown-source') : renderMarkdown(text, level))
  }

  toggle.type = 'button'
  toggle.addEventListener('click', () => {
    if (ctx.sourceDocs.has(id)) {
      ctx.sourceDocs.delete(id)
    } else {
      ctx.sourceDocs.add(id)
    }

    show()
  })

  show()

  return node
}
