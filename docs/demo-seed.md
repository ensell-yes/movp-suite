# Demo Seed

`pnpm seed:demo` creates a local-only `MOVP Demo` workspace with two confirmed users:

- `demo-owner@example.test`
- `demo-member@example.test`

Both use the local password `MovpDemo123!`. Do not use these credentials outside a local
Supabase stack. The seed is idempotent and safe to run repeatedly after `supabase db reset`.
