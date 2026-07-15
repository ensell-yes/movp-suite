---
title: Webhook Subscription
description: DSL reference for the webhook_subscription collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `webhook_subscription`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `active` | `boolean` | Active | — | — | no | no |
| `event_type` | `relation` | Event Type | many-to-one | — | no | no |
| `filter` | `json` | Filter | — | — | no | no |
| `internal_webhook_id` | `uuid` | Internal Webhook | — | — | no | no |
| `secret_last_rotated_at` | `datetime` | Secret Last Rotated At | — | — | no | no |
| `secret_set` | `boolean` | Secret Set | — | — | no | no |
| `url` | `text` | URL | — | — | no | no |
