#!/usr/bin/env bash
# C6d acceptance: publish the bundle to a local Verdaccio, scaffold CRM-lite, npm install (NO
# workspace links), codegen, db reset, serve the real GraphQL + MCP edge functions, and drive an
# authenticated GraphQL query + streamable-MCP tools/call + CLI create/list. Requires Docker,
# supabase, deno, node, npm, psql.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/fixtures/verdaccio-crm-lite"
REGISTRY="http://127.0.0.1:4873"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/movp-crm-lite.XXXXXX")"
PROJECT="acme-crm"
WS="33333333-3333-3333-3333-333333333333"
DB_URL="postgresql://postgres:postgres@127.0.0.1:64522/postgres"

# INTERFACES F1 — this gate writes NOTHING under the repository: the staging tree, Verdaccio's
# storage, and the npm auth token all live under $WORK / $CM_STAGE (mktemp -d). So cleanup only ever
# removes temp dirs — it never has to "restore" or delete anything in the worktree.
cleanup() {
  [ -n "${FN_PID:-}" ] && kill "$FN_PID" 2>/dev/null || true
  [ -n "${VERDACCIO_PID:-}" ] && kill "$VERDACCIO_PID" 2>/dev/null || true
  ( cd "$WORK/$PROJECT" 2>/dev/null && supabase stop --no-backup >/dev/null 2>&1 ) || true
  rm -rf "$WORK" "${CM_STAGE:-}"
}
trap cleanup EXIT

# 1. Build every publishable dist (tsup) + the platform bundle.
pnpm -w build
pnpm --filter @movp/platform build
pnpm --filter create-movp build
# No unguarded read path may reach an explicit copy (INTERFACES F1b): every one-off file copy in the
# staging script and the scaffolder goes through `copyFileGuarded`, never a raw copyFileSync.
if grep -nE '\b(copyFileSync|readFileSync)\(' \
     "$FIXTURE_DIR/stage-create-movp.mjs" "$REPO_ROOT/packages/create-movp/src/scaffold.ts"; then
  echo "gate: unguarded copyFileSync/readFileSync — use copyFileGuarded (INTERFACES F1b)"; exit 1;
fi
# The snapshot helper must STREAM (INTERFACES F2). A readFileSync-based snapshot OOMs on a large
# untracked file — i.e. it breaks the very gate whose job is to tolerate a dirty worktree.
if grep -nE '\breadFileSync\(' "$REPO_ROOT/scripts/tree-snapshot.mjs"; then
  echo "gate: tree-snapshot must stream (createReadStream + createHash), never readFileSync"; exit 1;
fi

# Stage create-movp into a TEMP publish tree — NEVER mutate the source worktree (INTERFACES F1).
# The staging script materializes templates/ through the SAME guarded copier (`copyTreeGuarded`:
# ROOT-and-subdirectory lstat/symlink-reject, regular-file-only, size-bound) that `npm create movp`
# runs — NOT a raw `cp -R` — so a symlinked template file, or a symlinked template ROOT, FAILS the
# pack instead of being packed into the published tarball.
#
# INTERFACES F2 — the invariant is "STAGING CHANGED NOTHING", not "the tree is pristine". Hash the
# source subtrees staging reads BEFORE and AFTER (with the ONE shared helper, scripts/tree-snapshot.mjs
# — 06e uses this same script) and require byte-identical manifests. Do NOT assert
# `packages/create-movp/templates` is absent or that `git status --porcelain` is empty, and NEVER
# `git checkout --` anything: this gate is run by developers with unrelated WIP and pre-existing
# untracked files, which are legitimate and MUST be preserved (an "assert pristine" gate tempts a
# cleanup that DELETES their work — the exact harm this check claims to prevent).
node "$REPO_ROOT/scripts/tree-snapshot.mjs" "$REPO_ROOT" "$WORK/snapshot-before.txt"
CM_STAGE="$(mktemp -d "${TMPDIR:-/tmp}/movp-create-movp.XXXXXX")"
node "$FIXTURE_DIR/stage-create-movp.mjs" "$REPO_ROOT" "$CM_STAGE"
node "$REPO_ROOT/scripts/tree-snapshot.mjs" "$REPO_ROOT" "$WORK/snapshot-after.txt"
if ! diff -u "$WORK/snapshot-before.txt" "$WORK/snapshot-after.txt"; then
  # The diff prints paths + sha256s only — file CONTENTS are never emitted into the log.
  echo "gate: staging MUTATED the source subtree (paths + hashes above)"; exit 1;
fi

# 2. Start Verdaccio, with its storage rendered into $WORK — a relative `storage:` in the yaml would
#    write into fixtures/ (i.e. into the repo). Nothing this gate creates lives in the worktree.
sed "s#__STORAGE__#$WORK/verdaccio-storage#" "$FIXTURE_DIR/verdaccio.yaml" >"$WORK/verdaccio.yaml"
# The edge runtime runs in Docker and reaches the ephemeral registry through host.docker.internal;
# loopback-only binding makes the published @movp packages invisible to the real function runtime.
# The registry and its writable storage exist only for this gate and are terminated by the trap.
node "$REPO_ROOT/node_modules/verdaccio/bin/verdaccio" --listen 0.0.0.0:4873 -c "$WORK/verdaccio.yaml" >"$WORK/verdaccio.log" 2>&1 &
VERDACCIO_PID=$!
VERDACCIO_READY=0
for _ in $(seq 1 30); do
  curl -sf --connect-timeout 2 --max-time 5 "$REGISTRY/-/ping" >/dev/null 2>&1 && { VERDACCIO_READY=1; break; }
  sleep 1
done
if [ "$VERDACCIO_READY" != "1" ]; then
  echo "gate: Verdaccio did not become ready at $REGISTRY" >&2
  tail -n 80 "$WORK/verdaccio.log" >&2
  exit 1
fi

# 3. Publish the bundle to Verdaccio (a throwaway token; Verdaccio accepts any with $all).
#    The token goes in a TEMP npm userconfig: `npm config set … --location project` would write an
#    .npmrc into the repo (clobbering the developer's) — INTERFACES F1, no writes under the worktree.
export npm_config_registry="$REGISTRY"
export NPM_CONFIG_REGISTRY="$REGISTRY"
export NPM_CONFIG_USERCONFIG="$WORK/npmrc"
export npm_config_cache="$WORK/npm-cache"
export DENO_DIR="$WORK/deno-cache"
printf '//127.0.0.1:4873/:_authToken=fake-token\n' >"$NPM_CONFIG_USERCONFIG"
for pkg in auth cli codegen core-schema domain editor-sdk flows graphql mcp notifications obs platform richtext search; do
  # pnpm rewrites workspace:* to concrete package versions in the published manifest. npm publish
  # preserves workspace:* and an external npm install then fails with EUNSUPPORTEDPROTOCOL.
  ( cd "$REPO_ROOT/packages/$pkg" && pnpm publish --no-git-checks ) || { echo "publish @movp/$pkg failed"; exit 1; }
done
# create-movp is published from the STAGING tree (holds package.json + dist/ + guarded templates/),
# never from the source worktree.
( cd "$CM_STAGE" && pnpm publish --no-git-checks ) || { echo "publish create-movp failed"; exit 1; }

# 4. Scaffold CRM-lite into a clean temp dir via the PUBLISHED create-movp (no workspace context).
cd "$WORK"
printf 'crm-lite\n%s\n%s\n' "$PROJECT" "$WS" | \
  npm --registry "$REGISTRY" create movp@0.1.0
[ -d "$WORK/$PROJECT" ] || { echo "scaffold did not create $PROJECT"; exit 1; }
cd "$WORK/$PROJECT"

# 5. Install with NO workspace links, then assert no file:/workspace: specifiers leaked.
npm install --registry "$REGISTRY"
if grep -REl '"(file:|workspace:|link:)' package.json package-lock.json >/dev/null 2>&1; then
  echo "gate: file:/workspace:/link: specifier found in the scaffold — not standalone"; exit 1;
fi
if grep -Rq 'supasuite/packages' package-lock.json 2>/dev/null; then
  echo "gate: lockfile references the monorepo source tree — not standalone"; exit 1;
fi

# 6. Codegen runs POST-install (INTERFACES F2 — the scaffolder does NOT run it inline; the project
#    baseline + movp.schema.json are emitted HERE, by the scaffold's own tsx + @movp/codegen). Sequence
#    is install (step 5) → codegen (this step) → db reset (step 7).
npm run codegen
test -f supabase/migrations/20260715000000_movp_generated.sql || { echo "project baseline missing"; exit 1; }
ls supabase/migrations/*_movp_generated.sql >/dev/null || { echo "no generated migration"; exit 1; }

# 6b. DATA-LOSS REGRESSION (INTERFACES round-12 F1, Task 5) — the end-to-end proof, in the one place it
#     is real: a PUBLISHED create-movp + a plain `npm install` layout, running the INSTALLED `movp` bin.
#     `movp codegen` here is PLATFORM codegen; before Task 5 it exited 0 and either deleted the project
#     baseline or wrote a junk `node_modules/supabase/` tree. It must now REFUSE, loudly, and touch
#     nothing. Assert all four properties — the exit code is the one that fails in every layout.
BASELINE_SHA_BEFORE="$(shasum -a 256 supabase/migrations/20260715000000_movp_generated.sql | cut -d' ' -f1)"
CODEGEN_STATUS=0
CODEGEN_OUT="$(npx movp codegen 2>&1)" || CODEGEN_STATUS=$?
if [ "$CODEGEN_STATUS" -eq 0 ]; then
  echo 'gate: `movp codegen` exited 0 inside the scaffold — the platform generator ran (round-12 F1)' >&2; exit 1
fi
if ! printf '%s\n' "$CODEGEN_OUT" | grep -qF 'project_codegen_use_project_bin'; then
  echo "gate: movp codegen refusal did not name project_codegen_use_project_bin: $CODEGEN_OUT" >&2; exit 1
fi
BASELINE_SHA_AFTER="$(shasum -a 256 supabase/migrations/20260715000000_movp_generated.sql | cut -d' ' -f1)"
if [ "$BASELINE_SHA_BEFORE" != "$BASELINE_SHA_AFTER" ]; then
  echo 'gate: `movp codegen` modified or deleted the scaffold project baseline' >&2; exit 1
fi
if [ -e node_modules/supabase ]; then
  echo 'gate: `movp codegen` wrote a platform migration tree into node_modules/supabase' >&2; exit 1
fi

# 7. Start the isolated stack + reset. Docker may report pg_meta/Studio as `starting` on the first
#    health window; retry the whole start at most three times, then preserve the CLI's hard failure.
STACK_STARTED=0
for attempt in 1 2 3; do
  if supabase start; then
    STACK_STARTED=1
    break
  fi
  sleep "$((attempt * 2))"
done
[ "$STACK_STARTED" = "1" ] || { echo "gate: Supabase stack did not become healthy after 3 attempts" >&2; exit 1; }
DB_RESET=0
for attempt in 1 2 3; do
  if supabase db reset; then
    DB_RESET=1
    break
  fi
  sleep "$((attempt * 2))"
done
[ "$DB_RESET" = "1" ] || { echo "gate: Supabase database reset failed after 3 attempts" >&2; exit 1; }

# 7b. The platform metadata the bundle seeded matches the VERIFIED manifest exactly — counts are DERIVED
#     from `verifyPlatformArtifact()`'s return value (it returns a PlatformManifest carrying
#     `metadata: { collections, fields }`), never hardcoded. Same derivation as
#     fixtures/platform-consumer/gate.sh:55. This also proves the project baseline did NOT re-seed or
#     drop any platform-layer metadata row.
PLATFORM_DIST="$REPO_ROOT/packages/platform/dist"
EXPECTED_COUNTS="$(node --input-type=module -e "import { verifyPlatformArtifact } from '$PLATFORM_DIST/index.js'; const m = verifyPlatformArtifact('$PLATFORM_DIST'); process.stdout.write(m.metadata.collections + '|' + m.metadata.fields)")" || {
  echo "gate: verifyPlatformArtifact failed" >&2; exit 1
}
IFS='|' read -r EXPECT_COLLECTIONS EXPECT_FIELDS <<<"$EXPECTED_COUNTS"
if [[ ! "$EXPECT_COLLECTIONS" =~ ^[1-9][0-9]*$ ]] || [[ ! "$EXPECT_FIELDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "gate: verified artifact returned malformed metadata counts" >&2; exit 1
fi
GOT_COLLECTIONS="$(psql "$DB_URL" -tAqc "select count(*) from public.movp_collections where layer='platform';")"
GOT_FIELDS="$(psql "$DB_URL" -tAqc "select count(*) from public.movp_fields where layer='platform';")"
if [ "$GOT_COLLECTIONS" != "$EXPECT_COLLECTIONS" ] || [ "$GOT_FIELDS" != "$EXPECT_FIELDS" ]; then
  echo "gate: platform metadata mismatch: manifest says collections=$EXPECT_COLLECTIONS fields=$EXPECT_FIELDS; db has collections=$GOT_COLLECTIONS fields=$GOT_FIELDS" >&2; exit 1
fi
PROJECT_COLLECTIONS="$(psql "$DB_URL" -tAqc "select count(*) from public.movp_collections where layer='project';")"
if [ "$PROJECT_COLLECTIONS" != "3" ]; then
  echo "gate: expected 3 project collections (contact/company/deal), got $PROJECT_COLLECTIONS" >&2; exit 1
fi
echo "artifact ok: platform metadata collections=$EXPECT_COLLECTIONS fields=$EXPECT_FIELDS; project collections=3"

# 8. verify-schema-runtime (06b) MUST be green — it compares the RUNTIME fingerprint (not the DB-exact
#    schemaFingerprint) between the Node config and the Deno edge module. The local registry publishes
#    packages seconds before this check, so disable Deno's minimum-age policy ONLY for this ephemeral
#    registry invocation; the scaffold's normal `npm run verify-schema-runtime` retains Deno's default.
npm run movp -- verify-schema-runtime \
  --config movp.config.mjs \
  --deno-config supabase/functions/mcp/deno.json \
  --edge-schema ./supabase/functions/_shared/schema.ts \
  --deno-minimum-dependency-age 0 \
  | grep -q '"ok":true' || { echo "verify-schema-runtime not ok"; exit 1; }

# 9. Load env + mint a real member JWT (same gotrue flow as slice-e2e).
eval "$(supabase status -o env | sed 's/^\([A-Z_]*\)=/export \1=/')"
: "${API_URL:?}"; : "${ANON_KEY:?}"; : "${SERVICE_ROLE_KEY:?}"
curl -sS --connect-timeout 2 --max-time 10 "$API_URL/auth/v1/admin/users" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "content-type: application/json" \
  -d '{"email":"crm@example.test","password":"Passw0rd!1","email_confirm":true}' >/dev/null
TOKEN="$(curl -sS --connect-timeout 2 --max-time 10 "$API_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -d '{"email":"crm@example.test","password":"Passw0rd!1"}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).access_token))')"
[ -n "$TOKEN" ] || { echo "failed to mint token"; exit 1; }
USER_ID="$(node -e 'const t=process.argv[1].split(".")[1];process.stdout.write(JSON.parse(Buffer.from(t,"base64url")).sub)' "$TOKEN")"
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -c "insert into public.workspace (id,name) values ('$WS','CRM') on conflict do nothing;" \
  -c "insert into public.workspace_membership (workspace_id,user_id,role) values ('$WS','$USER_ID','owner') on conflict do nothing;"

# 10. Serve the scaffold's REAL edge functions using the env-file pattern (shell-assigned env vars can
#     fail to propagate into the edge runtime on this stack — keep MOVP_JWT_ISSUER in a file).
FN_ENV_FILE="supabase/.env.local"
# These registry overrides are test-only: the packages were published seconds ago to Verdaccio.
# Normal scaffolds resolve public npm and keep Deno's default minimum dependency age.
printf 'MOVP_JWT_ISSUER=%s\nNPM_CONFIG_REGISTRY=http://host.docker.internal:4873\nNPM_CONFIG_MIN_RELEASE_AGE=0\n' \
  "$API_URL/auth/v1" >"$FN_ENV_FILE"
# The CLI serves every function and takes no positional function list.
supabase functions serve --env-file "$FN_ENV_FILE" >"$WORK/functions.log" 2>&1 &
FN_PID=$!
GRAPHQL_READY=0
for _ in $(seq 1 60); do
  BODY="$(curl -sS --connect-timeout 2 --max-time 10 "$API_URL/functions/v1/graphql" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
    -H "content-type: application/json" -d '{"query":"query{__typename}"}' || true)"
  printf '%s' "$BODY" | grep -q '"__typename"' && { GRAPHQL_READY=1; break; }
  sleep 1
done
[ "$GRAPHQL_READY" = "1" ] || { echo "graphql not ready"; tail -n 120 "$WORK/functions.log"; exit 1; }

# 11. Create a contact via the project-aware CLI, then list it back over the REAL surfaces.
SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" MOVP_ACCESS_TOKEN="$TOKEN" \
  npm run movp -- company create --workspace "$WS" --name "Acme Corp" >/dev/null
SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" MOVP_ACCESS_TOKEN="$TOKEN" \
  npm run movp -- company list --workspace "$WS" | grep -q 'Acme Corp' || { echo "CLI create/list failed"; exit 1; }

# 12. Authenticated GraphQL query over HTTP hits the project collection.
GQL="$(curl -sS --connect-timeout 2 --max-time 30 "$API_URL/functions/v1/graphql" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" \
  -d "{\"query\":\"query{companies(workspaceId:\\\"$WS\\\", first:20){items{id name}}}\"}")"
echo "$GQL" | grep -q 'Acme Corp' || { echo "GraphQL companies query failed: $GQL"; exit 1; }

# 13. Streamable-MCP tools/call over HTTP creates + reads a project collection tool. The MCP server
#     registers tools as `${collection}.list` = `company.list` (verified packages/mcp/src/server.ts:70).
#     Assert the EXACT tool name is present in tools/list BEFORE calling it (not a loose match).
MCP_LIST="$(curl -sS --connect-timeout 2 --max-time 30 "$API_URL/functions/v1/mcp" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"
echo "$MCP_LIST" | grep -qF '"company.list"' || { echo "MCP tools/list missing exact tool company.list: $MCP_LIST"; exit 1; }
MCP_CALL="$(curl -sS --connect-timeout 2 --max-time 30 "$API_URL/functions/v1/mcp" -H "Authorization: Bearer $TOKEN" -H "apikey: $ANON_KEY" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"company.list\",\"arguments\":{\"workspaceId\":\"$WS\"}}}")"
echo "$MCP_CALL" | grep -q 'Acme Corp' || { echo "MCP tools/call company.list failed: $MCP_CALL"; exit 1; }

echo "gate: verdaccio-crm-lite acceptance PASS"
