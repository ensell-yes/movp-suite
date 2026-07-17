// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tipTapAdapter } from '../src/adapter.ts'
import { MovpEditor } from '../src/editor.tsx'

const BODY_A = tipTapAdapter.encode({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] }],
})
const BODY_B = tipTapAdapter.encode({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bravo' }] }],
})

afterEach(cleanup)

describe('MovpEditor (mounted)', () => {
  it('renders the toolbar and save control once the editor is ready', async () => {
    render(<MovpEditor initialBody={BODY_A} onSave={vi.fn()} onRefresh={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Save content' })).toBeTruthy()
    const bold = screen.getByRole('button', { name: 'Bold' })
    expect(bold.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Heading 1' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: 'Bullet list' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(bold)
    await waitFor(() => expect(bold.getAttribute('aria-pressed')).toBe('true'))
  })

  it('encodes the live document and calls onSave once, even on a double click', async () => {
    const onSave = vi.fn().mockResolvedValue({ status: 'saved', revisionId: 'r1' })
    render(<MovpEditor initialBody={BODY_A} onSave={onSave} onRefresh={vi.fn()} />)
    const save = await screen.findByRole('button', { name: 'Save content' })
    act(() => {
      save.click()
      save.click()
    })
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const body = onSave.mock.calls[0][0] as string
    expect(tipTapAdapter.decode(body).type).toBe('doc')
    await screen.findByRole('status')
  })

  it('returns each successful revision so the host can advance the next expected revision', async () => {
    let serverRevision = 'r0'
    let expectedRevision = 'r0'
    let revisionNumber = 0
    const onSave = vi.fn(async () => {
      if (expectedRevision !== serverRevision) return { status: 'conflict' as const }
      revisionNumber += 1
      serverRevision = `r${revisionNumber}`
      return { status: 'saved' as const, revisionId: serverRevision }
    })
    const onSaved = vi.fn((revisionId: string) => { expectedRevision = revisionId })
    render(
      <MovpEditor
        initialBody={BODY_A}
        onSave={onSave}
        onSaved={onSaved}
        onRefresh={vi.fn()}
      />,
    )

    const save = await screen.findByRole('button', { name: 'Save content' })
    fireEvent.click(save)
    await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith('r1'))
    fireEvent.click(save)
    await waitFor(() => expect(onSaved).toHaveBeenLastCalledWith('r2'))

    expect(onSave).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a committed save as saved even when the host onSaved callback throws', async () => {
    const onSave = vi.fn().mockResolvedValue({ status: 'saved', revisionId: 'r1' })
    const onSaved = vi.fn(() => { throw new Error('host state update blew up') })
    render(<MovpEditor initialBody={BODY_A} onSave={onSave} onSaved={onSaved} onRefresh={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))
    // The save committed on the server; a throwing host callback must not repaint it as an error.
    await screen.findByRole('status')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('shows the conflict surface when onSave resolves to a conflict', async () => {
    const onSave = vi.fn().mockResolvedValue({ status: 'conflict' })
    render(<MovpEditor initialBody={BODY_A} onSave={onSave} onRefresh={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Refresh and reload latest content' })).toBeTruthy()
  })

  it('requests refresh, then reloads the new body and clears the conflict', async () => {
    const onSave = vi.fn().mockResolvedValue({ status: 'conflict' })
    const onRefresh = vi.fn()
    const { rerender } = render(
      <MovpEditor initialBody={BODY_A} onSave={onSave} onRefresh={onRefresh} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh and reload latest content' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(<MovpEditor initialBody={BODY_B} onSave={onSave} onRefresh={onRefresh} />)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    await waitFor(() => expect(document.body.textContent).toContain('bravo'))
  })

  it('hides the toolbar and save control in read-only mode', async () => {
    render(<MovpEditor initialBody={BODY_A} onSave={vi.fn()} onRefresh={vi.fn()} readOnly />)
    await waitFor(() => expect(document.body.textContent).toContain('alpha'))
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save content' })).toBeNull()
  })
})
