import { describe, expect, it } from 'vitest'
import { fitImage, type Codec, type Picture } from './fit-image.ts'

const MB = 1024 * 1024
const opts = { maxBytes: MB, maxEdge: 2048, keep: ['image/png', 'image/jpeg'] }

/** A fake codec: a file's size grows with its pixels and its quality, like a real encoder. */
function fake(p: Picture, webp = true) {
  const calls: { w: number; h: number; type: string; q: number }[] = []
  const codec: Codec = {
    decode: async () => p,
    webp: () => webp,
    encode: async (_p, w, h, type, q) => {
      calls.push({ w, h, type, q })
      const bytes = type === 'image/png' ? w * h * 0.5 : w * h * q * 0.3
      return new Blob([new Uint8Array(Math.round(bytes))], { type })
    },
  }
  return { codec, calls }
}
const file = (bytes: number, type = 'image/jpeg') => new Blob([new Uint8Array(bytes)], { type })

describe('fitting a picture to the upload limit', () => {
  it('sends a picture that already fits as it is', async () => {
    const f = file(500_000)
    const { codec, calls } = fake({ width: 4000, height: 3000, alpha: false })
    expect(await fitImage(f, opts, codec)).toBe(f)
    expect(calls).toEqual([])
  })

  it('caps the long edge, never enlarges, and keeps the highest quality that fits', async () => {
    const { codec, calls } = fake({ width: 6000, height: 4000, alpha: false })
    const out = (await fitImage(file(30 * MB), opts, codec))!
    expect(out.size).toBeLessThanOrEqual(MB)
    expect(out.type).toBe('image/webp')
    expect(Math.max(...calls.map((c) => c.w))).toBe(2048)
    // 2048 × 1365 at quality q weighs 838 656·q bytes: q = 0.98 fits at once.
    expect(calls[0]).toMatchObject({ w: 2048, h: 1365, q: 0.98 })

    const small = fake({ width: 900, height: 600, alpha: false })
    await fitImage(file(2 * MB, 'image/heic'), opts, small.codec)
    expect(small.calls[0]).toMatchObject({ w: 900, h: 600 })
  })

  it('searches the quality, then steps down in size when even the lowest is too big', async () => {
    const tight = { ...opts, maxBytes: 600_000 }
    const { codec, calls } = fake({ width: 6000, height: 4000, alpha: false })
    const out = (await fitImage(file(30 * MB), tight, codec))!
    expect(out.size).toBeLessThanOrEqual(600_000)
    const used = calls.find((c) => c.w === 2048 && out.size === Math.round(c.w * c.h * c.q * 0.3))!
    // The best fitting quality is within one search step of the exact answer, 600 000 / 838 656.
    expect(used.q).toBeGreaterThan(0.71)
    expect(used.q).toBeLessThanOrEqual(600_000 / (2048 * 1365 * 0.3))

    const tiny = { ...opts, maxBytes: 200_000 }
    const again = fake({ width: 6000, height: 4000, alpha: false })
    const small = (await fitImage(file(30 * MB), tiny, again.codec))!
    expect(small.size).toBeLessThanOrEqual(200_000)
    expect(Math.max(...again.calls.map((c) => c.w))).toBe(2048)
    expect(again.calls.at(-1)!.w).toBeLessThan(2048)
  })

  it('keeps transparency as PNG where the browser has no WebP, and gives up on an unknown file', async () => {
    const { codec, calls } = fake({ width: 3000, height: 3000, alpha: true }, false)
    const out = (await fitImage(file(20 * MB, 'image/png'), opts, codec))!
    expect(out.type).toBe('image/png')
    expect(calls.every((c) => c.type === 'image/png')).toBe(true)
    expect(out.size).toBeLessThanOrEqual(MB)
    const opaque = fake({ width: 3000, height: 3000, alpha: false }, false)
    expect((await fitImage(file(20 * MB), opts, opaque.codec))!.type).toBe('image/jpeg')

    const none: Codec = { ...codec, decode: async () => null }
    expect(await fitImage(file(20 * MB, 'image/heic'), opts, none)).toBeNull()
  })
})
