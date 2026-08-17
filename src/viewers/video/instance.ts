/**
 * The mounted video viewer: the class the contract's `ViewerInstance` names.
 *
 * It owns the open file and the tile's state, and delegates the rest — the
 * surface to `engine/view.ts`, the playhead to `engine/transport.ts`, the
 * timeline to `engine/scrubber.ts`, tracks and captions to `engine/tracks.ts`
 * and `engine/subtitles.ts`, the side panel to `engine/panels.ts`. What lives
 * *here* is the parts the contract asks for: capabilities, the toolbar and
 * keybind contributions, search, copy, thumbnails, state round-tripping, and a
 * `dispose()` that provably releases every decoder.
 *
 * ## Chapters are subdivisions
 *
 * The contract calls anything a file can be divided into a *subdivision*, and is
 * explicit that the shell must be able to page through them and draw thumbnails
 * without knowing what they are. A film's chapters are exactly that, so a file
 * with chapter marks reports `subdivisionCount` and gets the sidebar's preview
 * rail as a chapter strip — with `reveal({ subdivision })` seeking to a mark —
 * without one line of shell code knowing what a chapter is. AGENTS.md
 * anticipates this: "a video plugin exposing keyframes gets the same rail
 * without touching it."
 *
 * A file with no chapters reports no `subdivisionCount` at all, which is the
 * contract's "omitted for continuous content", and the rail stays away. Frames
 * are deliberately not subdivisions: a ninety-minute film has 130,000 of them,
 * and a rail with 130,000 entries is not a navigation aid.
 *
 * ## Search is caption text, or nothing at all
 *
 * The brief: *"search should be implemented only if the video has caption/
 * subtitle text; otherwise the viewer is non-searchable and the shell must
 * handle that with no error."* So `capabilities.search` is `true` only when a
 * readable subtitle track exists, and when it is `false` there is no `search`
 * property at all — the contract's rule that absence is never an error. A
 * `find` that always returned nothing would be a disabled capability pretending
 * to be an implemented one.
 *
 * Each segment's location carries the cue's timestamp in `anchor`, which is what
 * `reveal` seeks to. The contract's `range` and `rect` do not apply: a caption
 * has no box on a page, it has a moment.
 *
 * ## Copy is the current frame
 *
 * *"Copy should provide the current frame as image data."* Not the file, not the
 * subtitle text, not a screenshot of the tile. `engine/capture.ts` explains why
 * the frame is captured at the media's own resolution rather than at whatever
 * size the tile happens to be.
 *
 * ## What is shared with the image plugin, and what is still not
 *
 * Zoom and pan are shared, and deliberately: they were ruled out here as an
 * image-viewer concept and that was wrong for a *review* tool, where getting
 * closer to a frame is how a compression artefact or a burned-in timecode is
 * checked. `engine/view.ts` sets out the reversal. The behaviour is borrowed
 * whole — anchored zoom, drag-to-pan by scrolling, a normalized centre in the
 * saved state — because two viewers in one app that zoom differently is worse
 * than either choice.
 *
 * Everything else that belongs to images stays there: no inversion, no rotation
 * or flip, no histogram, no adjustment pipeline, no colour picker, no slideshow.
 * The self-test asserts that list by name.
 */

import type { FileHandle } from "../../files";
import {
  BaseViewerInstance,
  type CopyableContent,
  type CopyScope,
  type TextSegment,
  type ThumbnailRequest,
  type ThumbnailResult,
  type ToolbarControl,
  type Unsubscribe,
  type ViewerCapabilities,
  type ViewerCopyApi,
  type ViewerHost,
  type ViewerInstance,
  type ViewerKeybind,
  type ViewerKeybindApi,
  type ViewerLocation,
  type ViewerSearchApi,
  type ViewerToolbarApi,
} from "../contract";
import {
  videoKeybinds,
  videoMenuItems,
  videoToolbarControls,
  type VideoActions,
} from "./actions";
import { emptyContainerInfo, type ContainerInfo } from "./container";
import { captureFrame, copyFrame, frameToPng, releaseFrame, saveFrame } from "./engine/capture";
import { closeVideoMenu, openVideoMenu } from "./engine/menu";
import { VideoInspector, type VideoPanel } from "./engine/panels";
import {
  inPictureInPicture,
  isFullscreen,
  togglePictureInPicture,
  toggleFullscreen,
  watchFullscreen,
  watchPictureInPicture,
} from "./engine/presentation";
import { Scrubber } from "./engine/scrubber";
import { CaptionOverlay, type SidecarSubtitles } from "./engine/subtitles";
import { Thumbnailer } from "./engine/thumbnailer";
import { SUBTITLES_OFF, TrackModel } from "./engine/tracks";
import { formatTimecode, PLAYBACK_SPEEDS, Transport, type PlaybackSpeed } from "./engine/transport";
import { VideoView } from "./engine/view";
import { VIDEO_PLUGIN_ID } from "./id";
import type { LoadedVideo } from "./mount";
import { subscribeToVideoSettings, updateVideoSettings, videoSettings } from "./settings";
import { parseVideoState, type VideoViewerState } from "./state";

/**
 * How often the captions, the timeline and the readouts are refreshed while
 * something is moving.
 *
 * `timeupdate` alone is not enough — it is specified to fire about four times a
 * second, which makes a scrubber visibly step rather than glide. And
 * `requestAnimationFrame` is wrong for the reason AGENTS.md records: a window
 * that is not being composited never gets a frame, so a video behind another
 * window would stop updating its own captions. A 100 ms interval keeps running
 * and costs a handful of style writes.
 *
 * It is the *floor*, not the whole story. See {@link VideoViewerInstance} on the
 * frame callback, which takes over whenever the compositor is actually running
 * and the chrome is on screen.
 */
const RENDER_TICK_MS = 100;

/** The toolbar lives in React; re-rendering it ten times a second is wasteful. */
const TOOLBAR_NOTIFY_MS = 250;

/** Where the contract thumbnail is taken from, as a fraction of the duration. */
const THUMBNAIL_POSITION = 0.1;

export interface VideoInstanceInit {
  readonly container: HTMLElement;
  readonly loaded: LoadedVideo;
  readonly initialState: unknown;
  readonly host?: ViewerHost;
}

export class VideoViewerInstance extends BaseViewerInstance implements ViewerInstance {
  readonly pluginId = VIDEO_PLUGIN_ID;

  readonly toolbar: ViewerToolbarApi;
  readonly keybinds: ViewerKeybindApi;
  readonly copy: ViewerCopyApi;
  /**
   * Assigned rather than declared, because whether this file has caption text
   * is not known when the tile is built — see {@link adoptDetails}. Until then
   * the property is absent and `capabilities.search` is false, which is the
   * contract's "optional capability, not disabled capability" holding true at
   * every instant rather than only at the end.
   */
  search?: ViewerSearchApi;

  #loaded: LoadedVideo;
  #host: ViewerHost | undefined;

  #view: VideoView;
  #transport: Transport;
  #scrubber: Scrubber;
  #captions: CaptionOverlay;
  #tracks: TrackModel;
  #inspector: VideoInspector;
  #thumbnailer: Thumbnailer | null = null;
  #thumbnailerTried = false;

  /**
   * What the container turned out to hold. Empty until the parse lands.
   *
   * Read through this field and never through `#loaded`, which no longer
   * carries it: the tile exists before the header has been read, so every
   * consumer has to be correct for "not yet" as well as for "here".
   */
  #info: ContainerInfo = emptyContainerInfo();
  /**
   * Whether `#adoptDetails` has run.
   *
   * The sidecars are deliberately not kept beside `#info`: `TrackModel` is the
   * only thing that ever wanted them, it holds them itself, and a second copy
   * here would be a field that exists to be passed through.
   */
  #detailsReady = false;
  /**
   * The state this tile opened with, kept so the parts of it that need the
   * container — the audio and subtitle selections — can be applied when the
   * parse arrives rather than dropped for having been early.
   */
  #wanted: VideoViewerState;
  #preferSubtitles: boolean;

  #panel: VideoPanel = "none";
  #resumeAfterScrub = false;

  #renderTimer: ReturnType<typeof setInterval> | null = null;
  #frameHandle: number | null = null;
  #lastToolbarNotify = 0;
  #thumbnailCache = new Map<string, ThumbnailResult>();

  #toolbarListeners = new Set<() => void>();
  #keybindListeners = new Set<() => void>();
  #unsubscribeSettings: Unsubscribe;
  #unwatchFullscreen: () => void;
  #unwatchPip: () => void;
  #abort = new AbortController();
  #disposing = false;

  constructor(init: VideoInstanceInit) {
    super();
    this.#loaded = init.loaded;
    this.#host = init.host;

    const settings = videoSettings();
    const initial = parseVideoState(init.initialState);
    // An audio-only file has no frames to preview. Measured once, because it is
    // a property of the file and cannot change while the tile is open.
    const hasPicture = init.loaded.measured.width > 0;
    this.#wanted = initial;
    this.#preferSubtitles = settings.preferSubtitles;
    this.#panel = initial.panel;

    this.#view = new VideoView({
      container: init.container,
      // The element the load already measured and filled, not a fresh one.
      video: init.loaded.element,
      callbacks: {
        onTogglePlay: () => this.#transport.toggle(),
        // The chip walks the three speeds a review is run at; `x` and the menu
        // keep the full ladder. Both end at `Transport.setSpeed`, which applies
        // in either direction, so clicking it while reversing changes how fast
        // the film runs backwards.
        onCycleSpeed: () => this.#transport.cycleQuickSpeed(),
        onToggleFullscreen: () => void this.#toggleFullscreen(),
        onContextMenu: (at) => openVideoMenu(at, videoMenuItems(this.#actions())),
        onZoomChange: (info) => this.#onZoomChange(info.continuous),
        onPersist: () => this.#host?.requestPersist(),
      },
    });

    // No frame rate yet: it lives in the container header, which is still being
    // read. `#adoptDetails` hands it over, and until then the transport steps at
    // its own stated assumption and says that it is assuming.
    this.#transport = new Transport({
      video: this.#view.video,
      callbacks: {
        onChange: () => this.#render(),
        onAnnounce: (message, tone) => this.#view.announce(message, tone),
        // The transport knows where the element goes blank; the view knows how
        // to cover it. See `engine/hold.ts`.
        onHoldFrame: (active) => this.#view.holdFrame(active),
      },
    });

    this.#scrubber = new Scrubber({
      transport: this.#transport,
      // Indirect on purpose, so the second decoder is opened by the first hover
      // rather than by the mount. See `#previewThumbnailer`.
      thumbnailer: {
        get available() {
          // Read live rather than from the snapshot above: turning previews off
          // in one tile should stop them in every tile, which is the same rule
          // volume follows, and a captured boolean would leave this one tile
          // still opening decoders.
          return videoSettings().scrubberPreviews && hasPicture;
        },
        frameAt: (ms, width) => this.#previewFrame(ms, width),
      },
      callbacks: {
        onSeek: (milliseconds) => this.#transport.seekTo(milliseconds),
        onScrubStateChange: (scrubbing) => this.#onScrubStateChange(scrubbing),
      },
    });
    this.#view.mountScrubber(this.#scrubber.root);

    this.#captions = new CaptionOverlay(this.#view.captionHost);

    this.#tracks = new TrackModel({ video: this.#view.video });

    this.#inspector = new VideoInspector(this.#view.panelHost, {
      onSelectAudio: (id) => this.#selectAudio(id),
      onSelectSubtitle: (id) => this.#selectSubtitle(id),
      onSeek: (milliseconds) => this.#transport.seekTo(milliseconds),
    });

    this.toolbar = {
      getControls: () => this.#toolbarControls(),
      onControlsChange: (listener) => subscribe(this.#toolbarListeners, listener),
    };

    this.keybinds = {
      groupTitle: "Video",
      getKeybinds: () => this.#keybindDefinitions(),
      // The declaration genuinely changes: the chapter, subtitle and capture
      // bindings are enabled by what this file turned out to contain, and the
      // subtitle one changes again when a sidecar selection lands.
      onKeybindsChange: (listener) => subscribe(this.#keybindListeners, listener),
    };

    this.copy = { getCopyable: (scope) => this.#getCopyable(scope) };

    // A settings change is an application-wide preference, so every open tile
    // follows it rather than only the one it was changed in. This is what makes
    // the brief's "volume remembered as a shared preference" true across tiles.
    this.#unsubscribeSettings = subscribeToVideoSettings((next) => {
      this.#applyAudioSettings(next.volume, next.muted);
      this.#notifyToolbar(true);
    });

    this.#unwatchFullscreen = watchFullscreen(() => {
      // Entering or leaving fullscreen is a deliberate act with a visible
      // result, so the chrome comes up to acknowledge it and then times out
      // like anything else.
      this.#view.wake();
      this.#notifyToolbar(true);
    });
    this.#unwatchPip = watchPictureInPicture(this.#view.video, () => this.#notifyToolbar(true));

    this.#view.video.addEventListener(
      "loadedmetadata",
      () => {
        // The natural size is only known now, and `actual` needs it.
        this.#view.layout();
        this.#refreshPanel();
        this.#notifyToolbar(true);
      },
      { signal: this.#abort.signal },
    );

    // A failure *after* mount — a disc unplugged mid-playback, a decoder that
    // gave up on a later part of the stream. Mount already measured the file, so
    // anything arriving here is new information and belongs on the tile.
    this.#view.video.addEventListener(
      "error",
      () => {
        if (this.#disposing) return;
        const error = this.#view.video.error;
        this.#host?.reportError({
          code: error?.code === MediaError.MEDIA_ERR_NETWORK ? "not-found" : "corrupt",
          message: `${this.#loaded.file.name} stopped playing.`,
          detail: error?.message || "the media element reported a failure during playback",
          recoverable: error?.code === MediaError.MEDIA_ERR_NETWORK,
        });
      },
      { signal: this.#abort.signal },
    );

    this.#applyInitialState(initial);
    this.#refreshPanel();
    this.#render();
    this.setStatus("ready");

    // The one thing worth interrupting a film to say: a name that disagrees with
    // the file's contents is the usual reason a file "that plays everywhere
    // else" behaves oddly, and the user can act on it. Said once, over the
    // picture, and for longer than an ordinary message — where it used to be a
    // permanent strip below the video.
    //
    // Everything else the parse noticed stays in the info panel. Those notes are
    // real and worth keeping — an approximate AVI duration, subtitles that
    // cannot be reached — but they are answers to questions someone went looking
    // for, not news. A permanent orange line explaining a container's internal
    // structure over a video that is playing correctly is noise, and noise in
    // that position trains people to stop reading it.
    if (init.loaded.mismatch) this.#view.announce(init.loaded.mismatch, "notice");

    // The tile is live from here. Everything the container had to say arrives
    // after it and is folded in below — the film does not wait for a parse.
    void this.#loaded.details.then((details) => this.#adoptDetails(details));

    if (settings.autoplay) this.#transport.play();
  }

  /**
   * What this instance can do, re-read rather than fixed at mount.
   *
   * Two of these answers are properties of the *container*, which is still being
   * read when the tile is built: whether there is caption text to search, and
   * how many chapters there are to page through. A snapshot taken in the
   * constructor would say "no" to both for every file, permanently.
   *
   * So it is a getter, and `#adoptDetails` tells the shell to look again through
   * the contract's own `invalidate(["capabilities"])`. `SubdivisionRail` reads
   * `subdivisionCount` at render time and gets the chapter strip a moment after
   * the film appears, which is the intended shape of a late answer.
   */
  get capabilities(): ViewerCapabilities {
    return {
      // True only when there is caption text. See the class comment: when this
      // is false there is no `search` property either.
      search: this.#tracks.hasSearchableText,
      copy: true,
      // Phase 05's job. Declared false rather than half-implemented, because the
      // contract's rule is "optional capability, not disabled capability".
      annotation: false,
      toolbar: true,
      keybinds: true,
      thumbnail: this.#loaded.measured.width > 0,
      subdivisionCount: this.#info.chapters.length > 1 ? this.#info.chapters.length : undefined,
    };
  }

  /**
   * Takes the container's contents once they have been read.
   *
   * Everything here is additive — a track list where there was none, chapter
   * marks on a timeline that had none, a real frame rate in place of an
   * assumption — so there is no intermediate state to unwind, only one to fill
   * in. The order matters in one place: the remembered track selections are
   * applied *after* the model has the tracks, because before that there is
   * nothing for an id to resolve against.
   */
  #adoptDetails(details: { info: ContainerInfo; sidecars: readonly SidecarSubtitles[] }): void {
    if (this.#disposing) return;

    this.#info = details.info;
    this.#detailsReady = true;
    this.#tracks.adopt({ container: details.info.tracks, sidecars: details.sidecars });
    this.#scrubber.setChapters(details.info.chapters);
    this.#transport.setFrameRate(
      details.info.tracks.find((track) => track.kind === "video")?.frameRate,
    );

    this.#applyTrackState(this.#wanted, { preferSubtitles: this.#preferSubtitles });
    // Spent: it applies to opening a file, not to every later restore.
    this.#preferSubtitles = false;

    if (this.#tracks.hasSearchableText && !this.search) {
      this.search = {
        extractText: (options) => this.#extractText(options),
        reveal: (location, options) => this.reveal(location, options),
      };
    }

    this.#refreshPanel();
    this.#render();
    this.#notifyToolbar(true);
    this.#notifyKeybinds();
    // Search, the chapter rail and the audio-dependent toolbar control all
    // depend on what just arrived, and the shell caches every one of them.
    this.#host?.invalidate(["capabilities", "text"]);
  }

  get file(): FileHandle {
    return this.#loaded.file;
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  /** Everything that can be applied before the container has been read. */
  #applyInitialState(state: VideoViewerState): void {
    const settings = videoSettings();
    this.#applyAudioSettings(settings.volume, settings.muted);

    this.#view.setZoomMode(state.scaleMode, state.zoom);
    this.#restoreCenter({ x: state.centerX, y: state.centerY });
    this.#inspector.setPanel(state.panel);

    const speed = nearestSpeed(state.speed);
    this.#transport.setSpeed(speed);

    if (state.positionMs > 0) {
      // Deferred to `loadedmetadata`: a seek before the duration is known is
      // silently dropped by every engine, which would look like the position
      // simply not being remembered.
      const seek = (): void => this.#transport.seekTo(state.positionMs);
      if (this.#view.video.readyState >= HTMLMediaElement.HAVE_METADATA) seek();
      else this.#view.video.addEventListener("loadedmetadata", seek, { once: true });
    }

    if (state.loopInMs !== undefined && state.loopOutMs !== undefined) {
      this.#transport.restoreLoop({ inMs: state.loopInMs, outMs: state.loopOutMs });
    }
  }

  /**
   * Puts the view back where it was looking, once there is something to look at.
   *
   * Deferred to `loadedmetadata` for the same reason the position seek is: the
   * frame's box is derived from the media's own pixels, and until those are
   * known it is zero — so a centre applied now would be applied to nothing and
   * silently discarded, which reads as the pan not being remembered.
   */
  #restoreCenter(center: { x: number; y: number }): void {
    const apply = (): void => {
      if (this.#disposing) return;
      this.#view.layout();
      this.#view.setCenterFraction(center);
    };
    if (this.#view.video.readyState >= HTMLMediaElement.HAVE_METADATA) apply();
    else {
      this.#view.video.addEventListener("loadedmetadata", apply, {
        once: true,
        signal: this.#abort.signal,
      });
    }
  }

  /**
   * A zoom or fit-mode change: say what it became, and remember it.
   *
   * The announcement is not decoration, for the same reason the volume one is
   * not: the tile's bar has no zoom readout — the shared toolbar is capped at
   * the five controls the brief names and the tile's bar gave up everything but
   * the timeline — so a keyboard zoom with no feedback is a key you press twice.
   * The badge over the picture is the persistent half of the same answer.
   */
  #onZoomChange(continuous: boolean): void {
    // Not during a pinch or a ctrl-scroll: the picture is changing under the
    // pointer, which is its own feedback, and a live region rewritten at the
    // pointer's event rate is noise to a screen reader rather than help.
    if (!continuous) this.#view.announce(this.#zoomLabel());
    // Throttled, like every other high-rate notification here — the toolbar
    // lives in React and a forced re-render per wheel event is the one thing a
    // zoom gesture cannot afford.
    this.#notifyToolbar();
    this.#host?.requestPersist();
  }

  #zoomLabel(): string {
    const mode = this.#view.zoomMode;
    const percent = Math.round(this.#view.zoomPercent * 10) / 10;
    if (mode === "custom") return `${percent}%`;
    return `${mode === "actual" ? "actual size" : mode} — ${percent}%`;
  }

  /**
   * The parts of a remembered state that need the container to exist.
   *
   * Run from `#adoptDetails`, and from `restore()` when the container is already
   * known. A track id is only meaningful against a track list, so applying these
   * at mount — before the header is parsed — would resolve every one of them to
   * nothing and silently drop a remembered choice.
   *
   * `preferSubtitles` is honoured only on the first pass. It means "turn
   * subtitles on when a file has them", which is a statement about opening a
   * file; applying it again on a restore would switch them back on for someone
   * who had turned them off in this very tile.
   */
  #applyTrackState(state: VideoViewerState, options?: { preferSubtitles?: boolean }): void {
    if (state.audioTrackId) {
      // Silently, and without a message when it does not resolve: a remembered
      // track that no longer exists is a stale layout, not a fault, and the file
      // plays its own default.
      this.#tracks.selectAudio(state.audioTrackId);
    }

    const preferSubtitles = options?.preferSubtitles ?? false;
    const wanted =
      state.subtitleTrackId !== SUBTITLES_OFF
        ? state.subtitleTrackId
        : preferSubtitles
          ? this.#tracks.nextSubtitleId()
          : SUBTITLES_OFF;
    if (wanted !== SUBTITLES_OFF) {
      const cues = this.#tracks.selectSubtitle(wanted);
      if (cues) this.#captions.setCues(cues);
    }
  }

  // -------------------------------------------------------------------------
  // The render loop
  // -------------------------------------------------------------------------

  /**
   * Refreshes everything that tracks the playhead. Cheap, and called often.
   *
   * "Everything" is two lists, and the split is what keeps a playing film from
   * paying for chrome nobody is looking at:
   *
   *   - **The captions are always drawn.** They are part of the picture. They
   *     are also nearly free — `CaptionOverlay.update` compares against what is
   *     on screen and returns without touching the DOM for seven calls out of
   *     eight, which for a two-second subtitle is most of them.
   *   - **The readouts and the timeline are drawn only when the chrome is up.**
   *     A timecode and a scrubber that nobody can see are a style
   *     recalculation over a decoding video ten times a second, forever, for
   *     no result. `VideoView` decides visibility; this only asks.
   */
  #render(): void {
    if (this.#disposing) return;

    // `view.update` still runs while the chrome is hidden — it is what learns
    // that playback started or stopped, which is what decides visibility — but
    // it returns before writing any readout. See `VideoView.update`.
    this.#view.update({
      playing: this.#transport.playing,
      currentMs: this.#transport.currentMs,
      durationMs: this.#transport.durationMs,
      shuttleRate: this.#transport.shuttleRate,
      // For the rate badge, which is the one readout that stays on screen after
      // the chrome has faded — see `engine/view.ts`, "The state badges".
      speed: this.#transport.speed,
      // Only when the file said so. A timecode showing frames derived from an
      // assumed 25 fps would read as exact and be wrong.
      frameRate: this.#transport.frameRateIsAssumed ? undefined : this.#transport.frameRate,
    });
    // Always, even with the bar hidden: `sync` is what tells the timeline's
    // animation to stop when the bar goes and where to resume from when it comes
    // back, and it is two comparisons when nothing has changed. The heavier half
    // — the buffered extent, the loop region, the chapter marks, the aria state
    // — is still skipped entirely while nobody can see it.
    this.#scrubber.sync(this.#view.chromeVisible);
    if (this.#view.chromeVisible) this.#scrubber.update();
    this.#captions.update(this.#transport.currentMs);

    this.#syncRenderTicker();
    this.#notifyToolbar();
  }

  /**
   * Keeps a tick running while the playhead is moving, and stops it afterwards.
   *
   * Two sources, because neither is sufficient alone:
   *
   *   - **`requestVideoFrameCallback`** fires once per frame the compositor
   *     actually presents, and it is the only thing that knows *which* frame
   *     that is: it carries the presentation timestamp `Transport.displayMs`
   *     extrapolates from and the captions and the timecode's frame field are
   *     read against. It used to be described here as what made the scrubber
   *     glide rather than step, which stopped being true when `engine/glide.ts`
   *     was written — the bar is on the film's own timeline now and does not
   *     need a tick at all. It is also self-throttling: a tile tabbed behind
   *     another presents no frames and therefore costs nothing.
   *   - **A 100 ms interval**, underneath it, because self-throttling is a
   *     liability as well as a feature. AGENTS.md records that a window which is
   *     not being composited never gets a frame; the captions still have to
   *     change on a video playing in that state, and the frame callback will not
   *     deliver them. The interval is the floor that keeps them honest.
   *
   * Running both is not double work. The frame callback re-arms only while the
   * chrome is visible, and `#render` is idempotent — a tick that finds nothing
   * changed writes nothing.
   */
  #syncRenderTicker(): void {
    const needed = this.#transport.playing || this.#transport.shuttleRate !== 0;

    if (needed && !this.#renderTimer && !this.#disposing) {
      this.#renderTimer = setInterval(() => this.#render(), RENDER_TICK_MS);
    } else if (!needed && this.#renderTimer) {
      clearInterval(this.#renderTimer);
      this.#renderTimer = null;
    }

    if (needed && this.#frameHandle === null && this.#view.chromeVisible) {
      this.#requestFrameTick();
    }
  }

  /**
   * Arms one frame callback, if this engine has them.
   *
   * Probed by calling it rather than by testing for the property, per AGENTS.md
   * — though here the two agree, and the reason it is written this way is that a
   * `null` handle is also how the "not supported" case turns itself off: the
   * request never lands, nothing re-arms, and the interval carries the tick on
   * its own with no branch anywhere else in this file.
   */
  #requestFrameTick(): void {
    const video = this.#view.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: { mediaTime?: number }) => void,
      ) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (!video.requestVideoFrameCallback) return;

    this.#frameHandle = video.requestVideoFrameCallback((_now, metadata) => {
      this.#frameHandle = null;
      if (this.#disposing) return;
      // The one thing this callback knows that nothing else does: exactly which
      // frame is on screen. `Transport.displayMs` uses it to give the timeline's
      // animation a reference that does not step, which is what stops the drift
      // correction from chasing the reference's own quantisation.
      if (typeof metadata?.mediaTime === "number") {
        this.#transport.noteFramePresented(metadata.mediaTime);
      }
      this.#render();
    });
  }

  #cancelFrameTick(): void {
    const video = this.#view.video as HTMLVideoElement & {
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (this.#frameHandle !== null) video.cancelVideoFrameCallback?.(this.#frameHandle);
    this.#frameHandle = null;
  }

  #onScrubStateChange(scrubbing: boolean): void {
    // The bar must not time out under the pointer that is dragging it.
    this.#view.setScrubbing(scrubbing);

    if (scrubbing) {
      this.#resumeAfterScrub = this.#transport.playing;
      this.#transport.pause();
      return;
    }
    if (this.#resumeAfterScrub) this.#transport.play();
    this.#resumeAfterScrub = false;
    this.#host?.requestPersist();
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------

  #applyAudioSettings(volume: number, muted: boolean): void {
    this.#view.video.volume = volume;
    this.#view.video.muted = muted;
    this.#render();
  }

  /**
   * Sets the shared volume, and says what it became.
   *
   * The saying is not decoration. There is no volume slider in the tile any more
   * — it, the mute button and the speed readout came out of the control bar so
   * that the timeline could have the width, and the level is now reached by
   * `Up`/`Down`, by `m`, by the context menu and by the toolbar's own control.
   * Three of those four are invisible from inside the tile, and a volume key
   * with no feedback at all is a key you press twice because you cannot tell
   * whether it worked.
   */
  #setVolume(volume: number): void {
    const bounded = Math.min(1, Math.max(0, volume));
    // Through the shared settings, not straight onto the element: this is a
    // preference every tile follows, and writing it here would leave the other
    // tiles and the next file at the old level.
    updateVideoSettings({ volume: bounded, muted: bounded === 0 ? videoSettings().muted : false });
    this.#view.wake();
    this.#view.announce(bounded === 0 ? "volume 0%" : `volume ${Math.round(bounded * 100)}%`);
  }

  #toggleMute(): void {
    const muted = !videoSettings().muted;
    updateVideoSettings({ muted });
    this.#view.wake();
    this.#view.announce(muted ? "muted" : `unmuted — volume ${Math.round(videoSettings().volume * 100)}%`);
  }

  // -------------------------------------------------------------------------
  // Tracks
  // -------------------------------------------------------------------------

  #selectAudio(id: string): void {
    if (this.#tracks.selectAudio(id)) {
      this.#view.announce("switched audio track");
      this.#host?.requestPersist();
    } else {
      this.#view.announce(
        "this webview does not expose audio track switching, so the file's default track keeps playing",
        "warn",
      );
    }
    this.#refreshPanel();
  }

  #selectSubtitle(id: string): void {
    const cues = this.#tracks.selectSubtitle(id);
    if (!cues) {
      this.#view.announce("that subtitle track could not be read", "warn");
      this.#refreshPanel();
      return;
    }
    this.#captions.setCues(cues);
    this.#captions.update(this.#transport.currentMs);
    this.#view.announce(id === SUBTITLES_OFF ? "subtitles off" : `subtitles: ${this.#subtitleLabel()}`);
    this.#refreshPanel();
    this.#notifyKeybinds();
    this.#host?.requestPersist();
    // The searchable text changed, and the shell caches it.
    this.#host?.invalidate(["text"]);
  }

  #cycleSubtitles(): void {
    this.#selectSubtitle(this.#tracks.nextSubtitleId());
  }

  #subtitleLabel(): string {
    const id = this.#tracks.selectedSubtitleId;
    const track = this.#tracks.subtitleTracks().find((entry) => entry.id === id);
    return track?.label ?? "off";
  }

  // -------------------------------------------------------------------------
  // Chapters
  // -------------------------------------------------------------------------

  #chapterStep(direction: 1 | -1): void {
    const chapters = this.#info.chapters;
    if (chapters.length === 0) return;
    const at = this.#transport.currentMs;

    if (direction < 0) {
      // A small grace window before the current mark, so "previous chapter"
      // pressed a second after a chapter starts goes to the one before it
      // rather than back to the same mark — which is what every disc player
      // does and what the key is for.
      const previous = [...chapters].reverse().find((chapter) => chapter.startMs < at - 1500);
      this.#transport.seekTo(previous?.startMs ?? 0);
      return;
    }

    const next = chapters.find((chapter) => chapter.startMs > at + 50);
    if (!next) {
      this.#view.announce("already in the last chapter");
      return;
    }
    this.#transport.seekTo(next.startMs);
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  async #toggleFullscreen(): Promise<void> {
    const result = await toggleFullscreen(this.#view.root);
    if (!result.ok && result.message) this.#view.announce(result.message, "warn");
    this.#notifyToolbar(true);
  }

  async #togglePictureInPicture(): Promise<void> {
    const result = await togglePictureInPicture(this.#view.video);
    if (result.message) this.#view.announce(result.message, result.ok ? "info" : "warn");
    this.#notifyToolbar(true);
  }

  // -------------------------------------------------------------------------
  // Frame capture
  // -------------------------------------------------------------------------

  async #copyFrame(): Promise<void> {
    const frame = captureFrame(this.#view.video);
    if (!frame) {
      this.#view.announce("this frame could not be captured", "warn");
      return;
    }
    try {
      const result = await copyFrame(frame);
      this.#view.announce(result.message, result.ok ? "info" : "warn");
    } finally {
      releaseFrame(frame);
    }
  }

  async #exportFrame(): Promise<void> {
    const frame = captureFrame(this.#view.video);
    if (!frame) {
      this.#view.announce("this frame could not be captured", "warn");
      return;
    }
    try {
      const result = await saveFrame(frame, {
        baseName: stripExtension(this.#loaded.file.name),
        timecode: formatTimecode(frame.atMs),
      });
      // An empty message is a cancelled dialog, which is not worth a line.
      if (result.message) this.#view.announce(result.message, result.ok ? "info" : "warn");
    } finally {
      releaseFrame(frame);
    }
  }

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  #refreshPanel(): void {
    this.#inspector.setData({
      formatLabel: this.#loaded.format.label,
      fileName: this.#loaded.file.name,
      fileSize: this.#loaded.file.size,
      filePath: this.#loaded.file.path,
      modifiedAt: this.#loaded.file.modifiedAt,
      info: this.#info,
      measured: {
        width: this.#view.video.videoWidth,
        height: this.#view.video.videoHeight,
        durationMs: this.#transport.durationMs,
      },
      // What frame-stepping actually moves by, which is the container's rate
      // when it stated one and the transport's assumption when it did not.
      frameRate: {
        value: this.#transport.frameRate,
        assumed: this.#transport.frameRateIsAssumed,
      },
      source: { kind: this.#loaded.sourceKind, streaming: this.#loaded.streaming },
      audioTracks: this.#tracks.audioTracks(),
      subtitleTracks: this.#tracks.subtitleTracks(),
      selectedAudioId: this.#tracks.selectedAudioId,
      selectedSubtitleId: this.#tracks.selectedSubtitleId,
    });
  }

  #setPanel(panel: VideoPanel): void {
    this.#panel = panel;
    this.#inspector.setPanel(panel);
    this.#refreshPanel();
    this.#host?.requestPersist();
  }

  // -------------------------------------------------------------------------
  // Contributions
  // -------------------------------------------------------------------------

  /** The verb list the toolbar, the keybinds and the context menu all read. */
  #actions(): VideoActions {
    const transport = this.#transport;
    const view = this.#view;

    return {
      get playing() {
        return transport.playing;
      },
      get currentMs() {
        return transport.currentMs;
      },
      get durationMs() {
        return transport.durationMs;
      },
      get speed() {
        return transport.speed;
      },
      get shuttleRate() {
        return transport.shuttleRate;
      },
      get muted() {
        return view.video.muted;
      },
      get volume() {
        return view.video.volume;
      },
      // Optimistic until the header has been read. A volume control that turns
      // out to be unnecessary is a smaller wrong than one that appears a second
      // after the file opens — the latter reads as the app having decided the
      // film is silent and then changed its mind.
      hasAudio: !this.#detailsReady || this.#info.tracks.some((track) => track.kind === "audio"),
      get scaleMode() {
        return view.zoomMode;
      },
      get zoomPercent() {
        return view.zoomPercent;
      },
      panel: this.#panel,
      get loopIn() {
        return transport.loopIn;
      },
      get loopOut() {
        return transport.loopOut;
      },
      chapterCount: this.#info.chapters.length,
      subtitleLabel: this.#subtitleLabel(),
      hasSubtitleChoice: this.#tracks.subtitleTracks().filter((track) => track.available).length > 1,
      hasPicture: this.#loaded.measured.width > 0,
      pictureInPicture: inPictureInPicture(this.#view.video),
      fullscreen: isFullscreen(this.#view.root),

      // `wake()` on everything that moves the playhead or changes what the bar
      // is showing. The chrome hides itself while a film plays untouched, so an
      // action taken from a keybind has to bring back the readout that says
      // where it landed — otherwise a frame step is a key that appears to do
      // nothing.
      togglePlayback: () => {
        view.wake();
        transport.toggle();
      },
      seekBy: (milliseconds) => {
        view.wake();
        transport.seekBy(milliseconds);
      },
      seekTo: (milliseconds) => {
        view.wake();
        transport.seekTo(milliseconds);
      },
      stepFrame: (direction) => {
        view.wake();
        transport.stepFrame(direction);
      },
      shuttle: (direction) => {
        view.wake();
        transport.shuttle(direction);
      },
      cycleSpeed: () => {
        view.wake();
        transport.cycleSpeed();
      },
      cycleLoop: () => {
        view.wake();
        transport.cycleLoop();
      },
      clearLoop: () => {
        view.wake();
        transport.clearLoop();
      },
      previousChapter: () => {
        view.wake();
        this.#chapterStep(-1);
      },
      nextChapter: () => {
        view.wake();
        this.#chapterStep(1);
      },
      setScaleMode: (mode) => {
        view.wake();
        // No `#scaleMode` field to keep in step: the view is the one place the
        // mode lives, and `serialize()` reads it from there. A second copy here
        // was a copy that could disagree once zoom could change the mode without
        // going through this action.
        view.setScaleMode(mode);
      },
      zoomIn: () => {
        view.wake();
        view.stepZoom(1);
      },
      zoomOut: () => {
        view.wake();
        view.stepZoom(-1);
      },
      cycleInspector: () => {
        this.#panel = this.#inspector.cycle();
        this.#refreshPanel();
        this.#host?.requestPersist();
      },
      setInspector: (panel) => this.#setPanel(panel),
      cycleSubtitles: () => this.#cycleSubtitles(),
      toggleMute: () => this.#toggleMute(),
      setVolume: (volume) => this.#setVolume(volume),
      nudgeVolume: (delta) => this.#setVolume(view.video.volume + delta),
      copyFrame: () => void this.#copyFrame(),
      exportFrame: () => void this.#exportFrame(),
      togglePictureInPicture: () => void this.#togglePictureInPicture(),
      toggleFullscreen: () => void this.#toggleFullscreen(),
    };
  }

  #toolbarControls(): readonly ToolbarControl[] {
    return videoToolbarControls(this.#actions());
  }

  #keybindDefinitions(): readonly ViewerKeybind[] {
    return videoKeybinds(this.#actions());
  }

  /**
   * Tells the shell the toolbar changed, at most four times a second.
   *
   * `force` skips the throttle for the changes a user just made with a click —
   * a mute toggle that took a quarter of a second to show would read as a
   * dropped press. The throttle exists for the position readout, which changes
   * ten times a second and is the only reason this is called that often.
   */
  #notifyToolbar(force = false): void {
    const now = Date.now();
    if (!force && now - this.#lastToolbarNotify < TOOLBAR_NOTIFY_MS) return;
    this.#lastToolbarNotify = now;
    for (const listener of this.#toolbarListeners) {
      try {
        listener();
      } catch (thrown) {
        console.error("[video] toolbar listener threw", thrown);
      }
    }
  }

  #notifyKeybinds(): void {
    for (const listener of this.#keybindListeners) {
      try {
        listener();
      } catch (thrown) {
        console.error("[video] keybind listener threw", thrown);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async #extractText(options?: {
    subdivision?: number;
    signal?: AbortSignal;
  }): Promise<readonly TextSegment[]> {
    options?.signal?.throwIfAborted();

    const segments: TextSegment[] = [];
    const chapters = this.#info.chapters;

    for (const group of this.#tracks.allCues()) {
      for (const cue of group.cues) {
        // A subdivision here is a chapter, so a request for one narrows the cues
        // to the span of that chapter rather than returning everything.
        const subdivision = chapterIndexAt(chapters, cue.startMs);
        if (options?.subdivision !== undefined && subdivision !== options.subdivision) continue;
        segments.push({
          text: cue.text,
          location: {
            subdivision,
            // The timestamp is what `reveal` seeks to. A caption has no box on a
            // page, so `rect` and `range` are left off rather than faked.
            anchor: { timeMs: cue.startMs, track: group.track },
          },
        });
      }
    }

    return segments;
  }

  async reveal(location: ViewerLocation, _options?: { highlight?: boolean }): Promise<void> {
    const anchor = location.anchor as { timeMs?: number } | undefined;
    if (typeof anchor?.timeMs === "number") {
      this.#transport.seekTo(anchor.timeMs);
      return;
    }

    // No timestamp: a subdivision on its own, which the thumbnail rail sends
    // when a chapter is clicked.
    const chapter = this.#info.chapters[location.subdivision ?? 0];
    if (chapter) this.#transport.seekTo(chapter.startMs);
  }

  // -------------------------------------------------------------------------
  // Copy
  // -------------------------------------------------------------------------

  /**
   * The current frame, as image data.
   *
   * Every scope gives the same answer, and that is the honest one. A video has
   * no selection to copy, and a normalized region of a frame is a crop the shell
   * asked for over a *rendered page* — cropping a frame and calling it "the
   * video" would be a different thing than what was asked for. Phase 05's
   * annotation work is where a region of a frame becomes meaningful.
   */
  async #getCopyable(_scope: CopyScope): Promise<readonly CopyableContent[]> {
    const frame = captureFrame(this.#view.video);
    if (!frame) return [];
    try {
      const png = await frameToPng(frame);
      if (!png) return [];
      return [
        {
          kind: "image",
          blob: png.blob,
          mimeType: png.mimeType,
          width: png.width,
          height: png.height,
        },
      ];
    } finally {
      releaseFrame(frame);
    }
  }

  // -------------------------------------------------------------------------
  // Thumbnails
  // -------------------------------------------------------------------------

  /**
   * The preview decoder, opened the first time something actually needs it.
   *
   * It is a second `<video>` on the same source: a second decoder, a second
   * open file and a second connection to the loopback server, held for as long
   * as the tile is. That is real on a machine playing several 4K files at once,
   * and it used to be paid by every tile at mount — including the great many
   * that are opened, watched and closed without the timeline ever being hovered
   * or a sidebar preview ever being asked for.
   *
   * So it is opened on demand and only once: `#thumbnailerTried` makes a second
   * caller reuse the answer rather than re-testing the conditions, including
   * when the answer was "no".
   */
  #previewThumbnailer(): Thumbnailer | null {
    if (this.#thumbnailerTried) return this.#thumbnailer;
    this.#thumbnailerTried = true;

    // An audio-only file has no frames to preview, and the preference is what
    // lets someone on a constrained machine turn the second decoder off.
    if (this.#disposing) return null;
    if (!videoSettings().scrubberPreviews) return null;
    if (this.#loaded.measured.width <= 0) return null;

    this.#thumbnailer = new Thumbnailer(this.#loaded.url);
    return this.#thumbnailer;
  }

  /** The scrubber's hover preview, via the on-demand decoder above. */
  #previewFrame(milliseconds: number, maxWidth?: number) {
    const thumbnailer = this.#previewThumbnailer();
    if (!thumbnailer?.available) return Promise.resolve(null);
    return thumbnailer.frameAt(milliseconds, maxWidth);
  }

  /**
   * A frame from about a tenth of the way in, as the brief asks.
   *
   * Ten percent rather than the first frame, and the reason is worth stating: a
   * film's first frame is black about half the time — a fade-in, a slate, a
   * leader — and a preview grid of black rectangles is no preview at all.
   */
  async thumbnail(request: ThumbnailRequest): Promise<ThumbnailResult> {
    const key = `${request.subdivision ?? 0}:${request.maxWidth}x${request.maxHeight}`;
    const cached = this.#thumbnailCache.get(key);
    if (cached) return cached;

    const fallback: ThumbnailResult = {
      kind: "icon",
      icon: "video",
      label: this.#loaded.format.label,
    };

    if (request.signal?.aborted) return fallback;
    const thumbnailer = this.#previewThumbnailer();
    if (!thumbnailer?.available) return fallback;

    const chapter = this.#info.chapters[request.subdivision ?? -1];
    const duration = this.#transport.durationMs || this.#loaded.measured.durationMs || 0;
    const at = chapter ? chapter.startMs : duration * THUMBNAIL_POSITION;

    const frame = await thumbnailer.frameAt(at, request.maxWidth);
    // Not an error, and not cached: a decoder that would not seek right now may
    // well seek later, and caching the fallback would make one bad moment
    // permanent for this tile.
    if (!frame || request.signal?.aborted) return fallback;

    const result: ThumbnailResult = {
      kind: "canvas",
      canvas: frame.canvas,
      width: frame.width,
      height: frame.height,
    };
    this.#thumbnailCache.set(key, result);
    return result;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  serialize(): unknown {
    const loop = this.#transport.loopRange;
    const center = this.#view.centerFraction();
    const state: VideoViewerState = {
      positionMs: Math.round(this.#transport.currentMs),
      scaleMode: this.#view.zoomMode,
      zoom: this.#view.zoomPercent,
      centerX: center.x,
      centerY: center.y,
      panel: this.#panel,
      speed: this.#transport.speed,
      audioTrackId: this.#tracks.selectedAudioId ?? undefined,
      subtitleTrackId: this.#tracks.selectedSubtitleId,
      loopInMs: loop ? Math.round(loop.inMs) : undefined,
      loopOutMs: loop ? Math.round(loop.outMs) : undefined,
    };
    return state;
  }

  restore(state: unknown): void {
    if (this.#disposing) return;
    const parsed = parseVideoState(state);
    this.#panel = parsed.panel;
    // Remembered as well as applied: a restore that lands while the header is
    // still being parsed has no track list to resolve its ids against, and
    // `#adoptDetails` replays them from here when it does.
    this.#wanted = parsed;
    this.#applyInitialState(parsed);
    this.#applyTrackState(parsed);
    this.#refreshPanel();
    this.#render();
  }

  /**
   * The tile's box changed.
   *
   * The contract's optional hook, implemented now that a fit mode is a computed
   * scale rather than an `object-fit` the compositor re-applies for free. The
   * view observes its own stage as well — the two are not redundant, because
   * neither covers the other's case: this one fires for a re-tile the observer
   * would also see, and the observer fires for fullscreen, where the shell's
   * container never changes size at all.
   */
  resize(): void {
    if (this.#disposing) return;
    this.#view.resize();
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.#disposing) return;
    this.#disposing = true;

    this.#abort.abort();
    if (this.#renderTimer) clearInterval(this.#renderTimer);
    this.#renderTimer = null;
    this.#cancelFrameTick();

    this.#unsubscribeSettings();
    this.#unwatchFullscreen();
    this.#unwatchPip();
    closeVideoMenu();

    this.#toolbarListeners.clear();
    this.#keybindListeners.clear();

    for (const result of this.#thumbnailCache.values()) {
      // The shell owns a returned bitmap; a canvas it never asked to keep is
      // ours, and a cache of full-size frames is megabytes per tile.
      if (result.kind === "canvas" && result.canvas instanceof HTMLCanvasElement) {
        result.canvas.width = 0;
        result.canvas.height = 0;
      }
    }
    this.#thumbnailCache.clear();

    this.#transport.destroy();
    this.#scrubber.destroy();
    this.#captions.destroy();
    this.#thumbnailer?.destroy();
    this.#thumbnailer = null;
    // Last: releasing the element's decoder is what the two above depend on
    // having been told about first, and the object URL — when this platform
    // needed one — is only safe to revoke once nothing is pointed at it.
    this.#view.destroy();
    this.#loaded.releaseUrl?.();

    this.markDisposed();
  }

  /** Test hook: whether every decoder and timer has been given back. */
  get holdsResources(): boolean {
    return this.#renderTimer !== null || this.#frameHandle !== null || this.#thumbnailer !== null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subscribe(listeners: Set<() => void>, listener: () => void): Unsubscribe {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The nearest offered speed to a restored one, so the cycle stays on its ladder. */
function nearestSpeed(speed: number): PlaybackSpeed {
  let best: PlaybackSpeed = 1;
  for (const candidate of PLAYBACK_SPEEDS) {
    if (Math.abs(candidate - speed) < Math.abs(best - speed)) best = candidate;
  }
  return best;
}

/** Which chapter a timestamp falls in. `0` for a file with no chapters. */
function chapterIndexAt(
  chapters: readonly { readonly startMs: number }[],
  timeMs: number,
): number {
  let index = 0;
  for (let at = 0; at < chapters.length; at += 1) {
    if (chapters[at]!.startMs <= timeMs) index = at;
    else break;
  }
  return index;
}

/** `film.mkv` -> `film`, so a captured frame is not named `film.mkv-1-23.png`. */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
