#!/usr/bin/env bash
set -euo pipefail
files=(package.json pnpm-lock.yaml pnpm-workspace.yaml)
if ! git diff --quiet -- "${files[@]}" || ! git diff --cached --quiet -- "${files[@]}"; then
  echo "ROOT MUTATION: spike changed a root workspace file" >&2
  git status --short -- "${files[@]}" >&2
  exit 1
fi
echo "root-clean: ok"
