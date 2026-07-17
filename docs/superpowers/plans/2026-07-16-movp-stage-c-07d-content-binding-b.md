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

  it('stays dirty when the user edits DURING an in-flight save (F-2 race)', async () => {
    let resolveSave!: (r: { status: 'saved'; revisionId: string }) => void
    const onSave = vi.fn(() => new Promise<{ status: 'saved'; revisionId: string }>((r) => { resolveSave = r }))
    const onDirtyChange = vi.fn()
    render(<MovpEditor initialBody={BODY_A} onSave={onSave} onRefresh={vi.fn()} onDirtyChange={onDirtyChange} />)
    const saveBtn = await screen.findByRole('button', { name: 'Save content' })
    // edit -> dirty, then click Save (captures submittedBody), then edit AGAIN while the promise is pending
    // ...drive edit #1 (same mechanism as the test above)...
    fireEvent.click(saveBtn)
    // ...drive edit #2 while onSave is unresolved...
    onDirtyChange.mockClear()
    act(() => { resolveSave({ status: 'saved', revisionId: 'r1' }) })
    await vi.waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true)) // edits #2 were NOT submitted
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

Rework the `save` callback so the SUBMITTED body — not the post-await live document — becomes the baseline. Capture `submittedBody` BEFORE calling `onSave`; submit exactly that; after a `saved` result set the baseline to it and reconcile against the current document (so edits typed DURING the in-flight save keep the editor dirty):

```tsx
  const save = useCallback(async () => {
    if (!editor || savingRef.current) return
    savingRef.current = true
    setStatus('saving')
    const submittedBody = tipTapAdapter.encode(editor.getJSON())   // capture BEFORE the await
    let result: SaveResult
    try {
      result = await onSave(submittedBody)
    } catch (err) {
      result = classifySaveOutcome(err)
    }
    savingRef.current = false
    setStatus(result.status)
    if (result.status === 'saved') {
      baselineRef.current = submittedBody
      // If the user typed during the in-flight save, the live doc differs from what was submitted:
      // those edits were NOT saved, so remain dirty.
      emitDirty(editorRef.current ? tipTapAdapter.encode(editorRef.current.getJSON()) !== submittedBody : false)
      try { onSaved?.(result.revisionId) } catch { /* contained */ }
    }
  }, [editor, onSave, onSaved, emitDirty])
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

## Task 3G: GraphQL production conflict boundary (execute BEFORE Task 4)

**Why:** production `updateContent` throws a plain domain `Error`; graphql-yoga's `maskError` (via `maskMovpError`, `packages/graphql/src/yoga.ts:11`) replaces it with `"Unexpected error."` and code `INTERNAL_SERVER_ERROR`. The mock returns the real conflict string, so an e2e would pass while production silently degrades a conflict to `save_failed`. The resolver must emit a **sanitized, structured** conflict that survives masking, and the endpoint must classify that **code** (not message text).

**Files:**
- Modify: `packages/graphql/src/schema.ts` (the `updateContent` resolver, `:1518-1530`)
- Modify: `templates/frontend-astro/src/lib/graphql.ts` (surface the first error's extension `code` on the `ok:false` path)
- Modify: `templates/frontend-astro/src/pages/content/[id].astro` (`saveErrorMessage` → code-based)
- Test: `packages/graphql/test/*` (yoga-through test) — match the existing graphql test harness

**Interfaces:**
- Produces: on a content-update conflict, GraphQL responds with an error carrying `extensions.code === 'CONFLICT'` and a sanitized message; `gqlRequest` exposes it as `{ ok: false, code: 'graphql_error', errorCode: 'CONFLICT' }`.

- [ ] **Step 1: Write the failing graphql test** (match the existing `packages/graphql/test` harness that builds the real yoga server). Assert: an `updateContent` that hits `content_update_conflict` returns an error whose `extensions.code === 'CONFLICT'` (and message is NOT the raw domain string), while an unrelated internal error is masked to `"Unexpected error."`.

```ts
// shape (adapt to the existing graphql test harness that POSTs to createYoga(...)):
it('surfaces a content-update conflict as a sanitized CONFLICT, not a masked internal error', async () => {
  // ...drive updateContent so domain.content.update throws '... [content_update_conflict]' ...
  const body = await postGraphql(UPDATE_CONTENT, { id, data, expectedRevisionId: staleId })
  expect(body.errors[0].extensions.code).toBe('CONFLICT')
  expect(body.errors[0].message).not.toContain('content_update_conflict') // sanitized
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @movp/graphql test`
Expected: FAIL — the conflict is currently masked to `INTERNAL_SERVER_ERROR`/`"Unexpected error."`.

- [ ] **Step 3: Map the conflict in the resolver.** `GraphQLError` is already imported in `schema.ts` (used at `:79`). Wrap the `updateContent` resolver (`:1518-1530`) so a domain `content_update_conflict` becomes a sanitized structured error; other errors propagate unchanged (still masked):

```ts
    builder.mutationField('updateContent', (t: any) =>
      t.field({
        type: contentItemRef,
        complexity: 10,
        args: { id: t.arg.id({ required: true }), data: t.arg.string({ required: true }), expectedRevisionId: t.arg.id({ required: false }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          try {
            return await domainFrom(ctx).content.update({
              itemId: String(a.id),
              data: JSON.parse(String(a.data)),
              expectedRevisionId: a.expectedRevisionId ? String(a.expectedRevisionId) : undefined,
            })
          } catch (error) {
            if (error instanceof Error && error.message.includes('content_update_conflict')) {
              throw new GraphQLError('This content was updated by someone else.', { extensions: { code: 'CONFLICT' } })
            }
            throw error   // ordinary errors stay masked by maskMovpError
          }
        },
      }),
    )
```

> **Gotcha:** an intentionally-thrown `GraphQLError` with `extensions` is NOT masked by `maskError` (that is exactly how the admin path at `schema.ts:64-80` surfaces `CONFLICT`). A plain `throw error` remains masked. Do not widen the `catch` to re-wrap non-conflict errors.

- [ ] **Step 4: Surface the extension code in the frontend client.** In `templates/frontend-astro/src/lib/graphql.ts`, add `errorCode?: string` to the `ok:false` variant of `GqlResult`, and populate it from the first field error that carries a code (the parser already extracts `extensions.code` into `GqlFieldError.code`):

```ts
// in the GqlResult union, the failure arm becomes:
  | { ok: false; code: GqlErrorCode; message?: string; errorCode?: string }
// ...and the non-partial error return becomes:
    const message = errors.map((error) => error.message).filter(Boolean).join('; ')
    return { ok: false, code: 'graphql_error', message: message || undefined, errorCode: errors.find((e) => e.code)?.code }
```

Because the resolver now emits a SANITIZED message, the **existing** page's message-substring conflict check would stop matching in prod. Update `saveErrorMessage` in `templates/frontend-astro/src/pages/content/[id].astro:124-130` to classify on the structured code (the mock returns `extensions.code: 'CONFLICT'`, so the existing `ci1` conflict e2e keeps passing):

```ts
function saveErrorMessage(result: { code: string; message?: string; errorCode?: string }): string {
  if (result.errorCode === 'CONFLICT' || (result.message ?? '').includes('content_update_conflict')) {
    return 'This content was changed by someone else. Reload to see the latest, then reapply your edits.'
  }
  return 'Could not save. Try again.'
}
```
> The `|| message.includes(...)` clause is a belt-and-suspenders fallback; the `errorCode` path is authoritative.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @movp/graphql test`
Expected: PASS.
Run: `pnpm --filter @movp/graphql typecheck && pnpm --filter @movp/frontend-astro build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/graphql/src/schema.ts packages/graphql/test templates/frontend-astro/src/lib/graphql.ts "templates/frontend-astro/src/pages/content/[id].astro"
git commit -m "fix(graphql): surface content-update conflict as sanitized CONFLICT code"
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
import { boundedText, classifyOutcome, fieldKeyBytes, parseData, parseSchema } from './richtext.ts'

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

describe('classifyOutcome (code-based, not message-based)', () => {
  it('maps the structured CONFLICT extension code to conflict/409', () => {
    expect(classifyOutcome({ ok: false, code: 'graphql_error', errorCode: 'CONFLICT' }))
      .toEqual({ outcome: 'conflict', status: 409, body: { status: 'conflict' } })
  })
  it('maps auth_error to 401', () => {
    expect(classifyOutcome({ ok: false, code: 'auth_error' }).status).toBe(401)
  })
  it('does NOT infer conflict from message text alone (a masked prod error is 500)', () => {
    const out = classifyOutcome({ ok: false, code: 'graphql_error', message: 'content_update_conflict leaked' })
    expect(out).toEqual({ outcome: 'error', status: 500, body: { status: 'error', code: 'save_failed' } })
  })
})

describe('parseSchema / parseData reject malformed persisted JSON', () => {
  it('parseSchema returns null for non-array / bad elements', () => {
    expect(parseSchema('{}')).toBeNull()
    expect(parseSchema('[{"type":"richtext"}]')).toBeNull()   // missing name
    expect(parseSchema('not json')).toBeNull()
  })
  it('parseData returns null for non-object', () => {
    expect(parseData('[]')).toBeNull()
    expect(parseData('null')).toBeNull()
  })
  it('fieldKeyBytes measures UTF-8 bytes, not UTF-16 units', () => {
    expect(fieldKeyBytes('€')).toBe(3)   // 1 UTF-16 unit, 3 UTF-8 bytes
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

/**
 * Map a failed gqlRequest to the authoritative outcome row (spec §7). Classify conflict by the STRUCTURED
 * extension code the graphql layer emits (Task 3G) — NOT by message text, which prod masking would drop.
 */
export function classifyOutcome(r: { ok: false; code: string; message?: string; errorCode?: string }): OutcomeRow {
  if (r.code === 'auth_error') return { outcome: 'unauthorized', status: 401, body: { status: 'error', code: 'auth_error' } }
  if (r.errorCode === 'CONFLICT') return { outcome: 'conflict', status: 409, body: { status: 'conflict' } }
  return { outcome: 'error', status: 500, body: { status: 'error', code: 'save_failed' } }
}

type FieldDef = { name: string; type?: string }

/** UTF-8 byte length of a string (spec §7 bounds are in bytes, not UTF-16 units). */
export function fieldKeyBytes(s: string): number { return new TextEncoder().encode(s).length }

/** Structurally validate a persisted field_schema. Returns null (→ quarantine, not crash) if malformed. */
export function parseSchema(raw: string | null): FieldDef[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw ?? '[]') } catch { return null }
  if (!Array.isArray(parsed)) return null
  const out: FieldDef[] = []
  for (const f of parsed) {
    if (!f || typeof f !== 'object') return null
    const name = (f as { name?: unknown }).name
    const type = (f as { type?: unknown }).type
    if (typeof name !== 'string') return null
    out.push({ name, type: typeof type === 'string' ? type : undefined })
  }
  return out
}

/** Structurally validate persisted item data. Returns null if not a JSON object. */
export function parseData(raw: string | null): Record<string, unknown> | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw ?? '{}') } catch { return null }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

function emit(row: { outcome: string; itemId?: string; fieldKey?: string; startedAt: number }) {
  console.log(JSON.stringify({
    event: 'content.richtext_save', outcome: row.outcome, item_id: row.itemId, field_key: row.fieldKey,
    request_id: crypto.randomUUID(), latency_ms: Date.now() - row.startedAt,
  }))
}

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
  const invalid = !UUID.test(id) || !UUID.test(expectedRevisionId) || !fieldKey || fieldKeyBytes(fieldKey) > 256
  let parsedBody: unknown
  try { parsedBody = JSON.parse(body) } catch { parsedBody = undefined }
  // Do NOT log the unvalidated fieldKey on a validation reject.
  if (invalid || !isDocShape(parsedBody)) { emit({ outcome: 'validation', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'invalid_request' }, { status: 422 }) }

  const { graphqlEndpoint } = readServerEnv()
  const read = await gqlRequest<{ contentItem: { data?: string | null; current_revision_id?: string | null; content_type: { field_schema: string | null } } | null }>(
    { endpoint: graphqlEndpoint, token }, CONTENT_ITEM_QUERY, { id },
  )
  if (!read.ok) { const o = classifyOutcome(read); emit({ outcome: o.outcome, itemId: id, startedAt }); return Response.json(o.body, { status: o.status }) }
  const itemNode = read.data.contentItem
  if (!itemNode) { emit({ outcome: 'not_found', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'not_found' }, { status: 404 }) }

  // Structurally validate persisted state (untrusted-I/O: quarantine malformed, don't crash) BEFORE use.
  const schema = parseSchema(itemNode.content_type.field_schema)
  const current = parseData(itemNode.data ?? '{}')
  if (!schema || !current) { emit({ outcome: 'error', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'save_failed' }, { status: 500 }) }
  if (!schema.some((f) => f.name === fieldKey && f.type === 'richtext')) {
    // fieldKey did not pass the schema check → still unvalidated → do not log it.
    emit({ outcome: 'validation', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'invalid_request' }, { status: 422 })
  }

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
  const schema = parseSchema(itemNode.content_type.field_schema)
  const data = parseData(itemNode.data ?? '{}')
  if (!schema || !data) { emit({ outcome: 'error', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'save_failed' }, { status: 500 }) }
  if (!schema.some((f) => f.name === fieldKey && f.type === 'richtext')) {
    emit({ outcome: 'validation', itemId: id, startedAt }); return Response.json({ status: 'error', code: 'invalid_request' }, { status: 422 })
  }
  const value = data[fieldKey]
  emit({ outcome: 'read_ok', itemId: id, fieldKey, startedAt })
  return Response.json({ body: typeof value === 'string' ? value : '', revisionId: itemNode.current_revision_id ?? '' }, { status: 200 })
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
      return json(res, 200, { errors: [{ message: 'This content was updated by someone else.', extensions: { code: 'CONFLICT' } }] })
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
        return json(res, 200, { errors: [{ message: 'This content was updated by someone else.', extensions: { code: 'CONFLICT' } }] })
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

  it('does not install a beforeunload guard while clean (spec §6.1)', () => {
    const add = vi.spyOn(window, 'addEventListener')
    render(<RichTextFieldsIsland itemId="rt1" initialRevisionId="rt-rev-1"
      fields={[{ key: 'body', label: 'Body', body: '' }]} />)
    expect(add.mock.calls.some(([type]) => type === 'beforeunload')).toBe(false)
    expect(screen.getByTestId('richtext-island').getAttribute('data-dirty')).toBe('false')
    add.mockRestore()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @movp/frontend-astro exec vitest run src/components/content/RichTextFieldsIsland.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `templates/frontend-astro/src/components/content/RichTextFieldsIsland.tsx` (client-safe: only `@movp/editor-sdk` + `@movp/richtext` + react):

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
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
  const dirtyKeys = useRef<Set<string>>(new Set())
  const handlerRef = useRef<((e: BeforeUnloadEvent) => void) | null>(null)
  const [dirtyCount, setDirtyCount] = useState(0)   // drives data-dirty for a deterministic e2e assertion

  // Install the beforeunload guard ONLY while at least one editor is dirty; remove it when clean (spec §6.1).
  const setFieldDirty = useCallback((key: string, isDirty: boolean) => {
    if (isDirty) dirtyKeys.current.add(key)
    else dirtyKeys.current.delete(key)
    const has = dirtyKeys.current.size > 0
    if (has && !handlerRef.current) {
      const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
      handlerRef.current = h
      window.addEventListener('beforeunload', h)
    } else if (!has && handlerRef.current) {
      window.removeEventListener('beforeunload', handlerRef.current)
      handlerRef.current = null
    }
    setDirtyCount(dirtyKeys.current.size)
  }, [])

  useEffect(() => () => { if (handlerRef.current) window.removeEventListener('beforeunload', handlerRef.current) }, [])

  return (
    <div data-testid="richtext-island" data-ready={hydrated ? 'true' : 'false'} data-dirty={dirtyCount > 0 ? 'true' : 'false'}>
      {fields.map((f) => (
        <RichTextField key={f.key} itemId={itemId} field={f} revisionRef={revisionRef} setFieldDirty={setFieldDirty} />
      ))}
    </div>
  )
}

function RichTextField(
  { itemId, field, revisionRef, setFieldDirty }:
  { itemId: string; field: Field; revisionRef: { current: string }; setFieldDirty: (key: string, isDirty: boolean) => void },
) {
  const [initialBody, setInitialBody] = useState(() => normalizeToCanonicalDoc(field.body))
  const [refreshState, setRefreshState] = useState<'idle' | 'refreshing' | 'ready_to_retry' | 'refresh_error'>('idle')

  const onSave = async (body: string) => {
    const res = await fetch(`/api/content/${itemId}/richtext`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fieldKey: field.key, body, expectedRevisionId: revisionRef.current }),
    })
    if (res.status === 200) { const j = (await res.json()) as { revisionId: string }; return { status: 'saved' as const, revisionId: j.revisionId } }
    if (res.status === 409) return { status: 'conflict' as const }
    return { status: 'error' as const, code: 'save_failed' as const }
  }
  const onSaved = (revisionId: string) => { revisionRef.current = revisionId; setRefreshState('idle') }

  const fetchLatest = async (): Promise<{ body: string; revisionId: string }> => {
    const r = await fetch(`/api/content/${itemId}/richtext?fieldKey=${encodeURIComponent(field.key)}`)
    if (!r.ok) throw new Error('refresh_failed')
    return (await r.json()) as { body: string; revisionId: string }
  }
  const onRefresh = () => {
    // Re-sync the shared revision WITHOUT touching the draft (spec §5). GET-failure keeps draft + conflict.
    setRefreshState('refreshing')
    fetchLatest()
      .then((j) => { revisionRef.current = j.revisionId; setRefreshState('ready_to_retry') })
      .catch(() => setRefreshState('refresh_error'))
  }
  const onLoadLatest = () => {
    setRefreshState('refreshing')
    fetchLatest()
      .then((j) => { revisionRef.current = j.revisionId; setInitialBody(normalizeToCanonicalDoc(j.body)); setRefreshState('idle') })
      .catch(() => setRefreshState('refresh_error'))   // destructive path: only replaces the draft on success
  }
  const onDirtyChange = (d: boolean) => setFieldDirty(field.key, d)

  return (
    <section aria-label={field.label}>
      <MovpEditor initialBody={initialBody} onSave={onSave} onSaved={onSaved}
        onRefresh={onRefresh} onLoadLatest={onLoadLatest} onDirtyChange={onDirtyChange} />
      {refreshState === 'ready_to_retry' && <span role="status">Revision updated — Save to retry.</span>}
      {refreshState === 'refresh_error' && <span role="alert">Could not refresh. Your draft is safe; try again.</span>}
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

- [ ] **Step 3: Verify build + existing content e2e still pass.** Note: `ci1`'s content type ALREADY has a `body` richtext field (`graphql-mock.mjs:151`), so its editor page now ALSO mounts the island (the `body` textarea is removed from the form). The existing `ci1` specs are unaffected because they interact only with the non-richtext form fields (Priority/Featured/Category) and the form Save; the form still merges `body` from the loaded `values`. Confirm those specs stay green:

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
test('two editors on DIFFERENT fields: stale save conflicts, refresh+retry preserves BOTH fields', async ({ browser }) => {
  const ctxA = await browser.newContext(); const ctxB = await browser.newContext()
  await seedSession(ctxA); await seedSession(ctxB)
  const a = await ctxA.newPage(); const b = await ctxB.newPage()
  await a.goto('/content/rt1'); await b.goto('/content/rt1')
  await Promise.all([a.getByTestId('richtext-island').waitFor(), b.getByTestId('richtext-island').waitFor()])

  // A edits SUMMARY and saves -> revision advances, A's summary is persisted.
  const aSummary = a.getByRole('region', { name: 'Summary' }).getByRole('textbox', { name: 'Rich text editor' })
  await aSummary.click(); await aSummary.pressSequentially('alpha summary')
  await a.getByRole('region', { name: 'Summary' }).getByRole('button', { name: 'Save content' }).click()
  await expect(a.getByRole('region', { name: 'Summary' })).toContainText('Saved')

  // B (opened at the OLD revision) edits BODY and saves -> stale expected revision -> conflict, draft kept.
  const bBody = b.getByRole('region', { name: 'Body' }).getByRole('textbox', { name: 'Rich text editor' })
  await bBody.click(); await bBody.pressSequentially('bravo body')
  await b.getByRole('region', { name: 'Body' }).getByRole('button', { name: 'Save content' }).click()
  await b.getByRole('region', { name: 'Body' }).getByRole('alert').waitFor()          // ConflictSurface
  await expect(b.getByRole('region', { name: 'Body' })).toContainText('bravo body')    // draft preserved

  // B refreshes the revision (draft untouched -> ready_to_retry), then re-saves.
  await b.getByRole('button', { name: 'Refresh revision' }).click()
  await expect(b.getByRole('region', { name: 'Body' })).toContainText('Revision updated')
  await expect(b.getByRole('region', { name: 'Body' })).toContainText('bravo body')    // still the draft
  await b.getByRole('region', { name: 'Body' }).getByRole('button', { name: 'Save content' }).click()
  await expect(b.getByRole('region', { name: 'Body' })).toContainText('Saved')

  // Fresh load proves the server-merge kept A's Summary AND B's Body (cross-field preservation).
  const c = await ctxA.newPage(); await c.goto('/content/rt1')
  await c.getByTestId('richtext-island').waitFor()
  await expect(c.getByRole('region', { name: 'Summary' })).toContainText('alpha summary')
  await expect(c.getByRole('region', { name: 'Body' })).toContainText('bravo body')
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

test('editing arms the beforeunload guard; saving disarms it', async ({ page }) => {
  await page.goto('/content/rt1')
  const island = page.getByTestId('richtext-island')
  await island.waitFor()
  await expect(island).toHaveAttribute('data-dirty', 'false')          // clean: no guard installed (spec §6.1)
  const body = page.getByRole('region', { name: 'Body' }).getByRole('textbox', { name: 'Rich text editor' })
  await body.click(); await body.pressSequentially('unsaved')
  await expect(island).toHaveAttribute('data-dirty', 'true')           // deterministic proof the guard is armed
  await page.getByRole('region', { name: 'Body' }).getByRole('button', { name: 'Save content' }).click()
  await expect(page.getByRole('region', { name: 'Body' })).toContainText('Saved')
  await expect(island).toHaveAttribute('data-dirty', 'false')          // disarmed after a successful save
})
```

> **Deterministic dirty/guard proof (spec §6.1, F-5):** the island's `data-dirty` attribute reflects exactly whether the `beforeunload` listener is installed (it is installed iff the dirty-key set is nonempty). Asserting `data-dirty` transitions `false→true→false` deterministically proves the guard arms on edit and disarms on save — without depending on Playwright's non-deterministic native-`beforeunload` dialog handling. This replaces the earlier dialog-interception approach.

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
pnpm --filter @movp/editor-sdk test          # dirty signal (incl. in-flight-edit race) + conflict actions
pnpm --filter @movp/graphql test             # Task 3G: sanitized CONFLICT survives masking
pnpm --filter @movp/frontend-astro test      # endpoint unit (bounds/guards/code-classify) + island unit
pnpm --filter @movp/frontend-astro build
bash scripts/check-boundary.sh               # island stays client-safe
pnpm --filter @movp/frontend-astro e2e       # two-editor cross-field + two-field + beforeunload(data-dirty)
pnpm typecheck
```
Then update the Stage C EXECUTION STATUS table for C7.3b, and mark **C7.3 complete only when both C7.3a and C7.3b parts and their gates pass** (CLAUDE.md "Phase Completion Signal").

## Production conflict surfacing (closed by Task 3G)

The masking risk — a production `updateContent` conflict masked to `save_failed` — is closed by **Task 3G**: the resolver emits a sanitized `GraphQLError` with `extensions.code === 'CONFLICT'`, `gqlRequest` surfaces it as `errorCode`, and BOTH the new endpoint (`classifyOutcome`) and the existing page (`saveErrorMessage`) classify on that **structured code**, not message text. Task 3G's yoga-through test asserts the conflict stays identifiable while ordinary internal errors remain `"Unexpected error."`, and the mock returns the same `CONFLICT` code so the e2e and production classify identically. No message-substring dependency remains on the authoritative path.

## Spec coverage self-check (C7.3b scope)

- Non-destructive conflict recovery, refresh-keeps-draft, load-latest destructive, GET-failure keeps state (spec §5) → Tasks 2, 6. ✅
- Coordinator island over one shared revision; client-safe; page rule + beforeunload (spec §6, §6.1) → Tasks 6, 7. ✅
- `onDirtyChange` docChanged-gated + reconciliation (spec §6.1) → Task 1. ✅
- Endpoint: bounds/validation/one-combined-read/outcome table/observability (spec §7) → Task 4. ✅
- Stateful mock + read-counter (spec §8) → Task 5. ✅
- Two-editor + two-field + dirty-guard e2e (spec §8) → Task 8. ✅
- Frontend deps + Verdaccio consumer (spec §3.1 item 4) → Task 3 (+ C7.3a registered the packages in the Verdaccio publish lists). ✅
- Production conflict surfacing as a structured `CONFLICT` code, not a masked internal error (F-1) → Task 3G. ✅
- Endpoint structural validation of persisted state + UTF-8 byte key length + content-disciplined events (F-4) → Task 4. ✅
- Dirty stays true when the user edits during an in-flight save (F-2) → Task 1. ✅
- Refresh feedback states + caught GET-failure + deterministic guard install/remove (F-5) → Tasks 6, 8. ✅
