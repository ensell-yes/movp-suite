---
title: Content SEO
description: DSL reference for the content_seo collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->

**Collection name:** `content_seo`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `checklist` | `json` | Checklist | — | — | no | no |
| `content_item` | `relation` | Content Item | many-to-one | — | no | no |
| `jsonld` | `json` | JSON-LD | — | — | no | no |
| `meta` | `json` | Meta | — | — | no | no |
| `score` | `number` | Score | — | measure | no | no |
