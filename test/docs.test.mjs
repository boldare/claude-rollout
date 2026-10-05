import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { COMMANDS } from '../lib/control.mjs'
import { loadManifest } from '../lib/manifest.mjs'
import { ROLES } from '../lib/view.mjs'
import { STATES } from '../ui/model.js'
import { makeRollout } from './fixtures.mjs'

// The docs site is plain HTML with no build step, so these tests hold it
// together: one sidebar everywhere, links that resolve, tokens equal to the
// UI's, and a place on the right page for every command, field and state.

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const DOCS = join(ROOT, 'docs')
const PAGES = [
  'index.html',
  'getting-started.html',
  'accounts.html',
  'manifest.html',
  'commands.html',
  'ui.html',
  'how-it-works.html',
  'security.html',
]
const TOP_LEVEL_FIELDS = ['rollout', 'model', 'claudeBin', 'repo', 'briefing', 'policy', 'prs']

function read(file) {
  return readFileSync(join(DOCS, file), 'utf8')
}

function ids(html) {
  return [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
}

function attributes(html, name) {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((match) => match[1])
}

function sidebar(html) {
  return html.match(/<nav class="sidebar"[\s\S]*?<\/nav>/)?.[0] ?? ''
}

function declarations(block) {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].replace(/\s+/g, ' ').trim()]))
}

function tokens(css) {
  const light = css.match(/^:root \{([\s\S]*?)^\}/m)
  const dark = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n {2}\}/)

  assert.ok(light && dark, 'both token blocks are present')

  return { light: declarations(light[1]), dark: declarations(dark[1]) }
}

test('docs: the pages on disk are the pages in the sidebar, in order', () => {
  const onDisk = readdirSync(DOCS)
    .filter((file) => file.endsWith('.html'))
    .sort()

  assert.deepEqual(onDisk, [...PAGES].sort())
  assert.deepEqual(attributes(sidebar(read('index.html')), 'href'), PAGES)
})

test('docs: every page has a title, links docs.css and loads nothing from elsewhere', () => {
  for (const page of PAGES) {
    const html = read(page)

    assert.match(html, /^<!doctype html>/, page)
    assert.match(html, /<title>[^<]+ · rollout docs<\/title>/, page)
    assert.match(html, /<link rel="stylesheet" href="docs\.css" \/>/, page)
    assert.doesNotMatch(html, /<script|<style|\sstyle="|\son[a-z]+="/i, page)

    for (const source of [...attributes(html, 'src'), ...[...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((match) => match[1])]) {
      assert.doesNotMatch(source, /^[a-z]+:|^\/\/|^\//i, `${page}: ${source}`)
    }

    for (const href of attributes(html, 'href')) {
      assert.doesNotMatch(href, /^\.\.\/|^\/|^http:/, `${page}: ${href} does not work on GitHub Pages`)
    }
  }
})

test('docs: the sidebar is the same on every page and marks the page itself', () => {
  const reference = sidebar(read('index.html')).replace(' aria-current="page"', '')

  for (const page of PAGES) {
    const nav = sidebar(read(page))
    const current = [...nav.matchAll(/href="([^"]+)" aria-current="page"/g)].map((match) => match[1])

    assert.deepEqual(current, [page], page)
    assert.equal(nav.replace(' aria-current="page"', ''), reference, page)
  }
})

test('docs: the pager walks the pages in sidebar order', () => {
  PAGES.forEach((page, index) => {
    const pager = read(page).match(/<nav class="pager"[\s\S]*?<\/nav>/)?.[0] ?? ''
    const previous = pager.match(/class="prev" href="([^"]+)"/)?.[1] ?? null
    const next = pager.match(/class="next" href="([^"]+)"/)?.[1] ?? null

    assert.equal(previous, PAGES[index - 1] ?? null, `${page}: previous`)
    assert.equal(next, PAGES[index + 1] ?? null, `${page}: next`)
  })
})

test('docs: every id is unique and every link, anchor and SVG reference resolves', () => {
  const idsByPage = new Map(PAGES.map((page) => [page, ids(read(page))]))

  for (const [page, pageIds] of idsByPage) {
    const duplicates = pageIds.filter((id, index) => pageIds.indexOf(id) !== index)
    assert.deepEqual(duplicates, [], `${page}: duplicate ids`)
  }

  for (const page of PAGES) {
    const html = read(page)
    const local = [...attributes(html, 'href'), ...attributes(html, 'src')].filter((href) => !/^[a-z]+:/i.test(href))

    for (const href of local) {
      const [file, fragment] = href.split('#')
      const target = file || page

      assert.ok(existsSync(join(DOCS, target)), `${page}: ${href} points to a missing file`)

      if (fragment) {
        assert.ok(idsByPage.get(target)?.includes(fragment), `${page}: ${href} points to a missing anchor`)
      }
    }

    const references = [
      ...[...html.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]),
      ...attributes(html, 'aria-labelledby').flatMap((value) => value.split(/\s+/)),
    ]

    for (const reference of references) {
      assert.ok(idsByPage.get(page).includes(reference), `${page}: #${reference} is referenced but not defined`)
    }
  }
})

test('docs: the tokens are the UI tokens, in both schemes', () => {
  const ui = tokens(readFileSync(join(ROOT, 'ui', 'style.css'), 'utf8'))
  const docs = tokens(read('docs.css'))

  assert.ok(Object.keys(ui.light).length > 20)
  assert.deepEqual(docs.light, ui.light)
  assert.deepEqual(docs.dark, ui.dark)
})

test('docs: every page shows the package version', () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  for (const page of PAGES) {
    assert.ok(read(page).includes(`<span class="version">v${version}</span>`), page)
  }
})

test('docs: every CLI command and flag has its place on the commands page', () => {
  const cli = readFileSync(join(ROOT, 'bin', 'rollout.mjs'), 'utf8')
  const commands = new Set([...cli.matchAll(/case '([a-z-]+)':/g)].map((match) => match[1]))
  const options = cli.match(/options: \{([\s\S]*?)\n {2}\},/)[1]
  const flags = [...options.matchAll(/^\s+'?([a-z-]+)'?: \{ type:/gm)].map((match) => match[1])
  const html = read('commands.html')
  const pageIds = ids(html)

  commands.add('ui')
  commands.add('help')
  assert.ok(commands.size >= 15 && flags.length >= 8)

  for (const command of commands) {
    assert.ok(pageIds.includes(`cmd-${command}`), `commands.html has no #cmd-${command}`)
  }

  for (const flag of flags) {
    assert.ok(pageIds.includes(`flag-${flag}`), `commands.html has no #flag-${flag}`)
  }
})

test('docs: every UI command has its place on the UI page', () => {
  const pageIds = ids(read('ui.html'))

  for (const command of COMMANDS) {
    assert.ok(pageIds.includes(`control-${command}`), `ui.html has no #control-${command}`)
  }
})

test('docs: every manifest field, from the defaults and the example, has its row', () => {
  const manifest = loadManifest(makeRollout())
  const example = parse(readFileSync(join(ROOT, 'examples', 'manifest.yaml'), 'utf8'))
  const pageIds = ids(read('manifest.html'))
  const expected = [
    ...TOP_LEVEL_FIELDS.map((key) => `manifest-${key}`),
    ...[...Object.keys(manifest.repo), ...Object.keys(example.repo)].map((key) => `repo-${key}`),
    ...[...Object.keys(manifest.policy), ...Object.keys(example.policy)].map((key) => `policy-${key}`),
    ...[...Object.keys(manifest.all[0]), ...example.prs.flatMap((pr) => Object.keys(pr))]
      .filter((key) => key !== 'order')
      .map((key) => `pr-${key}`),
    ...example.briefing.sources.flatMap((source) => Object.keys(source)).map((key) => `source-${key}`),
  ]

  for (const key of Object.keys(example)) {
    assert.ok(TOP_LEVEL_FIELDS.includes(key), `examples/manifest.yaml has an unknown top-level field ${key}`)
  }

  for (const id of new Set(expected)) {
    assert.ok(pageIds.includes(id), `manifest.html has no #${id}`)
  }
})

test('docs: every PR state has its row on the how it works page', () => {
  const pageIds = ids(read('how-it-works.html'))

  for (const state of STATES) {
    assert.ok(pageIds.includes(`state-${state}`), `how-it-works.html has no #state-${state}`)
  }
})

test('docs: every run role has its colour class in the UI and the docs', () => {
  assert.ok(ROLES.length >= 5, 'lib/view.mjs exports the run roles')

  for (const file of ['ui/style.css', 'docs/docs.css']) {
    const css = readFileSync(join(ROOT, file), 'utf8')

    for (const role of ROLES) {
      assert.match(css, new RegExp(`^\\.role-${role} \\{`, 'm'), `${file} has no .role-${role} rule`)
    }
  }
})

test('skill: every CLI command is in the command table of SKILL.md', () => {
  const skill = readFileSync(join(ROOT, 'SKILL.md'), 'utf8')
  const table = skill.match(/## Commands[\s\S]*?\n## /)?.[0] ?? ''
  const cli = readFileSync(join(ROOT, 'bin', 'rollout.mjs'), 'utf8')
  const commands = new Set([...cli.matchAll(/case '([a-z-]+)':/g)].map((match) => match[1]))

  commands.add('ui')
  commands.add('help')

  for (const command of commands) {
    assert.match(table, new RegExp(`\`node \\$R [^\`]*\\b${command}\\b`), `SKILL.md has no row for ${command}`)
  }
})
