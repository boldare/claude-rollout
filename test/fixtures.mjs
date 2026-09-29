import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { freshPr } from '../lib/ledger.mjs'

// A synthetic rollout directory. Every part can be overridden, and null
// leaves the file out.

export const START = Date.parse('2026-09-01T10:00:00.000Z')

export function at(minutes) {
  return new Date(START + minutes * 60_000).toISOString()
}

const SHA = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'

export function samplePrs() {
  const verdict = {
    verdict: 'PASS',
    sha: SHA,
    summary: 'Every checklist item holds.',
    checklist: [{ item: 'tests pass', status: 'pass', evidence: 'npm test: 12 pass' }],
    blocking: [],
    nonBlocking: [],
    at: at(80),
    run: 'A1-02-verify',
  }

  return {
    A1: {
      state: 'verified',
      attempts: { implement: 1, fix: 0, verify: 0, brief: 0 },
      pr: 11,
      author: 'demo-bot',
      claimedSha: SHA,
      verified: { sha: SHA, patchId: 'patch-a1', at: at(80) },
      approved: { sha: SHA, patchId: 'patch-a1', at: at(81) },
      gate: { action: 'wait', reasons: ['held (rollout release A1)'], mergeState: 'CLEAN', sha: SHA, at: at(82) },
      verdict,
      verdicts: [verdict],
      held: { at: at(81) },
      costUsd: 6.25,
    },
    A2: {
      state: 'implementing',
      attempts: { implement: 1, fix: 0, verify: 0, brief: 1 },
      costUsd: 1.5,
    },
  }
}

export function sampleEvents() {
  return [
    { at: at(0), id: '-', kind: 'driver-start', prs: ['A1', 'A2', 'A3'], dryRun: false, merge: 'human', pid: 1 },
    { at: at(1), id: 'A2', kind: 'brief-start', effort: 'xhigh', log: 'logs/A2-01-brief-write.jsonl' },
    { at: at(20), id: 'A2', kind: 'brief-done', ok: true, cost: 1.5, seconds: 1140 },
    {
      at: at(21),
      id: 'A1',
      kind: 'implement-start',
      run: 'A1-01-implement',
      log: 'logs/A1-01-implement.jsonl',
      effort: 'high',
      resume: false,
    },
    {
      at: at(60),
      id: 'A1',
      kind: 'implement-done',
      run: 'A1-01-implement',
      ok: true,
      result: 'READY',
      cost: 4.25,
      seconds: 2340,
      denials: 1,
      stopped: false,
      error: null,
    },
    { at: at(61), id: 'A1', kind: 'verify-start', run: 'A1-02-verify', log: 'logs/A1-02-verify.jsonl', effort: 'high', resume: false },
    {
      at: at(80),
      id: 'A1',
      kind: 'verify-done',
      run: 'A1-02-verify',
      ok: true,
      result: 'PASS',
      cost: 2,
      seconds: 1140,
      denials: 0,
      stopped: false,
      error: null,
    },
    { at: at(81), id: 'A1', kind: 'held', state: 'verified', running: null },
    {
      at: at(82),
      id: 'A2',
      kind: 'implement-start',
      run: 'A2-01-implement',
      log: 'logs/A2-01-implement.jsonl',
      effort: 'high',
      resume: false,
    },
    // The driver is still appending this line.
    '{"at":"2026-09-01T11:23:00.000Z","id":"A2","ki',
  ]
}

// One stream-json agent log, as `claude -p --output-format stream-json` writes it.
export function sampleTranscript() {
  return [
    { type: 'system', subtype: 'init', model: 'opus', session_id: 'session-1' },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Plan the work.' },
          { type: 'text', text: 'Reading the brief.' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tests 12, pass 12' }] } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'gh pr merge 11' } },
          { type: 'tool_use', id: 'tool-3', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-2', is_error: true, content: 'rollout guard: the driver merges PRs' }],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-3',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'image', source: { type: 'base64', data: '' } },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
      },
    },
    { type: 'user', message: { content: 'a prompt as plain text' } },
    { type: 'rate_limit_event', status: 'allowed' },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 4.25,
      duration_ms: 2_340_400,
      num_turns: 31,
      permission_denials: [{ tool_name: 'Bash' }],
      structured_output: { status: 'READY', pr: 11, headSha: SHA },
      result: 'Done.',
    },
  ]
}

export function jsonLines(lines) {
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')
}

function manifest(dir, policy) {
  const effort = { implement: 'high', verify: 'high' }
  const pr = (id, extra = {}) => ({
    id,
    branch: `feat/${id.toLowerCase()}`,
    title: `feat: ${id}`,
    brief: `briefs/${id}.md`,
    effort,
    changeset: 'none',
    ...extra,
  })

  return {
    rollout: 'demo',
    repo: { path: join(dir, 'repo'), github: 'example/demo', requiredChecks: ['test'] },
    policy,
    briefing: { sources: [{ title: 'Plan', path: join(dir, 'plan.md'), kind: 'markdown' }] },
    prs: [pr('A1'), pr('A2', { deps: ['A1'] }), pr('A3')],
  }
}

export function makeRollout(overrides = {}) {
  const options = {
    prs: samplePrs(),
    paused: false,
    halted: null,
    events: sampleEvents(),
    heartbeat: 'tick',
    lock: true,
    logs: { 'A1-01-implement': [...sampleTranscript(), '{"type":"assis'], 'A1-02-verify': sampleTranscript().slice(0, 1) },
    policy: {},
    ...overrides,
  }
  const dir = mkdtempSync(join(tmpdir(), 'rollout-'))

  mkdirSync(join(dir, 'repo'))
  mkdirSync(join(dir, 'logs'))
  writeFileSync(join(dir, 'plan.md'), '# Plan\n')
  writeFileSync(join(dir, 'manifest.yaml'), stringify(manifest(dir, options.policy)))

  if (options.prs) {
    const prs = Object.fromEntries(Object.entries(options.prs).map(([id, state]) => [id, { ...freshPr(), ...state }]))
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ prs, paused: options.paused, halted: options.halted }, null, 2))
  }

  if (options.events) {
    writeFileSync(join(dir, 'events.jsonl'), jsonLines(options.events))
  }

  if (options.heartbeat !== null) {
    writeFileSync(join(dir, 'heartbeat'), `${new Date().toISOString()} ${options.heartbeat}`.trim())
  }

  if (options.lock) {
    writeFileSync(join(dir, 'driver.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  }

  for (const [name, lines] of Object.entries(options.logs ?? {})) {
    writeFileSync(join(dir, 'logs', `${name}.jsonl`), jsonLines(lines))
  }

  return dir
}
