import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeEnv } from './sh.mjs'

// Agents act on GitHub as a separate, non-admin account: its token comes
// from repo.agentToken, and gh gets an empty config dir with no stored login.
// That alone does not stop the keyring fallback, see agentEnv.
export function agentGitHubEnv(M) {
  if (!M.repo.agentToken) {
    return {}
  }

  if (!existsSync(M.repo.agentToken)) {
    throw new Error(`repo.agentToken ${M.repo.agentToken} does not exist`)
  }

  const token = readFileSync(M.repo.agentToken, 'utf8').trim()
  const configDir = join(M.dir, '.gh-agents')
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
export function agentEnv(M, extra = {}) {
  const env = makeEnv(M, { ...extra, ...agentGitHubEnv(M), GH_REPO: `github.com/${M.repo.github}` })

  delete env.GH_HOST
  delete env.GH_ENTERPRISE_TOKEN
  delete env.GITHUB_ENTERPRISE_TOKEN

  return env
}
