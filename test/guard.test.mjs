import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { check, decide, isEntry } from '../hooks/guard-bash.mjs'
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

function runHook(manifest, role, input, options = {}) {
  return spawnGuard('sh', ['-c', guardCommand(manifest, role)], input, options)
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

test('the hook script exits 2 with a reason on stdin payloads', () => {
  const script = new URL('../hooks/guard-bash.mjs', import.meta.url).pathname
  const run = (command) =>
    spawnSync('node', [script, 'worker'], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      env: { ...process.env, ROLLOUT_BRANCH: BRANCH },
      encoding: 'utf8',
    })

  const denied = run('gh pr merge 1 --admin')
  assert.equal(denied.status, 2)
  assert.match(denied.stderr, /rollout guard/)
  assert.equal(run('ls -la').status, 0)
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
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } })
  const explode = () => {
    throw new Error('boom')
  }

  assert.match(decide(payload, 'worker', {}, explode), /boom/)
  assert.equal(decide(payload, 'worker', {}), null)
})

test('decide refuses even when the thrown value cannot be printed', () => {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } })
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

    assert.match(decide(payload, 'worker', {}, explode), /^the guard failed \(.+\), command refused$/)
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

  // Node 20 and 22 cannot load a path with a backslash. A Node that can still refuses the merge.
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
  ])

  manifest.home = mkdtempSync(join(tmpdir(), 'rollout-no-guard-'))

  const missing = guardSelfTest(manifest)

  assert.equal(missing.problems.length, 2, missing.problems.join('\n'))
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

// The test process may itself run inside an agent, so its ROLLOUT_* never reach the hook.
function hookEnv(extra = {}) {
  const env = { ...process.env }

  for (const name of Object.keys(env)) {
    if (name.startsWith('ROLLOUT_')) {
      delete env[name]
    }
  }

  return { ...env, ...extra }
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
  assert.match(check('read ROLLOUT_ROLE < /dev/null', 'worker', BRANCH, REPO), /the guard's context/)
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

test('agent repo: without ROLLOUT_REPO any named repo is refused', () => {
  for (const context of [{}, { repo: '' }]) {
    assertRefused(['gh pr view 1 --repo o/r', 'gh -R o/r pr view 1', 'gh api repos/o/r/pulls', 'gh api /repos/o/r'], context)
    assertAllowed(['gh pr view 12', 'gh api repos/{owner}/{repo}/pulls', 'gh api user'], context)
  }

  assert.match(check('gh pr view 1 --repo o/r', 'worker', BRANCH, {}), /^ROLLOUT_REPO is not set/)
  assert.match(check('gh api repos/o/r/pulls', 'worker', BRANCH, {}), /^ROLLOUT_REPO is not set/)
})

test('agent repo: the hook command reads ROLLOUT_REPO from its environment', () => {
  const manifest = loadManifest(makeRollout())
  const pinned = hookEnv({ ROLLOUT_REPO: 'o/r' })
  const unpinned = hookEnv()

  assert.equal(unpinned.ROLLOUT_REPO, undefined)

  for (const role of Object.keys(HOOK_ROLES)) {
    const own = runHook(manifest, role, payload('gh pr view 1 --repo o/r'), { env: pinned })
    const other = runHook(manifest, role, payload('gh pr view 1 --repo other/x'), { env: pinned })
    const unset = runHook(manifest, role, payload('gh pr view 1 --repo o/r'), { env: unpinned })

    assert.equal(own.status, 0, `${role}: ${own.stderr}`)
    assert.equal(other.status, 2, `${role}: ${other.stderr}`)
    assert.match(other.stderr, /another repository than o\/r/, role)
    assert.equal(unset.status, 2, `${role}: ${unset.stderr}`)
    assert.match(unset.stderr, /ROLLOUT_REPO is not set/, role)
  }
})

test('agent repo: padded lines are decided', () => {
  const manifest = loadManifest(makeRollout())
  const env = hookEnv({ ROLLOUT_REPO: 'o/r' })
  const lines = {
    'repeated gh': ['gh '.repeat(5_000) + '--repo other/x pr view 1', /another repository than o\/r/],
    'repeated env -u': ['env -u '.repeat(2_000) + 'GH_TOKEN gh api user', /unsetting GH_TOKEN with env/],
  }

  for (const [name, [line, reason]] of Object.entries(lines)) {
    assert.ok(line.length > 13_000 && line.length < 16_384, `${name}: ${line.length}`)

    for (const role of Object.keys(HOOK_ROLES)) {
      const result = runHook(manifest, role, payload(line), { env })

      assert.equal(result.status, 2, `${name}, ${role}: ${result.stderr}`)
      assert.equal(result.signal, null, `${name}, ${role}`)
      assert.doesNotMatch(result.stderr, /16384/, `${name}, ${role}`)
      assert.match(result.stderr, reason, `${name}, ${role}`)
    }
  }
})
