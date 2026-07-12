# MOVP Stage C5c — CRM Recipes, Zapier/n8n Templates, Integration Slice

> **For agentic workers (Codex):** implement task-by-task with TDD. Steps use checkbox
> (`- [ ]`) syntax. Samples line-verified against committed code (2026-07-11).
> **Precondition: C5a + C5b merged.** Third of three C5 plans; expanded from
> `2026-07-11-movp-stage-c05-integration-fabric-design.md` §C5c and roadmap §C5.4–C5.6.
> REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.

**Goal:** make the integration fabric *usable* — copy-paste CRM recipes (HubSpot/Salesforce/
Attio) with one runnable mock sync worker + CI smoke, importable Zapier/n8n templates with a
lint gate, and an end-to-end `[integration]` slice proving idempotent ingest → `external_ref`
upsert → RLS-guarded PostgREST read.

**Architecture:** docs + examples + gated scripts, no new DB surface. The mock sync worker is a
Node script that exercises the **inbound** path (mock CRM payload → `upsert_by_external_ref` via
the PostgREST RPC) against the local stack; the **outbound** path (webhook_subscription →
transformer → CRM API) is documented and reuses the app-06 webhook machinery. Templates are
static JSON validated by a lint script. The `[integration]` slice block extends the linear
`scripts/slice-e2e.sh` and runs in the existing `slice-e2e` CI job.

**Tech stack:** Markdown docs; Node (mock CRM `http` server, smoke + lint scripts); bash/`curl`/
`psql` in `slice-e2e.sh`; GitHub Actions.

## Global Constraints (every task inherits these)
- **TDD/gate-first.** Each script/template has a failing gate before content exists.
- **No secrets in templates or examples** — placeholders only (`<MOVP_PAT>`, `<CRM_API_KEY>`);
  the lint gate greps for obvious leaked-secret shapes and fails on a hit.
- **Recipes reference real surfaces only:** `upsert_by_external_ref`, the `ingest` edge fn +
  `ingest_platform_event`, `webhook_subscription` (app-06), PATs/CLI (C3). No invented endpoints.
- **Deferred (documented, not built):** bundled connector runtime/marketplace, field-mapping UI,
  CDC/logical-replication streaming.
- **Per-task gate + one commit per task.**

## File Structure
- `docs/integrations/crm-sync.md` — HubSpot/Salesforce/Attio inbound+outbound recipe.
- `examples/sync-worker/{README.md,worker.mjs,mock-crm.mjs}` — runnable inbound sync example.
- `scripts/check-integration-smoke.mjs` — CI smoke (mock CRM → upsert → assert).
- `templates/integrations/{zapier-inbound.json,n8n-inbound.json}` — importable flows.
- `scripts/check-integration-templates.mjs` — template lint (valid JSON + no secrets).
- `scripts/slice-e2e.sh` — new `[integration]` block.
- `.github/workflows/ci.yml` — `integration-smoke` + `integration-templates` jobs.

---

## Task C5c.1: CRM sync recipe docs

**Files**
- Create: `docs/integrations/crm-sync.md`
- Modify: `scripts/check-docs-presence.mjs` (add `docs/integrations/crm-sync.md`)

- [ ] **Step 1 — add the presence gate (failing).** Add `'docs/integrations/crm-sync.md'` to the
required-docs array in `scripts/check-docs-presence.mjs`.

- [ ] **Step 2 — run it, expect RED:**

```sh
node scripts/check-docs-presence.mjs
```
Expected: **FAIL** — file missing.

- [ ] **Step 3 — write `docs/integrations/crm-sync.md`.** Cover, with concrete `curl`/SQL:
  - **Inbound (CRM → MOVP):** a CRM webhook (HubSpot contact, Salesforce/Attio record) maps to
    `upsert_by_external_ref(ws, '<crm>', '<crm record id>', <payload jsonb>)` — idempotent, emits
    `external.record.upserted` which segmentation/automation consume. Show the PostgREST RPC call:

    ```
    curl -sS "$API_URL/rest/v1/rpc/upsert_by_external_ref" \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer <MOVP_PAT_SESSION_JWT>" \
      -H "content-type: application/json" \
      -d '{"ws":"<workspace-uuid>","source":"hubspot","external_id":"<contact-id>","payload":{"stage":"lead"}}'
    ```
    Note the external identity `(source, external_id)` is **immutable** — re-syncing the same
    record updates `payload` only; a changed id is a new record.
  - **Inbound (event stream):** high-volume CRM *events* (not entities) go through the `ingest`
    edge fn with an `x-ingest-key` and an optional per-event `idempotency_key` (dedupe on retry).
  - **Outbound (MOVP → CRM):** register a `webhook_subscription` for the event types you care
    about; a transformer worker receives the signed delivery and calls the CRM API. Reference the
    app-06 webhook signing + delivery docs; note payloads are keys-only for audited events.
  - **HubSpot/Salesforce/Attio specifics:** the `source` value per system, id field names, and
    which direction each supports out of the box.
  - **Deferred** section: connector runtime/marketplace, field-mapping UI, CDC.

- [ ] **Step 4 — gate + commit.**

```sh
node scripts/check-docs-presence.mjs   # Expected: pass
git add docs/integrations/crm-sync.md scripts/check-docs-presence.mjs
git commit -m "docs(reporting): C5c.1 CRM sync recipe (HubSpot/Salesforce/Attio, inbound+outbound)"
```

---

## Task C5c.2: Runnable mock sync worker + CI smoke

**Files**
- Create: `examples/sync-worker/README.md`, `examples/sync-worker/worker.mjs`, `examples/sync-worker/mock-crm.mjs`
- Create: `scripts/check-integration-smoke.mjs`
- Modify: `.github/workflows/ci.yml` (add `integration-smoke` job)

**Interfaces (consumed):** `$API_URL`, `$ANON_KEY`, `$SERVICE_ROLE_KEY`, `$DB_URL` from
`supabase status -o env`; the GoTrue password-grant JWT mint pattern (`slice-e2e.sh:117-134`);
`upsert_by_external_ref` (C5a).

- [ ] **Step 1 — write the failing smoke.** Create `scripts/check-integration-smoke.mjs` — it must
(a) start a mock CRM HTTP server (`node:http`) that serves one contact record, (b) mint a member
JWT + workspace (reuse the GoTrue password grant + `psql` membership insert), (c) POST the mock
record to `rpc/upsert_by_external_ref`, (d) assert the returned row's `external_id` matches and a
second identical call is idempotent (no error, same id), then exit 0; any mismatch → `exit 1`.
Read env like the repo's scripts:

```js
const API_URL = process.env.SUPABASE_URL ?? process.env.API_URL ?? 'http://127.0.0.1:64321'
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.ANON_KEY
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SERVICE_ROLE_KEY
if (!ANON_KEY || !SERVICE_ROLE_KEY) { console.error('missing ANON_KEY/SERVICE_ROLE_KEY'); process.exit(1) }
```

Mint the member JWT (verbatim shape from the slice):

```js
// create + confirm a user via GoTrue admin, then password-grant for the access token
await fetch(`${API_URL}/auth/v1/admin/users`, { method: 'POST',
  headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'sync-smoke@example.com', password: 'Passw0rd!1', email_confirm: true }) })
const tok = await (await fetch(`${API_URL}/auth/v1/token?grant_type=password`, { method: 'POST',
  headers: { apikey: ANON_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'sync-smoke@example.com', password: 'Passw0rd!1' }) })).json()
const TOKEN = tok.access_token
const userId = JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64url')).sub
```

Then insert workspace + membership via `psql "$DB_URL"` (child_process), call the RPC twice, and
assert. Keep the mock CRM server + assertions self-contained.

- [ ] **Step 2 — run it, expect RED:**

```sh
supabase start >/dev/null 2>&1 || true
eval "$(supabase status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
node scripts/check-integration-smoke.mjs
```
Expected: **FAIL** — `worker.mjs`/smoke not implemented (or the RPC path not wired), non-zero exit.

- [ ] **Step 3 — implement `examples/sync-worker/`.** `mock-crm.mjs` = a tiny `http` server that
returns `{ id: 'crm-1', properties: { stage: 'lead' } }`. `worker.mjs` = the reusable inbound
sync: fetch from the mock CRM, map to `{ ws, source:'mockcrm', external_id: record.id, payload: record.properties }`,
POST to `rpc/upsert_by_external_ref` with a PAT/session bearer. `README.md` = how to run it with a
real PAT + `MOVP_API_URL`. Wire `check-integration-smoke.mjs` to import/exercise `worker.mjs`
against the mock server so the smoke and the example share one code path.

- [ ] **Step 4 — run it, expect GREEN:**

```sh
node scripts/check-integration-smoke.mjs   # Expected: prints "integration-smoke: PASS", exit 0
```

- [ ] **Step 5 — add the CI job.** In `.github/workflows/ci.yml` add (mirrors the live-DB+script
`vector-scale` job template):

```yaml
  integration-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v6
        with: { version: 9.12.0 }
      - uses: actions/setup-node@v6
        with: { node-version: 22, cache: pnpm }
      - uses: supabase/setup-cli@v2
        with: { version: latest }
      - run: pnpm install --frozen-lockfile
      - run: supabase start
      - run: supabase db reset
      - name: Run integration smoke
        run: |
          eval "$(supabase status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
          node scripts/check-integration-smoke.mjs
```

- [ ] **Step 6 — gate + commit.**

```sh
git add examples/sync-worker scripts/check-integration-smoke.mjs .github/workflows/ci.yml
git commit -m "feat(reporting): C5c.2 mock sync worker + integration smoke (inbound CRM → upsert_by_external_ref)"
```

---

## Task C5c.3: Zapier/n8n templates + lint

**Files**
- Create: `templates/integrations/zapier-inbound.json`, `templates/integrations/n8n-inbound.json`
- Create: `scripts/check-integration-templates.mjs`
- Modify: `.github/workflows/ci.yml` (add `integration-templates` job — or fold into `typecheck`)

- [ ] **Step 1 — write the failing lint.** Create `scripts/check-integration-templates.mjs`: glob
`templates/integrations/*.json`, `JSON.parse` each (fail on parse error), assert each contains the
required placeholder keys (`<MOVP_API_URL>`, `<MOVP_PAT>`), and **fail if any value matches a
secret shape** — e.g. `/\bmovp_pat_[0-9a-f]{64}\b/`, `/eyJ[A-Za-z0-9_-]{20,}\./` (a JWT), or
`/sk-[A-Za-z0-9]{20,}/`. Exit non-zero with the offending file+key on any violation; else print
`integration-templates: PASS`.

- [ ] **Step 2 — run it, expect RED:**

```sh
node scripts/check-integration-templates.mjs
```
Expected: **FAIL** — no template files found.

- [ ] **Step 3 — write the templates.** Each is an importable flow with placeholders only. Shape
(zapier-inbound.json shown; n8n analogous):

```json
{
  "name": "MOVP — CRM contact → upsert_by_external_ref",
  "trigger": { "app": "hubspot", "event": "contact.created" },
  "action": {
    "app": "webhooks",
    "method": "POST",
    "url": "<MOVP_API_URL>/rest/v1/rpc/upsert_by_external_ref",
    "headers": { "apikey": "<MOVP_ANON_KEY>", "Authorization": "Bearer <MOVP_PAT>", "content-type": "application/json" },
    "body": { "ws": "<WORKSPACE_ID>", "source": "hubspot", "external_id": "{{contact.id}}", "payload": "{{contact.properties}}" }
  },
  "notes": "external_id is immutable; re-syncs update payload only. Store <MOVP_PAT> as a Zapier secret, never inline."
}
```

- [ ] **Step 4 — run it, expect GREEN:**

```sh
node scripts/check-integration-templates.mjs   # Expected: integration-templates: PASS
```

- [ ] **Step 5 — CI + commit.** Add a tiny `integration-templates` job (static-script template,
like `boundary`) to `ci.yml`, or add `node scripts/check-integration-templates.mjs` to the
`typecheck` job's steps.

```sh
git add templates/integrations scripts/check-integration-templates.mjs .github/workflows/ci.yml
git commit -m "feat(reporting): C5c.3 Zapier/n8n import templates + secret-safe lint"
```

---

## Task C5c.4: `[integration]` end-to-end slice

**Files**
- Modify: `scripts/slice-e2e.sh` (add an `[integration]` block before the closing `[8]` block)

**Interfaces (consumed):** slice env + `$TOKEN`/`$WS`/`$USER_ID` (`:117-134`); `$DB_URL`;
`ingest_platform_event` via the `ingest` edge fn; `upsert_by_external_ref` via `rpc/`.

- [ ] **Step 1 — add the block.** Insert into `scripts/slice-e2e.sh` before
`echo "== [integration-exposure] ... =="` (from C5b.2):

```bash
echo "== [integration] idempotent ingest + external-ref upsert round trip =="
# mint an ingest key for $WS (service-role: store the sha256 of the raw key)
RAW_IK="slice-integration-key"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c \
  "insert into movp_internal.ingest_key (workspace_id, key_hash, label, active)
   values ('$WS', encode(extensions.digest('$RAW_IK','sha256'),'hex'), 'slice', true)
   on conflict (key_hash) do nothing;"

EV='{"events":[{"event_type":"signup.completed","subject_ref":"u-int","occurred_at":"2026-07-11T00:00:00Z","idempotency_key":"slice-k1"}]}'
R1="$(curl -sS "$API_URL/functions/v1/ingest" -H "apikey: $ANON_KEY" -H "x-ingest-key: $RAW_IK" -H "content-type: application/json" -d "$EV")"
echo "$R1" | json_get inserted | grep -q '^1$' || { echo "ingest did not insert 1: $R1"; exit 1; }
R2="$(curl -sS "$API_URL/functions/v1/ingest" -H "apikey: $ANON_KEY" -H "x-ingest-key: $RAW_IK" -H "content-type: application/json" -d "$EV")"
echo "$R2" | json_get duplicate | grep -q '^1$' || { echo "replay not deduped: $R2"; exit 1; }

# external-ref upsert via PostgREST RPC as a member, then RLS-read it back
curl -sS "$API_URL/rest/v1/rpc/upsert_by_external_ref" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d "{\"ws\":\"$WS\",\"source\":\"slice\",\"external_id\":\"int-1\",\"payload\":{\"stage\":\"lead\"}}" >/dev/null
UP="$(curl -sS "$API_URL/rest/v1/external_record?select=external_id&source=eq.slice&external_id=eq.int-1" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOKEN")"
echo "$UP" | grep -q 'int-1' || { echo "external_record not readable after upsert: $UP"; exit 1; }
# the upsert emitted an external.record.upserted event
EVT="$(psql "$DB_URL" -tA -c "select count(*) from movp_internal.movp_events where type='external.record.upserted' and workspace_id='$WS';")"
[ "$EVT" -ge 1 ] || { echo "no external.record.upserted event emitted"; exit 1; }
```

- [ ] **Step 2 — run the slice, expect PASS.**

```sh
supabase start >/dev/null 2>&1 || true
pkill -f 'supabase.*functions serve|edge-runtime' || true
bash scripts/slice-e2e.sh 2>&1 | grep -E '\[integration\]|slice-e2e:'
```
Expected: the `[integration]` banner prints; `slice-e2e: PASS`.

- [ ] **Step 3 — full-suite gate + commit.**

```sh
supabase db reset && supabase test db 2>&1 | tail -3    # Expected: Result: PASS (all pgTAP incl. C5a/C5b)
node scripts/check-forward-only-migrations.mjs          # Expected: ok
git add scripts/slice-e2e.sh
git commit -m "test(reporting): C5c.4 [integration] slice — idempotent ingest + external-ref upsert round trip"
```

---

## Deferred (C5c)
- Bundled connector runtime / marketplace, field-mapping UI, CDC streaming (documented in
  `docs/integrations/crm-sync.md`).
- Outbound CRM delivery is documented (reuses app-06 webhooks) but not smoke-tested end-to-end in
  v1 (the mock smoke covers inbound; outbound relies on the existing webhook slice coverage).

## Eight-dimension self-check (C5c)
- **Correctness:** the slice proves the real round trip (ingest dedupe + upsert + event + RLS read).
- **Safety:** templates/examples carry no secrets (lint-enforced); recipes use only real surfaces.
- **Reliability:** the smoke + slice are fail-loud (`exit 1` on any mismatch).
- **Observability:** the slice asserts the `external.record.upserted` event actually landed.
- **Efficiency/Performance:** docs + gated scripts only; no new runtime surface.
- **Simplicity:** the mock sync worker and the CI smoke share one `worker.mjs` code path.
- **Usability:** one runnable example + two importable templates + a concrete recipe doc.

---

## C5 series completion (all three plans)
When C5a+C5b+C5c are merged, update the **Stage B/C EXECUTION STATUS table** in
`docs/superpowers/plans/README.md` to mark C5 executed, and record the C5 merge in the
architecture memory. Remaining Stage C: **C6** (templates/scaffolder, needs C1 ✅ — enriched by
C4/C5), then C7/C8.
