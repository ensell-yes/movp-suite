---
title: Task Revision
description: DSL reference for the task_revision collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `task_revision`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `author_id` | `uuid` | Author | — | — | no | no |
| `body` | `richText` | Body | — | — | yes | yes |
| `content_hash` | `text` | Content Hash | — | — | no | no |
| `task` | `relation` | Task | many-to-one | — | no | no |
