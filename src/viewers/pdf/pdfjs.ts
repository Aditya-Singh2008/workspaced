/**
 * The single place `pdf.js` is loaded and configured.
 *
 * Everything else in this plugin imports the library from here, so there is one
 * answer to "which build, which worker, which version" and one place to change
 * it. Nothing outside `src/viewers/pdf/` imports `pdfjs-dist` at all — that is
 * what keeps the shell free of a PDF dependency.
 *
 * ## Why the version is pinned, and pinned *there*
 *
 * `pdfjs-dist` is pinned to 5.5.207 rather than tracking latest, and both
 * bounds are load-bearing:
 *
 *   - **Not older.** Nothing below it is newer, obviously; the point is that
 *     5.5.207 is the newest release in the 5.x line unaffected by
 *     GHSA-hq66-cqwq-w95j (arbitrary JavaScript execution on opening a
 *     malicious PDF), which covers `>=5.6.83 <6.2.108`. In an application whose
 *     entire job is opening PDFs the user did not write, that advisory is not
 *     theoretical.
 *   - **Not newer.** 6.2.108 is the first patched 6.x, and 6.x requires
 *     Iterator Helpers (`Iterator.prototype.*`), which webkit2gtk only ships
 *     from 2.48. Ubuntu 24.04 LTS is on 2.44. Taking 6.x would silently drop
 *     the Linux target AGENTS.md names first (see "Platform targets"), for no
 *     feature this plugin uses. 5.5.207 needs `Promise.withResolvers`, i.e.
 *     webkit2gtk 2.44+ / Safari 17.4+ / Chromium 119+, which is the baseline
 *     recorded in AGENTS.md.
 *
 * Revisit when a 6.x lands that this app's Linux floor can run.
 */

import * as pdfjs from "pdfjs-dist";

// Vite emits the worker as a hashed asset and hands back its URL. `workerSrc`
// rather than `workerPort` on purpose: pdf.js spawns one worker per document,
// so several open PDF tiles decode in parallel instead of queueing behind a
// single shared port.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export { pdfjs };

export type PdfDocument = pdfjs.PDFDocumentProxy;
export type PdfPage = pdfjs.PDFPageProxy;
export type PdfRenderTask = pdfjs.RenderTask;
export type PdfViewport = pdfjs.PageViewport;

/** The library version, for the dev self-test's report line. */
export const PDFJS_VERSION: string = pdfjs.version;

/**
 * Whether a rejection is pdf.js cancelling work we asked it to cancel.
 *
 * Scrolling, zooming and closing a tile all cancel in-flight renders, so this
 * is the common case rather than an error case: it must stay silent, and
 * anything that is *not* this must not.
 */
export function isRenderCancellation(thrown: unknown): boolean {
  return (
    thrown instanceof pdfjs.RenderingCancelledException ||
    (thrown instanceof Error && thrown.name === "RenderingCancelledException")
  );
}
