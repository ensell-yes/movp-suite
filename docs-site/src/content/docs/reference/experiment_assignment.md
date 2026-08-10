---
title: Experiment Assignment
description: DSL reference for the experiment_assignment collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `experiment_assignment`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `assignment_key_hash` | `text` | Assignment Key Hash | — | — | no | no |
| `experiment` | `relation` | Experiment | many-to-one | — | no | no |
| `exposure_count` | `number` | Exposure Count | — | measure | no | no |
| `last_seen_at` | `datetime` | Last Seen At | — | — | no | no |
| `variant` | `relation` | Variant | many-to-one | — | no | no |
