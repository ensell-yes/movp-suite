---
title: Content Revision
description: DSL reference for the content_revision collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `content_revision`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `author_id` | `uuid` | Author | — | — | no | no |
| `content_hash` | `text` | Content Hash | — | — | no | no |
| `content_item` | `relation` | Item | many-to-one | — | no | no |
| `data` | `json` | Data | — | — | no | no |
| `parent` | `relation` | Parent Revision | many-to-one | — | no | no |
| `revision_number` | `number` | Revision Number | — | — | no | no |
