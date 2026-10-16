import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from './db.ts'
import type { DB } from './db.ts'
import { addBrand, listProfiles, savePost } from './store.ts'
import { fbPost, igPost, webMediaId } from './meta-api.ts'
import type { CollectOptions } from './collect/index.ts'
import { discoveryFields, metaRoute, officialCollect, routeVia } from './meta-public.ts'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const shortcodeOf = (id: bigint) => {
  let s = ''
  for (let n = id; n > 0n; n /= 64n) s = ALPHABET[Number(n % 64n)] + s
  return s
}

// A Business Discovery answer as the Graph API documents it, with invented values.
const DISCOVERY = {
  business_discovery: {
    username: 'example_brand',
    followers_count: 1200,
    media_count: 3,
    id: '17841400000000001',
    media: {
      data: [
        {
          id: '17900000000000001',
          caption: 'New plans this autumn',
          timestamp: '2026-10-14T09:30:00+0000',
          permalink: `https://www.instagram.com/reel/${shortcodeOf(3456789012345678901n)}/`,
          shortcode: shortcodeOf(3456789012345678901n),
          media_type: 'VIDEO',
          media_product_type: 'REELS',
          media_url: 'https://cdn.example/video.mp4',
          thumbnail_url: 'https://cdn.example/thumb.jpg',
          like_count: 87,
          comments_count: 12,
          view_count: 4300,
        },
        {
          id: '17900000000000002',
          caption: 'Hidden likes',
          timestamp: '2026-10-12T18:00:00+0000',
          permalink: `https://www.instagram.com/p/${shortcodeOf(3456000000000000001n)}/`,
          media_type: 'CAROUSEL_ALBUM',
          media_product_type: 'FEED',
          media_url: 'https://cdn.example/photo.jpg',
          comments_count: 3,
        },
      ],
      paging: { cursors: { after: 'QVFIUabc' } },
    },
  },
}

const opt = (over: Partial<CollectOptions> = {}): CollectOptions => ({
  range: 'all',
  limit: 10,
  known: new Set(),
  due: new Map(),
  comments: true,
  maxComments: 300,
  usedSession: false,
  log: () => {},
  ...over,
})

function connect(db: DB, brandId: number, network: 'instagram' | 'facebook', username: string) {
  db.prepare(
    `INSERT INTO network_tokens (brand_id, network, open_id, access_token, refresh_token, expires_at,
       refresh_expires_at, scope, account, connected_at)
     VALUES (?, ?, ?, 'fixture-token', '', '9999', '9999', '', ?, '2026-10-16T00:00:00.000Z')`,
  ).run(
    brandId,
    network,
    network === 'instagram' ? '17841499999999999' : '100000000000001',
    JSON.stringify({ name: 'Our Page', username }),
  )
}

function setup() {
  const db = openDb(':memory:')
  const other = addBrand(db, 'Example', [
    'https://www.instagram.com/example_brand',
    'https://www.facebook.com/ExampleBrand',
  ])
  const ours = addBrand(db, 'Ours', ['https://www.instagram.com/our_agency'])
  const profile = (network: string) =>
    listProfiles(db, other.id).find((p) => p.network === network)!
  return { db, other, ours, profile }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.META_PPCA
})

describe('Instagram post ids', () => {
  it('turns a shortcode into the id the website uses', () => {
    expect(webMediaId('B')).toBe('1')
    expect(webMediaId('AAAAAAAAAA_')).toBe('63')
    expect(webMediaId(shortcodeOf(3456789012345678901n))).toBe('3456789012345678901')
    expect(webMediaId('not/valid')).toBeNull()
    expect(webMediaId(undefined)).toBeNull()
  })
})

describe('mapping Graph posts', () => {
  it('keeps an Instagram post with the website id, its kind, counts and views', () => {
    const [reel, album] = DISCOVERY.business_discovery.media.data.map(igPost)
    expect(reel).toEqual({
      ext_id: '3456789012345678901',
      url: DISCOVERY.business_discovery.media.data[0]!.permalink,
      posted_at: '2026-10-14T09:30:00.000Z',
      kind: 'reel',
      caption: 'New plans this autumn',
      thumb_url: 'https://cdn.example/thumb.jpg',
      likes: 87,
      comments_count: 12,
      shares: null,
      views: 4300,
      comments: [],
    })
    // No shortcode field: read from the permalink. Hidden likes stay unknown, never zero.
    expect(album!.ext_id).toBe('3456000000000000001')
    expect(album!.kind).toBe('photo')
    expect(album!.likes).toBeNull()
    expect(album!.thumb_url).toBe('https://cdn.example/photo.jpg')
  })

  it('keeps a Facebook post with the post part of its Graph id', () => {
    const p = fbPost({
      id: '100000000000001_200000000000002',
      message: 'Hello',
      created_time: '2026-10-10T10:00:00+0000',
      permalink_url: 'https://www.facebook.com/ExampleBrand/posts/200000000000002',
      reactions: { summary: { total_count: 40 } },
      comments: { summary: { total_count: 5 } },
      shares: { count: 2 },
    })
    expect(p).toMatchObject({ ext_id: '200000000000002', likes: 40, comments_count: 5, shares: 2 })
  })
})

describe('choosing the route', () => {
  it('uses the browser until some brand connects an Instagram account', () => {
    const { db, ours, profile } = setup()
    expect(metaRoute(db, profile('instagram'))).toBe('browser')
    connect(db, ours.id, 'instagram', 'our_agency')
    expect(metaRoute(db, profile('instagram'))).toBe('discovery')
    expect(routeVia(db, 'discovery')).toBe('@our_agency')
    // The connected brand's own account is read as connected, with comments.
    expect(metaRoute(db, listProfiles(db, ours.id)[0]!)).toBe('connected')
  })

  it('reads other Facebook Pages officially only with META_PPCA=on and a connected Page', () => {
    const { db, ours, profile } = setup()
    connect(db, ours.id, 'facebook', 'ourpage')
    expect(metaRoute(db, profile('facebook'))).toBe('browser')
    process.env.META_PPCA = 'on'
    expect(metaRoute(db, profile('facebook'))).toBe('ppca')
  })
})

describe('Business Discovery', () => {
  it('asks for the username through our account and keeps posts with their history', async () => {
    const { db, ours, profile } = setup()
    connect(db, ours.id, 'instagram', 'our_agency')
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return new Response(JSON.stringify(DISCOVERY))
      }),
    )
    const lines: string[] = []
    const p = profile('instagram')
    const posts = await officialCollect(db, p, opt({ log: (l) => lines.push(l) }), 'discovery')
    const u = new URL(urls[0]!)
    expect(u.pathname).toBe('/v23.0/17841499999999999')
    expect(u.searchParams.get('fields')).toBe(discoveryFields('example_brand', 25))
    expect(u.searchParams.get('fields')).toContain('view_count')
    expect(posts).toHaveLength(2)
    expect(posts!.every((x) => x.comments.length === 0)).toBe(true)
    expect(lines.join('\n')).toMatch(/Business Discovery.*no comment text/)
    const { post } = savePost(db, p, posts![0]!)
    const metrics = db
      .prepare('SELECT likes, comments, views FROM post_metrics WHERE post_id = ?')
      .all(post.id)
    expect(metrics).toEqual([{ likes: 87, comments: 12, views: 4300 }])
  })

  it('follows the cursor for the next page', () => {
    expect(discoveryFields('a.b', 10, 'QVF')).toBe(
      'business_discovery.username(a.b){username,followers_count,media_count,media.after(QVF).limit(10){id,caption,timestamp,permalink,shortcode,media_type,media_product_type,media_url,thumbnail_url,like_count,comments_count,view_count}}',
    )
  })

  it('says plainly when the account is not professional, or the hour is used up', async () => {
    const { db, ours, profile } = setup()
    connect(db, ours.id, 'instagram', 'our_agency')
    const answer = (body: object, status = 400) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(body), { status })),
      )
    answer({ error: { message: 'Invalid user id', code: 110, error_subcode: 2207013 } })
    await expect(officialCollect(db, profile('instagram'), opt(), 'discovery')).rejects.toThrow(
      /only Instagram business and creator accounts/,
    )
    answer({ error: { message: 'Application request limit reached', code: 4 } })
    await expect(officialCollect(db, profile('instagram'), opt(), 'discovery')).rejects.toThrow(
      /hourly limit/,
    )
    answer({ error: { message: '(#10) Not enough permission', code: 10 } })
    await expect(officialCollect(db, profile('instagram'), opt(), 'discovery')).rejects.toThrow(
      /instagram_manage_insights/,
    )
  })

  it('refuses a handle that is not an Instagram username, without calling Meta', async () => {
    const { db, ours, profile } = setup()
    connect(db, ours.id, 'instagram', 'our_agency')
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const p = { ...profile('instagram'), handle: 'x){id}' }
    await expect(officialCollect(db, p, opt(), 'discovery')).rejects.toThrow(/not an Instagram/)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('Page Public Content Access', () => {
  it('reads a public Page by its name and explains a refusal before approval', async () => {
    const { db, ours, profile } = setup()
    connect(db, ours.id, 'facebook', 'ourpage')
    process.env.META_PPCA = 'on'
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        return new Response(
          JSON.stringify({
            data: [{ id: '1_22', message: 'Hi', reactions: { summary: { total_count: 3 } } }],
          }),
        )
      }),
    )
    const posts = await officialCollect(db, profile('facebook'), opt(), 'ppca')
    expect(new URL(urls[0]!).pathname).toBe('/v23.0/ExampleBrand/posts')
    expect(posts![0]).toMatchObject({ ext_id: '22', likes: 3 })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: '(#10) requires Page Public Content Access', code: 10 },
            }),
            { status: 400 },
          ),
      ),
    )
    await expect(officialCollect(db, profile('facebook'), opt(), 'ppca')).rejects.toThrow(
      /not granted Page Public Content Access/,
    )
  })
})
