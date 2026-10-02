import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourcesFor } from './briefing.mjs'

function template(M, name) {
  return readFileSync(join(M.home, 'prompts', `${name}.md`), 'utf8')
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

export function verifyRecipe(M, pr, { forVerifier = false } = {}) {
  const steps = [...(M.repo.verify.common ?? [])].filter((step) => !forVerifier || !FIXERS.test(step))

  if (pr.smoke && M.repo.verify.smoke) {
    steps.push(M.repo.verify.smoke)
  }

  if (pr.viewer && M.repo.verify.viewer) {
    steps.push(...M.repo.verify.viewer)
  }

  steps.push(...pr.extra)

  return steps
}

function briefText(pr) {
  return existsSync(pr.brief) ? readFileSync(pr.brief, 'utf8') : `(brief file missing: ${pr.brief})`
}

function denylistTerms(M) {
  return M.repo.denylist.length > 0 ? M.repo.denylist.map((word) => `"${word}"`).join(', ') : '(none)'
}

// A private repo drops the public-repository rules but keeps the denylist,
// because the gate still checks it. Every value is fully rendered: fill()
// makes one pass.
function publicRepo(M, terms) {
  if (M.repo.public) {
    return `## Public repository\n\nEverything you write into code, tests, fixtures, commits, changesets and the PR is public. Never mention any of these terms: ${terms}. Never write absolute local paths (like \`/Users/...\`). Describe real-world projects generically ("a large jsdom project").`
  }

  if (M.repo.denylist.length === 0) {
    return ''
  }

  return `## Denylisted terms\n\nNever mention any of these terms in code, tests, fixtures, commits, changesets or the PR: ${terms}.`
}

function publicBriefRule(M, terms) {
  if (M.repo.public) {
    return `- **Public repository.** The implementer's code, comments, tests, changeset, commits and PR text are public. The brief must tell it never to mention client or project names from the plan (${terms}), nor any local path such as \`/Users/...\`. Real-world numbers may appear without names ("a 493-test design system").`
  }

  if (M.repo.denylist.length === 0) {
    return ''
  }

  return `- **Denylist.** The brief must tell the implementer never to mention these terms: ${terms}.`
}

function publicAnswerRule(M, terms) {
  if (M.repo.public) {
    return `- **Public repository.** Your answer reaches an agent that writes public code. It never contains these terms: ${terms}, nor an absolute local path from this machine.`
  }

  if (M.repo.denylist.length === 0) {
    return ''
  }

  return `- **Denylisted terms.** Your answer never contains these terms: ${terms}.`
}

function publicReviewCheck(M, terms) {
  if (M.repo.public) {
    return `, and for client names (${terms}) or local paths in anything the implementer could copy into the public repo`
  }

  if (M.repo.denylist.length === 0) {
    return ''
  }

  return `, and for the denylisted terms (${terms}) in anything the implementer could copy into the repo`
}

function publicVerifyCheck(M, pr) {
  const terms = denylistTerms(M)

  if (M.repo.public) {
    return `, client names (${terms}) or absolute local paths anywhere in the diff or PR text (\`gh pr view ${pr} --json title,body\`)`
  }

  if (M.repo.denylist.length === 0) {
    return ''
  }

  return `, the denylisted terms (${terms}) anywhere in the diff or PR text (\`gh pr view ${pr} --json title,body\`)`
}

function common(M, pr, s, { forVerifier = false } = {}) {
  const recipe = verifyRecipe(M, pr, { forVerifier })
  const terms = denylistTerms(M)

  return {
    id: pr.id,
    title: pr.title,
    rollout: M.rollout,
    github: M.repo.github,
    branch: pr.branch,
    base: M.repo.base,
    label: M.label,
    briefText: briefText(pr),
    deps: pr.deps.length > 0 ? pr.deps.join(', ') : 'none',
    scope: list(pr.scope.length > 0 ? pr.scope : (s.briefScope ?? [])),
    forbid: list(M.repo.forbid),
    changeset: pr.changeset,
    changesetRule:
      pr.changeset === 'none'
        ? 'This repo does not use changesets. Do not add one. Describe user-visible changes in the PR description instead.'
        : `Add one changeset \`.changeset/<short-slug>.md\` with a **${pr.changeset}** bump for the affected packages (the packages move together in a fixed group). Never above ${M.policy.maxBump}.`,
    changesetBriefRule:
      pr.changeset === 'none'
        ? 'This repo does not use changesets. The brief asks for none and puts the user-visible changes in the PR description skeleton instead.'
        : `One \`.changeset/<name>.md\` with a \`${pr.changeset}\` bump, never above \`${M.policy.maxBump}\`. The packages move together in a fixed group. It describes public API changes precisely.`,
    verify: recipe.map((step, index) => `${index + 1}. \`${step}\``).join('\n'),
    expect: pr.expect.length > 0 ? pr.expect.map((item) => `"${item}"`).join('; ') : 'everything green',
    publicRepo: publicRepo(M, terms),
    publicBriefRule: publicBriefRule(M, terms),
    publicReviewCheck: publicReviewCheck(M, terms),
    pr: s.pr ? `#${s.pr}` : 'not opened yet',
    workflows: pr.allowWorkflows
      ? 'This PR may change `.github/workflows/` (for example to run a new check script in CI); the maintainer reviews that diff separately.'
      : 'This PR must not touch `.github/`. If a new check script should also run in CI, list that under "Out of scope" as a follow-up instead.',
  }
}

export function codeScanningNote(M, reasons) {
  return [
    'Code scanning reports new alerts on the PR head:',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    'Fix the code that triggers each alert. Never silence the analyser: no suppression comments, no changes to its configuration or to the workflow that runs it.',
    `Read an alert with \`gh api repos/${M.repo.github}/code-scanning/alerts/<number>\`.`,
    'If you are sure an alert is a false positive, report BLOCKED with kind `code-scanning` and your evidence. Only the maintainer can dismiss an alert on GitHub.',
  ].join('\n')
}

export function implementPrompt(M, pr, s) {
  return fill(template(M, 'implement'), common(M, pr, s))
}

export function fixPrompt(M, pr, s, { reason, note, head }) {
  return fill(template(M, 'fix'), { ...common(M, pr, s), reason, note, head: head ?? 'unknown' })
}

export function resumeFreshPrompt(M, pr, s, { reason, note }) {
  return fill(template(M, 'resume-fresh'), { ...common(M, pr, s), reason, note, implement: implementPrompt(M, pr, s) })
}

export function verifyPrompt(M, pr, s, sha) {
  return fill(template(M, 'verify'), {
    ...common(M, pr, s, { forVerifier: true }),
    pr: s.pr,
    publicVerifyCheck: publicVerifyCheck(M, s.pr),
    sha,
    ready: JSON.stringify(s.ready, null, 2),
  })
}

function answerEntry(entry, index) {
  if (!entry.question) {
    return `### ${index + 1}\n\nA note from the maintainer:\n\n${entry.answer}`
  }

  return `### ${index + 1}\n\nQuestions:\n\n${entry.question}\n\nAnswer:\n\n${entry.answer}`
}

function briefAnswers(s) {
  const answers = s.briefAnswers ?? []

  if (answers.length === 0) {
    return ''
  }

  const intro = "These are the maintainer's answers to earlier drafts of this brief, oldest first. They are decisions: follow them."

  return `${['## Answers from the maintainer', intro, ...answers.map(answerEntry)].join('\n\n')}\n`
}

export function briefWritePrompt(M, pr, s) {
  return fill(template(M, 'brief-write'), {
    ...common(M, pr, s),
    sources: sourcesFor(M, pr),
    answers: briefAnswers(s),
  })
}

export function briefReviewPrompt(M, pr, s, draft) {
  return fill(template(M, 'brief-review'), {
    ...common(M, pr, s),
    sources: sourcesFor(M, pr),
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

function earlierAnswers(s) {
  const history = s.noteHistory ?? []

  return history.length > 0 ? history.map(noteEntry).join('\n\n') : '(none)'
}

export function delegatePrompt(M, pr, s) {
  const blocked = s.blocked ?? {}

  return fill(template(M, 'delegate'), {
    ...common(M, pr, s),
    kind: blocked.kind ?? '',
    question: blocked.question ?? '',
    evidence: blocked.evidence ?? '',
    sources: sourcesFor(M, pr),
    brief: existsSync(pr.brief) ? readFileSync(pr.brief, 'utf8') : 'No brief has been written yet.',
    answers: earlierAnswers(s),
    publicAnswerRule: publicAnswerRule(M, denylistTerms(M)),
  })
}
