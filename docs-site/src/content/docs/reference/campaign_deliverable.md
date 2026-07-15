---
title: Campaign Deliverable
description: DSL reference for the campaign_deliverable collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `campaign_deliverable`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `campaign` | `relation` | Campaign | many-to-one | — | no | no |
| `channel` | `relation` | Channel | many-to-one | — | no | no |
| `deliverable_type` | `enum` | Deliverable Type | — | dimension | no | no |
| `name` | `text` | Name | — | — | yes | no |
