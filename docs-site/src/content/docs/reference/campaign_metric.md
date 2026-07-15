---
title: Campaign Metric
description: DSL reference for the campaign_metric collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `campaign_metric`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `campaign` | `relation` | Campaign | many-to-one | — | no | no |
| `channel` | `relation` | Channel | many-to-one | — | no | no |
| `deliverable` | `relation` | Deliverable | many-to-one | — | no | no |
| `measured_at` | `date` | Measured At | — | dimension | no | no |
| `metric_key` | `text` | Metric Key | — | dimension | no | no |
| `unit` | `text` | Unit | — | dimension | no | no |
| `value` | `number` | Value | — | measure | no | no |
