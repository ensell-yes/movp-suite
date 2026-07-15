---
title: Content Approval
description: DSL reference for the content_approval collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `content_approval`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `approvals_required` | `number` | Approvals Required | — | — | no | no |
| `approved_content_hash` | `text` | Approved Content Hash | — | — | no | no |
| `approved_revision` | `relation` | Approved Revision | many-to-one | — | no | no |
| `content_item` | `relation` | Content Item | many-to-one | — | no | no |
| `decided_at` | `datetime` | Decided At | — | — | no | no |
| `decided_by` | `uuid` | Decided By | — | — | no | no |
| `policy` | `enum` | Policy | — | dimension | no | no |
| `state` | `enum` | State | — | dimension | no | no |
