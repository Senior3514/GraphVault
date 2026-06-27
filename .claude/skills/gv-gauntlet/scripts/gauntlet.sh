#!/usr/bin/env bash
# GraphVault verification gauntlet - mirrors .github/workflows/ci.yml.
# Runs each step in order, stops at the first failure, prints a verdict.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

step() {
  local name="$1"; shift
  printf '\n=== %s ===\n' "$name"
  if "$@"; then
    printf '✅ %s\n' "$name"
  else
    printf '❌ %s FAILED\n' "$name"
    printf '\nGAUNTLET RED at: %s - fix before shipping.\n' "$name"
    exit 1
  fi
}

step "typecheck"    pnpm typecheck
step "lint"         pnpm lint
step "format:check" pnpm format:check
step "tests"        pnpm test
step "build:web"    pnpm run build:web

printf '\nGAUNTLET GREEN - safe to ship.\n'
