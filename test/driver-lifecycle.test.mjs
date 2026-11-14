import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDriver } from '../lib/driver.mjs'
import { setFetch } from '../lib/github.mjs'
import { ERROR_KINDS } from '../lib/kinds.mjs'
import { postCommand } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { readEvents } from '../lib/view.mjs'
import { worktreePath } from '../lib/worktree.mjs'
import { fakeGitHubRepo, makeRollout, waitFor } from './fixtures.mjs'
import { MAINTAINER_TOKEN, agentResult, apply } from './driver-helpers.mjs'

// One PR through the real driver, on real git: a bare origin, repo.path
// cloned from it, and the driver's own clones. Only GitHub, gh and the agents
// are fakes, so collectFacts, the clones, the merge and the cleanup all run.

const GITHUB_URL = 'https://github.com/example/widgets.git'
const POLICY = { merge: 'human', approval: 'inbox', mergeDelaySeconds: 0 }
const EFFORT = { implement: 'high', verify: 'high' }
const A1 = { id: 'A1', branch: 'feat/a1', title: 'feat: A1', brief: 'briefs/A1.md', effort: EFFORT, changeset: 'patch' }
const CHANGESET = '---\n"widgets": patch\n---\n\nA1 adds a1.txt.\n'
const MAX_ROUNDS = 10
const JOB_TIMEOUT_MS = 20_000
const STALE_APPROVAL = 'it names a different head than the one verified now; look at the card again'

const MILESTONES = [
  'implement-start',
  'implement-done',
  'ready-claimed',
  'gate-check:ci:pass',
  'verify-start',
  'verify-done',
  'verified',
  'approved',
  'merged',
  'finished',
]

const UNWANTED = [
  'needs-fix',
  'blocked',
  'escalated',
  'verify-stale',
  'verifier-touched-tree',
  'merge-refused',
  'merge-unconfirmed',
  'command-rejected',
]

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// Config that every git this process starts reads, the driver's included,
// until the returned function puts the old values back.
function setGitConfig(entries) {
  const names = ['GIT_CONFIG_COUNT', ...entries.flatMap((_, i) => [`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`])]
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]))

  process.env.GIT_CONFIG_COUNT = String(entries.length)

  for (const [i, [key, value]] of entries.entries()) {
    process.env[`GIT_CONFIG_KEY_${i}`] = key
    process.env[`GIT_CONFIG_VALUE_${i}`] = value
  }

  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
}

// The implementer commits a1.txt and the changeset the policy asks for,
// pushes through the clone's hooks and opens the PR. The verifier passes the
// head it finds in its clone.
function fakeAgents(manifest, github, verifiedHeads) {
  function implement(pr, cwd, logName) {
    mkdirSync(join(cwd, '.changeset'), { recursive: true })
    writeFileSync(join(cwd, 'a1.txt'), `A1, from ${logName}\n`)
    writeFileSync(join(cwd, '.changeset', 'a1.md'), CHANGESET)
    git(cwd, 'add', 'a1.txt', '.changeset/a1.md')
    git(cwd, 'commit', '--quiet', '-m', 'feat: add a1.txt')
    git(cwd, 'push', '--quiet', 'origin', `HEAD:refs/heads/${pr.branch}`)

    const number = github.openPr({ branch: pr.branch, title: pr.title, labels: [manifest.label] })
    const output = {
      status: 'READY',
      summary: 'a1.txt and its changeset are pushed.',
      gates: [],
      pr: number,
      headSha: git(cwd, 'rev-parse', 'HEAD'),
    }

    return agentResult({ output })
  }

  function verify(cwd) {
    const sha = git(cwd, 'rev-parse', 'HEAD')
    const output = {
      verdict: 'PASS',
      sha,
      summary: 'a1.txt is there.',
      checklist: [],
      blocking: [],
      nonBlocking: [],
      recheck: [],
      criteria: [],
    }

    verifiedHeads.push(sha)

    return agentResult({ output })
  }

  return async (_, pr, { role, cwd, logName }) => {
    if (role === 'implement' || role === 'fix') {
      return implement(pr, cwd, logName)
    }

    if (role === 'verify') {
      return verify(cwd)
    }

    throw new Error(`no fake agent for the ${role} role`)
  }
}

// A rollout of A1 in one temp dir: the bare origin, the rollout dir with
// repo.path in it, and the driver's clones next to it. The cleanup waits for
// the driver's jobs, so a failed test leaves none writing into a removed dir.
function lifecycle(context) {
  const tmp = mkdtempSync(join(tmpdir(), 'rollout-lifecycle-'))
  const origin = join(tmp, 'origin.git')
  const dir = join(tmp, 'demo')
  const repo = join(dir, 'repo')
  const started = { driver: null }
  const restoreGitConfig = setGitConfig([
    [`url.${origin}.insteadOf`, GITHUB_URL],
    ['user.name', 'Test'],
    ['user.email', 'test@example.com'],
    ['commit.gpgsign', 'false'],
  ])

  context.after(async () => {
    try {
      if (started.driver) {
        await waitFor(() => started.driver.running.size === 0, 'the driver jobs to end', JOB_TIMEOUT_MS)
      }
    } finally {
      restoreGitConfig()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin])
  makeRollout({ dir, prs: { A1: {} }, events: [], logs: null, policy: POLICY, manifest: { briefing: undefined, prs: [A1] } })
  execFileSync('git', ['clone', '--quiet', origin, repo], { stdio: 'ignore' })
  writeFileSync(join(repo, 'widgets.txt'), 'widgets\n')
  git(repo, 'add', 'widgets.txt')
  git(repo, 'commit', '--quiet', '-m', 'chore: start widgets')
  git(repo, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main')
  mkdirSync(join(dir, 'briefs'))
  writeFileSync(join(dir, 'briefs', 'A1.md'), '# A1\n\nAdd a1.txt with a patch changeset.\n')

  const github = fakeGitHubRepo(dir, { origin })
  const manifest = loadManifest(dir)
  const notices = []
  const verifiedHeads = []

  setFetch(github.fetch, { token: async () => MAINTAINER_TOKEN })

  const driver = createDriver(manifest, {
    notify: (_, message) => notices.push(message),
    runAgent: fakeAgents(manifest, github, verifiedHeads),
  })

  started.driver = driver

  return {
    tmp,
    origin,
    manifest,
    github,
    driver,
    notices,
    verifiedHeads,
    pr: manifest.prs.find((item) => item.id === 'A1'),
    entry: driver.ledger.prs.A1,
  }
}

function kinds(setup) {
  return readEvents(setup.manifest).map((event) => event.kind)
}

function count(setup, kind) {
  return kinds(setup).filter((name) => name === kind).length
}

function milestone(event) {
  return event.kind === 'gate-check' ? `gate-check:${event.item}:${event.result}` : event.kind
}

// A tick, then the jobs it started, so the next check sees where they left the PR.
async function tickAndWait(setup) {
  await setup.driver.tick()
  await waitFor(() => setup.driver.running.size === 0, 'the jobs of the tick', JOB_TIMEOUT_MS)
}

async function tickUntil(setup, check, label) {
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    await tickAndWait(setup)

    if (check()) {
      return
    }
  }

  assert.fail(`no ${label} after ${MAX_ROUNDS} ticks. Events: ${kinds(setup).join(', ')}`)
}

function originMain(setup) {
  return git(setup.origin, 'rev-parse', 'refs/heads/main')
}

function approve(verified) {
  return { cmd: 'approve', id: 'A1', sha: verified.sha, patchId: verified.patchId }
}

// The driver's merge is one squash commit on the old main, with the tree of the PR head.
function assertSquashed(setup, { before, head }) {
  const main = originMain(setup)

  assert.equal(main, setup.entry.mergeSha)
  assert.equal(main, setup.driver.ledger.data.lastMerge.sha)
  assert.equal(git(setup.origin, 'log', '-1', '--format=%P', main), before)
  assert.equal(git(setup.origin, 'rev-parse', `${main}^{tree}`), git(setup.origin, 'rev-parse', `${head}^{tree}`))
}

function assertNoTrouble(setup) {
  const events = readEvents(setup.manifest)
  const errors = events.filter((event) => ERROR_KINDS.includes(event.kind) || event.kind.endsWith('-failed'))
  const detours = events.filter((event) => UNWANTED.includes(event.kind))
  const unknown = setup.github.requests().filter((request) => request.status === 400)

  assert.deepEqual(errors, [])
  assert.deepEqual(detours, [])
  assert.deepEqual(unknown, [])
  assert.equal(setup.entry.stageLabelError, null)
}

function statuses(requests) {
  return requests.map((request) => request.status)
}

// Another clone pushes a commit on top of the verified head. A fast-forward,
// so the driver's clone can follow it.
function pushOnTop(setup, verifiedSha) {
  const other = join(setup.tmp, 'other')

  execFileSync('git', ['clone', '--quiet', setup.origin, other], { stdio: 'ignore' })
  git(other, 'checkout', '--quiet', '-B', 'feat/a1', 'origin/feat/a1')
  assert.equal(git(other, 'rev-parse', 'HEAD'), verifiedSha)
  writeFileSync(join(other, 'a1-more.txt'), 'more of A1\n')
  git(other, 'add', 'a1-more.txt')
  git(other, 'commit', '--quiet', '-m', 'feat: add a1-more.txt')
  git(other, 'push', '--quiet', 'origin', 'HEAD:refs/heads/feat/a1')

  return git(other, 'rev-parse', 'HEAD')
}

test('lifecycle: one PR goes from pending to merged, squashed into the origin, and its clone and branch are gone', async (context) => {
  const setup = lifecycle(context)

  await setup.driver.start()
  await tickUntil(setup, () => setup.entry.state === 'verified', 'verification')

  const before = originMain(setup)
  const head = setup.entry.verified.sha

  postCommand(setup.manifest, approve(setup.entry.verified))
  await tickUntil(setup, () => setup.driver.finished(), 'finish')
  await setup.driver.finish()

  const number = setup.entry.pr
  const seen = readEvents(setup.manifest).map(milestone)
  const requests = setup.github.requests()
  // The driver swallows the errors of both, so only their answers tell.
  const branchDeletes = requests.filter((request) => request.method === 'DELETE' && request.path.endsWith('/git/refs/heads/feat/a1'))
  const openLists = requests.filter((request) => request.path === 'repos/example/widgets/pulls' && request.query.state === 'open')
  const merge = ['pr', 'merge', String(number), '--squash', '--match-head-commit', head, '--subject', `feat: A1 (#${number})`, '--body', '']

  assert.deepEqual(
    seen.filter((name) => MILESTONES.includes(name)),
    MILESTONES,
  )

  assertSquashed(setup, { before, head })
  assert.equal(existsSync(worktreePath(setup.manifest, setup.pr)), false)
  assert.equal(git(setup.origin, 'for-each-ref', 'refs/heads/feat/a1'), '')
  assert.deepEqual(statuses(branchDeletes), [204])
  assert.deepEqual(statuses(openLists), [200])
  assert.deepEqual(setup.github.ghCalls(), [merge])
  assert.ok(setup.notices.includes(`A1: merged PR #${number}`))
  assertNoTrouble(setup)
})

test('lifecycle: a head pushed after the verification is verified again, and an approve of the old head is rejected', async (context) => {
  const setup = lifecycle(context)

  await setup.driver.start()
  await tickUntil(setup, () => setup.entry.state === 'verified', 'verification')

  const first = { ...setup.entry.verified }
  const pushed = pushOnTop(setup, first.sha)

  await tickUntil(setup, () => count(setup, 'verified') === 2, 'second verification')

  const reasons = readEvents(setup.manifest)
    .filter((event) => event.kind === 'head-moved-reverify')
    .map((event) => event.reason)

  assert.deepEqual(reasons, ['new-patch'])
  assert.equal(count(setup, 'verify-start'), 2)
  assert.deepEqual(setup.verifiedHeads, [first.sha, pushed])
  assert.equal(setup.entry.verified.sha, pushed)
  assert.notEqual(setup.entry.verified.patchId, first.patchId)

  const main = originMain(setup)

  postCommand(setup.manifest, approve(first))
  await tickAndWait(setup)

  const rejections = readEvents(setup.manifest)
    .filter((event) => event.kind === 'approval-rejected')
    .map((event) => event.reason)

  assert.deepEqual(rejections, [STALE_APPROVAL])
  assert.equal(count(setup, 'approved'), 0)
  assert.equal(setup.entry.state, 'verified')
  assert.equal(originMain(setup), main)
  assertNoTrouble(setup)
})

test('lifecycle: a hold of the rollout keeps an approved PR through five ticks, and the merge follows release --all', async (context) => {
  const setup = lifecycle(context)

  await setup.driver.start()
  await tickUntil(setup, () => setup.entry.state === 'verified', 'verification')

  const before = originMain(setup)
  const head = setup.entry.verified.sha

  // Between ticks: with no merge delay, the tick that applies an approve merges at once.
  const approved = apply(setup.manifest, setup.driver, approve(setup.entry.verified))

  assert.deepEqual(
    approved.map((event) => event.kind),
    ['approved'],
  )

  postCommand(setup.manifest, { cmd: 'hold', all: true })

  for (let i = 0; i < 5; i += 1) {
    await tickAndWait(setup)

    assert.equal(setup.driver.ledger.data.hold?.by, 'maintainer', `tick ${i + 1}`)
  }

  assert.equal(count(setup, 'merged'), 0)
  assert.deepEqual(setup.github.ghCalls(), [])
  assert.equal(setup.entry.state, 'verified')
  assert.equal(originMain(setup), before)

  postCommand(setup.manifest, { cmd: 'release', all: true })
  await tickUntil(setup, () => setup.entry.state === 'merged', 'merge after release --all')

  assertSquashed(setup, { before, head })
  assertNoTrouble(setup)
})
