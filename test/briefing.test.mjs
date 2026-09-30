import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourcesFor, sourceText } from '../lib/briefing.mjs'

const dir = mkdtempSync(join(tmpdir(), 'rollout-brief-'))
const transcript = join(dir, 'agent.jsonl')
const plan = join(dir, 'plan.md')
const long = (label) => `${label} ${'x'.repeat(300)}`

writeFileSync(plan, '# Plan\n')
writeFileSync(
  transcript,
  [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: long('early draft') }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'noise' }] } }),
    '{"partial": ',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: long('final design') }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'short ack' }] } }),
  ].join('\n'),
)

test('a transcript source is its last substantial assistant text', () => {
  assert.match(sourceText({ path: transcript, kind: 'transcript' }), /^final design/)
})

test('PRs get untagged sources plus the ones for their tags', () => {
  const M = {
    briefing: {
      sources: [
        { title: 'Plan', path: plan, kind: 'markdown' },
        { title: 'Track A', path: transcript, kind: 'transcript', tag: 'A' },
      ],
    },
  }

  assert.match(sourcesFor(M, { briefTags: ['A'] }), /### Plan[\s\S]*### Track A/)
  assert.doesNotMatch(sourcesFor(M, { briefTags: ['B'] }), /Track A/)
})

test('a markdown source rewritten with a different length is read again', () => {
  const path = join(dir, 'resized.md')

  writeFileSync(path, '# Plan v1\n')
  assert.equal(sourceText({ path, kind: 'markdown' }), '# Plan v1\n')

  writeFileSync(path, '# Plan v2, longer\n')
  assert.equal(sourceText({ path, kind: 'markdown' }), '# Plan v2, longer\n')
})

test('a same-size source is read again only when its mtime changes', () => {
  const path = join(dir, 'same-size.md')
  const first = new Date('2026-01-01T10:00:00Z')
  const second = new Date('2026-01-01T11:00:00Z')

  writeFileSync(path, 'v1')
  utimesSync(path, first, first)
  assert.equal(sourceText({ path, kind: 'markdown' }), 'v1')

  writeFileSync(path, 'v2')
  utimesSync(path, first, first)
  assert.equal(sourceText({ path, kind: 'markdown' }), 'v1')

  utimesSync(path, second, second)
  assert.equal(sourceText({ path, kind: 'markdown' }), 'v2')
})

test('a transcript that grows returns its latest design', () => {
  const path = join(dir, 'growing.jsonl')
  const entry = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

  writeFileSync(path, `${entry(long('first design'))}\n`)
  assert.match(sourceText({ path, kind: 'transcript' }), /^first design/)

  appendFileSync(path, `${entry(long('second design'))}\n`)
  assert.match(sourceText({ path, kind: 'transcript' }), /^second design/)
})

test('a source removed after a read is missing', () => {
  const path = join(dir, 'removed.md')

  writeFileSync(path, '# Gone soon\n')
  sourceText({ path, kind: 'markdown' })
  rmSync(path)

  assert.throws(() => sourceText({ path, kind: 'markdown' }), /briefing source missing/)
})
