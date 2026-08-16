/**
 * The scrubber: the timeline, and everything drawn on it.
 *
 * The brief asks for four things here and they all share one strip of screen —
 * the played and buffered extents, chapter markers as *clickable* points, the
 * A/B loop region, and a hover preview showing "a preview frame at that
 * timestamp, not just a bare progress bar". Keeping them in one class is what
 * lets them agree about where a millisecond is; splitting them would mean four
 * copies of the same position arithmetic and four chances for one to drift.
 *
 * ## Positioning inside a widget is not "hand-rolled layout math"
 *
 * AGENTS.md forbids geometry — "pixel positions, pointer-drag arithmetic,
 * divider hit-testing" — for *tiling*. A viewer positioning its own content
 * within its own box is the different job `viewers/image/engine/view.ts` and
 * `viewers/pdf/view.ts` both do, and a scrubber is that job at its smallest: the
 * only measurement here is the track's own width, taken to turn a pointer x into
 * a fraction. Nothing dockview owns is measured or moved.
 *
 * ## Everything is a percentage, not a pixel
 *
 * Every mark sets `left`/`width` in `%`. A tile is resized constantly — by a
 * divider drag, by a sibling closing, by the window — and a scrubber laid out in
 * pixels would need a resize observer and a re-layout pass to stay correct.
 * Percentages make the browser do it, which is both free and impossible to get
 * out of step.
 *
 * ## The playhead is the exception, and is an animation
 *
 * The two parts that move *continuously* — the played fill and the position
 * marker — are the one thing percentages are wrong for. Written per tick they
 * step rather than glide, because between two writes they do not move at all.
 * They are driven by `engine/glide.ts` instead: one animation each, spanning the
 * film's duration, whose `currentTime` is the playhead and whose `playbackRate`
 * is the speed — signed, so reverse runs the bar backwards without a second code
 * path. This class's job for those two is to keep the animation pointed at the
 * transport ({@link Scrubber.sync}), to tell it how wide the track is, and to
 * draw them by hand when there is no duration to animate along.
 *
 * The width is the one measurement this class volunteers. The marker's keyframes
 * are in pixels rather than in percentages because a percentage translation
 * resolves against the element's own box, and an animated transform that depends
 * on the box size is the one engines decline to accelerate — so a
 * `ResizeObserver` on the track feeds `ProgressGlide.setTrackWidth`, and a
 * divider drag rebuilds that one animation. It is the exception to the rule
 * above and it earns it: it buys the marker a place on the compositor beside the
 * fill on every engine this app ships to, which is the difference between two
 * halves of one bar moving together and the handle stepping along behind the
 * fill's leading edge.
 *
 * Everything else here still changes slowly enough to write directly: the
 * buffered extent, the loop region, the chapter marks and the aria state all
 * belong to {@link Scrubber.update}, which the instance calls only while the
 * bar is on screen — and each of them is compared against what it last wrote,
 * because that method runs at the video's frame rate and almost none of what it
 * draws changes that often.
 */

import type { Chapter } from "../container";
import { ProgressGlide } from "./glide";
import { formatTimecode, type Transport } from "./transport";
import type { FrameGrab } from "./thumbnailer";

/** How long the pointer must rest before a preview frame is requested. */
const PREVIEW_DEBOUNCE_MS = 80;

/**
 * Where hover-preview frames come from.
 *
 * Narrower than `Thumbnailer` on purpose: the timeline wants a frame at a
 * timestamp and has no business knowing that producing one costs a second
 * decoder. That indirection is what lets the instance defer opening the second
 * decoder until the first hover — which for the common case, a film watched
 * without ever touching the timeline, means it is never opened at all.
 */
export interface PreviewSource {
  /** Whether asking is worth it. False disables the preview outright. */
  readonly available: boolean;
  frameAt(milliseconds: number, maxWidth?: number): Promise<FrameGrab | null>;
}

export interface ScrubberCallbacks {
  /** The user asked to move the playhead. */
  onSeek(milliseconds: number): void;
  /** A scrub started or finished, so playback can be resumed afterwards. */
  onScrubStateChange(scrubbing: boolean): void;
}

export class Scrubber {
  readonly root: HTMLElement;

  #transport: Transport;
  #thumbnailer: PreviewSource | null;
  #callbacks: ScrubberCallbacks;

  #track: HTMLElement;
  #buffered: HTMLElement;
  #played: HTMLElement;
  #loop: HTMLElement;
  #marker: HTMLElement;
  #chapterHost: HTMLElement;

  #preview: HTMLElement;
  #previewFrame: HTMLElement;
  #previewLabel: HTMLElement;

  /** Drives the two moving parts. See the module comment. */
  #glide: ProgressGlide;
  /** Watches the track, because the marker's keyframes are drawn in pixels. */
  #resize: ResizeObserver | null = null;
  /** The last whole second announced, so aria is not rewritten per tick. */
  #announcedSecond = -1;
  /**
   * What was last written to the parts that are drawn rather than animated.
   *
   * The frame callback runs {@link update} at the video's own rate — twenty-four
   * to sixty times a second — and every one of those calls used to write the
   * buffered extent and the loop region whether or not they had moved. How much
   * of a file has downloaded changes a few times a minute and a loop region
   * changes when a key is pressed, so almost all of that was a style
   * invalidation next to a composited animation to say what was already on
   * screen. Compared before writing, which is the same thing `engine/view.ts`
   * does for every readout it owns.
   */
  #drawnBuffered = -1;
  #drawnLoop = "";
  #drawnPosition = -1;
  #reversing = false;
  /** The last visibility {@link Scrubber.sync} was given. See its comment. */
  #lastVisible = false;

  #chapters: readonly Chapter[] = [];
  #scrubbing = false;
  #wasPlaying = false;
  #previewTimer: ReturnType<typeof setTimeout> | null = null;
  #previewToken = 0;
  #abort = new AbortController();
  #destroyed = false;

  constructor(options: {
    transport: Transport;
    thumbnailer: PreviewSource | null;
    callbacks: ScrubberCallbacks;
  }) {
    this.#transport = options.transport;
    this.#thumbnailer = options.thumbnailer;
    this.#callbacks = options.callbacks;

    this.root = document.createElement("div");
    this.root.className = "video-scrubber";

    this.#track = document.createElement("div");
    this.#track.className = "video-track";
    this.#track.setAttribute("role", "slider");
    this.#track.setAttribute("aria-label", "playback position");
    this.#track.tabIndex = -1;

    this.#buffered = element("video-track-buffered");
    this.#played = element("video-track-played");
    this.#loop = element("video-track-loop");
    this.#loop.hidden = true;
    this.#chapterHost = element("video-track-chapters");
    // The handle hangs off a positioner rather than setting its own `left`, so
    // that the thing being moved is a `transform` and not a layout write. The
    // positioner spans the track, which is also the distance the animation
    // translates it across — see `engine/glide.ts` on why that distance is
    // measured in pixels rather than written as `100%`.
    this.#marker = element("video-track-marker");
    // The handle needs no field of its own: it is positioned entirely by its
    // parent, and nothing after mount ever writes to it.
    this.#marker.append(element("video-track-handle"));

    this.#track.append(
      this.#buffered,
      this.#loop,
      this.#played,
      this.#chapterHost,
      this.#marker,
    );

    this.#glide = new ProgressGlide({ fill: this.#played, marker: this.#marker });

    this.#preview = document.createElement("div");
    this.#preview.className = "video-preview";
    this.#preview.hidden = true;
    this.#previewFrame = element("video-preview-frame");
    this.#previewLabel = element("video-preview-label");
    this.#preview.append(this.#previewFrame, this.#previewLabel);

    this.root.append(this.#track, this.#preview);

    // The marker is translated across the track in pixels rather than by a
    // percentage, because a percentage translation depends on the box size and a
    // transform that depends on the box size is not accelerated — see
    // `engine/glide.ts`. The cost of that is having to say how wide the track is,
    // and to say so again when a divider drag changes it. Probed by using it,
    // per AGENTS.md: an engine without it leaves the width at zero and the bar
    // falls back to the percentage writes below.
    try {
      this.#resize = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry || this.#destroyed) return;
        const wasActive = this.#glide.active;
        this.#glide.setTrackWidth(entry.contentRect.width);
        // A width arriving after the duration is what turns the animation on,
        // and it turns on parked at zero. The observer runs before the frame it
        // belongs to is painted, so pointing it at the transport here is what
        // keeps the bar from flashing back to the start of the film for a tick.
        if (!wasActive && this.#glide.active) this.sync(this.#lastVisible);
      });
      this.#resize.observe(this.#track);
    } catch {
      this.#resize = null;
    }

    const signal = this.#abort.signal;
    this.#track.addEventListener("pointerdown", this.#onPointerDown, { signal });
    this.#track.addEventListener("pointermove", this.#onPointerMove, { signal });
    this.#track.addEventListener("pointerup", this.#onPointerUp, { signal });
    this.#track.addEventListener("pointercancel", this.#onPointerUp, { signal });
    this.#track.addEventListener("pointerleave", this.#onPointerLeave, { signal });
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  setChapters(chapters: readonly Chapter[]): void {
    this.#chapters = chapters;
    this.#renderChapters();
  }

  /**
   * Chapter marks, rebuilt only when the chapter list changes.
   *
   * Each is a button rather than a decoration, because the brief asks for
   * "clickable markers on the scrubber" — and a button is also what makes them
   * reachable by keyboard and gives each one its title as a tooltip, which is
   * the only place a chapter's name appears without opening a panel.
   */
  #renderChapters(): void {
    const duration = this.#transport.durationMs;
    if (duration <= 0 || this.#chapters.length === 0) {
      this.#chapterHost.replaceChildren();
      return;
    }

    this.#chapterHost.replaceChildren(
      ...this.#chapters.map((chapter) => {
        const mark = document.createElement("button");
        mark.type = "button";
        mark.className = "video-chapter-mark";
        mark.style.left = `${(chapter.startMs / duration) * 100}%`;
        mark.title = `${formatTimecode(chapter.startMs)} — ${chapter.title}`;
        mark.setAttribute("aria-label", `chapter: ${chapter.title}`);
        mark.addEventListener("click", (event) => {
          // The mark sits on the track, and a click on it is a click on the
          // track underneath — which would seek to the pixel rather than to the
          // chapter, a few frames off.
          event.stopPropagation();
          this.#callbacks.onSeek(chapter.startMs);
        });
        // The same reasoning for the press: the track's own `pointerdown` starts
        // a scrub, which would take over the drag before the click ever lands.
        mark.addEventListener("pointerdown", (event) => event.stopPropagation());
        return mark;
      }),
    );
  }

  /**
   * Points the playhead at the transport. Always called, and cheap.
   *
   * Separate from {@link update} because it must run whether or not the bar is
   * on screen: the animation has to be told to stop when the chrome fades and
   * where to resume from when it comes back, and it is the only part of the
   * timeline that costs nothing to keep current — two comparisons in the steady
   * state.
   */
  sync(visible: boolean): void {
    if (this.#destroyed) return;
    // Remembered so the resize observer can drive one of these itself. See the
    // constructor: a width arriving is what activates the animation, and an
    // animation that is active but has not yet been told where the playhead is
    // holds the bar at zero — for up to a tick, which is long enough to paint.
    this.#lastVisible = visible;

    const duration = this.#transport.durationMs;
    // Idempotent, and the duration is not known until the metadata lands: this
    // is where a film that has just finished loading gets its animations.
    this.#glide.setDuration(duration);

    const rate = this.#transport.signedRate;
    const reversing = rate < 0;
    if (reversing !== this.#reversing) {
      this.#reversing = reversing;
      // The bar brightens while the film runs backwards — the same signal the
      // timecode gives, in the one part of the chrome that is showing motion.
      this.#track.classList.toggle("is-reversing", reversing);
    }

    // A duration but no animation means the track has not been measured yet —
    // the observer has not delivered its first entry, or this engine had none to
    // give. One rect per tick until a width arrives, and never for a stream,
    // which has no duration and so is drawn by hand for good.
    if (!this.#glide.active && duration > 0) {
      this.#glide.setTrackWidth(this.#track.getBoundingClientRect().width);
    }

    if (this.#glide.active) {
      this.#glide.sync({ currentMs: this.#transport.displayMs, rate, visible });
      return;
    }

    // Nothing to animate along: a live stream, or metadata that has not arrived.
    // The bar is drawn by hand at the tick's own rate, which steps, and stepping
    // is the correct amount of honesty about a timeline whose length is unknown.
    if (visible) this.#drawPosition(duration);
  }

  /** The fallback playhead: the same two transforms, written rather than animated. */
  #drawPosition(durationMs: number): void {
    const position =
      durationMs > 0 ? Math.min(1, Math.max(0, this.#transport.currentMs / durationMs)) : 0;
    // Rounded to a thousandth before comparing: this runs at the frame callback's
    // rate on a stream that will never be animated, and a fraction that differs
    // in its twelfth decimal is not a different bar.
    const drawn = Math.round(position * 1000);
    if (drawn === this.#drawnPosition) return;
    this.#drawnPosition = drawn;
    this.#played.style.transform = `scaleX(${position})`;
    this.#marker.style.transform = `translateX(${position * 100}%)`;
  }

  /**
   * Redraws everything that is *not* the playhead.
   *
   * Called only while the bar is on screen, and only for the parts that change
   * slowly enough to be written directly: the buffered extent, the loop region,
   * the chapter marks and the aria state. The chapter marks are rebuilt
   * separately because they change when the *file* does, not when the playhead
   * does — but their positions depend on the duration, which arrives after the
   * file loads, so a duration appearing for the first time triggers one rebuild.
   */
  update(): void {
    if (this.#destroyed) return;

    const duration = this.#transport.durationMs;
    if (duration <= 0) return;

    if (this.#chapters.length > 0 && this.#chapterHost.childElementCount === 0) {
      this.#renderChapters();
    }

    // A thousandth of the track is the finest change worth a style write, and
    // the buffered bar is the one element here deliberately given no
    // `will-change` — so every write of it is a real paint next to the
    // composited fill. See `#drawnBuffered`.
    const buffered = Math.round(this.#transport.bufferedFraction * 1000);
    if (buffered !== this.#drawnBuffered) {
      this.#drawnBuffered = buffered;
      this.#buffered.style.transform = `scaleX(${buffered / 1000})`;
    }

    // Once a second, not once a tick. An `aria-valuetext` rewritten ten times a
    // second is ten invalidations of the accessibility tree — and a screen
    // reader that is tracking a slider gets ten announcements — to say the same
    // second over and over. The value it carries has one-second resolution, so
    // that is how often it is worth writing.
    const seconds = Math.round(this.#transport.currentMs / 1000);
    if (seconds !== this.#announcedSecond) {
      this.#announcedSecond = seconds;
      this.#track.setAttribute("aria-valuemin", "0");
      this.#track.setAttribute("aria-valuemax", String(Math.round(duration / 1000)));
      this.#track.setAttribute("aria-valuenow", String(seconds));
      this.#track.setAttribute("aria-valuetext", formatTimecode(this.#transport.currentMs));
    }

    // The loop region is drawn whenever both points exist, including while the
    // loop is set but not yet running — which is the state between pressing the
    // key once and pressing it twice, and showing the in point immediately is
    // how the user knows the first press registered.
    const inMs = this.#transport.loopIn;
    const outMs = this.#transport.loopOut;
    if (inMs === null) {
      this.#loop.hidden = true;
      this.#drawnLoop = "";
    } else {
      this.#loop.hidden = false;
      const from = Math.min(1, inMs / duration);
      const to = outMs === null ? from : Math.min(1, outMs / duration);
      // A zero-width region is invisible, so a set-but-incomplete loop is drawn
      // as a hairline at the in point rather than as nothing at all.
      const left = `${from * 100}%`;
      const width = `${Math.max(to - from, 0.004) * 100}%`;
      // A loop's ends move when a key is pressed and at no other time, so the
      // frame callback would otherwise rewrite two lengths per frame for the
      // whole of a loop's life. Compared as the strings that would be written,
      // which is the only comparison that is certain to match what is there.
      const drawn = `${left} ${width}`;
      if (drawn !== this.#drawnLoop) {
        this.#drawnLoop = drawn;
        this.#loop.style.left = left;
        this.#loop.style.width = width;
      }
      this.#loop.classList.toggle("is-active", this.#transport.looping);
    }
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  /** Where along the track a client x sits, as a fraction. */
  #fractionAt(clientX: number): number {
    const box = this.#track.getBoundingClientRect();
    if (box.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  }

  #onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.#transport.durationMs <= 0) return;
    event.preventDefault();

    this.#setScrubbing(true);
    // Remembered so playback resumes on release. A scrub that leaves a playing
    // film paused is the single most irritating thing a player can do.
    this.#wasPlaying = this.#transport.playing;
    this.#transport.pause();
    this.#track.setPointerCapture(event.pointerId);
    this.#callbacks.onScrubStateChange(true);

    this.#callbacks.onSeek(this.#fractionAt(event.clientX) * this.#transport.durationMs);
  };

  #onPointerMove = (event: PointerEvent): void => {
    const duration = this.#transport.durationMs;
    if (duration <= 0) return;

    const at = this.#fractionAt(event.clientX) * duration;

    if (this.#scrubbing) {
      this.#callbacks.onSeek(at);
    }
    this.#showPreview(at, event.clientX);
  };

  #onPointerUp = (event: PointerEvent): void => {
    if (!this.#scrubbing) return;
    this.#setScrubbing(false);
    if (this.#track.hasPointerCapture(event.pointerId)) {
      this.#track.releasePointerCapture(event.pointerId);
    }
    this.#callbacks.onScrubStateChange(false);
    if (this.#wasPlaying) this.#transport.play();
  };

  /**
   * The drag state, and the class that puts the marker on screen for it.
   *
   * The marker is otherwise revealed by hovering the track (see `video.css`),
   * which is not enough on its own: a pointer captured for a drag can leave the
   * track entirely — dragging below the tile is how people scrub — and `:hover`
   * stops matching the moment it does, taking the marker away mid-drag.
   */
  #setScrubbing(scrubbing: boolean): void {
    this.#scrubbing = scrubbing;
    this.root.classList.toggle("is-scrubbing", scrubbing);
  }

  #onPointerLeave = (): void => {
    this.#hidePreview();
  };

  // -------------------------------------------------------------------------
  // The hover preview
  // -------------------------------------------------------------------------

  /**
   * Shows the timecode immediately and the frame when it arrives.
   *
   * The split is deliberate. The timecode is free and is what the pointer is
   * actually being aimed with, so it must not wait behind a decode; the frame
   * takes a seek and a draw, and asking for one per pointer move would queue
   * dozens. So the label tracks the pointer at full rate and the frame is
   * debounced, which is how it feels in a player that does this well.
   */
  #showPreview(milliseconds: number, clientX: number): void {
    if (this.#destroyed) return;

    this.#preview.hidden = false;
    this.#previewLabel.textContent = formatTimecode(milliseconds);
    // Named chapter under the pointer, when there is one — which turns the
    // preview into the answer to "which chapter is this bit".
    const chapter = this.#chapterAt(milliseconds);
    if (chapter) this.#previewLabel.textContent += ` · ${chapter.title}`;

    const box = this.root.getBoundingClientRect();
    const width = this.#preview.offsetWidth || 160;
    // Kept inside the tile: a preview near either end of the scrubber otherwise
    // hangs off the side of the tile and is clipped.
    const left = Math.min(
      Math.max(clientX - box.left - width / 2, 0),
      Math.max(box.width - width, 0),
    );
    this.#preview.style.left = `${left}px`;

    if (!this.#thumbnailer?.available) {
      this.#previewFrame.hidden = true;
      return;
    }

    if (this.#previewTimer) clearTimeout(this.#previewTimer);
    const token = ++this.#previewToken;
    this.#previewTimer = setTimeout(() => {
      this.#previewTimer = null;
      void this.#thumbnailer?.frameAt(milliseconds).then((frame) => {
        // Dropped when the pointer has moved on, so a slow decode cannot paint
        // a stale frame over the position the user is now looking at.
        if (this.#destroyed || token !== this.#previewToken) return;
        if (!frame) {
          this.#previewFrame.hidden = true;
          return;
        }
        this.#previewFrame.hidden = false;
        this.#previewFrame.replaceChildren(frame.canvas);
      });
    }, PREVIEW_DEBOUNCE_MS);
  }

  #hidePreview(): void {
    this.#previewToken += 1;
    if (this.#previewTimer) clearTimeout(this.#previewTimer);
    this.#previewTimer = null;
    this.#preview.hidden = true;
    this.#previewFrame.replaceChildren();
  }

  /** The chapter containing a timestamp: the last one that started before it. */
  #chapterAt(milliseconds: number): Chapter | undefined {
    let found: Chapter | undefined;
    for (const chapter of this.#chapters) {
      if (chapter.startMs <= milliseconds) found = chapter;
      else break;
    }
    return found;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#abort.abort();
    this.#resize?.disconnect();
    this.#resize = null;
    // Before the elements go: an animation outliving its element keeps the
    // element alive with it.
    this.#glide.destroy();
    if (this.#previewTimer) clearTimeout(this.#previewTimer);
    this.root.remove();
  }
}

function element(className: string): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  return node;
}
