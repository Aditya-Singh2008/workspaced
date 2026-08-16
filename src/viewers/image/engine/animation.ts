/**
 * Transport for animated images: play, pause, step, speed.
 *
 * The phase brief asks for these to use "the same transport-control conventions
 * the video plugin (Phase 4b) uses, so the interaction feels familiar across
 * both plugins even though they are independent implementations". So the shape
 * here is deliberately the shape a video transport has — a playing flag, a
 * current position, a speed multiplier, a step in either direction — rather than
 * a GIF-specific animator. Phase 4b implements the same verbs over a `<video>`
 * element and the two never share code, which is the contract's whole point.
 *
 * ## Scheduled with `setTimeout`, not `requestAnimationFrame`
 *
 * The usual advice is the opposite, and it is wrong here for two reasons.
 *
 * Frame timing in these formats is *per frame* and irregular — a GIF frame can
 * be shown for 20ms or for four seconds — so a display-rate callback would have
 * to keep its own accumulator and compare timestamps, which is a clock
 * reimplemented on top of a clock.
 *
 * More importantly, AGENTS.md records that `requestAnimationFrame` never fires
 * while the window is not being composited. For a *render* that is correct
 * behaviour and phase 03 relied on it. For a transport it would mean an
 * animation that silently stops when the window is occluded and resumes from
 * where it left off — and, worse, a frame-step that never completes, because
 * stepping is a one-shot advance that would sit forever waiting for a frame that
 * is not coming. `setTimeout` keeps running, and what it schedules is a canvas
 * draw that costs nothing when nobody is looking.
 */

/** Playback speeds, and the order the cycle visits them. */
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export interface TransportOptions {
  readonly frameCount: number;
  /** How long frame `index` is shown, before the speed multiplier. */
  delayAt(index: number): number;
  /** `0` means loop forever, which is what most animated files ask for. */
  readonly loopCount: number;
  /** Show this frame. The only thing the transport does to the outside world. */
  onFrame(index: number): void;
  /** Playing, position or speed changed — republish the toolbar. */
  onChange(): void;
}

export class AnimationTransport {
  #options: TransportOptions;
  #index = 0;
  #playing = false;
  #speed: PlaybackSpeed = 1;
  #lap = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #destroyed = false;

  constructor(options: TransportOptions) {
    this.#options = options;
  }

  get frameCount(): number {
    return this.#options.frameCount;
  }

  get index(): number {
    return this.#index;
  }

  get playing(): boolean {
    return this.#playing;
  }

  get speed(): PlaybackSpeed {
    return this.#speed;
  }

  /** Total run time at 1×, in milliseconds. For the readout. */
  get durationMs(): number {
    let total = 0;
    for (let index = 0; index < this.#options.frameCount; index += 1) {
      total += this.#options.delayAt(index);
    }
    return total;
  }

  play(): void {
    if (this.#destroyed || this.#playing || this.#options.frameCount < 2) return;
    this.#playing = true;
    this.#schedule();
    this.#options.onChange();
  }

  pause(): void {
    if (!this.#playing) return;
    this.#playing = false;
    this.#clear();
    this.#options.onChange();
  }

  toggle(): void {
    if (this.#playing) this.pause();
    else this.play();
  }

  /**
   * Moves one frame in either direction, and stops playback.
   *
   * Stepping while playing would put the transport in a state where the user
   * has asked for a specific frame and something else immediately replaces it,
   * which is the behaviour of every media player worth copying.
   */
  step(direction: 1 | -1): void {
    this.pause();
    const count = this.#options.frameCount;
    this.seek((((this.#index + direction) % count) + count) % count);
  }

  seek(index: number): void {
    if (this.#destroyed) return;
    const bounded = Math.min(Math.max(0, Math.round(index)), this.#options.frameCount - 1);
    if (bounded === this.#index) return;
    this.#index = bounded;
    this.#options.onFrame(bounded);
    this.#options.onChange();
    if (this.#playing) this.#schedule();
  }

  setSpeed(speed: PlaybackSpeed): void {
    if (this.#speed === speed) return;
    this.#speed = speed;
    // Re-scheduled from now rather than adjusting the pending timer: the change
    // should be felt on the next frame, not after the current one finishes at
    // the old rate.
    if (this.#playing) this.#schedule();
    this.#options.onChange();
  }

  cycleSpeed(): void {
    const at = PLAYBACK_SPEEDS.indexOf(this.#speed);
    this.setSpeed(PLAYBACK_SPEEDS[(at + 1) % PLAYBACK_SPEEDS.length]!);
  }

  #schedule(): void {
    this.#clear();
    const delay = Math.max(10, this.#options.delayAt(this.#index) / this.#speed);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#playing || this.#destroyed) return;

      const next = this.#index + 1;
      if (next >= this.#options.frameCount) {
        this.#lap += 1;
        // A finite loop count means stop on the last frame rather than snapping
        // back to the first — which is where the file says the animation ends.
        if (this.#options.loopCount > 0 && this.#lap >= this.#options.loopCount) {
          this.#playing = false;
          this.#options.onChange();
          return;
        }
        this.#index = 0;
      } else {
        this.#index = next;
      }

      this.#options.onFrame(this.#index);
      this.#options.onChange();
      this.#schedule();
    }, delay);
  }

  #clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#playing = false;
    this.#clear();
  }
}

/** `1.4s` / `12.0s`, for the readout. */
export function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}
