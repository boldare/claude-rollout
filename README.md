# claude-rollout

Ships a plan of several PRs with headless Claude Code agents. For a PR without a brief, a writer agent drafts one from the plan and a reviewer checks it against the code. For every PR, an implementer opens it and waits for green CI, and an independent verifier tries to refute its claim. A merge gate re-checks everything on GitHub before the driver merges a PR.

The orchestrator is a process, not a model. `rollout run` ticks every minute, reads the truth from GitHub, starts agents, runs the gate and records everything in a ledger. A stalled chat session cannot stall a rollout, and restarting the same command resumes it.

Status: internal alpha. It shipped describe-me 0.5.0 (13 PRs) end to end.

**Docs: [grzehub.github.io/claude-rollout](https://grzehub.github.io/claude-rollout/).** The same pages live in `docs/`, so `open docs/index.html` works offline.

## Install

```sh
git clone https://github.com/grzehub/claude-rollout ~/.claude/skills/rollout
cd ~/.claude/skills/rollout && npm ci
```

The repository is also a Claude Code skill (`SKILL.md`), so this makes `/rollout` available too. Requirements: Node 20+, git, gh, pnpm and `claude` on PATH. [Getting started](https://grzehub.github.io/claude-rollout/getting-started.html) explains the other ways to install and why the installed copy stays apart from a checkout you develop in.

## Quick start

```sh
R=~/.claude/skills/rollout/bin/rollout.mjs
node $R preflight --dir ~/.rollouts/<name> --live
node $R run --dir ~/.rollouts/<name> --only P1 --dry-run
node $R ui
```

A rollout directory holds `manifest.yaml` (see `examples/manifest.yaml`), optional `briefs/<id>.md` and the state the driver writes. Before a first run, set up the accounts and the repository as [Accounts](https://grzehub.github.io/claude-rollout/accounts.html) describes.

- [Getting started](https://grzehub.github.io/claude-rollout/getting-started.html): install and a first dry run.
- [Accounts](https://grzehub.github.io/claude-rollout/accounts.html): your GitHub login, the bot account, the Claude login.
- [Manifest](https://grzehub.github.io/claude-rollout/manifest.html): every field and its default.
- [Commands](https://grzehub.github.io/claude-rollout/commands.html): every command and flag, and what the UI offers.
- [Web UI](https://grzehub.github.io/claude-rollout/ui.html): what it shows and how it stays live.
- [How it works](https://grzehub.github.io/claude-rollout/how-it-works.html): the tick, the PR lifecycle, the agents, the gate.
- [Security](https://grzehub.github.io/claude-rollout/security.html): what protects what, and what does not.

## Development

```sh
npm test               # node:test suites in test/
npm run format:check   # prettier
```

Read `CLAUDE.md` and `STYLE.md` before changing code. The docs are plain HTML and CSS in `docs/` with no build step. `test/docs.test.mjs` keeps them in step with the code: one sidebar on every page, links that resolve, the UI's tokens, and a place for every command, manifest field and PR state.
