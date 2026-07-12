# MOVP Stage C5a — Idempotent Ingest + `external_record` Foundation

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. Transcribe the code samples verbatim — they are grounded in the real
> committed code (line-verified 2026-07-11). **Precondition: C4 merged** (PR #13 `fab464f`).
> This is the first of three plans (`c5a`…`c5c`) expanded from the settled design doc
> `2026-07-11-movp-stage-c05-integration-fabric-design.md` and the Stage C roadmap §C5.
> REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.

**Goal:** stand up the integration data layer — a config-first `external_record` landing
collection (emitted OUT of the frozen baseline via the generated-delta registry), with
immutable external identity + write-path-agnostic idempotent event emission, an idempotent
`upsert_by_external_ref` RPC, and optional idempotency keys on `platform_event` ingest.

**Architecture — the linchpin:** adding a collection to the DSL would change
`emitSqlMigration(schema)` output and trip the frozen-baseline drift guard
(`packages/codegen/src/generate.ts`). C5a.1 therefore teaches the **existing** generated-delta
registry to *own* collections: a delta entry declares `collections: [...]`, the baseline
emitter excludes delta-owned collections (single source of truth = the filename-keyed
registry, never a per-collection schema flag), and the delta reuses the existing
`emitCollectionSql`. `external_record` then enters the DSL (auto types/GraphQL/MCP/CLI for
free) while its SQL lands in a pinned delta migration and the baseline stays byte-identical.
Identity immutability, the no-DELETE grant, and the idempotent emit triggers are a hand
migration (mirroring how `platform_event`'s policies/indexes/immutability were hand-added in
`20260701000019_segmentation.sql`).

**Tech stack:** TypeScript (`@movp/codegen`, `@movp/core-schema`, vitest string-containment
tests, `tsx`), Postgres 17 + pgTAP, Supabase CLI (`supabase db reset`, `supabase test db`,
`supabase db diff`), Deno edge functions.

## Global Constraints (every task inherits these)

- **TDD, failing test first.** Each task adds its failing test/gate and proves the stated
  RED before implementing.
- **Migration timestamp pre-flight.** Fetch `main`; if `supabase/migrations/` contains any
  filename sorting after `20260712000004_*`, re-timestamp C5a's four migration filenames
  (delta `20260712000001`, guards `20260712000002`, upsert RPC `20260712000003`, ingest
  idempotency `20260712000004`) so they remain consecutive and sort last, updating every
  reference incl. the `GENERATED_DELTAS` entry. Once a C5 migration merges it is
  forward-only — never rename or edit it.
- **The frozen baseline `supabase/migrations/20260701000002_movp_generated.sql` must stay
  byte-identical to `main`** (`git diff --exit-code` on it after codegen). Guard:
  `node scripts/check-forward-only-migrations.mjs`.
- **`@movp/*` import rules:** bare specifiers between packages; explicit `.ts` extensions on
  relative imports.
- **Generated SQL is idempotent** (`create table if not exists`, `create or replace`,
  metadata upserts) so a delta can be regenerated until it merges.
- **Every SECURITY DEFINER function pins `set search_path = ''`** and fully-qualifies names
  (`public.`, `movp_internal.`). Member gate uses `public.is_workspace_member(ws)` +
  `(select auth.uid())`. Denials raise SQLSTATE `42501`.
- **Observability is keys-only:** conflict/error events log field NAMES + a workspace hash +
  bounded classifiers — never payload values, external ids as values, or raw request bodies.
- **Per-task gate + one commit per task.** A task is done only when its gate passes.

## Baselines (verify before starting)

| Fact | Value | Source |
|---|---|---|
| Frozen baseline migration | `20260701000002_movp_generated.sql` | codegen |
| Last merged migration | `20260711000003_reporting_bi.sql` | C4 (PR #13) |
| pgTAP count on `main` | 666 across 33 files | `supabase test db` |
| Reusable per-collection emitter | `emitCollectionSql(c)` `emit-sql.ts:360` | codegen |
| Baseline entry | `emitSqlMigration(schema)` `emit-sql.ts:385` | codegen |
| Delta registry | `GENERATED_DELTAS` `generate.ts:14` | codegen |
| Ingest RPC to extend | `ingest_platform_event(api_key text, events jsonb)` | `20260701000020` |
| Event emitter | `emit_event(ev_type text, ws uuid, payload jsonb, trace text)` | `20260701000005:138` |

## File Structure

- `packages/codegen/src/generate.ts` — add `collections?` to `GeneratedDelta`; baseline excludes delta-owned.
- `packages/codegen/src/emit-sql.ts` — `emitSqlMigration(schema, {excludeCollections, excludeEvents})`; new `emitDeltaSql`.
- `packages/core-schema/src/collections/external_record.ts` — new DSL collection.
- `packages/core-schema/src/schema.ts`, `.../index.ts` — register + export it.
- `supabase/migrations/20260712000001_movp_generated_external_record.sql` — generated delta (codegen output).
- `supabase/migrations/20260712000002_external_record_guards.sql` — unique + policies + triggers (hand).
- `supabase/migrations/20260712000003_upsert_by_external_ref.sql` — the upsert RPC (hand).
- `supabase/migrations/20260712000004_ingest_idempotency.sql` — dedupe table + ingest RPC extension (hand).
- `supabase/functions/ingest/index.ts` — thread optional `idempotency_key`.
- `supabase/tests/external_record_test.sql`, `supabase/tests/ingest_idempotency_test.sql` — pgTAP.

## Interfaces (produced — later parts and plans consume these)

- `public.external_record(id, workspace_id, source, external_id, payload jsonb, created_at, updated_at)`,
  `unique(workspace_id, source, external_id)`.
- Event `external.record.upserted` (domain `lifecycle`) with payload `{id, source, external_id}`,
  emitted via `emit_event` → consumed by the **automation** engine (app-06 automate enqueue).
  Registered in `events.ts` and seeded by the delta migration (delta-owned event, out of the
  frozen baseline). Segment-targeting on external records is a documented follow-up (needs a
  `platform_event` bridge — segments consume `platform_event`, not movp_events).
- `public.upsert_by_external_ref(ws uuid, source text, external_id text, payload jsonb) returns jsonb`
  (the upserted row as jsonb) — INVOKER, member-gated (42501), identity never mutated.
- `public.ingest_platform_event(api_key text, events jsonb) returns jsonb` — return object gains
  a `duplicate` counter; each event may carry an optional `idempotency_key`.
- Errcodes: `external_ref_identity_immutable` (P0001), `idempotency_conflict` (mapped from 23505).

---

## Task C5a.1: Generated-delta registry owns collections AND events

A post-freeze collection also needs a post-freeze **event** (`external.record.upserted`, C5a.3):
`check-event-catalog.mjs` requires every event literal used in a migration to be registered in
`packages/core-schema/src/events.ts`, but the baseline emitter seeds
`eventCatalogSeedSql(schema.events)` into the **frozen** baseline — so a new registered event
would drift it. The delta registry therefore owns events too (symmetric with collections): the
baseline excludes delta-owned events from its seed, and the delta emits them.

**Files**
- Modify: `packages/codegen/src/emit-sql.ts` (`emitSqlMigration` signature; add `emitDeltaSql`)
- Modify: `packages/codegen/src/generate.ts` (`GeneratedDelta.collections`/`.events`; baseline exclude)
- Modify: `packages/codegen/test/generate.test.ts` (new failing test)

**Interfaces (produced):** `emitSqlMigration(schema, opts?: { excludeCollections?: readonly string[];
excludeEvents?: readonly string[] })`; `emitDeltaSql(schema, { collections?, events? }): string`;
`GeneratedDelta.collections?: readonly string[]`; `GeneratedDelta.events?: readonly string[]`.

- [ ] **Step 1 — write the failing test.** Append to `packages/codegen/test/generate.test.ts` (inside the existing `describe`):

```ts
  it('a delta that owns a collection excludes it from the baseline emit', async () => {
    const { root, migrationsDir } = await freshRoot()
    const delta = {
      file: '20990101000001_movp_generated_owned.sql',
      emit: () => '-- owned',
      collections: ['note'],
    }
    await generate({ root, deltas: [delta] })
    const baseline = await readFile(join(migrationsDir, BASELINE), 'utf8')
    expect(baseline).not.toContain('create table if not exists public.note (')
    // control: without the delta, note IS in the baseline
    const fresh = await freshRoot()
    await generate({ root: fresh.root })
    expect(await readFile(join(fresh.migrationsDir, BASELINE), 'utf8'))
      .toContain('create table if not exists public.note (')
  })
```

- [ ] **Step 2 — run it, expect RED:**

```sh
pnpm --filter @movp/codegen exec vitest run generate
```
Expected: **FAIL** — the first assertion fails (baseline still contains `public.note`; `collections` is ignored).

- [ ] **Step 3 — teach `emitSqlMigration` to exclude, and add `emitDeltaSql`.** In `packages/codegen/src/emit-sql.ts`, replace the `emitSqlMigration` function (currently line ~385) with:

```ts
export function emitSqlMigration(
  schema: MovpSchema,
  opts: { excludeCollections?: readonly string[]; excludeEvents?: readonly string[] } = {},
): string {
  const exCols = new Set(opts.excludeCollections ?? [])
  const exEvents = new Set(opts.excludeEvents ?? [])
  const collections = schema.collections.filter((c) => !exCols.has(c.name))
  const events = schema.events.filter((e) => !exEvents.has(e.key))
  return `${HEADER}\n\n${emitSharedInfraSql()}\n\n${collections.map(emitCollectionSql).join('\n')}\n${eventCatalogSeedSql(events)}`
}

// Emit a post-freeze delta migration: named collections' DDL (reusing the exact per-collection
// emitter so a delta collection is byte-for-byte a baseline collection) + named events' catalog
// seed rows (so a new event stays out of the frozen baseline).
export function emitDeltaSql(
  schema: MovpSchema,
  owned: { collections?: readonly string[]; events?: readonly string[] },
): string {
  const cols = (owned.collections ?? []).map((name) => {
    const c = schema.collections.find((x) => x.name === name)
    if (!c) throw new Error(`delta collection not registered: ${name}`)
    return emitCollectionSql(c)
  })
  const evKeys = new Set(owned.events ?? [])
  const events = schema.events.filter((e) => evKeys.has(e.key))
  for (const key of owned.events ?? []) {
    if (!events.some((e) => e.key === key)) throw new Error(`delta event not registered: ${key}`)
  }
  return `${HEADER}\n${cols.join('\n')}\n${eventCatalogSeedSql(events)}`
}
```

- [ ] **Step 4 — declare + apply delta ownership in `generate.ts`.** Change the `GeneratedDelta` interface (line ~7) to add `collections`/`events`, and derive both baseline exclusion sets. Replace the interface and the `baselineSql` line:

```ts
export interface GeneratedDelta {
  file: string
  emit: (schema: MovpSchema) => string
  collections?: readonly string[]   // collections this delta owns; excluded from the baseline DDL
  events?: readonly string[]        // event keys this delta owns; excluded from the baseline seed
}

function deltaOwnedCollections(deltas: readonly GeneratedDelta[]): string[] {
  return deltas.flatMap((d) => d.collections ?? [])
}
function deltaOwnedEvents(deltas: readonly GeneratedDelta[]): string[] {
  return deltas.flatMap((d) => d.events ?? [])
}
```

Then inside `generate()`, change the baseline emit (currently `const baselineSql = emitSqlMigration(schema)`) to:

```ts
  const baselineSql = emitSqlMigration(schema, {
    excludeCollections: deltaOwnedCollections(deltas),
    excludeEvents: deltaOwnedEvents(deltas),
  })
```

(`deltas` is already resolved above as `options.deltas ?? GENERATED_DELTAS`.)

- [ ] **Step 5 — run tests, expect GREEN:**

```sh
pnpm --filter @movp/codegen exec vitest run
```
Expected: **PASS** — the new test plus all existing generate/emit tests (baseline byte-stability still holds because no current delta owns a collection).

- [ ] **Step 6 — gate + commit.**

```sh
pnpm --filter @movp/codegen test
turbo run typecheck --filter=@movp/codegen   # Expected: pass
git add packages/codegen/src/emit-sql.ts packages/codegen/src/generate.ts packages/codegen/test/generate.test.ts
git commit -m "feat(codegen): C5a.1 generated-delta registry can own collections (excluded from frozen baseline)"
```

---

## Task C5a.2: `external_record` collection + delta registration

**Files**
- Create: `packages/core-schema/src/collections/external_record.ts`
- Modify: `packages/core-schema/src/schema.ts` (import + append to ordered array)
- Modify: `packages/core-schema/src/index.ts` (export the const)
- Modify: `packages/codegen/src/generate.ts` (import `emitDeltaSql`; register the delta)
- Create (codegen output): `supabase/migrations/20260712000001_movp_generated_external_record.sql`

**Interfaces (consumed):** `emitDeltaSql` (C5a.1). **Produced:** the DSL const
`externalRecord`; the delta migration file; auto `ExternalRecord` type + GraphQL/MCP/CLI surfaces.

- [ ] **Step 1 — write the failing test.** Create `packages/core-schema/test/external_record.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { schema } from '../src/schema.ts'
import { emitDeltaSql } from '@movp/codegen'

describe('external_record collection (C5a.2)', () => {
  it('is registered in the schema exactly once, workspace-scoped', () => {
    const found = schema.collections.filter((c) => c.name === 'external_record')
    expect(found).toHaveLength(1)
    expect(found[0].workspaceScoped).toBe(true)
    expect(Object.keys(found[0].fields).sort()).toEqual(['external_id', 'payload', 'source'])
  })

  it('emits a create table with source/external_id/payload as a delta collection', () => {
    const sql = emitDeltaSql(schema, { collections: ['external_record'] })
    expect(sql).toContain('create table if not exists public.external_record (')
    expect(sql).toContain('  source text not null')
    expect(sql).toContain('  external_id text not null')
    expect(sql).toContain('  payload jsonb')
    expect(sql).toContain('create policy external_record_rw on public.external_record')
  })
})
```

- [ ] **Step 2 — run it, expect RED:**

```sh
pnpm --filter @movp/core-schema exec vitest run external_record
```
Expected: **FAIL** — `external_record` not in schema (found length 0); `emitDeltaSql` throws `delta collection not registered`.

- [ ] **Step 3 — create the collection.** `packages/core-schema/src/collections/external_record.ts`:

```ts
import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// Integration landing collection. External-system records (CRM, etc.) land here keyed by a
// stable (source, external_id). Emitted OUT of the frozen baseline via the generated-delta
// registry (Stage C5a.1). Identity immutability, the unique key, the no-DELETE grant, and the
// idempotent `external.record.upserted` emit triggers are added by the hand migration
// 20260712000002_external_record_guards.sql (mirrors platform_event's 000019 guards).
export const externalRecord = defineCollection({
  name: 'external_record',
  label: 'External Record',
  labelPlural: 'External Records',
  workspaceScoped: true,
  fields: {
    source: f.text({ label: 'Source', required: true }),
    external_id: f.text({ label: 'External ID', required: true }),
    payload: f.json({ label: 'Payload' }),
  },
})
```

- [ ] **Step 4 — register it.** In `packages/core-schema/src/schema.ts` add the import near the other collection imports:

```ts
import { externalRecord } from './collections/external_record.ts'
```

and append `externalRecord` to the ordered array passed to `defineSchema([...], events)` (after `platformEvent`; order only matters for FK targets and `external_record` has none, so appending near the end is safe). In `packages/core-schema/src/index.ts` add:

```ts
export { externalRecord } from './collections/external_record.ts'
```

- [ ] **Step 5 — register the delta.** In `packages/codegen/src/generate.ts`, add the import and the registry entry:

```ts
import { emitDeltaSql } from './emit-sql.ts'
```
```ts
export const GENERATED_DELTAS: readonly GeneratedDelta[] = [
  { file: '20260711000001_movp_generated_reporting.sql', emit: emitReportingSql },
  {
    file: '20260712000001_movp_generated_external_record.sql',
    emit: (schema) => emitDeltaSql(schema, { collections: ['external_record'] }),
    collections: ['external_record'],
  },
]
```

- [ ] **Step 6 — run codegen; prove baseline is byte-identical.**

```sh
pnpm codegen           # if this script is absent, run: pnpm tsx scripts/codegen.ts
git diff --exit-code supabase/migrations/20260701000002_movp_generated.sql   # Expected: EXIT 0 (no change)
git status --porcelain supabase/migrations/                                  # Expected: only the new 20260712000001 file (untracked)
node scripts/check-forward-only-migrations.mjs                               # Expected: forward-only migrations: ok
```
Expected: the delta file `20260712000001_movp_generated_external_record.sql` exists and contains `create table if not exists public.external_record`; the baseline is unchanged; generated types now include an `external_record` entry.

- [ ] **Step 7 — run unit tests, expect GREEN + gate + commit.**

```sh
pnpm --filter @movp/core-schema exec vitest run external_record   # Expected: PASS
pnpm --filter @movp/codegen test                                  # Expected: PASS (baseline still byte-stable)
turbo run typecheck                                               # Expected: pass (ExternalRecord type generated)
git add packages/core-schema/src/collections/external_record.ts packages/core-schema/src/schema.ts packages/core-schema/src/index.ts packages/codegen/src/generate.ts packages/core-schema/test/external_record.test.ts supabase/migrations/20260712000001_movp_generated_external_record.sql packages/domain/src/generated/types.ts
git commit -m "feat(reporting): C5a.2 external_record landing collection via generated-delta registry"
```

---

## Task C5a.3: Identity immutability, no-DELETE, idempotent emit (guards migration)

**Files**
- Create: `supabase/migrations/20260712000002_external_record_guards.sql`
- Create: `supabase/tests/external_record_test.sql`
- Modify: `packages/core-schema/src/events.ts` (register `external.record.upserted`, domain `lifecycle`)
- Modify: `packages/codegen/src/generate.ts` (external_record delta now also owns the event)

**Interfaces (consumed):** the generated `public.external_record` table (C5a.2), `public.emit_event`,
`emitDeltaSql` event-ownership (C5a.1). Event domain MUST be an allowed value (`lifecycle`).
**Produced:** `unique(workspace_id, source, external_id)`; split select/insert/update policies +
no delete; `external_record_identity_immutable` trigger (P0001); `external.record.upserted` event.

**Column contract:** `external_record` has exactly `id, workspace_id, source, external_id,
payload, created_at, updated_at`. `(source, external_id)` is the immutable external identity;
`payload` is the only mutable business field.

- [ ] **Step 1 — write the failing pgTAP test.** Create `supabase/tests/external_record_test.sql`:

```sql
-- C5a.3 external_record: identity immutability, no-delete, idempotent event emission.
begin;
select plan(9);

insert into public.workspace (id, name) values
  ('c5a00000-0000-0000-0000-000000000001', 'ExtW1'),
  ('c5a00000-0000-0000-0000-000000000002', 'ExtW2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c5a00000-0000-0000-0000-000000000001', 'c5a0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member'),
  ('c5a00000-0000-0000-0000-000000000002', 'c5a0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5a0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

-- insert emits exactly one external.record.upserted event
insert into public.external_record (workspace_id, source, external_id, payload)
values ('c5a00000-0000-0000-0000-000000000001', 'hubspot', 'contact-1', '{"email_present":true}'::jsonb);
select is(
  (select count(*)::int from movp_internal.movp_events
     where type = 'external.record.upserted' and workspace_id = 'c5a00000-0000-0000-0000-000000000001'),
  1, 'insert emits exactly one external.record.upserted');

-- same-payload replay via ON CONFLICT is idempotent at the event layer (0 new events)
insert into public.external_record (workspace_id, source, external_id, payload)
values ('c5a00000-0000-0000-0000-000000000001', 'hubspot', 'contact-1', '{"email_present":true}'::jsonb)
on conflict (workspace_id, source, external_id) do update
  set payload = excluded.payload, updated_at = now()
  where public.external_record.payload is distinct from excluded.payload;
select is(
  (select count(*)::int from movp_internal.movp_events where type = 'external.record.upserted'),
  1, 'same-payload replay emits NO new event');

-- changed payload emits one more event
insert into public.external_record (workspace_id, source, external_id, payload)
values ('c5a00000-0000-0000-0000-000000000001', 'hubspot', 'contact-1', '{"email_present":false}'::jsonb)
on conflict (workspace_id, source, external_id) do update
  set payload = excluded.payload, updated_at = now()
  where public.external_record.payload is distinct from excluded.payload;
select is(
  (select count(*)::int from movp_internal.movp_events where type = 'external.record.upserted'),
  2, 'changed payload emits one more event');

-- identity fields are immutable
select throws_ok(
  $$ update public.external_record set source = 'salesforce'
       where source = 'hubspot' and external_id = 'contact-1' $$,
  'P0001', 'external_ref_identity_immutable', 'source is immutable');
select throws_ok(
  $$ update public.external_record set external_id = 'contact-2'
       where source = 'hubspot' and external_id = 'contact-1' $$,
  'P0001', 'external_ref_identity_immutable', 'external_id is immutable');

-- generic DELETE is denied (no delete policy for authenticated)
select is(
  (with d as (delete from public.external_record
                where source = 'hubspot' and external_id = 'contact-1' returning 1)
   select count(*)::int from d),
  0, 'generic delete removes no rows (no delete policy)');
select is(
  (select count(*)::int from public.external_record where source = 'hubspot'),
  1, 'row survives the denied delete');

-- unique identity per workspace
select throws_ok(
  $$ insert into public.external_record (workspace_id, source, external_id, payload)
     values ('c5a00000-0000-0000-0000-000000000001', 'hubspot', 'contact-1', '{}'::jsonb) $$,
  '23505', null, 'duplicate (source, external_id) rejected in-workspace');

-- cross-workspace isolation
set local request.jwt.claims = '{"sub":"c5a0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(
  (select count(*)::int from public.external_record where workspace_id = 'c5a00000-0000-0000-0000-000000000001'),
  0, 'member B sees no W1 external_records');

reset role;
select * from finish();
rollback;
```

- [ ] **Step 2 — run it, expect RED:**

```sh
supabase db reset && supabase test db 2>&1 | grep external_record
```
Expected: **FAIL** — the guards/triggers/unique do not exist yet (identity update does not throw; delete removes the row; duplicate insert succeeds).

- [ ] **Step 3 — register the event (delta-owned, valid domain).** Two edits, then re-run codegen:

  1. In `packages/core-schema/src/events.ts` register the event with `defineEvent`. **`domain` must be one of the seven allowed values** (`EventDef.domain` in `packages/core-schema/src/types.ts:47` AND the `event_type.domain` CHECK constraint) — there is NO `integration` domain; use **`lifecycle`** (a record upsert is a lifecycle event). Match the shape of the existing entries:

  ```ts
  defineEvent('external.record.upserted', {
    domain: 'lifecycle',
    label: 'External Record Upserted',
    payloadSchema: { id: 'uuid', source: 'text', external_id: 'text' },
    version: 1,
  }),
  ```

  2. In `packages/codegen/src/generate.ts`, make the external_record delta entry **own the event** so its `event_type` seed lands in the delta, NOT the frozen baseline (C5a.1 mechanism):

  ```ts
  {
    file: '20260712000001_movp_generated_external_record.sql',
    emit: (schema) => emitDeltaSql(schema, { collections: ['external_record'], events: ['external.record.upserted'] }),
    collections: ['external_record'],
    events: ['external.record.upserted'],
  },
  ```

  Then re-run codegen and prove the baseline is still frozen:

  ```sh
  pnpm codegen
  git diff --exit-code supabase/migrations/20260701000002_movp_generated.sql   # Expected: EXIT 0 (baseline unchanged)
  ```
  The regenerated `20260712000001_movp_generated_external_record.sql` now contains the
  `external_record` table AND an `insert into public.event_type (...) values ('external.record.upserted', 'lifecycle', ...)`.
  `node scripts/check-event-catalog.mjs` now passes (the literal used by the emit trigger below
  is registered in `events.ts`).

- [ ] **Step 4 — write the guards migration.** Create `supabase/migrations/20260712000002_external_record_guards.sql`:

```sql
-- C5a.3 external_record guards: immutable external identity, no generic delete, idempotent
-- event emission. Mirrors the platform_event hand-guards in 20260701000019_segmentation.sql.
-- (The `external.record.upserted` event_type row is seeded by the generated delta
-- 20260712000001, which OWNS the event — see Step 3; do not re-insert it here.)

-- Stable external identity.
alter table public.external_record
  add constraint external_record_identity_uk unique (workspace_id, source, external_id);

-- Replace the generic FOR ALL policy with split policies: SELECT + INSERT + payload UPDATE,
-- and NO DELETE (generic deletes are denied; removal is a future RPC).
drop policy if exists external_record_rw on public.external_record;
create policy external_record_select on public.external_record
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy external_record_insert on public.external_record
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy external_record_update on public.external_record
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Identity immutability (defends every write path incl. generic PATCH via PostgREST).
create or replace function public.external_record_identity_immutable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.source is distinct from old.source or new.external_id is distinct from old.external_id then
    raise exception 'external_ref_identity_immutable' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.external_record_identity_immutable() from public, anon, authenticated;
drop trigger if exists external_record_identity_tg on public.external_record;
create trigger external_record_identity_tg
  before update on public.external_record
  for each row execute function public.external_record_identity_immutable();

-- Idempotent event emission: on INSERT always; on UPDATE only when payload actually changed.
create or replace function public.external_record_emit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.emit_event(
    'external.record.upserted',
    new.workspace_id,
    jsonb_build_object('id', new.id, 'source', new.source, 'external_id', new.external_id),
    gen_random_uuid()::text
  );
  return new;
end;
$$;
revoke all on function public.external_record_emit_event() from public, anon, authenticated;
drop trigger if exists external_record_emit_insert_tg on public.external_record;
create trigger external_record_emit_insert_tg
  after insert on public.external_record
  for each row execute function public.external_record_emit_event();
drop trigger if exists external_record_emit_update_tg on public.external_record;
create trigger external_record_emit_update_tg
  after update on public.external_record
  for each row when (old.payload is distinct from new.payload)
  execute function public.external_record_emit_event();
```

- [ ] **Step 5 — run it, expect GREEN:**

```sh
supabase db reset && supabase test db 2>&1 | grep -E 'external_record_test|Result:'
```
Expected: `external_record_test.sql ... ok`; overall `Result: PASS`.

- [ ] **Step 6 — gate + commit.**

```sh
node scripts/check-forward-only-migrations.mjs   # Expected: ok
node scripts/check-definer-audit.mjs             # Expected: pass (both new definer fns pin search_path)
git add supabase/migrations/20260712000002_external_record_guards.sql supabase/migrations/20260712000001_movp_generated_external_record.sql supabase/tests/external_record_test.sql packages/core-schema/src/events.ts packages/codegen/src/generate.ts
git commit -m "feat(reporting): C5a.3 external_record identity immutability + idempotent event emission"
```

---

## Task C5a.4: `upsert_by_external_ref` RPC

**Files**
- Create: `supabase/migrations/20260712000003_upsert_by_external_ref.sql` (this RPC only; the
  ingest-idempotency table + RPC extension land in C5a.5's own `…000004` migration).
- Create: `supabase/tests/upsert_external_ref_test.sql` (do not touch the committed
  `external_record_test.sql` — it is frozen).

**Interfaces (produced):** `public.upsert_by_external_ref(ws uuid, source text, external_id text,
payload jsonb) returns jsonb` — INVOKER, member-gated (42501), upserts idempotently, returns the
current row as jsonb. Never mutates identity (uses the conflict key only).

- [ ] **Step 1 — write the failing pgTAP test.** Create `supabase/tests/upsert_external_ref_test.sql`:

```sql
-- C5a.4 upsert_by_external_ref: idempotent member-gated upsert.
begin;
select plan(6);

insert into public.workspace (id, name) values ('c5b00000-0000-0000-0000-000000000001', 'UpsertW1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c5b00000-0000-0000-0000-000000000001', 'c5b0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5b0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select is(
  (public.upsert_by_external_ref('c5b00000-0000-0000-0000-000000000001','attio','rec-1','{"stage":"lead"}'::jsonb)->>'external_id'),
  'rec-1', 'upsert returns the row');
select is((select count(*)::int from public.external_record where source='attio' and external_id='rec-1'),
  1, 'one row after first upsert');
-- idempotent replay: same payload, still one row, no new event
select is(
  (public.upsert_by_external_ref('c5b00000-0000-0000-0000-000000000001','attio','rec-1','{"stage":"lead"}'::jsonb)->>'external_id'),
  'rec-1', 'replay returns the row');
select is((select count(*)::int from movp_internal.movp_events where type='external.record.upserted'),
  1, 'idempotent replay emits no second event');
-- changed payload updates in place
select is(
  (public.upsert_by_external_ref('c5b00000-0000-0000-0000-000000000001','attio','rec-1','{"stage":"won"}'::jsonb)->'payload'->>'stage'),
  'won', 'changed payload updates in place');

-- non-member denied
set local request.jwt.claims = '{"sub":"c5b0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok(
  $$ select public.upsert_by_external_ref('c5b00000-0000-0000-0000-000000000001','attio','rec-9','{}'::jsonb) $$,
  '42501', 'not_workspace_member', 'non-member denied');

reset role;
select * from finish();
rollback;
```

- [ ] **Step 2 — run it, expect RED:**

```sh
supabase db reset && supabase test db 2>&1 | grep upsert_external_ref
```
Expected: **FAIL** — `function public.upsert_by_external_ref(...) does not exist`.

- [ ] **Step 3 — write the RPC.** Create `supabase/migrations/20260712000003_upsert_by_external_ref.sql` (the ingest-idempotency table lands in C5a.5's own migration):

```sql
-- C5a.4 upsert_by_external_ref: member-gated idempotent upsert into external_record. INVOKER so
-- RLS + the identity-immutable + emit triggers all apply. Never mutates identity (conflict key).
create or replace function public.upsert_by_external_ref(ws uuid, source text, external_id text, payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result public.external_record;
begin
  if (select auth.uid()) is null or not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  insert into public.external_record (workspace_id, source, external_id, payload)
  values (ws, source, external_id, coalesce(payload, '{}'::jsonb))
  on conflict (workspace_id, source, external_id) do update
    set payload = excluded.payload, updated_at = now()
    where public.external_record.payload is distinct from excluded.payload
  returning * into result;

  if result.id is null then
    -- guarded no-op conflict (payload unchanged): re-select the current row.
    select * into result from public.external_record
     where workspace_id = ws and source = upsert_by_external_ref.source
       and external_id = upsert_by_external_ref.external_id;
  end if;

  return to_jsonb(result);
end;
$$;
revoke all on function public.upsert_by_external_ref(uuid, text, text, jsonb) from public, anon;
grant execute on function public.upsert_by_external_ref(uuid, text, text, jsonb) to authenticated;
```

- [ ] **Step 4 — run it, expect GREEN:**

```sh
supabase db reset && supabase test db 2>&1 | grep -E 'upsert_external_ref|Result:'
```
Expected: `upsert_external_ref_test.sql ... ok`; `Result: PASS`.

- [ ] **Step 5 — gate + commit.**

```sh
node scripts/check-forward-only-migrations.mjs && node scripts/check-definer-audit.mjs   # Expected: pass
git add supabase/migrations/20260712000003_upsert_by_external_ref.sql supabase/tests/upsert_external_ref_test.sql
git commit -m "feat(reporting): C5a.4 upsert_by_external_ref idempotent member-gated RPC"
```

---

## Task C5a.5: Idempotent `platform_event` ingest

**Files**
- Create: `supabase/migrations/20260712000004_ingest_idempotency.sql` (dedupe table + RPC extension)
- Create: `supabase/tests/ingest_idempotency_test.sql`
- Modify: `supabase/functions/ingest/index.ts` (thread optional `idempotency_key`)

**Interfaces (consumed):** `public.ingest_platform_event(api_key, events)`, `movp_internal.ingest_key`.
**Produced:** `movp_internal.ingest_idempotency(workspace_id, idempotency_key, payload_hash,
event_id, created_at)` `unique(workspace_id, idempotency_key)`; return object gains `duplicate`.

**Semantics (idempotency rule):** `payload_hash` is derived over the **effective submitted event
payload** (the event object minus `idempotency_key`). Same key + same hash → the existing event
is returned (replay, counted `duplicate`), NO second `platform_event` row. Same key + different
hash → `idempotency_conflict` (SQLSTATE `P0001`), the batch continues (that row counted `dropped`)
+ a **keys-only** obs event.

- [ ] **Step 1 — write the failing pgTAP test.** Create `supabase/tests/ingest_idempotency_test.sql`:

```sql
-- C5a.5 idempotent ingest: same key+payload dedupes; same key+different payload conflicts.
begin;
select plan(5);

insert into public.workspace (id, name) values ('c5c00000-0000-0000-0000-000000000001', 'IngW1');
-- mint an ingest key (service-role path): store the sha256 hash of the raw key.
insert into movp_internal.ingest_key (workspace_id, key_hash, label, active)
values ('c5c00000-0000-0000-0000-000000000001',
        encode(extensions.digest('c5c-raw-key', 'sha256'), 'hex'), 'test', true);

-- first submit: one event
select is(
  (public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"u-1","occurred_at":"2026-07-11T00:00:00Z","idempotency_key":"k1"}]'::jsonb)->>'inserted')::int,
  1, 'first submit inserts one event');
-- replay same key + same payload: deduped, no new event
select is(
  (public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"u-1","occurred_at":"2026-07-11T00:00:00Z","idempotency_key":"k1"}]'::jsonb)->>'duplicate')::int,
  1, 'replay counts one duplicate');
select is(
  (select count(*)::int from public.platform_event where workspace_id='c5c00000-0000-0000-0000-000000000001'),
  1, 'replay creates no second platform_event row');
-- same key + different payload: conflict (dropped), still one row
select is(
  (public.ingest_platform_event('c5c-raw-key',
    '[{"event_type":"signup.completed","subject_ref":"DIFFERENT","occurred_at":"2026-07-11T00:00:00Z","idempotency_key":"k1"}]'::jsonb)->>'dropped')::int,
  1, 'same key + different payload is dropped as a conflict');
select is(
  (select count(*)::int from public.platform_event where workspace_id='c5c00000-0000-0000-0000-000000000001'),
  1, 'conflict creates no new row');

select * from finish();
rollback;
```

- [ ] **Step 2 — run it, expect RED:**

```sh
supabase db reset && supabase test db 2>&1 | grep ingest_idempotency
```
Expected: **FAIL** — `duplicate` key absent from the return object; replay inserts a second row.

- [ ] **Step 3 — write the migration.** Create `supabase/migrations/20260712000004_ingest_idempotency.sql`:

```sql
-- C5a.5 optional idempotency keys on platform_event ingest. Dedupe table lives in movp_internal
-- (service-role only), keyed per workspace. payload_hash is derived over the effective submitted
-- event payload (idempotency_key excluded) — same key+hash replays, different hash conflicts.
create table if not exists movp_internal.ingest_idempotency (
  workspace_id    uuid not null references public.workspace(id) on delete cascade,
  idempotency_key text not null,
  payload_hash    text not null,
  event_id        uuid not null references public.platform_event(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (workspace_id, idempotency_key)
);
alter table movp_internal.ingest_idempotency enable row level security;   -- no policies: closed to app roles
revoke all on movp_internal.ingest_idempotency from anon, authenticated;
grant all on movp_internal.ingest_idempotency to service_role;

create or replace function public.ingest_platform_event(api_key text, events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ws          uuid;
  v_event       jsonb;
  v_type        text;
  v_subject_ref text;
  v_props       jsonb;
  v_occurred    timestamptz;
  v_idem        text;
  v_hash        text;
  v_existing    uuid;
  v_new_id      uuid;
  n_ok          int := 0;
  n_bad         int := 0;
  n_dup         int := 0;
begin
  select k.workspace_id into v_ws
    from movp_internal.ingest_key k
   where k.key_hash = encode(extensions.digest(api_key, 'sha256'), 'hex') and k.active
   limit 1;
  if v_ws is null then
    raise exception 'ingest_key_invalid' using errcode = '28000';
  end if;
  if jsonb_typeof(events) is distinct from 'array' then
    raise exception 'events_not_array' using errcode = '22023';
  end if;
  if jsonb_array_length(events) > 500 then
    raise exception 'batch_too_large' using errcode = '54000';
  end if;

  for v_event in select value from jsonb_array_elements(events)
  loop
    v_type        := v_event->>'event_type';
    v_subject_ref := v_event->>'subject_ref';
    v_props       := coalesce(v_event->'properties', '{}'::jsonb);
    v_idem        := v_event->>'idempotency_key';
    begin
      v_occurred := (v_event->>'occurred_at')::timestamptz;
    exception when others then
      v_occurred := null;
    end;
    if v_type is null or length(v_type) = 0
       or v_subject_ref is null or length(v_subject_ref) = 0
       or v_occurred is null
       or octet_length(v_props::text) > 16384 then
      n_bad := n_bad + 1;
      continue;
    end if;

    -- Idempotency: hash the EFFECTIVE submitted event (idempotency_key removed) so byte-identical
    -- resubmissions collapse; a same-key resubmission with different content is a conflict.
    if v_idem is not null and length(v_idem) > 0 then
      v_hash := encode(extensions.digest((v_event - 'idempotency_key')::text, 'sha256'), 'hex');
      select ii.payload_hash, ii.event_id into v_hash, v_existing
        from movp_internal.ingest_idempotency ii
       where ii.workspace_id = v_ws and ii.idempotency_key = v_idem;
      if found then
        if v_existing is not null and v_hash = encode(extensions.digest((v_event - 'idempotency_key')::text, 'sha256'), 'hex') then
          n_dup := n_dup + 1;   -- replay of the same submitted payload
          continue;
        else
          n_bad := n_bad + 1;   -- same key, different payload → conflict (dropped, batch continues)
          perform public.emit_event('ingest.idempotency_conflict', v_ws,
            jsonb_build_object('idempotency_key_present', true, 'reason', 'payload_mismatch'),
            gen_random_uuid()::text);
          continue;
        end if;
      end if;
    end if;

    begin
      insert into public.platform_event
        (workspace_id, event_type, subject_type, subject_ref, actor_ref, source, properties, occurred_at, ingested_at)
      values
        (v_ws, v_type, coalesce(v_event->>'subject_type', 'user'), v_subject_ref, v_event->>'actor_ref',
         'external', v_props, v_occurred, now())
      returning id into v_new_id;
      if v_idem is not null and length(v_idem) > 0 then
        insert into movp_internal.ingest_idempotency (workspace_id, idempotency_key, payload_hash, event_id)
        values (v_ws, v_idem, encode(extensions.digest((v_event - 'idempotency_key')::text, 'sha256'), 'hex'), v_new_id);
      end if;
      n_ok := n_ok + 1;
    exception
      when not_null_violation or check_violation or invalid_text_representation or datetime_field_overflow then
        n_bad := n_bad + 1;
        continue;
    end;
  end loop;

  return jsonb_build_object('inserted', n_ok, 'dropped', n_bad, 'duplicate', n_dup);
end; $$;
revoke all on function public.ingest_platform_event(text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_platform_event(text, jsonb) to service_role;
```

> Gotcha (workerd/edge): the edge fn passes `idempotency_key` inside each event object; the RPC
> reads it from `v_event->>'idempotency_key'` and excludes it from the hash. Keep the exclusion in
> BOTH the lookup and the insert (shown) so the stored hash matches on replay.

- [ ] **Step 4 — run it, expect GREEN:**

```sh
supabase db reset && supabase test db 2>&1 | grep -E 'ingest_idempotency|Result:'
```
Expected: `ingest_idempotency_test.sql ... ok`; `Result: PASS`.

- [ ] **Step 5 — thread `idempotency_key` through the edge fn.** In `supabase/functions/ingest/index.ts`, ensure the per-event normalization (`validateIngestEvent` / the `clean` builder for the API-key path and `rows` for the JWT path) **preserves** a string `idempotency_key` field on each event when present. For the API-key path this means keeping `idempotency_key` on each object in the `clean` array passed to `rpc('ingest_platform_event', { api_key, events: clean })`; for the JWT direct-insert path, idempotency is out of scope (document that JWT ingest is not deduped in v1). Add a passthrough in `../_shared/ingest-bounds.ts`'s validator so the key survives normalization. Also surface the new `duplicate` counter where the fn reads `{ inserted, dropped }` (around index.ts:123-130).

- [ ] **Step 6 — gate + commit.**

```sh
node scripts/check-forward-only-migrations.mjs && node scripts/check-definer-audit.mjs   # Expected: pass
supabase test db 2>&1 | tail -3                                                          # Expected: Result: PASS
git add supabase/migrations/20260712000004_ingest_idempotency.sql supabase/tests/ingest_idempotency_test.sql supabase/functions/ingest/index.ts supabase/functions/_shared/ingest-bounds.ts
git commit -m "feat(reporting): C5a.5 optional idempotency keys on platform_event ingest"
```

---

## Deferred (C5a)

- JWT-path ingest idempotency (v1 dedupes only the API-key/edge path).
- A `delete_by_external_ref` RPC (generic delete stays denied; no v1 consumer).
- A reporting view over `external_record` (no reporting requirement yet).

## Eight-dimension self-check (C5a)

- **Correctness:** delta-owned exclusion keeps the baseline byte-identical (git-diff gate);
  upsert never mutates identity; idempotency hash is over the effective submitted payload.
- **Safety:** `external_record` writes are RLS-scoped; identity is immutable at the DB layer
  (defends generic PATCH); `ingest_idempotency` is service-role only; definers pin search_path.
- **Reliability:** replay is idempotent at the event layer (WHEN guard) AND the ingest layer
  (hash compare); ingest keeps the narrow per-row handler (unexpected faults still abort loud).
- **Observability:** idempotency conflicts emit a keys-only `ingest.idempotency_conflict` event.
- **Efficiency:** one `emitCollectionSql` for both baseline and delta (no duplicate emitter).
- **Performance:** `unique(workspace_id, source, external_id)` also serves external-ref lookups;
  ingest dedupe is a single indexed PK probe per keyed event.
- **Simplicity:** no per-collection `postFreeze` flag — the filename-keyed registry is the one
  source of truth for frozen-vs-delta.
- **Usability:** `upsert_by_external_ref` returns the row as jsonb for immediate use.
