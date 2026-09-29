// List prices in USD per million tokens, as of September 2026. They only
// estimate runs that reported no cost. Fast mode and long-context rates are
// ignored.
export const PRICES = [
  { prefix: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { prefix: 'claude-mythos-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { prefix: 'claude-fable-5', input: 10, output: 50, cacheRead: 1 },
  { prefix: 'claude-mythos-5', input: 10, output: 50, cacheRead: 1 },
  { prefix: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2 },
  { prefix: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.5 },
  { prefix: 'claude-opus-4-8', input: 5, output: 25, cacheRead: 0.5 },
  { prefix: 'claude-opus-4-7', input: 5, output: 25, cacheRead: 0.5 },
  { prefix: 'claude-opus-4-6', input: 5, output: 25, cacheRead: 0.5 },
  { prefix: 'claude-opus-4-5', input: 5, output: 25, cacheRead: 0.5 },
  { prefix: 'claude-opus-4', input: 15, output: 75, cacheRead: 1.5 },
  { prefix: 'claude-sonnet-5', input: 2, output: 10, cacheRead: 0.2 },
  { prefix: 'claude-sonnet-4', input: 3, output: 15, cacheRead: 0.3 },
  { prefix: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.1 },
]

const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2
const PER_TOKENS = 1_000_000

export function priceOf(model) {
  if (typeof model !== 'string') {
    return null
  }

  const start = model.indexOf('claude-')

  if (start === -1) {
    return null
  }

  const id = model.slice(start)
  let best = null

  for (const price of PRICES) {
    if (id.startsWith(price.prefix) && (!best || price.prefix.length > best.prefix.length)) {
      best = price
    }
  }

  return best
}

function modelCost(price, tokens) {
  const input = tokens.input * price.input
  const cacheRead = tokens.cacheRead * price.cacheRead
  const cacheWrites = tokens.cacheWrite5m * CACHE_WRITE_5M * price.input + tokens.cacheWrite1h * CACHE_WRITE_1H * price.input
  const output = tokens.output * price.output

  return (input + cacheRead + cacheWrites + output) / PER_TOKENS
}

export function estimateCost(usage) {
  const models = Object.entries(usage ?? {})

  if (models.length === 0) {
    return null
  }

  let total = 0

  for (const [model, tokens] of models) {
    const price = priceOf(model)

    if (!price) {
      return null
    }

    total += modelCost(price, tokens)
  }

  return Number(total.toFixed(4))
}
