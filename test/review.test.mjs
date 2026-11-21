import { test } from 'node:test'
import assert from 'node:assert/strict'
import { artifactName, candidates, matchKey, MAX_FINDINGS, parseReview, REVIEW_ARTIFACT, REVIEW_FILE } from '../lib/review.ts'
import { REVIEW_SEVERITIES } from '../lib/state.ts'

const REVISION = '4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d'

const LOW = {
  severity: 'low',
  criterion: 'review.naming',
  title: 'A flag named tmp',
  file: 'src/orders/total.ts',
  line: 12,
  failure_scenario: 'The next reader cannot tell what it guards.',
  fix: 'Name it after the condition.',
  status: 'open',
}

const HIGH = {
  severity: 'high',
  criterion: 'review.correctness',
  title: 'The total ignores a refunded line',
  file: 'src/orders/total.ts',
  line: 42,
  failure_scenario: 'An order with one refunded line shows the full price.',
  fix: 'Skip a line whose refund is settled.',
  status: 'new',
  refutation: 'Not read.',
}

const SAMPLE = {
  schema_version: 1,
  revision: REVISION,
  input_digest: '9b2d',
  findings: [LOW, HIGH],
  fixed: [],
  dropped: [],
}

function sample(changes = {}) {
  return JSON.stringify({ ...SAMPLE, ...changes })
}

function read(changes = {}, sha = REVISION) {
  return parseReview(sample(changes), { sha })
}

function reason(changes = {}, sha = REVISION) {
  const result = read(changes, sha)

  assert.equal(result.available, false, JSON.stringify(result))

  return result.reason
}

function finding(severity, title, extra = {}) {
  return { ...LOW, severity, title, ...extra }
}

function mapped(item) {
  return {
    severity: item.severity,
    criterion: item.criterion,
    title: item.title,
    file: item.file,
    line: item.line,
    failureScenario: item.failure_scenario,
    fix: item.fix,
    status: item.status,
  }
}

test('parseReview: the sample becomes a ReviewFile, high first, and the fields it does not read leave no trace', () => {
  assert.deepEqual(read(), {
    available: true,
    review: {
      reusedFrom: null,
      findings: [
        {
          severity: 'high',
          criterion: 'review.correctness',
          title: 'The total ignores a refunded line',
          file: 'src/orders/total.ts',
          line: 42,
          failureScenario: 'An order with one refunded line shows the full price.',
          fix: 'Skip a line whose refund is settled.',
          status: 'new',
        },
        {
          severity: 'low',
          criterion: 'review.naming',
          title: 'A flag named tmp',
          file: 'src/orders/total.ts',
          line: 12,
          failureScenario: 'The next reader cannot tell what it guards.',
          fix: 'Name it after the condition.',
          status: 'open',
        },
      ],
      fixed: [],
      leftOut: 0,
    },
  })
})

test('parseReview: the head may start with a revision of 7 characters, and any other revision is refused', () => {
  assert.equal(read({ revision: REVISION.slice(0, 7) }).available, true)
  assert.equal(reason({ revision: '1a2b3c4d5e' }), 'revision 1a2b3c4 is not the head')
  assert.equal(reason({ revision: REVISION.slice(0, 6) }), 'revision is shorter than 7 characters')
  assert.equal(reason({ revision: undefined }), 'revision is missing or not a string')
  assert.equal(reason({ revision: 42 }), 'revision is missing or not a string')
  assert.equal(reason({}, '9'.repeat(40)), 'revision 4f1c2d3 is not the head')
})

test('parseReview: a file that is not JSON, not an object or of another schema version is refused', () => {
  assert.equal(reason({ schema_version: 2 }), 'schema_version is not 1')
  assert.equal(reason({ schema_version: '1' }), 'schema_version is not 1')
  assert.equal(reason({ schema_version: undefined }), 'schema_version is not 1')

  const cases = [
    ['{"schema_version": 1,', 'review.json is not JSON'],
    ['', 'review.json is not JSON'],
    ['[]', 'review.json is not an object'],
    ['null', 'review.json is not an object'],
    ['"review"', 'review.json is not an object'],
  ]

  for (const [text, expected] of cases) {
    assert.deepEqual(parseReview(text, { sha: REVISION }), { available: false, reason: expected }, text)
  }
})

test('parseReview: reused_from and the two lists must have their types', () => {
  assert.equal(reason({ reused_from: 7 }), 'reused_from is not a string')
  assert.equal(reason({ findings: undefined }), 'findings is missing or not a list')
  assert.equal(reason({ findings: {} }), 'findings is missing or not a list')
  assert.equal(reason({ fixed: undefined }), 'fixed is missing or not a list')
  assert.equal(reason({ fixed: 'none' }), 'fixed is missing or not a list')
  assert.equal(reason({ findings: [LOW, 'a finding'] }), 'findings[1] is not an object')
  assert.equal(reason({ fixed: [null] }), 'fixed[0] is not an object')
  assert.equal(reason({ fixed: [[]] }), 'fixed[0] is not an object')
})

test('parseReview: an item without a required field, or with a value outside its range, is refused with the field', () => {
  const { title: _, ...untitled } = HIGH
  const nowhere = { ...LOW, file: undefined }

  const cases = [
    [{ findings: [untitled] }, 'findings[0].title is missing or not a string'],
    [{ findings: [{ ...HIGH, severity: 'critical' }] }, 'findings[0].severity is not high, medium or low'],
    [{ findings: [{ ...HIGH, line: 0 }] }, 'findings[0].line is not a whole number of 1 or more'],
    [{ findings: [{ ...HIGH, line: '12' }] }, 'findings[0].line is not a whole number of 1 or more'],
    [{ findings: [{ ...HIGH, line: 1.5 }] }, 'findings[0].line is not a whole number of 1 or more'],
    [{ findings: [{ ...HIGH, status: 'closed' }] }, 'findings[0].status is not new or open'],
    [{ findings: [{ ...HIGH, status: null }] }, 'findings[0].status is not new or open'],
    [{ findings: [LOW, { ...HIGH, criterion: 7 }] }, 'findings[1].criterion is missing or not a string'],
    [{ findings: [{ ...HIGH, failure_scenario: null }] }, 'findings[0].failure_scenario is missing or not a string'],
    [{ findings: [{ ...HIGH, fix: undefined }] }, 'findings[0].fix is missing or not a string'],
    [{ fixed: [nowhere] }, 'fixed[0].file is missing or not a string'],
  ]

  for (const [changes, expected] of cases) {
    assert.equal(reason(changes), expected)
  }
})

test('parseReview: findings are checked before fixed, and each item field by field in the order of the contract', () => {
  const broken = { severity: 'critical', title: 3, line: 0, status: 'closed' }

  assert.equal(reason({ findings: [LOW, broken], fixed: [broken] }), 'findings[1].severity is not high, medium or low')
  assert.equal(reason({ findings: [{ ...broken, severity: 'low' }] }), 'findings[0].criterion is missing or not a string')
  assert.equal(reason({ findings: [{ ...HIGH, line: 0, status: 'closed' }] }), 'findings[0].line is not a whole number of 1 or more')
  assert.equal(reason({ findings: [LOW], fixed: [{ ...broken, severity: 'low' }] }), 'fixed[0].criterion is missing or not a string')
  assert.equal(reason({ findings: [broken], fixed: 'none' }), 'fixed is missing or not a list')
})

test('parseReview: an item of fixed gets no status check and keeps a null status, and the review. prefix is never checked', () => {
  const result = read({
    findings: [],
    fixed: [
      { ...LOW, status: 'closed' },
      { ...HIGH, criterion: 'naming', status: undefined },
    ],
  })

  assert.deepEqual(result.review.fixed, [
    { ...mapped(HIGH), criterion: 'naming', status: null },
    { ...mapped(LOW), status: null },
  ])
})

test('parseReview: reused_from comes back as reusedFrom, and null or absent is null', () => {
  assert.equal(read({ reused_from: 'a0b1c2d3e4f5' }).review.reusedFrom, 'a0b1c2d3e4f5')
  assert.equal(read({ reused_from: null }).review.reusedFrom, null)
  assert.equal(read().review.reusedFrom, null)
})

test('parseReview: each text over its limit is cut to exactly its limit and ends with …, and one at its limit stays as it is', () => {
  const limits = [
    ['criterion', 'criterion', 100],
    ['title', 'title', 200],
    ['file', 'file', 300],
    ['failure_scenario', 'failureScenario', 1000],
    ['fix', 'fix', 1000],
  ]

  for (const [field, member, limit] of limits) {
    const long = read({ findings: [{ ...HIGH, [field]: `${'x'.repeat(limit)} tail` }] }).review.findings[0][member]
    const exact = read({ findings: [{ ...HIGH, [field]: ` ${'y'.repeat(limit - 2)} ` }] }).review.findings[0][member]
    const cutFixed = read({ fixed: [{ ...HIGH, [field]: 'z'.repeat(limit + 1) }] }).review.fixed[0][member]

    assert.equal(long.length, limit, field)
    assert.equal(long, `${'x'.repeat(limit - 1)}…`, field)
    assert.equal(exact, ` ${'y'.repeat(limit - 2)} `, field)
    assert.equal(cutFixed, `${'z'.repeat(limit - 1)}…`, field)
  }

  assert.equal(read({ reused_from: 'r'.repeat(65) }).review.reusedFrom, `${'r'.repeat(63)}…`)
  assert.equal(read({ reused_from: 'r'.repeat(64) }).review.reusedFrom, 'r'.repeat(64))
})

test('parseReview: of 60 findings, 50 are kept by severity in the file order, and leftOut counts the rest', () => {
  const lows = Array.from({ length: 50 }, (_, i) => finding('low', `low ${i}`))
  const highs = Array.from({ length: 10 }, (_, i) => finding('high', `high ${i}`))
  const { review } = read({ findings: [...lows, ...highs] })

  assert.equal(MAX_FINDINGS, 50)
  assert.equal(review.findings.length, 50)
  assert.deepEqual(
    review.findings.map((item) => item.title),
    [...highs, ...lows.slice(0, 40)].map((item) => item.title),
  )

  assert.equal(review.leftOut, 10)
})

test('parseReview: 60 items of fixed keep 50 by severity, and what they drop is not counted', () => {
  const fixed = Array.from({ length: 60 }, (_, i) => finding(i % 3 === 0 ? 'medium' : 'low', `fixed ${i}`))
  const { review } = read({ fixed })
  const mediums = fixed.filter((item) => item.severity === 'medium')
  const lows = fixed.filter((item) => item.severity === 'low')

  assert.equal(review.fixed.length, 50)
  assert.deepEqual(
    review.fixed.map((item) => item.title),
    [...mediums, ...lows].slice(0, 50).map((item) => item.title),
  )

  assert.equal(review.leftOut, 0)
})

test('matchKey: case and runs of white space make no difference, the file and the title do, and the line never does', () => {
  const key = matchKey({ criterion: 'review.correctness', file: 'src/orders/total.ts', title: 'The total ignores a refunded line' })

  assert.equal(key, 'review.correctness\nsrc/orders/total.ts\nthe total ignores a refunded line')
  assert.equal(matchKey({ ...mapped(HIGH), title: 'The  TOTAL ignores\ta\n refunded line' }), key)
  assert.equal(matchKey({ ...mapped(HIGH), line: 7 }), key)
  assert.equal(matchKey({ ...mapped(HIGH), criterion: 'Review.Correctness' }), key)
  assert.notEqual(matchKey({ ...mapped(HIGH), file: 'src/orders/refund.ts' }), key)
  assert.notEqual(matchKey({ ...mapped(HIGH), title: 'The total ignores a refunded order' }), key)
  assert.notEqual(matchKey({ ...mapped(HIGH), title: ' The total ignores a refunded line' }), key)
})

test('candidates: splits at minSeverity, each list high first and in the file order', () => {
  const findings = [
    mapped(finding('low', 'low 1')),
    mapped(finding('medium', 'medium 1')),
    mapped(finding('high', 'high 1')),
    mapped(finding('low', 'low 2')),
    mapped(finding('high', 'high 2')),
    mapped(finding('medium', 'medium 2')),
  ]

  const titles = (list) => list.map((item) => item.title)
  const medium = candidates({ findings }, 'medium')

  assert.deepEqual(Object.keys(medium).sort(), ['below', 'candidates'])
  assert.deepEqual(titles(medium.candidates), ['high 1', 'high 2', 'medium 1', 'medium 2'])
  assert.deepEqual(titles(medium.below), ['low 1', 'low 2'])

  const low = candidates({ findings }, 'low')

  assert.deepEqual(titles(low.candidates), ['high 1', 'high 2', 'medium 1', 'medium 2', 'low 1', 'low 2'])
  assert.deepEqual(low.below, [])

  const high = candidates({ findings }, 'high')

  assert.deepEqual(titles(high.candidates), ['high 1', 'high 2'])
  assert.deepEqual(titles(high.below), ['medium 1', 'medium 2', 'low 1', 'low 2'])
  assert.deepEqual(candidates({ findings: [] }, 'medium'), { candidates: [], below: [] })
})

test('artifactName puts the PR number in for every {pr}, and the severities are high, medium and low', () => {
  assert.equal(artifactName('review-{pr}', 11), 'review-11')
  assert.equal(artifactName(REVIEW_ARTIFACT, 7), 'review-7')
  assert.equal(artifactName('{pr}-review-{pr}', 3), '3-review-3')
  assert.equal(artifactName('agent-review', 3), 'agent-review')
  assert.equal(REVIEW_FILE, 'review.json')
  assert.deepEqual(REVIEW_SEVERITIES, ['high', 'medium', 'low'])
})
