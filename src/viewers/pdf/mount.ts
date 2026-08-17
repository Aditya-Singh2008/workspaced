/**
 * Opening a PDF: the half of the plugin that costs a megabyte.
 *
 * Split from `index.ts` so the descriptor can be registered at startup without
 * pdf.js being parsed. Everything reachable from here — the library, the
 * worker, the view, the stylesheet — is loaded the first time a PDF is actually
 * opened and never in a session that opens none.
 */

import type { FileHandle } from "../../files";
import {
  ViewerLoadError,
  type ViewerInstance,
  type ViewerMountOptions,
} from "../contract";
import { MIN_TEXT_CHARS, PdfViewerInstance, TEXT_PROBE_PAGES } from "./instance";
import {
  loadPdfDocument,
  pdfEnvironment,
  pdfjs,
  withinDeadline,
  type PdfDocument,
  type PdfLoadingTask,
} from "./pdfjs";

import "./pdf.css";

/**
 * How long pdf.js gets to open a document before the tile gives up on it.
 *
 * Enormously generous, and meant to be: the bytes are already in memory by the
 * time this starts, and `getDocument().promise` only has to reach the trailer
 * and the catalog — pdf.js reads pages lazily after that. A file that needs
 * three quarters of a minute to get that far is a file pdf.js is not going to
 * open. The number exists for the failure this plugin has actually shipped,
 * which is a promise that never settles at all (see `pdfjs.ts`), and AGENTS.md
 * is explicit that a hang reports nothing and is strictly worse than a failure.
 */
const OPEN_MS = 45_000;

/** The PDF magic number. Cheap, and a much better error than pdf.js's. */
function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d //   -
  );
}

/**
 * Turns a pdf.js load failure into the contract's vocabulary.
 *
 * Every detail carries {@link pdfEnvironment} with it. The dev self-test panel
 * is stripped from release builds — which is where these failures are seen — so
 * this line is the only thing that tells a user's screenshot apart from another
 * user's screenshot: which engine, which mode, which built-ins were missing.
 * Two macOS round trips were spent learning that.
 */
function describeLoadFailure(thrown: unknown, name: string): ViewerLoadError {
  const detail = `${thrown instanceof Error ? thrown.message : String(thrown)} [${pdfEnvironment()}]`;

  // Matched by name: pdf.js throws `PasswordException` but does not export the
  // class from its public entry point, so `instanceof` is not available.
  if (thrown instanceof Error && thrown.name === "PasswordException") {
    return new ViewerLoadError({
      code: "password-required",
      // Phase 07 owns credentials; until then this is an honest dead end rather
      // than a silent failure or a half-built password prompt.
      message: `${name} is password-protected, which is not supported yet.`,
      detail,
      recoverable: false,
      cause: thrown,
    });
  }

  if (thrown instanceof pdfjs.InvalidPDFException) {
    return new ViewerLoadError({
      code: "corrupt",
      message: `${name} is not a readable PDF.`,
      detail,
      recoverable: false,
      cause: thrown,
    });
  }

  return new ViewerLoadError({
    code: "internal",
    message: `${name} could not be opened.`,
    detail,
    recoverable: true,
    cause: thrown,
  });
}

/**
 * Whether the document has any text worth calling searchable.
 *
 * Bounded to the first few pages: see `TEXT_PROBE_PAGES` for why one is not
 * enough and why the whole document is too many.
 */
async function probeForText(document_: PdfDocument): Promise<boolean> {
  const limit = Math.min(document_.numPages, TEXT_PROBE_PAGES);
  for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
    try {
      const page = await document_.getPage(pageNumber);
      const content = await page.getTextContent();
      let characters = 0;
      for (const item of content.items) {
        const str = (item as { str?: string }).str;
        if (typeof str === "string") characters += str.trim().length;
      }
      if (characters >= MIN_TEXT_CHARS) return true;
    } catch {
      // A page that will not yield text is evidence of nothing either way.
    }
  }
  return false;
}

export async function mountPdf(
  container: HTMLElement,
  file: FileHandle,
  options?: ViewerMountOptions,
): Promise<ViewerInstance> {
  options?.signal?.throwIfAborted();

  let bytes: Uint8Array;
  try {
    bytes = await file.read();
  } catch (thrown) {
    throw new ViewerLoadError({
      code: "not-found",
      message: `${file.name} could not be read.`,
      detail: thrown instanceof Error ? thrown.message : String(thrown),
      recoverable: true,
      cause: thrown,
    });
  }
  options?.signal?.throwIfAborted();

  if (!looksLikePdf(bytes)) {
    throw new ViewerLoadError({
      code: "corrupt",
      message: `${file.name} does not look like a PDF.`,
      detail: "the file does not begin with the %PDF- header",
      recoverable: false,
    });
  }

  // pdf.js transfers the buffer to its worker, which detaches it — and the
  // `FileHandle` memoizes those bytes for the thumbnail and search paths. So it
  // gets a copy, and the handle's array stays usable.
  //
  // `loadPdfDocument` rather than `getDocument`: the worker has to be started
  // and *measured* before the library builds anything (see `pdfjs.ts`, "The
  // worker is started from source"). It is awaited once per session; every
  // later open resolves immediately.
  let task: PdfLoadingTask;
  try {
    task = await loadPdfDocument({ data: new Uint8Array(bytes) });
  } catch (thrown) {
    // Reaching here means pdf.js could not be started at all, in a worker or on
    // this thread — which is about the installation, not about this file.
    throw new ViewerLoadError({
      code: "internal",
      message: `${file.name} could not be opened.`,
      detail: `${thrown instanceof Error ? thrown.message : String(thrown)} [${pdfEnvironment()}]`,
      recoverable: true,
      cause: thrown,
    });
  }
  // Registered before the abort is re-checked, and the check is deliberately
  // left to the one after `task.promise` below: a signal that aborted while the
  // worker was starting never fires this listener, so throwing here would leak
  // the task it was meant to destroy.
  options?.signal?.addEventListener("abort", () => void task.destroy(), { once: true });

  let document_: PdfDocument;
  try {
    document_ = await withinDeadline(task.promise, OPEN_MS, `opening ${file.name}`);
  } catch (thrown) {
    // A rejected load leaves a task nothing else will ever close: there is no
    // document, so no tile, so no `destroy()`. Idempotent, and the only cover
    // for this exit when pdf.js is running on the main thread.
    void task.destroy().catch(() => {});
    throw describeLoadFailure(thrown, file.name);
  }

  if (options?.signal?.aborted) {
    await document_.destroy();
    options.signal.throwIfAborted();
  }

  try {
    // Page 1's box seeds every placeholder, so the scrollbar is right before
    // anything is rendered. Pages that differ correct themselves on their first
    // real render (see `PdfPageView.render`).
    const first = await withinDeadline(
      document_.getPage(1),
      OPEN_MS,
      `reading the first page of ${file.name}`,
    );
    const box = first.getViewport({ scale: 1 });
    const pageSizes = Array.from({ length: document_.numPages }, () => ({
      width: box.width,
      height: box.height,
    }));

    // Bounded for the same reason `task.promise` is: every await in here is
    // pdf.js waiting on the worker, and pdf.js puts no deadline on any of them.
    const hasText = await withinDeadline(
      probeForText(document_),
      OPEN_MS,
      `checking ${file.name} for text`,
    );
    options?.signal?.throwIfAborted();

    return new PdfViewerInstance({
      container,
      file,
      document: document_,
      pageSizes,
      hasText,
      initialState: options?.initialState,
      host: options?.host,
    });
  } catch (thrown) {
    // Anything after `getDocument` resolved owns the document, so a failure here
    // has to give the worker back before it propagates.
    await document_.destroy().catch(() => {});
    if (thrown instanceof ViewerLoadError) throw thrown;
    throw describeLoadFailure(thrown, file.name);
  }
}
