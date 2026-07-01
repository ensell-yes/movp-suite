#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== typecheck =="
pnpm typecheck

echo "== package tests =="
pnpm --filter @movp/auth test
pnpm --filter @movp/core-schema test
pnpm --filter @movp/codegen test
pnpm --filter @movp/graphql test
pnpm --filter @movp/mcp test
pnpm --filter @movp/obs test
pnpm --filter @movp/search test
pnpm --filter @movp/notifications test
pnpm --filter @movp/flows test
pnpm --filter @movp/frontend-astro test

echo "== static gates =="
bash scripts/check-boundary.sh
node scripts/check-definer-audit.mjs

echo "== supabase gates =="
supabase db reset
supabase test db
node scripts/check-vector-scale.mjs

echo "slice-e2e: PASS"
