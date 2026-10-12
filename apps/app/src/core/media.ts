import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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
  network: Network,
  folder: string,
  id: string,
  url: string | null | undefined,
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
    const data = Buffer.from(await r.arrayBuffer())
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
