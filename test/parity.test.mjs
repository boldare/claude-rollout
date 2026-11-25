import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadManifest } from '../lib/manifest.mjs'
import { matchKey } from '../lib/review.ts'
import { rolloutPr, rolloutSnapshot } from '../lib/rollouts.mjs'
import { STAGE_STATUSES } from '../lib/state.ts'
import { renderBoard } from '../ui/board.js'
import { dialogFor, prControls } from '../ui/commands.js'
import { renderDetail } from '../ui/detail.js'
import { renderHeader } from '../ui/header.js'
import { installDocument } from './fake-dom.mjs'
import { REVIEW_MANIFEST, answeredReview, at, laterReview, makeRollout, samplePrs, sampleReview, sampleStatus } from './fixtures.mjs'

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

// As a driver of this version writes it, so the view keeps it as it is.
function written(entry) {
  return { hold: null, ...entry }
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

  return written({ stage, status: sampleStatus(kind, code), pr: stage === 'brief' ? null : 100 + index, hold })
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
  prs.H1 = written({ stage: 'implement', status: sampleStatus('running', 'implement'), pr: 201, hold: HOLD })

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

function texts(node, selector) {
  return node.querySelectorAll(selector).map((item) => item.textContent)
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
  assert.equal(pairs().length, 66)

  const dir = everyStatusRollout()
  const view = viewOf(dir)
  const lines = cliLines(cli('status', '--dir', dir))
  const board = boardRows(view, null)

  assert.equal(board.size, 68)
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

// The card's review section only: its heading, then the lines up to the next blank one.
// Other sections, such as the verdict's checklist, also have lines that start with "  [".
function cardReview(stdout) {
  const lines = stdout.split('\n')
  const start = lines.findIndex((line) => line.startsWith('external review of'))

  assert.ok(start >= 0, stdout)

  const end = lines.indexOf('', start)

  return lines.slice(start, end === -1 ? lines.length : end)
}

// The verifier tab of A1, from the same model the page fetches.
function pageReview(dir) {
  const body = JSON.parse(JSON.stringify(rolloutPr(loadManifest(dir), 'A1')))
  const ctx = {
    ...boardContext(viewOf(dir)),
    route: { r: 'demo', view: 'board', pr: 'A1', tab: 'verifier' },
    detail: { status: 200, body },
  }

  const section = renderDetail(ctx).querySelector('div.external-review')

  assert.ok(section, 'the verifier tab shows the external review')

  return section
}

test('parity: the review section of rollout card reads as the external review on the verifier tab, row for row', () => {
  const skip = { ...sampleReview(), reusedFrom: null, skipped: 'the review run ended as failure', findings: [], fixed: [] }
  const rowCounts = []

  for (const review of [sampleReview(), skip]) {
    const dir = makeRollout({ manifest: REVIEW_MANIFEST, prs: { A1: { ...samplePrs().A1, review } } })
    const [heading, ...rest] = cardReview(cli('card', 'A1', '--dir', dir))
    const section = pageReview(dir)
    const reused = rest.filter((line) => line.startsWith('  line numbers refer to ')).map((line) => line.trim())
    const lines = rest.filter((line) => line.startsWith('  ['))
    const rows = section.querySelector('tbody')?.children ?? []

    assert.equal(`${textOf(section, 'h3')}: ${textOf(section, 'p.text')}`, heading)
    assert.deepEqual(
      reused,
      section.querySelectorAll('p.muted').map((node) => node.textContent),
    )

    assert.equal(rows.length, lines.length, heading)

    rows.forEach((row, i) => {
      assertInOrder(
        lines[i],
        row.querySelectorAll('td').map((cell) => cell.textContent),
        `row ${i}`,
      )
    })

    rowCounts.push(rows.length)
  }

  assert.deepEqual(rowCounts, [4, 0])
})

test('parity: with an answered review, rollout card and the verifier tab note the same outcome of each finding, row for row', () => {
  const answered = answeredReview()
  // The high finding is already F1, so the next launch fixed the medium one alone.
  const waiting = {
    ...answered,
    review: { ...answered.review, candidates: [{ id: 'X1', key: answered.review.candidates[1].key }] },
    verdict: samplePrs().A1.verdict,
    verdicts: [samplePrs().A1.verdict],
  }

  // The medium one was refuted earlier, and its file kept its blob, so the next launch fixed no candidate.
  const [, refutedFinding] = answered.verdict.external
  const held = {
    ...waiting,
    review: { ...answered.review, candidates: [] },
    reviewMemory: {
      sent: answered.review.candidates.map((candidate) => candidate.key),
      refuted: [
        {
          key: refutedFinding.key,
          blob: '3b18e512dba79e4c8300dd08aeb37f8e728b8dad',
          evidence: refutedFinding.evidence,
          run: 'A1-03-verify',
          at: at(81),
        },
      ],
    },
  }

  const cases = [
    [answered, ['X1 confirmed', 'X2 refuted: src/orders/load.ts:9 caps the retries at three.', 'shown only, below medium', 'fixed']],
    [waiting, ['not sent, already finding F1', 'X1 sent, no answer yet', 'shown only, below medium', 'fixed']],
    [
      held,
      [
        'not sent, already finding F1',
        'refuted earlier: src/orders/load.ts:9 caps the retries at three.',
        'shown only, below medium',
        'fixed',
      ],
    ],
  ]

  for (const [fields, notes] of cases) {
    const dir = makeRollout({ manifest: REVIEW_MANIFEST, prs: { A1: { ...samplePrs().A1, ...fields } } })
    const lines = cardReview(cli('card', 'A1', '--dir', dir)).filter((line) => line.startsWith('  ['))
    const rows = pageReview(dir).querySelector('tbody').children
    const cells = rows.map((row) => row.querySelectorAll('td').map((cell) => cell.textContent))

    assert.deepEqual(
      cells.map((row) => row.at(-1)),
      notes,
    )

    assert.equal(lines.length, rows.length)
    lines.forEach((line, i) => {
      assertInOrder(line, cells[i], `row ${i}`)
      assert.ok(line.endsWith(` (${notes[i]})`), line)
    })
  }
})

test('parity: a review read after the verification gives the same notes and summary in rollout card and on the verifier tab', () => {
  const [, high] = sampleReview().findings
  const counts = '3 findings (1 high, 1 medium, 1 low), 1 fixed'
  const cases = [
    [
      {},
      ['new since the verification', 'new since the verification', 'shown only, below medium', 'fixed'],
      `${counts}, 2 new since the verification`,
    ],
    [
      { reviewMemory: { sent: [matchKey(high)], refuted: [] } },
      ['went to a verifier earlier', 'new since the verification', 'shown only, below medium', 'fixed'],
      `${counts}, 1 new since the verification`,
    ],
  ]

  for (const [fields, notes, summary] of cases) {
    const dir = makeRollout({ manifest: REVIEW_MANIFEST, prs: { A1: { ...samplePrs().A1, review: laterReview(), ...fields } } })
    const [heading, ...rest] = cardReview(cli('card', 'A1', '--dir', dir))
    const lines = rest.filter((line) => line.startsWith('  ['))
    const section = pageReview(dir)
    const cells = section.querySelector('tbody').children.map((row) => row.querySelectorAll('td').map((cell) => cell.textContent))

    assert.equal(heading, `external review of a1a1a1a: ${summary}`)
    assert.equal(`${textOf(section, 'h3')}: ${textOf(section, 'p.text')}`, heading)
    assert.deepEqual(
      cells.map((row) => row.at(-1)),
      notes,
    )

    assert.equal(lines.length, cells.length)
    lines.forEach((line, i) => {
      assertInOrder(line, cells[i], `row ${i}`)
      assert.ok(line.endsWith(` (${notes[i]})`), line)
    })
  }
})

// The overview of a PR's page, from the same model the page fetches.
function pageOverview(dir, id) {
  const body = JSON.parse(JSON.stringify(rolloutPr(loadManifest(dir), id)))
  const ctx = { ...boardContext(viewOf(dir)), route: { r: 'demo', view: 'board', pr: id, tab: 'overview' }, detail: { status: 200, body } }

  return renderDetail(ctx).querySelector('dl')
}

// The value of an overview field, or null when the page shows none.
function fieldOf(overview, label) {
  const items = overview.children
  const index = items.findIndex((item) => item.tagName === 'DT' && item.textContent === label)

  return index === -1 ? null : items[index + 1]
}

// The line of `rollout card` that starts with `label: `, without the label, or null.
function cardLine(dir, id, label) {
  const line = cli('card', id, '--dir', dir)
    .split('\n')
    .find((text) => text.startsWith(`${label}: `))

  return line === undefined ? null : line.slice(label.length + 2)
}

test('parity: the trace line reads the same in rollout card and on the PR page, and neither shows one without policy.trace', () => {
  const approve = sampleStatus('needs-you', 'approve')
  const record = { comment: 901, digest: 'd'.repeat(64), at: at(90), error: null }
  const prs = {
    T1: written({ stage: 'merge', status: approve, pr: 101 }),
    T2: written({ stage: 'merge', status: approve, pr: 102, trace: record }),
    T3: written({ stage: 'merge', status: approve, pr: 103, trace: { ...record, error: 'PATCH repos/example/widgets:\nHTTP 500' } }),
  }

  const lines = {
    T1: 'not written yet',
    T2: `written at ${at(90)}`,
    T3: 'the last write failed: PATCH repos/example/widgets: HTTP 500',
  }

  const traced = rolloutWith(prs, { policy: { trace: 'comment' } })
  const off = rolloutWith(prs)

  for (const [id, line] of Object.entries(lines)) {
    const field = fieldOf(pageOverview(traced, id), 'trace')

    assert.equal(cardLine(traced, id, 'trace'), line, id)
    assert.equal(field.textContent, line, id)
    assert.equal(textOf(field, 'span.text'), line, id)
    assert.equal(cardLine(off, id, 'trace'), null, id)
    assert.equal(fieldOf(pageOverview(off, id), 'trace'), null, id)
  }
})

// The header of a PR's page, from the same model the page fetches.
function pageHeader(dir, id) {
  const body = JSON.parse(JSON.stringify(rolloutPr(loadManifest(dir), id)))
  const ctx = { ...boardContext(viewOf(dir)), route: { r: 'demo', view: 'board', pr: id, tab: 'overview' }, detail: { status: 200, body } }

  return renderDetail(ctx).querySelector('div.detail-header')
}

test('parity: the review marker reads the same in rollout status, rollout card, on the board and in the PR page header', () => {
  const [, high] = sampleReview().findings
  const verified = samplePrs().A1.verified
  const reviewed = { claimedSha: verified.sha, verified, review: laterReview() }
  const approve = sampleStatus('needs-you', 'approve')
  const prs = {
    A1: written({ stage: 'merge', status: sampleStatus('waiting', 'held'), pr: 101, hold: HOLD, ...reviewed }),
    A2: written({
      stage: 'merge',
      status: approve,
      pr: 102,
      hold: HOLD,
      ...reviewed,
      reviewMemory: { sent: [matchKey(high)], refuted: [] },
    }),
    A3: written({ stage: 'merge', status: approve, pr: 103, ...reviewed, review: sampleReview() }),
  }

  const dir = rolloutWith(prs, { manifest: { ...REVIEW_MANIFEST, prs: Object.keys(prs).map(manifestPr) } })
  const view = viewOf(dir)
  const lines = cliLines(cli('status', '--dir', dir))
  const board = boardRows(view, null)
  const statuses = {
    A1: 'merge · waiting: held [review: 2 new]',
    A2: 'merge · needs-you: approve [held] [review: 1 new]',
    A3: 'merge · needs-you: approve',
  }

  const markers = { A1: ['review: 2 new'], A2: ['review: 1 new'], A3: [] }

  for (const [id, status] of Object.entries(statuses)) {
    const cell = renderBoard(boardContext(view)).querySelectorAll('tr.clickable')[Number(id.slice(1)) - 1].children[3]
    const header = pageHeader(dir, id)
    const card = cli('card', id, '--dir', dir).split('\n')[1]

    assert.ok(lines.get(id).includes(`${status}  `), lines.get(id))
    assert.ok(card.startsWith(`${status}   PR: `), card)
    assert.deepEqual(texts(cell, 'span.badge.review-new'), markers[id], id)
    assert.deepEqual(texts(header, 'span.badge.review-new'), markers[id], id)
    assert.equal(board.get(id).held, id === 'A2', id)
    assert.equal(texts(header, 'span.badge.held').length, id === 'A2' ? 1 : 0, id)
    assertInOrder(lines.get(id), [...board.get(id).parts.slice(0, 2), ...texts(cell, 'span.badge.held'), ...markers[id]], id)
    assertInOrder(card, [textOf(header, 'span.badge.stage'), textOf(header, 'span.badge.status'), ...markers[id]], id)
  }
})
