// A placeholder until the real views land. Titles, errors and events are
// untrusted text, so the DOM is built from elements and textContent only.
const REFRESH_MS = 5000
const OPEN_THE_URL = 'Open the URL that rollout ui printed in its terminal. It carries the access token.'

const token = new URLSearchParams(location.hash.slice(1)).get('t')
const app = document.getElementById('app')

function element(tag, text, className) {
  const node = document.createElement(tag)

  if (text !== undefined) {
    node.textContent = text
  }

  if (className) {
    node.className = className
  }

  return node
}

function showLine(text) {
  app.replaceChildren(element('p', text))
}

function driverStatus(driver) {
  if (driver.halted) {
    return 'halted'
  }

  if (driver.paused) {
    return 'paused'
  }

  return driver.running ? 'running' : 'stopped'
}

function rolloutItem(rollout) {
  const item = element('li', undefined, 'rollout')
  item.append(element('strong', rollout.name))

  if (rollout.error) {
    item.append(element('span', rollout.error, 'error'))
    return item
  }

  item.append(
    element('span', driverStatus(rollout.driver)),
    element('span', `${rollout.merged}/${rollout.total} merged`),
    element('span', `$${rollout.costUsd.toFixed(2)}`),
  )

  return item
}

function render({ root, rollouts }) {
  if (rollouts.length === 0) {
    showLine(`No rollouts in ${root}.`)
    return
  }

  const list = element('ul', undefined, 'rollouts')
  list.append(...rollouts.map(rolloutItem))
  app.replaceChildren(element('h1', 'rollouts'), list)
}

// Resolves to whether another refresh makes sense.
async function load() {
  if (!token) {
    showLine(OPEN_THE_URL)
    return false
  }

  const response = await fetch('/api/rollouts', { headers: { Authorization: `Bearer ${token}` } })

  if (response.status === 401) {
    showLine(OPEN_THE_URL)
    return false
  }

  if (!response.ok) {
    showLine(`The server answered ${response.status}.`)
    return true
  }

  render(await response.json())

  return true
}

async function refresh() {
  let again = true

  try {
    again = await load()
  } catch (error) {
    showLine(`Cannot reach the server: ${error.message}`)
  }

  if (again) {
    setTimeout(refresh, REFRESH_MS)
  }
}

refresh()
