# Quickstart

This guide gets MOVP Suite running on a local Supabase stack with deterministic demo data.
The repository is pre-1.0 and intended for local development and review.

## Prerequisites

- Node.js 20 or newer
- pnpm 9.12.0
- Docker Desktop or a compatible Docker daemon
- Supabase CLI

## Install

```sh
git clone <your-fork-or-repo-url> movp-suite
cd movp-suite
pnpm install --frozen-lockfile
```

## Bootstrap

```sh
pnpm bootstrap
```

Bootstrap checks local prerequisites, starts Supabase, resets the database, runs
`pnpm seed:demo`, and prints local URLs. It is safe to rerun.

For CI-style execution without startup hints:

```sh
pnpm bootstrap -- --ci --skip-frontend
```

## Local Ports

Supabase ports are intentionally committed in the 64xxx range to avoid collisions with other
local Supabase projects on maintainer machines:

- API: `http://127.0.0.1:64321`
- DB: `postgresql://postgres:postgres@127.0.0.1:64322/postgres`
- Studio: `http://127.0.0.1:64323`
- Mailpit: `http://127.0.0.1:64324`

Do not normalize these to Supabase defaults without a documented per-user override strategy.
The contract is pinned by:

```sh
pnpm check:supabase-ports
```

## Demo Login

The demo seed creates a local-only `MOVP Demo` workspace and two confirmed users:

- `demo-owner@example.test`
- `demo-member@example.test`

Both use the local password `MovpDemo123!`. Do not use these credentials outside your local
stack.

The Astro template login page is `/login`. Supabase magic-link callbacks must redirect to
`/auth/callback` through `site_url` or `additional_redirect_urls`. The committed local
Supabase config allows the Astro dev URL (`http://127.0.0.1:4321/auth/callback`) and the
Playwright/Wrangler test URL (`http://127.0.0.1:8788/auth/callback`).

## Pages To Inspect

After bootstrap and frontend startup, inspect:

- `/` for notes
- `/tasks` and `/tasks/board`
- `/content`, `/content/approvals`, and `/content/calendar`
- `/campaigns`, `/campaigns/timeline`, and `/campaigns/calendar`
- `/segments`
- `/workflows/rules`, `/workflows/webhooks`, and `/workflows/runs`
- `/search`

Start the frontend when you are not using `--ci`:

```sh
pnpm --filter @movp/frontend-astro dev
```

Then open `http://127.0.0.1:4321/login`.

## Common Local Failures

- Docker storage healthcheck failures: restart Docker Desktop. Storage-backed CMS asset flows
  need storage enabled; DB-only gates may run storage-free only with a dated config comment.
- Orphan edge-runtime processes: if `slice-e2e` reports `BOOT_ERROR` or an invalid upstream
  response, stop stale function servers before debugging code.
- Port collisions: keep the committed 64xxx Supabase ports unless a documented override exists.
  The defaults may belong to other local projects.

## Gates

Useful local gates:

```sh
pnpm check:docs
pnpm check:quickstart-docs
pnpm check:packages
pnpm check:demo-seed
pnpm typecheck
pnpm test
pnpm test:forward-only-migrations
node scripts/check-definer-audit.mjs
node scripts/check-event-catalog.mjs
bash scripts/check-boundary.sh
bash scripts/slice-e2e.sh
```

Before publishing packages, the maintainer release environment must pass:

```sh
MOVP_RELEASE_PREFLIGHT=1 pnpm check:release-preflight
```

That command verifies `npm whoami` and `npm org ls movp` access. Use the unscoped org name for
the npm org check.
