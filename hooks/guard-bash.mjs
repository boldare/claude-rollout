#!/usr/bin/env node
// PreToolUse guard for rollout agents. Reads the hook payload on stdin and
// exits 2 (blocked, stderr goes back to the agent) when a Bash command could
// merge, publish, rewrite shared history, push anywhere but the PR branch,
// switch off the guard rails or drive the rollout itself. A payload the guard
// cannot read and an error of its own also exit 2, because a PreToolUse hook
// blocks only with that code.
//
// A regex guard is a seatbelt, not a sandbox. The guarantees that matter are
// also enforced elsewhere: the pre-push hook, no npm credentials in the agent
// environment, and the driver re-checking every claim before it merges.
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Splits a shell line into simple commands on ; & && || | newlines and
// subshell or group markers. Quoting is not honoured on purpose: a forbidden
// word inside a string still blocks.
export function segments(command) {
  return command
    .split(/;|&&|\|\||\||&|\n|\$\(|`|\(|\)|\{|\}/)
    .map((part) => part.trim())
    .filter(Boolean)
}

// Quotes and backslashes are deleted so `sh -c "git push origin main"` is
// read as the command inside it and `pu\\sh` or `p"u"sh` read as `push`.
function tokens(segment) {
  return segment
    .replace(/["'\\]/g, '')
    .split(/\s+/)
    .filter(Boolean)
}

function isTool(word, name) {
  return word === name || word.endsWith(`/${name}`)
}

// Arguments after every occurrence of a tool in a segment, global flags
// (and their values) skipped: `git -C dir -c x=y push` → ['push', ...].
function invocations(words, name, flagsWithValue) {
  const found = []

  words.forEach((word, index) => {
    if (!isTool(word, name)) {
      return
    }

    const rest = words.slice(index + 1)

    while (rest.length > 0 && rest[0].startsWith('-')) {
      const flag = rest.shift()

      if (flagsWithValue.includes(flag) && rest.length > 0) {
        rest.shift()
      }
    }

    found.push(rest)
  })

  return found
}

// The first positionals after the subcommand, skipping flags and the values
// of known value flags: `gh pr --repo o/r merge 12` → ['pr', 'merge', '12'].
function positionals(args, flagsWithValue) {
  const out = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]

    if (arg.startsWith('-')) {
      if (flagsWithValue.includes(arg)) {
        i += 1
      }

      continue
    }

    out.push(arg)
  }

  return out
}

// Off limits in every command: switches that would disable git hooks or
// reroute pushes, the push markers, and the environment the guard relies on.
const ALWAYS = [
  /\.claude\/skills\/rollout(?![\w.-])/,
  /GIT_CONFIG_/,
  /--config-env/,
  /GIT_DIR=|GIT_WORK_TREE=/,
  /--git-dir|--work-tree/,
  /GIT_SSH|GH_TOKEN=|GH_CONFIG_DIR=|GITHUB_TOKEN=|GH_HOST=/,
  /ROLLOUT_[A-Z_]*=/,
  /\bunset\s+[^\n]*ROLLOUT_/,
  /\benv\b[^\n]*\s-u\s*ROLLOUT_/,
  /(\.git|\/worktrees\/[^/\s]+)\/rollout-(branch|pushurl|ready)/,
]

// Git settings that would switch off the hooks or reroute pushes, whether set
// with `git config` or with a `-c key=value` override.
const GIT_SETTINGS = /hookspath|credential|pushurl|sshcommand|(^|[\s="'.])url\.|(^|[\s="'])remote\.|(^|[\s="'])alias\./i

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The live rollout: its directory (not the sibling `<dir>.worktrees`), the
// installed skill, and relative paths that name the rollout directory.
function contextPatterns({ dir, home, name } = {}) {
  const patterns = []

  if (dir) {
    patterns.push(new RegExp(`${escapeRegExp(dir)}(?![\\w.-])`))
  }

  if (home) {
    patterns.push(new RegExp(`${escapeRegExp(home)}(?![\\w.-])`))
  }

  if (name) {
    patterns.push(new RegExp(`(^|[\\s/"'=])${escapeRegExp(name)}(?![\\w.-])`))
  }

  return patterns
}

const GH_VALUE_FLAGS = [
  '-R',
  '--repo',
  '--hostname',
  '-X',
  '--method',
  '-H',
  '--header',
  '-q',
  '--jq',
  '-t',
  '--template',
  '-f',
  '-F',
  '--field',
  '--raw-field',
  '--input',
  '-b',
  '--body',
  '-t',
  '--title',
  '-B',
  '--base',
  '-l',
  '--label',
  '--json',
  '-L',
  '--limit',
  '-s',
  '--state',
  '-i',
  '--interval',
  '--head',
]
const GH_FORBIDDEN = [
  'repo',
  'release',
  'secret',
  'variable',
  'workflow',
  'ruleset',
  'alias',
  'extension',
  'codespace',
  'gpg-key',
  'ssh-key',
  'cache',
  'attestation',
]

function checkGh(words) {
  for (const args of invocations(words, 'gh', ['-R', '--repo', '--hostname'])) {
    const [sub, action] = positionals(args, GH_VALUE_FLAGS)

    if (GH_FORBIDDEN.includes(sub)) {
      return `gh ${sub} is not allowed for rollout agents`
    }

    if (sub === 'auth' && (action !== 'status' || args.some((arg) => arg === '-t' || arg === '--show-token'))) {
      return 'gh credentials stay with gh; only `gh auth status` (without the token) is allowed'
    }

    if (sub === 'pr' && ['merge', 'review', 'close', 'reopen', 'lock', 'unlock'].includes(action)) {
      return 'merging, reviewing and closing PRs belongs to the driver'
    }

    if (sub === 'api') {
      if (action === 'graphql' || args.includes('graphql')) {
        return 'gh api graphql is not allowed for rollout agents (use gh pr / gh run subcommands)'
      }

      const joined = args.join(' ')
      const method = joined.match(/(?:-X|--method)[\s=]*([A-Za-z]+)/)?.[1]
      const hasFields = args.some((arg) => /^(-f|-F|--field|--raw-field|--input)/.test(arg))

      if ((method && method.toUpperCase() !== 'GET') || (!method && hasFields)) {
        return 'gh api is read-only for rollout agents (GET only)'
      }
    }
  }

  return null
}

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'npx', 'pnpx', 'bun', 'bunx']
const PUBLISH_WORDS = [
  'publish',
  'release',
  'version-packages',
  'unpublish',
  'dist-tag',
  'deprecate',
  'owner',
  'adduser',
  'login',
  'logout',
  'token',
]

function checkPackageManagers(words) {
  if (!words.some((word) => PACKAGE_MANAGERS.some((name) => isTool(word, name)))) {
    return null
  }

  const hit = words.find((word) => PUBLISH_WORDS.includes(word))

  if (hit) {
    return `\`${hit}\` belongs to the release PR and the maintainer, not to rollout agents`
  }

  for (const name of PACKAGE_MANAGERS) {
    for (const args of invocations(words, name, ['-C', '--dir', '--filter', '-F', '-w', '--workspace'])) {
      if (args[0] === 'version') {
        return `${name} version is not allowed: versions are bumped by the release PR`
      }
    }
  }

  return null
}

// The changesets CLI under any name it runs by: `changeset@latest`, a bin
// path, `@changesets/cli` or its `bin.js`. `.changeset/pre.json` is not it.
const CHANGESET_TOOL = /(^|\/)(changeset(@[^/]*)?|@changesets\/cli(@[^/]*)?(\/.*)?)$/
const CHANGESET_RELEASE = ['version', 'publish', 'tag', 'pre']

// Any later release word counts, so flags such as `--cwd .` or `--` before
// the subcommand cannot hide it.
function checkChangesets(words) {
  const tool = words.findIndex((word) => CHANGESET_TOOL.test(word))

  if (tool === -1) {
    return null
  }

  const hit = words.slice(tool + 1).find((word) => CHANGESET_RELEASE.includes(word))

  if (!hit) {
    return null
  }

  return `changeset ${hit} belongs to the release PR`
}

function checkPush(args, branch) {
  const options = args.filter((arg) => arg.startsWith('-'))
  const positional = args.filter((arg) => !arg.startsWith('-'))

  for (const option of options) {
    if (
      ['--force', '-f', '--mirror', '--all', '--tags', '--delete', '-d', '--prune', '--no-verify'].includes(option) ||
      option.startsWith('--repo')
    ) {
      return `git push ${option} is not allowed (use --force-with-lease on your own branch only)`
    }
  }

  // origin is the only remote: its push URL goes through the agents' own
  // token, while any other URL could use the maintainer's SSH key.
  if (positional.length > 0 && positional[0] !== 'origin') {
    return `push to origin only (got ${positional[0]})`
  }

  // An explicit target is required: the maintainer's token can bypass the
  // base branch ruleset, so an implicit `git push` is too easy to aim wrong.
  const refspecs = positional.slice(1)

  if (refspecs.length === 0) {
    return `name the target explicitly: git push -u origin ${branch}`
  }

  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) {
      return `force refspec ${refspec} is not allowed`
    }

    if (refspec.startsWith(':') || refspec.endsWith(':')) {
      return 'deleting remote refs is not allowed'
    }

    const target = refspec.includes(':') ? refspec.split(':').pop() : refspec
    const name = target.replace(/^refs\/heads\//, '')

    if (name !== branch) {
      return `push only to your branch ${branch} (got ${refspec})`
    }
  }

  return null
}

const VERIFIER_GIT_FORBIDDEN = [
  'commit',
  'push',
  'rebase',
  'merge',
  'reset',
  'clean',
  'stash',
  'cherry-pick',
  'revert',
  'tag',
  'am',
  'apply',
  'checkout',
  'switch',
  'restore',
  'update-ref',
  'branch',
  'worktree',
]

function checkGit(words, role, branch) {
  for (const args of invocations(words, 'git', [
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--exec-path',
    '--config-env',
    '--super-prefix',
  ])) {
    const [sub, ...rest] = args

    if (!sub) {
      continue
    }

    if (
      sub === 'config' &&
      (rest.some((arg) => ['--remove-section', '--rename-section'].includes(arg)) || GIT_SETTINGS.test(rest.join(' ')))
    ) {
      return 'changing git settings for hooks, credentials or remotes is not allowed'
    }

    if (sub === 'remote' && ['add', 'set-url', 'rename', 'remove', 'rm', 'set-head'].includes(rest[0])) {
      return `git remote ${rest[0]} is not allowed: agents push to origin only`
    }

    if (['update-ref', 'send-pack', 'http-push', 'receive-pack', 'filter-branch', 'replace'].includes(sub)) {
      return `git ${sub} is not allowed for rollout agents`
    }

    if (sub === 'commit' && rest.some((arg) => arg === '--no-verify' || (/^-[a-zA-Z]*n[a-zA-Z]*$/.test(arg) && !arg.startsWith('--')))) {
      return 'git commit --no-verify is not allowed (the commit-msg hook enforces one-line messages)'
    }

    if (role === 'verifier') {
      if (VERIFIER_GIT_FORBIDDEN.includes(sub)) {
        return `the verifier is read-only and stays on the PR head: git ${sub} is not allowed`
      }

      continue
    }

    if (sub === 'push') {
      if (!branch) {
        return 'ROLLOUT_BRANCH is not set; refusing to push'
      }

      const problem = checkPush(rest, branch)

      if (problem) {
        return problem
      }
    }

    if (sub === 'tag' || (sub === 'branch' && rest.some((arg) => ['-D', '-d', '--delete', '-m', '-M', '--move'].includes(arg)))) {
      return `git ${sub} ${rest.join(' ')} is not allowed`
    }
  }

  return null
}

export function check(command, role, branch, context = {}) {
  for (const pattern of [...ALWAYS, ...contextPatterns(context)]) {
    if (pattern.test(command)) {
      return 'the rollout control plane, its hooks and git hook settings are off limits to agents'
    }
  }

  if (/(^|\s)-c\s*\S+/.test(command) && [...command.matchAll(/(?:^|\s)-c\s*(\S+)/g)].some((match) => GIT_SETTINGS.test(match[1]))) {
    return 'overriding git settings for hooks, credentials or remotes is not allowed'
  }

  for (const segment of segments(command)) {
    const words = tokens(segment)
    const line = words.join(' ')

    if (
      /\b(curl|wget|http|https|xh)\b/.test(line) &&
      /api\.github\.com|uploads\.github\.com|registry\.npmjs\.org|registry\.yarnpkg\.com/.test(line)
    ) {
      return 'talk to GitHub through gh (read-only gh api), not raw HTTP; npm registry writes are not allowed'
    }

    const problem = checkGh(words) ?? checkChangesets(words) ?? checkPackageManagers(words) ?? checkGit(words, role, branch)

    if (problem) {
      return problem
    }

    if (role === 'verifier' && /\bgh\b.*\b(pr\s+(create|edit|comment|ready)|issue)\b/.test(line)) {
      return 'the verifier is read-only on GitHub'
    }
  }

  return null
}

// Null allows the command, a string is the reason to refuse it. It never
// throws, since a crash exits 1 and exit 1 lets the command run. Only tests
// pass `inspect`.
export function decide(input, role, env, inspect = check) {
  let payload

  try {
    payload = JSON.parse(input)
  } catch {
    return 'the hook payload is not JSON, command refused'
  }

  const command = payload?.tool_input?.command

  if (typeof command !== 'string') {
    return 'the hook payload has no command string, command refused'
  }

  try {
    return inspect(command, role, env.ROLLOUT_BRANCH, { dir: env.ROLLOUT_DIR, home: env.ROLLOUT_HOME, name: env.ROLLOUT_NAME })
  } catch (error) {
    const message = String(error?.message ?? error).replace(/\s+/g, ' ')

    return `the guard failed (${message}), command refused`
  }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function main() {
  const problem = decide(readStdin(), process.argv[2] ?? 'worker', process.env)

  if (problem) {
    process.stderr.write(`rollout guard: ${problem}\n`)
    process.exit(2)
  }

  process.exit(0)
}

// Node loads the main module by its real path. Comparing that with argv[1] as
// typed would skip main() behind a symlink and let every command through.
function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isMain()) {
  main()
}
