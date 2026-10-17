import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planSection, planSources, prPlan, prPlans, prSourceTitles, prsWithoutPlan } from '../lib/plan.mjs'

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

const LEADS = [
  '# Plan',
  '',
  '## PRs',
  '',
  '**S1 · Contract v0** (–)',
  '- **Scope:** `spec/**`.',
  '- **What:**',
  '  - the rules.',
  '',
  'More about S1.',
  '',
  '**S2 `feat/rules` „feat: rules”** (S1)',
  'The rules in TS.',
  '',
  '**Order:** S1 first.',
  '',
  '**S3 `docs/start`**: `index.html`, `start.html`.',
  '',
  '## Later',
  'Nothing for S3.',
].join('\n')

test('planSection: a bold paragraph that opens with the id runs to the next bold paragraph or heading', () => {
  assert.deepEqual(planSection(LEADS, 'S1'), {
    heading: 'S1 · Contract v0',
    text: '(–)\n- **Scope:** `spec/**`.\n- **What:**\n  - the rules.\n\nMore about S1.',
    excerpt: 'Scope: spec/**.',
  })

  assert.deepEqual(planSection(LEADS, 'S2'), {
    heading: 'S2 feat/rules „feat: rules”',
    text: '(S1)\nThe rules in TS.',
    excerpt: 'The rules in TS.',
  })

  assert.deepEqual(planSection(LEADS, 'S3'), {
    heading: 'S3 docs/start',
    text: '`index.html`, `start.html`.',
    excerpt: 'index.html, start.html.',
  })
})

test('planSection: a list item that opens with the id in bold runs to the next item at its level', () => {
  const text = [
    '## PR breakdown',
    '',
    '- **U1 (driver).** The driver changes,',
    'with fixtures.',
    '  - a nested point.',
    '',
    '  A paragraph of the item.',
    '- **U2 (server).** The server.',
    '1. **U3** a numbered item.',
    '',
    'After the list.',
    '',
    '* __U4__: underscores.',
    '',
    '```sh',
    'npm test',
    '```',
  ].join('\n')

  assert.deepEqual(planSection(text, 'U1'), {
    heading: 'U1 (driver)',
    text: 'The driver changes,\nwith fixtures.\n  - a nested point.\n\n  A paragraph of the item.',
    excerpt: 'The driver changes,',
  })

  assert.equal(planSection(text, 'U2').text, 'The server.')
  assert.equal(planSection(text, 'U3').text, 'a numbered item.')
  assert.deepEqual(planSection(text, 'U4'), { heading: 'U4', text: 'underscores.', excerpt: 'underscores.' })
})

test('planSection: bold inside a paragraph, an id that does not open the bold, or bold in a fence is no lead', () => {
  assert.equal(planSection('Some text\n**P1** goes on here.', 'P1'), null)
  assert.equal(planSection('1. **No absolute paths (F1).** In the data.', 'F1'), null)
  assert.equal(planSection('```md\n**P1** inside\n```', 'P1'), null)
  assert.equal(planSection('**P10** not it', 'P1'), null)
  assert.equal(planSection('Intro.\n\n**P1** after a blank line.', 'P1').text, 'after a blank line.')
})

test('planSection: a heading wins over a bold lead that names the PR first', () => {
  const text = ['- **P1** the summary', '- **P2** the other', '', '## P1 the slice', 'Body.'].join('\n')

  assert.deepEqual(planSection(text, 'P1'), { heading: 'P1 the slice', text: 'Body.', excerpt: 'Body.' })
  assert.equal(planSection(text, 'P2').text, 'the other')
})

test('prPlan and prPlans: one slice per source of the PR, skipping other tags and missing files', () => {
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
    all: [{ id: 'A1', briefTags: ['track'] }, { id: 'A2' }, { id: 'A3' }],
  }

  assert.deepEqual(
    prPlan(manifest, { id: 'A1', briefTags: ['track'] }).map((slice) => slice.source),
    ['Track'],
  )

  assert.deepEqual(prPlan(manifest, { id: 'A1' }), [])
  assert.deepEqual(prPlan(manifest, { id: 'A2' }), [{ source: 'Plan', heading: 'A2', text: 'From the plan.', excerpt: 'From the plan.' }])
  assert.deepEqual(prPlan({}, { id: 'A1' }), [])

  assert.deepEqual(
    [...prPlans(manifest)].map(([id, slices]) => [id, slices.map((slice) => slice.source)]),
    [
      ['A1', ['Track']],
      ['A2', ['Plan']],
      ['A3', []],
    ],
  )

  assert.deepEqual(prSourceTitles(manifest, { id: 'A1', briefTags: ['track'] }), ['Gone', 'Track', 'Plan'])
  assert.deepEqual(prSourceTitles(manifest, { id: 'A2' }), ['Gone', 'Plan'])

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

function planDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-plan-'))

  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text)
  }

  return dir
}

test("prPlan: a source with a tag only this PR lists is the PR's in full, after its section in the main plan", () => {
  const dir = planDir({
    'plan.md': '# Plan\n\n### H4: the tick\nOne call never stops it.\n',
    'h4.md': '# Addendum for H4\n\nA PR merged while the gate looks at it.\n',
    'h11.md': '\n# Plan addendum: the delegate (H11)\n\nThe delegate answers.\n',
    'notes.md': 'Notes without a heading.\n',
    'shared.md': '# Shared track\n\nFor two PRs.\n',
    'inside.md': '# Addendum\n\nIntro.\n\n## H12 the gate\nThe slice.\n',
  })

  const source = (name, tag) => ({ title: `Source ${name}`, path: join(dir, name), kind: 'markdown', tag })
  const manifest = {
    briefing: {
      sources: [
        source('plan.md'),
        source('h4.md', 'h4extra'),
        source('h11.md', 'delegate'),
        source('notes.md', 'notes'),
        source('shared.md', 'shared'),
        source('inside.md', 'scanning'),
      ],
    },
    all: [
      { id: 'H4', briefTags: ['h4extra', 'shared'] },
      { id: 'H11', briefTags: ['delegate', 'notes'] },
      { id: 'H12', briefTags: ['scanning', 'shared'] },
    ],
  }

  const slices = (id) =>
    prPlan(
      manifest,
      manifest.all.find((pr) => pr.id === id),
    )

  assert.deepEqual(slices('H4'), [
    { source: 'Source plan.md', heading: 'H4: the tick', text: 'One call never stops it.', excerpt: 'One call never stops it.' },
    {
      source: 'Source h4.md',
      heading: 'Addendum for H4',
      text: 'A PR merged while the gate looks at it.',
      excerpt: 'A PR merged while the gate looks at it.',
    },
  ])

  assert.deepEqual(
    slices('H11').map((slice) => [slice.source, slice.heading, slice.text]),
    [
      ['Source h11.md', 'Plan addendum: the delegate (H11)', 'The delegate answers.'],
      ['Source notes.md', 'Source notes.md', 'Notes without a heading.'],
    ],
  )

  assert.deepEqual(
    slices('H12').map((slice) => [slice.source, slice.heading, slice.text]),
    [['Source inside.md', 'H12 the gate', 'The slice.']],
  )

  assert.deepEqual(
    [...prPlans(manifest)].map(([id, plan]) => [id, plan.length]),
    [
      ['H4', 2],
      ['H11', 2],
      ['H12', 1],
    ],
  )
})

test('prsWithoutPlan: the PRs of this run without a slice, and none without briefing sources', () => {
  const dir = planDir({ 'plan.md': '# Plan\n\n**A1** the first.\n' })
  const all = [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }]
  const briefing = { sources: [{ title: 'Plan', path: join(dir, 'plan.md'), kind: 'markdown' }] }

  assert.deepEqual(prsWithoutPlan({ briefing, all, prs: all }), ['A2', 'A3'])
  assert.deepEqual(prsWithoutPlan({ briefing, all, prs: [all[0], all[2]] }), ['A3'])
  assert.deepEqual(prsWithoutPlan({ all, prs: all }), [])
})
