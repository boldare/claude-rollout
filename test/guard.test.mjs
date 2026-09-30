import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, decide } from '../hooks/guard-bash.mjs'

const BRANCH = 'fix/thing'
const LIVE_X = { dir: '/Users/u/_Code/.rollouts/x', home: '/Users/u/.claude/skills/rollout', name: 'x' }
const blocked = (command, role = 'worker') => check(command, role, BRANCH) !== null

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
  }
})

test('read-only gh api is allowed', () => {
  assert.ok(!blocked('gh api repos/o/r/commits/abc/check-runs'))
  assert.ok(!blocked('gh api -X GET repos/o/r/commits/abc/check-runs -f per_page=100'))
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
  const skill = join(mkdtempSync(join(tmpdir(), 'rollout-link-')), 'skill')

  symlinkSync(fileURLToPath(new URL('..', import.meta.url)), skill)

  const result = spawnSync('node', [join(skill, 'hooks', 'guard-bash.mjs'), 'worker'], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 1 --admin' } }),
    encoding: 'utf8',
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /^rollout guard: /)
})

test('decide refuses when the check itself throws', () => {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } })
  const explode = () => {
    throw new Error('boom')
  }

  assert.match(decide(payload, 'worker', {}, explode), /boom/)
  assert.equal(decide(payload, 'worker', {}), null)
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
