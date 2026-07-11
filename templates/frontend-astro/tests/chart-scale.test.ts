import { describe, expect, it } from 'vitest'
import { dayTotals, rollup, scaleBars, trendPolyline } from '../src/lib/chart-scale.ts'

describe('scaleBars', () => {
  it('scales the maximum value to 100%', () => {
    expect(scaleBars([
      { label: 'draft', value: 2 },
      { label: 'published', value: 4 },
    ])).toEqual([
      { label: 'draft', value: 2, pct: 50 },
      { label: 'published', value: 4, pct: 100 },
    ])
  })

  it('handles empty and all-zero input', () => {
    expect(scaleBars([])).toEqual([])
    expect(scaleBars([{ label: 'x', value: 0 }])).toEqual([{ label: 'x', value: 0, pct: 0 }])
  })
})

describe('trendPolyline', () => {
  it('returns empty for an empty series', () => {
    expect(trendPolyline([])).toBe('')
  })

  it('plots a single point at the top-left padding', () => {
    expect(trendPolyline([{ day: '2026-07-10', count: 5 }], 320, 80, 4)).toBe('4,4')
  })

  it('spreads points across the available width', () => {
    expect(trendPolyline([
      { day: '2026-07-09', count: 0 },
      { day: '2026-07-10', count: 10 },
    ], 320, 80, 4).split(' ')).toEqual(['4,76', '316,4'])
  })
})

describe('rollup and dayTotals', () => {
  it('sums values by label', () => {
    expect(rollup(
      [
        { kind: 'embed', status: 'done', count: 2 },
        { kind: 'embed', status: 'failed', count: 1 },
        { kind: 'embed', status: 'done', count: 3 },
      ],
      (row) => `${row.kind}/${row.status}`,
      (row) => row.count,
    )).toEqual([
      { label: 'embed/done', value: 5 },
      { label: 'embed/failed', value: 1 },
    ])
  })

  it('sums per day and sorts ascending', () => {
    expect(dayTotals([
      { day: '2026-07-10', count: 2 },
      { day: '2026-07-09', count: 1 },
      { day: '2026-07-10', count: 3 },
    ])).toEqual([
      { day: '2026-07-09', count: 1 },
      { day: '2026-07-10', count: 5 },
    ])
  })
})
