import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifest } from '../lib/manifest.mjs'
import { mirrorPath, worktreePath } from '../lib/worktree.mjs'
import { makeRollout } from './fixtures.mjs'

const BIN = fileURLToPath(new URL('../bin/rollout.mjs', import.meta.url))

function cleanEnv() {
  const env = { ...process.env }

  delete env.ROLLOUT_ROLE
  delete env.ROLLOUT_ROOT
  delete env.ROLLOUT_DIR

  return env
}

function clean(manifest) {
  return spawnSync(process.execPath, [BIN, 'clean', '--dir', manifest.dir], { encoding: 'utf8', env: cleanEnv(), timeout: 20_000 })
}

// A rollout with a mirror in its worktree root. The mirror holds a file, like a real one holds objects.
function rolloutWithMirror(context, { lock }) {
  const dir = makeRollout({ lock })
  const manifest = loadManifest(dir)

  context.after(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(manifest.wtRoot, { recursive: true, force: true })
  })

  mkdirSync(join(mirrorPath(manifest), 'objects'), { recursive: true })
  writeFileSync(join(mirrorPath(manifest), 'HEAD'), 'ref: refs/heads/main\n')

  return manifest
}

test('clean: with no driver it removes the mirror and the empty worktree root, and prints both paths', (context) => {
  const manifest = rolloutWithMirror(context, { lock: false })
  const result = clean(manifest)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `removed ${mirrorPath(manifest)}\nremoved ${manifest.wtRoot}\n`)
  assert.equal(existsSync(manifest.wtRoot), false)
  assert.equal(existsSync(join(manifest.dir, 'manifest.yaml')), true)
  assert.equal(existsSync(join(manifest.dir, 'ledger.json')), true)
})

test('clean: a second run prints nothing to remove and exits 0', (context) => {
  const manifest = rolloutWithMirror(context, { lock: false })

  assert.equal(clean(manifest).status, 0)

  const again = clean(manifest)

  assert.equal(again.status, 0, again.stderr)
  assert.equal(again.stdout, 'nothing to remove\n')
})

test('clean: a PR clone and other files in the worktree root survive, and only the mirror goes', (context) => {
  const manifest = rolloutWithMirror(context, { lock: false })
  const clone = worktreePath(manifest, { id: 'A1' })
  const note = join(manifest.wtRoot, 'notes.txt')

  mkdirSync(clone)
  writeFileSync(join(clone, 'work.txt'), 'unpushed\n')
  writeFileSync(note, 'mine\n')

  const result = clean(manifest)

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `removed ${mirrorPath(manifest)}\n`)
  assert.equal(readFileSync(join(clone, 'work.txt'), 'utf8'), 'unpushed\n')
  assert.equal(readFileSync(note, 'utf8'), 'mine\n')
})

test('clean: with a live driver lock it says so, exits 1 and removes nothing', (context) => {
  const manifest = rolloutWithMirror(context, { lock: true })
  const result = clean(manifest)

  assert.equal(result.status, 1)
  assert.match(result.stderr, /a driver is running/)
  assert.equal(result.stdout, '')
  assert.equal(existsSync(join(mirrorPath(manifest), 'HEAD')), true)
})
