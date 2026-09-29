import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifest } from '../lib/manifest.mjs'
import { rolloutView, runsFromEvents } from '../lib/view.mjs'
import { duration, money } from '../ui/format.js'
import { ERROR_KINDS, STATES, driverStatus, errorCount, eventDetail, filterEvents, mergeEvents, stateCounts } from '../ui/model.js'
import { parseSse } from '../ui/sse.js'
import { MARKERS, timelineLayout } from '../ui/timeline-layout.js'
import { START, at, makeRollout } from './fixtures.mjs'

const UI = fileURLToPath(new URL('../ui/', import.meta.url))
const TOLERANCE = 1e-9

const FORBIDDEN_IN_SCRIPTS = [
  /innerHTML/,
  /outerHTML/,
  /insertAdjacentHTML/,
  /document\.write/,
  /\beval\(/,
  /new Function/,
  /setAttribute\(\s*['"]style/,
  /localStorage/,
  /sessionStorage/,
  /document\.cookie/,
  /new EventSource/,
]

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < TOLERANCE, `${label}: ${actual} is not ${expected}`)
}

function demo() {
  const view = rolloutView(loadManifest(makeRollout()))

  return { view, now: START + 100 * 60_000 }
}

function demoLayout(extraEvents = []) {
  const { view, now } = demo()

  return timelineLayout({ rows: view.rows, runs: view.runs, events: [...view.events, ...extraEvents], now, live: true })
}

function barOf(lane, role) {
  const bar = lane.bars.find((item) => item.role === role)
  assert.ok(bar, `${lane.id} has a ${role} bar`)

  return bar
}

function laneOf(layout, id) {
  return layout.lanes.find((lane) => lane.id === id)
}

function uiScripts() {
  return readdirSync(UI).filter((file) => file.endsWith('.js'))
}

test('parseSse: two messages in one chunk', () => {
  const { messages, rest } = parseSse('event: state\ndata: {"a":1}\n\nevent: events\ndata: {"from":0}\n\n')

  assert.deepEqual(messages, [
    { event: 'state', data: { a: 1 } },
    { event: 'events', data: { from: 0 } },
  ])
  assert.equal(rest, '')
})

test('parseSse: a message split across two calls carries the rest over', () => {
  const first = parseSse('event: state\ndata: {"na')

  assert.deepEqual(first.messages, [])
  assert.equal(first.rest, 'event: state\ndata: {"na')

  const second = parseSse(`${first.rest}me":"demo"}\n\nevent: ev`)

  assert.deepEqual(second.messages, [{ event: 'state', data: { name: 'demo' } }])
  assert.equal(second.rest, 'event: ev')
})

test('parseSse: a ping comment is ignored and the event defaults to message', () => {
  const { messages } = parseSse(': ping\n\ndata: 1\n\n: note\nevent: problem\ndata: {"error":"x"}\n\n')

  assert.deepEqual(messages, [
    { event: 'message', data: 1 },
    { event: 'problem', data: { error: 'x' } },
  ])
})

test('parseSse: data lines are joined with a newline, one space after the colon is removed', () => {
  const { messages } = parseSse('event: state\ndata: {"a":\ndata:  1}\n\ndata:"tight"\n\n')

  assert.deepEqual(messages, [
    { event: 'state', data: { a: 1 } },
    { event: 'message', data: 'tight' },
  ])
})

test('parseSse: invalid JSON and a message without data are dropped', () => {
  const { messages, rest } = parseSse('event: state\ndata: {not json\n\nevent: state\n\nevent: events\ndata: []\n\n')

  assert.deepEqual(messages, [{ event: 'events', data: [] }])
  assert.equal(rest, '')
})

test('mergeEvents: appends, replaces and truncates without touching the input', () => {
  const current = [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }]
  const copy = structuredClone(current)

  assert.deepEqual(
    mergeEvents(current, { from: 3, events: [{ kind: 'd' }] }).map((event) => event.kind),
    ['a', 'b', 'c', 'd'],
  )
  assert.deepEqual(
    mergeEvents(current, { from: 0, events: [{ kind: 'x' }] }).map((event) => event.kind),
    ['x'],
  )
  assert.deepEqual(
    mergeEvents(current, { from: 1, events: [{ kind: 'y' }] }).map((event) => event.kind),
    ['a', 'y'],
  )
  assert.deepEqual(current, copy)
})

test('model: the states and error kinds', () => {
  assert.deepEqual(STATES, [
    'pending',
    'briefing',
    'implementing',
    'ready_claimed',
    'verifying',
    'verified',
    'needs_fix',
    'fixing',
    'blocked',
    'escalated',
    'interrupted',
    'merged',
  ])
  assert.deepEqual(ERROR_KINDS, ['tick-error', 'error', 'on-done-error', 'reply-failed', 'manifest-rejected'])
})

test('errorCount: counts only error kinds', () => {
  const events = [...ERROR_KINDS, 'merged', 'tick', 'errors'].map((kind) => ({ id: '-', kind }))

  assert.equal(errorCount(events), 5)
  assert.equal(errorCount([]), 0)
})

test('driverStatus: halted, paused, running, stopped and unknown', () => {
  assert.equal(driverStatus({ running: true, paused: true, halted: 'out of budget' }), 'halted')
  assert.equal(driverStatus({ running: true, paused: true, halted: null }), 'paused')
  assert.equal(driverStatus({ running: true, paused: false, halted: null }), 'running')
  assert.equal(driverStatus({ running: false, paused: false, halted: null }), 'stopped')
  assert.equal(driverStatus(null), 'unknown')
})

test('stateCounts: known states in lifecycle order, then unknown ones sorted', () => {
  const rows = ['merged', 'zeta', 'pending', 'merged', 'alpha', 'implementing'].map((state) => ({ state }))

  assert.deepEqual(stateCounts(rows), [
    { state: 'pending', count: 1 },
    { state: 'implementing', count: 1 },
    { state: 'merged', count: 2 },
    { state: 'alpha', count: 1 },
    { state: 'zeta', count: 1 },
  ])
  assert.deepEqual(stateCounts([]), [])
})

test('filterEvents: by PR, driver events and error kinds, newest first', () => {
  const events = [
    { at: at(0), id: '-', kind: 'driver-start' },
    { at: at(1), id: 'A1', kind: 'implement-start' },
    { at: at(2), id: '-', kind: 'tick-error' },
    { at: at(3), id: 'A1', kind: 'error' },
    { at: at(4), id: 'A2', kind: 'implement-start' },
  ]
  const copy = structuredClone(events)
  const minutes = (list) => list.map((event) => event.at)

  assert.deepEqual(minutes(filterEvents(events)), [at(4), at(3), at(2), at(1), at(0)])
  assert.deepEqual(minutes(filterEvents(events, { id: '-' })), [at(2), at(0)])
  assert.deepEqual(minutes(filterEvents(events, { kind: 'errors' })), [at(3), at(2)])
  assert.deepEqual(minutes(filterEvents(events, { id: 'A1', kind: 'errors' })), [at(3)])
  assert.deepEqual(minutes(filterEvents(events, { kind: 'implement-start' })), [at(4), at(1)])
  assert.notEqual(filterEvents(events), events)
  assert.deepEqual(events, copy)
})

test('eventDetail: every other field as key=value, skipping null and cutting long values', () => {
  assert.equal(eventDetail({ at: at(0), id: 'A1', kind: 'merged', pr: 11, sha: 'abc1234' }), 'pr=11 sha=abc1234')
  assert.equal(eventDetail({ at: at(0), id: 'A1', kind: 'x', error: null, gone: undefined, ok: false }), 'ok=false')
  assert.equal(eventDetail({ id: '-', kind: 'driver-start', prs: ['A1', 'A2'], opts: { dry: true } }), 'prs=["A1","A2"] opts={"dry":true}')
  assert.equal(eventDetail({ id: '-', kind: 'x' }), '')

  const long = eventDetail({ id: 'A1', kind: 'x', note: 'n'.repeat(250) })

  assert.equal(long, `note=${'n'.repeat(200)}…`)
})

test('timelineLayout: the demo rollout', () => {
  const layout = demoLayout()
  const [a1, a2, a3] = layout.lanes

  assert.deepEqual(
    layout.lanes.map((lane) => lane.id),
    ['A1', 'A2', 'A3'],
  )
  assert.equal(layout.start, START)
  assert.equal(layout.end, START + 100 * 60_000)

  near(barOf(a1, 'implement').left, 0.21, 'A1 implement left')
  near(barOf(a1, 'implement').width, 0.39, 'A1 implement width')
  near(barOf(a1, 'verify').left, 0.61, 'A1 verify left')
  near(barOf(a1, 'verify').width, 0.19, 'A1 verify width')
  near(barOf(a2, 'brief').left, 0.01, 'A2 brief left')
  near(barOf(a2, 'brief').width, 0.19, 'A2 brief width')

  const running = barOf(a2, 'implement')

  assert.equal(running.status, 'running')
  assert.equal(running.run, 'A2-01-implement')
  near(running.left, 0.82, 'A2 implement left')
  near(running.width, 0.18, 'A2 implement width')

  assert.deepEqual(a3.bars, [])
  assert.deepEqual(a3.markers, [])
  assert.equal(layout.restarts.length, 1)
  near(layout.restarts[0].left, 0, 'restart left')
})

test('timelineLayout: rebase and merge markers', () => {
  const layout = demoLayout([
    { at: at(90), id: 'A1', kind: 'rebased', sha: 'b2b2b2b' },
    { at: at(95), id: 'A1', kind: 'merged', pr: 11 },
    { at: at(96), id: 'Z9', kind: 'merged', pr: 12 },
    { id: 'A1', kind: 'ready-claimed' },
  ])
  const markers = laneOf(layout, 'A1').markers

  assert.deepEqual(
    markers.map((marker) => marker.type),
    ['rebase', 'merge'],
  )
  assert.deepEqual(
    markers.map((marker) => marker.at),
    [at(90), at(95)],
  )
  near(markers[0].left, 0.9, 'rebase left')
  near(markers[1].left, 0.95, 'merge left')
  assert.deepEqual(laneOf(layout, 'A2').markers, [])
})

test('timelineLayout: every marker kind maps to a type', () => {
  assert.deepEqual(MARKERS, {
    'ready-claimed': 'ready',
    'ready-to-merge': 'ready',
    rebased: 'rebase',
    'review-feedback': 'feedback',
    merged: 'merge',
    'merged-outside-driver': 'merge',
    'merged-outside-run': 'merge',
  })
})

test('timelineLayout: an interrupted run ends at the next driver start', () => {
  const events = [
    { at: at(0), id: '-', kind: 'driver-start' },
    { at: at(5), id: 'A1', kind: 'implement-start', run: 'A1-01-implement' },
    { at: at(30), id: '-', kind: 'driver-start' },
    { at: at(31), id: 'A1', kind: 'fix-start', run: 'A1-02-fix' },
    { at: at(40), id: 'A1', kind: 'fix-done', run: 'A1-02-fix', ok: true },
  ]
  const runs = runsFromEvents(events, { driverRunning: false })
  const layout = timelineLayout({ rows: [{ id: 'A1' }], runs, events, now: Date.parse(at(100)), live: false })
  const [interrupted, fix] = layout.lanes[0].bars

  assert.equal(layout.start, Date.parse(at(0)))
  assert.equal(layout.end, Date.parse(at(40)))
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.to, Date.parse(at(30)))
  near(interrupted.left, 0.125, 'interrupted left')
  near(interrupted.width, 0.625, 'interrupted width')
  assert.equal(fix.role, 'fix')
  near(fix.left, 0.775, 'fix left')
  near(fix.width, 0.225, 'fix width')
  assert.deepEqual(
    layout.restarts.map((restart) => restart.left),
    [0, 0.75],
  )
})

test('timelineLayout: an interrupted run without a later driver start ends at the end', () => {
  const events = [
    { at: at(0), id: '-', kind: 'driver-start' },
    { at: at(10), id: 'A1', kind: 'implement-start', run: 'A1-01-implement' },
    { at: at(20), id: 'A1', kind: 'note' },
  ]
  const runs = runsFromEvents(events, { driverRunning: false })
  const layout = timelineLayout({ rows: [{ id: 'A1' }], runs, events, now: Date.parse(at(100)), live: false })
  const [bar] = layout.lanes[0].bars

  assert.equal(bar.to, Date.parse(at(20)))
  near(bar.left, 0.5, 'left')
  near(bar.width, 0.5, 'width')
})

test('timelineLayout: no times at all gives one empty lane per row', () => {
  const events = [
    { id: 'A1', kind: 'merged' },
    { id: '-', kind: 'driver-start', at: 'not a time' },
  ]
  const runs = [{ run: 'A1-01-implement', id: 'A1', role: 'implement', step: null, startedAt: null, endedAt: null, status: 'ok' }]
  const layout = timelineLayout({ rows: [{ id: 'A1' }, { id: 'A2' }], runs, events, now: START, live: true })

  assert.deepEqual(layout, {
    start: null,
    end: null,
    lanes: [
      { id: 'A1', bars: [], markers: [] },
      { id: 'A2', bars: [], markers: [] },
    ],
    restarts: [],
  })
})

test('timelineLayout: a single instant still spans a second, and bars stay inside the track', () => {
  const events = [{ at: at(0), id: 'A1', kind: 'implement-start', run: 'A1-01-implement' }]
  const runs = runsFromEvents(events, { driverRunning: true })
  const layout = timelineLayout({ rows: [{ id: 'A1' }], runs, events, now: START - 60_000, live: true })
  const [bar] = layout.lanes[0].bars

  assert.equal(layout.end, START + 1000)
  assert.equal(bar.left, 0)
  assert.equal(bar.width, 0)
})

test('format: money and duration', () => {
  assert.equal(money(4.25), '$4.25')
  assert.equal(money(0), '$0.00')
  assert.equal(money(null), '-')
  assert.equal(money(undefined), '-')
  assert.equal(duration(45), '45s')
  assert.equal(duration(2340), '39m')
  assert.equal(duration(3900), '1h 05m')
  assert.equal(duration(59.9), '59s')
  assert.equal(duration(null), '-')
})

test('ui scripts: no HTML sinks, eval, style attributes, browser storage or the SSE client', () => {
  const scripts = uiScripts()

  assert.ok(scripts.includes('app.js'))

  for (const file of scripts) {
    const source = readFileSync(join(UI, file), 'utf8')

    for (const pattern of FORBIDDEN_IN_SCRIPTS) {
      assert.doesNotMatch(source, pattern, `${file} matches ${pattern}`)
    }
  }
})

test('ui index.html: no inline script or style, no style or handler attributes', () => {
  const html = readFileSync(join(UI, 'index.html'), 'utf8')

  assert.doesNotMatch(html, /<style/i)
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i)
  assert.doesNotMatch(html, / style=/i)
  assert.doesNotMatch(html, / on[a-z]+=/i)
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/)
})
