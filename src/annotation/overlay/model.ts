/**
 * The overlay annotation model: marks that answer "where on the page".
 *
 * This is one of the two targeting strategies AGENTS.md describes, and the
 * distinction is load-bearing. Everything here carries a *position* and nothing
 * else — an ink stroke, a drawn highlight rectangle, a shape, a pasted image, a
 * point-anchored note. An annotation that means "these words", wherever they end
 * up after a reflow, is phase 05b's `annotation/text/` and carries a
 * {@link TextAnchor} instead of a position. Conflating the two was tried and
 * produced a highlight that could not survive a font substitution on export.
 *
 * ## Free of file-type vocabulary, on purpose
 *
 * There are no pages here, only *subdivisions* (the contract's word for whatever
 * a file divides into), and every coordinate is normalized (`geometry.ts`). The
 * PDF plugin is the only thing wired into this today; a future image plugin opts
 * in by writing its own bridge under `annotation/export/`, and this file should
 * not have to change when it does. Anything that would only ever make sense for
 * a PDF belongs in `viewers/pdf/`, not here.
 *
 * ## Items are immutable
 *
 * Every mutation produces a new item and a new array, which is what makes undo
 * a snapshot of a reference list rather than a deep clone: a hundred history
 * entries share the one copy of a pasted image. See `document.ts`.
 */

import type { AnnotationSummary } from "../model";
import {
  boundsOfPoints,
  mapPointBetweenRects,
  mapRectBetweenRects,
  normalizeRect,
  padRect,
  rectContains,
  unionRects,
  type NormalizedPoint,
  type NormalizedRect,
} from "../geometry";

export type OverlayItemKind = "ink" | "highlight" | "shape" | "text" | "note" | "image";

/** The four review shapes. Line and arrow differ only in their end style. */
export type OverlayShapeKind = "rect" | "ellipse" | "line" | "arrow";

interface OverlayItemBase {
  /** Unique within a document. Written into the exported annotation's `/NM`. */
  readonly id: string;

  /** Which subdivision the mark sits on. Single-view content uses `0`. */
  readonly subdivision: number;

  /**
   * The bounding box, always present and always current.
   *
   * Derived from the item's own geometry rather than stored independently of
   * it, so the two cannot drift — see {@link recomputeBounds}. It is what
   * hit-testing, the resize handles, `reveal()` and the exported `/Rect` all
   * read, which is why every kind has one even when its shape is a path.
   */
  readonly bounds: NormalizedRect;

  /** `#rrggbb`. See `tools.ts` for why annotations carry literal colours. */
  readonly color: string;

  /** `0..1`. Applied to the exported annotation's `/CA` as well as on screen. */
  readonly opacity: number;

  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OverlayInkItem extends OverlayItemBase {
  readonly kind: "ink";
  /**
   * One or more strokes, each a polyline. Several strokes per item so a single
   * undo takes back one *mark*, not one flick of the wrist — and so the export
   * writes one `/Ink` annotation with a multi-entry `/InkList`, which is what a
   * handwritten scribble is.
   */
  readonly strokes: readonly (readonly NormalizedPoint[])[];
  /** Fraction of the subdivision's *smaller* dimension. See {@link STROKE_WIDTHS}. */
  readonly strokeWidth: number;
}

export interface OverlayHighlightItem extends OverlayItemBase {
  /**
   * A *drawn* highlight — a region the user swept out. Not a text selection:
   * that is phase 05b, which resolves its rectangles from the text layer at
   * render time rather than storing them.
   */
  readonly kind: "highlight";
  readonly rects: readonly NormalizedRect[];
}

export interface OverlayShapeItem extends OverlayItemBase {
  readonly kind: "shape";
  readonly shape: OverlayShapeKind;
  readonly strokeWidth: number;
  /** `#rrggbb` interior fill, or absent for an outline. */
  readonly fill?: string;
  /**
   * Endpoints for `line`/`arrow`. A bounding box alone cannot say which
   * diagonal a line runs along, and an arrow additionally has a head end.
   */
  readonly from?: NormalizedPoint;
  readonly to?: NormalizedPoint;
}

export interface OverlayTextItem extends OverlayItemBase {
  /** A free-standing text callout. Exports as `/FreeText`. */
  readonly kind: "text";
  readonly text: string;
  /** Fraction of the subdivision's smaller dimension. */
  readonly fontSize: number;
}

export interface OverlayNoteItem extends OverlayItemBase {
  /** A point-anchored sticky note. Exports as `/Text` plus its `/Popup`. */
  readonly kind: "note";
  readonly text: string;
  /** Whether the note's body is showing. Written to the annotation's `/Open`. */
  readonly open: boolean;
}

/**
 * A pasted or dropped image.
 *
 * Held as base64 rather than a `Blob` so an item stays JSON-serializable and
 * structured-clonable, which is what phase 07 needs to persist a session and
 * what lets the undo history share one copy of the bytes across every snapshot.
 */
export interface OverlayImageData {
  readonly mimeType: "image/png" | "image/jpeg";
  readonly base64: string;
  /** Natural pixel size, for the initial aspect ratio. */
  readonly width: number;
  readonly height: number;
}

export interface OverlayImageItem extends OverlayItemBase {
  readonly kind: "image";
  readonly image: OverlayImageData;
}

export type OverlayItem =
  | OverlayInkItem
  | OverlayHighlightItem
  | OverlayShapeItem
  | OverlayTextItem
  | OverlayNoteItem
  | OverlayImageItem;

/** Bumped when the item schema changes incompatibly. */
export const OVERLAY_VERSION = 1;

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/**
 * Stroke widths, as a fraction of the subdivision's smaller dimension.
 *
 * Normalized rather than in points because the model must not know it is
 * describing a PDF — but the numbers come from somewhere real: 1, 2 and 4 points
 * on a 612-point-wide US Letter page, which is the pen ladder every PDF
 * annotator ships. On a subdivision of a different size they scale with it,
 * which is the behaviour you want when the same mark is drawn on an A4 page and
 * a thumbnail-sized one.
 */
export const STROKE_WIDTHS = [1 / 612, 2 / 612, 4 / 612] as const;
export const DEFAULT_STROKE_WIDTH = STROKE_WIDTHS[1];

/** Default callout size: 12pt on a 612pt page. */
export const DEFAULT_FONT_SIZE = 12 / 612;

/**
 * The sticky-note icon's size, as a fraction of the smaller dimension.
 *
 * 20 points on a 612-point page, which is the de-facto size of a `/Text`
 * annotation's icon — readers draw their own icon at their own size, so matching
 * it keeps the on-screen mark and the exported one in the same place.
 */
export const NOTE_SIZE = 20 / 612;

/** A click-created callout, when the user did not drag a box out. */
export const DEFAULT_TEXT_BOX = { width: 0.32, height: 0.08 } as const;

/**
 * How a text callout is laid out inside its box, as multiples of the font size.
 *
 * Shared by the two things that draw one — the on-screen SVG layer and the
 * exported `/FreeText` appearance stream — because the whole promise of this
 * export path is that the file looks like the tile did. Two sets of constants is
 * how that promise quietly stops being true.
 */
export const TEXT_PADDING_RATIO = 0.3;
export const TEXT_LINE_HEIGHT = 1.2;
/** Baseline drop from the top of a line. Helvetica's ascent, near enough. */
export const TEXT_BASELINE_RATIO = 0.85;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

let itemCounter = 0;

/**
 * A fresh item id.
 *
 * Includes a random component as well as a counter: ids are written into the
 * exported PDF as `/NM`, where they have to stay distinct from the ids of a
 * *previous* session's annotations in the same file.
 */
export function nextOverlayItemId(): string {
  itemCounter += 1;
  return `an${itemCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The bookkeeping every kind shares, so no call site has to remember it. */
export function overlayItemStamp(): {
  id: string;
  createdAt: number;
  updatedAt: number;
} {
  const now = Date.now();
  return { id: nextOverlayItemId(), createdAt: now, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Derived geometry
// ---------------------------------------------------------------------------

/**
 * The item's bounds, derived from its own geometry.
 *
 * Called after every edit, so `bounds` is never stale. Ink and shapes include
 * half the stroke width, because a 4-point pen paints 2 points outside the path
 * — leave it out and the selection outline crosses the mark, and the exported
 * `/Rect` clips it.
 */
export function recomputeBounds(item: OverlayItem): NormalizedRect {
  switch (item.kind) {
    case "ink": {
      const bounds = unionRects(item.strokes.map((stroke) => boundsOfPoints(stroke)));
      return padRect(bounds, item.strokeWidth / 2);
    }
    case "highlight":
      return unionRects(item.rects);
    case "shape": {
      // A line's box is its endpoints plus half a pen width, because a stroke
      // paints outside the path it follows.
      if (item.from && item.to) {
        return padRect(boundsOfPoints([item.from, item.to]), item.strokeWidth / 2);
      }
      // A rectangle's or an ellipse's box *is* its geometry — there is no
      // separate path to pad around — and both the layer and the export draw the
      // stroke inset inside it. Padding here would be the one case where this
      // function is not idempotent: every edit would re-pad an already-padded
      // box and the shape would creep outwards by a pen width per drag. It did,
      // and it took a real pointer drag in a browser to see it.
      return normalizeRect(item.bounds);
    }
    case "text":
    case "note":
    case "image":
      return normalizeRect(item.bounds);
  }
}

/** Whether a point is on (or close enough to) the item to select it by clicking. */
export function hitTestItem(
  item: OverlayItem,
  point: NormalizedPoint,
  tolerance: number,
): boolean {
  if (!rectContains(item.bounds, point, tolerance)) return false;
  // Inside the bounding box is the answer for everything with an interior. A
  // path is the exception: the box of a diagonal stroke is mostly empty, and
  // selecting it from a corner nowhere near the ink is how two overlapping
  // marks become impossible to tell apart.
  //
  // Measured against the *segments*, not the vertices. Against vertices alone,
  // a two-point stroke is only selectable at its two ends and completely dead
  // along its length, which reads as "this mark cannot be clicked".
  if (item.kind === "ink") {
    const reach = tolerance + item.strokeWidth / 2;
    return item.strokes.some((stroke) => {
      if (stroke.length === 1) {
        return Math.hypot(point.x - stroke[0]!.x, point.y - stroke[0]!.y) <= reach;
      }
      for (let index = 1; index < stroke.length; index += 1) {
        if (distanceToSegment(point, stroke[index - 1]!, stroke[index]!) <= reach) {
          return true;
        }
      }
      return false;
    });
  }
  if (item.kind === "shape" && (item.shape === "line" || item.shape === "arrow")) {
    return item.from && item.to
      ? distanceToSegment(point, item.from, item.to) <= tolerance
      : true;
  }
  return true;
}

function distanceToSegment(
  point: NormalizedPoint,
  a: NormalizedPoint,
  b: NormalizedPoint,
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
  );
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/**
 * Re-places an item inside a new bounding box.
 *
 * The single implementation of both move and resize: a drag produces a
 * translated box, a handle produces a reshaped one, and every kind's geometry is
 * mapped proportionally into it. Writing them as two operations is how a resize
 * ends up working for rectangles and quietly doing nothing to an ink stroke.
 */
export function transformItemToBounds(
  item: OverlayItem,
  next: NormalizedRect,
): OverlayItem {
  const from = item.bounds;
  const to = normalizeRect(next);
  const updatedAt = Date.now();

  switch (item.kind) {
    case "ink": {
      // Mapped through the *inset* boxes, so the stroke's centreline lands where
      // it should: `bounds` includes half a pen width of padding at every edge,
      // and mapping the path through the padded boxes would grow the mark by
      // that padding on every resize.
      const inset = item.strokeWidth / 2;
      const fromPath = padRect(from, -inset);
      const toPath = padRect(to, -inset);
      const strokes = item.strokes.map((stroke) =>
        stroke.map((vertex) => mapPointBetweenRects(vertex, fromPath, toPath)),
      );
      return { ...item, strokes, bounds: to, updatedAt };
    }
    case "highlight": {
      const rects = item.rects.map((rect) => mapRectBetweenRects(rect, from, to));
      return { ...item, rects, bounds: to, updatedAt };
    }
    case "shape": {
      if (!item.from || !item.to) return { ...item, bounds: to, updatedAt };
      const inset = item.strokeWidth / 2;
      const fromPath = padRect(from, -inset);
      const toPath = padRect(to, -inset);
      return {
        ...item,
        from: mapPointBetweenRects(item.from, fromPath, toPath),
        to: mapPointBetweenRects(item.to, fromPath, toPath),
        bounds: to,
        updatedAt,
      };
    }
    case "note":
      // A note is an icon, not a box: it moves, and it does not resize. Honouring
      // a resize would silently produce a mark no reader draws that way.
      return {
        ...item,
        bounds: { ...to, width: item.bounds.width, height: item.bounds.height },
        updatedAt,
      };
    case "text":
    case "image":
      return { ...item, bounds: to, updatedAt };
  }
}

/** Whether this kind has dimensions worth dragging a handle for. */
export function isResizable(item: OverlayItem): boolean {
  return item.kind !== "note";
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

/** The word the UI uses for a kind. Not the export subtype. */
export function overlayItemTypeLabel(item: OverlayItem): string {
  return item.kind === "shape" ? item.shape : item.kind;
}

/**
 * A short label for the annotation list.
 *
 * Text-carrying kinds say what they say, which is the only useful thing to show;
 * the rest say where they are, since one of five arrows on page 3 is otherwise
 * indistinguishable from the other four in a list.
 */
export function overlayItemLabel(item: OverlayItem): string {
  if (item.kind === "text" || item.kind === "note") {
    const line = item.text.trim().split("\n")[0] ?? "";
    if (line) return line.length > 42 ? `${line.slice(0, 41)}…` : line;
    return item.kind === "note" ? "empty note" : "empty callout";
  }
  if (item.kind === "image") {
    return `${item.image.width}×${item.image.height} image`;
  }
  const x = Math.round(item.bounds.x * 100);
  const y = Math.round(item.bounds.y * 100);
  return `${overlayItemTypeLabel(item)} at ${x}%, ${y}%`;
}

/**
 * The shell's view of these items.
 *
 * Ordered newest first, which is the order an annotation list is read in — the
 * array itself is in z-order, and "what did I just add" is the question a
 * reviewer asks of the list.
 */
export function summarizeOverlayItems(
  items: readonly OverlayItem[],
): readonly AnnotationSummary[] {
  return [...items]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((item) => ({
      id: item.id,
      type: overlayItemTypeLabel(item),
      label: overlayItemLabel(item),
      subdivision: item.subdivision,
      rect: item.bounds,
      createdAt: item.createdAt,
    }));
}
