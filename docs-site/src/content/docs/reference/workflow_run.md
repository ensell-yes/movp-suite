---
title: Workflow Run
description: DSL reference for the workflow_run collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `workflow_run`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `action_type` | `text` | Action Type | — | dimension | no | no |
| `automation_rule` | `relation` | Automation Rule | many-to-one | dimension | no | no |
| `error_code` | `text` | Error Code | — | — | no | no |
| `event_type` | `text` | Event Type | — | dimension | no | no |
| `job_id` | `uuid` | Job ID | — | — | no | no |
| `matched` | `boolean` | Matched | — | — | no | no |
| `outcome` | `enum` | Outcome | — | dimension | no | no |
| `source_event_id` | `uuid` | Source Event ID | — | — | no | no |
| `trace_id` | `text` | Trace ID | — | — | no | no |
