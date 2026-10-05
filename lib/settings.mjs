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

// Claude runs the hook command through a shell, so the skill path is quoted.
// A hook blocks only with exit 2, so `|| exit 2` turns any other exit of node
// into 2: a crash, running out of memory or a file node cannot load.
export function guardCommand(manifest, role) {
  return `node ${shellQuote(join(manifest.home, 'hooks', 'guard-bash.mjs'))} ${readOnlyRole(role) ? 'verifier' : 'worker'} || exit 2`
}

// A hook that times out lets the command run, so the limit is finite but far
// above the guard's worst case.
const GUARD_TIMEOUT_SECONDS = 30

export function agentSettings(manifest, role) {
  const verifier = readOnlyRole(role)
  const guard = guardCommand(manifest, role)

  // File tools never reach the control plane or the guard rails themselves.
  const protectedPaths = [manifest.dir, manifest.home].flatMap((path) => [`Edit(/${path}/**)`, `Write(/${path}/**)`])
  const deny = [...ALWAYS_DENY, ...pushDeny(manifest), ...protectedPaths]

  return {
    permissions: {
      allow: verifier ? VERIFIER_ALLOW : WORKER_ALLOW,
      deny: verifier ? [...deny, 'Edit', 'Write', 'NotebookEdit'] : deny,
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
