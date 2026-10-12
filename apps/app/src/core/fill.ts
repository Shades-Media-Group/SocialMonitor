import type { DB } from './db.ts'
import { now } from './db.ts'
import { saveImage } from './media.ts'
import { tiktokMedia } from './collect/tiktok.ts'
import { imageIn } from './collect/browser.ts'

/**
 * Fills in what comments read before photos and stickers were kept are missing: each person's
 * photo, their profile link and any sticker or picture. TikTok shows a post's comments to
 * anyone, so this reads them from TikTok's public comment pages with no account and no cookies:
 * slowly, one post at a time, never touching the signed-in session.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'

interface Raw {
  cid: string
  text?: string
  user?: { unique_id?: string; avatar_thumb?: unknown }
  image_list?: unknown
  sticker?: unknown
  cmt_sticker_struct?: unknown
  reply_comment?: Raw[] | null
  reply_comment_total?: number
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms + Math.random() * ms))
let running = false

async function get(
  path: string,
): Promise<{ comments?: Raw[]; has_more?: number; cursor?: number }> {
  await wait(1500)
  const r = await fetch(`https://www.tiktok.com${path}`, {
    headers: { 'user-agent': UA, referer: 'https://www.tiktok.com/' },
    credentials: 'omit',
  })
  if (!r.ok) throw new Error(`TikTok answered ${r.status}`)
  const text = await r.text()
  if (!text.trim()) throw new Error('TikTok sent nothing back')
  return JSON.parse(text)
}

/** Every comment and reply of a post that the public pages show, up to about 500. */
async function publicComments(postId: string) {
  const out = new Map<string, Raw>()
  const add = (c: Raw) => {
    out.set(c.cid, c)
    for (const r of c.reply_comment ?? []) out.set(r.cid, r)
  }
  let cursor = 0
  for (let page = 0; page < 10; page++) {
    const d = await get(`/api/comment/list/?aid=1988&aweme_id=${postId}&count=50&cursor=${cursor}`)
    for (const c of d.comments ?? []) add(c)
    if (!d.has_more || !d.comments?.length) break
    cursor = d.cursor ?? cursor + 50
  }
  for (const c of [...out.values()]) {
    if ((c.reply_comment_total ?? 0) <= (c.reply_comment?.length ?? 0)) continue
    const d = await get(
      `/api/comment/list/reply/?aid=1988&item_id=${postId}&comment_id=${c.cid}&count=50&cursor=0`,
    )
    for (const r of d.comments ?? []) out.set(r.cid, r)
  }
  return out
}

export async function fillTikTok(db: DB, log: (line: string) => void = () => {}) {
  if (running) return
  running = true
  try {
    const posts = db
      .prepare(
        `SELECT p.id, p.ext_id FROM posts p WHERE p.network = 'tiktok' AND p.people_read_at IS NULL
           AND EXISTS (SELECT 1 FROM comments c WHERE c.post_id = p.id AND c.author_avatar IS NULL)
         ORDER BY p.posted_at DESC LIMIT 40`,
      )
      .all() as { id: number; ext_id: string }[]
    if (!posts.length) return
    log(`Filling photos and stickers for ${posts.length} older TikTok posts, from public pages.`)
    let people = 0
    let pictures = 0
    for (const post of posts) {
      const raw = await publicComments(post.ext_id)
      const rows = db
        .prepare('SELECT id, ext_id, author, text FROM comments WHERE post_id = ?')
        .all(post.id) as { id: number; ext_id: string; author: string; text: string }[]
      for (const row of rows) {
        const c = raw.get(row.ext_id)
        if (!c) continue
        const handle = c.user?.unique_id
        const avatar = await saveImage(
          'tiktok',
          'people',
          row.author,
          imageIn(c.user?.avatar_thumb, /url/),
        )
        const media = await saveImage('tiktok', 'comments', row.ext_id, tiktokMedia(c))
        db.prepare(
          `UPDATE comments SET author_avatar = coalesce(?, author_avatar),
             author_url = coalesce(author_url, ?), media_url = coalesce(?, media_url),
             text = CASE WHEN text = '[sticker or picture]' THEN ? ELSE text END
           WHERE id = ?`,
        ).run(
          avatar,
          handle ? `https://www.tiktok.com/@${handle}` : null,
          media,
          c.text ?? '',
          row.id,
        )
        if (avatar) people++
        if (media) pictures++
      }
      db.prepare('UPDATE posts SET people_read_at = ? WHERE id = ?').run(now(), post.id)
    }
    log(`Filled ${people} photos and ${pictures} stickers or pictures.`)
  } finally {
    running = false
  }
}
