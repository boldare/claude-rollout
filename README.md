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

## Development

```sh
npm test               # node:test suites in test/
npm run format:check   # prettier
```

Read `CLAUDE.md` and `STYLE.md` before changing code.
