import { useState } from 'react'
import type { SearchHit } from '../lib/graphql.ts'

type View =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ok'; hits: SearchHit[] }
  | { kind: 'error'; code: string }

export default function SearchBox() {
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>({ kind: 'idle' })

  async function run(query: string) {
    if (!query.trim()) return
    setView({ kind: 'loading' })
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
      if (res.status === 401) return setView({ kind: 'error', code: 'auth_error' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string }
        return setView({ kind: 'error', code: body.code ?? 'http_error' })
      }
      const body = (await res.json()) as { hits: SearchHit[] }
      setView(body.hits.length === 0 ? { kind: 'empty' } : { kind: 'ok', hits: body.hits })
    } catch {
      setView({ kind: 'error', code: 'network_error' })
    }
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(q)
        }}
        role="search"
      >
        <label htmlFor="q">Search notes</label>
        <input id="q" name="q" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit">Search</button>
      </form>

      {view.kind === 'loading' && (
        <p data-testid="search-loading" role="status" aria-live="polite">
          Searching...
        </p>
      )}
      {view.kind === 'empty' && <p data-testid="search-empty">No results.</p>}
      {view.kind === 'error' && (
        <div data-testid="search-error" role="alert">
          <p>Search failed ({view.code}).</p>
          <button data-testid="search-retry" onClick={() => void run(q)}>
            Retry
          </button>
        </div>
      )}
      {view.kind === 'ok' && (
        <ul data-testid="search-results" aria-label="Search results">
          {view.hits.map((h) => (
            <li key={`${h.collection}:${h.id}`}>
              <a href={`/notes/${h.id}`}>{h.title}</a> <small>{h.collection} score {h.score.toFixed(2)}</small>
              <div>{h.snippet}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
