# C7.3b — Editor Binding & Conflict UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount `@movp/editor-sdk`'s `MovpEditor` inline on the CMS editor page as a coordinated island, saving one rich-text field at a time through a bounded, observable server endpoint, with non-destructive concurrent-edit conflict recovery, proven by a two-session Playwright test.

**Architecture:** A `RichTextFieldsIsland` React island renders every rich-text field over one shared revision id; each field saves via `POST /api/content/[id]/richtext`, which does one combined authenticated read, merges the single field, and calls `updateContent` with `expectedRevisionId`. The SDK gains a `docChanged`-gated dirty signal (drives a `beforeunload` guard) and a non-destructive conflict surface (refresh re-syncs the revision, keeps the draft; "Load latest field" is a separate destructive action). A stateful mock proves the real conflict/idempotency mechanics in the fast e2e job. This is **part b of C7.3** (spec `docs/superpowers/specs/2026-07-16-c7.3-content-binding-design.md`); it lands AFTER C7.3a.

**Tech Stack:** TypeScript, React 18 islands (`@astrojs/react`), Astro server routes on Cloudflare Workers (`wrangler`), Vitest + `@testing-library/react`, Playwright.

## Global Constraints

- **Precondition:** C7.3a is merged. This plan consumes `@movp/richtext` (`normalizeToCanonicalDoc`, `isDocShape`, `canonicalizeInnerJson`) and the hash-first `update_content`. Before starting, run the **reconciliation checkpoint** below.
- Client-safe boundary (enforced by `scripts/check-boundary.sh` over all of `templates/`): the island and any component MUST NOT import `@movp/auth`, `@movp/domain`, or reference `service_role`/`SERVICE_ROLE_KEY`/`SUPABASE_SERVICE_ROLE`. Islands reach the server only through the API route + `gqlRequest`.
- API routes use the real pattern: `export const POST: APIRoute = async ({ request, cookies }) => { … }`, `getSessionToken(cookies)`, `readServerEnv()`, `gqlRequest(opts, query, vars)`, and `Response.json(body, { status })`. Do NOT use `Astro.cookies` or `new Response(JSON.stringify(...))`.
- Conflict is recognized by **message substring** `content_update_conflict` on a `{ ok: false }` `gqlRequest` result (the existing page pattern, `content/[id].astro:124-130`), NOT by an extension `code`.
- `MAX_BODY_BYTES = 262_144` (256 KiB). Bound the request stream BEFORE buffering (untrusted-I/O rule).
- Observability: emit exactly one content-disciplined event per POST outcome; never log the body, the token, or an unvalidated `fieldKey`.
- `onSave`/`onSaved`/`onLoadLatest`/`onDirtyChange` host callbacks are contained: a throwing host callback must not corrupt SDK state (the F5 pattern, already in `editor.tsx`).

### Reconciliation checkpoint (run BEFORE Task 1)

C7.3a was planned against intended interfaces. Confirm the built reality matches, and fix this plan's samples if not:
```bash
# 1. @movp/richtext exports the three functions this plan imports:
node -e "import('@movp/richtext').then(m=>console.log(['canonicalizeInnerJson','isDocShape','normalizeToCanonicalDoc'].map(k=>k+':'+typeof m[k]).join(' ')))"
# Expected: canonicalizeInnerJson:function isDocShape:function normalizeToCanonicalDoc:function
# 2. The conflict string the domain throws is exactly 'content_update_conflict':
grep -n "content_update_conflict" packages/domain/src/content.ts
# 3. The hash-first migration exists (name may differ from the C7.3a placeholder):
ls supabase/migrations/*update_content_hash_first*.sql
```
If any differ (export name, conflict string, migration name), update the affected samples in this plan before implementing.

---

## File Structure

- `packages/editor-sdk/src/editor.tsx` (modify) — add `onDirtyChange` + `onLoadLatest`; dirty baseline + reconciliation timer.
- `packages/editor-sdk/src/conflict-surface.tsx` (modify) — optional destructive "Load latest field" action + reworded copy.
- `packages/editor-sdk/test/mounted.test.tsx` (modify) — dirty-signal + conflict-action tests.
- `templates/frontend-astro/package.json` (modify) — add SDK + richtext + tiptap deps.
- `templates/frontend-astro/src/pages/api/content/[id]/richtext.ts` (new) — the save/read endpoint.
- `templates/frontend-astro/src/pages/api/content/[id]/richtext.test.ts` (new) — endpoint unit tests.
- `templates/frontend-astro/src/components/content/RichTextFieldsIsland.tsx` (new) — coordinator island.
- `templates/frontend-astro/src/components/content/RichTextFieldsIsland.test.tsx` (new) — island unit test.
- `templates/frontend-astro/src/pages/content/[id].astro` (modify) — mount the island for richtext fields.
- `templates/frontend-astro/tests/mock/graphql-mock.mjs` (modify) — stateful `updateContent` + a richtext-primary fixture + a `/counts` read-counter.
- `templates/frontend-astro/tests/e2e/content.spec.ts` (modify) — two-editor + two-field + dirty-guard tests.

---

## Task 1: SDK dirty signal (`onDirtyChange`)

**Files:**
- Modify: `packages/editor-sdk/src/editor.tsx`
- Test: `packages/editor-sdk/test/mounted.test.tsx`

**Interfaces:**
- Produces: `MovpEditorProps.onDirtyChange?(dirty: boolean): void` — `false` at mount/`initialBody` change/successful save; `true` immediately on the first `docChanged` edit; back to `false` only after a 150 ms reconciliation encode matches the baseline.

- [ ] **Step 1: Write the failing test** — add to `packages/editor-sdk/test/mounted.test.tsx` (uses fake timers):

```tsx
import { act } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
// ...existing imports...

describe('MovpEditor dirty signal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is clean at mount, dirty immediately on edit, clean after undo-to-baseline reconciles', async () => {
    const onDirtyChange = vi.fn()
    render(<MovpEditor initialBody={BODY_A} onSave={vi.fn()} onRefresh={vi.fn()} onDirtyChange={onDirtyChange} />)
    await vi.waitFor(() => expect(screen.getByRole('textbox', { name: 'Rich text editor' })).toBeTruthy())
    onDirtyChange.mockClear()

    // simulate a doc-changing edit
    act(() => { document.execCommand?.('insertText', false, 'x') })
    // NOTE: prefer driving via the TipTap editor instance the component exposes to tests; see impl note.
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)   // immediate, before the reconciliation timer

    act(() => { vi.advanceTimersByTime(150) })             // reconciliation encode runs once
    // still dirty because content differs from baseline:
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })
})
```

> **Implementer note:** the exact edit-driving mechanism depends on how the mounted tests already exercise TipTap (they render a real `EditorContent`). Use the same approach the existing `mounted.test.tsx` uses to change the document (e.g. `fireEvent.input` on the `.ProseMirror` element, or a test-only ref). The assertions that matter: `onDirtyChange(true)` fires immediately on a `docChanged` edit; a non-doc-changing transaction does NOT call `onDirtyChange`; a successful save calls `onDirtyChange(false)`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/mounted.test.tsx`
Expected: FAIL — `onDirtyChange` is not a prop yet; never called.

- [ ] **Step 3: Implement in `packages/editor-sdk/src/editor.tsx`.** Add `onDirtyChange?` to `MovpEditorProps`, and wire the baseline + `docChanged`-gated + 150 ms reconciliation logic:

```tsx
export interface MovpEditorProps {
  initialBody: string
  onSave: SaveHandler
  onSaved?(revisionId: string): void
  onRefresh(): void
  onLoadLatest?(): void        // Task 2
  onDirtyChange?(dirty: boolean): void
  readOnly?: boolean
}
```

Inside `MovpEditor`, add a baseline ref, a dirty ref, and a reconciliation timer. Set the baseline whenever content is (re)loaded, and emit dirty transitions from the TipTap `onUpdate`:

```tsx
  const baselineRef = useRef<string>('')
  const dirtyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const emitDirty = useCallback((next: boolean) => {
    if (dirtyRef.current === next) return
    dirtyRef.current = next
    try { onDirtyChange?.(next) } catch { /* host callback fault contained */ }
  }, [onDirtyChange])

  const editor = useEditor({
    extensions: [StarterKit],
    editable: !readOnly,
    immediatelyRender: false,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Rich text editor', 'aria-multiline': 'true' },
    },
    onUpdate: ({ transaction }) => {
      if (!transaction.docChanged) return          // selection-only transaction: no encode, no emit
      emitDirty(true)                              // immediate: no unguarded navigation window
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {        // one trailing encode per burst, not per keystroke
        if (!editorRef.current) return
        emitDirty(tipTapAdapter.encode(editorRef.current.getJSON()) !== baselineRef.current)
      }, 150)
    },
  })
  const editorRef = useRef(editor)
  editorRef.current = editor
```

Set the baseline (and clear dirty) in the load effect and after a successful save; cancel the timer on unmount:

```tsx
  useEffect(() => {
    if (!editor) return
    if (timerRef.current) clearTimeout(timerRef.current)
    editor.commands.setContent(tipTapAdapter.decode(initialBody), false) // false = do NOT emit onUpdate
    baselineRef.current = tipTapAdapter.encode(editor.getJSON())
    emitDirty(false)
    setStatus('idle')
  }, [editor, initialBody])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
```

In the existing `save` callback, on a `saved` result set the baseline to the submitted body and clear dirty (place AFTER `setStatus`, alongside the F5-contained `onSaved`):

```tsx
    if (result.status === 'saved') {
      baselineRef.current = tipTapAdapter.encode(editor.getJSON())
      emitDirty(false)
      try { onSaved?.(result.revisionId) } catch { /* contained */ }
    }
```

> **Gotcha:** `setContent(doc, false)` — the second arg `false` suppresses the `onUpdate` emit, so a programmatic load/`initialBody` change never flashes `dirty:true` (spec §6.1). Set the baseline in the SAME effect immediately after.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @movp/editor-sdk test`
Expected: PASS — dirty tests green; existing mounted/save/boundary tests still green.
Run: `pnpm --filter @movp/editor-sdk typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/editor-sdk/src/editor.tsx packages/editor-sdk/test/mounted.test.tsx
git commit -m "feat(editor-sdk): docChanged-gated onDirtyChange with trailing reconciliation"
```

---

## Task 2: SDK non-destructive conflict actions

**Files:**
- Modify: `packages/editor-sdk/src/conflict-surface.tsx`, `packages/editor-sdk/src/editor.tsx`
- Test: `packages/editor-sdk/test/mounted.test.tsx`, `packages/editor-sdk/test/presentational.test.tsx`

**Interfaces:**
- Consumes: `onRefresh()` (re-sync revision, keep draft), `onLoadLatest?()` (Task 1 prop).
- Produces: `ConflictSurface` renders a destructive "Load latest field" button only when `onLoadLatest` is provided; `onRefresh` no longer implies a content reload.

- [ ] **Step 1: Write the failing test** — add to `packages/editor-sdk/test/mounted.test.tsx`:

```tsx
it('conflict keeps the draft and offers refresh + load-latest without replacing content', async () => {
  const onSave = vi.fn().mockResolvedValue({ status: 'conflict' })
  const onRefresh = vi.fn()
  const onLoadLatest = vi.fn()
  render(<MovpEditor initialBody={BODY_A} onSave={onSave} onRefresh={onRefresh} onLoadLatest={onLoadLatest} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))
  await screen.findByRole('alert')
  // draft (alpha) is still present — conflict did NOT reload:
  expect(document.body.textContent).toContain('alpha')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh revision' }))
  expect(onRefresh).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).toContain('alpha')            // refresh did not replace the draft
  fireEvent.click(screen.getByRole('button', { name: 'Load latest field and discard my changes' }))
  expect(onLoadLatest).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/mounted.test.tsx`
Expected: FAIL — button labels "Refresh revision"/"Load latest field…" do not exist yet.

- [ ] **Step 3: Implement.** Replace `packages/editor-sdk/src/conflict-surface.tsx`:

```tsx
export function ConflictSurface({ onRefresh, onLoadLatest }: { onRefresh(): void; onLoadLatest?(): void }) {
  return (
    <div role="alert">
      <p>
        This field changed since you opened it. Refresh revision, then Save to keep your version (other
        fields keep their latest). Or load the latest version to discard your changes.
      </p>
      <button type="button" aria-label="Refresh revision" onClick={onRefresh}>Refresh revision</button>
      {onLoadLatest && (
        <button type="button" aria-label="Load latest field and discard my changes" onClick={onLoadLatest}>
          Load latest field
        </button>
      )}
    </div>
  )
}
```

In `editor.tsx`, pass `onLoadLatest` through to the rendered `ConflictSurface`:

```tsx
      {status === 'conflict' && <ConflictSurface onRefresh={onRefresh} onLoadLatest={onLoadLatest} />}
```

> **Invariant (spec §5):** the editor document equals the user's draft while `status==='conflict'` until the host calls `onLoadLatest` (which changes `initialBody` → `setContent`). `onRefresh` only re-syncs the host's revision; it must not change `initialBody`. A retry Save is available directly from the conflict state (the Save button is only disabled while `status==='saving'`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @movp/editor-sdk test`
Expected: PASS — new conflict-action test + existing tests green (update the existing `presentational.test.tsx` ConflictSurface assertion, which expects the old "Refresh and reload latest content" label, to the new "Refresh revision" label).
Run: `pnpm --filter @movp/editor-sdk typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/editor-sdk/src/conflict-surface.tsx packages/editor-sdk/src/editor.tsx packages/editor-sdk/test
git commit -m "feat(editor-sdk): non-destructive conflict surface (refresh revision + load latest)"
```

---

## Task 3: Frontend dependencies

**Files:** Modify `templates/frontend-astro/package.json`

- [ ] **Step 1: Add dependencies.** In `templates/frontend-astro/package.json` `dependencies`, add (the tiptap deps are the SDK's own deps but the template installs from published tarballs in the Verdaccio gate, so pin the same versions the SDK pins):

```json
    "@movp/editor-sdk": "workspace:*",
    "@movp/richtext": "workspace:*",
    "@tiptap/core": "2.27.2",
    "@tiptap/react": "2.27.2",
    "@tiptap/pm": "2.27.2",
    "@tiptap/starter-kit": "2.27.2"
```

Run: `pnpm install`
Expected: resolves with no lockfile error.

- [ ] **Step 2: Verify the boundary still passes** (nothing imported yet, but confirm the template builds):

Run: `pnpm --filter @movp/frontend-astro build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add templates/frontend-astro/package.json pnpm-lock.yaml
git commit -m "chore(frontend): depend on @movp/editor-sdk and @movp/richtext"
```

---

## Task 4: Rich-text save/read endpoint

**Files:**
- Create: `templates/frontend-astro/src/pages/api/content/[id]/richtext.ts`, `templates/frontend-astro/src/pages/api/content/[id]/richtext.test.ts`

**Interfaces:**
- Consumes: `isDocShape` (`@movp/richtext`), `gqlRequest`, `CONTENT_ITEM_QUERY`, `UPDATE_CONTENT_MUTATION`, `getSessionToken`, `readServerEnv`.
- Produces: `POST` → `{status:'saved',revisionId}` (200) | `{status:'conflict'}` (409) | `{status:'error',code}` (413/422/401/404/500). `GET ?fieldKey=` → `{body,revisionId}`.

- [ ] **Step 1: Write the failing test** `templates/frontend-astro/src/pages/api/content/[id]/richtext.test.ts`. Test the pure helpers by importing the module and exercising `POST` with a stub `gqlRequest` is heavy; instead unit-test the two exported pure helpers `boundedText` and `classifyOutcome` (extract them from the route), plus a light integration via a fake `fetch`. Minimal load-bearing cases:

```ts
import { describe, expect, it } from 'vitest'
import { boundedText, classifyOutcome } from './richtext.ts'

describe('boundedText', () => {
  it('returns null when the stream exceeds the cap', async () => {
    const big = new Request('http://x', { method: 'POST', body: 'x'.repeat(300_000) })
    expect(await boundedText(big, 262_144)).toBeNull()
  })
  it('returns the decoded body under the cap', async () => {
    const r = new Request('http://x', { method: 'POST', body: '{"a":1}' })
    expect(await boundedText(r, 262_144)).toBe('{"a":1}')
  })
})

describe('classifyOutcome', () => {
  it('maps a content_update_conflict gql failure to conflict/409', () => {
    expect(classifyOutcome({ ok: false, code: 'graphql_error', message: 'x content_update_conflict' }))
      .toEqual({ outcome: 'conflict', status: 409, body: { status: 'conflict' } })
  })
  it('maps auth_error to 401', () => {
    expect(classifyOutcome({ ok: false, code: 'auth_error' }).status).toBe(401)
  })
  it('maps any other gql failure to 500 save_failed (no message leak)', () => {
    const out = classifyOutcome({ ok: false, code: 'graphql_error', message: 'secret 10.0.0.1' })
    expect(out).toEqual({ outcome: 'error', status: 500, body: { status: 'error', code: 'save_failed' } })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @movp/frontend-astro exec vitest run src/pages/api/content/[id]/richtext.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route** `templates/frontend-astro/src/pages/api/content/[id]/richtext.ts`:

```ts
import type { APIRoute } from 'astro'
import { isDocShape } from '@movp/richtext'
import { readServerEnv } from '../../../../lib/env.ts'
import { getSessionToken } from '../../../../lib/session.ts'
import { gqlRequest, type GqlResult } from '../../../../lib/graphql.ts'
import { CONTENT_ITEM_QUERY, UPDATE_CONTENT_MUTATION } from '../../../../lib/content-queries.ts'

export const MAX_BODY_BYTES = 262_144
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type OutcomeRow = { outcome: string; status: number; body: Record<string, unknown> }

/** Read the request stream with a hard byte cap BEFORE buffering. Returns null if over the cap. */
export async function boundedText(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { await reader.cancel(); return null }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { merged.set(c, at); at += c.byteLength }
  return new TextDecoder().decode(merged)
}

/** Map a failed gqlRequest to the authoritative outcome row (spec §7). */
export function classifyOutcome(r: Extract<GqlResult<unknown>, { ok: false }>): OutcomeRow {
  if (r.code === 'auth_error') return { outcome: 'unauthorized', status: 401, body: { status: 'error', code: 'auth_error' } }
  if ((r.message ?? '').includes('content_update_conflict')) return { outcome: 'conflict', status: 409, body: { status: 'conflict' } }
  return { outcome: 'error', status: 500, body: { status: 'error', code: 'save_failed' } }
}

function emit(row: { outcome: string; itemId?: string; fieldKey?: string; startedAt: number }) {
  console.log(JSON.stringify({
    event: 'content.richtext_save', outcome: row.outcome, item_id: row.itemId, field_key: row.fieldKey,
    request_id: crypto.randomUUID(), latency_ms: Date.now() - row.startedAt,
  }))
}

type FieldDef = { name: string; type?: string }

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const startedAt = Date.now()
  const id = String(params.id ?? '')
  const token = getSessionToken(cookies)
  if (!token) { emit({ outcome: 'unauthorized', startedAt }); return Response.json({ status: 'error', code: 'auth_error' }, { status: 401 }) }

  const raw = await boundedText(request, MAX_BODY_BYTES)
  if (raw === null) { emit({ outcome: 'too_large', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'body_too_large' }, { status: 413 }) }

  let input: { fieldKey?: unknown; body?: unknown; expectedRevisionId?: unknown }
  try { input = JSON.parse(raw || '{}') } catch { input = {} }
  const fieldKey = typeof input.fieldKey === 'string' ? input.fieldKey : ''
  const body = typeof input.body === 'string' ? input.body : ''
  const expectedRevisionId = typeof input.expectedRevisionId === 'string' ? input.expectedRevisionId : ''
  const invalid = !UUID.test(id) || !UUID.test(expectedRevisionId) || !fieldKey || fieldKey.length > 256
  let parsedBody: unknown
  try { parsedBody = JSON.parse(body) } catch { parsedBody = undefined }
  if (invalid || !isDocShape(parsedBody)) { emit({ outcome: 'validation', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'invalid_request' }, { status: 422 }) }

  const { graphqlEndpoint } = readServerEnv()
  const read = await gqlRequest<{ contentItem: { data?: string | null; current_revision_id?: string | null; content_type: { field_schema: string | null } } | null }>(
    { endpoint: graphqlEndpoint, token }, CONTENT_ITEM_QUERY, { id },
  )
  if (!read.ok) { const o = classifyOutcome(read); emit({ outcome: o.outcome, itemId: id, startedAt }); return Response.json(o.body, { status: o.status }) }
  const itemNode = read.data.contentItem
  if (!itemNode) { emit({ outcome: 'not_found', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'not_found' }, { status: 404 }) }

  const schema = JSON.parse(itemNode.content_type.field_schema ?? '[]') as FieldDef[]
  if (!schema.some((f) => f.name === fieldKey && f.type === 'richtext')) {
    emit({ outcome: 'validation', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'invalid_request' }, { status: 422 })
  }

  const current = JSON.parse(itemNode.data ?? '{}') as Record<string, unknown>
  const merged = { ...current, [fieldKey]: body }   // body sent unchanged; domain prepare() canonicalizes once
  const write = await gqlRequest<{ updateContent: { id: string; status: string; current_revision_id: string } }>(
    { endpoint: graphqlEndpoint, token }, UPDATE_CONTENT_MUTATION, { id, data: JSON.stringify(merged), expectedRevisionId },
  )
  if (!write.ok) { const o = classifyOutcome(write); emit({ outcome: o.outcome, itemId: id, fieldKey, startedAt }); return Response.json(o.body, { status: o.status }) }
  emit({ outcome: 'saved', itemId: id, fieldKey, startedAt })
  return Response.json({ status: 'saved', revisionId: write.data.updateContent.current_revision_id }, { status: 200 })
}

export const GET: APIRoute = async ({ params, request, cookies }) => {
  const startedAt = Date.now()
  const id = String(params.id ?? '')
  const fieldKey = new URL(request.url).searchParams.get('fieldKey') ?? ''
  const token = getSessionToken(cookies)
  if (!token) { emit({ outcome: 'unauthorized', startedAt }); return Response.json({ status: 'error', code: 'auth_error' }, { status: 401 }) }
  if (!UUID.test(id) || !fieldKey) { emit({ outcome: 'validation', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'invalid_request' }, { status: 422 }) }
  const { graphqlEndpoint } = readServerEnv()
  const read = await gqlRequest<{ contentItem: { data?: string | null; current_revision_id?: string | null; content_type: { field_schema: string | null } } | null }>(
    { endpoint: graphqlEndpoint, token }, CONTENT_ITEM_QUERY, { id },
  )
  if (!read.ok) { const o = classifyOutcome(read); emit({ outcome: o.outcome, itemId: id, startedAt }); return Response.json(o.body, { status: o.status }) }
  const itemNode = read.data.contentItem
  if (!itemNode) { emit({ outcome: 'not_found', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'not_found' }, { status: 404 }) }
  const schema = JSON.parse(itemNode.content_type.field_schema ?? '[]') as FieldDef[]
  if (!schema.some((f) => f.name === fieldKey && f.type === 'richtext')) {
    emit({ outcome: 'validation', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'invalid_request' }, { status: 422 })
  }
  const data = JSON.parse(itemNode.data ?? '{}') as Record<string, string>
  emit({ outcome: 'saved', itemId: id, fieldKey, startedAt })   // read-ok reuses 'saved'-shaped success; latency logged
  return Response.json({ body: data[fieldKey] ?? '', revisionId: itemNode.current_revision_id ?? '' }, { status: 200 })
}
```

> **Gotcha (workerd):** `readServerEnv()` reads `cloudflare:workers` env at call time — never `process.env`. `crypto.randomUUID()` is available on workerd. Do not capture env or a client at module scope.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @movp/frontend-astro exec vitest run "src/pages/api/content/[id]/richtext.test.ts"`
Expected: PASS.
Run: `pnpm --filter @movp/frontend-astro build`
Expected: PASS (route typechecks in the worker build).

- [ ] **Step 5: Commit**

```bash
git add "templates/frontend-astro/src/pages/api/content/[id]/richtext.ts" "templates/frontend-astro/src/pages/api/content/[id]/richtext.test.ts"
git commit -m "feat(frontend): bounded, observable richtext save/read endpoint"
```

---

## Task 5: Stateful mock + richtext-primary fixture

**Files:** Modify `templates/frontend-astro/tests/mock/graphql-mock.mjs`

- [ ] **Step 1: Add a richtext-primary content type + item to the seed.** After the existing `contentTypes`/`contentItems`/`contentRevisions` (~`graphql-mock.mjs:145-180`), add a second content type whose primary field is `richtext`, and a matching item + revision, so the two-editor e2e has a clean conflict signal AND a two-richtext-field case:

```js
// C7.3b: a richtext-primary type (two richtext fields) for the conflict/coordinator e2e.
contentTypes.push({
  id: 'ct-rt', key: 'note', label: 'Note',
  field_schema: JSON.stringify([
    { name: 'body', type: 'richtext', label: 'Body' },
    { name: 'summary', type: 'richtext', label: 'Summary' },
  ]),
})
let rtRevSeq = 1
const rtItem = {
  id: 'rt1', slug: 'note-1', status: 'draft', content_type_id: 'ct-rt',
  data: JSON.stringify({ body: '', summary: '' }),
  current_revision_id: 'rt-rev-1', approved_revision_id: null, published_revision_id: null,
  updated_at: '2026-07-02T00:00:00Z', content_type: contentTypes[contentTypes.length - 1],
}
contentItems.push(rtItem)
contentRevisions.push({ id: 'rt-rev-1', parent_id: null, revision_number: 1, data: rtItem.data, author_id: 'u1', created_at: '2026-07-01T00:00:00Z' })
```

- [ ] **Step 2: Make `updateContent` stateful** for the richtext item (replace the `mutation UpdateContent` branch at `graphql-mock.mjs:440-449`). Keep the scenario-driven conflict for the legacy `ci1` path; add real revision tracking for `rt1`:

```js
  if (query.includes('mutation UpdateContent')) {
    const vid = parsed.variables?.id
    const item = contentItems.find((i) => i.id === vid)
    // Legacy scenario-driven conflict for the existing ci1 test:
    if (scenario === 'conflict' && vid === 'ci1') {
      return json(res, 200, { errors: [{ message: 'domain.content.update failed [40001] content_update_conflict' }] })
    }
    if (item && item.content_type_id === 'ct-rt') {
      const expected = parsed.variables?.expectedRevisionId
      const submitted = JSON.parse(parsed.variables?.data ?? '{}')
      const submittedHash = JSON.stringify(submitted)
      // hash-first idempotency: identical payload returns current revision even if expected is stale.
      const currentRev = contentRevisions.find((r) => r.id === item.current_revision_id)
      if (currentRev && currentRev.data === submittedHash) {
        return json(res, 200, { data: { updateContent: { id: vid, status: item.status, current_revision_id: item.current_revision_id } } })
      }
      if (expected && expected !== item.current_revision_id) {
        return json(res, 200, { errors: [{ message: 'domain.content.update failed [40001] content_update_conflict' }] })
      }
      rtRevSeq += 1
      const newRev = { id: `rt-rev-${rtRevSeq}`, parent_id: item.current_revision_id, revision_number: rtRevSeq, data: submittedHash, author_id: 'u1', created_at: '2026-07-02T00:00:00Z' }
      contentRevisions.push(newRev)
      item.current_revision_id = newRev.id
      item.data = submittedHash
      return json(res, 200, { data: { updateContent: { id: vid, status: item.status, current_revision_id: newRev.id } } })
    }
    // ...preserve the existing ci1 validation + success branch below unchanged...
    const data = JSON.parse(parsed.variables?.data ?? '{}')
    if (typeof data.priority !== 'number' || typeof data.featured !== 'boolean' || !['news', 'guide'].includes(data.category) || !data.hero) {
      return json(res, 200, { errors: [{ message: 'invalid content data' }] })
    }
    return json(res, 200, { data: { updateContent: { id: vid, status: 'draft' } } })
  }
```

- [ ] **Step 3: Add a `/counts` endpoint + `ContentItem` read counter** so the endpoint's "one combined read" is provable. In the `ContentItem` query handler (`graphql-mock.mjs:417-419`) add `bump(token, 'contentItemRead')` before returning; and add near the `/scenario` handler:

```js
  if (url.pathname === '/counts') {
    const t = url.searchParams.get('token') ?? 'fallback'
    return json(res, 200, counts.get(t) ?? {})
  }
```
Also reset per-item revision state per test: on the `/scenario` reset, restore `rt1` to `rt-rev-1`/empty and `rtRevSeq = 1`.

- [ ] **Step 4: Verify the mock boots**

Run: `node templates/frontend-astro/tests/mock/graphql-mock.mjs 4399 &` then `curl -s localhost:4399/health` (or the health route the config uses); stop it after.
Expected: server starts; `/scenario` and `/counts` respond.

- [ ] **Step 5: Commit**

```bash
git add templates/frontend-astro/tests/mock/graphql-mock.mjs
git commit -m "test(frontend): stateful mock updateContent + richtext-primary fixture + read counter"
```

---

## Task 6: `RichTextFieldsIsland` coordinator

**Files:**
- Create: `templates/frontend-astro/src/components/content/RichTextFieldsIsland.tsx`, `templates/frontend-astro/src/components/content/RichTextFieldsIsland.test.tsx`

**Interfaces:**
- Consumes: `MovpEditor` (`@movp/editor-sdk`), `normalizeToCanonicalDoc` (`@movp/richtext`).
- Produces: default export `RichTextFieldsIsland({ itemId, fields, initialRevisionId })` where `fields: { key: string; label: string; body: string }[]`.

- [ ] **Step 1: Write the failing test** `RichTextFieldsIsland.test.tsx` (jsdom):

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RichTextFieldsIsland from './RichTextFieldsIsland.tsx'

afterEach(cleanup)

describe('RichTextFieldsIsland', () => {
  it('hydrates and renders one editor per richtext field', async () => {
    render(<RichTextFieldsIsland itemId="rt1" initialRevisionId="rt-rev-1"
      fields={[{ key: 'body', label: 'Body', body: '' }, { key: 'summary', label: 'Summary', body: '' }]} />)
    await waitFor(() => expect(screen.getByTestId('richtext-island').getAttribute('data-ready')).toBe('true'))
    expect(screen.getAllByRole('textbox', { name: 'Rich text editor' }).length).toBe(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @movp/frontend-astro exec vitest run src/components/content/RichTextFieldsIsland.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `templates/frontend-astro/src/components/content/RichTextFieldsIsland.tsx` (client-safe: only `@movp/editor-sdk` + `@movp/richtext` + react):

```tsx
import { useEffect, useRef, useState } from 'react'
import { MovpEditor } from '@movp/editor-sdk'
import { normalizeToCanonicalDoc } from '@movp/richtext'

type Field = { key: string; label: string; body: string }

export default function RichTextFieldsIsland(
  { itemId, fields, initialRevisionId }: { itemId: string; fields: Field[]; initialRevisionId: string },
) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => { setHydrated(true) }, [])

  // One shared, authoritative revision across sibling editors (spec §6).
  const revisionRef = useRef(initialRevisionId)
  const dirty = useRef<Set<string>>(new Set())

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => { if (dirty.current.size > 0) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  return (
    <div data-testid="richtext-island" data-ready={hydrated ? 'true' : 'false'}>
      {fields.map((f) => (
        <RichTextField key={f.key} itemId={itemId} field={f} revisionRef={revisionRef} dirty={dirty} />
      ))}
    </div>
  )
}

function RichTextField(
  { itemId, field, revisionRef, dirty }:
  { itemId: string; field: Field; revisionRef: { current: string }; dirty: { current: Set<string> } },
) {
  const [initialBody, setInitialBody] = useState(() => normalizeToCanonicalDoc(field.body))

  const onSave = async (body: string) => {
    const res = await fetch(`/api/content/${itemId}/richtext`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fieldKey: field.key, body, expectedRevisionId: revisionRef.current }),
    })
    if (res.status === 200) { const j = (await res.json()) as { revisionId: string }; return { status: 'saved' as const, revisionId: j.revisionId } }
    if (res.status === 409) return { status: 'conflict' as const }
    return { status: 'error' as const, code: 'save_failed' as const }
  }
  const onSaved = (revisionId: string) => { revisionRef.current = revisionId }
  const onRefresh = () => {
    // Re-sync the shared revision WITHOUT touching the draft (spec §5).
    void fetch(`/api/content/${itemId}/richtext?fieldKey=${encodeURIComponent(field.key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { revisionId: string } | null) => { if (j) revisionRef.current = j.revisionId })
  }
  const onLoadLatest = () => {
    void fetch(`/api/content/${itemId}/richtext?fieldKey=${encodeURIComponent(field.key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { body: string; revisionId: string } | null) => {
        if (!j) return
        revisionRef.current = j.revisionId
        setInitialBody(normalizeToCanonicalDoc(j.body))   // changes initialBody -> SDK setContent (destructive)
      })
  }
  const onDirtyChange = (d: boolean) => { if (d) dirty.current.add(field.key); else dirty.current.delete(field.key) }

  return (
    <section aria-label={field.label}>
      <MovpEditor initialBody={initialBody} onSave={onSave} onSaved={onSaved}
        onRefresh={onRefresh} onLoadLatest={onLoadLatest} onDirtyChange={onDirtyChange} />
    </section>
  )
}
```

- [ ] **Step 4: Run to verify it passes + boundary clean**

Run: `pnpm --filter @movp/frontend-astro exec vitest run src/components/content/RichTextFieldsIsland.test.tsx`
Expected: PASS.
Run: `bash scripts/check-boundary.sh`
Expected: `boundary: clean` — the island imports only `@movp/editor-sdk`/`@movp/richtext`/react, none of the forbidden set.

- [ ] **Step 5: Commit**

```bash
git add templates/frontend-astro/src/components/content/RichTextFieldsIsland.tsx templates/frontend-astro/src/components/content/RichTextFieldsIsland.test.tsx
git commit -m "feat(frontend): RichTextFieldsIsland coordinator over a shared revision"
```

---

## Task 7: Mount the island on the editor page

**Files:** Modify `templates/frontend-astro/src/pages/content/[id].astro`

- [ ] **Step 1: Import the island** at the top of the frontmatter:
```astro
import RichTextFieldsIsland from '../../components/content/RichTextFieldsIsland.tsx'
```

- [ ] **Step 2: Render the island for richtext fields and drop them from the textarea branch.** In the field-render loop (`content/[id].astro:327-361`), change the `type === 'richtext'` textarea branch so richtext fields are no longer rendered as form textareas (they leave the form POST). Before the `<form method="post">` (or at the top of the fields section), render one island for ALL richtext fields:

```astro
        {fields.some((field) => (field.type ?? 'text') === 'richtext') && (
          <RichTextFieldsIsland client:load itemId={id} initialRevisionId={item.current_revision_id ?? ''}
            fields={fields.filter((field) => (field.type ?? 'text') === 'richtext').map((field) => ({
              key: keyFor(field), label: labelFor(field), body: String(values[keyFor(field)] ?? ''),
            }))} />
        )}
```
In the existing `.map(...)` field loop, filter richtext out of the form (add `(field.type ?? 'text') !== 'richtext'` to the existing `.filter(...)` at `:327`), so those fields are handled only by the island.

> **Page rule (spec §6/D5):** the form save still full-page-reloads on success, re-mounting the island at the fresh revision; document the "save rich-text before a form save" behavior in a short comment above the island. The island's `beforeunload` guard protects unsaved rich-text edits.

- [ ] **Step 3: Verify build + existing content e2e still pass** (the `ci1` legacy test uses non-richtext fields and is unaffected):

Run: `pnpm --filter @movp/frontend-astro build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "templates/frontend-astro/src/pages/content/[id].astro"
git commit -m "feat(frontend): mount RichTextFieldsIsland on the content editor page"
```

---

## Task 8: Two-editor conflict + two-field + dirty-guard e2e

**Files:** Modify `templates/frontend-astro/tests/e2e/content.spec.ts`

**Interfaces:**
- Consumes: `seedSession`, `scenario` (`tests/e2e/scenario.ts`); the `rt1` fixture (Task 5).

- [ ] **Step 1: Write the failing tests** — add to `templates/frontend-astro/tests/e2e/content.spec.ts`:

```ts
test('two editors: the stale second save conflicts, keeps the draft, refresh+resave preserves other field', async ({ browser }) => {
  const ctxA = await browser.newContext(); const ctxB = await browser.newContext()
  await seedSession(ctxA); await seedSession(ctxB)
  const a = await ctxA.newPage(); const b = await ctxB.newPage()
  await a.goto('/content/rt1'); await b.goto('/content/rt1')
  await Promise.all([
    a.getByTestId('richtext-island').waitFor(), b.getByTestId('richtext-island').waitFor(),
  ])
  // A edits the Body field and saves -> revision advances.
  const aBody = a.getByRole('region', { name: 'Body' }).getByRole('textbox', { name: 'Rich text editor' })
  await aBody.click(); await aBody.pressSequentially('alpha edit')
  await a.getByRole('region', { name: 'Body' }).getByRole('button', { name: 'Save content' }).click()
  await a.getByRole('region', { name: 'Body' }).getByRole('status').waitFor()
  // B (opened at the old revision) edits + saves -> conflict, draft preserved.
  const bBody = b.getByRole('region', { name: 'Body' }).getByRole('textbox', { name: 'Rich text editor' })
  await bBody.click(); await bBody.pressSequentially('bravo edit')
  await b.getByRole('region', { name: 'Body' }).getByRole('button', { name: 'Save content' }).click()
  await b.getByRole('region', { name: 'Body' }).getByRole('alert').waitFor()
  await expect(b.getByRole('region', { name: 'Body' })).toContainText('bravo edit')   // draft preserved
  // B refreshes the revision (draft stays) then re-saves successfully.
  await b.getByRole('button', { name: 'Refresh revision' }).click()
  await expect(b.getByRole('region', { name: 'Body' })).toContainText('bravo edit')
  await b.getByRole('region', { name: 'Body' }).getByRole('button', { name: 'Save content' }).click()
  await b.getByRole('region', { name: 'Body' }).getByRole('status').waitFor()
  await ctxA.close(); await ctxB.close()
})

test('two richtext fields save sequentially in one session without a self-conflict', async ({ page }) => {
  await page.goto('/content/rt1')
  await page.getByTestId('richtext-island').waitFor()
  for (const name of ['Body', 'Summary']) {
    const region = page.getByRole('region', { name })
    await region.getByRole('textbox', { name: 'Rich text editor' }).click()
    await region.getByRole('textbox', { name: 'Rich text editor' }).pressSequentially(`${name} text`)
    await region.getByRole('button', { name: 'Save content' }).click()
    await region.getByRole('status').waitFor()
    await expect(region.getByRole('alert')).toHaveCount(0)   // no conflict
  }
})

test('beforeunload guards an unsaved richtext edit', async ({ page }) => {
  await page.goto('/content/rt1')
  await page.getByTestId('richtext-island').waitFor()
  const body = page.getByRole('region', { name: 'Body' }).getByRole('textbox', { name: 'Rich text editor' })
  await body.click(); await body.pressSequentially('unsaved')
  let dialogSeen = false
  page.once('dialog', (d) => { dialogSeen = d.type() === 'beforeunload'; void d.dismiss() })
  await page.evaluate(() => { window.location.href = '/content' }).catch(() => {})
  // The navigation is blocked; we remain on the item page with the draft intact.
  await expect(page).toHaveURL(/\/content\/rt1$/)
  await expect(page.getByRole('region', { name: 'Body' })).toContainText('unsaved')
})
```

> **Playwright beforeunload note (spec §6.1):** register `page.once('dialog', …)` BEFORE triggering navigation; assert `dialog.type() === 'beforeunload'`; the completed-navigation-or-stay is the assertion bound, not a `waitForTimeout`. If the harness auto-dismisses beforeunload such that the URL still changes, assert instead on the dirty-set via a `data-dirty` attribute the island can expose — decide during execution based on observed Playwright behavior.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @movp/frontend-astro e2e`
Expected: FAIL — island/regions not mounted until Tasks 6–7 are wired (if running out of order) or the two-editor conflict path not yet stateful (if the mock lacks Task 5). When Tasks 5–7 are in, these drive the real flow.

- [ ] **Step 3: Run to verify they pass** (after Tasks 5–7)

Run: `pnpm --filter @movp/frontend-astro e2e`
Expected: PASS — all three new tests + the existing content specs green.

- [ ] **Step 4: Commit**

```bash
git add templates/frontend-astro/tests/e2e/content.spec.ts
git commit -m "test(frontend): two-editor conflict, two-field, and beforeunload e2e"
```

---

## C7.3b completion gate

```bash
pnpm --filter @movp/editor-sdk test          # dirty signal + conflict actions
pnpm --filter @movp/frontend-astro test      # endpoint unit + island unit
pnpm --filter @movp/frontend-astro build
bash scripts/check-boundary.sh               # island stays client-safe
pnpm --filter @movp/frontend-astro e2e       # two-editor + two-field + beforeunload
pnpm typecheck
```
Then update the Stage C EXECUTION STATUS table for C7.3b, and mark **C7.3 complete only when both C7.3a and C7.3b parts and their gates pass** (CLAUDE.md "Phase Completion Signal").

## Known risk / reconciliation item (verify during execution)

- **Production conflict surfacing.** The endpoint (and the existing page) recognize a conflict by the `content_update_conflict` **message substring**. The stateful mock returns that string, so the e2e passes. In production, the GraphQL `updateContent` resolver throws a plain domain `Error`; graphql-yoga's `maskError` may replace the message with a generic masked string, in which case a real cross-user conflict would surface as `save_failed`, not `conflict`. **Verify against the real GraphQL boundary** during execution; if masked, add a small graphql task to map the `updateContent` conflict to a `GraphQLError` carrying `content_update_conflict` (unmasked) so the message-substring contract holds in prod. This is out of the mock-based gate's reach — do not let a green e2e certify the production conflict path.

## Spec coverage self-check (C7.3b scope)

- Non-destructive conflict recovery, refresh-keeps-draft, load-latest destructive, GET-failure keeps state (spec §5) → Tasks 2, 6. ✅
- Coordinator island over one shared revision; client-safe; page rule + beforeunload (spec §6, §6.1) → Tasks 6, 7. ✅
- `onDirtyChange` docChanged-gated + reconciliation (spec §6.1) → Task 1. ✅
- Endpoint: bounds/validation/one-combined-read/outcome table/observability (spec §7) → Task 4. ✅
- Stateful mock + read-counter (spec §8) → Task 5. ✅
- Two-editor + two-field + dirty-guard e2e (spec §8) → Task 8. ✅
- Frontend deps + Verdaccio consumer (spec §3.1 item 4) → Task 3 (+ C7.3a registered the packages in the Verdaccio publish lists). ✅
