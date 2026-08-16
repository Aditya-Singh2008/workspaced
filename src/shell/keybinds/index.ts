/**
 * Keybind registry, reference modal, and the platform-correct accelerator
 * primitives underneath both.
 *
 * The rules every consumer follows:
 *
 *   - Declare bindings with `Mod`, never `Ctrl` or `Cmd`, so they resolve to
 *     Cmd on macOS and Ctrl on Windows/Linux.
 *   - Match key events only through the registry (`dispatchKeybind`), which
 *     matches with `matchesAccelerator`.
 *   - Render every label, including the reference modal's, only with
 *     `formatAccelerator`.
 *
 * AGENTS.md ("Platform targets") requires this abstraction from day one; the
 * registry and modal landed in phase 02 on top of the phase 01 primitives.
 */

export {
  formatAccelerator,
  formatAcceleratorSpec,
  InvalidAcceleratorError,
  matchesAccelerator,
  parseAccelerator,
} from "./accelerator";
export type { Accelerator, KeyModifier } from "./accelerator";

export {
  clearKeybinds,
  dispatchKeybind,
  findKeybindConflicts,
  installKeybindListener,
  isTextEntryTarget,
  keybindsVersion,
  listKeybinds,
  listKeybindSections,
  registerKeybindGroup,
  registerKeybinds,
  subscribeToKeybinds,
} from "./registry";
export type {
  KeybindDefinition,
  KeybindGroup,
  KeybindSection,
  RegisteredKeybind,
} from "./registry";

export { SHELL_KEYBIND_GROUP } from "./groups";

export { registerViewerKeybinds } from "./contributions";

export { useKeybindRegistry, useKeybinds } from "./useKeybinds";
export { KeybindReference } from "./KeybindReference";
