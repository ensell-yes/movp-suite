# MOVP App — Segmentation Phase 6, Part B: External Event Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **public, authenticated ingestion endpoint** so OTHER apps can emit events that land the SAME normalized `public.platform_event` rows Part A built, stamped `source='external'`. The endpoint supports **two auth modes** — a first-party **JWT** path (RLS-bound insert under the caller's principal) and a service-to-service **API-key** path (a `SECURITY DEFINER` RPC that resolves the workspace from the HASHED key) — and in BOTH modes the workspace is resolved **server-side**; a client-supplied `workspace_id` is NEVER trusted for the API-key path. Hand-author migration `supabase/migrations/20260701000020_segmentation_ingest.sql` (the `movp_internal.ingest_key` registry + `public.mint_ingest_key` + `public.ingest_platform_event`), add the Deno edge function `supabase/functions/ingest/index.ts`, and add a pure, bounded `ingest-bounds.ts` duplicated VERBATIM between `@movp/domain` and the edge runtime.

**Architecture:** Part A committed `public.platform_event` — columns `(workspace_id, event_type, subject_type, subject_ref, actor_ref, source enum('internal','external'), properties jsonb, occurred_at, ingested_at)`, **INSERT-only / immutability-guarded**, with a member INSERT policy `with check public.is_workspace_member(workspace_id)` — plus the internal bridge that surfaces all 7 collections generically. This Part B is **purely additive on the ingestion side**: it introduces no new table on `public` and no new event type; every external event becomes a `platform_event` row with `source='external'`. The single load-bearing invariant is **server-resolved workspace**: in the JWT path the workspace is gated by RLS (`with check is_workspace_member`) so a non-member write is rejected at the boundary; in the API-key path the workspace is derived from `movp_internal.ingest_key.workspace_id` looked up by the SHA-256 hash of the presented key — so **a workspace-A key can never write a workspace-B row**, no matter what the request body claims. Ingestion is **bounded untrusted I/O**: the batch element count is capped (`INGEST_MAX_BATCH = 500`) and each event's `properties` is capped by **serialized byte length** (`INGEST_MAX_PROP_BYTES = 16 * 1024`, measured via `new TextEncoder().encode(JSON.stringify(properties)).length`) — malformed and oversized events are **dropped, not buffered**, and the endpoint returns `{ inserted, dropped }`. Keys are **stored hashed** (`encode(extensions.digest(<raw_key>, 'sha256'), 'hex')`) and the raw key is returned by `mint_ingest_key` **exactly once**, never stored or logged in raw form. The edge function is Deno (reads `Deno.env` at call time, never module-scopes the client); the domain is workerd and holds no service credentials.

**Ingestion contract (verbatim for Tasks 1–3):**
```sql
-- movp_internal.ingest_key  (mirrors movp_internal.webhooks)
--   id           uuid   pk default gen_random_uuid()
--   workspace_id uuid   not null references public.workspace(id) on delete cascade
--   key_hash     text   not null unique          -- encode(extensions.digest(raw,'sha256'),'hex')
--   label        text
--   active       boolean not null default true
--   created_at   timestamptz not null default now()

-- public.mint_ingest_key(ws uuid, label text) returns text     -- DEFINER; returns the RAW key ONCE
-- public.ingest_platform_event(api_key text, events jsonb) returns jsonb
--     -> jsonb_build_object('inserted', n_ok, 'dropped', n_bad)   -- workspace resolved from the KEY
```
```ts
// Pasted precedent — @movp/auth principal (fail-closed discriminated union):
// resolvePrincipal(req, env): Promise<{ ok:true; userId:string; db:SupabaseClient }
//   | { ok:false; code:'missing_token'|'invalid_token'|'expired_token'|'invalid_claims' }>
const principal = await resolvePrincipal(req, env)
if (!principal.ok) return new Response(JSON.stringify({ error: principal.code }), { status: 401, headers: { 'content-type': 'application/json' } })
// principal.db is an anon-key client carrying the caller's Bearer token → RLS applies.

// Pasted precedent — the pure bounds shape (ingest-bounds.ts):
export const INGEST_MAX_BATCH = 500; export const INGEST_MAX_PROP_BYTES = 16 * 1024;
export function validateIngestEvent(e: unknown): { ok: true; value: NormalizedEvent } | { ok: false; error: 'malformed' | 'oversized' } { /* require event_type/subject_ref/occurred_at; default subject_type to 'user'; new TextEncoder().encode(JSON.stringify(properties)).length <= cap */ }
```

**Tech Stack:** Supabase CLI (local stack, hand-authored migrations, pgTAP via `supabase test db`), Postgres `SECURITY DEFINER` RPCs + `movp_internal` private schema, pgcrypto (`extensions.digest` / `extensions.gen_random_bytes`, installed `with schema extensions` in `000002`), the committed `public.platform_event` + `public.is_workspace_member`, Supabase Edge Functions (`Deno.serve` + `@movp/auth` `resolvePrincipal` + `@movp/obs` `emit` + a service-role client, mirroring `supabase/functions/graphql/index.ts` for `resolvePrincipal` + structured obs and `flows` for the service-role client pattern), a pure bounds module duplicated across the workerd (`@movp/domain`) and Deno (edge) runtimes, the definer-audit gate (`node scripts/check-definer-audit.mjs`), the boundary gate (`bash scripts/check-boundary.sh`), and Vitest (`@movp/domain`).

**This is Part B of the Segmentation Phase 6 series.** It depends on **Part A** (`public.platform_event` + its member RLS + the internal bridge, migration `20260701000019_*`), on the async/private backbone (`movp_internal`, `movp_internal.webhooks` as the registry precedent, pgcrypto in `extensions`), on `public.is_workspace_member`, and on `@movp/auth`'s `resolvePrincipal`. Downstream consumers depend on the `platform_event` shape (`source='external'` for ingested rows) — do not rename columns or the source enum values. `mint_ingest_key`'s **raw key is returned once**; treat it as a secret from the moment it is minted.

## Global Constraints

- **Fully hand-authored migration — no codegen, no `supabase migration new`.** `ingest_key` lives in the **private `movp_internal`** schema (like `webhooks`), NOT in the config-first collection DSL, so there is **no `pnpm codegen` step** in this Part. Create the exact file `supabase/migrations/20260701000020_segmentation_ingest.sql` (a wall-clock `migration new` timestamp would sort wrong; `000020` must sort AFTER Part A's `000019`). Because everything is in the migration, `supabase db diff` stays empty.
- **The workspace is ALWAYS server-resolved.** JWT path → RLS `with check public.is_workspace_member(workspace_id)` gates the write. API-key path → `ingest_platform_event` derives `workspace_id` from `movp_internal.ingest_key` by the key hash and inserts under THAT id, **ignoring any `workspace_id` in `events`**. There is no code path in which a client-supplied `workspace_id` decides the destination workspace for the API-key path.
- **All `SECURITY DEFINER` functions hardened.** Every function: `set search_path = ''`, every object fully schema-qualified (`movp_internal.ingest_key`, `public.platform_event`, `extensions.digest`, `extensions.gen_random_bytes`; `pg_catalog` built-ins like `encode`/`octet_length`/`now`/`jsonb_*` are unqualified — always in path), `execute` revoked from `public`/`anon`/`authenticated`, and **explicitly granted to `service_role`** (both RPCs are invoked by a service-role client / an operator provisioning path). The definer-audit gate (`node scripts/check-definer-audit.mjs`) splits on `create ... function` and FAILS any `security definer` block missing `set search_path =`. Both functions set it — do not drop the clause.
- **Keys are stored hashed; the raw key is emitted once.** `mint_ingest_key` generates `encode(extensions.gen_random_bytes(24),'hex')` (48 hex chars), stores `encode(extensions.digest(raw,'sha256'),'hex')` (64 hex chars), and RETURNS the raw key. The raw key is never persisted or logged. `ingest_platform_event` hashes the presented `api_key` and matches `key_hash` — the plaintext is never stored, so a DB read cannot recover it.
- **`mint_ingest_key` is service-role-only.** Revoked from `authenticated` — a random member cannot self-issue an ingest key. Minting is an operator/admin action (service-role client or CLI).
- **Bounded untrusted input (bound-before-buffer analog).** The batch element count is capped at `INGEST_MAX_BATCH = 500`; each event's `properties` serialized bytes are capped at `INGEST_MAX_PROP_BYTES = 16384`. Oversized/malformed events are **dropped** (counted in `dropped`), never inserted. The RPC re-enforces both bounds server-side even though the edge fn also pre-filters — the RPC is authoritable and reachable by a service-role caller.
- **Serialized-byte measurement, both runtimes.** `ingest-bounds.ts` measures `new TextEncoder().encode(JSON.stringify(properties)).length` (UTF-8 bytes of the real serialized payload, not char length). The SQL RPC measures `octet_length((properties)::text)` — the jsonb re-serialization is a superset discriminator (whitespace/key-order may differ from the client's exact bytes) but never under-counts a real oversize; state this, do not claim byte-for-byte parity.
- **`ingest-bounds.ts` is duplicated VERBATIM across runtimes.** `packages/domain/src/ingest-bounds.ts` (workerd/vitest) and `supabase/functions/_shared/ingest-bounds.ts` (Deno edge) are **byte-identical** — different bundles/runtimes, kept in lock-step. A gate `diff`s the two files. Byte length is measured with `new TextEncoder().encode(JSON.stringify(properties)).length` — `TextEncoder` is a web standard present in BOTH Node (vitest) and the Deno edge runtime with **no polyfill**, so the primitive is valid verbatim in both. Do NOT use `Buffer` (it is not a Deno global), and do NOT justify the byte measurement by analogy to CMS `asset-bounds.ts` (that module bounds a **declared numeric size**, not a serialized byte length).
- **`resolvePrincipal` is fail-closed.** On `!principal.ok` the edge fn returns 401 with `principal.code`; it never proceeds anonymously. An RLS `42501` on the JWT-path insert (a non-member `workspace_id` in the batch) surfaces as 403 — a loud rejection, never a silent success.
- **The `ingest` function has `verify_jwt = false`.** The API-key path carries NO `Authorization` header, so the platform gateway's JWT check would 401 it before our code runs. Set `[functions.ingest] verify_jwt = false` in `supabase/config.toml`; the function does its OWN fail-closed auth for both paths (`resolvePrincipal` for JWT, the hashed-key RPC for API-key). Neither path is anonymous.
- **Observability discipline.** The edge fn emits a structured `@movp/obs` event (via `emit`, `surface: 'ingest'`) on EVERY failure branch (405/400/401/403/413/500) and on a partial-drops summary — carrying `trace_id`/`request_id`/`operation`/`error_code` (field NAMES + a bounded classifier only), NEVER `body`, event `properties`, filenames, `api_key`, `x-ingest-key`, or a raw key (`emit()`'s `redact()` also drops any `@`-string). It performs NO raw `console.*` logging — all diagnostics go through `emit`. `platform_event.actor_ref` is caller-supplied metadata, not an auth principal; the auth principal is the JWT (JWT path) or the key hash (API-key path).
- **Edge fn is Deno, not workerd; the domain is workerd.** The edge fn reads `Deno.env` at call time and never module-scopes the Supabase client. The domain (`@movp/domain`) holds no service-role key and no ingest secret — the only domain artifact here is the pure `ingest-bounds.ts` (no server imports; passes `check-boundary.sh`).
- **Every task ends with a machine-checkable gate** (below).

## File Structure

```
supasuite/
  packages/
    domain/
      src/
        ingest-bounds.ts            # NEW: validateIngestEvent + boundBatch (pure; workerd/vitest copy)
      test/
        ingest-bounds.test.ts       # NEW vitest (batch cap, prop-byte cap via TextEncoder byte length, subject_type default, malformed/oversized)
    obs/
      src/
        event.ts                    # EDIT: add 'ingest' to the Surface union
        emit.ts                     # EDIT: add 'ingest' to the SURFACES allow-list
  supabase/
    config.toml                     # EDIT: add [functions.ingest] verify_jwt = false
    migrations/
      20260701000020_segmentation_ingest.sql   # NEW hand-authored (ingest_key + mint + ingest_platform_event)
    functions/
      _shared/
        ingest-bounds.ts            # NEW: VERBATIM copy of packages/domain/src/ingest-bounds.ts (Deno edge copy)
      ingest/
        deno.json                   # NEW: import map (mirror graphql/deno.json: @movp/auth, @movp/obs, @supabase/supabase-js, jose)
        index.ts                    # NEW Deno edge fn (JWT path + API-key path; emits @movp/obs on every failure)
    tests/
      segmentation_ingest_test.sql  # NEW pgTAP (registry + hashed key + workspace isolation + bounds)
  e2e/                              # (wherever the collaboration slice lives)
    ingest.slice.*                  # NEW e2e slice driving both paths (Task 4)
```

**Per-task apply gate (SQL/schema tasks end with it):**
```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected shape: the migration applies, `segmentation_ingest_test.sql .. ok` (all planned assertions pass), definer-audit prints `all definers pinned` (exit 0), `db diff` prints nothing. Domain tasks end with a Vitest gate (`pnpm --filter @movp/domain test`) + `bash scripts/check-boundary.sh`.

---

### Task 1: `movp_internal.ingest_key` registry + `mint_ingest_key` + `ingest_platform_event` + pgTAP

**Files:**
- Create: `supabase/migrations/20260701000020_segmentation_ingest.sql`
- Create: `supabase/tests/segmentation_ingest_test.sql`

**Interfaces:**
- Consumes: `public.workspace`, `public.platform_event` (Part A, with its member INSERT policy), `public.is_workspace_member`, pgcrypto (`extensions.digest` / `extensions.gen_random_bytes`), the `movp_internal` private schema.
- Produces: the `movp_internal.ingest_key` registry (RLS-enabled, anon/authenticated revoked, service_role granted); `public.mint_ingest_key(uuid, text)` (service_role-only; returns the raw key once, stores the hash); `public.ingest_platform_event(text, jsonb)` (resolves the workspace from the key hash, drops malformed/oversized events, caps the batch, returns `{inserted, dropped}`). Invariant: a workspace-A key inserts ONLY workspace-A rows; the payload `workspace_id` is ignored.

- [ ] **Step 1: Write the failing pgTAP (red)**

Create `supabase/tests/segmentation_ingest_test.sql`. `plan(12)`. All fixture UUIDs are hex so they parse as `uuid`. The RPC is `SECURITY DEFINER`, so calling it as the table owner exercises the real code path (the security boundary is the KEY, not the caller's role).
```sql
begin;
select plan(12);

-- ── shared seed (as the table owner; RLS bypassed) ──────────────────────────
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1'),
  ('22222222-2222-2222-2222-222222222222','W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','owner');

-- ── registry exists + is closed to anon/authenticated ───────────────────────
select has_table('movp_internal','ingest_key','movp_internal.ingest_key registry exists');
select table_privs_are('movp_internal','ingest_key','anon','{}'::text[],
  'anon has no privileges on movp_internal.ingest_key');
select table_privs_are('movp_internal','ingest_key','authenticated','{}'::text[],
  'authenticated has no privileges on movp_internal.ingest_key');

-- ── mint_ingest_key: raw key returned once (48 hex), stored hashed (64 hex) ──
select is(length(public.mint_ingest_key(
    '11111111-1111-1111-1111-111111111111','minted')), 48,
  'mint_ingest_key returns a 48-char hex raw key (24 random bytes)');
select is((select length(key_hash) from movp_internal.ingest_key
           where workspace_id='11111111-1111-1111-1111-111111111111' and label='minted'),
          64, 'mint stores a 64-char sha256 hash, never the raw key');

-- ── a known W1 key (insert the HASH of a known raw key) ──────────────────────
insert into movp_internal.ingest_key (id, workspace_id, key_hash, label, active) values
  ('000000f1-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   encode(extensions.digest('rawkey-w1','sha256'),'hex'),'k1',true);

-- ── ingest: 2 valid, 1 malformed (no subject_ref/occurred_at), 1 oversized ──
-- Event #1 carries workspace_id=W2 in its payload; the key resolves W1, so it
-- MUST land in W1 (payload workspace_id ignored). Event #2 OMITS subject_type to
-- prove the RPC defaults it to 'user' (platform_event.subject_type is NOT NULL) —
-- a missing subject_type must NOT abort the batch. Call ONCE into a temp table
-- so the two count-assertions read the same result (a second call re-inserts).
create temp table _ingest_result as
  select public.ingest_platform_event('rawkey-w1', jsonb_build_array(
    jsonb_build_object('event_type','signup','subject_type','user','subject_ref','u1',
      'occurred_at','2026-07-01T00:00:00Z','properties',jsonb_build_object('plan','pro'),
      'workspace_id','22222222-2222-2222-2222-222222222222'),
    jsonb_build_object('event_type','login','subject_ref','u2',                -- no subject_type -> defaults to 'user'
      'occurred_at','2026-07-01T00:01:00Z'),
    jsonb_build_object('event_type','bad'),                                   -- malformed
    jsonb_build_object('event_type','big','subject_ref','u3',
      'occurred_at','2026-07-01T00:02:00Z',
      'properties',jsonb_build_object('blob', repeat('x', 20000)))            -- oversized (>16KiB)
  )) as r;
select is((select r->>'inserted' from _ingest_result), '2',
  'the two valid events are inserted (inserted=2)');
select is((select r->>'dropped' from _ingest_result), '2',
  'the malformed + oversized events are dropped (dropped=2)');
select is((select count(*)::int from public.platform_event
           where workspace_id='11111111-1111-1111-1111-111111111111' and source='external'),
          2, 'both valid events land in W1 as source=external');
select is((select count(*)::int from public.platform_event
           where workspace_id='22222222-2222-2222-2222-222222222222'),
          0, 'the payload workspace_id (W2) is IGNORED — a W1 key never writes a W2 row');
select is((select subject_type from public.platform_event
           where workspace_id='11111111-1111-1111-1111-111111111111' and subject_ref='u2'),
          'user', 'a missing subject_type defaults to user (NOT NULL satisfied); the batch still commits');

-- ── batch cap + invalid key ─────────────────────────────────────────────────
select throws_ok($$
  select public.ingest_platform_event('rawkey-w1',
    (select jsonb_agg(jsonb_build_object('event_type','x','subject_ref','s',
       'occurred_at','2026-07-01T00:00:00Z')) from generate_series(1,501)))
$$, '54000', null, 'a batch over 500 events is rejected (batch_too_large)');
select throws_ok($$
  select public.ingest_platform_event('not-a-real-key', '[]'::jsonb)
$$, '28000', null, 'an unknown/inactive api key is rejected');

select * from finish();
rollback;
```

- [ ] **Step 2: Run to verify it fails**

```bash
supabase test db
```
Expected: FAIL — with only `000001`–`000019` applied, `movp_internal.ingest_key` and both functions do not exist; the file errors on the first `has_table` / the first `mint_ingest_key` call. This confirms the test targets `000020`.

- [ ] **Step 3: Create `000020` — registry + `mint_ingest_key` + `ingest_platform_event` (green)**

Create `supabase/migrations/20260701000020_segmentation_ingest.sql` (exact path — do NOT use `supabase migration new`):
```sql
-- Segmentation Phase 6 — Part B (external ingestion). Sorts AFTER Part A's 000019.
-- Hand-authored: the ingest_key registry (private, like movp_internal.webhooks),
-- mint_ingest_key (service-role-only; returns the raw key once), and the API-key
-- ingest RPC (resolves the workspace from the key hash; the payload workspace_id
-- is never trusted). No codegen — nothing here is a config-first collection.

-- ── movp_internal.ingest_key: hashed-key registry (mirror movp_internal.webhooks)
create table movp_internal.ingest_key (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  key_hash     text not null unique,            -- encode(extensions.digest(raw,'sha256'),'hex')
  label        text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
alter table movp_internal.ingest_key enable row level security;   -- no policies: closed to anon/authenticated
revoke all on movp_internal.ingest_key from anon, authenticated;
grant all on movp_internal.ingest_key to service_role;

-- ── mint_ingest_key: emit a raw key ONCE, store only its hash ────────────────
-- GOTCHA: keep `set search_path = ''` (definer-audit gate). gen_random_bytes /
-- digest are pgcrypto -> extensions-qualified. encode is pg_catalog (unqualified).
-- Service-role-only: a member must NOT be able to self-issue an ingest key.
create or replace function public.mint_ingest_key(ws uuid, label text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  raw_key text;
begin
  raw_key := encode(extensions.gen_random_bytes(24), 'hex');   -- 48 hex chars
  insert into movp_internal.ingest_key (workspace_id, key_hash, label)
    values (ws, encode(extensions.digest(raw_key, 'sha256'), 'hex'), label);
  return raw_key;   -- returned ONCE; the caller must store it now. Never persisted/logged raw.
end; $$;
revoke all on function public.mint_ingest_key(uuid, text) from public, anon, authenticated;
grant execute on function public.mint_ingest_key(uuid, text) to service_role;  -- operator/admin path only

-- ── ingest_platform_event: API-key path — workspace comes from the KEY ───────
-- GOTCHA: keep `set search_path = ''`. The workspace is resolved from the hashed
-- key; EVERY row is stamped with that workspace_id, so events->>'workspace_id' is
-- ignored — a workspace-A key can never write a workspace-B row. Malformed /
-- oversized events are DROPPED (never buffered/inserted); the batch is capped.
create or replace function public.ingest_platform_event(api_key text, events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ws          uuid;
  v_event       jsonb;
  v_type        text;
  v_subject_ref text;
  v_props       jsonb;
  v_occurred    timestamptz;
  n_ok          int := 0;
  n_bad         int := 0;
begin
  -- resolve workspace from the HASHED key (server-side; never trust client input)
  select k.workspace_id into v_ws
    from movp_internal.ingest_key k
   where k.key_hash = encode(extensions.digest(api_key, 'sha256'), 'hex')
     and k.active
   limit 1;
  if v_ws is null then
    raise exception 'ingest_key_invalid' using errcode = '28000';   -- invalid_authorization_specification
  end if;

  if jsonb_typeof(events) is distinct from 'array' then
    raise exception 'events_not_array' using errcode = '22023';
  end if;
  if jsonb_array_length(events) > 500 then                          -- INGEST_MAX_BATCH
    raise exception 'batch_too_large' using errcode = '54000';      -- program_limit_exceeded
  end if;

  for v_event in select value from jsonb_array_elements(events)
  loop
    v_type        := v_event->>'event_type';
    v_subject_ref := v_event->>'subject_ref';
    v_props       := coalesce(v_event->'properties', '{}'::jsonb);
    begin
      v_occurred := (v_event->>'occurred_at')::timestamptz;
    exception when others then
      v_occurred := null;
    end;
    -- required shape + serialized-byte bound (superset discriminator vs the client's exact bytes)
    if v_type is null or length(v_type) = 0
       or v_subject_ref is null or length(v_subject_ref) = 0
       or v_occurred is null
       or octet_length(v_props::text) > 16384 then                  -- INGEST_MAX_PROP_BYTES
      n_bad := n_bad + 1;
      continue;
    end if;
    -- Per-row INSERT wrapped so a single-row failure DROPS (counted), never aborts the
    -- whole batch. platform_event.subject_type is NOT NULL (Part A) -> coalesce to 'user'
    -- when the event omits it; the RPC's own occurred_at cast above only guards the cast,
    -- so the INSERT needs its OWN handler for any residual NOT NULL / type failure.
    begin
      insert into public.platform_event
        (workspace_id, event_type, subject_type, subject_ref, actor_ref, source, properties, occurred_at, ingested_at)
      values
        (v_ws, v_type, coalesce(v_event->>'subject_type', 'user'), v_subject_ref, v_event->>'actor_ref',
         'external', v_props, v_occurred, now());                   -- workspace = v_ws (the KEY's), never the payload
      n_ok := n_ok + 1;
    exception when others then
      n_bad := n_bad + 1;                                           -- a per-row failure is a DROP, not a batch abort
      continue;
    end;
  end loop;

  return jsonb_build_object('inserted', n_ok, 'dropped', n_bad);
end; $$;
revoke all on function public.ingest_platform_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_platform_event(text, jsonb) to service_role;  -- edge fn (service-role client)
```

- [ ] **Step 4: Apply + test + definer audit + drift**

```bash
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```
Expected: `segmentation_ingest_test.sql .. ok` (12 assertions); definer-audit exits 0 (`mint_ingest_key` + `ingest_platform_event` both pin `search_path`); `db diff` empty (nothing is codegen-owned).

- [ ] **Step 5: Gate — workspace is server-resolved; keys are hashed; RPCs are pinned + closed**

```bash
grep -q "encode(extensions.digest(api_key, 'sha256'), 'hex')" supabase/migrations/20260701000020_segmentation_ingest.sql && echo KEY_HASH_LOOKUP_OK
grep -q "values$" supabase/migrations/20260701000020_segmentation_ingest.sql; grep -cE "v_ws, v_type" supabase/migrations/20260701000020_segmentation_ingest.sql
grep -c "revoke all on function public.\(mint_ingest_key\|ingest_platform_event\)" supabase/migrations/20260701000020_segmentation_ingest.sql
```
Expected: prints `KEY_HASH_LOOKUP_OK` (the workspace is looked up by the key hash, not a payload field); the second grep prints `1` (the insert stamps `v_ws` — the key's workspace — never `events->>'workspace_id'`); the third grep prints `2` (both RPCs revoke `execute` from public/anon/authenticated).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260701000020_segmentation_ingest.sql supabase/tests/segmentation_ingest_test.sql
git commit -m "feat(segmentation): ingest_key registry + mint + API-key ingest RPC (Part B)"
```

---

### Task 2: pure `ingest-bounds.ts` + Vitest (batch cap, prop-byte cap, malformed/oversized)

**Files:**
- Create: `packages/domain/src/ingest-bounds.ts` (pure `validateIngestEvent` + `boundBatch`)
- Create: `packages/domain/test/ingest-bounds.test.ts` (Vitest)

**Interfaces:**
- Consumes: nothing (pure module; no imports, no server code — the canonical, unit-tested copy).
- Produces: `INGEST_MAX_BATCH`/`INGEST_MAX_PROP_BYTES`, `NormalizedEvent`, `validateIngestEvent` (discriminated `{ok:true;value} | {ok:false;error}`), `boundBatch`. Invariant: `validateIngestEvent` requires `event_type`/`subject_ref`/`occurred_at`, defaults a missing `subject_type` to `'user'` (so the domain agrees with the RPC and `platform_event.subject_type` NOT NULL is always satisfied), measures `new TextEncoder().encode(JSON.stringify(properties)).length` against the cap, drops unknown fields, and NEVER buffers file/large content — it inspects the already-parsed event object only.

- [ ] **Step 1: Write the failing Vitest (red)**

Create `packages/domain/test/ingest-bounds.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  validateIngestEvent, boundBatch, INGEST_MAX_BATCH, INGEST_MAX_PROP_BYTES,
} from '../src/ingest-bounds';

describe('validateIngestEvent (require shape; measure serialized bytes)', () => {
  it('accepts a well-formed event and normalizes to known fields only', () => {
    const r = validateIngestEvent({
      event_type: 'signup', subject_type: 'user', subject_ref: 'u1',
      actor_ref: 'a1', occurred_at: '2026-07-01T00:00:00Z',
      properties: { plan: 'pro' }, workspace_id: 'ignored-here', junk: 42,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        event_type: 'signup', subject_type: 'user', subject_ref: 'u1',
        actor_ref: 'a1', properties: { plan: 'pro' }, occurred_at: '2026-07-01T00:00:00Z',
      });
      // unknown/extra fields (workspace_id, junk) are dropped by normalization
      expect(Object.keys(r.value)).not.toContain('workspace_id');
      expect(Object.keys(r.value)).not.toContain('junk');
    }
  });
  it('defaults a missing subject_type to "user" (platform_event.subject_type is NOT NULL)', () => {
    const r = validateIngestEvent({
      event_type: 'x', subject_ref: 's', occurred_at: '2026-07-01T00:00:00Z',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.subject_type).toBe('user');
  });
  it('rejects a missing subject_ref as malformed', () => {
    expect(validateIngestEvent({ event_type: 'x', occurred_at: '2026-07-01T00:00:00Z' }))
      .toEqual({ ok: false, error: 'malformed' });
  });
  it('rejects a bad occurred_at as malformed', () => {
    expect(validateIngestEvent({ event_type: 'x', subject_ref: 's', occurred_at: 'not-a-date' }))
      .toEqual({ ok: false, error: 'malformed' });
  });
  it('rejects oversized properties by SERIALIZED byte length', () => {
    const big = { blob: 'x'.repeat(INGEST_MAX_PROP_BYTES) }; // JSON.stringify > cap
    expect(validateIngestEvent({
      event_type: 'x', subject_ref: 's', occurred_at: '2026-07-01T00:00:00Z', properties: big,
    })).toEqual({ ok: false, error: 'oversized' });
  });
});

describe('boundBatch (cap element count; require an array)', () => {
  it('rejects a non-array', () => {
    expect(boundBatch({ events: 'nope' })).toEqual({ ok: false, error: 'not_array' });
  });
  it('rejects a batch over the cap', () => {
    const over = Array.from({ length: INGEST_MAX_BATCH + 1 }, () => ({}));
    expect(boundBatch(over)).toEqual({ ok: false, error: 'batch_too_large' });
  });
  it('accepts a within-bound array', () => {
    expect(boundBatch([{}, {}]).ok).toBe(true);
  });
});
```

Run: `pnpm --filter @movp/domain test ingest-bounds`
Expected: FAIL — `Cannot find module '../src/ingest-bounds'` (the module does not exist yet).

- [ ] **Step 2: Create the pure bounds module (green)**

Create `packages/domain/src/ingest-bounds.ts`. This exact file is copied VERBATIM to `supabase/functions/_shared/ingest-bounds.ts` in Task 3 — a gate `diff`s them, so keep it self-contained (no imports).
```ts
// Pure ingestion bounds — the "bound-before-buffer" gate for external events.
// DUPLICATED VERBATIM in supabase/functions/_shared/ingest-bounds.ts (Deno edge).
// Byte length is measured with new TextEncoder().encode(...).length — TextEncoder is a
// web standard present in BOTH Node (vitest) and the Deno edge runtime with NO polyfill,
// so this module is valid verbatim in both. Do NOT use Buffer (it is not a Deno global).
export const INGEST_MAX_BATCH = 500;
export const INGEST_MAX_PROP_BYTES = 16 * 1024; // 16 KiB, measured on the serialized payload

export interface NormalizedEvent {
  event_type: string;
  subject_type: string; // platform_event.subject_type is NOT NULL; missing -> defaulted to 'user'
  subject_ref: string;
  actor_ref: string | null;
  properties: Record<string, unknown>;
  occurred_at: string;
}

const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function validateIngestEvent(e: unknown):
  { ok: true; value: NormalizedEvent } | { ok: false; error: 'malformed' | 'oversized' } {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, error: 'malformed' };
  const o = e as Record<string, unknown>;
  const event_type = asStr(o['event_type']);
  const subject_ref = asStr(o['subject_ref']);
  const occurred_at = asStr(o['occurred_at']);
  if (!event_type || event_type.length === 0) return { ok: false, error: 'malformed' };
  if (!subject_ref || subject_ref.length === 0) return { ok: false, error: 'malformed' };
  if (!occurred_at || Number.isNaN(Date.parse(occurred_at))) return { ok: false, error: 'malformed' };
  const rawProps = o['properties'];
  const properties = (rawProps && typeof rawProps === 'object' && !Array.isArray(rawProps))
    ? (rawProps as Record<string, unknown>) : {};
  // measure the REAL serialized byte length (UTF-8), not char length.
  // TextEncoder is a web standard in BOTH Node (vitest) and Deno — no Buffer, no polyfill.
  if (new TextEncoder().encode(JSON.stringify(properties)).length > INGEST_MAX_PROP_BYTES) {
    return { ok: false, error: 'oversized' };
  }
  // normalize to known fields ONLY — unknown/extra fields are dropped here.
  // subject_type defaults to 'user' so platform_event.subject_type (NOT NULL) is always satisfied.
  return {
    ok: true,
    value: {
      event_type,
      subject_type: asStr(o['subject_type']) ?? 'user',
      subject_ref,
      actor_ref: asStr(o['actor_ref']),
      properties,
      occurred_at,
    },
  };
}

export function boundBatch(events: unknown):
  { ok: true; value: unknown[] } | { ok: false; error: 'not_array' | 'batch_too_large' } {
  if (!Array.isArray(events)) return { ok: false, error: 'not_array' };
  if (events.length > INGEST_MAX_BATCH) return { ok: false, error: 'batch_too_large' };
  return { ok: true, value: events };
}
```

- [ ] **Step 3: Vitest + boundary gate**

```bash
pnpm --filter @movp/domain test ingest-bounds && bash scripts/check-boundary.sh
```
Expected: `ingest-bounds.test.ts` passes (8 assertions across the two describes); `check-boundary.sh` passes (the new module imports nothing server-only / no consumer directory — it is pure).

- [ ] **Step 4: Gate — the bound is measured on serialized bytes, and the module is pure**

```bash
grep -q "new TextEncoder().encode(JSON.stringify(properties)).length" packages/domain/src/ingest-bounds.ts && echo SERIALIZED_BYTES_OK
grep -c "Buffer" packages/domain/src/ingest-bounds.ts   # must be 0 — Buffer is not a Deno global
grep -cE "^import |from '(~/lib/server|~/components|~/features)" packages/domain/src/ingest-bounds.ts
```
Expected: prints `SERIALIZED_BYTES_OK`; the second grep prints `0` (`Buffer` never appears — the module copies cleanly to Deno, which has no `Buffer` global); the third grep prints `0` (no imports at all — the module is pure and copies cleanly to the Deno runtime).

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/ingest-bounds.ts packages/domain/test/ingest-bounds.test.ts
git commit -m "feat(segmentation): pure ingest-bounds (batch cap + serialized prop-byte cap)"
```

---

### Task 3: `ingest` edge fn (JWT + API-key modes) + `_shared/ingest-bounds.ts` (verbatim) + integration check

**Files:**
- Create: `supabase/functions/_shared/ingest-bounds.ts` (VERBATIM copy of `packages/domain/src/ingest-bounds.ts`)
- Create: `supabase/functions/ingest/deno.json` (import map — mirror `graphql/deno.json`, NOT `flows`)
- Create: `supabase/functions/ingest/index.ts` (Deno edge fn: two auth modes; emits `@movp/obs` on every failure)
- Edit: `supabase/config.toml` (add `[functions.ingest] verify_jwt = false`)
- Edit: `packages/obs/src/event.ts` + `packages/obs/src/emit.ts` (add `'ingest'` to the `Surface` union + `SURFACES` allow-list)

**Interfaces:**
- Consumes: `@movp/auth` `resolvePrincipal(req, env)` (fail-closed union), the `public.ingest_platform_event` RPC (via a service-role client), the pure bounds copy, `Deno.env` (Vault-backed).
- Produces: `POST /ingest` with `{ events: [...] }`. JWT path → insert under `principal.db` (RLS gates the workspace). API-key path (`x-ingest-key`, no JWT) → `rpc('ingest_platform_event', { api_key, events })` (the RPC resolves the workspace). Both stamp `source='external'`; both drop malformed/oversized and are batch-capped. Invariant: no anonymous path; a non-member JWT write is rejected (403); a workspace-A key never writes a workspace-B row.

- [ ] **Step 1: Copy the bounds module VERBATIM into the edge runtime**

```bash
cp packages/domain/src/ingest-bounds.ts supabase/functions/_shared/ingest-bounds.ts
diff packages/domain/src/ingest-bounds.ts supabase/functions/_shared/ingest-bounds.ts && echo BOUNDS_IN_LOCKSTEP
```
Expected: `diff` prints nothing and `BOUNDS_IN_LOCKSTEP` prints (the two copies are byte-identical). The edge fn imports this copy via a relative path; the domain imports its own.

- [ ] **Step 2: Wire the function — `verify_jwt = false`, the `deno.json` import map, and the `ingest` obs surface**

The API-key path carries NO `Authorization` header, so the platform gateway would 401 it before our code runs. Add to `supabase/config.toml`:
```toml
[functions.ingest]
verify_jwt = false
```
The function does its OWN fail-closed auth for both paths — this only moves the auth decision from the gateway into our code (where the API-key path lives).

The `ingest` fn imports `@movp/auth` (which transitively pulls `@supabase/supabase-js` + `jose`) and `@movp/obs`. The `flows` fn maps NONE of these, so do NOT mirror `flows/deno.json`. Create `supabase/functions/ingest/deno.json` mirroring `supabase/functions/graphql/deno.json` (which maps all four):
```json
{
  "imports": {
    "@movp/auth": "../../../packages/auth/src/index.ts",
    "@movp/obs": "../../../packages/obs/src/index.ts",
    "@supabase/supabase-js": "npm:@supabase/supabase-js@2",
    "jose": "npm:jose@5"
  }
}
```

The edge fn emits `@movp/obs` events with `surface: 'ingest'`, but the `Surface` union has no `'ingest'` member yet — an unregistered surface makes `emit()` fire a spurious `observability_enum_violation` on EVERY call. Register it (additive, two tokens). In `packages/obs/src/event.ts`:
```ts
export type Surface = 'graphql' | 'mcp' | 'cli' | 'flows' | 'embed' | 'ingest'
```
In `packages/obs/src/emit.ts`:
```ts
const SURFACES: readonly string[] = ['graphql', 'mcp', 'cli', 'flows', 'embed', 'ingest']
```
Re-run the obs suite to confirm no regression: `pnpm --filter @movp/obs test` (Expected: PASS — adding an allowed surface does not change the existing enum-violation cases).

- [ ] **Step 3: Create the `ingest` edge fn (green)**

Create `supabase/functions/ingest/index.ts` (mirror `supabase/functions/graphql/index.ts`: `Deno.serve` + call-time env + `resolvePrincipal` + `@movp/obs` `emit`; the `flows` fn is NOT the model here — it uses a service-role client only and never calls `resolvePrincipal`):
```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { resolvePrincipal } from '@movp/auth'; // resolved via supabase/functions/ingest/deno.json (mirror graphql, NOT flows)
import { emit, REDACTION_VERSION } from '@movp/obs';
import {
  INGEST_MAX_BATCH, validateIngestEvent, type NormalizedEvent,
} from '../_shared/ingest-bounds.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  // One correlation id pair per request so every emit() below ties together.
  const trace_id = crypto.randomUUID();
  const request_id = crypto.randomUUID();
  // Every failure emits a structured @movp/obs event carrying field NAMES + a bounded
  // error_code ONLY — never the request body, event properties, x-ingest-key, or raw key.
  // (redact() also drops any @-string.) No raw console logging here; emit is the only sink.
  const fail = (status: number, operation: string, error_code: string) => {
    emit({ trace_id, request_id, surface: 'ingest', operation, error_code, redaction_version: REDACTION_VERSION });
    return json(status, { error: error_code });
  };

  if (req.method !== 'POST') return fail(405, 'ingest', 'method_not_allowed');

  // GOTCHA: resolve env at call time (Deno.env, Vault-backed); never module-scope the client.
  // SUPABASE_JWT_ISSUER mirrors functions/graphql/index.ts so a custom-issuer JWT that
  // graphql accepts is not 401'd here (falls back through MOVP_JWT_ISSUER -> default).
  const env = {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    SUPABASE_JWT_ISSUER: Deno.env.get('MOVP_JWT_ISSUER') ?? Deno.env.get('SUPABASE_JWT_ISSUER') ?? undefined,
  };

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !Array.isArray((body as { events?: unknown }).events)) {
    return fail(400, 'ingest', 'events_required');
  }
  const rawEvents = (body as { events: unknown[] }).events;
  if (rawEvents.length > INGEST_MAX_BATCH) return fail(413, 'ingest', 'batch_too_large');

  const ingestKey = req.headers.get('x-ingest-key');
  const hasAuth = (req.headers.get('Authorization') ?? '').length > 0;

  // F6: a request carrying BOTH an ingest key AND a JWT is ambiguous — reject loudly (400),
  // never silently prefer one credential and ignore the other.
  if (ingestKey && hasAuth) return fail(400, 'authenticate', 'ambiguous_auth');

  // ── API-KEY path (service-to-service): an x-ingest-key header present (no JWT) ─
  if (ingestKey) {
    // Service-role client; the RPC resolves the workspace from the HASHED key.
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    // pre-filter/normalize on the edge (defense in depth; the RPC re-validates + is authoritative).
    // validateIngestEvent defaults a missing subject_type to 'user' (platform_event NOT NULL).
    const clean = rawEvents
      .map(validateIngestEvent)
      .filter((r): r is { ok: true; value: NormalizedEvent } => r.ok)
      .map((r) => r.value);
    const { data, error } = await admin.rpc('ingest_platform_event', { api_key: ingestKey, events: clean });
    if (error) {
      // F7: branch on SQLSTATE (error.code), NEVER error.message. 28000=invalid key -> 401;
      // 54000=batch too large -> 413; anything else is an operational failure -> 500.
      if (error.code === '28000') return fail(401, 'ingest_key', 'invalid_ingest_key');
      if (error.code === '54000') return fail(413, 'ingest_key', 'batch_too_large');
      return fail(500, 'ingest_key', 'ingest_failed');
    }
    const result = data as { inserted: number; dropped: number };
    if (result.dropped > 0) {
      emit({ trace_id, request_id, surface: 'ingest', operation: 'ingest_key', error_code: 'events_dropped', redaction_version: REDACTION_VERSION });
    }
    return json(200, result); // { inserted, dropped }
  }

  // ── JWT path (first-party): Authorization: Bearer <jwt> ─────────────────────
  const principal = await resolvePrincipal(req, env);
  if (!principal.ok) return fail(401, 'authenticate', principal.code); // fail-closed: never proceed anonymously
  // principal.db is an anon-key client carrying the caller's Bearer token → RLS applies.

  let dropped = 0;
  const rows: Array<Record<string, unknown>> = [];
  for (const e of rawEvents) {
    const v = validateIngestEvent(e);
    if (!v.ok) { dropped++; continue; }
    // workspace_id is per-event or top-level; RLS `with check is_workspace_member` gates it.
    const wsId = (e as { workspace_id?: unknown }).workspace_id ?? (body as { workspace_id?: unknown }).workspace_id;
    if (typeof wsId !== 'string') { dropped++; continue; }
    rows.push({
      workspace_id: wsId,
      event_type: v.value.event_type,
      subject_type: v.value.subject_type, // always a string ('user' default) — platform_event NOT NULL
      subject_ref: v.value.subject_ref,
      actor_ref: v.value.actor_ref,
      source: 'external',
      properties: v.value.properties,
      occurred_at: v.value.occurred_at,
      ingested_at: new Date().toISOString(),
    });
  }
  if (rows.length === 0) {
    if (dropped > 0) emit({ trace_id, request_id, surface: 'ingest', operation: 'ingest_jwt', error_code: 'events_dropped', redaction_version: REDACTION_VERSION });
    return json(200, { inserted: 0, dropped });
  }
  // Atomic batch insert: a non-member workspace_id in ANY row makes RLS reject the
  // whole batch (42501) — fail LOUD (403), never a silent partial/anonymous success.
  const { error } = await principal.db.from('platform_event').insert(rows);
  if (error) {
    // F7: branch on SQLSTATE (error.code), NEVER error.message. 42501=RLS reject (non-member).
    return fail(error.code === '42501' ? 403 : 500, 'ingest_jwt',
      error.code === '42501' ? 'not_a_member' : 'ingest_failed');
  }
  if (dropped > 0) emit({ trace_id, request_id, surface: 'ingest', operation: 'ingest_jwt', error_code: 'events_dropped', redaction_version: REDACTION_VERSION });
  return json(200, { inserted: rows.length, dropped });
});
```
GOTCHA: never pass `body`, event `properties`, `x-ingest-key`, `ingestKey`, or the RPC/insert payload to `emit()` — emit only the `operation` + a bounded `error_code` (field names/codes). There is NO raw `console.*` in this file; `@movp/obs` `emit()` is the only diagnostic sink (its `redact()` drops any `@`-string as a backstop).

- [ ] **Step 4: Integration check (both paths, against the local stack)**

Serve the function and assert both paths. The API-key path proves workspace isolation; the JWT path proves the RLS gate. Mirror the collaboration slice's local-stack env (`$DB_URL`, `$FUNCTIONS_URL`, member JWTs). Seed W1 (member A) + W2 (member B, NOT in W1):
```bash
supabase functions serve ingest &   # env from supabase/.env (SUPABASE_URL/ANON/SERVICE_ROLE_KEY)
W1='11111111-1111-1111-1111-111111111111'; W2='22222222-2222-2222-2222-222222222222'

# ── API-KEY path: a W1 key writes W1 only (payload workspace_id=W2 is ignored) ──
# The event OMITS subject_type on purpose -> the RPC coalesces it to 'user'; the row
# landing (and the subject_type check below) prove a missing subject_type never aborts.
RAW="$(psql "$DB_URL" -tAc "select public.mint_ingest_key('$W1','svc');" | tr -d '[:space:]')"
curl -sS "$FUNCTIONS_URL/ingest" -H "x-ingest-key: $RAW" -H 'content-type: application/json' \
  -d '{"events":[{"event_type":"signup","subject_ref":"u1","occurred_at":"2026-07-01T00:00:00Z","workspace_id":"'"$W2"'"}]}' >/dev/null
[ "$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$W1' and source='external';" | tr -d '[:space:]')" = "1" ] || { echo FAIL_KEY_W1; exit 1; }
[ "$(psql "$DB_URL" -tAc "select subject_type from public.platform_event where workspace_id='$W1' and subject_ref='u1';" | tr -d '[:space:]')" = "user" ] || { echo FAIL_SUBJECT_TYPE_DEFAULT; exit 1; }
[ "$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$W2';" | tr -d '[:space:]')" = "0" ] || { echo FAIL_KEY_ISOLATION; exit 1; }

# ── JWT path: member A writes W1; a non-member workspace (W2) is rejected 403 ──
A="$(curl -sS -o /dev/null -w '%{http_code}' "$FUNCTIONS_URL/ingest" \
  -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d '{"events":[{"event_type":"login","subject_type":"user","subject_ref":"u2","occurred_at":"2026-07-01T00:03:00Z","workspace_id":"'"$W1"'"}]}')"
[ "$A" = "200" ] || { echo "member JWT write not accepted (got $A)"; exit 1; }
NM="$(curl -sS -o /dev/null -w '%{http_code}' "$FUNCTIONS_URL/ingest" \
  -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d '{"events":[{"event_type":"login","subject_ref":"u9","occurred_at":"2026-07-01T00:04:00Z","workspace_id":"'"$W2"'"}]}')"
[ "$NM" = "403" ] || { echo "non-member workspace JWT write not rejected (got $NM)"; exit 1; }
echo INGEST_AUTHZ_OK
```
Expected: `INGEST_AUTHZ_OK` — the API-key path writes only the key's workspace (payload `workspace_id` ignored) and the row lands with `subject_type='user'` (the omitted `subject_type` was defaulted, NOT dropped — the batch committed); the JWT path accepts a member's own-workspace write and rejects (403) a write to a workspace the caller is not a member of. (This may fold into the Part-D e2e `[ingest]` slice; either location is fine as long as it runs.)

- [ ] **Step 5: Gate — verbatim bounds, fail-closed auth, no key logging**

```bash
diff packages/domain/src/ingest-bounds.ts supabase/functions/_shared/ingest-bounds.ts && echo BOUNDS_IN_LOCKSTEP
grep -q "if (!principal.ok) return fail(401" supabase/functions/ingest/index.ts && echo FAIL_CLOSED_OK
grep -c "verify_jwt = false" supabase/config.toml
# F3: the ingest fn has its OWN import map mapping @movp/auth (mirrors graphql, NOT flows)
test -f supabase/functions/ingest/deno.json && grep -q "@movp/auth" supabase/functions/ingest/deno.json && echo DENO_JSON_OK
grep -q "'ingest'" packages/obs/src/event.ts && echo OBS_SURFACE_REGISTERED_OK
# F4: every failure emits a structured @movp/obs event; no raw console; the body/props/key
# are NEVER arguments to a log/emit call (only field names + bounded codes are emitted).
grep -q "from '@movp/obs'" supabase/functions/ingest/index.ts && echo OBS_IMPORTED_OK
[ "$(grep -c 'console\.' supabase/functions/ingest/index.ts)" = "0" ] && echo NO_RAW_CONSOLE_OK
# strip line-comments first so a prose comment can't false-positive; then a real emit()/console
# call carrying a forbidden identifier is the only way this matches.
sed 's://.*::' supabase/functions/ingest/index.ts | grep -nE "emit\(|console\." \
  | grep -E "body|properties|ingestKey|api_key|x-ingest-key" \
  && { echo CONTENT_LEAK_FOUND; exit 1; } || echo LOG_CONTENT_DISCIPLINE_OK
# F5/F6/F7: custom JWT issuer honored; ambiguous both-creds rejected; errors branch on SQLSTATE
grep -q "MOVP_JWT_ISSUER" supabase/functions/ingest/index.ts && echo JWT_ISSUER_OK
grep -q "ambiguous_auth" supabase/functions/ingest/index.ts && echo AMBIGUOUS_AUTH_OK
grep -q "error.code === '28000'" supabase/functions/ingest/index.ts && echo SQLSTATE_BRANCH_OK
```
Expected: `BOUNDS_IN_LOCKSTEP` (byte-identical copies); `FAIL_CLOSED_OK` (401 on `!principal.ok`, via `fail(...)` so it also emits); `verify_jwt = false` count `1`; `DENO_JSON_OK` + `OBS_SURFACE_REGISTERED_OK` (F3: own import map with `@movp/auth`; the `ingest` obs surface is registered so `emit` does not fire an enum violation); `OBS_IMPORTED_OK` + `NO_RAW_CONSOLE_OK` + `LOG_CONTENT_DISCIPLINE_OK` (F4: obs-only diagnostics, and `body`/`properties`/`ingestKey`/`api_key`/`x-ingest-key` never appear on an `emit`/`console` line); `JWT_ISSUER_OK` (F5), `AMBIGUOUS_AUTH_OK` (F6: both-credentials → 400), `SQLSTATE_BRANCH_OK` (F7: branch on `error.code`, not `error.message`).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/ingest-bounds.ts supabase/functions/ingest/index.ts supabase/functions/ingest/deno.json supabase/config.toml packages/obs/src/event.ts packages/obs/src/emit.ts
git commit -m "feat(segmentation): ingest edge fn (JWT + API-key) + verbatim bounds copy"
```

---

### Task 4: e2e-ready slice — drive both ingestion paths end-to-end

**Files:**
- Create/Edit: the e2e `[ingest]` slice (clone the committed collaboration slice; `test(e2e): add collaboration slice`)

**Interfaces:**
- Consumes: the served `ingest` edge fn, `mint_ingest_key` (via the service-role client / CLI), a first-party member JWT, `public.platform_event` (assert landed rows).
- Produces: an executable e2e slice that exercises BOTH paths against a fresh local stack. Invariant: after the slice, `platform_event` holds exactly the events the slice submitted, all `source='external'`, all in the intended workspace — and NONE in a workspace the caller could not reach.

- [ ] **Step 1: Add the `[ingest]` slice (clone the collaboration slice harness)**

Mirror the collaboration slice's setup (fresh `supabase db reset`, seeded workspace + member, `supabase functions serve`, captured member JWT). The slice drives both paths and asserts the normalized rows:
```
[ingest] external event ingestion
  setup:   reset the stack; seed W1 (owner A) + W2 (owner B, not in W1); serve `ingest`.
  api-key: mint a W1 key via `mint_ingest_key`; POST a 3-event batch with `x-ingest-key`
           (one event carries workspace_id=W2 in its body; one event OMITS subject_type).
    assert: response { inserted: 3, dropped: 0 }; 3 platform_event rows in W1 (source=external);
            0 rows in W2 (the payload workspace_id is ignored — workspace comes from the key);
            the subject_type-less row landed with subject_type='user' (defaulted, NOT dropped —
            platform_event.subject_type is NOT NULL, so a missing value must never abort the batch).
  bounds:  POST a batch with one malformed (no subject_ref) + one oversized (>16KiB properties) event.
    assert: those two are dropped ({ dropped: 2 }); only the valid events land.
  jwt:     as member A, POST events with workspace_id=W1 -> 200, rows land under source=external.
    assert: as member A, POST an event with workspace_id=W2 -> 403 (RLS rejects the non-member write).
  teardown: stop the served function.
```
Keep every submitted event's `properties` small; assert on counts + `source`, never on raw `properties` bytes (content discipline). Use the raw key returned by `mint_ingest_key` immediately (it is emitted once).

- [ ] **Step 2: Run the slice (gate)**

```bash
# invoke however the collaboration slice is run (e.g. the e2e runner filtered to the ingest slice)
pnpm e2e --grep ingest    # or: bash e2e/run.sh ingest  — match the repo's committed runner
```
Expected: the `[ingest]` slice passes — both paths land normalized `source='external'` rows in the intended workspace, the API-key path ignores the payload `workspace_id`, malformed/oversized events are dropped, and the non-member JWT write is rejected 403.

- [ ] **Step 3: Gate — the slice drives BOTH paths and asserts isolation**

```bash
grep -q "x-ingest-key" e2e/*ingest* && echo API_KEY_PATH_DRIVEN
grep -q "Authorization" e2e/*ingest* && echo JWT_PATH_DRIVEN
grep -q "source" e2e/*ingest* && echo ASSERTS_EXTERNAL_SOURCE
```
Expected: prints `API_KEY_PATH_DRIVEN`, `JWT_PATH_DRIVEN`, and `ASSERTS_EXTERNAL_SOURCE` (the slice exercises both auth modes and asserts the ingested rows are `source='external'`).

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): add external-ingestion slice (JWT + API-key paths)"
```

---

## Self-Review

- **Spec coverage (Part B scope):** the `movp_internal.ingest_key` registry + `mint_ingest_key` (raw-once, service-role-only) + `ingest_platform_event` (workspace-from-key, bounded, `{inserted,dropped}`) with pgTAP (Task 1); the pure `ingest-bounds.ts` + Vitest (Task 2); the `ingest` edge fn (JWT path via RLS-bound `principal.db`, API-key path via the service-role RPC) + the verbatim `_shared` bounds copy + its own `deno.json` import map (mirror graphql) + the registered `'ingest'` obs surface + per-failure `@movp/obs` emit + `verify_jwt=false` + the integration check (Task 3); the e2e `[ingest]` slice driving both paths (Task 4). Every SQL/domain task is TDD (red → green) and ends with a machine-checkable gate: SQL tasks run `supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff` + a targeted grep; the domain task runs Vitest + `check-boundary.sh` + a grep; the edge task runs a served-function integration check + a `diff`/grep gate.
- **`ingest_key` columns (verbatim):** `id uuid pk default gen_random_uuid()`, `workspace_id uuid not null references public.workspace(id) on delete cascade`, `key_hash text not null unique` (= `encode(extensions.digest(raw,'sha256'),'hex')`), `label text`, `active boolean not null default true`, `created_at timestamptz not null default now()`. RLS enabled with no policies; `revoke all … from anon, authenticated`; `grant all … to service_role` (mirrors `movp_internal.webhooks`).
- **`ingest_platform_event` signature + return:** `public.ingest_platform_event(api_key text, events jsonb) returns jsonb` → `jsonb_build_object('inserted', n_ok, 'dropped', n_bad)`. It resolves `workspace_id` from `ingest_key` by `encode(extensions.digest(api_key,'sha256'),'hex')` (active only; else raise `28000`), caps the batch at 500 (raise `54000`), drops per-event on missing `event_type`/`subject_ref`/`occurred_at` or `octet_length(properties::text) > 16384`, and stamps every insert with `source='external'`, `ingested_at=now()`, `subject_type = coalesce(events->>'subject_type','user')` (satisfies `platform_event.subject_type` NOT NULL from Part A), and the KEY's `workspace_id` — never `events->>'workspace_id'`. The per-row `INSERT` is wrapped in `begin … exception when others then n_bad := n_bad + 1; continue; end;` so a single-row failure is a counted DROP, never a whole-batch abort (the RPC's `occurred_at` cast handler guards only the cast — the INSERT needs its own).
- **Two auth modes (both server-resolved workspace):** (1) **JWT** — `Authorization: Bearer <jwt>` → `resolvePrincipal(req, env)` (fail-closed; 401 on `!ok`) → insert under `principal.db` where RLS `with check public.is_workspace_member(workspace_id)` rejects a non-member write (403 on `42501`); `source='external'`. (2) **API-key** — `x-ingest-key: <raw_key>` and NO JWT → service-role client → `rpc('ingest_platform_event', { api_key, events })`, which derives the workspace from the hashed key. A client `workspace_id` is never trusted on the API-key path.
- **Bound constants:** `INGEST_MAX_BATCH = 500`, `INGEST_MAX_PROP_BYTES = 16 * 1024` (16384). Measured on serialized bytes: `new TextEncoder().encode(JSON.stringify(properties)).length` in TS (a web standard present in BOTH Node/vitest and Deno with no polyfill — `Buffer` is deliberately avoided as it is not a Deno global), `octet_length((properties)::text)` in SQL (a superset discriminator — never under-counts a real oversize; not claimed byte-for-byte identical to the client's exact JSON).
- **Correctness / self-consistency:** the pgTAP calls the RPC ONCE into a temp table so `inserted`/`dropped` read one result; event #1 carries `workspace_id=W2` to prove the payload id is ignored (2 rows in W1, 0 in W2); event #2 OMITS `subject_type` to prove the `coalesce(...,'user')` default lands (asserted `subject_type='user'`), so a missing value never aborts the batch; the oversized event uses `repeat('x',20000)` (> 16 KiB); `plan(12)` matches the twelve assertions. `octet_length` / `length` / `encode` / `jsonb_*` are pg_catalog (unqualified is correct even under `search_path=''`); pgcrypto (`digest`, `gen_random_bytes`) is `extensions`-qualified.
- **Safety / observability:** both RPCs are hardened `SECURITY DEFINER` (`set search_path=''`, fully qualified, `execute` revoked from public/anon/authenticated and granted to service_role only) and pass `check-definer-audit.mjs`. Keys are stored hashed (raw emitted once, never logged); `mint_ingest_key` is service-role-only (a member cannot self-issue). The edge fn is fail-closed (401 on `!principal.ok`), rejects non-member writes loudly (403), rejects an ambiguous both-credentials request (400 `ambiguous_auth`, so an `x-ingest-key` is never silently ignored in favour of a JWT), and branches every DB error on SQLSTATE (`error.code`), NOT `error.message` (28000→401, 54000→413, 42501→403). It emits a structured `@movp/obs` event (`surface: 'ingest'`, correlated `trace_id`/`request_id`) on EVERY failure branch and on a partial-drops summary — field NAMES + a bounded `error_code` only, never the key, `body`, `properties`, or `x-ingest-key`; there is NO raw `console.*` (a content-discipline grep asserts those identifiers never appear on an `emit`/`console` line, and `'ingest'` is registered in the obs `Surface` union so `emit` does not fire an enum violation). `ingest_key` lives in the private `movp_internal` schema with RLS on and no policies.
- **Reliability / efficiency / performance:** malformed/oversized events are dropped (never buffered), the batch is capped before any insert, and oversize is rejected with `413`/`54000`. The JWT path uses a single atomic batch insert (a non-member row rejects the whole batch — a loud, safe 403, not a partial write); the API-key path pre-filters on the edge (defense in depth) and the RPC re-validates authoritatively. The key lookup is a single unique-index hit on `key_hash`. No new event type, no async fan-out, no codegen — `supabase db diff` stays empty.
- **Deferred (intentional):** no key rotation/revocation UI (a key is deactivated by setting `active=false`, filtered out of the lookup); no per-key rate limit (a follow-up if abuse appears); no domain `SegmentationService.ingest()` method (ingestion is edge-fn + RPC only — `ingest-bounds.ts` is unit-tested in the domain but the write path is the endpoint). None are needed for the DB/edge deliverable.
- **Executor reconciliation flags (stated, not hidden):** (1) the `platform_event` INSERT column list + its member INSERT policy (`with check is_workspace_member`) and the freely-settable `source='external'` are Part A's contract — reconcile the insert columns / NOT NULL set against the committed `000019`. Per Part A's cross-part contract, `subject_type` is **NOT NULL** (defaulted to `'user'` in both the RPC via `coalesce` and the domain `validateIngestEvent`), `actor_ref` is nullable, `properties` defaults `{}`, and every insert MUST set `workspace_id`/`source`/`occurred_at`/`ingested_at` (no defaults). (2) `@movp/auth`'s `resolvePrincipal` and `@movp/obs`'s `emit` are imported by the edge fn exactly as the `graphql` function imports them — the `ingest` fn's own `deno.json` maps `@movp/auth`/`@movp/obs`/`@supabase/supabase-js`/`jose` (mirror `graphql/deno.json`; the `flows` fn is NOT the model — it maps none of these and never calls `resolvePrincipal`), and the `env` bag shape (incl. `SUPABASE_JWT_ISSUER`) matches graphql. (3) The e2e slice's runner invocation (`pnpm e2e --grep ingest` vs `bash e2e/run.sh`) must match the committed collaboration-slice runner. (4) `service_role` execute is granted explicitly on both RPCs because `revoke … from public` also removes the implicit grant — the service-role edge client and the operator mint path both need it.
- **Placeholder scan:** none — every SQL/TS/bash block is complete and copy-paste-ready with an exact command + expected output. The only "mirror the committed X" pointers are the collaboration-slice harness (Task 4), the `graphql` fn + `graphql/deno.json` import map for `@movp/auth`/`@movp/obs` (Task 3 — NOT `flows`, which lacks both), and the `movp_internal.webhooks` registry precedent (Task 1) — all named, none invented.
