# GitHub setup

What a repository needs before a rollout drives it. `rollout preflight` checks most of it. Each section names the manifest field or the preflight check it relates to.

## Bot account and token

Agents open PRs and push as a separate GitHub account, never as you.

1. Create a GitHub account for the agents and invite it as a collaborator with the Write role. Preflight requires its permission to be exactly `write` and its login to be outside `repo.maintainers` (the `agent identity` line in `bin/rollout.mjs`).
2. Create a classic token for it with the `repo` and `workflow` scopes. `workflow` matters only for PRs that change `.github/workflows/`, and preflight warns when it is missing. Preflight reads the scopes from the `x-oauth-scopes` header, so with a fine-grained token it cannot confirm `workflow` and warns.
3. Save the token in a file outside any repo, run `chmod 600` on it and point `repo.agentToken` at it.

Agents get the token as `GH_TOKEN`, with `GH_CONFIG_DIR` set to an empty directory in the rollout directory, so they cannot fall back to your stored `gh` login (`lib/identity.mjs`). Worktrees push over HTTPS to `repo.pushUrl` through `gh auth git-credential` (`lib/worktree.mjs`).

`policy.approval: github` needs both `repo.agentToken` and `repo.maintainers` (`validateManifest` in `lib/manifest.mjs`).

## Rulesets

Add a branch ruleset on `repo.base`:

- Require a pull request. Require one approval when `policy.approval` is `github`.
- Require the status checks that `repo.requiredChecks` matches.
- Block force pushes.
- Restrict deletions.
- Requiring code scanning results is optional (see below).

The bypass list holds only the repository admin role, never the bot.

Your own `gh` login must be a repository admin when `merge.admin` is set, and the default `auto` counts. Preflight checks it. The driver merges a PR you authored with `--admin` (`needsAdmin` in `lib/judge.mjs`, `merge` in `lib/github.mjs`), because GitHub does not let authors approve their own PR.

In the repository settings, enable squash merges. Preflight fails without them. It also suggests the PR title with a blank message as the squash default, and warns otherwise.

## CODEOWNERS

Add `.github/CODEOWNERS` that names the maintainers for `.github/`, the release configuration and `CODEOWNERS` itself. Make the ruleset require a code owner review. The bot is never a code owner.

This backs up `repo.forbid` and `allowWorkflows`. The driver's gate enforces both (`lib/judge.mjs`), GitHub does not.

## Code scanning

Enable CodeQL default setup. When the ruleset requires its results, GitHub reports the merge state `BLOCKED` until they exist. The gate then waits with a reason, unless it merges with `--admin` (`lib/judge.mjs`).

## npm trusted publishing

Publish only from a GitHub Actions release workflow through OIDC, with no npm token anywhere.

On the driver side:

- `repo.neverMerge` keeps the release PR away from the driver.
- The release workflow belongs in `repo.forbid` (see `examples/manifest.yaml`).
- Agents get no npm credentials (`runAgent` in `lib/spawn.mjs`).
- Publish commands are denied in the agents' settings (`lib/settings.mjs`).

Pitfalls:

- Trusted publishing needs npm CLI 11.5.1 or newer. Upgrade npm in the workflow unless the Node version already bundles it.
- The publishing job needs `permissions: id-token: write`.
- The trusted publisher is set per package on npmjs.com: owner, repository, workflow file name (for example `release.yml`, the name only) and an optional environment. All must match exactly. Every package of a monorepo needs its own entry.
- `repository.url` in each `package.json` must match the GitHub repository, or the publish fails.
- Only GitHub-hosted runners are supported.
- After the first trusted publish works, set the package to require two-factor authentication and disallow tokens, and delete any `NPM_TOKEN` secret.
