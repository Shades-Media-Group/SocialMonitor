import { useEffect, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import type { BrandView } from '../app.tsx'
import type { Network } from '../api.ts'
import { api } from '../api.ts'
import { LineChart } from '../charts.tsx'
import { JsonPanel } from '../json.tsx'
import { locale, t } from '../i18n.ts'
import { Empty, Modal, NETWORK_NAME, count, fmt, short, when } from '../ui.tsx'
import { usePref } from '../prefs.ts'

interface Totals {
  calls: number
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost_usd: number
  items: number
}
type Group = Totals & { key: string | null }
interface Usage {
  rivals: number
  periods: { last30: Totals; month: Totals; all: Totals }
  by_task: Group[]
  by_network: Group[]
  daily: { day: string; calls: number; tokens: number; cost_usd: number }[]
  volume: {
    posts: number
    comments: number
    sorted: number
    runs: number
    avg_run_seconds: number | null
    media_bytes: number
    report_bytes: number
  }
  derived: {
    usd_per_1000_sorted: number | null
    projected_month_usd: number | null
    recorded_days: number
  }
  brands: {
    id: number
    name: string
    tokens: number
    cost_usd: number
    comments: number
    calls: number
  }[]
  updates: { runs: Update[]; estimate: Estimate | null }
}
/** One update; null figures were not recorded (updates from before they were tied to it). */
interface Update {
  id: number
  started_at: string
  finished_at: string | null
  seconds: number | null
  trigger: string
  status: string
  networks: Network[]
  recorded: boolean
  posts: number | null
  comments: number | null
  new_comments: number | null
  sorted: number | null
  calls: number | null
  tokens: number | null
  input: number | null
  output: number | null
  cache_read: number | null
  cache_write: number | null
  cost_usd: number | null
  by_task: Group[]
}
interface Estimate {
  tokens: number
  cost_usd: number
  from: number
  networks: Network[]
  same_networks: boolean
}

const cents = new Intl.NumberFormat(locale, {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
})
const small = new Intl.NumberFormat(locale, {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
})
const tiny = new Intl.NumberFormat(locale, {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
  maximumSignificantDigits: 2,
})
/**
 * Dollars: cents from 10 cents up, four decimals below so a column lines up and $0.0042 is not
 * $0.00, two significant figures for the rare amount under a hundredth of a cent.
 */
export const usd = (n: number | null | undefined) =>
  n == null
    ? '–'
    : n === 0 || n >= 0.1
      ? cents.format(n)
      : n >= 0.0001
        ? small.format(n)
        : tiny.format(n)

const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
export function bytes(n: number) {
  // From kilobytes up: "0 kB" reads better than "0 byte".
  const i = Math.max(
    1,
    n > 0 ? Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024))) : 0,
  )
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: UNITS[i],
    unitDisplay: 'short',
    maximumFractionDigits: i > 1 ? 1 : 0,
  }).format(n / 1024 ** i)
}
const seconds = (s: number | null) =>
  s == null
    ? '–'
    : new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: s < 90 ? 'second' : 'minute',
        unitDisplay: 'short',
        maximumFractionDigits: s < 90 ? 0 : 1,
      }).format(s < 90 ? s : s / 60)

const tokens = (r: Totals) => r.input + r.output + r.cache_read + r.cache_write

const TASK: Record<string, string> = {
  'sort-comments': 'Sorting comments',
  'describe-post': 'Describing posts',
  'campaign-tags': 'Placing posts in campaigns',
  summary: 'Weekly summary',
  ideas: 'Post ideas',
  reply: 'Reply drafts',
  translate: 'Translations',
  'limit-check': 'Limit check',
}

/** As runs.status records it; a status this list does not know shows as it is. */
const STATUS: Record<string, string> = {
  ok: t('Done'),
  partial: t('Done, with gaps'),
  error: t('Failed'),
  stopped: t('Stopped'),
  running: t('Reading now'),
  // Translated in the ai-limits change, which adds this status.
  postponed: t('Postponed'),
}
const TRIGGER: Record<string, string> = {
  manual: t('Manual'),
  schedule: t('Schedule'),
  mcp: 'MCP',
}
/** "Instagram and TikTok" in a sentence, "Instagram, TikTok" in a table cell. */
const networkList = (nets: Network[], sentence = false) =>
  new Intl.ListFormat(
    locale,
    sentence ? { style: 'long', type: 'conjunction' } : { style: 'short', type: 'unit' },
  ).format(nets.map((n) => NETWORK_NAME[n]))

/** A table whose columns sort on a click, the way Statistics does it. */
function SortTable<R>({
  rows,
  cols,
  initial,
  current,
}: {
  rows: R[]
  cols: {
    key: string
    label: string
    value: (r: R) => number | string
    show?: (r: R) => ComponentChildren
    /** Hidden on a phone, so the figures that matter fit without scrolling. */
    wide?: boolean
  }[]
  initial: string
  current?: (r: R) => boolean
}) {
  const [sort, setSort] = useState({ key: initial, desc: true })
  const col = cols.find((c) => c.key === sort.key) ?? cols[0]!
  const sorted = [...rows].sort((a, b) => {
    const x = col.value(a)
    const y = col.value(b)
    const d =
      typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return sort.desc ? -d : d
  })
  return (
    <div class="sm-scroll">
      <table class="sm-dtable sm-admin__table">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th
                class={`${i ? 'sm-num' : ''}${c.wide ? ' sm-admin__wide' : ''}`}
                aria-sort={
                  sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined
                }
              >
                <button
                  type="button"
                  class="sm-sortbtn"
                  onClick={() =>
                    setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : i > 0 })
                  }
                >
                  {c.label}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr class={current?.(r) ? 'is-current' : undefined}>
              {cols.map((c, i) =>
                i ? (
                  <td class={`sm-num g-num${c.wide ? ' sm-admin__wide' : ''}`}>
                    {c.show ? c.show(r) : c.value(r)}
                  </td>
                ) : (
                  <td class="sm-admin__name">{c.show ? c.show(r) : c.value(r)}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The usage columns every grouped table shares. */
const usageCols = <R extends Totals>(itemsLabel: string) => [
  { key: 'calls', label: t('Calls'), value: (r: R) => r.calls, show: (r: R) => fmt(r.calls) },
  {
    key: 'input',
    label: t('Input'),
    value: (r: R) => r.input,
    show: (r: R) => short(r.input),
    wide: true,
  },
  {
    key: 'output',
    label: t('Output'),
    value: (r: R) => r.output,
    show: (r: R) => short(r.output),
    wide: true,
  },
  {
    wide: true,
    key: 'cache',
    label: t('Cache'),
    value: (r: R) => r.cache_read + r.cache_write,
    show: (r: R) => short(r.cache_read + r.cache_write),
  },
  { key: 'items', label: itemsLabel, value: (r: R) => r.items, show: (r: R) => fmt(r.items) },
  { key: 'usd', label: t('USD'), value: (r: R) => r.cost_usd, show: (r: R) => usd(r.cost_usd) },
]

type Metric = 'cost' | 'tokens' | 'calls'

/**
 * Super admins only: what the brand's AI work used over the last 30 days, in tokens and in what
 * the same tokens would cost on the Anthropic API, beside how much data it holds and every brand.
 */
export function Admin({ brand, mode, version }: BrandView) {
  const [u, setU] = useState<Usage | null>(null)
  const [failed, setFailed] = useState('')
  const [metric, setMetric] = usePref<Metric>('admin.metric', 'cost')
  useEffect(() => {
    api
      .get<Usage>(`/api/brands/${brand.id}/admin`)
      .then(setU)
      .catch((e: Error) => setFailed(e.message))
  }, [brand.id, version])

  if (failed) return <Empty title={t('The figures did not load.')}>{failed}</Empty>
  if (!u) return null
  if (mode === 'json') return <JsonPanel value={u} />

  const p = u.periods
  const recorded = p.all.calls > 0
  const CARDS: [Metric, string, string, number[], ((n: number) => string) | undefined][] = [
    ['cost', t('API value'), usd(p.last30.cost_usd), u.daily.map((d) => d.cost_usd), usd],
    ['tokens', t('Tokens'), short(tokens(p.last30)), u.daily.map((d) => d.tokens), short],
    ['calls', t('AI calls'), fmt(p.last30.calls), u.daily.map((d) => d.calls), undefined],
  ]
  const active = CARDS.find(([k]) => k === metric) ?? CARDS[0]!
  const sorted30 = u.by_task.find((r) => r.key === 'sort-comments')?.items ?? 0
  const v = u.volume

  const held = (
    <section class="sm-box">
      <header class="sm-box__head">
        <h2>{t('Data held')}</h2>
        {u.rivals > 0 && <span class="sm-box__meta">{t('With the rivals it watches')}</span>}
      </header>
      <dl class="sm-admin__rows">
        <dt>{t('Posts')}</dt>
        <dd class="g-num">{fmt(v.posts)}</dd>
        <dt>{t('Comments')}</dt>
        <dd class="g-num">
          {fmt(v.comments)}
          <span>{t('{n} sorted', { n: fmt(v.sorted) })}</span>
        </dd>
        <dt>{t('Updates')}</dt>
        <dd class="g-num">
          {fmt(v.runs)}
          {v.avg_run_seconds != null && (
            <span>{t('{time} on average', { time: seconds(v.avg_run_seconds) })}</span>
          )}
        </dd>
        <dt>{t('Pictures')}</dt>
        <dd class="g-num">{bytes(v.media_bytes)}</dd>
        <dt>{t('Saved reports')}</dt>
        <dd class="g-num">{bytes(v.report_bytes)}</dd>
      </dl>
    </section>
  )

  return (
    <div class="sm-ga sm-admin">
      <p class="sm-admin__note">
        {t(
          'Prices are what the same tokens would cost on the Anthropic API. The Claude subscription is not billed per call, so nothing here was charged.',
        )}
      </p>
      {!recorded ? (
        <>
          <div class="sm-layout">
            <div class="sm-span-8">
              <Empty title={t('No AI usage recorded yet.')}>
                {t(
                  'Recording starts with this release: the next update, summary or reply draft shows here.',
                )}
              </Empty>
            </div>
            <div class="sm-span-4">{held}</div>
          </div>
          {u.updates.runs.length > 0 && <Updates {...u.updates} />}
        </>
      ) : (
        <>
          <section class="sm-box sm-ga__report">
            <div
              class="sm-ga__cards sm-admin__cards"
              role="tablist"
              aria-label={t('What to chart')}
            >
              {CARDS.map(([k, label, value]) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={metric === k}
                  class="sm-ga__card"
                  onClick={() => setMetric(k)}
                >
                  <span class="sm-ga__label">{label}</span>
                  <span class="sm-ga__value g-num">{value}</span>
                  <span class="sm-ga__sub">{t('Last 30 days')}</span>
                </button>
              ))}
              <div class="sm-ga__card sm-ga__card--static">
                <span class="sm-ga__label">{t('Comments sorted')}</span>
                <span class="sm-ga__value g-num">{fmt(sorted30)}</span>
                <span class="sm-ga__sub">{t('Last 30 days')}</span>
              </div>
              <div class="sm-ga__card sm-ga__card--static">
                <span class="sm-ga__label">{t('Per 1,000 sorted')}</span>
                <span class="sm-ga__value g-num">{usd(u.derived.usd_per_1000_sorted)}</span>
                <span class="sm-ga__sub">{t('All AI work included')}</span>
              </div>
              <div class="sm-ga__card sm-ga__card--static">
                <span class="sm-ga__label">{t('A month at this pace')}</span>
                <span class="sm-ga__value g-num">{usd(u.derived.projected_month_usd)}</span>
                <span class="sm-ga__sub">
                  {u.derived.recorded_days < 30
                    ? t('From {n} recorded days', { n: u.derived.recorded_days })
                    : t('From the last 30 days')}
                </span>
              </div>
            </div>
            <LineChart
              days={u.daily.map((d) => d.day)}
              values={active[3]}
              previous={[]}
              label={active[1]}
              show={active[4]}
            />
          </section>

          {u.updates.runs.length > 0 && <Updates {...u.updates} />}

          <section class="sm-box sm-box--table">
            <header class="sm-box__head">
              <h2>{t('By period')}</h2>
              {u.rivals > 0 && <span class="sm-box__meta">{t('With the rivals it watches')}</span>}
            </header>
            <SortTable
              initial=""
              rows={[
                { ...p.last30, key: t('Last 30 days') },
                { ...p.month, key: t('This month') },
                { ...p.all, key: t('All time') },
              ]}
              cols={[
                { key: 'name', label: t('Period'), value: () => 0, show: (r) => r.key },
                ...usageCols<Group>(t('Items')),
              ]}
            />
          </section>

          <div class="sm-layout">
            <section class="sm-box sm-box--table sm-span-8">
              <header class="sm-box__head">
                <h2>{t('By task')}</h2>
                <span class="sm-box__meta">{t('Last 30 days')}</span>
              </header>
              <SortTable
                initial="usd"
                rows={u.by_task}
                cols={[
                  {
                    key: 'task',
                    label: t('Task'),
                    value: (r) => t(TASK[r.key ?? ''] ?? r.key ?? ''),
                  },
                  ...usageCols<Group>(t('Items')),
                ]}
              />
            </section>
            <section class="sm-box sm-box--table sm-span-4">
              <header class="sm-box__head">
                <h2>{t('By network')}</h2>
                <span class="sm-box__meta">{t('Last 30 days')}</span>
              </header>
              <SortTable
                initial="usd"
                rows={u.by_network}
                cols={[
                  {
                    key: 'network',
                    label: t('Network'),
                    value: (r) => (r.key ? NETWORK_NAME[r.key as Network] : t('Whole brand')),
                  },
                  {
                    key: 'calls',
                    label: t('Calls'),
                    value: (r) => r.calls,
                    show: (r) => fmt(r.calls),
                  },
                  {
                    key: 'usd',
                    label: t('USD'),
                    value: (r) => r.cost_usd,
                    show: (r) => usd(r.cost_usd),
                  },
                ]}
              />
            </section>
          </div>
          <div class="sm-layout">
            <AllBrands u={u} brandId={brand.id} />
            <div class="sm-span-4">{held}</div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The brand's last 50 updates, newest first: what each read, sorted and used, with what the next
 * one would take above them. A row opens that update's breakdown by task.
 */
function Updates({ runs, estimate }: Usage['updates']) {
  const [open, setOpen] = useState<Update | null>(null)
  const e = estimate
  return (
    <>
      <section class="sm-box sm-box--table">
        <header class="sm-box__head">
          <h2>{t('Updates')}</h2>
          <span class="sm-box__meta">{t('Last 50, rivals included')}</span>
        </header>
        <p class="sm-admin__next">
          <span class="sm-admin__next-label">{t('Next update')}</span>
          {e ? (
            <>
              <strong class="g-num">
                {t('About {tokens} tokens and {usd}', {
                  tokens: short(e.tokens),
                  usd: usd(e.cost_usd),
                })}
              </strong>
              <span class="sm-admin__next-note">
                {t(
                  e.same_networks
                    ? 'At the API-equivalent price. An estimate from recent updates: the median of {updates} that used AI on {networks}.'
                    : 'At the API-equivalent price. An estimate from recent updates: the median of {updates} that used AI, since none read only {networks} yet.',
                  {
                    updates: count(e.from, 'update'),
                    networks: networkList(e.networks, true),
                  },
                )}
              </span>
            </>
          ) : (
            <span class="sm-admin__unrecorded">
              {t('No estimate yet: it needs a recorded update that used AI.')}
            </span>
          )}
        </p>
        <div class="sm-scroll">
          <table class="sm-dtable sm-admin__table sm-admin__updates">
            <thead>
              <tr>
                <th>{t('Started')}</th>
                <th class="sm-num sm-admin__wide">{t('Took')}</th>
                <th class="sm-admin__wide">{t('Started by')}</th>
                <th class="sm-admin__wide">{t('Networks')}</th>
                <th>{t('Status')}</th>
                <th class="sm-num sm-admin__wide">{t('Posts')}</th>
                <th class="sm-num sm-admin__wide">{t('Comments')}</th>
                <th class="sm-num sm-admin__wide">{t('Sorted')}</th>
                <th class="sm-num">{t('Tokens')}</th>
                <th class="sm-num">{t('USD')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr class={open?.id === r.id ? 'is-current' : undefined}>
                  <td class="sm-admin__name">
                    <button type="button" class="sm-admin__open" onClick={() => setOpen(r)}>
                      {when(r.started_at)}
                    </button>
                  </td>
                  <td class="sm-num g-num sm-admin__wide">{seconds(r.seconds)}</td>
                  <td class="sm-admin__wide">{TRIGGER[r.trigger] ?? r.trigger}</td>
                  <td class="sm-admin__wide">{networkList(r.networks)}</td>
                  <td class={`sm-admin__status sm-admin__status--${r.status}`}>
                    {STATUS[r.status] ?? r.status}
                  </td>
                  <td class="sm-num g-num sm-admin__wide">{fmt(r.posts)}</td>
                  <td class="sm-num g-num sm-admin__wide">{fmt(r.comments)}</td>
                  <td class="sm-num g-num sm-admin__wide">{fmt(r.sorted)}</td>
                  {r.recorded ? (
                    <>
                      <td class="sm-num g-num">{short(r.tokens)}</td>
                      <td class="sm-num g-num">{usd(r.cost_usd)}</td>
                    </>
                  ) : (
                    // Tokens and price, which only updates since run_id have.
                    <td class="sm-num sm-admin__unrecorded" colSpan={2}>
                      {t('Not recorded')}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {/* Outside the box, so the box's table margins stay out of the pop-up. */}
      {open && <UpdateDetail r={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** One update's figures, and what each kind of AI work in it used. */
function UpdateDetail({ r, onClose }: { r: Update; onClose: () => void }) {
  const title = t('Update of {time}', { time: when(r.started_at) })
  const line = [
    STATUS[r.status] ?? r.status,
    TRIGGER[r.trigger] ?? r.trigger,
    networkList(r.networks, true),
    r.seconds != null ? seconds(r.seconds) : null,
  ].filter(Boolean)
  return (
    <Modal title={title} onClose={onClose}>
      <div class="sm-admin__detail">
        <h2>{title}</h2>
        <p>{line.join(' · ')}</p>
        {r.recorded ? (
          <>
            <dl class="sm-admin__rows">
              <dt>{t('Posts read')}</dt>
              <dd class="g-num">{fmt(r.posts)}</dd>
              <dt>{t('Comments read')}</dt>
              <dd class="g-num">
                {fmt(r.comments)}
                <span>{t('{n} new', { n: fmt(r.new_comments) })}</span>
              </dd>
              <dt>{t('Comments sorted')}</dt>
              <dd class="g-num">{fmt(r.sorted)}</dd>
              <dt>{t('AI calls')}</dt>
              <dd class="g-num">{fmt(r.calls)}</dd>
              <dt>{t('Input tokens')}</dt>
              <dd class="g-num">{fmt(r.input)}</dd>
              <dt>{t('Output tokens')}</dt>
              <dd class="g-num">{fmt(r.output)}</dd>
              <dt>{t('Cache read')}</dt>
              <dd class="g-num">{fmt(r.cache_read)}</dd>
              <dt>{t('Cache written')}</dt>
              <dd class="g-num">{fmt(r.cache_write)}</dd>
              <dt>{t('Total tokens')}</dt>
              <dd class="g-num">{fmt(r.tokens)}</dd>
              <dt>{t('API-equivalent price')}</dt>
              <dd class="g-num">{usd(r.cost_usd)}</dd>
            </dl>
            {r.by_task.length > 0 && (
              <SortTable
                initial="usd"
                rows={r.by_task}
                cols={[
                  {
                    key: 'task',
                    label: t('Task'),
                    value: (g) => t(TASK[g.key ?? ''] ?? g.key ?? ''),
                  },
                  {
                    key: 'calls',
                    label: t('Calls'),
                    value: (g) => g.calls,
                    show: (g) => fmt(g.calls),
                    wide: true,
                  },
                  {
                    key: 'tokens',
                    label: t('Tokens'),
                    value: (g) => tokens(g),
                    show: (g) => short(tokens(g)),
                  },
                  {
                    key: 'usd',
                    label: t('USD'),
                    value: (g) => g.cost_usd,
                    show: (g) => usd(g.cost_usd),
                  },
                ]}
              />
            )}
          </>
        ) : (
          <p>
            {t(
              'This update ran before updates kept their AI usage, so what it read and used was not recorded.',
            )}
          </p>
        )}
      </div>
    </Modal>
  )
}

/** Every brand's last 30 days, the open one highlighted. */
function AllBrands({ u, brandId }: { u: Usage; brandId: number }) {
  return (
    <section class="sm-box sm-box--table sm-span-8">
      <header class="sm-box__head">
        <h2>{t('All brands')}</h2>
        <span class="sm-box__meta">{t('Last 30 days, rivals included')}</span>
      </header>
      <SortTable
        initial="usd"
        rows={u.brands}
        current={(r) => r.id === brandId}
        cols={[
          {
            key: 'name',
            label: t('Brand'),
            value: (r) => r.name,
            show: (r) => <a href={`/b/${r.id}/admin`}>{r.name}</a>,
          },
          {
            key: 'calls',
            label: t('Calls'),
            value: (r) => r.calls,
            show: (r) => fmt(r.calls),
            wide: true,
          },
          {
            wide: true,
            key: 'tokens',
            label: t('Tokens'),
            value: (r) => r.tokens,
            show: (r) => short(r.tokens),
          },
          {
            key: 'comments',
            label: t('Comments sorted'),
            value: (r) => r.comments,
            show: (r) => fmt(r.comments),
          },
          {
            key: 'per1000',
            label: t('Per 1,000 sorted'),
            value: (r) => (r.comments ? r.cost_usd / r.comments : -1),
            show: (r) => (r.comments ? usd((r.cost_usd / r.comments) * 1000) : '–'),
          },
          {
            key: 'usd',
            label: t('USD'),
            value: (r) => r.cost_usd,
            show: (r) => usd(r.cost_usd),
          },
        ]}
      />
    </section>
  )
}
