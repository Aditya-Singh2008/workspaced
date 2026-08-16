/**
 * Verifies that accelerators resolve, match and display correctly on all three
 * platforms. **Dev builds only.**
 *
 * Runs every case against forced `windows` / `macos` / `linux` values rather
 * than only the host, so a macOS regression is caught while developing on
 * Linux. That is the whole risk this module exists to manage.
 */

import { check, report, type SelfTestReport } from "../../dev/selftest";
import type { HostPlatform } from "../../platform";
import { formatAcceleratorSpec, matchesAccelerator, parseAccelerator } from "./accelerator";

/** A synthetic key press. `KeyboardEvent` is constructible, so these are real events. */
function press(
  key: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {},
  code?: string,
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key),
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
    metaKey: modifiers.meta ?? false,
  });
}

function matches(spec: string, event: KeyboardEvent, platform: HostPlatform): boolean {
  return matchesAccelerator(event, parseAccelerator(spec), platform);
}

export function runKeybindSelfTest(): SelfTestReport {
  const checks = [];

  // The core requirement: one spec, the right physical modifier per platform.
  checks.push(
    check(
      "Mod resolves to Ctrl on Windows/Linux",
      matches("Mod+O", press("o", { ctrl: true }), "windows") &&
        matches("Mod+O", press("o", { ctrl: true }), "linux") &&
        !matches("Mod+O", press("o", { meta: true }), "windows"),
      "Ctrl+O matches, Win+O does not",
    ),
  );

  checks.push(
    check(
      "Mod resolves to Cmd on macOS",
      matches("Mod+O", press("o", { meta: true }), "macos") &&
        !matches("Mod+O", press("o", { ctrl: true }), "macos"),
      "Cmd+O matches, Ctrl+O does not",
    ),
  );

  checks.push(
    check(
      "modifier matching is exact",
      !matches("Mod+O", press("o", { ctrl: true, shift: true }), "linux") &&
        matches("Mod+Shift+O", press("O", { ctrl: true, shift: true }), "linux"),
      "Ctrl+Shift+O does not trigger Mod+O",
    ),
  );

  checks.push(
    check(
      "literal Ctrl stays Ctrl on macOS",
      matches("Ctrl+K", press("k", { ctrl: true }), "macos") &&
        !matches("Ctrl+K", press("k", { meta: true }), "macos"),
      "an explicit Ctrl binding is not rewritten to Cmd",
    ),
  );

  // macOS reports Option+P as "π"; the physical code has to carry the match.
  checks.push(
    check(
      "falls back to physical key code",
      matches("Mod+Alt+P", press("π", { meta: true, alt: true }, "KeyP"), "macos"),
      "Option+Cmd+P matches via code=KeyP despite key='π'",
    ),
  );

  checks.push(
    check(
      "named and symbol keys parse",
      matches("Mod+ArrowLeft", press("ArrowLeft", { ctrl: true }), "linux") &&
        parseAccelerator("Mod++").key === "+" &&
        parseAccelerator("Mod+Space").key === "Space",
      "ArrowLeft, the '+' key, and Space all round-trip",
    ),
  );

  // Display labels — what the phase 02 reference modal will render.
  const macLabel = formatAcceleratorSpec("Mod+Shift+P", "macos");
  const winLabel = formatAcceleratorSpec("Mod+Shift+P", "windows");
  const linuxLabel = formatAcceleratorSpec("Mod+Shift+P", "linux");
  checks.push(
    check(
      "labels render per platform",
      macLabel === "⇧⌘P" && winLabel === "Ctrl+Shift+P" && linuxLabel === "Ctrl+Shift+P",
      `macos="${macLabel}" windows="${winLabel}" linux="${linuxLabel}"`,
    ),
  );

  const macArrow = formatAcceleratorSpec("Mod+Alt+ArrowLeft", "macos");
  const winMeta = formatAcceleratorSpec("Meta+K", "windows");
  const linuxMeta = formatAcceleratorSpec("Meta+K", "linux");
  checks.push(
    check(
      "key and Meta labels are platform-idiomatic",
      macArrow === "⌥⌘←" && winMeta === "Win+K" && linuxMeta === "Super+K",
      `macos="${macArrow}" windows="${winMeta}" linux="${linuxMeta}"`,
    ),
  );

  let rejected = false;
  try {
    parseAccelerator("Hyper+K");
  } catch {
    rejected = true;
  }
  checks.push(
    check("rejects unknown modifiers", rejected, "Hyper+K throws InvalidAcceleratorError"),
  );

  return report("keybind accelerators", checks);
}
