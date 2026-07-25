import { createOverlayHostOptions } from '../../lib/content-overlay.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NEGATIVE_TTL_MS = 60_000
export const NEGATIVE_MARKER_KEY = 'movp-overlay-negative-v1'

type OverlayHandle = { destroy(): void }
type OverlayModule = {
  mountOverlay(options: ReturnType<typeof createOverlayHostOptions>): OverlayHandle
}

export interface OverlayBootstrapDeps {
  fetchImpl: typeof fetch
  loadOverlay(): Promise<OverlayModule>
  now(): number
  document?: Document
  storage?: Storage
}

async function defaultLoadOverlay(): Promise<OverlayModule> {
  const stylesheet = await import('@movp/editor-sdk/overlay.css?url')
  if (typeof stylesheet.default !== 'string' || !stylesheet.default.startsWith('/')) {
    throw new Error('overlay_stylesheet_url_invalid')
  }
  if (!document.querySelector(`link[data-movp-overlay-styles="${stylesheet.default}"]`)) {
    await new Promise<void>((resolve, reject) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = stylesheet.default
      link.dataset.movpOverlayStyles = stylesheet.default
      link.addEventListener('load', () => resolve(), { once: true })
      link.addEventListener('error', () => reject(new Error('overlay_stylesheet_load_failed')), {
        once: true,
      })
      document.head.append(link)
    })
  }
  return import('@movp/editor-sdk/overlay')
}

function hasFreshNegative(storage: Storage, now: number): boolean {
  const raw = storage.getItem(NEGATIVE_MARKER_KEY)
  if (!raw || raw.length > 128) return false
  try {
    const value: unknown = JSON.parse(raw)
    return value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value as { denied?: unknown }).denied === true
      && typeof (value as { expiresAt?: unknown }).expiresAt === 'number'
      && (value as { expiresAt: number }).expiresAt > now
  } catch {
    return false
  }
}

async function exactCapability(response: Response): Promise<boolean | null> {
  if (response.status !== 200) return null
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  let value: unknown
  try {
    for (;;) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      total += chunk.byteLength
      if (total > 1_024) {
        await reader.cancel()
        return null
      }
      chunks.push(chunk)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'canEdit') return null
  const canEdit = (value as { canEdit?: unknown }).canEdit
  return typeof canEdit === 'boolean' ? canEdit : null
}

export function installContentOverlayBootstrap(
  overrides: Partial<OverlayBootstrapDeps> = {},
): OverlayHandle {
  const doc = overrides.document ?? document
  const storage = overrides.storage ?? sessionStorage
  const fetchImpl = overrides.fetchImpl ?? fetch
  const loadOverlay = overrides.loadOverlay ?? defaultLoadOverlay
  const now = overrides.now ?? Date.now
  const bound = doc.querySelector<HTMLElement>('[data-movp-item][data-movp-field]')
  const itemId = bound?.dataset.movpItem ?? ''
  let started = false
  let destroyed = false
  let overlay: OverlayHandle | null = null
  const events = ['pointerdown', 'keydown', 'focusin'] as const
  const removeListeners = () => {
    for (const event of events) doc.removeEventListener(event, start)
  }

  const start = () => {
    if (started || destroyed) return
    started = true
    removeListeners()
    if (!UUID.test(itemId) || hasFreshNegative(storage, now())) return
    void (async () => {
      let response: Response | null = null
      let operationalFailure = false
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetchImpl(`/api/content/${itemId}/capability`, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (![502, 503, 504].includes(response.status)) break
          operationalFailure = true
        } catch {
          operationalFailure = true
        }
      }
      if (!response || [502, 503, 504].includes(response.status)) {
        if (operationalFailure) console.warn('content_overlay_capability_probe_failed')
        return
      }
      const canEdit = await exactCapability(response)
      if (canEdit === false) {
        storage.setItem(NEGATIVE_MARKER_KEY, JSON.stringify({
          denied: true,
          expiresAt: now() + NEGATIVE_TTL_MS,
        }))
        return
      }
      if (canEdit !== true || destroyed) return
      try {
        const module = await loadOverlay()
        if (!destroyed) overlay = module.mountOverlay(createOverlayHostOptions(fetchImpl))
      } catch {
        console.warn('content_overlay_capability_probe_failed')
      }
    })()
  }

  for (const event of events) doc.addEventListener(event, start, { once: true })
  return {
    destroy() {
      if (destroyed) return
      destroyed = true
      removeListeners()
      overlay?.destroy()
    },
  }
}
