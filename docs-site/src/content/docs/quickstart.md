---
title: Quickstart
description: Scaffold and boot a MOVP project.
---

## Scaffold

```sh
npx create-movp
```

Pick a template (CRM-lite, Marketing, Support, or Knowledge base) and a project name. The scaffolder
copies the template, materializes the immutable platform migration bundle, runs project codegen for
your extension collections, and prints bootstrap steps.

## Boot the local stack

```sh
pnpm install
pnpm bootstrap
```

`pnpm bootstrap` starts the port-isolated local Supabase stack. This repo uses the local Postgres
port **64322** (and sibling ports) to stay isolated from other local Supabase projects — do not
revert to the Supabase defaults.

## Connect an agent

Agent connectivity defaults to the hosted MCP endpoint. See
[Agent connectivity](/agents/connectivity/).
