function missing(value) {
  return value === null || value === undefined
}

function pad(number) {
  return String(number).padStart(2, '0')
}

export function money(usd) {
  if (missing(usd)) {
    return '-'
  }

  return `$${usd.toFixed(2)}`
}

export function duration(seconds) {
  if (missing(seconds)) {
    return '-'
  }

  const whole = Math.max(0, Math.floor(seconds))

  if (whole < 60) {
    return `${whole}s`
  }

  if (whole < 3600) {
    return `${Math.floor(whole / 60)}m`
  }

  return `${Math.floor(whole / 3600)}h ${pad(Math.floor((whole % 3600) / 60))}m`
}

export function ago(seconds) {
  if (missing(seconds)) {
    return '-'
  }

  return `${duration(seconds)} ago`
}

function sameDay(first, second) {
  return first.getFullYear() === second.getFullYear() && first.getMonth() === second.getMonth() && first.getDate() === second.getDate()
}

export function clock(iso, now = Date.now()) {
  const time = typeof iso === 'string' ? new Date(iso) : null

  if (!time || Number.isNaN(time.getTime())) {
    return '-'
  }

  const hours = `${pad(time.getHours())}:${pad(time.getMinutes())}`

  if (sameDay(time, new Date(now))) {
    return hours
  }

  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${hours}`
}
