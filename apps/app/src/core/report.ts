import type { DB } from './db.ts'
import * as store from './store.ts'
import type { RunScope } from './types.ts'

const NAME = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok' } as const
const quote = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return `"${t.length > n ? t.slice(0, n - 1) + '…' : t}"`
}

/**
 * The report at the end of an update, as plain Markdown: what was read, what needs an
 * answer, and how the mood compares with everything kept before. Short by design: it is
 * also what Claude reads back through the MCP server.
 */
export function buildReport(
  db: DB,
  scope: RunScope,
  since: string,
  postIds: number[],
  problems: string[],
  skipped: string[],
) {
  const lines: string[] = []
  const stats: Record<string, unknown> = { posts: new Set(postIds).size }
  const day = new Date(since).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
  lines.push(`# Update, ${day}`, '')

  for (const brandId of scope.brandIds) {
    const brand = store.getBrand(db, brandId)
    if (!brand) continue
    const fresh = store.labelCounts(db, brandId, since)
    const all = store.labelCounts(db, brandId)
    const sorted = (c: Record<string, number>) => (c.total ?? 0) - (c.unsorted ?? 0)
    const pct = (c: Record<string, number>, k: string) =>
      sorted(c) ? Math.round(((c[k] ?? 0) / sorted(c)) * 100) : 0
    // A spike: at least three new complaints, at twice the brand's usual share or more.
    const spike =
      (fresh.complaint ?? 0) >= 3 &&
      sorted(all) >= 10 &&
      pct(fresh, 'complaint') >= 2 * Math.max(1, pct(all, 'complaint'))
    stats[brand.name] = { new: fresh, all, spike }

    lines.push(`## ${brand.name}`, '')
    if (spike)
      lines.push(
        `**Complaints spiked:** ${fresh.complaint} new, ${pct(fresh, 'complaint')}% of new comments against ${pct(all, 'complaint')}% usually.`,
        '',
      )
    const posts = store.listPosts(db, { brandId, limit: 200 }).filter((p) => postIds.includes(p.id))
    lines.push(
      `${posts.length} posts read, ${fresh.total ?? 0} new comments: ${fresh.complaint ?? 0} complaints, ${fresh.question ?? 0} questions, ${fresh.praise ?? 0} praise. ${fresh.needs_reply ?? 0} need a reply.` +
        // Unsorted comments are not "zero complaints": say how many still wait for the AI.
        (fresh.unsorted ? ` ${fresh.unsorted} not sorted yet: see Needs you.` : ''),
    )
    if (sorted(all) && sorted(fresh))
      lines.push(
        `Complaints are ${pct(fresh, 'complaint')}% of new comments, against ${pct(all, 'complaint')}% of all comments kept.`,
      )
    lines.push('')

    const reply = store
      .listComments(db, { brandId, needsReply: true, limit: 10 })
      .filter((c) => c.label)
    if (reply.length) {
      lines.push('### Answer these first', '')
      for (const c of reply)
        lines.push(
          `- **${c.label}**, ${NAME[c.network]}, ${c.author}${c.likes ? ` (${c.likes} likes)` : ''}: ${quote(c.text)} ${c.post_url}`,
        )
      lines.push('')
    }

    if (posts.length) {
      lines.push('### Posts', '')
      for (const p of posts)
        lines.push(
          `- ${NAME[p.network]}, ${p.posted_at?.slice(0, 10) ?? ''}: ${p.description ?? quote(p.caption, 100)} ${p.likes ?? '–'} likes, ${p.comments_count ?? '–'} comments${p.views != null ? `, ${p.views} views` : ''}${p.flagged ? `, ${p.flagged} to look at` : ''}. ${p.url}`,
        )
      lines.push('')
    }
  }

  if (skipped.length) lines.push('### Waiting for the gap', '', ...skipped.map((s) => `- ${s}`), '')
  if (problems.length) lines.push('### Needs you', '', ...problems.map((s) => `- ${s}`), '')
  return { text: lines.join('\n').trim() + '\n', stats }
}
