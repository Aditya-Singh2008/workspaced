/**
 * The progress bar's motion, put on the media's own timeline.
 *
 * The timeline used to be drawn the obvious way: every render tick, write the
 * played fraction as a percentage width and the marker's position as a
 * percentage offset. That is a *sampled* bar, and it looks like one. Between two
 * samples it does not move at all, so the eye sees a row of small jumps rather
 * than a bar sliding — ten a second when the frame callback is missing, and
 * fewer than that whenever the main thread is busy decoding, which for a video
 * player is always. Turning the tick rate up does not fix it; it makes the same
 * stepping cost more, and every extra sample is a layout write over a decoding
 * video.
 *
 * ## An animation is not a smoother tick, it is a different mechanism
 *
 * The fix is to stop sampling. A film has a length and a rate, so where the bar
 * should be at any instant is a *function of time*, not a value that has to be
 * pushed. The Web Animations API expresses exactly that: one animation per
 * element, `duration` set to the film's duration, `linear`, and then
 *
 *   - `currentTime` **is** the playhead, in milliseconds;
 *   - `playbackRate` **is** the speed, signed, so `-2` runs the bar backwards at
 *     2× and needs no separate code path for reverse;
 *   - `pause()` is a stopped transport.
 *
 * The compositor interpolates between whatever this class last said, so the bar
 * keeps gliding through a tick that arrived late, through a frame the decoder
 * dropped, and through a garbage collection. Nothing in the steady state costs a
 * main-thread write at all: a film playing forward at 1× for two hours needs one
 * `play()` and a drift check that usually does nothing.
 *
 * ## Both halves have to be on the compositor, and only one of them was
 *
 * Both animated properties are `transform`s because `width` and `left` are
 * layout, and animating layout sixty times a second over a decoding video is the
 * cost this module exists to remove. But being a `transform` is not sufficient.
 * A transform whose value **depends on the box size** — which a percentage
 * translation does, since it resolves against the element's own width — is the
 * classic disqualifier for handing an animation to the compositor, because the
 * compositor would have to be told about a box that layout may change underneath
 * it. Engines differ in how much of that they will still accept, and this app
 * ships on more than one of them (webkit2gtk on Linux, WebView2 on Windows), so
 * the marker was animated `translateX(0%) → translateX(100%)` and *may or may
 * not* have been accelerated depending on where it was running.
 *
 * That is the part worth fixing even more than the stepping itself: the fill's
 * unitless `scaleX` is accelerated everywhere, so wherever the marker was not,
 * the two halves of one bar ran on two different clocks — one on the compositor
 * and one on the main thread, the one busy decoding video. Under load the handle
 * stepped along behind the fill's leading edge, which is visible precisely when
 * the pointer is on the track and the user is looking closely at it.
 *
 * So the marker's keyframes are in **pixels**, which is why this class has to be
 * told the track's width ({@link ProgressGlide.setTrackWidth}) and to rebuild
 * that one animation when it changes. The marker is as wide as the track, so
 * translating it by the track's width lands exactly where `100%` did — the
 * geometry is unchanged, only whether a compositor will take it, and now it does
 * not depend on which engine is asking. The fill needs no such thing: `scaleX`
 * is unitless and a resize costs it nothing, which is also why a divider drag
 * never rebuilds the half of the bar that is always on screen.
 *
 * ## Why not `requestAnimationFrame`
 *
 * The rule AGENTS.md records for this app: a window that is not being composited
 * never gets a frame, so anything paced by `rAF` silently stops in a tile behind
 * another window. It is the same reason `transport.ts` uses `setInterval` for
 * the A/B loop. An animation has no such problem — it is driven by the document
 * timeline rather than by frames, and a bar that is not on screen simply is not
 * drawn, which is the correct amount of work rather than a stall.
 *
 * ## Drift, and why correcting it is not a jump
 *
 * The animation's clock and the media's clock are two clocks, and they disagree:
 * the decoder stalls on a slow read, the engine rounds a seek to a keyframe
 * boundary, reverse moves the playhead in steps rather than continuously, and
 * the audio clock the film is actually slaved to runs a fraction of a percent
 * off the document timeline. The media is the authority and this is a *display*
 * of it, so {@link ProgressGlide.sync} compares the two on every render tick.
 *
 * What it must not do is *write the position*. A position write is a teleport,
 * and a teleport is the stepping this module exists to remove, reintroduced once
 * every time the error creeps past a threshold. So there are three bands rather
 * than one:
 *
 *   - **Below {@link deadband}, nothing happens.** The threshold is derived from
 *     the track's width, because a millisecond of error is not a fixed amount of
 *     *visible* error: half a pixel is 4.5 seconds of a two-hour film and 19
 *     milliseconds of a thirty-second clip. The old fixed 120 ms meant two
 *     completely different things at those two durations — invisible at one end,
 *     a four-pixel lurch at the other.
 *   - **Up to {@link SEEK_JUMP_MS}, the bar changes speed instead.** The error
 *     is fed into the playback rate, so the bar runs a few percent fast or slow
 *     until it has caught up and then returns to nominal. Nothing on screen
 *     moves discontinuously; it is a clock being disciplined rather than reset.
 *   - **Past it, the position is written.** An error that large is not drift —
 *     it is a seek, a loop wrap or a chapter jump — and those *are* jumps. A bar
 *     that eased into a seek would read as lag. The threshold is in milliseconds
 *     and not in pixels on purpose: what counts as a deliberate jump is a
 *     property of the media, where what counts as visible is a property of the
 *     track.
 *
 * On a long enough film the deadband is wider than the seek threshold and the
 * middle band closes up, which is correct: at half a pixel per 4.5 seconds there
 * is nothing to converge towards, and the only corrections left are real seeks.
 *
 * ## It is allowed not to work
 *
 * A file with no duration — a live stream, a container the engine has not parsed
 * far enough — has no timeline to animate along, a track that has not been laid
 * out yet has no width to animate across, and an engine without `element.animate`
 * has nothing to animate with. All three leave {@link ProgressGlide.active}
 * false, and `engine/scrubber.ts` falls back to the percentage writes it used
 * before. Probed by *calling* it and checking the result rather than by testing
 * for the property, per AGENTS.md.
 */

/**
 * How much visible error is worth correcting, in pixels of track.
 *
 * Half a pixel: the point at which a correction could begin to show as anything
 * at all. Converted to milliseconds against the film's duration by
 * {@link ProgressGlide.thresholds}, which is the whole reason this is expressed
 * in pixels — see the module comment.
 */
const DEADBAND_PX = 0.5;

/**
 * A floor under the deadband: one frame, at the rates films are actually shot
 * at.
 *
 * Below a frame the reference has nothing to say. `Transport.displayMs` is
 * exact while the frame callback is running, but when it falls back to the
 * element's own clock that clock is quantised to the frame on screen, and an
 * error smaller than one step of the thing you are measuring against is noise.
 * Correcting noise is how a servo starts hunting — the bar breathing a few
 * percent either side of nominal forever — which would be a worse artefact than
 * the error it was chasing, since a constant offset of less than a frame is not
 * something the eye can see and a wobble is.
 */
const MIN_DEADBAND_MS = 40;

/**
 * The line between drift and a jump.
 *
 * Comfortably larger than any error the two clocks produce on their own — a
 * stalled decode, a reverse step, a tick that arrived late — and comfortably
 * smaller than the shortest jump anything in the player asks for, which is a
 * frame-step's neighbour at the low end and a loop wrap or chapter seek above
 * it. Errors below it are disciplined by rate; errors above it are obeyed.
 */
const SEEK_JUMP_MS = 320;

/**
 * Roughly how long the bar takes to absorb an error it is correcting by rate.
 *
 * Long enough that the speed change is not itself visible as a lurch, short
 * enough that the bar is not lying about where the film is for any length of
 * time. Errors big enough that this would need more speed than {@link MAX_TRIM}
 * allows simply take proportionally longer.
 */
const CONVERGE_MS = 500;

/**
 * The most the bar's speed may be bent, as a fraction of its nominal rate.
 *
 * A quarter is far more than steady-state drift ever needs and is still slow
 * enough not to read as the bar racing. Expressed against the nominal rate
 * rather than as an absolute so a film at 2× gets proportionally more authority
 * to correct, and so the trim can never flip the bar's direction.
 */
const MAX_TRIM = 0.25;

/** Below this, rewriting `playbackRate` would cost a commit to say nothing. */
const RATE_EPSILON = 0.004;

/** Below this, rewriting `currentTime` on a parked bar would say nothing. */
const PARK_EPSILON_MS = 1;

export interface GlideState {
  /** Where the media says the playhead is. */
  readonly currentMs: number;
  /** Signed: `+speed` playing forward, `-speed` reversing, `0` stopped. */
  readonly rate: number;
  /** Whether the bar is on screen. A hidden bar is frozen rather than driven. */
  readonly visible: boolean;
}

/** Which of the two moving parts a leg drives. They are rebuilt separately. */
type LegKind = "fill" | "marker";

interface Leg {
  readonly kind: LegKind;
  readonly element: HTMLElement;
  animation: Animation;
}

export class ProgressGlide {
  #fill: HTMLElement;
  #marker: HTMLElement;
  /** Empty when this is inactive, which is the whole of the fallback signal. */
  #legs: Leg[] = [];
  #durationMs = 0;
  #trackWidthPx = 0;
  /** The rate the transport asked for, before any correction is mixed in. */
  #rate = 0;
  /** What was last written to `playbackRate`: the nominal rate plus its trim. */
  #appliedRate = 0;
  #running = false;
  #destroyed = false;

  constructor(options: {
    /** Scaled along its x-axis, from empty to full. */
    fill: HTMLElement;
    /** A full-width positioner, translated across the track's own width. */
    marker: HTMLElement;
  }) {
    this.#fill = options.fill;
    this.#marker = options.marker;
  }

  /** Whether the bar is being animated, or the caller must draw it by hand. */
  get active(): boolean {
    return this.#legs.length > 0;
  }

  /**
   * Where the bar is, in milliseconds of film, or `null` when inactive.
   *
   * Read from the animation rather than from a field this class also keeps, so
   * what it reports is what is on screen — including the drift a caller is about
   * to correct.
   */
  get positionMs(): number | null {
    const leg = this.#legs[0];
    return leg ? readMs(leg.animation.currentTime) : null;
  }

  /**
   * The rate the bar is travelling at: signed, and `0` when it is not moving.
   *
   * The *nominal* rate — what the transport asked for — and deliberately not
   * what is currently written to `playbackRate`, which carries a correction
   * trim that is this class's own business. Callers use the sign of this to
   * decide that the film is running backwards; a bar a few percent off while it
   * absorbs an error has not changed direction and must not look as though it
   * has.
   */
  get rate(): number {
    return this.#running ? this.#rate : 0;
  }

  /**
   * Takes the film's length, and builds the animations that span it.
   *
   * Called whenever the duration changes, which is once for a local file — it
   * arrives with the metadata, after the tile is already on screen — and
   * occasionally more for a stream that revises its estimate. Rebuilding is the
   * only option: an animation's duration is fixed at creation, and scaling the
   * playback rate to fake a longer one would put the bar's arithmetic somewhere
   * other than where its position is read from.
   */
  setDuration(durationMs: number): void {
    if (this.#destroyed) return;
    const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    if (duration === this.#durationMs) return;

    this.#durationMs = duration;
    // Both: the fill's keyframes do not mention the duration, but the duration
    // is the animation's own length and that is fixed at creation.
    this.#rebuild(["fill", "marker"]);
  }

  /**
   * Takes the track's width, which is what the marker's keyframes are drawn in.
   *
   * Fed by a `ResizeObserver` in `engine/scrubber.ts`. Rounded to whole pixels
   * and compared before anything happens, because a tile being resized by a
   * divider drag reports a new width on every frame of the drag and rebuilding
   * an animation per frame is exactly the main-thread cost this module exists to
   * avoid. A width of zero — a tile that has not been laid out — leaves the bar
   * inactive and in the caller's hands, which is the same honest fallback as a
   * film with no duration.
   */
  setTrackWidth(widthPx: number): void {
    if (this.#destroyed) return;
    const width = Number.isFinite(widthPx) && widthPx > 0 ? Math.round(widthPx) : 0;
    if (width === this.#trackWidthPx) return;

    this.#trackWidthPx = width;
    // Only the marker measures the track. The fill is a unitless `scaleX` and a
    // resize means nothing to it, so the half of the bar that is always on
    // screen is never rebuilt by a drag.
    this.#rebuild(["marker"]);
  }

  /**
   * Points the animations at the transport, as cheaply as possible.
   *
   * Called on every render tick — several times a second while anything is
   * moving — so the fast path is two comparisons and no DOM work at all.
   */
  sync(state: GlideState): void {
    if (this.#destroyed || this.#legs.length === 0) return;

    // A bar nobody can see is frozen where it stands and then left alone —
    // *including* its position, which is the point. The chrome is hidden for most
    // of a film's life (`engine/view.ts`), and a hidden bar whose `currentTime`
    // is corrected on every tick is the ten style writes a second over a
    // decoding video that this whole module exists to remove. It is put back
    // where it belongs by the drift check below, in the first tick after it
    // returns.
    if (!state.visible) {
      if (this.#rate !== 0) {
        this.#rate = 0;
        this.#setRunning(false);
      }
      return;
    }

    const rate = state.rate;
    if (rate !== this.#rate) {
      this.#rate = rate;
      // Rate `0` is expressed by pausing rather than by a zero playback rate:
      // the two look identical and only one of them lets the animation be
      // resumed at a rate it remembers.
      if (rate !== 0) this.#writeRate(rate);
      this.#setRunning(rate !== 0);
    }

    const wanted = Math.min(Math.max(state.currentMs, 0), this.#durationMs);
    const at = this.positionMs;

    // Stopped: where it is told is the only information there is, so it goes
    // exactly there — but only when that is somewhere it is not already. A
    // paused film with the chrome up used to rewrite both animations on every
    // tick, forever, to say the same number.
    if (rate === 0 || at === null) {
      if (at === null || Math.abs(at - wanted) >= PARK_EPSILON_MS) this.#writePosition(wanted);
      return;
    }

    const error = wanted - at;
    const magnitude = Math.abs(error);
    const { deadband } = this.thresholds;

    if (magnitude <= deadband) {
      // Nothing worth showing. Drop any trim still left over from an error that
      // has now been absorbed, and otherwise touch nothing at all: this is the
      // steady state, and it is meant to cost two comparisons.
      this.#writeRate(rate);
      return;
    }

    if (magnitude > SEEK_JUMP_MS) {
      // A seek, a loop wrap or a chapter jump. Obeyed, and any correction in
      // flight is abandoned along with the position it was correcting towards.
      this.#writePosition(wanted);
      this.#writeRate(rate);
      return;
    }

    // Drift. Bend the speed towards the media instead of jumping to it: `error`
    // is signed, so a bar that is behind speeds up and a bar that is ahead slows
    // down, and on a film running backwards — where `rate` is negative — the same
    // arithmetic reverses less quickly, which is the same correction.
    const limit = Math.abs(rate) * MAX_TRIM;
    const trim = Math.min(Math.max(error / CONVERGE_MS, -limit), limit);
    this.#writeRate(rate + trim);
  }

  /**
   * What counts as error worth correcting, and what counts as a jump.
   *
   * Exposed because it is the part worth asserting on in a self-test: that the
   * deadband is a function of the track rather than a constant is the whole of
   * the change, and it is invisible from the outside otherwise.
   */
  get thresholds(): { deadband: number; seekJump: number } {
    const msPerPx = this.#trackWidthPx > 0 ? this.#durationMs / this.#trackWidthPx : 0;
    return {
      deadband: Math.max(msPerPx * DEADBAND_PX, MIN_DEADBAND_MS),
      seekJump: SEEK_JUMP_MS,
    };
  }

  destroy(): void {
    this.#destroyed = true;
    this.#stop();
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  /**
   * Rebuilds the named legs, carrying the bar's motion across unchanged.
   *
   * Position, rate and whether it is running are read off what is there, and
   * written back onto what replaces it, so a rebuild is not something the eye
   * can find — which matters most for {@link setTrackWidth}, where a rebuild
   * happens during a divider drag over a film that is playing.
   *
   * Half a bar is never left behind: if either animation cannot be made, the
   * whole thing goes inactive and the caller draws both parts by hand. A fill
   * that glides away from a marker that steps is worse than the honest fallback.
   */
  #rebuild(kinds: readonly LegKind[]): void {
    if (this.#destroyed) return;
    if (this.#durationMs <= 0 || this.#trackWidthPx <= 0) {
      this.#stop();
      return;
    }

    const position = this.positionMs ?? 0;
    const appliedRate = this.#appliedRate;
    const running = this.#running;

    // A leg that has never been built has to be built whatever was asked for.
    const wanted = new Set<LegKind>(kinds);
    for (const kind of ["fill", "marker"] as const) {
      if (!this.#legs.some((leg) => leg.kind === kind)) wanted.add(kind);
    }

    const built = new Map<LegKind, Leg>();
    for (const kind of wanted) {
      const leg = this.#buildLeg(kind);
      if (!leg) {
        for (const made of built.values()) discard(made.animation);
        this.#stop();
        return;
      }
      built.set(kind, leg);
    }

    for (const leg of this.#legs) {
      if (wanted.has(leg.kind)) discard(leg.animation);
    }
    // Rebuilt in a fixed order rather than in whatever order they were replaced,
    // so `positionMs` always reads the fill — the half that is always on screen
    // and is never rebuilt by a resize.
    this.#legs = (["fill", "marker"] as const).flatMap((kind) => {
      const leg = built.get(kind) ?? this.#legs.find((existing) => existing.kind === kind);
      return leg ? [leg] : [];
    });

    // Only the new legs need catching up; the survivors are already running at
    // the right rate and would gain nothing but a spurious `play()` from being
    // told again. `play()` on a *finished* animation rewinds it to the start —
    // the specification's auto-rewind, which is right for a UI animation and
    // wrong for a playhead — so the position is written last, after everything
    // that could trigger it and before this task yields to a paint.
    const restoreRate = appliedRate || 1;
    for (const leg of built.values()) {
      leg.animation.playbackRate = restoreRate;
      if (running) leg.animation.play();
      else leg.animation.pause();
    }
    this.#appliedRate = restoreRate;
    this.#running = running;
    this.#writePosition(position);
  }

  /**
   * One leg, or `null` if this engine will not make one.
   *
   * `fill: "both"` so the bar holds its position when the animation is paused,
   * finished, or has not started — without it a paused animation reverts to the
   * element's own style and the bar snaps to empty every time the film stops.
   */
  #buildLeg(kind: LegKind): Leg | null {
    const element = kind === "fill" ? this.#fill : this.#marker;
    const keyframes: Keyframe[] =
      kind === "fill"
        ? [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }]
        : // Pixels, not `100%`. See the module comment: a percentage translation
          // depends on the box size, and a transform that depends on the box
          // size does not go to the compositor.
          [{ transform: "translateX(0px)" }, { transform: `translateX(${this.#trackWidthPx}px)` }];

    const animate = (element as HTMLElement & { animate?: HTMLElement["animate"] }).animate;
    if (typeof animate !== "function") return null;
    try {
      const animation = element.animate(keyframes, {
        duration: this.#durationMs,
        easing: "linear",
        fill: "both",
      });
      // Created running, and there is nothing to run yet: the caller starts it
      // when the transport says something is moving.
      animation.pause();
      animation.currentTime = 0;
      return { kind, element, animation };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /** The nominal rate plus whatever trim is being applied, written once. */
  #writeRate(value: number): void {
    if (Math.abs(value - this.#appliedRate) < RATE_EPSILON) return;
    this.#appliedRate = value;
    // Assigning `playbackRate` preserves `currentTime` — the specification
    // recomputes `startTime` around it — so a speed change is not also a jump.
    for (const leg of this.#legs) leg.animation.playbackRate = value;
  }

  #writePosition(milliseconds: number): void {
    for (const leg of this.#legs) leg.animation.currentTime = milliseconds;
  }

  #setRunning(running: boolean): void {
    if (running === this.#running) return;
    this.#running = running;
    for (const leg of this.#legs) {
      // See `#rebuild` on auto-rewind. It is harmless here only because `sync`
      // writes `currentTime` immediately afterwards, in the same task, before
      // anything is painted. Moving that write is what would make the end of a
      // film flash back to zero.
      if (running) leg.animation.play();
      else leg.animation.pause();
    }
  }

  /** Everything off: no legs, no motion, and the caller draws the bar itself. */
  #stop(): void {
    for (const leg of this.#legs) discard(leg.animation);
    this.#legs = [];
    this.#rate = 0;
    this.#appliedRate = 0;
    this.#running = false;
  }
}

function discard(animation: Animation): void {
  try {
    animation.cancel();
  } catch {
    /* Already finished or detached; there is nothing to undo. */
  }
}

/**
 * An animation's time in milliseconds.
 *
 * `Animation.currentTime` is typed `CSSNumberish` — a number for a document
 * timeline, and a `CSSUnitValue` only for the scroll timelines this code does
 * not use. Coerced rather than asserted, because an assertion here would be a
 * lie that surfaces as a bar that never corrects its drift.
 */
function readMs(value: CSSNumberish | null): number | null {
  if (typeof value === "number") return value;
  if (value && typeof (value as CSSUnitValue).value === "number") {
    return (value as CSSUnitValue).value;
  }
  return null;
}
