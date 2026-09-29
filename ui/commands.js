// What the controls show, ask and send. No DOM here, so Node tests it.
const RETRY_STATES = ['escalated', 'blocked', 'interrupted']
const PR_COMMANDS = ['hold', 'release', 'retry']
const LOSES_VERIFICATION = ['verified', 'ready_claimed']

export function rolloutControls(view, readOnly) {
  if (readOnly) {
    return []
  }

  if (!view) {
    return ['start']
  }

  const { driver } = view
  const controls = [driver.paused ? 'resume' : 'pause']

  if (driver.halted) {
    controls.push('unhalt')
  }

  controls.push(driver.running ? 'stop' : 'start')

  return controls
}

export function prControls(pr, readOnly) {
  if (readOnly || pr.state === 'merged') {
    return []
  }

  const controls = [pr.held ? 'release' : 'hold', 'note']

  if (RETRY_STATES.includes(pr.state)) {
    controls.push('retry')
  }

  return controls
}

function noteDialog(pr) {
  const dialog = { title: `Note for ${pr.id}`, confirmLabel: 'Send', withText: true }

  if (LOSES_VERIFICATION.includes(pr.state)) {
    dialog.text = 'The PR goes back to the implementer and loses its verification.'
  }

  return dialog
}

export function dialogFor(command, { rollout, driver, pr }) {
  switch (command) {
    case 'stop':
      return {
        title: `Stop the driver (pid ${driver?.pid})?`,
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
      return { title: `Retry ${pr.id}?`, text: 'Its attempts start from zero.', confirmLabel: 'Retry' }

    case 'unhalt':
      return {
        title: `Unhalt ${rollout}?`,
        text: `Halted: ${driver?.halted}. Unhalt lets the driver merge again.`,
        confirmLabel: 'Unhalt',
      }

    case 'note':
      return noteDialog(pr)

    default:
      return null
  }
}

// Stop carries no pid: the server reads driver.lock when the request arrives.
export function commandBody(command, pr, answer) {
  if (command === 'note') {
    return { cmd: command, id: pr.id, text: answer.text }
  }

  if (command === 'start') {
    return { cmd: command, dryRun: Boolean(answer?.dryRun) }
  }

  if (PR_COMMANDS.includes(command)) {
    return { cmd: command, id: pr.id }
  }

  return { cmd: command }
}

function startNotice(body) {
  const text = `Starting the driver. Its output goes to ${body.log}.`

  return body.dryRun ? `${text} Dry run.` : text
}

function queuedNotice(command, driver) {
  const text = `${[command.cmd, command.id].filter(Boolean).join(' ')} queued.`

  return driver?.running ? text : `${text} It applies when the driver starts.`
}

export function commandNotice(command, { status, body }, driver) {
  if (status !== 202) {
    return { text: body?.error ?? `The server answered ${status}.`, error: true }
  }

  if (command.cmd === 'stop') {
    return { text: `Stopping the driver (pid ${body.pid}).`, error: false }
  }

  if (command.cmd === 'start') {
    return { text: startNotice(body), error: false }
  }

  return { text: queuedNotice(command, driver), error: false }
}
