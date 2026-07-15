---
title: Mention
description: DSL reference for the mention collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `mention`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `comment` | `relation` | Comment | many-to-one | — | no | no |
| `entity_id` | `uuid` | Entity | — | — | no | no |
| `entity_type` | `text` | Entity Type | — | — | no | no |
| `mentioned_user_id` | `uuid` | Mentioned User | — | — | no | no |
