---
title: Content Collection Entry
description: DSL reference for the content_collection_entry collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `content_collection_entry`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `collection` | `relation` | Collection | many-to-one | — | no | no |
| `content_item` | `relation` | Content Item | many-to-one | — | no | no |
| `position` | `number` | Position | — | — | no | no |
