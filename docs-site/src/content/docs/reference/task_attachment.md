---
title: Task Attachment
description: DSL reference for the task_attachment collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `task_attachment`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `bytes` | `number` | Bytes | — | — | no | no |
| `content_type` | `text` | Content Type | — | — | no | no |
| `filename` | `text` | Filename | — | — | no | no |
| `r2_key` | `text` | R2 Key | — | — | no | no |
| `task` | `relation` | Task | many-to-one | — | no | no |
| `uploaded_by` | `uuid` | Uploaded By | — | — | no | no |
