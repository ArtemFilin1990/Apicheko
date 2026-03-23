#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/remove_checko_legacy.sh [--apply] [--include-docs]

Removes legacy Python Checko files listed in the task and prints repo lines
that still need manual cleanup.

Options:
  --apply         Actually delete files. Without this flag the script runs in dry-run mode.
  --include-docs  Also report matches under docs/ and archive/.
  -h, --help      Show this help.
USAGE
}

mode="dry-run"
include_docs=0
for arg in "$@"; do
  case "$arg" in
    --apply) mode="apply" ;;
    --include-docs) include_docs=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

TARGET_FILES=(
  "services/checko_api.py"
  "utils/checko_payload.py"
  "tests/test_checko_api.py"
  "tests/test_checko_payload.py"
)

MANUAL_TARGETS=(
  "config/settings.py"
  ".env.example"
  ".dev.vars.example"
  "bot/handlers/search.py"
  "bot/handlers/callbacks.py"
  "bot/cards.py"
  "bot/formatters.py"
  "bot/keyboards.py"
  "bot/main.py"
  "services/__init__.py"
  "tests/test_config.py"
  "tests/test_handlers.py"
  "worker/worker.js"
  "tests/worker_smoke.test.mjs"
  "README.md"
  "wrangler.toml"
)

printf '== Checko legacy cleanup ==\n'
printf 'Repo: %s\n' "$repo_root"
printf 'Mode: %s\n\n' "$mode"

printf '%s\n' '-- File actions --'
for file in "${TARGET_FILES[@]}"; do
  if [[ -e "$file" ]]; then
    if [[ "$mode" == "apply" ]]; then
      rm -f -- "$file"
      printf 'deleted  %s\n' "$file"
    else
      printf 'would delete  %s\n' "$file"
    fi
  else
    printf 'missing  %s\n' "$file"
  fi
done

printf '\n%s\n' '-- Manual cleanup candidates --'
pattern='CHECKO_API_KEY|CHECKO_API_URL|CheckoAPI|CheckoAPIError|checko_api|co:risk|co:fin|co:arb|co:debt|co:ctr|co:his|co:tax|co:own|co:fil|co:okv|/company|/legal-cases|/contracts|/history|/enforcements|/bank|/entrepreneur|/person'

printed_any=0
for file in "${MANUAL_TARGETS[@]}"; do
  if [[ -f "$file" ]]; then
    matches=$(rg -n -H --color=never -e "$pattern" "$file" || true)
    if [[ -n "$matches" ]]; then
      printed_any=1
      printf '\n[%s]\n%s\n' "$file" "$matches"
    fi
  fi
done

if [[ "$include_docs" -eq 1 ]]; then
  printf '\n%s\n' '-- Documentation / archive references --'
  docs_matches=$(rg -n -H --color=never -g 'README.md' -g 'docs/**' -g 'archive/**' -e 'CHECKO|Checko|checko' . || true)
  if [[ -n "$docs_matches" ]]; then
    printed_any=1
    printf '%s\n' "$docs_matches"
  else
    printf 'No documentation references found.\n'
  fi
fi

if [[ "$printed_any" -eq 0 ]]; then
  printf 'No manual cleanup matches found in tracked targets.\n'
fi

printf '\nDone.\n'
if [[ "$mode" == "dry-run" ]]; then
  printf 'Dry-run only. Re-run with --apply to delete files.\n'
fi
