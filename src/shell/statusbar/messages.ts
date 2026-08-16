/**
 * The shell's transient announcement channel: one line, in the status bar,
 * that fades out on its own.
 *
 * Phase 06 needs somewhere to say "copied" and the brief is specific about
 * where: *"Visual feedback on successful copy should be a brief status-bar
 * message, consistent with the established flat aesthetic, not a modal or
 * animated toast."* So this is deliberately the smallest thing that can be:
 * one message at a time, replaced rather than queued, cleared by a timer.
 *
 * ## Why a shell channel at all, when the tiles already have one
 *
 * The image and video plugins each announce inside their own tile (`view.ts`'s
 * `announce`), which is right for something that happened *to that tile* —
 * "fit to window", "frame 12 of 30". A clipboard write is not that: it is the
 * shell acting on the focused tile, and its outcome concerns the workspace
 * (what is now on the system clipboard, what is now in the scratch panel), not
 * the document. Putting it in the tile would also mean a plugin that never
 * grew an announcement area could not report a copy at all.
 *
 * Kept out of `store/layout.ts` because it is not layout and not a preference —
 * it is a message with a lifetime. Everything else in that store survives until
 * something changes it; this expires.
 */

import { create } from "zustand";

/** Functional signaling only, mapped to the three signal tokens. */
export type StatusTone = "info" | "warn" | "error";

export interface StatusMessage {
  readonly text: string;
  readonly tone: StatusTone;
  /** Bumped on every announcement, so an identical message re-triggers the timer. */
  readonly nonce: number;
}

interface StatusMessageState {
  readonly message: StatusMessage | null;
  announce(text: string, tone?: StatusTone): void;
  clear(nonce?: number): void;
}

/**
 * Long enough to read a short sentence, short enough that the bar is not
 * lying about the present state by the time you look at it.
 */
export const STATUS_MESSAGE_MS = 3500;

let nonce = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export const useStatusMessageStore = create<StatusMessageState>((set, get) => ({
  message: null,

  announce(text, tone = "info") {
    nonce += 1;
    const current = nonce;
    set({ message: { text, tone, nonce: current } });

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      get().clear(current);
    }, STATUS_MESSAGE_MS);
  },

  /**
   * Clears the bar. With a `nonce`, only if that message is still the one
   * showing — so a timer belonging to a message that has already been replaced
   * cannot wipe its successor.
   */
  clear(expected) {
    set((state) => {
      if (expected !== undefined && state.message?.nonce !== expected) return state;
      return { message: null };
    });
  },
}));

/**
 * Announce from outside React. Everything in this phase that produces a
 * message — a clipboard write, a failed region capture — is an action rather
 * than a component, so this is the form that actually gets used.
 */
export function announceStatus(text: string, tone: StatusTone = "info"): void {
  useStatusMessageStore.getState().announce(text, tone);
}
