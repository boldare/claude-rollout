import { join } from 'node:path'

// Settings passed to every agent with --settings. Deny rules win over allow
// rules in any permission mode; the PreToolUse hook catches what patterns
// cannot (chained commands, refspecs, gh api methods).
const ALWAYS_DENY = [
  'Bash(gh pr merge *)',
  'Bash(gh pr review *)',
  'Bash(gh pr close *)',
  'Bash(gh repo *)',
  'Bash(gh release *)',
  'Bash(gh secret *)',
  'Bash(gh variable *)',
  'Bash(gh workflow *)',
  'Bash(gh ruleset *)',
  'Bash(npm publish *)',
  'Bash(pnpm publish *)',
  'Bash(pnpm release *)',
  'Bash(pnpm run release *)',
  'Bash(pnpm changeset publish *)',
]

const WORKER_ALLOW = [
  'Bash(git *)',
  'Bash(pnpm *)',
  'Bash(node *)',
  'Bash(gh pr create *)',
  'Bash(gh pr edit *)',
  'Bash(gh pr view *)',
  'Bash(gh pr checks *)',
  'Bash(gh pr list *)',
  'Bash(gh run view *)',
  'Bash(gh run list *)',
  'Bash(gh run rerun *)',
  'Bash(gh api *)',
]

const VERIFIER_ALLOW = [
  'Bash(git diff *)',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git status *)',
  'Bash(git rev-parse *)',
  'Bash(pnpm *)',
  'Bash(node *)',
  'Bash(gh pr view *)',
  'Bash(gh pr checks *)',
  'Bash(gh pr diff *)',
  'Bash(gh run view *)',
  'Bash(gh api *)',
]

// Roles that must not change the tree: the verifier, the brief writers and the delegate.
export function readOnlyRole(role) {
  return role === 'verify' || role === 'brief' || role === 'delegate'
}

const FILE_TOOLS = ['Edit', 'Write', 'NotebookEdit']

// Tools that act in a later turn. Under `claude -p` the run ends with the
// turn, so an agent that ends its turn to wait for one is cut off and reports.
const LATER_TURN_TOOLS = ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'Monitor']

// Passed as --disallowedTools, so the model never sees them, and denied in the settings as well.
export function disallowedTools(role) {
  return readOnlyRole(role) ? [...FILE_TOOLS, ...LATER_TURN_TOOLS] : LATER_TURN_TOOLS
}

// The built-in tools of each role, as an allowlist: a tool a newer Claude
// Code adds reaches no agent until it is named here.
const WORKER_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'TaskStop']
const READ_ONLY_TOOLS = ['Bash', 'Read', 'WebFetch', 'WebSearch', 'TaskStop']

export function agentTools(role) {
  return readOnlyRole(role) ? READ_ONLY_TOOLS : WORKER_TOOLS
}

// What an agent loads besides its prompt: the tools of its role, no skills
// and the project's settings only. Local and user settings can carry hooks
// and env that an agent wrote or the maintainer set for themselves. The guard
// and the permission rules come through --settings, so they still apply. The
// maintainer's plugins, skills and connectors would ride along in every
// request. Only implement and fix get the manifest's mcpConfig: an MCP tool
// never passes the Bash guard, so a server that writes files or posts would
// break the read-only roles. --tools is variadic, so it stays last.
export function contextArgs(manifest, role) {
  const mcp = manifest.mcpConfig && !readOnlyRole(role) ? ['--mcp-config', manifest.mcpConfig] : []

  return ['--setting-sources', 'project', '--strict-mcp-config', ...mcp, '--disable-slash-commands', '--tools', ...agentTools(role)]
}

// No agent reads or writes the maintainer's auto-memory. A subscription
// writes the prompt cache for an hour by default, at a higher rate. The
// read-only roles never pause that long between turns, so they get five
// minutes. Implement and fix keep Claude Code's default: they wait for CI,
// and a fix resumes the implementer's session.
export function contextEnv(role) {
  return {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ...(readOnlyRole(role) ? { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' } : {}),
  }
}

// The base branch may be called something else, and `main` stays denied too.
function pushDeny(manifest) {
  const names = [...new Set(['main', manifest.repo.base])]

  return names.flatMap((name) => [`Bash(git push origin ${name}*)`, `Bash(git push origin HEAD:${name}*)`])
}

// The shell expands nothing inside single quotes, so any path survives. A
// single quote in the text closes the quotes, is escaped and reopens them.
function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`
}

// The guard's context goes on its command line, not into the agents'
// environment, where their shell would expand it for them. Claude runs the
// hook command through a shell, so the skill path and every value are quoted.
// A hook blocks only with exit 2, so `|| exit 2` turns any other exit of node
// into 2: a crash, running out of memory or a file node cannot load.
export function guardCommand(manifest, role, { branch = '' } = {}) {
  const readOnly = readOnlyRole(role)
  const context = {
    dir: manifest.dir,
    home: manifest.home,
    name: manifest.rollout,
    repo: manifest.repo.github,
    // Read-only roles get no branch, but they work in the PR worktree, whose
    // rollout-branch marker lets pre-push through. The guard refuses their pushes.
    branch: readOnly ? '' : branch,
  }

  // parseArgs in strict mode throws on `--dir -x`, so each value is attached with `=`.
  const options = Object.entries(context).map(([name, value]) => `--${name}=${shellQuote(value)}`)

  return `node ${shellQuote(join(manifest.home, 'hooks', 'guard-bash.mjs'))} ${readOnly ? 'verifier' : 'worker'} ${options.join(' ')} || exit 2`
}

// A hook that times out lets the command run, so the limit is finite but far
// above the guard's worst case.
const GUARD_TIMEOUT_SECONDS = 30

export function agentSettings(manifest, role, { branch = '' } = {}) {
  const verifier = readOnlyRole(role)
  const guard = guardCommand(manifest, role, { branch })

  // File tools never reach the control plane or the guard rails themselves.
  const protectedPaths = [manifest.dir, manifest.home].flatMap((path) => [`Edit(/${path}/**)`, `Write(/${path}/**)`])
  const deny = [...ALWAYS_DENY, ...pushDeny(manifest), ...protectedPaths]

  return {
    permissions: {
      allow: verifier ? VERIFIER_ALLOW : WORKER_ALLOW,
      deny: [...deny, ...disallowedTools(role)],
    },
    attribution: { commit: '', pr: '' },
    includeCoAuthoredBy: false,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: guard, timeout: GUARD_TIMEOUT_SECONDS }],
        },
      ],
    },
  }
}
