import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifest } from '../lib/manifest.mjs'
import {
  costs,
  isRunName,
  liveness,
  parseEvents,
  parseTranscript,
  prDetail,
  prRows,
  readEvents,
  readTranscript,
  rolloutView,
  runsFromEvents,
} from '../lib/view.mjs'
import { START, at, interruptedTranscript, jsonLines, makeRollout, sampleTranscript } from './fixtures.mjs'

const BIN = fileURLToPath(new URL('../bin/rollout.mjs', import.meta.url))

function start(id, role, run, minute, extra = {}) {
  return { at: at(minute), id, kind: `${role}-start`, run, log: `logs/${run}.jsonl`, effort: 'high', ...extra }
}

function done(id, role, run, minute, extra = {}) {
  return {
    at: at(minute),
    id,
    kind: `${role}-done`,
    run,
    ok: true,
    result: null,
    cost: 1,
    seconds: 60,
    denials: 0,
    stopped: false,
    error: null,
    ...extra,
  }
}

function statuses(runs) {
  return runs.map((run) => `${run.run}:${run.status}`)
}

test('liveness: the lock means running, the heartbeat gives its age and note', () => {
  const dir = makeRollout({ heartbeat: 'tick-error boom' })
  const beat = new Date(START)
  utimesSync(join(dir, 'heartbeat'), beat, beat)

  assert.deepEqual(liveness(loadManifest(dir), START + 42_000), {
    running: true,
    pid: process.pid,
    heartbeatAgeSeconds: 42,
    heartbeatNote: 'tick-error boom',
  })
})

test('liveness: no lock and no heartbeat', () => {
  const M = loadManifest(makeRollout({ lock: false, heartbeat: null }))
  assert.deepEqual(liveness(M), { running: false, pid: null, heartbeatAgeSeconds: null, heartbeatNote: '' })
})

test('parseEvents skips blank lines, partial lines and JSON that is not an object', () => {
  const text = ['{"id":"A1","kind":"held"}', '', '42', 'null', '[1]', '"text"', '{"id":"-","kind":"paused"}', '{"id":"A2","ki'].join('\n')
  assert.deepEqual(
    parseEvents(text).map((event) => event.kind),
    ['held', 'paused'],
  )
})

test('readEvents reads events.jsonl and is empty without it', () => {
  assert.equal(readEvents(loadManifest(makeRollout())).length, 9)
  assert.deepEqual(readEvents(loadManifest(makeRollout({ events: null }))), [])
})

test('runsFromEvents pairs starts and dones by run id', () => {
  const runs = runsFromEvents([
    start('A1', 'implement', 'A1-01-implement', 0),
    start('A2', 'implement', 'A2-01-implement', 1),
    done('A2', 'implement', 'A2-01-implement', 5, { result: 'READY', cost: 2 }),
    done('A1', 'implement', 'A1-01-implement', 9, { result: 'READY', cost: 3, seconds: 540, denials: 2 }),
  ])

  assert.deepEqual(runs[0], {
    run: 'A1-01-implement',
    id: 'A1',
    role: 'implement',
    step: null,
    effort: 'high',
    startedAt: at(0),
    endedAt: at(9),
    seconds: 540,
    costUsd: 3,
    ok: true,
    result: 'READY',
    error: null,
    denials: 2,
    status: 'ok',
  })
  assert.deepEqual(statuses(runs), ['A1-01-implement:ok', 'A2-01-implement:ok'])
})

test('runsFromEvents pairs old events by log name, PR and role', () => {
  const old = (minute) => ({
    at: at(minute),
    id: 'A1',
    kind: 'implement-start',
    effort: 'high',
    resume: false,
    log: 'logs/A1-01-implement.jsonl',
  })
  const runs = runsFromEvents(
    [
      old(0),
      { at: at(4), id: '-', kind: 'driver-start' },
      old(5),
      { at: at(30), id: 'A1', kind: 'implement-done', ok: true, cost: 3, seconds: 1500 },
    ],
    { driverRunning: true },
  )

  assert.deepEqual(statuses(runs), ['A1-01-implement:interrupted', 'A1-01-implement:ok'])
  assert.equal(runs[1].costUsd, 3)
  assert.equal(runs[1].result, null)
  assert.equal(runs[1].denials, 0)
})

test('runsFromEvents: the brief writer and reviewer are two runs', () => {
  const runs = runsFromEvents([
    start('A1', 'brief', 'A1-01-brief-write', 0, { step: 'write' }),
    done('A1', 'brief', 'A1-01-brief-write', 10, { step: 'write', result: 'BRIEF', cost: 1.5 }),
    start('A1', 'brief', 'A1-01-brief-review', 11, { step: 'review' }),
    done('A1', 'brief', 'A1-01-brief-review', 20, { step: 'review', result: 'BRIEF', cost: 2.5 }),
  ])

  assert.deepEqual(
    runs.map((run) => [run.run, run.step, run.costUsd, run.status]),
    [
      ['A1-01-brief-write', 'write', 1.5, 'ok'],
      ['A1-01-brief-review', 'review', 2.5, 'ok'],
    ],
  )
})

test('runsFromEvents: a run without a done is running only while the driver that started it runs', () => {
  const events = [start('A1', 'implement', 'A1-01-implement', 0), start('A2', 'verify', 'A2-02-verify', 1)]
  const restarted = [start('A1', 'fix', 'A1-02-fix', 0), { at: at(1), id: '-', kind: 'driver-start' }, start('A2', 'fix', 'A2-02-fix', 2)]

  assert.deepEqual(statuses(runsFromEvents(events, { driverRunning: true })), ['A1-01-implement:running', 'A2-02-verify:running'])
  assert.deepEqual(statuses(runsFromEvents(events)), ['A1-01-implement:interrupted', 'A2-02-verify:interrupted'])
  assert.deepEqual(statuses(runsFromEvents(restarted, { driverRunning: true })), ['A1-02-fix:interrupted', 'A2-02-fix:running'])
})

test('runsFromEvents: stopped runs are interrupted, other failures failed', () => {
  const runs = runsFromEvents([
    start('A1', 'fix', 'A1-02-fix', 0),
    done('A1', 'fix', 'A1-02-fix', 1, { ok: false, stopped: true, cost: 0, error: 'driver stopping' }),
    start('A2', 'verify', 'A2-02-verify', 2),
    done('A2', 'verify', 'A2-02-verify', 3, { ok: false, error: 'timeout after 60 min' }),
  ])

  assert.deepEqual(statuses(runs), ['A1-02-fix:interrupted', 'A2-02-verify:failed'])
  assert.equal(runs[1].error, 'timeout after 60 min')
  assert.equal(runs[1].ok, false)
})

test('runsFromEvents: a done without a start still counts', () => {
  const runs = runsFromEvents([
    done('A1', 'verify', 'A1-03-verify', 5, { cost: 2 }),
    { at: at(6), id: 'A2', kind: 'fix-done', ok: false, cost: 0.5, seconds: 30 },
  ])

  assert.deepEqual(
    runs.map((run) => [run.run, run.role, run.startedAt, run.endedAt, run.costUsd, run.status]),
    [
      ['A1-03-verify', 'verify', null, at(5), 2, 'ok'],
      [null, 'fix', null, at(6), 0.5, 'failed'],
    ],
  )
})

test('costs: PR totals from the ledger, roles and a cumulative line from runs', () => {
  const M = loadManifest(makeRollout())
  const runs = runsFromEvents([
    start('A1', 'implement', 'A1-01-implement', 0),
    done('A1', 'implement', 'A1-01-implement', 60, { cost: 4.25 }),
    start('A2', 'brief', 'A2-01-brief-write', 1, { step: 'write' }),
    done('A2', 'brief', 'A2-01-brief-write', 20, { cost: 0.1 }),
    start('A2', 'brief', 'A2-01-brief-review', 21, { step: 'review' }),
    done('A2', 'brief', 'A2-01-brief-review', 30, { cost: 0.2 }),
    start('A1', 'verify', 'A1-02-verify', 61),
  ])

  assert.deepEqual(costs(M, { prs: { A1: { costUsd: 4.25 }, A2: { costUsd: 0.3 } } }, runs), {
    totalUsd: 4.55,
    byPr: { A1: 4.25, A2: 0.3, A3: 0 },
    byRole: { brief: 0.3, implement: 4.25, fix: 0, verify: 0 },
    overTime: [
      { at: at(20), totalUsd: 0.1 },
      { at: at(30), totalUsd: 0.3 },
      { at: at(60), totalUsd: 4.55 },
    ],
  })
})

test('prRows: held goes outside approved, and a PR missing from the ledger is fresh', () => {
  const view = rolloutView(loadManifest(makeRollout()))
  const [first, second, third] = view.rows

  assert.equal(first.info, 'held; approved; wait: held (rollout release A1)')
  assert.equal(first.head, 'a1a1a1a')
  assert.equal(first.url, 'https://github.com/example/demo/pull/11')
  assert.equal(first.lastEventAt, at(81))
  assert.equal(first.gate.mergeState, 'CLEAN')
  assert.equal(second.activeRun, 'A2-01-implement')
  assert.deepEqual(second.deps, [{ id: 'A1', state: 'verified' }])
  assert.deepEqual(third, {
    id: 'A3',
    title: 'feat: A3',
    branch: 'feat/a3',
    state: 'pending',
    held: null,
    pr: null,
    url: null,
    head: '-',
    info: '',
    deps: [],
    attempts: { implement: 0, fix: 0, verify: 0, brief: 0 },
    costUsd: 0,
    lastEventAt: null,
    activeRun: null,
    gate: null,
  })
})

test('prRows follows the manifest order and the CLI info rules', () => {
  const M = loadManifest(makeRollout())
  const ledger = {
    prs: {
      A1: { state: 'merged', mergeSha: 'feedface00', attempts: {} },
      A2: { state: 'blocked', blocked: { kind: 'brief-questions', question: 'Which API?' } },
      A3: { state: 'needs_fix', fixReason: 'CI is red', gate: { action: 'fix', reasons: ['x'] } },
    },
  }

  assert.deepEqual(
    prRows(M, ledger, [], []).map((row) => [row.id, row.info]),
    [
      ['A1', 'merged as feedfac'],
      ['A2', 'brief-questions: Which API?'],
      ['A3', 'CI is red'],
    ],
  )
})

test('prDetail: verdicts fall back to the latest verdict for old ledgers', () => {
  const M = loadManifest(makeRollout())
  const verdict = { verdict: 'PASS', sha: 'abc', summary: 'ok' }
  const history = [{ verdict: 'FAIL' }, verdict]
  const verdicts = (state) => prDetail(M, { prs: { A1: state } }, [], [], 'A1').verdicts

  assert.deepEqual(verdicts({ verdict }), [verdict])
  assert.deepEqual(verdicts({ verdict, verdicts: [] }), [verdict])
  assert.deepEqual(verdicts({ verdict, verdicts: history }), history)
  assert.deepEqual(verdicts({}), [])
  assert.equal(prDetail(M, { prs: {} }, [], [], 'Z9'), null)
})

test('prDetail: approval channel, brief paths, feedback and runs', () => {
  const dir = makeRollout()
  const M = loadManifest(dir)
  const onGitHub = { ...M, policy: { ...M.policy, approval: 'github' }, repo: { ...M.repo, maintainers: ['maint'] } }
  const feedback = [{ id: 'c1', body: 'rename this', action: 'renamed', sha: 'abc', at: at(90) }]
  const ledger = { prs: { A1: { author: 'demo-bot', feedbackHandled: feedback }, A2: { author: 'maint' } } }
  const runs = runsFromEvents([start('A1', 'implement', 'A1-01-implement', 0), start('A2', 'implement', 'A2-01-implement', 1)])

  mkdirSync(join(dir, 'briefs'))
  writeFileSync(join(dir, 'briefs', 'A1.md'), '# A1\n')

  const detail = prDetail(onGitHub, ledger, [], runs, 'A1')
  assert.equal(detail.approval, 'github')
  assert.deepEqual(detail.maintainers, ['maint'])
  assert.deepEqual(detail.brief, {
    path: join(dir, 'briefs', 'A1.md'),
    exists: true,
    notesPath: join(dir, 'briefs', 'A1.review-notes.md'),
    notesExist: false,
  })
  assert.deepEqual(detail.feedback, feedback)
  assert.deepEqual(
    detail.runs.map((run) => run.run),
    ['A1-01-implement'],
  )
  assert.equal(prDetail(onGitHub, ledger, [], runs, 'A2').approval, 'inbox')
  assert.equal(prDetail(onGitHub, ledger, [], runs, 'A3').approval, 'github')
  assert.equal(prDetail(M, ledger, [], runs, 'A1').approval, 'inbox')
  assert.equal(prDetail(M, ledger, [], runs, 'A1').merge, 'human')

  for (const merge of ['manual', 'auto']) {
    for (const manifest of [M, onGitHub]) {
      const detail = prDetail({ ...manifest, policy: { ...manifest.policy, merge } }, ledger, [], runs, 'A1')

      assert.equal(detail.approval, null, merge)
      assert.equal(detail.merge, merge)
    }
  }
})

test('parseTranscript: text, tool calls, results, refusals and the final report', () => {
  const { items, final } = parseTranscript(jsonLines([...sampleTranscript(), '{"type":"assis']))

  assert.deepEqual(items, [
    { kind: 'init', model: 'opus', sessionId: 'session-1' },
    { kind: 'text', text: 'Reading the brief.' },
    { kind: 'tool', id: 'tool-1', name: 'Bash', input: { command: 'npm test' }, command: 'npm test' },
    { kind: 'tool-result', toolUseId: 'tool-1', text: 'tests 12, pass 12', isError: false, refused: false },
    { kind: 'tool', id: 'tool-2', name: 'Bash', input: { command: 'gh pr merge 11' }, command: 'gh pr merge 11' },
    { kind: 'tool', id: 'tool-3', name: 'Read', input: { file_path: 'README.md' }, command: null },
    { kind: 'tool-result', toolUseId: 'tool-2', text: 'rollout guard: the driver merges PRs', isError: true, refused: true },
    { kind: 'tool-result', toolUseId: 'tool-3', text: 'line one\n[image]\nline two', isError: false, refused: false },
  ])
  assert.deepEqual(final, {
    ok: true,
    subtype: 'success',
    costUsd: 4.25,
    seconds: 2340,
    turns: 31,
    denials: 1,
    report: { status: 'READY', pr: 11, headSha: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1' },
    text: 'Done.',
  })
})

test('parseTranscript: the init model and no usage for a log without it', () => {
  const { model, usage } = parseTranscript(jsonLines(sampleTranscript()))

  assert.equal(model, 'opus')
  assert.deepEqual(usage, {})
  assert.deepEqual(parseTranscript(''), { items: [], final: null, model: null, usage: {} })
})

test('parseTranscript: usage per model, deduplicated by message, with the output estimated', () => {
  const { final, model, usage } = parseTranscript(jsonLines(interruptedTranscript()))

  assert.equal(final, null)
  assert.equal(model, 'claude-opus-5-5')
  assert.deepEqual(usage, {
    'claude-opus-5-5': { input: 100000, cacheRead: 1000000, cacheWrite5m: 0, cacheWrite1h: 200000, output: 20000 },
    'claude-haiku-4-5-20251001': { input: 10000, cacheRead: 0, cacheWrite5m: 40000, cacheWrite1h: 0, output: 2000 },
  })
})

test('parseTranscript: messages without a model or an id, and thinking without an init', () => {
  const assistant = (message) => ({ type: 'assistant', message: { content: [], ...message } })
  const lines = [
    { type: 'system', subtype: 'thinking_tokens', estimated_tokens_delta: 50 },
    assistant({ model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } }),
    assistant({ model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } }),
    assistant({ usage: { input_tokens: 7 } }),
  ]

  assert.deepEqual(parseTranscript(jsonLines(lines)).usage, {
    'claude-sonnet-5': { input: 20, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 50 },
    unknown: { input: 7, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 },
  })

  const onlyThinking = [{ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }, lines[0]]

  assert.deepEqual(parseTranscript(jsonLines(onlyThinking)).usage, {
    'claude-opus-5-5': { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 50 },
  })
  assert.deepEqual(parseTranscript(jsonLines([lines[0]])).usage, {})
})

test('parseTranscript: the last result wins, and without one there is no final', () => {
  const failed = { type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 1, duration_ms: 1000, num_turns: 3 }
  const passed = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 2,
    duration_ms: 2000,
    num_turns: 5,
    structured_output: {},
  }

  assert.equal(parseTranscript(jsonLines([passed, failed])).final.subtype, 'error_max_turns')
  assert.equal(parseTranscript(jsonLines([passed, failed])).final.ok, false)
  assert.equal(parseTranscript(jsonLines([failed, passed])).final.ok, true)
  assert.equal(parseTranscript(jsonLines([{ ...passed, structured_output: undefined }])).final.ok, false)
  assert.deepEqual(parseTranscript(jsonLines(sampleTranscript().slice(0, 3))).final, null)
})

test('readTranscript reads logs/<run>.jsonl and refuses names outside it', () => {
  const M = loadManifest(makeRollout())

  for (const name of ['../ledger', 'a/b', '.hidden', 'a..b', '', null]) {
    assert.throws(() => readTranscript(M, name), /invalid run name/, String(name))
    assert.equal(isRunName(name), false, String(name))
  }

  assert.equal(isRunName('A1-01-implement'), true)

  assert.equal(readTranscript(M, 'Z9-01-implement'), null)
  assert.equal(readTranscript(M, 'A1-01-implement').final.costUsd, 4.25)
})

test('rolloutView: null without a ledger, the whole model with one', () => {
  assert.equal(rolloutView(loadManifest(makeRollout({ prs: null }))), null)

  const view = rolloutView(loadManifest(makeRollout({ paused: true })))
  assert.equal(view.rollout, 'demo')
  assert.equal(view.merge, 'human')
  assert.equal(view.driver.running, true)
  assert.equal(view.driver.paused, true)
  assert.equal(view.driver.halted, null)
  assert.equal(view.events.length, 9)
  assert.deepEqual(statuses(view.runs), ['A2-01-brief-write:ok', 'A1-01-implement:ok', 'A1-02-verify:ok', 'A2-01-implement:running'])
  assert.equal(view.costs.totalUsd, 7.75)
  assert.deepEqual(view.costs.byRole, { brief: 1.5, implement: 4.25, fix: 0, verify: 2 })
})

function cli(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dirname(BIN) })
}

test('help lists hold, release and preflight', () => {
  const result = cli('help')

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /rollout\.mjs hold \| release <id>/)
  assert.match(result.stdout, /rollout\.mjs preflight/)
})

test('status and card read the fixture, partial events line included', () => {
  const dir = makeRollout()
  const status = cli('status', '--dir', dir)
  const card = cli('card', 'A1', '--dir', dir)

  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /A1 {4}verified {7}#11 {4}a1a1a1a {2}held; approved; wait/)
  assert.match(status.stdout, /A3 {4}pending/)
  assert.match(status.stdout, /recent events:\n[\s\S]*A2 {3}implement-start/)
  assert.equal(card.status, 0, card.stderr)
  assert.match(
    card.stdout,
    /^state: verified {3}PR: https:\/\/github\.com\/example\/demo\/pull\/11 {3}cost: \$6\.25\nheld since 2026-09-01T11:21:00\.000Z \(rollout\.mjs release A1\)$/m,
  )
  assert.match(card.stdout, /verifier: PASS on a1a1a1a/)
})

test('status and card without a ledger, or with an empty events file', () => {
  const bare = makeRollout({ prs: null })
  const quiet = makeRollout({ events: [] })

  assert.match(cli('status', '--dir', bare).stdout, /^no ledger yet in /)
  assert.equal(cli('card', 'A1', '--dir', bare).stdout, 'no state yet\n')
  assert.equal(cli('status', '--dir', quiet).status, 0)
  assert.doesNotMatch(cli('status', '--dir', quiet).stdout, /recent events/)
})
