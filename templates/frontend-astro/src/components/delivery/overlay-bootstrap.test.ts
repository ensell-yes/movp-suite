// @vitest-environment jsdom
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installContentOverlayBootstrap,
  NEGATIVE_MARKER_KEY,
  type OverlayBootstrapDeps,
} from './overlay-bootstrap.ts'
import { createOverlayHostOptions } from '../../lib/content-overlay.ts'

const ITEM = 'd1000000-0000-4000-8000-000000000001'
const REVISION = 'd2000000-0000-4000-8000-000000000001'
const BODY = '{"type":"doc","content":[]}'

function deps(fetchImpl: typeof fetch): OverlayBootstrapDeps {
  return {
    fetchImpl,
    loadOverlay: vi.fn(async () => ({ mountOverlay: vi.fn() })),
    now: () => 1_000,
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('overlay bootstrap', () => {
  it('has no static editor graph and names only the approved dynamic import', () => {
    for (const relative of [
      'src/components/delivery/overlay-bootstrap.ts',
      'src/lib/content-overlay.ts',
    ]) {
      const path = join(process.cwd(), relative)
      const info = lstatSync(path)
      expect(info.isSymbolicLink()).toBe(false)
      expect(info.isFile()).toBe(true)
      expect(info.size).toBeLessThanOrEqual(256 * 1024)
      const source = readFileSync(path, 'utf8')
      expect(source).not.toMatch(/^\s*(?:import|export).*@movp\/editor-sdk/m)
      expect(source).not.toMatch(/@tiptap|react-dom|MovpEditor/)
    }
    const bootstrap = readFileSync(
      join(process.cwd(), 'src/components/delivery/overlay-bootstrap.ts'),
      'utf8',
    )
    expect(bootstrap.match(/import\('@movp\/editor-sdk\/overlay'\)/g)).toHaveLength(1)
    expect(bootstrap.match(/import\('@movp\/editor-sdk\/overlay\.css\?url'\)/g)).toHaveLength(1)
  })

  it('makes no request before interaction, then imports only after exact true', async () => {
    document.body.innerHTML = `<div data-movp-item="${ITEM}" data-movp-field="body"></div>`
    const fetchImpl = vi.fn(async () => Response.json({ canEdit: true }))
    const value = deps(fetchImpl as typeof fetch)
    const handle = installContentOverlayBootstrap(value)
    expect(fetchImpl).not.toHaveBeenCalled()

    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await vi.waitFor(() => expect(value.loadOverlay).toHaveBeenCalledTimes(1))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(`/api/content/${ITEM}/capability`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
    handle.destroy()
  })

  it('fails closed when a delivery document binds more than one content item', async () => {
    const secondItem = 'd1000000-0000-4000-8000-000000000002'
    document.body.innerHTML = `
      <div data-movp-item="${ITEM}" data-movp-field="body"></div>
      <div data-movp-item="${secondItem}" data-movp-field="body"></div>
    `
    const fetchImpl = vi.fn(async () => Response.json({ canEdit: true }))
    const value = deps(fetchImpl as typeof fetch)
    installContentOverlayBootstrap(value)

    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await Promise.resolve()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(value.loadOverlay).not.toHaveBeenCalled()
  })

  it('negative-caches exact false for 60 seconds across bootstrap mounts', async () => {
    document.body.innerHTML = `<div data-movp-item="${ITEM}" data-movp-field="body"></div>`
    const fetchImpl = vi.fn(async () => Response.json({ canEdit: false }))
    const first = deps(fetchImpl as typeof fetch)
    installContentOverlayBootstrap(first)
    document.dispatchEvent(new Event('focusin', { bubbles: true }))
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(sessionStorage.getItem(NEGATIVE_MARKER_KEY)).not.toBeNull())
    const stored = sessionStorage.getItem(NEGATIVE_MARKER_KEY) ?? ''
    expect(stored).not.toContain(ITEM)
    expect(stored).toContain('61000')

    const second = deps(fetchImpl as typeof fetch)
    installContentOverlayBootstrap(second)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    await Promise.resolve()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(second.loadOverlay).not.toHaveBeenCalled()
  })

  it.each([
    [{ canEdit: true, extra: true }],
    [{ canEdit: 'true' }],
    [{}],
  ])('malformed response %# never imports or negative-caches', async (body) => {
    document.body.innerHTML = `<div data-movp-item="${ITEM}" data-movp-field="body"></div>`
    const value = deps(vi.fn(async () => Response.json(body)) as typeof fetch)
    installContentOverlayBootstrap(value)
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await vi.waitFor(() => expect(value.fetchImpl).toHaveBeenCalledTimes(1))
    expect(value.loadOverlay).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(NEGATIVE_MARKER_KEY)).toBeNull()
  })

  it('rejects a capability response before buffering more than 1 KiB', async () => {
    document.body.innerHTML = `<div data-movp-item="${ITEM}" data-movp-field="body"></div>`
    const cancel = vi.fn(async () => undefined)
    let reads = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_025))
      },
      cancel,
    }))
    const reader = response.body?.getReader()
    if (!reader) throw new Error('response_body_missing')
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              reads += 1
              return reader.read()
            },
            cancel,
          }
        },
      },
    } as unknown as Response))
    const value = deps(fetchImpl as typeof fetch)
    installContentOverlayBootstrap(value)
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
    expect(reads).toBe(1)
    expect(value.loadOverlay).not.toHaveBeenCalled()
  })

  it('retries one transient response but never retries a terminal 4xx', async () => {
    document.body.innerHTML = `<div data-movp-item="${ITEM}" data-movp-field="body"></div>`
    const transient = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ canEdit: true }))
    const first = deps(transient as typeof fetch)
    installContentOverlayBootstrap(first)
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await vi.waitFor(() => expect(transient).toHaveBeenCalledTimes(2))
    expect(first.loadOverlay).toHaveBeenCalledTimes(1)

    sessionStorage.clear()
    const terminal = vi.fn(async () => new Response('', { status: 403 }))
    const second = deps(terminal as typeof fetch)
    installContentOverlayBootstrap(second)
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(1))
    expect(second.loadOverlay).not.toHaveBeenCalled()
  })

  it('host adapters use only the existing GET/POST rich-text route', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ body: BODY, revisionId: REVISION }))
      .mockResolvedValueOnce(Response.json({ status: 'saved', revisionId: 'revision-2' }))
    const host = createOverlayHostOptions(fetchImpl as typeof fetch)
    await expect(host.resolveEditable({ itemId: ITEM, fieldKey: 'body' })).resolves.toEqual({
      itemId: ITEM,
      fieldKey: 'body',
      body: BODY,
      revisionId: REVISION,
    })
    await expect(host.save({
      itemId: ITEM,
      fieldKey: 'body',
      body: BODY,
      revisionId: REVISION,
    }, BODY)).resolves.toEqual({ status: 'saved', revisionId: 'revision-2' })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `/api/content/${ITEM}/richtext?fieldKey=body`,
    )
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`/api/content/${ITEM}/richtext`)
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    })
  })
})
