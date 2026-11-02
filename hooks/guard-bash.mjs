#!/usr/bin/env node
// PreToolUse guard for rollout agents. Reads the hook payload on stdin and
// exits 2 (blocked, stderr goes back to the agent) when a Bash command could
// merge, publish, rewrite shared history, push anywhere but the PR branch,
// switch off the guard rails, drop or redirect the agents' GitHub identity,
// leave the manifest's repository or drive the rollout itself. Its context,
// the rollout directory, the skill, the rollout's name, the repository and
// the push branch, comes from the hook command (lib/settings.mjs), not from
// the agents' environment, so no agent holds those paths in a variable. It
// refuses commands built by shell expansion in the positions it decides on,
// because it cannot read what the shell would run there. A payload the guard
// cannot read, a hook command it cannot parse, a command too long to check
// and an error of its own also exit 2 with a reason. A PreToolUse hook blocks
// only with that code, so the hook command turns any other exit, such as a
// crash or running out of memory, into 2 as well.
//
// A regex guard is a seatbelt, not a sandbox: a command it reads differently
// from the shell or the tool gets past it, and docs/security.html lists the
// known limits. The guarantees that matter are also enforced elsewhere: the
// pre-push hook, no npm credentials in the agent environment, and the driver
// re-checking every claim before it merges.
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

// A `#` at the start of a word starts a comment.
const COMMENT = /(^|[\s;&|()<>`])#/

// A newline after an odd number of backslashes continues the line, so
// `git pu\` + newline + `sh` reads as `git push`. After an even number the
// backslashes are escaped and the newline ends the line. A comment ends at
// its newline, its last backslash included, so with `comments` a line that
// holds a comment keeps its newline.
function joinContinuations(command, comments = false) {
  return command.replace(/(?<!\\)((?:\\\\)*)\\\n/g, (_, escaped, offset) => {
    const line = command.slice(command.lastIndexOf('\n', offset) + 1, offset)

    return comments && COMMENT.test(line) ? `${escaped}\n` : escaped
  })
}

// Only quotes tell a comment's `#` from a quoted one, and the guard does not
// read quotes. So a continued line with a `#` is read both ways: joined, as
// when the `#` is quoted, and ended at its newline, as after a comment.
function readings(command) {
  const joined = joinContinuations(command)
  const commented = joinContinuations(command, true)

  return commented === joined ? [joined] : [joined, commented]
}

const CLOSERS = { '$(': ')', '(': ')', '${': '}', '{': '}', '`': '`' }
const SPECIAL = /[$`(){};&|\n]/g
const SEPARATORS = ';&|\n)}'

// What a plain group leaves in the command around it, when it is empty and when it is not.
const GROUP_MARKS = { '(': ['()', '(…)'], '{': ['{}', '{…}'] }

// The parameter and operator a ${…} body starts with: `PWD`, `#name`,
// `!name`, `arr[@]`, `x:-`, `f%%`. No class crosses a `{`, so the scans of
// nested bodies never overlap.
const PARAMETER = /[#!]?(?:[A-Za-z_]\w*|\d+|[@*#?!0-])?(?:\[[^\]\s{}()`;&|<>]*\])?(?::?[-=?+]|##?|%%?|\/[/#%]?|\^\^?|,,?|[@:*])?/y

// Splits a shell line into simple commands on ; & && || | and newlines, in
// one pass with a stack: a hook that times out lets the command run.
// `$(…)`, `$((…))`, `${…}` and backticks are commands of their own and leave
// a `$` in the command around them, so `git -C $(pwd) push` stays one call.
// Plain parentheses and braces are commands of their own and leave a mark
// from GROUP_MARKS where they were, so `git -C {} push` keeps `push` as
// git's subcommand. A ${…} body loses its parameter and operator and the
// rest is read, because quoting is not honoured: `echo '${x:-' ; git push ;
// echo '}'` runs the push. An opener without a closer runs to the end, and a
// closer without an opener splits. A forbidden word inside a string still
// blocks.
export function readCommands(text) {
  const commands = []
  const stack = []
  const open = { ')': 0, '}': 0, '`': 0 }
  let current = { opener: null, closer: null, text: '', filled: false }

  function flush(frame) {
    const command = frame.text.trim()

    if (command) {
      commands.push(command)
    }

    frame.text = ''
  }

  function append(chunk) {
    current.text += chunk
    current.filled ||= /\S/.test(chunk)
  }

  // A plain group leaves its mark when it ends, once it is known to be empty or not.
  function enter(opener) {
    if (!GROUP_MARKS[opener]) {
      append('$')
    }

    current.filled = true
    stack.push(current)
    current = { opener, closer: CLOSERS[opener], text: '', filled: false }
    open[current.closer] += 1
  }

  // Frames still open inside the one a closer ends are ended with it.
  function leave(closer) {
    let closed

    do {
      const frame = current

      closed = frame.closer
      flush(frame)
      open[closed] -= 1
      current = stack.pop()

      if (GROUP_MARKS[frame.opener]) {
        current.text += GROUP_MARKS[frame.opener][frame.filled ? 1 : 0]
      }
    } while (closed !== closer)
  }

  // Reads the special character at `at` and returns how many it used.
  function step(at) {
    const char = text[at]
    const next = text[at + 1]

    if (char === '$' && next === '(') {
      enter('$(')
      return 2
    }

    if (char === '$' && next === '{') {
      enter('${')
      PARAMETER.lastIndex = at + 2

      return 2 + (PARAMETER.exec(text)?.[0].length ?? 0)
    }

    if (char === '`') {
      if (open['`'] > 0) {
        leave('`')
      } else {
        enter('`')
      }

      return 1
    }

    if (char === '(' || char === '{') {
      enter(char)
    } else if ((char === ')' || char === '}') && open[char] > 0) {
      leave(char)
    } else if (SEPARATORS.includes(char)) {
      // zsh reads `git(|)` as an alternation that matches `git`, so a separator fills a group.
      current.filled = true
      flush(current)
    } else {
      append(char)
    }

    return 1
  }

  let i = 0

  while (i < text.length) {
    SPECIAL.lastIndex = i
    const found = SPECIAL.exec(text)
    const at = found ? found.index : text.length

    append(text.slice(i, at))
    i = found ? at + step(at) : at
  }

  while (stack.length > 0) {
    leave(current.closer)
  }

  flush(current)

  return commands
}

function unquote(text) {
  return text.replace(/["'\\]/g, '')
}

// Quotes and backslashes are deleted so `sh -c "git push origin main"` is
// read as the command inside it and `pu\\sh` or `p"u"sh` read as `push`. A
// word that ends up empty stays, because the shell passes `""` on and git
// reads `-C ""` as the current directory. The raw words keep what only the
// shell's spelling shows: a leading `\` or `=`.
function readWords(command) {
  const raws = command.split(/\s+/).filter(Boolean)

  return { words: raws.map(unquote), raws }
}

// The guard decides on these words as written, so none may expand. `$` also
// marks where readCommands took out a substitution.
function readable(word, raw) {
  return !word.includes('$') && !raw.startsWith('\\')
}

// The mark of a group that is not empty.
const GROUP = /\(…\)|\{…\}/

// The shell may expand a glob to a file name, and zsh expands `=git` to git's
// path. A group in a subcommand is a brace expansion or a zsh glob, as in
// `gh pr {merge,x{}}` or `gh pr (mer|x)ge`.
function isName(word, raw) {
  return readable(word, raw) && !/[*?[]/.test(word) && !raw.startsWith('=') && !GROUP.test(word)
}

// `[` and `[[` start a test, and a group as a whole word is a subshell or a
// command group. Braces stay literal in a command word. zsh globs a `(…)`,
// but quoted program text reads calls such as `fs.readFileSync(x).toString()`
// as command words. So a `(…)` counts at the start of a word and in a path,
// as in `/usr/bin/(g)it`, which matches without a file the agent made.
function isCommandName(word, raw) {
  if (['[', '[[', '(…)', '{…}'].includes(word)) {
    return readable(word, raw)
  }

  const calls = word.includes('/') || word.startsWith('(') ? word : word.replaceAll('(…)', '')

  return isName(calls.replaceAll('{…}', ''), raw)
}

// The first word from words[from] up to words[to] that fails `test`, or -1.
function firstFailing(test, words, raws, from, to = words.length) {
  for (let i = from; i < to; i += 1) {
    if (!test(words[i], raws[i])) {
      return i
    }
  }

  return -1
}

function isTool(word, name) {
  const lower = word.toLowerCase()

  return lower === name || lower.endsWith(`/${name}`)
}

// Where the value that starts at raws[from] ends: a quote or an escaped
// space joins raw words, as in `-C "a b"`. -1 when the quote does not close
// in the command, as when readCommands split the value at a separator inside
// it, as in `-C "a;b"`.
function valueEnd(raws, from) {
  let quote = null

  for (let i = from; i < raws.length; i += 1) {
    let escaped = false

    for (const char of raws[i]) {
      if (escaped) {
        escaped = false
      } else if (char === '\\' && quote !== "'") {
        escaped = true
      } else if (quote === null && (char === '"' || char === "'")) {
        quote = char
      } else if (char === quote) {
        quote = null
      }
    }

    if (quote === null && !escaped) {
      return i + 1
    }
  }

  return -1
}

// Where the option at words[i] and its value end, each read across quotes
// and escaped spaces: `--namespace="a b"` is one word, `-C "a b"` two. Only
// an option in flagsWithValue takes a value. -1 when a quote does not close
// in the command.
function optionEnd(words, raws, i, flagsWithValue) {
  const end = valueEnd(raws, i)

  if (end === -1 || end >= words.length || !flagsWithValue.includes(words[i])) {
    return end
  }

  return valueEnd(raws, end)
}

// Where every occurrence of a tool in a command starts (call) and where its
// arguments start (start), global flags and the values of flagsWithValue
// skipped: `git -C dir -c x=y push` → the index of `git` and of `push`. The
// arguments run to the end of the command. Indices, not copies, keep memory
// linear when a command repeats the tool. A call can sit among another call's
// flags (`git -c git -c …`), so the starts are read once, from the end.
function invocations(words, raws, name, flagsWithValue) {
  const calls = []

  words.forEach((word, call) => {
    if (isTool(word, name)) {
      calls.push({ call, start: 0 })
    }
  })

  if (calls.length === 0) {
    return calls
  }

  // startFrom[i] is where the arguments start when words[i] is read as a flag.
  const startFrom = new Array(words.length + 1)

  startFrom[words.length] = words.length

  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (!words[i].startsWith('-')) {
      startFrom[i] = i
      continue
    }

    const end = optionEnd(words, raws, i, flagsWithValue)

    startFrom[i] = end === -1 ? words.length : startFrom[end]
  }

  for (const call of calls) {
    call.start = startFrom[call.call + 1]
  }

  return calls
}

// The flags between a call and its subcommand, read as invocations() reads
// them: each flag's index, where the flag's own word ends, its value's index
// or -1, and where the value ends, -1 when a quote does not close. A flag in
// `seen` was read for an earlier call, and so were the flags after it, so
// reading stops.
function globalOptions(words, raws, { call, start }, flagsWithValue, seen) {
  const options = []
  let i = call + 1

  while (i < start && !seen.has(i)) {
    const flag = i
    const flagEnd = valueEnd(raws, flag)

    seen.add(flag)
    i = optionEnd(words, raws, flag, flagsWithValue)
    options.push({ flag, flagEnd, value: i === flagEnd ? -1 : flagEnd, end: i })

    if (i === -1) {
      break
    }
  }

  return options
}

// The indices of the first `limit` positionals from words[from], skipping
// flags and the values of known value flags, each read across quotes and
// escaped spaces: `gh pr --body "x y" merge 12` → the indices of `pr` and
// `merge`.
function positionals(words, raws, from, flagsWithValue, limit) {
  const found = []
  let i = from

  while (i !== -1 && i < words.length && found.length < limit) {
    if (!words[i].startsWith('-')) {
      found.push(i)
      i = valueEnd(raws, i)
    } else {
      i = optionEnd(words, raws, i, flagsWithValue)
    }
  }

  return found
}

// The index after the options from words[from], `--` included.
function pastOptions(words, from) {
  let i = from

  while (i < words.length && words[i].startsWith('-')) {
    i += 1

    if (words[i - 1] === '--') {
      break
    }
  }

  return i
}

// Off limits in every command: switches that would disable git hooks or
// reroute pushes, the push markers, and the variables that keep the CLI from
// taking orders from agents. Each pattern comes with a command it refuses.
export const ALWAYS = [
  { pattern: /\.claude\/skills\/rollout(?![\w.-])/, sample: 'cat ~/.claude/skills/rollout/SKILL.md' },
  { pattern: /GIT_CONFIG_/, sample: 'GIT_CONFIG_COUNT=1 git status' },
  { pattern: /--config-env/, sample: 'git --config-env=core.hooksPath=HOOKS status' },
  { pattern: /(GIT_DIR|GIT_WORK_TREE)\+?=/, sample: 'GIT_DIR=/tmp/x/.git git status' },
  { pattern: /--git-dir|--work-tree/, sample: 'git --work-tree /tmp/x status' },
  { pattern: /GIT_SSH|(GH_TOKEN|GH_CONFIG_DIR|GITHUB_TOKEN|GH_HOST|GH_REPO)\+?=/, sample: 'GH_TOKEN= gh pr list' },
  { pattern: /ROLLOUT_[A-Z_]*\+?=/, sample: 'ROLLOUT_ROLE= node bin/rollout.mjs stop' },
  { pattern: /\bunset\s+[^\n]*ROLLOUT_/, sample: 'unset ROLLOUT_ROLE' },
  { pattern: /\benv\b[^\n]*\s-u\s*ROLLOUT_/, sample: 'env -u ROLLOUT_ROLE node bin/rollout.mjs stop' },
  { pattern: /(\.git|\/worktrees\/[^/\s]+)\/rollout-(branch|pushurl|ready)/, sample: 'touch .git/rollout-ready' },
]

// Git settings that would switch off the hooks or reroute pushes, whether set
// with `git config` or with a `-c key=value` override.
const GIT_SETTINGS = /hookspath|credential|pushurl|sshcommand|(^|[\s="'.])url\.|(^|[\s="'])remote\.|(^|[\s="'])alias\./i

// One setting for each part of GIT_SETTINGS.
export const GIT_SETTING_SAMPLES = [
  'core.hooksPath',
  'credential.helper',
  'remote.origin.pushurl',
  'core.sshCommand',
  'url.https://example.com/.insteadOf',
  'remote.origin.url',
  'alias.p',
]

const CONTROL_PLANE = 'the rollout control plane, its hooks and git hook settings are off limits to agents'

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// lib/manifest.mjs uses it, so no manifest hands agents a branch, title, base
// or repository that the guard refuses.
export function rolloutNamePattern(name) {
  return new RegExp(`(^|[\\s/"'=])${escapeRegExp(name)}(?![\\w.-])`)
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
    patterns.push(rolloutNamePattern(name))
  }

  return patterns
}

function matchesAny(text, context) {
  return [...ALWAYS.map(({ pattern }) => pattern), ...contextPatterns(context)].some((pattern) => pattern.test(text))
}

// The patterns read the command once more without quotes and backslashes, on
// both sides, so `de""mo` and `roll\out` name what they spell. Some patterns
// cost the square of a line's length, so the second read runs only when
// deleting changed something.
function offLimits(joined, plain, context) {
  const plainContext = {
    dir: context.dir && unquote(context.dir),
    home: context.home && unquote(context.home),
    name: context.name && unquote(context.name),
  }

  const changed = plain !== joined || ['dir', 'home', 'name'].some((key) => plainContext[key] !== context[key])

  return matchesAny(joined, context) || (changed && matchesAny(plain, plainContext))
}

const WRITE_IT_OUT = 'Write the command out. For quoted program text, use a script file or the Write tool'

function builtByExpansion(what) {
  return `${what} is built by shell expansion, so the guard cannot read it. ${WRITE_IT_OUT}`
}

// Rollouts sit right under one root, so a glob or an expansion there could
// reach any of them. The root is the parent of the rollout directory.
function rolloutsRootPattern(dir) {
  const root = (dir && basename(dirname(dir))) || '.rollouts'

  return new RegExp(`(?<![\\w.-])${escapeRegExp(root)}/(?![\\w.-]*(?:[/\\s;&|)<>]|$))`)
}

// Brace expansion, a list or a sequence: {a,b}, {1..3}, {a..z..2}. No part
// has greedy runs on both sides of its separator, which would cost the square
// of the length on `{,,,,…`.
const BRACE_EXPANSION = /\{[^\s{},]*,[^\s{}]*\}|\{(?:-?\d+|[^\s{}.,])\.\.(?:-?\d+|[^\s{}.,])(?:\.\.-?\d+)?\}/

// Rules on the whole command, its quotes and backslashes deleted.
function wholeCommandProblem(plain, context) {
  if (/\$ROLLOUT_|\$\{!?ROLLOUT_/.test(plain)) {
    return 'a $ROLLOUT_ variable is refused: the rollout control plane is off limits to agents in any spelling'
  }

  if (/\$\{?IFS/.test(plain)) {
    return `$IFS splits words that the guard reads as one, so it is refused. ${WRITE_IT_OUT}`
  }

  if (BRACE_EXPANSION.test(plain)) {
    return `brace expansion such as {a,b} or {1..3} builds words the guard cannot read, so it is refused. A space after the comma is fine, as in {a, b} in jq or JavaScript. ${WRITE_IT_OUT}`
  }

  if (rolloutsRootPattern(context.dir).test(plain)) {
    return 'only a plain rollout name may follow the rollouts root, not a glob or an expansion: the rollout control plane is off limits to agents in any spelling'
  }

  return null
}

const GH_GLOBAL_FLAGS = ['-R', '--repo', '--hostname']

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

export const GH_FORBIDDEN = [
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

export const GH_PR_FORBIDDEN = ['merge', 'review', 'close', 'reopen', 'lock', 'unlock']

// Options that give gh api a body, which makes the call a POST.
export const GH_API_FIELDS = ['-f', '-F', '--field', '--raw-field', '--input']
const GH_API_FIELD = new RegExp(`^(${GH_API_FIELDS.join('|')})`)

function checkGh(words, raws, { repo, placeholders }) {
  let api = false

  for (const { start } of invocations(words, raws, 'gh', GH_GLOBAL_FLAGS)) {
    const args = words.slice(start)
    const [sub, action] = positionals(words, raws, start, GH_VALUE_FLAGS, 2).map((index) => words[index])

    if (GH_FORBIDDEN.includes(sub)) {
      return `gh ${sub} is not allowed for rollout agents`
    }

    if (sub === 'auth' && (action !== 'status' || args.some((arg) => arg === '-t' || arg === '--show-token'))) {
      return 'gh credentials stay with gh; only `gh auth status` (without the token) is allowed'
    }

    if (sub === 'pr' && GH_PR_FORBIDDEN.includes(action)) {
      return 'merging, reviewing and closing PRs belongs to the driver'
    }

    if (sub === 'api') {
      api = true

      if (action === 'graphql' || args.includes('graphql')) {
        return 'gh api graphql is not allowed for rollout agents (use gh pr / gh run subcommands)'
      }

      const joined = args.join(' ')
      const method = joined.match(/(?:-X|--method)[\s=]*([A-Za-z]+)/)?.[1]
      const hasFields = args.some((arg) => GH_API_FIELD.test(arg))

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

const REPOS_PATH = /^[./]*repos\//i

function apiPathProblem(word, repo) {
  const prefix = word.match(REPOS_PATH)?.[0]

  if (!prefix || prefix.length === word.length) {
    return null
  }

  if (climbs(word)) {
    return `gh api ${word} could climb out of the repository with .. or an encoded dot or slash, so it is refused`
  }

  const [owner, name] = word.slice(prefix.length).split(/[?#]/)[0].split('/')

  // readCommands() leaves `{…}` for `{owner}` and `{repo}`. gh fills them from
  // the pinned GH_REPO, and placeholderProblem() reads them on the whole command.
  if (owner.includes('{') || name?.includes('{')) {
    return null
  }

  if (!repo) {
    return `the guard has no --repo, so gh api ${word} is refused. Use repos/{owner}/{repo}/… instead`
  }

  if (`${owner}/${name}`.toLowerCase() !== normalizeRepo(repo)) {
    return `gh api ${word} names another repository than ${repo}, and agents stay on the manifest's repository`
  }

  return null
}

// The arguments of every gh call in a command run to its end, so one scan
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
        return `the guard has no --repo, so gh ${shown} is refused. ${hint}`
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

// readCommands() leaves `{…}` in place of each placeholder, so the
// placeholders and the path after them are read on the whole command. Alone,
// {owner} or {repo} could name another repository of the same owner or
// another owner's repository of that name.
function placeholderProblem(plain) {
  for (const match of plain.matchAll(/\{owner\}\/\{repo\}(\S*)/g)) {
    if (climbs(match[1])) {
      return `gh api {owner}/{repo}${match[1]} could climb out of the repository with .. or an encoded dot or slash, so it is refused`
    }
  }

  if (/\{(owner|repo)\}/.test(plain.replaceAll('{owner}/{repo}', ''))) {
    return 'gh api placeholders {owner} and {repo} are allowed only together as {owner}/{repo}, because alone they could reach another repository'
  }

  return null
}

// The agents' GitHub identity and repository, and the variables that keep
// the CLI from taking orders from agents.
const PROTECTED = 'GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|GH_REPO|GH_HOST|ROLLOUT_\\w*'

// A protected name as an argument: bare, assigned (`=`, `+=`, `[0]=`),
// attached to an option (`read -aNAME`) or as a nameref target (`x=NAME`).
const PROTECTED_ARGUMENT = new RegExp(`^(?:[-+][A-Za-z]*)?(${PROTECTED})(?!\\w)|=(${PROTECTED})(?!\\w)`)
const PROTECTED_NAME = new RegExp(`^(${PROTECTED})$`)

function protectedReason(name) {
  if (name.startsWith('ROLLOUT_')) {
    return `${name} is a ROLLOUT_* variable, and these keep the CLI from taking orders from agents`
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

// Words before the command word. `time -p` also takes an option.
const KEYWORDS = new Set(['!', 'if', 'then', 'elif', 'else', 'do', 'while', 'until', 'time'])
const ASSIGNMENT = /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/

// The index of the word the shell runs, past redirections, assignments and
// keywords, or -1 when there is none.
function commandWordAt(words, from) {
  let i = from

  while (i < words.length) {
    const word = words[i]
    const redirect = redirectWidth(words, i)

    if (redirect > 0) {
      i += redirect
    } else if (word === 'time') {
      i = pastOptions(words, i + 1)
    } else if (KEYWORDS.has(word) || ASSIGNMENT.test(word)) {
      i += 1
    } else {
      return i
    }
  }

  return -1
}

// Builtins and tools that run the next word as a command, past their own
// options and assignments. Returns where that command starts, or null.
function wrappedCommand(words, at) {
  const name = words[at].split(/[<>]/)[0]

  if (isTool(name, 'env')) {
    return readEnvOptions(words, at + 1)
  }

  if (name === 'exec') {
    return readExecOptions(words, at + 1)
  }

  if (name === 'command' || name === 'builtin' || isTool(name, 'nohup')) {
    return { problem: null, end: pastOptions(words, at + 1) }
  }

  return null
}

function commandWordProblem(words, raws) {
  let at = commandWordAt(words, 0)

  while (at !== -1) {
    if (!isCommandName(words[at], raws[at])) {
      return builtByExpansion(`the command word ${raws[at]}`)
    }

    const wrapped = wrappedCommand(words, at)

    // checkEnvCommands gives the reason for env's and exec's own options.
    if (!wrapped || wrapped.problem) {
      return null
    }

    at = commandWordAt(words, wrapped.end)
  }

  return null
}

const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh']

// How many values the options in a cluster take: -o and -O take one each.
function optionValues(word) {
  return /^[-+][A-Za-z]+$/.test(word) ? word.replace(/[^oO]/g, '').length : 0
}

// A shell reads all its options before the string of -c, so `bash -c -e "$x"`
// and `bash -co errexit "$x"` both run $x. Returns the string's index or -1.
function shellStringAt(words, cluster) {
  let values = optionValues(words[cluster])

  for (let i = cluster + 1; i < words.length; i += 1) {
    const word = words[i]

    if (values > 0) {
      values -= 1
    } else if (word === '--') {
      return i + 1 < words.length ? i + 1 : -1
    } else if (word === '--rcfile' || word === '--init-file') {
      values = 1
    } else if (/^[-+]/.test(word)) {
      values = optionValues(word)
    } else {
      return i
    }
  }

  return -1
}

// eval and `sh -c` run a string as a command, so the guard must read it. Its
// first word is the string's command word.
function shellStringProblem(words, raws) {
  const evalAt = words.indexOf('eval')
  const unreadable = evalAt === -1 ? -1 : firstFailing(readable, words, raws, evalAt + 1)

  if (unreadable !== -1) {
    return builtByExpansion(`the argument ${raws[unreadable]} of eval`)
  }

  const evaluated = evalAt + 1

  if (evalAt !== -1 && evaluated < words.length && !isCommandName(words[evaluated], raws[evaluated])) {
    return builtByExpansion(`the command ${raws[evaluated]} of eval`)
  }

  let shell = null

  for (let i = 0; i < words.length; i += 1) {
    if (SHELLS.some((name) => isTool(words[i], name))) {
      shell = words[i]
    } else if (shell && /^-[A-Za-z]*c[A-Za-z]*$/.test(words[i])) {
      const at = shellStringAt(words, i)

      if (at !== -1 && !isCommandName(words[at], raws[at])) {
        return builtByExpansion(`the command ${raws[at]} of ${shell} -c`)
      }

      shell = null
    }
  }

  return null
}

const GIT_VALUE_FLAGS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']

// The flags before git's subcommand and the key of -c must be names, because
// a glob there can turn into a setting once it matches a file the agent made.
// The other values need only be readable, and -C's directory is free.
function gitOptionProblem(words, raws, { flag, flagEnd, value, end }) {
  if (end === -1) {
    return `a quote in the git option ${raws[flag]} does not close in this command, so the guard cannot tell where git's subcommand starts. Keep ;, &, | and newlines out of a quoted value`
  }

  const unnamed = firstFailing(isName, words, raws, flag, flagEnd)

  if (unnamed !== -1) {
    return builtByExpansion(`the git option ${raws[unnamed]}`)
  }

  if (value === -1 || words[flag] === '-C') {
    return null
  }

  const unreadable = firstFailing(readable, words, raws, value, end)

  if (unreadable !== -1) {
    return builtByExpansion(`the git option ${raws[flag]} ${raws[unreadable]}`)
  }

  if (words[flag] === '-c' && !isName(words[value].split('=')[0], raws[value])) {
    return builtByExpansion(`the git option ${raws[flag]} ${raws[value]}`)
  }

  return null
}

// Git's global options, its subcommand, the arguments of config and push and
// the action of remote are where git decides what to change.
function gitExpansionProblem(words, raws) {
  const seen = new Set()
  let checkedFrom = Infinity

  for (const call of invocations(words, raws, 'git', GIT_VALUE_FLAGS)) {
    for (const option of globalOptions(words, raws, call, GIT_VALUE_FLAGS, seen)) {
      const problem = gitOptionProblem(words, raws, option)

      if (problem) {
        return problem
      }
    }

    const { start } = call

    if (start >= words.length) {
      continue
    }

    const sub = words[start]

    if (!isName(sub, raws[start])) {
      return builtByExpansion(`the git subcommand ${raws[start]}`)
    }

    // Calls come in order, so the first config or push covers the words of every later one.
    if ((sub === 'config' || sub === 'push') && start < checkedFrom) {
      checkedFrom = start

      const unnamed = firstFailing(isName, words, raws, start + 1)

      if (unnamed !== -1) {
        return builtByExpansion(`the git ${sub} argument ${raws[unnamed]}`)
      }
    }

    const [action] = sub === 'remote' ? positionals(words, raws, start + 1, [], 1) : []

    if (action !== undefined && !isName(words[action], raws[action])) {
      return builtByExpansion(`the git remote action ${raws[action]}`)
    }
  }

  return null
}

function ghExpansionProblem(words, raws) {
  let checkedFrom = Infinity

  for (const { call, start } of invocations(words, raws, 'gh', GH_GLOBAL_FLAGS)) {
    const [sub, action] = positionals(words, raws, start, GH_VALUE_FLAGS, 2)

    if (sub === undefined) {
      continue
    }

    if (!isName(words[sub], raws[sub])) {
      return builtByExpansion(`the gh subcommand ${raws[sub]}`)
    }

    if (words[sub] !== 'api') {
      if (action !== undefined && !isName(words[action], raws[action])) {
        return builtByExpansion(`the gh ${words[sub]} action ${raws[action]}`)
      }

      continue
    }

    // Every argument counts: an expanded word can become -X, --method or a field.
    if (call < checkedFrom) {
      checkedFrom = call

      const unreadable = firstFailing(readable, words, raws, call + 1)
      const problem = unreadable === -1 ? ghApiProblem(words, raws, sub + 1) : null

      if (unreadable !== -1) {
        return builtByExpansion(`the gh api argument ${raws[unreadable]}`)
      }

      if (problem) {
        return problem
      }
    }
  }

  return null
}

// The endpoint may hold `?`, which starts its query string, and `{…}` for the
// placeholders, which placeholderProblem() reads.
function isEndpoint(word, raw) {
  return isName(word.replaceAll('?', '').replaceAll('{…}', ''), raw)
}

// gh api's flags, its method and any word but the endpoint must be names, as
// a glob there can turn into -X PUT or a field once it matches a file the
// agent made. The values of the other flags, such as --jq, -H and -f, are
// free text.
function ghApiProblem(words, raws, from) {
  let endpoint = true
  let i = from

  while (i !== -1 && i < words.length) {
    const flagged = words[i].startsWith('-')
    const own = valueEnd(raws, i)
    const end = flagged ? optionEnd(words, raws, i, GH_VALUE_FLAGS) : own
    const named = flagged && (words[i] === '-X' || words[i] === '--method') ? end : own
    const test = !flagged && endpoint ? isEndpoint : isName
    const failing = firstFailing(test, words, raws, i, named === -1 ? words.length : named)

    if (failing !== -1) {
      return builtByExpansion(`the gh api argument ${raws[failing]}`)
    }

    endpoint &&= flagged
    i = end
  }

  return null
}

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'npx', 'pnpx', 'bun', 'bunx']
const PACKAGE_MANAGER_VALUE_FLAGS = ['-C', '--dir', '--filter', '-F', '-w', '--workspace']

// The script or package a manager runs comes right after its subcommand.
// Globs stay free there: `npx eslint 'src/**'`.
function packageManagerExpansionProblem(words, raws) {
  for (const name of PACKAGE_MANAGERS) {
    for (const { start } of invocations(words, raws, name, PACKAGE_MANAGER_VALUE_FLAGS)) {
      if (start >= words.length) {
        continue
      }

      if (!isName(words[start], raws[start])) {
        return builtByExpansion(`the ${name} subcommand ${raws[start]}`)
      }

      const [first] = positionals(words, raws, start + 1, [], 1)

      if (first !== undefined && !readable(words[first], raws[first])) {
        return builtByExpansion(`the ${name} ${words[start]} argument ${raws[first]}`)
      }
    }
  }

  return null
}

// The changesets CLI under any name it runs by: `changeset@latest`, a bin
// path, `@changesets/cli` or its `bin.js`. `.changeset/pre.json` is not it.
const CHANGESET_TOOL = /(^|\/)(changeset(@[^/]*)?|@changesets\/cli(@[^/]*)?(\/.*)?)$/i

export const CHANGESET_RELEASE = ['version', 'publish', 'tag', 'pre']

function changesetExpansionProblem(words, raws) {
  const tool = words.findIndex((word) => CHANGESET_TOOL.test(word))

  if (tool === -1) {
    return null
  }

  const unreadable = firstFailing(readable, words, raws, tool + 1)

  if (unreadable !== -1) {
    return builtByExpansion(`the changeset argument ${raws[unreadable]}`)
  }

  const [first] = positionals(words, raws, tool + 1, [], 1)

  if (first !== undefined && !isName(words[first], raws[first])) {
    return builtByExpansion(`the changeset command ${raws[first]}`)
  }

  return null
}

// Run before the tool rules, so an expanded word gets this reason and not the
// reason of a rule it slipped past.
function expansionProblem(words, raws) {
  return (
    commandWordProblem(words, raws) ??
    shellStringProblem(words, raws) ??
    gitExpansionProblem(words, raws) ??
    ghExpansionProblem(words, raws) ??
    packageManagerExpansionProblem(words, raws) ??
    changesetExpansionProblem(words, raws)
  )
}

export const PUBLISH_WORDS = [
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

function checkPackageManagers(words, raws) {
  if (!words.some((word) => PACKAGE_MANAGERS.some((name) => isTool(word, name)))) {
    return null
  }

  const hit = words.find((word) => PUBLISH_WORDS.includes(word))

  if (hit) {
    return `\`${hit}\` belongs to the release PR and the maintainer, not to rollout agents`
  }

  for (const name of PACKAGE_MANAGERS) {
    for (const { start } of invocations(words, raws, name, PACKAGE_MANAGER_VALUE_FLAGS)) {
      if (words[start] === 'version') {
        return `${name} version is not allowed: versions are bumped by the release PR`
      }
    }
  }

  return null
}

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

// Push options a worker may not use. `--repo` counts in every spelling, `--repo=x` included.
export const PUSH_FORBIDDEN = ['--force', '-f', '--mirror', '--all', '--tags', '--delete', '-d', '--prune', '--no-verify', '--repo']

function checkPush(args, branch) {
  const options = args.filter((arg) => arg.startsWith('-'))
  const positional = args.filter((arg) => !arg.startsWith('-'))

  for (const option of options) {
    if (PUSH_FORBIDDEN.includes(option) || option.startsWith('--repo')) {
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

export const VERIFIER_GIT_FORBIDDEN = [
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

export const CONFIG_SECTION_FLAGS = ['--remove-section', '--rename-section']
export const REMOTE_FORBIDDEN = ['add', 'set-url', 'rename', 'remove', 'rm', 'set-head']
export const GIT_FORBIDDEN = ['update-ref', 'send-pack', 'http-push', 'receive-pack', 'filter-branch', 'replace']

// Refused for the worker with `git tag`.
export const BRANCH_FORBIDDEN = ['-D', '-d', '--delete', '-m', '-M', '--move']

function checkGit(words, raws, role, branch) {
  for (const call of invocations(words, raws, 'git', GIT_VALUE_FLAGS)) {
    const sub = words[call.start]

    if (!sub) {
      continue
    }

    const rest = words.slice(call.start + 1)

    if (sub === 'config' && (rest.some((arg) => CONFIG_SECTION_FLAGS.includes(arg)) || GIT_SETTINGS.test(rest.join(' ')))) {
      return 'changing git settings for hooks, credentials or remotes is not allowed'
    }

    // git remote takes -v before its action.
    const action = sub === 'remote' ? words[positionals(words, raws, call.start + 1, [], 1)[0]] : undefined

    if (REMOTE_FORBIDDEN.includes(action)) {
      return `git remote ${action} is not allowed: agents push to origin only`
    }

    if (GIT_FORBIDDEN.includes(sub)) {
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
        return 'the guard has no --branch, so it refuses to push'
      }

      const problem = checkPush(rest, branch)

      if (problem) {
        return problem
      }
    }

    if (sub === 'tag' || (sub === 'branch' && rest.some((arg) => BRANCH_FORBIDDEN.includes(arg)))) {
      return `git ${sub} ${rest.join(' ')} is not allowed`
    }
  }

  return null
}

export const HTTP_TOOLS = ['curl', 'wget', 'http', 'https', 'xh']
export const HTTP_HOSTS = ['api.github.com', 'uploads.github.com', 'registry.npmjs.org', 'registry.yarnpkg.com']
const HTTP_TOOL = new RegExp(`\\b(${HTTP_TOOLS.join('|')})\\b`, 'i')
const HTTP_HOST = new RegExp(HTTP_HOSTS.map(escapeRegExp).join('|'), 'i')

// gh calls that write to GitHub, refused for the verifier on top of the rest.
export const VERIFIER_GH_FORBIDDEN = ['pr create', 'pr edit', 'pr comment', 'pr ready', 'issue']
const VERIFIER_GH_ACTION = new RegExp(`\\b(${VERIFIER_GH_FORBIDDEN.map((action) => action.replace(' ', '\\s+')).join('|')})\\b`)

// The tool's name counts in any case, its subcommands only as written.
function writesGitHub(line) {
  const at = line.search(/\bgh\b/i)

  return at !== -1 && VERIFIER_GH_ACTION.test(line.slice(at))
}

function toolProblem(words, raws, role, branch, gh) {
  const line = words.join(' ')

  if (HTTP_TOOL.test(line) && HTTP_HOST.test(line)) {
    return 'talk to GitHub through gh (read-only gh api), not raw HTTP; npm registry writes are not allowed'
  }

  const problem =
    checkGh(words, raws, gh) ??
    checkChangesets(words) ??
    checkPackageManagers(words, raws) ??
    checkGit(words, raws, role, branch) ??
    checkBuiltins(words) ??
    checkEnvCommands(words)

  if (problem) {
    return problem
  }

  if (role === 'verifier' && writesGitHub(line)) {
    return 'the verifier is read-only on GitHub'
  }

  return null
}

// Some rules cost the square of a line's length, and a hook that times out
// lets the command run. The caps keep the guard's work far below the
// timeout. Joined continuations and nested code can make a longer line or
// command, so the caps hold for those too.
const MAX_COMMAND = 262_144
const MAX_LINE = 16_384

function lengthProblem(command) {
  if (command.length > MAX_COMMAND) {
    return `a command of more than ${MAX_COMMAND} characters is too long for the guard, split it`
  }

  if (command.split('\n').some((line) => line.length > MAX_LINE)) {
    return `a line of more than ${MAX_LINE} characters is too long for the guard, split the command`
  }

  return null
}

// A -c override counts anywhere in the command, `-c key=value` or
// `-ckey=value`, not only among a git call's options. An option the guard
// does not list as taking a value moves git's subcommand, as in
// `git --attr-source x -c …`, and git under an alias has no `git` word.
function overridesGitSetting(plain) {
  for (const match of plain.matchAll(/(?:^|\s)-c\s*(\S+)/g)) {
    if (GIT_SETTINGS.test(match[1])) {
      return true
    }
  }

  return false
}

export function check(command, role, branch, context = {}) {
  const raw = lengthProblem(command)

  if (raw) {
    return raw
  }

  // A command read the same way twice is decided once.
  const checked = new Set()

  for (const text of readings(command)) {
    const problem = checkReading(text, role, branch, context, checked)

    if (problem) {
      return problem
    }
  }

  return null
}

function checkReading(joined, role, branch, context, checked) {
  const plain = unquote(joined)

  const problem =
    lengthProblem(joined) ??
    (offLimits(joined, plain, context) ? CONTROL_PLANE : null) ??
    (overridesGitSetting(plain) ? 'overriding git settings for hooks, credentials or remotes is not allowed' : null) ??
    wholeCommandProblem(plain, context)

  if (problem) {
    return problem
  }

  const gh = { repo: context.repo, placeholders: placeholderProblem(plain) }

  for (const text of readCommands(joined)) {
    if (text.length > MAX_LINE) {
      return `a command of more than ${MAX_LINE} characters between separators is too long for the guard, split it`
    }

    const key = `${gh.placeholders}\n${text}`

    if (checked.has(key)) {
      continue
    }

    checked.add(key)

    const { words, raws } = readWords(text)
    const found = expansionProblem(words, raws) ?? toolProblem(words, raws, role, branch, gh)

    if (found) {
      return found
    }
  }

  return null
}

const GUARD_OPTIONS = {
  dir: { type: 'string' },
  home: { type: 'string' },
  name: { type: 'string' },
  repo: { type: 'string' },
  branch: { type: 'string' },
}

const ROLES = ['worker', 'verifier']

// The role and context on the hook command (lib/settings.mjs), or the problem
// that refuses every command. In strict mode parseArgs refuses an unknown
// option and a value that starts with `-` after a space.
export function guardArgs(argv) {
  let parsed

  try {
    parsed = parseArgs({ args: argv, options: GUARD_OPTIONS, strict: true, allowPositionals: true })
  } catch (error) {
    return { problem: `the guard cannot read its hook command (${errorText(error)}), command refused` }
  }

  const [role = 'worker', ...extra] = parsed.positionals

  if (!ROLES.includes(role) || extra.length > 0) {
    return { problem: `the guard takes one role, worker or verifier, not ${parsed.positionals.join(' ')}, command refused` }
  }

  return { role, context: { ...parsed.values } }
}

// Null allows the command, a string is the reason to refuse it. It never
// throws, so the agent learns why its command was refused. The hook command
// turns any other failure into exit 2. Only tests pass `inspect`.
export function decide(input, role, context, inspect = check) {
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
    return inspect(command, role, context.branch, context)
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
  const input = readStdin()
  const { role, context, problem: unreadable } = guardArgs(process.argv.slice(2))
  const problem = unreadable ?? decide(input, role, context)

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
