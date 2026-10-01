import { test } from 'node:test'
import assert from 'node:assert/strict'
import { githubUnavailable } from '../lib/github.mjs'
import { sh, shOk } from '../lib/sh.mjs'

// Each child sleeps far longer than its timeout, so the kill always wins.
const SLEEP = 'setTimeout(() => {}, 10_000)'

test('shOk: a call killed for its timeout says so, and that is an outage', async () => {
  await assert.rejects(shOk(process.execPath, ['-e', SLEEP], { timeout: 300 }), (error) => {
    assert.match(error.message, /timed out after 0\.3 s$/)
    assert.doesNotMatch(error.message, / exited /)
    assert.equal(githubUnavailable(error), true)

    return true
  })
})

test('shOk: a call killed for its timeout keeps the output it wrote before', async () => {
  const script = `process.stderr.write('still waiting for github.com'); ${SLEEP}`

  await assert.rejects(shOk(process.execPath, ['-e', script], { timeout: 2000 }), /timed out after 2 s: still waiting for github\.com$/)
})

test('sh: a kill for the timeout resolves as timed out with code 1, any other end does not', async () => {
  assert.deepEqual(await sh(process.execPath, ['-e', SLEEP], { timeout: 300 }), { code: 1, stdout: '', stderr: '', timedOut: true })
  assert.deepEqual(await sh(process.execPath, ['-e', 'process.exit(2)']), { code: 2, stdout: '', stderr: '', timedOut: false })
})

test('shOk: a plain non-zero exit keeps its code and stderr', async () => {
  const script = "process.stderr.write('HTTP 404: Not Found\\n'); process.exit(3)"

  await assert.rejects(shOk(process.execPath, ['-e', script]), (error) => {
    assert.match(error.message, / exited 3: HTTP 404: Not Found$/)
    assert.equal(githubUnavailable(error), false)

    return true
  })
})
