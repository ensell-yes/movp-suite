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
supabase_local functions serve graphql mcp index-embeddings flows --env-file "$FN_ENV_FILE" >/tmp/movp-functions.log 2>&1 &
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

echo "== [collab] define a token-scoped GraphQL helper + a 2nd member =="
post_graphql_as() {
  curl -sS "$API_URL/functions/v1/graphql" \
    -H "Authorization: Bearer $1" \
    -H "apikey: $ANON_KEY" \
    -H "content-type: application/json" \
    -d "$2"
}
curl -sS "$API_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"email":"e2e-collab2@example.com","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN2="$(
  curl -sS "$API_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" -H "content-type: application/json" \
    -d '{"email":"e2e-collab2@example.com","password":"Passw0rd!1"}' | json_get access_token
)"
[ -n "$TOKEN2" ] || { echo "failed to mint 2nd token"; exit 1; }
USER2_ID="$(node -e 'const t=process.argv[1].split(".")[1];process.stdout.write(JSON.parse(Buffer.from(t,"base64url")).sub)' "$TOKEN2")"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.workspace_membership (workspace_id,user_id,role) values ('$WS','$USER2_ID','member') on conflict do nothing;"

echo "== [collab] create a note, add a comment mentioning the 2nd user =="
NOTE="$(post_graphql "{\"query\":\"mutation(\$i:NoteCreateInput!){createNote(input:\$i){id}}\",\"variables\":{\"i\":{\"workspace_id\":\"$WS\",\"title\":\"Collab note\",\"body\":\"collab body\"}}}")"
NOTE_ID="$(echo "$NOTE" | json_get data.createNote.id)"
[ -n "$NOTE_ID" ] || { echo "collab note create failed: $NOTE"; exit 1; }
ADD="$(post_graphql "{\"query\":\"mutation{addComment(entityType:\\\"note\\\", entityId:\\\"$NOTE_ID\\\", body:\\\"welcome\\\", mentions:[\\\"$USER2_ID\\\"]){id entity_id}}\"}")"
echo "$ADD" | grep -q "$NOTE_ID" || { echo "addComment failed: $ADD"; exit 1; }

echo "== [collab] mentioned user sees it in inbox(mentions) =="
INBOX="$(post_graphql_as "$TOKEN2" "{\"query\":\"query{inbox(workspaceId:\\\"$WS\\\", tab:\\\"mentions\\\"){kind entity_id}}\"}")"
echo "$INBOX" | grep -q "$NOTE_ID" || { echo "inbox mentions missing note: $INBOX"; exit 1; }

echo "== [collab] toggle a reaction and a save =="
post_graphql "{\"query\":\"mutation{toggleReaction(entityType:\\\"note\\\", entityId:\\\"$NOTE_ID\\\", kind:\\\"like\\\", on:true)}\"}" | grep -q 'true' || { echo "toggleReaction failed"; exit 1; }
post_graphql "{\"query\":\"mutation{toggleSave(entityType:\\\"note\\\", entityId:\\\"$NOTE_ID\\\", on:true)}\"}" | grep -q 'true' || { echo "toggleSave failed"; exit 1; }

echo "== [collab] create + resolve a share link =="
SHARE="$(post_graphql "{\"query\":\"mutation{createShareLink(entityType:\\\"note\\\", entityId:\\\"$NOTE_ID\\\"){token}}\"}")"
SHARE_TOKEN="$(echo "$SHARE" | json_get data.createShareLink.token)"
[ -n "$SHARE_TOKEN" ] || { echo "createShareLink failed: $SHARE"; exit 1; }
RES="$(post_graphql "{\"query\":\"mutation{resolveShareLink(token:\\\"$SHARE_TOKEN\\\"){entity_id workspace_id}}\"}")"
echo "$RES" | grep -q "$NOTE_ID" || { echo "resolveShareLink failed: $RES"; exit 1; }

echo "== [collab] a user.mentioned notify job carries recipient_user_id =="
MENTION_JOBS="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_jobs where kind='notify' and payload->>'event'='user.mentioned' and payload ? 'recipient_user_id';")"
[ "$(echo "$MENTION_JOBS" | tr -d '[:space:]')" -ge 1 ] || { echo "no user.mentioned notify job with recipient_user_id (got $MENTION_JOBS)"; exit 1; }

echo "== [task] create a task (workspace defaults applied) =="
TASK="$(post_graphql "{\"query\":\"mutation{createTask(workspaceId:\\\"$WS\\\", title:\\\"E2E task\\\"){id status_id current_revision_id}}\"}")"
TASK_ID="$(echo "$TASK" | json_get data.createTask.id)"
[ -n "$TASK_ID" ] || { echo "createTask failed: $TASK"; exit 1; }

echo "== [task] assign USER2 -> a task.assigned notify job carries recipient_user_id =="
post_graphql "{\"query\":\"mutation{assignTask(taskId:\\\"$TASK_ID\\\", userId:\\\"$USER2_ID\\\")}\"}" >/dev/null
ASSIGN_JOBS="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_jobs where kind='notify' and payload->>'event'='task.assigned' and payload->>'recipient_user_id'='$USER2_ID';")"
[ "$(echo "$ASSIGN_JOBS" | tr -d '[:space:]')" -ge 1 ] || { echo "no task.assigned notify for USER2 (got $ASSIGN_JOBS)"; exit 1; }

echo "== [task] inbox Assigned lists the task for USER2 (queried AS USER2) =="
INBOX="$(curl -sS "$API_URL/functions/v1/graphql" \
  -H "Authorization: Bearer $TOKEN2" -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d "{\"query\":\"query{inbox(workspaceId:\\\"$WS\\\", tab:\\\"assigned\\\"){entity_id}}\"}")"
echo "$INBOX" | grep -q "$TASK_ID" || { echo "inbox assigned did not include the task: $INBOX"; exit 1; }

echo "== [task] transition to a done-category status -> completed_at + history + task.completed =="
DONE_ID="$(psql "$DB_URL" -tAc "select id from public.task_status_option where workspace_id='$WS' and category='done' limit 1;" | tr -d '[:space:]')"
[ -n "$DONE_ID" ] || { echo "no done-category status option seeded for WS"; exit 1; }
post_graphql "{\"query\":\"mutation{transitionTask(taskId:\\\"$TASK_ID\\\", statusId:\\\"$DONE_ID\\\"){id completed_at}}\"}" | grep -q 'completed_at' || { echo "transition failed"; exit 1; }
HIST="$(psql "$DB_URL" -tAc "select count(*) from public.task_status_history where task_id='$TASK_ID';")"
[ "$(echo "$HIST" | tr -d '[:space:]')" -ge 1 ] || { echo "no task_status_history row (got $HIST)"; exit 1; }
COMPLETED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='task.completed' and payload->>'entity_id'='$TASK_ID';")"
[ "$(echo "$COMPLETED" | tr -d '[:space:]')" -ge 1 ] || { echo "no task.completed event (got $COMPLETED)"; exit 1; }

echo "== [content] helper + a non-member (USER3) for the authz checks =="
type post_graphql_as >/dev/null 2>&1 || post_graphql_as() {
  curl -sS "$API_URL/functions/v1/graphql" \
    -H "Authorization: Bearer $1" \
    -H "apikey: $ANON_KEY" \
    -H "content-type: application/json" \
    -d "$2"
}
curl -sS "$API_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"email":"e2e-content3@example.com","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN3="$(curl -sS "$API_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"email":"e2e-content3@example.com","password":"Passw0rd!1"}' | json_get access_token)"
[ -n "$TOKEN3" ] || { echo "failed to mint USER3 token"; exit 1; }

echo "== [content] create type - a malformed field schema is rejected =="
BAD="$(post_graphql "{\"query\":\"mutation{createContentType(workspaceId:\\\"$WS\\\", key:\\\"bad\\\", label:\\\"Bad\\\", fieldSchema:\\\"{\\\\\\\"fields\\\\\\\":\\\\\\\"nope\\\\\\\"}\\\"){id}}\"}")"
echo "$BAD" | grep -q '"errors"' || { echo "malformed field schema was NOT rejected: $BAD"; exit 1; }

echo "== [content] create a valid type + an item (content.created + revision #1) =="
CT="$(post_graphql "{\"query\":\"mutation{createContentType(workspaceId:\\\"$WS\\\", key:\\\"article\\\", label:\\\"Article\\\", fieldSchema:\\\"{\\\\\\\"fields\\\\\\\":[{\\\\\\\"key\\\\\\\":\\\\\\\"headline\\\\\\\",\\\\\\\"type\\\\\\\":\\\\\\\"text\\\\\\\"}]}\\\"){id}}\"}")"
CT_ID="$(echo "$CT" | json_get data.createContentType.id)"
[ -n "$CT_ID" ] || { echo "createContentType failed: $CT"; exit 1; }
ITEM="$(post_graphql "{\"query\":\"mutation{createContent(workspaceId:\\\"$WS\\\", contentTypeId:\\\"$CT_ID\\\", slug:\\\"e2e-article\\\", data:\\\"{\\\\\\\"headline\\\\\\\":\\\\\\\"v1\\\\\\\"}\\\"){id status}}\"}")"
ITEM_ID="$(echo "$ITEM" | json_get data.createContent.id)"
[ -n "$ITEM_ID" ] || { echo "createContent failed: $ITEM"; exit 1; }
REVS1="$(psql "$DB_URL" -tAc "select count(*) from public.content_revision where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
[ "$REVS1" = "1" ] || { echo "expected 1 revision at create, got $REVS1"; exit 1; }
CREATED_EVT="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='content.created' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
[ "$CREATED_EVT" -ge 1 ] || { echo "no content.created event"; exit 1; }

echo "== [content] no-op re-save dedups (still 1 revision) =="
post_graphql "{\"query\":\"mutation{updateContent(id:\\\"$ITEM_ID\\\", data:\\\"{\\\\\\\"headline\\\\\\\":\\\\\\\"v1\\\\\\\"}\\\"){id}}\"}" >/dev/null
REVS_DEDUP="$(psql "$DB_URL" -tAc "select count(*) from public.content_revision where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
[ "$REVS_DEDUP" = "1" ] || { echo "identical re-save added a revision (dedupe broken), got $REVS_DEDUP"; exit 1; }

echo "== [content] a real edit adds revision #2 =="
post_graphql "{\"query\":\"mutation{updateContent(id:\\\"$ITEM_ID\\\", data:\\\"{\\\\\\\"headline\\\\\\\":\\\\\\\"v2\\\\\\\"}\\\"){id}}\"}" >/dev/null
REVS2="$(psql "$DB_URL" -tAc "select count(*) from public.content_revision where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
[ "$REVS2" = "2" ] || { echo "expected 2 revisions after a real edit, got $REVS2"; exit 1; }

echo "== [content] submit for approval (content.submitted_for_approval) =="
post_graphql "{\"query\":\"mutation{submitForApproval(itemId:\\\"$ITEM_ID\\\"){id status}}\"}" | grep -q 'in_review' || { echo "submitForApproval did not move to in_review"; exit 1; }
SUB_EVT="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='content.submitted_for_approval' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
[ "$SUB_EVT" -ge 1 ] || { echo "no content.submitted_for_approval event"; exit 1; }

echo "== [content] decide approval (approve) - content.approved + approved_revision_id frozen =="
APPROVAL_ID="$(post_graphql "{\"query\":\"query{contentApprovals(workspaceId:\\\"$WS\\\", itemId:\\\"$ITEM_ID\\\", state:\\\"pending\\\"){id}}\"}" | json_get data.contentApprovals.0.id || true)"
[ -n "$APPROVAL_ID" ] || APPROVAL_ID="$(psql "$DB_URL" -tAc "select id from public.content_approval where content_item_id='$ITEM_ID' and state='pending' order by created_at desc limit 1;" | tr -d '[:space:]')"
[ -n "$APPROVAL_ID" ] || { echo "no pending content_approval row to decide"; exit 1; }
post_graphql "{\"query\":\"mutation{decideApproval(approvalId:\\\"$APPROVAL_ID\\\", vote:\\\"approve\\\"){id state approved_revision_id}}\"}" | grep -q 'approved' || { echo "decideApproval(approve) failed"; exit 1; }
APPROVED_REV="$(post_graphql "{\"query\":\"query{contentItem(id:\\\"$ITEM_ID\\\"){approved_revision_id current_revision_id}}\"}" | json_get data.contentItem.approved_revision_id)"
[ -n "$APPROVED_REV" ] || { echo "approved_revision_id not set after approval"; exit 1; }
APP_EVT="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='content.approved' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
[ "$APP_EVT" -ge 1 ] || { echo "no content.approved event"; exit 1; }

echo "== [content] editing after approval supersedes it (status in_review; approved rev retained/frozen) =="
post_graphql "{\"query\":\"mutation{updateContent(id:\\\"$ITEM_ID\\\", data:\\\"{\\\\\\\"headline\\\\\\\":\\\\\\\"v3-draft\\\\\\\"}\\\"){id}}\"}" >/dev/null
AFTER="$(post_graphql "{\"query\":\"query{contentItem(id:\\\"$ITEM_ID\\\"){status approved_revision_id current_revision_id}}\"}")"
echo "$AFTER" | grep -q 'in_review' || { echo "post-approval edit did not return to in_review: $AFTER"; exit 1; }
STILL_APPROVED="$(echo "$AFTER" | json_get data.contentItem.approved_revision_id)"
CURRENT_REV="$(echo "$AFTER" | json_get data.contentItem.current_revision_id)"
[ "$STILL_APPROVED" = "$APPROVED_REV" ] || { echo "approved revision not frozen after edit (was $APPROVED_REV, now $STILL_APPROVED)"; exit 1; }
[ "$CURRENT_REV" != "$APPROVED_REV" ] || { echo "current revision should differ from the frozen approved one"; exit 1; }

echo "== [content] publish -> content.published + a SIGNED webhook (HMAC over the raw body) =="
CAP_DIR="$(mktemp -d)"
WH_SECRET="e2e-webhook-secret-$(date +%s)"
node -e 'const http=require("http"),fs=require("fs"),d=process.argv[1];http.createServer((q,r)=>{const b=[];q.on("data",c=>b.push(c));q.on("end",()=>{fs.writeFileSync(d+"/body",Buffer.concat(b));fs.writeFileSync(d+"/sig",String(q.headers["x-movp-signature"]||""));r.writeHead(200);r.end("ok")})}).listen(8899,()=>console.error("cap up"))' "$CAP_DIR" &
CAP_PID=$!
sleep 1
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.register_webhook('$WS', 'content.published', 'http://host.docker.internal:8899', '$WH_SECRET');"
post_graphql "{\"query\":\"mutation{publishContent(itemId:\\\"$ITEM_ID\\\"){id status published_revision_id}}\"}" | grep -q 'published' || { echo "publishContent failed"; kill "$CAP_PID" 2>/dev/null || true; exit 1; }
PUB_EVT="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='content.published' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
[ "$PUB_EVT" -ge 1 ] || { echo "no content.published event"; kill "$CAP_PID" 2>/dev/null || true; exit 1; }
curl -sS -f -X POST "$API_URL/functions/v1/flows" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" >/tmp/content-flows.json
node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("/tmp/content-flows.json","utf8")); if ((j.processed||0) < 1 || (j.failed||0) > 0) { console.error("flows worker did not deliver cleanly:", j); process.exit(1) }'
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$CAP_DIR/body" ] && break; sleep 1; done
[ -s "$CAP_DIR/body" ] || { echo "no webhook body captured"; kill "$CAP_PID" 2>/dev/null || true; exit 1; }
SIG="$(cat "$CAP_DIR/sig")"
SIG="${SIG#sha256=}"
EXP="$(openssl dgst -sha256 -hmac "$WH_SECRET" < "$CAP_DIR/body" | awk '{print $NF}')"
kill "$CAP_PID" 2>/dev/null || true
[ -n "$SIG" ] && [ "$SIG" = "$EXP" ] || { echo "webhook x-movp-signature HMAC mismatch (sig=$SIG exp=$EXP)"; exit 1; }

echo "== [content] getPublished returns the frozen snapshot while a newer draft exists =="
PUBLISHED_HEADLINE="$(post_graphql "{\"query\":\"query{publishedContent(id:\\\"$ITEM_ID\\\"){ item{id slug status} revision{id data content_hash} }}\"}" | json_get data.publishedContent.revision.data)"
echo "$PUBLISHED_HEADLINE" | grep -q 'v2' || { echo "getPublished did not return the frozen (approved v2) snapshot: $PUBLISHED_HEADLINE"; exit 1; }
DRAFT_HEADLINE="$(post_graphql "{\"query\":\"query{contentItem(id:\\\"$ITEM_ID\\\"){data}}\"}" | json_get data.contentItem.data)"
echo "$DRAFT_HEADLINE" | grep -q 'v3-draft' || { echo "current draft is not the newer v3-draft: $DRAFT_HEADLINE"; exit 1; }

echo "== [content] curation published-only + runSeoAudit writes a score/checklist =="
post_graphql "{\"query\":\"query{content(workspaceId:\\\"$WS\\\", status:\\\"published\\\"){items{id}}}\"}" | grep -q "$ITEM_ID" || { echo "published-only curation did not include the item"; exit 1; }
SEO="$(post_graphql "{\"query\":\"mutation{runSeoAudit(itemId:\\\"$ITEM_ID\\\"){score checklist}}\"}")"
echo "$SEO" | grep -q '"score"' || { echo "runSeoAudit returned no score: $SEO"; exit 1; }
echo "$SEO" | json_get data.runSeoAudit.checklist | grep -q '.' || { echo "runSeoAudit returned an empty checklist: $SEO"; exit 1; }

echo "== [content] unpublish (content.unpublished; dropped from published curation) =="
post_graphql "{\"query\":\"mutation{unpublishContent(itemId:\\\"$ITEM_ID\\\"){id status}}\"}" >/dev/null
UNPUB_EVT="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='content.unpublished' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
[ "$UNPUB_EVT" -ge 1 ] || { echo "no content.unpublished event"; exit 1; }

echo "== [content] schedule + run the content scheduler (claim -> run the PINNED revision) =="
CUR_REV="$(post_graphql "{\"query\":\"query{contentItem(id:\\\"$ITEM_ID\\\"){current_revision_id}}\"}" | json_get data.contentItem.current_revision_id)"
[ -n "$CUR_REV" ] || { echo "could not read current_revision_id for scheduling"; exit 1; }
post_graphql "{\"query\":\"mutation{scheduleContent(itemId:\\\"$ITEM_ID\\\", action:\\\"publish\\\", revisionId:\\\"$CUR_REV\\\", runAt:\\\"2000-01-01T00:00:00Z\\\"){id state}}\"}" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.claim_due_schedules(100);" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.run_scheduled_publish(id) from public.content_schedule where state='fired' and run_at <= now();" >/dev/null
SCHED_ROW="$(psql "$DB_URL" -tAc "select count(*) from public.content_schedule where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
[ "$SCHED_ROW" -ge 1 ] || { echo "no content_schedule row for the item"; exit 1; }

echo "== [content] authz - a capability-less member cannot decide/publish via the API [42501] =="
post_graphql "{\"query\":\"mutation{submitForApproval(itemId:\\\"$ITEM_ID\\\"){id}}\"}" >/dev/null
DENY_APPROVAL_ID="$(psql "$DB_URL" -tAc "select id from public.content_approval where content_item_id='$ITEM_ID' and state='pending' order by created_at desc limit 1;" | tr -d '[:space:]')"
[ -n "$DENY_APPROVAL_ID" ] || { echo "no pending approval to test the deny path"; exit 1; }
DENY_DECIDE="$(post_graphql_as "$TOKEN2" "{\"query\":\"mutation{decideApproval(approvalId:\\\"$DENY_APPROVAL_ID\\\", vote:\\\"approve\\\"){id}}\"}")"
echo "$DENY_DECIDE" | grep -q '"errors"' || { echo "USER2 (no approve cap) was allowed to decide: $DENY_DECIDE"; exit 1; }
DENY_PUB="$(post_graphql_as "$TOKEN2" "{\"query\":\"mutation{publishContent(itemId:\\\"$ITEM_ID\\\"){id}}\"}")"
echo "$DENY_PUB" | grep -q '"errors"' || { echo "USER2 (no publish cap) was allowed to publish: $DENY_PUB"; exit 1; }

echo "== [content] authz - a non-member (USER3) sees 0 rows =="
NM="$(post_graphql_as "$TOKEN3" "{\"query\":\"query{content(workspaceId:\\\"$WS\\\"){items{id}}}\"}")"
echo "$NM" | grep -q "$ITEM_ID" && { echo "non-member saw content rows: $NM"; exit 1; } || true

echo "== [content] immutability - content_revision + content_publish_event rows cannot be UPDATEd =="
REV_ID="$(psql "$DB_URL" -tAc "select id from public.content_revision where content_item_id='$ITEM_ID' order by created_at limit 1;" | tr -d '[:space:]')"
BEFORE_HASH="$(psql "$DB_URL" -tAc "select content_hash from public.content_revision where id='$REV_ID';" | tr -d '[:space:]')"
psql "$DB_URL" -c "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER2_ID\"}'; update public.content_revision set content_hash='tampered' where id='$REV_ID'; rollback;" >/dev/null 2>&1 || true
AFTER_HASH="$(psql "$DB_URL" -tAc "select content_hash from public.content_revision where id='$REV_ID';" | tr -d '[:space:]')"
[ "$BEFORE_HASH" = "$AFTER_HASH" ] || { echo "content_revision was mutated (immutability broken)"; exit 1; }
PE_BEFORE="$(psql "$DB_URL" -tAc "select count(*) from public.content_publish_event where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
psql "$DB_URL" -c "begin; set local role authenticated; set local request.jwt.claims = '{\"sub\":\"$USER2_ID\"}'; update public.content_publish_event set content_item_id='00000000-0000-0000-0000-000000000000' where content_item_id='$ITEM_ID'; rollback;" >/dev/null 2>&1 || true
PE_AFTER="$(psql "$DB_URL" -tAc "select count(*) from public.content_publish_event where content_item_id='$ITEM_ID';" | tr -d '[:space:]')"
[ "$PE_BEFORE" = "$PE_AFTER" ] || { echo "content_publish_event was mutated (immutability broken)"; exit 1; }

echo "== [content] observability - each transition emits trace-correlated, ids-only events =="
for T in content.created content.submitted_for_approval content.approved content.published content.unpublished; do
  N="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='$T' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
  [ "$N" -ge 1 ] || { echo "missing event $T"; exit 1; }
  TRACED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='$T' and payload->>'id'='$ITEM_ID' and trace_id is not null;" | tr -d '[:space:]')"
  [ "$TRACED" = "$N" ] || { echo "event $T is not trace-correlated"; exit 1; }
done
LEAK="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where payload->>'id'='$ITEM_ID' and (payload::text ilike '%E2E article%' or payload::text ilike '%v3-draft%');" | tr -d '[:space:]')"
[ "$LEAK" = "0" ] || { echo "event payload leaked content title/body text (redaction broken)"; exit 1; }

echo "== [8] internal not exposed via PostgREST API =="
REST="$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/movp_jobs" -H "apikey: $ANON_KEY")"
[ "$REST" = "404" ] || [ "$REST" = "401" ] || { echo "movp_jobs reachable via REST ($REST)"; exit 1; }

echo "slice-e2e: PASS"
