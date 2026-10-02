import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notify, notifyCommand, sentences } from '../lib/notify.mjs'

function spy() {
  const calls = []

  function run(command, args, callback) {
    calls.push({ command, args, callback })
  }

  return { calls, run }
}

test('notifyCommand: osascript on macOS', () => {
  assert.deepEqual(notifyCommand('rollout', 'A1 "verified"', 'darwin'), {
    command: 'osascript',
    args: ['-e', 'display notification "A1 \\"verified\\"" with title "rollout"'],
  })
})

test('notifyCommand: notify-send on Linux, nothing elsewhere', () => {
  assert.deepEqual(notifyCommand('rollout', 'A1 verified', 'linux'), { command: 'notify-send', args: ['rollout', 'A1 verified'] })
  assert.equal(notifyCommand('rollout', 'A1 verified', 'win32'), null)
})

test('notify: runs notify-send once on Linux and ignores its result', () => {
  const { calls, run } = spy()

  notify('rollout', 'A1 verified', { platform: 'linux', run })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'notify-send')
  assert.deepEqual(calls[0].args, ['rollout', 'A1 verified'])
  assert.doesNotThrow(() => calls[0].callback(new Error('spawn notify-send ENOENT')))
})

test('notify: runs nothing on an unsupported platform', () => {
  const { calls, run } = spy()

  notify('rollout', 'A1 verified', { platform: 'win32', run })

  assert.deepEqual(calls, [])
})

test('sentences: a part that already ends a sentence gets no second mark', () => {
  assert.equal(sentences('a: Keep it as an alias.', 'Next'), 'a: Keep it as an alias. Next')
  assert.equal(sentences('a: Keep it as an alias', 'Next'), 'a: Keep it as an alias. Next')
  assert.equal(sentences('Keep the old flag?', 'Reason: silent.', 'Next'), 'Keep the old flag? Reason: silent. Next')
  assert.equal(sentences('Use "the alias."', '(see the plan!)', 'Next'), 'Use "the alias." (see the plan!) Next')
})

test('sentences: trailing punctuation that ends no sentence becomes a period', () => {
  assert.equal(sentences('Do this:', 'Next'), 'Do this. Next')
})

test('sentences: parts are trimmed, empty ones dropped, and the last one kept as it is', () => {
  assert.equal(sentences('  x  ', '', '   ', 'Next'), 'x. Next')
  assert.equal(sentences('First', 'Last.'), 'First. Last.')
})
