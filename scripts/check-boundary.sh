#!/usr/bin/env bash
set -euo pipefail

ROOT="${MOVP_BOUNDARY_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PATTERN='@movp/(auth|domain)|service_role|SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE'

violation=0
while IFS= read -r -d '' file; do
  if grep -nHE "$PATTERN" "$file"; then
    violation=1
  fi
done < <(
  find "$ROOT/templates" -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.astro' -o -name '*.mjs' -o -name '*.js' -o -name '*.json' \) \
    ! -path '*/supabase/functions/*' -print0
)

if [[ "$violation" -ne 0 ]]; then
  echo "BOUNDARY VIOLATION: forbidden import or service-role token reference found under templates/" >&2
  exit 1
fi

echo "boundary: clean"
