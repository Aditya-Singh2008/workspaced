/**
 * The transport: everything that moves the playhead.
 *
 * Play, pause, seek, frame-step, variable speed, J/K/L shuttle and the A/B loop
 * — the brief's first three engine requirements — over one `HTMLVideoElement`.
 * Nothing here touches the DOM beyond that element: the scrubber, the readouts
 * and the controls all *observe* this class, which is what lets a keystroke and a
 * button be two ways to run one action rather than two implementations that can
 * disagree (the rule `viewers/image/actions.ts` and `shell/docking/actions.ts`
 * both follow).
 *
 * It is deliberately the same *shape* as the image plugin's
 * `engine/animation.ts` — a playing flag, a position, a speed, a step in either
 * direction — because phase 04a's brief asked that plugin to anticipate this
 * one so the two feel familiar. The two share no code, which is the contract
 * working as intended.
 *
 * ## J, K, L are three keys, not a ladder
 *
 * They used to climb: each press of `L` moved up 1×, 2×, 4×, 8×, 16×. That is
 * the tape-deck convention and it was the wrong thing to build here. Above
 * roughly 4× no decoder in any of the three target webviews keeps up, so the
 * top of the ladder was a number in a readout over a picture that stuttered —
 * and every rung above 1× in *reverse* multiplied a seek load that was already
 * the hardest thing this file does. Speed is a separate, better control that
 * goes from 0.25× to 4× with the audio intact.
 *
 * So: `L` plays, `J` plays backwards, `K` stops. Pressing the same key again
 * stops; pressing the other reverses. There is no hidden state to climb out of.
 *
 * The speed control is what a ladder was for, and it works in *both*
 * directions: `#stepReverse` takes its travel from `elapsed × speed`, so
 * backwards at 2× is `J` and then 2×, and it costs strictly fewer seeks per
 * second than backwards at 1× rather than more. That is the whole of "reverse at
 * 2×" — one rate, one direction flag, and the same anti-flicker rules below
 * applying unchanged at every speed.
 *
 * ## Reverse is emulated, and has to be
 *
 * No browser engine implements a negative `playbackRate` — the property accepts
 * one and the specification permits ignoring it, and all three of the target
 * webviews ignore it. Setting it and believing the read-back is the exact
 * `CanvasRenderingContext2D.filter` trap AGENTS.md documents, one layer up.
 *
 * So the element is paused and the playhead is seeked backwards. mpv does the
 * same thing in principle and a great deal more in practice: it seeks back by a
 * chunk, decodes that chunk *forwards* into a queue, and presents the queue in
 * reverse, which is how it gets full-frame-rate backward play. That queue is not
 * available here — it would mean decoding in JavaScript and giving up the
 * hardware path the brief requires — but the parts of mpv's approach that do
 * carry over are the parts that make it smooth, and `#stepReverse` implements
 * each one:
 *
 *   1. **One seek in flight, released by a *presented frame*.** Not by `seeked`:
 *      that fires when the seek completes, which is before the frame reaches the
 *      compositor. Stepping on it means the next seek is issued while the last
 *      frame is still being painted, so the picture is a mix of two.
 *   2. **Never a step that moves forward.** `fastSeek` snaps to the *nearest*
 *      keyframe, which is routinely *ahead* of where it was asked to go. Under
 *      reverse that reads as the picture jerking forwards between backward
 *      steps. Reverse uses exact seeks and each target is taken from the last
 *      *request*, never from where the engine landed, so the sequence cannot
 *      oscillate.
 *   3. **Position from the wall clock, quantized to the frame grid, clamped.**
 *      Distance covered comes from elapsed time and the current speed, so
 *      reverse runs at the rate it claims whether seeks are cheap or expensive.
 *      Quantizing to whole frames keeps two consecutive steps from decoding the
 *      same picture. Clamping the per-step distance keeps a decoder that stalled
 *      for a second from teleporting a second's worth of film.
 *
 * ## The black flicker was none of the three, and is not fixed here
 *
 * Every rule above is about the *sequence* of seeks, and the sequence was never
 * what produced the strobe. A single seek on a paused element has a middle, and
 * in that middle the engine has no frame to show: WebKit flushes the video sink
 * and paints the layer's background, and webkit2gtk's GStreamer pipeline does
 * the same. So a perfectly ordered, never-overlapping, never-forward sequence of
 * seeks still shows black between every pair of good frames, because each seek
 * blanks the element on its own.
 *
 * Nothing this file can do about the seeks fixes that. What fixes it is not
 * showing the element while it is blank, which is `engine/hold.ts` — a canvas
 * holding the last decoded frame, put over the picture for the length of the
 * gap. This transport's part is knowing *when* the gap is: it engages the hold
 * on entering reverse and on any seek made while paused, and releases it when
 * the picture is live again. {@link TransportCallbacks.onHoldFrame} is that
 * signal, and it is the reason a seek issued while playing does not raise one —
 * the engine keeps presenting frames throughout a seek it is playing over, so
 * there is no gap to cover and freezing one would be a defect rather than a fix.
 *
 * ## Timers, not animation frames
 *
 * The A/B loop has to be enforced more often than `timeupdate` fires — the
 * event is specified to fire about four times a second, which at 2× on a
 * two-second loop overshoots the out point by a visible amount. The obvious fix
 * is `requestAnimationFrame`, and it is wrong here for the reason AGENTS.md
 * records: a window that is not being composited never gets a frame, and a video
 * whose tile is occluded keeps playing. A loop that silently stopped looping
 * whenever the window went behind another is worse than one that is fifty
 * milliseconds coarse. `setInterval` keeps running and costs one comparison.
 */

/** Speeds the cycle visits. The brief asks for at least 0.25× to 2×. */
export const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4] as const;

/**
 * The speeds the bar's own control walks, and only those.
 *
 * Eight stops is the right ladder for a key that can be held down and a menu row
 * that names its destination; it is the wrong one for a chip that is clicked,
 * where getting back to normal speed would take seven presses. These three are
 * the ones a review is actually run at, and everything below 1× stays on `x` and
 * the context menu — which is the same split the toolbar makes everywhere else
 * in this app: the common case on screen, the whole set one layer in.
 */
export const QUICK_SPEEDS = [1, 1.5, 2] as const;

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** Which way the transport is shuttling: `-1` back, `0` off, `1` forward. */
export type ShuttleDirection = -1 | 0 | 1;

/** How often the loop and the reverse stepper are serviced. */
const TICK_MS = 50;

/**
 * How many frame intervals a presented frame's timestamp may be extrapolated
 * from before it is stale. See {@link Transport.displayMs}.
 *
 * A frame and a half: long enough to cover the gap to the next frame and the
 * jitter around it, short enough that a callback which has stopped arriving —
 * a tile behind another window presents no frames — hands the clock back within
 * a frame rather than running on into a position nothing has confirmed.
 */
const FRAME_TRUST_FRAMES = 1.5;

/**
 * How far the extrapolated frame clock may sit from the element's own before it
 * is disbelieved. Wider than a frame at any rate the player supports, narrower
 * than the smallest seek, so a seek underneath a stale sample is caught at once.
 */
const FRAME_AGREEMENT_MS = 100;

/**
 * The shortest gap between two reverse steps.
 *
 * A floor, not a pace: steps are normally released by the previous frame
 * reaching the screen, and this only stops a pipeline that answers instantly
 * from being asked for more seeks than there are frames to show.
 */
const MIN_STEP_MS = 50;

/**
 * The furthest one reverse step may travel.
 *
 * Distance comes from elapsed time, so a decoder that stalls for a second would
 * otherwise answer with a one-second jump — which reads as a skip, not as
 * reverse. Capping it trades exact real-time reverse on a struggling file for
 * motion that still looks like motion.
 */
const MAX_STEP_MS = 400;

/**
 * How long a landed seek waits for its frame to be *presented*.
 *
 * The seek is done and the picture is very likely already right; this is the
 * margin that lets the compositor put it on screen before the next seek
 * disturbs it, and it is what keeps reverse from tearing.
 *
 * It must be short. A window that is not being composited never presents a
 * frame at all, and measured there, waiting for one cost the whole deadline per
 * step and dragged reverse down to a third of real time. Paying 80 ms for a
 * presentation that is not coming is a rounding error; paying 600 ms is the
 * difference between reverse and a slideshow.
 */
const PRESENT_GRACE_MS = 80;

/**
 * How long a step may wait in total before the next one is issued anyway.
 *
 * The backstop for an engine that fires neither `seeked` nor a frame callback.
 * Without it reverse would stop dead on a flag nothing will clear — and
 * AGENTS.md is unambiguous that a hang reports nothing, which is strictly worse
 * than a failure.
 */
const STEP_DEADLINE_MS = 600;

/** Monotonic, so a clock adjustment mid-shuttle cannot move the playhead. */
const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

/**
 * Assumed frame rate when the container did not state one.
 *
 * Every frame-step needs a frame duration, and a variable-frame-rate file
 * genuinely has no single answer. 25 is close enough that stepping feels like
 * stepping, and `frameRateIsAssumed` is exposed so the readout can say the
 * number is not the file's.
 */
const ASSUMED_FRAME_RATE = 25;

export interface TransportCallbacks {
  /** The playhead moved, or playback started or stopped. Cheap; called often. */
  onChange(): void;
  /** A user-visible one-off, for the status line. */
  onAnnounce(message: string, tone?: "info" | "warn"): void;
  /**
   * Cover the picture, or stop covering it.
   *
   * Raised around every operation that leaves the media element without a frame
   * — reverse play and any seek made while paused. See the module comment, "The
   * black flicker was none of the three": the transport knows where the gaps
   * are and `engine/hold.ts` knows how to hide them, and this is the one line
   * between them. Optional, so a transport built without a view (the self-test
   * builds several) needs no stub.
   */
  onHoldFrame?(active: boolean): void;
}

export interface LoopRange {
  readonly inMs: number;
  readonly outMs: number;
}

export class Transport {
  #video: HTMLVideoElement;
  #callbacks: TransportCallbacks;
  #frameRate: number;
  #frameRateAssumed: boolean;

  #speed: PlaybackSpeed = 1;
  /** `-1` reversing, `0` off, `1` playing forward under `L`. */
  #shuttle: ShuttleDirection = 0;
  /** Where the reverse stepper asked the playhead to be, in milliseconds. */
  #anchorMs = 0;
  /** When the last step was issued, on the monotonic clock. `0` when idle. */
  #stepAt = 0;
  /** Whether a step is still waiting for its frame. The anti-flicker fix. */
  #stepPending = false;
  #stepDeadline = 0;
  /** The pending `requestVideoFrameCallback`, so a cancelled step drops it. */
  #frameCallback: number | null = null;
  /** Set once a step's seek has landed and only its presentation is awaited. */
  #graceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The next reverse step, scheduled by the last one. See {@link #scheduleStep}. */
  #stepTimer: ReturnType<typeof setTimeout> | null = null;
  #loopIn: number | null = null;
  #loopOut: number | null = null;
  #looping = false;

  #ticker: ReturnType<typeof setInterval> | null = null;
  /** The last frame's presentation timestamp, and when it was handed over. */
  #framePresentedMs: number | null = null;
  #framePresentedAt = 0;
  #abort = new AbortController();
  #destroyed = false;

  constructor(options: {
    video: HTMLVideoElement;
    frameRate?: number;
    callbacks: TransportCallbacks;
  }) {
    this.#video = options.video;
    this.#callbacks = options.callbacks;
    this.#frameRate = options.frameRate && options.frameRate > 0 ? options.frameRate : ASSUMED_FRAME_RATE;
    this.#frameRateAssumed = !(options.frameRate && options.frameRate > 0);

    const signal = this.#abort.signal;
    for (const event of ["play", "pause", "timeupdate", "durationchange", "ratechange", "volumechange", "seeked", "ended"]) {
      this.#video.addEventListener(event, this.#onMediaEvent, { signal });
    }
    // Separate from the readout listener above: this one releases the reverse
    // stepper, and it must run whether or not anything is listening for a
    // redraw.
    this.#video.addEventListener("seeked", this.#onSeeked, { signal });
    // Running off the end stops the shuttle, so the readout cannot keep
    // claiming to be moving over a stopped picture.
    this.#video.addEventListener("ended", () => this.#stopShuttle(), { signal });
  }

  #onMediaEvent = (): void => {
    if (this.#destroyed) return;
    this.#callbacks.onChange();
  };

  // -------------------------------------------------------------------------
  // Position
  // -------------------------------------------------------------------------

  get currentMs(): number {
    const time = this.#video.currentTime;
    return Number.isFinite(time) ? time * 1000 : 0;
  }

  /**
   * Where the playhead is, taken from the picture rather than from the element.
   *
   * `currentTime` is the *official playback position*, and the specification
   * only requires it to keep up — it is quantised to whatever frame the element
   * has settled on and it lags the picture by up to a frame. That is invisible
   * in a timecode readout, which rounds to a frame anyway, and it is exactly the
   * wrong input for `engine/glide.ts`, whose whole job is to decide whether the
   * bar has drifted: a reference that steps by 42 ms every 42 ms produces 42 ms
   * of error out of nothing, and a correction chasing it is a correction of the
   * reference's own jitter.
   *
   * `requestVideoFrameCallback` hands over the presentation timestamp of the
   * frame it just put on screen, which is exact. {@link noteFramePresented}
   * records it; this extrapolates forward from it at the playback rate, so what
   * comes out is continuous rather than a staircase, and successive frames agree
   * with the extrapolation they replace instead of stepping past it.
   *
   * It is a *better* clock, never a second one to be caught between: a sample
   * older than a frame or two, or one that has stopped agreeing with the element
   * because something seeked underneath it, is dropped in favour of
   * {@link currentMs}. Reverse gets the element's clock outright — reverse is a
   * sequence of seeks, and there is nothing between them to extrapolate along.
   */
  get displayMs(): number {
    const element = this.currentMs;
    const presented = this.#framePresentedMs;
    if (presented === null) return element;

    const rate = this.signedRate;
    if (rate <= 0) return element;

    const age = performance.now() - this.#framePresentedAt;
    if (age < 0 || age > (1000 / this.#frameRate) * FRAME_TRUST_FRAMES) return element;

    const extrapolated = presented + age * rate;
    return Math.abs(extrapolated - element) > FRAME_AGREEMENT_MS ? element : extrapolated;
  }

  /**
   * Takes the presentation timestamp of the frame that has just been shown.
   *
   * Called from the frame callback in `instance.ts`, which is the only place the
   * metadata exists. Nothing else about the transport changes: this is a more
   * precise reading of a position it already had.
   */
  noteFramePresented(mediaSeconds: number): void {
    if (this.#destroyed || !Number.isFinite(mediaSeconds)) return;
    this.#framePresentedMs = mediaSeconds * 1000;
    this.#framePresentedAt = performance.now();
  }

  get durationMs(): number {
    const duration = this.#video.duration;
    return Number.isFinite(duration) && duration > 0 ? duration * 1000 : 0;
  }

  get playing(): boolean {
    return !this.#video.paused && !this.#video.ended;
  }

  get frameRate(): number {
    return this.#frameRate;
  }

  get frameRateIsAssumed(): boolean {
    return this.#frameRateAssumed;
  }

  /**
   * Takes the real frame rate once the container header has been read.
   *
   * The transport is built before the header is parsed, so it starts on
   * {@link ASSUMED_FRAME_RATE} and frame-steps at 25 fps for the moment or two
   * before the parse lands. That is the right trade — a tile that appears
   * immediately and steps at the file's own rate a beat later beats a tile that
   * waits for a parse to show a picture — but only if the correction actually
   * arrives, which is what this is for.
   *
   * A file that states no rate keeps the assumption, and keeps saying so: the
   * timecode readout drops its frame field rather than showing frames derived
   * from a guess.
   */
  setFrameRate(frameRate: number | undefined): void {
    if (!frameRate || frameRate <= 0) return;
    this.#frameRate = frameRate;
    this.#frameRateAssumed = false;
  }

  /** How much is downloaded, as a fraction, for the scrubber's buffered bar. */
  get bufferedFraction(): number {
    const duration = this.durationMs;
    if (duration <= 0) return 0;
    const ranges = this.#video.buffered;
    let furthest = 0;
    for (let index = 0; index < ranges.length; index += 1) {
      furthest = Math.max(furthest, ranges.end(index) * 1000);
    }
    return Math.min(1, furthest / duration);
  }

  // -------------------------------------------------------------------------
  // Play and pause
  // -------------------------------------------------------------------------

  play(): void {
    if (this.#destroyed) return;
    this.#stopShuttle();
    // `play()` returns a promise that rejects when the engine declines — an
    // autoplay policy, or a source it has given up on. Swallowing it silently
    // would leave a play button that does nothing and says nothing.
    void this.#video.play().catch((thrown: unknown) => {
      if (this.#destroyed) return;
      const reason = thrown instanceof Error ? thrown.message : String(thrown);
      this.#callbacks.onAnnounce(`playback could not start: ${reason}`, "warn");
      this.#callbacks.onChange();
    });
  }

  pause(): void {
    this.#stopShuttle();
    this.#video.pause();
  }

  toggle(): void {
    if (this.playing || this.#shuttle !== 0) this.pause();
    else this.play();
  }

  // -------------------------------------------------------------------------
  // Seeking
  // -------------------------------------------------------------------------

  /**
   * Moves the playhead, clamped to the media.
   *
   * Clamped rather than allowed to run past the end because seeking beyond the
   * duration fires `ended` on some engines and silently does nothing on others,
   * and a scrubber dragged to its right edge should land on the last frame in
   * both cases.
   */
  seekTo(milliseconds: number): void {
    if (this.#destroyed) return;
    const duration = this.durationMs;
    const bounded = Math.max(0, duration > 0 ? Math.min(milliseconds, duration - 1) : milliseconds);
    if (!Number.isFinite(bounded)) return;

    // A seek on a *paused* element is the blanking case: nothing is presenting
    // frames, so the engine paints its background until the target frame is
    // decoded, and a scrub or a chapter jump flashes black exactly the way
    // reverse used to. A seek while playing has no such gap. Skipped while
    // reversing because the hold is already up and sustained there — releasing
    // it once per step is what it exists to avoid.
    const cover = this.#video.paused && this.#shuttle !== -1;
    if (cover) this.#callbacks.onHoldFrame?.(true);
    this.#video.currentTime = bounded / 1000;
    // Released immediately: the release itself waits for the element to present
    // a frame before uncovering, so this is "stop holding once the picture is
    // back", not "stop holding now".
    if (cover) this.#callbacks.onHoldFrame?.(false);
    this.#callbacks.onChange();
  }

  seekBy(milliseconds: number): void {
    this.seekTo(this.currentMs + milliseconds);
  }

  /**
   * Moves exactly one frame.
   *
   * Pauses first, for the reason the image plugin's transport does: stepping
   * while playing puts the user on a frame that something else immediately
   * replaces. Half a frame is added before rounding so a step lands inside the
   * next frame's window rather than on its boundary, where floating-point
   * rounding can leave the playhead in the frame it started in and make the key
   * look broken.
   */
  stepFrame(direction: 1 | -1): void {
    this.pause();
    const frame = 1000 / this.#frameRate;
    // `seekTo` raises the hold itself for a paused seek, so a step is covered
    // without anything extra here — which is the point of putting the rule in
    // one place rather than at each call site that happens to blank.
    this.seekTo(this.currentMs + direction * frame + direction * 0.5);
  }

  // -------------------------------------------------------------------------
  // Speed
  // -------------------------------------------------------------------------

  get speed(): PlaybackSpeed {
    return this.#speed;
  }

  setSpeed(speed: PlaybackSpeed): void {
    this.#speed = speed;
    if (this.#shuttle === 0) this.#video.playbackRate = speed;
    this.#callbacks.onChange();
  }

  /** Steps through {@link PLAYBACK_SPEEDS}; `direction` chooses which way. */
  cycleSpeed(direction: 1 | -1 = 1): void {
    const at = PLAYBACK_SPEEDS.indexOf(this.#speed);
    const next = (at + direction + PLAYBACK_SPEEDS.length) % PLAYBACK_SPEEDS.length;
    this.setSpeed(PLAYBACK_SPEEDS[next]!);
    this.#callbacks.onAnnounce(`${PLAYBACK_SPEEDS[next]}× speed`);
  }

  /**
   * Steps through {@link QUICK_SPEEDS}: 1× → 1.5× → 2× → 1×.
   *
   * Defined as "the first quick speed above the current one, or back to 1×"
   * rather than as an index into the list, because the current speed need not be
   * in the list at all — `x` and the context menu can leave the transport at
   * 0.25× or 4×, and a chip that then did nothing, or wrapped to a speed slower
   * than the one showing, would look broken. From anywhere below 1× the first
   * press lands on 1×, which is also the thing someone stuck in slow motion is
   * most likely to want.
   */
  cycleQuickSpeed(): void {
    const next = QUICK_SPEEDS.find((speed) => speed > this.#speed) ?? QUICK_SPEEDS[0];
    this.setSpeed(next);
    this.#callbacks.onAnnounce(`${next}× speed`);
  }

  // -------------------------------------------------------------------------
  // Shuttle
  // -------------------------------------------------------------------------

  /** `-1` reversing, `0` off, `1` playing forward under `L`. */
  get shuttleRate(): ShuttleDirection {
    return this.#shuttle;
  }

  /**
   * Which way the playhead is going and how fast, as one signed number.
   *
   * `+speed` forward, `-speed` backwards, `0` stopped. The question "which way
   * and how fast" is asked by the progress bar, the speed chip and the rate
   * badge, and each of them was otherwise going to answer it by combining
   * {@link playing}, {@link shuttleRate} and {@link speed} for itself — three
   * copies of one rule, which is how a bar ends up gliding forwards over a film
   * that is running backwards.
   *
   * Reverse is deliberately *not* a special case here: it reports the speed it
   * is actually travelling at, because `#stepReverse` covers `elapsed × speed`
   * of film per step. Backwards at 2× is `-2`.
   */
  get signedRate(): number {
    if (this.#shuttle === -1) return -this.#speed;
    return this.playing ? this.#speed : 0;
  }

  /**
   * `L` and `J`.
   *
   * One rate each way and no ladder — see the note at the top of this file.
   * Pressing the key you are already going in stops; pressing the other turns
   * round. Two keys, four states, nothing hidden.
   */
  shuttle(direction: 1 | -1): void {
    this.#applyShuttle(this.#shuttle === direction ? 0 : direction);
  }

  /** `K`: stop shuttling and hold this frame. */
  stopShuttle(): void {
    this.#applyShuttle(0);
    this.#video.pause();
  }

  #applyShuttle(direction: ShuttleDirection): void {
    const wasReversing = this.#shuttle === -1;
    this.#shuttle = direction;
    // Anything in flight belongs to the state being left. Left alone, a seek
    // issued while reversing lands after the user has already pressed K and
    // drags the playhead somewhere they did not ask for.
    this.#cancelStep();
    // Leaving reverse: uncover, once there is a picture to uncover to.
    if (wasReversing && direction !== -1) this.#callbacks.onHoldFrame?.(false);

    if (direction === 1) {
      // Forward shuttle is simply playback. The engine paces its own frames and
      // keeps the audio, which is better than anything this file could do by
      // hand, and the speed control is there for anyone who wants it faster.
      this.#video.playbackRate = this.#speed;
      void this.#video.play().catch(() => {
        /* Reported by `play()`; a failed shuttle is not a second message. */
      });
    } else if (direction === -1) {
      this.#video.pause();
      this.#video.playbackRate = this.#speed;
      // Before the first seek, while the element still has a frame worth
      // keeping. Engaging after it would capture whatever the first flush left.
      this.#callbacks.onHoldFrame?.(true);
      // Start the clock now, so the first step measures from the moment the key
      // was pressed rather than from whatever the last tick's age happened to be.
      this.#stepAt = now();
      // Always from where the playhead actually is: carrying an anchor across a
      // spell of real playback would step from a position nothing has updated.
      this.#anchorMs = this.currentMs;
      this.#scheduleStep(MIN_STEP_MS);
    } else {
      this.#video.playbackRate = this.#speed;
    }

    this.#syncTicker();
    this.#callbacks.onChange();
  }

  #stopShuttle(): void {
    if (this.#shuttle === 0) return;
    const wasReversing = this.#shuttle === -1;
    this.#shuttle = 0;
    this.#cancelStep();
    if (wasReversing) this.#callbacks.onHoldFrame?.(false);
    this.#video.playbackRate = this.#speed;
    this.#syncTicker();
  }

  /**
   * One step of reverse.
   *
   * The three rules from the top of the file, each at the line that implements
   * it. What this does *not* do is as important: it never calls `fastSeek`, and
   * it never takes its next target from where the engine landed.
   */
  #stepReverse(): void {
    if (this.#shuttle !== -1 || this.#stepPending || this.#destroyed) return;

    const at = now();
    const elapsed = at - this.#stepAt;
    if (elapsed < MIN_STEP_MS) {
      // Come back when the floor has passed rather than dropping the step and
      // waiting for whenever the ticker next happens to fire.
      this.#scheduleStep(MIN_STEP_MS - elapsed);
      return;
    }

    // Rule 3. Distance from elapsed time *and the speed*, so reverse runs at
    // the rate the indicator claims rather than always at 1× — the speed
    // control used to apply to forward playback only, which left `0.5×` on
    // screen over a picture running backwards at full rate.
    const frame = 1000 / this.#frameRate;
    const wanted = elapsed * this.#speed;
    if (wanted < frame) {
      // Slower than one frame per step is *waiting longer*, not travelling
      // less: a floor of one frame would make every speed below 1× run at the
      // same rate as 1×, which is the whole of slow-motion reverse not working.
      // `#stepAt` is deliberately not advanced, so the wait accumulates.
      this.#scheduleStep(Math.max(MIN_STEP_MS, frame / this.#speed - elapsed));
      return;
    }
    this.#stepAt = at;

    // Capped so a stall becomes a slow step rather than a jump; quantized to
    // whole frames so two consecutive steps cannot decode the same picture and
    // read as a freeze.
    const travel = Math.min(wanted, MAX_STEP_MS);
    const target = Math.round((this.#anchorMs - travel) / frame) * frame;

    if (target <= 0) {
      this.#anchorMs = 0;
      this.seekTo(0);
      this.#applyShuttle(0);
      this.#callbacks.onAnnounce("at the start");
      return;
    }

    // Rule 2, the half that is bookkeeping: the anchor moves to what was
    // *asked for*, not to what the engine reports afterwards. A landing that
    // overshoots forwards therefore cannot pull the next target forwards with
    // it, which is what let the old version oscillate.
    this.#anchorMs = target;
    this.#beginStep(at);

    try {
      // Rule 2, the half that is the seek: exact, never `fastSeek`. Keyframe
      // snapping is free and points the wrong way — it lands on the nearest
      // keyframe, routinely ahead of the target, which under reverse is a
      // visible jerk forwards between every pair of backward steps.
      this.#video.currentTime = target / 1000;
    } catch {
      this.#releaseStep();
    }
  }

  /**
   * Arms the wait for this step's frame to reach the screen.
   *
   * Rule 1. Three things can release it and the earliest wins:
   *
   *   - `requestVideoFrameCallback`, which fires when a frame has actually been
   *     *presented*. This is the one that makes reverse look smooth, and it is
   *     used by calling it rather than by asking whether it exists — a call that
   *     throws or never fires costs nothing, because the other two still run
   *     (AGENTS.md: probe a capability by using it and measuring the result).
   *   - `seeked` plus {@link PRESENT_GRACE_MS}, which is the fallback for
   *     engines with no frame callback *and* the escape hatch for a window that
   *     has one and is not being composited, where a presentation never comes.
   *   - the deadline, for an engine that says nothing at all.
   */
  #beginStep(at: number): void {
    this.#stepPending = true;
    this.#stepDeadline = at + STEP_DEADLINE_MS;

    const element = this.#video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    try {
      this.#frameCallback =
        element.requestVideoFrameCallback?.(() => {
          this.#frameCallback = null;
          this.#releaseStep();
        }) ?? null;
    } catch {
      this.#frameCallback = null;
    }
  }

  /** This step's frame arrived (or its grace ran out). The next one may go. */
  #releaseStep(): void {
    if (this.#graceTimer !== null) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
    this.#stepPending = false;
    this.#scheduleStep(0);
  }

  /**
   * Queues the next reverse step.
   *
   * Reverse drives itself: each step schedules the next as soon as its frame is
   * on screen, so the loop runs as fast as the decoder can actually answer. The
   * ticker is only a backstop for a step that got no answer at all.
   *
   * Pacing reverse *from* the ticker was the mistake this replaces. It capped
   * every step at the next 50 ms boundary even when the seek came back in 10,
   * and — measured in a window that was not being composited, where the engine
   * throttles timers — the interval fired every ~350 ms, so reverse ran at
   * roughly half speed for reasons that had nothing to do with the video.
   */
  #scheduleStep(delay: number): void {
    if (this.#shuttle !== -1 || this.#destroyed || this.#stepTimer !== null) return;
    this.#stepTimer = setTimeout(() => {
      this.#stepTimer = null;
      this.#stepReverse();
    }, delay);
  }

  /**
   * Drops a step in flight, so its late arrival cannot move anything.
   *
   * `#stepAt` is deliberately left alone: on the deadline path it is what the
   * next step measures its distance from, and zeroing it here would make a
   * decoder that missed one frame look like one that had been stopped for
   * minutes.
   */
  #cancelStep(): void {
    this.#stepPending = false;
    if (this.#graceTimer !== null) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
    if (this.#stepTimer !== null) {
      clearTimeout(this.#stepTimer);
      this.#stepTimer = null;
    }
    if (this.#frameCallback !== null) {
      const element = this.#video as HTMLVideoElement & {
        cancelVideoFrameCallback?: (handle: number) => void;
      };
      try {
        element.cancelVideoFrameCallback?.(this.#frameCallback);
      } catch {
        /* Nothing to undo; the callback checks the state it runs in. */
      }
      this.#frameCallback = null;
    }
  }

  #onSeeked = (): void => {
    // Only a release, never a re-anchor. Where the engine landed is information
    // about the past; the next target comes from what was asked for.
    if (this.#shuttle !== -1 || !this.#stepPending) return;

    // No frame callback outstanding: `seeked` is the only signal there is.
    if (this.#frameCallback === null) {
      this.#releaseStep();
      return;
    }

    // One is outstanding, so give the compositor its moment — but only a
    // moment. If the window is not on screen the frame is never presented and
    // this is the timer that keeps reverse moving anyway.
    this.#graceTimer ??= setTimeout(() => {
      this.#graceTimer = null;
      this.#releaseStep();
    }, PRESENT_GRACE_MS);
  };

  // -------------------------------------------------------------------------
  // A/B loop
  // -------------------------------------------------------------------------

  get loopIn(): number | null {
    return this.#loopIn;
  }

  get loopOut(): number | null {
    return this.#loopOut;
  }

  get looping(): boolean {
    return this.#looping;
  }

  /** The active range, or `null` when the loop is not set up and running. */
  get loopRange(): LoopRange | null {
    if (!this.#looping || this.#loopIn === null || this.#loopOut === null) return null;
    return { inMs: this.#loopIn, outMs: this.#loopOut };
  }

  /**
   * One key, three states: set the in point, set the out point and start
   * looping, clear.
   *
   * The consolidation AGENTS.md keeps describing — three toggles folded into one
   * rotation — applied to the shape this feature actually has. Setting in, then
   * out, then clearing is the whole life cycle of a review loop, in that order,
   * every time. Three separate bindings would be three chips in the reference
   * modal to describe one gesture.
   */
  cycleLoop(): void {
    if (this.#loopIn === null) {
      this.#loopIn = this.currentMs;
      this.#callbacks.onAnnounce(`loop in at ${formatTimecode(this.#loopIn)} — press again to set the out point`);
    } else if (this.#loopOut === null) {
      const out = this.currentMs;
      if (out <= this.#loopIn + 100) {
        // A loop shorter than a tick cannot be watched and would pin the
        // playhead. Saying so beats accepting it and appearing to freeze.
        this.#callbacks.onAnnounce("the out point must be after the in point", "warn");
        return;
      }
      this.#loopOut = out;
      this.#looping = true;
      this.#callbacks.onAnnounce(
        `looping ${formatTimecode(this.#loopIn)} to ${formatTimecode(out)}`,
      );
    } else {
      this.clearLoop();
      return;
    }
    this.#syncTicker();
    this.#callbacks.onChange();
  }

  clearLoop(): void {
    this.#loopIn = null;
    this.#loopOut = null;
    this.#looping = false;
    this.#syncTicker();
    this.#callbacks.onAnnounce("loop cleared");
    this.#callbacks.onChange();
  }

  /** Restores a loop from serialized state, without announcing it. */
  restoreLoop(loop: LoopRange | null): void {
    if (!loop || !(loop.outMs > loop.inMs)) {
      this.#loopIn = null;
      this.#loopOut = null;
      this.#looping = false;
    } else {
      this.#loopIn = loop.inMs;
      this.#loopOut = loop.outMs;
      this.#looping = true;
    }
    this.#syncTicker();
    this.#callbacks.onChange();
  }

  // -------------------------------------------------------------------------
  // The ticker
  // -------------------------------------------------------------------------

  /** Runs only while something needs servicing, and stops again afterwards. */
  #syncTicker(): void {
    // Forward shuttle is ordinary playback and needs no servicing at all, which
    // is most of why removing the ladder made this cheaper as well as smoother.
    const needed = this.#looping || this.#shuttle === -1;
    if (needed && !this.#ticker && !this.#destroyed) {
      this.#ticker = setInterval(() => this.#tick(), TICK_MS);
    } else if (!needed && this.#ticker) {
      clearInterval(this.#ticker);
      this.#ticker = null;
    }
  }

  #tick(): void {
    if (this.#destroyed) return;

    if (this.#shuttle === -1) {
      // A frame that never arrived must not strand reverse forever.
      if (this.#stepPending && now() > this.#stepDeadline) this.#cancelStep();
      this.#stepReverse();
    }

    if (this.#looping && this.#loopIn !== null && this.#loopOut !== null) {
      const at = this.currentMs;
      // Both ends are enforced. Running past the out point is the obvious case;
      // landing *before* the in point matters too, because a scrubber drag or a
      // chapter jump can put the playhead outside a loop the user still has set,
      // and silently leaving the loop inactive would look like it had been
      // cleared.
      if (at >= this.#loopOut || at < this.#loopIn - TICK_MS) {
        this.seekTo(this.#loopIn);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  destroy(): void {
    this.#destroyed = true;
    this.#abort.abort();
    // Before the element goes: a frame callback outliving its transport would
    // run against a disposed instance.
    this.#cancelStep();
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = null;
  }
}

/**
 * `1:23`, `1:02:03`, `0:04.5`.
 *
 * Hours appear only when there are hours, and tenths only below a minute —
 * where a review tool's user is counting frames and a whole-second readout is
 * not enough to tell two of them apart.
 */
export function formatTimecode(milliseconds: number, options?: { frames?: number }): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "0:00";
  const total = milliseconds / 1000;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);

  const pad = (value: number): string => String(value).padStart(2, "0");

  if (options?.frames) {
    // Frame-accurate form, for the toolbar readout of a file whose rate is
    // known: `1:23:04:11`, the convention every review tool uses.
    const frame = Math.floor(((milliseconds % 1000) / 1000) * options.frames);
    const stem = hours > 0 ? `${hours}:${pad(minutes)}` : `${minutes}`;
    return `${stem}:${pad(seconds)}:${pad(frame)}`;
  }

  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  if (total < 60) return `${minutes}:${pad(seconds)}.${Math.floor((milliseconds % 1000) / 100)}`;
  return `${minutes}:${pad(seconds)}`;
}
