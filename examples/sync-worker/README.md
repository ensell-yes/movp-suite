# Mock CRM sync worker

This example demonstrates inbound entity synchronization. It fetches a CRM contact and sends it
to `upsert_by_external_ref`, so replaying the same source and record id updates payload rather
than creating a duplicate.

Exchange a MOVP PAT through `/functions/v1/auth-exchange` first, then call `syncRecord` with the
returned session JWT, `MOVP_API_URL`, the Supabase anon key, workspace id, and CRM source. The checked-in mock server is used by
`node scripts/check-integration-smoke.mjs`; real workers should replace it with the CRM API and
keep CRM credentials in their secret manager.
