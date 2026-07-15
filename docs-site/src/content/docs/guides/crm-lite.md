---
title: CRM-lite template
description: Contacts, companies, and deals with a segment and an automation.
---

The CRM-lite template (shipped by C6d) extends the platform with `contact`, `company`, and `deal`
collections, a saved segment, and an automation, plus a few Astro pages and seed data. Scaffold it:

```sh
npx create-movp
# choose: crm-lite
```

Your extension collections appear in the [Schema reference](/reference/) once you regenerate the
manifest. Add a collection, run `movp new-delta <name>` to allocate an immutable codegen delta, and
regenerate.
