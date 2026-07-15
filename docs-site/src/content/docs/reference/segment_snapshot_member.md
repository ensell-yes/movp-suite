---
title: Segment Snapshot Member
description: DSL reference for the segment_snapshot_member collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `segment_snapshot_member`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `evidence` | `json` | Evidence | — | — | no | no |
| `matched_rule` | `relation` | Matched Rule | many-to-one | — | no | no |
| `snapshot` | `relation` | Snapshot | many-to-one | — | no | no |
| `subject_ref` | `text` | Subject Ref | — | — | no | no |
