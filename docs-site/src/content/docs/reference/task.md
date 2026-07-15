---
title: Task
description: DSL reference for the task collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `task`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `completed_at` | `datetime` | Completed At | — | — | no | no |
| `current_revision_id` | `uuid` | Current Revision | — | — | no | no |
| `dependency_blocked` | `boolean` | Dependency Blocked | — | — | no | no |
| `due_date` | `date` | Due Date | — | — | no | no |
| `due_soon_notified_at` | `datetime` | Due Soon Notified At | — | — | no | no |
| `parent` | `relation` | Parent Task | many-to-one | — | no | no |
| `priority` | `relation` | Priority | many-to-one | — | no | no |
| `start_date` | `date` | Start Date | — | — | no | no |
| `status` | `relation` | Status | many-to-one | — | no | no |
| `title` | `text` | Title | — | — | yes | no |
