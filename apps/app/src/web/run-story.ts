/**
 * An update's log, retold for the person who started it: one plain sentence per thing that
 * happened, repeats folded together, the browser's inner workings left out. The raw log stays
 * one click away for whoever needs it.
 *
 * Pure, so it runs in tests: the caller passes its translate function (the dashboard's t).
 */

export type Tr = (s: string, vars?: Record<string, string | number>) => string
const english: Tr = (s, vars) =>
  vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')) : s

export type StoryKind = 'step' | 'good' | 'warn' | 'note'
export interface StoryItem {
  time: string
  kind: StoryKind
  text: string
  /** The plain reason behind a warning, when the log gives one. */
  detail?: string
  /** Items with the same key in a row fold into one. */
  key?: string
  n?: number
}
export interface Story {
  items: StoryItem[]
  accounts: number
  newComments: number
  sorted: number
  problems: number
}

const NET: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
}
const net = (n: string) => NET[n.toLowerCase()] ?? n

/** Lines that only say how the browser got past a page; the person learns nothing from them. */
const QUIET = [/public profile opened in a logged-out browser/i]

export function retell(log: string, t: Tr = english): Story {
  const story: Story = { items: [], accounts: 0, newComments: 0, sorted: 0, problems: 0 }
  let slowed = false
  const push = (item: StoryItem) => {
    const last = story.items.at(-1)
    if (last && last.text === item.text && last.kind === item.kind) return
    story.items.push(item)
  }
  /** Adds n to the item before when it has the same key, else starts a new one. */
  const add = (time: string, kind: StoryKind, key: string, n: number, say: (n: number) => string) => {
    const last = story.items.at(-1)
    if (last?.key === key) {
      last.n = (last.n ?? 0) + n
      last.text = say(last.n)
    } else story.items.push({ time, kind, key, n, text: say(n) })
  }
  for (const raw of log.split('\n')) {
    const m = raw.match(/^(\d\d:\d\d)(?::\d\d)?\s+(.*)$/)
    if (!m) continue
    const time = m[1]!
    const line = m[2]!.trim()
    if (!line || QUIET.some((q) => q.test(line))) continue
    let x: RegExpMatchArray | null
    if (/TikTok/i.test(line) && /Please wait/i.test(line)) {
      if (!slowed)
        push({
          time,
          kind: 'note',
          text: t(
            'TikTok asked for a pause, so its pages open in a private browser instead. Slower, but nothing is wrong.',
          ),
        })
      slowed = true
    } else if ((x = line.match(/^(.+): reading (instagram|facebook|tiktok) @(.+)\.$/i))) {
      story.accounts++
      push({
        time,
        kind: 'step',
        text: t('Reading {brand} on {network}', { brand: x[1]!, network: net(x[2]!) }),
      })
    } else if ((x = line.match(/^(\d+) new comments on /))) {
      story.newComments += Number(x[1])
      add(time, 'good', 'new', Number(x[1]), (n) => t('New comments found: {n}', { n }))
    } else if ((x = line.match(/^Facebook (\S+): (\d+) posts .*Page Public Content Access/))) {
      push({
        time,
        kind: 'good',
        text: t("{n} Facebook posts and their numbers, from Meta's official data", { n: x[2]! }),
        detail: t('Meta shares how many comments there are this way, not their text.'),
      })
    } else if ((x = line.match(/^Instagram @(\S+): (\d+) posts .*Business Discovery/))) {
      push({
        time,
        kind: 'good',
        text: t("{n} Instagram posts and their numbers, from Meta's official data", { n: x[2]! }),
      })
    } else if ((x = line.match(/^Stopped (instagram|facebook|tiktok): (.*)$/i))) {
      story.problems++
      push({
        time,
        kind: 'warn',
        text: t('{network} could not be read this time', { network: net(x[1]!) }),
        detail: x[2]!,
      })
    } else if ((x = line.match(/^(instagram|facebook|tiktok): inside the (\d+)-hour gap/i))) {
      push({
        time,
        kind: 'note',
        text: t(
          '{network} comments were read less than {h} hours ago, so only the numbers are refreshed.',
          { network: net(x[1]!), h: x[2]! },
        ),
      })
    } else if ((x = line.match(/^Sorting (\d+) comments on /))) {
      story.sorted += Number(x[1])
      add(time, 'step', 'sort', Number(x[1]), (n) =>
        t('AI sorts the new comments by topic and mood: {n} so far', { n }),
      )
    } else if ((x = line.match(/^Sorting waits for Claude until (.+)\.$/))) {
      push({
        time,
        kind: 'warn',
        text: t('The AI reached its usage limit. Sorting goes on by itself after {time}.', {
          time: x[1]!,
        }),
      })
    } else if ((x = line.match(/^Stopped sorting: (.*)$/))) {
      story.problems++
      push({ time, kind: 'warn', text: t('AI sorting paused'), detail: x[1]! })
    } else if ((x = line.match(/^Claude placed (\d+) posts in campaigns/))) {
      push({ time, kind: 'good', text: t('Posts added to their campaigns: {n}', { n: x[1]! }) })
    } else if ((x = line.match(/^Deleted (\d+) comments older than (\d+) days/))) {
      push({
        time,
        kind: 'note',
        text: t('Comments older than {d} days cleared out, as set in Settings: {n}', {
          n: x[1]!,
          d: x[2]!,
        }),
      })
    } else if (/^Stopped on request/.test(line)) {
      push({ time, kind: 'warn', text: t('Stopped as asked. Everything read until then is kept.') })
    } else if (line === 'Done.') {
      push({ time, kind: 'good', text: t('Finished') })
    } else if (
      (x = line.match(/^(instagram|facebook|tiktok) @\S+: (.*) Reading it from the web this time\.$/i))
    ) {
      push({
        time,
        kind: 'note',
        text: t('{network}: the official route said no, so the page is read from the web instead', {
          network: net(x[1]!),
        }),
        detail: x[2]!,
      })
    } else {
      push({ time, kind: 'note', text: line })
    }
  }
  return story
}

/** How long something took, in words: "35 s", "4 min", "1 h 5 min". */
export function took(fromIso: string, to: number, t: Tr = english) {
  const s = Math.max(0, Math.round((to - Date.parse(fromIso)) / 1000))
  if (s < 60) return t('{n} s', { n: s })
  const m = Math.round(s / 60)
  if (m < 60) return t('{n} min', { n: m })
  return t('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 })
}
