import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

// Readability rules that Prettier does not cover. See STYLE.md for the why.
// Formatting itself (quotes, semicolons, line width) is Prettier's job.
export default [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  // Prettier's config turns off every formatting rule, including `curly`,
  // so it must come before our block: later entries win.
  prettier,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // The UI runs in the browser, with no build step.
    files: ['ui/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.{js,mjs}'],
    plugins: { '@stylistic': stylistic },
    rules: {
      // Every block gets braces, even a one-line `if`. The braces show the scope.
      curly: ['error', 'all'],
      // A nested ternary is a puzzle, not an expression. Use if/else or a lookup.
      'no-nested-ternary': 'error',
      // Blank lines where the eye needs a pause: after imports, after any
      // multi-line block, before functions, classes and exports.
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        { blankLine: 'always', prev: 'multiline-block-like', next: '*' },
        { blankLine: 'always', prev: ['multiline-const', 'multiline-let', 'multiline-expression'], next: '*' },
        { blankLine: 'always', prev: '*', next: ['function', 'class', 'export'] },
        { blankLine: 'any', prev: 'export', next: 'export' },
      ],
      // Names carry meaning; a single letter forces the reader to scroll back.
      // Loop counters `i`/`j` and the throwaway `_` are the only exceptions.
      // Property names are data (git's status letters, URL params), not names.
      'id-length': ['error', { min: 2, exceptions: ['i', 'j', '_'], properties: 'never' }],
      // An inner name that hides an outer one makes the reader check which is meant.
      'no-shadow': 'error',
      // `_` marks a value left out on purpose: `({ at: _, ...event })`.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_$', varsIgnorePattern: '^_$', ignoreRestSiblings: true }],
    },
  },
]
