import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEnv, sh, shOk } from './sh.mjs'
import { agentGitHubEnv } from './identity.mjs'

// Worktrees live next to the rollout directory, not inside it, so agents
// working in them are nowhere near the ledger, the inbox or the manifest.
export function worktreePath(manifest, pr) {
  return join(manifest.wtRoot, pr.id)
}

function git(manifest, cwd, args, options = {}) {
  return shOk('git', ['-C', cwd, ...args], { env: makeEnv(manifest), ...options })
}

async function gitDir(manifest, wt) {
  return (await git(manifest, wt, ['rev-parse', '--absolute-git-dir'])).trim()
}

async function remoteBranchExists(manifest, branch) {
  const result = await sh('git', ['-C', manifest.repo.path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
    env: makeEnv(manifest),
  })

  return result.code === 0
}

async function localBranchSha(manifest, branch) {
  const result = await sh('git', ['-C', manifest.repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
    env: makeEnv(manifest),
  })

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

export function enableWorktreeConfig(manifest) {
  return serialized(() => git(manifest, manifest.repo.path, ['config', 'extensions.worktreeConfig', 'true']))
}

async function isReady(manifest, wt) {
  if (!existsSync(join(wt, '.git'))) {
    return false
  }

  return existsSync(join(await gitDir(manifest, wt), 'rollout-ready'))
}

// Hooks, the push marker and the upstream: everything that makes a worktree
// safe for an agent. Idempotent, so a half-prepared worktree is completed.
async function configure(manifest, pr, wt, fromRemote) {
  const dir = await gitDir(manifest, wt)

  await git(manifest, wt, ['config', '--worktree', 'core.hooksPath', join(manifest.home, 'git-hooks')])
  writeFileSync(join(dir, 'rollout-branch'), pr.branch)

  // Pushes go over HTTPS with the agents' token (through gh), never with the
  // maintainer's SSH key; fetches keep using the normal remote URL.
  if (manifest.repo.agentToken) {
    const ghBin = (await sh('sh', ['-c', 'command -v gh'], { env: makeEnv(manifest) })).stdout.trim() || 'gh'

    await git(manifest, wt, ['config', '--worktree', 'remote.origin.pushurl', manifest.repo.pushUrl])
    await git(manifest, wt, ['config', '--worktree', '--unset-all', 'credential.helper']).catch(() => {})
    await git(manifest, wt, ['config', '--worktree', '--add', 'credential.helper', ''])
    await git(manifest, wt, ['config', '--worktree', '--add', 'credential.helper', `!${ghBin} auth git-credential`])
    writeFileSync(join(dir, 'rollout-pushurl'), manifest.repo.pushUrl)
  }

  if (!fromRemote) {
    await git(manifest, wt, ['branch', '--unset-upstream']).catch(() => {})
  }
}

// Nothing pushed, committed or changed yet: move to the current base.
async function refreshUntouched(manifest, pr, wt) {
  if (await remoteBranchExists(manifest, pr.branch)) {
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

async function install(manifest, wt) {
  if (manifest.repo.install) {
    await shOk('sh', ['-c', manifest.repo.install], { cwd: wt, env: makeEnv(manifest), timeout: 20 * 60_000 })
  }
}

// A worktree per PR, on the PR branch. Reused when it is ready (retries and
// fixes continue the same work); otherwise created from the remote branch if
// a PR already pushed, else from a fresh origin/<base>.
export async function prepareWorktree(manifest, pr) {
  const wt = worktreePath(manifest, pr)

  if (await isReady(manifest, wt)) {
    const moved = await serialized(async () => {
      await configure(manifest, pr, wt, true)

      const fetched = await sh('git', ['-C', manifest.repo.path, 'fetch', '--quiet', '--prune', 'origin'], { env: makeEnv(manifest) })

      return fetched.code === 0 && refreshUntouched(manifest, pr, wt)
    })

    if (moved) {
      await install(manifest, wt)
    }

    return wt
  }

  await serialized(async () => {
    await git(manifest, manifest.repo.path, ['fetch', '--quiet', '--prune', 'origin'])

    const fromRemote = await remoteBranchExists(manifest, pr.branch)

    if (!existsSync(join(wt, '.git'))) {
      const start = fromRemote ? `origin/${pr.branch}` : `origin/${manifest.repo.base}`
      const local = await localBranchSha(manifest, pr.branch)

      if (local) {
        const startSha = (await git(manifest, manifest.repo.path, ['rev-parse', start])).trim()

        if (local !== startSha) {
          throw new Error(`local branch ${pr.branch} exists at ${local.slice(0, 7)} and differs from ${start}; rename or delete it first`)
        }
      }

      await git(manifest, manifest.repo.path, ['worktree', 'add', '-B', pr.branch, wt, start])
    }

    await configure(manifest, pr, wt, fromRemote)
  })

  await install(manifest, wt)
  writeFileSync(join(await gitDir(manifest, wt), 'rollout-ready'), new Date().toISOString())

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

// Puts a clean worktree on the given PR head before a verifier reads it.
export async function alignWorktree(manifest, pr, sha) {
  const wt = await prepareWorktree(manifest, pr)
  const dirty = (await git(manifest, wt, ['status', '--porcelain'])).trim()

  if (dirty) {
    return { ok: false, reason: `worktree has uncommitted changes:\n${dirty.slice(0, 1500)}` }
  }

  const head = (await git(manifest, wt, ['rev-parse', 'HEAD'])).trim()

  if (head !== sha) {
    await git(manifest, wt, ['fetch', '--quiet', 'origin', `+refs/heads/${pr.branch}:refs/remotes/origin/${pr.branch}`])

    const behind = await sh('git', ['-C', wt, 'merge-base', '--is-ancestor', head, sha], { env: makeEnv(manifest) })

    if (behind.code !== 0) {
      return { ok: false, reason: `local HEAD ${head.slice(0, 7)} has commits that are not in the PR head ${sha.slice(0, 7)}` }
    }

    await git(manifest, wt, ['checkout', '--quiet', '-B', pr.branch, sha])
  }

  return { ok: true, wt }
}

export async function inspectWorktree(manifest, pr) {
  const wt = worktreePath(manifest, pr)
  const status = (await git(manifest, wt, ['status', '--porcelain'])).trim()
  const head = (await git(manifest, wt, ['rev-parse', 'HEAD'])).trim()

  return { clean: status === '', status, head }
}

// Puts the worktree back on a pushed head, dropping local changes and
// untracked files (ignored build output stays).
export async function resetWorktree(manifest, pr, sha) {
  const wt = worktreePath(manifest, pr)

  await git(manifest, wt, ['reset', '--quiet', '--hard', sha])
  await git(manifest, wt, ['clean', '-fdq'])
}

export async function removeWorktree(manifest, pr) {
  const wt = worktreePath(manifest, pr)
  const env = makeEnv(manifest)

  await serialized(async () => {
    await sh('git', ['-C', manifest.repo.path, 'worktree', 'remove', '--force', wt], { env })
    await sh('git', ['-C', manifest.repo.path, 'branch', '-D', pr.branch], { env })
  })
}
