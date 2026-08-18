/**
 * The scrolling document view: layout, virtualization, navigation and zoom.
 *
 * Everything here is *inside one tile*. The "no hand-rolled layout math" rule
 * in AGENTS.md is about tiling — pixel positions of panes, divider hit-testing,
 * pointer-drag arithmetic between tiles. A document viewer has to know where
 * its own pages sit in its own scroller in order to virtualize at all, and that
 * is a different job; nothing here measures or positions anything the docking
 * library owns.
 *
 * ## Keeping up with a fast scroll
 *
 * Every page has a sized placeholder from the moment the document loads, so the
 * scrollbar is correct immediately and never jumps as pages arrive. What
 * decides whether scrolling *feels* fast is not raw render speed but which
 * pages get rendered, in what order, and what gets abandoned:
 *
 *   - **Nearest first.** The queue is re-sorted by distance from the middle of
 *     the viewport every time the scroll moves, so the page under the reader's
 *     eyes is always the next one decoded. Rendering in page order instead
 *     means arriving at page 40 and waiting behind pages 31–39.
 *   - **Abandon what was passed.** A render for a page that has scrolled out of
 *     range is cancelled rather than finished. pdf.js is single-worker, so a
 *     page nobody will look at is not merely wasted — it is holding up the one
 *     that is on screen.
 *   - **Two at a time.** Enough to overlap decode with paint, few enough that
 *     re-prioritising actually takes effect within a frame or two.
 *   - **Nothing speculative while moving.** Above a velocity threshold only
 *     pages actually intersecting the viewport are queued; the look-ahead comes
 *     back the moment the scroll settles.
 *   - **Text layers wait.** Hundreds of positioned spans per page is the most
 *     expensive thing here and the least useful mid-flight, so it happens on
 *     the settle pass.
 */

import { PdfPageView } from "./page";
import { pdfEnvironment, type PdfDocument } from "./pdfjs";
import { clamp } from "./util";

/** Discrete zoom stops, matching the original implementation's ladder. */
const ZOOM_STEPS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

/** How many pages may hold canvas pixels at once. */
const MAX_RENDERED_PAGES = 10;

/** Concurrent page renders. See "Two at a time" above. */
const MAX_CONCURRENT_RENDERS = 2;

/** Idle time after the last scroll or zoom before the settle pass runs. */
const SETTLE_MS = 120;

/** Above this many CSS pixels per frame, stop rendering ahead of the viewport. */
const FAST_SCROLL_PX_PER_FRAME = 60;

/** Space around each page, in CSS pixels. */
const PAGE_GAP = 12;

export type ZoomMode = "fit-width" | "fit-page" | "custom";

/**
 * Where a zoom is anchored, in terms that survive the scale change: which page,
 * where in that page, and where in the viewport that point currently sits.
 */
interface AnchorState {
  readonly pageIndex: number;
  readonly fractionY: number;
  readonly fractionX: number;
  readonly offsetY: number;
  readonly offsetX: number;
}

export interface PdfViewCallbacks {
  /** The page under the middle of the viewport changed. */
  onPageChange(pageNumber: number): void;
  /** The scale or zoom mode changed, for the toolbar readout. */
  onZoomChange(): void;
  /** Something worth persisting moved: scroll, zoom, page. Debounced by the shell. */
  onPersist(): void;
  /** A render failed for a reason that is not cancellation. */
  onRenderError(pageNumber: number, thrown: unknown): void;
  /**
   * A page's selectable text overlay could not be built.
   *
   * Separate from `onRenderError` because it is a different sentence to the
   * reader — the page is on screen and readable, and it is *selection* that is
   * missing — and because it must not read as "this page failed to render" when
   * the page plainly did.
   */
  onTextLayerError(pageNumber: number, thrown: unknown): void;
  /**
   * The scale changed, or a page's box did.
   *
   * Anything drawn *over* a page in page coordinates needs to hear about both:
   * the annotation layer sizes its handles in screen pixels, and a page whose
   * placeholder was seeded from page 1's box corrects itself on its first real
   * render. Fires during construction as well, so an implementation must
   * tolerate being called before the thing it updates exists.
   */
  onLayout(): void;
}

/**
 * Mirrors render outcomes to the terminal. **Dev builds only.**
 *
 * The same argument `viewers/instances.ts` makes for tracing mounts: a page
 * that renders blank and a page that is still rendering look identical from
 * outside the webview, whose console is unreadable on all three platforms. When
 * scrolling feels wrong, the question is always "which pages were started, and
 * which were abandoned", and nothing else can answer it.
 */
function trace(message: string): void {
  if (!import.meta.env.DEV) return;
  void import("../../dev/log").then(({ devLog }) => devLog(`pdf: ${message}`));
}

export class PdfView {
  readonly root: HTMLElement;
  readonly scroller: HTMLElement;
  readonly pagesContainer: HTMLElement;
  readonly pages: readonly PdfPageView[];
  /** Transient one-line feedback, and the tile's `aria-live` region. */
  readonly status: HTMLElement;

  #document: PdfDocument;
  #callbacks: PdfViewCallbacks;

  #scale = 1;
  #fitScale = 1;
  #zoomMode: ZoomMode = "fit-width";
  #zoom = 100;
  #currentPage = 1;
  #inverted = false;

  /** Scroll offset of each page's top, in the scroller's coordinate space. */
  #positions: number[] = [];
  /** Page numbers currently holding canvas pixels. What `#freeFarPages` bounds. */
  #holding = new Set<number>();
  /** Completed renders that put nothing on the canvas. See `#noteInk`. */
  #blankRenders = 0;
  /** Whether any page has ever drawn a mark, which clears the suspicion. */
  #everPainted = false;
  /** So the "nothing is reaching the screen" line is said once, not per page. */
  #reportedBlank = false;
  /** Pages whose text layer has already had its failure reported. */
  #reportedTextFailure = new Set<number>();
  /** Page numbers wanted on screen right now, re-derived on every scroll. */
  #wanted = new Set<number>();
  #activeRenders = 0;

  /** Bumped by `destroy()`; every async continuation checks it. */
  #generation = 0;
  #destroyed = false;

  #scrollFrame = 0;
  #lastScrollTop = 0;
  #scrollSpeed = 0;
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  #announceTimer: ReturnType<typeof setTimeout> | null = null;
  #abort = new AbortController();

  constructor(options: {
    container: HTMLElement;
    document: PdfDocument;
    pageSizes: readonly { width: number; height: number }[];
    callbacks: PdfViewCallbacks;
  }) {
    this.#document = options.document;
    this.#callbacks = options.callbacks;

    const root = document.createElement("div");
    root.className = "pdf-viewer";

    const scroller = document.createElement("div");
    scroller.className = "pdf-scroller";

    const pagesContainer = document.createElement("div");
    pagesContainer.className = "pdf-pages";
    pagesContainer.style.setProperty("--pdf-page-gap", `${PAGE_GAP}px`);

    // A one-line strip rather than the shell's error panel. "Copied 412
    // characters" and "no OCR plugin is registered" are things to say in
    // passing; `ViewerHost.reportError` covers the whole tile and is for
    // failures the user has to act on.
    const status = document.createElement("div");
    status.className = "pdf-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    scroller.append(pagesContainer);
    root.append(scroller, status);
    options.container.append(root);

    this.root = root;
    this.scroller = scroller;
    this.pagesContainer = pagesContainer;
    this.status = status;

    this.pages = options.pageSizes.map(
      (size, index) => new PdfPageView(index + 1, { ...size }),
    );
    pagesContainer.append(...this.pages.map((page) => page.root));

    const signal = this.#abort.signal;
    scroller.addEventListener("scroll", this.#onScroll, { passive: true, signal });
    scroller.addEventListener("wheel", this.#onWheel, { passive: false, signal });
    // Safari/WKWebView reports a trackpad pinch as gesture events rather than a
    // ctrl-modified wheel. Both paths are wired; whichever the platform sends
    // lands in the same `zoomAround`.
    scroller.addEventListener("gesturestart", this.#onGestureStart as EventListener, {
      signal,
    });
    scroller.addEventListener("gesturechange", this.#onGestureChange as EventListener, {
      signal,
    });
    scroller.addEventListener("gestureend", this.#onGestureEnd as EventListener, {
      signal,
    });

    this.#computeScale();
    this.layout();
  }

  // -------------------------------------------------------------------------
  // Inversion
  // -------------------------------------------------------------------------

  get inverted(): boolean {
    return this.#inverted;
  }

  /**
   * Toggles inversion for the whole document.
   *
   * One class on one element, and the browser's compositor does the rest — so
   * the cost of flipping it is a single DOM write rather than a redraw of every
   * live page, at any zoom level and any page count.
   */
  setInverted(inverted: boolean): void {
    this.#inverted = inverted;
    this.pagesContainer.classList.toggle("is-inverted", inverted);
  }

  // -------------------------------------------------------------------------
  // Scale
  // -------------------------------------------------------------------------

  get scale(): number {
    return this.#scale;
  }

  get zoomMode(): ZoomMode {
    return this.#zoomMode;
  }

  /** The zoom the toolbar shows: the fit scale when fitting, the stop otherwise. */
  get zoomPercent(): number {
    return this.#zoomMode === "custom" ? this.#zoom : Math.round(this.#fitScale * 100);
  }

  get currentPage(): number {
    return this.#currentPage;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Derives `scale` from the current mode and the scroller's box. */
  #computeScale(): void {
    const first = this.pages[0];
    if (!first) return;

    if (this.#zoomMode === "custom") {
      this.#scale = clampScale(this.#zoom / 100);
      return;
    }

    // `clientWidth`/`clientHeight` already exclude the scrollbar, which is what
    // makes fit-width settle instead of oscillating as the bar appears.
    const availableWidth = this.scroller.clientWidth - 2 * PAGE_GAP;
    const availableHeight = this.scroller.clientHeight - 2 * PAGE_GAP;
    const byWidth = availableWidth > 0 ? availableWidth / first.dimensions.width : 1;
    const byHeight = availableHeight > 0 ? availableHeight / first.dimensions.height : 1;

    this.#fitScale = clampScale(
      this.#zoomMode === "fit-page" ? Math.min(byWidth, byHeight) : byWidth,
    );
    this.#scale = this.#fitScale;
  }

  /**
   * Applies a new scale, keeping a chosen point stable.
   *
   * `anchor` is a client-space point — the cursor during a pinch or a
   * ctrl-scroll. Without it the current page's top is used, which is the right
   * anchor for the keyboard and toolbar paths where no cursor is involved.
   */
  #applyScale(
    next: { mode: ZoomMode; zoom?: number },
    anchor?: { clientX: number; clientY: number },
  ): void {
    const before = this.#anchorState(anchor);

    this.#zoomMode = next.mode;
    if (typeof next.zoom === "number") this.#zoom = next.zoom;
    this.#computeScale();
    this.layout();
    this.#restoreAnchor(before, anchor);

    // The pixels on every canvas were rendered at the old scale. They keep
    // painting, CSS-stretched, until a re-render replaces them — and they stay
    // in `#holding`, because that set records which pages own pixels, not which
    // are up to date. Clearing it would lose track of every off-screen page's
    // canvas and `#freeFarPages` would never reclaim them.
    for (const page of this.pages) page.markStale();

    this.#callbacks.onZoomChange();
    this.#callbacks.onPersist();
    this.updateRendering();
    this.#scheduleSettle();
  }

  #anchorState(anchor?: { clientX: number; clientY: number }): AnchorState {
    const scrollerBox = this.scroller.getBoundingClientRect();
    const pageIndex = clamp(this.#currentPage - 1, 0, this.pages.length - 1);
    const page = this.pages[pageIndex]!;
    const pageBox = page.root.getBoundingClientRect();

    const offsetY = anchor ? anchor.clientY - scrollerBox.top : 0;
    const offsetX = anchor ? anchor.clientX - scrollerBox.left : 0;
    const pointY = anchor ? anchor.clientY : scrollerBox.top;
    const pointX = anchor ? anchor.clientX : scrollerBox.left;

    return {
      pageIndex,
      fractionY: pageBox.height ? (pointY - pageBox.top) / pageBox.height : 0,
      fractionX: pageBox.width ? (pointX - pageBox.left) / pageBox.width : 0,
      offsetY,
      offsetX,
    };
  }

  #restoreAnchor(
    before: AnchorState,
    anchor?: { clientX: number; clientY: number },
  ): void {
    const page = this.pages[before.pageIndex];
    if (!page) return;
    const top = this.#positions[before.pageIndex] ?? 0;
    this.scroller.scrollTop = Math.max(
      0,
      top + before.fractionY * page.root.offsetHeight - before.offsetY,
    );

    if (anchor) {
      this.scroller.scrollLeft = Math.max(
        0,
        page.root.offsetLeft + before.fractionX * page.root.offsetWidth - before.offsetX,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public zoom / navigation actions
  // -------------------------------------------------------------------------

  stepZoom(direction: 1 | -1): void {
    const current = this.zoomPercent;
    let index: number;
    if (direction > 0) {
      index = ZOOM_STEPS.findIndex((step) => step > current);
      if (index === -1) index = ZOOM_STEPS.length - 1;
    } else {
      const previous = [...ZOOM_STEPS].reverse().find((step) => step < current);
      index = previous === undefined ? 0 : ZOOM_STEPS.indexOf(previous);
    }
    this.#applyScale({ mode: "custom", zoom: ZOOM_STEPS[index]! });
  }

  /** Continuous zoom, cursor-centred. */
  zoomAround(factor: number, anchor: { clientX: number; clientY: number }): void {
    const next = clampScale(this.#scale * factor);
    this.#applyScale({ mode: "custom", zoom: next * 100 }, anchor);
  }

  fitWidth(): void {
    this.#applyScale({ mode: "fit-width" });
  }

  fitPage(): void {
    this.#applyScale({ mode: "fit-page" });
  }

  resetZoom(): void {
    this.#applyScale({ mode: "custom", zoom: 100 });
  }

  setZoomState(state: { mode: ZoomMode; zoom: number }): void {
    this.#applyScale({ mode: state.mode, zoom: state.zoom });
  }

  goToPage(pageNumber: number): void {
    const target = clamp(Math.round(pageNumber), 1, this.pages.length);
    this.#currentPage = target;
    const top = this.#positions[target - 1];
    if (typeof top === "number") {
      this.scroller.scrollTop = Math.max(0, top - PAGE_GAP);
    }
    this.#callbacks.onPageChange(target);
    this.updateRendering();
    this.#scheduleSettle();
    this.#callbacks.onPersist();
  }

  /** Scrolls so a normalized rect within a page is visible. */
  revealRect(
    pageNumber: number,
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    const page = this.pages[pageNumber - 1];
    if (!page) return;
    const top = this.#positions[pageNumber - 1] ?? 0;
    const height = page.root.offsetHeight;
    const margin = Math.max(0, (this.scroller.clientHeight - rect.height * height) / 3);
    this.scroller.scrollTop = Math.max(0, top + rect.y * height - margin);
    this.#currentPage = pageNumber;
    this.#callbacks.onPageChange(pageNumber);
    this.updateRendering();
    this.#scheduleSettle();
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  layout(): void {
    for (const page of this.pages) page.layout(this.#scale);
    this.recomputePositions();
    this.#callbacks.onLayout();
  }

  recomputePositions(): void {
    // `offsetTop` is relative to the pages container, which is the scroller's
    // only child and its scroll origin, so this is already scroll-space.
    this.#positions = this.pages.map((page) => page.root.offsetTop);
  }

  /** The tile's box changed. Re-fit if fitting, otherwise just re-virtualize. */
  resize(): void {
    if (this.#destroyed) return;
    if (this.#zoomMode !== "custom") {
      const previous = this.#scale;
      this.#computeScale();
      const changed = Math.abs(previous - this.#scale) >= 0.0005;
      this.#scale = previous;
      if (changed) {
        this.#applyScale({ mode: this.#zoomMode });
        return;
      }
    }
    this.recomputePositions();
    this.updateRendering();
    this.#scheduleSettle();
  }

  // -------------------------------------------------------------------------
  // The render queue
  // -------------------------------------------------------------------------

  /**
   * Re-derives what should be on screen and gets the queue moving.
   *
   * Cheap enough to call on every scroll frame: it is a pass over the page
   * positions plus a set rebuild, with no rendering decisions of its own beyond
   * membership.
   */
  updateRendering(): void {
    if (this.#destroyed) return;

    const top = this.scroller.scrollTop;
    const viewportHeight = this.scroller.clientHeight;
    // While the scroll is moving quickly, look-ahead is worse than useless: the
    // pages it renders will have gone past before they finish.
    const margin = this.#scrollSpeed > FAST_SCROLL_PX_PER_FRAME ? 0 : viewportHeight;

    this.#wanted.clear();
    for (let index = 0; index < this.pages.length; index += 1) {
      const start = this.#positions[index] ?? 0;
      const end = start + this.pages[index]!.root.offsetHeight;
      if (end >= top - margin && start <= top + viewportHeight + margin) {
        this.#wanted.add(index + 1);
      }
    }

    // Abandon anything in flight that is no longer wanted. pdf.js decodes on
    // one worker, so a page nobody will see is not just wasted work — it is
    // ahead of the page that is on screen.
    for (const page of this.pages) {
      if (page.busy && !this.#wanted.has(page.pageNumber)) {
        trace(`page ${page.pageNumber} cancelled — scrolled out of range`);
        page.cancelRender();
        // The in-flight `#renderPage` will also decrement in its `finally`, so
        // it is not decremented here; doing both would let `#pump` exceed the
        // concurrency cap.
      }
    }

    this.#pump();
    this.#freeFarPages();
  }

  /**
   * Records whether a completed render drew anything, and speaks up when
   * nothing ever does.
   *
   * A render that resolves and leaves the canvas empty is the one PDF failure
   * this plugin has no other witness for: pdf.js reports success, the page
   * reports success, and the tile shows paper — which is exactly what a blank
   * page looks like. So the evidence has to be circumstantial and it has to be
   * held to a bar: **two** completed renders, neither of which put a mark down,
   * and no page anywhere in the document that ever has. One blank page is a
   * blank page. Two, with nothing else drawn, is a webview.
   *
   * Two rather than three because only the pages in view are rendered, and a
   * short document may never complete a third — which would leave the failure
   * this exists to catch as silent as it was before. The cost of the other
   * error is a warning line on a document that really is blank, which is
   * non-fatal, dismissible, and worth it.
   */
  #noteInk(pageNumber: number, painted: boolean): void {
    if (painted) {
      this.#everPainted = true;
      return;
    }
    this.#blankRenders += 1;
    trace(`page ${pageNumber} rendered without putting anything on the canvas`);
    if (this.#everPainted || this.#reportedBlank || this.#blankRenders < 2) return;
    this.#reportedBlank = true;
    this.#callbacks.onRenderError(
      pageNumber,
      new Error(
        `this webview finished drawing ${this.#blankRenders} pages and left every ` +
          `canvas empty — nothing is reaching the screen [${pdfEnvironment()}]`,
      ),
    );
  }

  /** Starts renders, nearest to the viewport first, up to the concurrency cap. */
  #pump(): void {
    while (this.#activeRenders < MAX_CONCURRENT_RENDERS) {
      const next = this.#nextPageToRender();
      if (!next) return;
      this.#activeRenders += 1;
      void this.#renderPage(next);
    }
  }

  /** The wanted page that needs pixels and is closest to the viewport centre. */
  #nextPageToRender(): PdfPageView | null {
    const centre = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    let best: PdfPageView | null = null;
    let bestDistance = Infinity;

    for (const pageNumber of this.#wanted) {
      const page = this.pages[pageNumber - 1];
      if (!page || page.busy) continue;
      if (page.rendered && !page.isStaleAt(this.#scale)) continue;

      const top = this.#positions[pageNumber - 1] ?? 0;
      const distance = Math.abs(top + page.root.offsetHeight / 2 - centre);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = page;
      }
    }
    return best;
  }

  async #renderPage(page: PdfPageView): Promise<void> {
    const generation = this.#generation;
    const isCurrent = (): boolean => !this.#destroyed && generation === this.#generation;

    try {
      await page.render(this.#document, this.#scale, isCurrent);
      if (isCurrent() && page.holdsPixels) this.#holding.add(page.pageNumber);
      if (isCurrent() && page.rendered) this.#noteInk(page.pageNumber, page.paintedInk);
      trace(
        `page ${page.pageNumber} render ${page.rendered ? "done" : "abandoned"} ` +
          `at scale ${this.#scale.toFixed(2)} (canvas ${page.canvas.width}x${page.canvas.height}, ` +
          `wanted=${this.#wanted.size}, viewport=${this.scroller.clientHeight})`,
      );
    } catch (thrown) {
      this.#callbacks.onRenderError(page.pageNumber, thrown);
    } finally {
      this.#activeRenders = Math.max(0, this.#activeRenders - 1);
    }

    if (!isCurrent()) return;
    // A page whose placeholder was seeded from page 1's box corrects its own
    // dimensions on its first render, and anything drawn over it has to follow.
    this.#callbacks.onLayout();
    this.#freeFarPages();
    // Keep going while anything wanted is still unrendered.
    this.#pump();
    // And re-arm the settle pass. Without this, a page that finishes rendering
    // *after* the last settle fired never gets a text layer: the settle only
    // builds layers for pages that are already rendered, and nothing else would
    // ever ask again.
    this.#scheduleSettle();
  }

  #freeFarPages(): void {
    if (this.#holding.size <= MAX_RENDERED_PAGES) return;
    const byDistance = [...this.#holding].sort(
      (a, b) => Math.abs(b - this.#currentPage) - Math.abs(a - this.#currentPage),
    );
    while (this.#holding.size > MAX_RENDERED_PAGES) {
      const pageNumber = byDistance.shift();
      if (pageNumber === undefined) break;
      // Never reclaim a page that is on screen, however the distance sorted.
      if (this.#wanted.has(pageNumber)) continue;
      this.pages[pageNumber - 1]?.free();
      this.#holding.delete(pageNumber);
    }
  }

  /**
   * The settle pass: the work that is worth doing once the reader has stopped.
   *
   * Text layers, and re-rendering anything still stale after a zoom. Both are
   * deliberately absent from the scroll path — see the module comment.
   */
  #scheduleSettle(): void {
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null;
      this.#settle();
    }, SETTLE_MS);
  }

  #settle(): void {
    if (this.#destroyed) return;
    this.#scrollSpeed = 0;
    // Re-derive with the full look-ahead now that nothing is moving.
    this.updateRendering();

    const generation = this.#generation;
    const isCurrent = (): boolean => !this.#destroyed && generation === this.#generation;
    for (const pageNumber of this.#wanted) {
      const page = this.pages[pageNumber - 1];
      if (page?.rendered) {
        // The settle pass re-runs after every scroll and every render, so a
        // page that keeps failing would keep reporting; `#reportedTextFailure`
        // holds it to once per page. The *retry* is deliberate — a text layer
        // that failed once on a busy frame should get another go — it is only
        // the sentence that is said once.
        page.buildTextLayer(this.#document, this.#scale, isCurrent).catch((thrown) => {
          if (!isCurrent() || this.#reportedTextFailure.has(pageNumber)) return;
          this.#reportedTextFailure.add(pageNumber);
          this.#callbacks.onTextLayerError(pageNumber, thrown);
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  #onScroll = (): void => {
    if (this.#scrollFrame) return;
    this.#scrollFrame = requestAnimationFrame(() => {
      this.#scrollFrame = 0;
      const top = this.scroller.scrollTop;
      this.#scrollSpeed = Math.abs(top - this.#lastScrollTop);
      this.#lastScrollTop = top;
      this.#syncCurrentPage();
      this.updateRendering();
      this.#scheduleSettle();
    });
  };

  /**
   * Which page the reader is on: the last one whose top is above the middle of
   * the viewport. Using the middle rather than the top means the number flips
   * over at the point the page visually changes.
   */
  #syncCurrentPage(): void {
    const middle = this.scroller.scrollTop + this.scroller.clientHeight / 2;
    let current = 1;
    for (let index = 0; index < this.#positions.length; index += 1) {
      if ((this.#positions[index] ?? 0) <= middle) current = index + 1;
      else break;
    }
    if (current === this.#currentPage) return;
    this.#currentPage = current;
    this.#callbacks.onPageChange(current);
    this.#callbacks.onPersist();
  }

  /**
   * Ctrl/Cmd + wheel zooms; a trackpad pinch arrives here too, as a wheel event
   * with `ctrlKey` synthesised by the browser. Everything else is left alone so
   * ordinary scrolling stays ordinary.
   */
  #onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    // `deltaY` is in lines or pixels depending on the device; the exponential
    // keeps the response proportional either way and never inverts.
    this.zoomAround(Math.exp(-event.deltaY * 0.01), event);
  };

  #gestureStartScale = 1;

  #onGestureStart = (event: Event & { scale?: number }): void => {
    event.preventDefault();
    this.#gestureStartScale = event.scale ?? 1;
  };

  #onGestureChange = (
    event: Event & { scale?: number; clientX?: number; clientY?: number },
  ): void => {
    event.preventDefault();
    const scale = event.scale ?? 1;
    const factor = this.#gestureStartScale ? scale / this.#gestureStartScale : 1;
    this.#gestureStartScale = scale;
    this.zoomAround(factor, { clientX: event.clientX ?? 0, clientY: event.clientY ?? 0 });
  };

  #onGestureEnd = (event: Event): void => {
    event.preventDefault();
    this.#scheduleSettle();
  };

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------

  /** Says something briefly, and to a screen reader. Clears itself. */
  announce(message: string, tone: "info" | "warn" = "info"): void {
    if (this.#destroyed) return;
    this.status.textContent = message;
    this.status.classList.toggle("is-warning", tone === "warn");
    this.status.classList.add("is-visible");
    if (this.#announceTimer) clearTimeout(this.#announceTimer);
    this.#announceTimer = setTimeout(() => {
      this.#announceTimer = null;
      this.status.classList.remove("is-visible");
      this.status.textContent = "";
    }, 4000);
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  destroy(): void {
    this.#destroyed = true;
    this.#generation += 1;
    this.#abort.abort();
    if (this.#scrollFrame) cancelAnimationFrame(this.#scrollFrame);
    if (this.#settleTimer) clearTimeout(this.#settleTimer);
    if (this.#announceTimer) clearTimeout(this.#announceTimer);
    for (const page of this.pages) page.destroy();
    this.#holding.clear();
    this.#wanted.clear();
    this.root.remove();
  }
}

function clampScale(scale: number): number {
  return clamp(scale, MIN_SCALE, MAX_SCALE);
}
