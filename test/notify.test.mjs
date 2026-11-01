import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDriver } from '../lib/driver.mjs'
import { postCommand } from '../lib/ledger.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { createNotifier, notify, notifyCommand, sentences } from '../lib/notify.mjs'
import { readEvents } from '../lib/view.mjs'
import { makeRollout, waitFor } from './fixtures.mjs'

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

function notifyManifest(settings, overrides = {}) {
  return loadManifest(makeRollout({ policy: { notify: settings }, ...overrides }))
}

function lines(file) {
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : []
}

// The callback is the last argument, because the command target also passes options.
function runSpy() {
  const calls = []

  function run(command, args, ...rest) {
    calls.push({ command, args, callback: rest.at(-1) })
  }

  return { calls, run }
}

// Real execFile and fetch, counting the calls that settled.
function settling() {
  const counts = { run: 0, fetch: 0 }

  function run(command, args, options, callback) {
    return execFile(command, args, options, (...results) => {
      counts.run += 1
      callback(...results)
    })
  }

  function fetchFn(url, request) {
    return fetch(url, request).finally(() => {
      counts.fetch += 1
    })
  }

  return { counts, run, fetch: fetchFn }
}

async function listen(context, answer) {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''

    request.on('data', (chunk) => {
      body += chunk
    })

    request.on('end', () => {
      requests.push({ method: request.method, headers: request.headers, url: request.url, body })
      answer(response)
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => server.close())

  return { requests, url: `http://127.0.0.1:${server.address().port}` }
}

test('createNotifier: a command gets the title and the message as $1, $2 and two variables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-notify-'))
  const out = join(dir, 'out.txt')
  const command = `printf '%s\\n' "$1" "$2" "$ROLLOUT_NOTIFY_TITLE" "$ROLLOUT_NOTIFY_MESSAGE" >> '${out}'`
  const send = createNotifier(notifyManifest({ desktop: false, command }))

  send('rollout demo', 'A1: verified')

  await waitFor(() => lines(out).length >= 4, 'the command output')
  assert.deepEqual(lines(out), ['rollout demo', 'A1: verified', 'rollout demo', 'A1: verified'])
})

test('createNotifier: shell text in the message reaches $2 verbatim and never runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-notify-'))
  const out = join(dir, 'out.txt')
  const pwned = join(dir, 'pwned')
  const message = `A1: $(touch '${pwned}') and \`touch '${pwned}'\``
  const send = createNotifier(notifyManifest({ desktop: false, command: `printf '%s\\n' "$2" >> '${out}'` }))

  send('rollout demo', message)

  await waitFor(() => lines(out).length >= 1, 'the command output')
  assert.deepEqual(lines(out), [message])
  assert.equal(existsSync(pwned), false)
})

test('createNotifier: a webhook gets one JSON POST with rollout, title, message and at', async (context) => {
  const server = await listen(context, (response) => response.end('ok'))
  const send = createNotifier(notifyManifest({ desktop: false, webhook: `${server.url}/hook` }))

  send('rollout demo', 'A1: verified')

  await waitFor(() => server.requests.length >= 1, 'the webhook request')
  assert.equal(server.requests.length, 1)

  const [request] = server.requests
  const body = JSON.parse(request.body)

  assert.equal(request.method, 'POST')
  assert.equal(request.headers['content-type'], 'application/json')
  assert.deepEqual(Object.keys(body).sort(), ['at', 'message', 'rollout', 'title'])
  assert.equal(body.rollout, 'demo')
  assert.equal(body.title, 'rollout demo')
  assert.equal(body.message, 'A1: verified')
  assert.ok(Number.isFinite(Date.parse(body.at)))
})

test('createNotifier: a failing command and webhook are each logged once, with no token', async (context) => {
  const server = await listen(context, (response) => {
    response.statusCode = 500
    response.end('no')
  })

  const manifest = notifyManifest({ desktop: false, command: 'exit 3 # secret-token', webhook: `${server.url}/hook?token=secret-token` })
  const { counts, run, fetch: fetchFn } = settling()
  const logged = []
  const send = createNotifier(manifest, { run, fetch: fetchFn, log: (...call) => logged.push(call) })

  send('rollout demo', 'first')
  send('rollout demo', 'second')

  await waitFor(() => counts.run === 2 && counts.fetch === 2, 'four settled calls')
  await new Promise((resolve) => setImmediate(resolve))

  const sorted = [...logged].sort((left, right) => left[1].target.localeCompare(right[1].target))

  assert.deepEqual(sorted, [
    ['notify-failed', { target: 'command', error: 'exit 3' }],
    ['notify-failed', { target: 'webhook', error: 'HTTP 500' }],
  ])

  assert.equal(JSON.stringify(logged).includes('secret-token'), false)
})

test('createNotifier: desktop false runs no desktop notifier, and a failing one is logged once', () => {
  for (const platform of ['darwin', 'linux']) {
    const { calls, run } = runSpy()

    createNotifier(notifyManifest({ desktop: false }), { platform, run })('rollout demo', 'A1: verified')

    assert.deepEqual(calls, [], platform)
  }

  const { calls, run } = runSpy()
  const logged = []
  const send = createNotifier(notifyManifest({ desktop: true }), { platform: 'linux', run, log: (...call) => logged.push(call) })

  send('rollout demo', 'first')

  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'notify-send')

  send('rollout demo', 'second')

  for (const call of calls) {
    const error = Object.assign(new Error('spawn notify-send ENOENT'), { code: 'ENOENT' })

    call.callback(error, '', '')
  }

  assert.deepEqual(logged, [['notify-failed', { target: 'desktop', error: 'ENOENT' }]])
})

test('createNotifier: a NUL byte and a throwing log never throw, synchronously or from a callback', async () => {
  let logCalls = 0

  function log() {
    logCalls += 1
    throw new Error('disk full')
  }

  const quiet = console.error

  console.error = () => {}

  try {
    const nul = createNotifier(notifyManifest({ desktop: false, command: 'true' }), { log })

    assert.doesNotThrow(() => nul('rollout demo', 'A1: \u0000'))
    assert.equal(logCalls, 1)

    const failing = createNotifier(notifyManifest({ desktop: false, command: 'exit 3' }), { log })

    assert.doesNotThrow(() => failing('rollout demo', 'A1: verified'))
    await waitFor(() => logCalls === 2, 'the failing command logged')
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    console.error = quiet
  }
})

test('createNotifier: reads policy.notify at each notice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-notify-'))
  const first = join(dir, 'first.txt')
  const second = join(dir, 'second.txt')
  const manifest = notifyManifest({ desktop: false, command: `printf '%s\\n' "$2" >> '${first}'` })
  const send = createNotifier(manifest)

  send('rollout demo', 'one')
  await waitFor(() => lines(first).length >= 1, 'the first command')

  manifest.policy = { ...manifest.policy, notify: { ...manifest.policy.notify, command: `printf '%s\\n' "$2" >> '${second}'` } }
  send('rollout demo', 'two')
  await waitFor(() => lines(second).length >= 1, 'the second command')

  assert.deepEqual(lines(first), ['one'])
  assert.deepEqual(lines(second), ['two'])
})

test('createDriver: the default notifier follows policy.notify and logs notify-failed once to the ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rollout-notify-'))
  const out = join(dir, 'out.txt')
  const manifest = notifyManifest({ desktop: false, command: `echo "$2" >> '${out}'; exit 3` }, { events: [] })
  const driver = createDriver(manifest)

  postCommand(manifest, { cmd: 'approve', id: 'A1' })
  postCommand(manifest, { cmd: 'approve', id: 'A1' })
  driver.applyCommands()

  const failures = () => readEvents(manifest).filter((event) => event.kind === 'notify-failed')

  await waitFor(() => lines(out).length >= 2 && failures().length >= 1, 'two notices and a notify-failed event')
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(lines(out).length, 2)
  assert.ok(lines(out).every((line) => line.startsWith('A1: approval rejected: ')))
  assert.deepEqual(
    failures().map(({ id, target }) => ({ id, target })),
    [{ id: '-', target: 'command' }],
  )
})
