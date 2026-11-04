import type { RawStory, ReadStory } from './collect/tiktok-stories.ts'
import type { Fetcher } from './story-media.ts'
import type { GraphGet } from './meta-stories.ts'
import type { StoryFilter } from './story-view.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Every file goes into a data folder of its own, and ffmpeg runs without the shared lock (the
// tests themselves run under it).
vi.hoisted(() => {
  process.env.SOCIALMONITOR_DATA = `${process.env.TMPDIR ?? '/tmp'}/sm-stories-test-${process.pid}`
  process.env.SOCIALMONITOR_HEAVY_LOCK = 'off'
})

const { DATA_DIR, openDb } = await import('./db.ts')
const store = await import('./store.ts')
const { setPlan } = await import('./plan.ts')
const tt = await import('./collect/tiktok-stories.ts')
const st = await import('./stories.ts')
const view = await import('./story-view.ts')
const media = await import('./story-media.ts')
const meta = await import('./meta-stories.ts')
const { parseStoryReading } = await import('./analyze.ts')
const { MetaRefused } = await import('./meta-api.ts')

const FIXTURES = new URL('./collect/fixtures/tiktok-stories/', import.meta.url)
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8')

/** A profile page as TikTok ships it logged out, with the story flag set or not. */
const profileHtml = (flag?: number) =>
  `<html><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(
    {
      __DEFAULT_SCOPE__: {
        'webapp.user-detail': {
          userInfo: {
            user: {
              id: '7458635402229253126',
              uniqueId: 'tavelo.md',
              secUid: 'MS4wLjABAAAA',
              ...(flag === undefined ? {} : { UserStoryStatus: flag }),
            },
          },
        },
      },
    },
  )}</script></body></html>`

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

beforeAll(() => mkdirSync(DATA_DIR, { recursive: true }))
afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }))

function setup() {
  // Each test starts with no files: story ids start again at 1 in every new database.
  for (const d of ['stories', 'media']) rmSync(join(DATA_DIR, d), { recursive: true, force: true })
  const db = openDb(':memory:')
  const brand = store.addBrand(db, 'Tavelo', ['https://www.tiktok.com/@tavelo.md'])
  const rival = store.addCompetitor(db, brand.id, 'Lumio', ['https://www.tiktok.com/@lumio.store'])
  return { db, brand, rival }
}

describe('TikTok stories as anyone sees them', () => {
  it('reads the profile’s story flag and id, and says when it is not there', () => {
    expect(tt.storyStatusFrom(profileHtml(1))).toEqual({ id: '7458635402229253126', live: true })
    expect(tt.storyStatusFrom(profileHtml(0))).toEqual({ id: '7458635402229253126', live: false })
    expect(tt.storyStatusFrom(profileHtml())).toEqual({ id: '7458635402229253126', live: null })
    expect(tt.storyStatusFrom('<html>nothing</html>')).toBeNull()
  })

  it('takes each story at its best quality, with stickers, tags, music and counts', () => {
    const list = JSON.parse(fixture('story_list.json')) as { itemList: RawStory[] }
    const [video, photo] = list.itemList.map((it) => tt.toStory(it, 'tavelo.md')!)
    // The 720p HEVC beats the 540p H.264: the most pixels first, whatever the codec.
    expect(video!.media).toEqual([
      expect.objectContaining({
        kind: 'video',
        width: 720,
        height: 1280,
        codec: 'h265_hvc1',
        bytes: 352348,
        urls: [
          'https://v16-webapp.tiktok.example/720.mp4',
          'https://v19-webapp.tiktok.example/720.mp4',
        ],
      }),
    ])
    expect(video).toMatchObject({
      network: 'tiktok',
      ext_id: '7704091736330505493',
      posted_at: '2026-11-03T23:30:47.000Z',
      expires_at: '2026-11-04T23:30:47.000Z',
      stickers: ['Autumn bags are in', '@lumio.store'],
      mentions: ['lumio.store'],
      music: { title: 'original sound', author: 'Tavelo' },
      views: 373,
      likes: 12,
      shares: 2,
      replies: 0,
    })
    expect(photo!.media).toEqual([
      expect.objectContaining({ kind: 'image', width: 720, height: 1280 }),
    ])
    expect(photo!.mentions).toEqual(['tavelo.official'])
  })

  it('pages through a long list and stops on a repeated cursor', async () => {
    const page = (ids: string[], more: boolean, cursor: string) =>
      JSON.stringify({
        itemList: ids.map((id) => ({
          id,
          createTime: 1793748647,
          imagePost: { images: [{ imageURL: { urlList: [`https://p16.example/${id}.jpg`] } }] },
        })),
        HasMoreAfter: more,
        MaxCursor: cursor,
      })
    const asked: string[] = []
    const answers = [page(['1', '2'], true, '50'), page(['3'], true, '50'), page(['4'], false, '0')]
    const items = await tt.readStoryList(
      async (url) => {
        asked.push(url)
        return answers[asked.length - 1]!
      },
      '7458635402229253126',
      'tavelo.md',
    )
    expect(items.map((s) => s.ext_id)).toEqual(['1', '2', '3'])
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('cursor=50')
    expect(await tt.readStoryList(async () => fixture('empty_list.json'), '1', 'x')).toEqual([])
  })

  it('finds handles in words, without trailing dots or e-mail addresses', () => {
    expect(tt.handlesIn('Thanks @lumio.store. Write to hi@tavelo.example or @Tavelo_MD!')).toEqual([
      'lumio.store',
      'tavelo_md',
    ])
  })
})

describe('keeping stories', () => {
  const story = (over: Partial<ReadStory> = {}): ReadStory => ({
    network: 'tiktok',
    ext_id: '100',
    handle: 'tavelo.md',
    posted_at: '2026-11-03T10:00:00.000Z',
    expires_at: '2026-11-04T10:00:00.000Z',
    caption: '',
    media: [
      {
        kind: 'image',
        urls: ['https://p16.example/a.jpg'],
        width: 720,
        height: 1280,
        duration: null,
        bytes: null,
        codec: null,
        cover: null,
      },
    ],
    stickers: [],
    mentions: [],
    links: [],
    music: null,
    views: 10,
    likes: 1,
    shares: 0,
    replies: 0,
    insights: null,
    permalink: null,
    is_ad: false,
    ...over,
  })

  it('adds a story once and keeps its first sight, its latest counts and every row', () => {
    const { db, brand } = setup()
    const a = st.saveStory(db, brand.id, brand.id, story(), '2026-11-03T11:00:00.000Z')
    expect(a.fresh).toBe(true)
    const b = st.saveStory(db, brand.id, brand.id, story({ views: 40 }), '2026-11-03T14:00:00.000Z')
    expect(b).toEqual({ id: a.id, fresh: false })
    const row = db.prepare('SELECT * FROM stories').get() as Record<string, unknown>
    expect(row).toMatchObject({
      first_seen_at: '2026-11-03T11:00:00.000Z',
      last_seen_at: '2026-11-03T14:00:00.000Z',
      views: 40,
    })
    expect(db.prepare('SELECT count(*) AS n FROM story_media').get()).toEqual({ n: 1 })
  })

  it('saves the original, and marks a file it could not fetch to try again', async () => {
    const { db, brand } = setup()
    const s = story({ ext_id: '200' })
    const { id } = st.saveStory(db, brand.id, brand.id, s)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000)])
    let fail = true
    const fetcher: Fetcher = async () =>
      fail
        ? { ok: false, status: 403, type: 'text/plain', body: Buffer.alloc(0) }
        : { ok: true, status: 200, type: 'image/jpeg', body: jpeg }
    expect(await st.saveOriginals(db, brand.id, id, s, fetcher)).toBe(0)
    expect(db.prepare('SELECT status, error FROM story_media').get()).toEqual({
      status: 'missing',
      error: 'the media server answered 403',
    })
    fail = false
    const at = new Date('2026-11-03T12:00:00.000Z')
    expect(await st.saveOriginals(db, brand.id, id, s, fetcher, at)).toBe(1)
    const m = db.prepare('SELECT * FROM story_media').get() as Record<string, string | number>
    expect(m).toMatchObject({
      status: 'pending',
      original_bytes: jpeg.length,
      original_path: `stories/${brand.id}/${id}-0.jpg`,
      original_until: '2026-11-13T12:00:00.000Z',
    })
    expect(existsSync(join(DATA_DIR, m.original_path as string))).toBe(true)
  })

  it('removes originals after their days, only where the compact copy exists', () => {
    const { db, brand } = setup()
    const { id } = st.saveStory(db, brand.id, brand.id, story({ ext_id: '300' }))
    const other = st.saveStory(db, brand.id, brand.id, story({ ext_id: '301' })).id
    const dir = join(DATA_DIR, 'stories', String(brand.id))
    mkdirSync(dir, { recursive: true })
    for (const n of [id, other]) {
      writeFileSync(join(dir, `${n}-0.jpg`), 'x'.repeat(100))
      db.prepare(
        `UPDATE story_media SET original_path = ?, original_bytes = 100,
           original_until = '2026-11-13T12:00:00.000Z', compact_path = '/media/c.webp',
           compact_bytes = 40, status = ? WHERE story_id = ?`,
      ).run(`stories/${brand.id}/${n}-0.jpg`, n === id ? 'done' : 'failed', n)
    }
    expect(st.cleanupOriginals(db, new Date('2026-11-13T11:59:00.000Z'))).toEqual({
      removed: 0,
      freed: 0,
    })
    expect(st.cleanupOriginals(db, new Date('2026-11-14T05:00:00.000Z'))).toEqual({
      removed: 1,
      freed: 100,
    })
    expect(existsSync(join(dir, `${id}-0.jpg`))).toBe(false)
    // The one whose compact copy failed keeps its original: it is the only copy.
    expect(existsSync(join(dir, `${other}-0.jpg`))).toBe(true)
    const rows = db
      .prepare(
        'SELECT story_id, original_path, original_removed_at, compact_path FROM story_media ORDER BY story_id',
      )
      .all()
    expect(rows).toEqual([
      {
        story_id: id,
        original_path: null,
        original_removed_at: '2026-11-14T05:00:00.000Z',
        compact_path: '/media/c.webp',
      },
      expect.objectContaining({ story_id: other, original_removed_at: null }),
    ])
    expect(db.prepare('SELECT count(*) AS n FROM stories').get()).toEqual({ n: 2 })
  })

  it.skipIf(!hasFfmpeg)(
    'makes the compact copy and the poster of a video and a picture, at their own size',
    { timeout: 120_000 },
    async () => {
      const { db, brand } = setup()
      const dir = join(DATA_DIR, 'stories', String(brand.id))
      mkdirSync(dir, { recursive: true })
      const v = st.saveStory(db, brand.id, brand.id, story({ ext_id: '400' })).id
      const p = st.saveStory(db, brand.id, brand.id, story({ ext_id: '401' })).id
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=180x320:rate=25:duration=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2',
        '-c:v',
        'libx265',
        '-c:a',
        'aac',
        '-shortest',
        join(dir, `${v}-0.mp4`),
      ])
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-y',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=360x640',
        '-frames:v',
        '1',
        join(dir, `${p}-0.jpg`),
      ])
      db.prepare("UPDATE story_media SET kind = 'video', original_path = ? WHERE story_id = ?").run(
        `stories/${brand.id}/${v}-0.mp4`,
        v,
      )
      db.prepare('UPDATE story_media SET original_path = ? WHERE story_id = ?').run(
        `stories/${brand.id}/${p}-0.jpg`,
        p,
      )
      await st.kickFiles(db, false)
      const rows = db.prepare('SELECT * FROM story_media ORDER BY story_id').all() as Record<
        string,
        string | number | null
      >[]
      expect(rows[0]).toMatchObject({
        status: 'done',
        width: 180,
        height: 320,
        codec: 'hevc',
        compact_path: `/media/stories/${brand.id}/${v}-0.mp4`,
        poster_path: `/media/stories/${brand.id}/${v}-0-poster.webp`,
      })
      expect(rows[0]!.duration).toBeCloseTo(2, 0)
      // HEVC does not play everywhere: the copy is H.264, with its sound.
      const copy = await media.probe(join(DATA_DIR, rows[0]!.compact_path as string))
      expect(copy).toMatchObject({ codec: 'h264', width: 180, height: 320, audio: true })
      expect(rows[1]).toMatchObject({
        status: 'done',
        width: 360,
        height: 640,
        compact_path: `/media/stories/${brand.id}/${p}-0.webp`,
      })
      expect(Number(rows[1]!.compact_bytes)).toBeGreaterThan(0)
      expect(Number(rows[1]!.poster_bytes)).toBeGreaterThan(0)
      const q = await media.similarity(
        join(DATA_DIR, rows[1]!.original_path as string),
        join(DATA_DIR, rows[1]!.compact_path as string),
      )
      expect(q.ssim).toBeGreaterThan(0.97)
    },
  )

  it('runs heavy work under the shared lock and at the lowest priority, where Linux has them', () => {
    const [cmd, args] = media.heavyCommand('ffmpeg', ['-i', 'a'], {
      SOCIALMONITOR_HEAVY_LOCK: '/tmp/shades-heavy.lock',
    })
    if (process.platform === 'linux' && existsSync('/usr/bin/flock')) {
      expect(cmd).toBe('flock')
      expect(args.slice(0, 1)).toEqual(['/tmp/shades-heavy.lock'])
      expect(args).toContain('nice')
      expect(args.slice(-3)).toEqual(['ffmpeg', '-i', 'a'])
    }
    expect(
      media.heavyCommand('ffmpeg', ['-i', 'a'], { SOCIALMONITOR_HEAVY_LOCK: 'off' })[1],
    ).not.toContain('/tmp/shades-heavy.lock')
    expect(media.videoArgs('in.mp4', 'out.mp4', 24, true)).toEqual(
      expect.arrayContaining([
        'libx264',
        'high',
        'slow',
        '24',
        'aac',
        '96k',
        '+faststart',
        'yuv420p',
      ]),
    )
  })
})

describe('the schedule', () => {
  it('checks a brand with Stories in its plan every three hours, from Node when nothing is up', async () => {
    const { db, brand } = setup()
    const deps = {
      get: async () => profileHtml(0),
      open: async () => {
        throw new Error('no browser when no story is up')
      },
    }
    const t0 = new Date('2026-11-04T09:00:00.000Z')
    expect(await st.storiesTick(db, t0, deps)).toBeNull()
    setPlan(db, brand.id, { stories: true }, null)
    const first = await st.storiesTick(db, t0, deps)
    expect(first).toBeTypeOf('number')
    await st.storiesIdle()
    const run = st.lastStoryRun(db, brand.id)!
    expect(run.status).toBe('ok')
    // The rival is not read: Competitor stories is off.
    expect(run.log).toContain('@tavelo.md: no story up now.')
    expect(run.log).not.toContain('lumio')
    db.prepare('UPDATE story_runs SET started_at = ?').run(t0.toISOString())
    expect(await st.storiesTick(db, new Date(t0.getTime() + 2 * 3600_000), deps)).toBeNull()
    const later = await st.storiesTick(db, new Date(t0.getTime() + 3.6 * 3600_000), deps)
    expect(later).toBeTypeOf('number')
    await st.storiesIdle()
    expect(db.prepare("SELECT value FROM settings WHERE key = 'stories_cleanup_on'").get()).toEqual(
      {
        value: '2026-11-04',
      },
    )
  })

  it('reads the rivals within the plan’s limit when Competitor stories is on', async () => {
    const { db, brand } = setup()
    store.addCompetitor(db, brand.id, 'Nordo', ['https://www.tiktok.com/@nordo'])
    setPlan(db, brand.id, { stories: true, rival_stories: true, rival_limit: 1 }, null)
    const asked: string[] = []
    st.startStoriesCheck(db, brand.id, 'manual', null, {
      deps: {
        get: async (url) => {
          asked.push(url)
          return profileHtml(0)
        },
      },
    })
    await st.storiesIdle()
    // Nordo, added second, is past the limit of one: paused, so not read.
    expect(asked.map((u) => u.split('@')[1])).toEqual(['tavelo.md', 'lumio.store'])
  })
})

describe('Claude’s reading of a story', () => {
  it('reads its six lines and keeps only known kinds, tones and real handles', () => {
    expect(
      parseStoryReading(`about|A promo for autumn bags at 20% off in the Chișinău store.
kind|promo
text|AUTUMN SALE / -20%
accounts|@lumio.store, @Tavelo_MD bad-handle!
tone|positive
repost|-`),
    ).toEqual({
      about: 'A promo for autumn bags at 20% off in the Chișinău store.',
      kind: 'promo',
      text: 'AUTUMN SALE / -20%',
      accounts: ['lumio.store', 'tavelo_md'],
      tone: 'positive',
      repostOf: null,
    })
    expect(
      parseStoryReading(
        'about|Shares a fan video.\nkind|Behind the scenes\ntone|odd\nrepost|@fan.page',
      ),
    ).toMatchObject({
      kind: 'behind-the-scenes',
      tone: 'neutral',
      repostOf: 'fan.page',
      text: null,
    })
    expect(parseStoryReading('nothing useful')).toBeNull()
  })
})

describe('Instagram and Facebook stories through Meta’s API', () => {
  const answers = (calls: string[]) =>
    (async (path: string, params: Record<string, string>) => {
      calls.push(`${path}?${params.metric ?? params.fields ?? ''}`)
      if (path === '/1784/stories')
        return {
          data: [
            {
              id: '9001',
              media_type: 'VIDEO',
              media_url: 'https://scontent.example/9001.mp4',
              thumbnail_url: 'https://scontent.example/9001.jpg',
              permalink: 'https://www.instagram.com/stories/tavelo/9001/',
              timestamp: '2026-11-04T08:00:00+0000',
              caption: 'Come by @lumio.store',
              username: 'tavelo',
            },
          ],
        }
      if (path === '/9001/insights' && params.metric?.includes('views'))
        throw new MetaRefused('Meta: (#100) metric views is not supported', 100, undefined)
      if (path === '/9001/insights' && params.metric === 'reach,replies')
        return {
          data: [
            { name: 'reach', values: [{ value: 812 }] },
            { name: 'replies', values: [{ value: 4 }] },
          ],
        }
      if (path === '/9001/insights' && params.metric === 'navigation')
        return {
          data: [
            {
              name: 'navigation',
              total_value: {
                value: 300,
                breakdowns: [
                  {
                    results: [
                      { dimension_values: ['tap_forward'], value: 210 },
                      { dimension_values: ['tap_exit'], value: 40 },
                    ],
                  },
                ],
              },
            },
          ],
        }
      if (path === '/555/stories')
        return {
          data: [
            {
              post_id: '555_77',
              media_id: '77',
              media_type: 'photo',
              creation_time: 1793779200,
              status: 'PUBLISHED',
            },
            {
              post_id: '555_78',
              media_id: '78',
              media_type: 'photo',
              creation_time: 1793779300,
              status: 'ARCHIVED',
            },
          ],
        }
      if (path === '/77')
        return {
          images: [
            { source: 'https://scontent.example/77-small.jpg', width: 320, height: 568 },
            { source: 'https://scontent.example/77.jpg', width: 1080, height: 1920 },
          ],
        }
      throw new Error(`unexpected ${path}`)
    }) as GraphGet

  const connect = (db: ReturnType<typeof setup>['db'], brandId: number) => {
    const put = db.prepare(
      `INSERT INTO network_tokens (brand_id, network, open_id, access_token, refresh_token, expires_at,
         refresh_expires_at, scope, account, connected_at) VALUES (?, ?, ?, 'page-token', '', '9999', '9999', '', '{}', '2026-11-01')`,
    )
    put.run(brandId, 'instagram', '1784')
    put.run(brandId, 'facebook', '555')
  }

  it('stays off until META_STORIES=on, asking Meta nothing', async () => {
    const { db, brand } = setup()
    connect(db, brand.id)
    const calls: string[] = []
    delete process.env.META_STORIES
    expect(await meta.readMetaStories(db, brand.id, {}, answers(calls))).toEqual([])
    expect(calls).toEqual([])
  })

  it('reads the connected account’s stories with their insights once it is on', async () => {
    const { db, brand } = setup()
    connect(db, brand.id)
    const calls: string[] = []
    process.env.META_STORIES = 'on'
    try {
      const items = await meta.readMetaStories(db, brand.id, { facebook: 'tavelo' }, answers(calls))
      expect(items).toHaveLength(2)
      expect(items[0]).toMatchObject({
        network: 'instagram',
        ext_id: '9001',
        handle: 'tavelo',
        posted_at: '2026-11-04T08:00:00.000Z',
        expires_at: '2026-11-05T08:00:00.000Z',
        mentions: ['lumio.store'],
        replies: 4,
        insights: { reach: 812, replies: 4, taps_forward: 210, exits: 40 },
        permalink: 'https://www.instagram.com/stories/tavelo/9001/',
        media: [
          expect.objectContaining({ kind: 'video', urls: ['https://scontent.example/9001.mp4'] }),
        ],
      })
      // The archived Facebook story is left out; the photo comes at its biggest size.
      expect(items[1]).toMatchObject({
        network: 'facebook',
        ext_id: '555_77',
        handle: 'tavelo',
        media: [
          expect.objectContaining({
            kind: 'image',
            width: 1080,
            urls: ['https://scontent.example/77.jpg'],
          }),
        ],
      })
    } finally {
      delete process.env.META_STORIES
    }
  })
})

describe('the Stories screen’s figures', () => {
  it('filters by account, state, kind and mentions, and leaves rivals out of an own-only scope', () => {
    const { db, brand, rival } = setup()
    const at = new Date('2026-11-04T12:00:00.000Z')
    const put = (
      brandId: number,
      ext: string,
      posted: string,
      extra: Record<string, unknown> = {},
    ) => {
      const { id } = st.saveStory(db, brand.id, brandId, {
        network: 'tiktok',
        ext_id: ext,
        handle: brandId === brand.id ? 'tavelo.md' : 'lumio.store',
        posted_at: posted,
        expires_at: new Date(Date.parse(posted) + 86_400_000).toISOString(),
        caption: '',
        media: [],
        stickers: [],
        mentions: [],
        links: [],
        music: null,
        views: null,
        likes: null,
        shares: null,
        replies: null,
        insights: null,
        permalink: null,
        is_ad: false,
      })
      const keys = Object.keys(extra)
      if (keys.length)
        db.prepare(`UPDATE stories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
          ...(Object.values(extra) as string[]),
          id,
        )
    }
    put(brand.id, 'a', '2026-11-04T09:15:00.000Z', {
      ai_kind: 'promo',
      mentions: '["lumio.store"]',
    })
    put(brand.id, 'b', '2026-11-01T18:00:00.000Z', {
      ai_kind: 'event',
      ai_accounts: '["lumio.store","fan.page"]',
    })
    put(rival.id, 'c', '2026-11-02T18:30:00.000Z', { ai_kind: 'repost', ai_repost_of: 'fan.page' })
    const all = view.storiesView(db, brand.id, { own: true, rivals: true }, {}, at)
    expect(all.stories.map((s) => s.id)).toHaveLength(3)
    expect(all.facets.state).toEqual({ live: 1, expired: 2 })
    expect(all.stories[0]).toMatchObject({ live: true, own: true, mentions: ['lumio.store'] })
    const own = view.storiesView(db, brand.id, { own: true, rivals: false }, {}, at)
    expect(own.stories.every((s) => s.own)).toBe(true)
    expect(own.accounts.map((a) => a.brand_id)).toEqual([brand.id])
    // Asking for the rival by id does not get past the scope.
    expect(
      view.storiesView(db, brand.id, { own: true, rivals: false }, { brands: [rival.id] }, at)
        .stories,
    ).toHaveLength(2)
    const pick = (f: StoryFilter) =>
      view
        .storiesView(db, brand.id, { own: true, rivals: true }, f, at)
        .stories.map((s) => s.handle + s.kind)
    expect(pick({ state: 'live' })).toEqual(['tavelo.mdpromo'])
    expect(pick({ has: 'reposts' })).toEqual(['lumio.storerepost'])
    expect(pick({ has: 'mentions', since: '2026-11-01', until: '2026-11-03' })).toEqual([
      'tavelo.mdevent',
    ])
    const stats = view.storyStats(db, brand.id, { own: true, rivals: true }, 7, at)
    expect(stats.series.map((s) => [s.name, s.total])).toEqual([
      ['Tavelo', 2],
      ['Lumio', 1],
    ])
    expect(stats.series[0]!.values.at(-1)).toBe(1)
    expect(stats.heatmap[3]![9]).toBe(1) // Wednesday 9 UTC
    expect(stats.mentioned[0]).toEqual({ handle: 'lumio.store', n: 2 })
    expect(stats.reposts).toEqual([{ handle: 'fan.page', n: 1 }])
  })
})
