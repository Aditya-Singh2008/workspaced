/**
 * Which desktop OS we are running on.
 *
 * Not in AGENTS.md's module map for the same reason as `src/files/`: the map
 * predates the "Platform targets" section. It is shared rather than living
 * inside `shell/keybinds/` because later phases need it too — phase 03/04 for
 * webkit2gtk rendering differences on Linux, phase 06 for WKWebView clipboard
 * behavior on macOS.
 *
 * The value comes from Rust (`src-tauri/src/platform.rs`), where the compile
 * target is a fact. `navigator.userAgent` is only a fallback for contexts with
 * no Tauri IPC — a plain browser running the verification harness.
 */

import { invoke } from "@tauri-apps/api/core";

/** The three supported targets. Mobile is out of scope. */
export type HostPlatform = "windows" | "macos" | "linux";

/** How the current value was obtained. Diagnostic only. */
export type PlatformSource = "unresolved" | "ipc" | "user-agent";

let resolved: HostPlatform | null = null;
let source: PlatformSource = "unresolved";

/**
 * Best guess with no IPC available. Reliable enough to distinguish the three
 * desktop webviews, and only ever used before {@link initPlatform} resolves or
 * outside the Tauri shell entirely.
 */
function guessFromUserAgent(): HostPlatform {
  const agent = navigator.userAgent;
  if (/Mac OS X|Macintosh/i.test(agent)) return "macos";
  if (/Windows/i.test(agent)) return "windows";
  return "linux";
}

/**
 * Resolves the host platform once, from Rust.
 *
 * Called before the first render (see `src/main.tsx`) so every synchronous
 * caller of {@link currentPlatform} sees the authoritative value. Never
 * rejects: outside the Tauri shell it settles on the user-agent guess rather
 * than blocking startup.
 */
export async function initPlatform(): Promise<HostPlatform> {
  if (resolved) return resolved;
  try {
    resolved = await invoke<HostPlatform>("host_platform");
    source = "ipc";
  } catch {
    resolved = guessFromUserAgent();
    source = "user-agent";
  }
  return resolved;
}

/**
 * Where {@link currentPlatform}'s answer came from.
 *
 * Worth surfacing because the Rust answer and the user-agent guess agree on
 * the host you happen to be developing on, which makes a broken IPC path
 * invisible unless you check.
 */
export function platformSource(): PlatformSource {
  return source;
}

/**
 * The host platform, synchronously.
 *
 * Safe in hot paths like `keydown` handling, which cannot await. Falls back to
 * the user-agent guess if called before {@link initPlatform} settles.
 */
export function currentPlatform(): HostPlatform {
  return resolved ?? guessFromUserAgent();
}

/**
 * Whether the primary modifier is Cmd rather than Ctrl.
 *
 * The one platform branch that matters for keybinds — see
 * `src/shell/keybinds/`, which is the only place that should consult it.
 */
export function isMacOS(): boolean {
  return currentPlatform() === "macos";
}

/** Test hook: force a platform so keybind behavior can be checked for all three. */
export function __setPlatformForTesting(platform: HostPlatform | null): void {
  resolved = platform;
  source = platform ? "ipc" : "unresolved";
}
