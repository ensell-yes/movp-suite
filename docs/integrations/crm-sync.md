# CRM sync recipes

MOVP supports a small, reliable integration core: external entities are upserted through one
idempotent RPC, and high-volume events use the bounded `ingest` edge function. HubSpot,
Salesforce, and Attio use the same pattern.

## Inbound entities: CRM to MOVP

Map each CRM record to a stable source and source-specific record id, then call the PostgREST RPC
with a member session JWT (including a session exchanged from a MOVP PAT):

```sh
MOVP_PAT_SESSION_JWT="$(curl -sS "$API_URL/functions/v1/auth-exchange" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer <MOVP_PAT>" \
  -H "content-type: application/json" \
  -d '{}' | jq -r '.access_token')"
```

The raw `movp_pat_...` token is accepted only by the exchange endpoint. PostgREST requires the
short-lived session JWT returned in `access_token`.

```sh
curl -sS "$API_URL/rest/v1/rpc/upsert_by_external_ref" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer <MOVP_PAT_SESSION_JWT>" \
  -H "content-type: application/json" \
  -d '{"ws":"<workspace-uuid>","source":"hubspot","external_id":"<contact-id>","payload":{"stage":"lead"}}'
```

Use `source: "hubspot"` with `contact.id`, `source: "salesforce"` with `Id`, and
`source: "attio"` with the record id. The external identity `(source, external_id)` is immutable:
resyncing the same record updates `payload`; a changed external id creates a new record.

Each successful insert or payload change emits `external.record.upserted`, which automations
consume directly. Segment targeting from external records is deferred until a documented
`platform_event` bridge exists.

## Inbound events: CRM to MOVP

For high-volume activity rather than durable CRM entities, POST to the `ingest` edge function with
an `x-ingest-key`. Provide an optional string `idempotency_key` per event so a retry is deduped
against the normalized payload. The API-key path is idempotent; JWT direct-table ingestion is not.

## Outbound: MOVP to CRM

Register a `webhook_subscription` for the MOVP event types your CRM should receive. A transformer
worker verifies the existing app-06 signed delivery, maps the keys-only event payload, and calls
the HubSpot, Salesforce, or Attio API with that provider's credential. Keep CRM credentials in the
worker's secret store, never in subscription configuration or templates.

HubSpot supports contact webhook triggers and contact API updates; Salesforce supports platform
events/webhooks and object updates; Attio supports record webhooks and record updates. Select the
provider's stable record id as the `external_id` in all cases.

## Deferred

- Bundled connector runtime or marketplace
- Field-mapping UI
- CDC or logical-replication streaming
