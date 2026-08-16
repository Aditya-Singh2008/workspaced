#!/usr/bin/env bash
#
# Builds the Linux desktop bundles: .deb, .rpm and .AppImage.
#
# Usage:
#   scripts/build-linux.sh                 all three formats
#   scripts/build-linux.sh --bundles deb   just one (any tauri --bundles value)
#   scripts/build-linux.sh --debug         unoptimized build with devtools
#
# Must run on Linux. Tauri does not cross-compile: a Linux bundle needs a Linux
# host (or a Linux CI runner). See AGENTS.md, "Building and releasing".

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

bundles="deb,rpm,appimage"
extra_args=""

while [ $# -gt 0 ]; do
  case "$1" in
    --bundles) shift; [ $# -gt 0 ] || die "--bundles needs a value"; bundles="$1" ;;
    --debug) extra_args="$extra_args --debug" ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

assert_project_root

[ "$(uname -s)" = "Linux" ] \
  || die "this builds Linux bundles and must run on Linux (host is $(uname -s)); Tauri does not cross-compile"

require_command cargo "install Rust via https://rustup.rs"
require_command npm "install Node.js 20 or newer"

# The webview. Without these headers the Rust build fails deep in a dependency
# with an error that does not mention the real cause.
if command -v pkg-config >/dev/null 2>&1; then
  pkg-config --exists webkit2gtk-4.1 \
    || die "webkit2gtk-4.1 development headers are missing — see AGENTS.md, 'Per-platform prerequisites'"
else
  warn "pkg-config not found; skipping the webkit2gtk-4.1 check"
fi

# AppImage packaging shells out to patchelf. Warn rather than fail, since the
# other two formats build fine without it.
case "$bundles" in
  *appimage*)
    command -v patchelf >/dev/null 2>&1 \
      || warn "patchelf not found; the AppImage bundle will probably fail (deb and rpm are unaffected)"

    # linuxdeploy is distributed as an AppImage that bundles its own ancient
    # binutils. Two things go wrong on a current distro, and both are opaque —
    # the bundler only reports "failed to run linuxdeploy":
    #
    #   NO_STRIP               its `strip` cannot parse the `.relr.dyn` sections
    #                          modern toolchains emit, and dies on every shared
    #                          library it tries to shrink.
    #   APPIMAGE_EXTRACT_AND_RUN  it self-mounts through FUSE, which is absent
    #                          in most containers and CI runners; this makes it
    #                          extract to a temp directory instead.
    #
    # Neither changes what ends up in the bundle, so they are set
    # unconditionally rather than probed for.
    export NO_STRIP=true
    export APPIMAGE_EXTRACT_AND_RUN=1
    ;;
esac

[ -d "$PROJECT_ROOT/node_modules" ] || die "dependencies not installed — run 'npm install' first"

log "building Linux bundles: $bundles"
cd "$PROJECT_ROOT"

# `tauri build` runs the frontend build itself via beforeBuildCommand.
# shellcheck disable=SC2086
"$(tauri_cli)" build --bundles "$bundles" $extra_args

profile="release"
case "$extra_args" in *--debug*) profile="debug" ;; esac

log ""
log "bundles written to src-tauri/target/$profile/bundle/"
find "src-tauri/target/$profile/bundle" -maxdepth 2 -type f \
  \( -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) 2>/dev/null \
  | sed 's/^/  /' || true
