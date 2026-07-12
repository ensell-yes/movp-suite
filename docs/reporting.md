# Reporting and dashboards

## Included reporting surfaces

- The `reporting` schema contains codegen-emitted, security-invoker views over every
  collection with reporting metadata, plus `reporting.v_task_cycle`. RLS continues to
  limit application members to their workspaces.
- Eight member-gated dashboard RPCs provide task, content, campaign, segment, workflow,
  ingestion, internal-event, and job aggregates. Date ranges are clamped to at most 90
  days. Internal event/job readers return counts and bounded classifiers only.
- `/admin/reports` provides the prebuilt application dashboards.
- Reporting resolver failures cross Yoga's production masking boundary as safe GraphQL
  errors with `FORBIDDEN` or `INTERNAL_SERVER_ERROR`. The page preserves successful
  sections when another reporting field fails and shows the failure within that section.
- Server failure events include the authenticated actor and a SHA-256 workspace identifier;
  raw workspace values and database error text are not emitted or returned to clients.

## External BI quickstart

An external PostgreSQL login has no application JWT claims, so it cannot use the
security-invoker application views. An operator can create a separate mirror:

The `reporting` schema is not exposed through the Data API, so run this from a direct
admin database session as `postgres` or `supabase_admin`:

```sql
select reporting.setup_bi_mirror();

create role movp_bi login password '<generate-a-strong-password>';
grant usage on schema reporting_bi to movp_bi;
grant select on all tables in schema reporting_bi to movp_bi;
```

Point the BI client at the database with the `movp_bi` credentials and select the
`reporting_bi` schema.

Important security properties:

- `reporting_bi` bypasses RLS and exposes all workspaces in the deployment. Grant its
  role only to operators trusted with that scope, or filter `workspace_id` downstream.
- Each mirror view is generated from the reporting view's resolved SQL, preserving its
  explicit bounded projection while executing base-table reads as the mirror owner.
- The role receives no access to base tables, `movp_internal`, or the application-facing
  `reporting` schema. `supabase/tests/reporting_bi_grants_test.sql` pins those boundaries.
- The function-level operator guard is defense in depth beyond the EXECUTE revoke. Its
  regression test temporarily grants an application role and asserts the exact
  `reserved_for_operator` failure from inside the function body.
- Re-run `reporting.setup_bi_mirror()` after adding reporting views, then repeat the
  `grant select on all tables in schema reporting_bi` statement for the BI role.

No BI product is bundled; this integration is intentionally limited to SQL and the
operator-managed database credentials.
