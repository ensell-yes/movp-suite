// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tipTapAdapter } from '../src/adapter.ts'
import { MovpEditor } from '../src/editor.tsx'

const BODY_A = tipTapAdapter.encode({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] }],
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
    expect(screen.getByRole('button', { name: 'Refresh revision' })).toBeTruthy()
  })

  it('conflict keeps the draft and offers refresh + load-latest without replacing content', async () => {
    const onSave = vi.fn().mockResolvedValue({ status: 'conflict' })
    const onRefresh = vi.fn()
    const onLoadLatest = vi.fn()
    render(
      <MovpEditor
        initialBody={BODY_A}
        onSave={onSave}
        onRefresh={onRefresh}
        onLoadLatest={onLoadLatest}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))
    await screen.findByRole('alert')
    expect(document.body.textContent).toContain('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh revision' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Load latest field and discard my changes' }))
    expect(onLoadLatest).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['Refresh revision', { onRefresh: () => { throw new Error('refresh host fault') }, onLoadLatest: vi.fn() }],
    ['Load latest field and discard my changes', { onRefresh: vi.fn(), onLoadLatest: () => { throw new Error('load host fault') } }],
  ] as const)('contains a throwing host callback from %s and keeps the draft', async (button, callbacks) => {
    const onSave = vi.fn().mockResolvedValue({ status: 'conflict' })
    render(<MovpEditor initialBody={BODY_A} onSave={onSave} {...callbacks} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))
    fireEvent.click(await screen.findByRole('button', { name: button }))
    await screen.findByText('Could not refresh or load latest. Your draft is unchanged.')
    expect(document.body.textContent).toContain('alpha')
    const save = screen.getByRole('button', { name: 'Save content' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
  })

  it('clears the host-action error once a retry Save succeeds', async () => {
    const onSave = vi.fn()
      .mockResolvedValueOnce({ status: 'conflict' })
      .mockResolvedValueOnce({ status: 'saved', revisionId: 'r1' })
    render(
      <MovpEditor
        initialBody={BODY_A}
        onSave={onSave}
        onRefresh={() => { throw new Error('host fault') }}
        onLoadLatest={vi.fn()}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh revision' }))
    await screen.findByText('Could not refresh or load latest. Your draft is unchanged.')
    fireEvent.click(screen.getByRole('button', { name: 'Save content' }))
    await waitFor(() => expect(screen.queryByText(/Could not refresh or load latest/)).toBeNull())
  })

  it('hides the toolbar and save control in read-only mode', async () => {
    render(<MovpEditor initialBody={BODY_A} onSave={vi.fn()} onRefresh={vi.fn()} readOnly />)
    await waitFor(() => expect(document.body.textContent).toContain('alpha'))
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save content' })).toBeNull()
  })
})
