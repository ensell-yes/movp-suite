---
title: Task Dependency
description: DSL reference for the task_dependency collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `task_dependency`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `blocker` | `relation` | Blocker | many-to-one | — | no | no |
| `task` | `relation` | Task | many-to-one | — | no | no |
