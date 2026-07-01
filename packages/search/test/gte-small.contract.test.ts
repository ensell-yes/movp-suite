import { describe, expect, it, vi } from 'vitest'

describe('GteSmallProvider', () => {
  it('lazily constructs the session at call time and returns run output', async () => {
    const run = vi.fn(async () => new Array(384).fill(0.1))
    const Session = vi.fn(() => ({ run }))
    ;(globalThis as unknown as { Supabase: unknown }).Supabase = { ai: { Session } }
    const { GteSmallProvider } = await import('../src/gte-small.ts')

    const p = new GteSmallProvider()
    expect(Session).not.toHaveBeenCalled()
    const v = await p.embed('hello')
    expect(Session).toHaveBeenCalledWith('gte-small')
    expect(run).toHaveBeenCalledWith('hello', { mean_pool: true, normalize: true })
    expect(v).toHaveLength(384)
  })
})
