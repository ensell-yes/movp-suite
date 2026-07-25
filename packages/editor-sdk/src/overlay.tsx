import { createRoot, type Root } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { MovpEditor } from './editor.tsx'
import type { SaveResult } from './save.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/

export interface OverlayRegion {
  itemId: string
  fieldKey: string
  body: string
  revisionId: string
}

type RegionReference = Pick<OverlayRegion, 'itemId' | 'fieldKey'>

export interface OverlayOptions {
  root?: ParentNode
  canEdit(region: RegionReference): Promise<boolean>
  resolveEditable(region: RegionReference): Promise<OverlayRegion | null>
  save(
    region: OverlayRegion,
    body: string,
  ): Promise<
    | { status: 'saved'; revisionId: string }
    | { status: 'conflict' }
    | { status: 'error'; code: string }
  >
}

export interface OverlayHandle {
  destroy(): void
}

type MountedRegion = {
  host: HTMLElement
  root: Root
}

function isRegion(value: OverlayRegion | null, expected: RegionReference): value is OverlayRegion {
  return value !== null
    && value.itemId === expected.itemId
    && value.fieldKey === expected.fieldKey
    && typeof value.body === 'string'
    && typeof value.revisionId === 'string'
    && value.revisionId.length > 0
}

function safeErrorMessage(code: string): string {
  if (code === 'auth_error') return 'Sign in again to keep editing.'
  if (code === 'content_edit_forbidden') return 'You no longer have permission to edit this field.'
  if (code === 'invalid_request') return 'This field can no longer be edited here.'
  if (code === 'not_found') return 'This content is no longer available.'
  if (
    code === 'content_revision_invalid'
    || code === 'content_revision_not_found'
    || code === 'content_schema_invalid'
  ) {
    return 'Refresh the page before trying to save again.'
  }
  return 'Save failed. Please try again.'
}

function RegionOverlay({
  reference,
  options,
}: {
  reference: RegionReference
  options: OverlayOptions
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [region, setRegion] = useState<OverlayRegion | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | undefined>()

  const resolve = async (): Promise<OverlayRegion | null> => {
    try {
      const next = await options.resolveEditable(reference)
      return isRegion(next, reference) ? next : null
    } catch {
      return null
    }
  }

  const openEditor = async () => {
    if (loading || open) return
    setLoading(true)
    setActionError(null)
    const next = await resolve()
    setLoading(false)
    if (!next) {
      setActionError('Could not load this field. Please try again.')
      return
    }
    setRegion(next)
    setOpen(true)
  }

  const closeEditor = () => {
    setOpen(false)
    queueMicrotask(() => triggerRef.current?.focus())
  }

  useEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus()
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeEditor()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [open])

  const save = async (body: string): Promise<SaveResult> => {
    if (!region) return { status: 'error', code: 'save_failed' }
    let result: Awaited<ReturnType<OverlayOptions['save']>>
    try {
      result = await options.save(region, body)
    } catch {
      result = { status: 'error', code: 'save_failed' }
    }
    if (result.status === 'saved') {
      setRegion((current) => current
        ? { ...current, revisionId: result.revisionId }
        : current)
      setSaveError(undefined)
    } else if (result.status === 'error') {
      setSaveError(safeErrorMessage(result.code))
    }
    return result
  }

  const refreshRevision = () => {
    setActionError(null)
    void resolve().then((next) => {
      if (!next) {
        setActionError('Could not refresh the revision. Your draft is unchanged.')
        return
      }
      setRegion((current) => current ? { ...current, revisionId: next.revisionId } : current)
    })
  }

  const loadLatest = () => {
    setActionError(null)
    void resolve().then((next) => {
      if (!next) {
        setActionError('Could not load the latest field. Your draft is unchanged.')
        return
      }
      setRegion(next)
      setSaveError(undefined)
    })
  }

  return (
    <div className="movp-overlay">
      <button
        ref={triggerRef}
        type="button"
        className="movp-overlay__control"
        aria-label={`Edit ${reference.fieldKey}`}
        aria-expanded={open}
        disabled={loading}
        onClick={() => void openEditor()}
      >
        Edit
      </button>
      {actionError && <div className="movp-overlay__alert" role="alert">{actionError}</div>}
      {open && region && (
        <div
          className="movp-overlay__dialog"
          role="dialog"
          aria-label={`Edit ${reference.fieldKey}`}
        >
          <button
            ref={closeButtonRef}
            type="button"
            className="movp-overlay__control"
            aria-label={`Close ${reference.fieldKey} editor`}
            onClick={closeEditor}
          >
            Close
          </button>
          <MovpEditor
            initialBody={region.body}
            onSave={save}
            onSaved={(revisionId) => {
              setRegion((current) => current ? { ...current, revisionId } : current)
            }}
            onRefresh={refreshRevision}
            onLoadLatest={loadLatest}
            errorMessage={saveError}
          />
        </div>
      )}
    </div>
  )
}

export function mountOverlay(options: OverlayOptions): OverlayHandle {
  const scanRoot = options.root ?? document
  const mounted: MountedRegion[] = []
  const seen = new Set<string>()
  let destroyed = false

  for (const element of Array.from(
    scanRoot.querySelectorAll<HTMLElement>('[data-movp-item][data-movp-field]'),
  )) {
    const itemId = element.dataset.movpItem ?? ''
    const fieldKey = element.dataset.movpField ?? ''
    if (!UUID.test(itemId) || !FIELD_KEY.test(fieldKey)) continue
    const key = `${itemId}\u0000${fieldKey}`
    if (seen.has(key)) continue
    seen.add(key)
    const reference = { itemId, fieldKey }

    void Promise.resolve(options.canEdit(reference)).then((allowed) => {
      if (!allowed || destroyed || !element.parentNode) return
      const host = document.createElement('div')
      host.className = 'movp-overlay-host'
      element.after(host)
      const root = createRoot(host)
      mounted.push({ host, root })
      root.render(<RegionOverlay reference={reference} options={options} />)
    }).catch(() => {
      // Advisory capability failure is fail-closed: the public page keeps no chrome.
    })
  }

  return {
    destroy() {
      if (destroyed) return
      destroyed = true
      for (const entry of mounted.splice(0)) {
        entry.root.unmount()
        entry.host.remove()
      }
    },
  }
}
