---
title: Segment Membership
description: DSL reference for the segment_membership collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `segment_membership`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `evaluated_at` | `datetime` | Evaluated At | — | — | no | no |
| `evidence` | `json` | Evidence | — | — | no | no |
| `first_matched_at` | `datetime` | First Matched At | — | — | no | no |
| `matched_rule` | `relation` | Matched Rule | many-to-one | — | no | no |
| `segment` | `relation` | Segment | many-to-one | — | no | no |
| `subject_ref` | `text` | Subject Ref | — | — | no | no |
| `subject_type` | `text` | Subject Type | — | dimension | no | no |
