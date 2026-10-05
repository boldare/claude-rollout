import { makeEnv, sh, shOk } from './sh.mjs'
import { summarizeChecks } from './checks.mjs'
import { needsAdmin } from './judge.mjs'
import { agentGitHubEnv } from './identity.mjs'

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

export async function ensureLabel(manifest) {
  await gh(manifest, ['label', 'create', manifest.label, '--color', '5319e7', '--description', 'Managed by the rollout driver', '--force'])
}

// Stage labels in blue, reasons in orange. --force makes create idempotent.
const STAGE_COLORS = { 'rollout-stage:': '1d76db', 'rollout-reason:': 'd93f0b' }

export async function setStageLabels(manifest, number, { add, remove }) {
  for (const label of add) {
    const color = Object.entries(STAGE_COLORS).find(([prefix]) => label.startsWith(prefix))?.[1] ?? 'ededed'

    await gh(manifest, ['label', 'create', label, '--color', color, '--description', 'Rollout stage, set by the driver', '--force'])
  }

  const args = [...add.flatMap((label) => ['--add-label', label]), ...remove.flatMap((label) => ['--remove-label', label])]

  if (args.length > 0) {
    await gh(manifest, ['pr', 'edit', String(number), ...args])
  }
}

const PR_FIELDS = 'number,state,isDraft,baseRefName,headRefName,headRefOid,labels,title,body,mergeable,mergeStateStatus,mergedAt,url,author'

export async function findPr(manifest, branch) {
  const out = await gh(manifest, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json', PR_FIELDS])
  const prs = JSON.parse(out).map((githubPr) => ({
    ...githubPr,
    author: githubPr.author?.login ?? null,
    labels: githubPr.labels.map((label) => label.name),
  }))

  return prs.find((githubPr) => githubPr.state === 'OPEN') ?? prs.find((githubPr) => githubPr.state === 'MERGED') ?? prs[0] ?? null
}

export async function viewPr(manifest, number) {
  const out = await gh(manifest, ['pr', 'view', String(number), '--json', PR_FIELDS])
  const githubPr = JSON.parse(out)

  return { ...githubPr, author: githubPr.author?.login ?? null, labels: githubPr.labels.map((label) => label.name) }
}

// Reviews as GitHub records them: who, what, on which commit, when.
export async function reviewsFor(manifest, number) {
  const out = await gh(manifest, ['api', '-X', 'GET', `repos/${manifest.repo.github}/pulls/${number}/reviews`, '-f', 'per_page=100'])

  return JSON.parse(out).map((review) => ({
    user: review.user?.login ?? null,
    state: review.state,
    commit: review.commit_id,
    at: review.submitted_at,
  }))
}

export async function checksFor(manifest, sha) {
  const out = await gh(manifest, ['api', '-X', 'GET', `repos/${manifest.repo.github}/commits/${sha}/check-runs`, '-f', 'per_page=100'])
  const runs = JSON.parse(out).check_runs.map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
  }))

  return summarizeChecks(runs, manifest.repo.requiredChecks)
}

// One page of the code scanning alerts API, open alerts only.
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
  const text = String(error?.message ?? error)

  if (text.includes('(HTTP 404)')) {
    return true
  }

  return text.includes('(HTTP 403)') && !/rate limit/i.test(text)
}

// How gh, git, curl and ssh say that GitHub or the network is down, slow or
// rate limiting. Every rule spans a space: git echoes branch names, which
// never hold one but can hold a bare "timeout".
const UNAVAILABLE = [
  /\bHTTP (5\d\d|429)\b/i,
  /non-200 OK status code: (5\d\d|429)\b/i,
  /The requested URL returned error: (5\d\d|429)\b/i,
  /Server Error/i,
  /Something went wrong while executing your query/i,
  /rate limit/i,
  /Could not resolve host/i,
  /no such host/i,
  /error connecting to /i,
  /Failed to connect to /i,
  /Couldn't connect to server/i,
  /connection refused/i,
  /connection reset/i,
  /network is unreachable/i,
  /TLS handshake/i,
  /ssh: connect to host \S+ port \d+/i,
  /timed out/i,
  /i\/o timeout/i,
  /Client\.Timeout exceeded/i,
  /deadline exceeded/i,
]

// True when a failure comes from GitHub or the network as a whole, not from
// the call. Only the tool's output counts: the command line can hold a PR
// title. An AggregateError is an outage only when every error in it is one.
// Right after a sleep the network may still be down in ways no rule knows,
// so with afterSleep every failed gh or git command is one.
export function githubUnavailable(error, { afterSleep = false } = {}) {
  if (Array.isArray(error?.errors)) {
    return error.errors.length > 0 && error.errors.every((inner) => githubUnavailable(inner, { afterSleep }))
  }

  if (afterSleep && /^(gh|git) /.test(error?.message ?? '')) {
    return true
  }

  const text = ghError(error)

  return UNAVAILABLE.some((rule) => rule.test(text))
}

// What gh said, without the command line shOk puts before it.
export function ghError(error) {
  const text = String(error?.message ?? error)
  const exited = text.match(/ exited \S+: /)

  return exited ? text.slice(exited.index + exited[0].length) : text
}

const ALERTS_PER_PAGE = 100

async function openAlerts(manifest, ref) {
  const alerts = []

  for (let page = 1; ; page += 1) {
    const out = await gh(manifest, [
      'api',
      '-X',
      'GET',
      `repos/${manifest.repo.github}/code-scanning/alerts`,
      '-f',
      `ref=${ref}`,
      '-f',
      'state=open',
      '-f',
      `per_page=${ALERTS_PER_PAGE}`,
      '-f',
      `page=${page}`,
    ])
    const json = JSON.parse(out)
    alerts.push(...alertsFrom(json))

    if (!Array.isArray(json) || json.length < ALERTS_PER_PAGE) {
      return alerts
    }
  }
}

// Open alerts on the PR head, and the numbers of those also open on the base.
// An alert keeps its number across branches, so the numbers tell new from old.
export async function codeScanningFor(manifest, number) {
  try {
    const alerts = await openAlerts(manifest, `refs/pull/${number}/head`)

    if (alerts.length === 0) {
      return { available: true, alerts: [], baseOpen: [] }
    }

    const baseOpen = (await openAlerts(manifest, `refs/heads/${manifest.repo.base}`)).map((alert) => alert.number)

    return { available: true, alerts, baseOpen }
  } catch (error) {
    if (!codeScanningUnavailable(error)) {
      throw error
    }

    return { available: false, reason: ghError(error).slice(0, 200), alerts: [], baseOpen: [] }
  }
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

// Facts about one PR head for the gate and the policy check.
export async function collectFacts(manifest, pr, entry, ledger) {
  const githubPr = entry.pr ? await viewPr(manifest, entry.pr) : await findPr(manifest, pr.branch)
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
    mainChecks: { state: 'pending', missing: [], pending: [], failing: [], runs: [] },
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

  facts.reviews = await reviewsFor(manifest, githubPr.number)
  facts.checks = await checksFor(manifest, sha)
  facts.mainChecks = await checksFor(manifest, await mainHead(manifest))

  if (manifest.repo.codeScanning.action !== 'ignore') {
    facts.codeScanning = await codeScanningFor(manifest, githubPr.number)
  }

  return facts
}

// A dependency counts as merged when the ledger says so, or, for PRs outside
// this run's --only set, when GitHub shows its branch merged.
export function depsPending(manifest, pr, ledger) {
  return pr.deps.filter((dep) => ledger.prs[dep]?.state !== 'merged')
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

export async function mergeCommit(manifest, number) {
  const out = await gh(manifest, ['pr', 'view', String(number), '--json', 'state,mergeCommit'])
  const githubPr = JSON.parse(out)

  return githubPr.state === 'MERGED' ? (githubPr.mergeCommit?.oid ?? null) : null
}

export async function deleteRemoteBranch(manifest, branch) {
  await sh('gh', ['api', '-X', 'DELETE', `repos/${manifest.repo.github}/git/refs/heads/${branch}`], {
    env: ghEnv(manifest),
    cwd: manifest.repo.path,
  })
}

export async function findReleasePr(manifest) {
  const out = await gh(manifest, ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,url'])

  return JSON.parse(out).find((githubPr) => manifest.repo.neverMerge.titles.includes(githubPr.title.trim())) ?? null
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

export async function feedbackFor(manifest, number) {
  const api = async (path) =>
    JSON.parse(await gh(manifest, ['api', '-X', 'GET', `repos/${manifest.repo.github}/${path}`, '-f', 'per_page=100']))
  const [inline, reviews, conversation] = await Promise.all([
    api(`pulls/${number}/comments`),
    api(`pulls/${number}/reviews`),
    api(`issues/${number}/comments`),
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

  await shOk('gh', ['api', '-X', 'POST', path, '-f', `body=${withDriverMarker(body)}`], {
    env: ghEnv(manifest, agentGitHubEnv(manifest)),
    cwd: manifest.repo.path,
  })
}

export async function commentAsAgents(manifest, number, body) {
  await shOk('gh', ['pr', 'comment', String(number), '--body-file', '-'], {
    env: ghEnv(manifest, agentGitHubEnv(manifest)),
    cwd: manifest.repo.path,
    input: withDriverMarker(body),
  })
}
