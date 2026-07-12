# REST API (PostgREST facade)

MOVP does not ship a bespoke REST layer. Supabase PostgREST exposes the `public`
schema behind the same row-level security (RLS) policies used throughout the platform, so it
is the REST API for reads and RLS-safe writes.

- **Local base URL:** `http://127.0.0.1:64321/rest/v1/<table>`.
- **Authentication:** every request needs `apikey`. Authenticated requests also send
  `Authorization: Bearer <JWT>`, using a user session or a session exchanged from a Personal
  Access Token.
- **Exposed schemas:** `public` and `graphql_public` only. `movp_internal` contains jobs,
  events, ingest keys, and idempotency records and is never exposed through PostgREST.
- **RLS is the boundary:** anonymous requests are denied from workspace tables. Members can read
  and write only rows in workspaces where `is_workspace_member(workspace_id)` is true. Depending
  on the endpoint and role, a denied anonymous read is an empty result or an HTTP denial response.

The enforceable boundary is audited by
[`supabase/tests/postgrest_exposure_test.sql`](../supabase/tests/postgrest_exposure_test.sql) and
the `[integration-exposure]` block in [`scripts/slice-e2e.sh`](../scripts/slice-e2e.sh).

## `internal:true` is not REST hiding

`internal:true` in the schema DSL only omits a collection from generated GraphQL, MCP, and CLI
CRUD surfaces. It does not hide a regular `public` table from PostgREST. Authenticated members
can still reach an `internal:true` table according to its table grants and RLS policies. The only
data hidden from the REST facade is data in unexposed schemas such as `movp_internal`, plus rows
denied by RLS.

## Use RPCs for invariant-bearing writes

Direct PostgREST writes are RLS-safe, but they cannot enforce multi-row atomicity or all domain
invariants. Use the documented RPC or edge-function surface for these operations:

- `upsert_by_external_ref(ws, source, external_id, payload)` performs an idempotent external
  entity upsert. The `(source, external_id)` identity is immutable; a re-sync changes payload only.
- The `ingest` edge function calls `ingest_platform_event` for bounded event ingestion. API-key
  events can provide a per-event `idempotency_key` for safe retry deduplication.
- Task and content lifecycle operations should use their create-with-revision, approval, and
  publish RPCs rather than piecing together invariants with individual table writes.
