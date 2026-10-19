import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInline, parseMarkdown } from '../ui/markdown-parse.js'

function text(value) {
  return { type: 'text', text: value }
}

function paragraph(...inline) {
  return { type: 'paragraph', inline }
}

function heading(level, ...inline) {
  return { type: 'heading', level, inline }
}

function item(blocks, checked = null) {
  return { checked, blocks }
}

function bullets(...items) {
  return { type: 'list', ordered: false, start: null, items }
}

function numbered(start, ...items) {
  return { type: 'list', ordered: true, start, items }
}

function code(value) {
  return { type: 'code', text: value }
}

function link(target, children, href = target) {
  return { type: 'link', target, href, children }
}

test('markdown: ATX headings with any indent and closing hashes, setext underlines, and "#tag" as text', () => {
  assert.deepEqual(parseMarkdown('# One\n  ### Three ###\n#tag'), [
    heading(1, text('One')),
    heading(3, text('Three')),
    paragraph(text('#tag')),
  ])

  assert.deepEqual(parseMarkdown('Title\n===\n\nSub\n---'), [heading(1, text('Title')), heading(2, text('Sub'))])
})

test('markdown: a paragraph joins its lines, and two trailing spaces or a backslash break the line', () => {
  assert.deepEqual(parseMarkdown('one\n  two'), [paragraph(text('one\ntwo'))])
  assert.deepEqual(parseMarkdown('one  \ntwo\\\nthree '), [
    paragraph(text('one'), { type: 'break' }, text('two'), { type: 'break' }, text('three')),
  ])
})

test('markdown: fences keep their text, close on the same marker at least as long, and an open one runs to the end', () => {
  assert.deepEqual(parseMarkdown('```sh\nnpm test\n# not a heading\n```\nafter'), [
    code('npm test\n# not a heading'),
    paragraph(text('after')),
  ])

  assert.deepEqual(parseMarkdown('````\n```\n````'), [code('```')])
  assert.deepEqual(parseMarkdown('~~~\n**x**'), [code('**x**')])
  assert.deepEqual(parseMarkdown('  ```\n    indented\n  ```'), [code('  indented')])
  assert.deepEqual(parseMarkdown('```a```'), [paragraph({ type: 'code', text: 'a' })])
})

test('markdown: rules, and a rule is never an empty item', () => {
  assert.deepEqual(parseMarkdown('a\n\n---\n\n* * *\n- - -'), [paragraph(text('a')), { type: 'rule' }, { type: 'rule' }, { type: 'rule' }])
})

test('markdown: bullet and numbered lists, with the number a list starts from', () => {
  assert.deepEqual(parseMarkdown('- a\n- b'), [bullets(item([paragraph(text('a'))]), item([paragraph(text('b'))]))])
  assert.deepEqual(parseMarkdown('3. a\n4. b'), [numbered(3, item([paragraph(text('a'))]), item([paragraph(text('b'))]))])
})

test('markdown: nesting goes by indent, two spaces under a number included, and blank lines keep the list', () => {
  const nested = bullets(item([paragraph(text('child'))]))

  assert.deepEqual(parseMarkdown('- parent\n  - child'), [bullets(item([paragraph(text('parent')), nested]))])
  assert.deepEqual(parseMarkdown('1. parent\n  - child'), [numbered(1, item([paragraph(text('parent')), nested]))])
  assert.deepEqual(parseMarkdown('1. parent\n   - child\n\n2. next'), [
    numbered(1, item([paragraph(text('parent')), nested]), item([paragraph(text('next'))])),
  ])
})

test('markdown: a list item takes the lines that carry on its paragraph, and ends at a blank line before less indent', () => {
  assert.deepEqual(parseMarkdown('- one\ncarried on\n\nafter'), [
    bullets(item([paragraph(text('one\ncarried on'))])),
    paragraph(text('after')),
  ])
})

test('markdown: another bullet starts a new list, and a list interrupts a paragraph only from 1 and with text', () => {
  assert.deepEqual(parseMarkdown('- a\n* b'), [bullets(item([paragraph(text('a'))])), bullets(item([paragraph(text('b'))]))])
  assert.deepEqual(parseMarkdown('Released in\n2024. Then'), [paragraph(text('Released in\n2024. Then'))])
  assert.deepEqual(parseMarkdown('Steps:\n1. a'), [paragraph(text('Steps:')), numbered(1, item([paragraph(text('a'))]))])
})

test('markdown: task items, checked and not', () => {
  assert.deepEqual(parseMarkdown('- [ ] todo\n- [x] done'), [
    bullets(item([paragraph(text('todo'))], false), item([paragraph(text('done'))], true)),
  ])
})

test("markdown: a plan's slice of a list item keeps its indent, and its children are still a list", () => {
  const slice = 'The events API.\n  - `GET /events`\n    - paged\n  - `POST /events`'
  const children = bullets(item([paragraph(text('paged'))]))

  assert.deepEqual(parseMarkdown(slice), [
    paragraph(text('The events API.')),
    bullets(item([paragraph({ type: 'code', text: 'GET /events' }), children]), item([paragraph({ type: 'code', text: 'POST /events' })])),
  ])
})

test('markdown: a quote holds blocks, and a line without ">" carries on its paragraph', () => {
  assert.deepEqual(parseMarkdown('> # Note\n> one\ntwo\n\nafter'), [
    { type: 'quote', blocks: [heading(1, text('Note')), paragraph(text('one\ntwo'))] },
    paragraph(text('after')),
  ])
})

test('markdown: a table with alignment, inline spans in cells, an escaped pipe, and rows fitted to the header', () => {
  const table = parseMarkdown('| a | b | c |\n|:--|:-:|--:|\n| `x` | **y** | z \\| w |\n| short |\n| 1 | 2 | 3 | 4 |')

  assert.deepEqual(table, [
    {
      type: 'table',
      align: ['left', 'center', 'right'],
      head: [[text('a')], [text('b')], [text('c')]],
      rows: [
        [[{ type: 'code', text: 'x' }], [{ type: 'strong', children: [text('y')] }], [text('z | w')]],
        [[text('short')], [], []],
        [[text('1')], [text('2')], [text('3')]],
      ],
    },
  ])
})

test('markdown: a table needs as many delimiter cells as header cells, ends at a line without a pipe, and can follow a paragraph', () => {
  assert.deepEqual(parseMarkdown('a | b\n|---|'), [paragraph(text('a | b\n|---|'))])

  const blocks = parseMarkdown('Intro\n| a |\n| --- |\n| 1 |\nafter')

  assert.deepEqual(
    blocks.map((block) => block.type),
    ['paragraph', 'table', 'paragraph'],
  )

  assert.deepEqual(blocks[1].rows, [[[text('1')]]])
})

test('markdown: CRLF line ends and leading tabs', () => {
  assert.deepEqual(parseMarkdown('- a\r\n\t- b'), [bullets(item([paragraph(text('a')), bullets(item([paragraph(text('b'))]))]))])
})

test('inline: code spans of any length, with one space of padding taken off both sides', () => {
  assert.deepEqual(parseInline('`a` and ``b ` c`` and `` `d` ``'), [
    { type: 'code', text: 'a' },
    text(' and '),
    { type: 'code', text: 'b ` c' },
    text(' and '),
    { type: 'code', text: '`d`' },
  ])

  assert.deepEqual(parseInline('an `open one'), [text('an `open one')])
})

test('inline: emphasis, strong, both, and strikethrough with two tildes only', () => {
  assert.deepEqual(parseInline('*a* _b_ **c** __d__ ***e*** ~~f~~ ~5 min'), [
    { type: 'em', children: [text('a')] },
    text(' '),
    { type: 'em', children: [text('b')] },
    text(' '),
    { type: 'strong', children: [text('c')] },
    text(' '),
    { type: 'strong', children: [text('d')] },
    text(' '),
    { type: 'em', children: [{ type: 'strong', children: [text('e')] }] },
    text(' '),
    { type: 'del', children: [text('f')] },
    text(' ~5 min'),
  ])
})

test('inline: nesting, a bold lead with code in it, and the rule of three', () => {
  assert.deepEqual(parseInline('**a *b***'), [{ type: 'strong', children: [text('a '), { type: 'em', children: [text('b')] }] }])
  assert.deepEqual(parseInline('**P3 `feat/events`** (P1)'), [
    { type: 'strong', children: [text('P3 '), { type: 'code', text: 'feat/events' }] },
    text(' (P1)'),
  ])

  assert.deepEqual(parseInline('*foo**bar*'), [{ type: 'em', children: [text('foo**bar')] }])
})

test('inline: snake_case, globs, arithmetic and a lone star stay text', () => {
  for (const value of ['snake_case_name', 'src/**/*.ts', '2 * 3 * 4', 'a ** b', 'file_*.md']) {
    assert.deepEqual(parseInline(value), [text(value)], value)
  }
})

test('inline: links keep an address only for http and https, and their text holds no other link', () => {
  assert.deepEqual(parseInline('[the PR](https://github.com/o/r/pull/1 "title")'), [
    link('https://github.com/o/r/pull/1', [text('the PR')]),
  ])

  assert.deepEqual(parseInline('[plan](docs/plan.md)'), [link('docs/plan.md', [text('plan')], null)])
  assert.deepEqual(parseInline('[x](javascript:alert(1))'), [link('javascript:alert(1)', [text('x')], null)])
  assert.deepEqual(parseInline('[https://a.dev](https://b.dev)'), [link('https://b.dev', [text('https://a.dev')])])
  assert.deepEqual(parseInline('[a](<with space>)'), [link('with space', [text('a')], null)])
  assert.deepEqual(parseInline('[P1] (later) and [open'), [text('[P1] (later) and [open')])
})

test('inline: autolinks, bare URLs without the punctuation after them, and an image as a link to it', () => {
  assert.deepEqual(parseInline('<https://a.dev/x>'), [link('https://a.dev/x', [text('https://a.dev/x')])])
  assert.deepEqual(parseInline('See https://a.dev/x, then (https://b.dev/y_(z)).'), [
    text('See '),
    link('https://a.dev/x', [text('https://a.dev/x')]),
    text(', then ('),
    link('https://b.dev/y_(z)', [text('https://b.dev/y_(z)')]),
    text(').'),
  ])

  assert.deepEqual(parseInline('xhttps://a.dev'), [text('xhttps://a.dev')])
  assert.deepEqual(parseInline('![diagram](https://a.dev/d.png) ![](https://a.dev/e.png)'), [
    link('https://a.dev/d.png', [text('diagram')]),
    text(' '),
    link('https://a.dev/e.png', [text('https://a.dev/e.png')]),
  ])
})

test('inline: raw HTML and backslash escapes stay text', () => {
  assert.deepEqual(parseInline('<script>alert(1)</script> <b>x</b>'), [text('<script>alert(1)</script> <b>x</b>')])
  assert.deepEqual(parseInline('\\*not em\\* \\`not code\\` \\[not](a link) C:\\path'), [
    text('*not em* `not code` [not](a link) C:\\path'),
  ])
})

test('markdown: deep nesting stops at 32 levels and keeps the rest as text, so a hostile document cannot overflow the stack', () => {
  let block = parseMarkdown(`${'>'.repeat(20_000)} x`)[0]
  let depth = 0

  while (block.type === 'quote') {
    block = block.blocks[0]
    depth += 1
  }

  assert.equal(depth, 33)
  assert.equal(block.type, 'code')

  let node = parseInline(`${'*a '.repeat(5_000)}b${' c*'.repeat(5_000)}`)[0]
  let levels = 0

  while (node.type === 'em') {
    node = node.children.at(-1)
    levels += 1
  }

  assert.ok(levels > 0 && levels <= 33, `${levels} levels`)
})
