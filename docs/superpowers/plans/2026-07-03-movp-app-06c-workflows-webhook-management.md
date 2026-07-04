# MOVP App - Domain Workflows Phase 7, Part C: Webhook Subscription Management

> **For agentic workers:** REQUIRED SUB-SKILL: `writing-plans`. This is an implementation plan, not implementation code.

**Goal:** Add safe per-workspace webhook subscription management on top of Core's internal webhook delivery table: register, rotate, activate/deactivate, set filter, reconcile public/internal pairing, and apply subscription filters before delivery.

**Architecture:** `public.webhook_subscription` is the member-visible management handle created in Part A. `movp_internal.webhooks` remains the delivery source of truth for the flows worker and is never exposed directly. Part C adds hardened `SECURITY DEFINER` RPCs that first gate on `public.is_workspace_member(ws)` for the calling principal, then mutate the paired internal row. Filters use the same pure evaluator as Part B and are evaluated before `fetch`, so filtered-out deliveries complete without network I/O.

**Tech Stack:** Supabase SQL/RPC, pgTAP, `movp_internal.webhooks`, `public.webhook_subscription`, `packages/flows/src/condition.ts`, `packages/flows/src/flows-worker.ts`, Vitest, definer-audit, internal-access gate.

**This is Part C of Phase 7.** Precondition: Part A merged. Part B is preferred because it exports the evaluator, but C can land after A if it copies no logic and waits to import the evaluator once B merges.

## Global Constraints

- **Secret discipline:** webhook secrets never live in `public.webhook_subscription`, generated GraphQL responses, logs, `workflow_run`, or `movp_events`. Register/rotate may return a secret once if server-generated; tests must prove it is not persisted publicly.
- **RPCs are the only writers:** public subscription row and internal webhook row are paired 1:1 through RPCs. No generic create/update/delete surface may mutate `webhook_subscription` directly if it would break the pair; if generic surfaces are enabled, RLS must deny writes and custom RPCs own writes.
- **Membership before internal touch:** each definer RPC checks `public.is_workspace_member(ws)` before selecting or mutating `movp_internal.webhooks`.
- **Filter pre-fetch:** delivery worker evaluates the filter before building HMAC/fetching. A non-match is `done/skipped`, not a failed retry. Do not change `emit_event`'s webhook payload for filters; resolve the public subscription at delivery time from the paired internal webhook row.
- **No gate weakening:** `movp_internal` remains excluded from the Supabase API schemas and grant-denied to `anon/authenticated`.

## File Structure

```text
supabase/migrations/
  20260701000024_workflows_webhooks.sql # NEW
supabase/tests/
  workflows_webhooks_test.sql           # NEW
packages/flows/src/
  flows-worker.ts                       # UPDATE: filter before fetch
  webhook-subscriptions.ts              # NEW helpers if needed
packages/flows/test/
  webhook-subscriptions.test.ts         # NEW
```

### Task 1: Harden public subscription writes behind RPCs

**Files**

- Create: `supabase/migrations/20260701000024_workflows_webhooks.sql`
- Create: `supabase/tests/workflows_webhooks_test.sql`

**Interfaces**

- Produces:
  - `public.register_webhook_subscription(ws uuid, event_key text, url text, filter jsonb default null) returns jsonb`
  - `public.rotate_webhook_secret(subscription_id uuid, ws uuid) returns jsonb`
  - `public.set_webhook_active(subscription_id uuid, ws uuid, active boolean) returns public.webhook_subscription`
  - `public.set_webhook_filter(subscription_id uuid, ws uuid, filter jsonb) returns public.webhook_subscription`
  - `public.webhook_subscription_for_delivery(ws uuid, event_key text, hook_url text, hook_secret text) returns jsonb` granted to `service_role` only

- [ ] **Step 1: Write failing pgTAP**

Assertions:

- member registers a subscription and gets `{subscription_id, secret}` once;
- public row has `secret_set=true`, `secret_last_rotated_at`, and no secret value;
- internal row exists exactly once and carries the secret;
- non-member register/rotate/deactivate/filter throws `42501` or stable `not_workspace_member`;
- direct authenticated insert/update/delete on `public.webhook_subscription` is denied.

Expected: FAIL - RPCs missing and generated blanket RLS may allow direct writes.

- [ ] **Step 2: Override RLS**

Drop generated `webhook_subscription_rw`. Add:

- SELECT for workspace members;
- no direct INSERT/UPDATE/DELETE for authenticated;
- service_role all.

- [ ] **Step 3: Implement `register_webhook_subscription`**

Generate a secret server-side with `extensions.gen_random_bytes` and hex encode it, call Core's existing `public.register_webhook(ws, event_key, url, secret)` to create the internal row, then select the internal row by `(workspace_id,event_type,url,secret)` and insert the public row with `internal_webhook_id`. Return `{subscription_id, secret}` once. Use `set search_path=''` and schema-qualified names. Validate `event_key` exists and active in `public.event_type`.

Paste this RPC shape and keep the membership check before the Core call:

```sql
create or replace function public.register_webhook_subscription(ws uuid, event_key text, hook_url text, filter jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_internal_id uuid;
  v_subscription_id uuid;
begin
  if not public.is_workspace_member(ws) then
    raise exception 'not_workspace_member' using errcode = '42501';
  end if;
  if not exists (select 1 from public.event_type et where et.key = event_key and et.active) then
    raise exception 'event_type_not_found' using errcode = '22023';
  end if;

  perform public.register_webhook(ws, event_key, hook_url, v_secret);

  select w.id into v_internal_id
    from movp_internal.webhooks w
   where w.workspace_id = ws
     and w.event_type = event_key
     and w.url = hook_url
     and w.secret = v_secret
   order by w.created_at desc
   limit 1;

  insert into public.webhook_subscription
    (workspace_id, event_type_id, url, filter, active, secret_set, secret_last_rotated_at, internal_webhook_id)
  select ws, et.id, hook_url, filter, true, true, now(), v_internal_id
    from public.event_type et
   where et.key = event_key
  returning id into v_subscription_id;

  return jsonb_build_object('subscription_id', v_subscription_id, 'secret', v_secret);
end;
$$;
```

**Gate**

```sh
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && supabase db diff
```

Expected: `workflows_webhooks_test.sql .. ok`; no diff.

### Task 2: Rotate, activate/deactivate, and filter RPCs

**Files**

- Update: `supabase/migrations/20260701000024_workflows_webhooks.sql`
- Update: `supabase/tests/workflows_webhooks_test.sql`

**Interfaces**

- Consumes: paired public/internal rows from Task 1.
- Produces: drift-safe management operations.

- [ ] **Step 1: Add failing tests**

Test:

- rotate changes the internal secret and updates `secret_last_rotated_at`;
- old HMAC fails and new HMAC verifies in the worker helper test;
- deactivate sets both public and internal inactive;
- set-filter updates public filter only after validating JSON shape;
- no operation leaks the secret in public row JSON.

Expected: FAIL until RPCs exist.

- [ ] **Step 2: Implement RPCs**

Every RPC:

1. checks membership with the provided `ws`;
2. loads the subscription by `id` and `workspace_id=ws`;
3. updates both rows when active state changes;
4. returns bounded JSON or the public row only.

Rotation updates the existing paired internal row directly because Core has no rotate RPC; this is not a second register path. The pair remains anchored by `webhook_subscription.internal_webhook_id`.

**Gate**

```sh
supabase db reset && supabase test db && node scripts/check-definer-audit.mjs && node scripts/check-boundary.sh && supabase db diff
```

Expected: pass.

### Task 3: Pairing reconciliation gate

**Files**

- Update: `supabase/tests/workflows_webhooks_test.sql`

**Interfaces**

- Produces a deterministic check: every active public subscription has exactly one active internal webhook and every internal workflow-managed webhook has one public subscription.

- [ ] **Step 1: Add failing drift fixture**

In pgTAP, insert a deliberately orphaned internal row as table owner and assert the reconciliation query reports it. Then clean it and assert zero drift.

Expected: FAIL until reconciliation query/helper exists.

- [ ] **Step 2: Add the gate**

Use a SQL function used by pgTAP:

```sql
public.webhook_subscription_pairing_drift()
```

It returns rows with `drift_code` values: `missing_internal`, `duplicate_internal`, `orphan_internal`, `active_mismatch`.

**Gate**

```sh
supabase test db && rg -n "secret" supabase/tests/workflows_webhooks_test.sql packages/flows/test/webhook-subscriptions.test.ts
```

Expected: tests pass; grep shows only test-local secret variables/assertions, no public-row secret column.

### Task 4: Filter-evaluated pre-fetch delivery

**Files**

- Update: `packages/flows/src/flows-worker.ts`
- Create: `packages/flows/test/webhook-subscriptions.test.ts`

**Interfaces**

- Consumes: webhook job payloads from `emit_event` and public subscription filters.
- Produces: non-matching filters complete without network fetch and without retry.

- [ ] **Step 1: Write failing worker tests**

Tests:

- unmanaged Core webhook with no public subscription still calls `fetch` once (backward compatibility for CMS publish webhooks);
- matching filter calls `fetch` once and signs the payload;
- non-matching filter calls no `fetch`, completes job ok, and returns processed/skipped count;
- invalid filter completes failed with `condition_invalid` only if the subscription config is corrupt; it does not leak payload values.

Expected: FAIL - current worker always fetches webhook jobs.

- [ ] **Step 2: Implement pre-fetch filter**

Leave `emit_event`'s webhook enqueue unchanged. Before `buildWebhookRequest`, use the job's `workspace_id` plus `payload.event`, `payload.url`, and `payload.secret` to call `public.webhook_subscription_for_delivery(...)`. That service-role-only definer RPC finds the internal webhook row and returns the paired public subscription filter when one exists. **A null lookup means "unmanaged Core webhook / no managed filter" and MUST deliver normally.** Only a present subscription filter evaluating `matched=false` skips HMAC/fetch and completes the job successfully.

Use this lookup shape:

```ts
async function subscriptionForWebhookJob(db: SupabaseClient, job: Job): Promise<{ filter: unknown } | null> {
  const event = stringField(job.payload.event)
  const url = stringField(job.payload.url)
  const secret = stringField(job.payload.secret)
  if (!job.workspace_id || !event || !url) return null
  const { data, error } = await db.rpc('webhook_subscription_for_delivery', {
    ws: job.workspace_id,
    event_key: event,
    hook_url: url,
    hook_secret: secret ?? null,
  })
  if (error) throw new Error(`webhook_subscription_lookup_failed:${error.code ?? 'unknown'}`)
  // Null means the webhook was registered directly through Core's register_webhook
  // (for example CMS publish webhooks). Preserve Core behavior: no managed filter.
  return data && typeof data === 'object' ? data as { filter: unknown } : null
}
```

The RPC is definer/service-role-only and does not check `is_workspace_member` because delivery is a backend worker path, not an end-user management path. It returns only `{filter}` and never returns the secret. The worker must treat `null` as deliver:

```ts
const sub = await subscriptionForWebhookJob(db, job)
if (sub?.filter != null) {
  const r = evaluateCondition(sub.filter, job.payload)
  if (!r.ok) throw new Error(r.errorCode)
  if (!r.matched) {
    await completeJob(db, job.id, true)
    processed++
    continue
  }
}
const { url, headers, body } = await buildWebhookRequest(job.payload as Record<string, unknown>)
```

SQL shape:

```sql
create or replace function public.webhook_subscription_for_delivery(ws uuid, event_key text, hook_url text, hook_secret text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object('filter', s.filter)
    from movp_internal.webhooks w
    join public.webhook_subscription s on s.internal_webhook_id = w.id
   where w.workspace_id = ws
     and w.event_type = event_key
     and w.url = hook_url
     and (w.secret is not distinct from hook_secret)
     and w.active
     and s.active
   limit 1;
$$;
revoke all on function public.webhook_subscription_for_delivery(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.webhook_subscription_for_delivery(uuid,text,text,text) to service_role;
```

**Gate**

```sh
pnpm --filter @movp/flows test -- webhook-subscriptions flows-worker
```

Expected: PASS; HMAC signing tests still pass.

### Task 5: Part C integration and commit

- [ ] **Step 1: Full verification**

```sh
pnpm --filter @movp/flows test
pnpm --filter @movp/flows typecheck
supabase db reset
supabase test db
node scripts/check-definer-audit.mjs
node scripts/check-boundary.sh
supabase db diff
```

Expected: all pass.

- [ ] **Step 2: Commit**

```sh
git add supabase/migrations/20260701000024_workflows_webhooks.sql supabase/tests/workflows_webhooks_test.sql packages/flows scripts
git commit -m "feat(workflows): manage webhook subscriptions safely"
```

## Self-Review

- **Correctness:** RPCs own all public/internal pairing mutations; filters run before fetch.
- **Safety:** Membership gate precedes internal access; secrets never persist publicly; direct public writes are denied.
- **Reliability:** Pairing drift is test-detectable; deactivate stops delivery by changing both rows.
- **Observability:** Skipped/failed delivery outcomes get stable codes without payload values.
- **Efficiency:** Non-matching filters avoid network/HMAC work.
- **Performance:** Pairing and subscription lookups are indexed by workspace/id/event type from Parts A/C.
- **Simplicity:** Uses Core internal webhook table rather than a second delivery registry.
- **Usability:** Register/rotate returns the secret once and exposes rotation timestamp/active state for Part D.
