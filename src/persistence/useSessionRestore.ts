/**
 * The one call that starts persistence, and the state the app renders while it
 * is happening.
 *
 * Restoring is a startup step with a visible duration — a store file to read, a
 * directory entry per tile to stat — and the empty state is a lie during it:
 * "no files open" next to an *open file* button, on the way to four tiles that
 * were always going to appear. So the phase is rendered.
 *
 * Recording starts only once the restore has settled. Every step of a restore
 * writes to the very stores the autosave subscribes to, so arming first would
 * save a workspace with half its tiles, and — on a run where a file is slow —
 * possibly overwrite the record being read from.
 */

import { useEffect, useState } from "react";

import { armSessionPersistence } from "./session";
import { restoreSession, type SessionRestoreResult } from "./restore";

export type SessionPhase = "restoring" | "ready";

/**
 * Runs at most once per page load, whatever React does with the component.
 *
 * StrictMode invokes every effect twice in development, and a second restore
 * would duplicate the workspace — so the promise, not the effect, is the thing
 * that happens once.
 */
let started: Promise<SessionRestoreResult> | null = null;

export function useSessionRestore(): {
  readonly phase: SessionPhase;
  readonly result: SessionRestoreResult | null;
} {
  const [result, setResult] = useState<SessionRestoreResult | null>(null);

  useEffect(() => {
    let live = true;
    let disarm: (() => void) | null = null;

    const running = (started ??= restoreSession().catch(
      (thrown: unknown): SessionRestoreResult => {
        // `restoreSession` is written not to reject; this is the belt to that
        // brace, because a rejection here would leave the app stuck on
        // "restoring…" with a working workspace behind it.
        console.error("[persistence] the session could not be restored", thrown);
        return {
          found: false,
          tiles: 0,
          reopened: 0,
          missing: 0,
          changed: 0,
          storage: "memory",
          hasLayout: false,
          focused: null,
        };
      },
    ));

    void running.then((settled) => {
      if (!live) return;
      setResult(settled);
      disarm = armSessionPersistence();
    });

    return () => {
      live = false;
      disarm?.();
    };
  }, []);

  return { phase: result ? "ready" : "restoring", result };
}
