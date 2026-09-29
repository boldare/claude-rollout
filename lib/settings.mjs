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
  'Bash(git push origin main*)',
  'Bash(git push origin HEAD:main*)',
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

// Roles that must not change the tree: the verifier and the brief writers.
export function readOnlyRole(role) {
  return role === 'verify' || role === 'brief'
}

export function guardCommand(M, role) {
  return `node ${JSON.stringify(join(M.home, 'hooks', 'guard-bash.mjs'))} ${readOnlyRole(role) ? 'verifier' : 'worker'}`
}

export function agentSettings(M, role) {
  const verifier = readOnlyRole(role)
  const guard = guardCommand(M, role)

  // File tools never reach the control plane or the guard rails themselves.
  const protectedPaths = [M.dir, M.home].flatMap((path) => [`Edit(/${path}/**)`, `Write(/${path}/**)`])

  return {
    permissions: {
      allow: verifier ? VERIFIER_ALLOW : WORKER_ALLOW,
      deny: verifier ? [...ALWAYS_DENY, ...protectedPaths, 'Edit', 'Write', 'NotebookEdit'] : [...ALWAYS_DENY, ...protectedPaths],
    },
    attribution: { commit: '', pr: '' },
    includeCoAuthoredBy: false,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: guard }],
        },
      ],
    },
  }
}
