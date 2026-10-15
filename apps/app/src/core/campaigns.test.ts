import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { addBrand, listPosts, listProfiles, savePost, updateBrand } from './store.ts'
import {
  cleanCampaign,
  hashtagsOf,
  inRange,
  parsePicks,
  placeByAi,
  postCampaigns,
  ruleMatches,
  saveCampaign,
  setPostCampaign,
} from './campaigns.ts'
import type { AskCampaigns } from './campaigns.ts'
import { labelTotals } from './insights.ts'

const rule = (id: number, x: Partial<{ s: string; e: string; h: string[]; k: string[] }>) => ({
  id,
  starts_on: x.s ?? null,
  ends_on: x.e ?? null,
  hashtags: x.h ?? [],
  keywords: x.k ?? [],
})

describe('campaign rules', () => {
  it('reads hashtags in any alphabet, ignoring case', () => {
    expect([...hashtagsOf('Vara cu #Vara5G și #ЛетоСкидки! #vara5g')]).toEqual([
      'vara5g',
      'летоскидки',
    ])
  })

  it('matches by hashtag or whole keyword, inside the dates only', () => {
    const rules = [
      rule(1, { h: ['vara5g'], s: '2026-06-01', e: '2026-08-31' }),
      rule(2, { k: ['fibra 1 gbps'] }),
      rule(3, { k: ['5g'] }),
      rule(4, {}), // no hints: never by rule
    ]
    const at = '2026-07-10T09:00:00.000Z'
    expect(ruleMatches({ caption: 'Hai la #Vara5G', posted_at: at }, rules)).toEqual([1])
    expect(
      ruleMatches({ caption: 'Hai la #Vara5G', posted_at: '2026-09-01T00:00:00Z' }, rules),
    ).toEqual([])
    expect(ruleMatches({ caption: 'Hai la #Vara5G', posted_at: null }, rules)).toEqual([])
    expect(ruleMatches({ caption: 'Noua FIBRA 1 Gbps acasă', posted_at: at }, rules)).toEqual([2])
    // A keyword inside a longer word is not a match.
    expect(ruleMatches({ caption: 'Rețea 5GHz', posted_at: at }, rules)).toEqual([])
    expect(ruleMatches({ caption: 'Rețea 5G, peste tot', posted_at: at }, rules)).toEqual([3])
    expect(inRange({ starts_on: '2026-07-10', ends_on: '2026-07-10' }, at)).toBe(true)
  })

  it('tidies what a person typed and refuses what makes no sense', () => {
    expect(
      cleanCampaign({
        name: ' Vara ',
        hashtags: '#Vara5G, #vara5g #Leto',
        keywords: '5G, fibra\n x',
      }),
    ).toMatchObject({ name: 'Vara', hashtags: ['vara5g', 'leto'], keywords: ['5g', 'fibra'] })
    expect(() => cleanCampaign({ name: '' })).toThrow()
    expect(() =>
      cleanCampaign({ name: 'A', starts_on: '2026-09-01', ends_on: '2026-08-01' }),
    ).toThrow()
    expect(() => cleanCampaign({ name: 'A', starts_on: '1 Sept' })).toThrow()
  })
})

describe("Claude's campaign picks", () => {
  it('keeps only valid lines naming an offered campaign', () => {
    const picks = parsePicks('1|7\n2|-\n3|99\nnot a line\n 4 | 8 \n5|7|extra', new Set([7, 8]))
    expect([...picks]).toEqual([
      [1, 7],
      [2, null],
      [4, 8],
    ])
  })
})

describe('posts in campaigns', () => {
  const setup = () => {
    const db = openDb(':memory:')
    const brand = addBrand(db, 'Camp', ['https://www.tiktok.com/@camp'])
    const [profile] = listProfiles(db, brand.id)
    const post = (ext_id: string, caption: string) =>
      savePost(db, profile!, {
        ext_id,
        url: `https://www.tiktok.com/@camp/video/${ext_id}`,
        posted_at: '2026-07-10T09:00:00.000Z',
        kind: 'video',
        caption,
        thumb_url: null,
        likes: 1,
        comments_count: 1,
        shares: 0,
        views: 10,
        comments: [
          {
            ext_id: `${ext_id}-c`,
            parent_ext_id: null,
            author: 'someone',
            text: 'De ce?',
            likes: 0,
            posted_at: '2026-07-10T10:00:00.000Z',
          },
        ],
      }).post
    return { db, brand, post }
  }

  it('places posts by the hints as they are saved, and when a campaign changes', () => {
    const { db, brand, post } = setup()
    const before = post('a', 'Oferta #vara5g')
    const summer = saveCampaign(db, brand.id, { name: 'Vara', hashtags: '#vara5g' })
    // The post saved before the campaign existed is placed when the campaign is saved.
    expect(postCampaigns(db, before.id)).toEqual([
      expect.objectContaining({ id: summer.id, member: 1, set_by: 'rule' }),
    ])
    const later = post('b', 'Încă una #VARA5G')
    expect(
      JSON.parse(listPosts(db, { campaignId: summer.id }).map((p) => p.campaign_ids)[0]!),
    ).toEqual([summer.id])
    expect(
      listPosts(db, { campaignId: summer.id })
        .map((p) => p.id)
        .sort(),
    ).toEqual([before.id, later.id].sort())
    // Comments and figures follow the campaign.
    expect(labelTotals(db, { brandId: brand.id, campaignId: summer.id }).total).toBe(2)
    // The hint changes: the rule's placements follow.
    saveCampaign(db, brand.id, { name: 'Vara', hashtags: '#altceva' }, summer.id)
    expect(listPosts(db, { campaignId: summer.id })).toHaveLength(0)
  })

  it("never overwrites a person's choice, in or out", () => {
    const { db, brand, post } = setup()
    const c = saveCampaign(db, brand.id, { name: 'Vara', hashtags: '#vara5g' })
    const p = post('a', 'Oferta #vara5g')
    setPostCampaign(db, p.id, c.id, false)
    post('a', 'Oferta #vara5g') // read again
    saveCampaign(db, brand.id, { name: 'Vara', hashtags: '#vara5g', about: 'x' }, c.id)
    expect(postCampaigns(db, p.id)[0]).toMatchObject({ member: 0, set_by: 'you' })
    setPostCampaign(db, p.id, c.id, true)
    expect(postCampaigns(db, p.id)[0]).toMatchObject({ member: 1, set_by: 'you' })
    const other = addBrand(db, 'Other', ['https://www.tiktok.com/@other'])
    const foreign = saveCampaign(db, other.id, { name: 'Theirs' })
    expect(() => setPostCampaign(db, p.id, foreign.id, true)).toThrow()
  })

  it('places nothing by itself when the brand turns it off', () => {
    const { db, brand, post } = setup()
    updateBrand(db, brand.id, { campaign_auto: false })
    const c = saveCampaign(db, brand.id, { name: 'Vara', hashtags: '#vara5g' })
    const p = post('a', 'Oferta #vara5g')
    expect(postCampaigns(db, p.id)[0]).toMatchObject({ id: c.id, member: 0, set_by: null })
  })

  it('lets Claude place what the hints did not, once per version of the campaigns', async () => {
    const { db, brand, post } = setup()
    const summer = saveCampaign(db, brand.id, {
      name: 'Vara',
      starts_on: '2026-06-01',
      ends_on: '2026-08-31',
    })
    const winter = saveCampaign(db, brand.id, { name: 'Iarna', starts_on: '2026-12-01' })
    const a = post('a', 'Bucurați-vă de soare')
    const b = post('b', 'Nimic de văzut')
    const ruled = post('c', 'x')
    setPostCampaign(db, ruled.id, summer.id, true)
    const asked: number[] = []
    const ask: AskCampaigns = async (_brand, offer, posts) => {
      asked.push(posts.length)
      expect(offer.map((o) => o.name).sort()).toEqual(['Iarna', 'Vara'])
      // Post 2 is put in winter, outside its dates: dropped.
      return `1|${summer.id}\n2|${winter.id}`
    }
    expect(await placeByAi(db, [a.id, b.id, ruled.id], ask)).toBe(1)
    expect(asked).toEqual([2]) // the post a person placed is not asked about
    expect(postCampaigns(db, a.id).find((x) => x.id === summer.id)).toMatchObject({
      member: 1,
      set_by: 'ai',
    })
    expect(postCampaigns(db, b.id).every((x) => !x.member)).toBe(true)
    // Asked once: not again until the campaigns change.
    expect(await placeByAi(db, [b.id], ask)).toBe(0)
    expect(asked).toEqual([2])
  })
})
