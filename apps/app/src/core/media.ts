import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db.ts'
import type { Network } from './types.ts'

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
}

/**
 * Keeps a local copy of a picture so it still shows after the network's signed link expires.
 * Pictures come from the networks' public image servers with no cookies, so fetching them never
 * touches the signed-in account. A file that is already saved is not fetched again. The file
 * keeps its real type: stickers are animated WebP, photos JPEG.
 */
export async function saveImage(
  network: Network | 'ads',
  folder: string,
  id: string,
  url: string | null | undefined,
  /** Bigger files are not kept. */
  maxBytes = Infinity,
): Promise<string | null> {
  if (!url || url.startsWith('/media/')) return url ?? null
  const dir = join(DATA_DIR, 'media', network, folder)
  const base = id.replace(/[^\w.-]/g, '_').slice(0, 80)
  const local = (file: string) => `/media/${network}/${folder ? `${folder}/` : ''}${file}`
  for (const ext of Object.values(EXT))
    if (existsSync(join(dir, base + ext))) return local(base + ext)
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, credentials: 'omit' })
    if (!r.ok) return null
    if (Number(r.headers.get('content-length')) > maxBytes) return null
    const data = Buffer.from(await r.arrayBuffer())
    if (data.length > maxBytes) return null
    // Some image servers send AVIF under a JPEG type: the file's own signature decides.
    const avif = data.subarray(4, 12).toString('latin1').startsWith('ftypavi')
    const ext = avif
      ? '.avif'
      : (EXT[(r.headers.get('content-type') ?? '').split(';')[0]!.trim()] ?? '.jpg')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, base + ext), data)
    return local(base + ext)
  } catch {
    return null
  }
}

/**
 * A picture's width and height from its first bytes (JPEG, PNG, GIF, WebP), so an ad's creative
 * can be drawn at its own shape before it loads. Null for anything else.
 */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? { width: w, height: h } : null)
  try {
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++
          continue
        }
        const m = b[i + 1]!
        if (m === 0xff) {
          i++
          continue
        }
        // Start-of-frame markers carry the size; DHT, JPG and DAC share the range and do not.
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
          return ok(v.getUint16(i + 7), v.getUint16(i + 5))
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          i += 2
          continue
        }
        i += 2 + v.getUint16(i + 2)
      }
      return null
    }
    if (ascii(1, 4) === 'PNG') return ok(v.getUint32(16), v.getUint32(20))
    if (ascii(0, 3) === 'GIF') return ok(v.getUint16(6, true), v.getUint16(8, true))
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
      const kind = ascii(12, 16)
      if (kind === 'VP8X')
        return ok(1 + (v.getUint32(24, true) & 0xffffff), 1 + (v.getUint32(27, true) & 0xffffff))
      if (kind === 'VP8 ') return ok(v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff)
      if (kind === 'VP8L') {
        const bits = v.getUint32(21, true)
        return ok(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff))
      }
    }
  } catch {
    /* cut short */
  }
  return null
}

/** The size of a picture already saved under data/media, from its /media/ path. */
export function savedImageSize(path: string | null | undefined) {
  if (!path?.startsWith('/media/')) return null
  const file = join(DATA_DIR, 'media', path.slice('/media/'.length))
  if (!existsSync(file)) return null
  try {
    const fd = openSync(file, 'r')
    try {
      const head = Buffer.alloc(65536)
      const n = readSync(fd, head, 0, head.length, 0)
      return imageSize(head.subarray(0, n))
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}
