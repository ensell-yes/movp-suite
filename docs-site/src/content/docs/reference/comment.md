---
title: Comment
description: DSL reference for the comment collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `comment`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `author_id` | `uuid` | Author | — | — | no | no |
| `body` | `richText` | Body | — | — | yes | no |
| `entity_id` | `uuid` | Entity | — | — | no | no |
| `entity_type` | `text` | Entity Type | — | — | no | no |
| `parent` | `relation` | Parent Comment | many-to-one | — | no | no |
