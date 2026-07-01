#!/usr/bin/env bash
# End-to-end Phase-1 Verification items 1-10 against the local stack.
# Assumes `supabase start` has already run. Item 11 is the frontend-ux CI job.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SUPABASE_ARGS=()
if [ -n "${SUPABASE_WORKDIR:-}" ]; then
  SUPABASE_ARGS+=(--workdir "$SUPABASE_WORKDIR")
fi

supabase_local() {
  if [ ${#SUPABASE_ARGS[@]} -eq 0 ]; then
    supabase "$@"
  else
    supabase "$@" "${SUPABASE_ARGS[@]}"
  fi
}

json_get() {
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const p=process.argv[1].split(".");let v=JSON.parse(d);for (const k of p) v=v?.[k]; if (v == null) process.exit(1); process.stdout.write(String(v));})' "$1"
}

post_graphql() {
  local body="$1"
  curl -sS "$API_URL/functions/v1/graphql" \
    -H "Authorization: Bearer $TOKEN" \
    -H "apikey: $ANON_KEY" \
    -H "content-type: application/json" \
    -d "$body"
}

restart_project_kong() {
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  local project_id
  project_id="$(awk -F'"' '/^project_id =/ {print $2; exit}' supabase/config.toml)"
  project_id="${project_id:-$(basename "$ROOT")}"
  docker restart "supabase_kong_${project_id}" >/dev/null 2>&1 || true
  sleep 2
}

echo "== [1] migrate + drift gate =="
supabase_local db reset
drift="$(supabase_local db diff || true)"
if [ -n "$drift" ] && ! printf '%s\n' "$drift" | grep -q 'No schema changes found'; then
  if printf '%s\n' "$drift" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.exit(j.diff === "" ? 0 : 1)}catch{process.exit(1)}})'; then
    drift=""
  else
  echo "DRIFT:"
  echo "$drift"
  exit 1
  fi
fi

echo "== [3-7,9-10] package suites =="
pnpm install --frozen-lockfile
pnpm test
pnpm test:graphql-shape
pnpm test:jobs
pnpm test:redaction

echo "== [2,8] tenancy + RLS + internal-access =="
supabase_local db reset
supabase_local test db

echo "== static gates: boundary + definer-audit =="
bash scripts/check-boundary.sh
node scripts/check-definer-audit.mjs

echo "== load local env =="
eval "$(supabase_local status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
: "${API_URL:?}"
: "${ANON_KEY:?}"
: "${SERVICE_ROLE_KEY:?}"
: "${DB_URL:?}"

echo "== [7,8] vector-scale plan-shape + cross-tenant =="
VS_DB_URL="$DB_URL" node scripts/check-vector-scale.mjs

restart_project_kong

echo "== mint a real member JWT via gotrue =="
curl -sS "$API_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"email":"e2e@example.com","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN="$(
  curl -sS "$API_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" \
    -H "content-type: application/json" \
    -d '{"email":"e2e@example.com","password":"Passw0rd!1"}' | json_get access_token
)"
[ -n "$TOKEN" ] || { echo "failed to mint token"; exit 1; }
USER_ID="$(node -e 'const t=process.argv[1].split(".")[1];process.stdout.write(JSON.parse(Buffer.from(t,"base64url")).sub)' "$TOKEN")"
WS="33333333-3333-3333-3333-333333333333"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.workspace (id,name) values ('$WS','E2E') on conflict do nothing;" \
  -c "insert into public.workspace_membership (workspace_id,user_id,role) values ('$WS','$USER_ID','owner') on conflict do nothing;"

echo "== serve edge functions =="
FN_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/movp-functions.XXXXXX")"
printf 'MOVP_JWT_ISSUER=%s\n' "$API_URL/auth/v1" >"$FN_ENV_FILE"
supabase_local functions serve graphql mcp index-embeddings --env-file "$FN_ENV_FILE" >/tmp/movp-functions.log 2>&1 &
FN_PID=$!
trap 'kill $FN_PID 2>/dev/null || true; rm -f "$FN_ENV_FILE"' EXIT
for _ in $(seq 1 60); do
  curl -sf "$API_URL/functions/v1/graphql" -X OPTIONS >/dev/null 2>&1 && break
  sleep 1
done

echo "== [3] GraphQL: create + query back =="
CREATE="$(post_graphql "{\"query\":\"mutation(\$i:NoteCreateInput!){createNote(input:\$i){id title}}\",\"variables\":{\"i\":{\"workspace_id\":\"$WS\",\"title\":\"E2E note\",\"body\":\"semantic lighthouse phrase for e2e verification\"}}}")"
echo "$CREATE" | grep -q 'E2E note' || { echo "create failed: $CREATE"; exit 1; }
LIST="$(post_graphql "{\"query\":\"query{notes(workspaceId:\\\"$WS\\\", first:20){items{id title}}}\"}")"
echo "$LIST" | grep -q 'E2E note' || { echo "list failed: $LIST"; exit 1; }

echo "== [7] GraphQL: semantic search is reachable through the edge surface =="
echo "warming gte-small if this is a fresh CI container"
for i in $(seq 1 6); do
  curl -sS --max-time 120 -X POST "$API_URL/functions/v1/index-embeddings" -H "content-type: application/json" >/tmp/index-embeddings.json || true
  node -e 'const fs=require("fs"); let j={}; try{j=JSON.parse(fs.readFileSync("/tmp/index-embeddings.json","utf8"))}catch{}; process.exit((j.processed||0) >= 1 ? 0 : 1)' && break
  sleep $((i * 2))
done
node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("/tmp/index-embeddings.json","utf8")); if ((j.processed||0) < 1) { console.error("index-embeddings did not process a job:", j); process.exit(1) }'
SEM="$(post_graphql "{\"query\":\"query{search(workspaceId:\\\"$WS\\\", query:\\\"semantic lighthouse\\\", mode:\\\"semantic\\\"){collection id title snippet score}}\"}")"
echo "$SEM" | grep -q 'E2E note' || { echo "semantic search failed: $SEM"; echo "index worker: $(cat /tmp/index-embeddings.json)"; exit 1; }

echo "== [3] GraphQL: over-complexity query is rejected =="
TOO_BIG_QUERY="$(node -e 'const fields = Array.from({ length: 1100 }, (_, i) => `n${i}: note(id: "00000000-0000-0000-0000-000000000000") { id }`).join(" "); process.stdout.write(`query { ${fields} }`)')"
DEEP="$(post_graphql "$(node -e 'process.stdout.write(JSON.stringify({query: process.argv[1]}))' "$TOO_BIG_QUERY")")"
echo "$DEEP" | grep -qiE 'depth|complexity|exceeds' || { echo "over-complexity NOT rejected: $DEEP"; exit 1; }

echo "== [6] auth fail-closed: a garbage token is rejected =="
BAD="$(curl -sS -o /tmp/bad-auth.json -w '%{http_code}' "$API_URL/functions/v1/graphql" \
  -H "Authorization: Bearer not.a.jwt" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -d "{\"query\":\"query{notes(workspaceId:\\\"$WS\\\", first:1){items{id}}}\"}")"
[ "$BAD" = "401" ] || { echo "expected auth rejection on bad token ($BAD): $(cat /tmp/bad-auth.json)"; exit 1; }

echo "== [4] MCP: tools/list shows generated tools =="
MCP="$(curl -sS "$API_URL/functions/v1/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
echo "$MCP" | grep -qi 'note' || { echo "MCP tools/list missing note tools: $MCP"; exit 1; }

echo "== [8] internal not exposed via PostgREST API =="
REST="$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/movp_jobs" -H "apikey: $ANON_KEY")"
[ "$REST" = "404" ] || [ "$REST" = "401" ] || { echo "movp_jobs reachable via REST ($REST)"; exit 1; }

echo "slice-e2e: PASS"
