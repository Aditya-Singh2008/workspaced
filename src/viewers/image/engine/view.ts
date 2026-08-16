/**
 * The image surface: layout, zoom, pan, orientation and the pixels underneath.
 *
 * Everything here is *inside one tile*. AGENTS.md's "no hand-rolled layout math"
 * rule is about tiling — pane positions, divider hit-testing, drag arithmetic
 * between tiles — and a viewer positioning its own content within its own
 * scroller is a different job, the same one `viewers/pdf/view.ts` does. Nothing
 * here measures or moves anything the docking library owns.
 *
 * ## Scale is a size, never a transform
 *
 * This is the decision the whole module is arranged around, and it is what makes
 * the phase brief's "SVG stays crisp at 800%" true.
 *
 * A `transform: scale()` is a compositing operation: the browser takes the
 * pixels an element already painted and stretches them. For a photo that is
 * exactly right — there is nothing more to draw. For a vector image it throws
 * away the reason the format exists, because the geometry could have been
 * re-rendered at the new size and instead its old rasterization is blown up.
 *
 * So zoom sets the element's `width` and `height` in CSS pixels. A `<canvas>`
 * sized that way stretches its bitmap, which is the correct behaviour for
 * raster. An `<img>` holding an SVG sized that way is *laid out again*, and the
 * browser re-rasterizes the vector at the new size — crisp at any zoom, with no
 * special case anywhere in this file.
 *
 * Rotation and flip do go through a transform, because at quarter turns and
 * mirror flips there is nothing to resample: they are exact.
 *
 * ## Panning is scrolling
 *
 * Rather than positioning the image by hand. The scroller gives the tile
 * scrollbars, wheel and trackpad scrolling, keyboard scrolling and
 * momentum for free, all matching the PDF plugin's feel, and drag-to-pan
 * becomes two assignments to `scrollLeft`/`scrollTop` instead of a pointer-math
 * implementation of everything a scroller already does.
 */

import type { DecodedImage } from "../decode";
import { imageSettings } from "../settings";
import {
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  type Rotation,
  type ZoomMode,
} from "../state";
import { adjustmentFilter, type Adjustments } from "./adjust";

/** Discrete zoom stops. Wider than the PDF ladder — images are inspected closer. */
const ZOOM_STEPS = [
  1, 3, 6, 12, 25, 33, 50, 67, 75, 100, 150, 200, 300, 400, 600, 800, 1200, 1600, 2400,
  3200, 6400,
];

export interface ImageViewCallbacks {
  /** The zoom, fit mode, rotation, flip or adjustment changed. */
  onViewChange(): void;
  /** Something worth persisting moved. Debounced by the shell. */
  onPersist(): void;
  /**
   * The pointer moved over the image.
   *
   * `point` is in natural image pixel coordinates and `client` is where the
   * pointer physically is — the picker needs the first and the loupe needs both,
   * since it has to be drawn around the pixel *and* positioned beside the
   * cursor. Both are `null` when the pointer is off the image.
   */
  onPointerMove(
    point: { x: number; y: number } | null,
    client: { clientX: number; clientY: number } | null,
  ): void;
}

export class ImageView {
  readonly root: HTMLElement;
  readonly scroller: HTMLElement;
  /** The sized box the display element sits centred inside. */
  readonly frame: HTMLElement;
  readonly panelHost: HTMLElement;
  readonly status: HTMLElement;

  #callbacks: ImageViewCallbacks;
  #image: DecodedImage | null = null;

  /** The element the image is drawn into: a canvas for raster, an `<img>` for SVG. */
  #display: HTMLCanvasElement | HTMLImageElement | null = null;
  #objectUrl: string | null = null;
  /** Natural-resolution pixels, for the picker, the histogram and export. */
  #pixelCanvas: HTMLCanvasElement | null = null;
  #pixelFrame = -1;

  #zoomMode: ZoomMode = "fit-window";
  #zoom = 100;
  #fitScale = 1;
  #rotation: Rotation = 0;
  #flipX = false;
  #flipY = false;
  #adjustments: Adjustments = { brightness: 0, contrast: 0, exposure: 0 };
  #frameIndex = 0;

  #abort = new AbortController();
  #destroyed = false;
  #announceTimer: ReturnType<typeof setTimeout> | null = null;
  #panning: { pointerId: number; x: number; y: number } | null = null;
  #gestureScale = 1;

  constructor(options: { container: HTMLElement; callbacks: ImageViewCallbacks }) {
    this.#callbacks = options.callbacks;

    const root = document.createElement("div");
    root.className = "image-viewer";

    const body = document.createElement("div");
    body.className = "image-body";

    const scroller = document.createElement("div");
    scroller.className = "image-scroller";
    scroller.tabIndex = 0;

    const frame = document.createElement("div");
    frame.className = "image-frame";

    const panelHost = document.createElement("aside");
    panelHost.className = "image-panel";
    panelHost.hidden = true;

    const status = document.createElement("div");
    status.className = "image-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    scroller.append(frame);
    body.append(scroller, panelHost);
    root.append(body, status);
    options.container.append(root);

    this.root = root;
    this.scroller = scroller;
    this.frame = frame;
    this.panelHost = panelHost;
    this.status = status;

    const signal = this.#abort.signal;
    scroller.addEventListener("wheel", this.#onWheel, { passive: false, signal });
    scroller.addEventListener("pointerdown", this.#onPointerDown, { signal });
    scroller.addEventListener("pointermove", this.#onPointerMove, { signal });
    scroller.addEventListener("pointerup", this.#onPointerUp, { signal });
    scroller.addEventListener("pointercancel", this.#onPointerUp, { signal });
    scroller.addEventListener("pointerleave", this.#onPointerLeave, { signal });
    scroller.addEventListener("scroll", this.#onScroll, { passive: true, signal });
    // Safari and WKWebView report a trackpad pinch as gesture events rather
    // than a ctrl-modified wheel. Both are wired; whichever the platform sends
    // lands in the same `zoomAround`.
    scroller.addEventListener("gesturestart", this.#onGestureStart as EventListener, { signal });
    scroller.addEventListener("gesturechange", this.#onGestureChange as EventListener, { signal });
    scroller.addEventListener("gestureend", this.#onGestureEnd as EventListener, { signal });
  }

  // -------------------------------------------------------------------------
  // Source
  // -------------------------------------------------------------------------

  /**
   * Shows a decoded image, replacing whatever was there.
   *
   * Called on mount and again on every folder navigation, so it has to give back
   * the previous image's element and object URL rather than accumulating them —
   * stepping through a directory of two hundred photos would otherwise leak one
   * blob URL per step.
   */
  setImage(image: DecodedImage): void {
    this.#releaseDisplay();
    this.#image = image;
    this.#frameIndex = 0;

    if (image.source.kind === "vector") {
      const element = document.createElement("img");
      element.className = "image-display";
      element.decoding = "sync";
      element.draggable = false;
      // A blob URL rather than the markup inline: rendering SVG through an
      // `<img>` puts it in the browser's secure static mode — no script, no
      // external fetches, no access to this document — which is what makes
      // opening an SVG the user did not write safe. See `svg/index.ts`.
      const blob = new Blob([image.source.markup], { type: "image/svg+xml" });
      this.#objectUrl = URL.createObjectURL(blob);
      element.src = this.#objectUrl;
      this.#display = element;
    } else {
      const canvas = document.createElement("canvas");
      canvas.className = "image-display";
      canvas.width = Math.max(1, Math.round(image.width));
      canvas.height = Math.max(1, Math.round(image.height));
      this.#display = canvas;
      this.#pixelCanvas = canvas;
      this.#pixelFrame = -1;
      this.drawFrame(0);
    }

    this.frame.replaceChildren(this.#display);
    this.layout();
  }

  get image(): DecodedImage | null {
    return this.#image;
  }

  get frameCount(): number {
    const source = this.#image?.source;
    return source?.kind === "raster" ? source.frames.length : 1;
  }

  get frameIndex(): number {
    return this.#frameIndex;
  }

  /** Paints one frame of an animation into the display canvas. */
  drawFrame(index: number): void {
    const source = this.#image?.source;
    if (source?.kind !== "raster") return;
    const bounded = Math.min(Math.max(0, index), source.frames.length - 1);
    const frame = source.frames[bounded];
    const canvas = this.#display as HTMLCanvasElement | null;
    if (!frame || !canvas || !("getContext" in canvas)) return;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    // Cleared first: a frame with transparency drawn over the previous one would
    // otherwise composite with it, which is the animation bug `gif/index.ts`
    // already solved once at decode time and must not reintroduce here.
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(frame.bitmap, 0, 0);

    this.#frameIndex = bounded;
    this.#pixelFrame = bounded;
  }

  #releaseDisplay(): void {
    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = null;
    }
    if (this.#pixelCanvas && this.#pixelCanvas !== this.#display) {
      this.#pixelCanvas.width = 0;
      this.#pixelCanvas.height = 0;
    }
    if (this.#display && "getContext" in this.#display) {
      this.#display.width = 0;
      this.#display.height = 0;
    }
    this.#display?.remove();
    this.#display = null;
    this.#pixelCanvas = null;
    this.#pixelFrame = -1;
  }

  // -------------------------------------------------------------------------
  // Pixels
  // -------------------------------------------------------------------------

  /**
   * A canvas holding the current frame at natural resolution.
   *
   * For raster this *is* the display canvas — the display element is already the
   * right size and holds the right pixels, so there is nothing to copy. For
   * vector it is a rasterization made on demand and cached, because the picker,
   * the histogram and export all need pixels and an SVG has none until something
   * chooses a size.
   */
  pixelCanvas(): HTMLCanvasElement | null {
    const image = this.#image;
    if (!image) return null;

    if (image.source.kind === "raster") {
      if (this.#pixelFrame !== this.#frameIndex) this.drawFrame(this.#frameIndex);
      return this.#pixelCanvas;
    }

    if (this.#pixelCanvas) return this.#pixelCanvas;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width));
    canvas.height = Math.max(1, Math.round(image.height));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const element = this.#display;
    if (!context || !element) return null;
    try {
      // An `<img>` that has not finished decoding draws as nothing. Callers get
      // `null` and ask again rather than caching an empty rasterization.
      if (element instanceof HTMLImageElement && !element.complete) return null;
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
    } catch {
      return null;
    }
    this.#pixelCanvas = canvas;
    return canvas;
  }

  // -------------------------------------------------------------------------
  // Zoom and fit
  // -------------------------------------------------------------------------

  get zoomMode(): ZoomMode {
    return this.#zoomMode;
  }

  get scale(): number {
    return this.#zoomMode === "custom" ? this.#zoom / 100 : this.#fitScale;
  }

  get zoomPercent(): number {
    return Math.round(this.scale * 100 * 100) / 100;
  }

  /** Natural size with rotation applied — a quarter turn swaps the axes. */
  get orientedSize(): { width: number; height: number } {
    const image = this.#image;
    if (!image) return { width: 0, height: 0 };
    const quarterTurned = this.#rotation === 90 || this.#rotation === 270;
    return quarterTurned
      ? { width: image.height, height: image.width }
      : { width: image.width, height: image.height };
  }

  #computeFitScale(): void {
    const { width, height } = this.orientedSize;
    if (!width || !height) return;

    const availableWidth = this.scroller.clientWidth;
    const availableHeight = this.scroller.clientHeight;
    if (availableWidth <= 0 || availableHeight <= 0) return;

    const byWidth = availableWidth / width;
    const byHeight = availableHeight / height;

    switch (this.#zoomMode) {
      case "fit-window":
        // Capped at 1:1. "Fit" that scales a 16×16 icon to fill a 1400px tile is
        // technically fitting and is not what anyone means by it — the image is
        // a blurry mural and the detail the user opened it for is gone. Filling
        // the tile is what `fill` is for, and it is one keystroke away.
        this.#fitScale = Math.min(byWidth, byHeight, 1);
        break;
      case "fill":
        this.#fitScale = Math.max(byWidth, byHeight);
        break;
      case "actual":
        this.#fitScale = 1;
        break;
      default:
        break;
    }
  }

  /**
   * Applies a new zoom, holding a chosen point still.
   *
   * `anchor` is a client-space point — the cursor during a pinch or a
   * ctrl-scroll. Without one the centre of the view is held, which is what the
   * keyboard and toolbar paths want.
   */
  #applyZoom(next: { mode: ZoomMode; zoom?: number }, anchor?: { clientX: number; clientY: number }): void {
    const before = this.#anchorFraction(anchor);

    this.#zoomMode = next.mode;
    if (typeof next.zoom === "number") {
      this.#zoom = Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, next.zoom));
    }
    this.layout();
    this.#restoreAnchor(before, anchor);

    this.#callbacks.onViewChange();
    this.#callbacks.onPersist();
  }

  /** Which fraction of the image sits under a client point, before a zoom. */
  #anchorFraction(anchor?: { clientX: number; clientY: number }): {
    fx: number;
    fy: number;
    offsetX: number;
    offsetY: number;
  } {
    const box = this.scroller.getBoundingClientRect();
    const offsetX = anchor ? anchor.clientX - box.left : this.scroller.clientWidth / 2;
    const offsetY = anchor ? anchor.clientY - box.top : this.scroller.clientHeight / 2;

    const frameBox = this.frame.getBoundingClientRect();
    const pointX = box.left + offsetX;
    const pointY = box.top + offsetY;

    return {
      fx: frameBox.width ? (pointX - frameBox.left) / frameBox.width : 0.5,
      fy: frameBox.height ? (pointY - frameBox.top) / frameBox.height : 0.5,
      offsetX,
      offsetY,
    };
  }

  #restoreAnchor(
    before: { fx: number; fy: number; offsetX: number; offsetY: number },
    _anchor?: { clientX: number; clientY: number },
  ): void {
    const { width, height } = this.displaySize();
    // `offsetLeft` accounts for the centring margin when the image is smaller
    // than the viewport, which is exactly when the naive calculation drifts.
    this.scroller.scrollLeft = Math.max(
      0,
      this.frame.offsetLeft + before.fx * width - before.offsetX,
    );
    this.scroller.scrollTop = Math.max(
      0,
      this.frame.offsetTop + before.fy * height - before.offsetY,
    );
  }

  stepZoom(direction: 1 | -1): void {
    const current = this.zoomPercent;
    let next: number;
    if (direction > 0) {
      next = ZOOM_STEPS.find((step) => step > current + 0.01) ?? ZOOM_STEPS.at(-1)!;
    } else {
      next = [...ZOOM_STEPS].reverse().find((step) => step < current - 0.01) ?? ZOOM_STEPS[0]!;
    }
    this.#applyZoom({ mode: "custom", zoom: next });
  }

  zoomAround(factor: number, anchor: { clientX: number; clientY: number }): void {
    this.#applyZoom({ mode: "custom", zoom: this.zoomPercent * factor }, anchor);
  }

  setZoomMode(mode: ZoomMode, zoom?: number): void {
    this.#applyZoom({ mode, zoom });
  }

  // -------------------------------------------------------------------------
  // Orientation
  // -------------------------------------------------------------------------

  get rotation(): Rotation {
    return this.#rotation;
  }

  get flipX(): boolean {
    return this.#flipX;
  }

  get flipY(): boolean {
    return this.#flipY;
  }

  setOrientation(orientation: { rotation?: Rotation; flipX?: boolean; flipY?: boolean }): void {
    if (orientation.rotation !== undefined) this.#rotation = orientation.rotation;
    if (orientation.flipX !== undefined) this.#flipX = orientation.flipX;
    if (orientation.flipY !== undefined) this.#flipY = orientation.flipY;
    this.layout();
    this.#callbacks.onViewChange();
    this.#callbacks.onPersist();
  }

  rotateBy(degrees: 90 | -90): void {
    this.setOrientation({
      rotation: ((((this.#rotation + degrees) % 360) + 360) % 360) as Rotation,
    });
  }

  // -------------------------------------------------------------------------
  // Adjustments
  // -------------------------------------------------------------------------

  get adjustments(): Adjustments {
    return this.#adjustments;
  }

  setAdjustments(adjustments: Adjustments): void {
    this.#adjustments = adjustments;
    if (this.#display) this.#display.style.filter = adjustmentFilter(adjustments);
    this.#callbacks.onViewChange();
    this.#callbacks.onPersist();
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  /** The frame's box in CSS pixels: the oriented image at the current scale. */
  displaySize(): { width: number; height: number } {
    const oriented = this.orientedSize;
    const scale = this.scale;
    return {
      width: Math.max(1, Math.round(oriented.width * scale)),
      height: Math.max(1, Math.round(oriented.height * scale)),
    };
  }

  layout(): void {
    if (!this.#image || !this.#display) return;

    this.#computeFitScale();
    const scale = this.scale;
    const frameSize = this.displaySize();

    this.frame.style.width = `${frameSize.width}px`;
    this.frame.style.height = `${frameSize.height}px`;

    // The element is sized to the *unrotated* image; the frame carries the
    // rotated box. Setting the size rather than scaling is the whole reason SVG
    // stays sharp — see the module comment.
    const naturalWidth = Math.max(1, Math.round(this.#image.width * scale));
    const naturalHeight = Math.max(1, Math.round(this.#image.height * scale));
    this.#display.style.width = `${naturalWidth}px`;
    this.#display.style.height = `${naturalHeight}px`;
    this.#display.style.transform =
      `translate(-50%, -50%) rotate(${this.#rotation}deg) ` +
      `scale(${this.#flipX ? -1 : 1}, ${this.#flipY ? -1 : 1})`;
    this.#display.style.filter = adjustmentFilter(this.#adjustments);

    // Past a few times life size the pixel grid is the subject — it is what the
    // inspector inspects — and smoothing hides it. Vector has no grid to show,
    // so it is left alone.
    const pixelate =
      this.#image.source.kind === "raster" && scale >= imageSettings().pixelateAboveZoom;
    this.#display.classList.toggle("is-pixelated", pixelate);

    this.root.classList.toggle(
      "is-checkered",
      imageSettings().checkerboardTransparency,
    );
  }

  /** The tile's box changed. Re-fit if fitting, otherwise leave the zoom alone. */
  resize(): void {
    if (this.#destroyed || !this.#image) return;
    const before = this.scale;
    this.layout();
    if (Math.abs(before - this.scale) > 0.0001) this.#callbacks.onViewChange();
  }

  // -------------------------------------------------------------------------
  // Coordinates
  // -------------------------------------------------------------------------

  /**
   * A client point as a natural image pixel, or `null` when it is outside.
   *
   * This is the function the pixel inspector's correctness rests on, and the
   * reason it is not simply `(clientX − left) / scale`: the displayed image may
   * be rotated a quarter turn and mirrored on either axis, so the mapping has to
   * be *inverted through the same transform the browser applied*. Getting it
   * wrong shows the colour of a different pixel, which looks plausible and is
   * wrong — the worst kind of bug for a tool whose job is telling you what
   * colour something is.
   */
  imagePointAt(client: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const image = this.#image;
    const point = this.#unprojected(client);
    if (!image || !point) return null;

    const x = Math.floor(point.x);
    const y = Math.floor(point.y);
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
    return { x, y };
  }

  /**
   * The same inverse transform, without the bounds check or the rounding.
   *
   * Split out for {@link imageRegionAt}, which needs the four corners of a box
   * and cannot reject the ones that fall outside the picture — a rubber band
   * drawn generously around a photograph is a perfectly good "all of it", not a
   * failed lookup.
   */
  #unprojected(client: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const image = this.#image;
    if (!image) return null;

    const box = this.frame.getBoundingClientRect();
    if (!box.width || !box.height) return null;

    // Offset from the frame's centre, which is the transform's origin.
    const dx = client.clientX - (box.left + box.width / 2);
    const dy = client.clientY - (box.top + box.height / 2);

    // Undo the rotation.
    const radians = (-this.#rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    let localX = dx * cos - dy * sin;
    let localY = dx * sin + dy * cos;

    // Undo the mirroring. Each flip is its own inverse.
    if (this.#flipX) localX = -localX;
    if (this.#flipY) localY = -localY;

    const scale = this.scale;
    return {
      x: localX / scale + image.width / 2,
      y: localY / scale + image.height / 2,
    };
  }

  /**
   * A client-space box as a normalized rect of the *natural, unrotated* image.
   *
   * Unrotated is the load-bearing word: this is what backs the contract's
   * region copy, and `renderForExport` crops the source before it applies the
   * orientation, so the rect has to be in the source's own coordinates. Mapping
   * the corners through the same inverse transform `imagePointAt` uses is what
   * makes a box dragged over a quarter-turned, mirrored photograph come back as
   * the piece of the picture that was actually under it.
   *
   * All four corners are mapped rather than two, because a rotation that is not
   * a multiple of 90° would otherwise lose the box — and while the viewer only
   * offers quarter turns today, a bounding box over four points is correct for
   * any angle and no more code.
   *
   * `null` when the box misses the image entirely.
   */
  imageRegionAt(box: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }): { x: number; y: number; width: number; height: number } | null {
    const image = this.#image;
    if (!image) return null;

    const corners = [
      { clientX: box.left, clientY: box.top },
      { clientX: box.right, clientY: box.top },
      { clientX: box.right, clientY: box.bottom },
      { clientX: box.left, clientY: box.bottom },
    ].map((corner) => this.#unprojected(corner));
    if (corners.some((corner) => corner === null)) return null;

    const xs = corners.map((corner) => corner!.x);
    const ys = corners.map((corner) => corner!.y);

    const left = Math.max(0, Math.min(...xs));
    const top = Math.max(0, Math.min(...ys));
    const right = Math.min(image.width, Math.max(...xs));
    const bottom = Math.min(image.height, Math.max(...ys));
    if (right - left < 1 || bottom - top < 1) return null;

    return {
      x: left / image.width,
      y: top / image.height,
      width: (right - left) / image.width,
      height: (bottom - top) / image.height,
    };
  }

  /** Where the centre of the view sits, as a fraction of the image. For state. */
  centerFraction(): { x: number; y: number } {
    const { width, height } = this.displaySize();
    if (!width || !height) return { x: 0.5, y: 0.5 };
    const x = (this.scroller.scrollLeft + this.scroller.clientWidth / 2 - this.frame.offsetLeft) / width;
    const y = (this.scroller.scrollTop + this.scroller.clientHeight / 2 - this.frame.offsetTop) / height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  /** Restores a centre recorded by {@link centerFraction}. */
  setCenterFraction(center: { x: number; y: number }): void {
    const { width, height } = this.displaySize();
    this.scroller.scrollLeft = Math.max(
      0,
      this.frame.offsetLeft + center.x * width - this.scroller.clientWidth / 2,
    );
    this.scroller.scrollTop = Math.max(
      0,
      this.frame.offsetTop + center.y * height - this.scroller.clientHeight / 2,
    );
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  #onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    // Exponential, so the response is proportional whether `deltaY` arrives in
    // lines or pixels, and never inverts.
    this.zoomAround(Math.exp(-event.deltaY * 0.01), event);
  };

  #onPointerDown = (event: PointerEvent): void => {
    // Left button only, and never on the panel.
    if (event.button !== 0) return;
    this.#panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.scroller.setPointerCapture(event.pointerId);
    this.scroller.classList.add("is-panning");
    // Dragging the image is not inspecting it, and a loupe left hanging over a
    // moving image is in the way of the thing being moved.
    this.#callbacks.onPointerMove(null, null);
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (this.#panning?.pointerId === event.pointerId) {
      const dx = event.clientX - this.#panning.x;
      const dy = event.clientY - this.#panning.y;
      this.#panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      this.scroller.scrollLeft -= dx;
      this.scroller.scrollTop -= dy;
      return;
    }
    this.#callbacks.onPointerMove(this.imagePointAt(event), {
      clientX: event.clientX,
      clientY: event.clientY,
    });
  };

  #onPointerUp = (event: PointerEvent): void => {
    if (this.#panning?.pointerId !== event.pointerId) return;
    this.#panning = null;
    this.scroller.classList.remove("is-panning");
    if (this.scroller.hasPointerCapture(event.pointerId)) {
      this.scroller.releasePointerCapture(event.pointerId);
    }
    this.#callbacks.onPersist();
  };

  #onPointerLeave = (): void => {
    this.#callbacks.onPointerMove(null, null);
  };

  #onScroll = (): void => {
    this.#callbacks.onPersist();
  };

  #onGestureStart = (event: Event & { scale?: number }): void => {
    event.preventDefault();
    this.#gestureScale = event.scale ?? 1;
  };

  #onGestureChange = (
    event: Event & { scale?: number; clientX?: number; clientY?: number },
  ): void => {
    event.preventDefault();
    const scale = event.scale ?? 1;
    const factor = this.#gestureScale ? scale / this.#gestureScale : 1;
    this.#gestureScale = scale;
    this.zoomAround(factor, { clientX: event.clientX ?? 0, clientY: event.clientY ?? 0 });
  };

  #onGestureEnd = (event: Event): void => {
    event.preventDefault();
    this.#callbacks.onPersist();
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
    }, 5000);
  }

  /** A persistent line under the image, for a decode's caveats. `null` clears it. */
  setNotice(message: string | null): void {
    this.root.classList.toggle("has-notice", message !== null);
    let notice = this.root.querySelector<HTMLElement>(".image-notice");
    if (!message) {
      notice?.remove();
      return;
    }
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "image-notice";
      this.root.insertBefore(notice, this.status);
    }
    notice.textContent = message;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  destroy(): void {
    this.#destroyed = true;
    this.#abort.abort();
    if (this.#announceTimer) clearTimeout(this.#announceTimer);
    this.#releaseDisplay();
    this.#image = null;
    this.root.remove();
  }

  /** Test hook: whether every bitmap-holding element has been given back. */
  get holdsPixels(): boolean {
    return this.#display !== null || this.#pixelCanvas !== null;
  }
}
