import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sourcesFor } from './briefing.mjs'

function template(M, name) {
  return readFileSync(join(M.home, 'prompts', `${name}.md`), 'utf8')
}

function fill(text, values) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in values ? String(values[key]) : whole))
}

function list(items) {
  return items.length > 0 ? items.map((item) => `\`${item}\``).join(', ') : '(none)'
}

// Commands that rewrite files: the implementer runs them, a read-only
// verifier must not (its lint results would describe an auto-fixed tree).
const FIXERS = /lint:fix|--fix\b|--write\b|^pnpm format$|^pnpm install(?!.*--frozen-lockfile)/

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

function common(M, pr, s, { forVerifier = false } = {}) {
  const recipe = verifyRecipe(M, pr, { forVerifier })

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
        : `Add one changeset \`.changeset/<short-slug>.md\` with a **${pr.changeset}** bump for the affected packages (the packages move together in a fixed group). Never major.`,
    changesetBriefRule:
      pr.changeset === 'none'
        ? 'This repo does not use changesets. The brief asks for none and puts the user-visible changes in the PR description skeleton instead.'
        : `One \`.changeset/<name>.md\`, bump \`${pr.changeset}\` (never major: the packages move together in a fixed group), describing public API changes precisely.`,
    verify: recipe.map((step, index) => `   ${index + 1}. \`${step}\``).join('\n'),
    expect: pr.expect.length > 0 ? pr.expect.map((item) => `"${item}"`).join('; ') : 'everything green',
    denylist: M.repo.denylist.length > 0 ? M.repo.denylist.map((word) => `"${word}"`).join(', ') : '(none)',
    pr: s.pr ? `#${s.pr}` : 'not opened yet',
    workflows: pr.allowWorkflows
      ? 'This PR may change `.github/workflows/` (for example to run a new check script in CI); the maintainer reviews that diff separately.'
      : 'This PR must not touch `.github/`. If a new check script should also run in CI, list that under "Out of scope" as a follow-up instead.',
  }
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
    sha,
    ready: JSON.stringify(s.ready, null, 2),
  })
}

export function briefWritePrompt(M, pr, s, answers) {
  return fill(template(M, 'brief-write'), {
    ...common(M, pr, s),
    sources: sourcesFor(M, pr),
    answers: answers ? `## Answers from the maintainer\n\n${answers}\n` : '',
  })
}

export function briefReviewPrompt(M, pr, s, draft) {
  return fill(template(M, 'brief-review'), {
    ...common(M, pr, s),
    sources: sourcesFor(M, pr),
    draft,
  })
}
