/**
 * Video-viewer preferences: the settings that belong to *the viewer*, not to
 * one open file.
 *
 * The line between this and `state.ts` is the same one the image plugin draws.
 * `state.ts` is what one tile remembers about one file — this position, this
 * loop, this subtitle track — and is serialized per tile by the shell. This is
 * what the user has decided about watching video in general.
 *
 * ## Volume is here, and the brief is specific about why
 *
 * *"Volume/mute state remembered per session as a shared preference."* Not per
 * file, and not per tile. Someone who turns the volume down because they are in
 * an office has made a statement about their environment, and a second video
 * opening at full volume a minute later would be exactly the failure that
 * setting was made to prevent. So volume lives here, every tile subscribes, and
 * changing it in one tile changes it in all of them.
 *
 * It is emphatically *not* in `state.ts`. A volume serialized into a saved
 * layout would come back a week later on a different machine in a different
 * room, which is a worse answer than the session default.
 *
 * **Not persisted yet.** Phase 07 owns persistence, and this deliberately does
 * not reach for the Tauri store ahead of it — {@link serializeVideoSettings} and
 * {@link restoreVideoSettings} are what that phase wires up, and they exist now
 * so the wiring is a call site rather than a refactor.
 */

import type { ScaleMode } from "./engine/view";

export const SCALE_MODES: readonly ScaleMode[] = ["fit", "fill", "actual"];

export const SCALE_MODE_LABELS: Readonly<Record<ScaleMode, string>> = {
  fit: "fit",
  fill: "fill",
  actual: "100%",
};

export interface VideoSettings {
  /** 0 to 1. Shared across every open video tile — see the module comment. */
  readonly volume: number;
  readonly muted: boolean;

  /** How a newly opened video is sized. */
  readonly defaultScaleMode: ScaleMode;

  /**
   * Start playing when a video opens.
   *
   * Defaults to *off*. A tile appearing in a layout is not the same act as
   * pressing play, and a grid of six videos that all began playing — with audio
   * — the moment a saved workspace was restored would be a workspace nobody
   * would restore twice.
   */
  readonly autoplay: boolean;

  /**
   * Turn on the first available subtitle track automatically.
   *
   * Defaults to *off*, because burning text over the picture is a decision, not
   * a default. The tracks panel and one keystroke are the two ways to change it
   * for a file, and this is how someone who always wants them says so once.
   */
  readonly preferSubtitles: boolean;

  /**
   * Show a frame preview when hovering the scrubber.
   *
   * On by default, and worth a setting because the preview costs a second
   * decoder for the lifetime of the tile. On a machine playing several 4K files
   * at once that is real, and turning it off leaves the timecode preview, which
   * is most of the value.
   */
  readonly scrubberPreviews: boolean;
}

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  volume: 1,
  muted: false,
  defaultScaleMode: "fit",
  autoplay: false,
  preferSubtitles: false,
  scrubberPreviews: true,
};

let current: VideoSettings = DEFAULT_VIDEO_SETTINGS;
const listeners = new Set<(settings: VideoSettings) => void>();

export function videoSettings(): VideoSettings {
  return current;
}

/**
 * Applies a partial change and notifies every open video tile.
 *
 * Explicitly-undefined keys are dropped rather than applied, so a `restore`
 * that could not validate a field leaves the existing value alone instead of
 * replacing it with `undefined`.
 */
export function updateVideoSettings(patch: Partial<VideoSettings>): VideoSettings {
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<VideoSettings>;

  const merged = { ...current, ...defined };
  current = { ...merged, volume: clampVolume(merged.volume) };

  for (const listener of listeners) {
    try {
      listener(current);
    } catch (thrown) {
      console.error("[video] settings listener threw", thrown);
    }
  }
  return current;
}

export function subscribeToVideoSettings(
  listener: (settings: VideoSettings) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_VIDEO_SETTINGS.volume;
  return Math.min(1, Math.max(0, volume));
}

// ---------------------------------------------------------------------------
// The phase 07 seam
// ---------------------------------------------------------------------------

export function serializeVideoSettings(): VideoSettings {
  return current;
}

/** Tolerates anything, exactly as a tile's `restore` must. */
export function restoreVideoSettings(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const candidate = value as Partial<VideoSettings>;
  updateVideoSettings({
    volume: typeof candidate.volume === "number" ? candidate.volume : undefined,
    muted: typeof candidate.muted === "boolean" ? candidate.muted : undefined,
    defaultScaleMode: SCALE_MODES.includes(candidate.defaultScaleMode as ScaleMode)
      ? candidate.defaultScaleMode
      : undefined,
    autoplay: typeof candidate.autoplay === "boolean" ? candidate.autoplay : undefined,
    preferSubtitles:
      typeof candidate.preferSubtitles === "boolean" ? candidate.preferSubtitles : undefined,
    scrubberPreviews:
      typeof candidate.scrubberPreviews === "boolean" ? candidate.scrubberPreviews : undefined,
  });
}

/** Test hook: back to defaults, so one self-test cannot affect the next. */
export function resetVideoSettings(): void {
  current = DEFAULT_VIDEO_SETTINGS;
}
