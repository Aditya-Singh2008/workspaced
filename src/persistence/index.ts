/**
 * Session and layout persistence: the workspace survives a restart.
 *
 * The same tiles, in the same arrangement, showing the same files, each viewer
 * resumed where it was left — from real paths through the Tauri store plugin,
 * not the browser's filename-and-size guesswork this app was rebuilt to get
 * away from.
 *
 * ## The layout
 *
 * ```
 * record.ts     what a saved session is, and how one is read back safely
 * storage.ts    where it is kept: the Tauri store, or memory outside the app
 * tiles.ts      per-tile bookkeeping a restore needs and no store should hold
 * session.ts    collecting the record, and the debounced writer
 * restore.ts    putting one back, in the order that survives a missing file
 * selftest.ts   dev-only: the record, the debounce, and a failed reopen
 * ```
 *
 * ## The one rule this layer owes the rest of the app
 *
 * *"Plugins only ever see `serialize()`/`restore()` calls from the shell; how
 * and where that data is stored is the persistence layer's concern alone."*
 * Nothing under `viewers/` imports anything here, in either direction: this
 * layer reads plugins through the contract — `ViewerInstance.serialize` for a
 * tile, `ViewerPluginDescriptor.preferences` for a plugin — and writes opaque
 * values it never inspects. It contains no file-type vocabulary at all, which
 * is checkable the same way the rest of the shell's is: by grep.
 *
 * The two seams it reaches through, rather than importing, are the dock's
 * serialization ({@link provideSessionLayout}) and the store's own restore
 * actions. Both go the same way round: the thing that owns the state hands over
 * a function, and this layer decides when to call it.
 */

export type {
  PersistedPreferences,
  PersistedSession,
  PersistedShellState,
  PersistedTile,
} from "./record";
export {
  EMPTY_SHELL_STATE,
  isEmptySession,
  isJsonSafe,
  parseSession,
  SESSION_RECORD_VERSION,
  usableTileState,
} from "./record";

export type { SessionStorage } from "./storage";
export {
  createMemorySessionStorage,
  SESSION_STORE_FILE,
  SESSION_STORE_KEY,
  sessionStorage,
  setSessionStorage,
} from "./storage";

export {
  clearRestoredState,
  forgetAllTiles,
  forgetTilesExcept,
  recordedFileRef,
  rememberTileSource,
  restoredViewerState,
} from "./tiles";

export type { SessionWriter, SessionWriterOptions } from "./session";
export {
  armSessionPersistence,
  clearSavedSession,
  collectSession,
  createSessionWriter,
  flushSessionSave,
  isSessionPersistenceSuspended,
  MAX_ANNOTATION_BYTES,
  nextSaveDelay,
  pauseSessionWrites,
  provideSessionLayout,
  requestSessionSave,
  SAVE_DEBOUNCE_MS,
  SAVE_MAX_DELAY_MS,
  useSessionStore,
} from "./session";

export type {
  ReopenFile,
  ReopenOutcome,
  SessionRestoreOptions,
  SessionRestoreResult,
} from "./restore";
export {
  clearRestoredLayout,
  hasRestoredLayout,
  relocateTileFile,
  reopenTileFile,
  restoreSession,
  takeRestoredLayout,
} from "./restore";

export type { SessionPhase } from "./useSessionRestore";
export { useSessionRestore } from "./useSessionRestore";
