import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
