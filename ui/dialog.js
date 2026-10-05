import { element, withClass, wrap } from './dom.js'

// The page rebuilds #app on every push, so the dialog lives outside it and
// keeps the typed note and the open confirmation.
let dialog = null
let settle = null

function finish(answer) {
  const resolve = settle

  settle = null

  if (dialog.open) {
    dialog.close()
  }

  resolve?.(answer)
}

function theDialog() {
  if (dialog) {
    return dialog
  }

  dialog = element('dialog')

  // A close() from an earlier ask fires this after the next showModal(), so only a closed dialog counts.
  dialog.addEventListener('close', () => {
    if (!dialog.open) {
      finish(null)
    }
  })

  document.body.append(dialog)

  return dialog
}

function button(text, className) {
  const node = element('button', text, className)
  node.type = 'button'

  return node
}

function dryRunBox() {
  const box = element('input')
  box.type = 'checkbox'

  return box
}

export function ask({ title, text, confirmLabel, withText = false, withDryRun = false }) {
  const node = theDialog()

  finish(null)

  const textArea = withText ? element('textarea') : null
  const dryRun = withDryRun ? dryRunBox() : null
  const cancel = button('Cancel')
  const accept = button(confirmLabel, 'primary')
  const parts = [element('h2', title)]

  if (text) {
    parts.push(element('p', text))
  }

  if (textArea) {
    textArea.rows = 5
    accept.disabled = true
    textArea.addEventListener('input', () => {
      accept.disabled = textArea.value.trim() === ''
    })

    parts.push(textArea)
  }

  if (dryRun) {
    parts.push(wrap('label', dryRun, element('span', 'dry run: everything real except the merge')))
  }

  parts.push(withClass(wrap('div', cancel, accept), 'dialog-buttons'))
  node.replaceChildren(...parts)

  cancel.addEventListener('click', () => finish(null))
  accept.addEventListener('click', () => finish({ text: textArea?.value.trim() ?? '', dryRun: dryRun?.checked ?? false }))

  const answer = new Promise((resolve) => {
    settle = resolve
  })

  node.showModal()

  // Cancel is the default, so Enter never confirms a stop by accident.
  const focused = textArea ?? cancel
  focused.focus()

  return answer
}
