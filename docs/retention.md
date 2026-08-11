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

## Experiment Assignments

`public.prune_experiment_assignment_retention(...)` removes stale, hash-only A/B assignment rows.
It is service-role-only, retains the newest activity by `last_seen_at`, defaults to 90 days, and
deletes at most 10,000 rows per call.

Before enabling experiment delivery, provision one high-entropy value in both deployment stores:
the Cloudflare Worker secret `DELIVERY_ASSIGNMENT_SIGNING_KEY` and the Supabase Vault secret named
`movp_delivery_assignment_signing_key`. The public route signs each cookie's random nonce with the
workspace id; the delivery RPC verifies that signature before it writes. Do not place this value in
`wrangler.jsonc`, public environment variables, or migration SQL.

`movp_internal.experiment_variant_exposure.exposure_count` is a bounded-storage, per-variant
count of signed delivery requests, including first visits. A signed cookie is replayable by a
network client, so this is an operational traffic signal rather than a fraud-resistant conversion
denominator. In contrast,
`public.experiment_assignment.exposure_count` records only visits after a signed cookie has returned
and must not be used as an experiment conversion-rate denominator. Aggregate exposure rows are bounded
by the number of variants and are retained with experiment/variant lifecycle.
`movp_internal.experiment_variant_exposure_daily` stores one narrow counter per variant and observed date, so
`public.reporting_experiment_exposure(workspace_id, days)` can return a member-gated, 90-day-clamped count without
adding per-visitor rows or rebuilding JSONB on delivery. The daily table is service-role-only and
`public.prune_experiment_variant_exposure_daily_retention(...)` removes rows older than 90 days in batches of at
most 10,000. Schedule it independently; retention is deploy-time configuration, not migration SQL.

An active experiment response with an unverified assignment token emits the bounded
`delivery_experiment_assignment_unsigned` code. Alert on a sustained non-zero rate after deployment or
secret rotation: it means the Worker secret and Vault secret are absent or do not match, while delivery
continues deterministically without recording exposure data. A missing Worker secret leaves non-experiment
pages cacheable and serves experiment control without setting a cookie.

To verify deployed Worker/Vault agreement without reading either secret, extract the assignment key from a
first-sight request with no `movp-ab-assignment` cookie to a published experiment page:

```sh
ASSIGNMENT_KEY="$(curl -sS -D - -o /dev/null 'https://<site>/<content-type>/<slug>' \
  | sed -n 's/^[Ss]et-[Cc]ookie: movp-ab-assignment=\([^;]*\).*/\1/p')"
if [ -z "$ASSIGNMENT_KEY" ]; then
  echo 'no cookie minted: DELIVERY_ASSIGNMENT_SIGNING_KEY is missing on the Worker' >&2
fi
```

Expected: no output and a non-empty `ASSIGNMENT_KEY`. A missing cookie stops the check and identifies the
missing Worker secret. Confirm the linked project reference matches the Supabase project used by the deployed
Worker, then query its Vault-backed verifier:

```sh
supabase projects list
supabase db query --linked "select movp_internal.delivery_assignment_key_is_signed('<workspace-id>'::uuid, '${ASSIGNMENT_KEY:?no assignment key: Worker signing key missing}');"
```

Expected: `supabase projects list` marks the intended project as linked, and the query returns `true`. A `false`
result means the Vault signing secret is absent or its verifier rejects the cookie minted by the deployed Worker.

The delivery RPC materializes the published variant set once per experiment request; keep this path below
100 signed experiment requests per second per variant until counter sharding is introduced.

Schedule it separately from the internal spine job so assignment volume is visible on its own:

```sql
select cron.schedule(
  'experiment-assignment-retention-daily',
  '17 3 * * *',
  $$ select public.prune_experiment_assignment_retention(); $$
);

select cron.schedule(
  'experiment-exposure-daily-retention',
  '27 3 * * *',
  $$ select public.prune_experiment_variant_exposure_daily_retention(); $$
);
```

Monitor returned delete counts for both jobs. A sustained increase means investigate experiment traffic and
cookie behavior before changing the retention window or batch bound.

## Verification

Before enabling the schedule in a new environment:

```sh
supabase db reset
supabase test db
node scripts/check-definer-audit.mjs
```

After enabling the schedule, monitor returned prune counts and dead-job volume. Unexpectedly high
counts are an operations signal, not a reason to broaden the pruning predicate.
