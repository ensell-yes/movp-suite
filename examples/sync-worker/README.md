# Mock CRM sync worker

This example demonstrates inbound entity synchronization. It fetches a CRM contact and sends it
to `upsert_by_external_ref`, so replaying the same source and record id updates payload rather
than creating a duplicate.

Provide a session JWT exchanged from a MOVP PAT, then call `syncRecord` with `MOVP_API_URL`, the
Supabase anon key, workspace id, and the CRM source. The checked-in mock server is used by
`node scripts/check-integration-smoke.mjs`; real workers should replace it with the CRM API and
keep CRM credentials in their secret manager.
