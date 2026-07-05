import { useEffect, useState } from 'react'

type Group = 'all' | 'any' | 'not'
type View =
  | { kind: 'idle' } | { kind: 'loading' }
  | { kind: 'previewed'; count: number } | { kind: 'saved'; version: number }
  | { kind: 'error'; code: string }

export default function RuleBuilder({ segmentId }: { segmentId: string }) {
  const [group, setGroup] = useState<Group>('all')
  const [value, setValue] = useState('')
  const [view, setView] = useState<View>({ kind: 'idle' })
  const [hydrated, setHydrated] = useState(false)
  // Mirror SearchBox: expose a hydration marker so tests click Preview/Save only after React attaches.
  useEffect(() => { setHydrated(true) }, [])
  const predicate = () => JSON.stringify({ [group]: value ? [{ event: value }] : [] })

  async function post(path: string): Promise<Response | null> {
    try {
      return await fetch(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ segmentId, predicate: predicate() }),
      })
    } catch { setView({ kind: 'error', code: 'network_error' }); return null }
  }
  async function preview() {
    setView({ kind: 'loading' })
    const res = await post('/api/segments/preview'); if (!res) return
    if (res.status === 401) return setView({ kind: 'error', code: 'auth_error' })
    if (!res.ok) return setView({ kind: 'error', code: 'preview_failed' })
    const body = (await res.json()) as { count: number }
    setView({ kind: 'previewed', count: body.count })
  }
  async function save() {
    setView({ kind: 'loading' })
    const res = await post('/api/segments/save-rule'); if (!res) return
    if (res.status === 401) return setView({ kind: 'error', code: 'auth_error' })
    if (!res.ok) return setView({ kind: 'error', code: 'save_failed' })
    const body = (await res.json()) as { rule: { version: number } | null }
    setView(body.rule ? { kind: 'saved', version: body.rule.version } : { kind: 'error', code: 'save_failed' })
  }

  return (
    <div data-testid="rule-builder-island" data-ready={hydrated ? 'true' : 'false'}>
      <fieldset>
        <legend>Match</legend>
        {(['all', 'any', 'not'] as Group[]).map((g) => (
          <label key={g}><input type="radio" name="group" checked={group === g} onChange={() => setGroup(g)} /> {g}</label>
        ))}
        <label htmlFor="cond">Event</label>
        <input id="cond" value={value} onChange={(e) => setValue(e.target.value)} />
      </fieldset>
      <button type="button" onClick={() => void preview()}>Preview</button>
      <button type="button" onClick={() => void save()}>Save</button>
      {view.kind === 'loading' && <p data-testid="rule-loading" role="status" aria-live="polite">Working…</p>}
      {view.kind === 'previewed' && <p data-testid="rule-preview">~{view.count} subjects match</p>}
      {view.kind === 'saved' && <p data-testid="rule-saved" role="status">Saved v{view.version}</p>}
      {view.kind === 'error' && <p data-testid="rule-error" role="alert">Failed ({view.code}).</p>}
    </div>
  )
}
