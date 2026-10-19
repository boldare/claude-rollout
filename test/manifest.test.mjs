import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
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

test('validateManifest: gates, when set, is a mapping of preVerify, a mapping of a boolean scope and the required and recommended commands', () => {
  const cases = [
    [{ preVerify: { scope: true } }, []],
    [{ preVerify: { scope: false } }, []],
    [{ preVerify: {} }, []],
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
    [
      { ready: {}, preVerify: { scope: 'on', brief: true } },
      ['gates: unknown key ready', 'gates.preVerify: unknown key brief', 'gates.preVerify.scope must be true or false'],
    ],
  ]

  for (const [gates, errors] of cases) {
    assert.deepEqual(gatesErrors(gates), errors, JSON.stringify(gates))
  }
})

test('validateManifest: gates.preVerify.required and recommended are lists of non-empty strings', () => {
  const valid = [['npm ci', 'npm test'], ['npm run lint'], [' npm test '], []]
  const invalid = [null, 'npm test', ['npm test', ''], ['  '], ['npm test', 3], [null], { test: 'npm test' }, true]

  for (const key of ['required', 'recommended']) {
    for (const commands of valid) {
      assert.deepEqual(gatesErrors({ preVerify: { [key]: commands } }), [], `${key}: ${JSON.stringify(commands)}`)
    }

    for (const commands of invalid) {
      assert.deepEqual(
        gatesErrors({ preVerify: { [key]: commands } }),
        [`gates.preVerify.${key} must be a list of non-empty strings`],
        `${key}: ${JSON.stringify(commands)}`,
      )
    }
  }
})

test('validateManifest: unknown stages first, then per stage its unknown keys and its type errors in table order', () => {
  assert.deepEqual(
    gatesErrors({
      verify: { criteriaFrom: 'plan' },
      preVerify: { recommended: 'lint', tests: ['npm test'], required: [''], scope: 'on' },
      brief: {},
    }),
    [
      'gates: unknown key verify',
      'gates: unknown key brief',
      'gates.preVerify: unknown key tests',
      'gates.preVerify.scope must be true or false',
      'gates.preVerify.required must be a list of non-empty strings',
      'gates.preVerify.recommended must be a list of non-empty strings',
    ],
  )

  assert.deepEqual(gatesErrors({ ready: { required: ['npm test'] }, preVerify: 'npm test' }), [
    'gates: unknown key ready',
    'gates.preVerify must be a mapping',
  ])
})

test('loadManifest: every gates key gets its default, and set values are kept', () => {
  const defaults = { preVerify: { scope: false, required: [], recommended: [] } }
  const set = { scope: true, required: ['npm ci', 'npm test'], recommended: ['npm run lint'] }

  assert.deepEqual(loadManifest(makeRollout()).gates, defaults)
  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: {} } })).gates, defaults)
  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { preVerify: {} } } })).gates, defaults)
  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { preVerify: { scope: true } } } })).gates, {
    preVerify: { scope: true, required: [], recommended: [] },
  })

  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { preVerify: set } } })).gates, { preVerify: set })
  assert.deepEqual(loadManifest(makeRollout({ manifest: { gates: { preVerify: { recommended: ['npm run lint'] } } } })).gates, {
    preVerify: { scope: false, required: [], recommended: ['npm run lint'] },
  })
})

test('loadManifest: each default list is a new array', () => {
  const first = loadManifest(makeRollout()).gates.preVerify
  const second = loadManifest(makeRollout()).gates.preVerify

  assert.notEqual(first.required, first.recommended)
  assert.notEqual(first.required, second.required)
  first.required.push('npm test')
  assert.deepEqual(second.required, [])
  assert.deepEqual(first.recommended, [])
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
