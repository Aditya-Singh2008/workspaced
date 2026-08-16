#!/usr/bin/env bash
#
# Removes build output, compiled binaries and runtime cruft so the project can
# be archived or shared without carrying gigabytes of Rust build artifacts.
#
# Usage:
#   scripts/clean.sh          build output, Rust target, generated schemas, caches
#   scripts/clean.sh --all    the above, plus node_modules
#   scripts/clean.sh --dry    list what would be removed; delete nothing
#
# Keep the target list below in step with .gitignore — see AGENTS.md,
# "Building and releasing".

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

include_dependencies=0
dry_run=0

for arg in "$@"; do
  case "$arg" in
    --all) include_dependencies=1 ;;
    --dry|--dry-run) dry_run=1 ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

assert_project_root

# Paths are relative to the project root, and every one of them is regenerated
# by a build. Nothing here is a source file.
targets="dist src-tauri/target src-tauri/gen node_modules/.vite"
if [ "$include_dependencies" -eq 1 ]; then
  targets="$targets node_modules"
fi

total_kb=0
removed=0

for relative in $targets; do
  absolute="$PROJECT_ROOT/$relative"

  # Belt and braces: never step outside the project, whatever ends up in the
  # list above.
  case "$absolute" in
    "$PROJECT_ROOT"/*) ;;
    *) warn "skipping $relative: outside the project root"; continue ;;
  esac

  [ -e "$absolute" ] || continue

  kb="$(size_kb "$absolute")"
  total_kb=$((total_kb + kb))
  removed=$((removed + 1))

  if [ "$dry_run" -eq 1 ]; then
    log "would remove  $relative  ($(human_size "$kb"))"
  else
    rm -rf "$absolute"
    log "removed  $relative  ($(human_size "$kb"))"
  fi
done

if [ "$removed" -eq 0 ]; then
  log "already clean"
  exit 0
fi

if [ "$dry_run" -eq 1 ]; then
  log "would free $(human_size "$total_kb") across $removed path(s)"
else
  log "freed $(human_size "$total_kb") across $removed path(s)"
fi

if [ "$include_dependencies" -eq 1 ]; then
  log "run 'npm install' before building again"
else
  log "node_modules kept; pass --all to remove it too"
fi
