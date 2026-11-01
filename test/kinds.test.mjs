import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { ERROR_KINDS, EVENT_KINDS, STATES, errorCount } from '../lib/kinds.mjs'
import { ERROR_KINDS as UI_ERROR_KINDS, STATES as UI_STATES } from '../ui/model.js'

const LIB = new URL('../lib/', import.meta.url)
// say( and ledger.event( take the kind second, a bare log( takes it first. A call can span lines.
const KIND_CALL =
  /(?<![\w.])(?:say|ledger\.event)\(\s*[^,()]+,\s*('[^']*'|`[^`]*`|[A-Za-z_$][\w$.]*)|(?<![\w.])log\(\s*('[^']*'|`[^`]*`|[A-Za-z_$][\w$.]*)/g

const ANY_CALL = /(?<![\w.])(?:say|ledger\.event|log)\(/g
const SPECIFIERS = [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g, /^\s*import\s*['"]([^'"]+)['"]/gm]

// Every kind lib builds at runtime, with all the values it can take. Under
// policy.merge manual, mergeCandidate turns merge into ready. A bare `kind`
// is `${step}-failed` from driverStep. The definition of say, say's own
// ledger.event and the notifier's log callback only forward theirs.
const BUILT_KINDS = {
  '`${role}-start`': ['implement-start', 'fix-start', 'verify-start'],
  '`${role}-done`': ['implement-done', 'fix-done', 'verify-done'],
  '`gate-${verdict.action}`': ['gate-block', 'gate-fix', 'gate-merge', 'gate-ready', 'gate-rebase', 'gate-wait'],
  kind: ['fetch-failed', 'outside-deps-failed', 'watch-base-failed'],
}

function libFiles() {
  return readdirSync(LIB)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => ({ file: `lib/${name}`, text: readFileSync(new URL(name, LIB), 'utf8') }))
}

function isQuoted(kind) {
  return kind.startsWith("'")
}

// The kind expression of every say(, ledger.event( and bare log( call, per file.
function scan() {
  return libFiles().map(({ file, text }) => ({
    file,
    counted: text.match(ANY_CALL)?.length ?? 0,
    kinds: [...text.matchAll(KIND_CALL)].map((match) => match[1] ?? match[2]),
  }))
}

function writtenKinds() {
  const written = new Set()

  for (const { kinds } of scan()) {
    for (const kind of kinds) {
      if (isQuoted(kind)) {
        written.add(kind.slice(1, -1))
      } else if (Object.hasOwn(BUILT_KINDS, kind)) {
        BUILT_KINDS[kind].forEach((value) => written.add(value))
      }
    }
  }

  return written
}

test('kinds: the states and error kinds', () => {
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

  assert.deepEqual(ERROR_KINDS, [
    'tick-error',
    'error',
    'on-done-error',
    'reply-failed',
    'manifest-rejected',
    'fetch-failed',
    'outside-deps-failed',
    'watch-base-failed',
    'github-unavailable',
    'report-unchecked',
  ])
})

test('kinds: ui/model.js mirrors the states and error kinds of lib', () => {
  assert.deepEqual(UI_STATES, STATES)
  assert.deepEqual(UI_ERROR_KINDS, ERROR_KINDS)
})

test('kinds: every kind lib writes is in EVENT_KINDS', () => {
  const files = scan()

  assert.ok(files.reduce((sum, { counted }) => sum + counted, 0) > 0, 'the scan finds no calls')

  for (const { file, counted, kinds } of files) {
    assert.equal(kinds.length, counted, `${file}: the scan cannot read the kind of a say(, ledger.event( or log( call`)

    for (const kind of kinds) {
      if (isQuoted(kind)) {
        assert.ok(EVENT_KINDS.includes(kind.slice(1, -1)), `${file} writes ${kind}, which EVENT_KINDS does not list`)
        continue
      }

      assert.ok(Object.hasOwn(BUILT_KINDS, kind), `${file} writes the kind ${kind}, which BUILT_KINDS does not list`)

      for (const value of BUILT_KINDS[kind]) {
        assert.ok(EVENT_KINDS.includes(value), `${file} writes ${value} through ${kind}, which EVENT_KINDS does not list`)
      }
    }
  }
})

test('kinds: EVENT_KINDS is sorted, lists no kind lib never writes, and holds every error kind', () => {
  const written = writtenKinds()

  assert.deepEqual(
    EVENT_KINDS.filter((kind) => !written.has(kind)),
    [],
    'kinds no file in lib/ writes',
  )

  assert.deepEqual(
    ERROR_KINDS.filter((kind) => !EVENT_KINDS.includes(kind)),
    [],
  )

  assert.deepEqual(EVENT_KINDS, [...EVENT_KINDS].sort())
})

test('kinds: lib never imports from ui/', () => {
  let specifiers = 0

  for (const { file, text } of libFiles()) {
    for (const pattern of SPECIFIERS) {
      for (const [, specifier] of text.matchAll(pattern)) {
        specifiers += 1
        assert.ok(!specifier.includes('ui/'), `${file} imports ${specifier}`)
      }
    }
  }

  assert.ok(specifiers > 0, 'the scan finds no imports')
})

test('kinds: errorCount counts only error kinds', () => {
  const events = [...ERROR_KINDS, 'merged', 'tick', 'errors', 'merge-unconfirmed', 'github-back'].map((kind) => ({ id: '-', kind }))

  assert.equal(errorCount(events), 10)
  assert.equal(errorCount([]), 0)
})
