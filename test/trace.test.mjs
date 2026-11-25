import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DRIVER_MARKER } from '../lib/github.mjs'
import { freshPr } from '../lib/ledger.mjs'
import { matchKey } from '../lib/review.ts'
import {
  CANDIDATE_RESULTS,
  CHANNELS,
  CRITERION_LEVELS,
  CRITERION_RESULTS,
  MERGE_POLICIES,
  RECHECK_RESULTS,
  REVIEW_SEVERITIES,
  ROLES,
  STAGES,
  STATUS_KINDS,
  VERDICTS,
} from '../lib/state.ts'
import { TRACE_LIMIT, TRACE_MARKER, readTrace, traceBody, traceDigest, traceOf } from '../lib/trace.ts'
import { traceSample } from './fixtures.mjs'

const SCHEMA = JSON.parse(readFileSync(new URL('../schemas/trace.json', import.meta.url), 'utf8'))
const EXAMPLE = JSON.parse(readFileSync(new URL('../examples/trace.json', import.meta.url), 'utf8'))
const HEAD = '4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d'
const OTHER = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4'
const NOW = '2026-12-01T10:42:07.000Z'
const KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'pattern',
  'minimum',
  'maxLength',
  'maxItems',
]

// Every enum of the schema, by path, and the list it spells. Merged['by'] has no list in lib/state.ts.
const ENUMS = {
  '$.policy.merge': MERGE_POLICIES,
  '$.policy.approval': CHANNELS,
  '$.place.stage': STAGES,
  '$.place.status': [...STATUS_KINDS, null],
  '$.runs[].role': ROLES,
  '$.verifications[].verdict': VERDICTS,
  '$.verifications[].criteria[].level': CRITERION_LEVELS,
  '$.verifications[].criteria[].result': CRITERION_RESULTS,
  '$.verifications[].rechecks[].result': RECHECK_RESULTS,
  '$.review_findings[].severity': REVIEW_SEVERITIES,
  '$.review_findings[].answers[].result': CANDIDATE_RESULTS,
  '$.review_findings[].rechecks[].result': RECHECK_RESULTS,
  '$.approval.channel': [...CHANNELS, null],
  '$.merged.by': ['driver', 'github'],
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const TYPES = {
  object: isObject,
  array: Array.isArray,
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number',
  integer: Number.isInteger,
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
}

// Each schema node with its path, the node itself first.
function* schemaNodes(schema, path = '$') {
  yield [path, schema]

  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    yield* schemaNodes(child, `${path}.${name}`)
  }

  if (schema.items) {
    yield* schemaNodes(schema.items, `${path}[]`)
  }
}

function assertKnown(schema) {
  for (const [path, node] of schemaNodes(schema)) {
    const unknown = Object.keys(node).filter((keyword) => !KEYWORDS.includes(keyword))

    if (unknown.length > 0) {
      throw new Error(`${path}: the checker does not know ${unknown.join(', ')}`)
    }

    if ('additionalProperties' in node && node.additionalProperties !== false) {
      throw new Error(`${path}: the checker knows only additionalProperties: false`)
    }

    for (const name of [node.type ?? []].flat()) {
      if (!Object.hasOwn(TYPES, name)) {
        throw new Error(`${path}: the checker does not know the type ${name}`)
      }
    }
  }
}

function objectErrors(schema, value, path) {
  const properties = schema.properties ?? {}
  const missing = (schema.required ?? []).filter((name) => !Object.hasOwn(value, name)).map((name) => `${path}.${name}: missing`)
  const extra =
    schema.additionalProperties === false
      ? Object.keys(value)
          .filter((name) => !Object.hasOwn(properties, name))
          .map((name) => `${path}.${name}: not allowed`)
      : []

  const nested = Object.entries(properties)
    .filter(([name]) => Object.hasOwn(value, name))
    .flatMap(([name, child]) => errorsOf(child, value[name], `${path}.${name}`))

  return [...missing, ...extra, ...nested]
}

function arrayErrors(schema, value, path) {
  const tooMany = schema.maxItems !== undefined && value.length > schema.maxItems ? [`${path}: more than ${schema.maxItems} items`] : []
  const items = schema.items ? value.flatMap((item, i) => errorsOf(schema.items, item, `${path}[${i}]`)) : []

  return [...tooMany, ...items]
}

function stringErrors(schema, value, path) {
  const errors = []

  if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
    errors.push(`${path}: does not match ${schema.pattern}`)
  }

  if (schema.maxLength !== undefined && [...value].length > schema.maxLength) {
    errors.push(`${path}: longer than ${schema.maxLength}`)
  }

  return errors
}

function errorsOf(schema, value, path) {
  const errors = []
  const types = [schema.type ?? []].flat()

  if (types.length > 0 && !types.some((name) => TYPES[name](value))) {
    errors.push(`${path}: not ${types.join(' or ')}`)
  }

  if ('const' in schema && value !== schema.const) {
    errors.push(`${path}: not ${JSON.stringify(schema.const)}`)
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not in the enum`)
  }

  if (isObject(value)) {
    errors.push(...objectErrors(schema, value, path))
  }

  if (Array.isArray(value)) {
    errors.push(...arrayErrors(schema, value, path))
  }

  if (typeof value === 'string') {
    errors.push(...stringErrors(schema, value, path))
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: below ${schema.minimum}`)
  }

  return errors
}

// A JSON Schema checker for the eleven keywords schemas/trace.json may use, with standard semantics. Any other
// keyword throws, wherever it is in the schema.
function check(schema, value) {
  assertKnown(schema)

  return errorsOf(schema, value, '$')
}

function traceFrom(sample, now = sample.now) {
  return traceOf(sample.manifest, sample.id, sample.entry, sample.runs, { now })
}

function fields(trace) {
  return trace.missing.map((line) => line.field)
}

function jsonBlock(body) {
  const lines = body.split('\n')
  const open = lines.indexOf('```json')

  return lines.slice(open + 1, lines.indexOf('```', open + 1)).join('\n')
}

function minutesAfter(start, minutes) {
  return new Date(Date.parse(start) + minutes * 60_000).toISOString()
}

function syntheticRun(i) {
  const startedAt = minutesAfter('2026-11-01T00:00:00.000Z', i * 10)

  return {
    id: 'A3',
    role: 'verify',
    step: null,
    effort: 'high',
    model: 'example-model-1',
    requestedModel: 'example-model-0',
    sha: HEAD,
    startedAt,
    endedAt: minutesAfter(startedAt, 5),
    seconds: 300,
    costUsd: 0.5,
    ok: true,
    result: 'PASS',
  }
}

function longFinding(i) {
  const finding = {
    severity: 'medium',
    criterion: `review.criterion-${i}-${'c'.repeat(80)}`,
    title: `Finding ${i} ${'t'.repeat(180)}`,
    file: `src/module-${i}/${'f'.repeat(260)}.ts`,
    line: 1,
    failureScenario: 'A scenario.',
    fix: 'A fix.',
    status: 'new',
  }

  return { ...finding, id: `X${i}`, key: matchKey(finding), result: 'refuted', evidence: 'Evidence.' }
}

// Ten FAIL verdicts of their own heads, each with `criteria` criteria of long ids and `findings` long candidates.
function heavyVerdicts(criteria, findings) {
  return Array.from({ length: 10 }, (_, i) => ({
    verdict: 'FAIL',
    sha: OTHER,
    summary: 'A summary.',
    checklist: [],
    blocking: [],
    nonBlocking: [],
    criteria: Array.from({ length: criteria }, (__, j) => ({
      id: `criterion-${i}-${j}-${'x'.repeat(100)}`,
      level: 'recommended',
      text: 'A text.',
      result: 'pass',
      evidence: 'Evidence.',
    })),
    external: Array.from({ length: findings }, (__, j) => longFinding(i * findings + j)),
    recheck: [],
    at: minutesAfter('2026-12-01T00:00:00.000Z', i),
    run: `A3-${String(i + 1).padStart(2, '0')}-verify`,
  }))
}

test('trace: the sample gives examples/trace.json, key order included, and both pass the schema', () => {
  const trace = traceFrom(traceSample())

  assert.deepEqual(trace, EXAMPLE)
  assert.equal(JSON.stringify(trace), JSON.stringify(EXAMPLE))
  assert.deepEqual(check(SCHEMA, trace), [])
  assert.deepEqual(check(SCHEMA, EXAMPLE), [])
})

test('trace: the body sums up the sample in a header and a table', () => {
  const lines = traceBody(traceFrom(traceSample())).split('\n')

  assert.equal(lines[1], '**Rollout trace** · `merge · waiting: merge-delay` · head `4f1c2d3`')
  assert.deepEqual(lines.slice(3, 10), [
    '| | |',
    '|---|---|',
    '| Runs | 5: 1 brief, 1 implement, 1 fix, 2 verify |',
    '| Cost | 12.34 USD |',
    '| Verified | `4f1c2d3`, PASS |',
    '| External review | 2 findings went to a verifier: 1 confirmed, 1 refuted |',
    '| Approved | by `octocat` at `4f1c2d3` |',
  ])
})

test('trace: a fresh entry with no runs has empty lists, nulls and no missing line', () => {
  const sample = traceSample()
  const trace = traceOf(sample.manifest, 'A1', freshPr(), {}, { now: NOW })

  assert.deepEqual(check(SCHEMA, trace), [])

  for (const list of ['runs', 'verifications', 'review_findings', 'missing']) {
    assert.deepEqual(trace[list], [], list)
  }

  assert.deepEqual(trace.cost, { total_usd: 0, by_role: {} })

  for (const value of [trace.head, trace.verified, trace.review, trace.approval, trace.merged, trace.pr.number, trace.pr.author]) {
    assert.equal(value, null)
  }

  assert.doesNotMatch(traceBody(trace), /\| \| \|/)
})

test('trace: a fact the ledger does not store yet is null, and missing names each kind once', () => {
  const sample = traceSample()

  for (const record of Object.values(sample.runs)) {
    delete record.sha
  }

  delete sample.entry.verdicts[1].recheck[0].fromReview
  delete sample.entry.approved.by
  delete sample.entry.approved.review

  const trace = traceFrom(sample)

  assert.deepEqual(
    trace.runs.map((run) => run.sha),
    [null, null, null, null, null],
  )

  assert.equal(trace.verifications[1].rechecks[0].from_review, null)
  assert.deepEqual(trace.review_findings[0].rechecks, [])
  assert.equal(trace.approval.by, null)
  assert.equal(trace.approval.github_review, null)
  assert.deepEqual(check(SCHEMA, trace), [])
  assert.deepEqual(fields(trace), ['runs.sha', 'verifications.rechecks.from_review', 'approval.by', 'approval.github_review'])
})

test('trace: a stored review null and a run not ended add no missing line', () => {
  const sample = traceSample()

  sample.entry.approved.review = null
  sample.entry.approved.by = null
  sample.runs['A3-03-verify'] = { id: 'A3', role: 'verify', startedAt: '2026-12-01T10:41:00.000Z', endedAt: null, model: null, ok: null }

  const trace = traceFrom(sample)

  assert.deepEqual(fields(trace), ['approval.by'])
  assert.deepEqual(trace.runs.at(-1), {
    run: 'A3-03-verify',
    role: 'verify',
    step: null,
    effort: null,
    model: null,
    sha: null,
    started_at: '2026-12-01T10:41:00.000Z',
    ended_at: null,
    seconds: null,
    cost_usd: 0,
    ok: null,
    result: null,
  })
})

test('trace: an approval read on GitHub has no review id, and its missing line says the driver keeps none', () => {
  const github = traceSample()
  const older = traceSample()
  const reviewLines = (trace) => trace.missing.filter((line) => line.field === 'approval.github_review')

  github.entry.approved = { patchId: '9b2d4e1f', sha: HEAD, at: '2026-12-01T10:40:00.000Z', channel: 'github', by: 'octocat' }
  delete older.entry.approved.review

  const fromGithub = traceFrom(github)

  assert.deepEqual([fromGithub.approval.by, fromGithub.approval.github_review], ['octocat', null])
  assert.deepEqual(check(SCHEMA, fromGithub), [])
  assert.deepEqual(reviewLines(fromGithub), [
    { field: 'approval.github_review', reason: 'the driver keeps no id of a review it read on GitHub' },
  ])

  assert.deepEqual(reviewLines(traceFrom(older)), [
    { field: 'approval.github_review', reason: 'the approval was recorded before the driver stored its GitHub review' },
  ])
})

test('trace: an inbox approval with its login and review id writes both, with no missing line for them', () => {
  const trace = traceFrom(traceSample())

  assert.deepEqual([trace.approval.channel, trace.approval.by, trace.approval.github_review], ['inbox', 'octocat', 7700112233])
  assert.deepEqual(
    fields(trace).filter((field) => field.startsWith('approval.')),
    [],
  )
})

test('trace: an older merged entry gives a trace that passes the schema', () => {
  const sample = traceSample()
  const entry = {
    ...freshPr('merged', '2026-10-01T09:00:00.000Z'),
    status: null,
    pr: 7,
    claimedSha: HEAD,
    merged: { by: 'github', at: '2026-10-02T09:00:00.000Z', sha: OTHER, from: 'merge', verified: true },
    approved: { sha: HEAD, at: '2026-10-01T12:00:00.000Z' },
    verdicts: [],
    verdict: { verdict: 'PASS', sha: HEAD, summary: 'Every item holds.', checklist: [], blocking: [], nonBlocking: [] },
  }

  const runs = { 'B2-01-implement': { id: 'B2', role: 'implement', endedAt: '2026-10-01T10:00:00.000Z' } }
  const trace = traceOf(sample.manifest, 'B2', entry, runs, { now: NOW })

  assert.deepEqual(check(SCHEMA, trace), [])
  assert.deepEqual(trace.place, { stage: 'merged', status: null, code: null })
  assert.deepEqual(trace.verifications, [{ run: null, sha: HEAD, at: null, verdict: 'PASS', blocking: 0, criteria: [], rechecks: [] }])

  assert.deepEqual(trace.approval, {
    channel: null,
    by: null,
    sha: HEAD,
    patch_id: null,
    at: '2026-10-01T12:00:00.000Z',
    github_review: null,
  })

  assert.deepEqual(trace.merged, { sha: OTHER, at: '2026-10-02T09:00:00.000Z', by: 'github' })
  assert.equal(trace.runs[0].started_at, null)
  assert.equal(trace.runs[0].ok, false)
  assert.deepEqual(fields(trace), ['runs.sha', 'approval.by', 'approval.github_review'])
  assert.match(traceBody(trace).split('\n')[1], /^\*\*Rollout trace\*\* · `merged`/)
})

test('trace: a run with no time comes first, and the runs of another PR stay out', () => {
  const sample = traceSample()

  sample.runs['A3-00-delegate'] = { id: 'A3', role: 'delegate', costUsd: 0.25 }

  const trace = traceFrom(sample)

  assert.deepEqual(
    trace.runs.map((run) => run.run),
    ['A3-00-delegate', 'A3-01-brief-write', 'A3-01-implement', 'A3-01-verify', 'A3-01-fix', 'A3-02-verify'],
  )

  assert.deepEqual(trace.cost.by_role, { brief: 1.12, implement: 6.02, fix: 1.9, verify: 3.3, delegate: 0.25 })
  assert.deepEqual(fields(trace), [])
})

test('trace: a sha that is not a full commit is null, with no missing line', () => {
  const sample = traceSample()

  sample.entry.verdicts[0].sha = 'abc1234'
  sample.entry.claimedSha = 'not a commit'
  sample.runs['A3-01-fix'].sha = HEAD.toUpperCase()

  const trace = traceFrom(sample)

  assert.equal(trace.head, null)
  assert.equal(trace.verifications[0].sha, null)
  assert.equal(trace.review_findings[0].answers[0].sha, null)
  assert.equal(trace.runs[3].sha, null)
  assert.equal(trace.review, null)
  assert.deepEqual(fields(trace), [])
})

test('trace: the review shows only for the claimed head, with the manifest key set', () => {
  const sample = traceSample()
  const { externalFindings } = sample.manifest.gates.verify

  sample.manifest.gates.verify.externalFindings = null
  assert.equal(traceFrom(sample).review, null)

  sample.manifest.gates.verify.externalFindings = externalFindings
  sample.entry.review.sha = OTHER
  assert.equal(traceFrom(sample).review, null)

  sample.entry.review.sha = HEAD
  sample.entry.review.reusedFrom = '9f8e7d6'
  sample.entry.review.skipped = `the artifact\nwas ${'gone '.repeat(100)}`

  const review = traceFrom(sample).review

  assert.equal(review.reused_from, '9f8e7d6')
  assert.equal(review.skipped.length, 300)
  assert.ok(review.skipped.startsWith('the artifact was gone'))
  assert.ok(review.skipped.endsWith('…'))

  sample.entry.review.reusedFrom = '../9F8E7D6'
  assert.equal(traceFrom(sample).review.reused_from, null)
})

test('trace: a re-check of a key with no answer in the kept verdicts adds no review finding', () => {
  const sample = traceSample()

  sample.entry.verdicts = [sample.entry.verdicts[1]]

  const trace = traceFrom(sample)

  assert.deepEqual(trace.review_findings, [])
  assert.deepEqual(trace.verifications[0].rechecks, [{ finding: 'F1', result: 'resolved', from_review: true }])
})

test('trace: the JSON block escapes what could close the fence or the details, and reads back with LF or CRLF', () => {
  const sample = traceSample()
  const title = 'A `flag` --> <!-- hidden </details> & more'

  sample.entry.verdicts[0].external[1].title = title

  const trace = traceFrom(sample)
  const body = traceBody(trace)

  assert.equal(trace.review_findings[1].title, title)
  assert.doesNotMatch(jsonBlock(body), /[<>&`]/)
  assert.equal(body.split('</details>').length, 2)
  assert.deepEqual(readTrace(body), trace)
  assert.deepEqual(readTrace(body.replaceAll('\n', '\r\n')), trace)
  assert.deepEqual(check(SCHEMA, trace), [])
})

test('trace: the body opens with the trace marker and ends with the driver marker', () => {
  const body = traceBody(traceFrom(traceSample()))
  const lines = body.split('\n')

  assert.equal(TRACE_MARKER, '<!-- rollout-trace -->')
  assert.equal(lines[0], TRACE_MARKER)
  assert.equal(lines.at(-1), DRIVER_MARKER)
  assert.ok(!body.endsWith('\n'))
  assert.equal(readTrace(lines.slice(1).join('\n')), null)
  assert.equal(readTrace(body.replace('"schema_version": 1,', '"schema_version": 1,,')), null)
  assert.equal(readTrace(`${TRACE_MARKER}\n\n\`\`\`json\n{}`), null)
  assert.equal(readTrace(''), null)
  assert.equal(readTrace(undefined), null)
})

test('trace: over the limit, the oldest runs go first and missing gives their number', () => {
  const sample = traceSample()

  for (let i = 0; i < 400; i += 1) {
    sample.runs[`A3-s${i}-verify`] = syntheticRun(i)
  }

  const all = Object.entries(sample.runs)
    .filter(([, record]) => record.id === 'A3')
    .sort(([, left], [, right]) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    .map(([run]) => run)

  const trace = traceFrom(sample)
  const left = all.length - trace.runs.length
  // With only the kept runs and the newest one left out, even the trace with no missing line is too long.
  const oneMore = Object.fromEntries(all.slice(left - 1).map((run) => [run, sample.runs[run]]))

  assert.ok(traceBody(trace).length <= TRACE_LIMIT)
  assert.ok(left > 0)
  assert.deepEqual(fields(traceOf(sample.manifest, 'A3', sample.entry, oneMore, { now: NOW })), ['runs'])
  assert.deepEqual(
    trace.runs.map((run) => run.run),
    all.slice(left),
  )

  assert.equal(trace.verifications.length, 2)
  assert.equal(trace.review_findings.length, 2)
  assert.equal(trace.cost.by_role.verify, 203.3)
  assert.deepEqual(check(SCHEMA, trace), [])
  assert.deepEqual(fields(trace), ['runs'])
  assert.match(trace.missing[0].reason, new RegExp(`\\b${left}\\b`))
})

test('trace: with no run left, the oldest verifications go before any review finding', () => {
  const sample = traceSample()

  sample.entry.verdicts = heavyVerdicts(30, 4)

  const trace = traceOf(sample.manifest, 'A3', sample.entry, {}, { now: NOW })

  assert.ok(traceBody(trace).length <= TRACE_LIMIT)
  assert.ok(trace.verifications.length > 0 && trace.verifications.length < 10)
  assert.deepEqual(
    trace.verifications.map((verification) => verification.run),
    sample.entry.verdicts.slice(10 - trace.verifications.length).map((verdict) => verdict.run),
  )

  assert.equal(trace.review_findings.length, 40)
  assert.equal(trace.review_findings[0].answers[0].run, 'A3-01-verify')
  assert.deepEqual(fields(trace), ['verifications'])
  assert.match(trace.missing[0].reason, new RegExp(`\\b${10 - trace.verifications.length}\\b`))
  assert.deepEqual(check(SCHEMA, trace), [])
})

test('trace: when the verifications are gone too, the oldest review findings go', () => {
  const sample = traceSample()

  sample.entry.verdicts = heavyVerdicts(1, 12)

  const trace = traceOf(sample.manifest, 'A3', sample.entry, {}, { now: NOW })
  const kept = trace.review_findings.length

  assert.ok(traceBody(trace).length <= TRACE_LIMIT)
  assert.deepEqual(trace.verifications, [])
  assert.ok(kept > 0 && kept < 120)
  assert.equal(trace.review_findings.at(-1).answers[0].id, 'X119')
  assert.deepEqual(fields(trace), ['verifications', 'review_findings'])
  assert.match(trace.missing[1].reason, new RegExp(`\\b${120 - kept}\\b`))
  assert.deepEqual(check(SCHEMA, trace), [])
})

test('trace: a text that holds a denylisted word is null, and its missing line holds neither', () => {
  const sample = traceSample()

  sample.manifest.repo.denylist = ['REFUNDED']

  const trace = traceFrom(sample)
  const body = traceBody(trace)

  assert.equal(trace.review_findings[0].title, null)
  assert.equal(trace.review_findings[1].title, 'A flag named tmp')
  assert.doesNotMatch(body, /refunded/i)
  assert.deepEqual(fields(trace), ['review_findings.title'])
  assert.doesNotMatch(JSON.stringify(trace.missing), /refunded/i)
  assert.deepEqual(check(SCHEMA, trace), [])
})

test('trace: the denylist covers the login and the base, with one line per field', () => {
  const sample = traceSample()

  sample.manifest.repo.denylist = ['OctoCat', 'MAIN', 'src/orders']

  const trace = traceFrom(sample)
  const body = traceBody(trace)

  assert.equal(trace.approval.by, null)
  assert.equal(trace.pr.base, null)
  assert.deepEqual(
    trace.review_findings.map((finding) => finding.file),
    [null, null],
  )

  assert.deepEqual(fields(trace), ['pr.base', 'review_findings.file', 'approval.by'])
  assert.doesNotMatch(body, /octocat|src\/orders/i)
  assert.match(body, /\| Approved \| at `4f1c2d3` \|/)
  assert.deepEqual(check(SCHEMA, trace), [])
})

test('trace: a login or a code that could break the markdown stays out of the header and the table', () => {
  const sample = traceSample()

  sample.entry.approved.by = 'octo`cat|<!--'
  sample.entry.status.code = 'merge`delay'

  const trace = traceFrom(sample)
  const lines = traceBody(trace).split('\n')

  assert.equal(trace.approval.by, 'octo`cat|<!--')
  assert.equal(lines[1], '**Rollout trace** · `merge · waiting` · head `4f1c2d3`')
  assert.ok(lines.includes('| Approved | at `4f1c2d3` |'))
  assert.deepEqual(readTrace(lines.join('\n')), trace)
})

test('trace: the digest leaves out the time of the write and follows every fact', () => {
  const sample = traceSample()
  const first = traceFrom(sample)
  const later = traceFrom(sample, '2026-12-02T08:00:00.000Z')

  assert.notEqual(first.updated_at, later.updated_at)
  assert.match(traceDigest(first), /^[0-9a-f]{64}$/)
  assert.equal(traceDigest(first), traceDigest(later))

  sample.entry.attempts.verify += 1

  assert.notEqual(traceDigest(traceFrom(sample)), traceDigest(first))
})

test('trace: the body of the sample holds none of its prose', () => {
  const sample = traceSample()
  const body = traceBody(traceFrom(sample))
  const verdicts = sample.entry.verdicts
  const prose = [
    ...verdicts.flatMap((verdict) => [verdict.summary, ...verdict.blocking, ...verdict.nonBlocking]),
    ...verdicts.flatMap((verdict) => verdict.checklist.flatMap((item) => [item.item, item.evidence])),
    ...verdicts.flatMap((verdict) => verdict.criteria.flatMap((criterion) => [criterion.text, criterion.evidence])),
    ...verdicts.flatMap((verdict) => verdict.external.flatMap((answer) => [answer.evidence, answer.failureScenario, answer.fix])),
    ...verdicts.flatMap((verdict) => verdict.recheck.flatMap((record) => [record.evidence, record.finding, record.answer.action])),
    ...sample.entry.review.findings.flatMap((finding) => [finding.failureScenario, finding.fix]),
  ]

  assert.equal(prose.length, 24)

  for (const text of prose) {
    assert.ok(!body.includes(text), text)
  }
})

test('trace: the builder leaves its inputs as they were', () => {
  const sample = traceSample()
  const before = structuredClone(sample)
  const trace = traceFrom(sample)

  traceBody(trace)
  traceDigest(trace)

  assert.deepEqual(sample, before)
})

test('trace: the schema uses only the eleven keywords, and every object is closed and fully required', () => {
  for (const [path, node] of schemaNodes(SCHEMA)) {
    assert.deepEqual(
      Object.keys(node).filter((keyword) => !KEYWORDS.includes(keyword)),
      [],
      path,
    )

    if (!node.properties || path === '$.cost.by_role') {
      continue
    }

    assert.equal(node.additionalProperties, false, path)
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), path)
  }

  const byRole = SCHEMA.properties.cost.properties.by_role

  assert.equal(byRole.required, undefined)
  assert.deepEqual(Object.keys(byRole.properties), [...ROLES])

  for (const role of ROLES) {
    assert.deepEqual(byRole.properties[role], { type: 'number', minimum: 0 })
  }
})

test('trace: each enum of the schema spells its list of lib/state.ts, with null where the field is nullable', () => {
  const enums = [...schemaNodes(SCHEMA)].filter(([, node]) => node.enum)

  assert.deepEqual(enums.map(([path]) => path).sort(), Object.keys(ENUMS).sort())

  for (const [path, node] of enums) {
    assert.deepEqual(node.enum, [...ENUMS[path]], path)
    assert.equal([node.type].flat().includes('null'), node.enum.includes(null), path)
  }
})

test('trace: the schema states the limits the builder keeps', () => {
  const finding = SCHEMA.properties.review_findings.items.properties

  assert.equal(finding.criterion.maxLength, 100)
  assert.equal(finding.file.maxLength, 300)
  assert.equal(finding.title.maxLength, 200)
  assert.equal(SCHEMA.properties.review.properties.skipped.maxLength, 300)
  assert.equal(SCHEMA.properties.verifications.maxItems, 10)
  assert.deepEqual(SCHEMA.properties.schema_version, { type: 'integer', const: 1 })
})

test('trace: the checker reports an extra member, a missing one, a wrong enum value and a long title', () => {
  const trace = traceFrom(traceSample())
  const extra = { ...trace, extra: true }
  const { head: _, ...headless } = trace
  const wrong = { ...trace, policy: { ...trace.policy, merge: 'sometimes' } }
  const long = structuredClone(trace)

  long.review_findings[0].title = 't'.repeat(201)

  assert.deepEqual(check(SCHEMA, extra), ['$.extra: not allowed'])
  assert.deepEqual(check(SCHEMA, headless), ['$.head: missing'])
  assert.deepEqual(check(SCHEMA, wrong), ['$.policy.merge: "sometimes" is not in the enum'])
  assert.deepEqual(check(SCHEMA, long), ['$.review_findings[0].title: longer than 200'])
})

test('trace: the checker throws on any other keyword, wherever it is', () => {
  assert.throws(() => check({ type: 'string', format: 'date-time' }, 'now'), /format/)
  assert.throws(() => check({ $schema: 'https://json-schema.org/draft/2020-12/schema' }, {}), /\$schema/)
  assert.throws(() => check({ type: 'object', properties: { at: { type: 'string', description: 'A time.' } } }, {}), /description/)
  assert.throws(() => check({ type: 'array', items: { oneOf: [] } }, []), /oneOf/)
  assert.deepEqual(check({ type: ['integer', 'null'], minimum: 1 }, 0), ['$: below 1'])
  assert.deepEqual(check({ type: 'string', maxLength: 2 }, '😀😀'), [])
})
