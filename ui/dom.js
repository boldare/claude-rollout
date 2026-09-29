// Titles, bodies, verdicts, briefs and events are untrusted agent output, so
// the page is built from elements, textContent and attributes only.
const SVG_NS = 'http://www.w3.org/2000/svg'
const GITHUB = 'https://github.com/'

export function element(tag, text, className) {
  const node = document.createElement(tag)

  if (text !== undefined && text !== null) {
    node.textContent = text
  }

  if (className) {
    node.className = className
  }

  return node
}

export function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag)

  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value)
  }

  return node
}

export function link(href, text, className) {
  const node = element('a', text, className)
  node.href = href

  return node
}

export function externalLink(url, text, className) {
  if (typeof url !== 'string' || !url.startsWith(GITHUB)) {
    return element('span', text, className)
  }

  const node = link(url, text, className)
  node.target = '_blank'
  node.rel = 'noreferrer noopener'

  return node
}

export function list(items, className) {
  const node = element('ul', undefined, className)
  node.append(...items.map((item) => (item instanceof Node ? wrap('li', item) : element('li', item))))

  return node
}

export function wrap(tag, ...children) {
  const node = document.createElement(tag)
  node.append(...children)

  return node
}

export function withClass(node, className) {
  node.className = className

  return node
}

export function table(headings, rows, className) {
  const head = wrap('tr', ...headings.map((heading) => element('th', heading)))
  const body = wrap('tbody', ...rows)
  const node = withClass(wrap('table', wrap('thead', head), body), className ?? '')

  return withClass(wrap('div', node), 'scroll')
}

export function cell(content, className) {
  const node = content instanceof Node ? wrap('td', content) : element('td', content)

  if (className) {
    node.className = className
  }

  return node
}

export function badge(text, className) {
  return element('span', text, `badge ${className}`)
}

export function stateBadge(state) {
  return badge(state, `state state-${state}`)
}

export function secondsSince(iso, now) {
  const time = typeof iso === 'string' ? Date.parse(iso) : NaN

  return Number.isFinite(time) ? Math.max(0, (now - time) / 1000) : null
}
