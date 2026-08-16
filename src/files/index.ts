/**
 * File access layer.
 *
 * Not in AGENTS.md's module map, because the map predates the `FileHandle`
 * abstraction that phase 01 calls for ("define a `FileHandle` type/interface in
 * a shared location"). It lives here rather than under `persistence/` because
 * every viewer plugin depends on it, and viewers must not depend on the
 * persistence layer.
 */

export type { FileHandle, FileSource, PersistedFileRef } from "./handle";
export { extensionOf, formatFileSize, nextFileHandleId } from "./handle";

export type { DialogFilter, FileDescriptor, FileQuestion } from "./native";
export {
  askAboutFile,
  createNativeFileHandle,
  directoryOf,
  fileExists,
  listDirectoryFiles,
  openFileByPath,
  openFilesViaDialog,
  readPathBytes,
  restoreFileRef,
  saveFileViaDialog,
  writeFileBytes,
} from "./native";

export { createMemoryFileHandle } from "./memory";

export {
  getFileHandle,
  releaseAllFileHandles,
  releaseFileHandle,
  requireFileHandle,
  retainFileHandle,
} from "./store";
