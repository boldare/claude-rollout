import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ALWAYS,
  BRANCH_FORBIDDEN,
  CHANGESET_RELEASE,
  CONFIG_SECTION_FLAGS,
  GH_API_FIELDS,
  GH_FORBIDDEN,
  GH_PR_FORBIDDEN,
  GIT_FORBIDDEN,
  GIT_SETTING_SAMPLES,
  HTTP_HOSTS,
  HTTP_TOOLS,
  PACKAGE_MANAGERS,
  PUBLISH_WORDS,
  PUSH_FORBIDDEN,
  REMOTE_FORBIDDEN,
  VERIFIER_GH_FORBIDDEN,
  VERIFIER_GIT_FORBIDDEN,
  check,
  decide,
  guardArgs,
  isEntry,
  readCommands,
  rolloutNamePattern,
} from '../hooks/guard-bash.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { guardSelfTest } from '../lib/preflight.mjs'
import { guardCommand } from '../lib/settings.mjs'
import { makeRollout } from './fixtures.mjs'

const BRANCH = 'fix/thing'
const LIVE_X = { dir: '/Users/u/_Code/.rollouts/x', home: '/Users/u/.claude/skills/rollout', name: 'x' }
const REPO = { repo: 'o/r' }
const blocked = (command, role = 'worker') => check(command, role, BRANCH, REPO) !== null
const REAL_GUARD = fileURLToPath(new URL('../hooks/guard-bash.mjs', import.meta.url))
const MERGE_PAYLOAD = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 1 --admin' } })
const LS_PAYLOAD = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } })
const PRESERVE_ENV = { ...process.env, NODE_OPTIONS: '--preserve-symlinks-main' }

// The agent role passed to guardCommand and the guard role it runs as.
const HOOK_ROLES = { implement: 'worker', verify: 'verifier' }

function payload(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } })
}

// On macOS, spawnSync now and then never ends a large `input` pipe, so the
// payload goes in through a file. A killed run has status null, so a guard
// that hangs fails the test instead of stalling it.
function spawnGuard(file, args, input, options) {
  const path = join(mkdtempSync(join(tmpdir(), 'rollout-payload-')), 'payload.json')

  writeFileSync(path, input)

  const stdin = openSync(path, 'r')

  try {
    return spawnSync(file, args, { stdio: [stdin, 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000, ...options })
  } finally {
    closeSync(stdin)
  }
}

function runHook(manifest, role, input, { branch = '', ...options } = {}) {
  return spawnGuard('sh', ['-c', guardCommand(manifest, role, { branch })], input, options)
}

function runScript(role, input) {
  return spawnGuard('node', [REAL_GUARD, role], input, {})
}

function linkSkill() {
  const skill = join(mkdtempSync(join(tmpdir(), 'rollout-link-')), 'skill')

  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), skill)

  return skill
}

test('worker may push its own branch explicitly', () => {
  assert.ok(!blocked('git push -u origin fix/thing'))
  assert.ok(!blocked('git push --force-with-lease origin fix/thing'))
  assert.ok(!blocked('git push origin HEAD:fix/thing'))
  assert.ok(!blocked('git push origin HEAD:refs/heads/fix/thing'))
  assert.ok(!blocked('cd /tmp/wt && git -C /tmp/wt push -u origin fix/thing'))
})

test('worker may not push elsewhere, force or delete', () => {
  assert.ok(blocked('git push'))
  assert.ok(blocked('git push origin main'))
  assert.ok(blocked('git push origin HEAD:main'))
  assert.ok(blocked('git push origin HEAD'))
  assert.ok(blocked('git push --force origin fix/thing'))
  assert.ok(blocked('git push -f origin fix/thing'))
  assert.ok(blocked('git push origin +fix/thing'))
  assert.ok(blocked('git push origin :fix/thing'))
  assert.ok(blocked('git push --delete origin fix/thing'))
  assert.ok(blocked('git push --all origin'))
  assert.ok(blocked('pnpm build && git push origin main'))
  assert.ok(blocked('echo ok; git push origin other-branch'))
})

test('merging, publishing and repo admin are blocked for everyone', () => {
  for (const role of ['worker', 'verifier']) {
    assert.ok(blocked('gh pr merge 12 --squash --admin', role))
    assert.ok(blocked('gh pr review 12 --approve', role))
    assert.ok(blocked('gh repo edit --enable-auto-merge', role))
    assert.ok(blocked('gh release create v1', role))
    assert.ok(blocked('pnpm publish -r', role))
    assert.ok(blocked('pnpm release', role))
    assert.ok(blocked('npx changeset publish', role))
    assert.ok(blocked('pnpm changeset version', role))
    assert.ok(blocked('gh api -X PATCH repos/o/r -f allow_auto_merge=true', role))
    assert.ok(blocked('gh api repos/o/r/pulls/1/merge -f merge_method=squash', role))
    assert.ok(blocked('gh api -X PATCH repos/o/r/code-scanning/alerts/3 -f state=dismissed', role))
    assert.ok(blocked('gh api repos/o/r/code-scanning/alerts/3 -f state=dismissed', role))
  }
})

test('read-only gh api is allowed', () => {
  assert.ok(!blocked('gh api repos/o/r/commits/abc/check-runs'))
  assert.ok(!blocked('gh api -X GET repos/o/r/commits/abc/check-runs -f per_page=100'))
  assert.ok(!blocked('gh api repos/o/r/code-scanning/alerts/3'))
})

test('hooks cannot be bypassed', () => {
  assert.ok(blocked('git commit --no-verify -m "x"'))
  assert.ok(blocked('git commit -n -m "x"'))
  assert.ok(blocked('git -c core.hooksPath=/dev/null commit -m "x"'))
  assert.ok(blocked('git config core.hooksPath .hooks'))
  assert.ok(!blocked('git commit -m "fix: thing"'))
})

test('verifier is read-only', () => {
  assert.ok(blocked('git commit -m "x"', 'verifier'))
  assert.ok(blocked('git push -u origin fix/thing', 'verifier'))
  assert.ok(blocked('git checkout main', 'verifier'))
  assert.ok(blocked('git reset --hard HEAD~1', 'verifier'))
  assert.ok(blocked('gh pr comment 12 --body hi', 'verifier'))
  assert.ok(blocked('gh pr edit 12 --title x', 'verifier'))
  assert.ok(!blocked('git diff origin/main...HEAD', 'verifier'))
  assert.ok(!blocked('pnpm build && pnpm --filter react-jsdom test', 'verifier'))
  assert.ok(!blocked('gh pr view 12 --json title,body', 'verifier'))
})

test('the hook script exits 2 with a reason on stdin payloads, and pushes only to the --branch it was given', () => {
  const script = new URL('../hooks/guard-bash.mjs', import.meta.url).pathname
  const run = (command, args = [`--branch=${BRANCH}`]) =>
    spawnSync('node', [script, 'worker', ...args], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
    })

  const denied = run('gh pr merge 1 --admin')
  assert.equal(denied.status, 2)
  assert.match(denied.stderr, /rollout guard/)
  assert.equal(run('ls -la').status, 0)
  assert.equal(run(`git push -u origin ${BRANCH}`).status, 0)

  const unpinned = run(`git push -u origin ${BRANCH}`, [])

  assert.equal(unpinned.status, 2)
  assert.equal(unpinned.stderr, 'rollout guard: the guard has no --branch, so it refuses to push\n')
})

test('changeset release commands are blocked in every form, for everyone', () => {
  const forms = [
    'changeset version',
    'changeset pre enter next',
    'changeset tag',
    './node_modules/.bin/changeset publish',
    'node node_modules/@changesets/cli/bin.js version',
    'npx @changesets/cli version',
    'pnpm changeset -- version',
    'npx changeset --cwd . version',
    'pnpm dlx @changesets/cli@2.29.0 version',
    'node ./node_modules/@changesets/cli/bin.js pre exit',
    'npx changeset@latest version',
    'sh -c "changeset version"',
  ]

  for (const role of ['worker', 'verifier']) {
    for (const command of forms) {
      assert.ok(blocked(command, role), `${role}: ${command}`)
    }
  }
})

test('changeset add, status and .changeset files stay allowed', () => {
  const forms = [
    'changeset add',
    'changeset status',
    'npx changeset add --empty',
    'pnpm changeset status --since=origin/main',
    'git add .changeset/fix-thing.md',
    'cat .changeset/pre.json',
  ]

  for (const role of ['worker', 'verifier']) {
    for (const command of forms) {
      assert.ok(!blocked(command, role), `${role}: ${command}`)
    }
  }
})

test('the hook script fails closed on a payload it cannot read', () => {
  const script = new URL('../hooks/guard-bash.mjs', import.meta.url).pathname
  const inputs = ['', 'not json', 'null', '{}', '{"tool_input":{}}', '{"tool_input":{"command":42}}', '{"tool_input":{"command":["ls"]}}']

  for (const role of ['worker', 'verifier']) {
    for (const input of inputs) {
      const result = spawnSync('node', [script, role], { input, encoding: 'utf8' })

      assert.equal(result.status, 2, `${role}: ${JSON.stringify(input)}`)
      assert.match(result.stderr, /^rollout guard: /)
    }

    const allowed = spawnSync('node', [script, role], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }),
      encoding: 'utf8',
    })

    assert.equal(allowed.status, 0, role)
    assert.equal(allowed.stderr, '')
  }
})

test('the hook script still runs when reached through a symlink', () => {
  const script = join(linkSkill(), 'hooks', 'guard-bash.mjs')
  const variants = {
    plain: { args: [], env: process.env },
    '--preserve-symlinks-main': { args: ['--preserve-symlinks-main'], env: process.env },
    NODE_OPTIONS: { args: [], env: PRESERVE_ENV },
  }

  for (const [name, { args, env }] of Object.entries(variants)) {
    const refused = spawnSync('node', [...args, script, 'worker'], { input: MERGE_PAYLOAD, env, encoding: 'utf8' })

    assert.equal(refused.status, 2, `${name}: forbidden command`)
    assert.match(refused.stderr, /^rollout guard: /, `${name}: forbidden command`)

    const allowed = spawnSync('node', [...args, script, 'worker'], { input: LS_PAYLOAD, env, encoding: 'utf8' })

    assert.equal(allowed.status, 0, `${name}: ls -la`)
    assert.equal(allowed.stderr, '', `${name}: ls -la`)
  }
})

test('importing the guard runs nothing', () => {
  const skill = linkSkill()
  const linked = join(skill, 'hooks', 'guard-bash.mjs')

  for (const [where, path] of [
    ['real', REAL_GUARD],
    ['symlinked', linked],
  ]) {
    const code = `await import(${JSON.stringify(pathToFileURL(path).href)}); console.log('imported')`

    for (const [how, env] of [
      ['plain', process.env],
      ['NODE_OPTIONS', PRESERVE_ENV],
    ]) {
      const result = spawnSync('node', ['--input-type=module', '-e', code], { input: MERGE_PAYLOAD, env, encoding: 'utf8' })

      assert.equal(result.status, 0, `${where} path, ${how}: ${result.stderr}`)
      assert.equal(result.stdout, 'imported\n', `${where} path, ${how}`)
    }
  }

  const importer = join(skill, '..', 'importer.mjs')

  writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(linked).href)})\nconsole.log('imported')\n`)

  const result = spawnSync('node', ['--preserve-symlinks-main', importer], { input: MERGE_PAYLOAD, encoding: 'utf8' })

  assert.equal(result.status, 0, `importer: ${result.stderr}`)
  assert.equal(result.stdout, 'imported\n', 'importer')
})

test('isEntry resolves both paths and fails closed', () => {
  const skill = linkSkill()
  const linked = join(skill, 'hooks', 'guard-bash.mjs')
  const realUrl = new URL('../hooks/guard-bash.mjs', import.meta.url).href
  const linkedUrl = pathToFileURL(linked).href

  assert.equal(isEntry(REAL_GUARD, realUrl), true, 'real path, real URL')
  assert.equal(isEntry(linked, realUrl), true, 'plain run behind a symlink')
  assert.equal(isEntry(REAL_GUARD, linkedUrl), true, '--preserve-symlinks-main')
  assert.equal(isEntry(fileURLToPath(import.meta.url), realUrl), false, 'another file')
  assert.equal(isEntry(undefined, realUrl), false, 'no argv[1]')
  assert.equal(isEntry(join(skill, '..', 'missing.mjs'), realUrl), true, 'unresolvable path')
})

test('decide refuses when the check itself throws', () => {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } })
  const explode = () => {
    throw new Error('boom')
  }

  assert.match(decide(input, 'worker', {}, explode), /boom/)
  assert.equal(decide(input, 'worker', {}), null)
})

test('decide refuses even when the thrown value cannot be printed', () => {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } })
  const unprintable = [
    Object.create(null),
    {
      get message() {
        throw new Error('x')
      },
    },
    {
      toString() {
        throw new Error('x')
      },
    },
    { message: Object.create(null) },
  ]

  for (const value of unprintable) {
    const explode = () => {
      throw value
    }

    assert.match(decide(input, 'worker', {}, explode), /^the guard failed \(.+\), command refused$/)
  }
})

test('commit-msg hook accepts one line and rejects bodies and trailers', () => {
  const hook = new URL('../git-hooks/commit-msg', import.meta.url).pathname
  const dir = mkdtempSync(join(tmpdir(), 'rollout-msg-'))
  const attempt = (message) => {
    const file = join(dir, 'MSG')
    writeFileSync(file, message)

    return spawnSync('sh', [hook, file]).status
  }

  assert.equal(attempt('fix: thing\n'), 0)
  assert.equal(attempt('fix: thing\n# Please enter the commit message\n'), 0)
  assert.equal(attempt('fix: thing\n\nlonger body\n'), 1)
  assert.equal(attempt('fix: thing\n\nCo-Authored-By: x <y@z>\n'), 1)
  assert.equal(attempt(`fix: ${'x'.repeat(80)}\n`), 1)
})

test('pre-push hook lets only the branch named in the git-dir marker through', () => {
  const hooks = new URL('../git-hooks', import.meta.url).pathname
  const dir = mkdtempSync(join(tmpdir(), 'rollout-push-'))
  const sh = (command, env = {}) => spawnSync('sh', ['-c', command], { cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' })

  sh('git init -q --bare remote.git && git init -q work')
  sh(
    `cd work && git config core.hooksPath ${hooks} && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m "fix: one" && git remote add origin ../remote.git`,
  )

  assert.notEqual(sh(`cd work && git push -q origin HEAD:refs/heads/${BRANCH}`).status, 0, 'no marker, no push')

  writeFileSync(join(dir, 'work', '.git', 'rollout-branch'), BRANCH)
  assert.equal(sh(`cd work && git push -q origin HEAD:refs/heads/${BRANCH}`).status, 0)
  assert.notEqual(sh('cd work && git push -q origin HEAD:main').status, 0)
  assert.notEqual(sh('cd work && git push -q origin HEAD:main', { ROLLOUT_BRANCH: 'main' }).status, 0, 'env cannot widen the marker')
  assert.notEqual(sh(`cd work && git push -q origin HEAD:refs/heads/${BRANCH} HEAD:other`).status, 0)
  assert.notEqual(sh(`cd work && git push -q origin :${BRANCH}`).status, 0)
})

test('review bypasses: gh global flags, aliases, graphql, attached fields', () => {
  assert.ok(blocked('gh -R grzehub/describe-me pr merge 12 --squash --admin'))
  assert.ok(blocked('gh pr --repo grzehub/describe-me merge 12 --admin'))
  assert.ok(blocked('gh alias set m "pr merge"'))
  assert.ok(blocked('gh api -XPOST repos/o/r/merges'))
  assert.ok(blocked('gh api --method=PUT repos/o/r/pulls/1/merge'))
  assert.ok(blocked('gh api repos/o/r/pulls/1/merge -fmerge_method=squash'))
  assert.ok(blocked('gh api graphql -f query="mutation { mergePullRequest }"'))
  assert.ok(blocked('gh auth token'))
  assert.ok(blocked('curl -X PUT https://api.github.com/repos/o/r/pulls/1/merge'))
})

test('review bypasses: publish and version through flags and scripts', () => {
  assert.ok(blocked('pnpm -w release'))
  assert.ok(blocked('pnpm --filter describe-me publish --no-git-checks'))
  assert.ok(blocked('npm -w packages/core publish'))
  assert.ok(blocked('pnpm version-packages'))
  assert.ok(blocked('pnpm run version-packages'))
  assert.ok(blocked('npm version minor'))
  assert.ok(blocked('pnpm exec changeset version'))
  assert.ok(!blocked('pnpm install --frozen-lockfile'))
  assert.ok(!blocked('pnpm --filter react-jsdom test'))
  assert.ok(!blocked('pnpm build && pnpm lint && pnpm format:check'))
  assert.ok(!blocked('pnpm smoke --vitest 4.1.11 --vite 6.4.3'))
})

test('review bypasses: single &, second git in a segment, --no-verify push, config env', () => {
  assert.ok(blocked('git fetch -q origin & git push --no-verify origin HEAD:main'))
  assert.ok(blocked('git status && git fetch origin && git push origin HEAD:main'))
  assert.ok(blocked('git push --no-verify origin fix/thing'))
  assert.ok(blocked('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath git push origin fix/thing'))
  assert.ok(blocked('git config --worktree --remove-section core'))
  assert.ok(blocked('git update-ref refs/heads/main HEAD'))
  assert.ok(blocked('git -c core.hooksPath=/dev/null push origin fix/thing'))
})

test('review bypasses: the control plane and hook files are off limits', () => {
  assert.ok(blocked('node ~/.claude/skills/rollout/bin/rollout.mjs approve A6 --dir ~/_Code/.rollouts/x'))
  assert.ok(blocked('sed -i "" s/exit\\(2\\)/exit\\(0\\)/ /Users/u/.claude/skills/rollout/hooks/guard-bash.mjs'))
  assert.ok(check('echo \'{"cmd":"approve","id":"A6"}\' > /Users/u/_Code/.rollouts/x/inbox/1.json', 'worker', BRANCH, LIVE_X) !== null)
  assert.ok(blocked('chmod -x /Users/u/.claude/skills/rollout/git-hooks/pre-push'))
  assert.ok(!blocked('gh pr create --base main --head fix/thing --title "fix: thing" --label "rollout:x" --body-file /tmp/body.md'))
})

test('worktrees next to the live rollout dir stay usable, the dir itself does not', () => {
  const live = { dir: '/Users/u/_Code/.rollouts/demo', home: '/Users/u/.claude/skills/rollout', name: 'demo' }
  const wt = '/Users/u/_Code/.rollouts/demo.worktrees/A1'
  const ok = (command) => check(command, 'worker', BRANCH, live) === null

  assert.ok(ok(`cd ${wt} && node scripts/check-manifest.mjs ${wt}/examples/react-browser/.describe-me/manifest.json`))
  assert.ok(ok(`cat ${wt}/packages/core/src/recorder.ts`))
  assert.ok(!ok('cat /Users/u/_Code/.rollouts/demo/manifest.yaml'))
  assert.ok(!ok('ls /Users/u/_Code/.rollouts/demo/inbox'))
  assert.ok(!ok('echo x > ../../demo/inbox/1.json'))
  assert.ok(!ok('cat /Users/u/_Code/.rollouts/demo'))
})

test('dogfooding: agents working on the driver repo can use its own names', () => {
  const live = { dir: '/Users/u/.rollouts/dogfood-ui', home: '/Users/u/.claude/skills/rollout', name: 'dogfood-ui' }
  const ok = (command) => check(command, 'worker', BRANCH, live) === null

  assert.ok(ok('node bin/rollout.mjs status --dir test/fixtures/demo'))
  assert.ok(ok('git grep -n hooksPath lib/'))
  assert.ok(ok('cat lib/ledger.mjs && sed -n 1,40p git-hooks/pre-push'))
  assert.ok(ok('ls test/fixtures/demo/inbox && cat test/fixtures/demo/ledger.json'))
  assert.ok(ok('npm test && npm run format:check'))
  assert.ok(ok('sh -c "node --test test/guard.test.mjs"'))

  assert.ok(!ok('env -u ROLLOUT_ROLE node bin/rollout.mjs pause --dir test/fixtures/demo'))
  assert.ok(!ok('unset ROLLOUT_ROLE; node bin/rollout.mjs pause'))
  assert.ok(!ok('ROLLOUT_ROLE= node bin/rollout.mjs stop'))
  assert.ok(!ok('node /Users/u/.claude/skills/rollout/bin/rollout.mjs approve U1 --dir /Users/u/.rollouts/dogfood-ui'))
  assert.ok(!ok('node bin/rollout.mjs note U2 hi --dir ~/.rollouts/dogfood-ui'))
  assert.ok(!ok('git config --worktree core.hooksPath /dev/null'))
  assert.ok(!ok('git config --unset-all credential.helper'))
  assert.ok(!ok('git remote set-url --push origin git@github.com:o/r.git'))
  assert.ok(!ok('git -c "alias.p=push" p origin HEAD:main'))
})

test('second review: git global options, aliases, env overrides, escapes', () => {
  assert.ok(blocked('git --work-tree . push --no-verify origin HEAD:main'))
  assert.ok(blocked('git -c alias.p=push p origin HEAD:main'))
  assert.ok(blocked('ROLLOUT_BRANCH=main git push origin HEAD:main'))
  assert.ok(blocked('git --git-dir /x/.git push origin fix/thing:main'))
  assert.ok(blocked('git pu\\sh origin HEAD:main'))
  assert.ok(blocked('git p"u"sh origin HEAD:main'))
  assert.ok(blocked('echo main > .git/rollout-branch'))
  assert.ok(!blocked('git push -u origin fix/thing'))
})

test('agent identity: only origin, no remote or credential rewiring, no token output', () => {
  assert.ok(blocked('git push git@github.com:grzehub/describe-me.git fix/thing'))
  assert.ok(blocked('git push https://github.com/grzehub/describe-me.git fix/thing'))
  assert.ok(blocked('git remote set-url --push origin git@github.com:o/r.git'))
  assert.ok(blocked('git config --worktree --unset-all credential.helper'))
  assert.ok(blocked('GH_TOKEN= gh pr merge 1'))
  assert.ok(blocked('env GH_CONFIG_DIR=/Users/u/.config/gh gh pr list'))
  assert.ok(blocked('GIT_SSH_COMMAND="ssh -i x" git push origin fix/thing'))
  assert.ok(blocked('gh auth status --show-token'))
  assert.ok(!blocked('gh auth status'))
  assert.ok(!blocked('git push -u origin fix/thing'))
  assert.ok(!blocked('git fetch origin && git rebase origin/main'))
})

test('pre-push hook refuses URLs other than the push URL marker', () => {
  const hooks = new URL('../git-hooks', import.meta.url).pathname
  const dir = mkdtempSync(join(tmpdir(), 'rollout-url-'))
  const sh = (command) => spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8' })

  sh('git init -q --bare remote.git && git init -q --bare other.git && git init -q work')
  sh(
    `cd work && git config core.hooksPath ${hooks} && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m "fix: one" && git remote add origin ../remote.git`,
  )

  writeFileSync(join(dir, 'work', '.git', 'rollout-branch'), BRANCH)
  writeFileSync(join(dir, 'work', '.git', 'rollout-pushurl'), '../remote.git')

  assert.equal(sh(`cd work && git push -q origin HEAD:refs/heads/${BRANCH}`).status, 0)
  assert.notEqual(sh(`cd work && git push -q ../other.git HEAD:refs/heads/${BRANCH}`).status, 0)
})

test('one padded line is refused by the hook command and the bare script, in both roles', () => {
  const manifest = loadManifest(makeRollout())
  const input = payload('git '.repeat(50_000) + '; gh api -X PUT repos/o/r/pulls/1/merge')

  for (const [role, guardRole] of Object.entries(HOOK_ROLES)) {
    for (const [how, result] of [
      [`hook ${role}`, runHook(manifest, role, input)],
      [`script ${guardRole}`, runScript(guardRole, input)],
    ]) {
      assert.equal(result.status, 2, `${how}: ${result.stderr}`)
      assert.equal(result.signal, null, how)
      assert.match(result.stderr, /^rollout guard: .*16384/, how)
    }
  }
})

test('padding over many lines does not hide the command after it', () => {
  const manifest = loadManifest(makeRollout())
  const command = ('git '.repeat(1_000) + '\n').repeat(50) + 'gh api -X PUT repos/o/r/pulls/1/merge'

  for (const role of Object.keys(HOOK_ROLES)) {
    const result = runHook(manifest, role, payload(command))

    assert.equal(result.status, 2, `${role}: ${result.stderr}`)
    assert.match(result.stderr, /gh api is read-only/, role)
  }
})

test('a long run of spaces after unset is refused before the regex rules', () => {
  const manifest = loadManifest(makeRollout())
  const command = 'unset' + ' '.repeat(250_000) + 'x\n' + 'gh api -X PUT repos/o/r/pulls/1/merge'

  for (const role of Object.keys(HOOK_ROLES)) {
    const result = runHook(manifest, role, payload(command))

    assert.equal(result.status, 2, `${role}: ${result.stderr}`)
    assert.equal(result.signal, null, role)
    assert.match(result.stderr, /16384/, role)
  }
})

test('the line and command caps hold at the boundary', () => {
  const longestLine = 'ls' + ' '.repeat(16_382)
  const longestCommand = ('ls' + ' '.repeat(1_021) + '\n').repeat(256)

  assert.equal(longestLine.length, 16_384)
  assert.equal(longestCommand.length, 262_144)

  for (const role of Object.values(HOOK_ROLES)) {
    assert.equal(check(longestLine, role, BRANCH), null, role)
    assert.match(check(longestLine + ' ', role, BRANCH), /line of more than 16384 characters/, role)
    assert.equal(check(longestCommand, role, BRANCH), null, role)
    assert.match(check(longestCommand + ' ', role, BRANCH), /command of more than 262144 characters/, role)
  }
})

test('the arguments of a call run to the end of its segment', () => {
  assert.match(check('git commit -m "fix git" --no-verify', 'worker', BRANCH), /--no-verify/)
})

test('the hook command exits 2 when the guard cannot run', () => {
  const broken = {
    'a missing file': null,
    'a syntax error': 'export const = 1\n',
    'exit 1': 'process.exit(1)\n',
    SIGABRT: "process.kill(process.pid, 'SIGABRT')\n",
  }

  for (const [name, source] of Object.entries(broken)) {
    const manifest = loadManifest(makeRollout())

    manifest.home = mkdtempSync(join(tmpdir(), 'rollout-broken-'))

    if (source !== null) {
      mkdirSync(join(manifest.home, 'hooks'))
      writeFileSync(join(manifest.home, 'hooks', 'guard-bash.mjs'), source)
    }

    for (const role of Object.keys(HOOK_ROLES)) {
      const result = runHook(manifest, role, LS_PAYLOAD, { cwd: manifest.home })

      assert.equal(result.status, 2, `${name}, ${role}: ${result.stderr}`)
    }
  }

  // Node cannot load a path with a backslash (24 and 26 at least). A Node that can still refuses the merge.
  const manifest = loadManifest(makeRollout())

  manifest.home = join(mkdtempSync(join(tmpdir(), 'rollout-backslash-')), 'sk\\ill')
  mkdirSync(join(manifest.home, 'hooks'), { recursive: true })
  copyFileSync(REAL_GUARD, join(manifest.home, 'hooks', 'guard-bash.mjs'))

  for (const role of Object.keys(HOOK_ROLES)) {
    const result = runHook(manifest, role, MERGE_PAYLOAD, { cwd: manifest.home })

    assert.equal(result.status, 2, `backslash, ${role}: ${result.stderr}`)
  }
})

test('the preflight guard self-test passes with this checkout and fails without a guard', () => {
  const manifest = loadManifest(makeRollout())
  const working = guardSelfTest(manifest)

  assert.deepEqual(working.problems, [])
  assert.deepEqual(working.lines, [
    'ok   guard hook command exits 2 on a forbidden command',
    'ok   guard hook command exits 0 on an allowed command',
    'ok   guard hook command exits 2 on the rollout directory',
  ])

  manifest.home = mkdtempSync(join(tmpdir(), 'rollout-no-guard-'))

  const missing = guardSelfTest(manifest)

  assert.equal(missing.problems.length, 3, missing.problems.join('\n'))
  assert.ok(
    missing.lines.every((line) => line.startsWith('FAIL')),
    missing.lines.join('\n'),
  )
})

const ROLES = Object.values(HOOK_ROLES)

function assertRefused(forms, context = REPO) {
  for (const role of ROLES) {
    for (const command of forms) {
      assert.notEqual(check(command, role, BRANCH, context), null, `${role}: ${command}`)
    }
  }
}

function assertAllowed(forms, context = REPO) {
  for (const role of ROLES) {
    for (const command of forms) {
      assert.equal(check(command, role, BRANCH, context), null, `${role}: ${command}`)
    }
  }
}

test('agent env: dropping the token or the gh config is refused in every form, for both roles', () => {
  assertRefused([
    'GH_REPO=o/x gh pr list',
    'GH_HOST+=github.com gh api user',
    'GH_TOKEN+=x gh api user',
    'GITHUB_TOKEN+=x gh api user',
    'GH_CONFIG_DIR+=/tmp/gh gh api user',
    'ROLLOUT_ROLE+=x node bin/rollout.mjs pause',
    'GIT_DIR+=/tmp/x git push -u origin fix/thing',
    'unset GH_TOKEN',
    'unset -v GITHUB_TOKEN',
    'unset FOO GH_CONFIG_DIR',
    'unset GH_REPO',
    'unset "GH_TOKEN"',
    'un""set GH_TOK\\EN',
    'export -n GH_TOKEN',
    'export GH_REPO',
    'export GH_HOST',
    'export GH_REPO"="other/x',
    'export GH_HOST"+="github.com',
    'declare +x GH_TOKEN',
    'declare -n ref=GH_TOKEN',
    'typeset +x GH_TOKEN',
    'local GH_TOKEN',
    'readonly GH_CONFIG_DIR',
    'read GH_TOKEN < /dev/null',
    'read GH_TOKEN</dev/null',
    'read</dev/null GH_TOKEN',
    'read -aGH_TOKEN < /dev/null',
    'printf -v GH_TOKEN x',
    'printf -vGH_TOKEN x',
    'mapfile GH_TOKEN < /dev/null',
    'readarray GH_TOKEN < /dev/null',
    'set GH_TOKEN',
    'setenv GH_HOST github.com',
    'unsetenv GH_TOKEN',
    'csh -c "unsetenv GH_TOKEN"',
    'zsh -c "unset -m GH_TOK*"',
    'unset -m "GH_*"',
    'unset 2>/dev/null -m "GH_*"',
    'typeset -gm "GH_*"',
    'export +m "GH_*"',
    'local -m "ROLLOUT_*"',
    'readonly -m x',
    'declare -fm x',
    'export -n ROLLOUT_ROLE',
    'declare +x ROLLOUT_ROLE',
    'typeset +x ROLLOUT_ROLE',
    'read ROLLOUT_ROLE < /dev/null',
    'unset "ROLLOUT_ROLE"',
    'env -u GH_TOKEN gh api user',
    'env -uGH_TOKEN gh api user',
    'env -vu GH_TOKEN gh api user',
    'env -vuGH_TOKEN gh api user',
    'env --unset GH_TOKEN gh api user',
    'env --unset=GH_TOKEN gh api user',
    'env -u "GH_TOKEN" gh api user',
    "env -u 'GH_REPO' gh pr list",
    'env --unset="GH_CONFIG_DIR" gh api user',
    'env --unset "GITHUB_TOKEN" gh api user',
    'env -0 -u GH_HOST gh api user',
    'env -C /tmp -u GH_TOKEN gh api user',
    'env FOO=1 -u GH_TOKEN gh api user',
    'env >/dev/null -u GH_TOKEN gh api user',
    'env 2> /tmp/log -u GH_TOKEN gh api user',
    'env GH_REPO"="other/x gh pr list',
    '/usr/bin/env -u GH_TOKEN gh api user',
    'sh -c "env -u GH_TOKEN gh api user"',
    'env env -u GH_TOKEN gh api user',
    'env -u "ROLLOUT_ROLE" node bin/rollout.mjs pause',
    'env --unset=ROLLOUT_ROLE node bin/rollout.mjs pause',
    'env -vu ROLLOUT_ROLE node bin/rollout.mjs pause',
    'env -uROLLOUT_DIR node bin/rollout.mjs pause',
  ])

  assert.match(check('unset GH_TOKEN', 'worker', BRANCH, REPO), /^unset with GH_TOKEN is not allowed: /)
  assert.match(check('env -u GH_REPO gh pr list', 'worker', BRANCH, REPO), /^unsetting GH_REPO with env is not allowed: /)
  assert.match(check('read ROLLOUT_ROLE < /dev/null', 'worker', BRANCH, REPO), /keep the CLI from taking orders from agents$/)
})

test('agent env: env -i, env -S, unknown env options and exec -c are refused, for both roles', () => {
  assertRefused([
    'env -i PATH=/usr/bin gh api user',
    'env -i gh api user',
    'env -iv gh api user',
    'env - gh api user',
    'env -- - gh api user',
    'env -vi gh api user',
    'env -0i gh api user',
    'env --ignore-environment gh api user',
    'env -S "-u GH_TOKEN" gh api user',
    'env -vS "-i" gh api user',
    'env --split-string="-u GH_TOKEN" gh api user',
    'env --split-string "-i" gh api user',
    'env --ign gh api user',
    'env --uns=GH_TOKEN gh api user',
    'env --ch /tmp -u GH_TOKEN gh api user',
    'env --null=1 gh api user',
    'env -L x gh api user',
    'env -x gh api user',
    'env >/dev/null -i gh api user',
    'env</dev/null -i gh api user',
    '/usr/bin/env -i gh api user',
    'sh -c "env -i gh api user"',
    'nice env -i gh api user',
    'exec -c gh api user',
    'exec -a x -c gh api user',
    'exec -lc gh api user',
    'exec -cl gh api user',
    'exec 2>/dev/null -c gh api user',
    'exec</dev/null -c gh api user',
    'bash -c "exec -c gh api user"',
  ])

  assert.match(check('env -i gh api user', 'worker', BRANCH, REPO), /without the agents' GitHub token and gh config/)
  assert.match(check('env -S x', 'worker', BRANCH, REPO), /re-splits a string/)
  assert.match(check('env --ign gh api user', 'worker', BRANCH, REPO), /does not know/)
  assert.match(check('exec -c gh api user', 'worker', BRANCH, REPO), /empty environment/)
})

test('agent env: everyday export, unset, read, env and exec stay allowed', () => {
  assertAllowed([
    'export CI=1 && npm test',
    'export PATH="$PATH:/tmp/bin"',
    'export FOO=$GH_REPO',
    'export -p',
    'unset CI',
    'echo $GH_REPO',
    'read -r line < notes.txt',
    'set -euo pipefail',
    'set -m',
    'printf \'%s\\n\' "$GH_REPO"',
    'local -r count=1',
    'git log --grep "unset the cache"',
    'env',
    'env | grep GH_',
    'env FOO=1 npm test',
    'env LC_ALL=C grep -i x README.md',
    'env -u FOO npm test',
    'env -0',
    'env -C /tmp npm test',
    'env --chdir=/tmp npm test',
    'env --block-signal=INT npm test',
    'env -- FOO=1 npm test',
    '/usr/bin/env node x.mjs',
    'exec node x.mjs',
    'exec sh -c "npm test"',
    'exec -a name node x.mjs',
  ])
})

test('agent repo: --repo and -R name only the manifest repo, for both roles', () => {
  assertAllowed([
    'gh pr view 1 --repo o/r',
    'gh pr view 1 --repo github.com/o/r',
    'gh pr view 1 --repo GitHub.com/O/R',
    'gh pr view 1 --repo=o/r',
    'gh pr view 1 -R o/r',
    'gh pr view 1 -Ro/r',
    'gh pr view 1 -R=o/r',
    'gh -R o/r pr view 1',
    'gh pr list -dR o/r',
    'gh pr view 1 --repo "o/r"',
  ])

  assertRefused([
    'gh pr view 1 --repo other/x',
    'gh pr view 1 -R other/x',
    'gh -R other/x pr view 1',
    'gh --repo other/x pr view 1',
    'gh pr view 1 --repo=other/x',
    'gh pr view 1 -Rother/x',
    'gh pr view 1 -R=other/x',
    'gh pr list -dR other/x',
    'gh pr list -dRother/x',
    'gh pr view 1 --repo o/r-fork',
    'gh pr view 1 --repo o/x',
    'gh pr view 1 --repo other/r',
    'gh pr view 1 --repo ghe.example.com/o/r',
    'gh pr view 1 --repo https://github.com/o/r',
    'gh pr view 1 --repo o/r.git',
    'gh pr view 1 --repo "other/x"',
    'gh pr view 1 "--repo=other/x"',
    'gh pr view 1 --repo o/r --repo other/x',
    'gh gh gh -R other/x pr view 1',
    'gh search prs --repo other/x',
    'gh pr view 1 --repo',
    'gh pr view 1 --repo=',
    'gh pr view 1 -R',
    'gh pr view 1 -R=',
    'gh pr create --title t --body "grep -R x"',
  ])

  assert.match(check('gh pr create --title t --body "grep -R x"', 'worker', BRANCH, REPO), /--body-file/)
  assert.match(check('gh pr view 1 --repo', 'worker', BRANCH, REPO), /--repo has no value/)
  assert.match(check('gh -R other/x pr merge 1', 'worker', BRANCH, REPO), /merging, reviewing and closing PRs belongs to the driver/)
})

test('agent repo: gh api paths name only the manifest repo, for both roles', () => {
  assertAllowed([
    'gh api repos/o/r/pulls',
    'gh api /repos/O/R/commits/abc/check-runs',
    'gh api repos/{owner}/{repo}/pulls',
    'gh api "repos/{owner}/{repo}/pulls?per_page=1"',
    'gh api "repos/o/r/pulls?per_page=1"',
    'gh api repos/o/r',
    'gh api user',
    'gh pr view 1 repos/other/x',
  ])

  assertRefused([
    'gh api repos/other/x/pulls',
    'gh api /repos/other/x',
    'gh api repos/o/r-fork/pulls',
    'gh api "repos/other/x/commits?per_page=1"',
    'gh api repos/{owner}/other/pulls',
    'gh api repos/other/{repo}/pulls',
    'gh api "repos/{owner}"/other/pulls',
    'gh api repos/o/r/../../other/x/pulls',
    'gh api repos/{owner}/{repo}/../../other/x',
    'gh api repos/o/r/%2E%2E/x',
    'gh api repos/o/r/..%2fother',
    'gh api repos/o/r%2F..%2F..%2Fother/x',
    'gh api //repos/other/x',
    'gh api ./repos/other/x',
    'gh api REPOS/other/x',
    'gh api repos/:owner/other/pulls',
    'gh api repos/o',
    'gh api "repos/other/x/pulls"',
    'gh -R o/r api repos/other/x',
    'gh api --paginate repos/other/x/pulls --jq .[].number',
  ])

  assert.match(check('gh api repos/other/x/pulls', 'worker', BRANCH, REPO), /another repository than o\/r/)
  assert.match(check('gh api repos/o/r/%2E%2E/x', 'worker', BRANCH, REPO), /climb out/)
  assert.match(check('gh api repos/{owner}/other/pulls', 'worker', BRANCH, REPO), /only together as \{owner\}\/\{repo\}/)
  assert.match(check('gh api -X PUT repos/other/x/pulls/1/merge', 'worker', BRANCH, REPO), /gh api is read-only/)
})

test('agent repo: without --repo any named repo is refused', () => {
  for (const context of [{}, { repo: '' }]) {
    assertRefused(['gh pr view 1 --repo o/r', 'gh -R o/r pr view 1', 'gh api repos/o/r/pulls', 'gh api /repos/o/r'], context)
    assertAllowed(['gh pr view 12', 'gh api repos/{owner}/{repo}/pulls', 'gh api user'], context)
  }

  assert.match(check('gh pr view 1 --repo o/r', 'worker', BRANCH, {}), /^the guard has no --repo, so gh --repo o\/r is refused/)
  assert.match(check('gh api repos/o/r/pulls', 'worker', BRANCH, {}), /^the guard has no --repo, so gh api repos\/o\/r\/pulls is refused/)
})

test('agent repo: the hook command carries the manifest repository, and the bare script has none', () => {
  const manifest = loadManifest(makeRollout())

  assert.equal(manifest.repo.github, 'example/widgets')

  for (const [role, guardRole] of Object.entries(HOOK_ROLES)) {
    const own = runHook(manifest, role, payload('gh pr view 1 --repo example/widgets'))
    const other = runHook(manifest, role, payload('gh pr view 1 --repo other/x'))
    const bare = runScript(guardRole, payload('gh pr view 1 --repo example/widgets'))

    assert.equal(own.status, 0, `${role}: ${own.stderr}`)
    assert.equal(other.status, 2, `${role}: ${other.stderr}`)
    assert.match(other.stderr, /another repository than example\/widgets/, role)
    assert.equal(bare.status, 2, `${guardRole}: ${bare.stderr}`)
    assert.match(bare.stderr, /^rollout guard: the guard has no --repo/, guardRole)
  }
})

test('the hook command decides by its command line, whatever ROLLOUT_* the environment holds', () => {
  const manifest = loadManifest(makeRollout())
  const branch = manifest.all[0].branch
  const env = { ...process.env, ROLLOUT_REPO: 'other/x', ROLLOUT_BRANCH: 'main', ROLLOUT_DIR: '/tmp', ROLLOUT_NAME: 'x' }
  const decisions = [
    ['gh pr view 1 --repo example/widgets', 0],
    ['gh pr view 1 --repo other/x', 2, /another repository than example\/widgets/],
    [`git push -u origin ${branch}`, 0],
    ['git push origin main', 2, /^rollout guard: push only to your branch feat\/a1 \(got main\)/],
    [`cat ${join(manifest.dir, 'ledger.json')}`, 2, /control plane/],
    ['ls /tmp', 0],
  ]

  for (const [command, status, reason] of decisions) {
    const result = runHook(manifest, 'implement', payload(command), { branch, env })

    assert.equal(result.status, status, `${command}: ${result.stderr}`)

    if (reason) {
      assert.match(result.stderr, reason, command)
    }
  }
})

test('agent repo: padded lines are decided', () => {
  const manifest = loadManifest(makeRollout())
  const lines = {
    'repeated gh': ['gh '.repeat(5_000) + '--repo other/x pr view 1', /another repository than example\/widgets/],
    'repeated env -u': ['env -u '.repeat(2_000) + 'GH_TOKEN gh api user', /unsetting GH_TOKEN with env/],
  }

  for (const [name, [line, reason]] of Object.entries(lines)) {
    assert.ok(line.length > 13_000 && line.length < 16_384, `${name}: ${line.length}`)

    for (const role of Object.keys(HOOK_ROLES)) {
      const result = runHook(manifest, role, payload(line))

      assert.equal(result.status, 2, `${name}, ${role}: ${result.stderr}`)
      assert.equal(result.signal, null, `${name}, ${role}`)
      assert.doesNotMatch(result.stderr, /16384/, `${name}, ${role}`)
      assert.match(result.stderr, reason, `${name}, ${role}`)
    }
  }
})

test('rolloutNamePattern: refuses exactly the names check() refuses', () => {
  const create = (title) =>
    `gh pr create --base main --head docs/p1 --title "${title}" --label "rollout:my-lib-docs" --body-file /tmp/body.md`

  const push = (branch) => ({ command: `git push -u origin ${branch}`, branch, value: branch })
  const rows = [
    { ...push('docs/my-lib-docs'), refused: true },
    { ...push('my-lib-docs/p1'), refused: true },
    { ...push('feat/my-lib-docs/p1'), refused: true },
    { ...push('my-lib-docs-p1'), refused: false },
    { ...push('my-lib-docsy'), refused: false },
    { command: create('docs: my-lib-docs site'), value: 'docs: my-lib-docs site', refused: true },
    { command: create('docs: my-lib-docs-p1 site'), value: 'docs: my-lib-docs-p1 site', refused: false },
    { command: 'git rebase origin/my-lib-docs', value: 'my-lib-docs', refused: true },
    { command: 'git rebase origin/main', name: 'main', value: 'main', refused: true },
    { command: 'gh api repos/example/demo/pulls/1', name: 'demo', repo: 'example/demo', value: 'example/demo', refused: true },
    { command: 'gh api repos/demo/site/pulls/1', name: 'demo', repo: 'demo/site', value: 'demo/site', refused: true },
    {
      command: 'gh api repos/example/demo-site/pulls/1',
      name: 'demo',
      repo: 'example/demo-site',
      value: 'example/demo-site',
      refused: false,
    },
  ]

  for (const { command, value, refused, name = 'my-lib-docs', repo = 'o/r', branch = 'docs/p1' } of rows) {
    const expected = refused ? 'the rollout control plane, its hooks and git hook settings are off limits to agents' : null

    assert.equal(rolloutNamePattern(name).test(value), refused, `${name}: ${value}`)
    assert.equal(check(command, 'worker', branch, { name, repo }), expected, command)
  }
})

test('guardArgs: the role and the five context options, each attached with =', () => {
  const options = ['--dir=/home/u/.rollouts/demo', '--home=/home/u/skill', '--name=demo', '--repo=example/widgets', '--branch=feat/a1']

  assert.deepEqual(guardArgs(['worker', ...options]), {
    role: 'worker',
    context: { dir: '/home/u/.rollouts/demo', home: '/home/u/skill', name: 'demo', repo: 'example/widgets', branch: 'feat/a1' },
  })

  assert.deepEqual(guardArgs(['verifier', '--branch=', '--dir=-x']), { role: 'verifier', context: { branch: '', dir: '-x' } })
  assert.deepEqual(guardArgs(['--name=demo']), { role: 'worker', context: { name: 'demo' } }, 'no role')
  assert.deepEqual(guardArgs([]), { role: 'worker', context: {} })

  const unreadable = {
    'an unknown role': ['admin'],
    'a second role': ['worker', 'verifier'],
    'an unknown option': ['worker', '--force'],
    'a value that starts with -': ['worker', '--dir', '-x'],
    'an option without its value': ['worker', '--branch'],
  }

  for (const [name, argv] of Object.entries(unreadable)) {
    const parsed = guardArgs(argv)

    assert.match(
      parsed.problem,
      /^the guard (cannot read its hook command \(.+\)|takes one role, worker or verifier, not .+), command refused$/,
      name,
    )

    assert.equal(parsed.context, undefined, name)
  }
})

test('the hook script refuses every command when it cannot read its command line', () => {
  for (const args of [['admin'], ['worker', '--force'], ['worker', '--dir', '-x']]) {
    const result = spawnSync('node', [REAL_GUARD, ...args], { input: LS_PAYLOAD, encoding: 'utf8' })

    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.stderr, /^rollout guard: the guard (cannot read its hook command|takes one role)/, args.join(' '))
  }
})

test('readCommands: nested code is read as commands of its own, and the command around it stays whole', () => {
  const reads = {
    'gh pr $(echo merge) 12': ['echo merge', 'gh pr $ 12'],
    'gh pr `echo merge` 12': ['echo merge', 'gh pr $ 12'],
    'repos/x/$(git rev-parse HEAD)/y': ['git rev-parse HEAD', 'repos/x/$/y'],
    'git -C ${PWD} push origin main': ['git -C $ push origin main'],
    'echo "${arr[@]}" ${#x} ${!x} ${a[$i]}': ['echo "$" $ $ $'],
    'echo ${x:-a b}': ['a b', 'echo $'],
    "echo '${x:-' ; git push origin main ; echo '}'": ["'", 'git push origin main', "echo '", "echo '$'"],
    'echo $((1 + 2))': ['(…)', '1 + 2', 'echo $'],
    '(cd x && git push) | cat': ['cd x', 'git push', '(…)', 'cat'],
    '$(a (b) c) d': ['b', 'a (…) c', '$ d'],
    '$(a { b ) c': ['b', 'a {…}', '$ c'],
    'gh api repos/{owner}/{repo}/pulls': ['owner', 'repo', 'gh api repos/{…}/{…}/pulls'],
    'git -C {} -c x status': ['git -C {} -c x status'],
    'f() { echo hi; }': ['echo hi', 'f() {…}'],
    'gh pr (mer|zzz)ge 1': ['mer', 'zzz', 'gh pr (…)ge 1'],
    'a ) b } c': ['a', 'b', 'c'],
    'a $(b ; c': ['a $', 'b', 'c'],
    'a ( b': ['b', 'a (…)'],
  }

  for (const [command, commands] of Object.entries(reads)) {
    assert.deepEqual(readCommands(command).toSorted(), commands.toSorted(), command)
  }
})

// A rollout named demo right under a .rollouts root, as a live one sits.
function liveRollout() {
  return loadManifest(makeRollout({ dir: join(mkdtempSync(join(tmpdir(), 'rollout-')), '.rollouts', 'demo') }))
}

// How each rule's reason starts, so a command refused by another rule fails the test.
const RULES = {
  variable: /^a \$ROLLOUT_ variable is refused: the rollout control plane is off limits to agents in any spelling$/,
  ifs: /^\$IFS splits words that the guard reads as one, so it is refused\. /,
  brace:
    /^brace expansion such as \{a,b\} or \{1\.\.3\} builds words the guard cannot read, so it is refused\. A space after the comma is fine/,
  root: /^only a plain rollout name may follow the rollouts root, not a glob or an expansion: the rollout control plane is off limits/,
  controlPlane: /^the rollout control plane, its hooks and git hook settings are off limits to agents$/,
  setting: /^overriding git settings for hooks, credentials or remotes is not allowed$/,
  pushTarget: /^push only to your branch feat\/a1 \(got /,
  rawHttp: /^talk to GitHub through gh \(read-only gh api\), not raw HTTP/,
  merge: /^merging, reviewing and closing PRs belongs to the driver$/,
  commandWord: /^the command word .+ is built by shell expansion, so the guard cannot read it\. /,
  eval: /^the argument .+ of eval is built by shell expansion, so the guard cannot read it\. /,
  shellString: /^the command .+ of [a-z]+ -c is built by shell expansion, so the guard cannot read it\. /,
  git: /^the git .+ is built by shell expansion, so the guard cannot read it\. /,
  gh: /^the gh .+ is built by shell expansion, so the guard cannot read it\. /,
}

// The reasons that ask for the command to be written out.
const WRITTEN_OUT = [RULES.ifs, RULES.brace, RULES.commandWord, RULES.eval, RULES.shellString, RULES.git, RULES.gh]
const WRITE_IT_OUT = /\. Write the command out\. For quoted program text, use a script file or the Write tool$/

// Commands the guard allowed before it took its context from its command line
// and refused expansion, with the rule that refuses each now. Rows that hang
// on the push branch are for the worker only. They are data, never run.
const BYPASSES = [
  [`echo '{"cmd":"approve","id":"A1"}' > "$ROLLOUT_DIR/inbox/1.json"`, RULES.variable],
  ['cat $ROLLOUT_DIR/ledger.json', RULES.variable],
  ["sed -i '' 's/exit(2)/exit(0)/' $ROLLOUT_HOME/hooks/guard-bash.mjs", RULES.variable],
  ['cp x /home/u/.rollouts/*/inbox/', RULES.root],
  ['cp x ~/.rollouts/?/inbox/', RULES.root],
  ['git -c core.hooks""Path=/dev/null push origin feat/a1', RULES.setting],
  ['git${IFS}push${IFS}origin${IFS}main', RULES.ifs],
  ['GIT push origin main', RULES.pushTarget, ['implement']],
  ['CURL -X PUT https://API.GITHUB.COM/repos/o/r/pulls/1/merge', RULES.rawHttp],
  ['s=commit; git $s -m "fix: thing"', RULES.git],
  ['s=push; git $s origin main', RULES.git],
  ['gh pr $(echo merge) 12', RULES.gh],
  ['gh pr `echo merge` 12', RULES.gh],
  ['git {push,} origin main', RULES.brace],
  ["git $'push' origin main", RULES.git],
  ['gh api -X $m repos/{owner}/{repo}/pulls/1/merge', RULES.gh],
  ['git pu\\\nsh origin main', RULES.pushTarget, ['implement']],
  ['ROLLOUT_\\\nROLE= node bin/rollout.mjs stop', RULES.controlPlane],
  ['eval "$x"', RULES.eval],
  ['sh -c "$x"', RULES.shellString],
  ['$(echo git) push origin main', RULES.commandWord],
  ['while read -r line; do $line; done < cmds.txt', RULES.commandWord],
  ['x=core.hooksPath=/dev/null; git -C ${PWD} -c $x push origin main', RULES.git],
  ['k=core.hooksPath; git config $k /dev/null', RULES.git],
  ['f=-fbase=main; gh api repos/{owner}/{repo}/merges $f', RULES.gh],
  ['git push --$f origin feat/a1', RULES.git],
  ['=git push origin main', RULES.commandWord],
  ['/usr/bin/gi? push origin main', RULES.commandWord],
  ['/opt/homebrew/bin/g? pr merge 1', RULES.commandWord],
  ['cat ~/.rollouts/de""mo/ledger.json', RULES.controlPlane],
  ['cat ~/.rollouts/de\\mo/ledger.json', RULES.controlPlane],
  [`sed -i '' 's/exit(2)/exit(0)/' ~/.claude/skills/roll""out/hooks/guard-bash.mjs`, RULES.controlPlane],
  ['cat ~/.rollouts/(a|b)/ledger.json', RULES.root],
  ['n=x; cat ~/.rollouts/$n/ledger.json', RULES.root],
]

// Refused before, and still refused once the guard reads nested code.
const STILL_REFUSED = [
  ['git -C ${PWD} -c core.hooksPath=/dev/null push origin feat/a1', RULES.setting],
  ['git -C "$(pwd)" -c core.hooksPath=/dev/null push origin feat/a1', RULES.setting],
  ["echo '${x:-' ; git push origin main ; echo '}'", RULES.pushTarget, ['implement']],
  ['echo \\\\\n$x', RULES.commandWord],
  ['git push origin main', RULES.pushTarget, ['implement']],
  ['gh pr merge 1', RULES.merge],
]

test('the bypasses are refused by the hook command, each by its own rule', () => {
  const manifest = liveRollout()
  const branch = manifest.all[0].branch

  assert.equal(branch, 'feat/a1')

  for (const [command, rule, roles = Object.keys(HOOK_ROLES)] of [...BYPASSES, ...STILL_REFUSED]) {
    for (const role of roles) {
      const result = runHook(manifest, role, payload(command), { branch })
      const shown = `${role}: ${JSON.stringify(command)}: ${result.stderr}`

      assert.equal(result.status, 2, shown)
      assert.match(result.stderr, /^rollout guard: .+\n$/, shown)

      const reason = result.stderr.slice('rollout guard: '.length, -1)

      assert.match(reason, rule, shown)
      assert.equal(WRITE_IT_OUT.test(reason), WRITTEN_OUT.includes(rule), shown)
    }
  }
})

const GIT_CONFIG = /^changing git settings for hooks, credentials or remotes is not allowed$/

// Words the guard could split, drop or join unlike the shell: an empty word,
// a group, a quoted space, a brace sequence, a zsh glob group and a comment
// before a line continuation. Each must still meet its own rule.
const MISREADINGS = [
  ['git -C "" -c core.hooksPath=/dev/null push origin main', RULES.setting],
  ["git -C '' -c core.hooksPath=/dev/null push origin main", RULES.setting],
  ['git -C {} -c core.hooksPath=/dev/null push origin main', RULES.setting],
  ['git --namespace "" -c core.hooksPath=/dev/null push origin main', RULES.setting],
  ['git -C "" -c credential.helper= push origin main', RULES.setting],
  ['git -C "" -c remote.origin.pushurl=https://example.com/x.git push origin main', RULES.setting],
  ['git -C "" -c core.hooksPath=/dev/null commit -m x', RULES.setting],
  ['git -C "a b" -c core.hooksPath=/dev/null push origin feat/a1', RULES.setting],
  ['git -C a{b}c -c core.hooksPath=/dev/null push origin feat/a1', RULES.setting],
  ['git -C (x|y) -c core.hooksPath=/dev/null push origin feat/a1', RULES.setting],
  ["alias g='git -c core.hooksPath=/dev/null'", RULES.setting],
  ['git -C "" config --worktree core.hooksPath /dev/null', GIT_CONFIG],
  ['git -C "" push origin main', RULES.pushTarget, ['implement']],
  ['git -C {} push origin main', RULES.pushTarget, ['implement']],
  ['git -C (x|y) push origin main', RULES.pushTarget, ['implement']],
  ['git -C "a b" push origin main', RULES.pushTarget, ['implement']],
  ['git -C a\\ b push origin main', RULES.pushTarget, ['implement']],
  [`sh -c "git -C 'a b' push origin main"`, RULES.pushTarget, ['implement']],
  ['git -C "a b" config core.hooksPath /dev/null', GIT_CONFIG],
  ['git -C "a;b" config core.hooksPath /dev/null', /^a quote in the git option -C does not close in this command/],
  ['git -c user.name="A B" commit --no-verify -m x', /^git commit --no-verify is not allowed/],
  ['gh pr {m..m}erge 1', RULES.brace],
  ['git {p..p}ush origin main', RULES.brace],
  ['gh {r..r}epo delete o/r', RULES.brace],
  ['npm {p..p}ublish', RULES.brace],
  ['echo {1..9..2}', RULES.brace],
  ['gh pr {merge,x{}} 1', RULES.gh],
  ['gh pr (mer|zzz)ge 1', RULES.gh],
  ['/usr/bin/(g)it push origin main', RULES.commandWord],
  ['echo note # \\\n$(echo gh) pr merge 1', RULES.commandWord],
  ['echo note # \\\n/opt/homebrew/bin/g? pr merge 1', RULES.commandWord],
  ['echo note # \\\n$x', RULES.commandWord],
  ['/usr/bin/git(|) push origin main', RULES.commandWord],
  ['/usr/bin/gi(|)t push origin main', RULES.commandWord],
  ['/opt/homebrew/bin/gh(|) pr merge 1 --squash', RULES.commandWord],
  ['gh pr me(|)rge 1 --squash', RULES.gh],
  ['git pu(|)sh origin main', RULES.git],
  ['git com(|)mit -m x', RULES.git],
  ['git (|)config core.hooksPath /dev/null', RULES.git],
  ['git --namespace="a b" config core.hooksPath /dev/null', GIT_CONFIG],
  ['git --namespace="a;b" config core.hooksPath /dev/null', /^a quote in the git option --namespace="a does not close in this command/],
  ['git --exec-path="a b" push origin main', RULES.pushTarget, ['implement']],
  ['git --namespace=a\\ b push origin main', RULES.pushTarget, ['implement']],
  ['gh pr -b "x y" merge 1 --squash', RULES.merge],
  ['gh pr --body="x y" merge 1 --squash', RULES.merge],
  ['git config core.hooks?ath /dev/null', RULES.git],
  ['git config core.hooks(P)ath /dev/null', RULES.git],
  ['git push --mirr?r origin feat/a1', RULES.git],
  ['git -c core.hooks?ath=/dev/null push origin feat/a1', RULES.git],
  ['gh api repos/{owner}/{repo}/pulls/1/merge -X [P]UT', RULES.gh],
  ['gh api repos/{owner}/{repo}/pulls/1/merge [-]XPUT', RULES.gh],
  ["eval '/usr/bin/gi? push origin main'", /^the command .+ of eval is built by shell expansion/],
  ['2>&1 $(echo git) push origin main', RULES.commandWord],
  ['1>&2 /usr/bin/gi? push origin main', RULES.commandWord],
  ['>/dev/null 2>&1 $x', RULES.commandWord],
  ['<&- $x', RULES.commandWord],
  ['>| out $x', RULES.commandWord],
  ['&>log $x', RULES.commandWord],
  ['2>&1 =git status', RULES.commandWord],
  ['gh pr 2>&1 merge 1', RULES.merge],
  ['git 2>&1 push origin main', RULES.pushTarget, ['implement']],
  ['gh pr -b "x;y" merge 1 --squash', /^a quote in the gh option -b does not close in this command/],
  ['gh pr --body "x&y" merge 1 --squash', /^a quote in the gh option --body does not close in this command/],
  ['gh pr -A x merge 1 --squash', RULES.merge],
  ['gh pr --match-head-commit abc merge 1 --squash', RULES.merge],
  ['gh pr -A x $(echo merge) 1 --squash', RULES.gh],
  ['gh pr "" merge 1', RULES.merge],
  ['gh pr -R example/widgets edit 1 --title x', /^the verifier is read-only on GitHub$/, ['verify']],
  ['git --attr-source x config core.hooksPath /dev/null', GIT_CONFIG],
  ['git --attr-source x push origin main', RULES.pushTarget, ['implement']],
  ['s=push; git --attr-source x $s origin main', RULES.git],
  ['git --attr-source x commit -m x', /^the verifier is read-only and stays on the PR head: git commit/, ['verify']],
  ['git --frobnicate x push origin main', /^git --frobnicate is an option the guard does not know/],
  ['gh -X PUT api repos/{owner}/{repo}/pulls/1/merge', /^gh api is read-only for rollout agents/],
  ['s=release; npm --prefix . run $s', /^the npm run argument \$s is built by shell expansion/],
  ['npm --registry x version patch', /^npm version is not allowed/],
  ['npm --prefix "a;b" run $s', /^a quote in the npm option --prefix does not close in this command/],
]

test('misread words are refused by the hook command, each by its own rule', () => {
  const manifest = liveRollout()
  const branch = manifest.all[0].branch

  for (const [command, rule, roles = Object.keys(HOOK_ROLES)] of MISREADINGS) {
    for (const role of roles) {
      const result = runHook(manifest, role, payload(command), { branch })
      const shown = `${role}: ${JSON.stringify(command)}: ${result.stderr}`

      assert.equal(result.status, 2, shown)
      assert.match(result.stderr.slice('rollout guard: '.length, -1), rule, shown)
    }
  }
})

test('redirections, gh options and package manager options leave ordinary commands allowed', () => {
  const both = [
    'npm test 2>&1 | tail -20',
    'gh pr view 12 --json title 2>/dev/null',
    'echo "a > b" > out.txt',
    "cat <<'EOF' > notes.md\nhello\nEOF",
    'git --no-pager log -1 >/dev/null 2>&1',
    'gh pr --repo example/widgets view 12',
    'gh -R example/widgets pr view 12',
    'npx -y eslint "src/**"',
    'npm --prefix ./app test',
    'pnpm --filter pkg test',
    'npm view pkg version',
    'bunx --bun vite build',
  ]

  for (const role of ROLES) {
    for (const command of both) {
      assert.equal(check(command, role, 'feat/a1', LIVE_DEMO), null, `${role}: ${command}`)
    }
  }

  for (const command of ['git push -u origin feat/a1 2>&1', 'gh pr checks 12 --watch 2>&1 | tail -5', 'pnpm -w add -D typescript']) {
    assert.equal(check(command, 'worker', 'feat/a1', LIVE_DEMO), null, command)
  }
})

test('groups, empty words and a quoted # before a line continuation stay allowed', () => {
  const both = [
    '(cd sub && npm test) | tail -5',
    'f() { echo hi; }; f',
    '{ npm test; } 2>&1 | tail -5',
    `node -e "const fs = require('fs'); fs.readFileSync('x').toString()"`,
    `python3 -c "import json; print(json.dumps({'a': 1}))"`,
    "find . -name '*.md' -exec grep -l x {} +",
    'echo $(( (1 + 2) * 3 ))',
    'git log --oneline --grep "#12" \\\n  -5',
    'echo "a # b" \\\n  c',
    'git -C "/home/u/path with space" status',
    "git -C '/home/u/path with space' log --oneline",
    "gh api repos/{owner}/{repo}/pulls --jq '[.[] | .number]'",
    'gh api -X GET search/issues -f q="label:bug" --paginate',
    'eval "npm test"',
  ]

  for (const role of ROLES) {
    for (const command of both) {
      assert.equal(check(command, role, 'feat/a1', LIVE_DEMO), null, `${role}: ${command}`)
    }
  }

  for (const command of [
    'git commit -m ""',
    'git -c user.name="A B" commit -m "feat: x"',
    'git -c user.name="github-actions[bot]" commit -m "feat: x"',
    'gh pr create --title "fix #12" \\\n  --body-file /tmp/body.md',
  ]) {
    assert.equal(check(command, 'worker', 'feat/a1', LIVE_DEMO), null, command)
  }
})

const LIVE_DEMO = { dir: '/home/u/.rollouts/demo', home: '/home/u/.claude/skills/rollout', name: 'demo', repo: 'example/widgets' }

test('everyday commands with substitutions, braces and a heredoc stay allowed', () => {
  const both = [
    'gh pr checks 12 --watch',
    'grep -c foo file',
    'node -c x.js',
    'npm test',
    'sha=$(git rev-parse HEAD)',
    'git diff $(git merge-base origin/main HEAD)',
    'cd "$(git rev-parse --show-toplevel)" && npm test',
    'git -C "$PWD" status',
    'git -C ${PWD} status',
    'echo $((1 + 2))',
    `printf '%s\\n' "\${HOME}"`,
    'gh pr checks $(gh pr view --json number -q .number) --watch',
    'gh api repos/{owner}/{repo}/pulls',
    'gh api "repos/{owner}/{repo}/pulls?per_page=1"',
    'git log -1 HEAD@{1}',
    'for f in a b; do echo $f; done',
    '[ -f x ] && echo y',
    "awk '{print $1}' file",
    "sed -n '$p' file",
    "npx eslint 'src/**'",
    'ls ~/.rollouts/demo.worktrees/A1/*.md',
    'ls ~/.rollouts/',
    'bash -c "npm test"',
    'env FOO=1 npm test',
    'command -v git',
    'time -p npm test',
    "jq '{name: .name, id: .id}' x.json",
    'gh pr checks $n --watch',
  ]

  const worker = [
    'git commit -m "$msg"',
    'git commit $flags',
    'git push -u origin feat/a1',
    'git push --force-with-lease origin feat/a1',
    'git commit -m "feat: x"',
    'git commit -m "$(cat <<\'EOF\'\nfeat: x\nEOF\n)"',
  ]

  for (const role of ROLES) {
    for (const command of both) {
      assert.equal(check(command, role, 'feat/a1', LIVE_DEMO), null, `${role}: ${command}`)
    }
  }

  for (const command of worker) {
    assert.equal(check(command, 'worker', 'feat/a1', LIVE_DEMO), null, command)
  }
})

test('expansion hides no command behind a wrapper, a keyword or a shell option', () => {
  const forms = [
    ['time -p $x', RULES.commandWord],
    ['env FOO=1 $x', RULES.commandWord],
    ['command -p $x', RULES.commandWord],
    ['builtin $x', RULES.commandWord],
    ['nohup $x', RULES.commandWord],
    ['exec $x', RULES.commandWord],
    ['if $x; then echo y; fi', RULES.commandWord],
    ['! $x', RULES.commandWord],
    ['2>/dev/null $x', RULES.commandWord],
    ['FOO=1 BAR=2 "$x"', RULES.commandWord],
    ['\\git push origin feat/a1', RULES.commandWord],
    ['bin/*.sh', RULES.commandWord],
    ['bash -c -e "$x"', RULES.shellString],
    ['bash -co errexit "$x"', RULES.shellString],
    ['zsh -lc "$x"', RULES.shellString],
    ['sh -c -- "$x"', RULES.shellString],
    ['eval git "$x"', RULES.eval],
    ['git -c core.editor=$x status', RULES.git],
    ['git remote $action origin x', RULES.git],
    ['git remote -v $action origin x', RULES.git],
    ['gh $sub list', RULES.gh],
    ['gh api repos/o/r/pulls -X$m', RULES.gh],
    ['gh api repos/o/r/pulls --method=$m', RULES.gh],
  ]

  for (const [command, rule] of forms) {
    for (const role of ROLES) {
      assert.match(check(command, role, BRANCH, REPO), rule, `${role}: ${command}`)
    }
  }
})

test('tool names count in any case, subcommands only as written', () => {
  const forms = [
    ['GH pr merge 1', RULES.merge, ROLES],
    ['/USR/BIN/GIT push origin main', /^push only to your branch fix\/thing/, ['worker']],
    ['Git -c core.hooksPath=/dev/null status', RULES.setting, ROLES],
    ['NPM publish', /^`publish` belongs to the release PR/, ROLES],
    ['CHANGESET version', /^changeset version belongs to the release PR$/, ROLES],
    ['Curl https://api.github.com/repos/o/r', RULES.rawHttp, ROLES],
    ['ENV -i gh api user', /without the agents' GitHub token/, ROLES],
    ['GH pr create --title x', /^the verifier is read-only on GitHub$/, ['verifier']],
  ]

  for (const [command, rule, roles] of forms) {
    for (const role of roles) {
      assert.match(check(command, role, BRANCH, REPO), rule, `${role}: ${command}`)
    }
  }
})

test('the caps hold for lines joined by continuations and for commands that span lines', () => {
  const joined = 'ls' + ' '.repeat(10_000) + '\\\n' + ' '.repeat(10_000) + 'x'
  const spanning = ('echo ' + 'x'.repeat(10_000) + ' $(\n) ').repeat(2)

  assert.ok(joined.split('\n').every((line) => line.length <= 16_384))
  assert.ok(spanning.split('\n').every((line) => line.length <= 16_384))

  for (const role of ROLES) {
    assert.match(check(joined, role, BRANCH), /^a line of more than 16384 characters is too long for the guard/, role)
    assert.match(
      check(spanning, role, BRANCH),
      /^a command of more than 16384 characters between separators is too long for the guard/,
      role,
    )
  }
})

test('deeply nested and padded lines are decided by the hook command', () => {
  const manifest = liveRollout()
  const lines = [
    ['5,000 nested $(', '$('.repeat(5_000) + 'x' + ')'.repeat(5_000), 2],
    ['5,000 nested ${', '${'.repeat(5_000) + 'x' + '}'.repeat(5_000), 2],
    ['{ and 16,000 commas', '{' + ','.repeat(16_000), 0],
  ]

  for (const [name, line, status] of lines) {
    assert.ok(line.length <= 16_384, name)

    for (const role of Object.keys(HOOK_ROLES)) {
      const result = runHook(manifest, role, payload(line), { branch: manifest.all[0].branch })

      assert.equal(result.error, undefined, `${name}, ${role}`)
      assert.equal(result.signal, null, `${name}, ${role}`)
      assert.equal(result.status, status, `${name}, ${role}: ${result.stderr}`)

      if (status === 2) {
        assert.match(result.stderr.slice('rollout guard: '.length), RULES.commandWord, `${name}, ${role}`)
      }
    }
  }
})

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Each exported list is walked whole, so a member added later is tested here too.
function assertReason(command, roles, reason) {
  for (const role of roles) {
    assert.match(check(command, role, BRANCH, REPO), reason, `${role}: ${command}`)
  }
}

test('ALWAYS: every pattern refuses its sample, and the push markers are off limits, for both roles', () => {
  for (const { pattern, sample } of ALWAYS) {
    assert.match(sample, pattern)
    assertReason(sample, ROLES, RULES.controlPlane)
  }

  for (const marker of ['rollout-branch', 'rollout-pushurl', 'rollout-ready']) {
    assertReason(`echo x > .git/${marker}`, ROLES, RULES.controlPlane)
    assertReason(`rm ../.git/worktrees/A1/${marker}`, ROLES, RULES.controlPlane)
  }
})

test('GIT_SETTING_SAMPLES: a -c override or git config of each setting is refused, for both roles', () => {
  for (const setting of GIT_SETTING_SAMPLES) {
    for (const command of [
      `git -c ${setting}=x status`,
      `git -c${setting}=x status`,
      `git -c "${setting}=x" status`,
      `git -C /tmp -c ${setting}=x log`,
    ]) {
      assertReason(command, ROLES, RULES.setting)
    }

    assertReason(`git config ${setting} x`, ROLES, /^changing git settings for hooks, credentials or remotes is not allowed$/)
  }

  assertAllowed(['grep -c foo file', 'node -c x.js', 'git log --grep credential.helper'])
})

test('GIT_FORBIDDEN: each subcommand is refused, for both roles', () => {
  for (const sub of GIT_FORBIDDEN) {
    assertReason(`git ${sub} x`, ROLES, new RegExp(`^git ${escapeRegExp(sub)} is not allowed for rollout agents$`))
  }
})

test('REMOTE_FORBIDDEN: each git remote action is refused, before or after its options, for both roles', () => {
  for (const action of REMOTE_FORBIDDEN) {
    for (const command of [`git remote ${action} origin x`, `git remote -v ${action} origin x`]) {
      assertReason(command, ROLES, new RegExp(`^git remote ${escapeRegExp(action)} is not allowed: agents push to origin only$`))
    }
  }
})

test('CONFIG_SECTION_FLAGS: removing or renaming a config section is refused, for both roles', () => {
  for (const flag of CONFIG_SECTION_FLAGS) {
    assertReason(`git config ${flag} core`, ROLES, /^changing git settings for hooks, credentials or remotes is not allowed$/)
  }
})

test('BRANCH_FORBIDDEN: deleting or moving a branch, and git tag, are refused for the worker', () => {
  for (const flag of BRANCH_FORBIDDEN) {
    assertReason(`git branch ${flag} old`, ['worker'], new RegExp(`^git branch ${escapeRegExp(flag)} old is not allowed$`))
  }

  assertReason('git tag v1.0.0', ['worker'], /^git tag v1\.0\.0 is not allowed$/)
})

test('PUSH_FORBIDDEN: each push option is refused for the worker, --repo in every spelling', () => {
  for (const option of [...PUSH_FORBIDDEN, '--repo=origin']) {
    assertReason(`git push ${option} origin fix/thing`, ['worker'], new RegExp(`^git push ${escapeRegExp(option)} is not allowed`))
  }
})

test('VERIFIER_GIT_FORBIDDEN: each subcommand is refused for the verifier', () => {
  for (const sub of VERIFIER_GIT_FORBIDDEN) {
    // update-ref is refused for everyone first.
    const reason = GIT_FORBIDDEN.includes(sub)
      ? `^git ${escapeRegExp(sub)} is not allowed for rollout agents$`
      : `^the verifier is read-only and stays on the PR head: git ${escapeRegExp(sub)} is not allowed$`

    assertReason(`git ${sub}`, ['verifier'], new RegExp(reason))
  }
})

test('GH_FORBIDDEN: each gh command is refused, for both roles', () => {
  for (const sub of GH_FORBIDDEN) {
    assertReason(`gh ${sub} list`, ROLES, new RegExp(`^gh ${escapeRegExp(sub)} is not allowed for rollout agents$`))
  }
})

test('GH_PR_FORBIDDEN: each gh pr action is refused, for both roles', () => {
  for (const action of GH_PR_FORBIDDEN) {
    assertReason(`gh pr ${action} 12`, ROLES, RULES.merge)
  }
})

test('GH_API_FIELDS: gh api with a body is refused without a method, for both roles', () => {
  for (const field of GH_API_FIELDS) {
    assertReason(`gh api repos/o/r/issues ${field} title=x`, ROLES, /^gh api is read-only for rollout agents \(GET only\)$/)
  }
})

test('VERIFIER_GH_FORBIDDEN: each gh write is refused for the verifier, in any case of the tool', () => {
  for (const action of VERIFIER_GH_FORBIDDEN) {
    for (const tool of ['gh', 'GH']) {
      assertReason(`${tool} ${action} --title x`, ['verifier'], /^the verifier is read-only on GitHub$/)
    }
  }
})

test('PACKAGE_MANAGERS: each manager refuses releases, versions and expanded subcommands, for both roles', () => {
  for (const manager of PACKAGE_MANAGERS) {
    assertReason(`${manager} publish`, ROLES, /^`publish` belongs to the release PR and the maintainer, not to rollout agents$/)
    assertReason(`${manager} version`, ROLES, new RegExp(`^${manager} version is not allowed: versions are bumped by the release PR$`))
    assertReason(`${manager} $cmd`, ROLES, new RegExp(`^the ${manager} subcommand \\$cmd is built by shell expansion`))
    assertReason(`${manager} run $script`, ROLES, new RegExp(`^the ${manager} run argument \\$script is built by shell expansion`))
  }
})

test('PUBLISH_WORDS: each word is refused under a package manager, for both roles', () => {
  for (const word of PUBLISH_WORDS) {
    for (const command of [`npm ${word}`, `pnpm -w ${word}`]) {
      assertReason(command, ROLES, new RegExp(`^\`${escapeRegExp(word)}\` belongs to the release PR and the maintainer`))
    }
  }
})

test('CHANGESET_RELEASE: each release command is refused, for both roles', () => {
  for (const word of CHANGESET_RELEASE) {
    for (const command of [`changeset ${word}`, `npx @changesets/cli ${word}`, `Changeset ${word}`]) {
      assertReason(command, ROLES, new RegExp(`^changeset ${word} belongs to the release PR$`))
    }
  }

  assertReason('changeset $cmd', ROLES, /^the changeset argument \$cmd is built by shell expansion/)
})

test('HTTP_TOOLS: each tool is refused against GitHub, in any case, for both roles', () => {
  for (const tool of HTTP_TOOLS) {
    for (const name of [tool, tool.toUpperCase()]) {
      assertReason(`${name} https://api.github.com/repos/o/r`, ROLES, RULES.rawHttp)
    }
  }
})

test('HTTP_HOSTS: each host is refused to raw HTTP, in any case, for both roles', () => {
  for (const host of HTTP_HOSTS) {
    for (const name of [host, host.toUpperCase()]) {
      assertReason(`curl -X PUT https://${name}/x`, ROLES, RULES.rawHttp)
    }
  }
})
