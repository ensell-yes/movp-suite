# C7.2 — `@movp/editor-sdk` Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@movp/editor-sdk` — a client-safe, publishable React rich-text editor package that productionizes the TipTap island proven by the C7.1 spike, so a host app can embed the editor and wire its save callback to MOVP content mechanics.

**Architecture:** The SDK owns exactly four things: (1) the TipTap React editor + toolbar, (2) the normative canonical inner-JSON encode/decode adapter that makes stored `richtext` byte-stable, (3) a small save state machine with a humane conflict *surface*, and (4) a pure `classifySaveOutcome` bridge that normalizes save failures. It is strictly client-safe: it never imports `@movp/domain`, `@movp/auth`, `@movp/graphql`, or `@supabase`. The host injects an `onSave(body) => Promise<SaveResult>` callback (whose implementation calls `content.update` server-side); the SDK recognizes a domain conflict *by string shape only*.

**Tech Stack:** TypeScript (ES2022, `moduleResolution: bundler`, explicit `.ts` import extensions), React 18.3 (peer), TipTap 2.27.2 (`@tiptap/react` + `@tiptap/pm` + `@tiptap/starter-kit`), Vitest 3.2 (node default; jsdom per-file for the mounted test), tsup (build → `dist`).

## Provenance (why the decisions below are already made — do not re-litigate)

- **Candidate selection is settled.** C7.1's report (`docs/superpowers/specs/2026-07-15-c7.1-editor-spike-report.md`) selected **TipTap** under `permissive_only`: all-MIT prod tree, passed idempotent/exact-edit/lifecycle/delivery/stale/boundary/a11y. BlockNote failed delivery + a11y and carries MPL-2.0 copyleft. Use TipTap; introduce no MPL/copyleft dependency.
- **The byte contract is normative.** Spike design (`docs/superpowers/specs/2026-07-15-c7.1-editor-spike-design.md` §5.2) fixes the canonical inner-JSON algorithm. `richtext` is stored as an **opaque `z.string()`** and production `canonicalize` (`packages/domain/src/content.ts:95-108`) sorts only *outer* `data` keys, so editor idempotency reduces to "is the stored inner string byte-stable across load→save?". Port the algorithm verbatim (Task 2).
- **Conflict mechanics already exist.** `ContentService.update({ itemId, data, expectedRevisionId? })` (`packages/domain/src/types.ts:177`) maps a stale revision to the error `domain.content.update failed [content_update_conflict]` (`packages/domain/src/content.ts:237`). The content GraphQL resolver does not currently expose a stable conflict extension, so transport hosts must translate their own conflict response into `{ status: 'conflict' }`; `classifySaveOutcome` recognizes only the domain error string and never imports server packages.
- **Scope boundary.** This is C7.2 of the C7 breakdown (`docs/superpowers/plans/2026-07-07-movp-stage-c-tdd-breakdown.md:607-616`). The **two-editor domain 409 e2e**, the real `onSave→content.update` binding, the overlay, realtime, and delivery artifacts are C7.3–C7.7 — **out of scope** here. C7.2 proves the component *mounts, saves, surfaces conflict, and reloads* against an injected `onSave` (jsdom, Task 6); the real keystroke-driven bold + two-editor conflict against a live DB is C7.3 Playwright.

## Global Constraints

Every task's requirements implicitly include these. Values copied verbatim from the spike design, the report, and verified repo conventions.

- **Node:** `22` (CI uses `node-version: 22`).
- **Package name / version:** `@movp/editor-sdk`, version **`0.1.0`** (the publishable-version gate enforces `EXPECTED_VERSION = '0.1.0'`; `scripts/check-publishable-versions.mjs:15`).
- **License:** permissive only. No MPL-2.0 or copyleft dependency.
- **Editor deps (exact-pinned, no `^`):** `@tiptap/core`, `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit` all `2.27.2`. React/`react-dom` are **peer** deps at `^18.3.1` (a library must not bundle its own React).
- **Client boundary (hard gate):** no file under `packages/editor-sdk/src/` may import `@movp/domain`, `@movp/auth`, `@movp/graphql`, `@supabase*`, or `packages/domain*`, or reference `service_role` / `SERVICE_ROLE_KEY` / `SUPABASE_SERVICE_ROLE`. Enforced by `test/boundary.test.ts` (Task 7), which walks `src/` so new files are covered automatically.
- **Canonical version:** `INNER_CANONICAL_VERSION = 1`. Bump only if the §5.2 algorithm changes.
- **Import extensions:** intra-package imports use explicit `.ts`/`.tsx` extensions (repo sets `allowImportingTsExtensions: true`; `tsconfig.base.json`).
- **State modeling:** the save outcome is a **discriminated union** (`SaveResult`); the editor status is a closed set — no wide types + sentinels (per `idempotency-cli-and-auth`).
- **Content discipline:** never propagate raw error text or file contents into a `code`, a log, or a rendered surface (per `untrusted-io-and-resource-bounds` + observability discipline). Codes are allowlisted classifiers.

---

## File Structure

```
packages/editor-sdk/
  package.json                 # @movp/editor-sdk, deps, peerDeps, publishConfig, tsup build
  tsconfig.json                # extends ../../tsconfig.base.json, adds jsx: react-jsx
  vitest.config.ts             # node env default + esbuild automatic JSX runtime
  src/
    canonical.ts               # §5.2 canonicalizeInnerJson (ported verbatim)
    adapter.ts                 # EditorAdapter, INNER_CANONICAL_VERSION, tipTapAdapter (shape-validated), TipTapDoc
    save.ts                    # SaveResult union, SaveHandler, classifySaveOutcome (normalized codes)
    toolbar.tsx                # presentational 5-control toolbar (ported)
    conflict-surface.tsx       # presentational humane conflict banner (new)
    editor.tsx                 # MovpEditor shell (TipTap + toolbar + conflict + save state machine)
    index.ts                   # public barrel
  test/
    canonical.test.ts          # §5.2 suite (ported)              [node]
    adapter.test.ts            # decode shape validation + idempotency [node]
    save.test.ts               # classifySaveOutcome + no-leak       [node]
    presentational.test.tsx    # toolbar + conflict-surface + SSR-no-warn (renderToStaticMarkup) [node]
    public-surface.test.ts     # durable barrel export gate          [node]
    tiptap-jsdom-smoke.test.tsx # viability gate for TipTap EditorView under jsdom [jsdom]
    mounted.test.tsx           # MovpEditor mount/save/conflict/refresh/readOnly [jsdom]
    boundary.test.ts           # client-boundary walk over src/      [node]
```

**Responsibility split:** pure logic (`canonical`, `adapter`, `save`) is DOM-free and exhaustively unit-tested; presentational components render server-side via `react-dom/server` (no DOM env); the `editor` shell is proven **mounted in jsdom** (Task 6) for save/conflict/refresh/readOnly, with the real keystroke-driven + live-DB conflict deferred to C7.3 Playwright.

---

## Task 0 (GATE): Production-dependency approval — STOP before Task 1

> **Do not run `pnpm install` (Task 1) until a human has explicitly approved this exact dependency set.** The C7.1 spike approval covered only `spikes/editor/` (design §11); it did **not** approve production dependencies. This is a hard stop per the repo's "no new dependencies without approval" rule.

- [ ] **Step 1: Present the exact set for approval**

Production `dependencies` (all MIT per the C7.1 report's `--prod` license graph):
- `@tiptap/core` `2.27.2`, `@tiptap/react` `2.27.2`, `@tiptap/pm` `2.27.2`, `@tiptap/starter-kit` `2.27.2`

Peer `dependencies` (already present in the repo's app runtime):
- `react` `^18.3.1`, `react-dom` `^18.3.1`

Test-only `devDependencies` (do not ship; needed for the mounted-component gate, Task 6):
- `jsdom` `^25.0.0`, `@testing-library/react` `^16.1.0`, `@testing-library/dom` `^10.4.0`

`@testing-library/dom` is explicit because React Testing Library v16 moved it to a peer dependency.
Do not rely on pnpm peer auto-install behavior in a clean worktree.

- [ ] **Step 2: Record approval, then proceed**

Obtain an explicit "approved" from the human partner. Do not mutate `pnpm-lock.yaml` before that. Once approved, continue to Task 1.

**Gate:** approval recorded in the conversation/PR before any lockfile change.

---

## Task 1: Scaffold the `@movp/editor-sdk` package

> **Ordering matters (clean-worktree reliability):** create the manifest and install BEFORE any `--filter` test run. `pnpm --filter @movp/editor-sdk <cmd>` against a package that does not yet exist prints "No projects matched" and **exits 0** — a filtered "red" step would silently pass. So Task 1's gate is `install` + `typecheck`, and the first genuinely-red test is Task 2.

**Files:**
- Create: `packages/editor-sdk/package.json`
- Create: `packages/editor-sdk/tsconfig.json`
- Create: `packages/editor-sdk/vitest.config.ts`
- Create: `packages/editor-sdk/src/index.ts`

**Interfaces:**
- Produces: an installable, typechecking workspace package `@movp/editor-sdk`. Later tasks add real modules.

- [ ] **Step 1: Create the package manifest** (mirrors `packages/search/package.json`; `main`/`types` point at source, `publishConfig` redirects to `dist` at publish time):

```json
{
  "name": "@movp/editor-sdk",
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
  "dependencies": {
    "@tiptap/core": "2.27.2",
    "@tiptap/react": "2.27.2",
    "@tiptap/pm": "2.27.2",
    "@tiptap/starter-kit": "2.27.2"
  },
  "peerDependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "@types/react": "18.3.3",
    "@types/react-dom": "18.3.0",
    "@testing-library/dom": "^10.4.0",
    "@testing-library/react": "^16.1.0",
    "jsdom": "^25.0.0",
    "vitest": "^3.2.6"
  },
  "publishConfig": {
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
  }
}
```

> **GOTCHA (workspace):** `pnpm-workspace.yaml` already globs `packages/*`, so no edit there. `tsup` is provided at the repo root (like `@movp/search`); do not add it to this package's `devDependencies`.

- [ ] **Step 2: Create tsconfig** (base sets ES2022/bundler/strict; add the React JSX transform, which the base does not set):

`packages/editor-sdk/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "react-jsx" },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create the Vitest config** (node env like `@movp/search`; the `esbuild.jsx` block lets `.tsx` tests transform without `@vitejs/plugin-react`. The mounted tests opt into jsdom per-file via docblocks, Task 6):

`packages/editor-sdk/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
})
```

- [ ] **Step 4: Create the placeholder barrel** (real exports arrive in Task 6):

`packages/editor-sdk/src/index.ts`:
```ts
export {}
```

- [ ] **Step 5: Install and gate**

Run: `pnpm install`
Expected: lockfile updates; `@movp/editor-sdk` resolves with TipTap + React + test deps.

Run: `pnpm --filter @movp/editor-sdk typecheck`
Expected: PASS (no errors; empty module typechecks).

- [ ] **Step 6: Commit**

```bash
git add packages/editor-sdk pnpm-lock.yaml
git commit -m "feat(editor-sdk): scaffold @movp/editor-sdk package"
```

---

## Task 2: Port the canonical inner-JSON algorithm (§5.2)

**Files:**
- Create: `packages/editor-sdk/src/canonical.ts`
- Create: `packages/editor-sdk/test/canonical.test.ts`

**Interfaces:**
- Produces: `canonicalizeInnerJson(value: unknown): string` — byte-stable serializer (recursive lexicographic key sort, compact output, throws on non-JSON/cycles/non-plain-objects). Consumed by `adapter.ts` (Task 3).

- [ ] **Step 1: Write the failing test** — port the spike's proven suite verbatim.

`packages/editor-sdk/test/canonical.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { canonicalizeInnerJson } from '../src/canonical.ts'

describe('canonicalizeInnerJson (§5.2)', () => {
  it('sorts object keys recursively and preserves array order', () => {
    const a = canonicalizeInnerJson({ b: 1, a: { d: 2, c: 3 }, list: [3, 1, 2] })
    const b = canonicalizeInnerJson({ list: [3, 1, 2], a: { c: 3, d: 2 }, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1,"list":[3,1,2]}')
  })
  it('emits compact output', () => {
    expect(canonicalizeInnerJson({ x: 1 })).toBe('{"x":1}')
  })
  it('rejects undefined, bigint, non-finite numbers', () => {
    expect(() => canonicalizeInnerJson({ x: undefined })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: 10n })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: NaN })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: Infinity })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: -Infinity })).toThrow(/canonical/)
  })
  it('rejects non-plain objects (Date, Map, class instances)', () => {
    class CustomValue { value = 1 }
    const customPrototype: unknown = Object.create({ inherited: true })
    expect(() => canonicalizeInnerJson({ x: new Date() })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: new Map() })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: new CustomValue() })).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson({ x: customPrototype })).toThrow(/canonical/)
  })
  it('accepts finite numbers, strings, booleans, null, nested arrays/objects', () => {
    expect(canonicalizeInnerJson({ n: 0, s: 'x', b: true, z: null, arr: [{ k: 1 }] }))
      .toBe('{"arr":[{"k":1}],"b":true,"n":0,"s":"x","z":null}')
  })
  it('rejects sparse arrays instead of silently converting holes', () => {
    const sparse: unknown[] = []
    sparse.length = 1
    expect(() => canonicalizeInnerJson(sparse)).toThrow(/canonical: undefined/)
  })
  it('rejects direct and indirect object and array cycles', () => {
    const directObject: Record<string, unknown> = {}
    directObject.self = directObject
    const directArray: unknown[] = []
    directArray.push(directArray)
    const indirectObject: Record<string, unknown> = {}
    const indirectArray: unknown[] = [indirectObject]
    indirectObject.array = indirectArray
    expect(() => canonicalizeInnerJson(directObject)).toThrow(/canonical: cycle/)
    expect(() => canonicalizeInnerJson(directArray)).toThrow(/canonical: cycle/)
    expect(() => canonicalizeInnerJson(indirectObject)).toThrow(/canonical: cycle/)
    expect(() => canonicalizeInnerJson(indirectArray)).toThrow(/canonical: cycle/)
  })
  it('allows shared acyclic references', () => {
    const shared = { z: 1 }
    expect(canonicalizeInnerJson({ a: shared, b: shared })).toBe('{"a":{"z":1},"b":{"z":1}}')
  })
  it('accepts null-prototype objects', () => {
    const value = Object.create(null) as Record<string, unknown>
    value.b = 2
    value.a = 1
    expect(canonicalizeInnerJson(value)).toBe('{"a":1,"b":2}')
  })
  it('rejects top-level functions and symbols', () => {
    expect(() => canonicalizeInnerJson(() => true)).toThrow(/canonical/)
    expect(() => canonicalizeInnerJson(Symbol('value'))).toThrow(/canonical/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/canonical.test.ts`
Expected: FAIL — cannot resolve `../src/canonical.ts`.

- [ ] **Step 3: Create the implementation** — ported verbatim from `spikes/editor/fixture/src/canonical.ts`.

`packages/editor-sdk/src/canonical.ts`:
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/canonical.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/editor-sdk/src/canonical.ts packages/editor-sdk/test/canonical.test.ts
git commit -m "feat(editor-sdk): port §5.2 canonical inner-JSON algorithm"
```

---

## Task 3: Editor adapter — shape-validated decode + canonical version

**Files:**
- Create: `packages/editor-sdk/src/adapter.ts`
- Create: `packages/editor-sdk/test/adapter.test.ts`

**Interfaces:**
- Consumes: `canonicalizeInnerJson` (Task 2).
- Produces:
  - `interface EditorAdapter<Doc> { decode(body: string): Doc; encode(doc: Doc): string }`
  - `const INNER_CANONICAL_VERSION = 1`
  - `type TipTapDoc = Record<string, unknown>`
  - `const tipTapAdapter: EditorAdapter<TipTapDoc>` — `decode` validates the **top-level** document shape (`type: 'doc'`, array `content`) and throws a stable `invalid_richtext_document` (no source echo) on anything else; `encode` runs §5.2.

> **Why top-level only (declined deeper validation):** domain validation guarantees `richtext` is *a string*, not a valid ProseMirror doc, so a malformed top level (`{}`, `{type:"paragraph"}`) could crash TipTap's `setContent`. Validating `type:'doc'` + array `content` closes that. Full node-tree validation is **out of scope** — TipTap tolerates node/mark variance and re-validates on load; real-document fidelity is proven in C7.3. Do not add a recursive node validator here.

- [ ] **Step 1: Write the failing test**

`packages/editor-sdk/test/adapter.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { INNER_CANONICAL_VERSION, tipTapAdapter } from '../src/adapter.ts'

const seedDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
}

describe('tipTapAdapter', () => {
  it('pins the canonical version', () => {
    expect(INNER_CANONICAL_VERSION).toBe(1)
  })
  it('decode("") yields an empty doc', () => {
    expect(tipTapAdapter.decode('')).toEqual({ type: 'doc', content: [] })
  })
  it('decode rejects malformed JSON with a stable code and no source echo', () => {
    expect(() => tipTapAdapter.decode('{not json')).toThrow('invalid_richtext_document')
    // the error must NOT contain the offending source
    try {
      tipTapAdapter.decode('{not json SECRET')
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET')
    }
  })
  it('decode rejects a non-doc object (missing type, wrong type, non-array content)', () => {
    expect(() => tipTapAdapter.decode('{}')).toThrow('invalid_richtext_document')
    expect(() => tipTapAdapter.decode('{"type":"paragraph"}')).toThrow('invalid_richtext_document')
    expect(() => tipTapAdapter.decode('{"type":"doc"}')).toThrow('invalid_richtext_document')
    expect(() => tipTapAdapter.decode('42')).toThrow('invalid_richtext_document')
  })
  it('decode accepts a well-formed doc', () => {
    expect(tipTapAdapter.decode('{"type":"doc","content":[]}')).toEqual({ type: 'doc', content: [] })
  })
  it('encode(decode(x)) is byte-stable (zero-edit idempotency)', () => {
    const body = tipTapAdapter.encode(seedDoc)
    expect(tipTapAdapter.encode(tipTapAdapter.decode(body))).toBe(body)
  })
  it('encode is insensitive to inner key order', () => {
    const a = tipTapAdapter.encode({ type: 'doc', content: [], attrs: { b: 1, a: 2 } })
    const b = tipTapAdapter.encode({ attrs: { a: 2, b: 1 }, content: [], type: 'doc' })
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/adapter.test.ts`
Expected: FAIL — cannot resolve `../src/adapter.ts`.

- [ ] **Step 3: Create the implementation**

`packages/editor-sdk/src/adapter.ts`:
```ts
import { canonicalizeInnerJson } from './canonical.ts'

export interface EditorAdapter<Doc> {
  /** stored richtext string -> editor document */
  decode(body: string): Doc
  /** editor document -> stored richtext string, via the §5.2 canonical algorithm */
  encode(doc: Doc): string
}

/** Bump if the §5.2 canonical algorithm changes. */
export const INNER_CANONICAL_VERSION = 1

export type TipTapDoc = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Top-level ProseMirror doc shape only. Deeper node validation is intentionally out of scope. */
function isDocShape(value: unknown): value is TipTapDoc {
  return isRecord(value) && value.type === 'doc' && Array.isArray(value.content)
}

export const tipTapAdapter: EditorAdapter<TipTapDoc> = {
  decode(body) {
    if (body === '') return { type: 'doc', content: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      // stable code, NEVER echo the source (untrusted-io: no content in diagnostics)
      throw new Error('tiptap.decode: invalid_richtext_document')
    }
    if (!isDocShape(parsed)) throw new Error('tiptap.decode: invalid_richtext_document')
    return parsed
  },
  encode(doc) {
    return canonicalizeInnerJson(doc)
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/adapter.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/editor-sdk/src/adapter.ts packages/editor-sdk/test/adapter.test.ts
git commit -m "feat(editor-sdk): shape-validated TipTap adapter + canonical version pin"
```

---

## Task 4: Save contract — `SaveResult` union + normalized `classifySaveOutcome`

**Files:**
- Create: `packages/editor-sdk/src/save.ts`
- Create: `packages/editor-sdk/test/save.test.ts`

**Interfaces:**
- Produces:
  - `type SaveResult = { status: 'saved'; revisionId: string } | { status: 'conflict' } | { status: 'error'; code: 'save_failed' }`
  - `type SaveHandler = (body: string) => Promise<SaveResult>`
  - `function classifySaveOutcome(err: unknown): SaveResult` — maps a caught error to `conflict` (retryable via refresh) or a **normalized** `error/save_failed`. Never propagates raw error text.
- Consumed by: `editor.tsx` (Task 6). The **host** implements `SaveHandler` (server-side `content.update`); the SDK never provides an implementation.

> **BOUNDARY + content discipline (comment this at the top of `save.ts`):** recognizes the conflict *by string shape only* — MUST NOT import `@movp/domain`, `@movp/graphql`, or `@supabase`. All other failures normalize to `save_failed`; the raw message (which may carry an endpoint/host/token) is dropped, never returned.

- [ ] **Step 1: Write the failing test**

`packages/editor-sdk/test/save.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { classifySaveOutcome, type SaveResult } from '../src/save.ts'

describe('classifySaveOutcome', () => {
  it('maps a domain content_update_conflict error to conflict', () => {
    const err = new Error('domain.content.update failed [content_update_conflict]')
    expect(classifySaveOutcome(err)).toEqual<SaveResult>({ status: 'conflict' })
  })
  it('does not infer conflict from a transport extension the content GraphQL path does not emit', () => {
    const err = { extensions: { code: 'CONFLICT' } }
    expect(classifySaveOutcome(err)).toEqual<SaveResult>({ status: 'error', code: 'save_failed' })
  })
  it('normalizes any other error to save_failed and never leaks the message', () => {
    const err = new Error('connect ECONNREFUSED 10.0.0.1:5432 secret-token')
    const out = classifySaveOutcome(err)
    expect(out).toEqual<SaveResult>({ status: 'error', code: 'save_failed' })
    expect(JSON.stringify(out)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(out)).not.toContain('secret-token')
  })
  it('normalizes a non-Error value to save_failed', () => {
    expect(classifySaveOutcome(null)).toEqual<SaveResult>({ status: 'error', code: 'save_failed' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/save.test.ts`
Expected: FAIL — cannot resolve `../src/save.ts`.

- [ ] **Step 3: Create the implementation**

`packages/editor-sdk/src/save.ts`:
```ts
// CLIENT-SAFE. Recognizes the domain conflict by string shape ONLY — never import
// @movp/domain, @movp/graphql, or @supabase. Non-conflict failures normalize to a fixed
// classifier; the raw error text (which may carry endpoint/host/token) is dropped.

/** The result the host's SaveHandler resolves to. Discriminated union — no sentinels. */
export type SaveResult =
  | { status: 'saved'; revisionId: string }
  | { status: 'conflict' }
  | { status: 'error'; code: 'save_failed' }

/**
 * The host implements this via content.update. It must translate transport-specific conflicts into
 * `{ status: 'conflict' }`; transport errors are deliberately not inferred by this client package.
 */
export type SaveHandler = (body: string) => Promise<SaveResult>

/** Map a caught save error to a SaveResult. Conflict is retryable via refresh; everything else is terminal. */
export function classifySaveOutcome(err: unknown): SaveResult {
  const message = err instanceof Error ? err.message : ''
  if (message.includes('content_update_conflict')) {
    return { status: 'conflict' }
  }
  return { status: 'error', code: 'save_failed' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/save.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/editor-sdk/src/save.ts packages/editor-sdk/test/save.test.ts
git commit -m "feat(editor-sdk): SaveResult union + normalized classifySaveOutcome"
```

---

## Task 5: Presentational components — toolbar, conflict surface, SSR safety

**Files:**
- Create: `packages/editor-sdk/src/toolbar.tsx`
- Create: `packages/editor-sdk/src/conflict-surface.tsx`
- Create: `packages/editor-sdk/test/presentational.test.tsx`

**Interfaces:**
- Produces:
  - `interface ToolbarCommands { bold(): void; h1(): void; bullet(): void; undo(): void; redo(): void }`
  - `interface ToolbarActiveState { bold: boolean; h1: boolean; bullet: boolean }`
  - `function Toolbar({ commands, active }: { commands: ToolbarCommands; active: ToolbarActiveState }): JSX.Element`
  - `function ConflictSurface({ onRefresh }: { onRefresh(): void }): JSX.Element`

> **A11y (this repo gates a11y):** the toolbar carries `role="toolbar"` + `aria-label`; each control has an explicit `aria-label`. The conflict surface uses `role="alert"` so it is announced, with a labeled refresh control. These match the spike's passing a11y gate.

> The third test here also guards the **SSR immediatelyRender contract** for `MovpEditor` (created in Task 6): rendering it with `react-dom/server` must not emit TipTap's SSR warning. This test file is written now but its `MovpEditor` import resolves only after Task 6 — order accordingly (write the toolbar/conflict tests first; add the SSR test in Task 6, Step 8).

- [ ] **Step 1: Write the failing test** (toolbar + conflict only for now; render server-side, no DOM env, no new deps)

`packages/editor-sdk/test/presentational.test.tsx`:
```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Toolbar } from '../src/toolbar.tsx'
import { ConflictSurface } from '../src/conflict-surface.tsx'

const noopCommands = { bold: vi.fn(), h1: vi.fn(), bullet: vi.fn(), undo: vi.fn(), redo: vi.fn() }
const inactive = { bold: false, h1: false, bullet: false }

describe('Toolbar', () => {
  it('renders a labeled toolbar with five accessible controls', () => {
    const html = renderToStaticMarkup(<Toolbar commands={noopCommands} active={inactive} />)
    expect(html).toContain('role="toolbar"')
    expect(html).toContain('aria-label="Formatting"')
    for (const label of ['Bold', 'Heading 1', 'Bullet list', 'Undo', 'Redo']) {
      expect(html).toContain(`aria-label="${label}"`)
    }
  })
})

describe('ConflictSurface', () => {
  it('renders an alert with a refresh affordance', () => {
    const html = renderToStaticMarkup(<ConflictSurface onRefresh={() => {}} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-label="Refresh and reload latest content"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/presentational.test.tsx`
Expected: FAIL — cannot resolve `../src/toolbar.tsx`.

- [ ] **Step 3: Create the toolbar** (ported from `spikes/editor/tiptap/src/toolbar.tsx`, prop `cmds` → `commands`)

`packages/editor-sdk/src/toolbar.tsx`:
```tsx
export interface ToolbarCommands {
  bold(): void
  h1(): void
  bullet(): void
  undo(): void
  redo(): void
}

export interface ToolbarActiveState {
  bold: boolean
  h1: boolean
  bullet: boolean
}

export function Toolbar({ commands, active }: { commands: ToolbarCommands; active: ToolbarActiveState }) {
  return (
    <div role="toolbar" aria-label="Formatting">
      <button type="button" aria-label="Bold" aria-pressed={active.bold} onClick={commands.bold}>B</button>
      <button type="button" aria-label="Heading 1" aria-pressed={active.h1} onClick={commands.h1}>H1</button>
      <button type="button" aria-label="Bullet list" aria-pressed={active.bullet} onClick={commands.bullet}>List</button>
      <button type="button" aria-label="Undo" onClick={commands.undo}>Undo</button>
      <button type="button" aria-label="Redo" onClick={commands.redo}>Redo</button>
    </div>
  )
}
```

- [ ] **Step 4: Create the conflict surface**

`packages/editor-sdk/src/conflict-surface.tsx`:
```tsx
export function ConflictSurface({ onRefresh }: { onRefresh(): void }) {
  return (
    <div role="alert">
      <p>This content changed since you started editing. Refresh to load the latest version before saving again.</p>
      <button type="button" aria-label="Refresh and reload latest content" onClick={onRefresh}>
        Refresh
      </button>
    </div>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/presentational.test.tsx`
Expected: PASS (2 tests). (A third — SSR safety — is added in Task 6.)

- [ ] **Step 6: Commit**

```bash
git add packages/editor-sdk/src/toolbar.tsx packages/editor-sdk/src/conflict-surface.tsx packages/editor-sdk/test/presentational.test.tsx
git commit -m "feat(editor-sdk): accessible toolbar + conflict surface"
```

---

## Task 6: `MovpEditor` shell + save state machine + public barrel

**Files:**
- Create: `packages/editor-sdk/test/tiptap-jsdom-smoke.test.tsx`
- Create: `packages/editor-sdk/test/mounted.test.tsx`
- Create: `packages/editor-sdk/src/editor.tsx`
- Modify: `packages/editor-sdk/src/index.ts` (replace the Task 1 placeholder)
- Create: `packages/editor-sdk/test/public-surface.test.ts`
- Modify: `packages/editor-sdk/test/presentational.test.tsx` (add the SSR-safety test)

**Interfaces:**
- Consumes: `Toolbar`/`ToolbarCommands`, `ConflictSurface`, `tipTapAdapter`, `classifySaveOutcome`/`SaveHandler`/`SaveResult`.
- Produces:
  - `type EditorStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error'`
  - `interface MovpEditorProps { initialBody: string; onSave: SaveHandler; onSaved?(revisionId: string): void; onRefresh(): void; readOnly?: boolean }`
  - `function MovpEditor(props: MovpEditorProps): JSX.Element | null`

> **Refresh semantics (fixes the "refresh does nothing" defect):** TipTap does NOT react to `content`-prop changes, so refresh must reload imperatively. The host's refresh (wired to `ConflictSurface.onRefresh`) refetches the latest content and passes a **new `initialBody`**; an effect on `initialBody` calls `editor.commands.setContent(decode(initialBody))` and resets status to `idle`, which reloads the doc and clears the conflict surface.

> **GOTCHA (SSR):** the installed `@tiptap/react` 2.27.2 warns "SSR has been detected, please set `immediatelyRender` explicitly to `false`" (`useEditor.ts:110`). `useEditor` MUST pass `immediatelyRender: false`.

> **Concurrent-save guard:** a `disabled` attribute alone does not stop two synchronous clicks before React re-renders, so guard with a `useRef` flag that flips *synchronously* on entry.

> **jsdom rabbit-hole guard:** first prove the exact TipTap 2.27.2 `EditorView` can initialize under
> jsdom 25. If the smoke names one absent standard DOM API, add only that API as a typed polyfill in
> `test/setup.ts`, wire it through `vitest.config.ts` `setupFiles`, and rerun. If a second API is absent
> or the smoke still fails, STOP: do not accumulate browser shims. Amend Task 0 for explicit
> Playwright/Vite approval and move this C7.2 mounted proof to a real browser.

- [ ] **Step 1: Prove TipTap can initialize under jsdom before writing the product shell**

`packages/editor-sdk/test/tiptap-jsdom-smoke.test.tsx`:
```tsx
// @vitest-environment jsdom
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(cleanup)

function TiptapJsdomHarness() {
  const editor = useEditor({
    extensions: [StarterKit],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    immediatelyRender: false,
  })
  return editor ? <EditorContent editor={editor} /> : null
}

describe('TipTap jsdom viability', () => {
  it('constructs and mounts an EditorView', async () => {
    render(<TiptapJsdomHarness />)
    await waitFor(() => expect(document.querySelector('.ProseMirror')).not.toBeNull())
  })
})
```

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/tiptap-jsdom-smoke.test.tsx`
Expected: PASS (1 test). This is an environment-viability gate, not the product red test.

- [ ] **Step 2: Write the failing mounted-component contract before `editor.tsx` exists**

`packages/editor-sdk/test/mounted.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tipTapAdapter } from '../src/adapter.ts'
import { MovpEditor } from '../src/editor.tsx'

const BODY_A = tipTapAdapter.encode({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] }],
})
const BODY_B = tipTapAdapter.encode({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bravo' }] }],
})

afterEach(cleanup)

describe('MovpEditor (mounted)', () => {
  it('renders the toolbar and save control once the editor is ready', async () => {
    render(<MovpEditor initialBody={BODY_A} onSave={vi.fn()} onRefresh={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Save content' })).toBeTruthy()
  })

  it('encodes the live document and calls onSave once, even on a double click', async () => {
    const onSave = vi.fn().mockResolvedValue({ status: 'saved', revisionId: 'r1' })
    render(<MovpEditor initialBody={BODY_A} onSave={onSave} onRefresh={vi.fn()} />)
    const save = await screen.findByRole('button', { name: 'Save content' })
    fireEvent.click(save)
    fireEvent.click(save)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const body = onSave.mock.calls[0][0] as string
    expect(tipTapAdapter.decode(body).type).toBe('doc')
    await screen.findByRole('status')
  })

  it('shows the conflict surface when onSave resolves to a conflict', async () => {
    const onSave = vi.fn().mockResolvedValue({ status: 'conflict' })
    render(<MovpEditor initialBody={BODY_A} onSave={onSave} onRefresh={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Refresh and reload latest content' })).toBeTruthy()
  })

  it('requests refresh, then reloads the new body and clears the conflict', async () => {
    const onSave = vi.fn().mockResolvedValue({ status: 'conflict' })
    const onRefresh = vi.fn()
    const { rerender } = render(
      <MovpEditor initialBody={BODY_A} onSave={onSave} onRefresh={onRefresh} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Save content' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh and reload latest content' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    rerender(<MovpEditor initialBody={BODY_B} onSave={onSave} onRefresh={onRefresh} />)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    await waitFor(() => expect(document.body.textContent).toContain('bravo'))
  })

  it('hides the toolbar and save control in read-only mode', async () => {
    render(<MovpEditor initialBody={BODY_A} onSave={vi.fn()} onRefresh={vi.fn()} readOnly />)
    await waitFor(() => expect(document.body.textContent).toContain('alpha'))
    expect(screen.queryByRole('toolbar')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save content' })).toBeNull()
  })
})
```

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/mounted.test.tsx`
Expected: FAIL — cannot resolve `../src/editor.tsx`. This is the C7.2 product red test.

> These assertions use Vitest-core matchers, not `@testing-library/jest-dom`; do not add another dependency.

- [ ] **Step 3: Create the shell**

`packages/editor-sdk/src/editor.tsx`:
```tsx
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useCallback, useEffect, useRef, useState } from 'react'
import { tipTapAdapter } from './adapter.ts'
import { classifySaveOutcome, type SaveHandler, type SaveResult } from './save.ts'
import { ConflictSurface } from './conflict-surface.tsx'
import { Toolbar, type ToolbarActiveState, type ToolbarCommands } from './toolbar.tsx'

export type EditorStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'error'

export interface MovpEditorProps {
  /** stored richtext string for the field this editor occupies */
  initialBody: string
  /** host-provided save; the host calls content.update server-side and returns a SaveResult */
  onSave: SaveHandler
  /** successful revision feedback; retain this as the next content.update expectedRevisionId */
  onSaved?(revisionId: string): void
  /** host-provided reload of the latest content (wired to the conflict Refresh control) */
  onRefresh(): void
  readOnly?: boolean
}

export function MovpEditor({ initialBody, onSave, onSaved, onRefresh, readOnly = false }: MovpEditorProps) {
  const [status, setStatus] = useState<EditorStatus>('idle')
  const savingRef = useRef(false)
  const editor = useEditor({
    extensions: [StarterKit],
    editable: !readOnly,
    immediatelyRender: false, // TipTap 2.27.2 warns on SSR unless false (useEditor.ts:110)
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': 'Rich text editor', 'aria-multiline': 'true' },
    },
  })

  // Load, and reload on refresh: host refetches -> new initialBody -> content reloads + status clears.
  useEffect(() => {
    if (!editor) return
    editor.commands.setContent(tipTapAdapter.decode(initialBody))
    setStatus('idle')
  }, [editor, initialBody])

  useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])

  const save = useCallback(async () => {
    if (!editor || savingRef.current) return
    savingRef.current = true
    setStatus('saving')
    let result: SaveResult
    try {
      result = await onSave(tipTapAdapter.encode(editor.getJSON()))
      if (result.status === 'saved') onSaved?.(result.revisionId)
    } catch (err) {
      result = classifySaveOutcome(err)
    }
    savingRef.current = false
    setStatus(result.status)
  }, [editor, onSave, onSaved])

  if (!editor) return null

  const commands: ToolbarCommands = {
    bold: () => editor.chain().focus().toggleBold().run(),
    h1: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    bullet: () => editor.chain().focus().toggleBulletList().run(),
    undo: () => editor.chain().focus().undo().run(),
    redo: () => editor.chain().focus().redo().run(),
  }
  const active: ToolbarActiveState = {
    bold: editor.isActive('bold'),
    h1: editor.isActive('heading', { level: 1 }),
    bullet: editor.isActive('bulletList'),
  }

  return (
    <div>
      {!readOnly && <Toolbar commands={commands} active={active} />}
      {status === 'conflict' && <ConflictSurface onRefresh={onRefresh} />}
      {status === 'error' && <div role="alert">Save failed. Please try again.</div>}
      <EditorContent editor={editor} />
      {!readOnly && (
        <button type="button" aria-label="Save content" disabled={status === 'saving'} onClick={() => void save()}>
          Save
        </button>
      )}
      {status === 'saved' && <span role="status">Saved</span>}
    </div>
  )
}
```

- [ ] **Step 4: Run the mounted contract to green**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/mounted.test.tsx`
Expected: PASS (5 tests). The jsdom environment was already isolated by the Step 1 smoke, so a
failure here is a product-contract failure rather than an ambiguous harness failure.

- [ ] **Step 5: Write the public-surface barrel test (durable — replaces the deleted scaffold smoke)**

`packages/editor-sdk/test/public-surface.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import * as sdk from '../src/index.ts'

describe('public surface', () => {
  it('exports the documented editor SDK surface', () => {
    expect(typeof sdk.MovpEditor).toBe('function')
    expect(typeof sdk.Toolbar).toBe('function')
    expect(typeof sdk.ConflictSurface).toBe('function')
    expect(typeof sdk.canonicalizeInnerJson).toBe('function')
    expect(typeof sdk.classifySaveOutcome).toBe('function')
    expect(sdk.INNER_CANONICAL_VERSION).toBe(1)
    expect(typeof sdk.tipTapAdapter.encode).toBe('function')
    expect(typeof sdk.tipTapAdapter.decode).toBe('function')
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/public-surface.test.ts`
Expected: FAIL — `src/index.ts` still exports `{}` (Task 1 placeholder).

- [ ] **Step 7: Write the real barrel**

`packages/editor-sdk/src/index.ts` (replaces `export {}`):
```ts
export { canonicalizeInnerJson } from './canonical.ts'
export { INNER_CANONICAL_VERSION, tipTapAdapter, type EditorAdapter, type TipTapDoc } from './adapter.ts'
export { classifySaveOutcome, type SaveHandler, type SaveResult } from './save.ts'
export { Toolbar, type ToolbarActiveState, type ToolbarCommands } from './toolbar.tsx'
export { ConflictSurface } from './conflict-surface.tsx'
export { MovpEditor, type EditorStatus, type MovpEditorProps } from './editor.tsx'
```

- [ ] **Step 8: Add the SSR-safety test** to `packages/editor-sdk/test/presentational.test.tsx`

Add this import to the existing import block at the top of the file:
```tsx
import { MovpEditor } from '../src/editor.tsx'
```

Append only the test block below after the existing `ConflictSurface` tests:
```tsx
describe('MovpEditor SSR safety', () => {
  it('server-renders without TipTap SSR warnings (immediatelyRender:false)', () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)) })
    const warns: string[] = []
    const wspy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warns.push(String(m)) })
    try {
      renderToStaticMarkup(
        <MovpEditor initialBody="" onSave={async () => ({ status: 'saved', revisionId: 'r1' })} onRefresh={() => {}} />,
      )
    } finally {
      spy.mockRestore()
      wspy.mockRestore()
    }
    expect([...errors, ...warns].some((m) => m.includes('SSR'))).toBe(false)
  })
})
```

- [ ] **Step 9: Typecheck and run every Task 6 test**

Run: `pnpm --filter @movp/editor-sdk typecheck`
Expected: PASS.

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/tiptap-jsdom-smoke.test.tsx test/mounted.test.tsx test/public-surface.test.ts test/presentational.test.tsx`
Expected: PASS — jsdom smoke (1) + mounted (5) + public-surface (1) + presentational (3).

- [ ] **Step 10: Sabotage each mounted guard once** (per `sabotage-test-every-gate`)

Temporarily break one subject at a time, run the named test, confirm FAIL, then revert:
- Remove the `savingRef` guard → `test/mounted.test.tsx` fails because `onSave` runs twice.
- Stop resetting status in the refresh effect → `test/mounted.test.tsx` fails because the alert persists.
- Remove `immediatelyRender: false` → `test/presentational.test.tsx` fails on the SSR warning.

After all three reversions, rerun the Step 9 command. Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/editor-sdk/src/editor.tsx packages/editor-sdk/src/index.ts packages/editor-sdk/test/tiptap-jsdom-smoke.test.tsx packages/editor-sdk/test/mounted.test.tsx packages/editor-sdk/test/public-surface.test.ts packages/editor-sdk/test/presentational.test.tsx
git commit -m "feat(editor-sdk): MovpEditor shell, save state machine, public barrel"
```

---

## Task 7: Client-boundary gate

**Files:**
- Create: `packages/editor-sdk/test/boundary.test.ts`

**Interfaces:**
- Produces: a test that walks `packages/editor-sdk/src/` and fails on any forbidden server-only module specifier (in ANY import form) or service-role token. Walking the directory covers new `src/` files automatically (mirrors `scripts/check-boundary.sh`).

> **Why a specifier-grep, not the spike's AST walker:** every import form — `import X from '…'`, side-effect `import '…'`, `import('…')`, `require('…')` — carries the module specifier as a **quoted string**. Matching the forbidden quoted specifier catches all of them, including `@movp/domain/*` subpaths, with far less machinery than an AST parse. Fail-closed is acceptable for a boundary gate: do not write a forbidden specifier as a plain string literal in `src/`.

> **Untrusted-I/O:** the walker uses `lstatSync` and **fails** (not skips) on a symlink — a symlinked source file could otherwise hide a leak from the scan or redirect a read outside the package. It bounds each file's size before reading and reports **paths only**, never file contents (per `untrusted-io-and-resource-bounds`).

- [ ] **Step 1: Write the failing test**

`packages/editor-sdk/test/boundary.test.ts`:
```ts
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))
const MAX_FILE_BYTES = 512 * 1024

// A forbidden module specifier in ANY import form is a quoted string; match it directly.
// Covers side-effect, dynamic, require, and subpaths (@movp/domain/foo). Plus service-role tokens.
const FORBIDDEN =
  /['"](@movp\/(auth|domain|graphql)(\/[^'"]*)?|@supabase[^'"]*|packages\/domain[^'"]*)['"]|service_role|SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE/

function walkRegularFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = lstatSync(p) // lstat: never follow a symlink out of the tree
    if (st.isSymbolicLink()) throw new Error(`boundary: refusing to scan a symlink: ${p}`)
    if (st.isDirectory()) out.push(...walkRegularFiles(p))
    else if (st.isFile() && /\.(ts|tsx)$/.test(name)) {
      if (st.size > MAX_FILE_BYTES) throw new Error(`boundary: ${p} exceeds size bound`)
      out.push(p)
    }
  }
  return out
}

describe('client boundary', () => {
  it('no src file imports server-only modules or references service-role tokens', () => {
    const offenders = walkRegularFiles(SRC).filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it passes on clean source**

Run: `pnpm --filter @movp/editor-sdk exec vitest run test/boundary.test.ts`
Expected: PASS (1 test) — current `src/` is clean.

- [ ] **Step 3: Sabotage — prove each false-green path the old regex missed goes red** (per `sabotage-test-every-gate`)

Run each of these edits to `packages/editor-sdk/src/adapter.ts` (top of file), confirm FAIL, then revert:
- Static subpath: `import { x } from '@movp/domain/content'`
- Side-effect: `import '@movp/auth'`
- Dynamic: `const m = import('@supabase/supabase-js')`
- GraphQL: `import { y } from '@movp/graphql'`

Each must make the test FAIL with `src/adapter.ts` in `offenders`. Revert after each.

- [ ] **Step 4: Commit**

```bash
git add packages/editor-sdk/test/boundary.test.ts
git commit -m "test(editor-sdk): client/server boundary gate over src/"
```

---

## Task 8: Register with release + version gates

**Files:**
- Modify: `scripts/check-package-artifacts.mjs:6-20` (the `publishable` array)
- Modify: `scripts/check-publishable-versions.mjs:11-14` (the `PUBLISHABLE` array)
- Modify: `.github/workflows/ci.yml` (required `c7-editor-sdk` package-test job)
- Modify: `scripts/check-ci-wiring.mjs` (`REQUIRED_JOBS` entry)
- Modify: `scripts/test/check-ci-wiring.test.mjs` (missing-step sabotage regression)

**Interfaces:**
- Produces: `@movp/editor-sdk` is a first-class publishable package (built `dist/` asserted, version pinned to `0.1.0`).

- [ ] **Step 1: Build ALL packages, then verify this one emits `dist/`**

> `pnpm check:packages` packs EVERY publishable package and asserts each has a built `dist/`, so the whole graph must be built first — a single-package `--filter build` leaves the others' `dist/` absent on a clean worktree.

Run: `pnpm build`
Expected: succeeds; `packages/editor-sdk/dist/index.js` + `index.d.ts` (+ sourcemap) exist. If `--dts` errors on the `.tsx` graph, that is a TS error to fix, not a config workaround.

- [ ] **Step 2: Add to the artifact check** — insert `'editor-sdk'` (alphabetical) into `publishable` in `scripts/check-package-artifacts.mjs`:

```js
const publishable = [
  'auth',
  'cli',
  'codegen',
  'core-schema',
  'create-movp',
  'domain',
  'editor-sdk',
  'flows',
  'graphql',
  'mcp',
  'notifications',
  'obs',
  'platform',
  'search',
]
```

- [ ] **Step 3: Add to the publishable-version gate** — insert `'editor-sdk'` into `PUBLISHABLE` in `scripts/check-publishable-versions.mjs`:

```js
export const PUBLISHABLE = [
  'auth', 'cli', 'codegen', 'core-schema', 'domain', 'editor-sdk', 'flows',
  'graphql', 'mcp', 'notifications', 'obs', 'platform', 'search',
]
```

- [ ] **Step 4: Arm the package tests in CI**

Add a `c7-editor-sdk` job that performs checkout, pinned pnpm/Node setup, frozen install, then runs exactly:

```yaml
- run: pnpm --filter @movp/editor-sdk test
```

Register that exact command under `REQUIRED_JOBS['c7-editor-sdk']`. Add a checker test that removes the run line
from a fixture and requires `ci_wiring_run_missing`; this is the permanent sabotage proof that the seam audit cannot
become inert while CI remains green.

- [ ] **Step 5: Run the gates**

Run: `pnpm check:publishable-versions`
Expected: PASS — `all N @movp publishables at 0.1.0, no 0.0.0 consumer pins` (N incremented by one). If it prints `@movp/editor-sdk is <x>, expected 0.1.0`, fix the package version.

Run: `pnpm check:packages`
Expected: PASS — packed `@movp/editor-sdk` contains `package/dist/` and its manifest `exports` point at `./dist/*`, not source.

> The complete generic artifact path in `scripts/check-package-artifacts.mjs` has been inspected:
> it requires `dist/` plus packed `dist` exports. The additional branches are scoped only to
> `platform`, `create-movp`, and `search`; none applies to `editor-sdk`. Keep PASS as the exact expectation.

Run: `pnpm check:ci-wiring`
Expected: PASS. The dedicated `c7-editor-sdk` job must run `pnpm --filter @movp/editor-sdk test`, and `REQUIRED_JOBS` plus its sabotage test must fail if that invocation is removed. Root typecheck continues to cover the package through `turbo run typecheck`.

- [ ] **Step 6: Full local verification of the package**

Run: `pnpm --filter @movp/editor-sdk test && pnpm --filter @movp/editor-sdk typecheck`
Expected: PASS — **33 tests across 8 files**: canonical 10, adapter 7, save 4, presentational 3, public-surface 1, jsdom smoke 1, mounted 6, boundary 1; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml scripts/check-package-artifacts.mjs scripts/check-publishable-versions.mjs scripts/check-ci-wiring.mjs scripts/test/check-ci-wiring.test.mjs
git commit -m "chore(editor-sdk): register with release and version gates"
```

---

## Task 9: Retire the C7.1 harness; update roadmap + stack

**Files:**
- Delete: `spikes/editor/` (tracked C7.1 harness source and nested lockfile)
- Modify/verify: `docs/superpowers/specs/2026-07-15-c7.1-editor-spike-design.md` (historical reproduction pin)
- Modify: `docs/superpowers/plans/README.md` (Stage C status row for C7)
- Modify: `CLAUDE.md` (stack note)

**Interfaces:**
- Consumes: the migrated canonical, adapter, mounted, boundary, bundle/license decision, and package gates.
- Preserves: `docs/superpowers/specs/2026-07-15-c7.1-editor-spike-design.md` and
  `docs/superpowers/specs/2026-07-15-c7.1-editor-spike-report.md` as the durable C7.1 evidence.

> **Why deletion is authorized:** the approved C7.1 design §10 says the harness remains only until
> the winning adapter contract migrates into `@movp/editor-sdk`, then full removal happens in C7.2.
> This task runs only after Tasks 2–8 prove that replacement. Do not delete either durable spec/report.

- [ ] **Step 1: Prove the durable evidence and replacement gates exist before deleting**

Run:
```bash
test -f docs/superpowers/specs/2026-07-15-c7.1-editor-spike-design.md
test -f docs/superpowers/specs/2026-07-15-c7.1-editor-spike-report.md
pnpm --filter @movp/editor-sdk test
pnpm --filter @movp/editor-sdk typecheck
```
Expected: both file checks exit 0; editor SDK reports 32 passing tests and clean typecheck.

- [ ] **Step 2: Remove the tracked spike harness**

Run: `git rm -r spikes/editor`

Expected: every tracked path under `spikes/editor/` is staged as deleted. Ignored local `node_modules`
may remain on disk; they are not source or repository state and are not a reason to weaken the git gate.

- [ ] **Step 3: Prove only deletions are staged under the retired harness**

Run: `git diff --cached --name-status --diff-filter=ACMRTUXB -- spikes/editor`
Expected: empty output — there are no added, copied, modified, renamed, type-changed, unmerged, or broken-pair paths.

Run: `git diff --cached --name-only --diff-filter=D -- spikes/editor`
Expected: non-empty output listing the retired tracked harness files.

- [ ] **Step 4: Pin the preserved design's reproduction instructions to the historical harness snapshot**

In `docs/superpowers/specs/2026-07-15-c7.1-editor-spike-design.md` §10, retain the
authorized-removal sentence and ensure the clean-clone block is immediately preceded by:

```md
After that retirement, historical reproduction remains available from the immutable C7.1
evidence snapshot `5615b265da6810b764dd53669b3108a09ad6dc34`, which contains both the
complete harness and the generated report. Run the block below only from an isolated worktree
checked out at that commit; the current post-C7.2 tree intentionally has no `spikes/editor/`.

**Historical clean-clone reproduction (must succeed end-to-end in that snapshot):**
```

Do not leave the former heading `Clean-clone reproduction (must succeed end-to-end)` claiming
that the deleted harness remains runnable from the current tree.

Run: `git cat-file -e 5615b265da6810b764dd53669b3108a09ad6dc34:spikes/editor/package.json && git cat-file -e 5615b265da6810b764dd53669b3108a09ad6dc34:docs/superpowers/specs/2026-07-15-c7.1-editor-spike-report.md`
Expected: exit 0 — the pinned snapshot contains both artifacts.

- [ ] **Step 5: Update the authoritative Stage C status row** in `docs/superpowers/plans/README.md`

Find:
```
> | C7 Inline Editing & Delivery | breakdown + `2026-07-15-c7.1-editor-dependency-spike.md` | 🟡 C7.1 EXECUTED (TipTap selected under permissive-only; C7.2–C7.7 pending) |
```
Replace with:
```
> | C7 Inline Editing & Delivery | breakdown + `2026-07-15-c7.1-editor-dependency-spike.md` + `2026-07-16-movp-stage-c-07b-editor-sdk.md` | 🟡 C7.1–C7.2 EXECUTED (`@movp/editor-sdk` client-safe TipTap editor; C7.1 harness retired; C7.3–C7.7 pending) |
```

- [ ] **Step 6: Add a stack note to `CLAUDE.md`** under "Schema Productization"

```md
- `@movp/editor-sdk` is the client-safe embeddable rich-text editor (TipTap, permissive-only). It NEVER imports
  `@movp/domain`/`@movp/auth`/`@movp/graphql`/`@supabase`; the host injects `onSave` and the SDK recognizes a
  `content_update_conflict` by string shape only. `packages/editor-sdk/test/boundary.test.ts` is the seam audit.
```

- [ ] **Step 7: Run the final C7.2 gate after retirement**

Run:
```bash
pnpm --filter @movp/editor-sdk test
pnpm --filter @movp/editor-sdk typecheck
pnpm check:publishable-versions
pnpm check:packages
pnpm check:ci-wiring
pnpm check:docs
```
Expected: all commands exit 0; removing the isolated spike does not affect production package
resolution or required documentation. `check:docs` does not validate arbitrary Markdown links;
the explicit §10 historical-snapshot amendment above is the dangling-reference guard.

- [ ] **Step 8: Commit the completion signal with the retirement**

```bash
git add docs/superpowers/specs/2026-07-15-c7.1-editor-spike-design.md docs/superpowers/plans/README.md CLAUDE.md
git commit -m "chore(editor-sdk): retire spike harness and record C7.2 execution"
```

Run: `test -z "$(git ls-files spikes/editor)"`
Expected: exit 0 — no retired harness path remains tracked.

---

## Definition of Done (C7.2)

- Dependency approval obtained before install (Task 0).
- `@movp/editor-sdk` exists as a publishable workspace package at `0.1.0`, installs, builds to `dist/`, and typechecks.
- Public surface exports: `MovpEditor`, `EditorStatus`, `MovpEditorProps`, `tipTapAdapter`, `canonicalizeInnerJson`, `INNER_CANONICAL_VERSION`, `classifySaveOutcome`, `SaveResult`/`SaveHandler`, `Toolbar`, `ConflictSurface`, `EditorAdapter`, `TipTapDoc`, `ToolbarCommands`, `ToolbarActiveState`.
- **33 tests green across 8 files:** canonical byte-stability (ported §5.2), adapter shape-validation + idempotency, normalized `classifySaveOutcome` (no message leak), presentational a11y + SSR safety, durable public-surface barrel, jsdom viability, mounted render/save/revision-feedback/conflict/refresh/read-only, client-boundary walk.
- The editor mounts, saves via injected `onSave`, prevents concurrent saves, surfaces conflict, and reloads on refresh — all proven mounted.
- Client boundary proven (no `@movp/domain|auth|graphql`, `@supabase`, or service-role token in `src/`) and sabotage-verified against every import form.
- `pnpm check:packages`, `pnpm check:publishable-versions`, `pnpm check:ci-wiring` pass; roadmap + stack docs updated in the landing commit.
- The tracked `spikes/editor/` harness is retired only after its adapter/mount/boundary contracts migrate; the durable design and report remain committed.
- **Deferred to C7.3:** binding `onSave` to `content.update` + GraphQL, the real keystroke-driven edit, and the two-editor live-DB 409/refresh e2e (Playwright).

## Eight-Dimension self-check (author)

- **Correctness** — canonical algorithm ported verbatim with its full proven suite; adapter idempotency + top-level shape validation asserted; `SaveResult`/`EditorStatus` are closed unions; the C7.2 render requirement is met by a mounted jsdom gate, not deferred.
- **Safety** — the SDK cannot reach secrets/DB: a boundary walk over `src/` bans `@movp/domain|auth|graphql`, `@supabase*` (incl. subpaths, every import form), and service-role tokens; sabotage-verified. New production deps require an explicit approval stop (Task 0).
- **Reliability** — save failures are classified (retryable `conflict` vs terminal `error`); `onSave` rejection is caught; concurrent saves are ref-guarded; refresh imperatively reloads; malformed persisted bodies are rejected with a stable code, not crashed into TipTap.
- **Observability** — failures normalize to allowlisted codes (`save_failed`); the boundary gate and adapter report **paths/codes only**, never file or error contents (no-leak test asserts this).
- **Efficiency** — canonical/adapter/save are single-sourced and reused by the shell; no jsdom infra on the pure tests (server-render for presentational); jsdom is scoped per-file to the viability and mounted contracts that need it.
- **Performance** — React/`react-dom` are **peer** deps (no bundled duplicate); TipTap is the spike-measured set; tsup externalizes deps; `immediatelyRender:false` avoids an SSR hydration mismatch.
- **Simplicity** — one status enum + one ref guard, no reducer; boundary gate is a specifier-grep, not an AST walker; shape validation is top-level only (deeper node validation declined as YAGNI).
- **Usability** — toolbar + conflict surface + save/error/saved states carry explicit ARIA roles/labels; Save disables while pending; terminal errors announce via `role="alert"`; conflict is a `role="alert"` with a labeled refresh control.
