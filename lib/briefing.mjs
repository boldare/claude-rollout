import { readFileSync, statSync } from 'node:fs'
import { expandHome } from './sh.mjs'

// Source material for brief writers: the plan (markdown) and design notes
// kept in agent transcripts (JSONL, where the last assistant text is the design).
// A transcript can be large, so the text is cached. The manifest reloads every
// tick and an edited plan must reach the next brief too, so every read checks
// the file's size and mtime first.
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
      // A partial line. Skip it.
    }
  }

  return last ?? ''
}

export function sourceText(source) {
  const path = expandHome(source.path)
  const key = `${source.kind}:${path}`

  const stat = statSync(path, { throwIfNoEntry: false })

  if (!stat) {
    throw new Error(`briefing source missing: ${path}`)
  }

  const cached = cache.get(key)

  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.text
  }

  const text = source.kind === 'transcript' ? lastAssistantText(path) : readFileSync(path, 'utf8')

  cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, text })

  return text
}

// The sources a PR's brief writer gets: every untagged source plus the ones
// whose tag the PR lists (e.g. the design notes of its track).
export function sourcesFor(manifest, pr) {
  const sources = manifest.briefing?.sources ?? []

  return sources
    .filter((source) => !source.tag || (pr.briefTags ?? []).includes(source.tag))
    .map((source) => `### ${source.title ?? source.path}\n\n${sourceText(source)}`)
    .join('\n\n---\n\n')
}
