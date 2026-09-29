import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateCost, priceOf } from '../lib/prices.mjs'

const INTERRUPTED_USAGE = {
  'claude-opus-5-5': { input: 100000, cacheRead: 1000000, cacheWrite5m: 0, cacheWrite1h: 200000, output: 20000 },
  'claude-haiku-4-5-20251001': { input: 10000, cacheRead: 0, cacheWrite5m: 40000, cacheWrite1h: 0, output: 2000 },
}

test('priceOf: the longest prefix wins, dated, regional and suffixed ids resolve', () => {
  const inputs = {
    'claude-opus-5-5': 4,
    'claude-opus-5': 5,
    'claude-opus-4-5-20251101': 5,
    'claude-opus-4-5@20251101': 5,
    'claude-opus-4-6[1m]': 5,
    'claude-opus-4-1-20250805': 15,
    'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 3,
    'claude-sonnet-5-5': 2,
    'claude-haiku-4-5-20251001': 1,
  }

  for (const [model, input] of Object.entries(inputs)) {
    assert.equal(priceOf(model)?.input, input, model)
  }

  assert.equal(priceOf('claude-fable-5-1').cacheRead, 0.25)
  assert.equal(priceOf('claude-fable-5').cacheRead, 1)
  assert.deepEqual(priceOf('claude-opus-5-5'), { prefix: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2 })
})

test('priceOf: null for unknown ids, synthetic messages and non-strings', () => {
  for (const model of ['gpt-4', '<synthetic>', null, undefined, 42, 'claude-instant-1', 'opus']) {
    assert.equal(priceOf(model), null, String(model))
  }
})

test('estimateCost: list prices per model, with both cache write lifetimes', () => {
  assert.equal(estimateCost(INTERRUPTED_USAGE), 2.67)
  assert.equal(estimateCost({ 'claude-opus-5-5': INTERRUPTED_USAGE['claude-opus-5-5'] }), 2.6)
  assert.equal(estimateCost({ 'claude-haiku-4-5': INTERRUPTED_USAGE['claude-haiku-4-5-20251001'] }), 0.07)
})

test('estimateCost: null without models or when one model has no price', () => {
  assert.equal(estimateCost({}), null)
  assert.equal(
    estimateCost({ ...INTERRUPTED_USAGE, unknown: { input: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 } }),
    null,
  )
})
