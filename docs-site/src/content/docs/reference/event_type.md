---
title: Event Type
description: DSL reference for the event_type collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `event_type`
**Layer:** platform
**Workspace-scoped:** no
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `active` | `boolean` | Active | — | — | no | no |
| `description` | `text` | Description | — | — | yes | no |
| `domain` | `enum` | Domain | — | dimension | no | no |
| `key` | `text` | Key | — | dimension | no | no |
| `label` | `text` | Label | — | — | no | no |
| `payload_schema` | `json` | Payload Schema | — | — | no | no |
| `schema_version` | `number` | Schema Version | — | — | no | no |
