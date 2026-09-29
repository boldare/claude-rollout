import { execFile } from 'node:child_process'

// A desktop notification on macOS and Linux, none elsewhere. Failures are
// ignored (headless machines, CI, no notify-send installed).
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

export function notify(title, message, { platform = process.platform, run = execFile } = {}) {
  const notifier = notifyCommand(title, message, platform)

  if (!notifier) {
    return
  }

  run(notifier.command, notifier.args, () => {})
}
