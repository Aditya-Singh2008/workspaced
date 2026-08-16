/**
 * Dev-only panel that runs the self-tests inside the real webview and shows
 * the results.
 *
 * Running here rather than in a headless browser is the point: the two things
 * being checked — canvas/`ImageBitmap` behavior and keyboard modifier handling
 * — are exactly where webkit2gtk on Linux, WebView2 on Windows and WKWebView
 * on macOS are most likely to diverge (AGENTS.md, "Platform targets").
 *
 * Stripped from production builds by the `import.meta.env.DEV` guard at its
 * call site and by the dynamic imports below.
 */

import { useEffect, useRef, useState } from "react";

import type { SelfTestReport } from "../dev/selftest";
import { currentPlatform, platformSource } from "../platform";

export function DevSelfTestPanel() {
  const [reports, setReports] = useState<readonly SelfTestReport[]>([]);
  const [running, setRunning] = useState(false);
  const autoRan = useRef(false);

  // Runs once per dev session, so a regression is visible the moment the app
  // boots rather than only when someone thinks to check.
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    void run();
  }, []);

  const [crash, setCrash] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setCrash(null);
    try {
      const [
        { runContractSelfTest },
        { runKeybindSelfTest },
        { runKeybindRegistrySelfTest },
        { runDockingSelfTest },
        { runShellServicesSelfTest },
        { runPersistenceSelfTest },
        { runAnnotationSelfTest },
        { runPdfSelfTest },
        { runImageSelfTest },
        { runVideoSelfTest },
        { devLog, formatReportLines },
      ] = await Promise.all([
        import("../viewers/dev/contract-selftest"),
        import("../shell/keybinds/selftest"),
        import("../shell/keybinds/registry-selftest"),
        import("../shell/docking/selftest"),
        import("../shell/selftest"),
        import("../persistence/selftest"),
        import("../annotation/selftest"),
        import("../viewers/pdf/selftest"),
        import("../viewers/image/selftest"),
        import("../viewers/video/selftest"),
        import("../dev/log"),
      ]);

      // Announced before each suite runs, not after. Reports are only printed
      // once every suite has finished, so a suite that hangs produces a log
      // that stops dead with no indication of where — which is exactly the
      // situation this line exists to prevent.
      const suites: readonly [string, () => SelfTestReport | Promise<SelfTestReport>][] = [
        ["viewer plugin contract", runContractSelfTest],
        ["keybind accelerators", runKeybindSelfTest],
        ["keybind registry", runKeybindRegistrySelfTest],
        ["tiling and layout actions", runDockingSelfTest],
        // The three shell services phase 06 added. Before the plugin suites
        // for the same reason the annotation one is: they are checked against
        // fakes here, so a failure explains one there rather than the reverse.
        ["clipboard, search and command palette", runShellServicesSelfTest],
        // After the shell services and before the plugins, for the same reason
        // as both: it drives the real workspace and layout stores, so it wants
        // them quiet — and its last section declines to run at all if the
        // workspace has tiles in it.
        ["session persistence", runPersistenceSelfTest],
        // Before the plugin suites: it checks the shared model and the export
        // bridge, which the PDF suite then exercises through the tile. A failure
        // here explains a failure there.
        ["annotation model and export", runAnnotationSelfTest],
        ["pdf viewer plugin", runPdfSelfTest],
        ["image viewer plugin", runImageSelfTest],
        ["video viewer plugin", runVideoSelfTest],
      ];

      const results: SelfTestReport[] = [];
      for (const [name, run] of suites) {
        await devLog(`running ${name}…`);
        results.push(await run());
      }
      setReports(results);

      // Mirror to the terminal, so the result is readable from outside the
      // webview — the only way to check webkit2gtk/WebView2/WKWebView behavior
      // without a human watching the window.
      await devLog(
        `platform=${currentPlatform()} (via ${platformSource()}) userAgent=${navigator.userAgent}`,
      );
      for (const result of results) {
        for (const line of formatReportLines(result)) await devLog(line);
      }
    } catch (thrown) {
      // Without this the whole harness fails *silently*: a self-test module
      // that throws while loading — a dependency the dev server cannot resolve,
      // a top-level error — leaves the panel empty and the terminal quiet,
      // which reads exactly like "still running". Cost an afternoon in phase 03.
      const message = thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown);
      setCrash(message);
      const { devLog } = await import("../dev/log");
      await devLog(`SELF-TESTS CRASHED — ${message}`);
    } finally {
      setRunning(false);
    }
  }

  const allPassed = reports.length > 0 && reports.every((r) => r.passed);

  return (
    <div className="mt-8 flex w-full max-w-4xl flex-col items-center gap-3 border-t border-border pt-6">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="border border-border px-3 py-1 text-muted hover:bg-surface-hover hover:text-fg disabled:text-disabled"
        >
          {running ? "running…" : "run self-tests"}
        </button>
        {/*
          The tiling shell can only be verified by hand — split, stack, drag,
          resize. These open throwaway in-memory tiles so that can be done from
          a cold start without keeping sample files around.
        */}
        <button
          type="button"
          onClick={() => void import("../dev/stubTiles").then((m) => m.openStubTiles(3))}
          className="border border-border px-3 py-1 text-muted hover:bg-surface-hover hover:text-fg"
        >
          open 3 stub tiles
        </button>
        {/*
          Phase 03's verification is mostly visual — inversion, zoom, selection.
          This opens the self-test's own two-page fixture as a real tile so
          those can be judged without a sample PDF on the machine.
        */}
        <button
          type="button"
          onClick={() => void import("../dev/stubTiles").then((m) => m.openFixturePdfTile())}
          className="border border-border px-3 py-1 text-muted hover:bg-surface-hover hover:text-fg"
        >
          open sample PDF
        </button>
        {/*
          Phase 04a's verification is mostly visual too — zoom feel, SVG
          crispness at 800%, animation timing, the transparency checkerboard.
          These open one tile per fixture so all four can be judged side by side.
        */}
        <button
          type="button"
          onClick={() =>
            void import("../dev/stubTiles").then((m) => m.openFixtureImageTiles())
          }
          className="border border-border px-3 py-1 text-muted hover:bg-surface-hover hover:text-fg"
        >
          open sample images
        </button>
        {/*
          Phase 04b's verification is almost entirely visual and tactile —
          scrub feel, transport keys, caption placement. The fixture is encoded
          by the platform on demand, so the button does nothing on a build with
          no `MediaRecorder` and a real file is needed there instead.
        */}
        <button
          type="button"
          onClick={() =>
            void import("../dev/stubTiles").then(async (m) => {
              if ((await m.openFixtureVideoTile()) === null) {
                const { devLog } = await import("../dev/log");
                await devLog(
                  "this platform cannot encode a video fixture — open a real video file to check playback",
                );
              }
            })
          }
          className="border border-border px-3 py-1 text-muted hover:bg-surface-hover hover:text-fg"
        >
          open sample video
        </button>
        <span className="text-muted">platform: {currentPlatform()}</span>
        {reports.length > 0 ? (
          <span className={allPassed ? "text-ok" : "text-error"}>
            {allPassed ? "ALL PASS" : "FAILURES"}
          </span>
        ) : null}
      </div>

      {crash ? (
        <pre className="w-full overflow-x-auto whitespace-pre-wrap break-words text-error">
          {crash}
        </pre>
      ) : null}

      {reports.map((report) => (
        <div key={report.title} className="flex w-full flex-col gap-1">
          <p className={report.passed ? "text-ok" : "text-error"}>
            {report.passed ? "PASS" : "FAIL"} — {report.title} —{" "}
            {report.checks.filter((c) => c.passed).length}/
            {report.checks.filter((c) => !c.skipped).length} checks
            {report.checks.some((c) => c.skipped)
              ? ` (${report.checks.filter((c) => c.skipped).length} skipped)`
              : ""}
          </p>
          {report.checks.map((check) => (
            <div key={check.name} className="flex gap-3">
              <span
                className={
                  check.skipped
                    ? "w-12 shrink-0 text-warn"
                    : check.passed
                      ? "w-12 shrink-0 text-ok"
                      : "w-12 shrink-0 text-error"
                }
              >
                {check.skipped ? "skip" : check.passed ? "ok" : "fail"}
              </span>
              <span className="w-72 shrink-0 text-fg-dim">{check.name}</span>
              <span className="min-w-0 break-all text-muted">{check.detail}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
