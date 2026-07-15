---
title: Campaign Segment
description: DSL reference for the campaign_segment collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `campaign_segment`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `campaign` | `relation` | Campaign | many-to-one | — | no | no |
| `targeting_role` | `enum` | Targeting Role | — | dimension | no | no |
| `weight` | `number` | Weight | — | — | no | no |
