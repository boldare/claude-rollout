import { existsSync, lstatSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { makeEnv, sh, shOk } from './sh.mjs'
import { agentGitHubEnv, readOnlyEnv } from './identity.mjs'

// Worktrees live next to the rollout directory, not inside it, so agents
// working in them are nowhere near the ledger, the inbox or the manifest.
export function worktreePath(manifest, pr) {
  return join(manifest.wtRoot, pr.id)
}

export function mirrorPath(manifest) {
  return join(manifest.wtRoot, 'mirror.git')
}

function git(manifest, cwd, args, options = {}) {
  return shOk('git', ['-C', cwd, ...args], { env: makeEnv(manifest), ...options })
}

async function remoteBranchExists(manifest, wt, branch) {
  const result = await sh('git', ['-C', wt, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
    env: makeEnv(manifest),
  })

  return result.code === 0
}

// The mirror is the only thing the clones share. Two PRs starting in the
// same tick would otherwise create it twice or update it while it is cloned.
let queue = Promise.resolve()

function serialized(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})

  return run
}

// The first mirror clone downloads the whole repository with the maintainer's
// credentials. git removes the directory of a clone that fails or is killed,
// so the next prepare starts over. A local clone hard-links the objects.
async function cloneFromMirror(manifest, wt) {
  const mirror = mirrorPath(manifest)

  await serialized(async () => {
    if (!existsSync(mirror)) {
      const url = (await git(manifest, manifest.repo.path, ['remote', 'get-url', 'origin'])).trim()

      await shOk('git', ['clone', '--mirror', '--quiet', url, mirror], { env: makeEnv(manifest), timeout: 60 * 60_000 })
    }

    await git(manifest, mirror, ['remote', 'update', '--prune'])
    await shOk('git', ['clone', '--quiet', '--no-checkout', mirror, wt], { env: makeEnv(manifest) })
  })
}

// A clone fetches and pushes over HTTPS through gh, so git signs in with the
// GH_TOKEN or the gh login of its environment. The empty helper drops the
// global config's helpers, which git would otherwise ask first.
async function connect(manifest, wt) {
  const ghBin = (await sh('sh', ['-c', 'command -v gh'], { env: makeEnv(manifest) })).stdout.trim() || 'gh'

  await git(manifest, wt, ['config', 'remote.origin.url', `https://github.com/${manifest.repo.github}.git`])
  await git(manifest, wt, ['config', 'core.hooksPath', join(manifest.home, 'git-hooks')])
  await git(manifest, wt, ['config', '--unset-all', 'credential.helper']).catch(() => {})
  await git(manifest, wt, ['config', '--add', 'credential.helper', ''])
  await git(manifest, wt, ['config', '--add', 'credential.helper', `!${ghBin} auth git-credential`])
}

// The GitHub origin, the hooks and the push markers: everything that makes a
// clone safe for an agent. Idempotent, so it runs on every prepare.
async function configure(manifest, pr, wt) {
  await connect(manifest, wt)
  writeFileSync(join(wt, '.git', 'rollout-branch'), pr.branch)

  // pre-push refuses any push URL but the marker's.
  if (manifest.repo.agentToken) {
    await git(manifest, wt, ['config', 'remote.origin.pushurl', manifest.repo.pushUrl])
    writeFileSync(join(wt, '.git', 'rollout-pushurl'), manifest.repo.pushUrl)
  }
}

// Nothing pushed, committed or changed yet: move to the current base.
async function refreshUntouched(manifest, pr, wt) {
  if (await remoteBranchExists(manifest, wt, pr.branch)) {
    return false
  }

  const base = `origin/${manifest.repo.base}`
  const head = (await git(manifest, wt, ['rev-parse', 'HEAD'])).trim()
  const target = (await git(manifest, wt, ['rev-parse', base])).trim()

  if (head === target) {
    return false
  }

  const ancestor = await sh('git', ['-C', wt, 'merge-base', '--is-ancestor', head, target], { env: makeEnv(manifest) })
  const dirty = (await git(manifest, wt, ['status', '--porcelain'])).trim()

  if (ancestor.code !== 0 || dirty) {
    return false
  }

  await git(manifest, wt, ['merge', '--quiet', '--ff-only', target])

  return true
}

// The install runs scripts from a worktree an agent may have written, so it
// gets the read-only agents' environment, not the maintainer's.
async function install(manifest, pr, wt) {
  if (!manifest.repo.install) {
    return
  }

  await shOk('sh', ['-c', manifest.repo.install], { cwd: wt, env: readOnlyEnv(manifest, 'install'), timeout: 20 * 60_000 })
}

async function refreshClone(manifest, pr, wt) {
  await configure(manifest, pr, wt)

  const fetched = await sh('git', ['-C', wt, 'fetch', '--quiet', '--prune', 'origin'], { env: makeEnv(manifest) })

  if (fetched.code === 0 && (await refreshUntouched(manifest, pr, wt))) {
    await install(manifest, pr, wt)
  }
}

// The fetch after the clone makes origin/* GitHub's refs, not the mirror's.
async function newClone(manifest, pr, wt) {
  await cloneFromMirror(manifest, wt)
  await configure(manifest, pr, wt)
  await git(manifest, wt, ['fetch', '--quiet', '--prune', 'origin'])

  const fromRemote = await remoteBranchExists(manifest, wt, pr.branch)
  const start = fromRemote ? `origin/${pr.branch}` : `origin/${manifest.repo.base}`

  await git(manifest, wt, ['checkout', '--quiet', '-B', pr.branch, start])

  if (!fromRemote) {
    await git(manifest, wt, ['branch', '--unset-upstream']).catch(() => {})
  }

  await install(manifest, pr, wt)
  writeFileSync(join(wt, '.git', 'rollout-ready'), new Date().toISOString())
}

// A clone per PR with its own .git, on the PR branch. A ready clone is reused,
// so retries and fixes continue the same work. Anything else at the path is a
// prepare that never finished, where no agent worked, because the ready marker
// is written before the first prepare returns. It gives way to a new clone,
// on the remote branch if a PR already pushed, else on a fresh origin/<base>.
export async function prepareWorktree(manifest, pr) {
  const wt = worktreePath(manifest, pr)
  const dotGit = lstatSync(join(wt, '.git'), { throwIfNoEntry: false })

  // A .git file means a worktree of repo.path. git config there would write
  // into repo.path's shared config, and the directory may hold unpushed work,
  // so it is neither configured nor deleted.
  if (dotGit && !dotGit.isDirectory()) {
    throw new Error(
      `${wt} is a git worktree of repo.path made by an earlier version of the driver. Save its work, delete the directory and retry.`,
    )
  }

  if (dotGit && existsSync(join(wt, '.git', 'rollout-ready'))) {
    await refreshClone(manifest, pr, wt)

    return wt
  }

  await rm(wt, { recursive: true, force: true })
  await newClone(manifest, pr, wt)

  return wt
}

// Where a brief written ahead of its dependencies works: origin/<base> with
// the verified head of each unmerged dependency merged in, detached and
// never pushed. Its pre-push hook finds no branch marker and refuses every
// push. Not the PR's own worktree, whose branch must start from the base the
// dependencies merged into.
export function previewPath(manifest, pr) {
  return join(manifest.wtRoot, `${pr.id}.brief`)
}

export async function removePreview(manifest, pr) {
  await rm(previewPath(manifest, pr), { recursive: true, force: true })
}

// The merges are local commits of the driver, so they get an identity and no
// signing. Null when a head does not merge cleanly or is not in the clone.
export async function preparePreview(manifest, pr, heads) {
  const wt = previewPath(manifest, pr)

  await removePreview(manifest, pr)
  await cloneFromMirror(manifest, wt)
  await connect(manifest, wt)
  await git(manifest, wt, ['fetch', '--quiet', '--prune', 'origin'])
  await git(manifest, wt, ['checkout', '--quiet', '--detach', `origin/${manifest.repo.base}`])

  for (const head of heads) {
    const identity = ['-c', 'user.name=rollout', '-c', 'user.email=rollout@localhost', '-c', 'commit.gpgsign=false']
    const message = `preview: ${head.id} at ${head.sha.slice(0, 7)}`
    const merged = await sh('git', ['-C', wt, ...identity, 'merge', '--quiet', '--no-ff', '-m', message, head.sha], {
      env: makeEnv(manifest),
    })

    if (merged.code !== 0) {
      await removePreview(manifest, pr)

      return null
    }
  }

  await install(manifest, pr, wt)

  return wt
}

// Mechanical rebase of the head the gate judged onto the base branch. The
// push leases exactly that head, so anything pushed meanwhile is not lost.
// On conflict the rebase is aborted and the conflicting files are returned.
export async function rebaseWorktree(manifest, pr, headSha) {
  const wt = await prepareWorktree(manifest, pr)
  const env = makeEnv(manifest)

  await git(manifest, wt, ['fetch', '--quiet', 'origin'])

  const dirty = (await git(manifest, wt, ['status', '--porcelain', '--untracked-files=no'])).trim()

  if (dirty) {
    return { ok: false, conflicts: [], reason: `worktree has uncommitted changes:\n${dirty}` }
  }

  await git(manifest, wt, ['checkout', '--quiet', '-B', pr.branch, headSha])

  const result = await sh('git', ['-C', wt, 'rebase', `origin/${manifest.repo.base}`], { env })

  if (result.code !== 0) {
    const conflicts = (await sh('git', ['-C', wt, 'diff', '--name-only', '--diff-filter=U'], { env })).stdout.split('\n').filter(Boolean)
    await sh('git', ['-C', wt, 'rebase', '--abort'], { env })

    return { ok: false, conflicts, reason: result.stderr.trim() || result.stdout.trim() }
  }

  await git(manifest, wt, ['push', `--force-with-lease=refs/heads/${pr.branch}:${headSha}`, 'origin', `HEAD:refs/heads/${pr.branch}`], {
    env: makeEnv(manifest, agentGitHubEnv(manifest)),
  })

  return { ok: true, conflicts: [], head: (await git(manifest, wt, ['rev-parse', 'HEAD'])).trim() }
}

// Claude Code loads these from the working directory, and a global gitignore
// can hide them from git status, so an agent can leave one for the next agent.
const LOCAL_CONFIG = ['.claude/settings.json', '.claude/settings.local.json', 'CLAUDE.local.md']

// Deletes the untracked ones and returns their paths. A tracked copy is in
// the PR's diff, where the gate and the maintainer see it. A symlinked
// .claude is never followed: deleting through it could remove files outside
// the worktree.
async function removeLocalConfig(manifest, wt) {
  const claudeDir = lstatSync(join(wt, '.claude'), { throwIfNoEntry: false })
  const candidates = claudeDir?.isDirectory() ? LOCAL_CONFIG : LOCAL_CONFIG.filter((path) => !path.startsWith('.claude/'))
  const present = candidates.filter((path) => lstatSync(join(wt, path), { throwIfNoEntry: false }))

  if (present.length === 0) {
    return []
  }

  const tracked = new Set((await git(manifest, wt, ['ls-files', '-z', '--', ...present])).split('\0'))
  const untracked = present.filter((path) => !tracked.has(path))

  for (const path of untracked) {
    rmSync(join(wt, path), { recursive: true, force: true })
  }

  return untracked
}

// Puts a clean worktree on the given PR head before a verifier reads it.
export async function alignWorktree(manifest, pr, sha) {
  const wt = await prepareWorktree(manifest, pr)
  const removed = await removeLocalConfig(manifest, wt)
  const dirty = (await git(manifest, wt, ['status', '--porcelain'])).trim()

  if (dirty) {
    return { ok: false, reason: `worktree has uncommitted changes:\n${dirty.slice(0, 1500)}`, removed }
  }

  const head = (await git(manifest, wt, ['rev-parse', 'HEAD'])).trim()

  if (head !== sha) {
    await git(manifest, wt, ['fetch', '--quiet', 'origin', `+refs/heads/${pr.branch}:refs/remotes/origin/${pr.branch}`])

    const behind = await sh('git', ['-C', wt, 'merge-base', '--is-ancestor', head, sha], { env: makeEnv(manifest) })

    if (behind.code !== 0) {
      return { ok: false, reason: `local HEAD ${head.slice(0, 7)} has commits that are not in the PR head ${sha.slice(0, 7)}`, removed }
    }

    await git(manifest, wt, ['checkout', '--quiet', '-B', pr.branch, sha])
  }

  return { ok: true, wt, removed }
}

export async function inspectWorktree(manifest, pr) {
  const wt = worktreePath(manifest, pr)
  const status = (await git(manifest, wt, ['status', '--porcelain'])).trim()
  const head = (await git(manifest, wt, ['rev-parse', 'HEAD'])).trim()

  return { clean: status === '', status, head }
}

// Puts the worktree back on a pushed head, dropping local changes and
// untracked files. Ignored build output stays, ignored Claude Code files do
// not. Returns the Claude Code files it removed, counted before git clean can
// remove them.
export async function resetWorktree(manifest, pr, sha) {
  const wt = worktreePath(manifest, pr)
  const removed = await removeLocalConfig(manifest, wt)

  await git(manifest, wt, ['reset', '--quiet', '--hard', sha])
  await git(manifest, wt, ['clean', '-fdq'])

  return removed
}

// A clone holds node_modules, and a synchronous delete would block the
// driver's event loop for seconds.
export async function removeWorktree(manifest, pr) {
  await rm(worktreePath(manifest, pr), { recursive: true, force: true })
}
