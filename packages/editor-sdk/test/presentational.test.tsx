import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Toolbar } from '../src/toolbar.tsx'
import { ConflictSurface } from '../src/conflict-surface.tsx'
import { MovpEditor } from '../src/editor.tsx'

const noopCommands = { bold: vi.fn(), h1: vi.fn(), bullet: vi.fn(), undo: vi.fn(), redo: vi.fn() }
const inactive = { bold: false, h1: false, bullet: false }

describe('Toolbar', () => {
  it('renders a labeled toolbar with five accessible controls', () => {
    const html = renderToStaticMarkup(<Toolbar commands={noopCommands} active={inactive} />)
    expect(html).toContain('role="toolbar"')
    expect(html).toContain('aria-label="Formatting"')
    for (const label of ['Bold', 'Heading 1', 'Bullet list', 'Undo', 'Redo']) {
      expect(html).toContain(`aria-label="${label}"`)
    }
  })
})

describe('ConflictSurface', () => {
  it('renders an alert with a refresh affordance', () => {
    const html = renderToStaticMarkup(<ConflictSurface onRefresh={() => {}} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-label="Refresh and reload latest content"')
  })
})

describe('MovpEditor SSR safety', () => {
  it('server-renders without TipTap SSR warnings (immediatelyRender:false)', () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)) })
    const warns: string[] = []
    const wspy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warns.push(String(m)) })
    try {
      renderToStaticMarkup(
        <MovpEditor initialBody="" onSave={async () => ({ status: 'saved', revisionId: 'r1' })} onRefresh={() => {}} />,
      )
    } finally {
      spy.mockRestore()
      wspy.mockRestore()
    }
    expect([...errors, ...warns].some((m) => m.includes('SSR'))).toBe(false)
  })
})
