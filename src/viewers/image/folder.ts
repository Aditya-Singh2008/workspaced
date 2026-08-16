/**
 * Folder browsing: stepping through the images beside the one that was opened.
 *
 * Shared by every format, so it sits in the plugin root. It knows about
 * `FileHandle` and about the plugin's format table, and nothing about decoding —
 * it answers "which file is next" and hands back a handle.
 *
 * ## The listing is read once and kept
 *
 * Re-listing the directory on every step would be correct and would also make
 * holding down the next key issue one filesystem walk per keystroke. A directory
 * of photographs is not a thing that changes while someone is looking through
 * it, so the listing is taken when browsing starts and reused. {@link refresh}
 * exists for when that assumption is worth re-checking — a slideshow wrapping
 * round, say — and is cheap to call because it is not called often.
 *
 * ## Both ends stop, they do not wrap
 *
 * Verification item 3 asks that navigation "behaves sensibly at the ends of the
 * directory listing". Stopping is the sensible behaviour for a manual step:
 * wrapping from the last photo to the first, silently, is indistinguishable from
 * the key not having worked, and it is how people lose their place in a large
 * directory. {@link atStart} and {@link atEnd} are exposed so the toolbar can
 * disable the button rather than the key doing nothing unexplained.
 *
 * The slideshow is the deliberate exception, and it wraps — that is what a
 * slideshow is — which is why {@link advance} takes the choice as an argument
 * rather than the class having one policy.
 */

import {
  createNativeFileHandle,
  directoryOf,
  listDirectoryFiles,
  type FileDescriptor,
  type FileHandle,
} from "../../files";
import { IMAGE_EXTENSIONS } from "./formats";

export class FolderSession {
  readonly directory: string;
  #entries: readonly FileDescriptor[];
  #index: number;

  private constructor(directory: string, entries: readonly FileDescriptor[], index: number) {
    this.directory = directory;
    this.#entries = entries;
    this.#index = index;
  }

  /**
   * Lists the siblings of `file` and positions on it.
   *
   * Returns `null` for anything that cannot have siblings — a file with no path,
   * which is every in-memory handle including the self-test's fixtures. That is
   * a normal condition and the instance reports the capability as absent rather
   * than showing navigation that cannot go anywhere.
   */
  static async open(file: FileHandle): Promise<FolderSession | null> {
    const directory = file.path ? directoryOf(file.path) : undefined;
    if (!directory) return null;

    let entries: FileDescriptor[];
    try {
      entries = await listDirectoryFiles(directory, IMAGE_EXTENSIONS);
    } catch (thrown) {
      console.error("[image] could not list the containing folder", thrown);
      return null;
    }
    if (entries.length === 0) return null;

    const index = entries.findIndex((entry) => entry.path === file.path);
    // The opened file not being in its own directory listing means it was
    // deleted or renamed between opening and now. Position at the start rather
    // than at −1, which every step would then have to defend against.
    return new FolderSession(directory, entries, index >= 0 ? index : 0);
  }

  get entries(): readonly FileDescriptor[] {
    return this.#entries;
  }

  get count(): number {
    return this.#entries.length;
  }

  /** 1-based, for the readout. `3 / 48` is what a viewer shows. */
  get position(): number {
    return this.#index + 1;
  }

  get current(): FileDescriptor | undefined {
    return this.#entries[this.#index];
  }

  get atStart(): boolean {
    return this.#index <= 0;
  }

  get atEnd(): boolean {
    return this.#index >= this.#entries.length - 1;
  }

  /**
   * Moves and returns a handle for the new file, or `null` when there is
   * nowhere to go.
   */
  advance(direction: 1 | -1, options?: { wrap?: boolean }): FileHandle | null {
    if (this.#entries.length === 0) return null;

    let next = this.#index + direction;
    if (next < 0 || next >= this.#entries.length) {
      if (!options?.wrap) return null;
      next = (next + this.#entries.length) % this.#entries.length;
    }
    if (next === this.#index && this.#entries.length > 1) return null;

    this.#index = next;
    return this.handleForCurrent();
  }

  /** Positions on a file by name. Used by `restore`. */
  goToName(name: string): FileHandle | null {
    const index = this.#entries.findIndex((entry) => entry.name === name);
    if (index < 0 || index === this.#index) return null;
    this.#index = index;
    return this.handleForCurrent();
  }

  handleForCurrent(): FileHandle | null {
    const entry = this.current;
    if (!entry) return null;
    // `"drag-drop"` is the source for "a path this app already knew", which is
    // what a sibling is. It is not a dialog selection and it is not a restored
    // session, and inventing a fourth source for it would put a value in
    // persisted state that phase 07 would then have to understand.
    return createNativeFileHandle(entry, "drag-drop");
  }

  /** Re-reads the directory, keeping the position on the same file if it survives. */
  async refresh(): Promise<void> {
    const currentPath = this.current?.path;
    try {
      const entries = await listDirectoryFiles(this.directory, IMAGE_EXTENSIONS);
      if (entries.length === 0) return;
      this.#entries = entries;
      const index = entries.findIndex((entry) => entry.path === currentPath);
      this.#index = index >= 0 ? index : Math.min(this.#index, entries.length - 1);
    } catch {
      // Keep the listing we have. A directory that has become unreadable is not
      // a reason to lose the file that is already open.
    }
  }
}
