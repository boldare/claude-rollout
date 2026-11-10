import { existsSync, lstatSync, rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { makeEnv, sh, shOk } from './sh.mjs'
import { agentGitHubEnv, readOnlyEnv } from './identity.mjs'
import { commandRun, homePath, runOnce, runtimeFor } from './sandbox.mjs'

// Worktrees live next to the rollout directory, not inside it, so agents
// working in them are nowhere near the ledger, the inbox or the manifest.
export function worktreePath(manifest, pr) {
  return join(manifest.wtRoot, pr.id)
}

export function mirrorPath(manifest) {
  return join(manifest.wtRoot, 'mirror.git')
}

// For the mirror and repo.path only. No runtime ever mounts them.
function git(manifest, cwd, args, options = {}) {
  return shOk('git', ['-C', cwd, ...args], { env: makeEnv(manifest), ...options })
}

const GIT_TIMEOUT_MS = 10 * 60_000

// Git in a clone where no code from its checkout has run: a new clone
// before its install, and the brief preview, which is cloned fresh for every
// brief.
function hostGit(manifest, wt) {
  const options = { env: makeEnv(manifest), timeout: GIT_TIMEOUT_MS }

  return {
    wt,
    run: (args) => sh('git', ['-C', wt, ...args], options),
    script: (text, words) => sh('sh', ['-c', text, 'sh', ...words], options),
  }
}

// Git in a clone that code from its checkout may have run in. Under Docker
// that code can write .git/config, where core.fsmonitor, a filter or a hooks
// path names a program that almost any git command runs. So git runs in a
// container over the clone, with the bot's environment alone: makeEnv's
// GH_TOKEN may be the maintainer's, and containerEnv passes it on. Under the
// host runtime git runs as before, and only a push gets the bot's token.
function runtimeGit(manifest, pr, wt) {
  const docker = runtimeFor(manifest).name === 'docker'

  function envFor(push) {
    if (docker) {
      return agentGitHubEnv(manifest)
    }

    return push ? makeEnv(manifest, agentGitHubEnv(manifest)) : makeEnv(manifest)
  }

  function start(command, args, push = false) {
    const env = envFor(push)
    const spec = { command, args, cwd: wt, env, role: 'git', pr, run: commandRun(pr, 'git'), stdin: 'ignore', group: true }

    return runOnce(manifest, spec, { timeoutMs: GIT_TIMEOUT_MS })
  }

  return {
    wt,
    run: (args, { push = false } = {}) => start('git', ['-C', wt, ...args], push),
    script: (text, words) => start('sh', ['-c', text, 'sh', ...words]),
  }
}

// A script's git commands and the markers it writes, for its error message.
function scriptLabel(text) {
  const steps = [...text.matchAll(/git -C "\$1" ([a-z-]+)|\.git\/(rollout-[a-z]+)/g)].map((match) => match[1] ?? `> ${match[2]}`)

  return [...new Set(steps)].join(' && ')
}

// A failed git reads like shOk's, because githubUnavailable and ghError read
// it by its words.
function stdoutOf(result, shown) {
  if (result.code === 0) {
    return result.stdout
  }

  const command = shown.slice(0, 300)
  const output = result.stderr.trim() || result.stdout.trim()

  if (result.timedOut) {
    throw new Error(`${command} timed out after ${GIT_TIMEOUT_MS / 1000} s${output ? `: ${output}` : ''}`)
  }

  throw new Error(`${command} exited ${result.code ?? 1}: ${output}`)
}

async function gitOk(clone, args, options) {
  return stdoutOf(await clone.run(args, options), ['git', '-C', clone.wt, ...args].join(' '))
}

// The words arrive as $1, $2, …, so no path, branch or URL is ever part of
// the script's text.
async function scriptOk(clone, text, words) {
  return stdoutOf(await clone.script(text, words), `git -C ${clone.wt} ${scriptLabel(text)}`)
}

async function remoteBranchExists(clone, branch) {
  const result = await clone.run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])

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
// so the next prepare starts over. A clone shares no inode with the mirror,
// so an agent cannot rewrite the mirror's objects through it.
export async function cloneFromMirror(manifest, wt) {
  const mirror = mirrorPath(manifest)

  await serialized(async () => {
    if (!existsSync(mirror)) {
      const url = (await git(manifest, manifest.repo.path, ['remote', 'get-url', 'origin'])).trim()

      await shOk('git', ['clone', '--mirror', '--quiet', url, mirror], { env: makeEnv(manifest), timeout: 60 * 60_000 })
    }

    await git(manifest, mirror, ['remote', 'update', '--prune'])
    await shOk('git', ['clone', '--quiet', '--no-checkout', '--no-hardlinks', mirror, wt], { env: makeEnv(manifest) })
  })
}

// A clone fetches and pushes over HTTPS through gh, so git signs in with the
// GH_TOKEN or the gh login of its environment. The empty helper drops the
// global and system config's helpers, which git would otherwise ask first.
// gh comes from the PATH of whatever runs git, so the same helper works on
// the host and inside the agents' image. Words: the clone, the GitHub URL
// and the hooks.
const CONNECT = [
  'set -e',
  'git -C "$1" config remote.origin.url "$2"',
  'git -C "$1" config core.hooksPath "$3"',
  'git -C "$1" config --unset-all credential.helper || true',
  `git -C "$1" config --add credential.helper ''`,
  `git -C "$1" config --add credential.helper '!gh auth git-credential'`,
].join('\n')

// Words: connect's, then the branch and the push URL, which is empty without
// repo.agentToken. pre-push refuses any push URL but the marker's.
const CONFIGURE = [
  CONNECT,
  `printf '%s' "$4" > "$1/.git/rollout-branch"`,
  'if [ -n "$5" ]; then',
  '  git -C "$1" config remote.origin.pushurl "$5"',
  `  printf '%s' "$5" > "$1/.git/rollout-pushurl"`,
  'fi',
].join('\n')

function connectWords(manifest, clone) {
  return [clone.wt, `https://github.com/${manifest.repo.github}.git`, join(manifest.home, 'git-hooks')]
}

async function connect(manifest, clone) {
  await scriptOk(clone, CONNECT, connectWords(manifest, clone))
}

// The GitHub origin, the hooks and the push markers: everything that makes a
// clone safe for an agent. Idempotent, so it runs on every prepare. One
// script, so a ready clone takes one container start for all of it.
async function configure(manifest, pr, clone) {
  const pushUrl = manifest.repo.agentToken ? manifest.repo.pushUrl : ''

  await scriptOk(clone, CONFIGURE, [...connectWords(manifest, clone), pr.branch, pushUrl])
}

// Nothing pushed, committed or changed yet: move to the current base.
async function refreshUntouched(manifest, pr, clone) {
  if (await remoteBranchExists(clone, pr.branch)) {
    return false
  }

  const base = `origin/${manifest.repo.base}`
  const head = (await gitOk(clone, ['rev-parse', 'HEAD'])).trim()
  const target = (await gitOk(clone, ['rev-parse', base])).trim()

  if (head === target) {
    return false
  }

  const ancestor = await clone.run(['merge-base', '--is-ancestor', head, target])
  const dirty = (await gitOk(clone, ['status', '--porcelain'])).trim()

  if (ancestor.code !== 0 || dirty) {
    return false
  }

  await gitOk(clone, ['merge', '--quiet', '--ff-only', target])

  return true
}

const INSTALL_TIMEOUT_MS = 20 * 60_000

// The install runs scripts from a worktree an agent may have written, so it
// gets the read-only agents' environment, not the maintainer's, and runs
// through the runtime like a gate command. A failure reads as shOk's does.
async function install(manifest, pr, wt) {
  if (!manifest.repo.install) {
    return
  }

  const args = ['-c', manifest.repo.install]
  const env = readOnlyEnv(manifest, 'install')
  const spec = { command: 'sh', args, cwd: wt, env, role: 'install', pr, run: commandRun(pr, 'install'), stdin: 'ignore', group: true }
  const result = await runOnce(manifest, spec, { timeoutMs: INSTALL_TIMEOUT_MS })

  if (result.code === 0) {
    return
  }

  const shown = ['sh', ...args].join(' ').slice(0, 300)
  const output = result.stderr.trim() || result.stdout.trim()

  if (result.timedOut) {
    throw new Error(`${shown} timed out after ${INSTALL_TIMEOUT_MS / 1000} s${output ? `: ${output}` : ''}`)
  }

  throw new Error(`${shown} exited ${result.code ?? 1}: ${output}`)
}

async function refreshClone(manifest, pr, wt) {
  const clone = runtimeGit(manifest, pr, wt)

  await configure(manifest, pr, clone)

  const fetched = await clone.run(['fetch', '--quiet', '--prune', 'origin'])

  if (fetched.code === 0 && (await refreshUntouched(manifest, pr, clone))) {
    await install(manifest, pr, wt)
  }
}

// Words: the clone and the time.
const READY = `printf '%s' "$2" > "$1/.git/rollout-ready"`

// Until its install, only host git has written the clone. The fetch after
// the clone makes origin/* GitHub's refs, not the mirror's. The install may
// run code from the checkout, so the ready marker is written through the
// runtime, like everything after it.
async function newClone(manifest, pr, wt) {
  const clone = hostGit(manifest, wt)

  await cloneFromMirror(manifest, wt)
  await configure(manifest, pr, clone)
  await gitOk(clone, ['fetch', '--quiet', '--prune', 'origin'])

  const fromRemote = await remoteBranchExists(clone, pr.branch)
  const start = fromRemote ? `origin/${pr.branch}` : `origin/${manifest.repo.base}`

  await gitOk(clone, ['checkout', '--quiet', '-B', pr.branch, start])

  if (!fromRemote) {
    await gitOk(clone, ['branch', '--unset-upstream']).catch(() => {})
  }

  await install(manifest, pr, wt)
  await scriptOk(runtimeGit(manifest, pr, wt), READY, [wt, new Date().toISOString()])
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
// Host git is safe here: the last preview is removed first, so this clone is
// new, and nothing runs on the host after its install.
export async function preparePreview(manifest, pr, heads) {
  const wt = previewPath(manifest, pr)
  const preview = hostGit(manifest, wt)

  await removePreview(manifest, pr)
  await cloneFromMirror(manifest, wt)
  await connect(manifest, preview)
  await gitOk(preview, ['fetch', '--quiet', '--prune', 'origin'])
  await gitOk(preview, ['checkout', '--quiet', '--detach', `origin/${manifest.repo.base}`])

  for (const head of heads) {
    const identity = ['-c', 'user.name=rollout', '-c', 'user.email=rollout@localhost', '-c', 'commit.gpgsign=false']
    const message = `preview: ${head.id} at ${head.sha.slice(0, 7)}`
    const merged = await preview.run([...identity, 'merge', '--quiet', '--no-ff', '-m', message, head.sha])

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
// The calls stay apart: on the host only the push gets the bot's token.
export async function rebaseWorktree(manifest, pr, headSha) {
  const wt = await prepareWorktree(manifest, pr)
  const clone = runtimeGit(manifest, pr, wt)

  await gitOk(clone, ['fetch', '--quiet', 'origin'])

  const dirty = (await gitOk(clone, ['status', '--porcelain', '--untracked-files=no'])).trim()

  if (dirty) {
    return { ok: false, conflicts: [], reason: `worktree has uncommitted changes:\n${dirty}` }
  }

  await gitOk(clone, ['checkout', '--quiet', '-B', pr.branch, headSha])

  const result = await clone.run(['rebase', `origin/${manifest.repo.base}`])

  if (result.code !== 0) {
    const conflicts = (await clone.run(['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean)
    await clone.run(['rebase', '--abort'])

    return { ok: false, conflicts, reason: result.stderr.trim() || result.stdout.trim() }
  }

  await gitOk(clone, ['push', `--force-with-lease=refs/heads/${pr.branch}:${headSha}`, 'origin', `HEAD:refs/heads/${pr.branch}`], {
    push: true,
  })

  return { ok: true, conflicts: [], head: (await gitOk(clone, ['rev-parse', 'HEAD'])).trim() }
}

// Claude Code loads these from the working directory, and a global gitignore
// can hide them from git status, so an agent can leave one for the next agent.
const LOCAL_CONFIG = ['.claude/settings.json', '.claude/settings.local.json', 'CLAUDE.local.md']

// Deletes the untracked ones and returns their paths. A tracked copy is in
// the PR's diff, where the gate and the maintainer see it. A symlinked
// .claude is never followed: deleting through it could remove files outside
// the worktree. The delete stays on the host because rm follows no symlink
// and no agent or command runs in the clone meanwhile. Only its git goes
// through the runtime.
async function removeLocalConfig(clone) {
  const { wt } = clone
  const claudeDir = lstatSync(join(wt, '.claude'), { throwIfNoEntry: false })
  const candidates = claudeDir?.isDirectory() ? LOCAL_CONFIG : LOCAL_CONFIG.filter((path) => !path.startsWith('.claude/'))
  const present = candidates.filter((path) => lstatSync(join(wt, path), { throwIfNoEntry: false }))

  if (present.length === 0) {
    return []
  }

  const tracked = new Set((await gitOk(clone, ['ls-files', '-z', '--', ...present])).split('\0'))
  const untracked = present.filter((path) => !tracked.has(path))

  for (const path of untracked) {
    rmSync(join(wt, path), { recursive: true, force: true })
  }

  return untracked
}

// The status and the head in one start. The echo keeps the head on a line of
// its own when the status has no trailing newline.
const READ_TREE = 'git -C "$1" status --porcelain && echo && git -C "$1" rev-parse HEAD'

async function readTree(clone) {
  const lines = (await scriptOk(clone, READ_TREE, [clone.wt])).split('\n')
  const last = lines.findLastIndex((line) => line.trim() !== '')

  if (last === -1) {
    return { status: '', head: '' }
  }

  return { status: lines.slice(0, last).join('\n').trim(), head: lines[last].trim() }
}

// Puts a clean worktree on the given PR head before a verifier reads it.
export async function alignWorktree(manifest, pr, sha) {
  const wt = await prepareWorktree(manifest, pr)
  const clone = runtimeGit(manifest, pr, wt)
  const removed = await removeLocalConfig(clone)
  const { status: dirty, head } = await readTree(clone)

  if (dirty) {
    return { ok: false, reason: `worktree has uncommitted changes:\n${dirty.slice(0, 1500)}`, removed }
  }

  if (head !== sha) {
    await gitOk(clone, ['fetch', '--quiet', 'origin', `+refs/heads/${pr.branch}:refs/remotes/origin/${pr.branch}`])

    const behind = await clone.run(['merge-base', '--is-ancestor', head, sha])

    if (behind.code !== 0) {
      return { ok: false, reason: `local HEAD ${head.slice(0, 7)} has commits that are not in the PR head ${sha.slice(0, 7)}`, removed }
    }

    await gitOk(clone, ['checkout', '--quiet', '-B', pr.branch, sha])
  }

  return { ok: true, wt, removed }
}

export async function inspectWorktree(manifest, pr) {
  const { status, head } = await readTree(runtimeGit(manifest, pr, worktreePath(manifest, pr)))

  return { clean: status === '', status, head }
}

// Words: the clone and the head.
const RESET = 'git -C "$1" reset --quiet --hard "$2" && git -C "$1" clean -fdq'

// Puts the worktree back on a pushed head, dropping local changes and
// untracked files. Ignored build output stays, ignored Claude Code files do
// not. Returns the Claude Code files it removed, counted before git clean can
// remove them.
export async function resetWorktree(manifest, pr, sha) {
  const wt = worktreePath(manifest, pr)
  const clone = runtimeGit(manifest, pr, wt)
  const removed = await removeLocalConfig(clone)

  await scriptOk(clone, RESET, [wt, sha])

  return removed
}

// A clone holds node_modules, and a synchronous delete would block the
// driver's event loop for seconds. The implementer's home goes with it.
export async function removeWorktree(manifest, pr) {
  await rm(worktreePath(manifest, pr), { recursive: true, force: true })
  await rm(homePath(manifest, pr), { recursive: true, force: true })
}
