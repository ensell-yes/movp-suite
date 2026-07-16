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
