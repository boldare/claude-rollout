#!/usr/bin/env node
// PreToolUse guard for rollout agents. Reads the hook payload on stdin and
// exits 2 (blocked, stderr goes back to the agent) when a Bash command could
// merge, publish, rewrite shared history, push anywhere but the PR branch,
// switch off the guard rails, drop or redirect the agents' GitHub identity,
// leave the manifest's repository or drive the rollout itself. A payload the
// guard cannot read, a command too long to check and an error of its own also
// exit 2 with a reason. A PreToolUse hook blocks only with that code, so the
// hook command (lib/settings.mjs) turns any other exit, such as a crash or
// running out of memory, into 2 as well.
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

// Where the arguments of every occurrence of a tool in a segment start, global
// flags (and their values) skipped: `git -C dir -c x=y push` → the index of
// `push`. The arguments run to the end of the segment. Indices, not copies,
// keep memory linear when a segment repeats the tool.
function invocations(words, name, flagsWithValue) {
  const starts = []

  words.forEach((word, index) => {
    if (!isTool(word, name)) {
      return
    }

    let start = index + 1

    while (start < words.length && words[start].startsWith('-')) {
      const flag = words[start]

      start += 1

      if (flagsWithValue.includes(flag) && start < words.length) {
        start += 1
      }
    }

    starts.push(start)
  })

  return starts
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
  /(GIT_DIR|GIT_WORK_TREE)\+?=/,
  /--git-dir|--work-tree/,
  /GIT_SSH|(GH_TOKEN|GH_CONFIG_DIR|GITHUB_TOKEN|GH_HOST|GH_REPO)\+?=/,
  /ROLLOUT_[A-Z_]*\+?=/,
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

function checkGh(words, { repo, placeholders }) {
  let api = false

  for (const start of invocations(words, 'gh', ['-R', '--repo', '--hostname'])) {
    const args = words.slice(start)
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
      api = true

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

  const first = words.findIndex((word) => isTool(word, 'gh'))

  if (first === -1) {
    return null
  }

  return checkGhRepo(words, first + 1, repo, api) ?? (api ? placeholders : null)
}

// gh takes the repository with or without its host.
function normalizeRepo(text) {
  return text.toLowerCase().replace(/^github\.com\//, '')
}

// --repo X, --repo=X, -R X, -RX, -R=X and clusters such as -dR X.
function repoFlag(word) {
  if (word === '--repo') {
    return { next: true }
  }

  if (word.startsWith('--repo=')) {
    return { next: false, value: word.slice('--repo='.length) }
  }

  const short = word.match(/^-(?!-)[A-Za-z]*?R(.*)$/)

  if (!short) {
    return null
  }

  if (short[1] === '') {
    return { next: true }
  }

  return { next: false, value: short[1].replace(/^=/, '') }
}

function climbs(path) {
  return path.split('/').includes('..') || /%2e|%2f/i.test(path)
}

// segments() splits `repos/{owner}/{repo}/pulls` on the braces and leaves a
// bare `repos/`. gh fills the placeholders from the pinned GH_REPO.
const REPOS_PATH = /^[./]*repos\//i

function apiPathProblem(word, repo) {
  const prefix = word.match(REPOS_PATH)?.[0]

  if (!prefix || prefix.length === word.length) {
    return null
  }

  if (climbs(word)) {
    return `gh api ${word} could climb out of the repository with .. or an encoded dot or slash, so it is refused`
  }

  if (!repo) {
    return `ROLLOUT_REPO is not set, so gh api ${word} is refused. Use repos/{owner}/{repo}/… instead`
  }

  const [owner, name] = word.slice(prefix.length).split(/[?#]/)[0].split('/')

  if (`${owner}/${name}`.toLowerCase() !== normalizeRepo(repo)) {
    return `gh api ${word} names another repository than ${repo}, and agents stay on the manifest's repository`
  }

  return null
}

// The arguments of every gh call in a segment run to its end, so one scan
// from the first call reads the flags and paths of all of them.
function checkGhRepo(words, start, repo, api) {
  for (let i = start; i < words.length; i += 1) {
    const word = words[i]
    const flag = repoFlag(word)

    if (flag) {
      const value = (flag.next ? words[i + 1] : flag.value) ?? ''
      const shown = flag.next && value ? `${word} ${value}` : word
      const hint = 'Put text that contains -R or --repo in a file and pass --body-file'

      if (flag.next) {
        i += 1
      }

      if (!repo) {
        return `ROLLOUT_REPO is not set, so gh ${shown} is refused. ${hint}`
      }

      if (!value) {
        return `gh ${word} has no value, and agents may name only the manifest's repository ${repo}. ${hint}`
      }

      if (normalizeRepo(value) !== normalizeRepo(repo)) {
        return `gh ${shown} names another repository than ${repo}, and agents stay on the manifest's repository. ${hint}`
      }

      continue
    }

    const problem = api ? apiPathProblem(word, repo) : null

    if (problem) {
      return problem
    }
  }

  return null
}

// segments() drops braces, so the placeholders and the path after them are
// read on the whole command. Alone, {owner} or {repo} could name another
// repository of the same owner or another owner's repository of that name.
function placeholderProblem(command) {
  const text = command.replace(/["'\\]/g, '')

  for (const match of text.matchAll(/\{owner\}\/\{repo\}(\S*)/g)) {
    if (climbs(match[1])) {
      return `gh api {owner}/{repo}${match[1]} could climb out of the repository with .. or an encoded dot or slash, so it is refused`
    }
  }

  if (/\{(owner|repo)\}/.test(text.replaceAll('{owner}/{repo}', ''))) {
    return 'gh api placeholders {owner} and {repo} are allowed only together as {owner}/{repo}, because alone they could reach another repository'
  }

  return null
}

// The agents' GitHub identity and repository, and the guard's own context.
const PROTECTED = 'GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|GH_REPO|GH_HOST|ROLLOUT_\\w*'

// A protected name as an argument: bare, assigned (`=`, `+=`, `[0]=`),
// attached to an option (`read -aNAME`) or as a nameref target (`x=NAME`).
const PROTECTED_ARGUMENT = new RegExp(`^(?:[-+][A-Za-z]*)?(${PROTECTED})(?!\\w)|=(${PROTECTED})(?!\\w)`)
const PROTECTED_NAME = new RegExp(`^(${PROTECTED})$`)

function protectedReason(name) {
  if (name.startsWith('ROLLOUT_')) {
    return `${name} is the guard's context and keeps the CLI from taking orders from agents`
  }

  return `${name} keeps agents on their own GitHub login and the manifest's repository`
}

// Shell builtins that set, unset or un-export variables, csh's included.
const ENV_BUILTINS = new Set([
  'unset',
  'export',
  'declare',
  'typeset',
  'local',
  'readonly',
  'read',
  'printf',
  'mapfile',
  'readarray',
  'set',
  'setenv',
  'unsetenv',
])

// zsh reads their names as patterns with -m: `unset -m 'GH_*'`.
const PATTERN_BUILTINS = new Set(['unset', 'export', 'declare', 'typeset', 'local', 'readonly'])

// A redirect is no argument, so `env >/dev/null -i` still gives env its -i.
// An operator without its target takes the next word too.
function redirectWidth(words, index) {
  const word = words[index]

  if (!/^\d*[<>]/.test(word)) {
    return 0
  }

  return /^\d*[<>]+$/.test(word) ? 2 : 1
}

function checkBuiltins(words) {
  let builtin = null
  let ownOptions = false

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]
    const redirect = redirectWidth(words, i)

    if (redirect > 0) {
      i += redirect - 1
      continue
    }

    if (ownOptions && /^[-+]/.test(word)) {
      if (PATTERN_BUILTINS.has(builtin) && /^[-+][A-Za-z]*m/.test(word)) {
        return `${builtin} ${word} reads names as patterns that could match the agents' GitHub variables, so it is not allowed`
      }
    } else {
      const name = word.split(/[<>]/)[0]

      ownOptions = ENV_BUILTINS.has(name)

      if (ownOptions) {
        builtin = name
        continue
      }
    }

    const hit = builtin ? word.match(PROTECTED_ARGUMENT) : null

    if (hit) {
      const target = hit[1] ?? hit[2]

      return `${builtin} with ${target} is not allowed: ${protectedReason(target)}`
    }
  }

  return null
}

const ENV_FLAGS = ['-0', '-v', '--null', '--debug', '--list-signal-handling', '--help', '--version']
const ENV_SIGNAL_OPTIONS = ['--block-signal', '--default-signal', '--ignore-signal']

function envDrop(word) {
  return `env ${word} starts the command without the agents' GitHub token and gh config, so it is not allowed`
}

function envUnset(name) {
  return PROTECTED_NAME.test(name) ? `unsetting ${name} with env is not allowed: ${protectedReason(name)}` : null
}

// env's own options, from words[start] on. Returns the reason to refuse, or
// the index where the command env runs starts.
function readEnvOptions(words, start) {
  let operands = false
  let i = start

  while (i < words.length) {
    const word = words[i]
    const redirect = redirectWidth(words, i)

    if (redirect > 0) {
      i += redirect
      continue
    }

    if (word === '-') {
      return { problem: envDrop(word) }
    }

    if (!word.startsWith('-') || operands) {
      if (!word.includes('=')) {
        break
      }

      const name = word.slice(0, word.indexOf('='))

      if (PROTECTED_NAME.test(name)) {
        return { problem: `setting ${name} with env is not allowed: ${protectedReason(name)}` }
      }

      i += 1
      continue
    }

    i += 1

    if (word === '--') {
      operands = true
      continue
    }

    if (word.startsWith('--')) {
      const name = word.split('=')[0]

      if (name === '--ignore-environment') {
        return { problem: envDrop(word) }
      }

      if (name === '--split-string') {
        return { problem: `env ${word} re-splits a string the guard does not read, so it is not allowed. Write the command out` }
      }

      if (name === '--unset' || name === '--chdir') {
        const value = word.includes('=') ? word.slice(name.length + 1) : (words[i] ?? '')

        if (!word.includes('=')) {
          i += 1
        }

        const problem = name === '--unset' ? envUnset(value) : null

        if (problem) {
          return { problem }
        }

        continue
      }

      if (ENV_SIGNAL_OPTIONS.includes(name) || ENV_FLAGS.includes(word)) {
        continue
      }

      return { problem: `env ${word} is an option the guard does not know, so it is refused` }
    }

    for (let j = 1; j < word.length; j += 1) {
      const letter = word[j]

      if (letter === 'i') {
        return { problem: envDrop(word) }
      }

      if (letter === 'S') {
        return { problem: `env ${word} re-splits a string the guard does not read, so it is not allowed. Write the command out` }
      }

      if ('uCP'.includes(letter)) {
        let value = word.slice(j + 1)

        if (value === '') {
          value = words[i] ?? ''
          i += 1
        }

        const problem = letter === 'u' ? envUnset(value) : null

        if (problem) {
          return { problem }
        }

        break
      }

      if (!ENV_FLAGS.includes(`-${letter}`)) {
        return { problem: `env -${letter} is an option the guard does not know, so it is refused` }
      }
    }
  }

  return { problem: null, end: i }
}

// exec [-cl] [-a name]: -c starts the command with an empty environment.
function readExecOptions(words, start) {
  let i = start

  while (i < words.length) {
    const word = words[i]
    const redirect = redirectWidth(words, i)

    if (redirect > 0) {
      i += redirect
      continue
    }

    if (!word.startsWith('-')) {
      break
    }

    i += 1

    if (word === '--') {
      break
    }

    for (let j = 1; j < word.length; j += 1) {
      if (word[j] === 'c') {
        return {
          problem: `exec ${word} starts the command with an empty environment, without the agents' GitHub token and gh config, so it is not allowed`,
        }
      }

      if (word[j] === 'a') {
        if (j === word.length - 1) {
          i += 1
        }

        break
      }
    }
  }

  return { problem: null, end: i }
}

// The outer scan resumes where env's or exec's options end, so a long run of
// `env -u env -u …` is read once.
function checkEnvCommands(words) {
  let i = 0

  while (i < words.length) {
    const name = words[i].split(/[<>]/)[0]
    let reader = null

    if (isTool(name, 'env')) {
      reader = readEnvOptions
    } else if (name === 'exec') {
      reader = readExecOptions
    }

    if (!reader) {
      i += 1
      continue
    }

    const { problem, end } = reader(words, i + 1)

    if (problem) {
      return problem
    }

    i = end
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
    for (const start of invocations(words, name, ['-C', '--dir', '--filter', '-F', '-w', '--workspace'])) {
      if (words[start] === 'version') {
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
  for (const start of invocations(words, 'git', [
    '-C',
    '-c',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--exec-path',
    '--config-env',
    '--super-prefix',
  ])) {
    const sub = words[start]

    if (!sub) {
      continue
    }

    const rest = words.slice(start + 1)

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

// Some rules cost the square of a line's length, and a hook that times out
// lets the command run. The caps keep the guard's work far below the timeout.
const MAX_COMMAND = 262_144
const MAX_LINE = 16_384

export function check(command, role, branch, context = {}) {
  if (command.length > MAX_COMMAND) {
    return `a command of more than ${MAX_COMMAND} characters is too long for the guard, split it`
  }

  if (command.split('\n').some((line) => line.length > MAX_LINE)) {
    return `a line of more than ${MAX_LINE} characters is too long for the guard, split the command`
  }

  for (const pattern of [...ALWAYS, ...contextPatterns(context)]) {
    if (pattern.test(command)) {
      return 'the rollout control plane, its hooks and git hook settings are off limits to agents'
    }
  }

  if (/(^|\s)-c\s*\S+/.test(command) && [...command.matchAll(/(?:^|\s)-c\s*(\S+)/g)].some((match) => GIT_SETTINGS.test(match[1]))) {
    return 'overriding git settings for hooks, credentials or remotes is not allowed'
  }

  const gh = { repo: context.repo, placeholders: placeholderProblem(command) }

  for (const segment of segments(command)) {
    const words = tokens(segment)
    const line = words.join(' ')

    if (
      /\b(curl|wget|http|https|xh)\b/.test(line) &&
      /api\.github\.com|uploads\.github\.com|registry\.npmjs\.org|registry\.yarnpkg\.com/.test(line)
    ) {
      return 'talk to GitHub through gh (read-only gh api), not raw HTTP; npm registry writes are not allowed'
    }

    const problem =
      checkGh(words, gh) ??
      checkChangesets(words) ??
      checkPackageManagers(words) ??
      checkGit(words, role, branch) ??
      checkBuiltins(words) ??
      checkEnvCommands(words)

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
// throws, so the agent learns why its command was refused. The hook command
// turns any other failure into exit 2. Only tests pass `inspect`.
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
    return inspect(command, role, env.ROLLOUT_BRANCH, {
      dir: env.ROLLOUT_DIR,
      home: env.ROLLOUT_HOME,
      name: env.ROLLOUT_NAME,
      repo: env.ROLLOUT_REPO,
    })
  } catch (error) {
    return `the guard failed (${errorText(error)}), command refused`
  }
}

// A thrown value can be anything, even an object without a prototype.
function errorText(error) {
  try {
    return String(error?.message ?? error).replace(/\s+/g, ' ')
  } catch {
    return 'an error that cannot be printed'
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

// Node loads the main module by its real path, unless --preserve-symlinks-main
// keeps the typed one. So both sides are resolved. No argv[1] means an import.
// A path that cannot be resolved still runs main(), because skipping it would
// let every command through.
export function isEntry(entry, moduleUrl) {
  if (typeof entry !== 'string') {
    return false
  }

  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return true
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  main()
}
