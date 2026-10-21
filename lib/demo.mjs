import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { freshPr } from './ledger.mjs'

// rollout ui --demo: made-up rollouts in a temp directory, so the UI can be
// shown without a real one. The names, paths and texts are invented. Each
// driver lock names the UI server's own process, so the drivers read as
// running and Stop can never signal anything (see signalablePid).
const MODEL = 'claude-opus-5-5'
const MINUTE = 60_000
const REFRESH_MS = 20_000
const LIVE_RUN = { rollout: 'my-lib-1.2.0', run: 'P3-01-implement' }
const DELEGATE = { kinds: ['needs-decision', 'brief-questions'], maxPerPr: 2 }
const RUNNING = ['my-lib-1.2.0', 'edge-states']

function shaOf(seed) {
  return seed.repeat(40).slice(0, 40)
}

function lines(count) {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n')
}

function prOf(id, title, deps = []) {
  return {
    id,
    branch: `feat/${id.toLowerCase()}`,
    title,
    brief: `briefs/${id}.md`,
    effort: { implement: 'xhigh', verify: 'xhigh' },
    changeset: 'none',
    deps,
  }
}

function init(session) {
  return { type: 'system', subtype: 'init', model: MODEL, session_id: session }
}

function tool(id, name, input) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }
}

function result(id, content, isError = false) {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } }
}

function text(value) {
  return { type: 'assistant', message: { content: [{ type: 'text', text: value }] } }
}

function final(cost, seconds, status, denials = 0) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: cost,
    duration_ms: seconds * 1000,
    num_turns: 30,
    permission_denials: Array.from({ length: denials }, () => ({ tool_name: 'Bash' })),
    structured_output: { status },
    result: status,
  }
}

function jsonLines(items) {
  return `${items.map((item) => JSON.stringify(item)).join('\n')}\n`
}

// Minutes before the demo started, as the timestamps a driver would have written.
function clockOf(now) {
  return (minutes) => new Date(now - minutes * MINUTE).toISOString()
}

function runEvents(ago) {
  const start = (id, role, run, minutes, extra = {}) => ({
    at: ago(minutes),
    id,
    kind: `${role}-start`,
    run,
    log: `logs/${run}.jsonl`,
    effort: 'xhigh',
    model: MODEL,
    resume: false,
    ...extra,
  })

  const done = (id, role, run, minutes, outcome, cost, seconds) => ({
    at: ago(minutes),
    id,
    kind: `${role}-done`,
    run,
    ok: true,
    result: outcome,
    cost,
    seconds,
    denials: 0,
    stopped: false,
    error: null,
  })

  return { start, done }
}

function writeRollout(root, { name, prs, ledger, events = [], logs = {}, files = {}, policy = {}, pid = null }) {
  const dir = join(root, name)

  mkdirSync(join(dir, 'repo'), { recursive: true })
  mkdirSync(join(dir, 'logs'))
  mkdirSync(join(dir, 'briefs'))

  const manifest = {
    rollout: name,
    repo: { path: join(dir, 'repo'), github: 'example/my-lib', requiredChecks: ['test'] },
    policy: { merge: 'human', ...policy },
    briefing: { sources: [{ title: 'Plan', path: join(dir, 'plan.md'), kind: 'markdown' }] },
    prs,
  }

  const entries = Object.fromEntries(Object.entries(ledger).map(([id, state]) => [id, { ...freshPr(), ...state }]))

  writeFileSync(join(dir, 'manifest.yaml'), stringify(manifest))
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ prs: entries, paused: false, halted: null }, null, 2))
  writeFileSync(join(dir, 'events.jsonl'), jsonLines(events))
  writeFileSync(join(dir, 'plan.md'), files.plan ?? '# Plan\n')

  for (const [file, content] of Object.entries(files.briefs ?? {})) {
    writeFileSync(join(dir, 'briefs', file), content)
  }

  for (const [run, items] of Object.entries(logs)) {
    writeFileSync(join(dir, 'logs', `${run}.jsonl`), jsonLines(items))
  }

  if (pid !== null) {
    writeFileSync(join(dir, 'driver.lock'), JSON.stringify({ pid, at: new Date().toISOString() }))
    writeFileSync(join(dir, 'heartbeat'), `${new Date().toISOString()} tick`)
  }
}

const MY_LIB_PRS = [
  prOf('P1', 'feat: config loader'),
  prOf('P2', 'feat: cli flags', ['P1']),
  prOf('P3', 'docs: config reference'),
  prOf('P4', 'feat: watch mode', ['P2', 'P3']),
  prOf('P5', 'feat: plugin hooks', ['P1']),
  prOf('P6', 'fix: retry on timeout'),
]

const MY_LIB_PLAN = `# my-lib 1.2: configuration

The release adds a config file, flags for every key, a reference page, a watch mode, plugin hooks and retries.

### P1 config loader

Load my-lib.config.yaml from the working directory or the nearest parent, validate it against the schema and expose it as loadConfig().

### P2 cli flags

Every config key gets a flag. Flags win over the file, the file wins over the defaults.

### P3 config reference

A reference page for every config key and flag, generated from the schema so it cannot drift.

### P4 watch mode

my-lib watch runs again on every file change, with the config and flags from P1 and P2.

### P5 plugin hooks

Plugins register before, after and error hooks. Hooks run in the order the config lists the plugins.

### P6 retry on timeout

Requests that time out are retried with backoff, as connection resets already are.
`

const P2_BRIEF = `# P2 feat: cli flags

## Goal

Every key of the config schema gets a command-line flag. A flag wins over the file, and the file wins over the defaults.

## Acceptance

- [x] \`my-lib --help\` lists every flag with its default.
- [x] A flag overrides the same key from my-lib.config.yaml.
- [ ] The README shows the order: flags, file, defaults.
`

const QUESTION = 'Should a hook that throws stop the run?'

function myLibLedger(ago) {
  return {
    P1: {
      state: 'merged',
      pr: 41,
      attempts: { brief: 1, implement: 1, fix: 0, verify: 1 },
      costUsd: 9.8,
      mergeSha: shaOf('3f2a9c1'),
      verified: { sha: shaOf('1'), patchId: 'p1', at: ago(170) },
      approved: { sha: shaOf('1'), patchId: 'p1', at: ago(160) },
    },
    P2: {
      state: 'verified',
      pr: 42,
      attempts: { brief: 1, implement: 1, fix: 0, verify: 1 },
      costUsd: 9.69,
      claimedSha: shaOf('9c4e1b2'),
      verified: { sha: shaOf('9c4e1b2'), patchId: 'p2', at: ago(36) },
      gate: {
        action: 'wait',
        reasons: ['awaiting a maintainer review on GitHub (approve PR #42)'],
        mergeState: 'BLOCKED',
        sha: shaOf('9c4e1b2'),
        at: ago(19),
      },
      verdict: {
        verdict: 'PASS',
        sha: shaOf('9c4e1b2'),
        summary: 'Every flag parses, wins over the file and shows in --help.',
        checklist: [
          { item: 'tests pass', status: 'pass', evidence: 'npm test: 214 lines, 0 failing' },
          { item: 'flags win over the file', status: 'pass', evidence: '--port 9 over port: 8 in the file' },
        ],
        blocking: [],
        nonBlocking: ['The README does not show the order of flags, file and defaults yet.'],
        at: ago(36),
        run: 'P2-02-verify',
      },
    },
    P3: { state: 'implementing', attempts: { brief: 1, implement: 1, fix: 0, verify: 0 }, costUsd: 1.95 },
    P4: { state: 'pending' },
    P5: {
      state: 'blocked',
      pr: 45,
      attempts: { brief: 0, implement: 1, fix: 0, verify: 0 },
      costUsd: 3.1,
      blocked: {
        kind: 'needs-decision',
        question: QUESTION,
        evidence:
          'The plan calls hooks "best effort" in section 3 and "part of the stage" in the P5 section. A hook that throws either fails the stage, or is logged and skipped.',
      },
      delegate: {
        runs: 1,
        lastQuestion: null,
        limitNotified: false,
        answers: [
          {
            at: ago(7),
            kind: 'needs-decision',
            question: QUESTION,
            decision: 'escalate',
            answer: '',
            planRefs: [],
            reasoning: 'the plan does not decide',
            run: 'P5-02-delegate',
          },
        ],
      },
    },
    P6: {
      state: 'fixing',
      pr: 44,
      attempts: { brief: 0, implement: 1, fix: 1, verify: 0 },
      costUsd: 4.4,
      fixReason: 'answer from the maintainer',
      noteHistory: [{ at: ago(3), by: 'maintainer', kind: 'needs-decision', text: 'Retry three times.' }],
    },
  }
}

function myLibEvents(ago, pid) {
  const { start, done } = runEvents(ago)

  return [
    { at: ago(200), id: '-', kind: 'driver-start', prs: MY_LIB_PRS.map((pr) => pr.id), dryRun: false, merge: 'human', pid },
    start('P1', 'implement', 'P1-01-implement', 199),
    done('P1', 'implement', 'P1-01-implement', 175, 'READY', 7.1, 1440),
    start('P1', 'verify', 'P1-02-verify', 174),
    done('P1', 'verify', 'P1-02-verify', 170, 'PASS', 2.7, 240),
    { at: ago(156), id: 'P1', kind: 'merged', sha: shaOf('3f2a9c1') },
    start('P2', 'implement', 'P2-01-implement', 120),
    done('P2', 'implement', 'P2-01-implement', 58, 'READY', 7.85, 3700),
    start('P2', 'verify', 'P2-02-verify', 57),
    done('P2', 'verify', 'P2-02-verify', 36, 'PASS', 1.84, 1260),
    { at: ago(19), id: 'P2', kind: 'gate', action: 'wait' },
    start('P3', 'implement', 'P3-01-implement', 34),
    start('P5', 'implement', 'P5-01-implement', 60),
    done('P5', 'implement', 'P5-01-implement', 8, 'BLOCKED', 3.1, 3100),
    { at: ago(8), id: 'P5', kind: 'blocked', reason: 'needs-decision' },
    start('P5', 'delegate', 'P5-02-delegate', 8, { effort: 'high', blocked: 'needs-decision' }),
    done('P5', 'delegate', 'P5-02-delegate', 7, null, 0.2, 60),
    start('P6', 'fix', 'P6-02-fix', 2, { resume: true }),
  ]
}

function myLibLogs() {
  return {
    'P2-02-verify': [
      init('demo-p2'),
      tool('t1', 'Bash', { command: 'npm test' }),
      result('t1', lines(214)),
      tool('t2', 'Bash', { command: 'node bin/my-lib.mjs --help' }),
      result('t2', lines(38)),
      text('PASS: all 14 flags parse, win over the file and show in --help.'),
      final(1.84, 1260, 'PASS'),
    ],
    'P3-01-implement': [
      init('demo-p3'),
      tool('t1', 'Read', { file_path: 'lib/config/schema.mjs' }),
      result('t1', lines(148)),
      tool('t2', 'Bash', { command: 'node scripts/config-docs.mjs --out docs/config.md' }),
      result('t2', lines(2)),
      tool('t3', 'Edit', { file_path: 'docs/config.md' }),
      result('t3', 'ok'),
      tool('t4', 'Bash', { command: 'npm test -- test/docs.test.mjs' }),
      result('t4', '# fail 1\nnot ok 3 - --watch has a key', true),
      text('One flag in the reference has no key in the schema yet, --watch. P4 adds it, so I leave it out and say so in the PR.'),
    ],
    'P5-01-implement': [
      init('demo-p5'),
      tool('t1', 'Grep', { pattern: 'best effort', path: 'docs/plan.md' }),
      result('t1', lines(3)),
      tool('t2', 'Read', { file_path: 'lib/hooks.mjs' }),
      result('t2', lines(92)),
      tool('t3', 'Bash', { command: 'gh pr merge 45' }),
      result('t3', 'rollout guard: the driver merges PRs', true),
      text('The plan says two different things about a hook that throws. I ask before I pick one.'),
      final(3.1, 3100, 'BLOCKED', 1),
    ],
    'P6-02-fix': [
      init('demo-p6'),
      text('The maintainer answered: retry three times with backoff.'),
      tool('t1', 'Edit', { file_path: 'lib/http/retry.mjs' }),
      result('t1', 'The file lib/http/retry.mjs has been updated successfully.'),
      tool('t2', 'Bash', { command: 'npm test -- test/retry.test.mjs' }),
    ],
  }
}

const EDGE_PRS = [
  prOf('E1', 'fix: flaky cache test'),
  prOf('E2', 'feat: export csv'),
  prOf('E3', 'feat: dark mode'),
  prOf('E4', 'feat: plugin api'),
  prOf('E5', 'chore: bump deps'),
]

function edgeLedger(ago) {
  return {
    E1: {
      state: 'escalated',
      pr: 51,
      attempts: { brief: 1, implement: 1, fix: 3, verify: 2 },
      costUsd: 12.4,
      escalation: 'fix attempts exhausted',
      lastError: 'fix attempts exhausted (3)',
    },
    E2: {
      state: 'interrupted',
      pr: 52,
      attempts: { brief: 1, implement: 1, fix: 0, verify: 0 },
      costUsd: 2.2,
      lastError: 'the run hit its timeout of 240 minutes',
    },
    E3: {
      state: 'verified',
      pr: 53,
      held: { at: ago(30) },
      attempts: { brief: 1, implement: 1, fix: 0, verify: 1 },
      costUsd: 6.1,
      claimedSha: shaOf('e3'),
      verified: { sha: shaOf('e3'), patchId: 'e3', at: ago(40) },
      gate: { action: 'wait', reasons: ['held (rollout release E3)'], mergeState: 'CLEAN', sha: shaOf('e3'), at: ago(20) },
    },
    E4: {
      state: 'blocked',
      attempts: { brief: 1, implement: 0, fix: 0, verify: 0 },
      costUsd: 1.1,
      blocked: {
        kind: 'brief-questions',
        question: 'Is the plugin API public in 1.3, or internal until 2.0?\nShould a plugin see the raw config or the validated one?',
        evidence: 'Section 4 lists the API under "public", the E4 section calls it "experimental".',
      },
    },
    E5: {
      state: 'blocked',
      pr: 55,
      attempts: { brief: 1, implement: 1, fix: 0, verify: 1 },
      costUsd: 3.3,
      blocked: { kind: 'gate', question: 'a required check failed: lint', evidence: '' },
    },
  }
}

function edgeEvents(ago, pid) {
  const { start, done } = runEvents(ago)

  return [
    { at: ago(300), id: '-', kind: 'driver-start', prs: EDGE_PRS.map((pr) => pr.id), dryRun: false, merge: 'human', pid },
    start('E1', 'fix', 'E1-05-fix', 90),
    done('E1', 'fix', 'E1-05-fix', 70, 'READY', 2.1, 1200),
    { at: ago(69), id: 'E1', kind: 'escalated', role: 'fix' },
    start('E2', 'implement', 'E2-01-implement', 290),
    {
      at: ago(50),
      id: 'E2',
      kind: 'implement-done',
      run: 'E2-01-implement',
      ok: false,
      result: null,
      cost: 0,
      seconds: 14400,
      denials: 0,
      stopped: true,
      error: 'timeout',
    },
    start('E3', 'verify', 'E3-02-verify', 60),
    done('E3', 'verify', 'E3-02-verify', 40, 'PASS', 1.2, 1200),
    start('E4', 'brief', 'E4-01-brief-write', 30, { step: 'write' }),
    done('E4', 'brief', 'E4-01-brief-write', 20, 'BRIEF', 1.1, 600),
    { at: ago(20), id: 'E4', kind: 'blocked', reason: 'brief-questions' },
    start('E5', 'verify', 'E5-02-verify', 50),
    done('E5', 'verify', 'E5-02-verify', 35, 'PASS', 1, 900),
    { at: ago(15), id: 'E5', kind: 'blocked', reason: 'gate' },
  ]
}

// A running demo rollout, a finished one, one with every state that waits or
// stops, and one whose manifest does not load.
export function makeDemoRoot({ dir = null, now = Date.now(), pid = process.pid } = {}) {
  const root = dir ?? mkdtempSync(join(tmpdir(), 'rollout-demo-'))
  const ago = clockOf(now)
  const merged = Object.fromEntries(MY_LIB_PRS.map((pr) => [pr.id, { state: 'merged', costUsd: 4.82 }]))

  mkdirSync(root, { recursive: true })

  writeRollout(root, {
    name: 'my-lib-1.2.0',
    prs: MY_LIB_PRS,
    ledger: myLibLedger(ago),
    events: myLibEvents(ago, pid),
    logs: myLibLogs(),
    files: { plan: MY_LIB_PLAN, briefs: { 'P2.md': P2_BRIEF } },
    policy: { delegate: DELEGATE },
    pid,
  })

  writeRollout(root, { name: 'my-lib-1.1.0', prs: MY_LIB_PRS, ledger: merged })
  writeRollout(root, {
    name: 'edge-states',
    prs: EDGE_PRS,
    ledger: edgeLedger(ago),
    events: edgeEvents(ago, pid),
    policy: { delegate: DELEGATE },
    pid,
  })

  mkdirSync(join(root, 'notes-site'))
  writeFileSync(join(root, 'notes-site', 'manifest.yaml'), 'rollout: notes-site\n')

  return root
}

// What the live run does next, one step per refresh, so its open panel moves.
const LIVE_STEPS = [
  [tool('d1', 'Read', { file_path: 'lib/config/flags.mjs' }), result('d1', lines(64))],
  [tool('d2', 'Edit', { file_path: 'scripts/config-docs.mjs' }), result('d2', 'ok')],
  [tool('d3', 'Bash', { command: 'node scripts/config-docs.mjs --out docs/config.md' }), result('d3', lines(3))],
  [tool('d4', 'Bash', { command: 'npm test -- test/docs.test.mjs' }), result('d4', lines(41))],
  [text('The reference now leaves out keys the schema does not have yet, and says so at the top.')],
  [tool('d5', 'Bash', { command: 'git commit -am "docs: config reference"' }), result('d5', lines(2))],
]

// Keeps the demo alive while it is shown: fresh heartbeats, and a run that goes on.
export function keepDemoAlive(root, { intervalMs = REFRESH_MS } = {}) {
  let step = 0

  const timer = setInterval(() => {
    for (const name of RUNNING) {
      writeFileSync(join(root, name, 'heartbeat'), `${new Date().toISOString()} tick`)
    }

    if (step < LIVE_STEPS.length) {
      appendFileSync(join(root, LIVE_RUN.rollout, 'logs', `${LIVE_RUN.run}.jsonl`), jsonLines(LIVE_STEPS[step]))
      step += 1
    }
  }, intervalMs)

  timer.unref()

  return () => clearInterval(timer)
}

export function removeDemoRoot(root) {
  rmSync(root, { recursive: true, force: true })
}
