import type { DB } from './db.ts'
import { now } from './db.ts'
import { saveImage } from './media.ts'
import { publicComments, tiktokMedia } from './collect/tiktok-public.ts'
import { imageIn } from './collect/browser.ts'

/**
 * Fills in what comments read before photos and stickers were kept are missing: each person's
 * photo, their profile link and any sticker or picture. TikTok shows a post's comments to
 * anyone, so this reads them from TikTok's public comment pages with no account and no cookies:
 * slowly, one post at a time, never touching the signed-in session.
 */

let running = false

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
