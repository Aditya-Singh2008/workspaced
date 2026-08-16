/**
 * The rubber band: a box dragged over a tile, copied as an image.
 *
 * It is drawn by the shell, over the plugin's own surface, and it never asks
 * the plugin for a pixel — the box is normalized against the tile's box, which
 * the shell owns, and `ViewerCopyApi.locateRegion` turns that into "page 3, this
 * rectangle of it". That indirection is what makes one gesture work over a
 * scrolled PDF and a zoomed, rotated photograph with no branch between them.
 *
 * Rendered inside `ViewerSurface`, so it inherits the tile's box exactly and
 * cannot drift from it the way a portal positioned from a measured rect would.
 * It exists only while this tile is in capture mode.
 *
 * Two behaviours worth naming:
 *
 *   - **Escape cancels, and wins.** The listener is on the window in the capture
 *     phase and stops propagation, because a plugin may have its own Escape
 *     bound while a mode of its own is open (the PDF's annotate mode does).
 *     The gesture the user started most recently is the one Escape should end.
 *   - **A click is not a region.** Anything under a few pixels in either
 *     direction is treated as a mis-click and cancels rather than copying a
 *     sliver, which would otherwise land a 1×1 PNG on the clipboard.
 */

import { useEffect, useRef, useState } from "react";

import { announceStatus } from "../statusbar/messages";
import { copyRegion } from "./actions";
import { useClipboardStore } from "./store";

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Below this, in CSS pixels, the drag was a click. */
const MINIMUM_DRAG = 6;

export function RegionCapture({ clientId }: { readonly clientId: string }) {
  const endRegionCapture = useClipboardStore((state) => state.endRegionCapture);
  const surfaceRef = useRef<HTMLDivElement>(null);
  /**
   * The tile's box, measured once when the drag starts.
   *
   * Measuring per frame would be the obvious thing and is the wrong one: it is
   * a forced layout on every pointer move, and a plugin that reflows under the
   * pointer (a PDF settling a page render) would move the band's origin
   * mid-drag.
   */
  const boundsRef = useRef<DOMRect | null>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [current, setCurrent] = useState<Point | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      endRegionCapture();
      announceStatus("region copy cancelled");
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [endRegionCapture]);

  const box = start && current ? boxBetween(start, current) : null;

  return (
    <div
      ref={surfaceRef}
      // `crosshair` is the one cursor in the app that is not the default, and
      // it is doing real work here: it is the only indication *inside the tile*
      // that the next drag means something different from usual.
      className="absolute inset-0 z-20 cursor-crosshair bg-bg/20"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        try {
          // Keeps the moves coming when the pointer leaves the tile mid-drag.
          // It is an improvement, not a requirement — the box is clamped to the
          // tile either way — so a pointer the engine will not let us capture
          // (a synthetic one, above all) must not break the gesture.
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* no capture; the drag still works within the tile */
        }
        boundsRef.current = event.currentTarget.getBoundingClientRect();
        const point = { x: event.clientX, y: event.clientY };
        setStart(point);
        setCurrent(point);
      }}
      onPointerMove={(event) => {
        if (!start) return;
        setCurrent({ x: event.clientX, y: event.clientY });
      }}
      onPointerUp={(event) => {
        const bounds = boundsRef.current;
        const from = start;
        setStart(null);
        setCurrent(null);
        boundsRef.current = null;
        endRegionCapture();
        if (!from || !bounds || bounds.width <= 0 || bounds.height <= 0) return;

        const to = { x: event.clientX, y: event.clientY };
        const drawn = boxBetween(from, to);
        if (drawn.width < MINIMUM_DRAG || drawn.height < MINIMUM_DRAG) {
          announceStatus("region copy cancelled — drag a box to select one");
          return;
        }

        void copyRegion(
          clientId,
          {
            x: (drawn.left - bounds.left) / bounds.width,
            y: (drawn.top - bounds.top) / bounds.height,
            width: drawn.width / bounds.width,
            height: drawn.height / bounds.height,
          },
          // The same two destinations the keyboard has, on the same modifier
          // the yank binding uses.
          event.shiftKey ? "scratch" : "clipboard",
        );
      }}
    >
      {box && boundsRef.current ? (
        <div
          className="pointer-events-none absolute border border-accent bg-selection"
          style={{
            left: `${box.left - boundsRef.current.left}px`,
            top: `${box.top - boundsRef.current.top}px`,
            width: `${box.width}px`,
            height: `${box.height}px`,
          }}
        />
      ) : null}
    </div>
  );
}

/** Two corners in any order into a positive-area box, in client pixels. */
function boxBetween(a: Point, b: Point) {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return { left, top, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
