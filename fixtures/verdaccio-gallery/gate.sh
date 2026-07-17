#!/usr/bin/env bash
set -euo pipefail

TEMPLATE="${1:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGISTRY="http://127.0.0.1:4873"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/movp-gallery-${TEMPLATE:-unknown}.XXXXXX")"
WS="33333333-3333-3333-3333-333333333333"
PROJECT="gallery-${TEMPLATE:-unknown}"

case "$TEMPLATE" in
  crm-lite)
    DB_PORT=64522; GQL_FIELD=companies; MCP_TOOL=company.list; PROJECT_COLLECTION_COUNT=3 ;;
  marketing-site)
    DB_PORT=64622; GQL_FIELD=authors; MCP_TOOL=author.list; PROJECT_COLLECTION_COUNT=2 ;;
  support-desk)
    DB_PORT=64722; GQL_FIELD=support_tickets; MCP_TOOL=support_ticket.list; PROJECT_COLLECTION_COUNT=2 ;;
  knowledge-base)
    DB_PORT=64822; GQL_FIELD=kb_articles; MCP_TOOL=kb_article.list; PROJECT_COLLECTION_COUNT=2 ;;
  *) echo "usage: gate.sh <crm-lite|marketing-site|support-desk|knowledge-base>" >&2; exit 2 ;;
esac
DB_URL="postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres"

cleanup() {
  status=$?
  trap - EXIT
  if [ -n "${FN_PID:-}" ]; then kill "$FN_PID" 2>/dev/null || true; wait "$FN_PID" 2>/dev/null || true; fi
  if [ -n "${VERDACCIO_PID:-}" ]; then kill "$VERDACCIO_PID" 2>/dev/null || true; wait "$VERDACCIO_PID" 2>/dev/null || true; fi
  (cd "$WORK/$PROJECT" 2>/dev/null && supabase stop --no-backup >/dev/null 2>&1) || true
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

graphql_post() {
  payload="$1"
  for attempt in 1 2 3; do
    if curl -sS --connect-timeout 2 --max-time 20 "$API_URL/functions/v1/graphql" \
      -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
      -H 'content-type: application/json' -d "$payload"; then
      return 0
    fi
    sleep "$attempt"
  done
  return 1
}

mcp_post() {
  payload="$1"
  for attempt in 1 2 3; do
    if curl -sS --connect-timeout 2 --max-time 60 "$API_URL/functions/v1/mcp" \
      -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
      -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
      -d "$payload"; then
      return 0
    fi
    sleep "$attempt"
  done
  return 1
}

auth_admin_post() {
  for attempt in 1 2 3; do
    if curl -sS --connect-timeout 2 --max-time 10 "$API_URL/auth/v1/admin/users" \
      -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
      -H 'content-type: application/json' \
      -d '{"email":"gallery@example.test","password":"Passw0rd!1","email_confirm":true}' >/dev/null; then
      return 0
    fi
    sleep "$attempt"
  done
  return 1
}

auth_token_post() {
  for attempt in 1 2 3; do
    if curl -sS --connect-timeout 2 --max-time 10 "$API_URL/auth/v1/token?grant_type=password" \
      -H "apikey: $ANON_KEY" -H 'content-type: application/json' \
      -d '{"email":"gallery@example.test","password":"Passw0rd!1"}'; then
      return 0
    fi
    sleep "$attempt"
  done
  return 1
}

PACK_DIR="${ARTIFACTS_DIR:-$WORK/artifacts}"
if [ -z "${ARTIFACTS_DIR:-}" ]; then
  mkdir -p "$PACK_DIR"
  # pack.sh snapshots the source before and after guarded staging via scripts/tree-snapshot.mjs.
  # Keep that invariant in one producer; this consumer must not duplicate or weaken it.
  bash "$REPO_ROOT/fixtures/verdaccio-gallery/pack.sh" "$PACK_DIR"
fi
ls "$PACK_DIR"/*.tgz >/dev/null 2>&1 || { echo "no tarballs in $PACK_DIR" >&2; exit 1; }

if curl -sf --connect-timeout 1 --max-time 2 "$REGISTRY/-/ping" >/dev/null 2>&1; then
  echo "Verdaccio port 4873 is already in use; refusing to publish into an unrelated registry" >&2
  exit 1
fi

sed "s#__STORAGE__#$WORK/verdaccio-storage#" \
  "$REPO_ROOT/fixtures/verdaccio-crm-lite/verdaccio.yaml" >"$WORK/verdaccio.yaml"
node "$REPO_ROOT/node_modules/verdaccio/bin/verdaccio" --listen 0.0.0.0:4873 \
  -c "$WORK/verdaccio.yaml" >"$WORK/verdaccio.log" 2>&1 &
VERDACCIO_PID=$!
VERDACCIO_READY=0
for _ in $(seq 1 30); do
  curl -sf --connect-timeout 2 --max-time 5 "$REGISTRY/-/ping" >/dev/null 2>&1 && { VERDACCIO_READY=1; break; }
  sleep 1
done
if [ "$VERDACCIO_READY" != "1" ]; then
  echo "Verdaccio did not become ready" >&2
  tail -n 80 "$WORK/verdaccio.log" >&2
  exit 1
fi

export npm_config_registry="$REGISTRY"
export NPM_CONFIG_REGISTRY="$REGISTRY"
export NPM_CONFIG_USERCONFIG="$WORK/npmrc"
export npm_config_cache="$WORK/npm-cache"
export DENO_DIR="$WORK/deno-cache"
printf '//127.0.0.1:4873/:_authToken=fake-token\n' >"$NPM_CONFIG_USERCONFIG"
for tarball in "$PACK_DIR"/*.tgz; do
  npm publish "$tarball" --registry "$REGISTRY" >/dev/null 2>&1 || {
    echo "publish $(basename "$tarball") failed" >&2
    exit 1
  }
done

PLATFORM_CHECK="$WORK/platform-check"
npm install --prefix "$PLATFORM_CHECK" --registry "$REGISTRY" --ignore-scripts --no-package-lock \
  @movp/platform@0.1.1 >/dev/null
PLATFORM_DIST="$PLATFORM_CHECK/node_modules/@movp/platform/dist"
[ -f "$PLATFORM_DIST/index.js" ] || {
  echo "published @movp/platform artifact is missing dist/index.js" >&2
  exit 1
}

cd "$WORK"
printf '%s\n%s\n%s\n' "$TEMPLATE" "$PROJECT" "$WS" >"$WORK/scaffold-input"
npm --registry "$REGISTRY" create movp@0.1.1 <"$WORK/scaffold-input"
[ -d "$PROJECT" ] || { echo "scaffold did not create $PROJECT" >&2; exit 1; }
cd "$PROJECT"
echo "gallery gate [$TEMPLATE]: install"
npm install --registry "$REGISTRY"
if grep -REl '"(file:|workspace:|link:)' package.json package-lock.json >/dev/null 2>&1; then
  echo "scaffold contains a local dependency link" >&2
  exit 1
fi
if grep -Rq 'supasuite/packages' package-lock.json 2>/dev/null; then
  echo "scaffold lockfile references the monorepo" >&2
  exit 1
fi

echo "gallery gate [$TEMPLATE]: codegen and refusal"
npm run codegen
BASELINE="supabase/migrations/20260715000000_movp_generated.sql"
[ -f "$BASELINE" ] || { echo "project baseline missing" >&2; exit 1; }
BASELINE_BEFORE="$(shasum -a 256 "$BASELINE" | cut -d' ' -f1)"
CODEGEN_STATUS=0
CODEGEN_OUTPUT="$(npx movp codegen 2>&1)" || CODEGEN_STATUS=$?
if [ "$CODEGEN_STATUS" -eq 0 ]; then
  echo 'movp codegen must refuse in a scaffold' >&2
  exit 1
fi
printf '%s\n' "$CODEGEN_OUTPUT" | grep -qF 'project_codegen_use_project_bin' || {
  echo "movp codegen refusal lacks project_codegen_use_project_bin" >&2
  exit 1
}
[ "$BASELINE_BEFORE" = "$(shasum -a 256 "$BASELINE" | cut -d' ' -f1)" ] || {
  echo "movp codegen changed the project baseline" >&2
  exit 1
}
[ ! -e node_modules/supabase ] || { echo "movp codegen wrote under node_modules" >&2; exit 1; }

echo "gallery gate [$TEMPLATE]: start and reset"
STACK_STARTED=0
for attempt in 1 2 3; do
  if supabase start; then STACK_STARTED=1; break; fi
  sleep "$((attempt * 2))"
done
[ "$STACK_STARTED" = 1 ] || { echo "Supabase start failed after 3 attempts" >&2; exit 1; }
DB_RESET=0
for attempt in 1 2 3; do
  if supabase db reset; then DB_RESET=1; break; fi
  sleep "$((attempt * 2))"
done
[ "$DB_RESET" = 1 ] || { echo "Supabase reset failed after 3 attempts" >&2; exit 1; }

EXPECTED_COUNTS="$(node --input-type=module -e "import { verifyPlatformArtifact } from '$PLATFORM_DIST/index.js'; const m = verifyPlatformArtifact('$PLATFORM_DIST'); process.stdout.write(m.metadata.collections + '|' + m.metadata.fields)")"
IFS='|' read -r EXPECT_COLLECTIONS EXPECT_FIELDS <<<"$EXPECTED_COUNTS"
[[ "$EXPECT_COLLECTIONS" =~ ^[1-9][0-9]*$ && "$EXPECT_FIELDS" =~ ^[1-9][0-9]*$ ]] || {
  echo "platform artifact returned malformed metadata counts" >&2
  exit 1
}
GOT_COLLECTIONS="$(psql "$DB_URL" -tAqc "select count(*) from public.movp_collections where layer='platform';")"
GOT_FIELDS="$(psql "$DB_URL" -tAqc "select count(*) from public.movp_fields where layer='platform';")"
[ "$GOT_COLLECTIONS|$GOT_FIELDS" = "$EXPECT_COLLECTIONS|$EXPECT_FIELDS" ] || {
  echo "platform metadata mismatch: expected $EXPECTED_COUNTS, got $GOT_COLLECTIONS|$GOT_FIELDS" >&2
  exit 1
}
GOT_PROJECT="$(psql "$DB_URL" -tAqc "select count(*) from public.movp_collections where layer='project';")"
[ "$GOT_PROJECT" = "$PROJECT_COLLECTION_COUNT" ] || {
  echo "expected $PROJECT_COLLECTION_COUNT project collections, got $GOT_PROJECT" >&2
  exit 1
}

npm run movp -- verify-schema-runtime \
  --config movp.config.mjs \
  --deno-config supabase/functions/mcp/deno.json \
  --edge-schema ./supabase/functions/_shared/schema.ts \
  --deno-minimum-dependency-age 0 | grep -q '"ok":true' || {
    echo "verify-schema-runtime failed" >&2
    exit 1
  }
echo "gallery gate [$TEMPLATE]: runtime fingerprints match"

STACK_ENV=''
for _ in $(seq 1 20); do
  if STACK_ENV="$(supabase status -o env 2>"$WORK/status.log")" \
    && printf '%s\n' "$STACK_ENV" | grep -q '^API_URL=' \
    && printf '%s\n' "$STACK_ENV" | grep -q '^ANON_KEY=' \
    && printf '%s\n' "$STACK_ENV" | grep -q '^SERVICE_ROLE_KEY='; then
    break
  fi
  STACK_ENV=''
  sleep 1
done
if [ -z "$STACK_ENV" ]; then
  echo "Supabase API/auth environment did not become ready after 20 attempts" >&2
  exit 1
fi
eval "$(printf '%s\n' "$STACK_ENV" | sed 's/^\([A-Z_]*\)=/export \1=/')"
: "${API_URL:?}"; : "${ANON_KEY:?}"; : "${SERVICE_ROLE_KEY:?}"
auth_admin_post || { echo "failed to create gallery user after 3 transport attempts" >&2; exit 1; }
TOKEN="$(auth_token_post \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).access_token))')"
[ -n "$TOKEN" ] || { echo "failed to mint member token" >&2; exit 1; }
USER_ID="$(node -e 'const t=process.argv[1].split(".")[1];process.stdout.write(JSON.parse(Buffer.from(t,"base64url")).sub)' "$TOKEN")"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.workspace (id,name) values ('$WS','Gallery') on conflict do nothing;" \
  -c "insert into public.workspace_membership (workspace_id,user_id,role) values ('$WS','$USER_ID','owner') on conflict do nothing;"

printf 'MOVP_JWT_ISSUER=%s\nNPM_CONFIG_REGISTRY=http://host.docker.internal:4873\nNPM_CONFIG_MIN_RELEASE_AGE=0\n' \
  "$API_URL/auth/v1" >supabase/.env.local
supabase functions serve --env-file supabase/.env.local >"$WORK/functions.log" 2>&1 &
FN_PID=$!
GRAPHQL_READY=0
for _ in $(seq 1 60); do
  BODY="$(curl -sS --connect-timeout 2 --max-time 10 "$API_URL/functions/v1/graphql" \
    -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
    -H 'content-type: application/json' -d '{"query":"query{__typename}"}' || true)"
  printf '%s' "$BODY" | grep -q '"__typename"' && { GRAPHQL_READY=1; break; }
  sleep 1
done
if [ "$GRAPHQL_READY" != 1 ]; then
  echo "GraphQL did not become ready" >&2
  tail -n 120 "$WORK/functions.log" >&2
  exit 1
fi

FIELDS="$(graphql_post '{"query":"query{__type(name:\"Query\"){fields{name}}}"}')" || {
  echo "GraphQL schema probe failed after 3 transport attempts" >&2
  tail -n 120 "$WORK/functions.log" >&2
  exit 1
}
printf '%s' "$FIELDS" | grep -qF "\"$GQL_FIELD\"" || {
  echo "GraphQL Query is missing $GQL_FIELD" >&2
  exit 1
}
GQL="$(graphql_post "{\"query\":\"query{$GQL_FIELD(workspaceId:\\\"$WS\\\", first:5){items{id}}}\"}")" || {
  echo "GraphQL $GQL_FIELD probe failed after 3 transport attempts" >&2
  exit 1
}
printf '%s' "$GQL" | grep -q '"items"' || { echo "GraphQL $GQL_FIELD returned no items" >&2; exit 1; }
if printf '%s' "$GQL" | grep -q '"errors"'; then echo "GraphQL $GQL_FIELD errored" >&2; exit 1; fi

MCP_LIST="$(mcp_post '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')" || {
  echo "MCP tools/list failed after 3 transport attempts" >&2
  exit 1
}
printf '%s' "$MCP_LIST" | grep -qF "\"$MCP_TOOL\"" || {
  echo "MCP tools/list is missing $MCP_TOOL" >&2
  exit 1
}
MCP_CALL="$(mcp_post "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$MCP_TOOL\",\"arguments\":{\"workspaceId\":\"$WS\"}}}")" || {
  echo "MCP $MCP_TOOL failed after 3 transport attempts" >&2
  exit 1
}
if printf '%s' "$MCP_CALL" | grep -q '"error"'; then echo "MCP $MCP_TOOL errored" >&2; exit 1; fi

echo "gate: verdaccio-gallery ($TEMPLATE) acceptance PASS"
