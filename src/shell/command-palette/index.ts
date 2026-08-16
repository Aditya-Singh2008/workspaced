/**
 * Command palette.
 *
 * `commands.ts` derives what can be run from the sources that already declare
 * it — the dock's action list, the focused plugin's contributions, the shell's
 * own verbs — and is a pure function over its context, which is what lets the
 * self-test check the list without a window. `CommandPalette.tsx` is the
 * overlay and holds nothing but the query and the highlighted row.
 *
 * Built by phase 06 (`prompts/06-clipboard-search-command-palette.md`).
 */

export {
  buildPaletteCommands,
  filterPaletteCommands,
  focusedTileLabel,
  groupPaletteCommands,
  PALETTE_GROUPS,
} from "./commands";
export type {
  PaletteCommand,
  PaletteContext,
  PaletteShellActions,
} from "./commands";

export { CommandPalette } from "./CommandPalette";
