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

import {
  isRenderCancellation,
  isTextLayerCancellation,
  pdfjs,
  withinDeadline,
  type PdfDocument,
  type PdfPage,
} from "./pdfjs";

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
 * How long one page gets to draw before the strip says so.
 *
 * Generous — a dense page on the main thread is genuinely slow — but finite,
 * because the failure this plugin keeps meeting on unfamiliar webviews is a
 * render that neither finishes nor fails. AGENTS.md's rule again: a hang
 * reports nothing and is strictly worse than a failure.
 */
const RENDER_MS = 30_000;

/**
 * How long each half of building a text layer gets: reading the page's text,
 * and laying it out.
 *
 * Shorter than a render because neither half rasterises anything, and for the
 * same reason a render has a deadline at all: `getTextContent()` is a round trip
 * to the decoder, and the way this plugin's dependencies fail on an unfamiliar
 * webview is by never answering. Without this, an unanswered text request is a
 * document whose words cannot be selected, with nothing anywhere saying why.
 */
const TEXT_LAYER_MS = 20_000;

/** The square the ink probe shrinks a page into. See {@link hasInk}. */
const INK_PROBE = 32;

function describe(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Whether anything at all was drawn onto `canvas`.
 *
 * Worth asking because a canvas that comes back *empty* is a real WebKit
 * failure mode and a completely silent one: `render()` resolves, the page
 * reports success, and the tile shows paper. `selftest.ts` ("Where pdf.js is
 * allowed to draw") checks the same property in the lab; this is that check in
 * production, where it is the only witness there is.
 *
 * Shrunk into a 32-pixel square first, so the cost is one `drawImage` and one
 * tiny `getImageData` rather than reading thirty megabytes back per page.
 * Averaging is fine for the question being asked: a page with one line of text
 * is no longer uniformly white once it is that small.
 *
 * Answers `true` when it cannot tell. A wrong "nothing was drawn" would put an
 * error on a page that rendered correctly, which is worse than missing one.
 */
function hasInk(canvas: HTMLCanvasElement): boolean {
  try {
    const probe = document.createElement("canvas");
    probe.width = INK_PROBE;
    probe.height = INK_PROBE;
    const context = probe.getContext("2d", { willReadFrequently: true });
    if (!context) return true;
    context.drawImage(canvas, 0, 0, INK_PROBE, INK_PROBE);
    const { data } = context.getImageData(0, 0, INK_PROBE, INK_PROBE);
    for (let at = 0; at < data.length; at += 4) {
      if (data[at]! < 250 || data[at + 1]! < 250 || data[at + 2]! < 250) return true;
    }
    return false;
  } catch {
    return true;
  }
}

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

  /**
   * Whether the last completed render put anything on the canvas.
   *
   * `true` until proven otherwise, including when it could not be measured. The
   * view watches this across pages: one blank page is a blank page, and every
   * page blank is a webview that is not drawing.
   */
  paintedInk = true;

  /** The scale the canvas was rendered at, so a stale page can be spotted. */
  #renderedScale = 0;

  /**
   * The in-flight render, or `true` for a slot claimed before the first
   * `await`. Claiming early is what stops a concurrent scroll from starting a
   * second render of the same page.
   */
  #renderTask: pdfjs.RenderTask | true | null = null;

  /**
   * Which attempt owns {@link #renderTask}. Bumped by every cancellation.
   *
   * The claim above is necessary and was not sufficient, because a render can
   * lose it while it is suspended and has nothing to cancel: between claiming
   * the slot and `page.render()` there is an `await` on `getPage`, and
   * {@link cancelRender} arriving in that window used to just set the slot back
   * to `null` — the suspended call held no task yet, so there was nothing to
   * stop, and it woke up and drew anyway. Meanwhile the freed slot let the next
   * scroll or zoom start a *second* render of the same page, and pdf.js refuses
   * two renders of one canvas outright: "Cannot use the same canvas during
   * multiple render() operations". That reached a user as a page that renders
   * correctly with an error in the strip above it, on macOS, where the first
   * `getPage` of a document is slow enough for the opening fit-to-width to land
   * inside the window.
   *
   * So cancellation is a number that goes up rather than a task to stop, and a
   * suspended render compares it on the far side of every `await`. One that no
   * longer owns the slot draws nothing and touches nothing — the state it would
   * be writing belongs to whoever cancelled it.
   */
  #renderAttempt = 0;
  #textLayerTask: pdfjs.TextLayer | null = null;
  #textLayerScale = 0;

  /** The scale a build is running at, or `null` when none is. */
  #textLayerBuilding: number | null = null;
  /** {@link #renderAttempt} for text layers. See {@link buildTextLayer}. */
  #textLayerAttempt = 0;

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
    // First, and whether or not there is a task: a render that is still
    // suspended has no task to cancel, and this is the only thing that stops it.
    this.#renderAttempt += 1;
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
    const attempt = ++this.#renderAttempt;
    /** Whether this call still owns the slot it claimed. See {@link #renderAttempt}. */
    const mine = (): boolean => this.#renderAttempt === attempt;
    /** Gives the slot back, unless it now belongs to a later attempt. */
    const release = (): void => {
      if (mine()) this.#renderTask = null;
    };

    let page: PdfPage;
    try {
      page = await document_.getPage(this.pageNumber);
    } catch {
      release();
      return;
    }
    if (!mine() || !isCurrent()) {
      release();
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

    // `willReadFrequently` is pdf.js's choice, not ours, and getting it here is
    // the only way it survives. `InternalRenderTask` ignores the context it is
    // handed whenever a `canvas` is also passed — which it always is, because
    // `render()` defaults `canvas` to `canvasContext.canvas` — and asks the
    // canvas for `{ alpha: false, willReadFrequently: !enableHWA }` itself.
    // `getContext` returns whichever context was created *first*, so creating
    // one here without the hint silently overrode that and left every page on an
    // accelerated backing store. `selftest.ts` ("Where pdf.js is allowed to
    // draw") already records what an accelerated backing store does on WebKit
    // when the window is not being composited: the render never completes, and
    // the tile shows paper. Matching pdf.js's request means the two agree and
    // the canvas is the software one it expects to read back from.
    const context = this.canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    if (!context) {
      release();
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

    // Two things are watched while the render runs, because the way this fails
    // on an unfamiliar webview is silence rather than an exception.
    //
    // `onContinue` is handed pdf.js's own scheduler and calling it is exactly
    // what pdf.js does when nothing is listening, so counting the calls changes
    // nothing and tells us whether drawing ever started — the operator list has
    // to arrive from the decoder before the first one.
    //
    // The frame probe answers the other half. pdf.js drives every continuation
    // through `requestAnimationFrame`, so a webview that has stopped painting
    // stops the render dead without failing it, and the canvas keeps the white
    // fill above. That is indistinguishable from a blank page by eye, and the
    // difference between the two is the whole diagnosis.
    let continued = 0;
    task.onContinue = (cont: () => void): void => {
      continued += 1;
      cont();
    };
    let framesFired = false;
    const frame = requestAnimationFrame(() => {
      framesFired = true;
    });

    try {
      await withinDeadline(task.promise, RENDER_MS, () => {
        const frames = framesFired
          ? "animation frames are firing"
          : "and this webview is not firing animation frames";
        return continued === 0
          ? `page ${this.pageNumber} never began drawing — no operator list arrived (${frames})`
          : `page ${this.pageNumber} stopped drawing after ${continued} continuation(s) (${frames})`;
      });
    } catch (thrown) {
      cancelAnimationFrame(frame);
      release();
      // Cancellation is the *normal* case here — a scroll past, a zoom, a
      // closed tile — and must stay silent. Anything else is worth reporting.
      if (isRenderCancellation(thrown)) return;
      // Our own deadline leaves the task running, and pdf.js keeps this canvas
      // in its in-use set until the task ends — so a later attempt at this page
      // would be refused outright rather than retried.
      try {
        task.cancel();
      } catch {
        // Already finished; nothing to stop.
      }
      if (isCurrent()) throw thrown;
      return;
    }

    cancelAnimationFrame(frame);
    // A render that lost the slot while it was drawing can still land here —
    // it finished in the gap between the cancellation and the rejection. Its
    // pixels are fine and stay on the canvas, but the bookkeeping below belongs
    // to whichever attempt owns the page now, so leave it alone.
    const owned = mine();
    release();
    if (!owned || !isCurrent()) return;

    this.rendered = true;
    this.#renderedScale = scale;
    this.paintedInk = hasInk(this.canvas);
  }

  /**
   * Builds the selectable text overlay.
   *
   * pdf.js positions transparent spans against `--total-scale-factor` and sizes
   * the container through `setLayerDimensions`, so both have to be set before
   * rendering or every span lands in the top-left corner.
   *
   * ## Why this throws instead of returning
   *
   * It used to swallow everything: two bare `catch { return; }` clauses, a
   * constructor outside any `try`, and no deadline. Every way this can fail
   * therefore produced the *same* observable state as a page that simply has no
   * text — an inert layer, nothing in the strip, nothing in the console — and
   * "selection does not work" is then a sentence with a dozen causes and no way
   * to tell them apart from outside the webview. That is the exact shape of the
   * blank-page bug (AGENTS.md, open item 4b) one layer further on, and it is
   * fixed the same way: **report rather than guess.**
   *
   * A failure here is not a failed document — the page still renders and still
   * scrolls — so it is thrown for `view.ts` to route into the status strip and
   * left non-fatal. A page that genuinely has no text (a scan) is not a failure
   * and does not throw.
   *
   * ## One build at a time
   *
   * The settle pass asks for a layer after every scroll and every completed
   * render, and reading a dense page's text can easily outlast the settle
   * interval — so this can be re-entered while the previous call is still
   * waiting on the decoder. Nothing about the old guard stopped that: it asked
   * whether the layer *exists*, and while the first call is suspended it does
   * not. Both calls would then `replaceChildren()` the same container and append
   * into it from two `TextLayer`s at once, which is a page whose words are
   * selectable twice. {@link #textLayerAttempt} is the render slot's mechanism
   * applied to the same problem.
   */
  async buildTextLayer(
    document_: PdfDocument,
    scale: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (this.hasTextLayer && Math.abs(this.#textLayerScale - scale) < 0.001) return;
    // A build already under way for this scale will finish on its own. One for
    // a *stale* scale is cancelled instead: its spans would be positioned for a
    // zoom level nobody is looking at any more.
    if (this.#textLayerBuilding !== null && Math.abs(this.#textLayerBuilding - scale) < 0.001) {
      return;
    }
    this.#cancelTextLayer();
    const attempt = ++this.#textLayerAttempt;
    const mine = (): boolean => this.#textLayerAttempt === attempt;
    this.#textLayerBuilding = scale;
    try {
      await this.#buildTextLayer(document_, scale, isCurrent, mine);
    } finally {
      if (mine()) this.#textLayerBuilding = null;
    }
  }

  /** {@link buildTextLayer}'s body, with the slot already claimed. */
  async #buildTextLayer(
    document_: PdfDocument,
    scale: number,
    isCurrent: () => boolean,
    mine: () => boolean,
  ): Promise<void> {
    let page: PdfPage;
    let content: Awaited<ReturnType<PdfPage["getTextContent"]>>;
    try {
      // pdf.js caches page proxies, so this does not re-fetch anything.
      page = await document_.getPage(this.pageNumber);
      // Deadlined for the same reason the render is: this is a round trip to
      // the decoder, and the failure this plugin keeps meeting on unfamiliar
      // webviews is one that never settles rather than one that rejects.
      content = await withinDeadline(
        page.getTextContent(),
        TEXT_LAYER_MS,
        `reading the text of page ${this.pageNumber}`,
      );
    } catch (thrown) {
      this.#syncEmptyClass();
      if (!mine() || !isCurrent()) return;
      throw new Error(`its text could not be read — ${describe(thrown)}`);
    }
    if (!mine() || !isCurrent() || !this.rendered) return;

    if (content.items.length === 0) {
      // A scanned page. Not an error, and not worth retrying on every settle.
      this.textLayer.classList.add("is-empty");
      this.#textLayerScale = scale;
      return;
    }

    this.textLayer.replaceChildren();
    const viewport = page.getViewport({ scale });
    this.textLayer.style.setProperty("--total-scale-factor", String(scale));

    try {
      // Inside the `try`: `setLayerDimensions` and the `TextLayer` constructor
      // both run engine code on the page — CSS `round()`, `Promise.withResolvers`,
      // a canvas context, a layout measurement — and a throw from either used to
      // escape as an unhandled rejection with the layer left inert.
      pdfjs.setLayerDimensions(this.textLayer, viewport);
      const layer = new pdfjs.TextLayer({
        textContentSource: content,
        container: this.textLayer,
        viewport,
      });
      this.#textLayerTask = layer;
      await withinDeadline(
        layer.render(),
        TEXT_LAYER_MS,
        `laying out the text of page ${this.pageNumber}`,
      );
    } catch (thrown) {
      // A cancelled layer is this class cancelling it — a scroll, a zoom, a
      // closing tile — and says nothing about the engine.
      if (mine()) this.#textLayerTask = null;
      this.#syncEmptyClass();
      if (!mine() || !isCurrent() || isTextLayerCancellation(thrown)) return;
      throw new Error(`its text could not be laid out — ${describe(thrown)}`);
    }
    if (!mine() || !isCurrent()) return;

    this.#textLayerTask = null;
    this.#textLayerScale = scale;
    this.#syncEmptyClass();
  }

  /**
   * Keeps `is-empty` — which is what takes the pointer away from the layer —
   * saying what is actually in the layer.
   *
   * Called on every exit, including the failing ones. A partial layer that kept
   * the class was the worst of the old behaviour: spans over the words, the
   * text cursor over them, and a drag that selected nothing.
   */
  #syncEmptyClass(): void {
    this.textLayer.classList.toggle("is-empty", this.textLayer.childElementCount === 0);
  }

  #cancelTextLayer(): void {
    // First, for the reason `cancelRender` bumps its counter first: a build that
    // has not reached its `TextLayer` yet has nothing here to cancel.
    this.#textLayerAttempt += 1;
    this.#textLayerBuilding = null;
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
