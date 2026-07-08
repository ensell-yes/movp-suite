# Internal Retention

MOVP stores durable operational history in `movp_internal.movp_events` and
`movp_internal.movp_jobs`. The production pruning primitive is
`public.prune_internal_retention(...)`.

The migration ships the RPC only. The schedule is deploy-time configuration so `supabase db diff`
stays empty across environments.

## Recommended Schedule

Run daily from `pg_cron` with a service-role execution context. Store any deploy automation
credentials in Supabase Vault, not in migration SQL or source control.

Example deploy-time SQL shape:

```sql
select cron.schedule(
  'movp-internal-retention-daily',
  '17 3 * * *',
  $$
    select public.prune_internal_retention(
      event_retention_days => 90,
      terminal_job_retention_days => 30,
      batch_size => 10000
    );
  $$
);
```

Do not prune `failed`, `pending`, or `running` jobs. The RPC only prunes terminal jobs and old
events; `workflow_run.source_event_id` intentionally remains an audit pointer even after the
event row ages out.

## Verification

Before enabling the schedule in a new environment:

```sh
supabase db reset
supabase test db
node scripts/check-definer-audit.mjs
```

After enabling the schedule, monitor returned prune counts and dead-job volume. Unexpectedly high
counts are an operations signal, not a reason to broaden the pruning predicate.
