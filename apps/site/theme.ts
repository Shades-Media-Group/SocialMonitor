/**
 * Lets the reader's theme choice win over the system's.
 *
 * The site's stylesheets write their dark colours in
 * `@media (prefers-color-scheme: dark) { … }` blocks. The display panel
 * (shades-gradient/preferences) sets data-theme="light" or "dark" on <html>,
 * so each block becomes two: the system's dark, unless the reader chose
 * light, and the reader's dark, whatever the system says. `:root` inside a
 * block becomes `&`, so the nested rules still land on the root.
 */
import type { Plugin } from 'vite'

const DARK = '@media (prefers-color-scheme: dark)'

/** The body of the block opening at `start` (the index of its "{"), and where it ends. */
function block(css: string, start: number) {
  let depth = 0
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return { body: css.slice(start + 1, i), end: i + 1 }
  }
  throw new Error('theme: unbalanced braces in a dark-mode block')
}

export function themeable(css: string): string {
  let out = ''
  let from = 0
  for (let at = css.indexOf(DARK); at !== -1; at = css.indexOf(DARK, from)) {
    const open = css.indexOf('{', at)
    // Only the plain query; combined ones (`and (…)`) are left as they are.
    if (css.slice(at + DARK.length, open).trim() !== '') {
      out += css.slice(from, open + 1)
      from = open + 1
      continue
    }
    const { body, end } = block(css, open)
    const nested = body.replace(/(^|[,{}\s]):root(?=[\s,{:[.])/g, '$1&')
    out +=
      css.slice(from, at) +
      `${DARK} {\n  :root:not([data-theme='light']) {${nested}}\n}\n` +
      `:root[data-theme='dark'] {${nested}}`
    from = end
  }
  return out + css.slice(from)
}

export function theme(): Plugin {
  return {
    name: 'socialmonitor-theme',
    enforce: 'pre',
    transform(code, id) {
      // Packages handle their own themes (shades-gradient already reads data-theme).
      if (!id.endsWith('.css') || id.includes('node_modules') || !code.includes(DARK)) return
      return { code: themeable(code), map: null }
    },
  }
}
