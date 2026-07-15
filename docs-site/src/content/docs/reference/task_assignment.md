---
title: Task Assignment
description: DSL reference for the task_assignment collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `task_assignment`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `assignee_user_id` | `uuid` | Assignee | — | — | no | no |
| `role` | `enum` | Role | — | — | no | no |
| `task` | `relation` | Task | many-to-one | — | no | no |
