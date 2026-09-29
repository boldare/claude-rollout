// Minimal glob matching for manifest paths and check names:
// `**` spans directories, `*` stays inside one segment, `?` is one character.
export function globToRegExp(glob) {
  let source = ''
  let i = 0

  while (i < glob.length) {
    const char = glob[i]

    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?'
      i += 3
    } else if (glob.startsWith('**', i)) {
      source += '.*'
      i += 2
    } else if (char === '*') {
      source += '[^/]*'
      i += 1
    } else if (char === '?') {
      source += '[^/]'
      i += 1
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }

  return new RegExp(`^${source}$`)
}

export function matchesAny(value, globs) {
  return globs.some((glob) => globToRegExp(glob).test(value))
}
