/**
 * `FileHandle` implementation backed by a real path on disk, plus the Tauri
 * bridge that produces them.
 *
 * This is the only module in the frontend that calls the native file commands.
 * Everything else — viewers, persistence, the shell — works through
 * {@link FileHandle}.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import {
  extensionOf,
  nextFileHandleId,
  type FileHandle,
  type FileSource,
  type PersistedFileRef,
} from "./handle";

/** Mirror of the Rust `FileDescriptor` in `src-tauri/src/files.rs`. */
export interface FileDescriptor {
  readonly path: string;
  readonly name: string;
  readonly extension?: string;
  readonly size: number;
  readonly modifiedAt?: number;
}

/** Mirror of the Rust `DialogFilter`. */
export interface DialogFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

class NativeFileHandle implements FileHandle {
  readonly id: string;
  readonly name: string;
  readonly extension?: string;
  readonly mimeType?: string;
  readonly size: number;
  readonly modifiedAt?: number;
  readonly source: FileSource;
  readonly path: string;

  /** Shared across concurrent callers so the file is read at most once. */
  #bytes: Promise<Uint8Array> | null = null;
  #released = false;

  constructor(descriptor: FileDescriptor, source: FileSource, mimeType?: string) {
    this.id = nextFileHandleId("file");
    this.name = descriptor.name;
    this.extension = descriptor.extension ?? extensionOf(descriptor.name);
    this.mimeType = mimeType;
    this.size = descriptor.size;
    this.modifiedAt = descriptor.modifiedAt;
    this.source = source;
    this.path = descriptor.path;
  }

  read(): Promise<Uint8Array> {
    if (this.#released) this.#bytes = null;
    this.#released = false;

    if (!this.#bytes) {
      this.#bytes = invoke<ArrayBuffer>("read_file_bytes", { path: this.path })
        .then((buffer) => new Uint8Array(buffer))
        .catch((cause: unknown) => {
          // Don't cache a failure; a retry after the user fixes permissions
          // should actually retry.
          this.#bytes = null;
          throw new Error(`failed to read ${this.name}: ${describeError(cause)}`, {
            cause,
          });
        });
    }
    return this.#bytes;
  }

  async readRange(offset: number, length: number): Promise<Uint8Array> {
    // Served from the cache when the whole file is already here, which is the
    // normal case for a plugin that called `read()` first. Going back to the
    // backend for a slice of bytes we are holding would be a second IPC round
    // trip and a second copy for no new information.
    if (this.#bytes && !this.#released) {
      const whole = await this.#bytes;
      const start = Math.max(0, Math.trunc(offset));
      return whole.subarray(start, start + Math.max(0, Math.trunc(length)));
    }

    try {
      const buffer = await invoke<ArrayBuffer>("read_file_range", {
        path: this.path,
        offset: Math.max(0, Math.trunc(offset)),
        length: Math.max(0, Math.trunc(length)),
      });
      return new Uint8Array(buffer);
    } catch (cause) {
      throw new Error(`failed to read ${this.name}: ${describeError(cause)}`, { cause });
    }
  }

  streamUrl(): string | undefined {
    return convertFileSrc(this.path);
  }

  async exists(): Promise<boolean> {
    try {
      await invoke<FileDescriptor>("describe_file", { path: this.path });
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    this.#released = true;
    this.#bytes = null;
  }

  toPersistable(): PersistedFileRef {
    return {
      path: this.path,
      name: this.name,
      size: this.size,
      modifiedAt: this.modifiedAt,
      mimeType: this.mimeType,
    };
  }
}

function describeError(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/** Wraps a descriptor the backend already produced. */
export function createNativeFileHandle(
  descriptor: FileDescriptor,
  source: FileSource = "native-dialog",
  mimeType?: string,
): FileHandle {
  return new NativeFileHandle(descriptor, source, mimeType);
}

/**
 * Opens the OS-native file picker.
 *
 * Resolves to an empty array when the user dismisses the dialog — a
 * cancellation is not an error.
 */
export async function openFilesViaDialog(options?: {
  multiple?: boolean;
  filters?: readonly DialogFilter[];
}): Promise<FileHandle[]> {
  const descriptors = await invoke<FileDescriptor[]>("open_file_dialog", {
    multiple: options?.multiple ?? false,
    filters: options?.filters ?? [],
  });
  return descriptors.map((descriptor) =>
    createNativeFileHandle(descriptor, "native-dialog"),
  );
}

/**
 * Builds a handle for a path the frontend already knows: a drag-and-drop
 * payload, or a path recorded in a previous session.
 */
export async function openFileByPath(
  path: string,
  source: Exclude<FileSource, "memory"> = "drag-drop",
): Promise<FileHandle> {
  const descriptor = await invoke<FileDescriptor>("describe_file", { path });
  return createNativeFileHandle(descriptor, source);
}

/**
 * Whether a readable regular file exists at `path`.
 *
 * `FileHandle.exists()` answers this for a file something already has open;
 * this answers it for a path nothing has opened, which is what phase 05a's
 * save-target collision rule needs — the question there is about a file the user
 * may never have seen.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await invoke<FileDescriptor>("describe_file", { path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a path that has no handle behind it.
 *
 * Deliberately not memoized and deliberately not a `FileHandle`: the caller is
 * inspecting a file, not opening one, and building a handle would put it in the
 * retain/release bookkeeping for a read that ends immediately.
 */
export async function readPathBytes(path: string): Promise<Uint8Array> {
  const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path });
  return new Uint8Array(buffer);
}

/**
 * Lists the files in a directory whose extension is one of `extensions`.
 *
 * Backs the image plugin's folder browsing. The extension filter is the
 * caller's, not the backend's: the plugin owns the list of formats it can open,
 * and `files/` stays free of file-type vocabulary.
 *
 * Ordered the way a file manager orders a directory — digit runs compare as
 * numbers, so `IMG_9` precedes `IMG_10`.
 */
export async function listDirectoryFiles(
  directory: string,
  extensions: readonly string[],
): Promise<FileDescriptor[]> {
  return invoke<FileDescriptor[]>("list_directory_files", {
    directory,
    extensions,
  });
}

/** The directory part of a path, for both separator conventions. */
export function directoryOf(path: string): string | undefined {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : undefined;
}

/**
 * Shows the OS-native save dialog.
 *
 * Resolves to `null` when the user dismisses it, matching
 * {@link openFilesViaDialog}'s treatment of a cancelled open as "no selection"
 * rather than a failure.
 */
export async function saveFileViaDialog(options?: {
  defaultName?: string;
  filters?: readonly DialogFilter[];
}): Promise<string | null> {
  return invoke<string | null>("save_file_dialog", {
    defaultName: options?.defaultName,
    filters: options?.filters ?? [],
  });
}

/** A two-way question about a file, for {@link askAboutFile}. */
export interface FileQuestion {
  /** The dialog's title bar. */
  readonly title: string;
  /** The question itself. Plain text; newlines are kept. */
  readonly message: string;
  /** The button that resolves `true`. Name the *outcome*, not "yes". */
  readonly confirmLabel: string;
  /** The button that resolves `false`, and what dismissing the dialog means. */
  readonly cancelLabel: string;
}

/**
 * Asks the user a yes/no question about a file, natively.
 *
 * Here rather than in the shell because both callers are decisions about *which
 * file bytes go to or come from* — which annotated copy to open, and whether to
 * replace one — and because one of them is made inside a viewer plugin, which
 * may not reach into the shell for a React modal. A native dialog is also the
 * honest form for these: the app already shows the OS's own picker for open and
 * save, and this is the same conversation.
 *
 * Dismissing the dialog is `false`, matching {@link saveFileViaDialog}'s
 * treatment of a cancelled save — so the answer to "should I do the unusual
 * thing" is no when the user closes it. Falls back to the webview's own
 * `confirm` outside Tauri (the dev browser), and to `false` where even that is
 * missing, so a caller never hangs waiting for an answer that cannot come.
 */
export async function askAboutFile(question: FileQuestion): Promise<boolean> {
  try {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    return await ask(question.message, {
      title: question.title,
      kind: "info",
      okLabel: question.confirmLabel,
      cancelLabel: question.cancelLabel,
    });
  } catch {
    // Not running under Tauri, or the dialog plugin is unavailable.
  }
  try {
    return window.confirm(`${question.title}\n\n${question.message}`);
  } catch {
    return false;
  }
}

/**
 * Writes bytes to a path.
 *
 * The payload goes as the request's raw body, which is why the destination
 * travels in a header rather than as an argument: a `Uint8Array` passed as a
 * normal command argument is serialized as a JSON array of numbers, and an
 * exported image is megabytes of it. `encodeURIComponent` because headers are a
 * Latin-1 channel and a path is not.
 */
export async function writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
  // A fresh copy: `invoke` transfers the buffer, and the caller may still hold
  // a view onto the one it passed in.
  const body = new Uint8Array(bytes);
  await invoke<void>("write_file_bytes", body, {
    headers: { "x-target-path": encodeURIComponent(path) },
  });
}

/**
 * Re-opens a persisted reference.
 *
 * Reports `changed: true` when the file still exists but its size or mtime no
 * longer match what was recorded, so the caller can decide whether restoring
 * per-file state (scroll position, page number, annotations) is still sensible.
 */
export async function restoreFileRef(
  ref: PersistedFileRef,
): Promise<
  | { ok: true; handle: FileHandle; changed: boolean }
  | { ok: false; reason: string }
> {
  try {
    const descriptor = await invoke<FileDescriptor>("describe_file", {
      path: ref.path,
    });
    const changed =
      descriptor.size !== ref.size ||
      (ref.modifiedAt !== undefined && descriptor.modifiedAt !== ref.modifiedAt);
    return {
      ok: true,
      handle: createNativeFileHandle(descriptor, "restored-session", ref.mimeType),
      changed,
    };
  } catch (cause) {
    return { ok: false, reason: describeError(cause) };
  }
}
