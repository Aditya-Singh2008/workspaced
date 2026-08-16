/**
 * Sends a diagnostic line to the terminal running `npm start`. **Dev only.**
 *
 * The webview console is not readable from outside the app on any of the three
 * platforms, so this is how self-test output and per-platform rendering
 * observations get somewhere a human or a script can see them. Backed by the
 * `dev_log` Rust command, which discards its input in release builds.
 *
 * Never throws: outside the Tauri shell (a plain browser running the
 * verification harness) it falls back to the browser console.
 */

import { invoke } from "@tauri-apps/api/core";

export async function devLog(line: string): Promise<void> {
  try {
    await invoke("dev_log", { line });
  } catch {
    console.info(`[webview] ${line}`);
  }
}

/** Formats a self-test report as compact lines suitable for a terminal. */
export function formatReportLines(report: {
  title: string;
  passed: boolean;
  checks: readonly { name: string; passed: boolean; detail: string; skipped?: boolean }[];
}): string[] {
  const passedCount = report.checks.filter((c) => c.passed).length;
  const skipped = report.checks.filter((c) => c.skipped);
  const total = report.checks.length - skipped.length;

  return [
    `${report.passed ? "PASS" : "FAIL"} ${report.title} — ${passedCount}/${total}` +
      (skipped.length ? ` (${skipped.length} skipped)` : ""),
    // Skipped checks are printed too. A silent skip is how a suite quietly
    // stops covering the thing it was written for.
    ...skipped.map((c) => `  SKIP ${c.name}: ${c.detail}`),
    ...report.checks
      .filter((c) => !c.passed && !c.skipped)
      .map((c) => `  FAIL ${c.name}: ${c.detail}`),
  ];
}
