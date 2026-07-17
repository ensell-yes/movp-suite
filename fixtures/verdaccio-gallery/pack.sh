#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-}"
TEMPLATES=(crm-lite marketing-site support-desk knowledge-base)
PUBLISHABLE=(auth cli codegen core-schema domain editor-sdk flows graphql mcp notifications obs platform richtext search)

if [ -z "$OUT_DIR" ]; then
  echo "usage: pack.sh <outdir>" >&2
  exit 2
fi
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/movp-gallery-pack.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pnpm -w build
pnpm --filter @movp/platform build
pnpm --filter create-movp build

node "$REPO_ROOT/scripts/tree-snapshot.mjs" "$REPO_ROOT" >"$WORK/source-before.txt"
node "$REPO_ROOT/fixtures/verdaccio-gallery/stage-create-movp.mjs" \
  "$REPO_ROOT" "$WORK/create-movp" "${TEMPLATES[@]}"
node "$REPO_ROOT/scripts/tree-snapshot.mjs" "$REPO_ROOT" >"$WORK/source-after.txt"
if ! diff -u "$WORK/source-before.txt" "$WORK/source-after.txt"; then
  echo "gallery pack changed its source tree (paths and hashes above)" >&2
  exit 1
fi

for package in "${PUBLISHABLE[@]}"; do
  (cd "$REPO_ROOT/packages/$package" && pnpm pack --pack-destination "$OUT_DIR" >/dev/null)
done
(cd "$WORK/create-movp" && pnpm pack --pack-destination "$OUT_DIR" >/dev/null)

EXPECTED="$(( ${#PUBLISHABLE[@]} + 1 ))"
ACTUAL="$(find "$OUT_DIR" -maxdepth 1 -type f -name '*.tgz' | wc -l | tr -d ' ')"
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "gallery pack expected $EXPECTED tarballs, found $ACTUAL" >&2
  exit 1
fi
echo "gallery pack: $ACTUAL artifacts -> $OUT_DIR"
