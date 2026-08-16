#!/usr/bin/env bash
# Shared helpers for the build and clean scripts.
#
# Written for bash 3.2, which is what macOS still ships. No associative arrays,
# no `mapfile`, no `${var,,}` — those are bash 4+ and would break on a stock Mac.

set -euo pipefail

# Absolute path to the project root, resolved from this file's own location so
# the scripts work regardless of the directory they are invoked from.
# `readlink -f` is GNU-only, hence the cd/pwd dance.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$LIB_DIR/.." && pwd)"

log()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Refuses to operate on anything but this project. The clean script deletes
# `src-tauri/target/`, so it had better be certain which one it means.
assert_project_root() {
  local manifest="$PROJECT_ROOT/package.json"
  [ -f "$manifest" ] || die "no package.json at $PROJECT_ROOT"
  grep -q '"name": *"workspace-app"' "$manifest" \
    || die "$PROJECT_ROOT is not the workspace-app project"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed${2:+ ($2)}"
}

# Disk usage of a path in kilobytes. `du -sk` behaves the same on GNU and BSD.
size_kb() {
  [ -e "$1" ] || { printf '0'; return; }
  du -sk "$1" 2>/dev/null | awk '{print $1}'
}

human_size() {
  awk -v kb="$1" 'BEGIN {
    if (kb < 1024)          { printf "%d KB", kb }
    else if (kb < 1048576)  { printf "%.1f MB", kb / 1024 }
    else                    { printf "%.1f GB", kb / 1048576 }
  }'
}

# The Tauri CLI from node_modules. Preferred over `npx`, which may try to reach
# the network when the local copy is missing.
tauri_cli() {
  local cli="$PROJECT_ROOT/node_modules/.bin/tauri"
  [ -x "$cli" ] || die "Tauri CLI not found — run 'npm install' first"
  printf '%s' "$cli"
}
