/**
 * Platform-correct keyboard accelerators: parsing, matching, and display.
 *
 * The whole point of this module is the `Mod` modifier. Windows and Linux use
 * Ctrl as the primary shortcut modifier; macOS uses Cmd. Writing `"Mod+O"`
 * once and resolving it per platform is what keeps that convention out of
 * every call site — AGENTS.md ("Platform targets") requires the keybind
 * registry to abstract this from day one.
 *
 * Everything that displays or matches a keybind must go through
 * {@link formatAccelerator} and {@link matchesAccelerator}, including the
 * phase 02 reference modal's rendered labels. A component that formats a
 * shortcut by hand will be wrong on one of the three platforms.
 */

import { currentPlatform, type HostPlatform } from "../../platform";

/**
 * `Mod` is the platform's primary shortcut modifier: Cmd on macOS, Ctrl on
 * Windows and Linux. Use it for anything conventional (open, save, copy).
 *
 * The literal `Ctrl` / `Meta` names are for the rare binding that genuinely
 * means one specific physical key on every platform.
 */
export type KeyModifier = "Mod" | "Ctrl" | "Alt" | "Shift" | "Meta";

export interface Accelerator {
  /** Normalized key: lowercase for single characters, canonical name otherwise. */
  readonly key: string;
  readonly modifiers: readonly KeyModifier[];
}

const MODIFIER_ALIASES: Readonly<Record<string, KeyModifier>> = {
  mod: "Mod",
  cmdorctrl: "Mod",
  commandorcontrol: "Mod",
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  win: "Meta",
};

/** Named keys whose canonical casing we preserve, keyed by their lowercase form. */
const NAMED_KEYS = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "Insert",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
] as const;

const NAMED_KEY_BY_LOWER = new Map(NAMED_KEYS.map((name) => [name.toLowerCase(), name]));

/**
 * Normalizes a key name or a `KeyboardEvent.key` to the accelerator form.
 *
 * Single characters lowercase, so `Shift+P` (which reports `"P"`) and a plain
 * `p` compare equal and the Shift requirement is carried by the modifier list
 * rather than by the key's case.
 */
function normalizeKey(raw: string): string {
  if (raw === " ") return "Space";
  const named = NAMED_KEY_BY_LOWER.get(raw.toLowerCase());
  if (named) return named;
  return raw.length === 1 ? raw.toLowerCase() : raw;
}

export class InvalidAcceleratorError extends Error {
  constructor(spec: string, reason: string) {
    super(`invalid accelerator "${spec}": ${reason}`);
    this.name = "InvalidAcceleratorError";
  }
}

/**
 * Parses a spec like `"Mod+Shift+P"`, `"Mod+ArrowLeft"`, or `"Mod++"`.
 *
 * Modifier order in the spec is irrelevant; display order is canonical and
 * decided by {@link formatAccelerator}.
 */
export function parseAccelerator(spec: string): Accelerator {
  const parts = spec.split("+");

  // A trailing empty segment means the key itself is "+", as in "Mod++".
  if (parts.length > 1 && parts[parts.length - 1] === "") {
    parts.pop();
    parts[parts.length - 1] = "+";
  }

  const keyToken = parts.pop()?.trim();
  if (!keyToken) throw new InvalidAcceleratorError(spec, "no key");

  const modifiers: KeyModifier[] = [];
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.trim().toLowerCase()];
    if (!modifier) throw new InvalidAcceleratorError(spec, `unknown modifier "${part}"`);
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }

  return { key: normalizeKey(keyToken), modifiers };
}

interface ResolvedModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** Collapses the abstract modifier list into the physical keys for a platform. */
function resolveModifiers(
  modifiers: readonly KeyModifier[],
  platform: HostPlatform,
): ResolvedModifiers {
  const mac = platform === "macos";
  const resolved: ResolvedModifiers = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };

  for (const modifier of modifiers) {
    switch (modifier) {
      case "Mod":
        // The entire reason this module exists.
        if (mac) resolved.meta = true;
        else resolved.ctrl = true;
        break;
      case "Ctrl":
        resolved.ctrl = true;
        break;
      case "Alt":
        resolved.alt = true;
        break;
      case "Shift":
        resolved.shift = true;
        break;
      case "Meta":
        resolved.meta = true;
        break;
    }
  }
  return resolved;
}

/**
 * Whether a key press satisfies an accelerator on the given platform.
 *
 * Modifier matching is exact: holding a modifier the accelerator does not name
 * is a non-match, so `Mod+O` does not fire on `Mod+Shift+O`.
 */
export function matchesAccelerator(
  event: KeyboardEvent,
  accelerator: Accelerator,
  platform: HostPlatform = currentPlatform(),
): boolean {
  const want = resolveModifiers(accelerator.modifiers, platform);

  if (event.ctrlKey !== want.ctrl) return false;
  if (event.altKey !== want.alt) return false;
  if (event.shiftKey !== want.shift) return false;
  if (event.metaKey !== want.meta) return false;

  if (normalizeKey(event.key) === accelerator.key) return true;

  // Fall back to the physical key. On macOS, Option+P reports `key === "π"`,
  // and non-US layouts move letters around; `code` survives both.
  if (/^[a-z]$/.test(accelerator.key)) {
    return event.code === `Key${accelerator.key.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(accelerator.key)) {
    return event.code === `Digit${accelerator.key}`;
  }
  return false;
}

/** Modifier glyphs, in Apple's canonical display order. */
const MAC_MODIFIER_ORDER: ReadonlyArray<[keyof ResolvedModifiers, string]> = [
  ["ctrl", "⌃"],
  ["alt", "⌥"],
  ["shift", "⇧"],
  ["meta", "⌘"],
];

/** Modifier words, in the order Windows and Linux conventionally print them. */
const PC_MODIFIER_ORDER: ReadonlyArray<[keyof ResolvedModifiers, string]> = [
  ["ctrl", "Ctrl"],
  ["meta", "Meta"],
  ["alt", "Alt"],
  ["shift", "Shift"],
];

const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Delete: "Del",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

function labelForKey(key: string): string {
  return KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/**
 * The display string for a keybind — `"⇧⌘P"` on macOS, `"Ctrl+Shift+P"` on
 * Windows and Linux.
 *
 * This is the only place a shortcut should be turned into text. The phase 02
 * keybind reference modal renders these, so labels stay correct per platform
 * without the modal knowing which platform it is on.
 */
export function formatAccelerator(
  accelerator: Accelerator,
  platform: HostPlatform = currentPlatform(),
): string {
  const resolved = resolveModifiers(accelerator.modifiers, platform);

  if (platform === "macos") {
    const glyphs = MAC_MODIFIER_ORDER.filter(([flag]) => resolved[flag]).map(
      ([, glyph]) => glyph,
    );
    // macOS renders modifiers as adjacent glyphs with no separator.
    return `${glyphs.join("")}${labelForKey(accelerator.key)}`;
  }

  const words = PC_MODIFIER_ORDER.filter(([flag]) => resolved[flag]).map(([flag, word]) =>
    // The Meta key is branded differently on the two PC platforms.
    flag === "meta" ? (platform === "windows" ? "Win" : "Super") : word,
  );
  return [...words, labelForKey(accelerator.key)].join("+");
}

/** Convenience: parse and format in one step, for static label rendering. */
export function formatAcceleratorSpec(
  spec: string,
  platform: HostPlatform = currentPlatform(),
): string {
  return formatAccelerator(parseAccelerator(spec), platform);
}
