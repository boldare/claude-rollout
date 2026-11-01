import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { loadManifest } from '../lib/manifest.mjs'
import { rolloutPr, rolloutSnapshot, transcriptPage } from '../lib/rollouts.mjs'
import { renderBoard } from '../ui/board.js'
import { renderDetail } from '../ui/detail.js'
import { renderHeader } from '../ui/header.js'
import { renderTranscript } from '../ui/transcript.js'
import { installDocument } from './fake-dom.mjs'
import { START, makeRollout } from './fixtures.mjs'

const fakeDocument = installDocument()
const NOW = START + 100 * 60_000
const STYLE = readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8')

// The page only ever sees JSON, so the data takes the same round trip.
function overJson(value) {
  return JSON.parse(JSON.stringify(value))
}

const dir = makeRollout()
const manifest = loadManifest(dir)
const { state, events } = overJson(rolloutSnapshot(manifest, 'demo', NOW))
const prBody = overJson(rolloutPr(manifest, 'A1'))
const page = overJson(transcriptPage(manifest, 'A1-01-implement'))

state.readOnly = true
rmSync(dir, { recursive: true, force: true })

function viewContext(overrides = {}) {
  const { route, ...rest } = overrides

  return {
    route: { r: 'demo', view: 'board', pr: null, tab: 'overview', state: null, id: null, kind: null, run: null, from: null, ...route },
    now: NOW,
    state,
    view: state.view,
    events,
    status: null,
    problem: null,
    detail: null,
    plan: null,
    transcript: null,
    rowChoices: new Map(),
    panels: new Map(),
    drafts: new Map(),
    sent: new Set(),
    toggleRow: () => {},
    sendAnswer: () => {},
    readOnly: true,
    sending: false,
    notice: null,
    send: () => {},
    remembered: new Map(),
    linkTo: () => '#',
    linkWith: () => '#',
    go: () => {},
    ...rest,
  }
}

function one(node, selector) {
  const found = node.querySelector(selector)
  assert.ok(found, `no ${selector} in ${node.tagName}.${node.className}`)

  return found
}

function texts(node, selector) {
  return node.querySelectorAll(selector).map((item) => item.textContent)
}

// Comments become spaces first, so a brace inside one never counts and the line numbers hold.
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
}

// A style rule sits at the top level or inside @media. Other at-rules, like the @font-face ones, repeat by design.
function isStyleRule(prelude, outer) {
  return !prelude.startsWith('@') && outer.every((block) => block.startsWith('@media'))
}

// The selector list stays whole. A group for shared declarations next to a rule of its own is the pattern in
// style.css, not a repeat.
function cssRules(css) {
  const source = stripComments(css)
  const rules = []
  const outer = []
  let start = 0
  let line = 1

  for (let i = 0; i < source.length; i++) {
    const char = source[i]

    if (char === '\n') {
      line += 1
    } else if (char === '{') {
      const prelude = source.slice(start, i).replace(/\s+/g, ' ').trim()

      if (isStyleRule(prelude, outer)) {
        rules.push({ context: outer.join(' / ') || 'top level', selector: prelude, line })
      }

      outer.push(prelude)
      start = i + 1
    } else if (char === '}') {
      outer.pop()
      start = i + 1
    }
  }

  return rules
}

function repeatedRules(css) {
  const seen = new Map()
  const repeats = []

  for (const rule of cssRules(css)) {
    const key = `${rule.context} | ${rule.selector}`

    if (seen.has(key)) {
      repeats.push(`${rule.selector} (${rule.context}) at lines ${seen.get(key)} and ${rule.line}`)
    } else {
      seen.set(key, rule.line)
    }
  }

  return repeats
}

test('board: one clickable row per PR with its state badges', () => {
  const board = renderBoard(viewContext())

  assert.equal(board.tagName, 'SECTION')
  assert.equal(board.className, 'board')

  const rows = board.querySelectorAll('tr.clickable')
  const states = rows.map((row) => row.children[3])
  const firstBadges = states.map((cell) => one(cell, '.badge'))

  assert.deepEqual(
    rows.map((row) => row.children[1].textContent),
    ['A1', 'A2', 'A3'],
  )

  assert.deepEqual(
    firstBadges.map((badge) => [badge.className, badge.textContent]),
    [
      ['badge state state-verified', 'verified'],
      ['badge state state-implementing', 'implementing'],
      ['badge state state-pending', 'pending'],
    ],
  )

  assert.equal(one(states[0], 'span.badge.held').textContent, 'held')
})

test('header: the rollout name, the running driver and the document title', () => {
  const header = renderHeader(viewContext())

  assert.equal(header.tagName, 'HEADER')
  assert.equal(header.className, 'header')
  assert.equal(one(header, 'h1').textContent, 'demo')
  assert.equal(one(header, 'span.badge.driver.driver-running').textContent, 'running')
  assert.equal(fakeDocument.title, 'demo')
})

test('detail overview: the gate action and its reason', () => {
  const detail = renderDetail(viewContext({ route: { pr: 'A1', tab: 'overview' }, detail: { status: 200, body: prBody } }))

  assert.equal(detail.tagName, 'SECTION')
  assert.equal(detail.className, 'detail')
  assert.ok(texts(detail, 'strong').includes('wait'), 'the gate shows wait')
  assert.ok(texts(detail, 'li').includes('held (rollout release A1)'), 'the gate lists its reason')
})

test('detail verifier: the verdict badge, summary and checklist', () => {
  const detail = renderDetail(viewContext({ route: { pr: 'A1', tab: 'verifier' }, detail: { status: 200, body: prBody } }))

  assert.equal(one(detail, 'span.badge.verdict-pass').textContent, 'PASS')
  assert.ok(texts(detail, 'p.text').includes('Every checklist item holds.'), 'the summary shows')

  const check = detail.querySelectorAll('tr').find((row) => texts(row, 'td').includes('tests pass'))

  assert.ok(check, 'the checklist has the tests pass item')
  assert.equal(one(check, 'td.check-pass').textContent, 'pass')
})

test('detail: an unknown PR shows an error', () => {
  const detail = renderDetail(viewContext({ route: { pr: 'A9' }, detail: { status: 404, body: { error: 'unknown PR' } } }))

  assert.equal(one(detail, 'p.error').textContent, 'Unknown PR')
})

test('transcript: the Bash call, its result, the refused call and the final report', () => {
  const transcript = renderTranscript(viewContext({ route: { run: 'A1-01-implement' }, transcript: { status: 200, body: page } }))

  assert.equal(transcript.tagName, 'SECTION')
  assert.equal(transcript.className, 'transcript')

  const items = transcript.children
  const call = items.findIndex((item) => item.className === 'transcript-tool' && item.querySelector('code')?.textContent === 'npm test')

  assert.ok(call >= 0, 'the npm test call shows')
  assert.equal(one(items[call], 'strong').textContent, 'Bash')

  const result = items[call + 1]

  assert.equal(result.tagName, 'DETAILS')
  assert.equal(result.className, 'transcript-result')
  assert.equal(one(result, 'summary').textContent, 'result of Bash: tests 12, pass 12 (1 line)')

  const refused = one(transcript, 'details.transcript-result.refused')

  assert.equal(one(refused, 'span.badge.refused').textContent, 'guard refused')
  one(transcript, 'div.transcript-final')
})

test('style.css: no two rules share a selector', () => {
  assert.ok(cssRules(STYLE).length > 300, `found ${cssRules(STYLE).length} rules`)
  assert.deepEqual(repeatedRules(STYLE), [])
  assert.deepEqual(
    repeatedRules('button { a: 1 }\nbutton { b: 2 }').map((repeat) => repeat.split(' ')[0]),
    ['button'],
  )

  assert.deepEqual(repeatedRules(':root { a: 1 }\n@media (x) { :root { a: 2 } }\n@font-face { a: 1 }\n@font-face { a: 2 }'), [])
})
