import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planSection, planSources, prPlan } from '../lib/plan.mjs'

const PLAN = [
  '# Plan',
  '',
  'Intro.',
  '',
  '## PRs',
  '',
  '### P1 `feat: the data model`',
  '',
  'Why: every other PR needs it.',
  '```sh',
  '# not a heading',
  '```',
  '#### Acceptance',
  'Migrations apply twice.',
  '',
  '### P10 feat: the about page',
  '',
  '- What: a static page.',
  '',
  '## **PR P2**: rules',
  'Pure functions.',
  '',
  '### P3-extra is not P3',
  '',
  '### P4',
].join('\n')

test('planSection: the section runs to the next heading of the same or a higher level', () => {
  const section = planSection(PLAN, 'P1')

  assert.equal(section.heading, 'P1 feat: the data model')
  assert.match(section.text, /^Why: every other PR needs it\./)
  assert.match(section.text, /#### Acceptance\nMigrations apply twice\.$/)
  assert.doesNotMatch(section.text, /P10/)
  assert.equal(section.excerpt, 'Why: every other PR needs it.')
})

test('planSection: P1 never matches P10 or P3-extra, and a heading inside a fence never counts', () => {
  assert.equal(planSection(PLAN, 'P10').heading, 'P10 feat: the about page')
  assert.equal(planSection(PLAN, 'P3'), null)
  assert.equal(planSection(PLAN, 'not'), null)
})

test('planSection: P1 never matches P1.1, but "P1." is P1', () => {
  assert.equal(planSection('## P1.1 the sub-slice\nA\n\n## P1 the slice\nB', 'P1').text, 'B')
  assert.equal(planSection('## P1. the slice\nB', 'P1').heading, 'P1. the slice')
})

test('planSection: a fence closes only on a fence as long as its own, and ```a``` is no fence', () => {
  const nested = ['````md', '```', '## P1 inside', '```', '````', '## P1 outside', 'Body.'].join('\n')

  assert.equal(planSection(nested, 'P1').heading, 'P1 outside')
  assert.equal(planSection('```inline``` code\n## P1\nBody.', 'P1').text, 'Body.')
  assert.equal(planSection('~~~\n## P1 inside\n```\n~~~\n## P1 outside', 'P1').heading, 'P1 outside')
})

test('planSection: a # inside the heading stays, closing hashes go, and 4 spaces of indent is no heading', () => {
  assert.equal(planSection('## P1 the C# client\nBody.', 'P1').heading, 'P1 the C# client')
  assert.equal(planSection('## P1 the slice ##\nBody.', 'P1').heading, 'P1 the slice')
  assert.equal(planSection('   ## P1 indented\nBody.', 'P1').heading, 'P1 indented')
  assert.equal(planSection('    ## P1 code\nBody.', 'P1'), null)
})

test('planSection: the excerpt skips headings, code and rules, and drops the markdown', () => {
  const text = [
    '## P1',
    '',
    '#### Acceptance',
    '```ts',
    'const x = 1',
    '```',
    '---',
    '> **Why:** it comes _first_, see [the spec](spec.md).',
  ].join('\n')

  assert.equal(planSection(text, 'P1').excerpt, 'Why: it comes first, see the spec.')
  assert.equal(planSection('## P1\n\n1. Ship `snake_case` names', 'P1').excerpt, 'Ship snake_case names')
  assert.equal(planSection('## P1\n```sh\nnpm test\n```', 'P1').excerpt, null)
})

test('planSection: a numeric id, as YAML reads `id: 3`', () => {
  assert.equal(planSection('## 3 the third\nBody.', 3).heading, '3 the third')
  assert.equal(planSection('## 30 not it', 3), null)
})

test('planSection: a PR prefix and emphasis around the id, the heading as plain text, a list marker in the excerpt', () => {
  assert.equal(planSection(PLAN, 'P2').heading, 'PR P2: rules')
  assert.equal(planSection(PLAN, 'P2').excerpt, 'Pure functions.')
  assert.equal(planSection(PLAN, 'P10').excerpt, 'What: a static page.')
})

test('planSection: an empty section has no excerpt, and a long first line is cut', () => {
  assert.deepEqual(planSection(PLAN, 'P4'), { heading: 'P4', text: '', excerpt: null })

  const long = planSection(`## P5\n\n${'word '.repeat(60)}`, 'P5')
  assert.equal(long.excerpt.length, 160)
  assert.ok(long.excerpt.endsWith('…'))
})

test('prPlan: the first source of the PR with a section, skipping other tags and missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-plan-'))
  const main = join(dir, 'plan.md')
  const track = join(dir, 'track.md')

  writeFileSync(main, '# Plan\n\n## A2\nFrom the plan.\n')
  writeFileSync(track, '# Track\n\n## A1\nFrom the track.\n\n## A2\nFrom the track.\n')

  const manifest = {
    briefing: {
      sources: [
        { title: 'Gone', path: join(dir, 'gone.md'), kind: 'markdown' },
        { title: 'Track', path: track, kind: 'markdown', tag: 'track' },
        { title: 'Plan', path: main, kind: 'markdown' },
      ],
    },
  }

  assert.equal(prPlan(manifest, { id: 'A1', briefTags: ['track'] }).source, 'Track')
  assert.equal(prPlan(manifest, { id: 'A1' }), null)
  assert.deepEqual(prPlan(manifest, { id: 'A2' }), { source: 'Plan', heading: 'A2', text: 'From the plan.', excerpt: 'From the plan.' })
  assert.equal(prPlan({}, { id: 'A1' }), null)

  const sources = planSources(manifest)
  assert.deepEqual(
    sources.map((source) => [source.title, source.tag, source.text === null, Boolean(source.error)]),
    [
      ['Gone', null, true, true],
      ['Track', 'track', false, false],
      ['Plan', null, false, false],
    ],
  )
})
