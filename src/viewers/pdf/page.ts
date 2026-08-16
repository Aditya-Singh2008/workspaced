/**
 * One page: its element, its canvas, its text layer, and the rules for giving
 * all three back.
 *
 * ## Rendered straight to the visible canvas
 *
 * There is no offscreen buffer and no compositing step: pdf.js draws into the
 * canvas the user is looking at, and inversion is a CSS `filter` on that
 * element, applied by the GPU for free.
 *
 * The alternative — render into a retained copy, then paint the visible canvas
 * from it — buys the ability to alter *parts* of a page, and costs a full-size
 * allocation and a copy per page plus a repaint on every settings change.
 * Nothing here needs to alter part of a page, so the cost has no buyer. It also
 * means a live page holds half as much, which is what lets the virtualizer keep
 * more pages warm while scrolling.
 *
 * ## The text layer is deferred
 *
 * Building it means creating one absolutely-positioned span per text run —
 * hundreds of DOM nodes for a dense page. During a fast scroll that is the
 * single most expensive thing the viewer can do, and it is invisible: nobody
 * selects text on a page that is on screen for 80ms. So the canvas renders
 * immediately and the text layer waits for the scroll to settle (see
 * `view.ts`).
 */

import { isRenderCancellation, pdfjs, type PdfDocument, type PdfPage } from "./pdfjs";

/**
 * The ceiling on rendered pixels per CSS pixel. A 3x display already renders
 * nine times the pixels of a 1x one; beyond that is a difference nobody can see
 * on a document page, paid for on every scroll.
 */
const MAX_RENDER_RATIO = 3;

/**
 * The most pixels one page's canvas may hold, whatever the ratio works out to.
 *
 * pdf.js's own viewer default (`maxCanvasPixels`, 2^24), and it is here for the
 * same reason: the ratio above is a quality knob, but a poster-sized page at a
 * deep zoom multiplies it into an allocation that fails — and a canvas that
 * fails to allocate renders nothing at all. The ratio gives way instead.
 */
const MAX_CANVAS_PIXELS = 2 ** 24;

/**
 * Rendered pixels per CSS pixel for a page of this size.
 *
 * `width`/`height` are the page's box at the current scale, in CSS pixels.
 *
 * The answer is the device pixel ratio and nothing else. Asking for *more* than
 * the display can show does not add detail, it destroys it: the surplus has to
 * come back out somewhere, and where it comes out is WebKit's compositor, whose
 * canvas downscale is a cheap bilinear sample rather than a filtered one. It
 * drops rows and columns of an antialiased glyph instead of averaging them, so
 * stems come back uneven, hairlines drop out, and the page reads grainy at
 * every zoom level — which is exactly the artefact supersampling was meant to
 * avoid. Rendering one canvas pixel per device pixel means the compositor has
 * no scaling to do at all, and pdf.js's own antialiasing survives to the screen.
 */
function renderRatio(width: number, height: number): number {
  const wanted = Math.min(window.devicePixelRatio || 1, MAX_RENDER_RATIO);
  const area = Math.max(1, width * height);
  // The cap wins when it binds: a canvas that fails to allocate renders
  // nothing, which is worse than a page that is merely soft.
  return Math.max(0.1, Math.min(wanted, Math.sqrt(MAX_CANVAS_PIXELS / area)));
}

export class PdfPageView {
  readonly pageNumber: number;

  /** The sized placeholder. Present from the moment the document loads. */
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** A `div` specifically: pdf.js's `setLayerDimensions` requires one. */
  readonly textLayer: HTMLDivElement;

  /** Unscaled page box, in PDF points. Corrected on first render. */
  dimensions: { width: number; height: number };

  /** Whether the canvas holds pixels for the current scale. */
  rendered = false;

  /** The scale the canvas was rendered at, so a stale page can be spotted. */
  #renderedScale = 0;

  /**
   * The in-flight render, or `true` for a slot claimed before the first
   * `await`. Claiming early is what stops a concurrent scroll from starting a
   * second render of the same page.
   */
  #renderTask: pdfjs.RenderTask | true | null = null;
  #textLayerTask: pdfjs.TextLayer | null = null;
  #textLayerScale = 0;

  constructor(pageNumber: number, dimensions: { width: number; height: number }) {
    this.pageNumber = pageNumber;
    this.dimensions = dimensions;

    const root = document.createElement("div");
    root.className = "pdf-page";
    root.dataset.page = String(pageNumber);

    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page-canvas";

    const textLayer = document.createElement("div");
    // pdf.js's own class name: its text layer contract, reproduced minimally in
    // `pdf.css`, is written against it.
    textLayer.className = "textLayer is-empty";

    root.append(canvas, textLayer);

    this.root = root;
    this.canvas = canvas;
    this.textLayer = textLayer;
  }

  get busy(): boolean {
    return this.#renderTask !== null;
  }

  /** Whether this page holds pixels, current or stale. */
  get holdsPixels(): boolean {
    return this.canvas.width > 0;
  }

  /** Whether the text layer has been built for the current scale. */
  get hasTextLayer(): boolean {
    return this.textLayer.childElementCount > 0;
  }

  /**
   * Sizes the placeholder for the current scale.
   *
   * The canvas is stretched to fill it by CSS rather than resized here, so a
   * scale change is visible immediately at the old resolution and only gets
   * sharp again when the re-render lands. The text layer needs no rebuild
   * either: pdf.js positions every span against `--total-scale-factor` and
   * sizes the container with a `calc()` over the same variable.
   */
  layout(scale: number): void {
    const box = this.#cssBox(scale);
    this.root.style.width = `${box.width}px`;
    this.root.style.height = `${box.height}px`;
    this.textLayer.style.setProperty("--total-scale-factor", String(scale));
  }

  /**
   * The page's box at this scale, in whole CSS pixels.
   *
   * Whole pixels because a box of 1375.77px is painted into 1376 of them, and
   * the canvas stretched across it would then be resampled by 1375.77/1376 —
   * enough to smear every glyph on the page. Rounding here and rendering to
   * *this* number rather than to the raw viewport is what keeps the bitmap and
   * the box the same size. `layout` and `render` must agree exactly, which is
   * why they both come through here rather than each doing the arithmetic.
   */
  #cssBox(scale: number): { width: number; height: number } {
    return {
      width: Math.max(1, Math.round(this.dimensions.width * scale)),
      height: Math.max(1, Math.round(this.dimensions.height * scale)),
    };
  }

  /** Whether the pixels on the canvas were rendered at a different scale. */
  isStaleAt(scale: number): boolean {
    return this.rendered && Math.abs(this.#renderedScale - scale) > 0.001;
  }

  /**
   * Marks the pixels as belonging to a stale scale without throwing them away.
   *
   * Freeing here instead would blank every visible page for the duration of the
   * re-render, which is the difference between zooming and flickering.
   */
  markStale(): void {
    this.cancelRender();
    this.rendered = false;
  }

  /** Aborts an in-flight render. Used when a page scrolls out of range. */
  cancelRender(): void {
    if (this.#renderTask && this.#renderTask !== true) {
      try {
        this.#renderTask.cancel();
      } catch {
        /* already finished */
      }
    }
    this.#renderTask = null;
  }

  /**
   * Renders this page's canvas.
   *
   * Resolves when the pixels are on screen. The text layer is *not* built here
   * — see the module comment, and {@link buildTextLayer}.
   */
  async render(
    document_: PdfDocument,
    scale: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (this.busy) return;
    if (this.rendered && !this.isStaleAt(scale)) return;
    this.#renderTask = true;

    let page: PdfPage;
    try {
      page = await document_.getPage(this.pageNumber);
    } catch {
      this.#renderTask = null;
      return;
    }
    if (!isCurrent()) {
      this.#renderTask = null;
      return;
    }

    // The placeholder was sized from page 1's box. A document with mixed page
    // sizes needs correcting the first time each page is actually loaded.
    const unscaled = page.getViewport({ scale: 1 });
    if (
      Math.abs(unscaled.width - this.dimensions.width) > 0.5 ||
      Math.abs(unscaled.height - this.dimensions.height) > 0.5
    ) {
      this.dimensions = { width: unscaled.width, height: unscaled.height };
      this.layout(scale);
    }

    const viewport = page.getViewport({ scale });
    const box = this.#cssBox(scale);
    const ratio = renderRatio(box.width, box.height);
    const pixelWidth = Math.max(1, Math.round(box.width * ratio));
    const pixelHeight = Math.max(1, Math.round(box.height * ratio));

    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) {
      this.#renderTask = null;
      return;
    }

    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    // Resizing a canvas leaves it opaque black under `alpha: false`, and a
    // black rectangle is a far worse thing to flash during a scroll than paper.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, pixelWidth, pixelHeight);
    this.root.classList.add("is-rendered");

    // Derived from the canvas rather than set to `ratio`, so the two roundings
    // above are absorbed here: the page is drawn to exactly the pixels that
    // exist, filling the bitmap edge to edge with nothing clipped and no blank
    // strip left along the right or the bottom.
    const task = page.render({
      canvas: this.canvas,
      canvasContext: context,
      viewport,
      transform: [pixelWidth / viewport.width, 0, 0, pixelHeight / viewport.height, 0, 0],
      background: "#ffffff",
    });
    this.#renderTask = task;

    try {
      await task.promise;
    } catch (thrown) {
      this.#renderTask = null;
      // Cancellation is the *normal* case here — a scroll past, a zoom, a
      // closed tile — and must stay silent. Anything else is worth reporting.
      if (isCurrent() && !isRenderCancellation(thrown)) throw thrown;
      return;
    }

    this.#renderTask = null;
    if (!isCurrent()) return;

    this.rendered = true;
    this.#renderedScale = scale;
  }

  /**
   * Builds the selectable text overlay.
   *
   * pdf.js positions transparent spans against `--total-scale-factor` and sizes
   * the container through `setLayerDimensions`, so both have to be set before
   * rendering or every span lands in the top-left corner.
   */
  async buildTextLayer(
    document_: PdfDocument,
    scale: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (this.hasTextLayer && Math.abs(this.#textLayerScale - scale) < 0.001) return;
    this.#cancelTextLayer();

    let page: PdfPage;
    let content;
    try {
      // pdf.js caches page proxies, so this does not re-fetch anything.
      page = await document_.getPage(this.pageNumber);
      content = await page.getTextContent();
    } catch {
      this.textLayer.classList.add("is-empty");
      return;
    }
    if (!isCurrent() || !this.rendered) return;

    if (content.items.length === 0) {
      // A scanned page. Not an error, and not worth retrying on every settle.
      this.textLayer.classList.add("is-empty");
      this.#textLayerScale = scale;
      return;
    }

    this.textLayer.replaceChildren();
    const viewport = page.getViewport({ scale });
    this.textLayer.style.setProperty("--total-scale-factor", String(scale));
    pdfjs.setLayerDimensions(this.textLayer, viewport);

    const layer = new pdfjs.TextLayer({
      textContentSource: content,
      container: this.textLayer,
      viewport,
    });
    this.#textLayerTask = layer;

    try {
      await layer.render();
    } catch {
      return;
    }
    if (!isCurrent()) return;

    this.#textLayerTask = null;
    this.#textLayerScale = scale;
    this.textLayer.classList.toggle("is-empty", !this.textLayer.childElementCount);
  }

  #cancelTextLayer(): void {
    try {
      this.#textLayerTask?.cancel();
    } catch {
      /* already finished */
    }
    this.#textLayerTask = null;
  }

  /**
   * Releases every resource this page holds, leaving the placeholder in place.
   *
   * Called both when a page scrolls far out of view and on teardown, so it has
   * to be idempotent and must not touch its own DOM node.
   */
  free(): void {
    this.cancelRender();
    this.#cancelTextLayer();
    this.textLayer.replaceChildren();
    this.textLayer.classList.add("is-empty");
    this.#textLayerScale = 0;

    // Zero-sizing is what actually releases the backing store; a canvas element
    // left at full size holds its pixels for as long as it is referenced.
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.root.classList.remove("is-rendered");
    this.rendered = false;
    this.#renderedScale = 0;
  }

  /** `free()` plus the DOM. Only on teardown. */
  destroy(): void {
    this.free();
    this.root.remove();
  }
}
