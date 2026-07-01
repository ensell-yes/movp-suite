#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATTERN='@movp/(auth|domain)|service_role|SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE'

if grep -rnE --include='*.ts' --include='*.tsx' --include='*.astro' --include='*.mjs' \
     --include='*.js' --include='*.json' "$PATTERN" "$ROOT/templates" ; then
  echo "BOUNDARY VIOLATION: forbidden import or service-role token reference found under templates/" >&2
  exit 1
fi

echo "boundary: clean"
