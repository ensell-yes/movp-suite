# MOVP Stage C5b — PostgREST Exposure Audit + REST-Facade Docs

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. Samples are line-verified against committed code (2026-07-11).
> **Precondition: C5a merged** (external_record + ingest idempotency). Second of three C5
> plans; expanded from `2026-07-11-movp-stage-c05-integration-fabric-design.md` §C5b and
> roadmap §C5.3. REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.

**Goal:** document PostgREST as the RLS-guarded REST facade honestly, and prove — with a pgTAP
grants/RLS audit plus a real-HTTP slice block — the *enforceable* boundary: `anon` denied,
`movp_internal` unreachable, members read/write only their own workspace, and `internal:true`
is a GraphQL-surface flag (NOT a PostgREST hiding mechanism).

**Architecture:** two layers. (1) a pgTAP test (auto-discovered by `supabase test db`) asserts
grant introspection (`has_schema_privilege`/`has_table_privilege`) + RLS cross-workspace denial
via `set local role` — the same idioms as `internal_access_test.sql` /
`reporting_bi_grants_test.sql`. (2) a `slice-e2e.sh` block hits the **real** PostgREST endpoint
(`$API_URL/rest/v1/...`, `apikey: $ANON_KEY` + a GoTrue-minted member `Bearer`) proving the
HTTP-level behavior the pgTAP layer can only simulate. Docs land in `docs/rest.md`, gated by
`check-docs-presence.mjs`.

**Tech stack:** Postgres 17 + pgTAP; bash + `curl` + `psql` (`scripts/slice-e2e.sh`); Node
docs-presence gate; Supabase CLI.

## Global Constraints (every task inherits these)

- **TDD, failing gate first.** Prove RED before writing the audit/docs.
- **No grant changes.** This plan AUDITS and DOCUMENTS the current boundary; it must not
  `revoke`/`grant` on any table (that's an explicitly rejected scope — members reading/writing
  their own workspace via PostgREST is by design; the app depends on it).
- **Honest claims only.** The docs must state that `internal:true` does NOT hide a table from
  PostgREST; the enforceable guarantee is RLS workspace-isolation + `anon`-denial +
  `movp_internal` hidden. Do not claim members cannot reach `internal:true` tables.
- **Exposed schemas are `public` + `graphql_public`** (`supabase/config.toml:35`); local API base
  is `http://127.0.0.1:64321`; `movp_internal` is NOT exposed.
- **Per-task gate + one commit per task.**

## File Structure

- `supabase/tests/postgrest_exposure_test.sql` — grants + RLS cross-workspace audit (pgTAP).
- `scripts/slice-e2e.sh` — new `[integration-exposure]` block (real HTTP).
- `docs/rest.md` — the REST-facade documentation.
- `scripts/check-docs-presence.mjs` — add `docs/rest.md` to the required set.

---

## Task C5b.1: pgTAP grants + RLS exposure audit

**Files**
- Create: `supabase/tests/postgrest_exposure_test.sql`

**Interfaces (consumed):** `public.note` (surfaced), `public.content_item` (`internal:true`),
`public.external_record` (C5a, `internal:false`), `movp_internal.movp_jobs`,
`movp_internal.ingest_idempotency` (C5a), `public.is_workspace_member`.

- [ ] **Step 1 — write the failing test.** Create `supabase/tests/postgrest_exposure_test.sql`:

```sql
-- C5b.1 PostgREST exposure boundary: the ENFORCEABLE guarantees only.
-- anon denied; movp_internal unreachable; RLS isolates members; internal:true is NOT a boundary.
begin;
select plan(12);

-- ── Grant introspection (Data-API roles) ─────────────────────────────────────
-- movp_internal is unreachable by both app roles.
select ok(not has_schema_privilege('anon', 'movp_internal', 'usage'), 'anon lacks movp_internal usage');
select ok(not has_schema_privilege('authenticated', 'movp_internal', 'usage'), 'authenticated lacks movp_internal usage');
select ok(not has_table_privilege('authenticated', 'movp_internal.ingest_idempotency', 'select'),
  'authenticated cannot select ingest_idempotency');
-- anon has no read on workspace tables (surfaced or internal:true).
select ok(not has_table_privilege('anon', 'public.note', 'select'), 'anon lacks note select grant');
select ok(not has_table_privilege('anon', 'public.content_item', 'select'), 'anon lacks content_item select grant');
select ok(not has_table_privilege('anon', 'public.external_record', 'select'), 'anon lacks external_record select grant');
-- internal:true is NOT a PostgREST boundary: authenticated has the SAME table grants on
-- content_item (internal:true) as on note (surfaced) and external_record.
select ok(has_table_privilege('authenticated', 'public.content_item', 'select'),
  'authenticated CAN select content_item (internal:true is a GraphQL-surface flag, not a REST boundary)');
select ok(has_table_privilege('authenticated', 'public.external_record', 'select'),
  'authenticated can select external_record');

-- ── RLS workspace-isolation (the real guarantee) ─────────────────────────────
insert into public.workspace (id, name) values
  ('c5d00000-0000-0000-0000-000000000001', 'RestW1'),
  ('c5d00000-0000-0000-0000-000000000002', 'RestW2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('c5d00000-0000-0000-0000-000000000001', 'c5d0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member'),
  ('c5d00000-0000-0000-0000-000000000002', 'c5d0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member');
insert into public.note (workspace_id, title, body, status) values
  ('c5d00000-0000-0000-0000-000000000001', 'W1 note', 'x', 'draft');

set local role authenticated;
set local request.jwt.claims = '{"sub":"c5d0aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is((select count(*)::int from public.note where workspace_id='c5d00000-0000-0000-0000-000000000001'),
  1, 'member A reads own-workspace note via RLS');

set local request.jwt.claims = '{"sub":"c5d0bbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from public.note where workspace_id='c5d00000-0000-0000-0000-000000000001'),
  0, 'member B cannot read W1 note (RLS isolation)');
-- member B cannot WRITE into W1 either (RLS with check)
select throws_ok(
  $$ insert into public.note (workspace_id, title, body, status)
     values ('c5d00000-0000-0000-0000-000000000001', 'forged', 'x', 'draft') $$,
  '42501', null, 'member B cannot insert into W1 (RLS with check)');

reset role;
select * from finish();
rollback;
```

- [ ] **Step 2 — run it, expect RED (then GREEN).**

```sh
supabase db reset && supabase test db 2>&1 | grep -E 'postgrest_exposure|Result:'
```
Expected: this is an **audit** of existing behavior — if the current grants/RLS already satisfy
it, it may pass immediately. The load-bearing RED is: temporarily change one assertion to the
FALSE expectation (e.g. assert `has_schema_privilege('authenticated','movp_internal','usage')` is
true) and confirm pgTAP reports a failure, then revert. This proves the assertions are real, not
vacuous. Document the temporary flip in the commit body.

- [ ] **Step 3 — gate + commit.**

```sh
supabase test db 2>&1 | tail -3   # Expected: Result: PASS (33+ files)
git add supabase/tests/postgrest_exposure_test.sql
git commit -m "test(reporting): C5b.1 PostgREST exposure audit — RLS isolation + movp_internal hidden + internal:true is not a REST boundary"
```

---

## Task C5b.2: Real-HTTP exposure block in the slice

**Files**
- Modify: `scripts/slice-e2e.sh` (add an `[integration-exposure]` block before the final `[8]` block)

**Interfaces (consumed):** slice env (`$API_URL`, `$ANON_KEY`, `$TOKEN`, `$WS`, `$USER_ID`),
already established at `slice-e2e.sh:94-134`. The `[8]` block at `:903-905` is the pattern.

- [ ] **Step 1 — add the block.** Insert into `scripts/slice-e2e.sh` immediately before the
`echo "== [8] internal not exposed via PostgREST API =="` line:

```bash
echo "== [integration-exposure] PostgREST facade is RLS-guarded =="
# movp_internal.ingest_idempotency must not be reachable via REST (schema not exposed)
EX1="$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/ingest_idempotency" -H "apikey: $ANON_KEY")"
[ "$EX1" = "404" ] || [ "$EX1" = "401" ] || { echo "ingest_idempotency reachable via REST ($EX1)"; exit 1; }

# a member reads their OWN external_record rows via REST (internal:false, RLS-scoped)
curl -sS -X POST "$API_URL/rest/v1/external_record" \
  -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -H "Prefer: return=minimal" \
  -d "{\"workspace_id\":\"$WS\",\"source\":\"slice\",\"external_id\":\"er-1\",\"payload\":{}}" >/dev/null
ER="$(curl -sS "$API_URL/rest/v1/external_record?select=external_id&source=eq.slice" \
  -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY")"
echo "$ER" | grep -q 'er-1' || { echo "member could not read own external_record via REST: $ER"; exit 1; }

# identity is immutable even via a raw PostgREST PATCH (defense-in-depth)
PATCH="$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$API_URL/rest/v1/external_record?source=eq.slice&external_id=eq.er-1" \
  -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"external_id":"er-2"}')"
[ "$PATCH" = "400" ] || [ "$PATCH" = "409" ] || [ "$PATCH" = "500" ] || { echo "identity PATCH not rejected ($PATCH)"; exit 1; }

# anon reads nothing from a workspace table
AN="$(curl -sS "$API_URL/rest/v1/note?select=id" -H "apikey: $ANON_KEY")"
[ "$AN" = "[]" ] || { echo "anon read a workspace table via REST: $AN"; exit 1; }
```

- [ ] **Step 2 — run the slice, expect PASS.**

```sh
supabase start >/dev/null 2>&1 || true
pkill -f 'supabase.*functions serve|edge-runtime' || true
bash scripts/slice-e2e.sh 2>&1 | grep -E 'integration-exposure|slice-e2e:'
```
Expected: the `[integration-exposure]` banner prints and `slice-e2e: PASS` at the end. (To prove
RED: temporarily change the identity-PATCH expectation to `[ "$PATCH" = "200" ]` and confirm the
slice aborts; revert.)

- [ ] **Step 3 — gate + commit.**

```sh
git add scripts/slice-e2e.sh
git commit -m "test(reporting): C5b.2 real-HTTP PostgREST exposure block (RLS facade + identity immutability)"
```

---

## Task C5b.3: `docs/rest.md` REST-facade documentation

**Files**
- Create: `docs/rest.md`
- Modify: `scripts/check-docs-presence.mjs` (add `docs/rest.md` to the required list)

- [ ] **Step 1 — add the presence gate (failing).** In `scripts/check-docs-presence.mjs`, add
`'docs/rest.md'` to the array of required doc paths it checks (follow the existing array; the
script fails loudly if a listed file is missing).

- [ ] **Step 2 — run it, expect RED:**

```sh
node scripts/check-docs-presence.mjs
```
Expected: **FAIL** — `docs/rest.md` missing.

- [ ] **Step 3 — write `docs/rest.md`:**

```markdown
# REST API (PostgREST facade)

MOVP does not ship a bespoke REST layer. Supabase's **PostgREST** already exposes the
`public` schema over the same RLS policies the rest of the platform enforces, so it *is*
the REST API for reads and RLS-safe writes.

- **Base URL (local):** `http://127.0.0.1:64321/rest/v1/<table>`. Every request needs an
  `apikey` header; authenticated requests add `Authorization: Bearer <JWT>` (a user session
  token, or a session minted from a Personal Access Token — see agent connectivity docs).
- **What's exposed:** the `public` and `graphql_public` schemas only (`supabase/config.toml`).
  `movp_internal` (jobs, events, ingest keys, ingest idempotency) is **never** exposed.
- **RLS is the boundary.** `anon` reads nothing from workspace tables. An authenticated member
  reads and writes **only their own workspace's rows** — enforced by
  `is_workspace_member(workspace_id)` policies, audited by
  `supabase/tests/postgrest_exposure_test.sql` and the `[integration-exposure]` slice block.

## `internal:true` is a GraphQL-surface flag, not a REST hiding mechanism

A collection marked `internal:true` in the schema DSL is skipped by the *generated GraphQL/MCP/CLI
CRUD surfaces* — because its writes need bespoke atomic logic. It is **still a regular `public`
table**, so PostgREST exposes it to authenticated members exactly like any other, RLS-scoped.
Do not treat `internal:true` as "hidden from REST"; the only hidden data is `movp_internal` and
anything `anon` is denied by RLS.

## Use RPCs for invariant-bearing writes

Direct PostgREST writes are RLS-safe (contained to your workspace) but skip app-layer validation
and multi-row atomicity. For operations with invariants, call the documented RPCs instead:

- `upsert_by_external_ref(ws, source, external_id, payload)` — idempotent CRM/entity upsert.
- `ingest_platform_event` (via the `ingest` edge function) — bounded, optionally idempotent event ingest.
- task/content lifecycle RPCs (create-with-revision, approval/publish) — see the domain docs.
```

- [ ] **Step 4 — run the gate, expect GREEN + commit.**

```sh
node scripts/check-docs-presence.mjs   # Expected: pass
git add docs/rest.md scripts/check-docs-presence.mjs
git commit -m "docs(reporting): C5b.3 REST-facade docs — PostgREST as the RLS-guarded facade"
```

---

## Deferred (C5b)
- Any grant hardening (read-only facade / RPC-only writes) — out of scope by design decision C.

## Eight-dimension self-check (C5b)
- **Correctness/Safety:** the audit asserts only enforceable guarantees; docs make no false
  hiding claim about `internal:true`; no grant changes.
- **Reliability/Observability:** exposure is proven at both the grant/RLS layer (pgTAP) and the
  real-HTTP layer (slice); the RED-flip note keeps the assertions non-vacuous.
- **Efficiency/Performance/Simplicity:** pure audit + docs; no new runtime surface.
- **Usability:** `docs/rest.md` tells an integrator exactly how to authenticate and what's safe.
