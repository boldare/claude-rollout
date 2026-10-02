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
