import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labelChanges, slug, stageLabels } from '../lib/stage.mjs'

test('stageLabels: nothing before the PR exists or after it merged', () => {
  assert.deepEqual(stageLabels({ state: 'briefing', pr: null }), [])
  assert.deepEqual(stageLabels({ state: 'implementing', pr: null }), [])
  assert.deepEqual(stageLabels({ state: 'merged', pr: 11 }), [])
})

test('stageLabels: the stage alone while the PR moves on its own', () => {
  assert.deepEqual(stageLabels({ state: 'verifying', pr: 11 }), ['rollout-stage:verifying'])
  assert.deepEqual(stageLabels({ state: 'ready_claimed', pr: 11 }), ['rollout-stage:ready-claimed'])
  assert.deepEqual(stageLabels({ state: 'verified', pr: 11, fixReason: 'CI is red' }), ['rollout-stage:verified'])
})

test('stageLabels: a PR sent back says why, for the fix run too', () => {
  const rejected = { state: 'needs_fix', pr: 11, fixReason: 'verifier findings' }

  assert.deepEqual(stageLabels(rejected), ['rollout-stage:needs-fix', 'rollout-reason:verifier-findings'])
  assert.deepEqual(stageLabels({ ...rejected, state: 'fixing' }), ['rollout-stage:fixing', 'rollout-reason:verifier-findings'])
  assert.deepEqual(stageLabels({ state: 'needs_fix', pr: 11, fixReason: 'CI is red' })[1], 'rollout-reason:ci-is-red')
})

test('stageLabels: a blocked PR names the kind of block', () => {
  assert.deepEqual(stageLabels({ state: 'blocked', pr: 11, blocked: { kind: 'brief-questions' } }), [
    'rollout-stage:blocked',
    'rollout-reason:brief-questions',
  ])
})

test('stageLabels: an escalated PR says what escalated it, never a block answered earlier', () => {
  const escalated = { state: 'escalated', pr: 11, blocked: { kind: 'needs-decision' } }

  assert.deepEqual(stageLabels({ ...escalated, escalation: 'fix attempts exhausted' }), [
    'rollout-stage:escalated',
    'rollout-reason:fix-attempts-exhausted',
  ])
  assert.deepEqual(stageLabels({ ...escalated, escalation: 'repeated errors' })[1], 'rollout-reason:repeated-errors')
  assert.deepEqual(stageLabels(escalated), ['rollout-stage:escalated'])
})

test('slug: lower case, dashes, at most 40 characters and no trailing dash', () => {
  assert.equal(slug('Report does not match GitHub'), 'report-does-not-match-github')
  assert.equal(slug('a'.repeat(39) + ' b'), 'a'.repeat(39))
  assert.equal(slug(undefined), '')
})

test('labelChanges: adds the missing, removes only our stale labels', () => {
  const current = ['rollout:demo', 'rollout-stage:needs-fix', 'rollout-reason:ci-is-red', 'bug']

  assert.deepEqual(labelChanges(current, ['rollout-stage:verifying']), {
    add: ['rollout-stage:verifying'],
    remove: ['rollout-stage:needs-fix', 'rollout-reason:ci-is-red'],
  })
  assert.deepEqual(labelChanges(['rollout-stage:verified'], ['rollout-stage:verified']), { add: [], remove: [] })
})
