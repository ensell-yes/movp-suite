#!/usr/bin/env bash
# Behavioural untrusted-I/O gate: all hostile writes happen in a synthetic tree under $TMPDIR.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TDIR="$(mktemp -d "${TMPDIR:-/tmp}/movp-gallery-guards.XXXXXX")"
trap 'rm -rf "$TDIR"' EXIT
SECRET="$TDIR/fake-secret"
printf 'TOPSECRET-DO-NOT-READ\n' >"$SECRET"

# Build before taking the worktree snapshot; generated dist is an expected precondition, not gate drift.
pnpm --filter create-movp build >/dev/null
node scripts/tree-snapshot.mjs . >"$TDIR/repo-before.txt"

seed_synthetic() {
  rm -rf "$TDIR/marketing-site"
  cp -R templates/marketing-site "$TDIR/marketing-site"
}

run_gate() {
  pnpm exec tsx scripts/check-template-gallery.ts \
    --template=marketing-site --templates-dir "$TDIR" 2>&1 || true
}

expect_reject() {
  local case_name="$1" code="$2" what="$3" out
  out="$(run_gate)"
  if ! printf '%s' "$out" | grep -qF "$code"; then
    echo "FAIL: $case_name was not rejected with $code"
    printf '%s\n' "$out"
    exit 1
  fi
  if ! printf '%s' "$out" | grep -qF "$what"; then
    echo "FAIL: $case_name rejected at the wrong read path ($what)"
    printf '%s\n' "$out"
    exit 1
  fi
  if printf '%s' "$out" | grep -qF 'TOPSECRET-DO-NOT-READ'; then
    echo "FAIL: $case_name read the symlink target"
    exit 1
  fi
  echo "guarded-reads: $case_name rejected ($code), target unread"
}

seed_synthetic
rm -f "$TDIR/marketing-site/supabase/seed.sql"
ln -s "$SECRET" "$TDIR/marketing-site/supabase/seed.sql"
expect_reject 'symlinked seed.sql' 'template_symlink_rejected' 'supabase/seed.sql'

seed_synthetic
rm -f "$TDIR/marketing-site/src/pages/blog/index.astro"
ln -s "$SECRET" "$TDIR/marketing-site/src/pages/blog/index.astro"
expect_reject 'symlinked page' 'template_symlink_rejected' 'src/pages/blog/index.astro'

seed_synthetic
rm -f "$TDIR/marketing-site/supabase/functions/_shared/schema.ts"
ln -s "$SECRET" "$TDIR/marketing-site/supabase/functions/_shared/schema.ts"
expect_reject 'symlinked schema module' 'template_symlink_rejected' 'schema module'

seed_synthetic
head -c 6291456 /dev/zero | tr '\0' 'x' >"$TDIR/marketing-site/supabase/seed.sql"
expect_reject 'oversized seed.sql' 'template_file_too_large' 'supabase/seed.sql'

pnpm exec tsx scripts/check-template-gallery.ts >/dev/null
echo 'guarded-reads: real template tree still passes (default --templates-dir)'

node scripts/tree-snapshot.mjs . >"$TDIR/repo-after.txt"
if ! diff -u "$TDIR/repo-before.txt" "$TDIR/repo-after.txt"; then
  echo 'FAIL: the guards gate wrote under the real repository'
  exit 1
fi
echo 'guarded-reads: real repository byte-unchanged'
echo 'guarded-reads: hostile-tree gate PASS'
