const SEPARATOR = '\n\n'

function field(line) {
  const colon = line.indexOf(':')

  if (colon === -1) {
    return { name: line, value: '' }
  }

  const value = line.slice(colon + 1)

  return { name: line.slice(0, colon), value: value.startsWith(' ') ? value.slice(1) : value }
}

function parseMessage(block) {
  let event = 'message'
  const data = []

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      continue
    }

    const { name, value } = field(line)

    if (name === 'event') {
      event = value || 'message'
    } else if (name === 'data') {
      data.push(value)
    }
  }

  if (data.length === 0) {
    return null
  }

  try {
    return { event, data: JSON.parse(data.join('\n')) }
  } catch {
    return null
  }
}

export function parseSse(buffer) {
  const blocks = buffer.split(SEPARATOR)
  const rest = blocks.pop()
  const messages = blocks.map(parseMessage).filter(Boolean)

  return { messages, rest }
}
