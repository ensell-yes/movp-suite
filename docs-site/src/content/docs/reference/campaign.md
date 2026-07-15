---
title: Campaign
description: DSL reference for the campaign collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `campaign`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `brief` | `richText` | Brief | — | — | yes | yes |
| `end_date` | `date` | End Date | — | dimension | no | no |
| `goal_metrics` | `json` | Goal Metrics | — | — | no | no |
| `marketing_plan` | `relation` | Marketing Plan | many-to-one | — | no | no |
| `name` | `text` | Name | — | — | yes | no |
| `owner_id` | `uuid` | Owner | — | — | no | no |
| `priority` | `enum` | Priority | — | dimension | no | no |
| `rank` | `number` | Rank | — | dimension | no | no |
| `start_date` | `date` | Start Date | — | dimension | no | no |
| `status` | `enum` | Status | — | dimension | no | no |
