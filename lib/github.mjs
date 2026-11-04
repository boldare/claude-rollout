import { makeEnv, sh, shOk } from './sh.mjs'
import { inheritsParent, parseCatalog, speaksForItself, summarizeChecks } from './checks.mjs'
import { needsAdmin } from './judge.mjs'
import { createClient, GitHubError } from './gh.mjs'
import { sentences } from './notify.mjs'

// Everything the driver knows about GitHub and git comes from here, as plain
// facts. The gate (judge.mjs) decides; this module only reads and acts.
function gh(manifest, args, options = {}) {
  return shOk('gh', args, { env: ghEnv(manifest), cwd: manifest.repo.path, ...options })
}

// Without the pin, gh takes the repository from the clone's remotes or
// `gh repo set-default`, and the host from GH_HOST. The API paths and the
// push URL already name repo.github on github.com.
export function ghEnv(manifest, extra = {}) {
  return makeEnv(manifest, { ...extra, GH_REPO: `github.com/${manifest.repo.github}`, GH_HOST: 'github.com' })
}

let clientOptions = {}
let clients = new WeakMap()

// One client per manifest object, so every request shares its token and its
// ETags. A manifest reload assigns into the same object and keeps them.
export function clientFor(manifest) {
  if (!clients.has(manifest)) {
    clients.set(manifest, createClient(manifest, clientOptions))
  }

  return clients.get(manifest)
}

// The seam for tests: every client built from now on uses this fetch and token.
export function setFetch(fetchImpl, { token } = {}) {
  clientOptions = { fetch: fetchImpl, token }
  clients = new WeakMap()
}

// The GitHub facts read in one tick, so every step that needs one shares a
// single read.
export function tickReads() {
  return { prs: new Map(), reviews: new Map(), checks: new Map(), bases: new Map(), codeScanning: new Map() }
}

// The promise is kept, not its value, so parallel callers share one request.
// A failed read stays failed for the rest of the tick: an outage costs one
// timeout per fact, not one per step.
function shared(map, key, read) {
  if (!map) {
    return read()
  }

  if (!map.has(key)) {
    map.set(key, read())
  }

  return map.get(key)
}

// Drops what a tick read about a PR whose head may have moved since.
export function forgetPr(reads, number) {
  if (!reads) {
    return
  }

  reads.prs.delete(number)
  reads.reviews.delete(number)
  reads.codeScanning.delete(number)
}

function git(manifest, args, options = {}) {
  return shOk('git', ['-C', manifest.repo.path, ...args], { env: makeEnv(manifest), ...options })
}

const URL_PROTOCOLS = new Map([
  ['ssh:', 'ssh'],
  ['git+ssh:', 'ssh'],
  ['ssh+git:', 'ssh'],
  ['https:', 'https'],
  ['http:', 'https'],
])

// A host that starts with `-` would reach `ssh -G` as an option.
function validHost(host) {
  return host !== '' && !host.startsWith('-') && !/\s/.test(host)
}

function ownerAndName(path) {
  const segments = path
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')

  if (segments.length !== 2 || segments.some((segment) => segment === '')) {
    return null
  }

  return segments.join('/').toLowerCase()
}

function urlRemote(url) {
  let parsed

  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const protocol = URL_PROTOCOLS.get(parsed.protocol)
  // new URL() keeps the case of the host for ssh: URLs.
  const host = parsed.hostname.toLowerCase()
  const repo = ownerAndName(parsed.pathname.replace(/^\//, ''))

  if (!protocol || !validHost(host) || !repo) {
    return null
  }

  return { protocol, host, repo }
}

// Git reads `[user@]host:path` as scp-like only when no `/` comes before the first `:`.
function scpRemote(url) {
  const colon = url.indexOf(':')

  if (colon === -1 || url.slice(0, colon).includes('/')) {
    return null
  }

  const host = url.slice(0, colon).split('@').at(-1).toLowerCase()
  const repo = ownerAndName(url.slice(colon + 1))

  if (!validHost(host) || !repo) {
    return null
  }

  return { protocol: 'ssh', host, repo }
}

// The host and owner/name of an SSH or HTTPS remote URL, or null for anything else.
export function remoteRepo(url) {
  if (typeof url !== 'string' || url === '') {
    return null
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    return urlRemote(url)
  }

  return scpRemote(url)
}

export async function fetchOrigin(manifest) {
  await git(manifest, ['fetch', '--quiet', '--prune', 'origin'])
}

function knownStatus(error, status) {
  return error instanceof GitHubError && error.status === status
}

// Creating a label that exists answers 422, and then it is updated, as
// `gh label create --force` did.
async function saveLabel(manifest, name, color, description) {
  const client = clientFor(manifest)

  try {
    await client.request('POST', `repos/${manifest.repo.github}/labels`, { body: { name, color, description } })
  } catch (error) {
    if (!knownStatus(error, 422)) {
      throw error
    }

    await client.request('PATCH', `repos/${manifest.repo.github}/labels/${encodeURIComponent(name)}`, { body: { color, description } })
  }
}

export async function ensureLabel(manifest) {
  await saveLabel(manifest, manifest.label, '5319e7', 'Managed by the rollout driver')
}

// Stage labels in blue, reasons in orange.
const STAGE_COLORS = { 'rollout-stage:': '1d76db', 'rollout-reason:': 'd93f0b' }

export async function setStageLabels(manifest, number, { add, remove }) {
  const client = clientFor(manifest)
  const labels = `repos/${manifest.repo.github}/issues/${number}/labels`

  for (const label of add) {
    const color = Object.entries(STAGE_COLORS).find(([prefix]) => label.startsWith(prefix))?.[1] ?? 'ededed'

    await saveLabel(manifest, label, color, 'Rollout stage, set by the driver')
  }

  if (add.length > 0) {
    await client.request('POST', labels, { body: { labels: add } })
  }

  for (const label of remove) {
    try {
      await client.request('DELETE', `${labels}/${encodeURIComponent(label)}`)
    } catch (error) {
      // The label is off already.
      if (!knownStatus(error, 404)) {
        throw error
      }
    }
  }
}

const MERGEABLE = new Map([
  [true, 'MERGEABLE'],
  [false, 'CONFLICTING'],
])

function prState(githubPr) {
  if (githubPr.merged_at) {
    return 'MERGED'
  }

  return githubPr.state === 'open' ? 'OPEN' : 'CLOSED'
}

// A REST pull request under the names the gate reads, which are gh's.
function prFacts(githubPr) {
  return {
    number: githubPr.number,
    state: prState(githubPr),
    isDraft: githubPr.draft === true,
    baseRefName: githubPr.base.ref,
    headRefName: githubPr.head.ref,
    headRefOid: githubPr.head.sha,
    labels: githubPr.labels.map((label) => label.name),
    title: githubPr.title,
    body: githubPr.body ?? '',
    mergeable: MERGEABLE.get(githubPr.mergeable) ?? 'UNKNOWN',
    mergeStateStatus: (githubPr.mergeable_state ?? 'unknown').toUpperCase(),
    mergedAt: githubPr.merged_at ?? null,
    url: githubPr.html_url,
    author: githubPr.user?.login ?? null,
  }
}

// The list has no mergeable or mergeable_state, so a PR found here reads
// UNKNOWN for both.
export async function findPr(manifest, branch) {
  const owner = manifest.repo.github.split('/')[0]
  const { body } = await clientFor(manifest).request('GET', `repos/${manifest.repo.github}/pulls`, {
    query: { head: `${owner}:${branch}`, state: 'all', per_page: 10 },
  })

  const prs = body.map(prFacts)

  return prs.find((githubPr) => githubPr.state === 'OPEN') ?? prs.find((githubPr) => githubPr.state === 'MERGED') ?? prs[0] ?? null
}

export function viewPr(manifest, number, { reads = null } = {}) {
  return shared(reads?.prs, number, async () => {
    const { body } = await clientFor(manifest).request('GET', `repos/${manifest.repo.github}/pulls/${number}`)

    return prFacts(body)
  })
}

// The REST list, which feedbackFor reads the bodies of.
function reviewList(manifest, number, reads) {
  return shared(reads?.reviews, number, () => clientFor(manifest).pages(`repos/${manifest.repo.github}/pulls/${number}/reviews`))
}

// Reviews as GitHub records them: who, what, on which commit, when.
export async function reviewsFor(manifest, number, { reads = null } = {}) {
  const reviews = await reviewList(manifest, number, reads)

  return reviews.map((review) => ({
    user: review.user?.login ?? null,
    state: review.state,
    commit: review.commit_id,
    at: review.submitted_at,
  }))
}

const MAX_QUIET_SKIPS = 20

export function checksFor(manifest, sha, { reads = null } = {}) {
  return shared(reads?.checks, sha, () => readChecks(manifest, sha))
}

async function readChecks(manifest, sha) {
  const checkRuns = await clientFor(manifest).pages(`repos/${manifest.repo.github}/commits/${sha}/check-runs`, {
    itemsOf: (body) => body?.check_runs,
  })

  const runs = checkRuns.map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
  }))

  return summarizeChecks(runs, manifest.repo.requiredChecks)
}

// A commit's parents and changed files never change, so each is read once.
const commitShapes = new Map()
const MAX_COMMIT_SHAPES = 500

// git detects renames by default and then prints only the destination, so a
// file moved into the quiet globs from outside would look quiet.
async function commitShape(manifest, sha) {
  const key = `${manifest.repo.path}\0${sha}`

  if (!commitShapes.has(key)) {
    const parents = (await git(manifest, ['log', '-1', '--format=%P', sha])).split(/\s+/).filter(Boolean)
    const files =
      parents.length === 1
        ? (await git(manifest, ['diff', '--no-renames', '--name-only', parents[0], sha])).split('\n').filter(Boolean)
        : []

    if (commitShapes.size >= MAX_COMMIT_SHAPES) {
      commitShapes.delete(commitShapes.keys().next().value)
    }

    commitShapes.set(key, { parents, files })
  }

  return commitShapes.get(key)
}

// The state of the base branch, read from its tip or, when the tip is a quiet
// commit, from the nearest ancestor that has something to say. Returns what
// summarizeChecks returns plus the sha it was read from and the number of
// commits passed over. With the tick's `reads`, every PR the gate looks at in
// one tick sees the same base, so it is read once.
export function baseChecks(manifest, sha, { reads = null } = {}) {
  return shared(reads?.bases, sha, () => walkBase(manifest, sha, reads))
}

async function walkBase(manifest, sha, reads) {
  const globs = manifest.repo.baseQuietPaths
  const requiredGlobs = manifest.repo.requiredChecks
  let at = sha
  let skipped = 0

  for (;;) {
    const checks = await checksFor(manifest, at, { reads })

    if (globs.length === 0 || skipped === MAX_QUIET_SKIPS || speaksForItself(checks.runs, requiredGlobs)) {
      return { ...checks, sha: at, skipped }
    }

    const { parents, files } = await commitShape(manifest, at)

    if (!inheritsParent({ runs: checks.runs, requiredGlobs, parentCount: parents.length, files, globs })) {
      return { ...checks, sha: at, skipped }
    }

    at = parents[0]
    skipped += 1
  }
}

// Alerts as the code scanning API lists them, open ones only.
export function alertsFrom(json) {
  if (!Array.isArray(json)) {
    return []
  }

  return json
    .filter((alert) => alert?.state === 'open')
    .map((alert) => {
      const instance = alert.most_recent_instance ?? {}

      return {
        number: alert.number ?? null,
        rule: alert.rule?.id ?? null,
        securitySeverity: alert.rule?.security_severity_level ?? null,
        severity: alert.rule?.severity ?? null,
        tool: alert.tool?.name ?? null,
        path: instance.location?.path ?? null,
        line: instance.location?.start_line ?? null,
        message: firstLine(instance.message?.text),
        url: alert.html_url ?? null,
        sha: instance.commit_sha ?? null,
      }
    })
}

// CodeQL can repeat the same sentence on several lines.
function firstLine(text) {
  if (typeof text !== 'string') {
    return ''
  }

  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

// A repo without code scanning answers 404, or 403 when Advanced Security is
// off. A 403 rate limit is a transient error like any other.
export function codeScanningUnavailable(error) {
  if (!(error instanceof GitHubError)) {
    return false
  }

  return error.status === 404 || (error.status === 403 && error.kind !== 'rate-limit')
}

// git's messages for a network that is down or slow, plus shOk's "timed out
// after" for a command it killed. Every rule spans a space: git echoes branch
// names, which never hold one but can hold a bare "timeout".
const UNAVAILABLE = [
  /Could not resolve host/i,
  /Connection refused/i,
  /Connection reset/i,
  /timed out/i,
  /early EOF/i,
  /The remote end hung up/i,
]

const OUTAGE_KINDS = ['network', 'timeout', 'rate-limit']

// True when a failure comes from GitHub or the network as a whole, not from
// the call. A GitHub request tells by its kind or a 5xx status. A gh or git
// command tells by git's words in what it printed, or by shOk's "timed out
// after", never by its command line, which can hold a PR title. An
// AggregateError is an outage only when every error in it is one. Right
// after a sleep the network may still be down in ways no rule knows, so with
// afterSleep every failed GitHub request and every failed gh or git command
// is one.
export function githubUnavailable(error, { afterSleep = false } = {}) {
  if (Array.isArray(error?.errors)) {
    return error.errors.length > 0 && error.errors.every((inner) => githubUnavailable(inner, { afterSleep }))
  }

  if (error instanceof GitHubError) {
    return afterSleep || OUTAGE_KINDS.includes(error.kind) || (error.status >= 500 && error.status <= 599)
  }

  if (afterSleep && /^(gh|git) /.test(error?.message ?? '')) {
    return true
  }

  const text = ghError(error)

  return UNAVAILABLE.some((rule) => rule.test(text))
}

// What GitHub or gh said: a request's detail, or a command's output without
// the command line shOk puts before it.
export function ghError(error) {
  if (error instanceof GitHubError) {
    return error.detail
  }

  const text = String(error?.message ?? error)
  const exited = text.match(/ exited \S+: /)

  return exited ? text.slice(exited.index + exited[0].length) : text
}

// gh merges through GraphQL's mergePullRequest, so a refused merge has no
// HTTP status, only gh's words: its own refusal from the PR's merge state, or
// the mutation's error. For a gh that exited, ghError leaves out the command
// line, whose --subject is the PR title.
const REFUSAL = /base branch policy prohibits|not mergeable/i

export function mergeRefusal(error) {
  return REFUSAL.test(ghError(error))
}

// A PR that answers 404 is unknown only while the repository still reads. A
// token that lost access to a private repository gets a 404 for both, and
// that stays an error. Any other failure of the repository read is thrown,
// so an outage stays one.
export async function prNotFound(manifest, error) {
  if (!knownStatus(error, 404)) {
    return false
  }

  try {
    await clientFor(manifest).request('GET', `repos/${manifest.repo.github}`)
  } catch (repositoryError) {
    if (knownStatus(repositoryError, 404)) {
      return false
    }

    throw repositoryError
  }

  return true
}

// Open alerts on the PR head, and the numbers of those also open on the base.
// An alert keeps its number across branches, so the numbers tell new from old.
export function codeScanningFor(manifest, number, { reads = null } = {}) {
  return shared(reads?.codeScanning, number, () => readCodeScanning(manifest, number))
}

async function readCodeScanning(manifest, number) {
  const client = clientFor(manifest)
  const path = `repos/${manifest.repo.github}/code-scanning/alerts`

  try {
    const alerts = alertsFrom(await client.pages(path, { query: { ref: `refs/pull/${number}/head`, state: 'open' } }))

    if (alerts.length === 0) {
      return { available: true, alerts: [], baseOpen: [] }
    }

    const base = alertsFrom(await client.pages(path, { query: { ref: `refs/heads/${manifest.repo.base}`, state: 'open' } }))

    return { available: true, alerts, baseOpen: base.map((alert) => alert.number) }
  } catch (error) {
    if (!codeScanningUnavailable(error)) {
      throw error
    }

    return { available: false, reason: ghError(error).slice(0, 200), alerts: [], baseOpen: [] }
  }
}

// From origin/<base>, never from a PR, so a PR cannot change the criteria it is judged by. git show reads only
// the local clone, so the message does not start with `git `, which githubUnavailable takes for an outage after a sleep.
export async function readCatalog(manifest) {
  const path = manifest.gates.verify.criteriaFrom
  const base = manifest.repo.base
  const shown = await sh('git', ['-C', manifest.repo.path, 'show', `origin/${base}:${path}`], { env: makeEnv(manifest) })

  if (shown.code !== 0) {
    throw new Error(
      `gates.verify.criteriaFrom ${path} cannot be read from origin/${base}: ${shown.stderr.trim() || `git exited ${shown.code}`}`,
    )
  }

  const { entries, errors } = parseCatalog(shown.stdout)

  if (errors.length > 0) {
    throw new Error(`gates.verify.criteriaFrom ${path} on origin/${base} is invalid: ${sentences(...errors)}`)
  }

  return entries
}

export async function mainHead(manifest) {
  return (await git(manifest, ['rev-parse', `origin/${manifest.repo.base}`])).trim()
}

async function ensureCommit(manifest, branch, sha) {
  const known = await sh('git', ['-C', manifest.repo.path, 'cat-file', '-e', `${sha}^{commit}`], { env: makeEnv(manifest) })

  if (known.code !== 0) {
    await git(manifest, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  }
}

export async function patchId(manifest, base, sha) {
  const diff = await git(manifest, ['diff', `${base}...${sha}`])

  if (diff.trim() === '') {
    return 'empty'
  }

  // --verbatim: whitespace changes are changes (a verified patch must be exact).
  const out = await shOk('git', ['patch-id', '--verbatim'], { env: makeEnv(manifest), input: diff })

  return out.split(' ')[0].trim()
}

export function parseNameStatus(out) {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, first, second] = line.split('\t')
      const kind = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'modified' }[status[0]] ?? status

      return kind === 'renamed' || kind === 'copied' ? { status: kind, path: second, previousPath: first } : { status: kind, path: first }
    })
}

export function parseAddedLines(diff) {
  const lines = []
  let path = null

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      path = line.startsWith('+++ b/') ? line.slice(6) : null
    } else if (line.startsWith('+') && path) {
      lines.push({ path, text: line.slice(1) })
    }
  }

  return lines
}

export function parseCommits(out) {
  return out
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, message] = chunk.split('\x1f')

      return { sha, message: message.trim() }
    })
}

// Facts about one PR head for the gate and the policy check. With the tick's
// `reads` (see tickReads), every GitHub read is shared with the other steps
// of the tick.
export async function collectFacts(manifest, pr, entry, ledger, { reads = null } = {}) {
  const githubPr = entry.pr ? await viewPr(manifest, entry.pr, { reads }) : await findPr(manifest, pr.branch)
  const base = `origin/${manifest.repo.base}`
  const facts = {
    halted: ledger.data.halted,
    pr: githubPr,
    depsPending: depsPending(manifest, pr, ledger),
    files: [],
    addedLines: [],
    commits: [],
    changesets: [],
    patchId: null,
    baseIsAncestor: false,
    reviews: [],
    checks: { state: 'pending', missing: [], pending: [], failing: [], runs: [] },
    mainChecks: { state: 'pending', missing: [], pending: [], failing: [], runs: [], sha: null, skipped: 0 },
    codeScanning: null,
  }

  if (!githubPr || githubPr.state !== 'OPEN') {
    return facts
  }

  const sha = githubPr.headRefOid
  await ensureCommit(manifest, pr.branch, sha)

  facts.files = parseNameStatus(await git(manifest, ['diff', '--name-status', '-M', `${base}...${sha}`]))
  facts.addedLines = parseAddedLines(await git(manifest, ['diff', '-U0', '--no-color', `${base}...${sha}`]))
  facts.commits = parseCommits(await git(manifest, ['log', '--format=%H%x1f%B%x1e', `${base}..${sha}`]))
  facts.patchId = await patchId(manifest, base, sha)
  facts.baseIsAncestor =
    (await sh('git', ['-C', manifest.repo.path, 'merge-base', '--is-ancestor', base, sha], { env: makeEnv(manifest) })).code === 0

  for (const file of facts.files) {
    if (/^\.changeset\/[^/]+\.md$/.test(file.path) && file.status !== 'removed' && !/README\.md$/i.test(file.path)) {
      facts.changesets.push({ path: file.path, text: await git(manifest, ['show', `${sha}:${file.path}`]) })
    }
  }

  facts.reviews = await reviewsFor(manifest, githubPr.number, { reads })
  facts.checks = await checksFor(manifest, sha, { reads })
  facts.mainChecks = await baseChecks(manifest, await mainHead(manifest), { reads })

  if (manifest.repo.codeScanning.action !== 'ignore') {
    facts.codeScanning = await codeScanningFor(manifest, githubPr.number, { reads })
  }

  return facts
}

// A dependency counts as merged when the ledger says so, or, for PRs outside
// this run's --only set, when GitHub shows its branch merged.
export function depsPending(manifest, pr, ledger) {
  return pr.deps.filter((dep) => ledger.prs[dep]?.state !== 'merged')
}

// The verified heads of the dependencies that have not merged, for a brief
// written ahead of them. Null while one of them is neither merged nor
// verified, or is held, because a hold is the maintainer's doubt about that
// PR. A merged one counts even when held, because a PR merged on GitHub keeps
// its hold.
export function unmergedHeads(pr, ledger) {
  const heads = []

  for (const dep of pr.deps) {
    const entry = ledger.prs[dep]

    if (entry?.state === 'merged') {
      continue
    }

    if (entry?.state !== 'verified' || !entry.verified?.sha || entry.held) {
      return null
    }

    heads.push({ id: dep, sha: entry.verified.sha, patchId: entry.verified.patchId ?? null })
  }

  return heads
}

// One failed lookup never stops the others. The error names every
// dependency that could not be checked, and keeps each failure, so one that
// is not an outage still counts when another is.
export async function refreshOutsideDeps(manifest, ledger) {
  const active = new Set(manifest.prs.map((pr) => pr.id))
  const outside = new Set(manifest.prs.flatMap((pr) => pr.deps).filter((dep) => !active.has(dep) && ledger.prs[dep]?.state !== 'merged'))
  const failures = []

  for (const id of outside) {
    try {
      const dep = manifest.all.find((pr) => pr.id === id)
      const found = await findPr(manifest, dep.branch)
      const ours = found && found.labels.includes(manifest.label) && found.baseRefName === manifest.repo.base

      if (found?.state === 'MERGED' && ours) {
        ledger.prs[id].state = 'merged'
        ledger.prs[id].pr = found.number
        ledger.event(id, 'merged-outside-run', { pr: found.number })
      }
    } catch (error) {
      failures.push({ id, error })
    }
  }

  if (failures.length > 0) {
    const message = failures.map(({ id, error }) => `${id}: ${String(error?.message ?? error)}`).join('\n')

    throw new AggregateError(
      failures.map(({ error }) => error),
      message,
    )
  }
}

export async function merge(manifest, pr, entry, facts) {
  const githubPr = facts.pr
  const args = [
    'pr',
    'merge',
    String(githubPr.number),
    `--${manifest.repo.merge.method}`,
    '--match-head-commit',
    githubPr.headRefOid,
    '--subject',
    `${githubPr.title} (#${githubPr.number})`,
    '--body',
    '',
  ]

  if (needsAdmin(manifest, facts)) {
    args.push('--admin')
  }

  await gh(manifest, args)

  // The merge happened; reading its commit back must not turn it into an
  // error (sync() records it later if this fails).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sha = await mergeCommit(manifest, githubPr.number).catch(() => null)

    if (sha) {
      return sha
    }
  }

  return null
}

// REST sets merge_commit_sha on an open PR too, to its test merge commit.
export async function mergeCommit(manifest, number) {
  const { body } = await clientFor(manifest).request('GET', `repos/${manifest.repo.github}/pulls/${number}`)

  return body.merged_at ? (body.merge_commit_sha ?? null) : null
}

export async function deleteRemoteBranch(manifest, branch) {
  const ref = branch
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  await clientFor(manifest).request('DELETE', `repos/${manifest.repo.github}/git/refs/heads/${ref}`)
}

export async function findReleasePr(manifest) {
  const prs = await clientFor(manifest).pages(`repos/${manifest.repo.github}/pulls`, { query: { state: 'open' } })
  const release = prs.find((githubPr) => manifest.repo.neverMerge.titles.includes(githubPr.title.trim()))

  if (!release) {
    return null
  }

  return { number: release.number, title: release.title, headRefName: release.head.ref, url: release.html_url }
}

// Without repo.agentToken the driver posts under the maintainer's login. The
// marker on the last line is what tells its comments apart from theirs.
export const DRIVER_MARKER = '<!-- rollout-driver -->'

function withDriverMarker(body) {
  return `${body.trimEnd()}\n\n${DRIVER_MARKER}`
}

// Only the last line counts, so a maintainer who quotes or mentions the
// marker in a comment is still heard.
function isDriverBody(body) {
  if (typeof body !== 'string') {
    return false
  }

  const lines = body.trimEnd().split(/\r?\n/)

  return lines.at(-1) === DRIVER_MARKER
}

// Only the reviews are shared with the tick. The comments are read once a tick anyway.
export async function feedbackFor(manifest, number, { reads = null } = {}) {
  const client = clientFor(manifest)
  const [inline, reviews, conversation] = await Promise.all([
    client.pages(`repos/${manifest.repo.github}/pulls/${number}/comments`),
    reviewList(manifest, number, reads),
    client.pages(`repos/${manifest.repo.github}/issues/${number}/comments`),
  ])

  return maintainerFeedback(manifest, { inline, reviews, conversation })
}

// Everything a maintainer wrote on a PR that asks for work: inline review
// comments, the bodies of COMMENTED / CHANGES_REQUESTED reviews, and
// conversation comments. Each item has a stable id to remember it by.
export function maintainerFeedback(manifest, { inline, reviews, conversation }) {
  const maintainers = new Set(manifest.repo.maintainers)
  const fromMaintainer = (item) => maintainers.has(item.user?.login) && !isDriverBody(item.body)
  const items = []

  for (const comment of inline.filter(fromMaintainer)) {
    items.push({
      id: `inline-${comment.id}`,
      commentId: comment.id,
      at: comment.created_at,
      body: comment.body,
      path: comment.path,
      line: comment.line ?? comment.original_line,
      hunk: comment.diff_hunk,
      replyTo: comment.in_reply_to_id ?? null,
    })
  }

  for (const review of reviews.filter(fromMaintainer)) {
    if (['COMMENTED', 'CHANGES_REQUESTED'].includes(review.state) && review.body?.trim()) {
      items.push({ id: `review-${review.id}`, at: review.submitted_at, body: review.body })
    }
  }

  for (const comment of conversation.filter(fromMaintainer)) {
    items.push({ id: `conversation-${comment.id}`, at: comment.created_at, body: comment.body })
  }

  return items.sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
}

// Replies and comments the driver posts go out as the agents' account, or as
// the maintainer without repo.agentToken.
export async function replyAsAgents(manifest, number, commentId, body) {
  const path = `repos/${manifest.repo.github}/pulls/${number}/comments/${commentId}/replies`

  await clientFor(manifest).request('POST', path, { as: 'agents', body: { body: withDriverMarker(body) } })
}

export async function commentAsAgents(manifest, number, body) {
  const path = `repos/${manifest.repo.github}/issues/${number}/comments`

  await clientFor(manifest).request('POST', path, { as: 'agents', body: { body: withDriverMarker(body) } })
}
