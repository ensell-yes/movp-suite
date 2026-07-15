---
title: Automation Rule
description: DSL reference for the automation_rule collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `automation_rule`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `action_config` | `json` | Action Config | — | — | no | no |
| `action_type` | `enum` | Action Type | — | dimension | no | no |
| `condition` | `json` | Condition | — | — | no | no |
| `enabled` | `boolean` | Enabled | — | — | no | no |
| `priority` | `number` | Priority | — | — | no | no |
| `trigger_event_type` | `relation` | Trigger Event Type | many-to-one | — | no | no |
