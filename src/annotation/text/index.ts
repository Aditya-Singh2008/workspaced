/**
 * The text-anchored annotation model — marks attached to a quote, not a place.
 *
 * Phase 05b. Its sibling `annotation/overlay/` (phase 05a) holds the other
 * targeting strategy; both persist through the one `annotation/store.ts` and
 * export through the one `annotation/export/` bridge per plugin.
 *
 * Nothing in here imports a viewer. The file-type-specific half lives behind
 * {@link TextAnchorSource}, which the PDF plugin implements in
 * `viewers/pdf/textGeometry.ts`.
 */

export type { TextAnchor, TextAnchorMatch } from "./anchor";
export {
  ANCHOR_CONTEXT_CHARS,
  ANCHOR_SEARCH_BUDGET,
  buildTextAnchor,
  matchAnchorInText,
  resolveTextAnchor,
  searchOrder,
} from "./anchor";

export type { TextAnchorCapability, TextAnchorSource, TextRange } from "./source";

export type {
  ResolvedTextAnnotation,
  TextAnnotationItem,
  TextAnnotationPlacement,
} from "./model";
export {
  TEXT_ANNOTATION_VERSION,
  nextTextAnnotationId,
  resolveTextAnnotations,
  summarizeTextAnnotations,
  textAnnotationLabel,
  textAnnotationStamp,
  textAnnotationTypeLabel,
} from "./model";

export type { TextAnnotationChangeReason } from "./document";
export { TextAnnotationDocument } from "./document";
