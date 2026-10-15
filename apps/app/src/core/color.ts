/**
 * Colour checks shared by the server and the dashboard's print page: a brand's accent is a
 * plain hex value, and text sits on it only where it reads.
 */

/** A colour as #rrggbb in lower case, or null when it is not a hex colour. */
export function validColor(v: unknown): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v ?? '').trim())
  if (!m) return null
  const h = m[1]!.toLowerCase()
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h)
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** WCAG contrast ratio of two #rrggbb colours, 1 to 21. */
export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/**
 * Which text reads on the accent: paper or ink, whichever contrasts more, if it reaches 4.5:1.
 * Null means no text reads on it, so the accent is used only for rules and marks.
 */
export function textOn(accent: string): string | null {
  const best = ['#ffffff', '#16181d'].sort((a, b) => contrast(b, accent) - contrast(a, accent))[0]!
  return contrast(best, accent) >= 4.5 ? best : null
}
