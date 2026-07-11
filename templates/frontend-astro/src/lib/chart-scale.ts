export interface BarDatum {
  label: string
  value: number
}

export interface ScaledBar extends BarDatum {
  pct: number
}

export interface TrendPoint {
  day: string
  count: number
}

export function scaleBars(data: BarDatum[]): ScaledBar[] {
  const max = Math.max(0, ...data.map((datum) => datum.value))
  return data.map((datum) => ({
    ...datum,
    pct: max === 0 ? 0 : Math.round((datum.value / max) * 100),
  }))
}

export function trendPolyline(series: TrendPoint[], width = 320, height = 80, pad = 4): string {
  if (series.length === 0) return ''
  const max = Math.max(1, ...series.map((point) => point.count))
  const stepX = series.length === 1 ? 0 : (width - pad * 2) / (series.length - 1)
  return series.map((point, index) => {
    const x = Math.round((pad + index * stepX) * 10) / 10
    const y = Math.round((height - pad - (point.count / max) * (height - pad * 2)) * 10) / 10
    return `${x},${y}`
  }).join(' ')
}

export function rollup<T>(
  rows: T[],
  labelOf: (row: T) => string,
  valueOf: (row: T) => number,
): BarDatum[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const label = labelOf(row)
    totals.set(label, (totals.get(label) ?? 0) + valueOf(row))
  }
  return [...totals].map(([label, value]) => ({ label, value }))
}

export function dayTotals(rows: TrendPoint[]): TrendPoint[] {
  return rollup(rows, (row) => row.day, (row) => row.count)
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((row) => ({ day: row.label, count: row.value }))
}
