import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAddedLines, parseCommits, parseNameStatus } from '../lib/github.mjs'

test('name-status with renames and deletions', () => {
  const files = parseNameStatus('M\tREADME.md\nA\t.changeset/a.md\nD\tpackages/core/src/quick-hash.ts\nR087\told/x.ts\tnew/x.ts\n')
  assert.deepEqual(files, [
    { status: 'modified', path: 'README.md' },
    { status: 'added', path: '.changeset/a.md' },
    { status: 'removed', path: 'packages/core/src/quick-hash.ts' },
    { status: 'renamed', path: 'new/x.ts', previousPath: 'old/x.ts' },
  ])
})

test('added lines keep their file and skip headers and deletions', () => {
  const diff = [
    'diff --git a/package.json b/package.json',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -3 +3 @@',
    '-  "version": "0.4.0",',
    '+  "version": "0.5.0",',
    'diff --git a/gone.txt b/gone.txt',
    '--- a/gone.txt',
    '+++ /dev/null',
    '-bye',
  ].join('\n')

  assert.deepEqual(parseAddedLines(diff), [{ path: 'package.json', text: '  "version": "0.5.0",' }])
})

test('commits split on record separators and keep bodies', () => {
  const out = 'aaa\x1ffix: one\n\x1e\nbbb\x1ffix: two\n\nbody line\n\x1e\n'
  assert.deepEqual(parseCommits(out), [
    { sha: 'aaa', message: 'fix: one' },
    { sha: 'bbb', message: 'fix: two\n\nbody line' },
  ])
})
