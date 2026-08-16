/**
 * Normalized geometry: the coordinate system every annotation is expressed in.
 *
 * `0..1` relative to the subdivision's own box, with `y` running *down* from the
 * top-left — the same convention the viewer contract uses for
 * {@link ViewerLocation.rect}, and for the same reason: a position that survives
 * zoom, device pixel ratio and a re-render at a different scale. Nothing here
 * knows what a page is.
 *
 * Two conversions happen at the edges and nowhere else. The PDF plugin turns
 * these into *display points* to draw them (`viewers/pdf/annotateLayer.ts`), and
 * the export bridge turns them into *PDF user space* to write them
 * (`annotation/export/pdf.ts`, which also handles `/Rotate`). Keeping the model
 * itself in one unit is what lets a second plugin implement its own bridge later
 * without the data changing shape.
 */

/** A rectangle in `0..1` coordinates relative to its subdivision's box. */
export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A point in `0..1` coordinates relative to its subdivision's box. */
export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** A rect from two corners, in either order. */
export function rectFromCorners(a: NormalizedPoint, b: NormalizedPoint): NormalizedRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Fixes a rect built with negative extents, e.g. from a drag right-to-left. */
export function normalizeRect(rect: NormalizedRect): NormalizedRect {
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

export function translateRect(rect: NormalizedRect, dx: number, dy: number): NormalizedRect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/** Grows a rect by `amount` on every side. Used to give a stroke its room. */
export function padRect(rect: NormalizedRect, amount: number): NormalizedRect {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: rect.width + amount * 2,
    height: rect.height + amount * 2,
  };
}

/** The smallest rect containing every input. Empty input gives an empty rect. */
export function unionRects(rects: readonly NormalizedRect[]): NormalizedRect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    const box = normalizeRect(rect);
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function boundsOfPoints(points: readonly NormalizedPoint[]): NormalizedRect {
  return unionRects(points.map((point) => ({ ...point, width: 0, height: 0 })));
}

export function rectContains(
  rect: NormalizedRect,
  point: NormalizedPoint,
  padding = 0,
): boolean {
  return (
    point.x >= rect.x - padding &&
    point.x <= rect.x + rect.width + padding &&
    point.y >= rect.y - padding &&
    point.y <= rect.y + rect.height + padding
  );
}

export function rectsOverlap(a: NormalizedRect, b: NormalizedRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/**
 * Maps a point from one box into another, proportionally.
 *
 * This is the whole of "resize an annotation": a resize handle produces a new
 * bounding box, and every point the item is made of is re-placed within it. A
 * zero-extent source axis maps to the destination's origin rather than dividing
 * by zero — which is the real case of a perfectly horizontal line being made
 * taller.
 */
export function mapPointBetweenRects(
  point: NormalizedPoint,
  from: NormalizedRect,
  to: NormalizedRect,
): NormalizedPoint {
  const fx = from.width > 1e-9 ? (point.x - from.x) / from.width : 0;
  const fy = from.height > 1e-9 ? (point.y - from.y) / from.height : 0;
  return { x: to.x + fx * to.width, y: to.y + fy * to.height };
}

export function mapRectBetweenRects(
  rect: NormalizedRect,
  from: NormalizedRect,
  to: NormalizedRect,
): NormalizedRect {
  const topLeft = mapPointBetweenRects({ x: rect.x, y: rect.y }, from, to);
  const bottomRight = mapPointBetweenRects(
    { x: rect.x + rect.width, y: rect.y + rect.height },
    from,
    to,
  );
  return rectFromCorners(topLeft, bottomRight);
}
