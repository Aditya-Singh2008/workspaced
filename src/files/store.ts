/**
 * Non-reactive registry of live `FileHandle` objects, keyed by handle id.
 *
 * A `FileHandle` owns cached bytes and object URLs: it is not serializable and
 * changing it must not re-render React. So the Zustand stores hold only the id
 * plus display metadata, and look the handle up here when they need the real
 * thing. Same reasoning as viewer instances (`src/viewers/instances.ts`).
 */

import type { FileHandle } from "./handle";

const handles = new Map<string, FileHandle>();
/** How many workspace clients currently reference each handle. */
const refCounts = new Map<string, number>();

/** Registers a handle and takes the first reference to it. */
export function retainFileHandle(handle: FileHandle): FileHandle {
  handles.set(handle.id, handle);
  refCounts.set(handle.id, (refCounts.get(handle.id) ?? 0) + 1);
  return handle;
}

/**
 * Drops one reference. When the last one goes, the handle is released (cached
 * bytes freed, object URLs revoked) and forgotten.
 */
export function releaseFileHandle(id: string): void {
  const remaining = (refCounts.get(id) ?? 0) - 1;
  if (remaining > 0) {
    refCounts.set(id, remaining);
    return;
  }
  refCounts.delete(id);
  handles.get(id)?.release();
  handles.delete(id);
}

export function getFileHandle(id: string): FileHandle | undefined {
  return handles.get(id);
}

/** Throws when the id is unknown — for call sites where absence is a bug. */
export function requireFileHandle(id: string): FileHandle {
  const handle = handles.get(id);
  if (!handle) throw new Error(`no file handle registered for id "${id}"`);
  return handle;
}

/** Test/teardown helper. Releases every handle. */
export function releaseAllFileHandles(): void {
  for (const handle of handles.values()) handle.release();
  handles.clear();
  refCounts.clear();
}
