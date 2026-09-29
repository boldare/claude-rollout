export const MARKERS = {
  'ready-claimed': 'ready',
  'ready-to-merge': 'ready',
  rebased: 'rebase',
  'review-feedback': 'feedback',
  merged: 'merge',
  'merged-outside-driver': 'merge',
  'merged-outside-run': 'merge',
}

const MIN_SPAN_MS = 1000

function timeOf(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN

  return Number.isFinite(parsed) ? parsed : null
}

function known(times) {
  return times.filter((time) => time !== null)
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high)
}

// Reduced instead of spread into Math.min, which overflows the stack on a long event log.
function earliest(times) {
  return times.reduce((low, time) => Math.min(low, time), Infinity)
}

function latest(times) {
  return times.reduce((high, time) => Math.max(high, time), -Infinity)
}

function spanOf({ runs, events, now, live }) {
  const eventTimes = known(events.map((event) => timeOf(event.at)))
  const startTimes = known(runs.map((run) => timeOf(run.startedAt)))
  const endTimes = known(runs.map((run) => timeOf(run.endedAt)))
  const starts = [...eventTimes, ...startTimes]

  if (starts.length === 0) {
    return null
  }

  const start = earliest(starts)
  let end = latest([...starts, ...endTimes])

  if (live || runs.some((run) => run.status === 'running')) {
    end = now
  }

  if (end <= start) {
    end = start + MIN_SPAN_MS
  }

  return { start, end }
}

function barEnd(run, from, { now, end, restarts }) {
  const ended = timeOf(run.endedAt)

  if (ended !== null) {
    return ended
  }

  if (run.status === 'running') {
    return now
  }

  if (run.status === 'interrupted') {
    return restarts.find((restart) => restart > from) ?? end
  }

  return from
}

function barOf(run, from, context) {
  const { start, end } = context
  const span = end - start
  const to = barEnd(run, from, context)
  const left = clamp((from - start) / span, 0, 1)
  const width = clamp((to - from) / span, 0, 1 - left)

  return { run: run.run, role: run.role, step: run.step, status: run.status, from, to, left, width }
}

function position(time, { start, end }) {
  return clamp((time - start) / (end - start), 0, 1)
}

function emptyLanes(rows) {
  return rows.map((row) => ({ id: row.id, bars: [], markers: [] }))
}

export function timelineLayout({ rows, runs, events, now, live }) {
  const span = spanOf({ runs, events, now, live })

  if (!span) {
    return { start: null, end: null, lanes: emptyLanes(rows), restarts: [] }
  }

  const lanes = emptyLanes(rows)
  const laneOf = new Map(lanes.map((lane) => [lane.id, lane]))
  const starts = events.filter((event) => event.kind === 'driver-start')
  const restartTimes = known(starts.map((event) => timeOf(event.at))).sort((first, second) => first - second)
  const context = { ...span, now, restarts: restartTimes }

  for (const run of runs) {
    const from = timeOf(run.startedAt)
    const lane = laneOf.get(run.id)

    if (from !== null && lane) {
      lane.bars.push(barOf(run, from, context))
    }
  }

  for (const event of events) {
    const time = timeOf(event.at)
    const lane = laneOf.get(event.id)

    if (time !== null && lane && Object.hasOwn(MARKERS, event.kind)) {
      lane.markers.push({ kind: event.kind, type: MARKERS[event.kind], at: event.at, left: position(time, span) })
    }
  }

  const restarts = starts
    .filter((event) => timeOf(event.at) !== null)
    .map((event) => ({ at: event.at, left: position(timeOf(event.at), span) }))

  return { start: span.start, end: span.end, lanes, restarts }
}
