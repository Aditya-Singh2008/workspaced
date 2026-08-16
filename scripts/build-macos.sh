#!/usr/bin/env bash
#
# Builds the macOS desktop bundles: .app and .dmg.
#
# Usage:
#   scripts/build-macos.sh                for this Mac's architecture
#   scripts/build-macos.sh --universal    one binary running native on Intel and Apple silicon
#   scripts/build-macos.sh --bundles app  just the .app, no disk image
#   scripts/build-macos.sh --debug        unoptimized build with devtools
#
# Must run on macOS. Tauri does not cross-compile: a macOS bundle needs a Mac
# (or a macOS CI runner). See AGENTS.md, "Building and releasing".

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

bundles="app,dmg"
extra_args=""
universal=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bundles) shift; [ $# -gt 0 ] || die "--bundles needs a value"; bundles="$1" ;;
    --universal) universal=1 ;;
    --debug) extra_args="$extra_args --debug" ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

assert_project_root

[ "$(uname -s)" = "Darwin" ] \
  || die "this builds macOS bundles and must run on macOS (host is $(uname -s)); Tauri does not cross-compile"

require_command cargo "install Rust via https://rustup.rs"
require_command npm "install Node.js 20 or newer"

xcode-select -p >/dev/null 2>&1 \
  || die "Xcode Command Line Tools are missing — run 'xcode-select --install'"

target_args=""
if [ "$universal" -eq 1 ]; then
  target_args="--target universal-apple-darwin"
  # A universal binary needs both architecture toolchains present; rustup will
  # not add them mid-build.
  for triple in x86_64-apple-darwin aarch64-apple-darwin; do
    rustup target list --installed 2>/dev/null | grep -q "^$triple$" \
      || die "missing Rust target $triple — run 'rustup target add $triple'"
  done
fi

[ -d "$PROJECT_ROOT/node_modules" ] || die "dependencies not installed — run 'npm install' first"

log "building macOS bundles: $bundles${universal:+ (universal)}"
cd "$PROJECT_ROOT"

# `tauri build` runs the frontend build itself via beforeBuildCommand.
# shellcheck disable=SC2086
"$(tauri_cli)" build --bundles "$bundles" $target_args $extra_args

profile="release"
case "$extra_args" in *--debug*) profile="debug" ;; esac

bundle_dir="src-tauri/target/$profile/bundle"
[ "$universal" -eq 1 ] && bundle_dir="src-tauri/target/universal-apple-darwin/$profile/bundle"

log ""
log "bundles written to $bundle_dir/"
find "$bundle_dir" -maxdepth 2 \( -name '*.dmg' -o -name '*.app' \) 2>/dev/null \
  | sed 's/^/  /' || true
log ""
log "note: unsigned bundles are blocked by Gatekeeper on other machines."
log "distribution needs an Apple Developer ID for signing and notarization."
