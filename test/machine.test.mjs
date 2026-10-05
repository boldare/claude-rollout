import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BATTERY_WARNING, batteryWarning, onBattery, sleptMs } from '../lib/machine.mjs'

// Synthetic `pmset -g batt` outputs.
const LAPTOP_ON_AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234567)\t87%; charging; 0:45 remaining present: true\n"
const LAPTOP_ON_BATTERY =
  "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234567)\t64%; discharging; 4:12 remaining present: true\n"

const DESKTOP = "Now drawing from 'AC Power'\n"
const UPS = "Now drawing from 'UPS Power'\n -UPS-0 (id=7654321)\t98%; discharging; 0:30 remaining present: true\n"
const GARBAGE = 'Battery Power\n%%% 0x00 not pmset output\n'

test('sleptMs: a gap up to a minute longer than the interval is no sleep', () => {
  assert.equal(sleptMs(60_000, 60_000), 0)
  assert.equal(sleptMs(120_000, 60_000), 0)
  assert.equal(sleptMs(120_001, 60_000), 60_001)
  assert.equal(sleptMs(2 * 60 * 60_000, 60_000), 7_140_000)
  assert.equal(sleptMs(-5_000, 60_000), 0)
})

test('sleptMs: the interval is the tick, whatever it is', () => {
  assert.equal(sleptMs(360_000, 300_000), 0)
  assert.equal(sleptMs(360_001, 300_000), 60_001)
  assert.equal(sleptMs(2 * 60 * 60_000, 300_000), 6_900_000)
})

test('onBattery: only a Mac drawing from its battery', () => {
  assert.equal(onBattery(LAPTOP_ON_BATTERY), true)

  for (const output of [LAPTOP_ON_AC, DESKTOP, UPS, '', GARBAGE]) {
    assert.equal(onBattery(output), false, output)
  }
})

test('batteryWarning: never reads the power source off macOS', async () => {
  for (const platform of ['linux', 'win32']) {
    let reads = 0
    const read = async () => {
      reads += 1

      return LAPTOP_ON_BATTERY
    }

    assert.equal(await batteryWarning({ platform, read }), null, platform)
    assert.equal(reads, 0, platform)
  }
})

test('batteryWarning: the warning on battery, null on AC', async () => {
  assert.equal(await batteryWarning({ platform: 'darwin', read: async () => LAPTOP_ON_BATTERY }), BATTERY_WARNING)
  assert.equal(await batteryWarning({ platform: 'darwin', read: async () => LAPTOP_ON_AC }), null)
  assert.equal(BATTERY_WARNING, 'on battery: caffeinate cannot keep this Mac awake, keep the lid open or plug in')
})

test('batteryWarning: a failed read is no warning', async () => {
  const throwing = () => {
    throw new Error('pmset missing')
  }

  const rejecting = async () => {
    throw new Error('pmset timed out')
  }

  assert.equal(await batteryWarning({ platform: 'darwin', read: throwing }), null)
  assert.equal(await batteryWarning({ platform: 'darwin', read: rejecting }), null)
})
