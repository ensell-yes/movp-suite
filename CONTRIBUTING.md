# Contributing

MOVP uses an adversarial review workflow. Changes should be small, gated, and easy to
reproduce.

## Required Discipline

- Keep migrations forward-only after the freeze baseline in
  `supabase/.forward-only-migration-baseline`.
- Do not edit already-merged migrations. Add a new timestamped migration instead.
- Do not hand-edit generated artifacts.
- Preserve local Supabase port isolation unless you first prove a safe override strategy.
- Run the relevant package tests, typecheck, SQL tests, and slice gates before asking for
  review.
- Apply the eight-dimension review harness from `CLAUDE.md` when reviewing plans, code, or
  pull requests.

## Common Gates

```sh
pnpm test
pnpm typecheck
pnpm test:graphql-shape
pnpm test:jobs
pnpm test:redaction
pnpm test:event-catalog
pnpm test:forward-only-migrations
bash scripts/check-boundary.sh
node scripts/check-definer-audit.mjs
supabase test db
bash scripts/slice-e2e.sh
```

## Pull Requests

Each PR should state:

- what changed;
- which gates ran;
- any skipped gate and why;
- any residual risk.

Do not include secrets, production credentials, or raw PII in issues, PRs, logs, or test
fixtures.
