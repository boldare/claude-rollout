# Security model

What protects what in a rollout, and what does not. Hard boundaries hold even against an agent that tries to break them. Seatbelts stop accidents and naive prompt injection, not a determined attacker.

## Who and what

- Agents run headless as the maintainer's OS user, with the settings from `lib/settings.mjs`.
- They read untrusted input: repo content, CI logs and PR comments. Only comments by `repo.maintainers` reach them (`feedbackFor` in `lib/github.mjs`).
- The assets are the base branch, published packages, credentials, the rollout's control plane (manifest, inbox, ledger) and the local briefs, which may name clients.

## Hard boundaries

These are enforced where the agent cannot edit them.

- **The bot account's GitHub role and the rulesets.** The bot has the Write role and no bypass. A merge needs a maintainer's review and green checks. See `docs/github-setup.md` and the preflight check of `repo.agentToken`.
- **npm trusted publishing with tokens disallowed.** Set on npmjs.com, see `docs/github-setup.md`.
- **The UI's network checks.** The UI listens on 127.0.0.1 and checks `Host` and `Origin` (`handle` in `lib/server.mjs`), so other web pages cannot reach it through DNS rebinding or CSRF.

The limit, stated plainly: these hold against the bot's token. Agents run as you, so any credential your user can read (your `gh` login, `~/.npmrc`, SSH keys) is within their reach. A boundary against a hostile agent needs another OS user, a VM or a container. This repo provides none.

## The driver's gate

The driver never trusts an agent's report. It merges only what `lib/judge.mjs` passes, on facts it reads from GitHub (`collectFacts` in `lib/github.mjs`). That is hard against a wrong or false report.

It is not a boundary against an agent that attacks the driver's own files (code, ledger, inbox). Only the seatbelts below protect those.

## Seatbelts

- **The Bash guard.** `hooks/guard-bash.mjs` is a regex guard, and its header says so.
- **Permission rules.** Deny rules for merge, review, repo admin and publish commands, plus Edit and Write denies on the rollout and skill directories (`lib/settings.mjs`).
- **The git hooks.** `git-hooks/pre-push` allows only the PR branch and only the HTTPS push URL. `git-hooks/commit-msg` allows one subject line.
- **The agent environment.** The bot's `GH_TOKEN`, an empty `gh` config directory, an empty npmrc and empty npm tokens (`lib/identity.mjs`, `runAgent` in `lib/spawn.mjs`).
- **The CLI's role check.** `bin/rollout.mjs` refuses to drive a rollout when `ROLLOUT_ROLE` is set.
- **The UI token.** It lives only in the server's memory (`lib/server.mjs`), but it is printed in the terminal and stays in the browser history with the URL. It stops a plain `curl`, not code that reads your files.
- **The verifier's read-only mode.** Edit and Write are denied (`runAgent` in `lib/spawn.mjs`, `lib/settings.mjs`), and the guard applies its verifier role (`hooks/guard-bash.mjs`).
- **The gate's denylist check.** `repo.denylist` is checked in `lib/judge.mjs`. It catches a leak before the merge, but a pushed branch of a public repo is already visible.

## What to do

- Set up the repository as `docs/github-setup.md` describes.
- Run `rollout preflight --live` before the first run. It proves the guard in a real headless agent.
- Review the workflow files that `rollout card` flags before you approve a PR.
