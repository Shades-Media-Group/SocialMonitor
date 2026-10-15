/** Brands' comments per day, grouped into steps for the comparison and share-of-voice lines. */
type PerDay = { day: string; n: number }[]

/** Days into steps of `size` days, so a year reads as 52 weeks instead of 365 days. */
export function bucket(perDay: PerDay, size: number) {
  const out = { days: [] as string[], values: [] as number[] }
  for (let i = 0; i < perDay.length; i += size) {
    out.days.push(perDay[i]!.day)
    out.values.push(perDay.slice(i, i + size).reduce((a, d) => a + d.n, 0))
  }
  return out
}

/**
 * Share of voice per step: each brand's part of all the comments the brands got in that step.
 * Brands are lined up on the longest brand's days; a step where nobody commented reads 0.
 */
export function voiceTrend(perBrand: PerDay[], step: number) {
  const days = perBrand.reduce<string[]>(
    (a, r) => (r.length > a.length ? r.map((d) => d.day) : a),
    [],
  )
  const counts = perBrand.map((r) => {
    const by = new Map(r.map((d) => [d.day, d.n]))
    return bucket(
      days.map((day) => ({ day, n: by.get(day) ?? 0 })),
      step,
    ).values
  })
  const totals = counts[0]?.map((_, i) => counts.reduce((n, c) => n + c[i]!, 0)) ?? []
  return {
    days: days.filter((_, i) => i % step === 0),
    shares: counts.map((c) => c.map((n, i) => (totals[i] ? n / totals[i]! : 0))),
  }
}
