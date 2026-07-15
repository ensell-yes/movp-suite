---
title: Segment Recompute Run
description: DSL reference for the segment_recompute_run collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `segment_recompute_run`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `added_count` | `number` | Added Count | — | measure | no | no |
| `evaluated_count` | `number` | Evaluated Count | — | measure | no | no |
| `finished_at` | `datetime` | Finished At | — | — | no | no |
| `idempotency_key` | `text` | Idempotency Key | — | — | no | no |
| `mode` | `text` | Mode | — | dimension | no | no |
| `outcome_code` | `text` | Outcome Code | — | — | no | no |
| `removed_count` | `number` | Removed Count | — | measure | no | no |
| `segment` | `relation` | Segment | many-to-one | — | no | no |
| `started_at` | `datetime` | Started At | — | — | no | no |
