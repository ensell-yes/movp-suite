---
title: Task Status History
description: DSL reference for the task_status_history collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `task_status_history`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `changed_by` | `uuid` | Changed By | — | — | no | no |
| `from_status_id` | `uuid` | From Status | — | — | no | no |
| `task` | `relation` | Task | many-to-one | — | no | no |
| `to_status_id` | `uuid` | To Status | — | — | no | no |
