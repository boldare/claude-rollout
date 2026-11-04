import { basename } from 'node:path'

// The run model, shared by the ledger and the view. It imports nothing from
// lib/: the ledger needs it for its migration, and the view imports the
// driver, which imports the ledger.
const RUN_EVENT = /^(brief|implement|fix|verify|delegate)-(start|done)$/

function newRun(event, role, run) {
  return {
    run,
    id: event.id,
    role,
    step: event.step ?? null,
    effort: event.effort ?? null,
    model: event.model ?? null,
    startedAt: event.at ?? null,
    endedAt: null,
    seconds: null,
    costUsd: null,
    ok: null,
    result: null,
    error: null,
    denials: null,
    status: null,
  }
}

function doneStatus(event) {
  if (event.ok) {
    return 'ok'
  }

  return event.stopped ? 'interrupted' : 'failed'
}

function closeRun(run, event) {
  run.step = run.step ?? event.step ?? null
  run.endedAt = event.at ?? null
  run.seconds = event.seconds ?? null
  run.costUsd = event.cost ?? 0
  run.ok = event.ok === true
  run.result = event.result ?? null
  run.error = event.error ?? null
  run.denials = event.denials ?? 0
  run.status = doneStatus(event)
}

// Pairs *-start and *-done events into runs. Events written before runs had
// ids carry only the log name on the start and nothing on the done, so those
// pair by PR and role instead.
export function runsFromEvents(events, { driverRunning = false } = {}) {
  const runs = []
  const open = []
  const restarted = new Set()

  for (const event of events) {
    if (event.kind === 'driver-start') {
      for (const run of open) {
        restarted.add(run)
      }

      continue
    }

    const match = RUN_EVENT.exec(event.kind)

    if (!match) {
      continue
    }

    const [, role, edge] = match

    if (edge === 'start') {
      const run = newRun(event, role, event.run ?? (event.log ? basename(event.log, '.jsonl') : null))
      runs.push(run)
      open.push(run)
      continue
    }

    const index = open.findLastIndex((run) => run.id === event.id && (event.run ? run.run === event.run : run.role === role))
    let run

    if (index === -1) {
      run = { ...newRun(event, role, event.run ?? null), effort: null, startedAt: null }
      runs.push(run)
    } else {
      run = open.splice(index, 1)[0]
    }

    closeRun(run, event)
  }

  for (const run of open) {
    run.status = restarted.has(run) || !driverRunning ? 'interrupted' : 'running'
  }

  return runs
}

// The ledger's records of the runs in the events, keyed by run name.
export function runRecords(events, { driverRunning = false } = {}) {
  const records = {}

  for (const run of runsFromEvents(events, { driverRunning })) {
    if (!run.run) {
      continue
    }

    // Logs from before reserveRunName could repeat a name. The later run wins, in its own place.
    delete records[run.run]
    records[run.run] = {
      id: run.id,
      role: run.role,
      step: run.step,
      reason: null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      effort: run.effort,
      model: null,
      requestedModel: run.model,
      resume: null,
      log: `logs/${run.run}.jsonl`,
      ok: run.ok,
      result: run.result,
      costUsd: run.costUsd,
      seconds: run.seconds,
      awakeSeconds: null,
      denials: run.denials,
      stopped: run.status === 'interrupted',
      error: run.error,
    }
  }

  return records
}

function recordStatus(record, driverRunning) {
  if (record.endedAt) {
    if (record.ok) {
      return 'ok'
    }

    return record.stopped ? 'interrupted' : 'failed'
  }

  if (record.stopped || !driverRunning) {
    return 'interrupted'
  }

  return 'running'
}

// The runs of a ledger in the shape runsFromEvents gives. `model` is the one
// the start asked for, as on the events.
export function runsFromLedger(ledger, { driverRunning = false } = {}) {
  return Object.entries(ledger.runs ?? {}).map(([run, record]) => ({
    run,
    id: record.id,
    role: record.role,
    step: record.step,
    effort: record.effort,
    model: record.requestedModel,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    seconds: record.seconds,
    costUsd: record.costUsd,
    ok: record.ok,
    result: record.result,
    error: record.error,
    denials: record.denials,
    status: recordStatus(record, driverRunning),
  }))
}
