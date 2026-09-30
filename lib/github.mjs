import { makeEnv, sh, shOk } from './sh.mjs'
import { summarizeChecks } from './checks.mjs'
import { needsAdmin } from './judge.mjs'
import { agentGitHubEnv } from './identity.mjs'

// Everything the driver knows about GitHub and git comes from here, as plain
// facts. The gate (judge.mjs) decides; this module only reads and acts.
function gh(M, args, options = {}) {
  return shOk('gh', args, { env: ghEnv(M), cwd: M.repo.path, ...options })
}

// Without the pin, gh takes the repository from the clone's remotes or
// `gh repo set-default`, and the host from GH_HOST. The API paths and the
// push URL already name repo.github on github.com.
export function ghEnv(M, extra = {}) {
  return makeEnv(M, { ...extra, GH_REPO: `github.com/${M.repo.github}`, GH_HOST: 'github.com' })
}

function git(M, args, options = {}) {
  return shOk('git', ['-C', M.repo.path, ...args], { env: makeEnv(M), ...options })
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

export async function fetchOrigin(M) {
  await git(M, ['fetch', '--quiet', '--prune', 'origin'])
}

export async function ensureLabel(M) {
  await gh(M, ['label', 'create', M.label, '--color', '5319e7', '--description', 'Managed by the rollout driver', '--force'])
}

const PR_FIELDS = 'number,state,isDraft,baseRefName,headRefName,headRefOid,labels,title,body,mergeable,mergeStateStatus,mergedAt,url,author'

export async function findPr(M, branch) {
  const out = await gh(M, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json', PR_FIELDS])
  const prs = JSON.parse(out).map((p) => ({ ...p, author: p.author?.login ?? null, labels: p.labels.map((label) => label.name) }))

  return prs.find((p) => p.state === 'OPEN') ?? prs.find((p) => p.state === 'MERGED') ?? prs[0] ?? null
}

export async function viewPr(M, number) {
  const out = await gh(M, ['pr', 'view', String(number), '--json', PR_FIELDS])
  const p = JSON.parse(out)

  return { ...p, author: p.author?.login ?? null, labels: p.labels.map((label) => label.name) }
}

// Reviews as GitHub records them: who, what, on which commit, when.
export async function reviewsFor(M, number) {
  const out = await gh(M, ['api', '-X', 'GET', `repos/${M.repo.github}/pulls/${number}/reviews`, '-f', 'per_page=100'])

  return JSON.parse(out).map((review) => ({
    user: review.user?.login ?? null,
    state: review.state,
    commit: review.commit_id,
    at: review.submitted_at,
  }))
}

export async function checksFor(M, sha) {
  const out = await gh(M, ['api', '-X', 'GET', `repos/${M.repo.github}/commits/${sha}/check-runs`, '-f', 'per_page=100'])
  const runs = JSON.parse(out).check_runs.map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
  }))

  return summarizeChecks(runs, M.repo.requiredChecks)
}

export async function mainHead(M) {
  return (await git(M, ['rev-parse', `origin/${M.repo.base}`])).trim()
}

async function ensureCommit(M, branch, sha) {
  const known = await sh('git', ['-C', M.repo.path, 'cat-file', '-e', `${sha}^{commit}`], { env: makeEnv(M) })

  if (known.code !== 0) {
    await git(M, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
  }
}

export async function patchId(M, base, sha) {
  const diff = await git(M, ['diff', `${base}...${sha}`])

  if (diff.trim() === '') {
    return 'empty'
  }

  // --verbatim: whitespace changes are changes (a verified patch must be exact).
  const out = await shOk('git', ['patch-id', '--verbatim'], { env: makeEnv(M), input: diff })

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
export async function collectFacts(M, pr, s, L) {
  const p = s.pr ? await viewPr(M, s.pr) : await findPr(M, pr.branch)
  const base = `origin/${M.repo.base}`
  const facts = {
    halted: L.data.halted,
    pr: p,
    depsPending: depsPending(M, pr, L),
    files: [],
    addedLines: [],
    commits: [],
    changesets: [],
    patchId: null,
    baseIsAncestor: false,
    reviews: [],
    checks: { state: 'pending', missing: [], pending: [], failing: [], runs: [] },
    mainChecks: { state: 'pending', missing: [], pending: [], failing: [], runs: [] },
  }

  if (!p || p.state !== 'OPEN') {
    return facts
  }

  const sha = p.headRefOid
  await ensureCommit(M, pr.branch, sha)

  facts.files = parseNameStatus(await git(M, ['diff', '--name-status', '-M', `${base}...${sha}`]))
  facts.addedLines = parseAddedLines(await git(M, ['diff', '-U0', '--no-color', `${base}...${sha}`]))
  facts.commits = parseCommits(await git(M, ['log', '--format=%H%x1f%B%x1e', `${base}..${sha}`]))
  facts.patchId = await patchId(M, base, sha)
  facts.baseIsAncestor = (await sh('git', ['-C', M.repo.path, 'merge-base', '--is-ancestor', base, sha], { env: makeEnv(M) })).code === 0

  for (const file of facts.files) {
    if (/^\.changeset\/[^/]+\.md$/.test(file.path) && file.status !== 'removed' && !/README\.md$/i.test(file.path)) {
      facts.changesets.push({ path: file.path, text: await git(M, ['show', `${sha}:${file.path}`]) })
    }
  }

  facts.reviews = await reviewsFor(M, p.number)
  facts.checks = await checksFor(M, sha)
  facts.mainChecks = await checksFor(M, await mainHead(M))

  return facts
}

// A dependency counts as merged when the ledger says so, or, for PRs outside
// this run's --only set, when GitHub shows its branch merged.
export function depsPending(M, pr, L) {
  return pr.deps.filter((dep) => L.prs[dep]?.state !== 'merged')
}

export async function refreshOutsideDeps(M, L) {
  const active = new Set(M.prs.map((pr) => pr.id))
  const outside = new Set(M.prs.flatMap((pr) => pr.deps).filter((dep) => !active.has(dep)))

  for (const id of outside) {
    const dep = M.all.find((pr) => pr.id === id)
    const p = await findPr(M, dep.branch)
    const ours = p && p.labels.includes(M.label) && p.baseRefName === M.repo.base

    if (p?.state === 'MERGED' && ours && L.prs[id].state !== 'merged') {
      L.prs[id].state = 'merged'
      L.prs[id].pr = p.number
      L.event(id, 'merged-outside-run', { pr: p.number })
    }
  }
}

export async function merge(M, pr, s, facts) {
  const p = facts.pr
  const args = [
    'pr',
    'merge',
    String(p.number),
    `--${M.repo.merge.method}`,
    '--match-head-commit',
    p.headRefOid,
    '--subject',
    `${p.title} (#${p.number})`,
    '--body',
    '',
  ]

  if (needsAdmin(M, facts)) {
    args.push('--admin')
  }

  await gh(M, args)

  // The merge happened; reading its commit back must not turn it into an
  // error (sync() records it later if this fails).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sha = await mergeCommit(M, p.number).catch(() => null)

    if (sha) {
      return sha
    }
  }

  return null
}

export async function mergeCommit(M, number) {
  const out = await gh(M, ['pr', 'view', String(number), '--json', 'state,mergeCommit'])
  const p = JSON.parse(out)

  return p.state === 'MERGED' ? (p.mergeCommit?.oid ?? null) : null
}

export async function deleteRemoteBranch(M, branch) {
  await sh('gh', ['api', '-X', 'DELETE', `repos/${M.repo.github}/git/refs/heads/${branch}`], { env: ghEnv(M), cwd: M.repo.path })
}

export async function findReleasePr(M) {
  const out = await gh(M, ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,url'])

  return JSON.parse(out).find((p) => M.repo.neverMerge.titles.includes(p.title.trim())) ?? null
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

export async function feedbackFor(M, number) {
  const api = async (path) => JSON.parse(await gh(M, ['api', '-X', 'GET', `repos/${M.repo.github}/${path}`, '-f', 'per_page=100']))
  const [inline, reviews, conversation] = await Promise.all([
    api(`pulls/${number}/comments`),
    api(`pulls/${number}/reviews`),
    api(`issues/${number}/comments`),
  ])

  return maintainerFeedback(M, { inline, reviews, conversation })
}

// Everything a maintainer wrote on a PR that asks for work: inline review
// comments, the bodies of COMMENTED / CHANGES_REQUESTED reviews, and
// conversation comments. Each item has a stable id to remember it by.
export function maintainerFeedback(M, { inline, reviews, conversation }) {
  const maintainers = new Set(M.repo.maintainers)
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

  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

// Replies and comments the driver posts go out as the agents' account, or as
// the maintainer without repo.agentToken.
export async function replyAsAgents(M, number, commentId, body) {
  const path = `repos/${M.repo.github}/pulls/${number}/comments/${commentId}/replies`

  await shOk('gh', ['api', '-X', 'POST', path, '-f', `body=${withDriverMarker(body)}`], {
    env: ghEnv(M, agentGitHubEnv(M)),
    cwd: M.repo.path,
  })
}

export async function commentAsAgents(M, number, body) {
  await shOk('gh', ['pr', 'comment', String(number), '--body-file', '-'], {
    env: ghEnv(M, agentGitHubEnv(M)),
    cwd: M.repo.path,
    input: withDriverMarker(body),
  })
}
