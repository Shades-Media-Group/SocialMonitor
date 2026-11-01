import { existsSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'

/**
 * The file a /media/ address names under `root` (data/media), or null when there is none or the
 * reader may not have it. Ad pictures, the Pages' pictures under ads/pages included, belong to the
 * owner's Ads dashboard: nobody but a super admin gets them, by any spelling of the path. Nothing
 * outside `root` is ever served.
 */
export function mediaFile(root: string, path: string, isSuper: boolean): string | null {
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
  if (!file.startsWith(root + sep)) return null
  if (!existsSync(file) || !statSync(file).isFile()) return null
  return file
}
