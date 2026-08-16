/**
 * What a video tile remembers, and how it survives a bad restore.
 *
 * The contract requires serialized state to be plain JSON the shell writes
 * without inspecting, and requires `restore()` to tolerate partial, stale or
 * malformed input by falling back to defaults rather than throwing. So the
 * shape is flat and primitive and {@link parseVideoState} validates every field
 * on the way in.
 *
 * The brief names four things to remember — *"playback position, volume,
 * selected audio/subtitle track, A/B loop points"* — and three of them are
 * here. Volume is not, deliberately: `settings.ts` sets out why it is a session
 * preference shared by every tile rather than something a saved layout carries
 * back a week later on a different machine. The scale mode and the open panel
 * join the three, for the reason the image plugin gives about its inspector —
 * reopening a session with a panel closed, when it was open, reads as the app
 * forgetting rather than as a default.
 *
 * ## Position is milliseconds, and is not clamped on the way in
 *
 * A position past the end of the media is not something this module can detect:
 * the duration is not known until the file is open, and a state object arrives
 * before that. So the value is validated as a finite non-negative number here
 * and clamped against the real duration by the transport, which is the only
 * place that knows it. Clamping to a guess here would silently move a playhead.
 *
 * ## Tracks are ids, not indices
 *
 * `sidecar:0`, `embedded:3`, `off` — the ids `engine/tracks.ts` mints. An index
 * into a track list is meaningless if the file was remuxed or a sidecar `.srt`
 * was added beside it since; an id either matches something in the file that is
 * open now or does not, and a selection that no longer resolves falls back to
 * off rather than to whichever track happens to be third.
 *
 * ## Pan is stored normalized, exactly as the image plugin stores it
 *
 * A scroll offset in pixels is meaningless in a tile of a different size, at a
 * different zoom, or on a different display — restore it into a re-tiled
 * workspace and the picture jumps somewhere the user never put it. What survives
 * all three is *which point of the frame is in the middle of the view*, as a
 * fraction of the frame's own box. That is what `centerX`/`centerY` are, and the
 * reasoning is `viewers/image/state.ts`'s, unchanged: a zoom that is remembered
 * and a pan that is not would restore someone into the wrong corner of the
 * picture every time.
 */

import type { ZoomMode } from "./engine/view";
import { MAX_ZOOM_PERCENT, MIN_ZOOM_PERCENT } from "./engine/view";
import type { VideoPanel } from "./engine/panels";
import { SUBTITLES_OFF } from "./engine/tracks";
import { DEFAULT_VIDEO_SETTINGS, SCALE_MODES } from "./settings";

export const VIDEO_PANELS: readonly VideoPanel[] = ["none", "info", "tracks", "chapters"];

export const VIDEO_PANEL_LABELS: Readonly<Record<VideoPanel, string>> = {
  none: "off",
  info: "info",
  tracks: "tracks",
  chapters: "chapters",
};

/**
 * The three fit modes plus the state an explicit zoom leaves behind.
 *
 * `custom` is validated as a mode rather than inferred from the zoom number
 * because the two are independent: a tile can be at `fit` and still carry the
 * zoom it was last set to, and reading the number as the mode would restore a
 * fitted picture as a zoomed one.
 */
export const VIDEO_ZOOM_MODES: readonly ZoomMode[] = [...SCALE_MODES, "custom"];

export interface VideoViewerState {
  /** Playhead, in milliseconds. Clamped against the real duration on load. */
  readonly positionMs: number;
  /** A fit mode, or `custom` when an explicit zoom is in effect. */
  readonly scaleMode: ZoomMode;
  /** Percent, and only meaningful when `scaleMode` is `custom`. */
  readonly zoom: number;
  /** The point held at the centre of the view, as a fraction of the frame. */
  readonly centerX: number;
  readonly centerY: number;
  readonly panel: VideoPanel;
  /** Playback rate. Not the shuttle, which is a gesture rather than a setting. */
  readonly speed: number;
  /** Track ids from `engine/tracks.ts`, or `undefined` for "whatever the file defaults to". */
  readonly audioTrackId?: string;
  readonly subtitleTrackId: string;
  /** Both ends, or neither. A half-set loop is a gesture in progress. */
  readonly loopInMs?: number;
  readonly loopOutMs?: number;
}

export const DEFAULT_VIDEO_STATE: VideoViewerState = {
  positionMs: 0,
  scaleMode: DEFAULT_VIDEO_SETTINGS.defaultScaleMode,
  zoom: 100,
  centerX: 0.5,
  centerY: 0.5,
  panel: "none",
  speed: 1,
  subtitleTrackId: SUBTITLES_OFF,
};

/** Bounds for a restored speed. Wider than the cycle, which is a subset of it. */
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 16;

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

function trackId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : undefined;
}

/** Coerces anything at all into a usable state. Never throws. */
export function parseVideoState(value: unknown): VideoViewerState {
  if (!value || typeof value !== "object") return DEFAULT_VIDEO_STATE;
  const candidate = value as Partial<VideoViewerState>;

  // Both ends or neither: a loop with only an in point would restore as a
  // half-pressed key, and one whose out point is not after its in point would
  // pin the playhead the moment it started.
  const loopIn = finite(candidate.loopInMs, Number.NaN);
  const loopOut = finite(candidate.loopOutMs, Number.NaN);
  const loopValid = Number.isFinite(loopIn) && Number.isFinite(loopOut) && loopOut > loopIn;

  return {
    positionMs: Math.max(0, finite(candidate.positionMs, 0)),
    scaleMode: oneOf(candidate.scaleMode, VIDEO_ZOOM_MODES, DEFAULT_VIDEO_STATE.scaleMode),
    zoom: clamp(finite(candidate.zoom, 100), MIN_ZOOM_PERCENT, MAX_ZOOM_PERCENT),
    centerX: clamp(finite(candidate.centerX, 0.5), 0, 1),
    centerY: clamp(finite(candidate.centerY, 0.5), 0, 1),
    panel: oneOf(candidate.panel, VIDEO_PANELS, "none"),
    speed: clamp(finite(candidate.speed, 1), MIN_SPEED, MAX_SPEED),
    audioTrackId: trackId(candidate.audioTrackId),
    subtitleTrackId: trackId(candidate.subtitleTrackId) ?? SUBTITLES_OFF,
    loopInMs: loopValid ? Math.max(0, loopIn) : undefined,
    loopOutMs: loopValid ? Math.max(0, loopOut) : undefined,
  };
}
