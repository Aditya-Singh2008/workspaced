/**
 * `FileHandle` implementation over bytes already in memory.
 *
 * Exists so the viewer contract can be exercised without touching disk or the
 * Tauri IPC layer — see `src/viewers/dev/contract-selftest.ts`. It is also the
 * only source that can carry an authoritative `mimeType`, which is what makes
 * the registry's MIME-first resolution path testable.
 *
 * Never persisted: `toPersistable()` returns `null`.
 */

import {
  extensionOf,
  nextFileHandleId,
  type FileHandle,
  type PersistedFileRef,
} from "./handle";

class MemoryFileHandle implements FileHandle {
  readonly id: string;
  readonly name: string;
  readonly extension?: string;
  readonly mimeType?: string;
  readonly size: number;
  readonly modifiedAt: number;
  readonly source = "memory" as const;

  #bytes: Uint8Array;
  #objectUrl: string | null = null;

  constructor(init: { name: string; bytes: Uint8Array; mimeType?: string }) {
    this.id = nextFileHandleId("mem");
    this.name = init.name;
    this.extension = extensionOf(init.name);
    this.mimeType = init.mimeType;
    this.#bytes = init.bytes;
    this.size = init.bytes.byteLength;
    this.modifiedAt = Date.now();
  }

  async read(): Promise<Uint8Array> {
    return this.#bytes;
  }

  /**
   * A view onto the bytes, not a copy — they are already here, and the whole
   * reason ranged reads exist is to avoid moving a file's worth of memory
   * around. `subarray` clamps both ends itself, which gives the same "starts
   * past the end means empty" behaviour the native path gets from the backend.
   */
  async readRange(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.trunc(offset));
    return this.#bytes.subarray(start, start + Math.max(0, Math.trunc(length)));
  }

  streamUrl(): string | undefined {
    if (!this.#objectUrl) {
      const blob = new Blob([this.#bytes as BlobPart], {
        type: this.mimeType ?? "application/octet-stream",
      });
      this.#objectUrl = URL.createObjectURL(blob);
    }
    return this.#objectUrl;
  }

  async exists(): Promise<boolean> {
    return true;
  }

  release(): void {
    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = null;
    }
  }

  toPersistable(): PersistedFileRef | null {
    return null;
  }
}

export function createMemoryFileHandle(init: {
  name: string;
  bytes: Uint8Array;
  mimeType?: string;
}): FileHandle {
  return new MemoryFileHandle(init);
}
