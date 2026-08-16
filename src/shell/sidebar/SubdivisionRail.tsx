/**
 * The subdivision rail: previews of whatever the focused tile is divided into.
 *
 * AGENTS.md says phase 03 fills the sidebar in "through the plugin contract
 * […] never with file-type knowledge", and this is that. It contains no PDF
 * vocabulary: it asks the focused instance how many *subdivisions* it has
 * (`capabilities.subdivisionCount`), asks for a preview of each
 * (`thumbnail({ subdivision })`), and navigates by handing back a
 * `ViewerLocation` (`reveal`). A video plugin exposing keyframes gets the same
 * rail for free.
 *
 * ## Virtualized, because the brief requires it
 *
 * "Virtualize thumbnail generation so only visible or near-visible thumbnails
 * render eagerly" is a property of the *requester*, not of the plugin — the
 * plugin renders what it is asked for. So the rail keeps a sized placeholder
 * per subdivision and requests a preview only when one scrolls near, which is
 * the same shape as the page virtualizer inside the viewer and for the same
 * reason: a 900-page document must not render 900 previews on open.
 *
 * Phase 05a moved the frame and the heading up into `SidebarPanels.tsx`, which
 * now decides between this and the annotation list. What is left here is the
 * rail itself: capability detection and the mount/unmount decision belong to
 * whichever component is choosing between panels, not to one of the panels.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getViewerInstance, type ThumbnailResult } from "../../viewers";

/** Requested box for one preview, in CSS pixels. */
const THUMB_WIDTH = 132;
const THUMB_HEIGHT = 180;

/** How far outside the visible range to render eagerly. */
const OVERSCAN = 4;

export interface SubdivisionRailProps {
  readonly clientId: string;
  /** How many subdivisions the focused instance reports. */
  readonly count: number;
  /**
   * The instance-registry version, so a rail rendered before its tile finished
   * mounting re-derives its visible range once the instance appears.
   */
  readonly instancesVersion: number;
}

export function SubdivisionRail({
  clientId,
  count,
  instancesVersion,
}: SubdivisionRailProps) {
  const instance = getViewerInstance(clientId);
  const canReveal = typeof instance?.reveal === "function";

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: OVERSCAN * 2 });

  const updateRange = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rowHeight = THUMB_HEIGHT + 28;
    const first = Math.floor(scroller.scrollTop / rowHeight);
    const visible = Math.ceil(scroller.clientHeight / rowHeight);
    setRange({
      start: Math.max(0, first - OVERSCAN),
      end: first + visible + OVERSCAN,
    });
  }, []);

  useEffect(() => {
    updateRange();
  }, [updateRange, clientId, count, instancesVersion]);

  const indices = useMemo(
    () => Array.from({ length: count }, (_, index) => index),
    [count],
  );

  return (
    <div
      ref={scrollerRef}
      onScroll={updateRange}
      className="min-h-0 grow overflow-y-auto px-2 py-2"
    >
      {indices.map((index) => (
        <Thumb
          key={`${clientId}:${index}`}
          clientId={clientId}
          subdivision={index}
          eager={index >= range.start && index <= range.end}
          onSelect={
            canReveal ? () => void instance?.reveal?.({ subdivision: index }) : undefined
          }
        />
      ))}
    </div>
  );
}

interface ThumbProps {
  readonly clientId: string;
  readonly subdivision: number;
  /** Whether this row is near enough to the viewport to be worth rendering. */
  readonly eager: boolean;
  readonly onSelect?: () => void;
}

function Thumb({ clientId, subdivision, eager, onSelect }: ThumbProps) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "ready"; src: string } | { kind: "failed" }
  >({ kind: "idle" });

  useEffect(() => {
    if (!eager || state.kind !== "idle") return;
    const instance = getViewerInstance(clientId);
    if (!instance) return;

    const abort = new AbortController();
    let live = true;

    void (async () => {
      try {
        const result = await instance.thumbnail({
          maxWidth: THUMB_WIDTH,
          maxHeight: THUMB_HEIGHT,
          subdivision,
          signal: abort.signal,
        });
        if (!live) return;
        const src = toImageSource(result);
        setState(src ? { kind: "ready", src } : { kind: "failed" });
      } catch {
        // A cancelled request is the normal case when the rail scrolls fast.
        if (live && !abort.signal.aborted) setState({ kind: "failed" });
      }
    })();

    return () => {
      live = false;
      abort.abort();
    };
  }, [clientId, subdivision, eager, state.kind]);

  const label = String(subdivision + 1);

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={!onSelect}
      aria-label={`view ${label}`}
      className="mb-2 flex w-full flex-col items-center gap-1 border border-transparent p-1 text-muted hover:border-border-strong hover:text-fg disabled:hover:border-transparent"
    >
      <span
        className="flex w-full items-center justify-center overflow-hidden border border-border bg-surface-raised"
        style={{ height: THUMB_HEIGHT }}
      >
        {state.kind === "ready" ? (
          <img
            src={state.src}
            alt=""
            className="max-h-full max-w-full"
            draggable={false}
          />
        ) : (
          <span className="text-disabled">{state.kind === "failed" ? "—" : "…"}</span>
        )}
      </span>
      <span>{label}</span>
    </button>
  );
}

/**
 * Turns any `ThumbnailResult` flavour into something an `<img>` can show.
 *
 * `"bitmap"` is the flavour the contract says the *consumer* owns, so it is
 * drawn once into a canvas and closed immediately rather than being held —
 * holding it would make the rail responsible for a resource whose lifetime it
 * cannot see. `"icon"` returns nothing and the caller draws its placeholder,
 * which is the honest rendering of "this plugin has no preview".
 */
function toImageSource(result: ThumbnailResult): string | null {
  switch (result.kind) {
    case "dataUrl":
      return result.dataUrl;
    case "canvas":
      return result.canvas instanceof HTMLCanvasElement
        ? result.canvas.toDataURL("image/png")
        : null;
    case "bitmap": {
      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        result.bitmap.close();
        return null;
      }
      context.drawImage(result.bitmap, 0, 0, result.width, result.height);
      result.bitmap.close();
      const url = canvas.toDataURL("image/png");
      canvas.width = 0;
      return url;
    }
    case "icon":
      return null;
  }
}
