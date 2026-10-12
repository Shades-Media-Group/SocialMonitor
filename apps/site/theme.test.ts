import { describe, expect, it } from 'vitest'
import { themeable } from './theme'

describe('themeable', () => {
  it('lets data-theme override the system dark mode', () => {
    const out = themeable(
      ':root { --ink: #000 }\n@media (prefers-color-scheme: dark) {\n  :root { --ink: #fff }\n  .x { color: red }\n}\n.y { color: blue }',
    )
    expect(out).toContain(":root:not([data-theme='light']) {")
    expect(out).toContain(":root[data-theme='dark'] {")
    expect(out).toContain('& { --ink: #fff }')
    expect(out).toContain('.x { color: red }')
    expect(out).toContain('.y { color: blue }')
    expect(out.match(/\.x \{ color: red \}/g)).toHaveLength(2)
  })

  it('leaves combined queries and other CSS alone', () => {
    const css = '@media (prefers-color-scheme: dark) and (min-width: 600px) { .a { color: red } }'
    expect(themeable(css)).toBe(css)
    expect(themeable('.b { color: red }')).toBe('.b { color: red }')
  })
})
