# Stage C5 — Integration Fabric — Design

**Date:** 2026-07-11
**Status:** design settled; TDD series (C5a/b/c) to be authored from this doc.
**Depends on:** C3 (PATs/CLI) ✅, and the existing ingest/webhook/segmentation machinery.
**Precondition to execute:** none beyond `main` (C1–C4 merged).

## Goal

A pre-existing CRM or custom app can sync bidirectionally with MOVP **without reading
source** — via idempotent event ingest, a stable external-identity landing collection, a
documented RLS-guarded PostgREST facade, and copy-paste CRM/Zapier/n8n recipes.

## What already exists (C5 is fabric, not greenfield)

- `public.platform_event` (DSL collection, in the **frozen** baseline) + the
  `ingest_platform_event(api_key, events jsonb)` RPC and `supabase/functions/ingest` edge
  fn (auth-before-buffer, capped stream reader, workspace-from-keyhash) — from Segmentation.
- `webhook_subscription` + the `flows` worker (outbound delivery) — from Workflows (app-06).
- PATs + CLI + the hosted MCP — from C3. These are the sync-worker's auth + transport.
- `emit_event(ev_type, ws, payload, trace)` + per-collection creation triggers
  (`note_created_emit_event`, `AFTER INSERT` only) — the event-emission precedent.
- `prune_internal_retention` — the dedupe/retention precedent; `movp_jobs.idempotency_key`
  is the existing idempotency-key precedent.

## Settled decisions

- **A — External records land in a dedicated `external_record` collection** (not a generic
  cross-collection mapping, not per-collection columns). One known target table ⇒ the upsert
  RPC has **no dynamic-collection injection surface**, and *records* (entities) are cleanly
  separated from *events* (the `platform_event` stream).
- **B — `external_record` is a first-class config-first collection emitted via the existing
  generated-delta registry** (NOT a per-collection schema flag). Only the SQL baseline is
  frozen; `emitTypes` + Pothos/MCP/CLI builders regenerate every build, so `external_record`
  gets auto GraphQL/MCP/CLI/types for free by being in the DSL. Its **SQL DDL** is kept out
  of the frozen baseline by the delta registry (see Codegen below).
- **C — The PostgREST exposure boundary is audited + documented as-is; no grant changes.**
  Verified against the live schema: `anon` is fully denied; `movp_internal` is unreachable
  by `anon`/`authenticated`; members can read **and write** `public` tables via PostgREST,
  RLS-scoped to their workspace — the app itself depends on this (`ctx.db.from(...)`).
  Therefore **`internal:true` is a GraphQL-surface flag, NOT a PostgREST hiding mechanism**;
  the enforceable guarantee is RLS workspace-isolation + anon-denial + `movp_internal` hidden.

## Decomposition

| Part | Scope | Roadmap tasks |
|---|---|---|
| **C5a** | Idempotent ingest + `external_record` foundation (DB + codegen) | C5.1, C5.2 |
| **C5b** | PostgREST exposure audit + REST-facade docs | C5.3 |
| **C5c** | CRM recipes + Zapier/n8n templates + `[integration]` slice | C5.4, C5.5, C5.6 |

---

## C5a — ingest idempotency + `external_record`

### Codegen: post-freeze collection via the delta registry (Finding 1 fix)

Do **not** add a `postFreeze`/DDL-routing attribute to `CollectionDef` — collection flags are
codegen-transparent w.r.t. DDL (`packages/core-schema/src/types.ts:37`). Instead, extend the
existing registry so a delta **owns** its collections:

```ts
// packages/codegen/src/generate.ts
export interface GeneratedDelta {
  file: string
  emit: (schema: MovpSchema) => string
  collections?: readonly string[]   // collections this delta owns; excluded from baseline
}
export const GENERATED_DELTAS: readonly GeneratedDelta[] = [
  { file: '20260711000001_movp_generated_reporting.sql', emit: emitReportingSql },
  { file: '20260712000001_movp_generated_external_record.sql',
    emit: (s) => emitCollectionsSql(s, ['external_record']),
    collections: ['external_record'] },
]
```

- Refactor `emit-sql.ts` to expose `emitCollectionSql(collection)`; `emitSqlMigration(schema)`
  emits every collection **except** `deltaOwnedCollections()` (= `GENERATED_DELTAS.flatMap(d => d.collections ?? [])`); `emitCollectionsSql(schema, names)` emits only the named ones with the identical per-collection path.
- **Frozen-vs-delta ownership lives in the registry, keyed by migration filename** — single
  source of truth. The baseline output for pre-existing collections is byte-identical, so the
  forward-only + baseline-drift guards still pass.
- **Gate:** `pnpm codegen && git diff --exit-code` shows only the new delta migration; the
  baseline `20260701000002_movp_generated.sql` is unchanged. `emit-reporting`/`generate` unit
  tests stay green; add a test asserting a delta-owned collection is absent from the baseline
  emit and present in the delta emit.

### `external_record` collection + idempotent event emission (Finding 2 fix)

- Collection: `workspace_id`, `source` (text/enum), `external_id` (text), `payload` (jsonb),
  `created_at`, `updated_at`; **`UNIQUE(workspace_id, source, external_id)`**; RLS via
  `is_workspace_member`. `internal: false` — full auto GraphQL/MCP/CLI surfaces (per decision B).
- **Identity is immutable at the DB layer** (the external-ref convention *depends* on a stable
  `(source, external_id)` key). Because `internal:false` routes `external_record` through the
  generic mutation builders, a generic `update`/`delete` must not be allowed to silently
  re-point or drop an integration record:
  - `BEFORE UPDATE` trigger `external_record_identity_immutable` raises a stable
    `external_ref_identity_immutable` error if `NEW.source IS DISTINCT FROM OLD.source OR
    NEW.external_id IS DISTINCT FROM OLD.external_id`. Defends **every** write path (generic,
    RPC, raw PostgREST); the `upsert` RPC never touches identity (it's the conflict key), so
    this only bites a generic identity mutation.
  - **No generic `DELETE`:** grant SELECT/INSERT/UPDATE RLS policies to `authenticated`, but
    **no DELETE policy** → generic deletes are denied. Record removal (if ever needed) is a
    future RPC (deferred, YAGNI) — v1 sync only upserts.
  - Payload updates + inserts remain allowed; `UNIQUE` blocks duplicate ids; the emit trigger's
    `WHEN (OLD.payload IS DISTINCT FROM NEW.payload)` guard keeps a same-payload replay
    event-idempotent. `upsert_by_external_ref` is the recommended idempotent CRM write path.
- **`upsert_by_external_ref(source, external_id, payload)`** — INVOKER, workspace from the
  caller's JWT/PAT, RLS-scoped:

  ```sql
  insert into public.external_record (workspace_id, source, external_id, payload)
  values (<ws>, source, external_id, payload)
  on conflict (workspace_id, source, external_id) do update
    set payload = excluded.payload, updated_at = now()
    where public.external_record.payload is distinct from excluded.payload   -- no-op replay = no write
  returning ...;   -- RPC re-selects the row when the guarded update is a no-op
  ```

- **Event via trigger, insert-and-real-change only** (NOT `AFTER INSERT OR UPDATE`):
  - `AFTER INSERT` → `emit_event('external.record.upserted', new.workspace_id, {id, source, external_id}, ...)`.
  - `AFTER UPDATE ... FOR EACH ROW WHEN (OLD.payload IS DISTINCT FROM NEW.payload)` → same emit.
  - Write-path-agnostic (RPC, generic, raw PostgREST) and idempotent: replay of identical
    `source+external_id+payload` produces **exactly one** event over its lifetime.
- **Invariant:** segmentation/automation consume `external.record.upserted` with zero new
  infra (the event stream is the seam).
- **Tests (pgTAP):** upsert insert→1 row+1 event; replay same payload→still 1 row, **0 new
  events, 0 new dispatches**; changed payload→1 update, 1 new event; **generic update of
  `source`/`external_id`→rejected (`external_ref_identity_immutable`)**; **generic
  `DELETE`→denied**; cross-workspace denied; `UNIQUE` holds.

### Idempotent `platform_event` ingest

- New table `ingest_idempotency(workspace_id, idempotency_key, payload_hash, event_id, created_at)`,
  `UNIQUE(workspace_id, idempotency_key)` — **do not mutate the frozen `platform_event`**.
- Extend `ingest_platform_event`: optional per-event `idempotency_key`; `payload_hash` derived
  over the **effective submitted event payload** (idempotency rule). On conflict: same hash →
  return existing `event_id` (replay, success); different hash → **stable conflict errcode**
  (e.g. `23505`-mapped `idempotency_conflict`) + a **keys-only** obs event (field names, never
  payload values). Pruned by `prune_internal_retention`.
- **Tests (pgTAP + ingest slice):** same key+payload twice → one event; same key + different
  payload → conflict code; conflict emits a content-disciplined obs event.

---

## C5b — PostgREST exposure audit + REST-facade docs

- **Audit test (CI), real PostgREST, `anon` + two member JWTs:** anon read/write denied;
  `movp_internal` unreachable; member reads/writes **only** their own workspace across
  representative `public` tables spanning both surface classes — **surfaced** (`note`, and the
  `internal:false` `external_record`) and **`internal:true`** (`content_item`) — proving
  `internal:true` is *not* a PostgREST boundary; a second member cannot read/write the first's
  rows. Assert on HTTP status + row counts, not just grants.
- **`docs/rest.md`:** PostgREST *is* the RLS-guarded REST facade (auth = user JWT / PAT-minted
  session); anon + `movp_internal` are out; **correct `internal:true` as a GraphQL-surface flag,
  not a hiding mechanism**; invariant-bearing writes (task+revision atomicity, idempotent
  ingest, `upsert_by_external_ref`) go through the documented RPCs; direct member writes are
  RLS-safe but skip app validation (contained to their workspace).
- **Gate:** exposure audit is a CI job; docs lint (link/anchor check).

## C5c — recipes, templates, integration slice

- **CRM recipes** (`docs/integrations/`): HubSpot/Salesforce/Attio — outbound
  (`webhook_subscription` → transformer worker → CRM API) and inbound (CRM webhook →
  `ingest` / `upsert_by_external_ref`). One **mock sync worker** (example dir) using a PAT +
  the CLI, with a CI smoke against a **mock CRM endpoint** (no real network).
- **Zapier/n8n templates:** importable JSON with placeholders + security notes; a lint script
  validates JSON shape and that no secrets are inlined.
- **`[integration]` slice** (`scripts/slice-e2e.sh`): idempotent ingest → automation/webhook →
  `external_ref` upsert → PostgREST read audit — end to end, fail-loud.
- **Gate:** full CI incl. the integration slice; C5 review ≥ 9.2.

## Cross-cutting invariants

- Forward-only migrations — new timestamped files only; the delta registry keeps the baseline
  frozen. No in-place edits to merged migrations.
- Observability: every conflict/error path emits a **keys-only**, workspace-hashed,
  actor-attributed event — never payload values, external ids as values, or raw CRM bodies.
- Codex-executable: copy-paste-correct SQL/TS samples, platform gotchas commented at the
  trigger site (`readServerEnv(ctx.locals)` not `process.env`; ctx-at-call-time), each task
  ends in a mechanical gate (pgTAP name / `git diff --exit-code` / exposure audit / lint /
  slice), no task depends on facts outside its own text.

## Deferred (documented as future, not built)

Bundled connector runtime / marketplace, field-mapping UI, CDC / logical-replication streaming.
Ingest + webhooks + `external_record` upsert suffice for v1 bidirectional sync.

## Open risks

- The `emit-sql.ts` refactor to `emitCollectionSql` must preserve byte-identical baseline
  output — the `git diff --exit-code` gate is the backstop.
- `upsert_by_external_ref`'s no-op-conflict path returns no `RETURNING` row; the RPC must
  re-select to return the current row (covered by a pgTAP replay assertion).
