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
 *     feature this plugin uses.
 *
 * 5.5.207's own floor is **higher than pdf.js documents and higher than this
 * file used to claim**: `Promise.try` (Safari 18.2) and `URL.parse` (18.0) are
 * both called unguarded. `compat.ts` supplies those and two more so the app's
 * stated floor is the real one; read it before touching the pin, and re-run the
 * scan it describes when the pin moves.
 *
 * Revisit when a 6.x lands that this app's Linux floor can run.
 *
 * ## pdf.js is never given a URL to resolve
 *
 * This is the fix for PDFs hanging on "loading" forever in the macOS bundle,
 * and it is worth writing down because nothing about it is visible from a
 * development run — and because the *first* fix for that hang was aimed at a
 * branch the engine never takes. Both halves are recorded here so the wrong one
 * is not re-derived.
 *
 * A bundled Tauri app is not served over `http`. `tauri_protocol_url` in
 * `tauri/src/manager/mod.rs` hands the webview `http://tauri.localhost` on
 * Windows and **`tauri://localhost` everywhere else**, macOS included, where a
 * `WKURLSchemeHandler` answers for the scheme. Every request the page makes for
 * its own assets — including a worker's script — goes through that handler
 * instead of a server, and **a request the handler does not drive does not
 * fail; it never completes**. wry's macOS handler is explicit about it: on any
 * of its validation paths it returns without calling `didFailWithError` or
 * `didFinish` (`wry/src/wkwebview/class/url_scheme_handler.rs`), which leaves
 * the load outstanding forever. Tauri issue #9975 is the same surface from the
 * other side — a worker script fetched over the app's scheme in a macOS release
 * build comes back as `index.html`, the SPA fallback, rather than as the asset.
 *
 * So `new Worker("/assets/pdf.worker.min-….mjs")` is the thing that breaks: the
 * worker's own script request goes to the scheme handler, the handler does not
 * answer it, the worker never evaluates, and it never sends `ready`. pdf.js has
 * an error path but no timeout, so `getDocument().promise` waits on a promise
 * that will not settle. The tile shows "loading" forever and *nothing is
 * logged*. None of it reproduces in `tauri dev`, where the frontend is
 * `http://localhost:1420` and a real server answers.
 *
 * **What is not the cause, despite looking like it.** pdf.js asks
 * `_isSameOrigin(window.location, workerSrc)` and, when the base has no origin,
 * decides the worker is on a CDN and wraps it in a blob that does
 * `await import("<the real URL>")`. `tauri:` is not a special scheme in the URL
 * Standard, so that branch *should* be taken — and on WebKit it is not.
 * `URL.parse("tauri://localhost/…").origin` returns `"tauri://localhost"`
 * there, not `"null"`: WebKit answers `URL.origin` from the document's
 * `SecurityOrigin`, which for an ordinary custom scheme is an ordinary
 * scheme/host tuple. Measured on webkit2gtk under a real `tauri://` scheme
 * handler, with and without `register_uri_scheme_as_secure`. The CDN wrapper
 * never runs on either WebKit port, so the patch that used to be here — pinning
 * `PDFWorker._isSameOrigin` to `true` — was preventing something that was not
 * happening. It is gone; do not put it back on the strength of the URL
 * Standard alone.
 *
 * The fix, then, is to leave pdf.js no URL to resolve at all:
 *
 *   1. **The worker's source is inlined at build time and run from a blob.**
 *      Nothing about it reaches the app's scheme — no fetch, no import, no
 *      scheme handler — so the platform difference stops being reachable.
 *   2. **The worker is measured, and then that same worker is the one pdf.js
 *      gets.** {@link startWorker} constructs it, waits for it to say hello,
 *      and {@link loadPdfDocument} hands it over as `getDocument({ worker })`.
 *      pdf.js then takes its `port` path, which never reads `workerSrc`, never
 *      consults `_isSameOrigin`, and never calls `new Worker`. What was
 *      measured is what runs; previously pdf.js built a second worker of its
 *      own from a URL and the measurement only implied that it would work.
 *   3. **Everything on the path has a deadline.** The handshake, the
 *      main-thread fallback's imports, and the shutdown handshake in
 *      {@link releaseWith}. AGENTS.md's rule is that a hang reports nothing and
 *      is strictly worse than a failure; the platform difference here surfaces
 *      as a hang rather than as an error, so every await that crosses it is
 *      bounded and reports which bound it hit.
 *
 * If the worker cannot be started at all, the library is set up to run on the
 * main thread instead — slower, and the UI judders while a page parses, but a
 * slow PDF is a PDF and a hung one is not.
 *
 * `?raw` costs a copy of the worker in the plugin's chunk, which is a chunk
 * nothing loads until a PDF is opened — the same trade `index.ts` already makes
 * for the library itself. The `?url` copy below it is emitted for the
 * main-thread fallback and fetched only if the blob path failed outright.
 */

// First, and deliberately: this module installs the built-ins pdf.js needs and
// old webviews lack, and ES modules evaluate in declaration order, so putting
// it above `pdfjs-dist` is what gets them in place before pdf.js's module body
// runs. See `compat.ts` — the gap is why every PDF hung on macOS.
import {
  PDF_COMPAT_SOURCE,
  describePdfCompat,
  installPdfCompat,
  pdfCompatHere,
  type PdfCompatReport,
} from "./compat";

import * as pdfjs from "pdfjs-dist";

// The worker's *source*. See "pdf.js is never given a URL to resolve" above:
// this replaced a `?url` import, and the difference between them is the
// difference between opening a PDF on macOS and not.
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

/**
 * `getDocument`'s object form, which is the only one this plugin uses.
 *
 * Narrowed from pdf.js's own union so {@link loadPdfDocument} can add a
 * `worker` to whatever it is handed without first having to work out whether it
 * was handed a URL, a buffer or a parameter object.
 */
export type PdfSource = Exclude<
  Parameters<typeof pdfjs.getDocument>[0],
  string | URL | ArrayBuffer | ArrayBufferView | undefined
>;

/** The library version, for the dev self-test's report line. */
export const PDFJS_VERSION: string = pdfjs.version;

/**
 * Where the library ended up running.
 *
 * `worker` is the good case and the one every platform is expected to reach.
 * `main-thread` means no worker ever answered and pdf.js is parsing and
 * rendering on the UI thread — correct, and noticeably less smooth.
 */
export type PdfWorkerMode = "worker" | "main-thread";

/**
 * How long a freshly spawned worker has to say hello.
 *
 * Generous on purpose. It is paid once per document, and only in full by a
 * platform that is already broken; a machine that needs two seconds to parse a
 * megabyte of decoder must not be pushed onto the main thread for being slow.
 */
const HANDSHAKE_MS = 5_000;

/** How long an `import()` of the worker module gets before it is written off. */
const MODULE_LOAD_MS = 15_000;

/**
 * How long pdf.js gets to shut a document down cleanly.
 *
 * `WorkerTransport.destroy` sends `Terminate` and waits for the worker to
 * acknowledge it, with no deadline of its own — so a worker that has stopped
 * answering would hang the tile being *closed* just as thoroughly as the one
 * being opened. Past this we stop waiting and terminate it ourselves.
 */
const SHUTDOWN_MS = 5_000;

let workerUrl: string | null = null;
let mode: PdfWorkerMode | null = null;
let preparation: Promise<PdfWorkerMode> | null = null;
/** The worker {@link prepare} proved, held for the first document to use. */
let proven: Worker | null = null;
/** What the last worker realm reported about its own globals. */
let workerCompat: PdfCompatReport | null = null;

/** What {@link withDeadline} resolves to when the work outran its deadline. */
const DEADLINE = Symbol("deadline");

/**
 * `work`, or {@link DEADLINE} if it takes longer than `ms`.
 *
 * Rejections are the caller's to handle; only the *silence* is converted, which
 * is the failure mode this module exists to convert.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * The worker's source as a blob URL, made once and never revoked.
 *
 * Never revoked because a new worker is started from it for every document
 * opened (see {@link loadPdfDocument}); revoking it after the first would break
 * the second.
 */
function workerSourceUrl(): string {
  // The compat shim goes *in front of* pdf.js's own source. A worker is a
  // separate global scope, so the copy installed on the main thread does
  // nothing for the thread that actually decodes — and it is that thread which
  // threw `Promise.try is not a function` and stopped answering.
  workerUrl ??= URL.createObjectURL(
    new Blob([PDF_COMPAT_SOURCE, pdfWorkerSource], { type: "text/javascript" }),
  );
  return workerUrl;
}

/**
 * Starts a worker and hands it back once it has spoken *and* said it is fit to
 * decode in. `null` if it never did either.
 *
 * Two messages arrive, in this order, and both are load-bearing:
 *
 *   1. **The compat report.** `PDF_COMPAT_SOURCE` runs ahead of pdf.js in that
 *      realm and posts what it had to supply and what is still absent. This is
 *      the only way to know whether the *worker's* globals are the ones pdf.js
 *      needs — the main thread's copy of the shim proves nothing about the
 *      worker's, and assuming it did is exactly how `toHex is not a function`
 *      became a mystery instead of a sentence. A realm that reports anything
 *      missing is refused here, so the session falls back to the main thread,
 *      whose globals this module patched itself and can vouch for.
 *   2. **pdf.js's own `ready`.** `WorkerMessageHandler` sends it from a static
 *      initializer the moment the module evaluates, so it is proof the rest of
 *      the path works: the blob was accepted, module workers are available, and
 *      a megabyte of decoder parsed and ran. Nothing is sniffed, which is
 *      AGENTS.md's rule for this kind of question.
 *
 * That second wait is one pdf.js would do anyway — it will not send `test`
 * until `ready` arrives — so doing it here costs nothing and buys the deadline
 * pdf.js does not have. Consuming both messages is safe: pdf.js's own `ready`
 * handler is a no-op, and the port path it takes resolves without waiting for
 * one.
 *
 * Resolves `null` rather than rejecting: the caller's next move is the same
 * whether the worker refused, crashed, arrived unfit, or never arrived at all.
 */
function startWorker(): Promise<Worker | null> {
  return new Promise<Worker | null>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(workerSourceUrl(), { type: "module" });
    } catch {
      resolve(null);
      return;
    }

    // Per call, not the module-level copy: that one keeps the *last* report for
    // diagnostics, and reading it here would let a later worker inherit an
    // earlier one's clean bill of health.
    let reported: PdfCompatReport | null = null;

    let settled = false;
    const settle = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (answered) {
        resolve(worker);
        return;
      }
      worker.terminate();
      resolve(null);
    };

    // The line that turns the macOS hang into a decision. Everything else here
    // is the happy path.
    const timer = setTimeout(() => settle(false), HANDSHAKE_MS);

    worker.addEventListener("message", (event: MessageEvent) => {
      const report = (event.data as { __pdfCompat?: PdfCompatReport } | null)?.__pdfCompat;
      if (report) {
        reported = report;
        workerCompat = report;
        // Not an answer, and not the end of the wait: `ready` is still coming.
        if (report.missing.length > 0) settle(false);
        return;
      }
      // `ready` with no report before it means the shim did not run in that
      // realm — the blob was assembled wrong, or something stripped it, or a
      // reason nobody has thought of yet. Whatever it is, this thread cannot
      // vouch for those globals and pdf.js will walk straight into them, so the
      // worker is declined in favour of the realm this module patched itself.
      settle(reported !== null);
    });
    worker.addEventListener("error", () => settle(false), { once: true });
  });
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
 * every other chunk of this app already loads through). Each gets a deadline,
 * because the second one is a request on the app's own scheme and that is the
 * request this whole file is about. If both fail there is no way to open a PDF
 * at all, and saying so beats a spinner.
 */
async function runWorkerOnThisThread(): Promise<void> {
  if (handlerIsOnThisThread()) return;

  const failures: string[] = [];
  const specifiers = [
    { name: "the inlined worker source", specifier: workerSourceUrl() },
    { name: "the emitted worker asset", specifier: pdfWorkerUrl },
  ];

  for (const { name, specifier } of specifiers) {
    try {
      const outcome = await withDeadline(import(/* @vite-ignore */ specifier), MODULE_LOAD_MS);
      if (outcome === DEADLINE) {
        failures.push(`${name} did not load within ${MODULE_LOAD_MS}ms`);
        continue;
      }
    } catch (thrown) {
      failures.push(`${name}: ${describe(thrown)}`);
      continue;
    }
    if (handlerIsOnThisThread()) return;
    failures.push(`${name} loaded but published no message handler`);
  }

  // An import that outran its deadline may still have landed while the other
  // one was being tried.
  if (handlerIsOnThisThread()) return;

  throw new Error(`the PDF decoder could not be started: ${failures.join("; ")}`);
}

/** Switches the session to the main thread for good, and says why. */
async function fallBackToThisThread(why: string): Promise<void> {
  // Worth a line in the console: it is the difference between "this app is
  // sluggish on large PDFs" and "this app is sluggish on large PDFs *here*".
  console.warn(`[pdf] ${why}; pdf.js will run on the main thread`);
  await runWorkerOnThisThread();

  // The worker path checks the realm it is about to decode in; this one has to
  // as well, and it is not free to assume — a megabyte of third-party module
  // has just been evaluated in *this* realm. `installPdfCompat` is idempotent,
  // so this either changes nothing or repairs something, and either way the
  // next line is a fact rather than an assumption.
  installPdfCompat();
  const here = pdfCompatHere();
  if (here.missing.length > 0) {
    throw new Error(
      `the PDF decoder cannot run here: this webview is missing ${here.missing.join(", ")}`,
    );
  }

  mode = "main-thread";
  preparation = Promise.resolve(mode);
}

async function prepare(): Promise<PdfWorkerMode> {
  // Set whatever happens. pdf.js reads `workerSrc` on paths that never spawn a
  // worker, and an unset one throws from a getter rather than doing nothing.
  // The blob is the right value even in main-thread mode: should anything ever
  // reach `getDocument` without going through `loadPdfDocument`, the worker it
  // builds for itself is still one that needs no scheme handler.
  pdfjs.GlobalWorkerOptions.workerSrc = workerSourceUrl();

  const worker = await startWorker();
  if (worker) {
    // Kept rather than terminated: this one has already parsed a megabyte of
    // decoder, and the first document is about to want exactly that.
    proven = worker;
    mode = "worker";
    return mode;
  }

  await fallBackToThisThread(
    workerCompat === null
      ? "the decoder worker started but never reported its built-ins, so its realm cannot be vouched for"
      : workerCompat.missing.length > 0
        ? `the decoder worker's realm is missing ${workerCompat.missing.join(", ")}`
        : "the decoder worker did not start",
  );
  return "main-thread";
}

/**
 * One line describing where pdf.js is running and what its globals are, for
 * error details and the self-test.
 *
 * Attached to every load failure on purpose. The dev self-test panel is
 * stripped from release builds, which is precisely where these failures are
 * reported from — so without this, a user's screenshot says a thing broke and
 * nothing about the engine it broke on, and answering costs a round trip.
 */
export function pdfEnvironment(): string {
  const here = `main thread: ${describePdfCompat(pdfCompatHere())}`;
  const there = workerCompat ? `; worker: ${describePdfCompat(workerCompat)}` : "";
  return `pdf.js ${PDFJS_VERSION} on the ${
    mode === "main-thread" ? "main thread" : "worker"
  } — ${here}${there}`;
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
 * Ties `worker`'s lifetime — and its failures — to `task`'s.
 *
 * **Ownership.** A `PDFWorker` built from a port does not own the worker behind
 * it — pdf.js only terminates workers it constructed itself — so the one thing
 * this module gains by constructing its own is the one thing it now has to
 * clean up. Both ways out are covered: `destroy()`, which is what a closing
 * tile calls (`PDFDocumentProxy.destroy` forwards to the loading task's), and a
 * load that rejected and will never be destroyed because it never produced a
 * document.
 *
 * **Failures.** pdf.js watches for `error` on workers it built itself and falls
 * back when one fires; on the port path it attaches nothing at all. That gap is
 * not theoretical — it is how a `TypeError` thrown inside the worker's own
 * message listener reached a user as a 45-second timeout with no cause attached
 * (see `compat.ts`). An uncaught error over there is a failed load, and it is
 * reported as itself.
 */
function releaseWith(task: PdfLoadingTask, worker: Worker): PdfLoadingTask {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    worker.terminate();
  };

  // Never resolves; only ever rejects. `Promise.race` below always attaches a
  // handler, so a worker that dies *after* the document loaded settles nothing
  // and goes unnoticed rather than surfacing as an unhandled rejection.
  const workerFailed = new Promise<never>((_, reject) => {
    worker.addEventListener(
      "error",
      (event) => {
        // A blob worker reports its errors in full; the guard is for engines
        // that reduce a cross-origin script error to an empty `ErrorEvent`.
        const detail = event.message || "the decoder worker stopped with an error";
        reject(new Error(`${detail}${event.lineno ? ` (line ${event.lineno})` : ""}`));
      },
      { once: true },
    );
    worker.addEventListener(
      "messageerror",
      () => reject(new Error("the decoder worker could not read a message it was sent")),
      { once: true },
    );
  });

  // Shadows the prototype getter, which is the same trick `destroy` below uses.
  // Callers await `task.promise`; this is the only place that can widen what
  // they are awaiting to include "the worker fell over".
  const settled = Promise.race([task.promise, workerFailed]);
  Object.defineProperty(task, "promise", { value: settled, configurable: true });

  const destroy = task.destroy.bind(task);
  task.destroy = async (): Promise<void> => {
    try {
      await withDeadline(destroy(), SHUTDOWN_MS);
    } finally {
      release();
    }
  };

  // Not `finally`: a resolved task is a live document, and its worker has to
  // outlive this promise by however long the tile stays open. A rejected one
  // is the single exit nothing else covers — there is no document to close, so
  // no tile will ever call `destroy()` for it.
  task.promise.catch(() => void task.destroy().catch(() => {}));

  return task;
}

/**
 * Opens a document. The only route to `getDocument` in this plugin.
 *
 * A funnel rather than a convenience: the worker has to be started and
 * *measured* before pdf.js builds anything (see "pdf.js is never given a URL to
 * resolve"), and a second call site that reached for `pdfjs.getDocument`
 * directly would be a second place where the macOS hang could come back. Hands
 * back the loading task rather than its promise, because callers cancel and
 * destroy through the task.
 */
export async function loadPdfDocument(parameters: PdfSource): Promise<PdfLoadingTask> {
  if ((await preparePdfWorker()) === "main-thread") return pdfjs.getDocument(parameters);

  const worker = proven ?? (await startWorker());
  proven = null;

  if (!worker) {
    // A worker answered when the session started and does not now. Handing
    // pdf.js one that has not spoken is exactly the trade this module refuses,
    // so take the slow road, and take it for the rest of the session.
    await fallBackToThisThread("a decoder worker stopped starting mid-session");
    return pdfjs.getDocument(parameters);
  }

  return releaseWith(
    pdfjs.getDocument({ ...parameters, worker: pdfjs.PDFWorker.create({ port: worker }) }),
    worker,
  );
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

/**
 * `work`, or a rejection naming the deadline it outran.
 *
 * Exported because opening a document is more than starting a worker, and the
 * steps after it — `getDocument().promise`, the first `getPage` — are pdf.js
 * waiting on the same worker with the same absence of a timeout. `mount.ts` is
 * the caller; see the rule in "pdf.js is never given a URL to resolve".
 */
export async function withinDeadline<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  const outcome = await withDeadline(work, ms);
  if (outcome === DEADLINE) {
    throw new Error(
      `${what} did not finish within ${Math.round(ms / 1000)}s (pdf.js is running ` +
        `${pdfWorkerMode() === "worker" ? "in a worker" : "on the main thread"})`,
    );
  }
  return outcome;
}
