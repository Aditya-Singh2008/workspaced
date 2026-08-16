/**
 * The two clipboard bindings, registered by the app shell.
 *
 * They live here rather than in a component with a button, because the
 * clipboard has no toolbar control — its mouse paths are the scratch panel and
 * the command palette. Registering from the shell means both are listed in the
 * reference modal whether or not anything is open, exactly like the layout
 * actions (`useDockKeybinds`), and each reports itself unavailable when the
 * focused tile has nothing to copy.
 *
 * ## Why `enabled()` does the work here
 *
 * `Mod+C` carries a modifier, so the registry dispatches it *even while a text
 * field has focus* — that guard only applies to unmodified keys. A shell
 * binding that answered it unconditionally would break copying out of the
 * search box, the palette and every input a later phase adds. Reporting
 * unavailable instead leaves the key press for the platform's own copy, which
 * is precisely the behaviour anyone typing expects. The same rule keeps `Mod+C`
 * out of the way of a tile whose plugin has no copy capability at all.
 *
 * The pair is deliberate and the brief asks for it: two destinations, two
 * keys. `Mod+Shift+C` is the yank, on the modifier the app already uses for
 * "same action, other way round" (`Mod+Enter` / `Mod+Shift+Enter`).
 */

import { isTextEntryTarget, SHELL_KEYBIND_GROUP, useKeybinds } from "../keybinds";
import {
  canCopyFromFocusedTile,
  copyFocusedTileToSystemClipboard,
  yankFocusedTileToScratch,
} from "./actions";

const COPY_KEYS = ["Mod+C"];
const YANK_KEYS = ["Mod+Shift+C"];

/** Available only when there is something to copy and nobody is typing. */
function clipboardBindingEnabled(): boolean {
  if (isTextEntryTarget(document.activeElement)) return false;
  return canCopyFromFocusedTile();
}

export function useClipboardKeybinds(): void {
  useKeybinds([
    {
      id: "shell.copy",
      group: SHELL_KEYBIND_GROUP,
      label: "copy to the system clipboard",
      keys: COPY_KEYS,
      order: 60,
      enabled: clipboardBindingEnabled,
      run: () => void copyFocusedTileToSystemClipboard(),
    },
    {
      id: "shell.yank",
      group: SHELL_KEYBIND_GROUP,
      label: "yank to the scratch panel",
      keys: YANK_KEYS,
      order: 70,
      enabled: clipboardBindingEnabled,
      run: () => void yankFocusedTileToScratch(),
    },
  ]);
}
