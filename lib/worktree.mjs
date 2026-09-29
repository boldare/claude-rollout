import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEnv, sh, shOk } from './sh.mjs'
import { agentGitHubEnv } from './identity.mjs'

// Worktrees live next to the rollout directory, not inside it, so agents
// working in them are nowhere near the ledger, the inbox or the manifest.
export function worktreePath(M, pr) {
  return join(M.wtRoot, pr.id)
}

function git(M, cwd, args, options = {}) {
  return shOk('git', ['-C', cwd, ...args], { env: makeEnv(M), ...options })
}

async function gitDir(M, wt) {
  return (await git(M, wt, ['rev-parse', '--absolute-git-dir'])).trim()
}

async function remoteBranchExists(M, branch) {
  const result = await sh('git', ['-C', M.repo.path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
    env: makeEnv(M),
  })

  return result.code === 0
}

async function localBranchSha(M, branch) {
  const result = await sh('git', ['-C', M.repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { env: makeEnv(M) })

  return result.code === 0 ? result.stdout.trim() : null
}

// Writes to the shared .git (worktree add, config) are serialized: two PRs
// starting in the same tick would otherwise fight over the config lock.
let queue = Promise.resolve()

function serialized(task) {
  const run = queue.then(task, task)
  queue = run.catch(() => {})

  return run
}

export function enableWorktreeConfig(M) {
  return serialized(() => git(M, M.repo.path, ['config', 'extensions.worktreeConfig', 'true']))
}

async function isReady(M, wt) {
  if (!existsSync(join(wt, '.git'))) {
    return false
  }

  return existsSync(join(await gitDir(M, wt), 'rollout-ready'))
}

// Hooks, the push marker and the upstream: everything that makes a worktree
// safe for an agent. Idempotent, so a half-prepared worktree is completed.
async function configure(M, pr, wt, fromRemote) {
  const dir = await gitDir(M, wt)

  await git(M, wt, ['config', '--worktree', 'core.hooksPath', join(M.home, 'git-hooks')])
  writeFileSync(join(dir, 'rollout-branch'), pr.branch)

  // Pushes go over HTTPS with the agents' token (through gh), never with the
  // maintainer's SSH key; fetches keep using the normal remote URL.
  if (M.repo.agentToken) {
    const ghBin = (await sh('sh', ['-c', 'command -v gh'], { env: makeEnv(M) })).stdout.trim() || 'gh'

    await git(M, wt, ['config', '--worktree', 'remote.origin.pushurl', M.repo.pushUrl])
    await git(M, wt, ['config', '--worktree', '--unset-all', 'credential.helper']).catch(() => {})
    await git(M, wt, ['config', '--worktree', '--add', 'credential.helper', ''])
    await git(M, wt, ['config', '--worktree', '--add', 'credential.helper', `!${ghBin} auth git-credential`])
    writeFileSync(join(dir, 'rollout-pushurl'), M.repo.pushUrl)
  }

  if (!fromRemote) {
    await git(M, wt, ['branch', '--unset-upstream']).catch(() => {})
  }
}

// A worktree with no pushed branch, no commits of its own and no changes has
// done no work yet (its agent died on start). Moves it to the current base,
// so it does not build on a base that other PRs have merged into since.
async function refreshUntouched(M, pr, wt) {
  if (await remoteBranchExists(M, pr.branch)) {
    return false
  }

  const base = `origin/${M.repo.base}`
  const head = (await git(M, wt, ['rev-parse', 'HEAD'])).trim()
  const target = (await git(M, wt, ['rev-parse', base])).trim()

  if (head === target) {
    return false
  }

  const ancestor = await sh('git', ['-C', wt, 'merge-base', '--is-ancestor', head, target], { env: makeEnv(M) })
  const dirty = (await git(M, wt, ['status', '--porcelain'])).trim()

  if (ancestor.code !== 0 || dirty) {
    return false
  }

  await git(M, wt, ['merge', '--quiet', '--ff-only', target])

  return true
}

async function install(M, wt) {
  if (M.repo.install) {
    await shOk('sh', ['-c', M.repo.install], { cwd: wt, env: makeEnv(M), timeout: 20 * 60_000 })
  }
}

// A worktree per PR, on the PR branch. Reused when it is ready (retries and
// fixes continue the same work, an untouched one moves to the current base);
// otherwise created from the remote branch if a PR already pushed, else from
// a fresh origin/<base>.
export async function prepareWorktree(M, pr) {
  const wt = worktreePath(M, pr)

  if (await isReady(M, wt)) {
    const moved = await serialized(async () => {
      await configure(M, pr, wt, true)

      // Best effort: a failed fetch leaves the worktree as it was.
      const fetched = await sh('git', ['-C', M.repo.path, 'fetch', '--quiet', '--prune', 'origin'], { env: makeEnv(M) })

      return fetched.code === 0 && refreshUntouched(M, pr, wt)
    })

    if (moved) {
      await install(M, wt)
    }

    return wt
  }

  await serialized(async () => {
    await git(M, M.repo.path, ['fetch', '--quiet', '--prune', 'origin'])

    const fromRemote = await remoteBranchExists(M, pr.branch)

    if (!existsSync(join(wt, '.git'))) {
      const start = fromRemote ? `origin/${pr.branch}` : `origin/${M.repo.base}`
      const local = await localBranchSha(M, pr.branch)

      if (local) {
        const startSha = (await git(M, M.repo.path, ['rev-parse', start])).trim()

        if (local !== startSha) {
          throw new Error(`local branch ${pr.branch} exists at ${local.slice(0, 7)} and differs from ${start}; rename or delete it first`)
        }
      }

      await git(M, M.repo.path, ['worktree', 'add', '-B', pr.branch, wt, start])
    }

    await configure(M, pr, wt, fromRemote)
  })

  await install(M, wt)
  writeFileSync(join(await gitDir(M, wt), 'rollout-ready'), new Date().toISOString())

  return wt
}

// Mechanical rebase of the head the gate judged onto the base branch. The
// push leases exactly that head, so anything pushed meanwhile is not lost.
// On conflict the rebase is aborted and the conflicting files are returned.
export async function rebaseWorktree(M, pr, headSha) {
  const wt = await prepareWorktree(M, pr)
  const env = makeEnv(M)

  await git(M, wt, ['fetch', '--quiet', 'origin'])

  const dirty = (await git(M, wt, ['status', '--porcelain', '--untracked-files=no'])).trim()

  if (dirty) {
    return { ok: false, conflicts: [], reason: `worktree has uncommitted changes:\n${dirty}` }
  }

  await git(M, wt, ['checkout', '--quiet', '-B', pr.branch, headSha])

  const result = await sh('git', ['-C', wt, 'rebase', `origin/${M.repo.base}`], { env })

  if (result.code !== 0) {
    const conflicts = (await sh('git', ['-C', wt, 'diff', '--name-only', '--diff-filter=U'], { env })).stdout.split('\n').filter(Boolean)
    await sh('git', ['-C', wt, 'rebase', '--abort'], { env })

    return { ok: false, conflicts, reason: result.stderr.trim() || result.stdout.trim() }
  }

  await git(M, wt, ['push', `--force-with-lease=refs/heads/${pr.branch}:${headSha}`, 'origin', `HEAD:refs/heads/${pr.branch}`], {
    env: makeEnv(M, agentGitHubEnv(M)),
  })

  return { ok: true, conflicts: [], head: (await git(M, wt, ['rev-parse', 'HEAD'])).trim() }
}

// Puts a clean worktree on the given PR head before a verifier reads it.
export async function alignWorktree(M, pr, sha) {
  const wt = await prepareWorktree(M, pr)
  const dirty = (await git(M, wt, ['status', '--porcelain'])).trim()

  if (dirty) {
    return { ok: false, reason: `worktree has uncommitted changes:\n${dirty.slice(0, 1500)}` }
  }

  const head = (await git(M, wt, ['rev-parse', 'HEAD'])).trim()

  if (head !== sha) {
    await git(M, wt, ['fetch', '--quiet', 'origin', `+refs/heads/${pr.branch}:refs/remotes/origin/${pr.branch}`])

    const behind = await sh('git', ['-C', wt, 'merge-base', '--is-ancestor', head, sha], { env: makeEnv(M) })

    if (behind.code !== 0) {
      return { ok: false, reason: `local HEAD ${head.slice(0, 7)} has commits that are not in the PR head ${sha.slice(0, 7)}` }
    }

    await git(M, wt, ['checkout', '--quiet', '-B', pr.branch, sha])
  }

  return { ok: true, wt }
}

export async function inspectWorktree(M, pr) {
  const wt = worktreePath(M, pr)
  const status = (await git(M, wt, ['status', '--porcelain'])).trim()
  const head = (await git(M, wt, ['rev-parse', 'HEAD'])).trim()

  return { clean: status === '', status, head }
}

// Puts the worktree back on a pushed head, dropping local changes and
// untracked files (ignored build output stays).
export async function resetWorktree(M, pr, sha) {
  const wt = worktreePath(M, pr)

  await git(M, wt, ['reset', '--quiet', '--hard', sha])
  await git(M, wt, ['clean', '-fdq'])
}

export async function removeWorktree(M, pr) {
  const wt = worktreePath(M, pr)
  const env = makeEnv(M)

  await serialized(async () => {
    await sh('git', ['-C', M.repo.path, 'worktree', 'remove', '--force', wt], { env })
    await sh('git', ['-C', M.repo.path, 'branch', '-D', pr.branch], { env })
  })
}
