// Just enough of a document for the UI's views to render in Node. Properties the views set,
// like href, title, open or colSpan, are plain fields.
const COMPOUND_SELECTOR = /^([a-z][a-z0-9-]*)?((?:\.[A-Za-z_][\w-]*)*)$/

class FakeNode {}

class FakeText extends FakeNode {
  constructor(text) {
    super()
    this.textContent = String(text)
  }
}

// A selector the fake cannot read throws, so a test never passes by matching nothing.
function parseSelector(selector) {
  const match = typeof selector === 'string' && selector !== '' ? COMPOUND_SELECTOR.exec(selector) : null

  if (!match) {
    throw new Error(`fake-dom: unsupported selector ${JSON.stringify(selector)}, use a tag and .class parts only`)
  }

  const classes = match[2].split('.').filter(Boolean)

  return { tag: match[1]?.toUpperCase() ?? null, classes }
}

function matches(element, { tag, classes }) {
  if (tag && element.tagName !== tag) {
    return false
  }

  return classes.every((name) => element.classList.contains(name))
}

function toNode(item) {
  return item instanceof FakeNode ? item : new FakeText(item)
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super()
    this.tagName = String(tag).toUpperCase()
    this.className = ''
    this.childNodes = []
    this.attributes = {}
    this.listeners = []
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof FakeElement)
  }

  get classList() {
    const names = this.className.split(/\s+/).filter(Boolean)

    return { contains: (name) => names.includes(name) }
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('')
  }

  set textContent(text) {
    const value = String(text)
    this.childNodes = value === '' ? [] : [new FakeText(value)]
  }

  append(...items) {
    this.childNodes.push(...items.map(toNode))
  }

  replaceChildren(...items) {
    this.childNodes = items.map(toNode)
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  addEventListener(type, listener) {
    this.listeners.push({ type, listener })
  }

  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()])
  }

  querySelectorAll(selector) {
    const parsed = parseSelector(selector)

    return this.descendants().filter((element) => matches(element, parsed))
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

export function installDocument() {
  const document = {
    title: '',
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(text),
  }

  globalThis.document = document
  globalThis.Node = FakeNode

  return document
}
