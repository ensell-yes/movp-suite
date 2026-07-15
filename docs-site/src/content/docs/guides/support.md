---
title: Support desk template
description: Tickets-as-tasks, SLA automation, and an operator inbox.
---

The Support template adds `support_ticket` and `sla_policy` project collections. Each ticket
links to a platform task for status, priority, assignment, and due-date behavior; `due_soon`
automation supports SLA workflows and the Astro frontend provides the inbox. Scaffold it:

```sh
npx create-movp
# choose: support-desk
```

Edit the project schema, run `npm run codegen`, then reset the local database to apply the
additive generated migration.
