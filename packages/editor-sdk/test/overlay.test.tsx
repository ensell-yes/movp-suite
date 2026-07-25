// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tipTapAdapter } from '../src/adapter.ts'
import {
  mountOverlay,
  type OverlayHandle,
  type OverlayOptions,
  type OverlayRegion,
} from '../src/overlay.tsx'

const ITEM = 'd1000000-0000-4000-8000-000000000001'
const REVISION = 'd2000000-0000-4000-8000-000000000001'
const BODY = tipTapAdapter.encode({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] }],
})
const REGION: OverlayRegion = {
  itemId: ITEM,
  fieldKey: 'body',
  body: BODY,
  revisionId: REVISION,
}
const handles: OverlayHandle[] = []

function options(overrides: Partial<OverlayOptions> = {}): OverlayOptions {
  return {
    canEdit: vi.fn(async () => true),
    resolveEditable: vi.fn(async () => REGION),
    save: vi.fn(async () => ({ status: 'saved' as const, revisionId: 'revision-2' })),
    ...overrides,
  }
}

function mount(markup: string, value: OverlayOptions): OverlayHandle {
  document.body.innerHTML = markup
  const handle = mountOverlay(value)
  handles.push(handle)
  return handle
}

afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy()
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('inline overlay', () => {
  it('scans only valid bindings and deduplicates identical regions', async () => {
    const canEdit = vi.fn(async () => true)
    mount(`
      <main>
        <section data-movp-item="${ITEM}" data-movp-field="body"></section>
        <section data-movp-item="${ITEM}" data-movp-field="body"></section>
        <section data-movp-item="not-a-uuid" data-movp-field="body"></section>
        <section data-movp-item="${ITEM}" data-movp-field="body.dot"></section>
        <section data-movp-item="${ITEM}"></section>
      </main>
    `, options({ canEdit }))

    const trigger = await screen.findByRole('button', { name: 'Edit body' })
    expect(trigger.classList.contains('movp-overlay__control')).toBe(true)
    expect(screen.getAllByRole('button', { name: 'Edit body' })).toHaveLength(1)
    expect(canEdit).toHaveBeenCalledTimes(1)
    expect(canEdit).toHaveBeenCalledWith({ itemId: ITEM, fieldKey: 'body' })
  })

  it('renders no chrome when advisory capability is false', async () => {
    const canEdit = vi.fn(async () => false)
    mount(`<section data-movp-item="${ITEM}" data-movp-field="body"></section>`, options({ canEdit }))
    await waitFor(() => expect(canEdit).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Edit body' })).toBeNull()
  })

  it('moves focus into the opened dialog; Escape closes and restores trigger focus', async () => {
    mount(`<section data-movp-item="${ITEM}" data-movp-field="body"></section>`, options())
    const trigger = await screen.findByRole('button', { name: 'Edit body' })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Edit body' })
    const close = screen.getByRole('button', { name: 'Close body editor' })
    await waitFor(() => expect(document.activeElement).toBe(close))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit body' })).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('reuses MovpEditor and advances the expected revision after each save', async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ status: 'saved', revisionId: 'revision-2' })
      .mockResolvedValueOnce({ status: 'saved', revisionId: 'revision-3' })
    mount(`<section data-movp-item="${ITEM}" data-movp-field="body"></section>`, options({ save }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit body' }))
    const saveButton = await screen.findByRole('button', { name: 'Save content' })
    fireEvent.click(saveButton)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    await screen.findByText('Saved')
    fireEvent.click(saveButton)
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))

    expect(save.mock.calls[0]?.[0]).toMatchObject({ revisionId: REVISION })
    expect(save.mock.calls[1]?.[0]).toMatchObject({ revisionId: 'revision-2' })
    expect(typeof save.mock.calls[1]?.[1]).toBe('string')
  })

  it('keeps the draft and existing recovery actions on conflict', async () => {
    const save = vi.fn(async () => ({ status: 'conflict' as const }))
    mount(`<section data-movp-item="${ITEM}" data-movp-field="body"></section>`, options({ save }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit body' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))

    await screen.findByText(/This field changed since you opened it/)
    expect(document.body.textContent).toContain('alpha')
    expect(screen.getByRole('button', { name: 'Refresh revision' })).toBeTruthy()
    expect(screen.getByRole('button', {
      name: 'Load latest field and discard my changes',
    })).toBeTruthy()
  })

  it('maps known safe errors and never renders an unknown code verbatim', async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ status: 'error', code: 'content_edit_forbidden' })
      .mockResolvedValueOnce({ status: 'error', code: 'private_database_detail' })
    mount(`<section data-movp-item="${ITEM}" data-movp-field="body"></section>`, options({ save }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit body' }))
    const saveButton = await screen.findByRole('button', { name: 'Save content' })
    fireEvent.click(saveButton)
    await screen.findByText('You no longer have permission to edit this field.')
    fireEvent.click(saveButton)
    await screen.findByText('Save failed. Please try again.')
    expect(document.body.textContent).not.toContain('private_database_detail')
    expect(document.body.textContent).toContain('alpha')
  })

  it('contains thrown save failures, keeps the draft, and exposes an alert', async () => {
    const save = vi.fn(async () => {
      throw new Error('private transport detail')
    })
    mount(`<section data-movp-item="${ITEM}" data-movp-field="body"></section>`, options({ save }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit body' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))

    await screen.findByRole('alert')
    expect(document.body.textContent).toContain('alpha')
    expect(document.body.textContent).not.toContain('private transport detail')
  })

  it('destroy removes chrome, ignores pending capability work, and is idempotent', async () => {
    let resolveCapability: ((allowed: boolean) => void) | undefined
    const canEdit = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveCapability = resolve
    }))
    const handle = mount(
      `<section data-movp-item="${ITEM}" data-movp-field="body"></section>`,
      options({ canEdit }),
    )
    await waitFor(() => expect(canEdit).toHaveBeenCalledTimes(1))
    handle.destroy()
    handle.destroy()
    resolveCapability?.(true)
    await Promise.resolve()
    expect(screen.queryByRole('button', { name: 'Edit body' })).toBeNull()
  })

  it('ships 44px controls and a reduced-motion stylesheet override', () => {
    const path = join(process.cwd(), 'src', 'overlay.css')
    const info = lstatSync(path)
    expect(info.isSymbolicLink()).toBe(false)
    expect(info.isFile()).toBe(true)
    expect(info.size).toBeLessThanOrEqual(128 * 1024)
    const css = readFileSync(path, 'utf8')
    expect(css).toMatch(/min-(?:block-size|height):\s*44px/)
    expect(css).toMatch(/min-(?:inline-size|width):\s*44px/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toMatch(/transition(?:-duration)?:\s*(?:none|0s)/)
  })
})
