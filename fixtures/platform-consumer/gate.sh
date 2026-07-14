#!/usr/bin/env bash
set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$FIXTURE_DIR/../.." && pwd)"
PLATFORM_DIST="$REPO_ROOT/packages/platform/dist"
MIGRATIONS="$FIXTURE_DIR/supabase/migrations"
DB_URL="postgresql://postgres:postgres@127.0.0.1:64422/postgres"

cleanup() {
  supabase stop --project-id movp-c6a-consumer --no-backup >/dev/null 2>&1 ||
    echo "gate: warning: could not stop isolated movp-c6a-consumer stack" >&2
}
trap cleanup EXIT

platform_digest() {
  psql "$DB_URL" -tAqc "
    with c as (
      select string_agg(name||'|'||label||'|'||label_plural||'|'||workspace_scoped||'|'||layer, ',' order by name) t
      from public.movp_collections where layer = 'platform'
    ), f as (
      select string_agg(collection_name||'.'||name||'|'||type||'|'||coalesce(cardinality,'')||'|'||layer, ',' order by collection_name, name) t
      from public.movp_fields where layer = 'platform'
    )
    select md5(coalesce((select t from c),'')||'::'||coalesce((select t from f),''));"
}

pnpm --filter @movp/platform build
node --input-type=module -e "import { verifyPlatformArtifact } from '$PLATFORM_DIST/index.js'; verifyPlatformArtifact('$PLATFORM_DIST'); console.log('artifact ok')" || {
  echo "gate: verifyPlatformArtifact failed" >&2
  exit 1
}

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
