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

post_graphql_as() {
  curl -sS "$API_URL/functions/v1/graphql" \
    -H "Authorization: Bearer $1" \
    -H "apikey: $ANON_KEY" \
    -H "content-type: application/json" \
    -d "$2"
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

cleanup_edge_runtime() {
  if [ "${MOVP_SKIP_EDGE_PROCESS_CLEANUP:-}" = "1" ]; then
    return 0
  fi
  if [ "${CI:-}" != "true" ] && [ "${MOVP_CLEAN_EDGE_RUNTIME:-}" != "1" ]; then
    return 0
  fi
  if command -v pkill >/dev/null 2>&1; then
    pkill -f 'supabase.*functions serve|edge-runtime' >/dev/null 2>&1 || true
  fi
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

echo "== [quickstart] seed demo data + login token =="
pnpm seed:demo
pnpm check:demo-seed
DEMO_TOKEN="$(
  curl -sS "$API_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" \
    -H "content-type: application/json" \
    -d '{"email":"demo-owner@example.test","password":"MovpDemo123!"}' | json_get access_token
)"
[ -n "$DEMO_TOKEN" ] || { echo "failed to mint demo owner token"; exit 1; }

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
cleanup_edge_runtime
FN_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/movp-functions.XXXXXX")"
# Keep local JWT issuer in an env file. On this stack, shell-assigned env vars
# can fail to propagate into the edge runtime and produce misleading invalid_token
# responses during manual debugging.
printf 'MOVP_JWT_ISSUER=%s\n' "$API_URL/auth/v1" >"$FN_ENV_FILE"
printf 'RESEND_API_KEY=%s\n' "slice-e2e-placeholder" >>"$FN_ENV_FILE"
# This CLI serves every function and accepts no positional function list.
supabase_local functions serve --env-file "$FN_ENV_FILE" >/tmp/movp-functions.log 2>&1 &
FN_PID=$!
trap 'kill $FN_PID 2>/dev/null || true; rm -f "$FN_ENV_FILE"; if [ -n "${AGENTS_XDG:-}" ]; then rm -rf "$AGENTS_XDG"; fi' EXIT
GRAPHQL_READY=0
BOOT_ERROR_COUNT=0
LAST_BOOT_ERROR=""
for _ in $(seq 1 60); do
  READY_BODY="$(post_graphql '{"query":"query{__typename}"}' || true)"
  if printf '%s' "$READY_BODY" | grep -q '"__typename"'; then
    GRAPHQL_READY=1
    break
  fi
  if printf '%s' "$READY_BODY" | grep -q 'BOOT_ERROR'; then
    BOOT_ERROR_COUNT=$((BOOT_ERROR_COUNT + 1))
    LAST_BOOT_ERROR="$READY_BODY"
    echo "graphql readiness saw transient BOOT_ERROR #$BOOT_ERROR_COUNT; retrying until timeout" >&2
  fi
  sleep 1
done
[ "$GRAPHQL_READY" = "1" ] || {
  echo "graphql function did not become ready; last response=${READY_BODY:-none}"
  if [ -n "$LAST_BOOT_ERROR" ]; then
    echo "last boot error: $LAST_BOOT_ERROR"
  fi
  tail -n 120 /tmp/movp-functions.log
  exit 1
}

echo "== [quickstart] bootstrap + login + seeded pages =="
DEMO_NOTES="$(post_graphql_as "$DEMO_TOKEN" "{\"query\":\"query{notes(workspaceId:\\\"$WS\\\", first:20){items{id title}}}\"}")"
echo "$DEMO_NOTES" | grep -q 'Welcome to MOVP' || { echo "quickstart notes missing seeded note: $DEMO_NOTES"; exit 1; }
DEMO_TASKS="$(post_graphql_as "$DEMO_TOKEN" "{\"query\":\"query{tasks(workspaceId:\\\"$WS\\\", first:20){items{id title}}}\"}")"
echo "$DEMO_TASKS" | grep -q 'Review the demo workspace' || { echo "quickstart tasks missing seeded task: $DEMO_TASKS"; exit 1; }
DEMO_WORKFLOWS="$(post_graphql_as "$DEMO_TOKEN" "{\"query\":\"query{automationRules(workspaceId:\\\"$WS\\\", first:20){items{id action_type}} workflow_runs(workspaceId:\\\"$WS\\\", first:20){items{id outcome}}}\"}")"
echo "$DEMO_WORKFLOWS" | grep -q 'notify' || { echo "quickstart workflows missing seeded rule: $DEMO_WORKFLOWS"; exit 1; }
echo "$DEMO_WORKFLOWS" | grep -q 'skipped' || { echo "quickstart workflows missing seeded run: $DEMO_WORKFLOWS"; exit 1; }

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
CT="$(post_graphql "{\"query\":\"mutation{createContentType(workspaceId:\\\"$WS\\\", key:\\\"article\\\", label:\\\"Article\\\", fieldSchema:\\\"[{\\\\\\\"name\\\\\\\":\\\\\\\"headline\\\\\\\",\\\\\\\"type\\\\\\\":\\\\\\\"text\\\\\\\"}]\\\"){id}}\"}")"
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
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update movp_internal.movp_jobs set status='dead', last_error_code='slice_skips_external_email' where kind='notify' and status in ('pending','running');" >/dev/null
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
SCHED_PUBLISH="$(psql "$DB_URL" -tAc "select count(*) from public.content_publish_event where content_item_id='$ITEM_ID' and action='publish' and revision_id='$CUR_REV';" | tr -d '[:space:]')"
[ "$SCHED_PUBLISH" -ge 1 ] || { echo "scheduled publish did not emit a publish event for pinned revision $CUR_REV"; exit 1; }

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
if psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update public.content_revision set content_hash='tampered' where id='$REV_ID';" >/tmp/content-revision-tamper.out 2>&1; then
  echo "content_revision UPDATE unexpectedly succeeded"
  cat /tmp/content-revision-tamper.out
  exit 1
fi
grep -qi 'immutable' /tmp/content-revision-tamper.out || { echo "content_revision tamper failed for the wrong reason"; cat /tmp/content-revision-tamper.out; exit 1; }
PE_ID="$(psql "$DB_URL" -tAc "select id from public.content_publish_event where content_item_id='$ITEM_ID' order by created_at limit 1;" | tr -d '[:space:]')"
[ -n "$PE_ID" ] || { echo "no content_publish_event row to test immutability"; exit 1; }
if psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update public.content_publish_event set content_item_id='00000000-0000-0000-0000-000000000000' where id='$PE_ID';" >/tmp/content-publish-event-tamper.out 2>&1; then
  echo "content_publish_event UPDATE unexpectedly succeeded"
  cat /tmp/content-publish-event-tamper.out
  exit 1
fi
grep -qi 'immutable' /tmp/content-publish-event-tamper.out || { echo "content_publish_event tamper failed for the wrong reason"; cat /tmp/content-publish-event-tamper.out; exit 1; }

echo "== [content] observability - each transition emits trace-correlated, ids-only events =="
for T in content.created content.submitted_for_approval content.approved content.published content.unpublished; do
  N="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='$T' and payload->>'id'='$ITEM_ID';" | tr -d '[:space:]')"
  [ "$N" -ge 1 ] || { echo "missing event $T"; exit 1; }
  TRACED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='$T' and payload->>'id'='$ITEM_ID' and trace_id ~ '^[0-9a-f-]{36}$';" | tr -d '[:space:]')"
  [ "$TRACED" = "$N" ] || { echo "event $T is not trace-correlated"; exit 1; }
done
LEAK="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where (payload->>'id'='$ITEM_ID' or payload->>'content_item_id'='$ITEM_ID') and (payload::text ilike '%e2e-article%' or payload::text ilike '%v1%' or payload::text ilike '%v2%' or payload::text ilike '%v3-draft%');" | tr -d '[:space:]')"
[ "$LEAK" = "0" ] || { echo "event payload leaked content title/body text (redaction broken)"; exit 1; }

echo "== [campaigns] plan -> campaign (psql: FK/status/date set) -> campaign.created + FK resolves =="
TODAY="$(date -u +%F)"
PLAN_ID="11111111-cccc-0000-0000-000000000001"
CAMP_ID="22222222-cccc-0000-0000-000000000001"
DELIV_ID="33333333-cccc-0000-0000-000000000001"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.marketing_plan (id, workspace_id, name, owner_id) values ('$PLAN_ID','$WS','E2E Plan','$USER_ID') on conflict (id) do nothing;" \
  -c "insert into public.campaign (id, workspace_id, name, marketing_plan_id, owner_id, status, start_date) values ('$CAMP_ID','$WS','E2E Campaign','$PLAN_ID','$USER_ID','scheduled','$TODAY') on conflict (id) do nothing;" \
  -c "insert into public.campaign_deliverable (id, workspace_id, campaign_id, name) values ('$DELIV_ID','$WS','$CAMP_ID','E2E Deliverable') on conflict (id) do nothing;"
CREATED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='campaign.created' and payload->>'entity_id'='$CAMP_ID';" | tr -d '[:space:]')"
[ "${CREATED:-0}" -ge 1 ] || { echo "no campaign.created event for $CAMP_ID (got $CREATED)"; exit 1; }
FK="$(psql "$DB_URL" -tAc "select marketing_plan_id from public.campaign where id='$CAMP_ID';" | tr -d '[:space:]')"
[ "$FK" = "$PLAN_ID" ] || { echo "campaign.marketing_plan_id did not resolve (got $FK)"; exit 1; }

echo "== [campaigns] create a backing task and link it (implemented_by edge) =="
TASK="$(post_graphql "{\"query\":\"mutation{createTask(workspaceId:\\\"$WS\\\", title:\\\"Backing task\\\"){id}}\"}")"
TASK_ID="$(echo "$TASK" | json_get data.createTask.id)"
[ -n "$TASK_ID" ] || { echo "createTask failed: $TASK"; exit 1; }
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.edges (workspace_id, src_type, src_id, rel, dst_type, dst_id) values ('$WS','campaign_deliverable','$DELIV_ID','implemented_by','task','$TASK_ID') on conflict do nothing;"

echo "== [campaigns] assign the backing task -> bridge emits deliverable.assigned =="
post_graphql "{\"query\":\"mutation{assignTask(taskId:\\\"$TASK_ID\\\", userId:\\\"$USER2_ID\\\")}\"}" >/dev/null
ASSIGNED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='deliverable.assigned' and payload->>'entity_id'='$DELIV_ID';" | tr -d '[:space:]')"
[ "${ASSIGNED:-0}" -ge 1 ] || { echo "bridge did not emit deliverable.assigned for $DELIV_ID (got $ASSIGNED)"; exit 1; }

echo "== [campaigns] complete the backing task -> bridge emits deliverable.completed =="
DONE_ID="$(psql "$DB_URL" -tAc "select id from public.task_status_option where workspace_id='$WS' and category='done' limit 1;" | tr -d '[:space:]')"
[ -n "$DONE_ID" ] || { echo "no done-category status option for WS"; exit 1; }
post_graphql "{\"query\":\"mutation{transitionTask(taskId:\\\"$TASK_ID\\\", statusId:\\\"$DONE_ID\\\"){id completed_at}}\"}" >/dev/null
COMPLETED="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='deliverable.completed' and payload->>'entity_id'='$DELIV_ID';" | tr -d '[:space:]')"
[ "${COMPLETED:-0}" -ge 1 ] || { echo "bridge did not emit deliverable.completed for $DELIV_ID (got $COMPLETED)"; exit 1; }

echo "== [campaigns] scan flips scheduled->active (campaign.started once); re-run emits nothing =="
psql "$DB_URL" -tAc "select public.scan_campaigns();" >/dev/null
STATUS="$(psql "$DB_URL" -tAc "select status from public.campaign where id='$CAMP_ID';" | tr -d '[:space:]')"
[ "$STATUS" = "active" ] || { echo "scan did not activate the campaign (got $STATUS)"; exit 1; }
STARTED1="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='campaign.started' and payload->>'entity_id'='$CAMP_ID';" | tr -d '[:space:]')"
[ "${STARTED1:-0}" -eq 1 ] || { echo "expected exactly one campaign.started (got $STARTED1)"; exit 1; }
psql "$DB_URL" -tAc "select public.scan_campaigns();" >/dev/null
STARTED2="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='campaign.started' and payload->>'entity_id'='$CAMP_ID';" | tr -d '[:space:]')"
[ "${STARTED2:-0}" -eq 1 ] || { echo "re-running scan emitted a duplicate campaign.started (got $STARTED2)"; exit 1; }

echo "== [campaigns] no-duplication gate: campaign_deliverable has no schedule/status/assignee columns =="
DUP_COLS="$(psql "$DB_URL" -tAc "select count(*) from information_schema.columns where table_schema='public' and table_name='campaign_deliverable' and column_name in ('start_date','due_date','status','status_id','priority','priority_id','assignee_user_id','completed_at');" | tr -d '[:space:]')"
[ "${DUP_COLS:-1}" -eq 0 ] || { echo "campaign_deliverable duplicates task fields (found $DUP_COLS)"; exit 1; }

echo "== [campaigns] a non-member sees 0 campaigns (GraphQL read under RLS) =="
OUT="$(post_graphql_as "$TOKEN3" "{\"query\":\"query{campaigns(workspaceId:\\\"$WS\\\"){items{id}}}\"}")"
echo "$OUT" | grep -q "$CAMP_ID" && { echo "non-member could see the campaign: $OUT"; exit 1; }

echo "== [campaigns] a non-owner UPDATE is denied (owner-only RLS) =="
psql "$DB_URL" -tAc "update public.campaign set name='keep' where id='$CAMP_ID';" >/dev/null
curl -sS -X PATCH "$API_URL/rest/v1/campaign?id=eq.$CAMP_ID" \
  -H "Authorization: Bearer $TOKEN2" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -H "Prefer: return=representation" \
  -d '{"name":"hijacked"}' >/dev/null
NAME="$(psql "$DB_URL" -tAc "select name from public.campaign where id='$CAMP_ID';" | tr -d '[:space:]')"
[ "$NAME" = "keep" ] || { echo "non-owner UPDATE mutated the campaign (name=$NAME)"; exit 1; }


echo "== [ingest] external ingestion: API-key path (workspace comes from the KEY) =="
W2ING="44444444-4444-4444-4444-444444444444"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -c "insert into public.workspace (id, name) values ('$W2ING','IngestW2') on conflict (id) do nothing;"
RAWKEY="$(psql "$DB_URL" -tAc "select public.mint_ingest_key('$WS','slice');" | tr -d '[:space:]')"
[ "${#RAWKEY}" = "48" ] || { echo "mint_ingest_key did not return a 48-char raw key"; exit 1; }
# 3 valid events: #1 smuggles workspace_id=W2ING (MUST be ignored); #2 omits subject_type (defaults to user).
ING1="$(curl -sS "$API_URL/functions/v1/ingest" -H "apikey: $ANON_KEY" -H "x-ingest-key: $RAWKEY" \
  -H 'content-type: application/json' \
  -d '{"events":[{"event_type":"slice.signup","subject_ref":"ing-u1","occurred_at":"2026-07-01T00:00:00Z","workspace_id":"'"$W2ING"'"},{"event_type":"slice.login","subject_ref":"ing-u2","occurred_at":"2026-07-01T00:01:00Z"},{"event_type":"slice.login","subject_type":"account","subject_ref":"ing-u3","occurred_at":"2026-07-01T00:02:00Z"}]}')"
[ "$(echo "$ING1" | json_get inserted)" = "3" ] || { echo "api-key ingest failed: $ING1"; exit 1; }
[ "$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$WS' and source='external' and subject_ref like 'ing-u%';" | tr -d '[:space:]')" = "3" ] \
  || { echo "expected 3 external rows in the key's workspace"; exit 1; }
[ "$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$W2ING';" | tr -d '[:space:]')" = "0" ] \
  || { echo "payload workspace_id was NOT ignored (rows landed in W2)"; exit 1; }
[ "$(psql "$DB_URL" -tAc "select subject_type from public.platform_event where subject_ref='ing-u2';" | tr -d '[:space:]')" = "user" ] \
  || { echo "missing subject_type did not default to user"; exit 1; }

echo "== [ingest] bounds: malformed + oversized are dropped (never buffered) =="
ING2="$(node -e 'process.stdout.write(JSON.stringify({events:[{event_type:"slice.ok",subject_ref:"ing-b1",occurred_at:"2026-07-01T00:03:00Z"},{event_type:"bad"},{event_type:"big",subject_ref:"ing-b3",occurred_at:"2026-07-01T00:04:00Z",properties:{blob:"x".repeat(17000)}}]}))' \
  | curl -sS "$API_URL/functions/v1/ingest" -H "apikey: $ANON_KEY" -H "x-ingest-key: $RAWKEY" -H 'content-type: application/json' -d @-)"
[ "$(echo "$ING2" | json_get inserted)" = "1" ] || { echo "bounds: expected inserted=1: $ING2"; exit 1; }
[ "$(echo "$ING2" | json_get dropped)" = "2" ] || { echo "bounds: expected dropped=2 (malformed+oversized): $ING2"; exit 1; }

echo "== [ingest] auth: invalid key 401; ambiguous both-creds 400 =="
BADKEY="$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/functions/v1/ingest" -H "apikey: $ANON_KEY" -H "x-ingest-key: not-a-real-key" \
  -H 'content-type: application/json' -d '{"events":[]}')"
[ "$BADKEY" = "401" ] || { echo "invalid ingest key not rejected (got $BADKEY)"; exit 1; }
AMBIG="$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/functions/v1/ingest" -H "apikey: $ANON_KEY" -H "x-ingest-key: $RAWKEY" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"events":[]}')"
[ "$AMBIG" = "400" ] || { echo "ambiguous both-credentials not rejected (got $AMBIG)"; exit 1; }

echo "== [ingest] JWT path: member write lands; non-member workspace 403 =="
J1="$(curl -sS "$API_URL/functions/v1/ingest" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"events":[{"event_type":"slice.jwt","subject_ref":"ing-j1","occurred_at":"2026-07-01T00:05:00Z","workspace_id":"'"$WS"'"}]}')"
[ "$(echo "$J1" | json_get inserted)" = "1" ] || { echo "member JWT ingest failed: $J1"; exit 1; }
[ "$(psql "$DB_URL" -tAc "select source from public.platform_event where subject_ref='ing-j1';" | tr -d '[:space:]')" = "external" ] \
  || { echo "JWT-ingested row is not source=external"; exit 1; }
NM="$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/functions/v1/ingest" -H "apikey: $ANON_KEY" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"events":[{"event_type":"slice.jwt","subject_ref":"ing-j2","occurred_at":"2026-07-01T00:06:00Z","workspace_id":"'"$W2ING"'"}]}')"
[ "$NM" = "403" ] || { echo "non-member workspace JWT write not rejected (got $NM)"; exit 1; }

echo "== [segmentation] (a) internal bridge: emit registration.completed -> platform_event (source internal) =="
SUBJ="$USER_ID"
# emit_event signature is (ev_type, ws, payload, trace) — NOT (ws, type, ...).
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "select public.emit_event('registration.completed','$WS', jsonb_build_object('subject_type','user','subject_ref','$SUBJ','email','pii@example.com'), null::text);"
BRIDGED="$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$WS' and event_type='registration.completed' and source='internal' and subject_ref='$SUBJ';" | tr -d '[:space:]')"
[ "${BRIDGED:-0}" -ge 1 ] || { echo "internal bridge did not land a platform_event (got $BRIDGED)"; exit 1; }
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.emit_event('some.unbridged.type','$WS', jsonb_build_object('subject_ref','$SUBJ'), null::text);"
UNBRIDGED="$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$WS' and event_type='some.unbridged.type';" | tr -d '[:space:]')"
[ "${UNBRIDGED:-1}" -eq 0 ] || { echo "a non-allow-listed type leaked into platform_event (got $UNBRIDGED)"; exit 1; }

echo "== [segmentation] (b) external ingest: a WS-A key writes A only; a forged WS-B write is rejected =="
# CTE-wrap so the top-level statement is a SELECT — a bare `insert … returning` also prints the
# "INSERT 0 1" command tag, which tr -d would glue onto the uuid.
WS_B="$(psql "$DB_URL" -tAc "with n as (insert into public.workspace (id, name) values (gen_random_uuid(), 'SegWsB') returning id) select id from n;" | tr -d '[:space:]')"
[ -n "$WS_B" ] || { echo "failed to create WS_B"; exit 1; }
INGEST_KEY="e2e-ingest-secret-$$"
# digest lives in the extensions schema; hash must match Part B's ingest_platform_event resolution.
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into movp_internal.ingest_key (workspace_id, key_hash, active) values ('$WS', encode(extensions.digest('$INGEST_KEY','sha256'),'hex'), true) on conflict do nothing;"
# The RPC resolves the workspace from the KEY HASH, so the forged events[].workspace_id (WS_B) is IGNORED.
EVENTS_JSON="[{\"event_type\":\"product.viewed\",\"subject_type\":\"user\",\"subject_ref\":\"ext-1\",\"occurred_at\":\"$(date -u +%FT%TZ)\",\"workspace_id\":\"$WS_B\"}]"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.ingest_platform_event('$INGEST_KEY', \$seg\$$EVENTS_JSON\$seg\$::jsonb);" >/dev/null
EXT_A="$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$WS' and source='external' and subject_ref='ext-1';" | tr -d '[:space:]')"
[ "${EXT_A:-0}" -ge 1 ] || { echo "external ingest did not write to the key's workspace A (got $EXT_A)"; exit 1; }
EXT_B="$(psql "$DB_URL" -tAc "select count(*) from public.platform_event where workspace_id='$WS_B';" | tr -d '[:space:]')"
[ "${EXT_B:-1}" -eq 0 ] || { echo "a WS-A key wrote a platform_event into WS-B (forged workspace_id honoured; got $EXT_B)"; exit 1; }

echo "== [segmentation] (c) segment+rule -> recompute -> membership (matched_rule + evidence); re-run idempotent =="
SEG_ID="44444444-dddd-0000-0000-000000000001"
RULE_ID="55555555-dddd-0000-0000-000000000001"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.segment (id, workspace_id, name, owner_ref, active, mode) values ('$SEG_ID','$WS','E2E Seg','$USER_ID', true, 'dynamic') on conflict (id) do nothing;" \
  -c "insert into public.segment_rule (id, workspace_id, segment_id, predicate, version, active) values ('$RULE_ID','$WS','$SEG_ID','{\"all\":[{\"event\":\"registration.completed\"}]}'::jsonb, 1, true) on conflict (id) do nothing;"
psql "$DB_URL" -tAc "select public.recompute_segment('$SEG_ID');" >/dev/null
MEMBERS="$(psql "$DB_URL" -tAc "select count(*) from public.segment_membership where segment_id='$SEG_ID' and subject_ref='$SUBJ';" | tr -d '[:space:]')"
[ "${MEMBERS:-0}" -ge 1 ] || { echo "recompute did not admit the registered subject (got $MEMBERS)"; exit 1; }
MATCHED="$(psql "$DB_URL" -tAc "select count(*) from public.segment_membership where segment_id='$SEG_ID' and subject_ref='$SUBJ' and matched_rule_id='$RULE_ID';" | tr -d '[:space:]')"
[ "${MATCHED:-0}" -ge 1 ] || { echo "membership row missing matched_rule_id=$RULE_ID"; exit 1; }
# idempotency: re-run changes 0 rows and emits 0 NEW membership_changed. The segment id is keyed under entity_id.
CHANGED1="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='segment.membership_changed' and payload->>'entity_id'='$SEG_ID';" | tr -d '[:space:]')"
COUNT1="$(psql "$DB_URL" -tAc "select count(*) from public.segment_membership where segment_id='$SEG_ID';" | tr -d '[:space:]')"
psql "$DB_URL" -tAc "select public.recompute_segment('$SEG_ID');" >/dev/null
CHANGED2="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type='segment.membership_changed' and payload->>'entity_id'='$SEG_ID';" | tr -d '[:space:]')"
COUNT2="$(psql "$DB_URL" -tAc "select count(*) from public.segment_membership where segment_id='$SEG_ID';" | tr -d '[:space:]')"
[ "${COUNT1:-0}" = "${COUNT2:-1}" ] || { echo "re-run changed membership rows ($COUNT1 -> $COUNT2)"; exit 1; }
[ "${CHANGED1:-0}" = "${CHANGED2:-1}" ] || { echo "re-run emitted new membership_changed events ($CHANGED1 -> $CHANGED2)"; exit 1; }

echo "== [segmentation] (d) snapshot freezes membership; later events do not change the frozen set =="
psql "$DB_URL" -tAc "select public.take_segment_snapshot('$SEG_ID','on_demand');" >/dev/null
SNAP_ID="$(psql "$DB_URL" -tAc "select id from public.segment_snapshot where segment_id='$SEG_ID' order by taken_at desc limit 1;" | tr -d '[:space:]')"
[ -n "$SNAP_ID" ] || { echo "take_segment_snapshot produced no snapshot"; exit 1; }
FROZEN1="$(psql "$DB_URL" -tAc "select count(*) from public.segment_snapshot_member where snapshot_id='$SNAP_ID';" | tr -d '[:space:]')"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.emit_event('registration.completed','$WS', jsonb_build_object('subject_type','user','subject_ref','$USER2_ID'), null::text);"
psql "$DB_URL" -tAc "select public.recompute_segment('$SEG_ID');" >/dev/null
FROZEN2="$(psql "$DB_URL" -tAc "select count(*) from public.segment_snapshot_member where snapshot_id='$SNAP_ID';" | tr -d '[:space:]')"
[ "${FROZEN1:-0}" = "${FROZEN2:-1}" ] || { echo "snapshot member set changed after later events ($FROZEN1 -> $FROZEN2)"; exit 1; }

echo "== [segmentation] (e) RLS: a non-member sees 0 rows on every segmentation collection =="
curl -sS "$API_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"email":"e2e-seg-outsider@example.com","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN3="$(curl -sS "$API_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"email":"e2e-seg-outsider@example.com","password":"Passw0rd!1"}' | json_get access_token)"
[ -n "$TOKEN3" ] || { echo "failed to mint outsider token"; exit 1; }
for COLL in segments platform_events segment_memberships segment_snapshots; do
  OUT="$(post_graphql_as "$TOKEN3" "{\"query\":\"query{${COLL}(workspaceId:\\\"$WS\\\"){items{id}}}\"}")"
  echo "$OUT" | grep -q "$SEG_ID" && { echo "non-member saw a row on $COLL: $OUT"; exit 1; }
done
IK="$(curl -sS "$API_URL/rest/v1/ingest_key?select=key_hash" -H "Authorization: Bearer $TOKEN2" -H "apikey: $ANON_KEY")"
echo "$IK" | grep -q 'key_hash' && { echo "ingest_key was readable by an authenticated user: $IK"; exit 1; }

echo "== [segmentation] (f) redaction: segmentation events carry field names not PII values =="
LEAK="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_events where type like 'segment.%' and payload::text like '%pii@example.com%';" | tr -d '[:space:]')"
[ "${LEAK:-1}" -eq 0 ] || { echo "a segment.* event leaked a PII property value (found $LEAK)"; exit 1; }

echo "== [workflows] (a) event catalog includes cross-domain triggers =="
EVENTS="$(post_graphql '{"query":"query{eventTypes(first:100){items{key domain active}}}"}')"
echo "$EVENTS" | grep -q 'task.completed' || { echo "eventTypes missing task.completed: $EVENTS"; exit 1; }
echo "$EVENTS" | grep -q 'content.approved' || { echo "eventTypes missing content.approved: $EVENTS"; exit 1; }
echo "$EVENTS" | grep -q 'segment.membership_changed' || { echo "eventTypes missing segment.membership_changed: $EVENTS"; exit 1; }

echo "== [workflows] (b) create_task automation runs exactly once under replay =="
WF_RULE_ID="66666666-eeee-0000-0000-000000000001"
TASK_COMPLETED_EVENT_TYPE_ID="$(psql "$DB_URL" -tAc "select id from public.event_type where key='task.completed';" | tr -d '[:space:]')"
[ -n "$TASK_COMPLETED_EVENT_TYPE_ID" ] || { echo "no task.completed event_type row"; exit 1; }
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.automation_rule (id, workspace_id, trigger_event_type_id, condition, action_type, action_config, enabled, priority) values ('$WF_RULE_ID','$WS','$TASK_COMPLETED_EVENT_TYPE_ID','{}'::jsonb,'create_task','{\"title\":\"Workflow follow-up task\",\"actorId\":\"$USER_ID\"}'::jsonb,true,1) on conflict (id) do update set enabled=true;"
RULES="$(post_graphql "{\"query\":\"query{automationRules(workspaceId:\\\"$WS\\\", first:100){items{id action_type enabled priority}}}\"}")"
echo "$RULES" | grep -q "$WF_RULE_ID" || { echo "automationRules did not expose the workflow rule: $RULES"; exit 1; }
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update movp_internal.movp_jobs set status='dead', last_error_code='slice_skips_external_email' where kind='notify' and status in ('pending','running');" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update movp_internal.movp_jobs set status='dead', last_error_code='slice_isolates_workflow_block' where kind='automate' and status in ('pending','running');" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.emit_event('task.completed','$WS', jsonb_build_object('entity_id','$TASK_ID','actor_id','$USER_ID','contact_email','e2e@example.com','body','semantic lighthouse','secret','workflow-secret-value'), 'workflow-slice-create-task');" >/dev/null
WF_EVENT_ID="$(psql "$DB_URL" -tAc "select id from movp_internal.movp_events where type='task.completed' and trace_id='workflow-slice-create-task' order by created_at desc limit 1;" | tr -d '[:space:]')"
[ -n "$WF_EVENT_ID" ] || { echo "workflow task.completed event was not recorded"; exit 1; }
WF_AUTOMATE_JOB_ID="$(psql "$DB_URL" -tAc "select id from movp_internal.movp_jobs where kind='automate' and payload->>'event_id'='$WF_EVENT_ID' order by created_at desc limit 1;" | tr -d '[:space:]')"
[ -n "$WF_AUTOMATE_JOB_ID" ] || { echo "workflow automate job was not enqueued"; exit 1; }
curl -sS -f -X POST "$API_URL/functions/v1/flows" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" >/tmp/workflow-flows.json
node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync("/tmp/workflow-flows.json","utf8")); if ((j.processed||0) < 1 || (j.failed||0) > 0) { console.error("workflow flows did not process cleanly:", j); process.exit(1) }'
WF_RUNS1="$(psql "$DB_URL" -tAc "select count(*) from public.workflow_run where source_event_id='$WF_EVENT_ID' and automation_rule_id='$WF_RULE_ID' and outcome='succeeded';" | tr -d '[:space:]')"
[ "${WF_RUNS1:-0}" -eq 1 ] || { echo "expected one succeeded workflow_run for create_task, got $WF_RUNS1"; exit 1; }
WF_TASKS1="$(psql "$DB_URL" -tAc "select count(*) from public.task where workspace_id='$WS' and title='Workflow follow-up task';" | tr -d '[:space:]')"
[ "${WF_TASKS1:-0}" -eq 1 ] || { echo "expected one workflow follow-up task, got $WF_TASKS1"; exit 1; }
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update movp_internal.movp_jobs set status='pending', attempts=0, next_run_at=now(), locked_by=null, locked_at=null, lease_expires_at=null where id='$WF_AUTOMATE_JOB_ID';" >/dev/null
curl -sS -f -X POST "$API_URL/functions/v1/flows" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" >/tmp/workflow-flows-replay.json
WF_TASKS2="$(psql "$DB_URL" -tAc "select count(*) from public.task where workspace_id='$WS' and title='Workflow follow-up task';" | tr -d '[:space:]')"
[ "${WF_TASKS2:-0}" -eq 1 ] || { echo "replayed automate job created a duplicate workflow task ($WF_TASKS1 -> $WF_TASKS2)"; exit 1; }

echo "== [workflows] (c) managed webhook registration, filter skip, rotation, and deactivate =="
WF_HOOK_URL="https://hooks.example.test/workflow-slice"
REG_BODY="$(node -e 'process.stdout.write(JSON.stringify({
  query: "mutation($workspaceId: ID!, $eventKey: String!, $url: String!, $filter: String) { registerWebhookSubscription(workspaceId: $workspaceId, eventKey: $eventKey, url: $url, filter: $filter) { subscriptionId secret } }",
  variables: {
    workspaceId: process.argv[1],
    eventKey: "task.completed",
    url: process.argv[2],
    filter: JSON.stringify({ field: "event", op: "eq", value: "never.matches" }),
  },
}))' "$WS" "$WF_HOOK_URL")"
REG="$(post_graphql "$REG_BODY")"
WF_SUB_ID="$(echo "$REG" | json_get data.registerWebhookSubscription.subscriptionId)"
WF_OLD_SECRET="$(echo "$REG" | json_get data.registerWebhookSubscription.secret)"
[ -n "$WF_SUB_ID" ] && [ -n "$WF_OLD_SECRET" ] || { echo "registerWebhookSubscription failed: $REG"; exit 1; }
SUBS="$(post_graphql "{\"query\":\"query{webhook_subscriptions(workspaceId:\\\"$WS\\\", first:100){items{id url active secret_set internal_webhook_id}}}\"}")"
echo "$SUBS" | grep -q "$WF_HOOK_URL" || { echo "webhook_subscriptions did not expose the managed subscription: $SUBS"; exit 1; }
echo "$SUBS" | grep -q 'secret_set' || { echo "webhook_subscriptions missing secret_set: $SUBS"; exit 1; }
echo "$SUBS" | grep -q "$WF_OLD_SECRET" && { echo "webhook secret leaked through generic subscription read: $SUBS"; exit 1; }
WF_INTERNAL_ID="$(psql "$DB_URL" -tAc "select internal_webhook_id from public.webhook_subscription where id='$WF_SUB_ID';" | tr -d '[:space:]')"
[ -n "$WF_INTERNAL_ID" ] || { echo "managed webhook subscription has no internal pair"; exit 1; }
DRIFT="$(psql "$DB_URL" -tAc "select count(*) from public.webhook_subscription_pairing_drift();" | tr -d '[:space:]')"
[ "${DRIFT:-1}" -eq 0 ] || { echo "webhook subscription pairing drift detected (count=$DRIFT)"; exit 1; }
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update public.automation_rule set enabled=false where id='$WF_RULE_ID';" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update movp_internal.movp_jobs set status='dead', last_error_code='slice_isolates_webhook_filter' where kind='automate' and status in ('pending','running');" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.emit_event('task.completed','$WS', jsonb_build_object('entity_id','$TASK_ID'), 'workflow-slice-webhook-filter');" >/dev/null
WF_WEBHOOK_EVENT_ID="$(psql "$DB_URL" -tAc "select id from movp_internal.movp_events where type='task.completed' and trace_id='workflow-slice-webhook-filter' order by created_at desc limit 1;" | tr -d '[:space:]')"
WF_WEBHOOK_JOB_ID="$(psql "$DB_URL" -tAc "select id from movp_internal.movp_jobs where kind='webhook' and payload->>'webhook_id'='$WF_INTERNAL_ID' and payload->>'entity_id'='$TASK_ID' order by created_at desc limit 1;" | tr -d '[:space:]')"
[ -n "$WF_WEBHOOK_JOB_ID" ] || { echo "managed webhook job was not enqueued for filter test"; exit 1; }
curl -sS -f -X POST "$API_URL/functions/v1/flows" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" >/tmp/workflow-flows-filter.json
WF_WEBHOOK_STATUS="$(psql "$DB_URL" -tAc "select status from movp_internal.movp_jobs where id='$WF_WEBHOOK_JOB_ID';" | tr -d '[:space:]')"
[ "$WF_WEBHOOK_STATUS" = "done" ] || { echo "non-matching managed webhook filter did not complete as skipped/done (status=$WF_WEBHOOK_STATUS)"; exit 1; }
ROT="$(post_graphql "{\"query\":\"mutation{rotateWebhookSecret(workspaceId:\\\"$WS\\\", subscriptionId:\\\"$WF_SUB_ID\\\"){subscriptionId secret}}\"}")"
WF_NEW_SECRET="$(echo "$ROT" | json_get data.rotateWebhookSecret.secret)"
[ -n "$WF_NEW_SECRET" ] && [ "$WF_NEW_SECRET" != "$WF_OLD_SECRET" ] || { echo "rotateWebhookSecret failed or reused the old secret: $ROT"; exit 1; }
OLD_LOOKUP="$(psql "$DB_URL" -tAc "select public.webhook_subscription_for_delivery('$WS','task.completed','$WF_HOOK_URL','$WF_OLD_SECRET','$WF_INTERNAL_ID')::text;" | tr -d '[:space:]')"
echo "$OLD_LOOKUP" | grep -q '"status":"skip"' || { echo "old webhook secret did not classify as skip after rotate: $OLD_LOOKUP"; exit 1; }
NEW_LOOKUP="$(psql "$DB_URL" -tAc "select public.webhook_subscription_for_delivery('$WS','task.completed','$WF_HOOK_URL','$WF_NEW_SECRET','$WF_INTERNAL_ID')::text;" | tr -d '[:space:]')"
echo "$NEW_LOOKUP" | grep -q '"status":"deliver"' || { echo "new webhook secret did not classify as deliver after rotate: $NEW_LOOKUP"; exit 1; }
post_graphql "{\"query\":\"mutation{setWebhookActive(workspaceId:\\\"$WS\\\", subscriptionId:\\\"$WF_SUB_ID\\\", active:false){id active}}\"}" | grep -q 'false' || { echo "setWebhookActive(false) failed"; exit 1; }
BEFORE_DEACT_JOBS="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_jobs where kind='webhook' and payload->>'webhook_id'='$WF_INTERNAL_ID';" | tr -d '[:space:]')"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.emit_event('task.completed','$WS', jsonb_build_object('entity_id','$TASK_ID'), 'workflow-slice-webhook-deactivated');" >/dev/null
AFTER_DEACT_JOBS="$(psql "$DB_URL" -tAc "select count(*) from movp_internal.movp_jobs where kind='webhook' and payload->>'webhook_id'='$WF_INTERNAL_ID';" | tr -d '[:space:]')"
[ "${BEFORE_DEACT_JOBS:-0}" = "${AFTER_DEACT_JOBS:-1}" ] || { echo "deactivated workflow webhook still enqueued a delivery job ($BEFORE_DEACT_JOBS -> $AFTER_DEACT_JOBS)"; exit 1; }

echo "== [workflows] (d) non-member isolation + replay-dead surface =="
OUT_RULES="$(post_graphql_as "$TOKEN3" "{\"query\":\"query{automationRules(workspaceId:\\\"$WS\\\", first:100){items{id}}}\"}")"
echo "$OUT_RULES" | grep -q "$WF_RULE_ID" && { echo "non-member saw workflow rules: $OUT_RULES"; exit 1; }
OUT_SUBS="$(post_graphql_as "$TOKEN3" "{\"query\":\"query{webhook_subscriptions(workspaceId:\\\"$WS\\\", first:100){items{id}}}\"}")"
echo "$OUT_SUBS" | grep -q "$WF_SUB_ID" && { echo "non-member saw workflow subscriptions: $OUT_SUBS"; exit 1; }
OUT_RUNS="$(post_graphql_as "$TOKEN3" "{\"query\":\"query{workflow_runs(workspaceId:\\\"$WS\\\", first:100){items{source_event_id}}}\"}")"
echo "$OUT_RUNS" | grep -q "$WF_EVENT_ID" && { echo "non-member saw workflow runs: $OUT_RUNS"; exit 1; }
DENY_ROTATE="$(post_graphql_as "$TOKEN3" "{\"query\":\"mutation{rotateWebhookSecret(workspaceId:\\\"$WS\\\", subscriptionId:\\\"$WF_SUB_ID\\\"){subscriptionId secret}}\"}")"
echo "$DENY_ROTATE" | grep -q '"errors"' || { echo "non-member rotated workflow webhook: $DENY_ROTATE"; exit 1; }
DENY_REPLAY="$(post_graphql_as "$TOKEN3" "{\"query\":\"mutation{replayDeadWorkflowJobs(workspaceId:\\\"$WS\\\"){replayed}}\"}")"
echo "$DENY_REPLAY" | grep -q '"errors"' || { echo "non-member replayed workflow jobs: $DENY_REPLAY"; exit 1; }
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update movp_internal.movp_jobs set status='dead', last_error_code='slice_replay_probe' where id='$WF_AUTOMATE_JOB_ID';" >/dev/null
REPLAY="$(post_graphql "{\"query\":\"mutation{replayDeadWorkflowJobs(workspaceId:\\\"$WS\\\"){replayed}}\"}")"
echo "$REPLAY" | grep -q '"replayed"' || { echo "replayDeadWorkflowJobs did not return a replay count: $REPLAY"; exit 1; }
curl -sS -f -X POST "$API_URL/functions/v1/flows" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" >/tmp/workflow-flows-replayed-dead.json
WF_TASKS3="$(psql "$DB_URL" -tAc "select count(*) from public.task where workspace_id='$WS' and title='Workflow follow-up task';" | tr -d '[:space:]')"
[ "${WF_TASKS3:-0}" -eq 1 ] || { echo "dead-job replay duplicated workflow task ($WF_TASKS2 -> $WF_TASKS3)"; exit 1; }

echo "== [workflows] (e) loop guard skips chained emit_event at max depth =="
LOOP_EVENT_TYPE_ID="77777777-eeee-0000-0000-000000000001"
LOOP_RULE_ID="88888888-eeee-0000-0000-000000000001"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.event_type (id, key, domain, label, payload_schema, schema_version, active, description) values ('$LOOP_EVENT_TYPE_ID','e2e.loop','workflow','E2E loop','{}'::jsonb,1,true,'slice loop guard') on conflict (key) do update set active=true;" \
  -c "insert into public.automation_rule (id, workspace_id, trigger_event_type_id, condition, action_type, action_config, enabled, priority) values ('$LOOP_RULE_ID','$WS','$LOOP_EVENT_TYPE_ID','{}'::jsonb,'emit_event','{\"eventType\":\"e2e.loop\",\"payload\":{}}'::jsonb,true,1) on conflict (id) do update set enabled=true;"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "update movp_internal.movp_jobs set status='dead', last_error_code='slice_isolates_loop_guard' where kind='automate' and status in ('pending','running');" >/dev/null
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "select public.emit_event('e2e.loop','$WS', jsonb_build_object('depth',5), 'workflow-slice-loop');" >/dev/null
LOOP_EVENT_ID="$(psql "$DB_URL" -tAc "select id from movp_internal.movp_events where type='e2e.loop' and trace_id='workflow-slice-loop' order by created_at desc limit 1;" | tr -d '[:space:]')"
curl -sS -f -X POST "$API_URL/functions/v1/flows" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" >/tmp/workflow-flows-loop.json
LOOP_ERR="$(psql "$DB_URL" -tAc "select error_code from public.workflow_run where source_event_id='$LOOP_EVENT_ID' and automation_rule_id='$LOOP_RULE_ID' order by updated_at desc limit 1;" | tr -d '[:space:]')"
[ "$LOOP_ERR" = "loop_depth_exceeded" ] || { echo "loop guard did not record loop_depth_exceeded (got $LOOP_ERR)"; exit 1; }

echo "== [workflows] (f) audit drilldown + redaction =="
EVENT_DETAIL="$(post_graphql "{\"query\":\"query{workflowEvent(workspaceId:\\\"$WS\\\", eventId:\\\"$WF_EVENT_ID\\\")}\"}")"
echo "$EVENT_DETAIL" | grep -q 'task.completed' || { echo "workflowEvent did not return the source event: $EVENT_DETAIL"; exit 1; }
echo "$EVENT_DETAIL" | grep -q 'payload_keys' || { echo "workflowEvent did not return redacted payload keys: $EVENT_DETAIL"; exit 1; }
echo "$EVENT_DETAIL" | grep -q 'e2e@example.com' && { echo "workflowEvent leaked email payload values: $EVENT_DETAIL"; exit 1; }
echo "$EVENT_DETAIL" | grep -q 'semantic lighthouse' && { echo "workflowEvent leaked content body payload values: $EVENT_DETAIL"; exit 1; }
echo "$EVENT_DETAIL" | grep -q 'workflow-secret-value' && { echo "workflowEvent leaked secret payload values: $EVENT_DETAIL"; exit 1; }
WF_LEAK="$(psql "$DB_URL" -tAc "select count(*) from public.workflow_run where to_jsonb(workflow_run)::text like '%$WF_OLD_SECRET%' or to_jsonb(workflow_run)::text like '%$WF_NEW_SECRET%' or to_jsonb(workflow_run)::text like '%e2e@example.com%' or to_jsonb(workflow_run)::text like '%semantic lighthouse%';" | tr -d '[:space:]')"
[ "${WF_LEAK:-1}" -eq 0 ] || { echo "workflow_run leaked secret/email/content values (count=$WF_LEAK)"; exit 1; }
grep -q "$WF_OLD_SECRET" /tmp/movp-functions.log && { echo "function log leaked old webhook secret"; exit 1; } || true
grep -q "$WF_NEW_SECRET" /tmp/movp-functions.log && { echo "function log leaked new webhook secret"; exit 1; } || true

echo "== [admin] (a) create workspace, invite, and accept membership =="
ADMIN_WS_CREATE="$(post_graphql '{"query":"mutation{createWorkspace(name:\"Admin Slice\"){id name}}"}')"
ADMIN_WS="$(echo "$ADMIN_WS_CREATE" | json_get data.createWorkspace.id)"
[ -n "$ADMIN_WS" ] || { echo "createWorkspace failed: $ADMIN_WS_CREATE"; exit 1; }
echo "$ADMIN_WS_CREATE" | grep -q 'Admin Slice' || { echo "createWorkspace did not return the workspace name: $ADMIN_WS_CREATE"; exit 1; }
curl -sS "$API_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"email":"e2e-admin-invitee@example.com","password":"Passw0rd!1","email_confirm":true}' >/dev/null
ADMIN_INVITEE_TOKEN="$(curl -sS "$API_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"email":"e2e-admin-invitee@example.com","password":"Passw0rd!1"}' | json_get access_token)"
[ -n "$ADMIN_INVITEE_TOKEN" ] || { echo "failed to mint admin invitee token"; exit 1; }
ADMIN_INVITE="$(post_graphql "{\"query\":\"mutation{inviteMember(workspaceId:\\\"$ADMIN_WS\\\", email:\\\"e2e-admin-invitee@example.com\\\", role:\\\"member\\\"){inviteId token}}\"}")"
ADMIN_INVITE_TOKEN="$(echo "$ADMIN_INVITE" | json_get data.inviteMember.token)"
[ -n "$ADMIN_INVITE_TOKEN" ] || { echo "inviteMember failed: $ADMIN_INVITE"; exit 1; }
ADMIN_ACCEPT="$(post_graphql_as "$ADMIN_INVITEE_TOKEN" "{\"query\":\"mutation{acceptInvite(token:\\\"$ADMIN_INVITE_TOKEN\\\"){workspace_id role}}\"}")"
echo "$ADMIN_ACCEPT" | grep -q "$ADMIN_WS" || { echo "acceptInvite did not join the new workspace: $ADMIN_ACCEPT"; exit 1; }
echo "$ADMIN_ACCEPT" | grep -q 'member' || { echo "acceptInvite did not return member role: $ADMIN_ACCEPT"; exit 1; }

echo "== [admin] (b) create ingest key returns raw key once; settings reports member count =="
ADMIN_KEY="$(post_graphql "{\"query\":\"mutation{createIngestKey(workspaceId:\\\"$ADMIN_WS\\\", label:\\\"slice\\\"){keyId rawKey}}\"}")"
ADMIN_RAW_KEY="$(echo "$ADMIN_KEY" | json_get data.createIngestKey.rawKey)"
node -e 'const k=process.argv[1]; if (!/^[0-9a-f]{48}$/.test(k)) { console.error(`raw ingest key was not 48 hex chars: ${k}`); process.exit(1) }' "$ADMIN_RAW_KEY"
ADMIN_KEYS="$(post_graphql "{\"query\":\"query{ingestKeys(workspaceId:\\\"$ADMIN_WS\\\"){id label active created_at}}\"}")"
echo "$ADMIN_KEYS" | grep -q 'slice' || { echo "ingestKeys did not list the created key: $ADMIN_KEYS"; exit 1; }
echo "$ADMIN_KEYS" | grep -q "$ADMIN_RAW_KEY" && { echo "ingestKeys leaked the raw key: $ADMIN_KEYS"; exit 1; }
ADMIN_SETTINGS="$(post_graphql "{\"query\":\"query{workspaceSettings(workspaceId:\\\"$ADMIN_WS\\\"){name member_count}}\"}")"
echo "$ADMIN_SETTINGS" | grep -q 'Admin Slice' || { echo "workspaceSettings missing workspace name: $ADMIN_SETTINGS"; exit 1; }
echo "$ADMIN_SETTINGS" | grep -q '"member_count":2' || { echo "workspaceSettings missing member_count=2: $ADMIN_SETTINGS"; exit 1; }

echo "== [admin] (c) dead-job counts, keys-only list, and scoped replay =="
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "select public.enqueue_job('notify','admin-slice-dead', jsonb_build_object('secret_url','https://evil.example/admin','event','admin.slice'), '$ADMIN_WS');" \
  -c "update movp_internal.movp_jobs set status='dead', attempts=8, last_error_code='admin_slice_dead' where kind='notify' and idempotency_key='admin-slice-dead';" >/dev/null
ADMIN_JOBS="$(post_graphql "{\"query\":\"query{jobCounts(workspaceId:\\\"$ADMIN_WS\\\") deadJobs(workspaceId:\\\"$ADMIN_WS\\\", first:20){id kind last_error_code payload_keys}}\"}")"
echo "$ADMIN_JOBS" | grep -q 'admin_slice_dead' || { echo "deadJobs did not include the seeded dead job: $ADMIN_JOBS"; exit 1; }
echo "$ADMIN_JOBS" | grep -q 'secret_url' || { echo "deadJobs did not expose payload keys: $ADMIN_JOBS"; exit 1; }
echo "$ADMIN_JOBS" | grep -q 'evil.example' && { echo "deadJobs leaked payload values: $ADMIN_JOBS"; exit 1; }
ADMIN_REPLAY="$(post_graphql "{\"query\":\"mutation{replayDeadJobs(workspaceId:\\\"$ADMIN_WS\\\", kind:\\\"notify\\\"){replayed}}\"}")"
echo "$ADMIN_REPLAY" | grep -q '"replayed":1' || { echo "replayDeadJobs did not replay exactly one dead job: $ADMIN_REPLAY"; exit 1; }

echo "== [admin] (d) generic collection create + update strip unsafe fields =="
ADMIN_NOTE="$(post_graphql "{\"query\":\"mutation{createNote(input:{workspace_id:\\\"$ADMIN_WS\\\", title:\\\"Admin slice note\\\", body:\\\"admin slice body\\\"}){id title}}\"}")"
ADMIN_NOTE_ID="$(echo "$ADMIN_NOTE" | json_get data.createNote.id)"
[ -n "$ADMIN_NOTE_ID" ] || { echo "createNote for admin generic browser failed: $ADMIN_NOTE"; exit 1; }
ADMIN_UPDATE="$(post_graphql "{\"query\":\"mutation{updateNote(id:\\\"$ADMIN_NOTE_ID\\\", input:{id:\\\"00000000-0000-0000-0000-000000000000\\\", workspace_id:\\\"$WS\\\", title:\\\"Admin slice edited\\\"}){id title workspace_id}}\"}")"
echo "$ADMIN_UPDATE" | grep -q 'Admin slice edited' || { echo "generic updateNote failed: $ADMIN_UPDATE"; exit 1; }
ADMIN_NOTE_WS="$(echo "$ADMIN_UPDATE" | json_get data.updateNote.workspace_id)"
[ "$ADMIN_NOTE_WS" = "$ADMIN_WS" ] || { echo "generic updateNote moved workspace_id ($ADMIN_NOTE_WS != $ADMIN_WS): $ADMIN_UPDATE"; exit 1; }

echo "== [agents] mint a user-scoped PAT via the web RPC (as the e2e owner) =="
# PATs are USER-SCOPED: this PAT grants exactly $USER_ID's own access. default_workspace_id
# ($WS) is a CLI home hint, NOT an access boundary. Minted via the GraphQL surface with the
# user's session JWT ($TOKEN) — mirrors how [admin] mints an ingest key via createIngestKey.
AGENTS_PAT_CREATE="$(post_graphql "{\"query\":\"mutation{createPersonalAccessToken(defaultWorkspaceId:\\\"$WS\\\", name:\\\"agents-slice\\\"){tokenId token}}\"}")"
AGENTS_PAT="$(echo "$AGENTS_PAT_CREATE" | json_get data.createPersonalAccessToken.token)"
AGENTS_PAT_ID="$(echo "$AGENTS_PAT_CREATE" | json_get data.createPersonalAccessToken.tokenId)"
[ -n "$AGENTS_PAT" ] && [ -n "$AGENTS_PAT_ID" ] || { echo "createPersonalAccessToken response was missing token or tokenId"; exit 1; }
# assert the movp_pat_ prefix WITHOUT echoing the raw token (keys-only obs)
case "$AGENTS_PAT" in movp_pat_*) : ;; *) echo "PAT missing movp_pat_ prefix (create response shape wrong)"; exit 1;; esac

echo "== [agents] the metadata list exposes the PAT but never the raw token/hash =="
AGENTS_PAT_LIST="$(post_graphql '{"query":"query{personalAccessTokens{id name defaultWorkspaceId createdAt revokedAt}}"}')"
echo "$AGENTS_PAT_LIST" | grep -q 'agents-slice' || { echo "personalAccessTokens did not list the PAT: $AGENTS_PAT_LIST"; exit 1; }
case "$AGENTS_PAT_LIST" in *"$AGENTS_PAT"*) echo "personalAccessTokens leaked the raw PAT"; exit 1;; esac

echo "== [agents] exchange the PAT for a real session via the auth-exchange edge fn =="
# The CLI login/headless path relies on THIS endpoint being served (see the serve-list edit).
AGENTS_EX="$(curl -sS "$API_URL/functions/v1/auth-exchange" \
  -H "Authorization: Bearer $AGENTS_PAT" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -d '{}')"
echo "$AGENTS_EX" | grep -q 'access_token' || { echo "auth-exchange did not return a session (is auth-exchange served?): $AGENTS_EX"; exit 1; }
AGENTS_EX_SUB="$(echo "$AGENTS_EX" | json_get user_id)"
[ "$AGENTS_EX_SUB" = "$USER_ID" ] || { echo "exchange resolved the wrong user ($AGENTS_EX_SUB != $USER_ID): $AGENTS_EX"; exit 1; }

echo "== [agents] MCP over streamable HTTP with the PAT: tools/list + a real tool-call =="
# Bearer is the movp_pat_ token -> resolvePrincipal's PAT branch mints a session in-process and
# binds principal.db under RLS. The transport is stateless (no initialize handshake needed),
# exactly as the [4] block already proves for tools/list.
AGENTS_MCP_LIST="$(curl -sS "$API_URL/functions/v1/mcp" \
  -H "Authorization: Bearer $AGENTS_PAT" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
echo "$AGENTS_MCP_LIST" | grep -q 'note.list' || { echo "MCP tools/list (PAT auth) missing note.list: $AGENTS_MCP_LIST"; exit 1; }
AGENTS_MCP_CALL="$(curl -sS "$API_URL/functions/v1/mcp" \
  -H "Authorization: Bearer $AGENTS_PAT" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"note.list\",\"arguments\":{\"workspaceId\":\"$WS\"}}}")"
echo "$AGENTS_MCP_CALL" | grep -q 'E2E note' || { echo "MCP note.list (PAT auth) returned no real data: $AGENTS_MCP_CALL"; exit 1; }

echo "== [agents] MCP over stdio via @movp/mcp-bridge with the PAT: tools/list =="
AGENTS_STDIO="$(MCP_ENDPOINT="$API_URL/functions/v1/mcp" MCP_PAT="$AGENTS_PAT" MCP_APIKEY="$ANON_KEY" \
  node scripts/mcp-bridge-probe.mjs)"
echo "$AGENTS_STDIO" | grep -q 'MCP_STDIO_TOOLS_OK' || { echo "@movp/mcp-bridge stdio tools/list did not list note.list: $AGENTS_STDIO"; exit 1; }

echo "== [agents] CLI authed action + hybrid search via the PAT (headless MOVP_PAT mode) =="
# GOTCHA: force the file-based 0600 credential store (MOVP_SECURE_STORE=file) and an isolated
# XDG_CONFIG_HOME so a local macOS run never writes to the developer login Keychain; CI (Linux)
# uses the file store anyway. The CLI is run from source via tsx (no build step needed).
AGENTS_XDG="$(mktemp -d "${TMPDIR:-/tmp}/movp-agents-xdg.XXXXXX")"
export SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" MOVP_SECURE_STORE=file XDG_CONFIG_HOME="$AGENTS_XDG"
AGENTS_TASKS="$(MOVP_PAT="$AGENTS_PAT" pnpm exec tsx packages/cli/src/bin.ts task list --workspace "$WS")"
echo "$AGENTS_TASKS" | grep -q 'E2E task' || { echo "movp task list (PAT auth) returned no real data: $AGENTS_TASKS"; exit 1; }
AGENTS_HYBRID="$(MOVP_PAT="$AGENTS_PAT" pnpm exec tsx packages/cli/src/bin.ts search 'semantic lighthouse' --workspace "$WS" --mode hybrid)"
echo "$AGENTS_HYBRID" | grep -q 'E2E note' || { echo "movp search --mode hybrid (PAT auth) returned no hit: $AGENTS_HYBRID"; exit 1; }

echo "== [agents] revoke the PAT -> every surface fails closed with the auth code =="
post_graphql "{\"query\":\"mutation{revokePersonalAccessToken(tokenId:\\\"$AGENTS_PAT_ID\\\")}\"}" | grep -q 'true' \
  || { echo "revokePersonalAccessToken did not return true"; exit 1; }
# (1) MCP over HTTP with the revoked PAT -> 401 + stable code (mirrors the [6] fail-closed block)
AGENTS_MCP_401="$(curl -sS -o /tmp/agents-mcp-revoked.json -w '%{http_code}' "$API_URL/functions/v1/mcp" \
  -H "Authorization: Bearer $AGENTS_PAT" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
[ "$AGENTS_MCP_401" = "401" ] || { echo "revoked PAT still reached MCP ($AGENTS_MCP_401): $(cat /tmp/agents-mcp-revoked.json)"; exit 1; }
grep -q 'invalid_token' /tmp/agents-mcp-revoked.json || { echo "MCP 401 body missing the stable auth code: $(cat /tmp/agents-mcp-revoked.json)"; exit 1; }
# (2) auth-exchange with the revoked PAT -> 401 + stable code
AGENTS_EX_401="$(curl -sS -o /tmp/agents-ex-revoked.json -w '%{http_code}' "$API_URL/functions/v1/auth-exchange" \
  -H "Authorization: Bearer $AGENTS_PAT" \
  -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -d '{}')"
[ "$AGENTS_EX_401" = "401" ] || { echo "revoked PAT still exchanged a session ($AGENTS_EX_401): $(cat /tmp/agents-ex-revoked.json)"; exit 1; }
grep -q 'invalid_token' /tmp/agents-ex-revoked.json || { echo "exchange 401 body missing the stable auth code: $(cat /tmp/agents-ex-revoked.json)"; exit 1; }
# (3) the CLI re-validates via the exchange on EVERY login, so a revoked PAT fails closed
# (non-zero) immediately. GOTCHA: an already-minted session stays valid up to jwt_expiry (~1h);
# `movp login` re-exchanges, so it does not depend on that documented residual window.
if printf '%s\n' "$AGENTS_PAT" | pnpm exec tsx packages/cli/src/bin.ts login >/tmp/agents-cli-revoked.log 2>&1; then
  echo "revoked PAT was accepted by movp login: $(cat /tmp/agents-cli-revoked.log)"; exit 1
fi
grep -qiE 'token|auth' /tmp/agents-cli-revoked.log || { echo "movp login failure did not surface an auth/token error: $(cat /tmp/agents-cli-revoked.log)"; exit 1; }

echo "== [agents] keys-only: the function log never printed the raw PAT =="
AGENTS_FUNCTION_LOG="$(cat /tmp/movp-functions.log)"
case "$AGENTS_FUNCTION_LOG" in *"$AGENTS_PAT"*) echo "function log leaked the raw PAT (keys-only obs violated)"; exit 1;; esac
rm -rf "$AGENTS_XDG"

echo "== [integration-exposure] PostgREST facade is RLS-guarded =="
EX1="$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/ingest_idempotency" -H "apikey: $ANON_KEY")"
[ "$EX1" = "404" ] || [ "$EX1" = "401" ] || { echo "ingest_idempotency reachable via REST ($EX1)"; exit 1; }

curl -sS -X POST "$API_URL/rest/v1/external_record" \
  -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -H "Prefer: return=minimal" \
  -d "{\"workspace_id\":\"$WS\",\"source\":\"slice\",\"external_id\":\"er-1\",\"payload\":{}}" >/dev/null
ER="$(curl -sS "$API_URL/rest/v1/external_record?select=external_id&source=eq.slice" \
  -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY")"
echo "$ER" | grep -q 'er-1' || { echo "member could not read own external_record via REST: $ER"; exit 1; }

PATCH="$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH "$API_URL/rest/v1/external_record?source=eq.slice&external_id=eq.er-1" \
  -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"external_id":"er-2"}')"
[ "$PATCH" = "400" ] || [ "$PATCH" = "409" ] || [ "$PATCH" = "500" ] || { echo "identity PATCH not rejected ($PATCH)"; exit 1; }

AN_STATUS="$(curl -sS -o /tmp/integration-exposure-anon.json -w '%{http_code}' \
  "$API_URL/rest/v1/note?select=id" -H "apikey: $ANON_KEY")"
case "$AN_STATUS" in
  200) [ "$(cat /tmp/integration-exposure-anon.json)" = "[]" ] || { echo "anon read a workspace table via REST"; exit 1; } ;;
  401|403) ;;
  *) echo "unexpected anon REST status ($AN_STATUS)"; exit 1 ;;
esac

echo "== [8] internal not exposed via PostgREST API =="
REST="$(curl -sS -o /dev/null -w '%{http_code}' "$API_URL/rest/v1/movp_jobs" -H "apikey: $ANON_KEY")"
[ "$REST" = "404" ] || [ "$REST" = "401" ] || { echo "movp_jobs reachable via REST ($REST)"; exit 1; }

echo "slice-e2e: PASS"
