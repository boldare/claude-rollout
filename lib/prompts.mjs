import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourcesFor } from './briefing.mjs'

function template(manifest, name) {
  return readFileSync(join(manifest.home, 'prompts', `${name}.md`), 'utf8')
}

// A multi-line value takes the indent of its placeholder's line, so markdown keeps it inside the list item the
// template puts it in. Prettier would otherwise merge a column-0 value with the steps that follow it.
function fill(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key, offset) => {
    if (!(key in values)) {
      return whole
    }

    const lineStart = text.lastIndexOf('\n', offset) + 1
    const indent = text.slice(lineStart).match(/^[ \t]*/)[0]

    return String(values[key]).replace(/\n(?=[^\n])/g, `\n${indent}`)
  })
}

function list(items) {
  return items.length > 0 ? items.map((item) => `\`${item}\``).join(', ') : '(none)'
}

// Commands that rewrite files: the implementer runs them, a read-only
// verifier must not (its lint results would describe an auto-fixed tree).
const FIXERS =
  /lint:fix|--fix\b|--write\b|^(npm|pnpm|yarn|bun)( run)? format(\s|$)|^(npm|pnpm|yarn|bun) (install|i)\b(?!.*(--frozen-lockfile|--immutable))|^yarn$/

export function verifyRecipe(manifest, pr, { forVerifier = false } = {}) {
  const steps = [...(manifest.repo.verify.common ?? [])].filter((step) => !forVerifier || !FIXERS.test(step))

  if (pr.smoke && manifest.repo.verify.smoke) {
    steps.push(manifest.repo.verify.smoke)
  }

  if (pr.viewer && manifest.repo.verify.viewer) {
    steps.push(...manifest.repo.verify.viewer)
  }

  steps.push(...pr.extra)

  return steps
}

function briefText(pr) {
  return existsSync(pr.brief) ? readFileSync(pr.brief, 'utf8') : `(brief file missing: ${pr.brief})`
}

function denylistTerms(manifest) {
  return manifest.repo.denylist.length > 0 ? manifest.repo.denylist.map((word) => `"${word}"`).join(', ') : '(none)'
}

// A private repo drops the public-repository rules but keeps the denylist,
// because the gate still checks it. Every value is fully rendered: fill()
// makes one pass.
function publicRepo(manifest, terms) {
  if (manifest.repo.public) {
    return `## Public repository\n\nEverything you write into code, tests, fixtures, commits, changesets and the PR is public. Never mention any of these terms: ${terms}. Never write absolute local paths (like \`/Users/...\`). Describe real-world projects generically ("a large jsdom project").`
  }

  if (manifest.repo.denylist.length === 0) {
    return ''
  }

  return `## Denylisted terms\n\nNever mention any of these terms in code, tests, fixtures, commits, changesets or the PR: ${terms}.`
}

function publicBriefRule(manifest, terms) {
  if (manifest.repo.public) {
    return `- **Public repository.** The implementer's code, comments, tests, changeset, commits and PR text are public. The brief must tell it never to mention client or project names from the plan (${terms}), nor any local path such as \`/Users/...\`. Real-world numbers may appear without names ("a 493-test design system").`
  }

  if (manifest.repo.denylist.length === 0) {
    return ''
  }

  return `- **Denylist.** The brief must tell the implementer never to mention these terms: ${terms}.`
}

function publicAnswerRule(manifest, terms) {
  if (manifest.repo.public) {
    return `- **Public repository.** Your answer reaches an agent that writes public code. It never contains these terms: ${terms}, nor an absolute local path from this machine.`
  }

  if (manifest.repo.denylist.length === 0) {
    return ''
  }

  return `- **Denylisted terms.** Your answer never contains these terms: ${terms}.`
}

function publicReviewCheck(manifest, terms) {
  if (manifest.repo.public) {
    return `, and for client names (${terms}) or local paths in anything the implementer could copy into the public repo`
  }

  if (manifest.repo.denylist.length === 0) {
    return ''
  }

  return `, and for the denylisted terms (${terms}) in anything the implementer could copy into the repo`
}

function publicVerifyCheck(manifest, pr) {
  const terms = denylistTerms(manifest)

  if (manifest.repo.public) {
    return `, client names (${terms}) or absolute local paths anywhere in the diff or PR text (\`gh pr view ${pr} --json title,body\`)`
  }

  if (manifest.repo.denylist.length === 0) {
    return ''
  }

  return `, the denylisted terms (${terms}) anywhere in the diff or PR text (\`gh pr view ${pr} --json title,body\`)`
}

// Under `claude -p` the run ends with the turn: a turn ended to wait for
// background work is cut off, and the agent must report at once.
const TURN_RULE =
  'Your run ends when your turn ends, and what you write then is your final report. So never end a turn to wait. Nothing brings you back later, neither a background command nor a background subagent. Run long commands in the foreground, and split a long recipe into calls that each fit the Bash timeout of 600000 ms.'

function common(manifest, pr, entry, { forVerifier = false } = {}) {
  const recipe = verifyRecipe(manifest, pr, { forVerifier })
  const terms = denylistTerms(manifest)

  return {
    id: pr.id,
    title: pr.title,
    rollout: manifest.rollout,
    github: manifest.repo.github,
    branch: pr.branch,
    base: manifest.repo.base,
    label: manifest.label,
    briefText: briefText(pr),
    deps: pr.deps.length > 0 ? pr.deps.join(', ') : 'none',
    scope: list(pr.scope.length > 0 ? pr.scope : (entry.briefScope ?? [])),
    forbid: list(manifest.repo.forbid),
    changeset: pr.changeset,
    changesetRule:
      pr.changeset === 'none'
        ? 'This repo does not use changesets. Do not add one. Describe user-visible changes in the PR description instead.'
        : `Add one changeset \`.changeset/<short-slug>.md\` with a **${pr.changeset}** bump for the affected packages (the packages move together in a fixed group). Never above ${manifest.policy.maxBump}.`,
    changesetBriefRule:
      pr.changeset === 'none'
        ? 'This repo does not use changesets. The brief asks for none and puts the user-visible changes in the PR description skeleton instead.'
        : `One \`.changeset/<name>.md\` with a \`${pr.changeset}\` bump, never above \`${manifest.policy.maxBump}\`. The packages move together in a fixed group. It describes public API changes precisely.`,
    verify: recipe.map((step, index) => `${index + 1}. \`${step}\``).join('\n'),
    expect: pr.expect.length > 0 ? pr.expect.map((item) => `"${item}"`).join('; ') : 'everything green',
    publicRepo: publicRepo(manifest, terms),
    publicBriefRule: publicBriefRule(manifest, terms),
    publicReviewCheck: publicReviewCheck(manifest, terms),
    pr: entry.pr ? `#${entry.pr}` : 'not opened yet',
    turnRule: TURN_RULE,
    workflows: pr.allowWorkflows
      ? 'This PR may change `.github/workflows/` (for example to run a new check script in CI); the maintainer reviews that diff separately.'
      : 'This PR must not touch `.github/`. If a new check script should also run in CI, list that under "Out of scope" as a follow-up instead.',
    claudeConfig: pr.allowClaudeConfig
      ? "This PR may change files under `.claude/`. Agents of this rollout load the project's Claude Code settings, so the maintainer reviews that diff separately."
      : 'This PR must not touch `.claude/`. Agents of this rollout load the project\'s Claude Code settings. If the work needs a change there, list it under "Out of scope" as a follow-up instead.',
  }
}

export function codeScanningNote(manifest, reasons) {
  return [
    'Code scanning reports new alerts on the PR head:',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    'Fix the code that triggers each alert. Never silence the analyser: no suppression comments, no changes to its configuration or to the workflow that runs it.',
    `Read an alert with \`gh api repos/${manifest.repo.github}/code-scanning/alerts/<number>\`.`,
    'If you are sure an alert is a false positive, report BLOCKED with kind `code-scanning` and your evidence. Only the maintainer can dismiss an alert on GitHub.',
  ].join('\n')
}

// `leftovers` is what a verifier that touched the tree left in it, or ''.
export function findingsNote(items, checklist, leftovers) {
  const findings = items.length > 0 ? items.map((item) => `- ${item.id}: ${item.text}`) : ['(none)']
  const failed = checklist.filter((item) => item.status !== 'pass').map((item) => `- ${item.item}: ${item.status}: ${item.evidence}`)
  const tree = leftovers ? ['', 'The verifier left this in the worktree (it has been reset):', leftovers.slice(0, 800)] : []

  return [
    'An independent verifier rejected the PR. Blocking findings:',
    ...findings,
    '',
    'Failed checklist items:',
    ...(failed.length > 0 ? failed : ['(none)']),
    '',
    'In your report, answer every finding with one `addressed` entry whose `id` is the finding id:',
    '- a finding you fixed: `outcome` `fixed`, with the evidence in `action` (file:line, a test or command output)',
    '- a finding you dispute: `outcome` `disputed`, with your reason in `action`',
    '',
    'The next verifier re-checks each finding against your answer. A disputed finding it still finds open goes to the maintainer.',
    ...tree,
  ].join('\n')
}

// A brief written before its dependencies merged saw their verified heads.
// One that merged with other changes may have moved what the brief describes.
function briefDriftNote(entry) {
  const drift = entry.briefDrift ?? []

  if (drift.length === 0) {
    return ''
  }

  const intro =
    'The brief was written before these dependencies merged, against their verified heads. They changed before they merged, so the parts of the brief about their code may be out of date. Where the brief and the code disagree, the code wins.'

  const items = drift.map((item) => `- ${item.id}: the brief saw \`${item.sha.slice(0, 7)}\`.`)

  return `${['## The brief and its dependencies', intro, items.join('\n')].join('\n\n')}\n\n`
}

export function implementPrompt(manifest, pr, entry) {
  return fill(template(manifest, 'implement'), {
    ...common(manifest, pr, entry),
    briefDrift: briefDriftNote(entry),
    decisions: decisions(entry),
  })
}

export function fixPrompt(manifest, pr, entry, { reason, note, head }) {
  return fill(template(manifest, 'fix'), { ...common(manifest, pr, entry), reason, note, head: head ?? 'unknown' })
}

export function resumeFreshPrompt(manifest, pr, entry, { reason, note }) {
  return fill(template(manifest, 'resume-fresh'), {
    ...common(manifest, pr, entry),
    reason,
    note,
    implement: implementPrompt(manifest, pr, entry),
  })
}

export function verifyPrompt(manifest, pr, entry, sha) {
  return fill(template(manifest, 'verify'), {
    ...common(manifest, pr, entry, { forVerifier: true }),
    pr: entry.pr,
    publicVerifyCheck: publicVerifyCheck(manifest, entry.pr),
    sha,
    ready: JSON.stringify(entry.ready, null, 2),
    decisions: decisions(entry),
    findings: findingsToRecheck(entry),
  })
}

function findingSection(item) {
  const answer = item.answer ? `Answer (${item.answer.outcome}):\n\n${item.answer.action}` : 'No answer from the implementer.'

  return `### ${item.id}\n\nFinding:\n\n${item.text}\n\n${answer}`
}

// Unlike the decisions, these are claims: the verifier checks each one, as
// it checks the READY report.
function findingsToRecheck(entry) {
  const items = entry.findings?.items ?? []

  if (items.length === 0) {
    return ''
  }

  const intro =
    "These are the previous verifier's blocking findings, each with the implementer's answer. They are claims to check, not decisions."

  return `${['## Findings to re-check', intro, ...items.map(findingSection)].join('\n\n')}\n`
}

function answerSection(briefAnswer, index) {
  if (!briefAnswer.question) {
    return `### ${index + 1}\n\nA note from the maintainer:\n\n${briefAnswer.answer}`
  }

  return `### ${index + 1}\n\nQuestions:\n\n${briefAnswer.question}\n\nAnswer:\n\n${briefAnswer.answer}`
}

function briefAnswers(entry) {
  const answers = entry.briefAnswers ?? []

  if (answers.length === 0) {
    return ''
  }

  const intro = "These are the maintainer's answers to earlier drafts of this brief, oldest first. They are decisions: follow them."

  return `${['## Answers from the maintainer', intro, ...answers.map(answerSection)].join('\n\n')}\n`
}

// Where the brief writers' worktree stands. Dependencies that are verified
// but not merged yet are merged into it locally and can still change.
function briefWorktree(manifest, pr, heads) {
  const base = `\`origin/${manifest.repo.base}\``
  const merged = pr.deps.filter((dep) => !heads.some((head) => head.id === dep))

  if (heads.length === 0) {
    return `at ${base}, which already contains the merged dependencies (${merged.length > 0 ? merged.join(', ') : 'none'})`
  }

  const ahead = heads.map((head) => `${head.id} at \`${head.sha.slice(0, 7)}\``).join(', ')
  const already = merged.length > 0 ? ` Merged already: ${merged.join(', ')}.` : ''

  return `at ${base} with the dependencies that are verified but not merged yet merged into it locally: ${ahead}.${already} They can still change before they merge`
}

export function briefWritePrompt(manifest, pr, entry, heads = []) {
  return fill(template(manifest, 'brief-write'), {
    ...common(manifest, pr, entry),
    briefWorktree: briefWorktree(manifest, pr, heads),
    sources: sourcesFor(manifest, pr),
    answers: briefAnswers(entry),
  })
}

export function briefReviewPrompt(manifest, pr, entry, draft, heads = []) {
  return fill(template(manifest, 'brief-review'), {
    ...common(manifest, pr, entry),
    briefWorktree: briefWorktree(manifest, pr, heads),
    sources: sourcesFor(manifest, pr),
    draft,
  })
}

function noteEntry(entry, index) {
  const who = entry.by === 'delegate' ? 'the delegate' : 'the maintainer'
  const heading = entry.kind ? `### ${index + 1}. From ${who}, on ${entry.kind}` : `### ${index + 1}. From ${who}`

  if (!entry.question) {
    return `${heading}\n\nNote:\n\n${entry.text}`
  }

  return `${heading}\n\nQuestion:\n\n${entry.question}\n\nAnswer:\n\n${entry.text}`
}

function earlierAnswers(entry) {
  const history = entry.noteHistory ?? []

  return history.length > 0 ? history.map(noteEntry).join('\n\n') : '(none)'
}

// Every entry renders, answers to brief questions included. A note queued
// while the brief writer ran is older than the brief and reaches the
// implementer only here.
function decisions(entry) {
  const history = entry.noteHistory ?? []

  if (history.length === 0) {
    return ''
  }

  const intro =
    "The driver recorded these notes from the maintainer, and answers from the delegate on the maintainer's behalf, oldest first. They are decisions. Where one conflicts with the brief, the decision wins. Where two conflict, the later one wins."

  return `${['## Decisions after the brief', intro, ...history.map(noteEntry)].join('\n\n')}\n`
}

export function delegatePrompt(manifest, pr, entry) {
  const blocked = entry.blocked ?? {}

  return fill(template(manifest, 'delegate'), {
    ...common(manifest, pr, entry),
    kind: blocked.kind ?? '',
    question: blocked.question ?? '',
    evidence: blocked.evidence ?? '',
    sources: sourcesFor(manifest, pr),
    brief: existsSync(pr.brief) ? readFileSync(pr.brief, 'utf8') : 'No brief has been written yet.',
    answers: earlierAnswers(entry),
    publicAnswerRule: publicAnswerRule(manifest, denylistTerms(manifest)),
  })
}
