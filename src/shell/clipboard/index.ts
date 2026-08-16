/**
 * Cross-viewer clipboard, scratch panel and history. Reads copyable content
 * through `ViewerInstance.copy` rather than the DOM selection, since not every
 * plugin renders selectable DOM text.
 *
 * Four pieces, and the split is by what they talk to:
 *
 *   - `system.ts`   the only code that touches the OS clipboard;
 *   - `store.ts`    the two in-app collections and their object-URL lifetimes;
 *   - `actions.ts`  the verbs, reaching plugins only through `ViewerCopyApi`;
 *   - the two components, which are chrome over the above and hold no state
 *     of their own.
 *
 * Built by phase 06 (`prompts/06-clipboard-search-command-palette.md`).
 */

export {
  canCopyFromFocusedTile,
  canCopyRegionFromFocusedTile,
  copyEntryToSystemClipboard,
  copyFocusedTileToSystemClipboard,
  copyRegion,
  copySourceFor,
  focusedCopySource,
  preferredContent,
  startRegionCapture,
  yankFocusedTileToScratch,
} from "./actions";
export type { CopySource } from "./actions";

export {
  CLIPBOARD_HISTORY_LIMIT,
  entryContent,
  useClipboardStore,
} from "./store";
export type { ClipEntry, ImageClipEntry, TextClipEntry } from "./store";

export {
  CLIPBOARD_IMAGE_TYPE,
  describeText,
  ellipsize,
  writeToSystemClipboard,
} from "./system";
export type { ClipboardWriteResult } from "./system";

export { RegionCapture } from "./RegionCapture";
export { ScratchPanel } from "./ScratchPanel";
export { useClipboardKeybinds } from "./useClipboardKeybinds";
