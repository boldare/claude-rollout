import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STAGE_PREFIX, STATUS_PREFIX, labelChanges, ourLabel, stageLabels } from '../lib/stage.mjs'
import { at } from './fixtures.mjs'

function entry(stage, status, pr = 11) {
  return { pr, stage, status: status && { since: at(0), ...status } }
}

test('stageLabels: the stage and the status code of an open PR', () => {
  assert.deepEqual(stageLabels(entry('verify', { kind: 'needs-you', code: 'dispute', findings: ['F1'], text: '' })), [
    'rollout-stage:verify',
    'rollout-status:dispute',
  ])

  assert.deepEqual(stageLabels(entry('merge', { kind: 'waiting', code: 'queued', after: 12 })), [
    'rollout-stage:merge',
    'rollout-status:queued',
  ])

  assert.deepEqual(stageLabels(entry('pre-verify', { kind: 'running', code: 'commands', sha: 'abc' })), [
    'rollout-stage:pre-verify',
    'rollout-status:commands',
  ])

  assert.deepEqual([STAGE_PREFIX, STATUS_PREFIX], ['rollout-stage:', 'rollout-status:'])
})

test('stageLabels: the stage alone when the status has no code', () => {
  assert.deepEqual(stageLabels(entry('implement', null)), ['rollout-stage:implement'])
})

test('stageLabels: nothing for a PR with no number, a merged PR or an entry with no stage', () => {
  assert.deepEqual(stageLabels(entry('implement', { kind: 'running', code: 'implement', run: 'A1-01-implement' }, null)), [])
  assert.deepEqual(stageLabels(entry('brief', { kind: 'waiting', code: 'slot' }, null)), [])
  assert.deepEqual(stageLabels({ pr: 11, stage: 'merged', status: null }), [])
  assert.deepEqual(stageLabels({ pr: 11, state: 'verified' }), [])
})

test('ourLabel: the stage and status prefixes, and the reason prefix of older drivers', () => {
  for (const label of ['rollout-stage:merge', 'rollout-status:approve', 'rollout-stage:needs-fix', 'rollout-reason:ci-is-red']) {
    assert.ok(ourLabel(label), label)
  }

  for (const label of ['rollout:demo', 'bug', 'rollout-statuses', 'stage:merge']) {
    assert.ok(!ourLabel(label), label)
  }
})

test('labelChanges: adds the missing, removes our stale labels, the old stage and reason ones included', () => {
  const current = ['rollout:demo', 'rollout-stage:needs-fix', 'rollout-reason:verifier-findings', 'rollout-status:slot', 'bug']

  assert.deepEqual(labelChanges(current, ['rollout-stage:verify', 'rollout-status:verify']), {
    add: ['rollout-stage:verify', 'rollout-status:verify'],
    remove: ['rollout-stage:needs-fix', 'rollout-reason:verifier-findings', 'rollout-status:slot'],
  })

  assert.deepEqual(labelChanges(['rollout-stage:merge', 'rollout-status:approve'], ['rollout-stage:merge', 'rollout-status:approve']), {
    add: [],
    remove: [],
  })

  assert.deepEqual(labelChanges(['rollout-stage:merge', 'rollout-status:approve', 'bug'], []), {
    add: [],
    remove: ['rollout-stage:merge', 'rollout-status:approve'],
  })
})
