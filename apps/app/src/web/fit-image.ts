/**
 * Makes a picture fit an upload limit in the browser, keeping as much of it as it can: the full
 * resolution when that fits, else the long edge capped; the highest quality that fits, found by
 * halving; smaller steps only when even the lowest quality is too big. Never enlarges.
 *
 * The search is pure and takes its codec as an argument, so it runs in tests; the browser codec
 * below draws on a canvas.
 */

export interface Picture {
  width: number
  height: number
  /** Whether any pixel is see-through. */
  alpha: boolean
}
export interface Codec<P extends Picture = Picture> {
  /** The picture, turned upright from its EXIF; null when this browser cannot open the file. */
  decode(file: Blob): Promise<P | null>
  encode(p: P, width: number, height: number, type: string, quality: number): Promise<Blob>
  webp(): boolean
  close?(p: P): void
}
export interface FitOptions {
  maxBytes: number
  /** The long edge, in pixels, once the file has to be made smaller. */
  maxEdge: number
  /** Types the server takes as they are: a file of one of them that already fits is sent untouched. */
  keep: string[]
}

const Q_HIGH = 0.98
const Q_LOW = 0.6
const STEP = 0.85

/** The file to send: the original when it fits, a smaller copy, or null when it cannot be opened. */
export async function fitImage<P extends Picture>(
  file: Blob,
  o: FitOptions,
  codec: Codec<P>,
): Promise<Blob | null> {
  if (file.size <= o.maxBytes && o.keep.includes(file.type)) return file
  const p = await codec.decode(file)
  if (!p) return null
  try {
    // A see-through picture keeps its transparency: WebP has it, JPEG does not, so PNG then.
    const type = codec.webp() ? 'image/webp' : p.alpha ? 'image/png' : 'image/jpeg'
    const lossy = type !== 'image/png'
    const long = Math.max(p.width, p.height)
    let scale = file.size > o.maxBytes ? Math.min(1, o.maxEdge / long) : 1
    while (long * scale >= 16) {
      const w = Math.max(1, Math.round(p.width * scale))
      const h = Math.max(1, Math.round(p.height * scale))
      const at = (q: number) => codec.encode(p, w, h, type, q)
      const top = await at(Q_HIGH)
      if (top.size <= o.maxBytes) return top
      if (lossy) {
        let low = Q_LOW
        let high = Q_HIGH
        let best = await at(Q_LOW)
        if (best.size <= o.maxBytes) {
          // Halve the gap between the lowest quality that fits and the lowest that does not.
          for (let i = 0; i < 6; i++) {
            const q = (low + high) / 2
            const b = await at(q)
            if (b.size <= o.maxBytes) {
              best = b
              low = q
            } else high = q
          }
          return best
        }
      }
      scale *= STEP
    }
    return null
  } finally {
    codec.close?.(p)
  }
}

type Bitmap = Picture & { bitmap: ImageBitmap }

/** The browser's own decoder and canvas. */
export const browserCodec: Codec<Bitmap> = {
  async decode(file) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { bitmap, width: bitmap.width, height: bitmap.height, alpha: seeThrough(bitmap) }
    } catch {
      return null
    }
  },
  async encode(p, w, h, type, quality) {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, w, h)
    }
    ctx.drawImage(p.bitmap, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, type, quality))
    if (!blob) throw new Error('The picture could not be made smaller.')
    return blob
  },
  webp() {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    return c.toDataURL('image/webp').startsWith('data:image/webp')
  },
  close(p) {
    p.bitmap.close()
  },
}

/** Whether any pixel is see-through, read from a copy at most 256 pixels wide. */
function seeThrough(b: ImageBitmap): boolean {
  const k = Math.min(1, 256 / Math.max(b.width, b.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(b.width * k))
  c.height = Math.max(1, Math.round(b.height * k))
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  ctx.drawImage(b, 0, 0, c.width, c.height)
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  for (let i = 3; i < d.length; i += 4) if (d[i]! < 255) return true
  return false
}
