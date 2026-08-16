/**
 * The frame hold: a canvas that keeps the last decoded picture on screen while
 * the element behind it is between frames.
 *
 * ## What this is for
 *
 * Reverse play here is a sequence of seeks on a paused element
 * (`transport.ts`, "Reverse is emulated, and has to be"), and every one of those
 * seeks has a window in which the media element has *no frame to show*. What it
 * shows in that window is the engine's business and none of the three target
 * webviews agree: WebKit flushes the video sink and paints the layer's
 * background, GStreamer's pipeline behind webkit2gtk does the same on a
 * flushing seek, and the result is a black frame between every pair of good
 * ones. At ten to twenty steps a second that is not an occasional glitch, it is
 * a strobe — and it is the single worst thing about backward playback, because
 * the eye reads it as the picture being destroyed and rebuilt rather than as
 * film running backwards.
 *
 * `transport.ts` already does everything that can be done *about the seeks*:
 * one in flight at a time, released by a presented frame, never a step that
 * moves forwards. None of that helps, because the gap is not caused by the
 * seeks overlapping — it is caused by a single seek having a middle. The only
 * remaining fix is to stop showing the element during the gap, and the only way
 * to do that without a second decoder is to keep a copy of the last good frame
 * and put it over the top.
 *
 * So: a `<canvas>` sized and positioned exactly over the picture, holding the
 * most recent frame, drawn from the element itself. While it is up, whatever the
 * element does underneath is invisible.
 *
 * ## Why a copy of the frame is cheap here and would not be in general
 *
 * `drawImage(video, …)` is one GPU blit per *new* frame, not per rendered
 * frame — the canvas keeps showing what it holds with no further work. Reverse
 * produces ten to twenty new frames a second, and the canvas is sized to the box
 * it covers on screen rather than to the media's own pixels, so a 4K film in a
 * quarter-tile costs a blit of a few hundred pixels square. This is emphatically
 * not the "canvas-per-frame pipeline" `engine/view.ts` rules out for playback:
 * nothing here decodes, and it runs only while the transport is doing something
 * that blanks the element.
 *
 * ## Only ever drawn from a frame that exists
 *
 * The one way to make this worse than the problem is to draw *during* the gap
 * and cache the blank. So there are exactly two moments a draw is attempted —
 * `seeked`, when the decoder has the target frame, and
 * `requestVideoFrameCallback`, when the compositor has presented one — and
 * `readyState` is checked at both. Between them the canvas keeps what it has,
 * which is the whole point.
 *
 * `drawImage` reads the element's *current frame*, not the composited layer, so
 * it works in a window that is not being composited — where, per AGENTS.md, no
 * frame is ever presented and the callback never fires. That is why `seeked` is
 * wired as well and not merely as a fallback for engines without the callback.
 *
 * ## Release waits for the picture to come back
 *
 * Removing the canvas the instant reverse stops would uncover the element at
 * exactly the moment it is least likely to have a frame — the last seek is
 * typically still settling. So {@link FrameHold.release} keeps it up until the
 * element presents a frame, with a short deadline for the case where none is
 * coming (a window behind another, an engine with no frame callback). Re-engaging
 * during that wait cancels it, so a frame step immediately after another does
 * not flash between them.
 */

/**
 * How long a release waits for the element to present a frame before giving up
 * and uncovering it anyway.
 *
 * Short, for the reason `transport.ts` gives about its own grace window: in a
 * window that is not being composited the frame is never presented, and a hold
 * that waited indefinitely would leave a still image over a film that had gone
 * back to playing.
 */
const RELEASE_DEADLINE_MS = 200;

/**
 * The most the held bitmap is allowed to differ from its target before it is
 * resized.
 *
 * Resizing a canvas clears it, so doing it on every draw would mean a blank
 * canvas for one frame every time the tile moved by a pixel — the exact defect
 * this module exists to remove. A tenth is far below what is visible on a
 * bitmap that is being scaled to fit its box anyway.
 */
const RESIZE_TOLERANCE = 0.1;

export class FrameHold {
  #video: HTMLVideoElement;
  /** The picture's box. The canvas fills it, so the two cannot drift apart. */
  #host: HTMLElement;

  #canvas: HTMLCanvasElement | null = null;
  #context: CanvasRenderingContext2D | null = null;

  #engaged = false;
  /** Whether a draw has ever succeeded, so a hold with nothing in it is known. */
  #hasFrame = false;
  #frameCallback: number | null = null;
  #releaseTimer: ReturnType<typeof setTimeout> | null = null;
  #listeners: AbortController | null = null;
  #destroyed = false;

  constructor(options: { video: HTMLVideoElement; host: HTMLElement }) {
    this.#video = options.video;
    this.#host = options.host;
  }

  /** Whether the canvas is currently covering the picture. */
  get active(): boolean {
    return this.#engaged;
  }

  /** Test hook: whether a real frame was captured, rather than an empty hold. */
  get holdsFrame(): boolean {
    return this.#hasFrame;
  }

  /**
   * Covers the picture, from now until {@link release}.
   *
   * Idempotent, and deliberately so: the transport engages on entering reverse
   * and again on every frame step, and a caller should never have to know
   * whether a hold is already up.
   */
  engage(): void {
    if (this.#destroyed) return;
    this.#cancelRelease();
    if (this.#engaged) {
      // Already up, and possibly showing a frame from before a seek the caller
      // is about to make. Refresh it while the element still has the old one.
      this.#draw();
      return;
    }

    this.#engaged = true;
    const canvas = document.createElement("canvas");
    canvas.className = "video-hold";
    // Never a pointer target: the stage's own click-to-play and the context
    // menu both test their event target, and a canvas between the pointer and
    // the picture would silently break both for as long as reverse ran.
    canvas.setAttribute("aria-hidden", "true");
    this.#canvas = canvas;
    // Alpha kept on, which looks like the wrong trade for a canvas that only
    // ever holds opaque frames and is not. An `alpha: false` canvas starts
    // *opaque black*, so a hold engaged before any frame could be captured
    // would paint precisely the black rectangle this module exists to prevent.
    // With alpha, an empty hold is transparent and the element shows through —
    // the same picture as no hold at all, which is the correct failure.
    this.#context = canvas.getContext("2d");

    // Drawn *before* it is inserted, so the first thing on screen is the
    // picture rather than one frame of an empty canvas.
    this.#draw();
    this.#host.append(canvas);

    this.#listeners = new AbortController();
    this.#video.addEventListener("seeked", this.#onSeeked, {
      signal: this.#listeners.signal,
    });
    this.#arm();
  }

  /**
   * Uncovers the picture, once the element has a frame to show.
   *
   * See the module comment: the moment a hold is released is the moment the
   * element is least likely to have settled, so this waits for a presented
   * frame and falls back to {@link RELEASE_DEADLINE_MS}.
   */
  release(): void {
    if (!this.#engaged || this.#destroyed) return;
    if (this.#releaseTimer !== null) return;
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = null;
      this.#teardown();
    }, RELEASE_DEADLINE_MS);

    const element = this.#video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    try {
      // Probed by using it (AGENTS.md): a call that throws or never fires costs
      // nothing, because the deadline above still runs.
      element.requestVideoFrameCallback?.(() => {
        if (this.#releaseTimer === null) return;
        this.#cancelRelease();
        this.#teardown();
      });
    } catch {
      /* The deadline is the answer. */
    }
  }

  /** Drops the hold immediately, without waiting for anything. */
  cancel(): void {
    this.#cancelRelease();
    this.#teardown();
  }

  destroy(): void {
    this.#destroyed = true;
    this.cancel();
  }

  // -------------------------------------------------------------------------
  // Capture
  // -------------------------------------------------------------------------

  #onSeeked = (): void => {
    // The decoder has the target frame now, whether or not anything has been
    // composited. This is the draw that carries a window that is not on screen.
    this.#draw();
  };

  /** Re-arms the per-frame draw. One outstanding callback at a time. */
  #arm(): void {
    if (!this.#engaged || this.#destroyed) return;
    const element = this.#video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    try {
      this.#frameCallback =
        element.requestVideoFrameCallback?.(() => {
          this.#frameCallback = null;
          this.#draw();
          this.#arm();
        }) ?? null;
    } catch {
      this.#frameCallback = null;
    }
  }

  /**
   * Copies the element's current frame into the canvas.
   *
   * Returns whether anything was drawn. A failure leaves the previous frame in
   * place, which is the correct answer in every failure case there is: an
   * element with no frame yet, a decoder mid-flush, a draw the engine refused.
   */
  #draw(): boolean {
    const canvas = this.#canvas;
    const context = this.#context;
    if (!canvas || !context || this.#destroyed) return false;

    const width = this.#video.videoWidth;
    const height = this.#video.videoHeight;
    if (width <= 0 || height <= 0) return false;
    // `HAVE_CURRENT_DATA`. Below it there is no frame at the playhead and
    // `drawImage` is specified to draw nothing — which would be a hold with a
    // blank in it, the one outcome worse than no hold at all.
    if (this.#video.readyState < 2) return false;
    // And never mid-seek. `readyState` is not a reliable guard on its own:
    // several engines keep it high across a seek they have already flushed the
    // sink for, so a draw taken then copies the blanked picture into the very
    // canvas that is covering the blanked picture. Every legitimate capture
    // point — `seeked`, a presented frame — has this flag already clear.
    if (this.#video.seeking) return false;

    this.#resizeFor(width, height);

    try {
      context.drawImage(this.#video, 0, 0, canvas.width, canvas.height);
    } catch {
      // A tainted or not-yet-decodable source. The canvas keeps what it had.
      return false;
    }
    this.#hasFrame = true;
    return true;
  }

  /**
   * Sizes the bitmap to the box it is covering, never larger than the media.
   *
   * The canvas is stretched to the host by CSS, so its bitmap only has to carry
   * the pixels that will actually be displayed. A 4K film in a small tile
   * therefore costs a small blit, and the same film zoomed to 400% gets a bitmap
   * capped at its own native resolution rather than a sixteen-times-oversized
   * one — in both directions the canvas holds what the screen can show and no
   * more.
   */
  #resizeFor(mediaWidth: number, mediaHeight: number): void {
    const canvas = this.#canvas;
    if (!canvas) return;

    const displayed = this.#host.clientWidth;
    const ratio = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const wanted =
      displayed > 0 ? Math.min(mediaWidth, Math.max(1, Math.round(displayed * ratio))) : mediaWidth;
    const height = Math.max(1, Math.round((wanted * mediaHeight) / mediaWidth));

    // Resizing clears the canvas, so it is done only when the difference is
    // worth a blank frame — see RESIZE_TOLERANCE.
    const drift = canvas.width > 0 ? Math.abs(wanted - canvas.width) / canvas.width : 1;
    if (canvas.width > 0 && drift < RESIZE_TOLERANCE) return;

    canvas.width = wanted;
    canvas.height = height;
    this.#hasFrame = false;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  #cancelRelease(): void {
    if (this.#releaseTimer !== null) {
      clearTimeout(this.#releaseTimer);
      this.#releaseTimer = null;
    }
  }

  #teardown(): void {
    if (!this.#engaged) return;
    this.#engaged = false;
    this.#hasFrame = false;

    this.#listeners?.abort();
    this.#listeners = null;

    if (this.#frameCallback !== null) {
      const element = this.#video as HTMLVideoElement & {
        cancelVideoFrameCallback?: (handle: number) => void;
      };
      try {
        element.cancelVideoFrameCallback?.(this.#frameCallback);
      } catch {
        /* The callback checks the state it runs in. */
      }
      this.#frameCallback = null;
    }

    if (this.#canvas) {
      // Zeroed before it is dropped: a canvas holding a 4K bitmap is megabytes,
      // and a tile that reversed a hundred times should not have left a hundred
      // of them for the collector to find.
      this.#canvas.width = 0;
      this.#canvas.height = 0;
      this.#canvas.remove();
      this.#canvas = null;
    }
    this.#context = null;
  }
}
