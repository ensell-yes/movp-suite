---
title: Note
description: DSL reference for the note collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `note`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `body` | `richText` | Body | — | — | yes | yes |
| `status` | `enum` | Status | — | dimension | no | no |
| `tags` | `relation` | Tags | many-to-many | — | no | no |
| `title` | `text` | Title | — | — | yes | no |
