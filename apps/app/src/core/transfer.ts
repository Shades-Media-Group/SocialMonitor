import type { DB } from './db.ts'

type Table = 'brands' | 'profiles' | 'posts' | 'comments' | 'schedules' | 'runs'

export interface Dump {
  app: 'socialmonitor'
  version: 1
  exported_at: string
  tables: Record<Table, Record<string, unknown>[]>
}

/** The whole database as one JSON document. Settings stay out: they belong to this computer. */
export function exportAll(db: DB, brandId?: number): Dump {
  const q = (sql: string, ...a: number[]) => db.prepare(sql).all(...a) as Record<string, unknown>[]
  const b = brandId ? ' WHERE brand_id = ?' : ''
  const a = brandId ? [brandId] : []
  return {
    app: 'socialmonitor',
    version: 1,
    exported_at: new Date().toISOString(),
    tables: {
      brands: q(`SELECT * FROM brands${brandId ? ' WHERE id = ?' : ''}`, ...a),
      profiles: q(`SELECT * FROM profiles${b}`, ...a),
      posts: q(`SELECT * FROM posts WHERE profile_id IN (SELECT id FROM profiles${b})`, ...a),
      comments: q(
        `SELECT * FROM comments WHERE post_id IN (SELECT id FROM posts WHERE profile_id IN (SELECT id FROM profiles${b}))`,
        ...a,
      ),
      schedules: q(`SELECT * FROM schedules${b}`, ...a),
      runs: brandId ? [] : q('SELECT * FROM runs'),
    },
  }
}

/**
 * Merges an export into this database. Rows match on their natural keys (brand name,
 * brand + network, network + post id, post + comment id), so importing twice changes nothing.
 * Ids are remapped, since the two databases number rows independently.
 */
export function importAll(db: DB, dump: Dump) {
  if (dump?.app !== 'socialmonitor' || dump.version !== 1)
    throw new Error('This file is not a SocialMonitor export.')
  const t = dump.tables
  const brandIds = new Map<number, number>()
  const profileIds = new Map<number, number>()
  const postIds = new Map<number, number>()
  const count = { brands: 0, posts: 0, comments: 0 }
  db.exec('BEGIN')
  try {
    for (const r of t.brands ?? []) {
      const row = db
        .prepare(
          'INSERT INTO brands (name, website, created_at, categories) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET website = coalesce(brands.website, excluded.website) RETURNING id',
        )
        .get(
          r.name as string,
          (r.website as string) ?? null,
          r.created_at as string,
          (r.categories as string) ?? '[]',
        ) as {
        id: number
      }
      brandIds.set(r.id as number, row.id)
      count.brands++
    }
    for (const r of t.profiles ?? []) {
      const brand = brandIds.get(r.brand_id as number)
      if (!brand) continue
      const row = db
        .prepare(
          `INSERT INTO profiles (brand_id, network, url, handle, last_run_at, last_status, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (brand_id, network) DO UPDATE SET last_run_at = max(coalesce(profiles.last_run_at, ''), coalesce(excluded.last_run_at, '')) RETURNING id`,
        )
        .get(
          brand,
          r.network as string,
          r.url as string,
          r.handle as string,
          (r.last_run_at as string) ?? null,
          (r.last_status as string) ?? null,
          (r.last_error as string) ?? null,
        ) as { id: number }
      profileIds.set(r.id as number, row.id)
    }
    const cols = [
      'network',
      'ext_id',
      'url',
      'posted_at',
      'kind',
      'caption',
      'thumb_url',
      'likes',
      'comments_count',
      'shares',
      'views',
      'description',
      'fetched_at',
    ] as const
    for (const r of t.posts ?? []) {
      const profile = profileIds.get(r.profile_id as number)
      if (!profile) continue
      const row = db
        .prepare(
          `INSERT INTO posts (profile_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
           ON CONFLICT (network, ext_id) DO UPDATE SET description = coalesce(posts.description, excluded.description) RETURNING id`,
        )
        .get(profile, ...cols.map((c) => (r[c] ?? null) as string | number | null)) as {
        id: number
      }
      postIds.set(r.id as number, row.id)
      count.posts++
    }
    const ccols = [
      'ext_id',
      'parent_ext_id',
      'author',
      'text',
      'likes',
      'posted_at',
      'fetched_at',
      'label',
      'needs_reply',
      'reason',
      'reply_status',
      'sentiment',
      'category',
      'sentiment_by',
    ] as const
    const insert = db.prepare(
      `INSERT INTO comments (post_id, ${ccols.join(', ')}) VALUES (?, ${ccols.map(() => '?').join(', ')})
       ON CONFLICT (post_id, ext_id) DO UPDATE SET label = coalesce(comments.label, excluded.label), reason = coalesce(comments.reason, excluded.reason)`,
    )
    for (const r of t.comments ?? []) {
      const post = postIds.get(r.post_id as number)
      if (!post) continue
      insert.run(post, ...ccols.map((c) => (r[c] ?? null) as string | number | null))
      count.comments++
    }
    for (const r of t.schedules ?? []) {
      const brand = brandIds.get(r.brand_id as number)
      if (!brand) continue
      db.prepare(
        'INSERT INTO schedules (brand_id, kind, every_hours, times, networks, range, enabled) VALUES (?, ?, ?, ?, ?, ?, 0)',
      ).run(
        brand,
        r.kind as string,
        (r.every_hours as number) ?? null,
        r.times as string,
        r.networks as string,
        r.range as string,
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return count
}
