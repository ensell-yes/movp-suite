---
title: Segment Snapshot
description: DSL reference for the segment_snapshot collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `segment_snapshot`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `member_count` | `number` | Member Count | — | measure | no | no |
| `reason` | `enum` | Reason | — | dimension | no | no |
| `rule_version_set` | `json` | Rule Version Set | — | — | no | no |
| `segment` | `relation` | Segment | many-to-one | — | no | no |
| `taken_at` | `datetime` | Taken At | — | — | no | no |
