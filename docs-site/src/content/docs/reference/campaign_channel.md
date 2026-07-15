---
title: Campaign Channel
description: DSL reference for the campaign_channel collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `campaign_channel`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `campaign` | `relation` | Campaign | many-to-one | — | no | no |
| `channel_type` | `enum` | Channel Type | — | dimension | no | no |
| `name` | `text` | Name | — | — | no | no |
