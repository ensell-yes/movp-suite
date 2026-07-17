// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({ editor: null as Editor | null }))
vi.mock('@tiptap/react', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@tiptap/react')>()
  return {
    ...mod,
    useEditor: (options: Parameters<typeof mod.useEditor>[0], deps?: readonly unknown[]) => {
      const ed = mod.useEditor(options, deps as never)
      if (ed) probe.editor = ed
      return ed
    },
  }
})

import { MovpEditor } from '../src/editor.tsx'

const BODY_A = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"alpha"}]}]}'

afterEach(() => {
  cleanup()
  probe.editor = null
})

async function mount(props: Parameters<typeof MovpEditor>[0]): Promise<Editor> {
  render(<MovpEditor {...props} />)
  await waitFor(() => expect(probe.editor).toBeTruthy())
  return probe.editor!
}

describe('MovpEditor dirty signal', () => {
  it('emits clean at mount and dirty immediately on a doc-changing edit', async () => {
    const onDirtyChange = vi.fn()
    const ed = await mount({ initialBody: BODY_A, onSave: vi.fn(), onRefresh: vi.fn(), onDirtyChange })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
    onDirtyChange.mockClear()
    act(() => { ed.commands.insertContent(' x') })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  it('does not emit on a selection-only (non-docChanged) transaction', async () => {
    const onDirtyChange = vi.fn()
    const ed = await mount({ initialBody: BODY_A, onSave: vi.fn(), onRefresh: vi.fn(), onDirtyChange })
    onDirtyChange.mockClear()
    act(() => { ed.commands.setTextSelection(1) })
    expect(onDirtyChange).not.toHaveBeenCalled()
  })

  it('reconciles back to clean when an edit is undone to the baseline', async () => {
    const onDirtyChange = vi.fn()
    const ed = await mount({ initialBody: BODY_A, onSave: vi.fn(), onRefresh: vi.fn(), onDirtyChange })
    act(() => { ed.commands.insertContent(' x') })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    act(() => { ed.commands.undo() })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false), { timeout: 500 })
  })

  it('clears dirty after a successful save', async () => {
    const onSave = vi.fn().mockResolvedValue({ status: 'saved', revisionId: 'r1' })
    const onDirtyChange = vi.fn()
    const ed = await mount({ initialBody: BODY_A, onSave, onRefresh: vi.fn(), onDirtyChange })
    act(() => { ed.commands.insertContent(' edited') })
    fireEvent.click(screen.getByRole('button', { name: 'Save content' }))
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
  })

  it('stays dirty when the user edits during an in-flight save', async () => {
    let resolveSave!: (result: { status: 'saved'; revisionId: string }) => void
    const onSave = vi.fn(() => new Promise<{ status: 'saved'; revisionId: string }>((resolve) => {
      resolveSave = resolve
    }))
    const onDirtyChange = vi.fn()
    const ed = await mount({ initialBody: BODY_A, onSave, onRefresh: vi.fn(), onDirtyChange })
    act(() => { ed.commands.insertContent(' first') })
    fireEvent.click(screen.getByRole('button', { name: 'Save content' }))
    act(() => { ed.commands.insertContent(' second') })
    onDirtyChange.mockClear()
    await act(async () => { resolveSave({ status: 'saved', revisionId: 'r1' }) })
    expect(onDirtyChange).not.toHaveBeenCalledWith(false)
  })
})
