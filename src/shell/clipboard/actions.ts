/**
 * The clipboard verbs, in one place, so the keybind, the toolbar-adjacent
 * palette entry and the scratch panel all run the same code.
 *
 * Everything here reaches the focused tile through `ViewerCopyApi` and nothing
 * else. That is the phase brief's first task in as many words — *"implement text
 * copy using each plugin's contract-defined copy method … so the shell never
 * assumes DOM text selection exists"* — and it is not a formality: the image
 * plugin renders to a canvas, the video plugin to a native surface below the
 * webview, and `window.getSelection()` is empty in both. Asking the plugin is
 * the only question that has an answer for all three.
 *
 * ## What "copy" means when nothing is selected
 *
 * Selection first, then the whole file. The fallback matters because "selection"
 * is not a concept every plugin has — the image plugin says so explicitly, and
 * a `Mod+C` that reported "nothing selected" on every image tile would be
 * useless there. Falling through to `{ kind: "all" }` gives each plugin its own
 * honest answer to "copy this": the document's text for a PDF, the picture for
 * an image, the current frame for a video. The status bar says which of the two
 * happened, so the fallback is never silent.
 *
 * The shell does *not* fall back to "the current subdivision", which would read
 * better for a long PDF, because the contract has no way to ask which
 * subdivision a tile is currently showing. Inventing one for a fallback would
 * be a contract extension in service of a nicety; `reveal` and
 * `subdivisionCount` exist because features needed them.
 */

import { getViewerInstance, type CopyableContent, type CopyScope } from "../../viewers";
import { clientLabel, useWorkspaceStore } from "../../store";
import { announceStatus } from "../statusbar/messages";
import { useClipboardStore, entryContent, type ClipEntry } from "./store";
import { writeToSystemClipboard } from "./system";
import type { NormalizedRect } from "../../viewers";

/** The focused tile, when it has something the shell can copy from. */
export interface CopySource {
  readonly clientId: string;
  /** What the tile is called, for the status bar and the entry's second line. */
  readonly label: string;
  readonly copy: NonNullable<ReturnType<typeof copyApiFor>>;
}

function copyApiFor(clientId: string) {
  const instance = getViewerInstance(clientId);
  if (!instance?.capabilities.copy) return undefined;
  return instance.copy;
}

export function copySourceFor(clientId: string | null): CopySource | null {
  if (!clientId) return null;
  const copy = copyApiFor(clientId);
  if (!copy) return null;
  const client = useWorkspaceStore
    .getState()
    .clients.find((candidate) => candidate.id === clientId);
  return { clientId, label: client ? clientLabel(client) : clientId, copy };
}

/** The focused tile's copy API, or `null` when it has none. */
export function focusedCopySource(): CopySource | null {
  return copySourceFor(useWorkspaceStore.getState().activeClientId);
}

/** Backs both clipboard bindings' `enabled()`. */
export function canCopyFromFocusedTile(): boolean {
  return focusedCopySource() !== null;
}

/** Whether the focused tile can answer "what is under this box". */
export function canCopyRegionFromFocusedTile(): boolean {
  return focusedCopySource()?.copy.locateRegion !== undefined;
}

/**
 * Picks one flavour out of what a plugin offers.
 *
 * The contract says a region "may legitimately yield both text and an image;
 * the shell decides which flavors to put on the clipboard", and this is that
 * decision: **text wins when there is any.** Text pastes into a search box, an
 * editor and a chat window; a picture of the same words pastes usefully into
 * about one of those. The image is still reachable — the region-copy gesture
 * asks for it by name when the user holds the modifier.
 */
export function preferredContent(
  contents: readonly CopyableContent[],
  prefer: "text" | "image" = "text",
): CopyableContent | null {
  return (
    contents.find((content) => content.kind === prefer) ??
    contents[0] ??
    null
  );
}

async function extract(
  source: CopySource,
  scope: CopyScope,
): Promise<readonly CopyableContent[]> {
  try {
    return await source.copy.getCopyable(scope);
  } catch (thrown) {
    // A plugin that throws here must not take the shortcut down with it; the
    // contract's "failures are local" rule applies to the clipboard too.
    console.error(`[clipboard] ${source.label} failed to produce copyable content`, thrown);
    return [];
  }
}

/**
 * Selection, else the whole file. Returns the content and which of the two it
 * turned out to be, so the caller can say so.
 */
async function copyableFromTile(
  source: CopySource,
  prefer: "text" | "image" = "text",
): Promise<{ content: CopyableContent; scope: "selection" | "all" } | null> {
  const selected = preferredContent(await extract(source, { kind: "selection" }), prefer);
  if (selected) return { content: selected, scope: "selection" };

  const all = preferredContent(await extract(source, { kind: "all" }), prefer);
  return all ? { content: all, scope: "all" } : null;
}

/** `Mod+C`: the focused tile's content onto the system clipboard. */
export async function copyFocusedTileToSystemClipboard(): Promise<boolean> {
  const source = focusedCopySource();
  if (!source) {
    announceStatus("this tile has nothing to copy", "warn");
    return false;
  }

  const found = await copyableFromTile(source);
  if (!found) {
    announceStatus("there is nothing to copy", "warn");
    return false;
  }

  return await putOnSystemClipboard(found.content, source.label, {
    suffix: found.scope === "all" ? " (the whole file)" : "",
  });
}

/** `Mod+Shift+C`: the same content, into the scratch panel instead. */
export async function yankFocusedTileToScratch(): Promise<boolean> {
  const source = focusedCopySource();
  if (!source) {
    announceStatus("this tile has nothing to yank", "warn");
    return false;
  }

  const found = await copyableFromTile(source);
  if (!found) {
    announceStatus("there is nothing to yank", "warn");
    return false;
  }

  useClipboardStore.getState().addToScratch(found.content, source.label);
  announceStatus(
    found.content.kind === "text"
      ? "yanked the text to the scratch panel"
      : "yanked the image to the scratch panel",
  );
  return true;
}

/**
 * The region gesture's other half: a box the user dragged over a tile, turned
 * into a location by the plugin and then into clipboard content.
 *
 * Prefers the *image* flavour, which is the difference between this and
 * `Mod+C`. A rubber band around a diagram means "give me that picture"; if the
 * user wanted the words under it they would have selected them.
 */
export async function copyRegion(
  clientId: string,
  tileRect: NormalizedRect,
  target: "clipboard" | "scratch" = "clipboard",
): Promise<boolean> {
  const source = copySourceFor(clientId);
  const locate = source?.copy.locateRegion;
  if (!source || !locate) {
    announceStatus("this tile does not support region copy", "warn");
    return false;
  }

  const location = locate(tileRect);
  if (!location) {
    announceStatus("that box is not over anything copyable", "warn");
    return false;
  }

  const contents = await extract(source, {
    kind: "region",
    subdivision: location.subdivision,
    rect: location.rect ?? { x: 0, y: 0, width: 1, height: 1 },
  });
  const content = preferredContent(contents, "image");
  if (!content) {
    announceStatus("that region produced nothing to copy", "warn");
    return false;
  }

  if (target === "scratch") {
    useClipboardStore.getState().addToScratch(content, source.label);
    announceStatus("yanked the region to the scratch panel");
    return true;
  }

  return await putOnSystemClipboard(content, source.label);
}

/** The scratch panel's and history's "put this back on the clipboard". */
export async function copyEntryToSystemClipboard(entry: ClipEntry): Promise<boolean> {
  const result = await writeToSystemClipboard(entryContent(entry));
  announceStatus(result.message, result.ok ? "info" : "warn");
  return result.ok;
}

/**
 * The single path onto the system clipboard, and the single place a copy is
 * recorded in the history — so an entry in that list is exactly "something this
 * app put on the clipboard", never "something it tried to".
 */
async function putOnSystemClipboard(
  content: CopyableContent,
  sourceLabel: string,
  options?: { readonly suffix?: string },
): Promise<boolean> {
  const result = await writeToSystemClipboard(content);
  if (result.ok) useClipboardStore.getState().addToHistory(content, sourceLabel);
  announceStatus(
    result.ok ? `${result.message}${options?.suffix ?? ""}` : result.message,
    result.ok ? "info" : "warn",
  );
  return result.ok;
}

/** Starts the rubber band over the focused tile. Cancelled with Escape. */
export function startRegionCapture(): void {
  const source = focusedCopySource();
  if (!source || !source.copy.locateRegion) {
    announceStatus("this tile does not support region copy", "warn");
    return;
  }
  useClipboardStore.getState().beginRegionCapture(source.clientId);
  // The only place the shift variant is discoverable: the gesture has no
  // palette entry of its own and no chip in the reference modal.
  announceStatus("drag a box to copy it — shift to yank instead — escape to cancel");
}
