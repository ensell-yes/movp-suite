---
title: Marketing Plan
description: DSL reference for the marketing_plan collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `marketing_plan`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `description` | `richText` | Description | — | — | yes | no |
| `goals` | `json` | Goals | — | — | no | no |
| `name` | `text` | Name | — | — | yes | no |
| `owner_id` | `uuid` | Owner | — | — | no | no |
| `period_end` | `date` | Period End | — | dimension | no | no |
| `period_start` | `date` | Period Start | — | dimension | no | no |
| `status` | `enum` | Status | — | dimension | no | no |
