/**
 * The annotation system: two targeting models, one store, one export bridge per
 * plugin.
 *
 * - `overlay/` — marks anchored to a *position* on a subdivision (phase 05a).
 * - `text/` — marks anchored to a *quote* (phase 05b), so they survive a reflow.
 *   The file-type-specific half of that model is behind `TextAnchorSource`,
 *   which a plugin implements; nothing under `text/` imports a viewer.
 * - `store.ts` — where a document's annotations live, and where a save goes.
 * - `export/` — one bridge per file type. Imported directly, never through this
 *   barrel, so pdf-lib stays out of a session that never saves.
 *
 * Only the PDF plugin is wired into any of it today. Nothing here knows that.
 */

export type {
  AnnotationExportFormat,
  AnnotationExportOptions,
  AnnotationExportResult,
  AnnotationSummary,
} from "./model";

export * from "./geometry";
export * from "./overlay";
export * from "./text";

export type {
  AnnotatedFileIdentity,
  AnnotatedTarget,
  AnnotatedTargetProbe,
  AnnotationDocumentRecord,
} from "./store";
export {
  ANNOTATED_SUFFIX,
  annotatedCompanionOrdinal,
  annotationDocumentKey,
  basename,
  clearAnnotationStore,
  companionPath,
  getAnnotatedTarget,
  hasOverlayDocument,
  hasTextDocument,
  isRestorableDocumentKey,
  overlayDocumentFor,
  resolveAnnotatedTarget,
  restoreAnnotationDocuments,
  serializeAnnotationDocuments,
  setAnnotatedTarget,
  splitPath,
  subscribeToAnnotationStore,
  textDocumentFor,
} from "./store";
