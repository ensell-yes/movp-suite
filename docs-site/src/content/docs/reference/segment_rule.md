---
title: Segment Rule
description: DSL reference for the segment_rule collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `segment_rule`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `active` | `boolean` | Active | — | dimension | no | no |
| `description` | `text` | Description | — | — | no | no |
| `predicate` | `json` | Predicate | — | — | no | no |
| `segment` | `relation` | Segment | many-to-one | — | no | no |
| `version` | `number` | Version | — | — | no | no |
