/**
 * `FileHandle` — the app's only representation of "a file the user opened".
 *
 * Viewer plugins and the persistence layer depend on this interface and never
 * on `File`, `Blob`, a raw path string, or a Tauri command directly. A file can
 * arrive from a native dialog, a drag-and-drop event, a session restored from
 * disk, or (in tests) memory; each of those produces a `FileHandle` with the
 * same surface, so the access mechanism can change without touching plugin
 * code.
 *
 * Implementations live alongside this file:
 *   - `native.ts`   real paths from the Tauri dialog / drag-drop / restore
 *   - `memory.ts`   in-memory bytes, used by tests and the contract self-test
 */

/** Where a handle came from. Affects what it can promise, not its interface. */
export type FileSource =
  /** The OS-native file picker. */
  | "native-dialog"
  /** A drag-and-drop onto the window. */
  | "drag-drop"
  /** A path recorded in a previous session and re-opened at startup. */
  | "restored-session"
  /** Bytes held in memory with no path behind them. Never persisted. */
  | "memory";

/**
 * The minimum needed to rebuild a handle in a later session, plus enough
 * identity to notice the file changed underneath us while we were gone.
 *
 * `null` for sources that cannot be restored (`"memory"`).
 */
export interface PersistedFileRef {
  readonly path: string;
  readonly name: string;
  /** Size at the time it was persisted; a mismatch means the file changed. */
  readonly size: number;
  /** Modified time at the time it was persisted, if the platform reported one. */
  readonly modifiedAt?: number;
  readonly mimeType?: string;
}

export interface FileHandle {
  /**
   * Stable for the lifetime of this handle. The Zustand stores hold this id
   * rather than the handle itself, since a handle owns non-serializable
   * resources (cached bytes, object URLs).
   */
  readonly id: string;

  /** File name including extension, e.g. `"report.pdf"`. */
  readonly name: string;

  /**
   * Lowercased extension without the leading dot, e.g. `"pdf"`. Absent for
   * files with no extension.
   */
  readonly extension?: string;

  /**
   * Only set when the *source* supplied an authoritative type. A native path
   * carries no MIME type, so this is usually absent — deliberately. The
   * registry resolves by MIME first and falls back to extension, and a guessed
   * MIME type here would make the guess indistinguishable from a real one.
   */
  readonly mimeType?: string;

  /** Size in bytes. */
  readonly size: number;

  /** Last-modified time in ms since the Unix epoch, when known. */
  readonly modifiedAt?: number;

  readonly source: FileSource;

  /** Absolute path on disk. Absent only for `"memory"` handles. */
  readonly path?: string;

  /**
   * The file's full contents.
   *
   * Memoized: repeated calls share one read, so a plugin, a thumbnail request
   * and a search extraction can each call it without coordinating. Call
   * {@link release} to drop the cache when the bytes are no longer needed.
   */
  read(): Promise<Uint8Array>;

  /**
   * `length` bytes starting at `offset`.
   *
   * Not memoized, and deliberately not built on {@link read}: the point of it is
   * to answer a question about a file *without* pulling the file into memory.
   * A video container is parsed from a few hundred kilobytes at each end of what
   * may be several gigabytes, and reading the whole thing to find a duration
   * would spend the file's size to answer what the header already answers.
   *
   * A range starting past the end of the file resolves to an empty array rather
   * than rejecting. That is the answer a parser walking an index needs, and it
   * is distinguishable from a short read, which comes back truncated at its own
   * offset rather than slid backwards to fit.
   */
  readRange(offset: number, length: number): Promise<Uint8Array>;

  /**
   * A URL the webview can load directly in an `<img>`/`<video>`/`<iframe>`
   * `src`, without pulling the whole file through JavaScript memory. This is
   * how streaming media should be loaded; `read()` is for formats that need the
   * bytes (pdf.js).
   *
   * Returns `undefined` when no such URL can be produced for this source.
   */
  streamUrl(): string | undefined;

  /** Whether the file is still present and readable. */
  exists(): Promise<boolean>;

  /**
   * Drop cached bytes and revoke any object URLs this handle created. Safe to
   * call more than once. The shell calls this when the last viewer instance for
   * the file is disposed.
   */
  release(): void;

  /**
   * A restorable reference, or `null` when this handle cannot be restored in a
   * later session.
   */
  toPersistable(): PersistedFileRef | null;
}

let handleCounter = 0;

/** Generates a session-unique handle id. */
export function nextFileHandleId(prefix: string): string {
  handleCounter += 1;
  return `${prefix}:${handleCounter}`;
}

/** Lowercased extension without the dot, derived from a file name. */
export function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

/** Human-readable size, for the fallback viewer and file lists. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
