/**
 * What an image tile remembers, and how it survives a bad restore.
 *
 * The contract requires serialized state to be plain JSON the shell writes
 * without inspecting, and requires `restore()` to tolerate partial, stale or
 * malformed input by falling back to defaults rather than throwing. So the
 * shape is flat and primitive and {@link parseImageState} validates every field
 * on the way in.
 *
 * The phase brief names five things to remember — zoom, pan, rotation, the
 * adjustment values, and the position in a folder browsing session — and this
 * is those five plus the two that would be strange to drop alongside them (fit
 * mode, which zoom is meaningless without, and the flips, which are the other
 * half of rotation). The inspector panel is here for the same reason the PDF
 * plugin remembers its inversion: reopening a session with the metadata panel
 * closed, when it was open, reads as the app forgetting rather than as a
 * default.
 *
 * ## Pan is stored normalized, and that is the interesting decision
 *
 * A scroll offset in pixels is meaningless in a tile of a different size, at a
 * different zoom, or on a different display — restore it into a re-tiled
 * workspace and the image jumps somewhere the user never put it. What survives
 * all three is *which point of the image is in the middle of the view*, as a
 * fraction of the image's own box. That is what `centerX`/`centerY` are, and it
 * is the same reasoning the contract gives for normalizing every coordinate
 * that crosses it.
 *
 * ## Folder position is a name, not an index
 *
 * A directory is not stable between sessions. An index into a listing that has
 * since gained a file points at the wrong photo and gives no way to notice;
 * a name either finds its file or does not, and the tile falls back to the file
 * it was opened with. The listing is re-read on restore either way.
 */

import { DEFAULT_ADJUSTMENTS, parseAdjustments, type Adjustments } from "./engine/adjust";
import { DEFAULT_IMAGE_SETTINGS, FIT_MODES, type FitMode } from "./settings";

/** Which side panel is open. `"none"` is a state, not the absence of one. */
export type InspectorPanel = "none" | "metadata" | "histogram" | "adjust";

export const INSPECTOR_PANELS: readonly InspectorPanel[] = [
  "none",
  "metadata",
  "histogram",
  "adjust",
];

export const INSPECTOR_PANEL_LABELS: Readonly<Record<InspectorPanel, string>> = {
  none: "off",
  metadata: "info",
  histogram: "levels",
  adjust: "light",
};

/** Quarter turns only. Arbitrary angles are an editing feature, not a view aid. */
export type Rotation = 0 | 90 | 180 | 270;

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

/** `"custom"` is what any explicit zoom leaves behind; the rest are fit modes. */
export type ZoomMode = FitMode | "custom";

export interface ImageViewerState {
  readonly zoomMode: ZoomMode;
  /** Percent, and only meaningful when `zoomMode` is `"custom"`. */
  readonly zoom: number;
  /** The point held at the centre of the view, as a fraction of the image. */
  readonly centerX: number;
  readonly centerY: number;
  readonly rotation: Rotation;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly adjustments: Adjustments;
  readonly panel: InspectorPanel;
  /** File name within the folder browsing session, if it has moved off the original. */
  readonly folderFile?: string;
}

export const DEFAULT_IMAGE_STATE: ImageViewerState = {
  zoomMode: DEFAULT_IMAGE_SETTINGS.defaultFitMode,
  zoom: 100,
  centerX: 0.5,
  centerY: 0.5,
  rotation: 0,
  flipX: false,
  flipY: false,
  adjustments: DEFAULT_ADJUSTMENTS,
  panel: "none",
};

const ZOOM_MODES: readonly ZoomMode[] = [...FIT_MODES, "custom"];

export const MIN_ZOOM_PERCENT = 1;
export const MAX_ZOOM_PERCENT = 6400;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Coerces anything at all into a usable state. Never throws. */
export function parseImageState(value: unknown): ImageViewerState {
  if (!value || typeof value !== "object") return DEFAULT_IMAGE_STATE;
  const candidate = value as Partial<ImageViewerState>;

  const rotation = finite(candidate.rotation, 0);
  return {
    zoomMode: oneOf(candidate.zoomMode, ZOOM_MODES, DEFAULT_IMAGE_STATE.zoomMode),
    zoom: clamp(finite(candidate.zoom, 100), MIN_ZOOM_PERCENT, MAX_ZOOM_PERCENT),
    centerX: clamp(finite(candidate.centerX, 0.5), 0, 1),
    centerY: clamp(finite(candidate.centerY, 0.5), 0, 1),
    // Normalized rather than validated against the list: a state file holding
    // `450` means the same thing as `90`, and rejecting it to `0` would silently
    // straighten a rotated image.
    rotation: (((Math.round(rotation / 90) * 90) % 360) + 360) % 360 as Rotation,
    flipX: candidate.flipX === true,
    flipY: candidate.flipY === true,
    adjustments: parseAdjustments(candidate.adjustments),
    panel: oneOf(candidate.panel, INSPECTOR_PANELS, "none"),
    folderFile:
      typeof candidate.folderFile === "string" && candidate.folderFile
        ? candidate.folderFile
        : undefined,
  };
}
