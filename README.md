# claude-rollout

Ships a plan of several PRs with headless Claude Code agents. For every PR a writer agent drafts a brief from the plan, a reviewer checks it against the code, an implementer opens the PR and waits for green CI, and an independent verifier tries to refute its claim. A merge gate re-checks everything on GitHub before a PR is called ready.

The orchestrator is a process, not a model. `rollout run` ticks every minute, reads the truth from GitHub, starts agents, runs the gate and records everything in a ledger. A stalled chat session cannot stall a rollout, and restarting the same command resumes it.

Status: internal alpha. It shipped describe-me 0.5.0 (13 PRs) end to end.

## Quick start

```sh
npm install
node bin/rollout.mjs preflight --dir ~/.rollouts/<name> --live
node bin/rollout.mjs run --dir ~/.rollouts/<name>
node bin/rollout.mjs status --dir ~/.rollouts/<name>
```

A rollout directory holds `manifest.yaml` (see `examples/manifest.yaml`), optional `briefs/<id>.md` and the state the driver writes. `SKILL.md` documents the commands, the PR lifecycle, the gate and the guard rails.

Requirements: Node 20+, git, gh, pnpm and `claude` on PATH. Set up the repository as [docs/github-setup.md](docs/github-setup.md) describes, and read [docs/security.md](docs/security.md) for what protects what.

## UI

```sh
node bin/rollout.mjs ui [--root ROOT] [--port N] [--no-open] [--read-only]
```

- The root is `--root`, else `ROLLOUT_ROOT`, else `~/.rollouts`. The UI lists every directory in it that has a `manifest.yaml`.
- It listens on 127.0.0.1 only, on a random port unless `--port` is given. It prints a URL with a token in the fragment (`#t=`). The token is kept only in memory and is valid while the server runs. The browser opens unless `--no-open` is set. It runs until Ctrl-C.
- It reads rollout files only and never calls GitHub, so stopped and finished rollouts work too.
- Views: board, timeline, events, costs, and a PR page with overview, runs (with transcripts), verifier, review and brief tabs. All of them update live.
- Controls: pause, resume, stop, start (optionally a dry run), unhalt, retry, note, hold and release. Stop, Start, Retry and Unhalt ask first. `--read-only` disables every control. Approval stays a GitHub review or `rollout approve`.

## Development

```sh
npm test               # node:test suites in test/
npm run format:check   # prettier
```

Read `CLAUDE.md` and `STYLE.md` before changing code.
