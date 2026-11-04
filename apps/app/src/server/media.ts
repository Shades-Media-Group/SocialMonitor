import { existsSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'

/** Whether the reader may have one story's files: (watching brand, story id) → yes or no. */
export type StoryAccess = (watcher: number, storyId: number) => boolean

/**
 * The file a /media/ address names under `root` (data/media), or null when there is none or the
 * reader may not have it. Ad pictures, the Pages' pictures under ads/pages included, belong to the
 * owner's Ads dashboard: nobody but a super admin gets them, by any spelling of the path. Stories'
 * compact copies and posters live under stories/<brand>/<story>-<n>[-poster].<ext> and go only to
 * someone `story` lets see that story; any other name under stories/ is nothing. Nothing outside
 * `root` is ever served.
 */
export function mediaFile(
  root: string,
  path: string,
  isSuper: boolean,
  story?: StoryAccess,
): string | null {
  let rest: string
  try {
    rest = decodeURIComponent(path.slice('/media/'.length))
  } catch {
    return null
  }
  if (rest.includes('\0')) return null
  const file = normalize(join(root, rest))
  const ads = join(root, 'ads')
  if ((file === ads || file.startsWith(ads + sep)) && !isSuper) return null
  const stories = join(root, 'stories')
  if (file === stories || file.startsWith(stories + sep)) {
    const m = /^(\d{1,9})[\\/](\d{1,12})-(\d{1,3})(-poster)?\.(mp4|webp)$/.exec(
      file.slice(stories.length + 1),
    )
    if (!m || !story?.(Number(m[1]), Number(m[2]))) return null
  }
  if (!file.startsWith(root + sep)) return null
  if (!existsSync(file) || !statSync(file).isFile()) return null
  return file
}

/**
 * The byte range a Range header asks for, inside a file of `size` bytes: Safari plays a video
 * only from a server that answers ranges. Null for no header or one this does not answer (then
 * the whole file goes); 'bad' for a range outside the file (416).
 */
export function byteRange(header: string | undefined, size: number) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  let start: number
  let end: number
  if (!m[1]) {
    // The last n bytes.
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (start >= size || start > end) return 'bad' as const
  return { start, end }
}
