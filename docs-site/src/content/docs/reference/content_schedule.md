---
title: Content Schedule
description: DSL reference for the content_schedule collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `content_schedule`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `action` | `enum` | Action | — | — | no | no |
| `content_item` | `relation` | Content Item | many-to-one | — | no | no |
| `revision` | `relation` | Revision | many-to-one | — | no | no |
| `run_at` | `datetime` | Run At | — | — | no | no |
| `scheduled_by` | `uuid` | Scheduled By | — | — | no | no |
| `state` | `enum` | State | — | dimension | no | no |
