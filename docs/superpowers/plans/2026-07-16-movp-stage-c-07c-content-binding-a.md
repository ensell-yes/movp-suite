# C7.3a — Rich-text Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "a `richtext` field is stored as a canonical ProseMirror doc-JSON string" a true, hash-stable invariant enforced in the domain, and fix the `update_content` RPC so an identical retry is idempotent instead of a false conflict.

**Architecture:** Extract the canonical algorithm into a new client-safe leaf package `@movp/richtext` shared by `@movp/editor-sdk` (encode) and `@movp/domain` (normalize-on-write), so the two can never byte-diverge. Domain `prepare()` normalizes richtext before hashing and derives plain search text from the doc. A new forward-only migration reorders the RPC to check the payload hash before the optimistic-lock revision. This is **part a of C7.3** (spec `docs/superpowers/specs/2026-07-16-c7.3-content-binding-design.md` §2.1); it lands and verifies before C7.3b (SDK/frontend binding).

**Tech Stack:** TypeScript (ESM, Node + Deno/workerd), pnpm workspaces, Vitest, Zod, Supabase Postgres + pgTAP, tsup.

## Global Constraints

- New package version is `0.1.0`; no publishable consumer pins `0.0.0` (spec §3.1; `EXPECTED_VERSION` in `scripts/check-publishable-versions.mjs`).
- `@movp/richtext` is **client-safe**: no React, no TipTap, no `@movp/domain`/`@movp/auth`/`@movp/graphql`/`@supabase` imports, no secrets.
- Migrations are **forward-only** from the freeze baseline: never edit/rename `20260701000012_cms_content_rpcs.sql`; add a new timestamped migration (CLAUDE.md "Migration Discipline"; guard `pnpm test:forward-only-migrations`).
- Never hand-edit a `*_movp_generated*.sql` file. This migration is a hand migration, not codegen output.
- The canonical string is the **byte output of `canonicalizeInnerJson`** applied to a valid ProseMirror `doc`; editor-encode and domain-normalize MUST produce identical bytes (shared module).
- `normalizeToCanonicalDoc` contract (spec §3.2): `''`→canonical empty doc; valid doc-JSON→canonicalized; any other string→one escaped-text paragraph; non-string→throws `richtext_value_not_a_string`.
- Every domain-consuming Edge entrypoint needs `@movp/richtext` in its `deno.json` import map; Node typecheck will NOT catch a missing Deno map entry.
- pnpm filter for the new package is `@movp/richtext`; run from the worktree root.

---

## File Structure

- `packages/richtext/` (new) — the shared canonical leaf package. One responsibility: byte-stable canonicalization + doc text extraction + normalization. No UI, no server deps.
- `packages/editor-sdk/src/canonical.ts` (modify) — becomes a thin re-export from `@movp/richtext` (keeps the SDK's public surface byte-compatible).
- `packages/domain/src/content.ts` (modify) — `prepare()` normalizes richtext + derives search text from the doc.
- `supabase/migrations/<ts>_update_content_hash_first.sql` (new) — hash-first `update_content`.
- `supabase/tests/cms_content_rpcs_test.sql` (modify) — 4 new pgTAP assertions.
- Registration: `scripts/check-package-artifacts.mjs`, `scripts/check-publishable-versions.mjs`, `scripts/check-ci-wiring.mjs` (+ its fixture test), `.github/workflows/ci.yml`, `fixtures/verdaccio-crm-lite/gate.sh`, `fixtures/verdaccio-gallery/pack.sh`, five `supabase/functions/*/deno.json`, `packages/{editor-sdk,domain}/package.json`.

---

## Task 1: Scaffold `@movp/richtext` and move the canonicalizer

**Files:**
- Create: `packages/richtext/package.json`, `packages/richtext/tsconfig.json`, `packages/richtext/vitest.config.ts`, `packages/richtext/src/canonical.ts`, `packages/richtext/src/index.ts`
- Create (move): `packages/richtext/test/canonical.test.ts` (from `packages/editor-sdk/test/canonical.test.ts`)
- Modify: `packages/editor-sdk/src/canonical.ts` (→ re-export), `packages/editor-sdk/package.json` (add dep)
- Delete: `packages/editor-sdk/test/canonical.test.ts` (moved)

**Interfaces:**
- Produces: `canonicalizeInnerJson(value: unknown): string` from `@movp/richtext` (identical bytes to the old editor-sdk implementation).

- [ ] **Step 1: Create the package manifest** `packages/richtext/package.json`

```json
{
  "name": "@movp/richtext",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "files": ["dist"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsup src/index.ts --format esm --dts --sourcemap --clean --target es2020 --out-dir dist"
  },
  "publishConfig": {
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
  },
  "devDependencies": { "vitest": "^3.2.6" }
}
```

- [ ] **Step 2: Create `packages/richtext/tsconfig.json` and `packages/richtext/vitest.config.ts`**

`tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```
`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { environment: 'node' } })
```

- [ ] **Step 3: Move the canonicalizer** — create `packages/richtext/src/canonical.ts` with the exact current content of `packages/editor-sdk/src/canonical.ts` (byte-for-byte; this is the §5.2 algorithm):

```ts
/** §5.2 normative canonical inner-JSON algorithm. Byte-stable string for a JSON value. */
export function canonicalizeInnerJson(value: unknown): string {
  return serialize(value, new WeakSet<object>())
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function serialize(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string') return JSON.stringify(value)
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical: non-finite number rejected')
    return JSON.stringify(value)
  }
  if (t === 'bigint') throw new Error('canonical: bigint rejected')
  if (t === 'undefined') throw new Error('canonical: undefined rejected')
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('canonical: cycle rejected')
    ancestors.add(value)
    try {
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        items.push(serialize(value[index], ancestors))
      }
      return `[${items.join(',')}]`
    } finally {
      ancestors.delete(value)
    }
  }
  if (t === 'object') {
    const obj = value as object
    if (!isPlainObject(obj)) throw new Error('canonical: non-plain object rejected')
    if (ancestors.has(obj)) throw new Error('canonical: cycle rejected')
    ancestors.add(obj)
    try {
      const keys = Object.keys(obj).sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k], ancestors)}`).join(',')}}`
    } finally {
      ancestors.delete(obj)
    }
  }
  throw new Error(`canonical: unsupported value of type ${t}`)
}
```

- [ ] **Step 4: Create `packages/richtext/src/index.ts`** (barrel; `docToPlainText`/`normalizeToCanonicalDoc` are added in Task 2):

```ts
export { canonicalizeInnerJson } from './canonical.ts'
```

- [ ] **Step 5: Move the canonical tests** — create `packages/richtext/test/canonical.test.ts` with the exact current content of `packages/editor-sdk/test/canonical.test.ts`, changing only the import path to `../src/canonical.ts` (it is already `../src/canonical.ts`, so the content is copied verbatim). Then delete `packages/editor-sdk/test/canonical.test.ts`.

- [ ] **Step 6: Point editor-sdk at the shared module.** Replace the entire body of `packages/editor-sdk/src/canonical.ts` with a re-export:

```ts
// The §5.2 canonical algorithm now lives in @movp/richtext so the editor (encode) and the domain
// (normalize-on-write) share one byte-stable implementation. Re-exported for back-compat.
export { canonicalizeInnerJson } from '@movp/richtext'
```

Add the dependency to `packages/editor-sdk/package.json` `dependencies`:
```json
"@movp/richtext": "workspace:*"
```

- [ ] **Step 7: Install and verify RED→GREEN across both packages**

Run: `pnpm install`
Then: `pnpm --filter @movp/richtext test`
Expected: PASS — the 10 moved canonical tests pass in `@movp/richtext`.

Run: `pnpm --filter @movp/editor-sdk test`
Expected: PASS — editor-sdk's `adapter.test.ts` (encode byte-stability) and `public-surface.test.ts` (still exports `canonicalizeInnerJson`) pass against the re-export; `canonical.test.ts` is gone from editor-sdk.

Run: `pnpm --filter @movp/richtext typecheck && pnpm --filter @movp/editor-sdk typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/richtext packages/editor-sdk/src/canonical.ts packages/editor-sdk/package.json pnpm-lock.yaml
git rm packages/editor-sdk/test/canonical.test.ts
git commit -m "feat(richtext): extract shared canonicalizer into @movp/richtext"
```

---

## Task 2: `docToPlainText` + `normalizeToCanonicalDoc`

**Files:**
- Modify: `packages/richtext/src/index.ts`
- Create: `packages/richtext/src/normalize.ts`, `packages/richtext/test/normalize.test.ts`

**Interfaces:**
- Consumes: `canonicalizeInnerJson` (Task 1).
- Produces: `docToPlainText(doc: unknown): string`, `isDocShape(v: unknown): v is { type: 'doc'; content: unknown[] }`, `normalizeToCanonicalDoc(value: unknown): string`.

- [ ] **Step 1: Write the failing test** `packages/richtext/test/normalize.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { canonicalizeInnerJson } from '../src/canonical.ts'
import { docToPlainText, isDocShape, normalizeToCanonicalDoc } from '../src/normalize.ts'

const EMPTY = canonicalizeInnerJson({ type: 'doc', content: [] })
const para = (text: string) => ({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

describe('isDocShape', () => {
  it('accepts a doc, rejects non-docs', () => {
    expect(isDocShape({ type: 'doc', content: [] })).toBe(true)
    expect(isDocShape({ type: 'paragraph' })).toBe(false)
    expect(isDocShape('x')).toBe(false)
  })
})

describe('docToPlainText', () => {
  it('concatenates text nodes depth-first, not markup', () => {
    const doc = { type: 'doc', content: [
      { type: 'heading', content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] },
    ] }
    const out = docToPlainText(doc)
    expect(out).toContain('Title')
    expect(out).toContain('Hello world')
    expect(out).not.toContain('"type"')
    expect(out).not.toContain('doc')
  })
})

describe('normalizeToCanonicalDoc', () => {
  it('empty string -> canonical empty doc', () => {
    expect(normalizeToCanonicalDoc('')).toBe(EMPTY)
  })
  it('valid doc-JSON -> canonicalized (idempotent on canonical input)', () => {
    const s = canonicalizeInnerJson(para('hi'))
    expect(normalizeToCanonicalDoc(s)).toBe(s)
  })
  it('plain text -> one escaped-text paragraph', () => {
    expect(normalizeToCanonicalDoc('hello')).toBe(canonicalizeInnerJson(para('hello')))
  })
  it('legacy HTML -> literal text paragraph (not parsed)', () => {
    expect(normalizeToCanonicalDoc('<p>x</p>')).toBe(canonicalizeInnerJson(para('<p>x</p>')))
  })
  it('non-string throws richtext_value_not_a_string', () => {
    expect(() => normalizeToCanonicalDoc(42 as unknown)).toThrow('richtext_value_not_a_string')
    expect(() => normalizeToCanonicalDoc(null as unknown)).toThrow('richtext_value_not_a_string')
  })
  it('parity: normalize is idempotent on canonicalizeInnerJson output', () => {
    const s = canonicalizeInnerJson(para('round trip'))
    expect(normalizeToCanonicalDoc(s)).toBe(s)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/richtext exec vitest run test/normalize.test.ts`
Expected: FAIL — `Cannot find module '../src/normalize.ts'`.

- [ ] **Step 3: Write minimal implementation** `packages/richtext/src/normalize.ts`

```ts
import { canonicalizeInnerJson } from './canonical.ts'

export function isDocShape(v: unknown): v is { type: 'doc'; content: unknown[] } {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    (v as { type?: unknown }).type === 'doc' && Array.isArray((v as { content?: unknown }).content)
  )
}

/** Concatenate text nodes depth-first. Never emits node/markup keys. */
export function docToPlainText(doc: unknown): string {
  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const n = node as { type?: unknown; text?: unknown; content?: unknown }
    if (n.type === 'text' && typeof n.text === 'string') parts.push(n.text)
    if (Array.isArray(n.content)) for (const child of n.content) walk(child)
  }
  walk(doc)
  return parts.join(' ')
}

const emptyDoc = () => canonicalizeInnerJson({ type: 'doc', content: [] })
const textParagraph = (text: string) =>
  canonicalizeInnerJson({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })

/**
 * The authoritative richtext storage normalizer (spec §3.2). Output is a canonical doc-JSON string.
 * Legacy HTML is stored as literal text (not parsed) in v1 — see spec §3.4 / Deferred.
 */
export function normalizeToCanonicalDoc(value: unknown): string {
  if (typeof value !== 'string') throw new Error('richtext_value_not_a_string')
  if (value === '') return emptyDoc()
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return textParagraph(value)
  }
  if (isDocShape(parsed)) return canonicalizeInnerJson(parsed)
  return textParagraph(value)
}
```

- [ ] **Step 4: Export from the barrel** — update `packages/richtext/src/index.ts`:

```ts
export { canonicalizeInnerJson } from './canonical.ts'
export { docToPlainText, isDocShape, normalizeToCanonicalDoc } from './normalize.ts'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @movp/richtext test`
Expected: PASS — canonical (10) + normalize (7) tests green.
Run: `pnpm --filter @movp/richtext typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/richtext/src/normalize.ts packages/richtext/src/index.ts packages/richtext/test/normalize.test.ts
git commit -m "feat(richtext): add normalizeToCanonicalDoc + docToPlainText"
```

---

## Task 3: Domain `prepare()` normalizes richtext + doc-derived search text

**Files:**
- Modify: `packages/domain/package.json` (add dep), `packages/domain/src/content.ts` (`prepare()`)
- Test: `packages/domain/test/content.integration.test.ts` (add cases) or a new `packages/domain/test/richtext-prepare.test.ts`

**Interfaces:**
- Consumes: `normalizeToCanonicalDoc`, `docToPlainText` from `@movp/richtext`.
- Produces: the persisted richtext value is canonical doc-JSON; `search_body` is human text.

- [ ] **Step 1: Add the dependency** to `packages/domain/package.json` `dependencies`:
```json
"@movp/richtext": "workspace:*"
```
Run: `pnpm install`

- [ ] **Step 2: Write the failing test.** Use the existing test's real-schema, real-DB pattern (`packages/domain/test/content.integration.test.ts` shows the `{name:'body', type:'richtext'}` type + `create`/`update` through the public service). Add a test that a plain-text richtext value is persisted as canonical doc-JSON and produces human `search_body`:

```ts
// in packages/domain/test/content.integration.test.ts (or a sibling using the same harness/ctx)
import { canonicalizeInnerJson, docToPlainText } from '@movp/richtext'

it('persists richtext as canonical doc-JSON and derives human search_body', async () => {
  // ...create a content type with a { name: 'body', type: 'richtext' } field via the existing harness...
  const created = await content.create({
    workspaceId, contentTypeId, slug: 'rt-1', data: { body: 'hello world' },
  })
  const detail = await content.getDetail(created.id)
  const stored = JSON.parse(String((detail!.currentRevision as { data: Record<string, string> }).data.body))
  expect(stored.type).toBe('doc')                                   // canonical doc, not raw 'hello world'
  expect(docToPlainText(stored)).toBe('hello world')                // round-trips to human text
  const expected = canonicalizeInnerJson({
    type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
  })
  expect((detail!.currentRevision as { data: Record<string, string> }).data.body).toBe(expected)
  // search_body holds human text, never markup:
  expect((detail!.currentRevision as { data: unknown } & { }).data).toBeDefined()
})
```

> **Note for the implementer:** match the exact harness this file already uses to obtain `content`, `workspaceId`, and a created `contentTypeId` (do not invent a new DB fixture). The assertion that matters: stored `body` is canonical doc-JSON and `docToPlainText(stored) === 'hello world'`. If `search_body` is queryable in the harness, also assert it contains `hello world` and not `"type"`.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @movp/domain test` (or the file-scoped `exec vitest run test/content.integration.test.ts`)
Expected: FAIL — stored `body` is the raw string `"hello world"`, not a canonical doc; `stored.type` is undefined.

- [ ] **Step 4: Implement — two edits in `packages/domain/src/content.ts`.**

Add to the imports at the top of the file:
```ts
import { docToPlainText, normalizeToCanonicalDoc } from '@movp/richtext'
```

In `prepare()`, immediately after `const parsed = fieldSchemaToZod(fields).parse(data)` (currently `content.ts:162`) and **before** `canonicalize`/`sha256Hex`, insert:
```ts
  // Normalize richtext to canonical doc-JSON BEFORE hashing so the canonical invariant holds for
  // every write surface (GraphQL/MCP/CLI/domain), not just the frontend endpoint (spec §3.3).
  for (const field of fields) {
    if (field.type === 'richtext' && parsed[field.name] != null) {
      parsed[field.name] = normalizeToCanonicalDoc(parsed[field.name])
    }
  }
```

Change the richtext `search_body` line (currently `content.ts:170`) from:
```ts
      if (field.type === 'richtext') bodyParts.push(String(value))
```
to:
```ts
      if (field.type === 'richtext') bodyParts.push(docToPlainText(JSON.parse(value as string)))
```

> **Gotcha:** `parsed` is the object that becomes `canonical` (persisted `p_data`) and is hashed. Normalizing it in place (before `canonicalize`) is what makes the stored value AND the `content_hash` canonical. Deriving `search_body` from the already-normalized value keeps markup out of full-text search.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @movp/domain test`
Expected: PASS — including the new case; existing content tests still green.
Run: `pnpm --filter @movp/domain typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/content.ts packages/domain/package.json packages/domain/test pnpm-lock.yaml
git commit -m "feat(domain): normalize richtext to canonical doc-JSON in prepare()"
```

---

## Task 4: Forward-only hash-first `update_content` migration + pgTAP

**Files:**
- Create: `supabase/migrations/<ts>_update_content_hash_first.sql`
- Modify: `supabase/tests/cms_content_rpcs_test.sql`

**Interfaces:**
- Produces: `update_content(...)` returns the current revision (idempotent) when `p_content_hash` matches; raises `content_update_conflict` only for a *differing* payload on a stale base.

- [ ] **Step 1: Create the migration.** Choose `<ts>` as a timestamp strictly greater than every existing migration filename (e.g. `20260716120000`). Create `supabase/migrations/20260716120000_update_content_hash_first.sql` with the full `create or replace` — identical to `20260701000012`'s function EXCEPT the hash-dedup block runs before the conflict check:

```sql
-- Forward-only fix (spec §4): check the effective-payload hash BEFORE the optimistic-lock revision so a
-- lost-response retry of an identical payload is idempotent instead of a false content_update_conflict.
-- Do NOT edit 20260701000012_cms_content_rpcs.sql; this create-or-replace supersedes that function body.
create or replace function public.update_content(
  p_item_id uuid,
  p_data jsonb,
  p_content_hash text,
  p_search_text text,
  p_search_body text,
  p_expected_revision_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ws uuid;
  v_parent uuid;
  current_hash text;
  next_number int;
  new_rev_id uuid;
  result jsonb;
begin
  select ci.workspace_id, ci.current_revision_id, r.content_hash
    into v_ws, v_parent, current_hash
    from public.content_item ci
    left join public.content_revision r on r.id = ci.current_revision_id
   where ci.id = p_item_id;

  if v_ws is null then
    raise exception 'content item not found or inaccessible' using errcode = 'no_data_found';
  end if;

  -- Hash-first: an identical effective payload is idempotent regardless of expected-revision staleness.
  if current_hash is not null and current_hash = p_content_hash then
    update public.content_item
       set search_text = p_search_text, search_body = p_search_body
     where id = p_item_id;
    select to_jsonb(ci) into result from public.content_item ci where ci.id = p_item_id;
    return result;
  end if;

  -- Only a DIFFERING payload on a stale base is a conflict.
  if p_expected_revision_id is not null and v_parent is distinct from p_expected_revision_id then
    raise exception 'content_update_conflict';
  end if;

  select coalesce(max(revision_number), 0) + 1 into next_number
    from public.content_revision where content_item_id = p_item_id;

  insert into public.content_revision (workspace_id, content_item_id, revision_number, data, content_hash, author_id, parent_id)
    values (v_ws, p_item_id, next_number, p_data, p_content_hash, (select auth.uid()), v_parent)
    returning id into new_rev_id;

  update public.content_item
     set current_revision_id = new_rev_id, search_text = p_search_text, search_body = p_search_body
   where id = p_item_id;

  select to_jsonb(ci) into result from public.content_item ci where ci.id = p_item_id;
  return result;
end;
$$;
```

- [ ] **Step 2: Verify the forward-only guard still passes** (new file, old untouched)

Run: `pnpm test:forward-only-migrations`
Expected: PASS — reports the new migration as an addition; no merged migration rewritten.

- [ ] **Step 3: Add the failing pgTAP assertions** to `supabase/tests/cms_content_rpcs_test.sql` (extend the existing file; match its `plan(...)` count and its fixture/seed helpers). Add, in a workspace/user context that owns a seeded content item:

```sql
-- Case 1: stale expected revision + IDENTICAL hash -> idempotent success, no new revision.
--   Capture current revision id + revision count, call update_content with the SAME data/hash and a
--   deliberately stale p_expected_revision_id (e.g. gen_random_uuid()), then assert:
select is(
  (select current_revision_id from public.content_item where id = :item_id),
  :rev_before,
  'identical-hash retry with stale expected revision does not advance the revision'
);
select is(
  (select count(*) from public.content_revision where content_item_id = :item_id),
  :count_before,
  'identical-hash retry inserts no new revision'
);

-- Case 2: stale expected revision + DIFFERENT hash -> conflict.
select throws_ok(
  $$ select public.update_content(:item_id, :different_data, :different_hash, '', '', gen_random_uuid()) $$,
  'content_update_conflict',
  'differing payload on a stale expected revision raises content_update_conflict'
);

-- Case 3: the rejected call in Case 2 mutated nothing.
select is(
  (select current_revision_id from public.content_item where id = :item_id),
  :rev_before,
  'a rejected conflict changes neither the current revision'
);
select is(
  (select count(*) from public.content_revision where content_item_id = :item_id),
  :count_before,
  'nor the revision count'
);

-- Case 4 (regression): matching base + different hash -> new revision (existing behavior preserved).
```

> **Implementer note:** replace `:item_id`, `:rev_before`, `:count_before`, `:different_data`, `:different_hash` with the file's existing seed variables/values; keep Case 4 as an explicit new-revision assertion using the *current* (matching) revision as `p_expected_revision_id`. Update the `plan(N)` count at the top of the file to include the added assertions.

- [ ] **Step 4: Run the DB gate to verify RED then GREEN**

Run (before writing the migration's reorder, to confirm the tests are load-bearing — optional sabotage check): temporarily point at the old function → Case 1 FAILS with a raised `content_update_conflict`.
Run the real gate: `bash scripts/slice-e2e.sh` (or the repo's `supabase test db` path used in CI for pgTAP).
Expected: PASS — all four new assertions green; existing `cms_content_rpcs_test.sql` assertions still green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260716120000_update_content_hash_first.sql supabase/tests/cms_content_rpcs_test.sql
git commit -m "fix(cms): hash-first update_content so identical retries are idempotent"
```

---

## Task 5: Register `@movp/richtext` across release/CI gates

**Files:**
- Modify: `scripts/check-package-artifacts.mjs`, `scripts/check-publishable-versions.mjs`, `scripts/check-ci-wiring.mjs`, `scripts/test/check-ci-wiring.test.mjs`, `.github/workflows/ci.yml`, `fixtures/verdaccio-crm-lite/gate.sh`, `fixtures/verdaccio-gallery/pack.sh`, `supabase/functions/{flows,graphql,index-embeddings,mcp,segment-recompute}/deno.json`

**Interfaces:**
- Produces: the release/CI graph treats `@movp/richtext` as a first-class publishable dependency of `@movp/domain` and `@movp/editor-sdk`.

- [ ] **Step 1: Add `richtext` to the two publishable lists.**
  - `scripts/check-package-artifacts.mjs`: add `'richtext',` to the `publishable` array (keep it alphabetical: after `platform`, before `search`).
  - `scripts/check-publishable-versions.mjs`: add `'richtext'` to the `PUBLISHABLE` array.

- [ ] **Step 2: Add the new package's build artifact.** Ensure `packages/richtext` has a `build` script producing `dist` (Task 1 Step 1 includes it). `check-package-artifacts` validates `dist` after build.

Run: `pnpm --filter @movp/richtext build`
Expected: emits `packages/richtext/dist/index.{js,d.ts}`.

- [ ] **Step 3: Add the five Deno import-map entries.** In each of `supabase/functions/{flows,graphql,index-embeddings,mcp,segment-recompute}/deno.json`, add `@movp/richtext` to the `imports` map alongside the existing `@movp/domain` entry, pointing at the same relative style the file already uses for `@movp/*` (mirror the existing `@movp/domain` mapping's path shape for `@movp/richtext`).

> **Gotcha:** the entry must resolve `@movp/richtext` to the package's source/entry the way the sibling `@movp/*` entries do. Node typecheck cannot catch a missing entry — only `deno check` does.

- [ ] **Step 4: Add both packages to the Verdaccio publish/pack lists.** In `fixtures/verdaccio-crm-lite/gate.sh` and `fixtures/verdaccio-gallery/pack.sh`, add `editor-sdk` **and** `richtext` to the list of packages that are staged/published (editor-sdk is currently absent from both — spec §3.1). Follow each file's existing package-name list pattern.

- [ ] **Step 5: Wire CI to run the new package's tests.** In `.github/workflows/ci.yml`, extend the `c7-editor-sdk` job to also run richtext (add a step `- run: pnpm --filter @movp/richtext test` after the editor-sdk test step). In `scripts/check-ci-wiring.mjs`, add `'pnpm --filter @movp/richtext test'` to the `c7-editor-sdk` job's `runs` array. Update `scripts/test/check-ci-wiring.test.mjs`'s `c7-editor-sdk` fixture (the armed workflow block and the fail-first case) to include that run line so removing it fails CI.

- [ ] **Step 6: Run every registration gate**

```bash
pnpm --filter @movp/richtext build
pnpm --filter @movp/domain build && pnpm --filter @movp/editor-sdk build
pnpm check:packages
pnpm test:version-gate && pnpm check:publishable-versions
pnpm check:ci-wiring
```
Expected: all PASS — `check:packages` finds `dist` for richtext with no source entrypoint; version gate reports richtext at `0.1.0`; `check:ci-wiring` confirms the `c7-editor-sdk` job runs the richtext test (and fails if that line is removed).

Run the Verdaccio graph (heavier; local runs may hit the known edge-runtime flake — trust the publish/install/codegen stages):
```bash
pnpm check:verdaccio-crm && pnpm check:verdaccio-gallery
```
Expected: PASS — external installs resolve `@movp/editor-sdk` → `@movp/richtext` with no `workspace:`/`link:`/`file:` leakage.

Run the Deno graph:
```bash
deno check --no-lock --config supabase/functions/flows/deno.json supabase/functions/flows/index.ts
# ...and the other four entrypoints (graphql, index-embeddings, mcp, segment-recompute)...
```
Expected: PASS — the bare `@movp/richtext` import resolves in all five.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-package-artifacts.mjs scripts/check-publishable-versions.mjs scripts/check-ci-wiring.mjs scripts/test/check-ci-wiring.test.mjs .github/workflows/ci.yml fixtures/verdaccio-crm-lite/gate.sh fixtures/verdaccio-gallery/pack.sh supabase/functions/flows/deno.json supabase/functions/graphql/deno.json supabase/functions/index-embeddings/deno.json supabase/functions/mcp/deno.json supabase/functions/segment-recompute/deno.json
git commit -m "chore(richtext): register @movp/richtext across release/CI/Deno gates"
```

---

## C7.3a completion gate

C7.3a is DONE only when all of the following are green (spec §2.1):

```bash
pnpm --filter @movp/richtext test && pnpm --filter @movp/editor-sdk test && pnpm --filter @movp/domain test
pnpm typecheck
pnpm check:packages && pnpm test:version-gate && pnpm check:publishable-versions && pnpm check:ci-wiring
pnpm test:forward-only-migrations
# pgTAP (4 new assertions) via the repo's DB test path; five-entrypoint deno check; verdaccio crm+gallery.
```

Then update the Stage C EXECUTION STATUS table in `docs/superpowers/plans/README.md` for C7.3a. **Do NOT mark C7.3 (or C7) complete** — C7.3b (SDK/frontend binding and conflict UX) must land next.

## Spec coverage self-check (C7.3a scope)

- Canonical invariant enforced in domain `prepare()` (spec §3.3) → Task 3. ✅
- Shared `@movp/richtext` module, editor re-export, no drift (spec §3.1) → Tasks 1–2. ✅
- `normalizeToCanonicalDoc` 4-class contract + idempotency (spec §3.2) → Task 2. ✅
- `docToPlainText` search extraction (spec §3.3) → Tasks 2–3. ✅
- Hash-first RPC migration + 4 pgTAP assertions (spec §4) → Task 4. ✅
- Package/version/Verdaccio/Deno/CI registration (spec §3.1 acceptance list) → Task 5. ✅
- Legacy-HTML rollout audit (spec §3.4) → operator SQL in the spec; no code task (count-only, pre-rollout). Carried as a rollout step, not a build task.
- **Out of C7.3a scope (→ C7.3b):** SDK dirty/conflict UX (§5, §6.1), coordinator island (§6), endpoint (§7), mock + e2e (§8), frontend deps + frontend-as-verdaccio-consumer.
