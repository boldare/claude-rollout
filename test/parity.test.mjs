import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifest } from '../lib/manifest.mjs'
import { rolloutSnapshot } from '../lib/rollouts.mjs'
import { STAGE_STATUSES } from '../lib/state.ts'
import { stateOf } from '../lib/transitions.ts'
import { renderBoard } from '../ui/board.js'
import { dialogFor, prControls } from '../ui/commands.js'
import { renderHeader } from '../ui/header.js'
import { installDocument } from './fake-dom.mjs'
import { at, makeRollout, sampleStatus } from './fixtures.mjs'

// The CLI and the board print one model. One PR per stage and code of
// STAGE_STATUSES, a merged one and a held running one: each status line of
// `rollout status` must hold what its board row shows, in the same order.

const BIN = fileURLToPath(new URL('../bin/rollout.mjs', import.meta.url))
const HOLD = { at: at(7), by: 'maintainer', reason: 'checking the plan' }

installDocument()

function pairs() {
  const found = []

  for (const [stage, kinds] of Object.entries(STAGE_STATUSES)) {
    for (const [kind, codes] of Object.entries(kinds)) {
      for (const code of codes) {
        found.push({ stage, kind, code })
      }
    }
  }

  return found
}

// As a driver of this version writes it, so the view's fill keeps it as it is.
function written(entry) {
  const full = { hold: null, held: null, ...entry }

  return { ...full, state: stateOf(full) }
}

function manifestPr(id) {
  return {
    id,
    branch: `feat/${id.toLowerCase()}`,
    title: `feat: ${id}`,
    brief: `briefs/${id}.md`,
    effort: { implement: 'high', verify: 'high' },
    changeset: 'none',
  }
}

// A held status names the PR's own hold, so those PRs carry one.
function pairEntry({ stage, kind, code }, index) {
  const hold = code === 'held' ? HOLD : null

  return written({ stage, status: sampleStatus(kind, code), pr: stage === 'brief' ? null : 100 + index, hold, held: hold })
}

function rolloutWith(prs, options = {}) {
  return makeRollout({ prs, events: [], logs: {}, manifest: { prs: Object.keys(prs).map(manifestPr) }, ...options })
}

function everyStatusRollout() {
  const prs = {}

  pairs().forEach((pair, index) => {
    prs[`P${String(index + 1).padStart(2, '0')}`] = pairEntry(pair, index)
  })

  prs.M1 = written({ stage: 'merged', status: null, pr: 200, mergeSha: 'feedface00' })
  prs.H1 = written({ stage: 'implement', status: sampleStatus('running', 'implement'), pr: 201, hold: HOLD, held: HOLD })

  return rolloutWith(prs)
}

function cli(...args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: dirname(BIN),
    env: { ...process.env, COLUMNS: '1000' },
  })

  assert.equal(result.status, 0, result.stderr)

  return result.stdout
}

function cliLines(stdout) {
  const lines = new Map()

  for (const line of stdout.split('\n')) {
    const [id] = line.split(' ')

    if (/^[PMHA]\d+$/.test(id)) {
      lines.set(id, line)
    }
  }

  return lines
}

function boardContext(view, filter = null) {
  return {
    route: { r: 'demo', view: 'board', pr: null, tab: 'overview', filter, id: null, kind: null, run: null, from: null },
    now: Date.now(),
    state: { name: 'demo', at: new Date().toISOString(), view, readOnly: true },
    view,
    events: [],
    status: null,
    problem: null,
    notice: null,
    rowChoices: new Map(),
    panels: new Map(),
    drafts: new Map(),
    sent: new Set(),
    remembered: new Map(),
    readOnly: true,
    sending: false,
    toggleRow: () => {},
    sendAnswer: () => {},
    send: () => {},
    linkTo: () => '#',
    linkWith: () => '#',
    go: () => {},
  }
}

// The page only ever sees JSON.
function viewOf(dir) {
  return JSON.parse(JSON.stringify(rolloutSnapshot(loadManifest(dir), 'demo'))).state.view
}

function textOf(node, selector) {
  return node.querySelector(selector)?.textContent ?? null
}

// What a board row shows of its status, in the order the CLI prints it.
function boardRows(view, filter) {
  const rows = new Map()

  for (const row of renderBoard(boardContext(view, filter)).querySelectorAll('tr.clickable')) {
    const status = row.children[3]
    const info = row.querySelector('td.info')

    rows.set(row.children[1].textContent, {
      parts: [
        textOf(status, 'span.badge.stage'),
        textOf(status, 'span.badge.status'),
        textOf(info, 'span.sentence'),
        textOf(info, 'code.way-out'),
      ],
      held: status.querySelectorAll('span.badge.held').length > 0,
    })
  }

  return rows
}

function assertInOrder(line, parts, id) {
  let from = 0

  for (const part of parts.filter((item) => item !== null)) {
    const index = line.indexOf(part, from)

    assert.ok(index >= from, `${id}: "${part}" is missing or out of order in: ${line}`)
    from = index + part.length
  }
}

test('parity: every stage and code, a merged PR and a held running one read the same in rollout status and on the board', () => {
  assert.equal(pairs().length, 65)

  const dir = everyStatusRollout()
  const view = viewOf(dir)
  const lines = cliLines(cli('status', '--dir', dir))
  const board = boardRows(view, null)

  assert.equal(board.size, 67)
  assert.deepEqual([...lines.keys()], [...board.keys()])

  for (const [id, row] of board) {
    assert.ok(row.parts[0] && row.parts[2], `${id} shows a stage and a sentence`)
    assertInOrder(lines.get(id), row.parts, id)
  }

  for (const [index, { stage, kind, code }] of pairs().entries()) {
    const id = `P${String(index + 1).padStart(2, '0')}`

    assert.deepEqual(board.get(id).parts.slice(0, 2), [stage, `${kind}: ${code}`], id)
    assert.equal(board.get(id).parts[3] !== null, kind === 'needs-you' || code === 'held', `${id} has a way out`)
  }

  assert.deepEqual(board.get('M1').parts, ['merged', null, 'merged as feedfac', null])
  // A merged PR has no age and no way out.
  assert.match(lines.get('M1'), /^M1 {3}merged {2,}merged as feedfac$/)
  assert.ok(lines.get('H1').includes('implement · running: implement [held]'), lines.get('H1'))
  assert.equal(board.get('H1').held, true)
  assert.deepEqual(
    [...board].filter(([, row]) => row.held).map(([id]) => id),
    ['H1'],
  )

  assert.deepEqual(
    [...lines].filter(([, line]) => line.includes('[held]')).map(([id]) => id),
    ['H1'],
  )
})

test('parity: status --needs-you and --stage merge list the ids the board shows under the same filters', () => {
  const dir = everyStatusRollout()
  const view = viewOf(dir)

  for (const [args, filter] of [
    [['--needs-you'], 'needs-you'],
    [['--stage', 'merge'], 'merge'],
  ]) {
    const listed = [...cliLines(cli('status', '--dir', dir, ...args)).keys()]
    const shown = [...boardRows(view, filter).keys()]

    assert.ok(listed.length > 0, filter)
    assert.deepEqual(listed, shown, filter)
  }
})

// The agent's variables would make the CLI refuse every command.
function commandEnv() {
  const env = { ...process.env }

  delete env.ROLLOUT_ROLE
  delete env.ROLLOUT_ROOT
  delete env.ROLLOUT_DIR

  return env
}

function command(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dirname(BIN), env: commandEnv() })
}

function inboxCount(dir) {
  const inbox = join(dir, 'inbox')

  return existsSync(inbox) ? readdirSync(inbox).filter((name) => !name.startsWith('.')).length : 0
}

// The effect lines as the CLI prints them: the id before the first, four spaces before the rest.
function printedLines(output, id) {
  const [first, ...rest] = output.trimEnd().split('\n')

  assert.ok(first.startsWith(`${id}  `), first)
  assert.ok(
    rest.every((line) => line.startsWith('    ')),
    output,
  )

  return [first.slice(id.length + 2), ...rest.map((line) => line.slice(4))]
}

function commandRollout() {
  const fix = { reason: 'verifier-findings', note: '<findings>', since: at(50) }
  const verified = { sha: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', patchId: 'patch-c6', at: at(80) }

  return rolloutWith({
    C1: written({ stage: 'implement', status: sampleStatus('needs-you', 'decision'), pr: 101, sessionId: 'session-1' }),
    C2: written({ stage: 'implement', status: sampleStatus('needs-you', 'obstacle'), pr: 102, sessionId: 'session-2' }),
    C3: written({
      stage: 'implement',
      status: sampleStatus('waiting', 'slot'),
      pr: 103,
      fix,
      fixReason: 'verifier findings',
      fixNote: '<findings>',
    }),
    C4: written({ stage: 'implement', status: sampleStatus('running', 'implement'), pr: 104 }),
    C5: written({ stage: 'verify', status: sampleStatus('needs-you', 'dispute'), pr: 105, claimedSha: verified.sha }),
    C6: written({
      stage: 'merge',
      status: sampleStatus('needs-you', 'approve'),
      pr: 106,
      claimedSha: verified.sha,
      verified,
      approved: { ...verified, at: at(81), channel: 'inbox' },
    }),
    C7: written({ stage: 'merged', status: null, pr: 107, mergeSha: 'feedface00' }),
  })
}

test('parity: retry and note print the lines of the board row and its dialog, and a refused one exits 1 and posts nothing', () => {
  const dir = commandRollout()
  const rows = new Map(viewOf(dir).rows.map((row) => [row.id, row]))
  const outcomes = []

  for (const [id, row] of rows) {
    for (const cmd of ['retry', 'note']) {
      const before = inboxCount(dir)
      const result = cmd === 'retry' ? command('retry', id, '--dir', dir) : command('note', id, 'Rename the field.', '--dir', dir)
      const effect = row.effects[cmd]

      outcomes.push(`${id} ${cmd} ${effect.applies}`)

      if (effect.applies) {
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(printedLines(result.stdout.replace(/queued\n$/, ''), id), effect.lines, `${id} ${cmd}`)
        assert.deepEqual(dialogFor(cmd, { pr: row }).effect, effect.lines, `${id} ${cmd}`)
        assert.equal(inboxCount(dir), before + 1, `${id} ${cmd}`)
      } else {
        assert.equal(result.status, 1, `${id} ${cmd}: ${result.stdout}`)
        assert.equal(result.stdout, '', `${id} ${cmd}`)
        assert.deepEqual(printedLines(result.stderr, id), effect.lines, `${id} ${cmd}`)
        assert.equal(inboxCount(dir), before, `${id} ${cmd}`)
      }

      if (cmd === 'retry') {
        assert.equal(prControls(row, false).includes('retry'), effect.applies, `${id} retry`)
      }
    }
  }

  assert.deepEqual(outcomes, [
    'C1 retry false',
    'C1 note true',
    'C2 retry true',
    'C2 note true',
    'C3 retry true',
    'C3 note true',
    'C4 retry false',
    'C4 note true',
    'C5 retry false',
    'C5 note true',
    'C6 retry true',
    'C6 note true',
    'C7 retry false',
    'C7 note false',
  ])
})

test('parity: with no driver, a running status reads waiting: driver-stopped in both, and both headers say the driver is down', () => {
  const dir = rolloutWith({ A1: written({ stage: 'implement', status: sampleStatus('running', 'implement'), pr: 11 }) }, { lock: false })
  const view = viewOf(dir)
  const stdout = cli('status', '--dir', dir)
  const line = cliLines(stdout).get('A1')
  const row = boardRows(view, null).get('A1')

  assert.deepEqual(row.parts, ['implement', 'waiting: driver-stopped', 'the driver is not running', null])
  assertInOrder(line, row.parts, 'A1')
  assert.match(stdout, /^rollout demo {2}driver: NOT RUNNING since \d{4}-\d\d-\d\d \d\d:\d\d UTC\. Statuses are from its last tick\./)
  assert.match(textOf(renderHeader(boardContext(view)), 'p.stopped-since'), /^Not running since .+\. Statuses are from its last tick\.$/)
})
