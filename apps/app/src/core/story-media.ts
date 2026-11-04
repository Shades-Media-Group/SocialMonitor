import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './db.ts'

/**
 * A story's files. Each one is kept twice for a while: the original, at the best quality the
 * network served, for STORIES_ORIGINAL_DAYS (10) days to download; and a compact copy kept for
 * good, made so it looks the same on a phone or a laptop: H.264 High at CRF 24 (preset slow, its
 * own size, AAC 96k, +faststart, so every browser plays it, Safari included) for a video, WebP
 * quality 82 at its own size for a picture. A small poster goes with each, for the gallery.
 *
 * Encoding runs one file at a time at the lowest CPU and disk priority, and on a computer that
 * shares the heavy-work lock (/tmp/shades-heavy.lock) it waits its turn there. Nothing is
 * downloaded from anywhere but the network's own media servers, with no cookies of an account.
 */

/** Days an original stays downloadable before the daily cleanup removes it. */
export const ORIGINAL_DAYS = Math.max(1, Number(process.env.STORIES_ORIGINAL_DAYS) || 10)
/** The compact video's quality: 24 measured indistinguishable from the original (docs/stories.md). */
export const CRF = Math.min(35, Math.max(16, Number(process.env.STORIES_CRF) || 24))
export const AUDIO_KBPS = 96
export const IMAGE_QUALITY = 82
const POSTER_WIDTH = 360

export const VIDEO_MAX_BYTES = 300 * 1024 * 1024
export const IMAGE_MAX_BYTES = 40 * 1024 * 1024

/** Where the originals live: outside data/media, so only the download route ever hands them out. */
export const originalsDir = (watcher: number) => join(DATA_DIR, 'stories', String(watcher))
/** The compact copies and posters, served under /media/stories/<watcher>/ to people who may see them. */
export const compactDir = (watcher: number) => join(DATA_DIR, 'media', 'stories', String(watcher))
export const mediaUrl = (watcher: number, file: string) => `/media/stories/${watcher}/${file}`

/** A file as the network answered it. */
export interface Fetched {
  ok: boolean
  status: number
  type: string
  body: Buffer
}
/** How files are fetched: plain Node, or a logged-out browser's request context (TikTok video). */
export type Fetcher = (url: string) => Promise<Fetched>

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'

export const nodeFetcher: Fetcher = async (url) => {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.tiktok.com/' },
    credentials: 'omit',
  })
  return {
    ok: r.ok,
    status: r.status,
    type: r.headers.get('content-type') ?? '',
    body: Buffer.from(await r.arrayBuffer()),
  }
}

const EXT: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/avif': '.avif',
}

/** The file's type from its first bytes, when the server's header says something else. */
export function sniff(b: Buffer, kind: 'video' | 'image', header: string): string {
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg'
  if (b.subarray(1, 4).toString('latin1') === 'PNG') return '.png'
  if (
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return '.webp'
  const box = b.subarray(4, 12).toString('latin1')
  if (box.startsWith('ftypavi')) return '.avif'
  if (box.startsWith('ftyphei') || box.startsWith('ftypmif')) return '.heic'
  if (box.startsWith('ftypqt')) return '.mov'
  if (box.startsWith('ftyp')) return '.mp4'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return '.webm'
  return EXT[header.split(';')[0]!.trim()] ?? (kind === 'video' ? '.mp4' : '.jpg')
}

/**
 * Saves the first mirror that answers with a real file, as `base` plus its own extension.
 * Returns the path and size, or why it failed.
 */
export async function download(
  fetcher: Fetcher,
  urls: string[],
  base: string,
  kind: 'video' | 'image',
): Promise<{ path: string; bytes: number } | { error: string }> {
  const max = kind === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES
  let error = 'no address to fetch'
  for (const url of urls.slice(0, 4)) {
    if (!/^https:\/\//.test(url)) continue
    try {
      const r = await fetcher(url)
      if (!r.ok) {
        error = `the media server answered ${r.status}`
        continue
      }
      if (r.body.length < 512) {
        error = 'the media server sent an empty file'
        continue
      }
      if (r.body.length > max) return { error: 'the file is larger than the limit' }
      if (/text\/html/.test(r.type)) {
        error = 'the media server sent a page instead of the file'
        continue
      }
      const path = base + sniff(r.body, kind, r.type)
      mkdirSync(dirname(path), { recursive: true })
      // Written next to its place and moved in, so a half-written file never counts as kept.
      writeFileSync(`${path}.part`, r.body)
      renameSync(`${path}.part`, path)
      return { path, bytes: r.body.length }
    } catch (e) {
      error = (e as Error).message
    }
  }
  return { error }
}

// Running the encoders

const has = (cmd: string) =>
  ['/usr/bin', '/bin', '/usr/local/bin'].some((d) => existsSync(join(d, cmd)))

/**
 * The command line for heavy work: the shared lock when this computer has one (and the env does
 * not turn it off), then the lowest CPU and disk priority. On macOS and Windows: the tool alone.
 */
export function heavyCommand(cmd: string, args: string[], env = process.env): [string, string[]] {
  if (process.platform !== 'linux') return [cmd, args]
  const lock = env.SOCIALMONITOR_HEAVY_LOCK ?? '/tmp/shades-heavy.lock'
  let line = [cmd, ...args]
  if (has('ionice')) line = ['ionice', '-c3', ...line]
  if (has('nice')) line = ['nice', '-n', '19', ...line]
  if (lock && lock !== 'off' && has('flock')) line = ['flock', lock, ...line]
  return [line[0]!, line.slice(1)]
}

/** Runs ffmpeg (or ffprobe) as heavy work and resolves with what it printed. */
function run(cmd: 'ffmpeg' | 'ffprobe', args: string[], heavy = true): Promise<string> {
  const [bin, argv] = heavy ? heavyCommand(cmd, args) : [cmd, args]
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)))
    child.on('error', (e) => reject(new Error(`${cmd} could not start: ${e.message}`)))
    child.on('close', (code) =>
      code === 0
        ? resolve(out || err)
        : reject(new Error(`${cmd} failed: ${err.trim().split('\n').slice(-2).join(' ')}`)),
    )
  })
}

/** Whether ffmpeg is installed here; without it, videos keep their original and no compact copy. */
export const ffmpegReady = () =>
  new Promise<boolean>((resolve) =>
    execFile('ffmpeg', ['-hide_banner', '-version'], (e) => resolve(!e)),
  )

export interface Probe {
  width: number | null
  height: number | null
  duration: number | null
  codec: string | null
  audio: boolean
}

/** A media file's size, length and codec, from ffprobe (not heavy: it reads the header only). */
export async function probe(file: string): Promise<Probe> {
  const out = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
    false,
  )
  const d = JSON.parse(out) as {
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]
    format?: { duration?: string }
  }
  const v = d.streams?.find((s) => s.codec_type === 'video')
  const duration = Number(d.format?.duration)
  return {
    width: v?.width ?? null,
    height: v?.height ?? null,
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 100) / 100 : null,
    codec: v?.codec_name ?? null,
    audio: !!d.streams?.some((s) => s.codec_type === 'audio'),
  }
}

/** The arguments of the compact copy: universal H.264 High, the original's own size. */
export const videoArgs = (src: string, out: string, crf = CRF, audio = true) => [
  '-hide_banner',
  '-y',
  '-i',
  src,
  '-map',
  '0:v:0',
  ...(audio ? ['-map', '0:a:0'] : []),
  // Even sides, which 4:2:0 needs; any original already has them, so its size is kept.
  '-vf',
  'scale=trunc(iw/2)*2:trunc(ih/2)*2',
  '-c:v',
  'libx264',
  '-profile:v',
  'high',
  '-preset',
  'slow',
  '-crf',
  String(crf),
  '-pix_fmt',
  'yuv420p',
  ...(audio ? ['-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`] : ['-an']),
  '-movflags',
  '+faststart',
  out,
]

/** The video as its compact copy. Written beside its place and moved in when whole. */
export async function encodeVideo(src: string, out: string, audio: boolean, crf = CRF) {
  mkdirSync(dirname(out), { recursive: true })
  const part = `${out}.part.mp4`
  await run('ffmpeg', videoArgs(src, part, crf, audio))
  renameSync(part, out)
  return statSync(out).size
}

/**
 * The original itself as the compact copy, moved into an MP4 that starts playing at once, for a
 * video already in H.264 and AAC that no encode would make smaller.
 */
export async function remuxVideo(src: string, out: string) {
  mkdirSync(dirname(out), { recursive: true })
  const part = `${out}.part.mp4`
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i',
    src,
    '-map',
    '0',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    part,
  ])
  renameSync(part, out)
  return statSync(out).size
}

/** A frame of the video at its own size (JPEG, for the poster and for the AI to read). */
export async function videoFrame(src: string, out: string, at: number) {
  mkdirSync(dirname(out), { recursive: true })
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss',
    String(at),
    '-i',
    src,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    out,
  ])
  return out
}

/** Three frames side by side (a quarter in, the middle, near the end), for the AI to read a video. */
export async function videoSheet(src: string, out: string, duration: number | null) {
  mkdirSync(dirname(out), { recursive: true })
  const d = duration && duration > 0.5 ? duration : 3
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i',
    src,
    '-vf',
    `fps=${(3 / d).toFixed(4)},scale=480:-2,tile=3x1`,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    out,
  ])
  return out
}

type Sharp = (input: string) => {
  rotate: () => ReturnType<Sharp>
  resize: (o: { width: number; withoutEnlargement: boolean }) => ReturnType<Sharp>
  webp: (o: { quality: number; effort: number }) => ReturnType<Sharp>
  toFile: (out: string) => Promise<{ size: number; width: number; height: number }>
}
let sharpLoaded: Sharp | null | undefined
async function loadSharp(): Promise<Sharp | null> {
  if (sharpLoaded !== undefined) return sharpLoaded
  try {
    sharpLoaded = ((await import('sharp')) as unknown as { default: Sharp }).default
  } catch {
    sharpLoaded = null
  }
  return sharpLoaded
}

/**
 * A picture as WebP: through sharp (turned the way its camera said), or through ffmpeg's WebP
 * encoder when sharp is not installed. `width` shrinks it (posters); without it, its own size.
 */
export async function toWebp(src: string, out: string, quality: number, width?: number) {
  mkdirSync(dirname(out), { recursive: true })
  const part = `${out}.part.webp`
  const sharp = await loadSharp()
  if (sharp) {
    let img = sharp(src).rotate()
    if (width) img = img.resize({ width, withoutEnlargement: true })
    await img.webp({ quality, effort: 5 }).toFile(part)
  } else {
    await run('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i',
      src,
      ...(width ? ['-vf', `scale='min(${width},iw)':-2`] : []),
      '-c:v',
      'libwebp',
      '-quality',
      String(quality),
      '-frames:v',
      '1',
      part,
    ])
  }
  renameSync(part, out)
  return statSync(out).size
}

export const posterOf = (src: string, out: string) => toWebp(src, out, 72, POSTER_WIDTH)
export const compactImage = (src: string, out: string) => toWebp(src, out, IMAGE_QUALITY)

/**
 * How alike two files look, frame by frame: SSIM (1 = identical) and PSNR in dB, from ffmpeg's
 * own filters; the compact copy keeps the original's size. For the measurements in the docs.
 */
export async function similarity(original: string, compact: string) {
  const out = await run('ffmpeg', [
    '-hide_banner',
    '-i',
    compact,
    '-i',
    original,
    '-lavfi',
    '[0:v]format=yuv420p,split[a1][a2];[1:v]format=yuv420p,split[b1][b2];[a1][b1]ssim;[a2][b2]psnr',
    '-f',
    'null',
    '-',
  ])
  const ssim = Number(/SSIM .*All:([\d.]+)/.exec(out)?.[1])
  const psnr = Number(/PSNR .*average:([\d.]+|inf)/.exec(out)?.[1])
  return { ssim: Number.isFinite(ssim) ? ssim : null, psnr: Number.isFinite(psnr) ? psnr : null }
}

export const fileBytes = (path: string | null | undefined) => {
  if (!path) return 0
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export const removeFile = (path: string | null | undefined) => {
  if (path) rmSync(path, { force: true })
}
