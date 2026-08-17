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
 *
 * ## The worker is started from source, not from a URL
 *
 * This is the fix for PDFs hanging on "loading" forever in the macOS bundle,
 * and the mechanism is worth writing down because nothing about it is visible
 * from a development run.
 *
 * A bundled Tauri app is not served over `http`. `tauri_protocol_url` in
 * `tauri/src/manager/mod.rs` hands the webview `http://tauri.localhost` on
 * Windows and **`tauri://localhost` everywhere else**, macOS included, where a
 * `WKURLSchemeHandler` answers for the scheme. `tauri:` is not a *special*
 * scheme in the URL Standard, so `URL.parse("tauri://localhost").origin` is the
 * string `"null"` — and that one detail is the whole bug. pdf.js asks
 * `_isSameOrigin(window.location, workerSrc)`, gets `false` because the *base*
 * has no origin, and concludes the worker lives on a CDN. It then does what it
 * does for a CDN: builds a one-line blob, `await import("<the real URL>");`,
 * and starts *that* as the worker.
 *
 * So the worker's first act is to fetch `tauri://localhost/assets/…` from
 * inside a worker context. WKWebView does not drive the scheme handler for that
 * request; it never completes and never fails. The import never settles, the
 * worker never sends its `ready`, and pdf.js — which has an error path but no
 * timeout — waits on a promise that will not settle. `getDocument().promise`
 * never resolves, the tile shows "loading" forever, and *nothing is logged*.
 *
 * None of it reproduces in `tauri dev`, where the frontend is
 * `http://localhost:1420`, a real origin: same-origin, no wrapper, no
 * cross-scheme fetch, worker starts. The bug exists only in a bundle, and only
 * where the scheme handler is WKWebView's.
 *
 * Two changes answer it, and each is doing a different job:
 *
 *   1. **The worker's source is inlined at build time and run from a blob.**
 *      The worker then needs nothing from the app's scheme — no fetch, no
 *      import, no scheme handler — so the platform difference stops being
 *      reachable. `_isSameOrigin` is pinned to `true` alongside it so pdf.js
 *      does not wrap our blob in a second blob that imports it; that wrapper is
 *      what turns a working URL into a request, and the request is the problem.
 *   2. **The worker is measured before it is trusted.** {@link preparePdfWorker}
 *      starts one and waits for it to say hello. If it does not, the library is
 *      set up to run on the main thread instead — slower, and the UI judders
 *      while a page parses, but a slow PDF is a PDF and a hung one is not.
 *      AGENTS.md is explicit that a hang reports nothing and is strictly worse
 *      than a failure; this is that rule applied to the thing that hung.
 *
 * `?raw` costs a copy of the worker in the plugin's chunk, which is a chunk
 * nothing loads until a PDF is opened — the same trade `index.ts` already makes
 * for the library itself. The `?url` copy below it is emitted for the
 * main-thread fallback and fetched only if the blob path failed outright.
 */

import * as pdfjs from "pdfjs-dist";

// The worker's *source*. See "The worker is started from source" above: this
// replaced a `?url` import, and the difference between them is the difference
// between opening a PDF on macOS and not.
import pdfWorkerSource from "pdfjs-dist/build/pdf.worker.min.mjs?raw";
// The same file, emitted as an asset. Only {@link runWorkerOnThisThread} reads
// it, and only after the blob has already failed.
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export { pdfjs };

export type PdfDocument = pdfjs.PDFDocumentProxy;
export type PdfPage = pdfjs.PDFPageProxy;
export type PdfRenderTask = pdfjs.RenderTask;
export type PdfViewport = pdfjs.PageViewport;
export type PdfLoadingTask = pdfjs.PDFDocumentLoadingTask;

/** The library version, for the dev self-test's report line. */
export const PDFJS_VERSION: string = pdfjs.version;

/**
 * Where the library ended up running.
 *
 * `worker` is the good case and the one every platform is expected to reach.
 * `main-thread` means the worker never answered and pdf.js is parsing and
 * rendering on the UI thread — correct, and noticeably less smooth.
 */
export type PdfWorkerMode = "worker" | "main-thread";

/**
 * How long a freshly spawned worker has to say hello.
 *
 * Generous on purpose. It is paid once per session and only by a platform that
 * is already broken; a machine that needs two seconds to parse a megabyte of
 * decoder must not be pushed onto the main thread for being slow.
 */
const HANDSHAKE_MS = 5_000;

let workerUrl: string | null = null;
let mode: PdfWorkerMode | null = null;
let preparation: Promise<PdfWorkerMode> | null = null;

/**
 * The worker's source as a blob URL, made once and never revoked.
 *
 * Never revoked because pdf.js starts a *new* worker from this URL for every
 * document opened (see {@link loadPdfDocument}); revoking it after the first
 * would break the second.
 */
function workerSourceUrl(): string {
  workerUrl ??= URL.createObjectURL(new Blob([pdfWorkerSource], { type: "text/javascript" }));
  return workerUrl;
}

/**
 * Starts one worker and waits for it to speak.
 *
 * The worker announces itself — `WorkerMessageHandler` sends `ready` from its
 * own static initializer the moment the module evaluates — so *any* message is
 * proof the whole path works: the blob was accepted, module workers are
 * available, and a megabyte of decoder parsed and ran. Nothing is asked of the
 * platform and no capability is sniffed, which is AGENTS.md's rule for exactly
 * this kind of question.
 *
 * Resolves `false` rather than rejecting: the caller's next move is the same
 * whether the worker refused, crashed, or silently never arrived.
 */
function workerAnswers(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(url, { type: "module" });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const settle = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The probe is a probe. The documents get their own workers.
      worker.terminate();
      resolve(answered);
    };

    // The line that turns the macOS hang into a decision. Everything else here
    // is the happy path.
    const timer = setTimeout(() => settle(false), HANDSHAKE_MS);
    worker.addEventListener("message", () => settle(true), { once: true });
    worker.addEventListener("error", () => settle(false), { once: true });
  });
}

/**
 * Stops pdf.js wrapping our worker URL in a blob that imports it.
 *
 * `_isSameOrigin` exists to decide whether `workerSrc` is a CDN URL that needs
 * the wrapper. Ours never is — it is a blob holding the source itself — so the
 * answer is always yes, and on a `tauri://` origin the honest answer is
 * unavailable anyway (the base has no origin to compare against).
 *
 * Reached through a cast because it is not on the published type. If a future
 * pdf.js drops it the assignment simply stops happening, and the fallback is
 * benign: the wrapper would then import a blob from a blob, which involves no
 * custom scheme and no scheme handler.
 */
function stopWrappingTheWorkerUrl(): void {
  const worker = pdfjs.PDFWorker as unknown as {
    _isSameOrigin?: (base: unknown, other: unknown) => boolean;
  };
  if (typeof worker._isSameOrigin === "function") worker._isSameOrigin = () => true;
}

/** Whether the worker's message handler is already on this thread. */
function handlerIsOnThisThread(): boolean {
  return Boolean((globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } }).pdfjsWorker
    ?.WorkerMessageHandler);
}

/**
 * Loads the worker module into *this* thread, for a platform that cannot run it
 * in a real one.
 *
 * The module publishes `globalThis.pdfjsWorker` when it evaluates outside a
 * worker, which is precisely what pdf.js looks for before it decides to spawn
 * anything — so doing this first means no `Worker` is ever constructed and
 * there is nothing left that can hang.
 *
 * Two specifiers, because this is the last line of defence: the blob (no
 * network, no scheme handler) and then the emitted asset (the same mechanism
 * every other chunk of this app already loads through). If both fail there is
 * no way to open a PDF at all, and saying so beats a spinner.
 */
async function runWorkerOnThisThread(): Promise<void> {
  if (handlerIsOnThisThread()) return;

  let failure: unknown;
  for (const specifier of [workerSourceUrl(), pdfWorkerUrl]) {
    try {
      await import(/* @vite-ignore */ specifier);
      if (handlerIsOnThisThread()) return;
    } catch (thrown) {
      failure = thrown;
    }
  }

  throw new Error(
    `the PDF decoder could not be started: ${
      failure instanceof Error ? failure.message : String(failure)
    }`,
  );
}

async function prepare(): Promise<PdfWorkerMode> {
  const url = workerSourceUrl();

  if (await workerAnswers(url)) {
    stopWrappingTheWorkerUrl();
    pdfjs.GlobalWorkerOptions.workerSrc = url;
    mode = "worker";
    return mode;
  }

  // Worth a line in the console: it is the difference between "this app is
  // sluggish on large PDFs" and "this app is sluggish on large PDFs *here*".
  console.warn(
    "[pdf] the decoder worker did not start; pdf.js will run on the main thread",
  );
  await runWorkerOnThisThread();
  // Set anyway. pdf.js reads `workerSrc` on paths that never spawn a worker,
  // and an unset one throws from a getter rather than doing nothing.
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  mode = "main-thread";
  return mode;
}

/**
 * Gets the library ready to open documents, once per session.
 *
 * Idempotent and memoized, including the failure: a worker that could not be
 * started could not be started for a reason that will not change mid-session,
 * and re-probing per document would pay the handshake timeout per document.
 * The same reasoning `media.rs` applies to its loopback port.
 */
export function preparePdfWorker(): Promise<PdfWorkerMode> {
  preparation ??= prepare();
  return preparation;
}

/** Where the library is running, for the dev self-test's report line. */
export function pdfWorkerMode(): PdfWorkerMode | "unresolved" {
  return mode ?? "unresolved";
}

/**
 * Opens a document. The only route to `getDocument` in this plugin.
 *
 * A funnel rather than a convenience: {@link preparePdfWorker} has to have
 * settled before pdf.js constructs anything, and a second call site that
 * reached for `pdfjs.getDocument` directly would be a second place where the
 * macOS hang could come back. Hands back the loading task rather than its
 * promise, because callers cancel and destroy through the task.
 */
export async function loadPdfDocument(
  parameters: Parameters<typeof pdfjs.getDocument>[0],
): Promise<PdfLoadingTask> {
  await preparePdfWorker();
  return pdfjs.getDocument(parameters);
}

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
