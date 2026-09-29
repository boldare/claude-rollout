# claude-rollout: notes for AI assistants

This repo is the rollout driver itself: a Node 20+ ESM CLI (`bin/rollout.mjs`) with its modules in `lib/`, agent prompts in `prompts/`, report schemas in `schemas/`, the PreToolUse guard in `hooks/guard-bash.mjs` and git hooks in `git-hooks/`. `SKILL.md` is the user-facing manual and is loaded as a Claude Code skill.

Follow `STYLE.md`.

## Commands

```sh
npm ci
npm test               # all suites, must stay green
npm run format:check   # prettier, run `npm run format` to fix
```

## Rules

- No new runtime dependencies without a good reason. Today there is one (`yaml`). The UI, when it exists, is plain HTML, CSS and ES modules served by `node:http`, with no build step.
- The driver must keep working unattended for hours. Every GitHub or git call can fail. Errors belong to one PR (`guarded()` in `lib/driver.mjs`), never to the whole tick.
- `lib/judge.mjs` and `lib/checks.mjs` stay pure and fully tested. Anything that decides whether a PR may merge goes there.
- Never weaken the guard (`hooks/guard-bash.mjs`) or the git hooks to make a test pass. Add a test for every rule and every bypass you close.
- Tests never start real agents, never call GitHub and never touch `~/.claude` or a real rollout directory. Build fixtures in a temp dir.
- Never copy data from a real rollout (briefs, logs, ledgers) into the repo. It can contain client names and local paths. Generate synthetic fixtures instead.
- You may be running inside a rollout of this very repo. The installed copy of the skill is what runs the rollout. Your worktree is a separate checkout, so your changes never affect the running driver.
