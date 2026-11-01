import { execFile } from 'node:child_process'
import { makeEnv } from './sh.mjs'

// A desktop notification on macOS and Linux, none elsewhere. A failure goes
// to onError, which ignores it by default (headless machines, CI, no
// notify-send installed).
export function notifyCommand(title, message, platform = process.platform) {
  if (platform === 'darwin') {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`

    return { command: 'osascript', args: ['-e', script] }
  }

  if (platform === 'linux') {
    return { command: 'notify-send', args: [title, message] }
  }

  return null
}

export function notify(title, message, { platform = process.platform, run = execFile, onError = () => {} } = {}) {
  const notifier = notifyCommand(title, message, platform)

  if (!notifier) {
    return
  }

  run(notifier.command, notifier.args, (error, _stdout, stderr) => {
    if (error) {
      onError(error, stderr)
    }
  })
}

const TIMEOUT_MS = 10_000
const ERROR_LENGTH = 300

// Never error.message: execFile repeats the whole command line there, and a
// command can hold a token.
function processError(error, stderr) {
  let text = String(error?.code ?? error?.name ?? 'failed')

  if (error?.killed) {
    text = `timed out after ${TIMEOUT_MS / 1000} s`
  } else if (error?.code === null && error.signal) {
    text = `signal ${error.signal}`
  } else if (typeof error?.code === 'number') {
    text = `exit ${error.code}`
  }

  const firstLine = String(stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')

  return firstLine ? `${text}: ${firstLine}` : text
}

// Never the URL, which can hold a token. Some fetch errors quote it.
function webhookError(error, url) {
  if (error?.name === 'TimeoutError') {
    return `timed out after ${TIMEOUT_MS / 1000} s`
  }

  return String(error?.cause?.message ?? error?.message ?? error).replaceAll(url, '<webhook>')
}

// Sends each notice to every target policy.notify turns on, without waiting.
// policy.notify is read on each call, so an edit applies to the next notice.
// A failing target is logged once for the life of the notifier.
export function createNotifier(
  manifest,
  { platform = process.platform, run = execFile, fetch: fetchFn = globalThis.fetch, log = () => {} } = {},
) {
  const failed = new Set()

  function fail(target, error) {
    if (failed.has(target)) {
      return
    }

    failed.add(target)

    // The log writes the ledger, and a full disk must not crash the driver.
    try {
      log('notify-failed', { target, error: error.slice(0, ERROR_LENGTH) })
    } catch (logError) {
      console.error(`rollout: could not log notify-failed for ${target}: ${logError?.message ?? logError}`)
    }
  }

  function desktop(title, message) {
    notify(title, message, { platform, run, onError: (error, stderr) => fail('desktop', processError(error, stderr)) })
  }

  // The title and the message are arguments, never part of the command
  // string, because they can hold agents' text.
  function command(title, message) {
    const options = {
      cwd: manifest.dir,
      env: makeEnv(manifest, { ROLLOUT_NOTIFY_TITLE: title, ROLLOUT_NOTIFY_MESSAGE: message }),
      timeout: TIMEOUT_MS,
    }

    run('sh', ['-c', manifest.policy.notify.command, 'rollout-notify', title, message], options, (error, _stdout, stderr) => {
      if (error) {
        fail('command', processError(error, stderr))
      }
    })
  }

  function webhook(title, message) {
    const url = manifest.policy.notify.webhook
    const body = JSON.stringify({ rollout: manifest.rollout, title, message, at: new Date().toISOString() })
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }

    fetchFn(url, request)
      .then((response) => {
        response.body?.cancel().catch(() => {})

        if (!response.ok) {
          fail('webhook', `HTTP ${response.status}`)
        }
      })
      .catch((error) => fail('webhook', webhookError(error, url)))
  }

  // A synchronous throw, such as execFile's on a NUL byte, is that target's
  // failure and never skips the others.
  function attempt(target, send, describe, title, message) {
    try {
      send(title, message)
    } catch (error) {
      fail(target, describe(error))
    }
  }

  return (title, message) => {
    const settings = manifest.policy.notify

    if (settings.desktop) {
      attempt('desktop', desktop, processError, title, message)
    }

    if (typeof settings.command === 'string') {
      attempt('command', command, processError, title, message)
    }

    if (typeof settings.webhook === 'string') {
      attempt('webhook', webhook, (error) => webhookError(error, settings.webhook), title, message)
    }
  }
}

const SENTENCE_END = /[.?!…]["'”’)\]]*$/

// Agents' text may already end a sentence, so a part gets a period only when it has no mark of its own.
export function sentences(...parts) {
  const kept = parts.map((part) => part.trim()).filter((part) => part !== '')

  return kept
    .map((part, index) => {
      if (index === kept.length - 1) {
        return part
      }

      const bare = part.replace(/[\s,;:]+$/, '')

      return SENTENCE_END.test(bare) ? bare : `${bare}.`
    })
    .join(' ')
}
