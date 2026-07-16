import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Toolbar } from '../src/toolbar.tsx'
import { ConflictSurface } from '../src/conflict-surface.tsx'

const noopCommands = { bold: vi.fn(), h1: vi.fn(), bullet: vi.fn(), undo: vi.fn(), redo: vi.fn() }

describe('Toolbar', () => {
  it('renders a labeled toolbar with five accessible controls', () => {
    const html = renderToStaticMarkup(<Toolbar commands={noopCommands} />)
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
