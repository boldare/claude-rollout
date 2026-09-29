import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Agents act on GitHub as a separate, non-admin account: its token comes
// from repo.agentToken, and gh gets an empty config dir, so dropping GH_TOKEN
// does not fall back to the maintainer's stored login.
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
