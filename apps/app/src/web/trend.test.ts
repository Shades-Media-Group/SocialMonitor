import { describe, expect, it } from 'vitest'
import { bucket, voiceTrend } from './trend.ts'

const days = (ns: number[], from = 1) => ns.map((n, i) => ({ day: `2026-10-0${i + from}`, n }))

describe('trend steps', () => {
  it('sums days into steps, keeping each step’s first day', () => {
    expect(bucket(days([1, 2, 3, 4, 5]), 2)).toEqual({
      days: ['2026-10-01', '2026-10-03', '2026-10-05'],
      values: [3, 7, 5],
    })
  })

  it('shares each step between the brands, lined up by day', () => {
    // The second brand's first comment came a day later, so its list starts later.
    const t = voiceTrend([days([3, 1, 0, 0]), days([1, 0, 0], 2)], 2)
    expect(t.days).toEqual(['2026-10-01', '2026-10-03'])
    expect(t.shares).toEqual([
      [0.8, 0],
      [0.2, 0],
    ])
  })
})
