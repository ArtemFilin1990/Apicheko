#!/usr/bin/env bash
set -euo pipefail

echo "[1/2] Unmerged files (if merge in progress):"
git diff --name-only --diff-filter=U || true

echo
echo "[2/2] Conflict markers scan:"
rg -n "^(<<<<<<<|=======|>>>>>>>)" || true
