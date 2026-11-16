import { WAY_OUT } from './state.ts'
import type { Hold, ShownStatus, WayOut } from './state.ts'

// One sentence and one way out per status, so the CLI and the UI print the
// same text. Pure: no I/O and no clock. The data comes from ledgers of any
// age, so an empty value drops its part instead of printing a gap.

export interface SentenceFacts {
  id: string
  // manifest.repo.base
  base: string
  // The hold a held status names: the PR's own for scope pr, the rollout's for scope rollout.
  hold: Hold | null
}

type Code = ShownStatus['code']
type StatusOf<Shown extends Code> = Extract<ShownStatus, { code: Shown }>
type Sentences = { [Shown in Code]: (status: StatusOf<Shown>, facts: SentenceFacts) => string }
type Sentence = (status: ShownStatus, facts: SentenceFacts) => string
type WayOutKind = WayOut | 'release'

const SHA_LENGTH = 7

// UTC, so a test's expected text does not depend on the machine's time zone.
export function timeText(iso: string): string {
  const time = typeof iso === 'string' && iso !== '' ? new Date(iso) : null

  if (!time || Number.isNaN(time.getTime())) {
    return 'an unknown time'
  }

  return `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function mergedSentence(sha: string | null): string {
  return sha ? `merged as ${sha.slice(0, SHA_LENGTH)}` : 'merged'
}

function shortSha(sha: string): string {
  return sha ? sha.slice(0, SHA_LENGTH) : 'the head'
}

function joined(items: readonly string[] | null | undefined): string {
  return (items ?? []).filter(Boolean).join(', ')
}

// The part with what holds it, or nothing when the value is empty.
function part(before: string, value: string | number | null | undefined, after = ''): string {
  return value ? `${before}${value}${after}` : ''
}

function firstLine(text: string | null | undefined): string {
  return (
    (text ?? '')
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  )
}

function failedRuns(failures: number): string {
  return failures === 1 ? '1 failed run' : `${failures} failed runs`
}

function heldSentence(status: StatusOf<'held'>, { hold }: SentenceFacts): string {
  const subject = status.scope === 'rollout' ? 'the whole rollout is held' : 'held'

  if (!hold) {
    return subject
  }

  return `${subject}${part(' since ', hold.at && timeText(hold.at))} by ${hold.by}${part(': ', hold.reason)}`
}

function ciSentence(status: StatusOf<'ci'>): string {
  const parts = [joined(status.pending), part('no run yet for ', joined(status.missing))].filter(Boolean)

  return `CI runs on ${shortSha(status.sha)}${part(': ', parts.join(', '))}`
}

const SENTENCES: Sentences = {
  'brief-write': () => 'the brief writer is working',
  'brief-review': () => 'the brief reviewer is checking the draft',
  implement: () => 'the implementer is working',
  fix: (status) => `the implementer is fixing${part(': ', status.reason)}`,
  delegate: (status) => `the delegate is answering the question${part(' (', status.question, ')')}`,
  commands: (status) => `the driver runs the pre-verify commands on ${shortSha(status.sha)}`,
  verify: (status) => `the verifier is checking ${shortSha(status.sha)}`,
  merge: (status) => `merging ${shortSha(status.sha)}`,
  slot: () => 'waits for a free slot',
  backoff: (status) => `waits until ${timeText(status.until)}${part(' after ', status.failures && failedRuns(status.failures))}`,
  held: heldSentence,
  dependencies: (status) => `waits for ${joined(status.on) || 'its dependencies'} to merge`,
  'dependencies-merge': (status) =>
    `waits: the verified heads of ${joined(status.heads?.map((head) => head.id)) || 'its dependencies'} do not merge cleanly together`,
  'outside-dependency': (status) => {
    const on = joined(status.on)

    return on ? `waits for ${on}, which are not in this run` : 'waits for dependencies outside this run'
  },
  github: () => 'the READY report waits: GitHub does not answer',
  ci: ciSentence,
  'code-scanning-pending': (status) => `code scanning has not analysed ${shortSha(status.sha)} yet`,
  'base-red': (status, facts) =>
    `${facts.base} is red${part(' at ', status.sha && shortSha(status.sha))}${part(': ', joined(status.failing))}. Merges wait until it is green`,
  'base-pending': (status, facts) => `${facts.base} is not green yet${part(' at ', status.sha && shortSha(status.sha))}`,
  'gate-pending': () => 'verified, the merge gate has not checked it yet',
  'mergeable-unknown': () => 'GitHub has not computed whether the PR merges',
  'github-merge-state': (status) => `GitHub's merge state is ${status.mergeState || 'unknown'}`,
  'merge-delay': (status) => `approved, merges at ${timeText(status.until)}`,
  queued: (status) => `ready after ${status.after ? `PR #${status.after}` : 'another PR'}: one PR is ready at a time`,
  'review-in-progress': (status) =>
    `the maintainer is reviewing${part(', last comment at ', status.lastCommentAt && timeText(status.lastCommentAt))}`,
  'driver-stopped': () => 'the driver is not running',
  'brief-questions': (status) => `the brief needs your answer${part(': ', firstLine(status.question?.text))}`,
  decision: (status) => `the implementer asks${part(': ', firstLine(status.question?.text))}`,
  obstacle: (status) =>
    `the implementer is blocked${part(' (', status.question?.kind, ')')}${part(': ', firstLine(status.question?.text))}`,
  dispute: (status) => {
    const findings = joined(status.findings)

    return findings
      ? `the verifier upholds ${findings}, which the implementer disputes`
      : 'the verifier upholds a finding the implementer disputes'
  },
  'attempts-exhausted': (status) => `${status.role} attempts exhausted${part(' (', status.limit, ')')}`,
  errors: (status) => `${status.count ? `${status.count} ticks in a row failed` : 'repeated errors'}${part(': ', status.error)}`,
  'merge-refused': (status) => `GitHub refused the merge${part(': ', status.error)}`,
  approve: () => 'verified, waits for your approval',
  review: (status) =>
    `verified, waits for a maintainer's review on GitHub${status.stale ? ': the approval is older than the current patch' : ''}`,
  'changes-requested': () => 'a maintainer requested changes on GitHub',
  'merge-by-hand': (status) => `ready: merge it on GitHub${part(' (', status.mergeState, ')')}`,
  'github-blocked': () => "the rollout gate passes, GitHub's ruleset still blocks the merge",
  'gate-blocked': (status) => `the gate blocks the merge${part(' (', status.gate, ')')}${part(': ', joined(status.reasons))}`,
  'code-scanning-alerts': (status) => `new code scanning alerts${part(': ', joined(status.alerts))}`,
  closed: () => 'the PR was closed on GitHub',
}

// The table's type makes tsc refuse a missing code. The throw catches one at run time, for the tests.
export function statusSentence(status: ShownStatus, facts: SentenceFacts): string {
  const sentence = Object.hasOwn(SENTENCES, status.code) ? (SENTENCES[status.code] as Sentence) : null

  if (!sentence) {
    throw new Error(`no sentence for the status code ${status.code}`)
  }

  return sentence(status, facts)
}

const WAY_OUT_TEXTS: Record<WayOutKind, (id: string, status: ShownStatus) => string> = {
  note: (id) => `rollout note ${id} "..."`,
  retry: (id) => `rollout retry ${id}`,
  'retry-or-note': (id) => `remove the cause, then rollout retry ${id}, or rollout note ${id} "..."`,
  approve: (id) => `rollout approve ${id}`,
  github: () => 'act on GitHub. The driver reads it again every tick',
  release: (id, status) => (status.code === 'held' && status.scope === 'rollout' ? 'rollout release --all' : `rollout release ${id}`),
}

function wayOutKind(status: ShownStatus): WayOutKind | null {
  if (status.kind === 'needs-you') {
    return WAY_OUT[status.code]
  }

  return status.code === 'held' ? 'release' : null
}

// What takes the status away. Only a needs-you status and a held one have one.
export function wayOut(status: ShownStatus, facts: SentenceFacts): { kind: WayOutKind; text: string } | null {
  const kind = wayOutKind(status)

  return kind ? { kind, text: WAY_OUT_TEXTS[kind](facts.id, status) } : null
}
