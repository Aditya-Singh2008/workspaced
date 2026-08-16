/**
 * The keybind registry: the single place a keyboard shortcut is declared,
 * dispatched from, and listed in the reference modal.
 *
 * Three properties matter and everything here exists to hold them:
 *
 * 1. **Platform correctness.** Bindings are declared with `Mod`, never `Ctrl`
 *    or `Cmd`, and matched and rendered exclusively through `./accelerator.ts`.
 *    No call site ever asks which OS it is on.
 * 2. **Contribution, not modification.** Later phases add page navigation,
 *    zoom and annotation bindings by calling {@link registerKeybinds} with
 *    their own group — the reference modal renders whatever is registered and
 *    never needs editing. Groups are declared separately from bindings so a
 *    phase can order its section without knowing about the others.
 * 3. **Discoverability.** Every binding carries a human label and a group, so
 *    "there is a shortcut for this" is answerable from the UI rather than from
 *    the source.
 *
 * Registration is dynamic (a binding lives as long as the component that owns
 * it), which is why this is a mutable registry with a subscription rather than
 * a static table.
 */

import { currentPlatform } from "../../platform";
import {
  formatAccelerator,
  matchesAccelerator,
  parseAccelerator,
  type Accelerator,
} from "./accelerator";

/** A titled section of the reference modal. */
export interface KeybindGroup {
  readonly id: string;
  readonly title: string;
  /** Lower sorts first. Groups without a declaration sort last, by id. */
  readonly order?: number;
}

export interface KeybindDefinition {
  /** Stable, namespaced — `"layout.toggleMonocle"`. Unique while registered. */
  readonly id: string;

  /** Which {@link KeybindGroup} this belongs to in the reference modal. */
  readonly group: string;

  /** Imperative and short: "toggle monocle", not "Toggles the monocle mode". */
  readonly label: string;

  /**
   * Accelerator specs, in `Mod+Shift+P` form. More than one is allowed so a
   * binding can have an alias (`Mod+=` and `Mod++`); the first is the one the
   * reference modal shows.
   */
  readonly keys: readonly string[];

  /** Lower sorts first within the group. */
  readonly order?: number;

  /** Registered and dispatchable, but not listed. For dev-only helpers. */
  readonly hidden?: boolean;

  /**
   * Let the binding fire while a text field has focus. Off by default, and
   * only consulted for unmodified keys — `Mod+O` always fires, a bare `j`
   * never steals a keystroke from an input.
   */
  readonly allowInTextInput?: boolean;

  /**
   * Whether the action applies right now. A binding that is not enabled does
   * not consume the key press, so a lower-priority binding can still take it.
   * Still listed in the reference modal, marked unavailable.
   */
  enabled?(): boolean;

  run(): void;
}

/** A definition plus its parsed accelerators. What consumers read. */
export interface RegisteredKeybind extends KeybindDefinition {
  readonly accelerators: readonly Accelerator[];
}

/** A group with its bindings, ready to render. */
export interface KeybindSection {
  readonly group: KeybindGroup;
  readonly keybinds: readonly RegisteredKeybind[];
}

const groups = new Map<string, KeybindGroup>();
/** Insertion-ordered: earlier registrations win a contested key press. */
const keybinds = new Map<string, RegisteredKeybind>();
const listeners = new Set<() => void>();

let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch (thrown) {
      console.error("[keybinds] listener threw", thrown);
    }
  }
}

export function registerKeybindGroup(group: KeybindGroup): void {
  groups.set(group.id, group);
  notify();
}

/**
 * Registers bindings and returns the function that removes them again.
 *
 * A duplicate id replaces the previous binding rather than throwing: hot
 * reload and remount both re-register, and failing there would be noise, not
 * signal. Genuine conflicts are about *keys*, not ids — see
 * {@link findKeybindConflicts}.
 */
export function registerKeybinds(
  definitions: readonly KeybindDefinition[],
): () => void {
  const registered: string[] = [];

  for (const definition of definitions) {
    keybinds.set(definition.id, {
      ...definition,
      accelerators: definition.keys.map(parseAccelerator),
    });
    registered.push(definition.id);
  }

  notify();

  return () => {
    for (const id of registered) keybinds.delete(id);
    notify();
  };
}

export function listKeybinds(): readonly RegisteredKeybind[] {
  return [...keybinds.values()];
}

/**
 * Everything listed, grouped and sorted the way the reference modal renders
 * it. Bindings whose group was never declared get a section of their own so a
 * contribution is never silently dropped.
 */
export function listKeybindSections(): readonly KeybindSection[] {
  const byGroup = new Map<string, RegisteredKeybind[]>();

  for (const keybind of keybinds.values()) {
    if (keybind.hidden) continue;
    const bucket = byGroup.get(keybind.group);
    if (bucket) bucket.push(keybind);
    else byGroup.set(keybind.group, [keybind]);
  }

  const sections = [...byGroup.entries()].map(([id, entries]) => ({
    group: groups.get(id) ?? { id, title: id },
    keybinds: entries.sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label),
    ),
  }));

  return sections.sort(
    (a, b) =>
      (a.group.order ?? Number.MAX_SAFE_INTEGER) -
        (b.group.order ?? Number.MAX_SAFE_INTEGER) ||
      a.group.id.localeCompare(b.group.id),
  );
}

/** Re-renders anything displaying the registry. */
export function subscribeToKeybinds(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshot for `useSyncExternalStore`. */
export function keybindsVersion(): number {
  return version;
}

/**
 * Two bindings that would answer the same key press on the given platform.
 *
 * Worth checking explicitly because `Mod` collapses differently per platform:
 * `Meta+K` and `Mod+K` are distinct on Linux and identical on macOS, so a
 * conflict can exist on a machine nobody is developing on.
 */
export function findKeybindConflicts(
  platform = currentPlatform(),
): readonly (readonly [RegisteredKeybind, RegisteredKeybind])[] {
  const conflicts: (readonly [RegisteredKeybind, RegisteredKeybind])[] = [];
  const seen = new Map<string, RegisteredKeybind>();

  for (const keybind of keybinds.values()) {
    for (const accelerator of keybind.accelerators) {
      // The formatted label is a faithful key for this: it is exactly the set
      // of physical keys the accelerator resolves to on this platform.
      const signature = formatAccelerator(accelerator, platform);
      const previous = seen.get(signature);
      if (previous) conflicts.push([previous, keybind] as const);
      else seen.set(signature, keybind);
    }
  }

  return conflicts;
}

/**
 * Whether the key press landed somewhere the user is typing.
 *
 * Exported because the guard has a second consumer since phase 06: `Mod+C`
 * carries a modifier, so it is dispatched even while a text field has focus,
 * and a shell binding that swallowed the browser's own copy inside the search
 * box would be a bug the registry cannot see. That binding reports itself
 * *unavailable* while typing instead, which leaves the key press for the
 * platform — the same "not enabled does not consume" property annotate mode
 * relies on.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  // Checkboxes, radios and buttons are not text entry; they should not swallow
  // a bare-letter binding.
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "reset", "range"].includes(type);
}

/** Whether an accelerator carries a modifier that makes it safe while typing. */
function hasNonShiftModifier(accelerator: Accelerator): boolean {
  return accelerator.modifiers.some((modifier) => modifier !== "Shift");
}

/**
 * Runs the first enabled binding that matches, and reports whether one did.
 *
 * Exported separately from {@link installKeybindListener} so the self-test can
 * dispatch synthetic events without touching the window.
 */
export function dispatchKeybind(
  event: KeyboardEvent,
  platform = currentPlatform(),
): RegisteredKeybind | null {
  const typing = isTextEntryTarget(event.target);

  for (const keybind of keybinds.values()) {
    const matched = keybind.accelerators.some((accelerator) => {
      if (typing && !keybind.allowInTextInput && !hasNonShiftModifier(accelerator)) {
        return false;
      }
      return matchesAccelerator(event, accelerator, platform);
    });
    if (!matched) continue;
    // An unavailable action leaves the key press for someone else rather than
    // consuming it silently.
    if (keybind.enabled && !keybind.enabled()) continue;

    try {
      keybind.run();
    } catch (thrown) {
      console.error(`[keybinds] "${keybind.id}" threw`, thrown);
    }
    return keybind;
  }

  return null;
}

/**
 * Installs the single global `keydown` handler. Called once by the app shell.
 *
 * Capture phase, so a binding wins over a focused widget's own handling of the
 * same key; the text-entry guard above is what keeps that from being rude.
 */
export function installKeybindListener(target: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    // Ignore the synthetic keydown a held key repeats into an IME composition.
    if (event.isComposing) return;
    if (dispatchKeybind(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => target.removeEventListener("keydown", onKeyDown, { capture: true });
}

/** Test/teardown helper. */
export function clearKeybinds(): void {
  keybinds.clear();
  groups.clear();
  notify();
}
