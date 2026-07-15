---
title: Content Item
description: DSL reference for the content_item collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `content_item`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `approved_revision_id` | `uuid` | Approved Revision | — | — | no | no |
| `content_type` | `relation` | Content Type | many-to-one | — | no | no |
| `current_revision_id` | `uuid` | Current Revision | — | — | no | no |
| `published_at` | `datetime` | Published At | — | — | no | no |
| `published_revision_id` | `uuid` | Published Revision | — | — | no | no |
| `search_body` | `richText` | Search Body | — | — | yes | yes |
| `search_text` | `text` | Search Text | — | — | yes | no |
| `slug` | `text` | Slug | — | — | no | no |
| `status` | `enum` | Status | — | dimension | no | no |
