/**
 * Shared shapes for the dev-only self-tests. **Dev builds only.**
 *
 * There is no test runner in the tech stack, and adding one is not justified
 * yet (AGENTS.md, "All new dependencies must be justified"). These self-tests
 * are the stand-in: they run inside the real webview, which is exactly where
 * the things worth checking live — canvas behavior under webkit2gtk, and
 * keyboard modifier handling per platform.
 */

export interface SelfTestCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
  /**
   * The check could not run here, and that is not a failure.
   *
   * Some things are only observable under conditions the harness does not
   * control: a macOS-only accelerator, or — the case this was added for — a
   * page render, which cannot complete while the window is not being
   * composited, because the renderer schedules its own continuations on
   * `requestAnimationFrame`. The honest report is "not verified", and it has to
   * be visibly distinct from both a pass and a fail. Reporting it as a pass
   * hides a gap in coverage; reporting it as a fail trains people to ignore red.
   */
  readonly skipped?: boolean;
}

export interface SelfTestReport {
  readonly title: string;
  readonly passed: boolean;
  readonly checks: readonly SelfTestCheck[];
}

export function check(name: string, passed: boolean, detail: string): SelfTestCheck {
  return { name, passed, detail };
}

/** A check that could not run. `reason` should say what would make it run. */
export function skip(name: string, reason: string): SelfTestCheck {
  return { name, passed: false, detail: reason, skipped: true };
}

export function report(title: string, checks: readonly SelfTestCheck[]): SelfTestReport {
  return {
    title,
    passed: checks.every((c) => c.passed || c.skipped),
    checks,
  };
}
