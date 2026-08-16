/**
 * The two in-app clipboard collections, and the region-capture mode flag.
 *
 * ## Scratch and history are different things, deliberately
 *
 * The brief asks for both and they are easy to confuse, so the distinction is
 * worth stating: **history** is a record of what the user copied — it fills
 * itself, it is capped, and the user never curates it. **Scratch** is a place
 * the user *puts* things — nothing lands there without a deliberate yank, and
 * nothing leaves except by being removed. That is why they have separate
 * keybindings (`Mod+C` versus `Mod+Shift+C`) rather than one action that does
 * both: collecting six quotes from four documents is a different job from
 * "what did I copy a minute ago", and an automatic scratch panel would be full
 * of things nobody chose.
 *
 * Neither survives a restart, which the brief specifies for the history and
 * which the scratch panel inherits for a simpler reason: entries can hold image
 * blobs, and persisting those would mean phase 07 writing megabytes of PNG into
 * the session store for a notes area.
 *
 * ## Object URLs are owned here
 *
 * An image entry carries both the blob (what gets written to the system
 * clipboard) and an object URL (what the panel renders). The URL is created
 * when the entry is added and revoked when it is dropped — from removal, from
 * the history cap, or from a clear. A store that hands out URLs and never
 * revokes them leaks the whole blob behind each one for the life of the
 * session, and a scratch panel is exactly where someone parks twenty screen
 * regions.
 */

import { create } from "zustand";

import type { CopyableContent } from "../../viewers";

export interface ClipEntryBase {
  readonly id: string;
  /** Which tile it came from, for the panel's second line. */
  readonly source: string;
  /** `Date.now()` at capture. Ordering only; never displayed as a wall clock. */
  readonly at: number;
}

export interface TextClipEntry extends ClipEntryBase {
  readonly kind: "text";
  readonly text: string;
}

export interface ImageClipEntry extends ClipEntryBase {
  readonly kind: "image";
  readonly blob: Blob;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  /** Object URL for the preview. Revoked by this store, by nobody else. */
  readonly url: string;
}

export type ClipEntry = TextClipEntry | ImageClipEntry;

/**
 * How many copies the session remembers.
 *
 * Short on purpose: the history is a compact list in a 256px column, and a
 * hundred rows of it would be a search problem rather than a convenience.
 */
export const CLIPBOARD_HISTORY_LIMIT = 25;

interface ClipboardState {
  /** Deliberate collection, newest first. */
  readonly scratch: readonly ClipEntry[];
  /** Automatic record of system-clipboard writes, newest first. */
  readonly history: readonly ClipEntry[];

  /**
   * The tile currently in region-capture mode, if any.
   *
   * Lives here rather than in the layout store because it is one half of a
   * clipboard gesture — the rubber band exists only to produce a copy — and
   * because `RegionCapture` reads it from inside the tile it applies to.
   */
  readonly regionCaptureClientId: string | null;

  addToScratch(content: CopyableContent, source: string): ClipEntry;
  addToHistory(content: CopyableContent, source: string): ClipEntry;
  removeEntry(id: string): void;
  clearScratch(): void;
  clearHistory(): void;
  beginRegionCapture(clientId: string): void;
  endRegionCapture(): void;
}

let entryCounter = 0;

/** Builds an entry, minting the object URL an image preview needs. */
function toEntry(content: CopyableContent, source: string): ClipEntry {
  entryCounter += 1;
  const base = { id: `clip:${entryCounter}`, source, at: Date.now() };

  if (content.kind === "text") return { ...base, kind: "text", text: content.text };

  return {
    ...base,
    kind: "image",
    blob: content.blob,
    mimeType: content.mimeType,
    width: content.width,
    height: content.height,
    url: URL.createObjectURL(content.blob),
  };
}

/** The one place an object URL is released. */
function release(entries: Iterable<ClipEntry>): void {
  for (const entry of entries) {
    if (entry.kind === "image") URL.revokeObjectURL(entry.url);
  }
}

export const useClipboardStore = create<ClipboardState>((set) => ({
  scratch: [],
  history: [],
  regionCaptureClientId: null,

  addToScratch(content, source) {
    const entry = toEntry(content, source);
    set((state) => ({ scratch: [entry, ...state.scratch] }));
    return entry;
  },

  addToHistory(content, source) {
    const entry = toEntry(content, source);
    set((state) => {
      const next = [entry, ...state.history];
      // Everything past the cap goes, and its URLs go with it.
      release(next.slice(CLIPBOARD_HISTORY_LIMIT));
      return { history: next.slice(0, CLIPBOARD_HISTORY_LIMIT) };
    });
    return entry;
  },

  removeEntry(id) {
    set((state) => {
      const gone = [...state.scratch, ...state.history].filter(
        (entry) => entry.id === id,
      );
      if (gone.length === 0) return state;
      release(gone);
      return {
        scratch: state.scratch.filter((entry) => entry.id !== id),
        history: state.history.filter((entry) => entry.id !== id),
      };
    });
  },

  clearScratch() {
    set((state) => {
      release(state.scratch);
      return { scratch: [] };
    });
  },

  clearHistory() {
    set((state) => {
      release(state.history);
      return { history: [] };
    });
  },

  beginRegionCapture(clientId) {
    set({ regionCaptureClientId: clientId });
  },

  endRegionCapture() {
    set({ regionCaptureClientId: null });
  },
}));

/** Turns an entry back into the shape the clipboard writer takes. */
export function entryContent(entry: ClipEntry): CopyableContent {
  return entry.kind === "text"
    ? { kind: "text", text: entry.text }
    : {
        kind: "image",
        blob: entry.blob,
        mimeType: entry.mimeType,
        width: entry.width,
        height: entry.height,
      };
}
