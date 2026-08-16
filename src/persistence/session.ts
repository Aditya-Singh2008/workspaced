/**
 * Saving: what a session is made of, and when it is written.
 *
 * ## The write is debounced, and the *collection* is what that buys
 *
 * Every save request is a flag and a timer — nothing is serialized, dockview is
 * not asked for its layout, no plugin is asked for its state. All of that
 * happens in {@link collectSession}, once, when the timer fires. That is what
 * makes it safe for `onDidLayoutChange` to request a save on every frame of a
 * sash drag, which it does: a drag of two hundred events costs two hundred
 * boolean writes and one file write.
 *
 * Two numbers, because one is not enough. {@link SAVE_DEBOUNCE_MS} is the quiet
 * period after the last change, which is what collapses a drag; {@link
 * SAVE_MAX_DELAY_MS} bounds how long a *continuous* stream of changes can hold
 * the write off, because a user who scrubs a video for a minute and then loses
 * power should not lose the minute. The delay is the smaller of the two, so the
 * quiet period never pushes a write past the ceiling.
 *
 * ## Every source of change, and why it is on this list
 *
 * | source | what it changes |
 * | --- | --- |
 * | the dock's `onDidLayoutChange` | panels added, removed, resized, rearranged |
 * | the workspace store | which files are open, which one is focused |
 * | the layout store | the tiling parameters, the gap, the sidebar |
 * | `ViewerHost.requestPersist` | a plugin's own state — zoom, page, playhead |
 * | the annotation store | marks added, moved, deleted, saved |
 *
 * The plugin row is the one the contract already promised ("Debounced by the
 * shell; call it freely on every scroll or zoom change"), and this is the shell
 * keeping that promise.
 *
 * ## What is deliberately not saved
 *
 * The clipboard history and the scratch panel, which phase 06 decided are
 * per-session by design — the scratch panel because its entries can hold image
 * blobs and this record is not the place for megabytes of PNG. The search
 * results, which are derived from files that may have changed. The keybind
 * reference and the command palette, which are overlays, not state.
 */

import { create } from "zustand";

import type { SerializedDockview } from "dockview-react";

import {
  serializeAnnotationDocuments,
  subscribeToAnnotationStore,
  type AnnotationDocumentRecord,
} from "../annotation";
import { getFileHandle } from "../files";
import { getViewerInstance, getViewerPlugin, listViewerPlugins } from "../viewers";
import { useLayoutStore, useWorkspaceStore } from "../store";
import {
  isJsonSafe,
  SESSION_RECORD_VERSION,
  type PersistedPreferences,
  type PersistedSession,
  type PersistedTile,
} from "./record";
import { sessionStorage, type SessionStorage } from "./storage";
import { forgetTilesExcept, recordedFileRef, restoredViewerState } from "./tiles";

/** Quiet period after the last change. */
export const SAVE_DEBOUNCE_MS = 400;

/** Ceiling on how long a continuous stream of changes can defer a write. */
export const SAVE_MAX_DELAY_MS = 2000;

/**
 * How much of the record annotations may take up.
 *
 * A pasted image is base64 on its item, so one screenshot dropped onto a page
 * is a megabyte of the session file, rewritten on every save. The budget keeps
 * the most recently edited documents and drops the rest rather than either
 * refusing to save annotations at all (they are the user's work, and the phase
 * brief requires an in-progress one to survive a restart) or letting a session
 * file grow without limit. Nothing is deleted from the store by this — the
 * documents are still there for the rest of the session.
 */
export const MAX_ANNOTATION_BYTES = 8 * 1024 * 1024;

interface SessionState {
  /** Set by "clear saved session"; see {@link clearSavedSession}. */
  readonly suspended: boolean;
  setSuspended(suspended: boolean): void;
}

/**
 * The one thing about persistence that anything renders: whether this run is
 * still being recorded, which the command palette shows on its clear entry.
 *
 * A store rather than a module flag because that entry has to re-read it — the
 * palette is rebuilt on every open, and a boolean nothing can subscribe to
 * would leave it saying "clear saved session" after it had been cleared. Not
 * `store/layout.ts`: that store is the shell's own preferences, and this is the
 * state of a background job.
 */
export const useSessionStore = create<SessionState>((set) => ({
  suspended: false,
  setSuspended: (suspended) => set({ suspended }),
}));

// ---------------------------------------------------------------------------
// The layout source
// ---------------------------------------------------------------------------

let layoutSource: (() => SerializedDockview | null) | null = null;

/**
 * How the dock hands over its serialization, without this module importing the
 * dock or the dock serializing on every event.
 *
 * A function rather than a value: `toJSON()` walks the whole grid, and calling
 * it on each of a drag's frames to store a result that is thrown away is the
 * exact cost the debounce exists to avoid. `DockingWorkspace` provides it while
 * it is mounted and clears it on unmount, which is also how "the workspace is
 * showing the empty state" arrives here as `null`.
 */
export function provideSessionLayout(
  source: (() => SerializedDockview | null) | null,
): void {
  layoutSource = source;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function tileFor(clientId: string, fileHandleId: string, pluginId: string): PersistedTile | null {
  const handle = fileHandleId ? getFileHandle(fileHandleId) : undefined;
  // A handle that cannot describe itself is an in-memory file (the dev stub
  // tiles, the self-test's fixtures): there is no path to reopen next time, so
  // the tile is left out rather than recorded as something that can only fail.
  const file = handle?.toPersistable() ?? recordedFileRef(clientId) ?? null;
  if (!file) return null;

  const instance = getViewerInstance(clientId);
  const stateVersion = getViewerPlugin(pluginId)?.stateVersion ?? -1;

  let state: unknown;
  if (instance) {
    try {
      state = instance.serialize();
    } catch (thrown) {
      // A plugin that throws from `serialize()` loses its own state and
      // nothing else — the same containment the mount path gives it.
      console.error(`[persistence] "${pluginId}" threw from serialize()`, thrown);
    }
    if (!isJsonSafe(state)) {
      console.error(`[persistence] "${pluginId}" serialized something JSON cannot hold`);
      state = undefined;
    }
  } else {
    // No live instance: either the tile has not mounted yet or its file could
    // not be reopened. Either way the state that was restored into it is still
    // the truth about that tile, so it is carried forward rather than dropped.
    // Without this, quitting while a tile is showing "file not found" would
    // save that tile with its zoom and page reset to defaults.
    state = restoredViewerState(clientId);
  }

  return { clientId, pluginId, stateVersion, file, state };
}

/** A cheap upper bound on a document's size, without serializing it. */
function estimateAnnotationBytes(record: AnnotationDocumentRecord): number {
  let bytes = record.key.length + 64;
  for (const item of record.overlay) {
    bytes += item.kind === "image" ? item.image.base64.length + 256 : 512;
  }
  for (const item of record.text) {
    bytes += item.anchor.quote.length + (item.note?.length ?? 0) + 512;
  }
  return bytes;
}

/** Most recently edited first, kept while the budget lasts. */
function withinAnnotationBudget(
  records: readonly AnnotationDocumentRecord[],
): readonly AnnotationDocumentRecord[] {
  const ordered = [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  const kept: AnnotationDocumentRecord[] = [];
  let bytes = 0;

  for (const record of ordered) {
    const size = estimateAnnotationBytes(record);
    if (bytes + size > MAX_ANNOTATION_BYTES) {
      console.warn(
        `[persistence] not saving annotations for ${record.key}: the session's ` +
          `annotation budget of ${MAX_ANNOTATION_BYTES} bytes is full`,
      );
      continue;
    }
    bytes += size;
    kept.push(record);
  }

  return kept;
}

function collectPreferences(): Record<string, PersistedPreferences> {
  const out: Record<string, PersistedPreferences> = {};

  for (const plugin of listViewerPlugins()) {
    const preferences = plugin.preferences;
    if (!preferences) continue;
    try {
      const value = preferences.serialize();
      if (isJsonSafe(value)) out[plugin.id] = { version: preferences.version, value };
    } catch (thrown) {
      console.error(`[persistence] "${plugin.id}" threw from preferences.serialize()`, thrown);
    }
  }

  return out;
}

/** Everything worth remembering about right now. */
export function collectSession(): PersistedSession {
  const workspace = useWorkspaceStore.getState();
  const layout = useLayoutStore.getState();

  const tiles = workspace.clients
    .map((client) => tileFor(client.id, client.fileHandleId, client.pluginId))
    .filter((tile): tile is PersistedTile => tile !== null);

  const saved = new Set(tiles.map((tile) => tile.clientId));

  return {
    version: SESSION_RECORD_VERSION,
    savedAt: Date.now(),
    tiles,
    // Dropped when a client could not be recorded — an in-memory tile — because
    // a layout naming a panel the restore will not create is one this record
    // cannot honour. The tiling model re-derives a clean grid in that case.
    layout: layoutSource && workspace.clients.length === saved.size ? layoutSource() : null,
    shell: {
      tiling: layout.tiling,
      gapIndex: layout.gapIndex,
      sidebarVisible: layout.sidebarVisible,
      sidebarPanel: layout.sidebarPanel,
      activeClientId: saved.has(workspace.activeClientId ?? "")
        ? workspace.activeClientId
        : null,
    },
    preferences: collectPreferences(),
    annotations: withinAnnotationBudget(serializeAnnotationDocuments()),
  };
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

/**
 * How long to wait after a change, given how long the record has already been
 * dirty.
 *
 * Pure, and separate from the timer, because it is the whole behaviour the
 * phase brief's fourth verification asks about — "debounced layout persistence
 * does not cause noticeable lag or excessive disk writes during rapid
 * resize/drag interactions" — and a self-test that had to actually wait two
 * seconds to check the ceiling is one that would get shortened later.
 */
export function nextSaveDelay(dirtyForMs: number): number {
  return Math.max(0, Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_DELAY_MS - dirtyForMs));
}

export interface SessionWriterOptions {
  collect(): PersistedSession;
  storage(): Promise<SessionStorage>;
}

/**
 * The debounced write loop, as an object rather than a set of module
 * variables.
 *
 * There is exactly one of these in the app. It is a factory anyway because the
 * self-test needs to drive the loop — the coalescing, the flush, the clear —
 * and the first version of that suite did it by swapping the module's storage
 * and resetting its flags, which quietly left the *app's* writer disarmed for
 * the rest of the run: a dev-only test that turned off the feature it was
 * testing. An instance the test owns cannot do that to one it does not.
 */
export function createSessionWriter(options: SessionWriterOptions) {
  let paused = true;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirtySince = 0;
  let writing: Promise<void> | null = null;
  let writes = 0;

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void writeNow();
    }, nextSaveDelay(Date.now() - dirtySince));
  };

  const cancel = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  async function writeNow(): Promise<void> {
    // Serialized against itself: two overlapping writes could land out of
    // order, and the loser would be the newer one.
    if (writing) await writing.catch(() => {});
    if (!dirty || paused) return;

    dirty = false;
    const session = options.collect();

    writing = (async () => {
      const storage = await options.storage();
      await storage.write(session);
      writes += 1;
    })()
      .catch((thrown: unknown) => {
        console.error("[persistence] the session could not be saved", thrown);
      })
      .finally(() => {
        writing = null;
        // Something changed while the write was in flight.
        if (dirty) schedule();
      });

    await writing;
  }

  return {
    /**
     * Notes that something changed and schedules a write. Free to call from
     * anywhere, at any rate, including a pointer-move handler.
     */
    request(): void {
      if (paused) return;
      if (!dirty) {
        dirty = true;
        dirtySince = Date.now();
      }
      schedule();
    },

    /**
     * Writes now, if anything is pending. For the way out of the app, where
     * the debounce is exactly wrong: the last thing the user did is the thing
     * most worth keeping.
     */
    async flush(): Promise<void> {
      cancel();
      await writeNow();
      await writing?.catch(() => {});
    },

    /** Forgets the stored record. Does not decide whether to keep recording. */
    async clear(): Promise<void> {
      cancel();
      dirty = false;
      await writing?.catch(() => {});
      const storage = await options.storage();
      await storage.clear();
    },

    /** Stops recording; anything already pending is dropped. */
    pause(): void {
      paused = true;
      cancel();
      dirty = false;
    },

    resume(): void {
      paused = false;
    },

    get paused(): boolean {
      return paused;
    },

    /** How many times the record has been written. The self-test counts these. */
    get writes(): number {
      return writes;
    },
  };
}

export type SessionWriter = ReturnType<typeof createSessionWriter>;

/**
 * The app's writer. Starts paused: a restore is in progress until
 * {@link armSessionPersistence} says otherwise, and a save during one would
 * write a workspace that has half its tiles.
 */
const writer = createSessionWriter({ collect: collectSession, storage: sessionStorage });

export function requestSessionSave(): void {
  writer.request();
}

export function flushSessionSave(): Promise<void> {
  return writer.flush();
}

/**
 * Stops the app's writer for the duration of something that would otherwise be
 * recorded, and gives back the function that starts it again.
 *
 * One caller: the self-test, whose restore checks put two fixture tiles into
 * the real workspace for a few milliseconds. Without this, a debounce that
 * happened to elapse in the middle of that would save them — and the next
 * launch would open two tiles pointing at files that never existed.
 */
let pauses = 0;

export function pauseSessionWrites(): () => void {
  pauses += 1;
  writer.pause();

  // Counted, and released at most once, because these nest: the dev self-test
  // panel holds one for the whole run and the persistence suite takes another
  // around its restore checks. An inner release that resumed the writer would
  // hand the outer holder a promise it no longer keeps.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pauses -= 1;
    if (pauses === 0 && !useSessionStore.getState().suspended) writer.resume();
  };
}

/**
 * Forgets the saved session, and stops saving this one.
 *
 * The second half is not a side effect, it is the point. "Clear saved session"
 * is asked for when the record has become stale or unwanted, and an app that
 * deleted the record and then rewrote it from the very tiles the user was
 * trying to stop it reopening would be answering a different question. So the
 * rest of this run is not recorded, and the next launch starts empty — which is
 * the phase brief's third verification, and what anyone pressing this means.
 *
 * It touches nothing but the record: no file on disk is read, written, moved or
 * deleted, no tile closes, and every open document keeps its annotations for
 * the rest of the session.
 */
export async function clearSavedSession(): Promise<void> {
  useSessionStore.getState().setSuspended(true);
  writer.pause();
  await writer.clear();
}

/** Whether this run is still being recorded. */
export function isSessionPersistenceSuspended(): boolean {
  return useSessionStore.getState().suspended;
}

/**
 * Starts recording, and returns the function that stops.
 *
 * Called once the restore has finished, never before: every step of a restore
 * changes the stores this subscribes to, and saving halfway through one would
 * write a workspace that has some of its tiles.
 */
export function armSessionPersistence(): () => void {
  useSessionStore.getState().setSuspended(false);
  writer.resume();

  const unsubscribes = [
    useWorkspaceStore.subscribe((state, previous) => {
      if (state.clients === previous.clients) {
        if (state.activeClientId !== previous.activeClientId) requestSessionSave();
        return;
      }
      forgetTilesExcept(state.clients.map((client) => client.id));
      requestSessionSave();
    }),

    useLayoutStore.subscribe((state, previous) => {
      if (
        state.tiling !== previous.tiling ||
        state.gapIndex !== previous.gapIndex ||
        state.sidebarVisible !== previous.sidebarVisible ||
        state.sidebarPanel !== previous.sidebarPanel
      ) {
        requestSessionSave();
      }
    }),

    subscribeToAnnotationStore(() => requestSessionSave()),
  ];

  // The window is going away and the debounce has to be cut short. `pagehide`
  // rather than `unload`, which webkit does not reliably deliver, and
  // `visibilitychange` as well because a window that is hidden may never come
  // back — a minimised window on a machine that is about to sleep.
  const onExit = () => void flushSessionSave();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") onExit();
  };
  window.addEventListener("pagehide", onExit);
  window.addEventListener("beforeunload", onExit);
  document.addEventListener("visibilitychange", onVisibility);

  // ## Why there is no `onCloseRequested` handler here
  //
  // Tauri's window-close event would be the *reliable* moment to flush — it
  // awaits its handler before destroying the window, where a DOM event races
  // the process teardown. It is not used, because of what it costs to use:
  // Tauri calls `api.prevent_close()` the moment **any** JS listener for that
  // event exists (`tauri/src/manager/window.rs`), so the listener becomes the
  // only thing that can close the window, and closing it needs a capability
  // (`core:window:allow-destroy`) that the default set deliberately withholds.
  // A renderer wedged mid-decode would then be a window the close button no
  // longer shuts.
  //
  // What is at stake without it is bounded by the debounce: the last few
  // hundred milliseconds of *view* state — a divider position, a scroll offset
  // — on a quit that lands inside the quiet period. Annotations reach the disk
  // through the export path, not through this record. Taking ownership of the
  // close button to save that is the wrong trade. Revisit only with a measured
  // case where the loss is more than a scroll position.

  return () => {
    writer.pause();
    for (const unsubscribe of unsubscribes) unsubscribe();
    window.removeEventListener("pagehide", onExit);
    window.removeEventListener("beforeunload", onExit);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
