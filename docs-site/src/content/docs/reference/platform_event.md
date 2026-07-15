---
title: Platform Event
description: DSL reference for the platform_event collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `platform_event`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `actor_ref` | `text` | Actor Ref | — | — | no | no |
| `event_type` | `text` | Event Type | — | dimension | no | no |
| `ingested_at` | `datetime` | Ingested At | — | — | no | no |
| `occurred_at` | `datetime` | Occurred At | — | dimension | no | no |
| `properties` | `json` | Properties | — | — | no | no |
| `source` | `enum` | Source | — | dimension | no | no |
| `subject_ref` | `text` | Subject Ref | — | — | no | no |
| `subject_type` | `text` | Subject Type | — | dimension | no | no |
