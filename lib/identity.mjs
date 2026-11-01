import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEnv } from './sh.mjs'

// Agents act on GitHub as a separate, non-admin account: its token comes
// from repo.agentToken, and gh gets an empty config dir with no stored login.
// That alone does not stop the keyring fallback, see agentEnv.
export function agentGitHubEnv(manifest) {
  if (!manifest.repo.agentToken) {
    return {}
  }

  if (!existsSync(manifest.repo.agentToken)) {
    throw new Error(`repo.agentToken ${manifest.repo.agentToken} does not exist`)
  }

  const token = readFileSync(manifest.repo.agentToken, 'utf8').trim()
  const configDir = join(manifest.dir, '.gh-agents')
  mkdirSync(configDir, { recursive: true })

  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: '',
    GH_CONFIG_DIR: configDir,
    GIT_TERMINAL_PROMPT: '0',
  }
}

// gh reads the keyring login whenever GH_HOST is set, even with an empty
// config dir. GH_REPO pins the repository without that lookup.
export function agentEnv(manifest, extra = {}) {
  const env = makeEnv(manifest, { ...extra, ...agentGitHubEnv(manifest), GH_REPO: `github.com/${manifest.repo.github}` })

  delete env.GH_HOST
  delete env.GH_ENTERPRISE_TOKEN
  delete env.GITHUB_ENTERPRISE_TOKEN

  return env
}

export function emptyNpmrc(manifest) {
  const path = join(manifest.dir, '.npmrc-agents')
  writeFileSync(path, '# rollout agents: no registry credentials\n')

  return path
}

// The environment of a read-only agent, for anything that runs code from a
// worktree an agent may have written. No npm credentials reach it (every
// publish path fails with ENEEDAUTH). ROLLOUT_ROLE is its only rollout
// variable: the guard's context is on its hook command, and any other
// ROLLOUT_* variable the driver inherited, such as a default --dir the
// maintainer exported, would hand an agent a path its shell expands. Callers
// add Claude Code's variables when they need them.
export function readOnlyEnv(manifest, role) {
  const env = agentEnv(manifest, {
    ROLLOUT_ROLE: role,
    NPM_CONFIG_USERCONFIG: emptyNpmrc(manifest),
    NPM_TOKEN: '',
    NODE_AUTH_TOKEN: '',
  })

  for (const name of Object.keys(env)) {
    if (name.startsWith('ROLLOUT_') && name !== 'ROLLOUT_ROLE') {
      delete env[name]
    }
  }

  return env
}
