---
title: Content Publish Event
description: DSL reference for the content_publish_event collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `content_publish_event`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `action` | `enum` | Action | — | dimension | no | no |
| `actor_id` | `uuid` | Actor | — | — | no | no |
| `content_hash` | `text` | Content Hash | — | — | no | no |
| `content_item` | `relation` | Content Item | many-to-one | — | no | no |
| `revision` | `relation` | Revision | many-to-one | — | no | no |
