/**
 * The video surface: the element the film plays in, the chrome that floats over
 * it, and the places the captions, the scrubber and the inspector are hosted.
 *
 * The division of labour matches `viewers/image/engine/view.ts` — this file owns
 * *pixels and layout*, `transport.ts` owns the playhead, and the instance wires
 * the two together. Nothing here decides what a key does or what a menu offers;
 * it hands out callbacks and shows what it is told.
 *
 * ## The `<video>` element is the decoder, deliberately
 *
 * The brief is explicit that this plugin uses "the native `<video>` element and
 * platform codec support (hardware decode) rather than shipping a software
 * decoder", and everything in this module follows from that. Scaling is a box
 * the compositor scales the video layer into, not a canvas blit; fullscreen is
 * the Fullscreen API, not a re-parent; and the frame the capture and the
 * thumbnailer draw comes out of the element the compositor is already feeding. A
 * canvas-per-frame pipeline would hand every video's playback to JavaScript and
 * give up the hardware path that makes a 4K file watchable at all.
 *
 * (`engine/hold.ts` does draw frames into a canvas, and is the exception that
 * proves this rule: it runs only while the transport is between frames, copies
 * at most one frame per *decoded* frame, and never touches playback.)
 *
 * ## `controls` stays off
 *
 * The engine's own control bar is tempting and cannot be used. It is styled by
 * the platform rather than by `theme/theme.css`, it differs on all three target
 * webviews, it has no idea about A/B loops, chapters or shuttle, and on WebKit
 * it captures keys this plugin has bound. So the chrome below is ours, built
 * from the same tokens as the rest of the app.
 *
 * ## Everything floats, and everything goes away
 *
 * There is one child of the viewer root — the stage — and every other piece of
 * this player is positioned over it: the chrome, the captions, the inspector,
 * the transient message line. Nothing takes a strip of layout from the picture.
 *
 * That is a change from a bar bolted under the video and a panel splitting the
 * tile beside it, and the reason is that a video tile is small. In a
 * four-way split a persistent 28-pixel bar and a 19-rem panel are most of the
 * tile; the film was being shown in the space left over by its own controls. A
 * player is the picture. Chrome is what you summon.
 *
 * So the chrome is shown when it is *wanted* and hidden when it is not, and
 * "wanted" is four measurable conditions rather than a guess:
 *
 *   - the film is paused — someone who stopped it is looking at the controls;
 *   - the pointer has moved over the stage in the last {@link IDLE_MS};
 *   - a scrub is in progress, which must not have the bar vanish under the
 *     pointer that is dragging it;
 *   - something just happened worth acknowledging — a seek, a speed change, a
 *     track switch — which is {@link VideoView.wake}.
 *
 * None of these is a timer that runs while the film plays untouched, which is
 * the state a player spends almost all of its life in. In that state this
 * module writes nothing to the DOM at all: the instance reads
 * {@link VideoView.chromeVisible} and skips the readouts and the timeline
 * entirely, so a playing video costs no style recalculation over the picture.
 * That is the second reason the chrome floats, and the one that shows up as
 * smoothness rather than as space.
 *
 * ## Four controls, and the rest is keys and the menu
 *
 * Play, the timeline, the timecode, and the speed chip. Mute and volume were in
 * the bar and are not any more: each is a keybind (`m`, `Up`/`Down`), a row in
 * the tile's context menu, and — for volume — a control in the shared toolbar,
 * so nothing became unreachable. What they were costing was the width that makes
 * a timeline usable in a narrow tile, and a mute button is a poor trade for a
 * scrubber you can hit.
 *
 * Speed went out with them and has come back, because it is the one of the three
 * whose *value* has to be on screen regardless. A tile playing at 1.5× has to
 * say so somewhere, so the width was being spent either way; making that readout
 * a button is the cheapest control in the bar. It walks `1× → 1.5× → 2×` and
 * nothing else — the full 0.25×–4× ladder stays on `x` and the context menu,
 * because seven clicks to get back to normal speed is not a control, it is a
 * penalty. See {@link speedChipLabel}.
 *
 * ## The state badges: what is true right now that would otherwise be invisible
 *
 * Two of the things this player can be doing are invisible from the picture
 * itself, and both are states someone can leave switched on and then be confused
 * by. Playing at 0.5× looks like a slow scene. Being zoomed 300% into a corner
 * looks like a badly framed shot. So each gets a small badge over the picture,
 * and — unlike the chrome — the badges do **not** fade out, because their whole
 * job is to answer "why does this look wrong" at a moment when nothing is being
 * touched and the chrome is therefore gone.
 *
 * They appear only when there is something to say: nothing at all at 1× forward
 * with the picture fitted, which is what almost every tile is doing almost all
 * of the time. The rate badge carries the direction as well as the number
 * (`◀◀ 2×`, `▶▶ 0.5×`, `⏸ 2×`), because "how fast" and "which way" are one
 * question when a transport can run backwards and answering half of it is what
 * the old accent-coloured timecode did.
 *
 * They live at the **bottom left**, with the bar rather than opposite it, and the
 * rate badge and the speed chip are one reading split across two surfaces: the
 * chip has it while the bar is up, the badge takes it when the bar fades, and it
 * never appears twice or moves across the picture. The cost of the move is that
 * the corner is now shared with the captions, which the `has-badge` class settles
 * the same way `has-chrome` already settles the bar.
 *
 * ## Scaling is three fit modes plus a continuous zoom
 *
 * Fit, fill and actual size are the three a review tool starts from, and zoom
 * sits on top of them exactly as it does in the image plugin: any explicit zoom
 * leaves the mode at `custom`, and picking a fit mode again takes it back.
 *
 * This is a reversal of an earlier decision — "a video is watched at the size it
 * plays" — and the reversal is right. The premise was that inspecting a picture
 * closely is an image-viewer job, and it is simply not true of a *review* tool:
 * checking a compression artefact, reading a burned-in timecode, or confirming
 * an edge in a delivery all mean getting closer to the frame, and every one of
 * them was reachable in this app only by exporting the frame and opening it in
 * the image viewer. `actual` size already scrolled a 4K frame around a small
 * tile, so the scroll-and-pan machinery was half built for a feature that was
 * declared out of scope.
 *
 * The mechanics are borrowed from `viewers/image/engine/view.ts` and the borrow
 * is deliberate and complete — same anchored zoom around the pointer, same
 * drag-to-pan-by-scrolling, same normalized centre in the saved state — because
 * two viewers in one app that zoom differently is worse than either choice.
 *
 * One difference, and it is a real one: **`fit` scales up as well as down.** The
 * image plugin caps fit at 1:1 so that a 16-pixel icon is not shown as a mural;
 * a video has no equivalent case, and every player there has ever been fills the
 * window with the film. `actual` is where 1:1 lives.
 *
 * ## The frame is a box, and everything in the picture fills it
 *
 * The stage holds one sized box — the frame — and the `<video>` and the hold
 * canvas both fill it completely. Sizing the box rather than constraining the
 * element is what makes zoom, panning and the flicker fix all fall out of one
 * number: the frame is the picture, so the canvas that covers the picture is
 * `inset: 0` and cannot drift out of alignment with it at any zoom, in any mode,
 * during any resize.
 */

import { FrameHold } from "./hold";
import { formatTimecode } from "./transport";

/** How the picture is sized inside the stage. */
export type ScaleMode = "fit" | "fill" | "actual";

/** `"custom"` is what an explicit zoom leaves behind; the rest are fit modes. */
export type ZoomMode = ScaleMode | "custom";

/**
 * Discrete zoom stops.
 *
 * Narrower than the image plugin's ladder at both ends. Below 10% a film is a
 * postage stamp with no use case — an image viewer needs it to see the whole of
 * a 20,000-pixel scan, and no video is 20,000 pixels wide. Above 1600% a single
 * media pixel is a 16-pixel block, which is past the point where anything
 * further can be learned about a frame that is at most 4K.
 */
const ZOOM_STEPS = [10, 25, 33, 50, 67, 75, 100, 125, 150, 200, 300, 400, 600, 800, 1200, 1600];

export const MIN_ZOOM_PERCENT = 10;
export const MAX_ZOOM_PERCENT = 1600;

/**
 * How far the pointer travels before a press becomes a pan rather than a click.
 *
 * A click on the picture toggles playback, so without a threshold every attempt
 * to pan would also pause the film, and every click would jitter the view by the
 * pixel or two a hand moves while pressing a button.
 */
const PAN_THRESHOLD_PX = 3;

/**
 * How long the chrome stays up after the pointer stops moving.
 *
 * Long enough to cross the tile and land on a control without it going away
 * under the pointer, short enough that a glance at the timecode does not leave
 * a bar sitting over the picture. Every desktop player lands between two and
 * three seconds; this is the middle of that.
 */
const IDLE_MS = 2500;

/** How long a transient message stays up before clearing itself. */
const MESSAGE_MS = 4000;

/**
 * How long the one-off warning at mount stays up.
 *
 * Longer than a message the user caused, because this one arrives unprompted
 * and has to survive not being looked at immediately.
 */
const NOTICE_MS = 8000;

/**
 * The `<video>` element, made before there is anywhere to put it.
 *
 * It lives here rather than in `mount.ts` because this module owns what the
 * element *is*; it is called from there because the load measures on the same
 * element the view will adopt, which is what keeps the source from being loaded
 * twice (`mount.ts`, "One load, not two").
 *
 * It has to be *in the document* to decode. Not `display: none` — a hidden
 * media element is not required to produce frames and on WebKit it does not,
 * which turns every measurement into a timeout — so it is parked off-screen
 * until the view takes it.
 */
export function createVideoSurface(): HTMLVideoElement {
  const video = document.createElement("video");
  video.className = "video-surface";
  video.preload = "auto";
  video.controls = false;
  video.playsInline = true;
  // The loopback stream is a different origin from the app's, so without this
  // the canvas that frame capture, the scrubber preview and the frame hold draw
  // into would be tainted and unreadable. The server answers with
  // `Access-Control-Allow-Origin`.
  video.crossOrigin = "anonymous";
  // Pitch correction at 0.5× and 2×, which is the difference between a speed
  // control someone will use to review dialogue and one that makes everyone
  // sound like a different person. The specified default is `true`, and it is
  // set anyway: WebKit shipped this behind a prefix for years and some builds
  // in the webkit2gtk range this app targets still honour only the prefixed
  // name. Writing both is two lines and removes the question.
  video.preservesPitch = true;
  (video as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true;
  // Nothing here is castable — the source is a loopback URL to a local file —
  // and leaving remote playback enabled makes the engine watch for routes,
  // publish a remote-playback state and, on some builds, offer a cast button
  // inside the element this plugin has taken `controls` off.
  video.disableRemotePlayback = true;
  // Not focusable itself: an element with focus intercepts Space on some
  // engines and toggles playback a second time, which reads as the key not
  // working. The stage takes focus instead.
  video.tabIndex = -1;
  video.style.cssText =
    "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.append(video);
  return video;
}

/**
 * Tears down a surface that never reached a view.
 *
 * Emptying `src` and reloading is what actually releases the decoder; removing
 * the element alone leaves it holding one until collection, which for a session
 * that failed to open a dozen files is a dozen live decoders.
 */
export function discardVideoSurface(video: HTMLVideoElement): void {
  video.removeAttribute("src");
  video.load();
  video.remove();
}

export interface VideoViewCallbacks {
  /** The play/pause control, or a click on the picture. */
  onTogglePlay(): void;
  /** The speed chip in the bar was clicked. See {@link speedChipLabel}. */
  onCycleSpeed(): void;
  /** The picture was double-clicked. */
  onToggleFullscreen(): void;
  /** The picture was right-clicked. */
  onContextMenu(at: { clientX: number; clientY: number }): void;
  /**
   * The zoom or the fit mode changed.
   *
   * `continuous` marks the events that arrive in streams — a pinch, a
   * ctrl-scroll — so the instance can skip the spoken announcement for them.
   * The picture is visibly changing under the pointer during those, and a live
   * region updated sixty times a second is unusable to a screen reader.
   */
  onZoomChange(info: { continuous: boolean }): void;
  /** Something worth persisting moved — a pan, in practice. */
  onPersist(): void;
}

export class VideoView {
  /**
   * The viewer, and the anchor every overlay is positioned against.
   *
   * Deliberately the root and not the stage. Once the picture is larger than the
   * tile the stage is a scroll container, and anything positioned inside a
   * scroll container scrolls with it — a control bar that slides off the bottom
   * of a 4K frame the moment it is panned is not a control bar. The root never
   * scrolls, so the chrome, the captions, the inspector and the message line all
   * hang off it and the stage is left to do nothing but hold the picture.
   */
  readonly root: HTMLElement;
  /** The picture area, and the only thing in the viewer's own flow. */
  readonly stage: HTMLElement;
  /** The sized box the picture fills. See the module comment. */
  readonly frame: HTMLElement;
  readonly video: HTMLVideoElement;
  /** Where `engine/panels.ts` draws the inspector, as an overlay. */
  readonly panelHost: HTMLElement;
  /** Where `engine/subtitles.ts` draws the captions, as an overlay. */
  readonly captionHost: HTMLElement;

  #callbacks: VideoViewCallbacks;

  #chrome: HTMLElement;
  #playButton: HTMLButtonElement;
  #time: HTMLElement;
  #speedChip: HTMLButtonElement;
  #scrubberHost: HTMLElement;
  #message: HTMLElement;
  #rateBadge: HTMLElement;
  #zoomBadge: HTMLElement;

  /** Covers the picture while the transport is between frames. */
  #hold: FrameHold;

  #zoomMode: ZoomMode = "fit";
  /** Percent, and only consulted when {@link #zoomMode} is `custom`. */
  #zoom = 100;
  /** What `fit`, `fill` and `actual` currently work out to. */
  #fitScale = 1;

  #abort = new AbortController();
  #messageTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #pointerActive = false;
  #scrubbing = false;
  #playing = false;
  /** The last transport state the badge was drawn from. See {@link #applyChrome}. */
  #lastRate: { playing: boolean; shuttleRate: number; speed: number } = {
    playing: false,
    shuttleRate: 0,
    speed: 1,
  };
  #panning: { pointerId: number; x: number; y: number } | null = null;
  #panMoved = false;
  /** Set by a pan, cleared by the click it swallows. See {@link #onStageClick}. */
  #suppressClick = false;
  #gestureScale = 1;
  #resizeObserver: ResizeObserver | null = null;
  /**
   * Starts false so the first {@link VideoView.applyChrome} in the constructor
   * is a real transition and writes the classes. Starting it true would agree
   * with the computed answer, take the early return, and leave a stylesheet that
   * hides the bar by default showing nothing at all.
   */
  #chromeVisible = false;
  #destroyed = false;

  constructor(options: {
    container: HTMLElement;
    /**
     * The element the load already measured, from {@link createVideoSurface}.
     *
     * Adopted rather than created, so the source is never loaded twice — see
     * `mount.ts`, "One load, not two". It arrives parked off-screen and holding
     * a decoder; the only thing left to do is put it where it belongs.
     */
    video: HTMLVideoElement;
    callbacks: VideoViewCallbacks;
  }) {
    this.#callbacks = options.callbacks;

    const root = document.createElement("div");
    root.className = "video-viewer";

    const stage = document.createElement("div");
    stage.className = "video-stage";
    // Focusable so the tile can take keyboard focus without the `<video>` itself
    // holding it — an element with focus intercepts Space on some engines and
    // toggles playback a second time, which reads as the key not working.
    stage.tabIndex = 0;

    const frame = document.createElement("div");
    frame.className = "video-frame";

    const video = options.video;
    // The parking style goes; the stylesheet takes over from here. Moving a
    // media element between parents *within one document* does not reload it or
    // pause it — the spec's "pause when removed" step runs at a stable state,
    // by which time it is back in the tree.
    video.removeAttribute("style");

    const panelHost = document.createElement("aside");
    panelHost.className = "video-panel";
    panelHost.hidden = true;

    const captionHost = document.createElement("div");
    captionHost.className = "video-caption-host";

    const message = document.createElement("div");
    message.className = "video-message";
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    // Hidden by opacity rather than by `hidden`, and that is an accessibility
    // requirement rather than a styling preference: a live region announces
    // when its *contents* change, and a region that is removed from the
    // accessibility tree between messages — which `hidden` and
    // `visibility: hidden` both do — is not there to have its contents change.
    // It stays in the tree, empty, and the text write is the announcement.

    const badges = document.createElement("div");
    badges.className = "video-badges";
    const rateBadge = document.createElement("span");
    rateBadge.className = "video-badge is-rate";
    rateBadge.hidden = true;
    const zoomBadge = document.createElement("span");
    zoomBadge.className = "video-badge is-zoom";
    zoomBadge.hidden = true;
    // No live region on either: a speed or zoom change already announces itself
    // through the message line, and a second region repeating it would make
    // every key press speak twice. They are ordinary text, readable on demand.
    badges.append(rateBadge, zoomBadge);

    const chrome = document.createElement("div");
    chrome.className = "video-chrome";

    const playButton = button("video-button is-play", "play");
    const scrubberHost = document.createElement("div");
    scrubberHost.className = "video-scrubber-host";
    const time = document.createElement("span");
    time.className = "video-time";
    const speedChip = button("video-speed", "playback speed");
    speedChip.title = "Playback speed — click to cycle 1×, 1.5×, 2×";

    chrome.append(playButton, scrubberHost, time, speedChip);
    frame.append(video);
    stage.append(frame);
    // Overlay order is paint order, and it is the order they may cover each
    // other in: captions under the bar (they move out of its way instead), the
    // inspector over the bar, and the message line over everything, because it
    // is transient and is the one thing that must never be the piece that is
    // hidden.
    root.append(stage, captionHost, chrome, badges, panelHost, message);
    options.container.append(root);

    this.root = root;
    this.stage = stage;
    this.frame = frame;
    this.video = video;
    this.panelHost = panelHost;
    this.captionHost = captionHost;
    this.#message = message;
    this.#rateBadge = rateBadge;
    this.#zoomBadge = zoomBadge;
    this.#chrome = chrome;
    this.#playButton = playButton;
    this.#time = time;
    this.#speedChip = speedChip;
    this.#scrubberHost = scrubberHost;

    // The frame is the picture's box, so it is also exactly the box the hold
    // canvas has to cover. Nothing has to keep the two in step.
    this.#hold = new FrameHold({ video, host: frame });

    const signal = this.#abort.signal;
    playButton.addEventListener("click", () => this.#callbacks.onTogglePlay(), { signal });
    speedChip.addEventListener("click", () => this.#callbacks.onCycleSpeed(), { signal });

    stage.addEventListener("click", this.#onStageClick, { signal });
    stage.addEventListener("dblclick", this.#onStageDoubleClick, { signal });
    stage.addEventListener("pointerdown", this.#onStagePointerDown, { signal });
    stage.addEventListener("pointermove", this.#onStagePointerMove, { signal });
    stage.addEventListener("pointerup", this.#onStagePointerUp, { signal });
    stage.addEventListener("pointercancel", this.#onStagePointerUp, { signal });
    stage.addEventListener("scroll", this.#onStageScroll, { passive: true, signal });
    stage.addEventListener("wheel", this.#onWheel, { passive: false, signal });
    // Safari and WKWebView report a trackpad pinch as gesture events rather
    // than a ctrl-modified wheel. Both are wired; whichever the platform sends
    // lands in the same `zoomAround`.
    stage.addEventListener("gesturestart", this.#onGestureStart as EventListener, { signal });
    stage.addEventListener("gesturechange", this.#onGestureChange as EventListener, { signal });
    stage.addEventListener("gestureend", this.#onGestureEnd as EventListener, { signal });
    // On the root, not the stage: the chrome is a sibling of the stage now, so
    // a pointer resting on the bar it just summoned would count as having left
    // the picture and time the bar out from under itself. The root is the whole
    // tile, which is the region the question is actually about.
    root.addEventListener("pointermove", this.#onPointerMove, { signal });
    root.addEventListener("pointerleave", this.#onPointerLeave, { signal });
    root.addEventListener("contextmenu", this.#onContextMenu, { signal });

    // A fit mode is a function of the stage's size, and the two things that
    // change it — the tile being resized and the viewer going fullscreen — do
    // not both reach the shell's `resize()`: in fullscreen the *container* keeps
    // its old size while the viewer fills the screen, so the shell's observer
    // never fires. Observing the stage covers both, and costs one callback.
    this.#observeStage();

    this.#applyChrome();
    this.layout();
  }

  // -------------------------------------------------------------------------
  // Hosting
  // -------------------------------------------------------------------------

  /** Puts the timeline into the chrome. Called once, on mount. */
  mountScrubber(element: HTMLElement): void {
    this.#scrubberHost.replaceChildren(element);
  }

  // -------------------------------------------------------------------------
  // The frame hold
  // -------------------------------------------------------------------------

  /**
   * Covers the picture with its last frame, or stops covering it.
   *
   * Driven by the transport, which is the only thing that knows when the element
   * is about to have no frame to show. See `engine/hold.ts` for what this fixes
   * and why nothing in the seek sequence itself could fix it.
   */
  holdFrame(active: boolean): void {
    if (this.#destroyed) return;
    if (active) this.#hold.engage();
    else this.#hold.release();
  }

  /** Test hook: whether the picture is currently being covered. */
  get holding(): boolean {
    return this.#hold.active;
  }

  // -------------------------------------------------------------------------
  // Scaling and zoom
  // -------------------------------------------------------------------------

  get zoomMode(): ZoomMode {
    return this.#zoomMode;
  }

  /** One at 1:1, two when one media pixel covers two CSS pixels. */
  get scale(): number {
    return this.#zoomMode === "custom" ? this.#zoom / 100 : this.#fitScale;
  }

  /** `100`, `240.5`. One decimal, because a pinch lands between the stops. */
  get zoomPercent(): number {
    return Math.round(this.scale * 1000) / 10;
  }

  /** The media's own pixels. Zeros until `loadedmetadata`, and for audio files. */
  get mediaSize(): { width: number; height: number } {
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  /** Whether the picture overflows the stage, which is when a drag means a pan. */
  get canPan(): boolean {
    return (
      this.stage.scrollWidth - this.stage.clientWidth > 1 ||
      this.stage.scrollHeight - this.stage.clientHeight > 1
    );
  }

  /** Back to one of the three fit modes, discarding any explicit zoom. */
  setScaleMode(mode: ScaleMode): void {
    this.#applyZoom({ mode });
  }

  /** Restores a mode and its zoom together, for `restore()`. Silent. */
  setZoomMode(mode: ZoomMode, zoom?: number): void {
    this.#applyZoom({ mode, zoom }, undefined, { silent: true });
  }

  /** The next stop up or down the ladder, from wherever the picture is now. */
  stepZoom(direction: 1 | -1): void {
    const current = this.zoomPercent;
    const next =
      direction > 0
        ? (ZOOM_STEPS.find((step) => step > current + 0.01) ?? ZOOM_STEPS.at(-1)!)
        : ([...ZOOM_STEPS].reverse().find((step) => step < current - 0.01) ?? ZOOM_STEPS[0]!);
    this.#applyZoom({ mode: "custom", zoom: next });
  }

  /** A pinch or a ctrl-wheel, holding the point under the pointer still. */
  zoomAround(factor: number, anchor: { clientX: number; clientY: number }): void {
    this.#applyZoom({ mode: "custom", zoom: this.zoomPercent * factor }, anchor, {
      continuous: true,
    });
  }

  /**
   * Applies a new zoom, holding a chosen point still.
   *
   * `anchor` is a client-space point — the cursor during a pinch or a
   * ctrl-scroll. Without one the centre of the view is held, which is what the
   * keyboard and the menu want.
   */
  #applyZoom(
    next: { mode: ZoomMode; zoom?: number },
    anchor?: { clientX: number; clientY: number },
    options?: { silent?: boolean; continuous?: boolean },
  ): void {
    const before = this.#anchorFraction(anchor);
    // Seeded from what is on screen *now*, so the first step out of a fit mode
    // continues from the size the picture actually is rather than jumping to
    // whatever the last custom zoom happened to be.
    const seed = this.scale * 100;

    this.#zoomMode = next.mode;
    if (next.mode === "custom") {
      this.#zoom = Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, next.zoom ?? seed));
    }

    this.layout();
    this.#restoreAnchor(before);

    if (!options?.silent) {
      this.#callbacks.onZoomChange({ continuous: options?.continuous ?? false });
    }
  }

  /** Which fraction of the picture sits under a client point, before a zoom. */
  #anchorFraction(anchor?: { clientX: number; clientY: number }): {
    fx: number;
    fy: number;
    offsetX: number;
    offsetY: number;
  } {
    const box = this.stage.getBoundingClientRect();
    const offsetX = anchor ? anchor.clientX - box.left : this.stage.clientWidth / 2;
    const offsetY = anchor ? anchor.clientY - box.top : this.stage.clientHeight / 2;

    const frameBox = this.frame.getBoundingClientRect();
    const pointX = box.left + offsetX;
    const pointY = box.top + offsetY;

    return {
      fx: frameBox.width ? (pointX - frameBox.left) / frameBox.width : 0.5,
      fy: frameBox.height ? (pointY - frameBox.top) / frameBox.height : 0.5,
      offsetX,
      offsetY,
    };
  }

  #restoreAnchor(before: { fx: number; fy: number; offsetX: number; offsetY: number }): void {
    const width = this.frame.offsetWidth;
    const height = this.frame.offsetHeight;
    // `offsetLeft` accounts for the centring margin when the picture is smaller
    // than the stage, which is exactly when the naive calculation drifts.
    this.stage.scrollLeft = Math.max(0, this.frame.offsetLeft + before.fx * width - before.offsetX);
    this.stage.scrollTop = Math.max(0, this.frame.offsetTop + before.fy * height - before.offsetY);
  }

  /** Where the centre of the view sits, as a fraction of the picture. For state. */
  centerFraction(): { x: number; y: number } {
    const width = this.frame.offsetWidth;
    const height = this.frame.offsetHeight;
    if (!width || !height) return { x: 0.5, y: 0.5 };
    const x =
      (this.stage.scrollLeft + this.stage.clientWidth / 2 - this.frame.offsetLeft) / width;
    const y = (this.stage.scrollTop + this.stage.clientHeight / 2 - this.frame.offsetTop) / height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  /** Restores a centre recorded by {@link centerFraction}. */
  setCenterFraction(center: { x: number; y: number }): void {
    const width = this.frame.offsetWidth;
    const height = this.frame.offsetHeight;
    this.stage.scrollLeft = Math.max(
      0,
      this.frame.offsetLeft + center.x * width - this.stage.clientWidth / 2,
    );
    this.stage.scrollTop = Math.max(
      0,
      this.frame.offsetTop + center.y * height - this.stage.clientHeight / 2,
    );
  }

  /**
   * Sizes the frame, which sizes everything in it.
   *
   * `fill` is the one mode whose box is the *stage* rather than the picture: it
   * crops, and cropping means the box is the tile and the video covers it. Every
   * other mode sizes the box to the media's pixels times the scale, so the box
   * always has the picture's own aspect ratio and there is never anything to
   * letterbox inside it — the letterbox is the black stage around the frame,
   * which is what a letterbox is.
   */
  layout(): void {
    if (this.#destroyed) return;

    const { width, height } = this.mediaSize;
    this.#computeFitScale(width, height);

    const fill = this.#zoomMode === "fill";
    // Scrolling is offered whenever the picture can be bigger than its stage,
    // which is every mode but the two that are defined as fitting inside it.
    const scrollable = this.#zoomMode === "actual" || this.#zoomMode === "custom";
    this.stage.classList.toggle("is-fill", fill);
    this.stage.classList.toggle("is-scrollable", scrollable);

    if (width <= 0 || height <= 0) {
      // No picture yet, or none at all — an audio-only file. `loadedmetadata`
      // calls this again, so there is nothing to wait for here.
      this.frame.style.width = "";
      this.frame.style.height = "";
      this.stage.classList.remove("can-pan");
      this.#updateZoomBadge();
      return;
    }

    if (fill) {
      this.frame.style.width = "100%";
      this.frame.style.height = "100%";
    } else {
      const scale = this.scale;
      this.frame.style.width = `${Math.max(1, Math.round(width * scale))}px`;
      this.frame.style.height = `${Math.max(1, Math.round(height * scale))}px`;
    }

    // After the box has been written, never before: `canPan` asks the stage
    // whether it overflows, and asked first it would answer about the size the
    // picture *used to* be — leaving the grab cursor one zoom step behind.
    this.stage.classList.toggle("can-pan", scrollable && this.canPan);

    this.#updateZoomBadge();
  }

  #computeFitScale(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    const availableWidth = this.stage.clientWidth;
    const availableHeight = this.stage.clientHeight;
    if (availableWidth <= 0 || availableHeight <= 0) return;

    const byWidth = availableWidth / width;
    const byHeight = availableHeight / height;

    switch (this.#zoomMode) {
      case "fit":
        // Not capped at 1:1, unlike the image plugin — see the module comment.
        this.#fitScale = Math.min(byWidth, byHeight);
        break;
      case "fill":
        this.#fitScale = Math.max(byWidth, byHeight);
        break;
      case "actual":
        this.#fitScale = 1;
        break;
      default:
        // `custom` carries its own number and must not be overwritten by the
        // stage's size, which is the whole difference between a zoom and a fit.
        break;
    }
  }

  /**
   * The tile's box changed. Re-fit if fitting; leave an explicit zoom alone.
   *
   * Deliberately silent, and that is not an oversight: a fit scale changes
   * continuously while a divider is dragged, and reporting each value would
   * spray a message over the picture and re-render the toolbar for something
   * nobody asked for. The badge, which `layout()` rewrites, is the whole of the
   * feedback a resize needs — and nothing worth saving has changed, because the
   * *mode* is what gets persisted and a resize does not touch it.
   */
  resize(): void {
    if (this.#destroyed) return;
    this.layout();
  }

  #observeStage(): void {
    if (typeof ResizeObserver === "undefined") return;
    let lastWidth = 0;
    let lastHeight = 0;
    this.#resizeObserver = new ResizeObserver(() => {
      if (this.#destroyed) return;
      const width = this.stage.clientWidth;
      const height = this.stage.clientHeight;
      // Guarded rather than trusted: `layout()` writes sizes, and a callback
      // that ran on its own writes is one scrollbar away from a loop.
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width;
      lastHeight = height;
      this.layout();
    });
    this.#resizeObserver.observe(this.stage);
  }

  // -------------------------------------------------------------------------
  // The chrome
  // -------------------------------------------------------------------------

  /**
   * Whether the chrome is on screen.
   *
   * The instance reads this before refreshing the readouts and the timeline, and
   * skips both when it is false. Roughly ten style writes a second over a
   * playing video become none, which is the point — see the module comment.
   */
  get chromeVisible(): boolean {
    return this.#chromeVisible;
  }

  /**
   * Shows the chrome and restarts the idle countdown.
   *
   * For anything the user just did that has a visible consequence in the bar: a
   * seek, a frame step, a speed change. The action itself is the request to see
   * where it landed.
   */
  wake(): void {
    if (this.#destroyed) return;
    this.#pointerActive = true;
    this.#restartIdleTimer();
    this.#applyChrome();
  }

  /** Held up while a scrub is in progress, whatever the pointer is doing. */
  setScrubbing(scrubbing: boolean): void {
    this.#scrubbing = scrubbing;
    if (scrubbing) this.#pointerActive = true;
    this.#applyChrome();
  }

  #restartIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      this.#pointerActive = false;
      this.#applyChrome();
    }, IDLE_MS);
  }

  /**
   * Decides visibility and writes it, once, only when it changed.
   *
   * A paused film always shows its controls. Beyond that it is the pointer and
   * the scrub, and the cursor goes with the chrome: a cursor sitting over a
   * playing film with nothing else on screen is the one piece of chrome every
   * player hides and this one was leaving up.
   */
  #applyChrome(): void {
    if (this.#destroyed) return;
    const visible = !this.#playing || this.#pointerActive || this.#scrubbing;
    if (visible === this.#chromeVisible) return;
    this.#chromeVisible = visible;
    this.#chrome.classList.toggle("is-visible", visible);
    // The handoff between the chip and the badge happens here, and it has to be
    // one write rather than two ticks apart: the badge goes as the bar arrives
    // and the chip is filled in the same breath, both from the last known
    // transport state, so there is no frame in which the speed is shown twice or
    // not at all.
    this.#updateRateBadge(this.#lastRate);
    if (visible) this.#updateSpeedChip(this.#lastRate);
    // Captions sit just above the bar when it is up, and drop back to the
    // frame's own lower third when it goes. Anything else has a subtitle
    // half-covered by a timeline for two and a half seconds after every mouse
    // movement.
    this.root.classList.toggle("has-chrome", visible);
    this.root.classList.toggle("is-idle", !visible);
  }

  #onPointerMove = (): void => {
    // Cheap on purpose: a boolean, a timer reset, and a class write only on the
    // transition. This fires at the pointer's full event rate.
    if (!this.#pointerActive) {
      this.#pointerActive = true;
      this.#applyChrome();
    }
    this.#restartIdleTimer();
  };

  #onPointerLeave = (): void => {
    if (this.#scrubbing) return;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#pointerActive = false;
    this.#applyChrome();
  };

  // -------------------------------------------------------------------------
  // Readouts
  // -------------------------------------------------------------------------

  /**
   * Refreshes the chrome and the badges from the current state.
   *
   * One function rather than a setter per control, called from the transport's
   * change callback: the controls are a *view of* the transport, and any path
   * that let one of them drift out of step would show a paused film with a pause
   * button on it. It runs several times a second while the chrome is up, so it
   * writes only what changed — assigning identical text still invalidates layout
   * on WebKit.
   */
  update(state: {
    playing: boolean;
    currentMs: number;
    durationMs: number;
    shuttleRate: number;
    speed: number;
    frameRate?: number;
  }): void {
    if (this.#destroyed) return;

    // Always, even when the chrome is hidden: the play state is what *decides*
    // whether the chrome is hidden, so it is the one thing that cannot be
    // skipped along with it.
    if (state.playing !== this.#playing) {
      this.#playing = state.playing;
      // A film that just stopped shows its controls immediately. One that just
      // started gets the full idle window first, rather than the bar snapping
      // away in the same instant the picture starts moving — including when
      // nothing pointed at it, which is what autoplay and a restored session
      // both look like from here.
      if (state.playing) {
        this.#pointerActive = true;
        this.#restartIdleTimer();
      }
      this.#applyChrome();
    }

    // Also always: the rate badge outlives the chrome by design, because the
    // state it reports is one someone can walk away from and come back to.
    this.#updateRateBadge(state);

    if (!this.#chromeVisible) return;

    setText(this.#playButton, state.playing ? "❚❚" : "▶");
    this.#playButton.setAttribute("aria-label", state.playing ? "pause" : "play");
    this.#playButton.title = state.playing ? "Pause" : "Play";
    this.#playButton.setAttribute("aria-pressed", String(state.playing));

    // One readout rather than two flanking the timeline. It is the same
    // information in half the horizontal space, which in a narrow tile is the
    // difference between a scrubber worth dragging and a stub.
    const current = formatTimecode(
      state.currentMs,
      state.frameRate ? { frames: state.frameRate } : undefined,
    );
    setText(this.#time, `${current} / ${formatTimecode(state.durationMs)}`);
    // Reverse shuttle is the one state where the playhead is not doing what the
    // speed says, so the readout marks itself rather than showing a number that
    // is true and misleading.
    this.#time.classList.toggle("is-shuttling", state.shuttleRate < 0);

    this.#updateSpeedChip(state);
  }

  /** The chip's text and its active state. Shared with {@link #applyChrome}. */
  #updateSpeedChip(state: { shuttleRate: number; speed: number }): void {
    setText(this.#speedChip, speedChipLabel(state));
    // The accent is for active states, and a transport that is off 1× or running
    // backwards is one — the same rule the timecode and the rate badge follow.
    this.#speedChip.classList.toggle(
      "is-active",
      state.shuttleRate < 0 || Math.abs(state.speed - 1) > 0.001,
    );
    this.#speedChip.setAttribute("aria-label", `playback speed ${formatSpeed(state.speed)}×`);
  }

  /**
   * `◀◀ 2×`, `▶▶ 0.5×`, `⏸ 2×`, or nothing.
   *
   * The decision about *whether* to say anything is {@link rateIndicator},
   * which is where the reasoning lives and which is what the self-test drives.
   * This is the DOM write around it.
   */
  #updateRateBadge(state: { playing: boolean; shuttleRate: number; speed: number }): void {
    // Cached so `#applyChrome` can re-render the badge when the bar comes and
    // goes, which is a visibility change with no new transport state behind it.
    this.#lastRate = state;
    setBadge(this.#rateBadge, rateIndicator(state, this.#chromeVisible));
    this.#rateBadge.title =
      state.shuttleRate < 0
        ? `playing backwards at ${formatSpeed(state.speed)}× speed`
        : `playback speed ${formatSpeed(state.speed)}×`;
    this.#applyBadgeState();
  }

  /** The zoom, when it is not the default fit. Written by `layout()`. */
  #updateZoomBadge(): void {
    if (this.#zoomMode === "fit") {
      setBadge(this.#zoomBadge, "");
      this.#applyBadgeState();
      return;
    }
    const percent = this.zoomPercent;
    const label = this.#zoomMode === "fill" ? `fill ${formatPercent(percent)}` : formatPercent(percent);
    setBadge(this.#zoomBadge, label);
    this.#zoomBadge.title = "picture scale";
    this.#applyBadgeState();
  }

  /**
   * Tells the stylesheet whether anything is in the badge corner.
   *
   * The badges moved to the bottom of the picture to sit with the bar, which put
   * them in the strip the captions occupy when the bar is down. Captions already
   * step out of the bar's way; this is the same rule for the other thing that
   * can be down there, and it is a class rather than a measurement because the
   * only question is whether the corner is occupied at all.
   */
  #applyBadgeState(): void {
    const showing = !this.#rateBadge.hidden || !this.#zoomBadge.hidden;
    this.root.classList.toggle("has-badge", showing);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  #onStageClick = (event: MouseEvent): void => {
    // The click that ends a pan is not a request to pause the film.
    if (this.#suppressClick) {
      this.#suppressClick = false;
      return;
    }
    // Only the picture itself. A click that landed on the chrome, the caption
    // overlay or the inspector belongs to that element.
    if (!this.#isPicture(event.target)) return;
    this.#callbacks.onTogglePlay();
  };

  #onStageDoubleClick = (event: MouseEvent): void => {
    if (!this.#isPicture(event.target)) return;
    // The single-click handler already toggled once on the way to this event.
    // Undoing it leaves a double-click meaning only "fullscreen", which is what
    // it means in every other player.
    this.#callbacks.onTogglePlay();
    this.#callbacks.onToggleFullscreen();
  };

  /** The stage, the frame, the video, or the hold canvas over it — all picture. */
  #isPicture(target: EventTarget | null): boolean {
    return (
      target === this.stage ||
      target === this.frame ||
      target === this.video ||
      (target instanceof Element && target.classList.contains("video-hold"))
    );
  }

  #onStagePointerDown = (event: PointerEvent): void => {
    // Left button only, and only when there is somewhere to pan to: capturing
    // the pointer on a picture that fits would swallow clicks for nothing.
    if (event.button !== 0 || !this.canPan) return;
    if (!this.#isPicture(event.target)) return;
    this.#panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.#panMoved = false;
    this.stage.setPointerCapture(event.pointerId);
  };

  #onStagePointerMove = (event: PointerEvent): void => {
    const pan = this.#panning;
    if (!pan || pan.pointerId !== event.pointerId) return;

    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    // Below the threshold nothing moves and the origin is kept, so the pan
    // starts from where the press was rather than losing the first few pixels.
    if (!this.#panMoved && Math.abs(dx) + Math.abs(dy) < PAN_THRESHOLD_PX) return;
    if (!this.#panMoved) {
      this.#panMoved = true;
      this.stage.classList.add("is-panning");
    }

    this.#panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.stage.scrollLeft -= dx;
    this.stage.scrollTop -= dy;
  };

  #onStagePointerUp = (event: PointerEvent): void => {
    if (this.#panning?.pointerId !== event.pointerId) return;
    const moved = this.#panMoved;
    this.#panning = null;
    this.#panMoved = false;
    this.stage.classList.remove("is-panning");
    if (this.stage.hasPointerCapture(event.pointerId)) {
      this.stage.releasePointerCapture(event.pointerId);
    }
    if (moved) {
      this.#suppressClick = true;
      this.#callbacks.onPersist();
    }
  };

  #onStageScroll = (): void => {
    if (this.#panning) return;
    this.#callbacks.onPersist();
  };

  #onWheel = (event: WheelEvent): void => {
    // Unmodified wheel is left alone: it scrolls a zoomed picture, which is what
    // a scroll container is for, and does nothing at all when there is nothing
    // to scroll.
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    // Exponential, so the response is proportional whether `deltaY` arrives in
    // lines or pixels, and never inverts.
    this.zoomAround(Math.exp(-event.deltaY * 0.01), event);
  };

  #onGestureStart = (event: Event & { scale?: number }): void => {
    event.preventDefault();
    this.#gestureScale = event.scale ?? 1;
  };

  #onGestureChange = (
    event: Event & { scale?: number; clientX?: number; clientY?: number },
  ): void => {
    event.preventDefault();
    const scale = event.scale ?? 1;
    const factor = this.#gestureScale ? scale / this.#gestureScale : 1;
    this.#gestureScale = scale;
    this.zoomAround(factor, { clientX: event.clientX ?? 0, clientY: event.clientY ?? 0 });
  };

  #onGestureEnd = (event: Event): void => {
    event.preventDefault();
    this.#callbacks.onPersist();
  };

  #onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    this.#callbacks.onContextMenu(event);
  };

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------

  /**
   * Says something briefly, over the picture, and to a screen reader.
   *
   * One transient line, where there used to be this plus a permanent notice
   * strip below the video. The strip is gone because a persistent orange line
   * explaining a container's internals over a film that is playing correctly is
   * noise, and noise in that position trains people to stop reading it. What was
   * worth interrupting for — a file whose name disagrees with its contents — is
   * said once here, for longer, at mount; everything the parse noticed stays in
   * the info panel, which is where someone goes to ask.
   */
  announce(message: string, tone: "info" | "warn" | "notice" = "info"): void {
    if (this.#destroyed) return;
    this.#message.textContent = message;
    this.#message.classList.toggle("is-warning", tone !== "info");
    this.#message.classList.add("is-visible");
    if (this.#messageTimer) clearTimeout(this.#messageTimer);
    this.#messageTimer = setTimeout(
      () => {
        this.#messageTimer = null;
        this.#message.classList.remove("is-visible");
        this.#message.textContent = "";
      },
      tone === "notice" ? NOTICE_MS : MESSAGE_MS,
    );
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  destroy(): void {
    this.#destroyed = true;
    this.#abort.abort();
    if (this.#messageTimer) clearTimeout(this.#messageTimer);
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    // Before the element goes: the hold holds a bitmap and a frame callback
    // against it, and both have to be given back while it still exists.
    this.#hold.destroy();
    // Emptying the source and reloading is what releases the decoder and the
    // file handle behind it. Removing the element alone leaves both held until
    // collection, which for a session that opened a dozen films is a dozen live
    // decoders — the same reason `thumbnailer.ts` does it.
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

function button(className: string, label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.setAttribute("aria-label", label);
  // Not reachable by Tab: it would sit between the picture and the next tile in
  // the tab order, and a layout of videos would be that much slower to move
  // through. It is reachable by pointer, by Space, and from the context menu.
  element.tabIndex = -1;
  return element;
}

/**
 * What the rate badge says, or the empty string for "say nothing".
 *
 * A pure function rather than a method, because the interesting part of this
 * feature is the *decision* — which state is worth a badge — and a decision
 * buried in a DOM write can only be tested by driving a real view through its
 * idle timers. Two conditions have to hold together:
 *
 *   - **The state is not ordinary** — running backwards, or at any speed but
 *     1×. An ordinary tile says nothing, which is what almost every tile is
 *     doing almost all of the time.
 *   - **The chrome is *down***. While the bar is up it carries the speed itself,
 *     on the chip beside the timecode ({@link speedChipLabel}), which is where
 *     the control is and therefore where the reading belongs. A badge as well
 *     would be the same fact twice, six inches apart.
 *
 * That second term used to be the opposite — the badge showed *because* the
 * chrome was up, back when the bar had no speed readout at all. The pair now
 * hands off: the bar owns the answer while it is on screen, the badge takes over
 * when it fades, and the reading never moves from the bottom of the picture.
 *
 * The glyph is the direction the playhead is *moving*, not the direction a press
 * of play would move it — those differ only while paused, and `⏸` says so rather
 * than guessing.
 */
export function rateIndicator(
  state: { playing: boolean; shuttleRate: number; speed: number },
  chromeVisible: boolean,
): string {
  if (chromeVisible) return "";
  const reversing = state.shuttleRate < 0;
  if (!reversing && Math.abs(state.speed - 1) <= 0.001) return "";
  const glyph = reversing ? "◀◀" : state.playing ? "▶▶" : "⏸";
  return `${glyph} ${formatSpeed(state.speed)}×`;
}

/**
 * What the speed chip in the bar says: `1×`, `1.5×`, `◀◀ 2×`.
 *
 * Always something, because it is a control and a control that disappears when
 * it is at its default value cannot be found by anyone who wants to change it.
 *
 * It carries the direction glyph only while reversing, and that asymmetry is
 * deliberate: forward and paused are already legible from the play button two
 * elements away, so a `▶▶` here would be decoration, while backwards is a state
 * with no other representation in the bar at all. The badge above is the one
 * that always names the direction — it appears when the bar is gone, and has
 * nothing beside it to borrow context from.
 */
export function speedChipLabel(state: { shuttleRate: number; speed: number }): string {
  const prefix = state.shuttleRate < 0 ? "◀◀ " : "";
  return `${prefix}${formatSpeed(state.speed)}×`;
}

/** Writes text only when it differs, because `update` runs many times a second. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** A badge shows what it is given and disappears when given nothing. */
function setBadge(element: HTMLElement, text: string): void {
  setText(element, text);
  const hidden = text.length === 0;
  if (element.hidden !== hidden) element.hidden = hidden;
}

/** `2`, `0.5`, `1.25` — trailing zeros dropped, because most speeds are short. */
function formatSpeed(speed: number): string {
  const rounded = Math.round(speed * 100) / 100;
  return String(rounded);
}

/** `100%`, `12.5%` — one decimal only when a pinch left one. */
function formatPercent(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}
