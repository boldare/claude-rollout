import { sh } from './sh.mjs'

export const BATTERY_WARNING = 'on battery: caffeinate cannot keep this Mac awake, keep the lid open or plug in'

const SLEEP_SLACK_MS = 60_000

// The part of a gap between two readings of the wall clock that the machine
// slept. A reading up to a minute late is load, not sleep.
export function sleptMs(gapMs, intervalMs) {
  const late = gapMs - intervalMs

  return late > SLEEP_SLACK_MS ? late : 0
}

export function onBattery(output) {
  return String(output ?? '').includes("Now drawing from 'Battery Power'")
}

async function readPmset() {
  const { stdout } = await sh('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5_000 })

  return stdout
}

export async function batteryWarning({ platform = process.platform, read = readPmset } = {}) {
  if (platform !== 'darwin') {
    return null
  }

  try {
    return onBattery(await read()) ? BATTERY_WARNING : null
  } catch {
    return null
  }
}
