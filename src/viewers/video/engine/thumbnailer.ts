/**
 * Frames at arbitrary timestamps, for the scrubber's hover preview and for the
 * contract's `thumbnail()`.
 *
 * Both need the same thing — a picture of the film at a moment that is not the
 * moment being played — and neither may move the playhead to get it. So this
 * owns a *second*, hidden `<video>` pointed at the same source, seeks that one,
 * and draws the result to a canvas. Every media player with a scrubber preview
 * does this; there is no other way to have a frame from 42:10 while watching
 * 03:00.
 *
 * ## Every wait has a deadline
 *
 * A seek resolves when the engine fires `seeked`, and AGENTS.md records at
 * length what happens to an unbounded `await` on something the engine may never
 * deliver: *"a hang reports nothing, which is strictly worse than a failure."*
 * Both hangs found in phase 03 were this shape. So every seek here races a
 * timer, a timed-out seek disables the preview rather than retrying forever, and
 * `available` says which state it is in.
 *
 * ## One request at a time, and only the newest matters
 *
 * Dragging along a scrubber generates a request per pointer move. Queuing them
 * would seek to every intermediate position in turn and arrive at the one the
 * user wants several seconds after they stopped moving. So a request in flight
 * is left to finish, the latest pending request replaces any other pending one,
 * and the intermediate positions are simply never asked for — which is the same
 * newest-wins reasoning the image plugin's folder navigation counter uses,
 * applied to a different kind of staleness.
 */

/** How long to wait for one seek before concluding the decoder is not answering. */
const SEEK_TIMEOUT_MS = 3000;

/** How long to wait for the hidden element to become usable at all. */
const READY_TIMEOUT_MS = 10_000;

export interface FrameGrab {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** The timestamp actually landed on, which a keyframe-only seek may shift. */
  readonly atMs: number;
}

export class Thumbnailer {
  #video: HTMLVideoElement;
  #ready: Promise<boolean> | null = null;
  #available = true;
  #busy = false;
  #pending: { ms: number; resolve: (frame: FrameGrab | null) => void } | null = null;
  #destroyed = false;

  constructor(url: string) {
    const video = document.createElement("video");
    video.src = url;
    video.preload = "metadata";
    video.muted = true;
    // `playsInline` and `crossOrigin` are both about what the element is allowed
    // to do rather than how it looks: without the first, some engines take a
    // seek on a hidden element as a cue to go fullscreen, and the second keeps
    // the canvas untainted so `drawImage` can be read back. The source is a
    // local `asset:` URL, so this is same-origin either way and the attribute
    // costs nothing to be explicit about.
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    // Off screen rather than `display: none`: a `display: none` video is not
    // required to decode at all, and on WebKit it does not — a seek on one never
    // produces a frame, which is a hang rather than a failure.
    //
    // The 2×2 size and zero opacity were tried at real dimensions and non-zero
    // opacity on the theory that an engine skips work for elements it judges
    // invisible. Measured on webkit2gtk with the window composited: no
    // difference. What actually decides it is whether the *source* can be
    // seeked, which is a property of the file — see `frameAt`.
    video.style.cssText =
      "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
    document.body.append(video);
    this.#video = video;
  }

  /** Whether previews are working. `false` after a failure, permanently. */
  get available(): boolean {
    return this.#available;
  }

  /**
   * Waits for the hidden element to know its own dimensions.
   *
   * Memoized, so the twenty pointer moves that start a scrub share one wait.
   */
  #whenReady(): Promise<boolean> {
    if (this.#ready) return this.#ready;

    this.#ready = new Promise<boolean>((resolve) => {
      if (this.#video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        resolve(this.#video.videoWidth > 0);
        return;
      }

      const abort = new AbortController();
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abort.abort();
        if (!ok) this.#available = false;
        resolve(ok);
      };

      const timer = setTimeout(() => finish(false), READY_TIMEOUT_MS);
      this.#video.addEventListener(
        "loadedmetadata",
        () => finish(this.#video.videoWidth > 0),
        { signal: abort.signal },
      );
      this.#video.addEventListener("error", () => finish(false), { signal: abort.signal });
      this.#video.load();
    });

    return this.#ready;
  }

  /**
   * A frame at `milliseconds`, or `null` when one could not be produced.
   *
   * `null` is not an error and every caller treats it as "show no preview" —
   * an audio-only file, a decoder that will not seek on a hidden element, and a
   * window that is not being composited all land here, and none of them is worth
   * a message on top of the video.
   */
  async frameAt(milliseconds: number, maxWidth = 240): Promise<FrameGrab | null> {
    if (this.#destroyed || !this.#available) return null;
    if (!(await this.#whenReady())) return null;
    if (this.#destroyed) return null;

    // Newest wins: a request already in flight finishes, and this one replaces
    // whatever else was waiting.
    if (this.#busy) {
      return new Promise<FrameGrab | null>((resolve) => {
        this.#pending?.resolve(null);
        this.#pending = { ms: milliseconds, resolve };
      });
    }

    this.#busy = true;
    try {
      return await this.#grab(milliseconds, maxWidth);
    } finally {
      this.#busy = false;
      const next = this.#pending;
      this.#pending = null;
      if (next && !this.#destroyed) {
        void this.frameAt(next.ms, maxWidth).then(next.resolve);
      }
    }
  }

  async #grab(milliseconds: number, maxWidth: number): Promise<FrameGrab | null> {
    const duration = Number.isFinite(this.#video.duration) ? this.#video.duration * 1000 : 0;
    // A hair inside the end: seeking exactly to the duration lands past the last
    // frame on some engines and fires `ended` instead of `seeked`.
    const target = Math.max(0, duration > 0 ? Math.min(milliseconds, duration - 40) : milliseconds);

    const seeked = await this.#seek(target / 1000);
    if (!seeked || this.#destroyed) return null;

    const width = this.#video.videoWidth;
    const height = this.#video.videoHeight;
    if (!width || !height) return null;

    const scale = Math.min(maxWidth / width, 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d");
    if (!context) return null;

    try {
      context.drawImage(this.#video, 0, 0, canvas.width, canvas.height);
    } catch {
      // A decoder that seeks but will not hand its frame to a canvas. Rare, and
      // permanent when it happens, so previews stop rather than being retried on
      // every pointer move.
      this.#available = false;
      canvas.width = 0;
      canvas.height = 0;
      return null;
    }

    return {
      canvas,
      width: canvas.width,
      height: canvas.height,
      atMs: this.#video.currentTime * 1000,
    };
  }

  /** One seek, bounded. `false` on timeout, which also disables the previewer. */
  #seek(seconds: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const abort = new AbortController();
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abort.abort();
        if (!ok) this.#available = false;
        resolve(ok);
      };

      const timer = setTimeout(() => finish(false), SEEK_TIMEOUT_MS);
      this.#video.addEventListener("seeked", () => finish(true), { signal: abort.signal });
      this.#video.addEventListener("error", () => finish(false), { signal: abort.signal });

      try {
        this.#video.currentTime = seconds;
      } catch {
        finish(false);
      }
    });
  }

  destroy(): void {
    this.#destroyed = true;
    this.#pending?.resolve(null);
    this.#pending = null;
    // Emptying `src` and reloading is what actually releases the decoder;
    // removing the element alone leaves it holding one until collection, which
    // for a session that opened a dozen videos is a dozen live decoders.
    this.#video.removeAttribute("src");
    this.#video.load();
    this.#video.remove();
  }
}
