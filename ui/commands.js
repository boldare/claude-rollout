import { sentence, serverAnswered } from './format.js'

const BODIES = {
  'hold-all': () => ({ cmd: 'hold', all: true }),
  'release-all': () => ({ cmd: 'release', all: true }),
  hold: (pr) => ({ cmd: 'hold', ids: [pr.id] }),
  release: (pr) => ({ cmd: 'release', ids: [pr.id] }),
  retry: (pr) => ({ cmd: 'retry', id: pr.id }),
}

export function rolloutControls(view, readOnly) {
  if (readOnly) {
    return []
  }

  if (!view) {
    return ['start']
  }

  const { driver } = view

  return [driver.hold ? 'release-all' : 'hold-all', driver.running ? 'stop' : 'start']
}

// Retry shows where the view says it applies, from the same rows the driver follows.
function retries(row) {
  return row.effects?.retry?.applies === true
}

export function prControls(pr, readOnly) {
  if (readOnly || pr.status.stage === 'merged') {
    return []
  }

  const controls = [pr.held ? 'release' : 'hold', pr.state === 'blocked' ? 'answer' : 'note']

  if (retries(pr)) {
    controls.push('retry')
  }

  return controls
}

// The buttons in a board row's panel. A waiting row answers in its own box, so Answer and Note are not among them.
export function panelControls(row, readOnly) {
  if (readOnly || row.status.stage === 'merged') {
    return []
  }

  const controls = row.held ? ['release'] : []

  if (retries(row)) {
    controls.push('retry')
  }

  return controls
}

// A sentence that ends in a question mark keeps it.
function closed(text) {
  return /[.?!…]$/.test(text) ? text : `${text}.`
}

function answerDialog(pr) {
  const { question } = pr.status
  const sections = [
    { heading: 'question', text: question?.text },
    { heading: 'evidence', text: question?.evidence },
  ].filter((section) => section.text)

  return {
    title: `Answer ${pr.id}`,
    text: `${closed(sentence(pr.status.sentence))} The answer goes to the agent as a note.`,
    sections,
    effect: pr.effects.note.lines,
    confirmLabel: 'Send',
    withText: true,
  }
}

export function dialogFor(command, { rollout, driver, pr }) {
  switch (command) {
    case 'stop':
      return {
        title: `Stop the driver (PID ${driver?.pid})?`,
        text: 'Its agents stop too. The next start resumes their sessions.',
        confirmLabel: 'Stop',
      }

    case 'start':
      return {
        title: `Start the driver for ${rollout}?`,
        text: 'It runs detached. Its output goes to driver.log.',
        confirmLabel: 'Start',
        withDryRun: true,
      }

    case 'retry':
      return { title: `Retry ${pr.id}?`, text: 'Its attempts start from zero.', effect: pr.effects.retry.lines, confirmLabel: 'Retry' }

    case 'note':
      return { title: `Note for ${pr.id}`, effect: pr.effects.note.lines, confirmLabel: 'Send', withText: true }

    case 'answer':
      return answerDialog(pr)

    default:
      return null
  }
}

export function commandBody(command, pr, answer) {
  if (command === 'note' || command === 'answer') {
    return { cmd: 'note', id: pr.id, text: answer.text }
  }

  if (command === 'start') {
    return { cmd: command, dryRun: Boolean(answer?.dryRun) }
  }

  if (Object.hasOwn(BODIES, command)) {
    return BODIES[command](pr)
  }

  return { cmd: command }
}

function startNotice(body) {
  const parts = [`Starting the driver. Its output goes to ${body.log}.`]

  if (body.dryRun) {
    parts.push('Dry run.')
  }

  if (body.warning) {
    parts.push(`${sentence(body.warning)}.`)
  }

  return parts.join(' ')
}

// What the command applies to: all, its PR ids or its one id.
function scopeOf(command) {
  if (command.all) {
    return 'all'
  }

  return command.ids?.join(' ') ?? command.id
}

function queuedNotice(command, driver) {
  const text = `${sentence([command.cmd, scopeOf(command)].filter(Boolean).join(' '))} queued.`

  return driver?.running ? text : `${text} It applies when the driver starts.`
}

export function commandNotice(command, { status, body }, driver) {
  if (status !== 202) {
    return { text: serverAnswered(status, body), error: true }
  }

  if (command.cmd === 'stop') {
    return { text: `Stopping the driver (PID ${body.pid}).`, error: false }
  }

  if (command.cmd === 'start') {
    return { text: startNotice(body), error: false }
  }

  return { text: queuedNotice(command, driver), error: false }
}
