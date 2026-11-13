// Helpers that two or more driver test files use. A helper that one file
// uses lives in that file.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDriver } from '../lib/driver.mjs'
import { setFetch } from '../lib/github.mjs'
import { postCommand } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { readEvents } from '../lib/view.mjs'
import { worktreePath } from '../lib/worktree.mjs'
import { at, fakeGitHub, fakeTools, makeRollout, samplePrs, waitFor } from './fixtures.mjs'

export const MAINTAINER_TOKEN = 'synthetic-maintainer-token'

export function agentResult(overrides = {}) {
  return { ok: true, output: null, costUsd: 1.25, seconds: 60, denials: [], error: null, stopped: false, ...overrides }
}

// A driver on a fixture rollout and a fake GitHub that answers `routes`. It
// never sends a desktop notification: a test that checks them passes its own notify.
export function driverFor(prs, { policy = {}, routes = [], ...options } = {}) {
  const manifest = loadManifest(makeRollout({ prs, events: [], policy }))
  const github = fakeGitHub(routes)

  setFetch(github.fetch, { token: async () => MAINTAINER_TOKEN })

  return { manifest, github, driver: createDriver(manifest, { notify: () => {}, ...options }) }
}

// Posts the commands, applies them and returns the events they caused.
export function apply(manifest, driver, ...commands) {
  const before = readEvents(manifest).length

  for (const command of commands) {
    postCommand(manifest, command)
  }

  driver.applyCommands()

  return readEvents(manifest)
    .slice(before)
    .map(({ at: _, ...event }) => event)
}

export const SHA = samplePrs().A1.verified.sha
export const MERGE_SHA = 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0'
export const FETCH = { tool: 'git', args: 'fetch', stdout: '' }
export const MERGE_RULE = { tool: 'gh', args: 'pr merge 11', stdout: '' }

export function mergeCalls(tools) {
  return tools.calls().filter((call) => call.tool === 'gh' && call.args.join(' ').startsWith('pr merge 11'))
}

export const GREEN_RUNS = { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] }

// A1's PR as viewPr maps it, at the head it was verified at.
export function prJson(overrides = {}) {
  return {
    number: 11,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'feat/a1',
    headRefOid: SHA,
    labels: [],
    title: 'feat: A1',
    body: '',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    mergedAt: null,
    url: 'https://github.com/example/widgets/pull/11',
    author: 'demo-bot',
    ...overrides,
  }
}

// What a merged PR carries in the REST API.
export const MERGED_PR = { state: 'closed', merged_at: at(90), merge_commit_sha: MERGE_SHA }

// A1's PR as the REST API answers it, at the head it was verified at. `head`
// and `base` are merged into A1's.
export function restPr({ head = {}, base = {}, ...overrides } = {}) {
  const number = overrides.number ?? 11

  return {
    number,
    state: 'open',
    draft: false,
    title: 'feat: A1',
    body: '',
    labels: [],
    user: { login: 'demo-bot' },
    html_url: `https://github.com/example/widgets/pull/${number}`,
    base: { ref: 'main', ...base },
    head: { ref: 'feat/a1', sha: SHA, ...head },
    mergeable: true,
    mergeable_state: 'clean',
    merged_at: null,
    merge_commit_sha: null,
    ...overrides,
  }
}

export function prRoute(overrides = {}) {
  const body = restPr(overrides)

  return { path: `repos/example/widgets/pulls/${body.number}`, body }
}

export function runsRoute(sha, body = GREEN_RUNS) {
  return { path: `repos/example/widgets/commits/${sha}/check-runs`, body, items: 'check_runs' }
}

// Facts on which the gate merges A1, in the shape collectFacts returns.
export function gateFacts(manifest, pr = {}) {
  const green = { state: 'green', missing: [], pending: [], failing: [], runs: [] }

  return {
    depsPending: [],
    files: [],
    addedLines: [],
    commits: [],
    changesets: [],
    baseIsAncestor: true,
    patchId: samplePrs().A1.verified.patchId,
    pr: { ...prJson(), labels: [manifest.label], ...pr },
    checks: green,
    mainChecks: green,
    reviews: [],
  }
}

// Tests never run a real command. One that reaches this fails its job.
function noCommands() {
  return Promise.reject(new Error('this test gives the driver no runCommand'))
}

// A driver whose gh, git and GitHub are fakes, with no slot for an agent. gh
// and git answer `rules`, GitHub answers `routes`. Its gate reads gateFacts
// with `gate.pr` and `gate.facts` on top, or throws `gate.error`. `gate.pr`
// may be a function of the manifest PR and its ledger entry. A `judge` stands
// in for the merge gate's own.
export function tickDriver(
  prs,
  { rules = [], routes = [], only = null, policy = {}, clock, judge, runAgent, runCommand = noCommands } = {},
) {
  const dir = makeRollout({ prs, events: [], policy: { concurrency: 0, ...policy } })
  const tools = fakeTools(dir, rules)
  const github = fakeGitHub(routes)
  const manifest = loadManifest(dir, { only })
  const gate = { calls: 0, error: null, pr: {}, facts: {} }
  const notices = []
  const cleaned = []

  setFetch(github.fetch, { token: async () => MAINTAINER_TOKEN })

  const driver = createDriver(manifest, {
    notify: (_, message) => notices.push(message),
    cleanup: async (pr) => cleaned.push(pr.id),
    collectFacts: async (_, pr, entry) => {
      gate.calls += 1

      if (gate.error) {
        throw gate.error
      }

      return { ...gateFacts(manifest, typeof gate.pr === 'function' ? gate.pr(pr, entry) : gate.pr), ...gate.facts }
    },
    judge,
    clock,
    runAgent,
    runCommand,
  })

  return { manifest, driver, tools, github, gate, notices, cleaned }
}

export function eventsSince(manifest, from = 0) {
  return readEvents(manifest)
    .slice(from)
    .map(({ at: _, ...event }) => event)
}

export function kindsSince(manifest, from = 0) {
  return eventsSince(manifest, from).map((event) => event.kind)
}

export const GREEN_EVIDENCE = 'required checks passed, runs: test (success)'

export function gateCheckEvent(item, result, evidence, sha = SHA) {
  return { id: 'A1', kind: 'gate-check', stage: 'preVerify', item, level: 'required', result, sha: sha.slice(0, 7), evidence }
}

// A1 with a brief, a ready worktree and model.implement sonnet. Every agent
// call is recorded, and `result` decides how each run ends: never by default.
export function modelDriver(prs, { result = () => new Promise(() => {}) } = {}) {
  const calls = []
  const setup = tickDriver(prs, {
    policy: { concurrency: 5 },
    runAgent: (_, pr, options) => {
      calls.push(options)
      return result(options)
    },
  })

  const pr = setup.manifest.all.find((item) => item.id === 'A1')
  const gitDir = join(worktreePath(setup.manifest, pr), '.git')

  pr.model = { implement: 'sonnet' }
  mkdirSync(gitDir, { recursive: true })
  mkdirSync(dirname(pr.brief), { recursive: true })
  writeFileSync(pr.brief, '# A1\n')
  writeFileSync(join(gitDir, 'rollout-ready'), '')
  setup.tools.answer([{ tool: 'git', args: '', stdout: '' }])

  return { ...setup, pr, entry: setup.driver.ledger.prs.A1, calls }
}

export async function launched(setup, role, options) {
  const before = setup.calls.length

  setup.driver.launch(setup.pr, role, options)
  await waitFor(() => setup.calls.length > before, `${role} run`)

  return setup.calls.at(-1)
}

export const NEW_HEAD = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'

export const REBASED = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'

export const CLAIMED = { state: 'ready_claimed', pr: 11, claimedSha: SHA, attempts: { implement: 1, fix: 0, verify: 0, brief: 0 } }

// A claimed A1 with green CI, a free slot and a worktree at its head, so checkClaim
// can start the verifier. Its scope is lib/** and it changes README.md. The agent never finishes.
// `rules` answer before the git rules, and `answer` swaps them later.
export function verifiableDriver({ gates, deviations, runCommand, rules = [] } = {}) {
  const agentCalls = []
  const prompts = []
  const setup = tickDriver(
    { A1: CLAIMED },
    {
      policy: { concurrency: 1 },
      routes: [prRoute(), runsRoute(SHA)],
      runAgent: (_, pr, options) => {
        agentCalls.push({ id: pr.id, role: options.role })
        prompts.push(options.prompt)
        return new Promise(() => {})
      },
      runCommand,
    },
  )

  const pr = setup.manifest.prs.find((item) => item.id === 'A1')
  const entry = setup.driver.ledger.prs.A1
  const gitDir = join(worktreePath(setup.manifest, pr), '.git')

  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(gitDir, 'rollout-ready'), '')

  const answer = (first) =>
    setup.tools.answer([...first, { tool: 'git', args: 'rev-parse HEAD', stdout: SHA }, { tool: 'git', args: '', stdout: '' }])

  answer(rules)

  entry.briefScope = ['lib/**']
  entry.ready = { status: 'READY', deviations }
  setup.gate.facts = { files: [{ status: 'modified', path: 'README.md' }] }

  if (gates) {
    setup.manifest.gates = { ...setup.manifest.gates, ...gates }
  }

  return { ...setup, pr, entry, agentCalls, prompts, answer }
}

// Every stage with every key, as loadManifest fills them, with the given values.
export function gatesWith({ brief = {}, ready = {}, preVerify = {}, verify = {} } = {}) {
  return {
    brief: { runChecks: false, required: [], recommended: [], ...brief },
    ready: { required: [], recommended: [], ...ready },
    preVerify: { scope: false, required: [], recommended: [], ...preVerify },
    verify: { required: [], recommended: [], criteriaFrom: null, ...verify },
  }
}

export const COMMANDS_GATE = gatesWith({ preVerify: { required: ['npm test'], recommended: ['npm run lint'] } })

// What runCommand resolves with: exit 0 and no output, unless overridden.
export function commandRun(overrides = {}) {
  return { exitCode: 0, signal: null, timedOut: false, stopped: false, tail: '', seconds: 1, ...overrides }
}

// A runCommand seam that records every call. `outcomes` maps a command to
// what it resolves with, or to a function of the call that returns a promise.
export function commandSeam(outcomes = {}) {
  const calls = []

  function seam(_, pr, options) {
    calls.push({ id: pr.id, ...options })

    const outcome = outcomes[options.command] ?? commandRun()

    return typeof outcome === 'function' ? outcome(options) : Promise.resolve(outcome)
  }

  return { calls, runCommand: seam, commands: () => calls.map((call) => call.command) }
}

export async function preVerified(setup, driver = setup.driver) {
  await driver.advance(setup.pr)
  await waitFor(() => !driver.running.has('A1'), 'the commands to finish')
}

export const FIRST_ROUND = {
  at: at(50),
  items: [
    { id: 'F1', text: 'cli.mjs:40 swallows the error.', answer: { outcome: 'fixed', action: 'It is logged at cli.mjs:42.' } },
    { id: 'F2', text: 'The retry flag is not documented.', answer: { outcome: 'disputed', action: 'The brief keeps the flag internal.' } },
  ],
}

export const UNANSWERED = { ...FIRST_ROUND, items: FIRST_ROUND.items.map((item) => ({ ...item, answer: null })) }
