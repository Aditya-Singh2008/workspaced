/**
 * Page thumbnails for the contract's `thumbnail()` method.
 *
 * Three decisions worth stating, because the original implementation's
 * thumbnails were broken and the phase brief asks for them to actually work
 * this time:
 *
 * 1. **Rendered from the document, not from the page view.** A thumbnail must
 *    be available for a page that has never been scrolled to, and must not
 *    disappear when that page is freed by the virtualizer. So this renders its
 *    own small viewport straight from pdf.js and shares nothing with `page.ts`.
 *
 * 2. **Natural colours, never the inversion.** A thumbnail's job is
 *    identifying a page, and an inverted thumbnail of a scanned page is a
 *    black rectangle with a pale smear on it — identical to every other
 *    inverted scanned page. The full-size view is where the inversion is
 *    useful; the rail is where the document is recognised. (This is the
 *    decision the brief asks to be made and documented.)
 *
 * 3. **Cached and bounded.** The cache is keyed by page *and* by requested
 *    width, so the sidebar's 120px rail and a future 240px grid do not fight
 *    over one entry. Entries are `ImageBitmap`s the *consumer* owns per the
 *    contract, so what is cached here is the source canvas' data URL rather
 *    than the bitmap — a cache of bitmaps would hand the same one to two
 *    callers and the first `close()` would break the second.
 */

import { ViewerLoadError, type ThumbnailRequest, type ThumbnailResult } from "../contract";
import { isRenderCancellation, type PdfDocument } from "./pdfjs";

/** Bounded so a 900-page document cannot fill memory with previews. */
const MAX_CACHED = 120;

interface CacheEntry {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

export class PdfThumbnailCache {
  #document: PdfDocument;
  /** Insertion-ordered, which makes the eviction below plain FIFO. */
  #cache = new Map<string, CacheEntry>();
  #inFlight = new Map<string, Promise<CacheEntry>>();
  #disposed = false;

  constructor(document_: PdfDocument) {
    this.#document = document_;
  }

  async get(request: ThumbnailRequest): Promise<ThumbnailResult> {
    if (this.#disposed) {
      throw new ViewerLoadError({
        code: "internal",
        message: "This document is no longer open.",
      });
    }
    request.signal?.throwIfAborted();

    const pageNumber = (request.subdivision ?? 0) + 1;
    const key = `${pageNumber}@${Math.round(request.maxWidth)}x${Math.round(request.maxHeight)}`;

    const cached = this.#cache.get(key);
    if (cached) return toResult(cached);

    // Two callers asking for the same preview at the same moment — the rail
    // scrolling back over a page it already requested — share one render.
    let pending = this.#inFlight.get(key);
    if (!pending) {
      pending = this.#render(pageNumber, request).finally(() =>
        this.#inFlight.delete(key),
      );
      this.#inFlight.set(key, pending);
    }

    const entry = await pending;
    request.signal?.throwIfAborted();

    if (!this.#disposed) {
      this.#cache.set(key, entry);
      while (this.#cache.size > MAX_CACHED) {
        const oldest = this.#cache.keys().next();
        if (oldest.done) break;
        this.#cache.delete(oldest.value);
      }
    }
    return toResult(entry);
  }

  async #render(pageNumber: number, request: ThumbnailRequest): Promise<CacheEntry> {
    const page = await this.#document.getPage(pageNumber);
    const unscaled = page.getViewport({ scale: 1 });

    // Fit inside the request's box, never upscale past 1:1 — a thumbnail bigger
    // than the page is wasted memory.
    const scale = Math.min(
      request.maxWidth / unscaled.width,
      request.maxHeight / unscaled.height,
      1,
    );
    const viewport = page.getViewport({ scale: Math.max(scale, 0.01) });

    // Capped at 2 rather than the full device ratio: a preview does not need
    // 3x pixels, and a 900-page rail at 3x is where memory actually goes.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio));

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new ViewerLoadError({
        code: "internal",
        message: "Could not create a page preview.",
        detail: "2d canvas context unavailable",
      });
    }

    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      // White, always: this is the natural-colour decision above. A scanned page
      // with no background of its own must not come out transparent-on-dark.
      background: "#ffffff",
    });

    request.signal?.addEventListener("abort", () => task.cancel(), { once: true });

    try {
      await task.promise;
    } catch (thrown) {
      if (isRenderCancellation(thrown)) request.signal?.throwIfAborted();
      throw thrown;
    }

    const entry: CacheEntry = {
      // JPEG rather than PNG: a page is photographic enough that PNG is several
      // times larger for no visible gain at thumbnail size.
      dataUrl: canvas.toDataURL("image/jpeg", 0.82),
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
    };

    canvas.width = 0;
    canvas.height = 0;
    return entry;
  }

  dispose(): void {
    this.#disposed = true;
    this.#cache.clear();
    this.#inFlight.clear();
  }
}

function toResult(entry: CacheEntry): ThumbnailResult {
  return {
    kind: "dataUrl",
    dataUrl: entry.dataUrl,
    width: entry.width,
    height: entry.height,
  };
}
