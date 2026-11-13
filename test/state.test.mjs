import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  ACTORS,
  CHANNELS,
  COMMANDS,
  FIX_REASONS,
  GATE_BLOCK_CODES,
  QUESTION_KINDS,
  ROLES,
  STAGES,
  STAGE_STATUSES,
  STATUS_KINDS,
  WAY_OUT,
} from '../lib/state.ts'

const OPEN_STAGES = STAGES.filter((stage) => stage !== 'merged')

function duplicates(list) {
  return list.filter((item, index) => list.indexOf(item) !== index)
}

function codeLists() {
  return OPEN_STAGES.flatMap((stage) => STATUS_KINDS.map((kind) => [`${stage} ${kind}`, STAGE_STATUSES[stage][kind]]))
}

test('state: no list spells a value twice', () => {
  const named = Object.entries({ STAGES, STATUS_KINDS, ROLES, ACTORS, CHANNELS, FIX_REASONS, QUESTION_KINDS, GATE_BLOCK_CODES, COMMANDS })

  for (const [name, list] of [...named, ...codeLists()]) {
    assert.deepEqual(duplicates(list), [], name)
  }
})

test('state: every open stage has a code of each kind, and no other key', () => {
  assert.deepEqual(Object.keys(STAGE_STATUSES), OPEN_STAGES)

  for (const stage of OPEN_STAGES) {
    assert.deepEqual(Object.keys(STAGE_STATUSES[stage]), [...STATUS_KINDS], stage)
  }

  for (const [name, list] of codeLists()) {
    assert.ok(list.length > 0, `${name} has no code`)
  }
})

test('state: WAY_OUT names exactly the needs-you codes of STAGE_STATUSES', () => {
  const needsYou = new Set(OPEN_STAGES.flatMap((stage) => STAGE_STATUSES[stage]['needs-you']))

  assert.deepEqual(Object.keys(WAY_OUT).sort(), [...needsYou].sort())
})

test('state: there are 15 fix reasons', () => {
  assert.equal(FIX_REASONS.length, 15)
})

test('state: Node imports the types with no flag and no warning', () => {
  const url = new URL('../lib/state.ts', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(url)})`], { encoding: 'utf8' })

  assert.equal(child.stderr, '')
  assert.equal(child.status, 0)
})
