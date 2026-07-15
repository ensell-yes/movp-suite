---
title: Campaign Calendar Event
description: DSL reference for the campaign_calendar_event collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `campaign_calendar_event`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** no

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `campaign` | `relation` | Campaign | many-to-one | — | no | no |
| `event_date` | `date` | Event Date | — | dimension | no | no |
| `event_type` | `enum` | Event Type | — | dimension | no | no |
| `title` | `text` | Title | — | — | yes | no |
