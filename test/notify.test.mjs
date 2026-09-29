import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notify, notifyCommand } from '../lib/notify.mjs'

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
