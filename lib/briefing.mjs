import { existsSync, readFileSync } from 'node:fs'
import { expandHome } from './sh.mjs'

// Source material for brief writers: the plan (markdown) and design notes
// kept in agent transcripts (JSONL; the last assistant text is the design).
const cache = new Map()

function lastAssistantText(path) {
  let last = null

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) {
      continue
    }

    try {
      const entry = JSON.parse(line)

      for (const part of entry.message?.content ?? []) {
        if (entry.type === 'assistant' && part?.type === 'text' && part.text.length > 200) {
          last = part.text
        }
      }
    } catch {
      // A partial line; skip it.
    }
  }

  return last ?? ''
}

export function sourceText(source) {
  const path = expandHome(source.path)
  const key = `${source.kind}:${path}`

  if (!cache.has(key)) {
    if (!existsSync(path)) {
      throw new Error(`briefing source missing: ${path}`)
    }

    cache.set(key, source.kind === 'transcript' ? lastAssistantText(path) : readFileSync(path, 'utf8'))
  }

  return cache.get(key)
}

// The sources a PR's brief writer gets: every untagged source plus the ones
// whose tag the PR lists (e.g. the design notes of its track).
export function sourcesFor(M, pr) {
  const sources = M.briefing?.sources ?? []

  return sources
    .filter((source) => !source.tag || (pr.briefTags ?? []).includes(source.tag))
    .map((source) => `### ${source.title ?? source.path}\n\n${sourceText(source)}`)
    .join('\n\n---\n\n')
}
