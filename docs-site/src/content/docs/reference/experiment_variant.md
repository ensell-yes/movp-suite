---
title: Experiment Variant
description: DSL reference for the experiment_variant collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `experiment_variant`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `active` | `boolean` | Active | — | dimension | no | no |
| `content_item` | `relation` | Content Item | many-to-one | — | no | no |
| `experiment` | `relation` | Experiment | many-to-one | — | no | no |
| `key` | `text` | Key | — | dimension | no | no |
| `position` | `number` | Position | — | — | no | no |
| `traffic_basis_points` | `number` | Traffic Basis Points | — | measure | no | no |
