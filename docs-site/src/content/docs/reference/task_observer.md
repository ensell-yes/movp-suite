---
title: Task Observer
description: DSL reference for the task_observer collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `task_observer`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `observer_user_id` | `uuid` | Observer | — | — | no | no |
| `task` | `relation` | Task | many-to-one | — | no | no |
