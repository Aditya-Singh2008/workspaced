/**
 * Annotate mode: the tools, the gestures, and the save.
 *
 * The instance owns the document and the view; this owns everything that
 * happens between the user pressing "annotate" and a file appearing on disk. It
 * is the only part of phase 05a that knows it is looking at a PDF, and even here
 * that knowledge is thin: pages, points, and where to write the bytes.
 *
 * ## One listener on the container, and layers only where they are needed
 *
 * A 900-page document has 900 page placeholders. Giving each one an annotation
 * layer up front would be 900 SVG elements to hold a document that has three
 * marks in it, so a layer is created for a page only when that page *has* a mark
 * or is drawn on. Pointer handling therefore lives on the pages container, which
 * exists once: it finds the page from `event.target.closest(".pdf-page")` and
 * makes the layer if the gesture needs one. This is the same virtualization
 * argument `view.ts` makes about canvases, applied to the thing drawn over them.
 *
 * ## Gestures are transactions
 *
 * Every drag — draw, move, resize — is one {@link OverlayDocument.begin}
 * transaction, so one drag is one undo and a drag abandoned with Escape leaves
 * nothing behind. Creating a callout or a note keeps the transaction open across
 * the whole typing session, which is why an empty one can vanish completely
 * rather than leaving a blank mark and two entries in the history.
 *
 * ## Where a save goes
 *
 * The policy is `annotation/store.ts` and is not repeated here; this supplies the
 * three things it cannot know — how to see whether a file carries the marker
 * (parse it with pdf-lib), how to write bytes (the Tauri command), and what the
 * user says when the companion already exists. After the first save the tile is
 * labelled with the companion's name through `ViewerHost.setDisplayName`, and
 * every later save in the session goes to the same path, so the original is
 * written to exactly never.
 *
 * ## What this file does *not* own, since phase 05b
 *
 * Text-anchored marks. They are made from a selection rather than a gesture,
 * their position is derived from a quote rather than drawn, and they live in
 * `annotation/text/` — see `textAnnotate.ts`. Two things connect them to this
 * file and nothing else does: `derivedMarks()`, which hands over their resolved
 * rectangles so one layer draws every mark on a page, and `textAnnotations()`,
 * which puts them into the one save pipeline below.
 *
 * ## A note is readable without annotate mode
 *
 * A sticky note is the one mark whose content is *not* on the page — the icon
 * stands for text that has to be opened to be read. Requiring annotate mode to
 * read it would mean entering an editing mode to look at a comment, so the note
 * icon keeps taking the pointer while the rest of the layer is inert (`pdf.css`)
 * and a click opens a read-only popup. Reading is not editing: the popup has no
 * caret, opens no transaction, and cannot change what it shows. Double-clicking
 * a note *in* annotate mode still opens the real editor.
 */

import {
  DEFAULT_TEXT_BOX,
  NOTE_SIZE,
  OverlayDocument,
  clamp01,
  getAnnotatedTarget,
  hitTestItem,
  isResizable,
  normalizeRect,
  overlayItemStamp,
  overlayToolPreferences,
  rectFromCorners,
  resolveAnnotatedTarget,
  setAnnotatedTarget,
  basename,
  transformItemToBounds,
  type NormalizedPoint,
  type NormalizedRect,
  type OverlayItem,
  type OverlayLiveEdit,
  type OverlayToolId,
  type OverlayToolStyle,
} from "../../annotation";
import type { ResolvedTextAnnotation } from "../../annotation";
import type { FileHandle } from "../../files";
import { PdfAnnotationLayer, type AnnotationHandle } from "./annotateLayer";
import { AnnotationPalette, FILL_TOOLS, STROKE_TOOLS } from "./annotatePalette";
import type { PdfView } from "./view";
import { clamp, noteBubbleBox, placeOverPage } from "./util";

/** How close a click has to be to a hairline to count, in normalized units. */
const HIT_TOLERANCE = 0.006;

/** Below this, a drag was a click: a tap, not a rectangle. */
const DRAG_THRESHOLD = 0.004;

type Gesture =
  | {
      readonly kind: "create";
      readonly edit: OverlayLiveEdit;
      readonly base: readonly OverlayItem[];
      readonly page: number;
      readonly start: NormalizedPoint;
      item: OverlayItem;
      moved: boolean;
    }
  | {
      readonly kind: "move";
      readonly edit: OverlayLiveEdit;
      readonly base: readonly OverlayItem[];
      readonly id: string;
      readonly start: NormalizedPoint;
      readonly origin: NormalizedRect;
    }
  | {
      readonly kind: "resize";
      readonly edit: OverlayLiveEdit;
      readonly base: readonly OverlayItem[];
      readonly id: string;
      readonly handle: AnnotationHandle;
      readonly origin: NormalizedRect;
    };

export interface PdfAnnotatorOptions {
  readonly view: PdfView;
  readonly file: FileHandle;
  /** The `annotation/store.ts` key this document's marks are filed under. */
  readonly documentKey: string;
  readonly overlay: OverlayDocument;
  /** Fires whenever the toolbar, the palette or the sidebar list would change. */
  onChange(): void;
  /** The tile is now showing a different file's name. */
  onDisplayName(name: string | null): void;

  /**
   * Marks this annotator draws but does not own: phase 05b's resolved text
   * anchors.
   *
   * They arrive as {@link OverlayItem} highlights because that is what they are
   * once resolved — a set of rectangles in normalized page space — and the brief
   * is explicit that they must go through the *existing* rectangle rendering
   * rather than a second path. What makes them different is upstream of here:
   * their position was derived from a quote rather than drawn, so they are not
   * in the overlay document, cannot be selected, moved or resized, and do not
   * appear in its undo history.
   */
  derivedMarks?(): readonly OverlayItem[];

  /** The same marks, unresolved, for the export. See {@link save}. */
  textAnnotations?(): readonly ResolvedTextAnnotation[];
}

export class PdfAnnotator {
  #view: PdfView;
  #file: FileHandle;
  #key: string;
  #overlay: OverlayDocument;
  #options: PdfAnnotatorOptions;

  #enabled = false;
  /**
   * Whether this tile is the focused one.
   *
   * Only the clipboard needs it, and it genuinely does: `paste` is a window
   * event, so with two annotated tiles open both would place the image and the
   * user would get two. Everything else here is scoped by where the pointer is,
   * which needs no help.
   */
  #active = false;
  #tool: OverlayToolId = "select";
  #selected: string | null = null;
  #busy = false;

  #layers = new Map<number, PdfAnnotationLayer>();
  #palette: AnnotationPalette | null = null;
  #gesture: Gesture | null = null;
  #editor: {
    element: HTMLTextAreaElement;
    edit: OverlayLiveEdit;
    id: string;
    /** Whether the item is being placed right now, or already existed. */
    created: boolean;
  } | null = null;
  /** The open note being *read*, which needs no transaction and no mode. */
  #popup: { element: HTMLElement; id: string } | null = null;

  #unsubscribeOverlay: () => void;
  #unlistenDrop: (() => void) | null = null;
  #abort = new AbortController();

  constructor(options: PdfAnnotatorOptions) {
    this.#options = options;
    this.#view = options.view;
    this.#file = options.file;
    this.#key = options.documentKey;
    this.#overlay = options.overlay;

    this.#unsubscribeOverlay = this.#overlay.subscribe(() => {
      this.render();
      this.#options.onChange();
    });

    const signal = this.#abort.signal;
    this.#view.pagesContainer.addEventListener("pointerdown", this.#onPointerDown, {
      signal,
    });
    // Both drop paths are wired. Tauri intercepts OS file drags when
    // `dragDropEnabled` is on and reports them with real paths (see
    // `#listenForNativeDrop`); the DOM one still fires for a drag that started
    // inside the webview, and is the only one that exists in a plain browser.
    this.#view.pagesContainer.addEventListener("dragover", this.#onDragOver, { signal });
    this.#view.pagesContainer.addEventListener("drop", this.#onDrop, { signal });
    window.addEventListener("paste", this.#onPaste, { signal });
    // Only ever acts on an open note popup. Escape belongs to annotate mode
    // otherwise, and that binding is registered by the instance, not here.
    window.addEventListener("keydown", this.#onKeyDown, { signal });

    // Marks restored from a previous tile on the same document have to appear
    // without waiting for annotate mode.
    this.render();
  }

  // -------------------------------------------------------------------------
  // Mode
  // -------------------------------------------------------------------------

  get enabled(): boolean {
    return this.#enabled;
  }

  get tool(): OverlayToolId {
    return this.#tool;
  }

  get selected(): string | null {
    return this.#selected;
  }

  get editing(): boolean {
    return this.#editor !== null;
  }

  get overlay(): OverlayDocument {
    return this.#overlay;
  }

  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    this.#view.root.classList.toggle("is-annotating", enabled);
    // Either direction: the reader belongs to the mode that was just left.
    this.#closePopup();

    if (enabled) {
      this.#palette ??= new AnnotationPalette(this.#view.root, {
        selectTool: (tool) => this.setTool(tool),
        setStyle: (patch) => this.#setStyle(patch),
        undo: () => this.undo(),
        redo: () => this.redo(),
        remove: () => this.deleteSelection(),
        bringToFront: () => this.#reorder("front"),
        sendToBack: () => this.#reorder("back"),
        save: () => void this.save(),
        close: () => this.setEnabled(false),
      });
      void this.#listenForNativeDrop();
    } else {
      this.#closeEditor("commit");
      this.#cancelGesture();
      this.#selected = null;
      this.#palette?.destroy();
      this.#palette = null;
      this.#unlistenDrop?.();
      this.#unlistenDrop = null;
    }

    this.render();
    this.#options.onChange();
  }

  setActive(active: boolean): void {
    this.#active = active;
  }

  setTool(tool: OverlayToolId): void {
    if (this.#tool === tool) return;
    this.#tool = tool;
    // Leaving the pointer for a drawing tool drops the selection: the handles
    // would still be on screen, offering a resize the next drag will not do.
    if (tool !== "select") this.#selected = null;
    this.render();
    this.#options.onChange();
  }

  #style(): OverlayToolStyle {
    return overlayToolPreferences.get(this.#tool);
  }

  #setStyle(patch: Partial<OverlayToolStyle>): void {
    overlayToolPreferences.set(this.#tool, patch);
    // A style change with something selected restyles it, which is what every
    // annotator does and what the swatch appears to promise.
    if (this.#selected) {
      const item = this.#overlay.find(this.#selected);
      if (item) this.#overlay.update(item.id, (current) => restyle(current, patch));
    }
    this.render();
    this.#options.onChange();
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  undo(): void {
    if (!this.#overlay.undo()) this.#view.announce("nothing to undo", "warn");
  }

  redo(): void {
    if (!this.#overlay.redo()) this.#view.announce("nothing to redo", "warn");
  }

  deleteSelection(): void {
    if (!this.#selected) return;
    this.#overlay.remove(this.#selected);
    this.#selected = null;
    this.render();
    this.#options.onChange();
  }

  remove(id: string): void {
    this.#overlay.remove(id);
    if (this.#selected === id) this.#selected = null;
    this.render();
    this.#options.onChange();
  }

  #reorder(where: "front" | "back"): void {
    if (!this.#selected) return;
    if (where === "front") this.#overlay.bringToFront(this.#selected);
    else this.#overlay.sendToBack(this.#selected);
  }

  /** Escape: back out of whatever is in progress, then out of annotate mode. */
  escape(): void {
    if (this.#editor) {
      this.#closeEditor("commit");
      return;
    }
    if (this.#gesture) {
      this.#cancelGesture();
      return;
    }
    if (this.#selected) {
      this.#selected = null;
      this.render();
      this.#options.onChange();
      return;
    }
    this.setEnabled(false);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(): void {
    const derived = this.#options.derivedMarks?.() ?? [];
    const wanted = new Set<number>();
    for (const item of this.#overlay.items) wanted.add(item.subdivision + 1);
    for (const item of derived) wanted.add(item.subdivision + 1);
    for (const pageNumber of this.#layers.keys()) wanted.add(pageNumber);

    for (const pageNumber of wanted) {
      const layer = this.#ensureLayer(pageNumber);
      if (!layer) continue;
      // Derived marks first, so they paint *under* the drawn ones: a text
      // highlight is part of the document's furniture by the time someone
      // scribbles over it.
      layer.setItems([
        ...derived.filter((item) => item.subdivision === pageNumber - 1),
        ...this.#overlay.itemsOn(pageNumber - 1),
      ]);
      layer.setSelection(this.#selected);
      layer.setScale(this.#view.scale);
      layer.setInteractive(this.#enabled);
    }

    // A note that was deleted — from the sidebar, or by an undo — takes its
    // open reader with it rather than leaving a bubble pointing at nothing.
    this.#refreshPopup();

    const selected = this.#selected ? this.#overlay.find(this.#selected) : undefined;
    this.#palette?.update({
      tool: this.#tool,
      style: this.#paletteStyle(selected),
      // What the controls would act on: the selected mark if there is one, the
      // tool otherwise. Stroke width on a selected sticky note is not a thing.
      allowStroke: selected
        ? selected.kind === "ink" || selected.kind === "shape"
        : STROKE_TOOLS.includes(this.#tool),
      allowFill: selected
        ? selected.kind === "shape" &&
          (selected.shape === "rect" || selected.shape === "ellipse")
        : FILL_TOOLS.includes(this.#tool),
      canUndo: this.#overlay.canUndo,
      canRedo: this.#overlay.canRedo,
      hasSelection: this.#selected !== null,
      // Both kinds, because the palette's count and its save button describe
      // the file that would be written, not this model's share of it.
      count: this.markCount,
      busy: this.#busy,
    });
  }

  /** The style the palette shows: the selection's, or the tool's. */
  #paletteStyle(selected: OverlayItem | undefined): OverlayToolStyle {
    const base = this.#style();
    if (!selected) return base;
    return {
      color: selected.color,
      opacity: selected.opacity,
      strokeWidth:
        selected.kind === "ink" || selected.kind === "shape"
          ? selected.strokeWidth
          : base.strokeWidth,
      fontSize: selected.kind === "text" ? selected.fontSize : base.fontSize,
      filled: selected.kind === "shape" ? selected.fill !== undefined : base.filled,
    };
  }

  /** Called by the view whenever the scale or a page's box changed. */
  syncLayout(): void {
    for (const [pageNumber, layer] of this.#layers) {
      const page = this.#view.pages[pageNumber - 1];
      if (page) layer.setSize(page.dimensions);
      layer.setScale(this.#view.scale);
    }
    this.#positionEditor();
    this.#positionPopup();
  }

  #ensureLayer(pageNumber: number): PdfAnnotationLayer | null {
    const existing = this.#layers.get(pageNumber);
    if (existing) return existing;
    const page = this.#view.pages[pageNumber - 1];
    if (!page) return null;
    const layer = new PdfAnnotationLayer(page.root, page.dimensions);
    layer.setScale(this.#view.scale);
    layer.setInteractive(this.#enabled);
    this.#layers.set(pageNumber, layer);
    return layer;
  }

  // -------------------------------------------------------------------------
  // Pointer gestures
  // -------------------------------------------------------------------------

  #onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // The palette is inside the tile but is not the page.
    if (target.closest(".pdf-annot-palette, .pdf-annot-editor")) return;

    // Reading a note is all a click does with the mode off, and it must not
    // consume the event: everything else on the page is still selectable text.
    if (!this.#enabled) {
      this.#toggleNoteUnder(target);
      return;
    }

    const pageElement = target.closest<HTMLElement>(".pdf-page");
    const pageNumber = Number(pageElement?.dataset.page ?? 0);
    if (!pageElement || !pageNumber) return;

    const layer = this.#ensureLayer(pageNumber);
    if (!layer) return;

    this.#closeEditor("commit");
    const point = layer.toNormalized(event.clientX, event.clientY);
    event.preventDefault();

    if (this.#tool === "select") this.#beginSelectGesture(event, target, point);
    else this.#beginCreateGesture(pageNumber, point);

    if (this.#gesture) {
      window.addEventListener("pointermove", this.#onPointerMove);
      window.addEventListener("pointerup", this.#onPointerUp);
      window.addEventListener("pointercancel", this.#onPointerUp);
    }
  };

  #beginSelectGesture(
    event: PointerEvent,
    target: Element,
    point: NormalizedPoint,
  ): void {
    const handle = target.closest<SVGElement>("[data-handle]")?.dataset.handle as
      | AnnotationHandle
      | undefined;
    const selected = this.#selected ? this.#overlay.find(this.#selected) : undefined;

    if (handle && selected && isResizable(selected)) {
      this.#gesture = {
        kind: "resize",
        edit: this.#overlay.begin(),
        base: this.#overlay.items,
        id: selected.id,
        handle,
        origin: selected.bounds,
      };
      return;
    }

    const hitId = target.closest<SVGElement>("[data-annot-id]")?.dataset.annotId;
    const hit =
      (hitId ? this.#overlay.find(hitId) : undefined) ?? this.#hitTest(point, event);

    if (!hit) {
      if (this.#selected === null) return;
      this.#selected = null;
      this.render();
      this.#options.onChange();
      return;
    }

    this.#selected = hit.id;
    if (event.detail >= 2 && (hit.kind === "text" || hit.kind === "note")) {
      this.render();
      this.#openEditor(hit);
      return;
    }

    this.#gesture = {
      kind: "move",
      edit: this.#overlay.begin(),
      base: this.#overlay.items,
      id: hit.id,
      start: point,
      origin: hit.bounds,
    };
    this.render();
    this.#options.onChange();
  }

  /**
   * The model's own hit test, for the marks the DOM cannot answer for.
   *
   * `event.target` resolves a click on a shape, which covers most of it — but a
   * hairline ink stroke is a sub-pixel target at fit-width, so a near miss falls
   * through to here and is measured against the geometry with a tolerance.
   */
  #hitTest(point: NormalizedPoint, event: PointerEvent): OverlayItem | undefined {
    const pageElement = (event.target as Element).closest<HTMLElement>(".pdf-page");
    const pageNumber = Number(pageElement?.dataset.page ?? 0);
    if (!pageNumber) return undefined;
    // Front to back: the topmost mark under the pointer is the one meant.
    const candidates = this.#overlay.itemsOn(pageNumber - 1);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const item = candidates[index]!;
      if (hitTestItem(item, point, HIT_TOLERANCE)) return item;
    }
    return undefined;
  }

  #beginCreateGesture(pageNumber: number, point: NormalizedPoint): void {
    if (this.#tool === "image") {
      void this.#placeImageFromClipboard(pageNumber, point);
      return;
    }

    const item = this.#draftItem(pageNumber, point);
    if (!item) return;

    const base = this.#overlay.items;
    const edit = this.#overlay.begin();
    edit.update([...base, item]);

    this.#gesture = {
      kind: "create",
      edit,
      base,
      page: pageNumber,
      start: point,
      item,
      moved: false,
    };
    this.#selected = null;
  }

  #draftItem(pageNumber: number, at: NormalizedPoint): OverlayItem | null {
    const style = this.#style();
    const subdivision = pageNumber - 1;
    const common = {
      ...overlayItemStamp(),
      subdivision,
      color: style.color,
      opacity: style.opacity,
    };
    const empty: NormalizedRect = { x: at.x, y: at.y, width: 0, height: 0 };

    switch (this.#tool) {
      case "ink":
        return {
          ...common,
          kind: "ink",
          strokes: [[at]],
          strokeWidth: style.strokeWidth,
          bounds: empty,
        };
      case "highlight":
        return { ...common, kind: "highlight", rects: [empty], bounds: empty };
      case "rect":
      case "ellipse":
        return {
          ...common,
          kind: "shape",
          shape: this.#tool,
          strokeWidth: style.strokeWidth,
          fill: style.filled ? style.color : undefined,
          bounds: empty,
        };
      case "line":
      case "arrow":
        return {
          ...common,
          kind: "shape",
          shape: this.#tool,
          strokeWidth: style.strokeWidth,
          from: at,
          to: at,
          bounds: empty,
        };
      case "text":
        return {
          ...common,
          kind: "text",
          text: "",
          fontSize: style.fontSize,
          bounds: { x: at.x, y: at.y, ...DEFAULT_TEXT_BOX },
        };
      case "note":
        return { ...common, kind: "note", text: "", open: true, bounds: this.#noteBox(pageNumber, at) };
      default:
        return null;
    }
  }

  /** A note icon is square *in points*, so its two normalized extents differ. */
  #noteBox(pageNumber: number, at: NormalizedPoint): NormalizedRect {
    const page = this.#view.pages[pageNumber - 1];
    const size = page ? Math.min(page.dimensions.width, page.dimensions.height) : 612;
    const side = NOTE_SIZE * size;
    return {
      x: at.x,
      y: at.y,
      width: page ? side / page.dimensions.width : NOTE_SIZE,
      height: page ? side / page.dimensions.height : NOTE_SIZE,
    };
  }

  #onPointerMove = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (!gesture) return;
    const pageNumber = gesture.kind === "create" ? gesture.page : this.#pageOf(gesture.id);
    const layer = pageNumber ? this.#layers.get(pageNumber) : undefined;
    if (!layer) return;

    const raw = layer.toNormalized(event.clientX, event.clientY);
    // Clamped to the page: a mark whose geometry runs off the paper cannot be
    // exported to a `/Rect` that means anything.
    const point = { x: clamp01(raw.x), y: clamp01(raw.y) };

    switch (gesture.kind) {
      case "create":
        this.#updateCreate(gesture, point);
        break;
      case "move": {
        const item = gesture.base.find((candidate) => candidate.id === gesture.id);
        if (!item) return;
        const next = transformItemToBounds(
          item,
          this.#clampToPage(
            {
              ...gesture.origin,
              x: gesture.origin.x + (point.x - gesture.start.x),
              y: gesture.origin.y + (point.y - gesture.start.y),
            },
            item.bounds,
          ),
        );
        gesture.edit.update(replace(gesture.base, next));
        break;
      }
      case "resize": {
        const item = gesture.base.find((candidate) => candidate.id === gesture.id);
        if (!item) return;
        const next = this.#resized(item, gesture, point);
        gesture.edit.update(replace(gesture.base, next));
        break;
      }
    }
  };

  #updateCreate(gesture: Extract<Gesture, { kind: "create" }>, point: NormalizedPoint): void {
    const item = gesture.item;
    if (
      Math.abs(point.x - gesture.start.x) > DRAG_THRESHOLD ||
      Math.abs(point.y - gesture.start.y) > DRAG_THRESHOLD
    ) {
      gesture.moved = true;
    }

    let next: OverlayItem;
    switch (item.kind) {
      case "ink": {
        const stroke = [...(item.strokes[0] ?? []), point];
        next = { ...item, strokes: [stroke] };
        break;
      }
      case "highlight": {
        const rect = rectFromCorners(gesture.start, point);
        next = { ...item, rects: [rect], bounds: rect };
        break;
      }
      case "shape":
        next =
          item.shape === "line" || item.shape === "arrow"
            ? { ...item, from: gesture.start, to: point }
            : { ...item, bounds: rectFromCorners(gesture.start, point) };
        break;
      case "text":
        next = { ...item, bounds: rectFromCorners(gesture.start, point) };
        break;
      default:
        return;
    }

    gesture.item = next;
    gesture.edit.update([...gesture.base, next]);
  }

  #resized(
    item: OverlayItem,
    gesture: Extract<Gesture, { kind: "resize" }>,
    point: NormalizedPoint,
  ): OverlayItem {
    if (
      item.kind === "shape" &&
      (gesture.handle === "from" || gesture.handle === "to")
    ) {
      return gesture.handle === "from"
        ? { ...item, from: point }
        : { ...item, to: point };
    }

    const box = gesture.origin;
    const left = gesture.handle.includes("w") ? point.x : box.x;
    const right = gesture.handle.includes("e") ? point.x : box.x + box.width;
    const top = gesture.handle.includes("n") ? point.y : box.y;
    const bottom = gesture.handle.includes("s") ? point.y : box.y + box.height;

    return transformItemToBounds(
      item,
      normalizeRect({
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      }),
    );
  }

  /** Keeps a moved mark's box on the page without changing its size. */
  #clampToPage(box: NormalizedRect, original: NormalizedRect): NormalizedRect {
    const width = original.width;
    const height = original.height;
    return {
      x: clamp(box.x, -width / 2, 1 - width / 2),
      y: clamp(box.y, -height / 2, 1 - height / 2),
      width,
      height,
    };
  }

  #onPointerUp = (): void => {
    const gesture = this.#gesture;
    window.removeEventListener("pointermove", this.#onPointerMove);
    window.removeEventListener("pointerup", this.#onPointerUp);
    window.removeEventListener("pointercancel", this.#onPointerUp);
    this.#gesture = null;
    if (!gesture) return;

    if (gesture.kind !== "create") {
      gesture.edit.commit();
      this.#options.onChange();
      return;
    }

    const item = gesture.item;

    // A click with a tool that needs an extent is a miss, not an invisible
    // zero-size mark: nothing to see, nothing to select, nothing to delete. A
    // tap with the *pen* is not a miss — it is a dot, and it is meant.
    const needsExtent = item.kind === "highlight" || item.kind === "shape";
    if (!gesture.moved && needsExtent) {
      gesture.edit.cancel();
      this.render();
      this.#options.onChange();
      return;
    }

    if (item.kind === "text" || item.kind === "note") {
      // The transaction stays open across the typing session, so an empty note
      // can be abandoned entirely rather than committed and then deleted.
      const placed =
        item.kind === "note" || gesture.moved
          ? item
          : { ...item, bounds: { ...item.bounds, ...DEFAULT_TEXT_BOX } };
      gesture.edit.update([...gesture.base, placed]);
      this.#editor = {
        element: this.#createEditorElement(placed),
        edit: gesture.edit,
        id: placed.id,
        created: true,
      };
      this.#focusEditor(placed);
      return;
    }

    gesture.edit.commit();
    this.#afterCreate(item, gesture.moved);
  };

  #afterCreate(item: OverlayItem, moved: boolean): void {
    // Back to the pointer after one mark, except for the pen and highlighter,
    // where the next thing a user does is nearly always another stroke.
    if (item.kind !== "ink" && item.kind !== "highlight") {
      this.#selected = moved ? item.id : null;
      this.setTool("select");
    }
    this.render();
    this.#options.onChange();
  }

  #cancelGesture(): void {
    const gesture = this.#gesture;
    if (!gesture) return;
    this.#gesture = null;
    window.removeEventListener("pointermove", this.#onPointerMove);
    window.removeEventListener("pointerup", this.#onPointerUp);
    window.removeEventListener("pointercancel", this.#onPointerUp);
    gesture.edit.cancel();
  }

  #pageOf(id: string): number | null {
    const item = this.#overlay.find(id);
    return item ? item.subdivision + 1 : null;
  }

  // -------------------------------------------------------------------------
  // Text editing
  // -------------------------------------------------------------------------

  #openEditor(item: OverlayItem): void {
    if (item.kind !== "text" && item.kind !== "note") return;
    this.#closeEditor("commit");
    const edit = this.#overlay.begin();
    this.#editor = {
      element: this.#createEditorElement(item),
      edit,
      id: item.id,
      created: false,
    };
    this.#focusEditor(item);
  }

  #createEditorElement(item: OverlayItem): HTMLTextAreaElement {
    const element = document.createElement("textarea");
    element.className = "pdf-annot-editor";
    element.value = item.kind === "text" || item.kind === "note" ? item.text : "";
    element.spellcheck = false;
    element.placeholder = item.kind === "note" ? "note…" : "text…";

    element.addEventListener("input", () => {
      const editor = this.#editor;
      if (!editor) return;
      const base = this.#overlay.items;
      editor.edit.update(
        base.map((candidate) =>
          candidate.id === editor.id && (candidate.kind === "text" || candidate.kind === "note")
            ? { ...candidate, text: element.value, updatedAt: Date.now() }
            : candidate,
        ),
      );
    });

    element.addEventListener("keydown", (event) => {
      // Escape and Ctrl/Cmd+Enter both finish. Plain Enter is a newline: a
      // callout is a paragraph, not a form field.
      if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        event.stopPropagation();
        this.#closeEditor("commit");
      }
    });
    element.addEventListener("blur", () => this.#closeEditor("commit"));

    const page = this.#view.pages[item.subdivision];
    page?.root.append(element);
    return element;
  }

  #focusEditor(item: OverlayItem): void {
    this.#positionEditor(item);
    const element = this.#editor?.element;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    this.#options.onChange();
  }

  #positionEditor(item?: OverlayItem): void {
    const editor = this.#editor;
    if (!editor) return;
    const target = item ?? this.#overlay.find(editor.id);
    if (!target) return;
    const page = this.#view.pages[target.subdivision];
    if (!page) return;

    const { width: pageWidth, height: pageHeight } = page.dimensions;
    const box = target.kind === "note" ? this.#noteBubble(target) : target.bounds;
    placeOverPage(editor.element, box);

    if (target.kind === "text") {
      const size = target.fontSize * Math.min(pageWidth, pageHeight) * this.#view.scale;
      editor.element.style.fontSize = `${size}px`;
      editor.element.style.color = target.color;
    }
  }

  /**
   * Where a note's bubble goes: beside the icon, pulled back inside the page
   * when the note was placed near an edge. Shared by the editor and the reader
   * so a note opens in the same place whichever one opens it.
   */
  #noteBubble(item: OverlayItem): NormalizedRect {
    const page = this.#view.pages[item.subdivision];
    return noteBubbleBox(item.bounds, {
      width: page?.dimensions.width ?? 612,
      height: page?.dimensions.height ?? 792,
    });
  }

  #closeEditor(how: "commit" | "cancel"): void {
    const editor = this.#editor;
    if (!editor) return;
    this.#editor = null;
    const text = editor.element.value.trim();
    editor.element.remove();

    if (how === "cancel" || !text) {
      // An empty callout or note is nothing at all. Placing one and typing
      // nothing leaves no mark *and no history entry*, which is why the whole
      // placement was one open transaction; emptying an existing one is a
      // deletion, because a mark with nothing in it and nothing to see is not
      // something to leave on the page.
      editor.edit.cancel();
      if (!editor.created && !text) this.#overlay.remove(editor.id);
    } else {
      editor.edit.commit();
      this.#selected = editor.id;
    }

    this.setTool("select");
    this.render();
    this.#options.onChange();
  }

  // -------------------------------------------------------------------------
  // Reading a note, which needs no mode
  // -------------------------------------------------------------------------

  /**
   * What a click does with annotate mode off: open the note under the pointer,
   * close the note that is open, and otherwise nothing at all.
   */
  #toggleNoteUnder(target: Element): void {
    // A click *inside* the popup is reading it — selecting its text, usually —
    // and must not dismiss the thing being read.
    if (target.closest(".pdf-annot-note-popup")) return;

    const id = target.closest<SVGElement>("[data-annot-id]")?.dataset.annotId;
    const item = id ? this.#overlay.find(id) : undefined;
    // Anywhere else on the page closes it, which is what every popup does and
    // what a reader tries first.
    if (item?.kind !== "note" || this.#popup?.id === item.id) {
      this.#closePopup();
      return;
    }
    this.#openPopup(item);
  }

  #openPopup(item: Extract<OverlayItem, { kind: "note" }>): void {
    this.#closePopup();
    const page = this.#view.pages[item.subdivision];
    if (!page) return;

    const element = document.createElement("div");
    element.className = "pdf-annot-note-popup";
    element.setAttribute("role", "note");
    page.root.append(element);

    this.#popup = { element, id: item.id };
    this.#refreshPopup();
    this.#positionPopup(item);
  }

  #positionPopup(item?: OverlayItem): void {
    const popup = this.#popup;
    if (!popup) return;
    const target = item ?? this.#overlay.find(popup.id);
    if (!target || target.kind !== "note") {
      this.#closePopup();
      return;
    }
    placeOverPage(popup.element, this.#noteBubble(target));
  }

  /** Keeps the open note in step with the model, or closes it. */
  #refreshPopup(): void {
    const popup = this.#popup;
    if (!popup) return;
    const item = this.#overlay.find(popup.id);
    if (!item || item.kind !== "note") {
      this.#closePopup();
      return;
    }
    // `textContent`, and the newlines survive through `white-space: pre-wrap`:
    // a note is text the user typed, never markup to be parsed.
    popup.element.textContent = item.text || "(empty note)";
    popup.element.classList.toggle("is-empty", !item.text);
  }

  #closePopup(): void {
    this.#popup?.element.remove();
    this.#popup = null;
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.#popup) return;
    // With the mode on, Escape is the mode's own verb — backing out of a
    // gesture, a selection, and finally the mode itself — and a note being read
    // is not what the user is trying to get out of.
    if (this.#enabled) return;
    event.preventDefault();
    this.#closePopup();
  };

  // -------------------------------------------------------------------------
  // Images: clipboard and drop
  // -------------------------------------------------------------------------

  #onPaste = (event: ClipboardEvent): void => {
    if (!this.#enabled || !this.#active || this.#editor) return;
    const file = [...(event.clipboardData?.items ?? [])]
      .find((entry) => entry.kind === "file" && entry.type.startsWith("image/"))
      ?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void this.#placeImageFile(file, this.#view.currentPage, null);
  };

  #onDragOver = (event: DragEvent): void => {
    if (!this.#enabled) return;
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  #onDrop = (event: DragEvent): void => {
    if (!this.#enabled) return;
    const file = [...(event.dataTransfer?.files ?? [])].find((entry) =>
      entry.type.startsWith("image/"),
    );
    if (!file) return;
    event.preventDefault();
    const at = this.#pointFromClient(event.clientX, event.clientY);
    void this.#placeImageFile(file, at?.page ?? this.#view.currentPage, at?.point ?? null);
  };

  /**
   * The Tauri side of dropping a file.
   *
   * With `dragDropEnabled` on — which this app needs for opening files by drag —
   * the webview never sees an OS file drag as a DOM `drop` event on Windows and
   * Linux. Tauri reports it instead, with real paths and a physical-pixel
   * position, so the drop has to be hit-tested back onto a page by hand.
   */
  async #listenForNativeDrop(): Promise<void> {
    if (this.#unlistenDrop) return;
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (!this.#enabled || event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        if (paths.length === 0) return;
        const ratio = window.devicePixelRatio || 1;
        const at = this.#pointFromClient(
          event.payload.position.x / ratio,
          event.payload.position.y / ratio,
        );
        if (!at) return;
        void this.#placeImagePath(paths[0]!, at.page, at.point);
      });
      this.#unlistenDrop = unlisten;
    } catch {
      // Not running under Tauri (the dev browser, the self-test). The DOM drop
      // handler is the whole story there.
    }
  }

  /** Which page a client-space point is over, and where on it. */
  #pointFromClient(
    clientX: number,
    clientY: number,
  ): { page: number; point: NormalizedPoint } | null {
    for (const page of this.#view.pages) {
      const box = page.root.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (
        clientX >= box.left &&
        clientX <= box.right &&
        clientY >= box.top &&
        clientY <= box.bottom
      ) {
        return {
          page: page.pageNumber,
          point: {
            x: (clientX - box.left) / box.width,
            y: (clientY - box.top) / box.height,
          },
        };
      }
    }
    return null;
  }

  async #placeImageFromClipboard(pageNumber: number, at: NormalizedPoint): Promise<void> {
    // Only reachable from a click on the page, which is the user gesture the
    // Clipboard API requires — and the reason the image tool reads the clipboard
    // here rather than the palette reading it when the tool is chosen.
    try {
      if (!navigator.clipboard?.read) {
        // `navigator.clipboard.read` is the part webviews disagree about; the
        // `paste` *event* carries the same image and is available everywhere.
        // So the honest message names the way that does work.
        this.#view.announce(
          "this platform will not hand over the clipboard on request — paste the image instead",
          "warn",
        );
        return;
      }
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((candidate) => candidate.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        await this.#placeImageBlob(blob, pageNumber, at);
        return;
      }
      this.#view.announce("there is no image on the clipboard", "warn");
      return;
    } catch (thrown) {
      console.error("[pdf] clipboard read failed", thrown);
      this.#view.announce("could not read the clipboard", "warn");
    }
  }

  async #placeImageFile(file: File, pageNumber: number, at: NormalizedPoint | null): Promise<void> {
    await this.#placeImageBlob(file, pageNumber, at);
  }

  async #placeImagePath(path: string, pageNumber: number, at: NormalizedPoint): Promise<void> {
    const lower = path.toLowerCase();
    const mimeType = lower.endsWith(".jpg") || lower.endsWith(".jpeg") ? "image/jpeg" : "image/png";
    if (!/\.(png|jpe?g)$/.test(lower)) {
      this.#view.announce("only PNG and JPEG images can be placed on a page", "warn");
      return;
    }
    try {
      const { readPathBytes } = await import("../../files");
      const bytes = await readPathBytes(path);
      await this.#placeImageBlob(new Blob([bytes], { type: mimeType }), pageNumber, at);
    } catch (thrown) {
      console.error("[pdf] reading a dropped image failed", thrown);
      this.#view.announce("could not read that image", "warn");
    }
  }

  /**
   * Decodes an image, sizes it sensibly on the page, and adds it.
   *
   * PNG and JPEG only, because those are the two formats pdf-lib can embed. A
   * WebP on the clipboard is re-encoded to PNG through a canvas rather than
   * refused — the user pasted a picture, and which container it arrived in is
   * not their problem.
   */
  async #placeImageBlob(
    blob: Blob,
    pageNumber: number,
    at: NormalizedPoint | null,
  ): Promise<void> {
    const page = this.#view.pages[pageNumber - 1];
    if (!page) return;

    let mimeType: "image/png" | "image/jpeg" =
      blob.type === "image/jpeg" ? "image/jpeg" : "image/png";
    let bytes = new Uint8Array(await blob.arrayBuffer());
    let size = await imageSize(blob);
    if (!size) {
      this.#view.announce("that image could not be decoded", "warn");
      return;
    }

    if (blob.type !== "image/png" && blob.type !== "image/jpeg") {
      const converted = await reencodeAsPng(blob, size);
      if (!converted) {
        this.#view.announce(`${blob.type || "that image"} cannot be placed on a page`, "warn");
        return;
      }
      bytes = converted.bytes;
      size = converted.size;
      mimeType = "image/png";
    }

    const { bytesToBase64 } = await import("../../annotation/export/pdf");

    // Placed at a third of the page width, keeping its aspect ratio, which is
    // big enough to see and small enough not to bury the page it lands on.
    const pageWidth = page.dimensions.width;
    const pageHeight = page.dimensions.height;
    const targetPoints = pageWidth / 3;
    const width = targetPoints / pageWidth;
    const height = ((targetPoints * size.height) / size.width) / pageHeight;
    const origin = at ?? { x: 0.5 - width / 2, y: 0.5 - height / 2 };

    this.#overlay.add({
      ...overlayItemStamp(),
      kind: "image",
      subdivision: pageNumber - 1,
      color: "#000000",
      opacity: 1,
      bounds: {
        x: clamp(origin.x, 0, Math.max(0, 1 - width)),
        y: clamp(origin.y, 0, Math.max(0, 1 - height)),
        width,
        height,
      },
      image: { mimeType, base64: bytesToBase64(bytes), width: size.width, height: size.height },
    });

    this.setTool("select");
    this.#view.announce(`placed a ${size.width}×${size.height} image`);
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  get busy(): boolean {
    return this.#busy;
  }

  /**
   * How many marks a save would write, of both kinds.
   *
   * The two models are separate everywhere else in this file and deliberately
   * so, but "is there anything to save" and "how much did I just save" are
   * questions about the document, not about a targeting strategy.
   */
  get markCount(): number {
    return this.#overlay.items.length + (this.#options.textAnnotations?.().length ?? 0);
  }

  /** The bytes of the annotated document, without writing anything. */
  async exportBytes(): Promise<Uint8Array> {
    const { exportAnnotatedPdf } = await import("../../annotation/export/pdf");
    return exportAnnotatedPdf({
      bytes: await this.#file.read(),
      items: this.#overlay.items,
      textItems: this.#options.textAnnotations?.() ?? [],
    });
  }

  /**
   * Writes the annotated copy, following AGENTS.md's rule to the letter.
   *
   * Every save re-exports from the *original* bytes with the current item list,
   * so saving five times produces one file with the marks that exist, not five
   * copies of everything ever drawn.
   */
  async save(): Promise<string | null> {
    if (this.#busy) return null;
    // `Mod+S` fires while a callout is being typed into, and the palette's own
    // button keeps focus in the textarea by design. Finishing the edit first is
    // what makes both mean "save what I just wrote" — including the rule that
    // an empty callout is nothing at all and does not reach the file.
    this.#closeEditor("commit");
    if (this.markCount === 0) {
      this.#view.announce("there is nothing to save yet", "warn");
      return null;
    }
    const sourcePath = this.#file.path;
    if (!sourcePath) {
      this.#view.announce("this document has no path on disk to save beside", "warn");
      return null;
    }

    this.#busy = true;
    this.render();

    try {
      const [{ exportAnnotatedPdf, pdfCarriesAnnotatedMarker }, files] = await Promise.all([
        import("../../annotation/export/pdf"),
        import("../../files"),
      ]);

      const bytes = await this.#file.read();
      const known = getAnnotatedTarget(this.#key);
      const target =
        known !== undefined
          ? { path: known, inPlace: known === sourcePath }
          : await resolveAnnotatedTarget(
              { path: sourcePath, carriesMarker: await pdfCarriesAnnotatedMarker(bytes) },
              {
                exists: (path) => files.fileExists(path),
                carriesMarker: async (path) => {
                  try {
                    return await pdfCarriesAnnotatedMarker(await files.readPathBytes(path));
                  } catch {
                    // Unreadable is "not ours", which makes the caller step over
                    // it rather than overwrite something it cannot identify.
                    return false;
                  }
                },
                // Only ever asked on the *first* save of a session, and only
                // when an annotated copy of this document is already on disk:
                // afterwards the target is remembered above and every later
                // save goes straight there without a word.
                confirmReplace: (path) =>
                  files.askAboutFile({
                    title: "Annotated copy already exists",
                    message:
                      `${basename(path)} is already an annotated copy of ` +
                      `${basename(sourcePath)}.\n\n` +
                      `Replace it with these ${this.markCount} mark(s), ` +
                      `or keep it and write a new numbered copy alongside it?`,
                    confirmLabel: `Replace ${basename(path)}`,
                    cancelLabel: "Write a new copy",
                  }),
              },
            );

      const annotated = await exportAnnotatedPdf({
        bytes,
        items: this.#overlay.items,
        textItems: this.#options.textAnnotations?.() ?? [],
      });
      await files.writeFileBytes(target.path, annotated);

      setAnnotatedTarget(this.#key, target.path);
      if (!target.inPlace) {
        // The tile now stands for the companion, and says so wherever it is
        // labelled. Every later save this session lands on the same path, so
        // the original is never written to again.
        this.#options.onDisplayName(basename(target.path));
      }
      this.#view.announce(`saved ${this.markCount} annotation(s) to ${basename(target.path)}`);
      return target.path;
    } catch (thrown) {
      console.error("[pdf] saving annotations failed", thrown);
      this.#view.announce(
        `could not save the annotations — ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        "warn",
      );
      return null;
    } finally {
      this.#busy = false;
      this.render();
      this.#options.onChange();
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  destroy(): void {
    this.#cancelGesture();
    this.#closeEditor("cancel");
    this.#closePopup();
    this.#abort.abort();
    this.#unsubscribeOverlay();
    this.#unlistenDrop?.();
    this.#unlistenDrop = null;
    this.#palette?.destroy();
    this.#palette = null;
    for (const layer of this.#layers.values()) layer.destroy();
    this.#layers.clear();
  }
}

function replace(
  items: readonly OverlayItem[],
  next: OverlayItem,
): readonly OverlayItem[] {
  return items.map((item) => (item.id === next.id ? next : item));
}

/** Applies a style change to whichever fields the item actually has. */
function restyle(item: OverlayItem, patch: Partial<OverlayToolStyle>): OverlayItem {
  const next: OverlayItem = { ...item, updatedAt: Date.now() };
  if (patch.color !== undefined) Object.assign(next, { color: patch.color });
  if (patch.opacity !== undefined) Object.assign(next, { opacity: patch.opacity });
  if (patch.strokeWidth !== undefined && (next.kind === "ink" || next.kind === "shape")) {
    Object.assign(next, { strokeWidth: patch.strokeWidth });
  }
  if (patch.filled !== undefined && next.kind === "shape") {
    Object.assign(next, { fill: patch.filled ? (patch.color ?? next.color) : undefined });
  }
  return next;
}

/** An image's natural size, without keeping the decoded bitmap. */
async function imageSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** Re-encodes anything the browser can decode as a PNG pdf-lib can embed. */
async function reencodeAsPng(
  blob: Blob,
  size: { width: number; height: number },
): Promise<{ bytes: Uint8Array; size: { width: number; height: number } } | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const encoded = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (!encoded) return null;
    return { bytes: new Uint8Array(await encoded.arrayBuffer()), size };
  } catch {
    return null;
  }
}
