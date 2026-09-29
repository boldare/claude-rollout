# Code style

Code here is written for people first. Machines read anything. Humans need light, rhythm and visible structure.

## Code

- **Braces on every block.** `if (x) { return }` on three lines, never `if (x) return`.
- **Blank lines where the eye needs a pause.** After the imports, around multi-line blocks and statements, before every function.
- **No single-letter names.** `pending` instead of `p`, `frame` instead of `f`. Loop counters `i`/`j` and the throwaway `_` are the only exceptions.
- **No nested ternaries.** Use `if`/`else` or a lookup table.
- **Short functions, flat bodies.** Prefer an early `return` over nesting.
- **Names over comments.** A good name beats a comment that explains a bad one.
- Prettier: no semicolons, single quotes, 140 columns, trailing commas.

## Prose

Comments, docs, prompts, commit subjects and PR descriptions follow the same idea: written for people and no longer than they need to be.

- **Comment the why, not the what.** A comment explains a decision, a constraint or a gotcha the code cannot show. Never restate the code or narrate the change.
- **Short sentences, plain words.**
- **Periods, not semicolons.** End the sentence and start a new one, or use a comma or a list.

## Commits

One short subject line in conventional style (`feat: …`, `fix: …`, `chore: …`), no body, no trailers.
