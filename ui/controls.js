import { commandBody, dialogFor, panelControls, prControls, rolloutControls } from './commands.js'
import { ask } from './dialog.js'
import { element } from './dom.js'

const LABELS = {
  pause: 'Pause',
  resume: 'Resume',
  unhalt: 'Unhalt',
  stop: 'Stop',
  start: 'Start',
  hold: 'Hold',
  release: 'Release',
  note: 'Note',
  answer: 'Answer',
  retry: 'Retry',
}

const CLASSES = { stop: 'danger', answer: 'primary' }

async function run(command, pr, ctx) {
  const options = dialogFor(command, { rollout: ctx.view?.rollout ?? ctx.state?.name, driver: ctx.view?.driver ?? null, pr })
  let answer = null

  if (options) {
    answer = await ask(options)

    if (!answer) {
      return
    }
  }

  ctx.send(commandBody(command, pr, answer))
}

function button(command, pr, ctx) {
  const node = element('button', LABELS[command], CLASSES[command] ?? '')

  node.type = 'button'
  node.disabled = Boolean(ctx.sending)
  node.addEventListener('click', () => run(command, pr, ctx))

  return node
}

function controls(commands, pr, ctx) {
  if (commands.length === 0) {
    return null
  }

  const node = element('div', undefined, 'controls')
  node.append(...commands.map((command) => button(command, pr, ctx)))

  return node
}

export function renderRolloutControls(ctx) {
  return controls(rolloutControls(ctx.view, ctx.readOnly), null, ctx)
}

export function renderPrControls(pr, ctx) {
  return controls(prControls(pr, ctx.readOnly), pr, ctx)
}

export function renderPanelControls(row, ctx) {
  return controls(panelControls(row, ctx.readOnly), row, ctx)
}
