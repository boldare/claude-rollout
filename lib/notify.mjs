import { execFile } from 'node:child_process'

// A macOS notification; failures are ignored (headless machines, CI).
export function notify(title, message) {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`

  execFile('osascript', ['-e', script], () => {})
}
