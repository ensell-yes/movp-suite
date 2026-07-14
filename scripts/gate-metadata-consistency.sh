#!/usr/bin/env bash
set -euo pipefail

DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:64322/postgres}"

pnpm exec tsx scripts/check-metadata-consistency.ts

count="$(psql "$DB_URL" -tAX -c 'select count(*) from public.movp_fields;')"
if [ "$count" -eq 0 ]; then
  echo 'GATE FAILED: no movp_fields rows after reset' >&2
  exit 1
fi

target="$(psql "$DB_URL" -tAX -F '|' -c \
  'select collection_name, name from public.movp_fields order by collection_name, name limit 1;')"
IFS='|' read -r target_collection target_field <<<"$target"
if [[ ! "$target_collection" =~ ^[a-z][a-z0-9_]*$ ]] || [[ ! "$target_field" =~ ^[a-z][a-z0-9_]*$ ]]; then
  echo 'GATE FAILED: selected metadata key is not a valid identifier' >&2
  exit 1
fi

restore_metadata() {
  psql "$DB_URL" -v ON_ERROR_STOP=1 -c \
    "update public.movp_fields
       set label = left(label, length(label) - length(' (drift)'))
     where collection_name = '$target_collection'
       and name = '$target_field'
       and right(label, length(' (drift)')) = ' (drift)';" >/dev/null
}
trap restore_metadata EXIT

psql "$DB_URL" -v ON_ERROR_STOP=1 -c \
  "update public.movp_fields set label = label || ' (drift)'
   where collection_name = '$target_collection' and name = '$target_field';"

set +e
out="$(pnpm exec tsx scripts/check-metadata-consistency.ts 2>&1)"
code=$?
set -e
printf '%s\n' "$out"

if [ "$code" -eq 0 ]; then
  echo 'GATE FAILED: mutated metadata returned exit 0' >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -q 'altered_metadata_row'; then
  echo 'GATE FAILED: expected altered_metadata_row' >&2
  exit 1
fi
restore_metadata
trap - EXIT
echo "metadata-consistency gate: OK (clean passes; drift fails with exit $code)"
