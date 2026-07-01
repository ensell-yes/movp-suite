# MOVP Core — Search & Async (Embeddings, Durable Jobs, Flows, Notifications) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the async backbone of MOVP Core — chunked semantic indexing (`@movp/search`), a provider-agnostic notifier (`@movp/notifications`, Resend default), and a durable job/flow engine (`@movp/flows`) over the `movp_internal.movp_jobs` queue — then wire `note.created → notify` end-to-end through two Supabase Edge Function workers.

**Architecture:** `movp_internal` is NOT exposed to PostgREST, so all application-side queue access goes through **`public` SECURITY DEFINER RPCs granted to `service_role`** (`enqueue_job`, `claim_jobs`, `complete_job`, `replay_jobs`, `reindex_collection`, `replace_search_chunks`, `emit_event`). `claim_jobs` returns `jsonb` instead of a composite type from `movp_internal`, avoiding PostgREST serialization risk for an unexposed schema. In-DB triggers (the embed-enqueue trigger from Plan 2, and the `note.created` lifecycle trigger added here) write the internal queue directly. Two edge workers, invoked every minute by `pg_cron`, drain the queue: `index-embeddings` (kind `embed`) chunks + embeds first, then atomically replaces a row's `search_chunk` rows in one DB RPC; `flows` (kinds `webhook`/`notify`) delivers with bounded retry + DLQ. The same Deno-only `GteSmallProvider` is also wired into the GraphQL and MCP edge contexts from Plan 4, making semantic/hybrid search reachable through user-facing surfaces. Jobs are idempotent (`unique(kind, idempotency_key)` + `content_hash`), crash-safe (lease + reclaim of expired `running`), and replayable.

**Tech Stack:** TypeScript, `@supabase/supabase-js` (service-role client), Supabase Edge Functions (Deno) + `Supabase.ai` `gte-small`, `pg_cron`, Vitest + `msw`, pgTAP.

**This is Plan 5 of the Phase 1 (MOVP Core) series** (design Build-sequence Tasks 9–10). Depends on Plan 1 (tenancy/auth), Plan 2 (shared infra: `movp_internal.movp_jobs`, `public.search_chunk`, `public.match_chunks`, the embeddable enqueue/delete triggers), and Plan 3 (`@movp/domain` defines `EmbeddingProvider`). Plan 4's CLI exposes injectable `jobs.replay/reindex` handlers that this plan fills.

## Global Constraints

- **Runtime-agnostic vs Deno-only split:** `chunkText`, `ResendAdapter`, and the `@movp/flows` query helpers are runtime-agnostic (bare specifiers, web APIs) and unit-tested in Node. `GteSmallProvider` uses the Deno-only `Supabase.ai` global and lives in its own module (`src/gte-small.ts`), constructed lazily at call time — it is exercised only in the edge integration gate, never imported by a Node test. A `FakeEmbeddingProvider` backs Node/integration tests.
- **`movp_internal` access only via `public` SECURITY DEFINER RPCs** (granted `service_role` only) or in-DB triggers. Never `db.schema('movp_internal')` from app code — PostgREST cannot reach it (Plan 2 excluded it from `config.toml [api] schemas`). RPCs exposed through PostgREST return public scalar/JSON shapes, not composites defined in `movp_internal`.
- **All SECURITY DEFINER functions hardened:** `set search_path = ''`, every object schema-qualified, `execute` revoked from `public`/`anon`/`authenticated`, granted to `service_role`.
- **Service-role client only on out-of-band paths** (the two workers, CLI admin) — never on a user request path.
- **Idempotent side effects:** the embed worker computes embeddings first, then calls `replace_search_chunks` so the field's old chunks are replaced transactionally; job insert uses `on conflict (kind, idempotency_key) do nothing`.
- **Bounded retry, no thundering herd:** exponential backoff `next_run_at = now() + 2^attempts seconds`; `attempts >= max_attempts → status='dead'` (DLQ).
- **Observability discipline:** workers log `error_code` + ids, never payload/PII values.
- **Supabase CLI is the only migration applier.** Migrations are plain SQL in `supabase/migrations/`.

## File Structure

```
supasuite/
  supabase/
    migrations/
      <ts>_async_rpcs.sql        # movp_events, webhooks, the 7 public SECURITY DEFINER RPCs, note lifecycle trigger
    tests/
      jobs_test.sql              # pgTAP: claim lease/reclaim, backoff/DLQ, deny-all RLS, RPCs service-role-only
    functions/
      index-embeddings/index.ts  # embed worker (Deno)
      flows/index.ts             # webhook/notify worker (Deno)
  packages/
    search/
      package.json · tsconfig.json · vitest.config.ts
      src/{index.ts, chunk.ts, fake.ts, gte-small.ts}
      test/chunk.test.ts
    notifications/
      package.json · tsconfig.json · vitest.config.ts
      src/{index.ts, resend.ts}
      test/resend.test.ts
    flows/
      package.json · tsconfig.json · vitest.config.ts
      src/{index.ts, jobs.ts, events.ts}
      test/jobs.test.ts          # integration against the local stack
```

---

### Task 1: `@movp/search` — `chunkText` + `FakeEmbeddingProvider`

**Files:**
- Create: `packages/search/package.json`, `packages/search/tsconfig.json`, `packages/search/vitest.config.ts`
- Create: `packages/search/src/chunk.ts`, `packages/search/src/fake.ts`, `packages/search/src/index.ts`
- Test: `packages/search/test/chunk.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider` from `@movp/domain` (`interface EmbeddingProvider { embed(text: string): Promise<number[]> }`).
- Produces: `chunkText(text: string, opts?: { tokens?: number; overlapPct?: number }): string[]`; `class FakeEmbeddingProvider implements EmbeddingProvider`.

- [ ] **Step 1: Create the package skeleton**

`packages/search/package.json`:
```json
{
  "name": "@movp/search",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./gte-small": "./src/gte-small.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@movp/domain": "workspace:*" },
  "devDependencies": { "vitest": "^2.1.0" }
}
```

`packages/search/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/search/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node' } })
```

Run: `pnpm install`
Expected: workspace links `@movp/domain`.

- [ ] **Step 2: Write the failing test**

`packages/search/test/chunk.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { chunkText, FakeEmbeddingProvider } from '../src/index.ts'

describe('chunkText', () => {
  it('returns [] for empty/whitespace', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n ')).toEqual([])
  })

  it('keeps short text as a single chunk', () => {
    expect(chunkText('Hello world. Short note.')).toEqual(['Hello world. Short note.'])
  })

  it('splits long text into multiple ~token-bounded chunks with overlap', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} has some filler words here.`)
    const text = sentences.join(' ')
    const chunks = chunkText(text, { tokens: 50, overlapPct: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    // every chunk is within budget (word-approximation of tokens)
    for (const c of chunks) expect(c.split(/\s+/).length).toBeLessThanOrEqual(50)
    // overlap: consecutive chunks share trailing/leading words
    const firstTail = chunks[0].split(/\s+/).slice(-5).join(' ')
    expect(chunks[1]).toContain(firstTail.split(/\s+/)[0])
  })

  it('places a phrase that appears past the first chunk into a later chunk', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Filler sentence ${i}.`).join(' ')
    const text = `${filler} The unique marker phrase appears here near the end.`
    const chunks = chunkText(text, { tokens: 50, overlapPct: 15 })
    expect(chunks.some((c) => c.includes('unique marker phrase'))).toBe(true)
    expect(chunks[0].includes('unique marker phrase')).toBe(false)
  })
})

describe('FakeEmbeddingProvider', () => {
  it('returns a deterministic, normalized 384-d vector', async () => {
    const p = new FakeEmbeddingProvider()
    const a = await p.embed('hello')
    const b = await p.embed('hello')
    expect(a).toHaveLength(384)
    expect(a).toEqual(b)
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @movp/search test`
Expected: FAIL — cannot resolve `../src/index.ts` / `chunkText` not defined.

- [ ] **Step 4: Implement**

`packages/search/src/chunk.ts`:
```ts
// Runtime-agnostic. Token count is approximated by word count (gte-small truncates
// at 512 tokens; default 400-word chunks stay safely under that).
export function chunkText(
  text: string,
  opts: { tokens?: number; overlapPct?: number } = {},
): string[] {
  const maxTokens = opts.tokens ?? 400
  const overlap = Math.floor((maxTokens * (opts.overlapPct ?? 15)) / 100)
  const clean = text.trim()
  if (!clean) return []

  const sentences = clean.split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let cur: string[] = []
  const flush = () => {
    if (cur.length) chunks.push(cur.join(' '))
  }
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean)
    if (cur.length > 0 && cur.length + words.length > maxTokens) {
      flush()
      cur = overlap > 0 ? cur.slice(Math.max(0, cur.length - overlap)) : []
    }
    cur.push(...words)
  }
  flush()
  return chunks
}
```

`packages/search/src/fake.ts`:
```ts
import type { EmbeddingProvider } from '@movp/domain'

// Deterministic bag-of-chars embedding for tests. Same text → same vector → distance 0.
export class FakeEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(384).fill(0)
    for (let i = 0; i < text.length; i++) v[i % 384] += text.charCodeAt(i)
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
    return v.map((x) => x / norm)
  }
}
```

`packages/search/src/index.ts`:
```ts
export { chunkText } from './chunk.ts'
export { FakeEmbeddingProvider } from './fake.ts'
// NOTE: GteSmallProvider is exported via the '@movp/search/gte-small' subpath ONLY
// (Deno-only; importing it in Node would touch the Supabase.ai global). See Task 2.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @movp/search test`
Expected: PASS — all cases green.

- [ ] **Step 6: Commit**

```bash
git add packages/search
git commit -m "feat(search): chunkText + FakeEmbeddingProvider"
```

---

### Task 2: `@movp/search` — `GteSmallProvider` (Deno-only)

**Files:**
- Create: `packages/search/src/gte-small.ts`
- Test: `packages/search/test/gte-small.contract.test.ts`
- Edit: `supabase/functions/graphql/index.ts`, `supabase/functions/mcp/index.ts`, their `deno.json` import maps

**Interfaces:**
- Consumes: `EmbeddingProvider` from `@movp/domain`; the Deno `Supabase.ai` global (edge runtime only).
- Produces: `class GteSmallProvider implements EmbeddingProvider` (exported at subpath `@movp/search/gte-small`); GraphQL/MCP edge contexts include `embedder: new GteSmallProvider()` so `mode:'semantic'|'hybrid'` works through both surfaces.

- [ ] **Step 1: Write the failing test (structural/contract — no Deno global in Node)**

`packages/search/test/gte-small.contract.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'

describe('GteSmallProvider', () => {
  it('lazily constructs the session at call time and returns its run() output', async () => {
    const run = vi.fn(async () => new Array(384).fill(0.1))
    const Session = vi.fn(() => ({ run }))
    // inject the Deno-only global before importing the module
    ;(globalThis as unknown as { Supabase: unknown }).Supabase = { ai: { Session } }
    const { GteSmallProvider } = await import('../src/gte-small.ts')

    const p = new GteSmallProvider()
    expect(Session).not.toHaveBeenCalled() // lazy: nothing on construction
    const v = await p.embed('hello')
    expect(Session).toHaveBeenCalledWith('gte-small')
    expect(run).toHaveBeenCalledWith('hello', { mean_pool: true, normalize: true })
    expect(v).toHaveLength(384)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @movp/search test gte-small`
Expected: FAIL — cannot resolve `../src/gte-small.ts`.

- [ ] **Step 3: Implement**

`packages/search/src/gte-small.ts`:
```ts
import type { EmbeddingProvider } from '@movp/domain'

// The Supabase.ai global exists ONLY on the Supabase Edge (Deno) runtime.
declare const Supabase: {
  ai: { Session: new (model: string) => { run(text: string, opts: { mean_pool: boolean; normalize: boolean }): Promise<number[]> } }
}

export class GteSmallProvider implements EmbeddingProvider {
  #session: { run(t: string, o: { mean_pool: boolean; normalize: boolean }): Promise<number[]> } | null = null

  async embed(text: string): Promise<number[]> {
    // Resolve the runtime dependency at CALL TIME (never at module/construction scope).
    this.#session ??= new Supabase.ai.Session('gte-small')
    return await this.#session.run(text, { mean_pool: true, normalize: true }) // 384-dim
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @movp/search test gte-small`
Expected: PASS.

- [ ] **Step 5: Wire GraphQL/MCP edge functions to the provider**

Edit `supabase/functions/graphql/index.ts`:
```ts
import { GteSmallProvider } from '@movp/search/gte-small'
```

Then change the Yoga handoff:
```ts
return yoga.handleRequest(yogaReq, {
  db: principal.db,
  userId: principal.userId,
  embedder: new GteSmallProvider(),
})
```

Edit `supabase/functions/mcp/index.ts`:
```ts
import { GteSmallProvider } from '@movp/search/gte-small'
```

Then change server construction:
```ts
const server = buildMcpServer(schema, {
  db: principal.db,
  userId: principal.userId,
  embedder: new GteSmallProvider(),
})
```

Confirm both function import maps contain:
```json
"@movp/search/gte-small": "../../../packages/search/src/gte-small.ts"
```

Expected: `supabase functions serve graphql mcp` starts without unmapped-specifier errors, and a GraphQL `search(workspaceId, query, mode:"semantic")` no longer throws `requires opts.embedder`.

- [ ] **Step 6: Commit**

```bash
git add packages/search/src/gte-small.ts packages/search/test/gte-small.contract.test.ts supabase/functions/graphql supabase/functions/mcp
git commit -m "feat(search): GteSmallProvider (Deno edge, lazy session)"
```

---

### Task 3: `@movp/notifications` — `ResendAdapter`

**Files:**
- Create: `packages/notifications/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/notifications/src/resend.ts`, `packages/notifications/src/index.ts`
- Test: `packages/notifications/test/resend.test.ts`

**Interfaces:**
- Consumes: the global `fetch`.
- Produces: `interface NotificationMessage { to: string; subject: string; html: string; from?: string }`; `interface NotificationProvider { send(msg: NotificationMessage): Promise<{ id: string }> }`; `escapeHtml(input: string): string`; `class ResendAdapter implements NotificationProvider`.

- [ ] **Step 1: Create the package skeleton**

`packages/notifications/package.json`:
```json
{
  "name": "@movp/notifications",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "devDependencies": { "vitest": "^2.1.0", "msw": "^2.4.0" }
}
```

`packages/notifications/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/notifications/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node' } })
```

Run: `pnpm install`
Expected: installs `msw`.

- [ ] **Step 2: Write the failing test**

`packages/notifications/test/resend.test.ts`:
```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { ResendAdapter, escapeHtml } from '../src/index.ts'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('ResendAdapter', () => {
  it('POSTs to the Resend API and returns the id', async () => {
    let seen: { auth: string | null; body: unknown } = { auth: null, body: null }
    server.use(
      http.post('https://api.resend.com/emails', async ({ request }) => {
        seen = { auth: request.headers.get('Authorization'), body: await request.json() }
        return HttpResponse.json({ id: 're_123' })
      }),
    )
    const r = await new ResendAdapter('re_test_key').send({
      to: 'a@example.com', subject: 'Hi', html: '<p>Hi</p>',
    })
    expect(r).toEqual({ id: 're_123' })
    expect(seen.auth).toBe('Bearer re_test_key')
    expect(seen.body).toMatchObject({ to: 'a@example.com', subject: 'Hi' })
  })

  it('throws a bounded error code on a 5xx', async () => {
    server.use(http.post('https://api.resend.com/emails', () => new HttpResponse(null, { status: 502 })))
    await expect(new ResendAdapter('k').send({ to: 'a@example.com', subject: 's', html: 'h' }))
      .rejects.toThrow('resend_send_failed:502')
  })

  it('rejects an empty api key', () => {
    expect(() => new ResendAdapter('')).toThrow('resend_missing_api_key')
  })

  it('escapes user-controlled text before rendering notification HTML', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @movp/notifications test`
Expected: FAIL — cannot resolve `../src/index.ts`.

- [ ] **Step 4: Implement**

`packages/notifications/src/resend.ts`:
```ts
export interface NotificationMessage { to: string; subject: string; html: string; from?: string }
export interface NotificationProvider { send(msg: NotificationMessage): Promise<{ id: string }> }

const DEFAULT_FROM = 'MOVP <notifications@movp.dev>'

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export class ResendAdapter implements NotificationProvider {
  #key: string
  constructor(apiKey: string) {
    if (!apiKey) throw new Error('resend_missing_api_key')
    this.#key = apiKey
  }
  async send(msg: NotificationMessage): Promise<{ id: string }> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: msg.from ?? DEFAULT_FROM, to: msg.to, subject: msg.subject, html: msg.html }),
    })
    if (!res.ok) throw new Error(`resend_send_failed:${res.status}`) // bounded code, no body
    const json = (await res.json()) as { id: string }
    return { id: json.id }
  }
}
```

`packages/notifications/src/index.ts`:
```ts
export { ResendAdapter, escapeHtml } from './resend.ts'
export type { NotificationMessage, NotificationProvider } from './resend.ts'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @movp/notifications test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/notifications
git commit -m "feat(notifications): provider interface + ResendAdapter"
```

---

### Task 4: Async RPC migration — events, webhooks, queue RPCs, `note.created` trigger

**Files:**
- Create: `supabase/migrations/<timestamp>_async_rpcs.sql`
- Test: `supabase/tests/jobs_test.sql` (pgTAP)

**Interfaces:**
- Consumes (Plan 2): `movp_internal` schema, `movp_internal.movp_jobs`, `public.note`, `public.search_chunk`, `extensions.digest` (pgcrypto), `public.workspace`.
- Produces (relied on by `@movp/flows` and the workers):
  - Tables `movp_internal.movp_events`, `movp_internal.webhooks` (both deny-all RLS, `service_role`-only).
  - RPCs (all `SECURITY DEFINER`, `set search_path=''`, `execute` → `service_role` only):
    `public.enqueue_job(job_kind text, idem_key text, payload jsonb, ws uuid) returns void`;
    `public.claim_jobs(job_kind text, lim int) returns jsonb`;
    `public.complete_job(job_id uuid, ok boolean, err_code text) returns void`;
    `public.dead_job(job_id uuid, err_code text) returns void`;
    `public.replay_jobs(job_kind text, only_dead boolean) returns int`;
    `public.reindex_collection(coll text) returns int`;
    `public.replace_search_chunks(src_table text, src_id uuid, src_field text, ws uuid, hash text, chunks jsonb) returns void`;
    `public.emit_event(ev_type text, ws uuid, payload jsonb, trace text) returns void`.
  - `AFTER INSERT` trigger `note_created_after_insert` on `public.note` → `movp_internal.on_note_created()` → `public.emit_event('note.created', …)`.

> **Coupling note (must match Plan 2):** the embed idempotency key format here and in Plan 2's embeddable enqueue trigger MUST be identical: `source_table || ':' || source_id || ':' || field || ':' || content_hash` with `content_hash = encode(extensions.digest(coalesce(<field>,''),'sha256'),'hex')`. If Plan 2 used a different format, align both during reconciliation.

- [ ] **Step 1: Write the failing pgTAP test**

`supabase/tests/jobs_test.sql`:
```sql
begin;
select plan(12);

-- structure
select has_table('movp_internal', 'movp_events', 'movp_events table exists');
select has_table('movp_internal', 'webhooks', 'webhooks table exists');
select has_function('public', 'claim_jobs', array['text','integer'], 'claim_jobs exists');
select has_function('public', 'complete_job', array['uuid','boolean','text'], 'complete_job exists');

-- RPCs are service-role only (authenticated must NOT have execute)
select is(
  has_function_privilege('authenticated', 'public.claim_jobs(text,integer)', 'execute'),
  false, 'authenticated cannot execute claim_jobs');
select is(
  has_function_privilege('service_role', 'public.claim_jobs(text,integer)', 'execute'),
  true, 'service_role can execute claim_jobs');

-- enqueue a job, claim it (sets running + lease + attempts=1)
insert into public.workspace (id, name) values ('22222222-2222-2222-2222-222222222222','WS');
select public.enqueue_job('webhook', 'k1', '{"x":1}'::jsonb, '22222222-2222-2222-2222-222222222222');
select is(jsonb_array_length(public.claim_jobs('webhook', 10)), 1, 'claim returns the due job');
select is((select status from movp_internal.movp_jobs where idempotency_key='k1'),
          'running', 'claimed job is running');
select isnt((select lease_expires_at from movp_internal.movp_jobs where idempotency_key='k1'),
            null, 'claimed job has a lease expiry');

-- lease/reclaim (gate e): an active lease blocks reclaim; an expired lease is reclaimed
select is(jsonb_array_length(public.claim_jobs('webhook', 10)),
          0, 'active lease blocks reclaim');
update movp_internal.movp_jobs set lease_expires_at = now() - interval '1 minute' where idempotency_key='k1';
select is(jsonb_array_length(public.claim_jobs('webhook', 10)),
          1, 'expired lease is reclaimed (crash recovery)');

-- backoff to failed, then exhaust attempts → dead (DLQ)
update movp_internal.movp_jobs set attempts = max_attempts where idempotency_key='k1';
select public.complete_job((select id from movp_internal.movp_jobs where idempotency_key='k1'), false, 'boom');
select is((select status from movp_internal.movp_jobs where idempotency_key='k1'),
          'dead', 'exhausted job is dead-lettered');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

Run: `supabase test db`
Expected: FAIL — `function public.claim_jobs(text, integer) does not exist`.

- [ ] **Step 3: Write the migration**

Run: `supabase migration new async_rpcs`
Put this in the created file:
```sql
-- ── tables (internal, deny-all RLS, service-role only) ───────────────────────
create table movp_internal.movp_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  workspace_id uuid references public.workspace(id) on delete cascade,
  payload jsonb not null default '{}',
  trace_id text,
  created_at timestamptz not null default now()
);
create table movp_internal.webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  event_type text not null,
  url text not null,
  secret text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table movp_internal.movp_events enable row level security;
alter table movp_internal.webhooks   enable row level security;
revoke all on movp_internal.movp_events from anon, authenticated;
revoke all on movp_internal.webhooks   from anon, authenticated;
grant all on movp_internal.movp_events to service_role;
grant all on movp_internal.webhooks   to service_role;

-- ── queue RPCs (SECURITY DEFINER, pinned search_path, service-role only) ──────
create or replace function public.enqueue_job(job_kind text, idem_key text, payload jsonb, ws uuid)
returns void language sql security definer set search_path = '' as $$
  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
  values (job_kind, idem_key, payload, ws)
  on conflict (kind, idempotency_key) do nothing;
$$;

create or replace function public.claim_jobs(job_kind text, lim int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare claimed jsonb;
begin
  with updated as (
    update movp_internal.movp_jobs j
     set status = 'running',
         locked_by = coalesce(current_setting('application_name', true), 'rpc'),
         locked_at = now(),
         lease_expires_at = now() + interval '5 minutes',
         attempts = j.attempts + 1, updated_at = now()
   where j.id in (
     select c.id from movp_internal.movp_jobs c
      where c.kind = job_kind
        and ( (c.status in ('pending','failed') and c.next_run_at <= now())
              or (c.status = 'running' and c.lease_expires_at < now()) )  -- reclaim crashed
     order by c.next_run_at
     for update skip locked
     limit lim )
  returning j.id, j.kind, j.idempotency_key, j.payload, j.attempts, j.max_attempts,
            j.status, j.workspace_id, j.locked_by, j.locked_at, j.lease_expires_at
  )
  select coalesce(jsonb_agg(to_jsonb(updated)), '[]'::jsonb) into claimed
    from updated;

  return claimed;
end; $$;

create or replace function public.complete_job(job_id uuid, ok boolean, err_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare j movp_internal.movp_jobs;
begin
  select * into j from movp_internal.movp_jobs where id = job_id;
  if not found then return; end if;
  if ok then
    update movp_internal.movp_jobs set status='done', last_error_code=null, updated_at=now() where id=job_id;
  elsif j.attempts >= j.max_attempts then
    update movp_internal.movp_jobs set status='dead', last_error_code=err_code, updated_at=now() where id=job_id;
  else
    update movp_internal.movp_jobs
       set status='failed', last_error_code=err_code,
           next_run_at = now() + (interval '1 second' * power(2, j.attempts)),  -- bounded backoff
           updated_at=now()
     where id=job_id;
  end if;
end; $$;

create or replace function public.dead_job(job_id uuid, err_code text)
returns void language sql security definer set search_path = '' as $$
  update movp_internal.movp_jobs
     set status='dead', last_error_code=err_code, updated_at=now()
   where id=job_id;
$$;

create or replace function public.replay_jobs(job_kind text, only_dead boolean)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update movp_internal.movp_jobs
     set status='pending', next_run_at=now(), locked_by=null, locked_at=null,
         lease_expires_at=null, updated_at=now()
   where (job_kind is null or kind = job_kind)
     and (case when only_dead then status='dead' else status in ('dead','failed') end);
  get diagnostics n = row_count;
  return n;
end; $$;

create or replace function public.reindex_collection(coll text)
returns int language plpgsql security definer set search_path = '' as $$
declare n int := 0;
begin
  if coll = 'note' then
    insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
    select 'embed',
           'note:' || nt.id::text || ':body:' || encode(extensions.digest(coalesce(nt.body,''),'sha256'),'hex'),
           jsonb_build_object('source_table','note','source_id',nt.id,'field','body',
             'content_hash', encode(extensions.digest(coalesce(nt.body,''),'sha256'),'hex')),
           nt.workspace_id
    from public.note nt
    on conflict (kind, idempotency_key) do nothing;
    get diagnostics n = row_count;
  end if;
  return n;
end; $$;

create or replace function public.replace_search_chunks(
  src_table text, src_id uuid, src_field text, ws uuid, hash text, chunks jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.search_chunk
   where source_table = src_table and source_id = src_id and field = src_field;

  insert into public.search_chunk
    (workspace_id, source_table, source_id, field, chunk_index, content, embedding, content_hash)
  select ws, src_table, src_id, src_field, r.chunk_index, r.content,
         r.embedding::extensions.vector(384), hash
    from jsonb_to_recordset(chunks)
      as r(chunk_index int, content text, embedding text);
end; $$;

create or replace function public.emit_event(ev_type text, ws uuid, payload jsonb, trace text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into movp_internal.movp_events (type, workspace_id, payload, trace_id)
    values (ev_type, ws, payload, coalesce(trace, gen_random_uuid()::text));
  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
    values ('notify', ev_type || ':' || coalesce(payload->>'id', gen_random_uuid()::text),
            payload || jsonb_build_object('event', ev_type), ws)
    on conflict (kind, idempotency_key) do nothing;
  insert into movp_internal.movp_jobs (kind, idempotency_key, payload, workspace_id)
    select 'webhook',
           ev_type || ':' || coalesce(payload->>'id','') || ':' || w.id::text,
           payload || jsonb_build_object('event', ev_type, 'url', w.url, 'secret', w.secret),
           ws
    from movp_internal.webhooks w
    where w.workspace_id = ws and w.event_type = ev_type and w.active
    on conflict (kind, idempotency_key) do nothing;
end; $$;

revoke all on function public.enqueue_job(text,text,jsonb,uuid)  from public, anon, authenticated;
revoke all on function public.claim_jobs(text,int)               from public, anon, authenticated;
revoke all on function public.complete_job(uuid,boolean,text)    from public, anon, authenticated;
revoke all on function public.dead_job(uuid,text)                 from public, anon, authenticated;
revoke all on function public.replay_jobs(text,boolean)          from public, anon, authenticated;
revoke all on function public.reindex_collection(text)           from public, anon, authenticated;
revoke all on function public.replace_search_chunks(text,uuid,text,uuid,text,jsonb) from public, anon, authenticated;
revoke all on function public.emit_event(text,uuid,jsonb,text)   from public, anon, authenticated;
grant execute on function public.enqueue_job(text,text,jsonb,uuid) to service_role;
grant execute on function public.claim_jobs(text,int)             to service_role;
grant execute on function public.complete_job(uuid,boolean,text)  to service_role;
grant execute on function public.dead_job(uuid,text)              to service_role;
grant execute on function public.replay_jobs(text,boolean)        to service_role;
grant execute on function public.reindex_collection(text)         to service_role;
grant execute on function public.replace_search_chunks(text,uuid,text,uuid,text,jsonb) to service_role;
grant execute on function public.emit_event(text,uuid,jsonb,text) to service_role;

-- ── note.created lifecycle trigger (surface-agnostic emission) ────────────────
create or replace function movp_internal.on_note_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event('note.created', new.workspace_id,
    jsonb_build_object('id', new.id, 'title', new.title), gen_random_uuid()::text);
  return new;
end; $$;
create trigger note_created_after_insert
  after insert on public.note
  for each row execute function movp_internal.on_note_created();
```

- [ ] **Step 4: Apply + run the test + drift check**

Run: `supabase db reset && supabase test db && supabase db diff`
Expected: migration applies; `jobs_test.sql .. ok` (12 assertions pass); `db diff` empty.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations supabase/tests/jobs_test.sql
git commit -m "feat(db): async queue RPCs, events/webhooks tables, note.created trigger"
```

---

### Task 5: `@movp/flows` — queue + event helpers

**Files:**
- Create: `packages/flows/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/flows/src/jobs.ts`, `packages/flows/src/events.ts`, `packages/flows/src/index.ts`
- Test: `packages/flows/test/jobs.test.ts` (integration against the local stack)

**Interfaces:**
- Consumes: the Task 4 RPCs; a `service_role` `SupabaseClient`.
- Produces:
  - `interface Job { id: string; kind: string; idempotency_key: string; payload: Record<string, unknown>; attempts: number; max_attempts: number; status: string; workspace_id: string | null }`
  - `enqueueJob(db, job: { kind: 'embed'|'webhook'|'notify'; idempotencyKey: string; payload: Record<string, unknown>; workspaceId?: string }): Promise<void>`
  - `claimDueJobs(db, kind: string, limit: number): Promise<Job[]>`
  - `completeJob(db, id: string, ok: boolean, errCode?: string): Promise<void>`
  - `deadJob(db, id: string, errCode: string): Promise<void>`
  - `replayJobs(db, opts: { kind?: string; dead?: boolean }): Promise<number>`
  - `reindexCollection(db, collection: string): Promise<number>`
  - `replaceSearchChunks(db, args: { sourceTable: string; sourceId: string; field: string; workspaceId: string; contentHash: string; chunks: { chunk_index: number; content: string; embedding: string }[] }): Promise<void>`
  - `interface MovpEvent { type: string; workspaceId: string; payload: Record<string, unknown>; traceId: string }`; `emitEvent(db, e: MovpEvent): Promise<void>`
  - (where `db: SupabaseClient`)

- [ ] **Step 1: Create the package skeleton**

`packages/flows/package.json`:
```json
{
  "name": "@movp/flows",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "@movp/domain": "workspace:*",
    "@movp/search": "workspace:*",
    "@movp/notifications": "workspace:*"
  },
  "devDependencies": { "vitest": "^2.1.0" }
}
```

`packages/flows/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/flows/vitest.config.ts` (injects the local-stack service-role env — fails loud if the stack is down):
```ts
import { execSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'

function supabaseEnv(): Record<string, string> {
  const out = execSync('supabase status -o env', { encoding: 'utf8' })
  const env: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z_]+)="?(.*?)"?$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}
const e = supabaseEnv()
export default defineConfig({
  test: {
    environment: 'node',
    env: {
      SUPABASE_URL: e.API_URL ?? '',
      SUPABASE_SERVICE_ROLE_KEY: e.SERVICE_ROLE_KEY ?? '',
    },
  },
})
```

Run: `pnpm install`
Expected: links `@movp/domain`, `@movp/search`, `@movp/notifications`.

- [ ] **Step 2: Write the failing integration test**

`packages/flows/test/jobs.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { claimDueJobs, completeJob, enqueueJob, replayJobs } from '../src/index.ts'

let db: SupabaseClient
let wsId: string

beforeAll(async () => {
  db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
  const { data, error } = await db.from('workspace').insert({ name: 'flows-test' }).select('id').single()
  if (error) throw error
  wsId = (data as { id: string }).id
})

describe('@movp/flows queue lifecycle', () => {
  it('enqueue → claim (running, attempts=1) → complete ok → not re-claimable', async () => {
    const key = `ok:${wsId}`
    await enqueueJob(db, { kind: 'webhook', idempotencyKey: key, payload: { x: 1 }, workspaceId: wsId })
    const job = (await claimDueJobs(db, 'webhook', 50)).find((j) => j.idempotency_key === key)!
    expect(job.attempts).toBe(1)
    expect(job.status).toBe('running')
    await completeJob(db, job.id, true)
    expect((await claimDueJobs(db, 'webhook', 50)).find((j) => j.id === job.id)).toBeUndefined()
  })

  it('enqueue is idempotent on (kind, idempotency_key)', async () => {
    const key = `dup:${wsId}`
    await enqueueJob(db, { kind: 'notify', idempotencyKey: key, payload: {}, workspaceId: wsId })
    await enqueueJob(db, { kind: 'notify', idempotencyKey: key, payload: {}, workspaceId: wsId })
    expect((await claimDueJobs(db, 'notify', 100)).filter((j) => j.idempotency_key === key)).toHaveLength(1)
  })

  it('exhausting attempts dead-letters; replay --dead recovers it', async () => {
    const key = `dead:${wsId}`
    await enqueueJob(db, { kind: 'webhook', idempotencyKey: key, payload: {}, workspaceId: wsId })
    let job = (await claimDueJobs(db, 'webhook', 100)).find((j) => j.idempotency_key === key)!
    // Deterministic despite backoff: after each failed attempt, replay failed jobs
    // back to pending so the next claim can increment attempts without sleeping.
    let recoveredDead = 0
    for (let i = 0; i < job.max_attempts + 1; i++) {
      await completeJob(db, job.id, false, 'boom')
      recoveredDead = await replayJobs(db, { kind: 'webhook', dead: true })
      if (recoveredDead > 0) break
      await replayJobs(db, { kind: 'webhook' }) // resets failed -> pending, leaves attempts intact
      const re = (await claimDueJobs(db, 'webhook', 100)).find((j) => j.idempotency_key === key)!
      job = re
    }
    expect(recoveredDead).toBeGreaterThanOrEqual(1)
  })
})
```

> Note: this test never waits on wall-clock backoff. It uses `replayJobs({ kind })` to make failed jobs due again while preserving `attempts`, then asserts a real `dead` job is recovered by `replayJobs({ dead: true })`. The deterministic lease/backoff SQL edges are also pinned in `jobs_test.sql` (Task 4).

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @movp/flows test`
Expected: FAIL — cannot resolve `../src/index.ts`.

- [ ] **Step 4: Implement**

`packages/flows/src/jobs.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'

export interface Job {
  id: string
  kind: string
  idempotency_key: string
  payload: Record<string, unknown>
  attempts: number
  max_attempts: number
  status: string
  workspace_id: string | null
}

export async function enqueueJob(
  db: SupabaseClient,
  job: { kind: 'embed' | 'webhook' | 'notify'; idempotencyKey: string; payload: Record<string, unknown>; workspaceId?: string },
): Promise<void> {
  const { error } = await db.rpc('enqueue_job', {
    job_kind: job.kind, idem_key: job.idempotencyKey, payload: job.payload, ws: job.workspaceId ?? null,
  })
  if (error) throw new Error(`enqueue_job_failed:${error.code ?? 'unknown'}`)
}

export async function claimDueJobs(db: SupabaseClient, kind: string, limit: number): Promise<Job[]> {
  const { data, error } = await db.rpc('claim_jobs', { job_kind: kind, lim: limit })
  if (error) throw new Error(`claim_jobs_failed:${error.code ?? 'unknown'}`)
  return Array.isArray(data) ? (data as Job[]) : []
}

export async function completeJob(db: SupabaseClient, id: string, ok: boolean, errCode?: string): Promise<void> {
  const { error } = await db.rpc('complete_job', { job_id: id, ok, err_code: errCode ?? null })
  if (error) throw new Error(`complete_job_failed:${error.code ?? 'unknown'}`)
}

export async function deadJob(db: SupabaseClient, id: string, errCode: string): Promise<void> {
  const { error } = await db.rpc('dead_job', { job_id: id, err_code: errCode })
  if (error) throw new Error(`dead_job_failed:${error.code ?? 'unknown'}`)
}

export async function replayJobs(db: SupabaseClient, opts: { kind?: string; dead?: boolean }): Promise<number> {
  const { data, error } = await db.rpc('replay_jobs', { job_kind: opts.kind ?? null, only_dead: !!opts.dead })
  if (error) throw new Error(`replay_jobs_failed:${error.code ?? 'unknown'}`)
  return (data ?? 0) as number
}

export async function reindexCollection(db: SupabaseClient, collection: string): Promise<number> {
  const { data, error } = await db.rpc('reindex_collection', { coll: collection })
  if (error) throw new Error(`reindex_failed:${error.code ?? 'unknown'}`)
  return (data ?? 0) as number
}

export async function replaceSearchChunks(
  db: SupabaseClient,
  args: {
    sourceTable: string
    sourceId: string
    field: string
    workspaceId: string
    contentHash: string
    chunks: { chunk_index: number; content: string; embedding: string }[]
  },
): Promise<void> {
  const { error } = await db.rpc('replace_search_chunks', {
    src_table: args.sourceTable,
    src_id: args.sourceId,
    src_field: args.field,
    ws: args.workspaceId,
    hash: args.contentHash,
    chunks: args.chunks,
  })
  if (error) throw new Error(`replace_chunks_failed:${error.code ?? 'unknown'}`)
}
```

`packages/flows/src/events.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'

export interface MovpEvent { type: string; workspaceId: string; payload: Record<string, unknown>; traceId: string }

export async function emitEvent(db: SupabaseClient, e: MovpEvent): Promise<void> {
  const { error } = await db.rpc('emit_event', { ev_type: e.type, ws: e.workspaceId, payload: e.payload, trace: e.traceId })
  if (error) throw new Error(`emit_event_failed:${error.code ?? 'unknown'}`)
}
```

`packages/flows/src/index.ts`:
```ts
export { enqueueJob, claimDueJobs, completeJob, deadJob, replayJobs, reindexCollection, replaceSearchChunks } from './jobs.ts'
export type { Job } from './jobs.ts'
export { emitEvent } from './events.ts'
export type { MovpEvent } from './events.ts'
export { runEmbedWorker } from './embed-worker.ts'   // Task 6
export { runFlowsWorker } from './flows-worker.ts'   // Task 7
```

> Implement only `jobs.ts` + `events.ts` in this task; the two `worker` re-exports are added in Tasks 6–7 (leave them commented until then so the package typechecks).

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @movp/flows test`
Expected: PASS (3 cases).

- [ ] **Step 6: Commit**

```bash
git add packages/flows
git commit -m "feat(flows): durable queue + event helpers over public RPCs"
```

---

### Task 6: Embed worker (`runEmbedWorker`) + `index-embeddings` edge function

**Files:**
- Create: `packages/flows/src/embed-worker.ts`
- Create: `supabase/functions/index-embeddings/index.ts`, `supabase/functions/index-embeddings/deno.json`
- Test: `packages/flows/test/embed-worker.test.ts`

**Interfaces:**
- Consumes: `EmbeddingProvider` (`@movp/domain`), `chunkText` (`@movp/search`), `claimDueJobs`/`completeJob` (`./jobs.ts`), `public.search_chunk`, the Plan 2 embed-enqueue + after-delete triggers.
- Produces: `runEmbedWorker(db: SupabaseClient, embedder: EmbeddingProvider, limit?: number): Promise<{ processed: number; failed: number }>`.

- [ ] **Step 1: Write the failing integration test**

`packages/flows/test/embed-worker.test.ts`:
```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { FakeEmbeddingProvider } from '@movp/search'
import { claimDueJobs, enqueueJob, replayJobs, runEmbedWorker } from '../src/index.ts'

class ThrowingEmbedder { async embed(): Promise<number[]> { throw new Error('boom') } }

let db: SupabaseClient
let wsId: string
const longBody =
  Array.from({ length: 60 }, (_, i) => `Filler sentence number ${i}.`).join(' ') +
  ' The unique marker phrase lives well past the first chunk boundary.'

beforeAll(async () => {
  db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const { data } = await db.from('workspace').insert({ name: 'embed-test' }).select('id').single()
  wsId = (data as { id: string }).id
})

async function countChunks(noteId: string): Promise<number> {
  const { count } = await db.from('search_chunk').select('*', { count: 'exact', head: true }).eq('source_id', noteId)
  return count ?? 0
}

describe('runEmbedWorker', () => {
  it('(a) chunks a long body so a phrase past the first chunk is indexed', async () => {
    const { data } = await db.from('note').insert({ workspace_id: wsId, title: 'Long', body: longBody }).select('id').single()
    const id = (data as { id: string }).id
    await runEmbedWorker(db, new FakeEmbeddingProvider(), 50) // drains the enqueued embed job
    const { data: hit } = await db.from('search_chunk').select('content').eq('source_id', id).ilike('content', '%unique marker phrase%')
    expect((hit ?? []).length).toBeGreaterThanOrEqual(1)
    expect(await countChunks(id)).toBeGreaterThan(1)
  })

  it('(b) re-saving unchanged content enqueues no new embed job (content_hash idempotency)', async () => {
    const { data } = await db.from('note').insert({ workspace_id: wsId, title: 'Idem', body: 'same body text.' }).select('id').single()
    const id = (data as { id: string }).id
    await runEmbedWorker(db, new FakeEmbeddingProvider(), 50)
    await db.from('note').update({ body: 'same body text.' }).eq('id', id) // unchanged content
    expect((await claimDueJobs(db, 'embed', 50)).length).toBe(0)
  })

  it('(c) embedder failure preserves previously indexed chunks and does not mark done', async () => {
    const { data } = await db.from('note').insert({ workspace_id: wsId, title: 'Fail', body: longBody }).select('id').single()
    const id = (data as { id: string }).id
    await runEmbedWorker(db, new FakeEmbeddingProvider(), 50)
    const before = await countChunks(id)
    expect(before).toBeGreaterThan(1)
    await db.from('note').update({ body: 'changed text should fail indexing.' }).eq('id', id)
    await runEmbedWorker(db, new ThrowingEmbedder(), 50)
    expect(await countChunks(id)).toBe(before) // old index remains until a successful replace RPC
  })

  it('(d) shrinking then deleting leaves no stale chunks', async () => {
    const { data } = await db.from('note').insert({ workspace_id: wsId, title: 'Shrink', body: longBody }).select('id').single()
    const id = (data as { id: string }).id
    await runEmbedWorker(db, new FakeEmbeddingProvider(), 50)
    expect(await countChunks(id)).toBeGreaterThan(1)
    await db.from('note').update({ body: 'tiny.' }).eq('id', id) // shrink → new content_hash → new job
    await runEmbedWorker(db, new FakeEmbeddingProvider(), 50)
    expect(await countChunks(id)).toBe(1) // REPLACE removed the old chunks
    await db.from('note').delete().eq('id', id) // Plan 2 after-delete trigger purges chunks
    expect(await countChunks(id)).toBe(0)
  })

  it('(e) rejects an embed payload for a non-embeddable table/field before dynamic reads', async () => {
    await enqueueJob(db, {
      kind: 'embed',
      idempotencyKey: `bad:${crypto.randomUUID()}`,
      workspaceId: wsId,
      payload: { source_table: 'workspace_membership', source_id: wsId, field: 'role', content_hash: 'x' },
    })
    const result = await runEmbedWorker(db, new FakeEmbeddingProvider(), 50)
    expect(result.failed).toBeGreaterThanOrEqual(1)
    expect(await replayJobs(db, { kind: 'embed', dead: true })).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @movp/flows test embed-worker`
Expected: FAIL — `runEmbedWorker` is not exported (`./embed-worker.ts` missing).

- [ ] **Step 3: Implement the worker core**

`packages/flows/src/embed-worker.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmbeddingProvider } from '@movp/domain'
import { chunkText } from '@movp/search'
import { claimDueJobs, completeJob, deadJob, replaceSearchChunks } from './jobs.ts'

interface EmbedPayload { source_table: string; source_id: string; field: string; content_hash: string }

class PermanentEmbedJobError extends Error {}

const EMBEDDABLE_FIELDS: Record<string, readonly string[]> = {
  note: ['body'],
}

function assertEmbeddablePayload(p: EmbedPayload): void {
  if (!EMBEDDABLE_FIELDS[p.source_table]?.includes(p.field)) {
    throw new PermanentEmbedJobError('embed_payload_not_allowed')
  }
}

export async function runEmbedWorker(
  db: SupabaseClient,
  embedder: EmbeddingProvider,
  limit = 10,
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0
  for (const job of await claimDueJobs(db, 'embed', limit)) {
    try {
      const p = job.payload as unknown as EmbedPayload
      assertEmbeddablePayload(p)
      const { data: row, error: readErr } = await db.from(p.source_table).select(p.field).eq('id', p.source_id).maybeSingle()
      if (readErr) throw new Error(`read:${readErr.code ?? 'err'}`)
      const text = ((row as Record<string, unknown> | null)?.[p.field] as string | null) ?? ''
      // Compute every embedding BEFORE replacing DB rows. If embedding fails, the old
      // successful index remains searchable and the job retries later.
      const chunks = chunkText(text)
      const rows: { chunk_index: number; content: string; embedding: string }[] = []
      for (let i = 0; i < chunks.length; i++) {
        const vec = await embedder.embed(chunks[i]) // throws before DB mutation
        rows.push({ chunk_index: i, content: chunks[i], embedding: JSON.stringify(vec) })
      }
      await replaceSearchChunks(db, {
        sourceTable: p.source_table,
        sourceId: p.source_id,
        field: p.field,
        workspaceId: job.workspace_id!,
        contentHash: p.content_hash,
        chunks: rows,
      })
      await completeJob(db, job.id, true)
      processed++
    } catch (e) {
      if (e instanceof PermanentEmbedJobError) {
        await deadJob(db, job.id, e.message)
        failed++
        continue
      }
      await completeJob(db, job.id, false, e instanceof Error ? e.message.slice(0, 40) : 'unknown')
      failed++
    }
  }
  return { processed, failed }
}
```

Then uncomment the `runEmbedWorker` re-export in `packages/flows/src/index.ts` (left stubbed in Task 5).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @movp/flows test embed-worker`
Expected: PASS — gates (a)–(e) green.

- [ ] **Step 5: Author the edge function (thin wrapper)**

`supabase/functions/index-embeddings/deno.json`:
```json
{
  "imports": {
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2",
    "@movp/domain": "../../../packages/domain/src/index.ts",
    "@movp/search": "../../../packages/search/src/index.ts",
    "@movp/search/gte-small": "../../../packages/search/src/gte-small.ts",
    "@movp/notifications": "../../../packages/notifications/src/index.ts",
    "@movp/flows": "../../../packages/flows/src/index.ts"
  }
}
```

`supabase/functions/index-embeddings/index.ts`:
```ts
import { createClient } from '@supabase/supabase-js'
import { GteSmallProvider } from '@movp/search/gte-small'
import { runEmbedWorker } from '@movp/flows'

const embedder = new GteSmallProvider()

Deno.serve(async () => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
  const result = await runEmbedWorker(db, embedder, 10)
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })
})
```

- [ ] **Step 6: Verify the edge function boots**

Run: `supabase functions serve index-embeddings --no-verify-jwt` then in another shell `curl -s -X POST localhost:54321/functions/v1/index-embeddings`
Expected: a JSON `{ "processed": <n>, "failed": <n> }` response (the `GteSmallProvider` runs only here, on the edge runtime). The logic gates are already proven in Step 4 with the fake embedder.

- [ ] **Step 7: Commit**

```bash
git add packages/flows/src/embed-worker.ts packages/flows/src/index.ts \
        packages/flows/test/embed-worker.test.ts supabase/functions/index-embeddings
git commit -m "feat(flows): durable chunked embed worker + index-embeddings edge fn"
```

---

### Task 7: Flows worker (`runFlowsWorker`) + `flows` edge function + CLI wiring + cron

**Files:**
- Create: `packages/flows/src/flows-worker.ts`
- Create: `supabase/functions/flows/index.ts`, `supabase/functions/flows/deno.json`
- Modify: `packages/cli/src/program.ts` (fill Plan 4's injectable `jobs` seam), `packages/cli/package.json` (add `@movp/flows`)
- Modify: `supabase/migrations/<ts>_async_rpcs.sql` (add `public.register_webhook`)
- Test: `packages/flows/test/flows-worker.test.ts`

**Interfaces:**
- Consumes: `NotificationProvider` (`@movp/notifications`), `claimDueJobs`/`completeJob` (`./jobs.ts`), `db.auth.admin.getUserById`, `public.register_webhook`.
- Produces: `runFlowsWorker(db: SupabaseClient, notifier: NotificationProvider, limit?: number): Promise<{ processed: number; failed: number }>`; CLI `movp jobs replay|reindex` wired to `@movp/flows`.

- [ ] **Step 1: Add `register_webhook` to the async RPC migration**

Append to `supabase/migrations/<ts>_async_rpcs.sql` (the Task 4 file), then re-run `supabase db reset`:
```sql
create or replace function public.register_webhook(ws uuid, ev_type text, hook_url text, hook_secret text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  insert into movp_internal.webhooks (workspace_id, event_type, url, secret)
  values (ws, ev_type, hook_url, hook_secret) returning id into new_id;
  return new_id;
end; $$;
revoke all on function public.register_webhook(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.register_webhook(uuid,text,text,text) to service_role;
```

- [ ] **Step 2: Write the failing integration test**

`packages/flows/test/flows-worker.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { NotificationMessage, NotificationProvider } from '@movp/notifications'
import { claimDueJobs, completeJob, replayJobs, runFlowsWorker } from '../src/index.ts'

class FakeNotifier implements NotificationProvider {
  sent: NotificationMessage[] = []
  async send(msg: NotificationMessage) { this.sent.push(msg); return { id: `fake_${this.sent.length}` } }
}

let db: SupabaseClient
let wsId: string
let ownerEmail: string
let hookServer: Server
let hookHits: { ok: number; fail: number } = { ok: 0, fail: 0 }
let hookUrl: string
let hookMode: 'ok' | 'fail' = 'ok'

beforeAll(async () => {
  db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  ownerEmail = `owner-${Date.now()}@example.com`
  const { data: u } = await db.auth.admin.createUser({ email: ownerEmail, email_confirm: true, password: 'pw-123456' })
  const { data: ws } = await db.from('workspace').insert({ name: 'flows-w' }).select('id').single()
  wsId = (ws as { id: string }).id
  await db.from('workspace_membership').insert({ workspace_id: wsId, user_id: u.user!.id, role: 'owner' })
  await new Promise<void>((res) => {
    hookServer = createServer((req, r) => {
      if (hookMode === 'ok') { hookHits.ok++; r.writeHead(200); r.end('ok') }
      else { hookHits.fail++; r.writeHead(502); r.end('no') }
    }).listen(0, () => { const a = hookServer.address(); hookUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/hook`; res() })
  })
})
afterAll(() => hookServer.close())

describe('runFlowsWorker', () => {
  it('(f) note.created → notify to the workspace owner email', async () => {
    await db.from('note').insert({ workspace_id: wsId, title: '<img src=x onerror=alert(1)>', body: 'b' }) // trigger emits note.created → notify job
    const notifier = new FakeNotifier()
    await runFlowsWorker(db, notifier, 50)
    const sent = notifier.sent.find((m) => m.to === ownerEmail)
    expect(sent).toBeTruthy()
    expect(sent!.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(sent!.html).not.toContain('<img')
  })

  it('webhook delivery: 5xx retries then dead-letters; replay --dead recovers', async () => {
    await db.rpc('register_webhook', { ws: wsId, ev_type: 'note.created', hook_url: hookUrl, hook_secret: 's3cr3t' })
    hookMode = 'fail'
    await db.from('note').insert({ workspace_id: wsId, title: 'Wh', body: 'b' }) // enqueues a webhook job
    // fail it repeatedly until it dead-letters. Replay failed jobs between attempts
    // so the test is deterministic and never sleeps on exponential backoff.
    let recovered = 0
    for (let i = 0; i < 10; i++) {
      await runFlowsWorker(db, new FakeNotifier(), 50)
      recovered = await replayJobs(db, { kind: 'webhook', dead: true })
      if (recovered > 0) break
      await replayJobs(db, { kind: 'webhook' })
    }
    expect(hookHits.fail).toBeGreaterThanOrEqual(1)
    expect(recovered).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @movp/flows test flows-worker`
Expected: FAIL — `runFlowsWorker` not exported.

- [ ] **Step 4: Implement the flows worker core**

`packages/flows/src/flows-worker.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { escapeHtml, type NotificationProvider } from '@movp/notifications'
import { claimDueJobs, completeJob } from './jobs.ts'

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function runFlowsWorker(
  db: SupabaseClient,
  notifier: NotificationProvider,
  limit = 10,
): Promise<{ processed: number; failed: number }> {
  let processed = 0
  let failed = 0

  for (const job of await claimDueJobs(db, 'notify', limit)) {
    try {
      const p = job.payload as { event?: string; title?: string }
      const { data: owner } = await db.from('workspace_membership')
        .select('user_id').eq('workspace_id', job.workspace_id).eq('role', 'owner').limit(1).maybeSingle()
      if (!owner) throw new Error('no_owner')
      const { data: u, error: uErr } = await db.auth.admin.getUserById((owner as { user_id: string }).user_id)
      if (uErr || !u.user?.email) throw new Error('no_owner_email')
      await notifier.send({ to: u.user.email, subject: `MOVP: ${p.event ?? 'update'}`, html: `<p>${escapeHtml(p.title ?? '')}</p>` })
      await completeJob(db, job.id, true); processed++
    } catch (e) {
      await completeJob(db, job.id, false, e instanceof Error ? e.message.slice(0, 40) : 'unknown'); failed++
    }
  }

  for (const job of await claimDueJobs(db, 'webhook', limit)) {
    try {
      const p = job.payload as { url: string; secret?: string }
      const body = JSON.stringify(job.payload)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (p.secret) headers['x-movp-signature'] = await hmac(p.secret, body)
      const res = await fetch(p.url, { method: 'POST', headers, body })
      if (!res.ok) throw new Error(`webhook:${res.status}`)
      await completeJob(db, job.id, true); processed++
    } catch (e) {
      await completeJob(db, job.id, false, e instanceof Error ? e.message.slice(0, 40) : 'unknown'); failed++
    }
  }
  return { processed, failed }
}
```

Then uncomment the `runFlowsWorker` re-export in `packages/flows/src/index.ts`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @movp/flows test flows-worker`
Expected: PASS — gate (f) + webhook retry/DLQ/replay green.

- [ ] **Step 6: Author the edge function**

`supabase/functions/flows/deno.json` (same import map as `index-embeddings` in Task 6 Step 5).

`supabase/functions/flows/index.ts`:
```ts
import { createClient } from '@supabase/supabase-js'
import { ResendAdapter } from '@movp/notifications'
import { runFlowsWorker } from '@movp/flows'

Deno.serve(async () => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
  const notifier = new ResendAdapter(Deno.env.get('RESEND_API_KEY')!)
  const result = await runFlowsWorker(db, notifier, 10)
  return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } })
})
```

- [ ] **Step 7: Wire the CLI `jobs` seam (fills Plan 4's injectable default)**

In `packages/cli/package.json`, add to `dependencies`: `"@movp/flows": "workspace:*"`.

In `packages/cli/src/program.ts`, replace Plan 4's throwing default `jobs` handlers:
```ts
      replay: async () => {
        throw new Error('movp jobs replay is delivered in Plan 5 (Search & Async)')
      },
      reindex: async () => {
        throw new Error('movp jobs reindex is delivered in Plan 5 (Search & Async)')
      },
```
with the real wiring (add `import { replayJobs, reindexCollection } from '@movp/flows'` at the top):
```ts
      replay: async (o: { kind?: string; dead?: boolean }) => {
        await replayJobs(resolveCtx().db, o)
      },
      reindex: async (collection: string) => {
        await reindexCollection(resolveCtx().db, collection)
      },
```
(`resolveCtx()` is Plan 4's seam returning a `service_role`-backed `{ db, userId }` for admin commands.)

- [ ] **Step 8: Verify the CLI wiring**

Run: `pnpm --filter @movp/cli test && pnpm --filter @movp/cli typecheck`
Expected: PASS — Plan 4's CLI tests still pass; `jobs replay/reindex` now resolve `@movp/flows` (no "delivered in Plan 5" throw).

- [ ] **Step 9: Document cron scheduling (deploy-time, no secrets in git)**

Add `docs/ops/cron.md` describing the per-minute schedule (run once per project via the SQL editor or `supabase` with project values — **never commit the service-role key**; reference it from Supabase Vault):
```sql
-- run once per project (values from the project; key via Vault, not literals in git)
select cron.schedule('movp-embed-worker', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_functions_url') || '/index-embeddings',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb);
$$);
select cron.schedule('movp-flows-worker', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_functions_url') || '/flows',
    headers := jsonb_build_object('Authorization', 'Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb);
$$);
```
The workers keep `verify_jwt = true` (default): the `service_role` key is a valid JWT that passes the gateway, so the functions are NOT publicly invocable. Local gates invoke `runEmbedWorker`/`runFlowsWorker` directly, so cron is not needed for CI.

- [ ] **Step 10: Commit**

```bash
git add packages/flows/src/flows-worker.ts packages/flows/test/flows-worker.test.ts \
        supabase/functions/flows supabase/migrations packages/cli docs/ops/cron.md
git commit -m "feat(flows): webhook/notify worker, flows edge fn, CLI jobs wiring, cron docs"
```

---

## Self-Review

- **Spec coverage (design Tasks 9–10):** `@movp/search` chunking + `GteSmallProvider` + `FakeEmbeddingProvider` (T1–2); GraphQL/MCP edge embedder wiring (T2); `@movp/notifications` Resend (T3); the async RPC layer + `note.created` trigger (T4); `@movp/flows` durable queue (T5); the chunked, idempotent, crash-safe embed worker (T6); the webhook/notify worker + CLI wiring + cron (T7). Design gates: (a) chunking past token 512 — T6 test (a); (b) no re-embed on unchanged content — T6 test (b); (c) embedder failure preserves the prior successful index and leaves the job retryable — T6 test (c); (d) shrink/delete no stale chunks — T6 test (d); (e) malformed/disallowed embed payload is rejected before dynamic table reads — T6 test (e); (f) lease reclaim of crashed `running` — **`jobs_test.sql` (T4, SQL-level)**; (g) note.created → notify + webhook delivery, 5xx → retry → DLQ → replay — T7 tests. Covered.
- **Placeholder scan:** none — every code/SQL block is complete; every step has an exact command + expected output.
- **Type consistency:** `Job`, `MovpEvent`, the seven queue/search RPC helpers, `runEmbedWorker`, `runFlowsWorker`, `chunkText`, `FakeEmbeddingProvider`, `GteSmallProvider`, `NotificationProvider`/`ResendAdapter`/`escapeHtml` are each defined once and consumed by name. `EmbeddingProvider` is imported from `@movp/domain` (defined in Plan 3), implemented by both `GteSmallProvider` and `FakeEmbeddingProvider`.
- **Cross-plan fidelity:** all `movp_internal` access is via `public` SECURITY DEFINER RPCs (`service_role`-only) or in-DB triggers — never `db.schema('movp_internal')`; PostgREST-facing RPCs return scalar/JSON shapes instead of internal composites. The embed idempotency key matches Plan 2's enqueue-trigger format (coupling note in T4). The CLI `jobs` seam fills Plan 4's injectable default. `search_chunk`/`movp_jobs`/`match_chunks` are consumed exactly as Plan 2 emits them.
- **Hardening:** every RPC and trigger function is `SECURITY DEFINER` + `set search_path = ''` + schema-qualified + `execute` revoked from `public`/`anon`/`authenticated`, granted to `service_role` — satisfies the `definer-audit` gate (Plan 6). No secrets in committed migrations (cron uses Vault). Workers use the service-role client only out-of-band; bounded `2^attempts` backoff + DLQ; error codes are bounded, no payload/PII logged.
- **Eight-dimension pass:** *Correctness* — transactional `replace_search_chunks` + content_hash idempotency proven by tests. *Safety* — internal-schema isolation via RPC seam, hardened definers, no committed secrets. *Reliability* — failed re-embedding preserves the old index; lease/reclaim + backoff + DLQ + replay. *Observability* — bounded error codes on every failure path. *Efficiency* — unchanged content never re-embeds. *Performance* — bounded `claimDueJobs` batch + `for update skip locked`. *Simplicity* — one queue, one RPC seam; cron documented not committed. *Usability* — `movp jobs replay/reindex` operator commands.
