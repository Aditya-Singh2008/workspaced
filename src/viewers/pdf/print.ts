/**
 * Printing.
 *
 * The requirement is that printing uses **the original file**, untouched by the
 * inversion pipeline and not limited to whichever pages the virtualizer happens
 * to have rendered. Two routes get there, and which one is available is a
 * property of the webview rather than of this app:
 *
 *   - **Native.** Hand the original bytes to a hidden frame and let the webview
 *     print its own PDF renderer's output. Vector, every page, exactly the file
 *     on disk. WebView2 (Windows) and WKWebView (macOS) both have a PDF
 *     renderer, so this is the route there.
 *
 *   - **Rasterised.** webkit2gtk has no PDF renderer at all — a frame pointed
 *     at a PDF on Linux displays nothing, and printing it prints nothing. So on
 *     Linux every page is re-rendered from the *original document* through
 *     pdf.js at print resolution into a print-only overlay. Still the original
 *     file and still every page; raster rather than vector is the cost, and it
 *     is the difference between printing and not printing.
 *
 * The branch is on {@link currentPlatform}, which AGENTS.md names as the only
 * place platform branching belongs.
 */

import { currentPlatform } from "../../platform";
import type { FileHandle } from "../../files";
import type { PdfDocument } from "./pdfjs";

/** Print at 150 DPI relative to the PDF's 72 DPI user space. */
const PRINT_SCALE = 150 / 72;

/** Give up on `afterprint` after this long and clean up anyway. */
const CLEANUP_FALLBACK_MS = 60_000;

export interface PrintOptions {
  readonly file: FileHandle;
  readonly document: PdfDocument;
  /** Reports a failure the user needs to know about. */
  readonly onError: (message: string, detail?: string) => void;
}

export async function printDocument(options: PrintOptions): Promise<void> {
  if (currentPlatform() === "linux") {
    await printRasterised(options);
    return;
  }
  const printed = await printViaFrame(options);
  // A frame that never loads, or a webview that refuses to print it, still has
  // to produce paper rather than silence.
  if (!printed) await printRasterised(options);
}

/**
 * The native route: a hidden frame holding the original bytes.
 *
 * Resolves `false` — rather than reporting an error — when the frame cannot be
 * printed, so the caller can fall through to the rasterised route.
 */
async function printViaFrame(options: PrintOptions): Promise<boolean> {
  let url: string | null = null;
  try {
    const bytes = await options.file.read();
    url = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: "application/pdf" }),
    );
  } catch (thrown) {
    options.onError(
      "Could not read the file to print it.",
      thrown instanceof Error ? thrown.message : String(thrown),
    );
    return true; // Reading failed; rasterising would fail for the same reason.
  }

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";

  const objectUrl = url;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (printed: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(printed);
    };
    const cleanup = (): void => {
      frame.remove();
      URL.revokeObjectURL(objectUrl);
    };

    frame.addEventListener("load", () => {
      try {
        const view = frame.contentWindow;
        if (!view) throw new Error("the print frame has no window");
        view.focus();
        view.addEventListener("afterprint", cleanup, { once: true });
        view.print();
        setTimeout(cleanup, CLEANUP_FALLBACK_MS);
        finish(true);
      } catch {
        cleanup();
        finish(false);
      }
    });

    frame.addEventListener("error", () => {
      cleanup();
      finish(false);
    });

    frame.src = objectUrl;
    document.body.append(frame);
  });
}

/**
 * The rasterised route: every page of the original document, re-rendered at
 * print resolution into an element only the printer sees.
 *
 * Rendered fresh from the `PDFDocumentProxy` rather than reusing the view's
 * buffers — those are at screen scale, may be composited with the inversion,
 * and only exist for the handful of pages currently near the viewport. Reusing
 * them is exactly the mistake the requirement is written against.
 */
async function printRasterised(options: PrintOptions): Promise<void> {
  const host = document.createElement("div");
  host.className = "pdf-print-host";
  host.setAttribute("aria-hidden", "true");
  document.body.append(host);

  const cleanup = (): void => {
    for (const canvas of host.querySelectorAll("canvas")) {
      canvas.width = 0;
      canvas.height = 0;
    }
    host.remove();
    document.documentElement.classList.remove("pdf-printing");
  };

  try {
    const count = options.document.numPages;
    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      const page = await options.document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: PRINT_SCALE });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("2d canvas context unavailable");

      await page.render({
        canvas,
        canvasContext: context,
        viewport,
        background: "#ffffff",
      }).promise;

      host.append(canvas);
    }
  } catch (thrown) {
    cleanup();
    options.onError(
      "Could not prepare this document for printing.",
      thrown instanceof Error ? thrown.message : String(thrown),
    );
    return;
  }

  // The class hides the app for the duration of the print, so the workspace
  // chrome does not end up on the paper alongside the pages.
  document.documentElement.classList.add("pdf-printing");
  window.addEventListener("afterprint", cleanup, { once: true });
  setTimeout(cleanup, CLEANUP_FALLBACK_MS);
  window.print();
}
