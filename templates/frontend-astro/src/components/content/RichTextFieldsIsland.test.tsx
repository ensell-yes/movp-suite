// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const sdkProbe = vi.hoisted(() => ({ mounts: 0, saves: 0 }))
vi.mock('@movp/editor-sdk', async () => {
  const { useEffect, useState } = await import('react')
  type Result =
    | { status: 'saved'; revisionId: string }
    | { status: 'conflict' }
    | { status: 'error'; code: 'save_failed' }
  return {
    MovpEditor: (props: {
      initialBody: string
      onSave?: (body: string) => Promise<Result>
      onSaved?: (revisionId: string) => void
      onDirtyChange?: (dirty: boolean) => void
      onRefresh?: () => void
      onLoadLatest?: () => void
    }) => {
      const [draft, setDraft] = useState(props.initialBody)
      useEffect(() => { sdkProbe.mounts += 1 }, [])
      return (
        <div data-testid="editor">
          <output data-testid="editor-body">{draft}</output>
          <button type="button" onClick={() => { setDraft('LOCAL-DRAFT'); props.onDirtyChange?.(true) }}>mark-dirty</button>
          <button type="button" onClick={() => props.onDirtyChange?.(false)}>mark-clean</button>
          <button type="button" onClick={() => {
            void props.onSave?.(draft).then((result) => {
              if (result.status === 'saved') {
                props.onSaved?.(result.revisionId)
                sdkProbe.saves += 1
              }
            })
          }}>do-save</button>
          <button type="button" onClick={() => props.onRefresh?.()}>do-refresh</button>
          <button type="button" onClick={() => props.onLoadLatest?.()}>do-load-latest</button>
        </div>
      )
    },
  }
})

import RichTextFieldsIsland from './RichTextFieldsIsland.tsx'

afterEach(() => { cleanup(); vi.restoreAllMocks(); sdkProbe.mounts = 0; sdkProbe.saves = 0 })

const twoFields = [
  { key: 'body', label: 'Body', body: 'server A' },
  { key: 'summary', label: 'Summary', body: '' },
]

describe('RichTextFieldsIsland', () => {
  it('hydrates and renders one editor per richtext field, clean', async () => {
    render(<RichTextFieldsIsland itemId="rtx" initialRevisionId="r0" fields={twoFields} />)
    await waitFor(() => expect(screen.getByTestId('richtext-island').getAttribute('data-ready')).toBe('true'))
    expect(screen.getAllByTestId('editor').length).toBe(2)
    expect(screen.getByTestId('richtext-island').getAttribute('data-dirty')).toBe('false')
  })

  it('installs exactly ONE beforeunload listener while any field is dirty; removes it when clean; cleans up on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const adds = () => add.mock.calls.filter(([type]) => type === 'beforeunload').length
    const removes = () => remove.mock.calls.filter(([type]) => type === 'beforeunload').length
    const { unmount } = render(<RichTextFieldsIsland itemId="rtx" initialRevisionId="r0" fields={twoFields} />)

    expect(adds()).toBe(0)
    const [bodyDirty, summaryDirty] = screen.getAllByRole('button', { name: 'mark-dirty' })
    fireEvent.click(bodyDirty!)
    expect(adds()).toBe(1)
    const beforeUnload = add.mock.calls.find(([type]) => type === 'beforeunload')?.[1]
    expect(beforeUnload).toBeTypeOf('function')
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    fireEvent.click(summaryDirty!)
    expect(adds()).toBe(1)
    const [bodyClean, summaryClean] = screen.getAllByRole('button', { name: 'mark-clean' })
    fireEvent.click(bodyClean!)
    expect(removes()).toBe(0)
    fireEvent.click(summaryClean!)
    expect(removes()).toBe(1)
    expect(screen.getByTestId('richtext-island').getAttribute('data-dirty')).toBe('false')

    fireEvent.click(bodyDirty!)
    unmount()
    expect(removes()).toBe(2)
  })

  it('advances the shared revision after one field saves so its sibling uses the new base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ revisionId: 'r1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revisionId: 'r2' }), { status: 200 }))
    render(<RichTextFieldsIsland itemId="rtx" initialRevisionId="r0" fields={twoFields} />)

    const [bodySave, summarySave] = screen.getAllByRole('button', { name: 'do-save' })
    fireEvent.click(bodySave!)
    await waitFor(() => expect(sdkProbe.saves).toBe(1))
    fireEvent.click(summarySave!)
    await waitFor(() => expect(sdkProbe.saves).toBe(2))
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as unknown
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as unknown
    expect(firstRequest).toMatchObject({ fieldKey: 'body', expectedRevisionId: 'r0' })
    expect(secondRequest).toMatchObject({ fieldKey: 'summary', expectedRevisionId: 'r1' })
  })

  it('surfaces ready_to_retry on refresh success and refresh_error on GET failure (draft untouched)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ body: '', revisionId: 'r9' }), { status: 200 }))
    render(<RichTextFieldsIsland itemId="rtx" initialRevisionId="r0" fields={[twoFields[0]!]} />)
    fireEvent.click(screen.getByRole('button', { name: 'do-refresh' }))
    await screen.findByText('Revision updated — Save to retry.')
    expect(screen.getByTestId('editor-body').textContent).toContain('server A')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'conflict' }), { status: 409 }))
    fireEvent.click(screen.getByRole('button', { name: 'do-save' }))
    await waitFor(() => expect(screen.queryByText('Revision updated — Save to retry.')).toBeNull())

    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))
    fireEvent.click(screen.getByRole('button', { name: 'do-refresh' }))
    await screen.findByText(/Could not refresh/)
  })

  it('load-latest remounts with the server body even when it equals initialBody, and clears dirty (N-1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    render(<RichTextFieldsIsland itemId="rtx" initialRevisionId="r0" fields={[twoFields[0]!]} />)
    await waitFor(() => expect(sdkProbe.mounts).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'mark-dirty' }))
    expect(screen.getByTestId('editor-body').textContent).toBe('LOCAL-DRAFT')
    expect(screen.getByTestId('richtext-island').getAttribute('data-dirty')).toBe('true')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ body: 'server A', revisionId: 'r9' }), { status: 200 }))
    fireEvent.click(screen.getByRole('button', { name: 'do-load-latest' }))
    await waitFor(() => expect(sdkProbe.mounts).toBe(2))
    expect(screen.getByTestId('editor-body').textContent).toContain('server A')
    expect(screen.getByTestId('editor-body').textContent).not.toContain('LOCAL-DRAFT')
    await waitFor(() => expect(screen.getByTestId('richtext-island').getAttribute('data-dirty')).toBe('false'))
  })
})
