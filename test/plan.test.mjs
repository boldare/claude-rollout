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

  assert.equal(section.heading, 'P1 `feat: the data model`')
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

test('planSection: a PR prefix and emphasis around the id, a list marker in the excerpt', () => {
  assert.equal(planSection(PLAN, 'P2').heading, '**PR P2**: rules')
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
