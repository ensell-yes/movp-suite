---
title: Experiment
description: DSL reference for the experiment collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `experiment`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `ends_at` | `datetime` | Ends At | — | — | no | no |
| `key` | `text` | Key | — | dimension | no | no |
| `name` | `text` | Name | — | — | no | no |
| `starts_at` | `datetime` | Starts At | — | — | no | no |
| `status` | `enum` | Status | — | dimension | no | no |
| `target_content_item` | `relation` | Target Content Item | many-to-one | — | no | no |
