---
title: Content Approval Vote
description: DSL reference for the content_approval_vote collection (generated — do not edit).
---

<!-- Generated from movp.schema.json by scripts/gen-dsl-reference. Do not edit by hand. -->

**Collection name:** `content_approval_vote`
**Layer:** platform
**Workspace-scoped:** yes
**Internal:** yes

## Fields

| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |
| --- | --- | --- | --- | --- | --- | --- |
| `approval` | `relation` | Approval | many-to-one | — | no | no |
| `vote` | `enum` | Vote | — | — | no | no |
| `voter_id` | `uuid` | Voter | — | — | no | no |
