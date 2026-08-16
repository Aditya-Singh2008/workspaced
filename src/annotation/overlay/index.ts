/**
 * The overlay annotation model — position-anchored marks over a document.
 *
 * Phase 05a. Its sibling `annotation/text/` (phase 05b) holds the other
 * targeting strategy; both persist through the one `annotation/store.ts` and
 * export through the one `annotation/export/` bridge per plugin.
 */

export type {
  OverlayChangeReason,
  OverlayLiveEdit,
} from "./document";
export { OverlayDocument } from "./document";

export type {
  OverlayImageData,
  OverlayImageItem,
  OverlayInkItem,
  OverlayItem,
  OverlayItemKind,
  OverlayHighlightItem,
  OverlayNoteItem,
  OverlayShapeItem,
  OverlayShapeKind,
  OverlayTextItem,
} from "./model";

export {
  DEFAULT_FONT_SIZE,
  DEFAULT_STROKE_WIDTH,
  DEFAULT_TEXT_BOX,
  NOTE_SIZE,
  OVERLAY_VERSION,
  STROKE_WIDTHS,
  TEXT_BASELINE_RATIO,
  TEXT_LINE_HEIGHT,
  TEXT_PADDING_RATIO,
  hitTestItem,
  isResizable,
  nextOverlayItemId,
  overlayItemLabel,
  overlayItemStamp,
  overlayItemTypeLabel,
  recomputeBounds,
  summarizeOverlayItems,
  transformItemToBounds,
} from "./model";

export type { OverlayToolDescriptor, OverlayToolId, OverlayToolStyle } from "./tools";
export {
  OVERLAY_COLORS,
  OVERLAY_TOOLS,
  OverlayToolPreferences,
  overlayToolPreferences,
} from "./tools";
