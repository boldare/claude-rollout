import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RUN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

// Objects from a JSON-lines file. A partial last line (the driver or an
// agent is still appending) and anything that is not an object are skipped.
export function jsonLines(text) {
  const objects = []

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }

    try {
      const value = JSON.parse(line)

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        objects.push(value)
      }
    } catch {
      // Not JSON, or not complete yet.
    }
  }

  return objects
}

function resultText(content) {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content.map((block) => (block?.type === 'text' ? block.text : `[${block?.type}]`)).join('\n')
}

function assistantItems(content) {
  const items = []

  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === 'text') {
      items.push({ kind: 'text', text: part.text })
    } else if (part?.type === 'tool_use') {
      const command = part.name === 'Bash' ? (part.input?.command ?? null) : null
      items.push({ kind: 'tool', id: part.id, name: part.name, input: part.input, command })
    }
  }

  return items
}

function toolResultItems(content) {
  return content
    .filter((part) => part?.type === 'tool_result')
    .map((part) => {
      const text = resultText(part.content)

      return {
        kind: 'tool-result',
        toolUseId: part.tool_use_id,
        text,
        isError: Boolean(part.is_error),
        refused: /rollout guard:/.test(text),
      }
    })
}

function finalOf(line) {
  return {
    ok: succeeded(line),
    subtype: line.subtype ?? null,
    costUsd: line.total_cost_usd ?? 0,
    seconds: Math.round((line.duration_ms ?? 0) / 1000),
    turns: line.num_turns ?? null,
    denials: line.permission_denials?.length ?? 0,
    report: line.structured_output ?? null,
    text: line.result ?? '',
  }
}

// A run succeeds only with a structured report.
export function succeeded(result) {
  return Boolean(result) && !result.is_error && Boolean(result.structured_output)
}

function tokenCount(value) {
  return Number.isFinite(value) ? value : 0
}

// Newer claude versions split cache writes by lifetime. Older ones only give
// the total, which is billed as 5-minute writes.
function lineTokens(usage) {
  const creation = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null

  return {
    input: tokenCount(usage.input_tokens),
    cacheRead: tokenCount(usage.cache_read_input_tokens),
    cacheWrite5m: tokenCount(creation ? creation.ephemeral_5m_input_tokens : usage.cache_creation_input_tokens),
    cacheWrite1h: tokenCount(creation?.ephemeral_1h_input_tokens),
    output: tokenCount(usage.output_tokens),
  }
}

function contentChars(content) {
  let chars = 0

  for (const part of Array.isArray(content) ? content : []) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      chars += part.text.length
    } else if (part?.type === 'tool_use') {
      chars += (JSON.stringify(part.input) ?? '').length
    }
  }

  return chars
}

function emptyTokens() {
  return { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 }
}

function maxTokens(first, second) {
  return Object.fromEntries(Object.keys(first).map((key) => [key, Math.max(first[key], second[key])]))
}

// claude writes one line per content block, and every line of a message
// repeats the usage of the whole message, so lines are grouped by message id.
function addMessage(messages, line, index) {
  const message = line.type === 'assistant' ? line.message : null

  if (!message?.usage || typeof message.usage !== 'object') {
    return
  }

  const key = message.id ?? Symbol(index)
  const known = messages.get(key) ?? { model: null, tokens: emptyTokens(), chars: 0 }

  known.model = known.model ?? message.model ?? null
  known.tokens = maxTokens(known.tokens, lineTokens(message.usage))
  known.chars += contentChars(message.content)
  messages.set(key, known)
}

function counted(messages) {
  return [...messages.values()].filter((message) => Object.values(message.tokens).some((count) => count > 0))
}

// Per-line output_tokens misses thinking and tool input, so the output is
// also estimated from the characters written plus the thinking reported.
function usageOf(messages, thinking, initModel) {
  const totals = {}

  for (const message of counted(messages)) {
    const model = message.model ?? initModel ?? 'unknown'
    const total = totals[model] ?? { ...emptyTokens(), chars: 0, thinking: 0 }

    for (const key of Object.keys(message.tokens)) {
      total[key] += message.tokens[key]
    }

    total.chars += message.chars
    totals[model] = total
  }

  const mainModel = initModel ?? Object.keys(totals)[0] ?? null

  if (mainModel !== null && thinking > 0) {
    totals[mainModel] = totals[mainModel] ?? { ...emptyTokens(), chars: 0, thinking: 0 }
    totals[mainModel].thinking = thinking
  }

  const usage = {}

  for (const [model, { chars, thinking: modelThinking, ...tokens }] of Object.entries(totals)) {
    usage[model] = { ...tokens, output: Math.max(tokens.output, Math.ceil(chars / 4) + modelThinking) }
  }

  return usage
}

// One stream-json agent log, fed a line at a time, so a log that grows is read
// again only from where the last read stopped. Logs written before run ids can
// hold two runs appended to each other, so the last result line wins and the
// first init names the model. result() hands out the parser's own items.
export function transcriptParser() {
  const items = []
  const messages = new Map()
  let final = null
  let model = null
  let initSeen = false
  let thinking = 0
  let count = 0

  function push(line) {
    const index = count

    count += 1
    addMessage(messages, line, index)

    if (line.type === 'system' && line.subtype === 'init') {
      items.push({ kind: 'init', model: line.model ?? null, sessionId: line.session_id ?? null })
      model = initSeen ? model : (line.model ?? null)
      initSeen = true
    } else if (line.type === 'system' && line.subtype === 'thinking_tokens') {
      thinking += tokenCount(line.estimated_tokens_delta)
    } else if (line.type === 'assistant') {
      items.push(...assistantItems(line.message?.content))
    } else if (line.type === 'user' && Array.isArray(line.message?.content)) {
      items.push(...toolResultItems(line.message.content))
    } else if (line.type === 'result') {
      final = finalOf(line)
    }
  }

  function result() {
    return { items, final, model, usage: usageOf(messages, thinking, model) }
  }

  return { push, result }
}

export function parseTranscript(text) {
  const parser = transcriptParser()

  for (const line of jsonLines(text)) {
    parser.push(line)
  }

  return parser.result()
}

// The name may come from an HTTP request, so it must stay inside logs/.
export function isRunName(name) {
  return typeof name === 'string' && RUN_NAME.test(name) && !name.includes('..')
}

export function readTranscript(manifest, run) {
  if (!isRunName(run)) {
    throw new Error('invalid run name')
  }

  const file = join(manifest.dir, 'logs', `${run}.jsonl`)

  return existsSync(file) ? parseTranscript(readFileSync(file, 'utf8')) : null
}
