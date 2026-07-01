export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100
export const DEPTH_LIMIT = 10
export const COMPLEXITY_BUDGET = 1000

export function clampPageSize(first?: number | null): number {
  if (first == null) return DEFAULT_PAGE_SIZE
  if (first < 1) return 1
  return Math.min(first, MAX_PAGE_SIZE)
}
