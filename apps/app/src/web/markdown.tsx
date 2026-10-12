const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Inline Markdown the reports use: **bold** and bare links. Everything else stays text. */
const inline = (s: string) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a class="g-link" href="$1" target="_blank" rel="noreferrer">Open</a>',
    )

/** The small Markdown a report is written in: headings, bullets and paragraphs. */
export function renderReport(md: string) {
  const out: string[] = []
  let list = false
  for (const line of md.split('\n')) {
    const bullet = line.startsWith('- ')
    if (list && !bullet) {
      out.push('</ul>')
      list = false
    }
    if (bullet) {
      if (!list) out.push('<ul>')
      list = true
      out.push(`<li>${inline(line.slice(2))}</li>`)
    } else if (line.startsWith('### ')) out.push(`<h3>${inline(line.slice(4))}</h3>`)
    else if (line.startsWith('## ')) out.push(`<h2>${inline(line.slice(3))}</h2>`)
    else if (line.startsWith('# ')) out.push(`<h1>${inline(line.slice(2))}</h1>`)
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  if (list) out.push('</ul>')
  return out.join('')
}
