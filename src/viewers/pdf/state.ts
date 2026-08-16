/**
 * What a PDF tile remembers, and how it survives a bad restore.
 *
 * The contract requires serialized state to be plain JSON the shell can write
 * without inspecting, and requires `restore()` to tolerate partial, stale or
 * malformed input by falling back to defaults rather than throwing. So the
 * shape is flat and primitive, and {@link parsePdfState} validates every field
 * on the way in — a session file edited by hand, or written by an older
 * `stateVersion`, must never be able to crash a tile.
 *
 * Four fields, and the shape is meant to stay about this size. Anything a tile
 * remembers has to be restored correctly on a file that has changed underneath
 * it, so every addition is another thing that can be stale — which is why
 * inversion is a boolean rather than a mode with exceptions.
 */

import type { ZoomMode } from "./view";
import { clamp } from "./util";

export interface PdfViewerState {
  readonly page: number;
  readonly zoomMode: ZoomMode;
  readonly zoom: number;
  readonly inverted: boolean;
}

export const DEFAULT_PDF_STATE: PdfViewerState = {
  page: 1,
  zoomMode: "fit-width",
  zoom: 100,
  inverted: false,
};

const ZOOM_MODES: readonly ZoomMode[] = ["fit-width", "fit-page", "custom"];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Coerces anything at all into a usable state. Never throws. */
export function parsePdfState(value: unknown): PdfViewerState {
  if (!value || typeof value !== "object") return DEFAULT_PDF_STATE;
  const candidate = value as Partial<PdfViewerState>;

  return {
    page: Math.max(1, Math.round(finiteNumber(candidate.page, DEFAULT_PDF_STATE.page))),
    zoomMode: oneOf(candidate.zoomMode, ZOOM_MODES, DEFAULT_PDF_STATE.zoomMode),
    zoom: clamp(finiteNumber(candidate.zoom, DEFAULT_PDF_STATE.zoom), 10, 800),
    inverted: candidate.inverted === true,
  };
}
