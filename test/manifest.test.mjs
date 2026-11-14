import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { loadManifest, validateManifest } from '../lib/manifest.mjs'
import { makeRollout } from './fixtures.mjs'

const base = {
  rollout: 'demo',
  repo: { path: '/tmp/x', github: 'o/r', requiredChecks: ['check'] },
  prs: [
    { id: 'A', branch: 'a', title: 'a', brief: 'a.md', effort: { implement: 'high', verify: 'high' }, changeset: 'minor' },
    { id: 'B', branch: 'b', title: 'b', brief: 'b.md', effort: { implement: 'max', verify: 'xhigh' }, changeset: 'patch', deps: ['A'] },
  ],
}

test('loadManifest: claude from PATH and a public repo by default', () => {
  const manifest = loadManifest(makeRollout())

  assert.equal(manifest.claudeBin, 'claude')
  assert.equal(manifest.repo.public, true)
})

test('loadManifest: an explicit claudeBin still expands ~/', () => {
  const manifest = loadManifest(makeRollout({ manifest: { claudeBin: '~/tools/claude' } }))

  assert.equal(manifest.claudeBin, `${homedir()}/tools/claude`)
})

test('loadManifest: no mcpConfig by default, a given one resolves against the rollout directory and must exist', () => {
  assert.equal(loadManifest(makeRollout()).mcpConfig, null)

  const dir = makeRollout({ manifest: { mcpConfig: 'mcp.json' } })

  assert.throws(() => loadManifest(dir), /mcpConfig .*mcp\.json does not exist/)

  writeFileSync(join(dir, 'mcp.json'), '{"mcpServers":{}}\n')
  assert.equal(loadManifest(dir).mcpConfig, join(dir, 'mcp.json'))
})

test('loadManifest: a PR implements on the rollout model unless its model.implement names another', () => {
  const dir = makeRollout()
  const raw = parse(readFileSync(join(dir, 'manifest.yaml'), 'utf8'))

  raw.model = 'fable'
  raw.prs[1].model = { implement: 'sonnet' }
  writeFileSync(join(dir, 'manifest.yaml'), stringify(raw))

  const manifest = loadManifest(dir)

  assert.equal(manifest.model, 'fable')
  assert.deepEqual(manifest.all[0].model, { implement: 'fable' })
  assert.deepEqual(manifest.all[1].model, { implement: 'sonnet' })
  assert.deepEqual(loadManifest(makeRollout()).all[0].model, { implement: 'opus' })
})

test('validateManifest: a PR model is a mapping of implement only', () => {
  const withModel = (model) => validateManifest({ ...base, prs: [{ ...base.prs[0], model }, base.prs[1]] })

  assert.deepEqual(withModel({ implement: 'sonnet' }), [])
  assert.deepEqual(withModel('sonnet'), ['prs.A.model must be a mapping like { implement: sonnet }'])
  assert.deepEqual(withModel({}), ['prs.A.model.implement must be a model name, such as sonnet'])
  assert.deepEqual(withModel({ implement: '' }), ['prs.A.model.implement must be a model name, such as sonnet'])
  assert.deepEqual(withModel({ implement: 'sonnet', verify: 'haiku' }), [
    "prs.A.model.verify: only implement can differ, every other role runs on the rollout's model",
  ])
})

test('allowClaudeConfig: false by default, and only a boolean when set', () => {
  const withFlag = (allowClaudeConfig) => validateManifest({ ...base, prs: [{ ...base.prs[0], allowClaudeConfig }, base.prs[1]] })

  assert.equal(loadManifest(makeRollout()).all[0].allowClaudeConfig, false)
  assert.deepEqual(withFlag(true), [])
  assert.deepEqual(withFlag(false), [])

  for (const value of ['yes', null]) {
    assert.deepEqual(withFlag(value), ['prs.A.allowClaudeConfig must be true or false'], JSON.stringify(value))
  }
})

test('validateManifest: mcpConfig, when set, is a non-empty path', () => {
  const message = 'mcpConfig must be the path of a JSON file with the MCP servers the agents get'

  for (const mcpConfig of ['', 42, ['mcp.json'], { mcpServers: {} }]) {
    assert.ok(validateManifest({ ...base, mcpConfig }).includes(message), JSON.stringify(mcpConfig))
  }

  assert.ok(!validateManifest({ ...base, mcpConfig: 'mcp.json' }).includes(message))
})

test('validateManifest: a manifest that is not a mapping gets one error', () => {
  for (const raw of [null, undefined, 'demo', [], 42]) {
    assert.deepEqual(validateManifest(raw), ['the manifest must be a mapping with rollout, repo and prs'])
  }
})

test('validateManifest: a prs entry that is not a mapping gets one error', () => {
  const raw = structuredClone(base)

  raw.prs = [null, raw.prs[0]]
  assert.deepEqual(validateManifest(raw), ['prs[0] must be a mapping'])

  raw.prs = ['x']
  assert.deepEqual(validateManifest(raw), ['prs[0] must be a mapping'])
})

test('validateManifest: deps that is not a list is not iterated', () => {
  for (const deps of ['A', 'AB', null, { A: true }]) {
    const raw = structuredClone(base)

    raw.prs[1].deps = deps
    assert.deepEqual(validateManifest(raw), ['prs.B.deps must be a list of PR ids'])
  }
})

test('validateManifest: effort.brief, when set, is a known level', () => {
  for (const brief of ['ultra', null]) {
    const raw = structuredClone(base)

    raw.prs[0].effort.brief = brief
    assert.deepEqual(validateManifest(raw), ['prs.A.effort.brief must be one of low, medium, high, xhigh, max'])
  }

  const raw = structuredClone(base)

  raw.prs[0].effort.brief = 'low'
  assert.deepEqual(validateManifest(raw), [])
  assert.deepEqual(validateManifest(structuredClone(base)), [])
})

test('validateManifest: an empty or comment-only manifest.yaml is an invalid manifest', () => {
  for (const content of ['', '# nothing yet\n']) {
    const dir = makeRollout()

    writeFileSync(join(dir, 'manifest.yaml'), content)
    assert.throws(
      () => loadManifest(dir),
      (error) => !(error instanceof TypeError) && error instanceof Error && /invalid manifest[\s\S]*must be a mapping/.test(error.message),
    )
  }
})

test('loadManifest: the delegate is off by default, has its timeout, and {} turns it on with the defaults', () => {
  const off = loadManifest(makeRollout())

  assert.equal(off.policy.delegate, null)
  assert.equal(off.policy.timeouts.delegate, 30)
  assert.equal(loadManifest(makeRollout({ policy: { delegate: null } })).policy.delegate, null)
  assert.deepEqual(loadManifest(makeRollout({ policy: { delegate: {} } })).policy.delegate, {
    kinds: ['brief-questions', 'needs-decision'],
    maxPerPr: 2,
    effort: 'high',
  })

  assert.deepEqual(loadManifest(makeRollout({ policy: { delegate: { kinds: ['stuck'], maxPerPr: 0 } } })).policy.delegate, {
    kinds: ['stuck'],
    maxPerPr: 0,
    effort: 'high',
  })
})

test('validateManifest: policy.delegate errors', () => {
  const errors = (delegate) => validateManifest({ ...structuredClone(base), policy: { delegate } })
  const cases = [
    ['on', 'policy.delegate must be a mapping, or null to turn it off'],
    [[], 'policy.delegate must be a mapping, or null to turn it off'],
    [false, 'policy.delegate must be a mapping, or null to turn it off'],
    [{ kinds: 'stuck' }, 'policy.delegate.kinds must be a list'],
    [{ kinds: null }, 'policy.delegate.kinds must be a list'],
    [{ kinds: ['ci'] }, 'policy.delegate.kinds: ci is never delegated'],
    [{ kinds: ['environment'] }, 'policy.delegate.kinds: environment is never delegated'],
    [{ kinds: ['closed'] }, 'policy.delegate.kinds: closed is never delegated'],
    [{ kinds: ['gate'] }, 'policy.delegate.kinds: gate is never delegated'],
    [{ kinds: ['code-scanning'] }, 'policy.delegate.kinds: code-scanning is never delegated'],
    [{ kinds: ['needs-decision', 'other'] }, 'policy.delegate.kinds: unknown kind other'],
    [{ maxPerPr: -1 }, 'policy.delegate.maxPerPr must be an integer of 0 or more'],
    [{ maxPerPr: 1.5 }, 'policy.delegate.maxPerPr must be an integer of 0 or more'],
    [{ maxPerPr: '2' }, 'policy.delegate.maxPerPr must be an integer of 0 or more'],
    [{ maxPerPr: null }, 'policy.delegate.maxPerPr must be an integer of 0 or more'],
    [{ effort: 'ultra' }, 'policy.delegate.effort must be one of low, medium, high, xhigh, max'],
    [{ effort: null }, 'policy.delegate.effort must be one of low, medium, high, xhigh, max'],
  ]

  for (const [delegate, error] of cases) {
    assert.deepEqual(errors(delegate), [error], JSON.stringify(delegate))
  }

  for (const delegate of [
    undefined,
    null,
    {},
    { kinds: ['brief-questions', 'needs-decision', 'brief-contradiction', 'stuck'], maxPerPr: 0, effort: 'max' },
  ]) {
    assert.deepEqual(errors(delegate), [], JSON.stringify(delegate))
  }
})

test('loadManifest: policy.notify turns the desktop on by default and merges key by key', () => {
  assert.deepEqual(loadManifest(makeRollout()).policy.notify, { desktop: true, command: null, webhook: null })
  assert.deepEqual(loadManifest(makeRollout({ policy: { notify: { command: 'x' } } })).policy.notify, {
    desktop: true,
    command: 'x',
    webhook: null,
  })
})

test('validateManifest: policy.notify errors', () => {
  const errors = (notify) => validateManifest({ ...structuredClone(base), policy: { notify } })
  const mapping = 'policy.notify must be a mapping with desktop, command and webhook'
  const desktop = 'policy.notify.desktop must be true or false'
  const command = 'policy.notify.command must be a shell command, or null for none'
  const webhook = 'policy.notify.webhook must be an http or https URL, or null for none'
  const cases = [
    [null, mapping],
    ['on', mapping],
    [[], mapping],
    [false, mapping],
    [{ desktop: null }, desktop],
    [{ desktop: 'yes' }, desktop],
    [{ command: '' }, command],
    [{ command: '  ' }, command],
    [{ command: 3 }, command],
    [{ webhook: 'ftp://host/x' }, webhook],
    [{ webhook: 'not a url' }, webhook],
    [{ webhook: '' }, webhook],
    [{ webhook: 3 }, webhook],
    [
      { webhook: 'https://user:pass@hooks.example.com/x' },
      'policy.notify.webhook must have no user name or password, because fetch refuses them',
    ],
    [{ sound: true }, 'policy.notify: unknown key sound'],
  ]

  for (const [notify, error] of cases) {
    assert.deepEqual(errors(notify), [error], JSON.stringify(notify))
  }

  for (const notify of [
    undefined,
    {},
    { desktop: false },
    { command: null, webhook: null },
    { webhook: 'http://127.0.0.1:9/hook' },
    { webhook: 'https://hooks.example.com/x?token=t' },
    { command: 'logger -t rollout "$2"' },
  ]) {
    assert.deepEqual(errors(notify), [], JSON.stringify(notify))
  }
})

// The manifest option of makeRollout replaces repo as a whole.
function withRepo(extra) {
  const dir = makeRollout()
  const file = join(dir, 'manifest.yaml')
  const raw = parse(readFileSync(file, 'utf8'))

  writeFileSync(file, stringify({ ...raw, repo: { ...raw.repo, ...extra } }))

  return dir
}

test('loadManifest: repo.baseQuietPaths defaults to an empty list and keeps a given one', () => {
  assert.deepEqual(loadManifest(makeRollout()).repo.baseQuietPaths, [])
  assert.deepEqual(loadManifest(withRepo({ baseQuietPaths: ['docs/journal/**'] })).repo.baseQuietPaths, ['docs/journal/**'])
})

test('loadManifest: repo.codeScanning defaults to fix at medium, and a partial value keeps the rest', () => {
  assert.deepEqual(loadManifest(makeRollout()).repo.codeScanning, { action: 'fix', minSeverity: 'medium' })
  assert.deepEqual(loadManifest(withRepo({ codeScanning: { action: 'block' } })).repo.codeScanning, {
    action: 'block',
    minSeverity: 'medium',
  })
})

test('validateManifest: repo.baseQuietPaths, when set, is a list of strings', () => {
  const error = 'repo.baseQuietPaths must be a list of path globs'
  const cases = [
    [null, [error]],
    ['docs/journal/**', [error]],
    [['docs/journal/**', 7], [error]],
    [undefined, []],
    [[], []],
    [['docs/journal/**', 'CHANGELOG.md'], []],
  ]

  for (const [baseQuietPaths, errors] of cases) {
    const raw = structuredClone(base)

    raw.repo.baseQuietPaths = baseQuietPaths
    assert.deepEqual(validateManifest(raw), errors, JSON.stringify(baseQuietPaths ?? null))
  }
})

test('loadManifest: repo.ignoredChecks defaults to an empty list and keeps a given one', () => {
  assert.deepEqual(loadManifest(makeRollout()).repo.ignoredChecks, [])
  assert.deepEqual(loadManifest(withRepo({ ignoredChecks: ['Dependabot'] })).repo.ignoredChecks, ['Dependabot'])
})

test('validateManifest: repo.ignoredChecks, when set, is a list of non-empty strings that repo.requiredChecks does not have', () => {
  const list = 'repo.ignoredChecks must be a list of check run names (globs), e.g. [Dependabot]'
  const overlap = 'repo.ignoredChecks: check is also in repo.requiredChecks, and a check cannot be both required and ignored'
  const cases = [
    [null, [list]],
    ['Dependabot', [list]],
    [['Dependabot', 7], [list]],
    [[''], [list]],
    [['  '], [list]],
    [['check'], [overlap]],
    [undefined, []],
    [[], []],
    [['Dependabot'], []],
    [['check*'], []],
  ]

  for (const [ignoredChecks, errors] of cases) {
    const raw = structuredClone(base)

    raw.repo.ignoredChecks = ignoredChecks
    assert.deepEqual(validateManifest(raw), errors, JSON.stringify(ignoredChecks ?? null))
  }
})

test('validateManifest: repo.codeScanning, when set, is a mapping of a known action and severity', () => {
  const cases = [
    [{ action: 'warn' }, ['repo.codeScanning.action must be fix, block or ignore']],
    [{ minSeverity: 'error' }, ['repo.codeScanning.minSeverity must be low, medium, high or critical']],
    ['fix', ['repo.codeScanning must be a mapping with action and minSeverity']],
    [null, ['repo.codeScanning must be a mapping with action and minSeverity']],
    [{ action: 'ignore', minSeverity: 'critical' }, []],
  ]

  for (const [codeScanning, errors] of cases) {
    const raw = structuredClone(base)

    raw.repo.codeScanning = codeScanning
    assert.deepEqual(validateManifest(raw), errors, JSON.stringify(codeScanning))
  }
})

function gatesErrors(gates) {
  const raw = structuredClone(base)

  raw.gates = gates

  return validateManifest(raw)
}

test('validateManifest: gates, when set, is a mapping of brief, ready, preVerify and verify, each a mapping of its keys', () => {
  const cases = [
    [{ preVerify: { scope: true } }, []],
    [{ preVerify: { scope: false } }, []],
    [{ preVerify: {} }, []],
    [{ ready: {} }, []],
    [{ ready: { required: ['npm ci'], recommended: ['npm run lint'] }, preVerify: { scope: true } }, []],
    [{}, []],
    [null, ['gates must be a mapping']],
    [[], ['gates must be a mapping']],
    ['scope', ['gates must be a mapping']],
    [true, ['gates must be a mapping']],
    [{ preMerge: {} }, ['gates: unknown key preMerge']],
    [{ preVerify: null }, ['gates.preVerify must be a mapping']],
    [{ preVerify: [] }, ['gates.preVerify must be a mapping']],
    [{ preVerify: true }, ['gates.preVerify must be a mapping']],
    [{ preVerify: { scope: true, tests: true } }, ['gates.preVerify: unknown key tests']],
    [{ preVerify: { scope: 'yes' } }, ['gates.preVerify.scope must be true or false']],
    [{ preVerify: { scope: null } }, ['gates.preVerify.scope must be true or false']],
    [{ preVerify: { scope: 1 } }, ['gates.preVerify.scope must be true or false']],
    [{ ready: null }, ['gates.ready must be a mapping']],
    [{ ready: [] }, ['gates.ready must be a mapping']],
    [{ ready: 'npm test' }, ['gates.ready must be a mapping']],
    [{ ready: { required: ['npm test'], scope: true } }, ['gates.ready: unknown key scope']],
    [
      { deploy: {}, preVerify: { scope: 'on', brief: true } },
      ['gates: unknown key deploy', 'gates.preVerify: unknown key brief', 'gates.preVerify.scope must be true or false'],
    ],
  ]

  for (const [gates, errors] of cases) {
    assert.deepEqual(gatesErrors(gates), errors, JSON.stringify(gates))
  }
})

test('validateManifest: gates.ready and gates.preVerify required and recommended are lists of non-empty strings', () => {
  const valid = [['npm ci', 'npm test'], ['npm run lint'], [' npm test '], []]
  const invalid = [null, 'npm test', ['npm test', ''], ['  '], ['npm test', 3], [null], { test: 'npm test' }, true]

  for (const stage of ['ready', 'preVerify']) {
    for (const key of ['required', 'recommended']) {
      for (const commands of valid) {
        assert.deepEqual(gatesErrors({ [stage]: { [key]: commands } }), [], `${stage}.${key}: ${JSON.stringify(commands)}`)
      }

      for (const commands of invalid) {
        assert.deepEqual(
          gatesErrors({ [stage]: { [key]: commands } }),
          [`gates.${stage}.${key} must be a list of non-empty strings`],
          `${stage}.${key}: ${JSON.stringify(commands)}`,
        )
      }
    }
  }
})

test('validateManifest: gates.brief is a mapping of a boolean runChecks and the required and recommended criteria', () => {
  const criterion = 'When the PR changes a rule, every file that states the old one is in Expected files.'
  const cases = [
    [{ brief: {} }, []],
    [{ brief: { runChecks: true } }, []],
    [{ brief: { runChecks: false, required: [criterion], recommended: ['The checklist names a command.'] } }, []],
    [{ brief: null }, ['gates.brief must be a mapping']],
    [{ brief: ['B1'] }, ['gates.brief must be a mapping']],
    [{ brief: { runChecks: 'yes' } }, ['gates.brief.runChecks must be true or false']],
    [{ brief: { runChecks: null } }, ['gates.brief.runChecks must be true or false']],
    [{ brief: { runChecks: true, scope: true } }, ['gates.brief: unknown key scope']],
    [{ brief: { criteria: [criterion] } }, ['gates.brief: unknown key criteria']],
  ]

  for (const [gates, errors] of cases) {
    assert.deepEqual(gatesErrors(gates), errors, JSON.stringify(gates))
  }

  const valid = [[criterion], [criterion, 'The checklist names a command.'], [' padded '], []]
  const invalid = [null, criterion, [criterion, ''], ['  '], [criterion, 3], [null], { B1: criterion }, true]

  for (const key of ['required', 'recommended']) {
    for (const criteria of valid) {
      assert.deepEqual(gatesErrors({ brief: { [key]: criteria } }), [], `${key}: ${JSON.stringify(criteria)}`)
    }

    for (const criteria of invalid) {
      assert.deepEqual(
        gatesErrors({ brief: { [key]: criteria } }),
        [`gates.brief.${key} must be a list of non-empty strings`],
        `${key}: ${JSON.stringify(criteria)}`,
      )
    }
  }
})

test('validateManifest: gates.verify, when set, is a mapping of the required and recommended criteria', () => {
  const cases = [
    [{ verify: {} }, []],
    [{ verify: { required: ['A new branch in the code has a test that fails without it.'] } }, []],
    [{ verify: { recommended: ['Docs: every new option has its row.'] } }, []],
    [{ verify: { required: [], recommended: [] } }, []],
    [{ verify: null }, ['gates.verify must be a mapping']],
    [{ verify: [] }, ['gates.verify must be a mapping']],
    [{ verify: 'every branch has a test' }, ['gates.verify must be a mapping']],
    [{ verify: { required: [], scope: true } }, ['gates.verify: unknown key scope']],
    [
      { verify: { criteria: ['a'], required: 'a test per branch' } },
      ['gates.verify: unknown key criteria', 'gates.verify.required must be a list of non-empty strings'],
    ],
  ]

  for (const [gates, errors] of cases) {
    assert.deepEqual(gatesErrors(gates), errors, JSON.stringify(gates))
  }
})

test('validateManifest: gates.verify.required and recommended are lists of non-empty strings', () => {
  const valid = [['A new branch has a test.', 'Docs: every option has its row.'], [' A test per branch '], []]
  const invalid = [null, 'A test per branch.', ['A test per branch.', ''], ['  '], ['A test per branch.', 3], [null], { test: 'a' }, true]

  for (const key of ['required', 'recommended']) {
    for (const criteria of valid) {
      assert.deepEqual(gatesErrors({ verify: { [key]: criteria } }), [], `${key}: ${JSON.stringify(criteria)}`)
    }

    for (const criteria of invalid) {
      assert.deepEqual(
        gatesErrors({ verify: { [key]: criteria } }),
        [`gates.verify.${key} must be a list of non-empty strings`],
        `${key}: ${JSON.stringify(criteria)}`,
      )
    }
  }
})

test('validateManifest: gates.verify.criteriaFrom is a path relative to the repository root', () => {
  const valid = ['criteria.yaml', 'docs/criteria.yaml', 'a..b.yaml']
  const invalid = [
    '/etc/criteria.yaml',
    '~/criteria.yaml',
    '../criteria.yaml',
    'docs/../criteria.yaml',
    '',
    '  ',
    null,
    42,
    true,
    ['criteria.yaml'],
  ]

  for (const criteriaFrom of valid) {
    assert.deepEqual(gatesErrors({ verify: { criteriaFrom } }), [], criteriaFrom)
  }

  for (const criteriaFrom of invalid) {
    assert.deepEqual(
      gatesErrors({ verify: { criteriaFrom } }),
      ['gates.verify.criteriaFrom must be a path relative to the repository root, with no .. segment and no leading / or ~'],
      JSON.stringify(criteriaFrom),
    )
  }
})

test('validateManifest: unknown stages first, then per stage its unknown keys and its type errors in table order', () => {
  assert.deepEqual(
    gatesErrors({
      verify: { catalog: 'plan' },
      preVerify: { recommended: 'lint', tests: ['npm test'], required: [''], scope: 'on' },
      merge: {},
      brief: { required: 'B1', checks: true, runChecks: 'on' },
      ready: { required: 'npm test', tests: [] },
    }),
    [
      'gates: unknown key merge',
      'gates.brief: unknown key checks',
      'gates.brief.runChecks must be true or false',
      'gates.brief.required must be a list of non-empty strings',
      'gates.ready: unknown key tests',
      'gates.ready.required must be a list of non-empty strings',
      'gates.preVerify: unknown key tests',
      'gates.preVerify.scope must be true or false',
      'gates.preVerify.required must be a list of non-empty strings',
      'gates.preVerify.recommended must be a list of non-empty strings',
      'gates.verify: unknown key catalog',
    ],
  )

  assert.deepEqual(gatesErrors({ deploy: { required: ['npm test'] }, preVerify: 'npm test' }), [
    'gates: unknown key deploy',
    'gates.preVerify must be a mapping',
  ])
})

test('loadManifest: every gates key gets its default, and set values are kept', () => {
  const brief = { runChecks: false, required: [], recommended: [] }
  const ready = { required: [], recommended: [] }
  const noCriteria = { required: [], recommended: [], criteriaFrom: null }
  const defaults = { brief, ready, preVerify: { scope: false, required: [], recommended: [] }, verify: noCriteria }
  const set = { scope: true, required: ['npm ci', 'npm test'], recommended: ['npm run lint'] }
  const briefSet = {
    runChecks: true,
    required: ['Every changed rule is in Expected files.'],
    recommended: ['The checklist names a command.'],
  }

  assert.deepEqual(loadManifest(makeRollout()).gates, defaults)
  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: {} } })).gates, defaults)
  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { preVerify: {}, verify: {} } } })).gates, defaults)
  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { ready: {} } } })).gates, defaults)
  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { brief: {} } } })).gates, defaults)
  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { preVerify: { scope: true } } } })).gates, {
    brief,
    ready,
    preVerify: { scope: true, required: [], recommended: [] },
    verify: noCriteria,
  })

  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { preVerify: set } } })).gates, {
    brief,
    ready,
    preVerify: set,
    verify: noCriteria,
  })

  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { preVerify: { recommended: ['npm run lint'] } } } })).gates, {
    brief,
    ready,
    preVerify: { scope: false, required: [], recommended: ['npm run lint'] },
    verify: noCriteria,
  })

  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { ready: { required: ['npm ci', 'npm test'] } } } })).gates, {
    brief,
    ready: { required: ['npm ci', 'npm test'], recommended: [] },
    preVerify: { scope: false, required: [], recommended: [] },
    verify: noCriteria,
  })

  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { ready: { recommended: ['npm run lint'] } } } })).gates, {
    brief,
    ready: { required: [], recommended: ['npm run lint'] },
    preVerify: { scope: false, required: [], recommended: [] },
    verify: noCriteria,
  })

  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { brief: briefSet } } })).gates, {
    brief: briefSet,
    ready,
    preVerify: defaults.preVerify,
    verify: noCriteria,
  })

  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { brief: { runChecks: true } } } })).gates.brief, {
    runChecks: true,
    required: [],
    recommended: [],
  })
})

test('loadManifest: set gates.verify criteria are kept, and a missing level is empty', () => {
  const required = ['A new branch in the code has a test that fails without it.']
  const recommended = ['Docs: every new option has its row.']
  const gatesWith = (verify) => loadManifest(makeRollout({ manifest: { gates: { verify } } })).gates

  assert.deepEqual(gatesWith({ required, recommended }), {
    brief: { runChecks: false, required: [], recommended: [] },
    ready: { required: [], recommended: [] },
    preVerify: { scope: false, required: [], recommended: [] },
    verify: { required, recommended, criteriaFrom: null },
  })

  assert.deepEqual(gatesWith({ required }).verify, { required, recommended: [], criteriaFrom: null })
  assert.deepEqual(gatesWith({ recommended }).verify, { required: [], recommended, criteriaFrom: null })
})

test('loadManifest: gates.verify.criteriaFrom is null by default, and a set path is kept as written', () => {
  const verifyWith = (verify) => loadManifest(makeRollout({ manifest: { gates: { verify } } })).gates.verify

  assert.equal(loadManifest(makeRollout()).gates.verify.criteriaFrom, null)
  assert.equal(verifyWith({ required: ['A test per branch.'] }).criteriaFrom, null)
  assert.deepEqual(verifyWith({ criteriaFrom: 'docs/criteria.yaml' }), {
    required: [],
    recommended: [],
    criteriaFrom: 'docs/criteria.yaml',
  })
})

test('loadManifest: each default list is a new array', () => {
  for (const stage of ['brief', 'ready', 'preVerify', 'verify']) {
    const first = loadManifest(makeRollout()).gates[stage]
    const second = loadManifest(makeRollout()).gates[stage]

    assert.notEqual(first.required, first.recommended, stage)
    assert.notEqual(first.required, second.required, stage)
    first.required.push('npm test')
    assert.deepEqual(second.required, [], stage)
    assert.deepEqual(first.recommended, [], stage)
  }
})

function named(rollout, edit) {
  const raw = structuredClone(base)

  raw.rollout = rollout
  edit(raw)

  return validateManifest(raw)
}

const refused = 'names the rollout my-lib-docs, and the guard refuses every command that does'

test('validateManifest: a branch, title, repo.base or repo.github that names the rollout is refused', () => {
  for (const branch of ['docs/my-lib-docs', 'my-lib-docs/p1', 'feat/my-lib-docs/p1', 'my-lib-docs']) {
    const errors = named('my-lib-docs', (raw) => {
      raw.prs[0].branch = branch
    })

    assert.deepEqual(errors, [`prs.A.branch ${branch} ${refused}: rename the branch`])
  }

  for (const title of ['docs: my-lib-docs site', 'my-lib-docs site']) {
    const errors = named('my-lib-docs', (raw) => {
      raw.prs[0].title = title
    })

    assert.deepEqual(errors, [`prs.A.title "${title}" ${refused}: reword the title`])
  }

  const baseErrors = named('my-lib-docs', (raw) => {
    raw.repo.base = 'my-lib-docs'
  })

  assert.deepEqual(baseErrors, [`repo.base my-lib-docs ${refused}: rename the rollout`])
})

test('validateManifest: the default base main names a rollout called main', () => {
  const errors = named('main', () => {})

  assert.deepEqual(errors, ['repo.base main names the rollout main, and the guard refuses every command that does: rename the rollout'])
})

test('validateManifest: repo.github names the rollout through its owner or its name', () => {
  for (const github of ['example/demo', 'demo/site']) {
    const errors = named('demo', (raw) => {
      raw.repo.github = github
    })

    assert.deepEqual(errors, [
      `repo.github ${github} names the rollout demo, and the guard refuses every command that does: rename the rollout`,
    ])
  }
})

test('validateManifest: the dots of a rollout name match only dots', () => {
  const dotted = named('my-lib-1.2.0', (raw) => {
    raw.prs[0].branch = 'release/my-lib-1.2.0'
  })

  assert.deepEqual(dotted, [
    'prs.A.branch release/my-lib-1.2.0 names the rollout my-lib-1.2.0, and the guard refuses every command that does: rename the branch',
  ])

  const other = named('my-lib-1.2.0', (raw) => {
    raw.prs[0].branch = 'release/my-lib-1x2y0'
  })

  assert.deepEqual(other, [])
})

test('validateManifest: the rollout name inside a longer word is not a name', () => {
  const branches = named('my-lib-docs', (raw) => {
    raw.prs[0].branch = 'my-lib-docs-p1'
    raw.prs[1].branch = 'my-lib-docsy'
    raw.prs.push({ ...structuredClone(raw.prs[0]), id: 'C', branch: 'docs/my-lib-docs-p1', title: 'docs: my-lib-docs-p1 site' })
  })

  assert.deepEqual(branches, [])

  const github = named('demo', (raw) => {
    raw.repo.github = 'example/demo-site'
  })

  assert.deepEqual(github, [])
})

test('validateManifest: a rollout, branch, title, base or repo of any type does not throw', () => {
  for (const value of [7, ['my-lib-docs'], { name: 'my-lib-docs' }, null]) {
    assert.doesNotThrow(() => named(value, () => {}), JSON.stringify(value))

    for (const edit of [
      (raw) => (raw.prs[0].branch = value),
      (raw) => (raw.prs[0].title = value),
      (raw) => (raw.repo.base = value),
      (raw) => (raw.repo.github = value),
    ]) {
      assert.doesNotThrow(() => named('my-lib-docs', edit), JSON.stringify(value))
      assert.doesNotThrow(() => named(7, edit), JSON.stringify(value))
    }
  }
})

test('loadManifest: a rollout that its repository names is an invalid manifest', () => {
  const dir = makeRollout({ manifest: { rollout: 'widgets' } })

  assert.throws(
    () => loadManifest(dir),
    (error) =>
      error.message.startsWith('invalid manifest') &&
      error.message.includes(
        'repo.github example/widgets names the rollout widgets, and the guard refuses every command that does: rename the rollout',
      ),
  )
})

const DEFAULT_HOSTS = [
  'api.anthropic.com',
  'statsig.anthropic.com',
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'registry.npmjs.org',
]

// A rollout with this sandbox mapping, and these keys on top of its repo.
function withSandbox(sandbox, repo = {}) {
  const dir = makeRollout()
  const file = join(dir, 'manifest.yaml')
  const raw = parse(readFileSync(file, 'utf8'))

  writeFileSync(file, stringify({ ...raw, repo: { ...raw.repo, ...repo }, sandbox }))

  return dir
}

function sandboxErrors(sandbox, edit = (raw) => raw) {
  const raw = structuredClone(base)

  raw.sandbox = sandbox

  return validateManifest(edit(raw))
}

test('loadManifest: the host runtime with the default image, token, hosts and limits when sandbox is not set', () => {
  assert.deepEqual(loadManifest(makeRollout()).sandbox, {
    runtime: 'host',
    image: null,
    oauthTokenFile: null,
    allowedDomains: DEFAULT_HOSTS,
    passEnv: [],
    memory: '4g',
    cpus: 2,
    pidsLimit: 512,
  })
})

test('loadManifest: each load gets new sandbox lists, and a given allowedDomains replaces the default one', () => {
  const first = loadManifest(makeRollout()).sandbox
  const second = loadManifest(makeRollout()).sandbox

  assert.notEqual(first.allowedDomains, second.allowedDomains)
  assert.notEqual(first.passEnv, second.passEnv)
  first.allowedDomains.push('example.com')
  first.passEnv.push('ANTHROPIC_API_KEY')
  assert.deepEqual(second.allowedDomains, DEFAULT_HOSTS)
  assert.deepEqual(second.passEnv, [])
  assert.deepEqual(loadManifest(makeRollout()).sandbox.allowedDomains, DEFAULT_HOSTS)
  assert.deepEqual(loadManifest(withSandbox({ allowedDomains: ['github.com'] })).sandbox.allowedDomains, ['github.com'])
})

test('validateManifest: sandbox, when set, is a mapping of known keys, each with a valid value', () => {
  const image = 'sandbox.image must be an image tag without whitespace, such as rollout-agent:2.1.309'
  const hosts = 'sandbox.allowedDomains must be a list of host names, such as api.anthropic.com'
  const memory = 'sandbox.memory must be a size such as 4g or 512m'
  const cpus = 'sandbox.cpus must be a positive number'
  const pids = 'sandbox.pidsLimit must be a positive integer'
  const valid = {
    runtime: 'host',
    image: 'rollout-agent:2.1.309',
    allowedDomains: [],
    passEnv: ['HTTPS_PROXY'],
    memory: '512m',
    cpus: 1.5,
    pidsLimit: 256,
  }

  const cases = [
    [null, ['sandbox must be a mapping']],
    ['docker', ['sandbox must be a mapping']],
    [{ runtime: 'host', network: 'none' }, ['sandbox: unknown key network']],
    [{ runtime: 'podman' }, ['sandbox.runtime must be host or docker']],
    [{ image: '' }, [image]],
    [{ image: 'rollout agent' }, [image]],
    [{ image: null }, [image]],
    [{ oauthTokenFile: '' }, ['sandbox.oauthTokenFile must be the path of a file that holds a Claude Code OAuth token']],
    [{ allowedDomains: 'github.com' }, [hosts]],
    [{ allowedDomains: ['github.com', '-x.example'] }, [hosts]],
    [{ allowedDomains: ['https://github.com'] }, [hosts]],
    [{ passEnv: 'ANTHROPIC_API_KEY' }, ['sandbox.passEnv must be a list of variable names']],
    [
      { passEnv: ['1PASSWORD', 'A-B'] },
      ['sandbox.passEnv: 1PASSWORD is not a variable name', 'sandbox.passEnv: A-B is not a variable name'],
    ],
    [{ passEnv: ['GH_TOKEN', 'PATH'] }, ['sandbox.passEnv: GH_TOKEN is set by the runtime', 'sandbox.passEnv: PATH is set by the runtime']],
    [{ passEnv: ['ROLLOUT_DIR'] }, ['sandbox.passEnv: ROLLOUT_DIR is a rollout variable, and agents get none but ROLLOUT_ROLE']],
    [{ memory: '4' }, [memory]],
    [{ memory: 4 }, [memory]],
    [{ memory: '0g' }, [memory]],
    [{ cpus: 0 }, [cpus]],
    [{ cpus: '2' }, [cpus]],
    [{ pidsLimit: 1.5 }, [pids]],
    [{ pidsLimit: 0 }, [pids]],
    [{}, []],
    [valid, []],
  ]

  for (const [sandbox, errors] of cases) {
    assert.deepEqual(sandboxErrors(sandbox), errors, JSON.stringify(sandbox))
  }
})

test('validateManifest: runtime docker needs a Claude sign-in and repo.agentToken, and refuses mcpConfig', () => {
  const signIn = 'sandbox.runtime docker needs sandbox.oauthTokenFile or ANTHROPIC_API_KEY in sandbox.passEnv, so claude can sign in'
  const bot = 'sandbox.runtime docker needs repo.agentToken: in the container agents act on GitHub only as the bot account'
  const mcp = 'sandbox.runtime docker does not take mcpConfig yet: the container mounts nothing of the rollout directory'
  const withToken = (raw) => ({ ...raw, repo: { ...raw.repo, agentToken: '~/agent-token' } })
  const withMcp = (raw) => ({ ...withToken(raw), mcpConfig: 'mcp.json' })

  assert.deepEqual(sandboxErrors({ runtime: 'docker' }), [signIn, bot])
  assert.deepEqual(sandboxErrors({ runtime: 'docker', oauthTokenFile: 'claude-token' }, withToken), [])
  assert.deepEqual(sandboxErrors({ runtime: 'docker', passEnv: ['ANTHROPIC_API_KEY'] }, withToken), [])
  assert.deepEqual(sandboxErrors({ runtime: 'docker', oauthTokenFile: 'claude-token' }, withMcp), [mcp])
  assert.deepEqual(sandboxErrors({ runtime: 'host' }, withMcp), [])
})

test('loadManifest: under Docker the token file resolves against the rollout directory, must exist and be readable by its owner only', () => {
  const dir = withSandbox({ runtime: 'docker', oauthTokenFile: 'claude-token' }, { agentToken: '~/agent-token' })
  const token = join(dir, 'claude-token')

  assert.throws(
    () => loadManifest(dir),
    (error) => error.message === `sandbox.oauthTokenFile ${token} does not exist`,
  )

  writeFileSync(token, 'synthetic-oauth-token\n')
  chmodSync(token, 0o644)
  assert.throws(
    () => loadManifest(dir),
    (error) => error.message.includes(`chmod 600 ${token}`),
  )

  chmodSync(token, 0o600)
  assert.equal(loadManifest(dir).sandbox.oauthTokenFile, token)
  assert.equal(loadManifest(withSandbox({ oauthTokenFile: '~/tokens/claude' })).sandbox.oauthTokenFile, join(homedir(), 'tokens', 'claude'))
})
