import { describe, expect, it } from 'vitest'
import { imageSize } from './media.ts'

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  )

describe('a picture’s size from its first bytes', () => {
  it('reads JPEG past the segments before the frame', () => {
    // SOI, an APP0 segment of 16 bytes, then a baseline frame of 1080 × 1920.
    const jpeg = bytes(
      [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10],
      new Array(14).fill(0),
      [0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x80, 0x04, 0x38, 0x03],
    )
    expect(imageSize(jpeg)).toEqual({ width: 1080, height: 1920 })
  })

  it('reads PNG, GIF and WebP', () => {
    const png = bytes(
      [0x89],
      'PNG',
      [13, 10, 26, 10, 0, 0, 0, 13],
      'IHDR',
      [0, 0, 2, 88, 0, 0, 1, 144],
    )
    expect(imageSize(png)).toEqual({ width: 600, height: 400 })
    expect(imageSize(bytes('GIF89a', [0x58, 0x02, 0x90, 0x01]))).toEqual({
      width: 600,
      height: 400,
    })
    const vp8x = bytes(
      'RIFF',
      [0, 0, 0, 0],
      'WEBPVP8X',
      new Array(8).fill(0),
      [0x57, 0x02, 0x00, 0x8f, 0x01, 0x00, 0x00],
    )
    expect(imageSize(vp8x)).toEqual({ width: 600, height: 400 })
  })

  it('says nothing for other files or a file cut short', () => {
    expect(imageSize(bytes('<html>'))).toBeNull()
    expect(imageSize(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBeNull()
    expect(imageSize(new Uint8Array())).toBeNull()
  })
})
