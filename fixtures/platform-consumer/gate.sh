#!/usr/bin/env bash
set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$FIXTURE_DIR/../.." && pwd)"
PLATFORM_DIST="$REPO_ROOT/packages/platform/dist"
MIGRATIONS="$FIXTURE_DIR/supabase/migrations"
DB_URL="postgresql://postgres:postgres@127.0.0.1:64422/postgres"
PLATFORM_COLLECTIONS=''
PLATFORM_FIELDS=''

cleanup() {
  supabase stop --project-id movp-c6a-consumer --no-backup >/dev/null 2>&1 ||
    echo "gate: warning: could not stop isolated movp-c6a-consumer stack" >&2
}
trap cleanup EXIT

platform_digest() {
  local expected_collections="${1:-$PLATFORM_COLLECTIONS}"
  local expected_fields="${2:-$PLATFORM_FIELDS}"
  local projection
  local collection_count
  local field_count
  local digest

  projection="$(psql "$DB_URL" -tAqc "
    with c as (
      select count(*) n,
        string_agg(name||'|'||label||'|'||label_plural||'|'||workspace_scoped||'|'||layer, ',' order by name) t
      from public.movp_collections where layer = 'platform'
    ), f as (
      select count(*) n,
        string_agg(collection_name||'.'||name||'|'||type||'|'||coalesce(cardinality,'')||'|'||layer, ',' order by collection_name, name) t
      from public.movp_fields where layer = 'platform'
    )
    select c.n||'|'||f.n||'|'||md5(c.t||'::'||f.t) from c cross join f;")"
  IFS='|' read -r collection_count field_count digest <<<"$projection"

  if [[ ! "$collection_count" =~ ^[0-9]+$ ]] || [[ ! "$field_count" =~ ^[0-9]+$ ]]; then
    echo "gate: platform metadata counts are missing or malformed" >&2
    return 1
  fi
  if [[ ! "$digest" =~ ^[0-9a-f]{32}$ ]]; then
    echo "gate: platform metadata digest is missing or malformed" >&2
    return 1
  fi
  if [ "$collection_count" -ne "$expected_collections" ] || [ "$field_count" -ne "$expected_fields" ]; then
    echo "gate: platform metadata count mismatch: expected collections=$expected_collections fields=$expected_fields; got collections=$collection_count fields=$field_count" >&2
    return 1
  fi
  printf '%s\n' "$digest"
}

pnpm --filter @movp/platform build
EXPECTED_COUNTS="$(node --input-type=module -e "import { verifyPlatformArtifact } from '$PLATFORM_DIST/index.js'; const manifest = verifyPlatformArtifact('$PLATFORM_DIST'); process.stdout.write(manifest.metadata.collections + '|' + manifest.metadata.fields)")" || {
  echo "gate: verifyPlatformArtifact failed" >&2
  exit 1
}
IFS='|' read -r PLATFORM_COLLECTIONS PLATFORM_FIELDS <<<"$EXPECTED_COUNTS"
if [[ ! "$PLATFORM_COLLECTIONS" =~ ^[1-9][0-9]*$ ]] || [[ ! "$PLATFORM_FIELDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "gate: verified artifact returned malformed metadata counts" >&2
  exit 1
fi
echo "artifact ok: platform metadata collections=$PLATFORM_COLLECTIONS fields=$PLATFORM_FIELDS"

rm -rf -- "$MIGRATIONS"
mkdir -p "$MIGRATIONS"
cp "$PLATFORM_DIST/migrations/"*.sql "$MIGRATIONS/"

if grep -rEl '\.\./|/Code/supasuite|packages/[a-z]' "$MIGRATIONS" >/dev/null; then
  echo "gate: source-repo path found in fixture migrations" >&2
  exit 1
fi

(cd "$FIXTURE_DIR" && supabase start)
(cd "$FIXTURE_DIR" && supabase db reset)
DIGEST_BASE="$(platform_digest)"
echo "platform digest (no extension): $DIGEST_BASE"

if platform_digest "$((PLATFORM_COLLECTIONS + 1))" "$PLATFORM_FIELDS" >/dev/null 2>&1; then
  echo "gate: platform metadata count sabotage unexpectedly passed" >&2
  exit 1
fi

cp "$FIXTURE_DIR/extension/"*.sql "$MIGRATIONS/"
(cd "$FIXTURE_DIR" && supabase db reset)
DIGEST_EXT="$(platform_digest)"
echo "platform digest (with extension): $DIGEST_EXT"

PROJECT_COUNT="$(psql "$DB_URL" -tAqc "select count(*) from public.movp_collections where layer='project' and name='contact';")"
if [ "$PROJECT_COUNT" != "1" ]; then
  echo "gate: expected exactly one project collection 'contact', got $PROJECT_COUNT" >&2
  exit 1
fi

if [ "$DIGEST_BASE" != "$DIGEST_EXT" ]; then
  echo "gate: platform metadata digest changed after adding the extension" >&2
  exit 1
fi

echo "gate: platform-consumer fixture PASS"
