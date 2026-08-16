/**
 * Image-viewer preferences: the settings that belong to *the viewer*, not to
 * one open file.
 *
 * The line between this and `state.ts` is worth stating, because it decides
 * where every future setting goes. `state.ts` is what one tile remembers about
 * one file — this zoom, this rotation, this position in this folder — and is
 * serialized per tile by the shell. This module is what the user has decided
 * about image viewing in general: how a newly opened image should be fitted,
 * how long a slideshow waits, whether GPS is hidden. Opening a second image
 * picks these up and does not inherit the first tile's zoom.
 *
 * **Not persisted yet.** Phase 07 owns persistence, and this deliberately does
 * not reach for the Tauri store ahead of it — {@link serializeImageSettings} and
 * {@link restoreImageSettings} are the two functions that phase will wire up,
 * and they exist now so that wiring is a call site rather than a refactor.
 */

/** How a newly opened image is sized. Matches the brief's three fit modes. */
export type FitMode =
  /** The whole image, scaled down to fit, never scaled up past 100%. */
  | "fit-window"
  /** 100%: one image pixel per CSS pixel. */
  | "actual"
  /** Cover the tile, cropping the overflowing axis. */
  | "fill";

export const FIT_MODES: readonly FitMode[] = ["fit-window", "actual", "fill"];

export const FIT_MODE_LABELS: Readonly<Record<FitMode, string>> = {
  "fit-window": "fit",
  actual: "100%",
  fill: "fill",
};

export interface ImageSettings {
  /** Fit mode applied when an image is opened with no remembered state. */
  readonly defaultFitMode: FitMode;

  /** Seconds between slideshow advances. */
  readonly slideshowIntervalSeconds: number;

  /**
   * Hide GPS coordinates in the metadata panel by default.
   *
   * Defaults to *on*. The brief asks for "a clear, unobtrusive way to hide
   * sensitive metadata like GPS", and a viewer that shows someone's home
   * coordinates the moment a photo is opened has already leaked them — to
   * whoever is looking at the screen, to a screen share, to a screenshot. The
   * unobtrusive control reveals them; it does not have to be found first.
   */
  readonly hideGps: boolean;

  /**
   * Zoom (as a fraction, so `3` is 300%) above which the image is drawn with
   * nearest-neighbour sampling instead of smoothing.
   *
   * Past roughly 3× the interesting thing about a raster image is its pixel
   * grid — that is what the pixel inspector is for — and a smoothed upscale
   * hides exactly what the user zoomed in to see. Vector images ignore this
   * entirely; they have no pixels to show.
   */
  readonly pixelateAboveZoom: number;

  /** Start animated images playing when they open. */
  readonly autoplayAnimations: boolean;

  /**
   * Draw a checkerboard behind images with an alpha channel.
   *
   * The app's background is near-black, so transparent and black are otherwise
   * indistinguishable — which for a PNG being checked for a clean alpha channel
   * is the one question being asked.
   */
  readonly checkerboardTransparency: boolean;
}

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  defaultFitMode: "fit-window",
  slideshowIntervalSeconds: 5,
  hideGps: true,
  pixelateAboveZoom: 3,
  autoplayAnimations: true,
  checkerboardTransparency: true,
};

/** Bounds for the slideshow interval, in seconds. */
export const MIN_SLIDESHOW_SECONDS = 1;
export const MAX_SLIDESHOW_SECONDS = 120;

let current: ImageSettings = DEFAULT_IMAGE_SETTINGS;
const listeners = new Set<(settings: ImageSettings) => void>();

export function imageSettings(): ImageSettings {
  return current;
}

/**
 * Applies a partial change and notifies every open image tile.
 *
 * Every tile subscribes, so changing the slideshow interval in one takes effect
 * in all of them — these are application preferences, and a preference that
 * only applied to the tile it was changed in would be a per-tile setting
 * pretending to be one.
 */
export function updateImageSettings(patch: Partial<ImageSettings>): ImageSettings {
  // Explicitly-undefined keys are dropped rather than applied. `restore` builds
  // its patch by validating each field and leaving the invalid ones undefined,
  // and a plain spread would turn "this field was unreadable" into "this field
  // is now undefined" — which is worse than the value it replaced.
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<ImageSettings>;

  const merged = { ...current, ...defined };
  current = {
    ...merged,
    slideshowIntervalSeconds: clampInterval(merged.slideshowIntervalSeconds),
  };
  for (const listener of listeners) {
    try {
      listener(current);
    } catch (thrown) {
      console.error("[image] settings listener threw", thrown);
    }
  }
  return current;
}

export function subscribeToImageSettings(
  listener: (settings: ImageSettings) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_IMAGE_SETTINGS.slideshowIntervalSeconds;
  return Math.min(MAX_SLIDESHOW_SECONDS, Math.max(MIN_SLIDESHOW_SECONDS, seconds));
}

// ---------------------------------------------------------------------------
// The phase 07 seam
// ---------------------------------------------------------------------------

export function serializeImageSettings(): ImageSettings {
  return current;
}

/** Tolerates anything, exactly as a tile's `restore` must. */
export function restoreImageSettings(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const candidate = value as Partial<ImageSettings>;
  updateImageSettings({
    defaultFitMode: FIT_MODES.includes(candidate.defaultFitMode as FitMode)
      ? candidate.defaultFitMode
      : undefined,
    slideshowIntervalSeconds:
      typeof candidate.slideshowIntervalSeconds === "number"
        ? candidate.slideshowIntervalSeconds
        : undefined,
    hideGps: typeof candidate.hideGps === "boolean" ? candidate.hideGps : undefined,
    pixelateAboveZoom:
      typeof candidate.pixelateAboveZoom === "number" && candidate.pixelateAboveZoom > 0
        ? candidate.pixelateAboveZoom
        : undefined,
    autoplayAnimations:
      typeof candidate.autoplayAnimations === "boolean"
        ? candidate.autoplayAnimations
        : undefined,
    checkerboardTransparency:
      typeof candidate.checkerboardTransparency === "boolean"
        ? candidate.checkerboardTransparency
        : undefined,
  });
}

/** Test hook: back to defaults, so one self-test cannot affect the next. */
export function resetImageSettings(): void {
  current = DEFAULT_IMAGE_SETTINGS;
}
