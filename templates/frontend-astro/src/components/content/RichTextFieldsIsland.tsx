import { MovpEditor, type SaveResult } from '@movp/editor-sdk'
import { normalizeToCanonicalDoc } from '@movp/richtext'
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'

type Field = {
  key: string
  label: string
  body: string
}

type Props = {
  itemId: string
  fields: Field[]
  initialRevisionId: string
}

type LatestField = {
  body: string
  revisionId: string
}

type RefreshState = 'idle' | 'refreshing' | 'ready_to_retry' | 'refresh_error'

function isLatestField(value: unknown): value is LatestField {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as { body?: unknown; revisionId?: unknown }
  return typeof row.body === 'string' && typeof row.revisionId === 'string'
}

function savedRevision(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const revisionId = (value as { revisionId?: unknown }).revisionId
  return typeof revisionId === 'string' ? revisionId : null
}

export default function RichTextFieldsIsland({ itemId, fields, initialRevisionId }: Props) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => { setHydrated(true) }, [])

  const revisionRef = useRef(initialRevisionId)
  const dirtyKeys = useRef<Set<string>>(new Set())
  const beforeUnloadHandler = useRef<((event: BeforeUnloadEvent) => void) | null>(null)
  const [dirtyCount, setDirtyCount] = useState(0)

  const setFieldDirty = useCallback((key: string, isDirty: boolean) => {
    if (isDirty) dirtyKeys.current.add(key)
    else dirtyKeys.current.delete(key)

    if (dirtyKeys.current.size > 0 && !beforeUnloadHandler.current) {
      const handler = (event: BeforeUnloadEvent) => {
        event.preventDefault()
        event.returnValue = ''
      }
      beforeUnloadHandler.current = handler
      window.addEventListener('beforeunload', handler)
    } else if (dirtyKeys.current.size === 0 && beforeUnloadHandler.current) {
      window.removeEventListener('beforeunload', beforeUnloadHandler.current)
      beforeUnloadHandler.current = null
    }

    setDirtyCount(dirtyKeys.current.size)
  }, [])

  useEffect(() => () => {
    if (beforeUnloadHandler.current) {
      window.removeEventListener('beforeunload', beforeUnloadHandler.current)
    }
  }, [])

  return (
    <div
      data-testid="richtext-island"
      data-ready={hydrated ? 'true' : 'false'}
      data-dirty={dirtyCount > 0 ? 'true' : 'false'}
    >
      {fields.map((field) => (
        <RichTextField
          key={field.key}
          itemId={itemId}
          field={field}
          revisionRef={revisionRef}
          setFieldDirty={setFieldDirty}
        />
      ))}
    </div>
  )
}

function RichTextField({
  itemId,
  field,
  revisionRef,
  setFieldDirty,
}: {
  itemId: string
  field: Field
  revisionRef: MutableRefObject<string>
  setFieldDirty: (key: string, isDirty: boolean) => void
}) {
  // V1 intentionally shows legacy HTML as literal text; operators audit/clean it per spec §3.4.
  const [initialBody, setInitialBody] = useState(() => normalizeToCanonicalDoc(field.body))
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [refreshState, setRefreshState] = useState<RefreshState>('idle')

  const onSave = async (body: string): Promise<SaveResult> => {
    const response = await fetch(`/api/content/${encodeURIComponent(itemId)}/richtext`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fieldKey: field.key,
        body,
        expectedRevisionId: revisionRef.current,
      }),
    })
    if (response.status === 409) {
      setRefreshState('idle')
      return { status: 'conflict' }
    }
    if (response.status !== 200) return { status: 'error', code: 'save_failed' }

    const payload: unknown = await response.json()
    const revisionId = savedRevision(payload)
    return revisionId
      ? { status: 'saved', revisionId }
      : { status: 'error', code: 'save_failed' }
  }

  const onSaved = (revisionId: string) => {
    revisionRef.current = revisionId
    setRefreshState('idle')
  }

  const fetchLatest = async (): Promise<LatestField> => {
    const response = await fetch(
      `/api/content/${encodeURIComponent(itemId)}/richtext?fieldKey=${encodeURIComponent(field.key)}`,
    )
    if (!response.ok) throw new Error('refresh_failed')
    const payload: unknown = await response.json()
    if (!isLatestField(payload)) throw new Error('refresh_invalid_response')
    return payload
  }

  const onRefresh = () => {
    setRefreshState('refreshing')
    void fetchLatest()
      .then((latest) => {
        revisionRef.current = latest.revisionId
        setRefreshState('ready_to_retry')
      })
      .catch(() => setRefreshState('refresh_error'))
  }

  const onLoadLatest = () => {
    setRefreshState('refreshing')
    void fetchLatest()
      .then((latest) => {
        revisionRef.current = latest.revisionId
        setInitialBody(normalizeToCanonicalDoc(latest.body))
        setEditorEpoch((epoch) => epoch + 1)
        setFieldDirty(field.key, false)
        setRefreshState('idle')
      })
      .catch(() => setRefreshState('refresh_error'))
  }

  return (
    <section aria-label={field.label} data-field-control>
      <MovpEditor
        key={editorEpoch}
        initialBody={initialBody}
        onSave={onSave}
        onSaved={onSaved}
        onRefresh={onRefresh}
        onLoadLatest={onLoadLatest}
        onDirtyChange={(isDirty) => setFieldDirty(field.key, isDirty)}
      />
      {refreshState === 'ready_to_retry' && (
        <span role="status">Revision updated — Save to retry.</span>
      )}
      {refreshState === 'refresh_error' && (
        <span role="alert">Could not refresh. Your draft is safe; try again.</span>
      )}
    </section>
  )
}
