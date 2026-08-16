/**
 * Annotating the *words*: the selection popover, the note, and the marks that
 * come back from resolving an anchor.
 *
 * `annotate.ts` owns the drawing tools; this owns everything that starts with a
 * text selection. They are separate for the reason the two models are separate:
 * a drawn highlight is a gesture that produces a position, and a text highlight
 * is a quote that produces a position *later*, every time the document is
 * opened. What they share is the layer that draws them (through
 * `PdfAnnotatorOptions.derivedMarks`), the file they are saved into, and the
 * sidebar list they appear in.
 *
 * ## No mode, and no new listed shortcut
 *
 * Selecting text is something a reader already does, so highlighting it is a
 * popover on the selection rather than a mode to enter — which is also why this
 * phase adds nothing to `actions.ts`. The reference modal is capped at nine
 * listed rows for this plugin (AGENTS.md, and `actions.ts` records what was cut
 * to keep it there); "highlight the current selection" would be a tenth for a
 * gesture that is already two clicks away *at the point the user is looking*,
 * with the popover naming both actions. If a shortcut is ever wanted here, it
 * costs a row and the argument has to be made then.
 *
 * ## The popover is chrome, the highlight is not
 *
 * The strip uses the app's tokens like every other control. The mark it creates
 * uses the highlighter's own colour from `overlayToolPreferences` — the *same*
 * per-tool memory the drawing palette writes to, because the brief is explicit
 * that there is one highlight colour picker in this plugin and not two.
 *
 * ## Reading a note back
 *
 * A comment attached to a sentence has the same problem as a sticky note: its
 * text is not on the page. Clicking the highlight opens a read-only bubble —
 * but by hit-testing the click against the resolved rectangles rather than by
 * letting the mark take pointer events, which is the part worth knowing. A
 * highlight that takes the pointer is a highlight you cannot select text
 * through, and the whole sentence is under it.
 */

import {
  overlayToolPreferences,
  resolveTextAnnotations,
  textAnnotationStamp,
  unionRects,
  type NormalizedPoint,
  type NormalizedRect,
  type OverlayItem,
  type ResolvedTextAnnotation,
  type TextAnnotationDocument,
  type TextAnnotationItem,
} from "../../annotation";
import type { PdfTextGeometry } from "./textGeometry";
import { clamp, noteBubbleBox, placeOverPage } from "./util";
import type { PdfView } from "./view";

/** How far a pointer may travel and still count as a click, in CSS pixels. */
const CLICK_SLOP = 4;

/** Space between the selection and the popover, in CSS pixels. */
const POPOVER_GAP = 6;

/**
 * How long the selection must hold still before the popover is offered, in ms.
 *
 * `selectionchange` fires on every keystroke of a shift+arrow extension and
 * several times over a double-click, and each one would otherwise place the
 * strip against a box that is about to move. Short enough to read as immediate,
 * long enough that the popover lands once.
 */
const POPOVER_SETTLE = 50;

export interface PdfTextAnnotatorOptions {
  readonly view: PdfView;
  readonly geometry: PdfTextGeometry;
  readonly document: TextAnnotationDocument;
  /** Whether the drawing tools currently own the page. */
  annotating(): boolean;
  /** Fires whenever the layers, the toolbar or the sidebar list would change. */
  onChange(): void;
}

export class PdfTextAnnotator {
  #view: PdfView;
  #geometry: PdfTextGeometry;
  #doc: TextAnnotationDocument;
  #options: PdfTextAnnotatorOptions;

  #resolved: readonly ResolvedTextAnnotation[] = [];
  #marks: readonly OverlayItem[] = [];

  #popover: HTMLElement | null = null;
  #editor: { element: HTMLTextAreaElement; id: string } | null = null;
  #popup: { element: HTMLElement; id: string } | null = null;

  /** Where the pointer went down, so a drag can be told from a click. */
  #pressed: { x: number; y: number } | null = null;
  /** The pending "the selection has settled, offer the popover" timer. */
  #settle: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every resolution pass; a stale one drops its own result. */
  #generation = 0;
  #destroyed = false;

  #unsubscribe: () => void;
  #abort = new AbortController();

  constructor(options: PdfTextAnnotatorOptions) {
    this.#options = options;
    this.#view = options.view;
    this.#geometry = options.geometry;
    this.#doc = options.document;

    this.#unsubscribe = this.#doc.subscribe((reason) => {
      // `place` is this class writing back what it just resolved. Re-resolving
      // on it would be a loop; redrawing on it is the point.
      if (reason === "place") this.#options.onChange();
      else void this.refresh();
    });

    const signal = this.#abort.signal;
    // On the window rather than the tile: a selection drag very often ends with
    // the pointer outside the scroller, and that release is the one that says
    // the selection is finished.
    window.addEventListener("pointerdown", this.#onPointerDown, { signal });
    window.addEventListener("pointerup", this.#onPointerUp, { signal });
    window.addEventListener("keydown", this.#onKeyDown, { signal });
    document.addEventListener("selectionchange", this.#onSelectionChange, { signal });
    this.#view.scroller.addEventListener("scroll", this.#onScroll, {
      passive: true,
      signal,
    });

    // Marks restored with the document have to appear without waiting for a
    // selection, exactly as the drawn ones do.
    void this.refresh();
  }

  // -------------------------------------------------------------------------
  // What the rest of the plugin reads
  // -------------------------------------------------------------------------

  /** The resolved marks, as the rectangles the annotation layer draws. */
  get marks(): readonly OverlayItem[] {
    return this.#marks;
  }

  /** Every item with where it currently resolves to, for the export. */
  get annotations(): readonly ResolvedTextAnnotation[] {
    return this.#resolved;
  }

  get count(): number {
    return this.#doc.items.length;
  }

  /** Deletes one mark. Unknown ids are someone else's, and are ignored. */
  remove(id: string): boolean {
    if (!this.#doc.find(id)) return false;
    if (this.#editor?.id === id) this.#closeEditor("cancel");
    if (this.#popup?.id === id) this.#closePopup();
    this.#doc.remove(id);
    return true;
  }

  /**
   * Re-resolves every anchor against the document as it is now.
   *
   * Cheap to call: the geometry caches a page's text, so a second pass over ten
   * marks on three pages costs three map lookups and the matching itself.
   */
  async refresh(): Promise<void> {
    if (this.#destroyed) return;
    const token = ++this.#generation;
    const resolved = await resolveTextAnnotations(this.#doc.items, this.#geometry);
    if (this.#destroyed || token !== this.#generation) return;

    this.#resolved = resolved;
    this.#marks = resolved
      .filter((entry) => entry.placement.rects.length > 0)
      .map((entry) => markOf(entry));
    this.#doc.setPlacements(resolved);
    this.#refreshPopup();
    this.#positionEditor();
    this.#options.onChange();
  }

  /**
   * The drawing tools were turned on or off.
   *
   * Entering annotate mode takes the pointer away from the text layer, so an
   * offer to highlight a selection the user can no longer see selected has to go
   * with it. Called by the instance, which is the only thing that knows about
   * both annotators.
   */
  modeChanged(): void {
    if (!this.#options.annotating()) return;
    this.#hidePopover();
    this.#closeEditor("commit");
    this.#closePopup();
  }

  /** The scale or a page's box changed; the bubbles are in page space and follow. */
  syncLayout(): void {
    this.#positionEditor();
    this.#positionPopup();
    this.#positionPopover();
  }

  // -------------------------------------------------------------------------
  // The selection popover
  // -------------------------------------------------------------------------

  #onPointerDown = (event: PointerEvent): void => {
    if (this.#inOwnUi(event.target)) return;
    this.#pressed = { x: event.clientX, y: event.clientY };
    this.#hidePopover();
  };

  #onPointerUp = (event: PointerEvent): void => {
    const pressed = this.#pressed;
    this.#pressed = null;
    if (this.#inOwnUi(event.target)) return;

    const moved =
      !pressed ||
      Math.abs(event.clientX - pressed.x) > CLICK_SLOP ||
      Math.abs(event.clientY - pressed.y) > CLICK_SLOP;

    // A release that did not travel is also a click, which is how a note is
    // opened or dismissed. It is *not* exclusive with having selected
    // something: a double-click selects a word without the pointer moving at
    // all, which is why this no longer returns here. Asking for the popover
    // unconditionally is safe — it takes itself away when there is no
    // selection to act on.
    if (!moved) this.#handleClick(event);
    this.#settlePopover();
  };

  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (this.#editor) return; // the textarea's own handler commits it
    if (!this.#popover && !this.#popup) return;
    event.preventDefault();
    this.#hidePopover();
    this.#closePopup();
  };

  /**
   * The selection changed by *some* means.
   *
   * This is what makes the offer independent of how the words were chosen. The
   * first version hung the popover off a pointer release that had travelled
   * far enough to be a drag, which is only one of the ways a reader selects
   * text: a double-click on a word, a triple-click on a line, shift+click,
   * shift+arrows and select-all all leave text selected with the pointer
   * having gone nowhere, and every one of them left the reader looking at
   * their own selection with nothing offered about it.
   *
   * The pointer being down is the one case to sit out. Mid-drag the selection
   * changes on every mouse move, and a strip chasing the pointer would be in
   * front of the words being selected; the release schedules it instead.
   */
  #onSelectionChange = (): void => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      this.#hidePopover();
      return;
    }
    if (this.#pressed) return;
    this.#settlePopover();
  };

  #onScroll = (): void => {
    this.#positionPopover();
  };

  /** Whether an event landed on this class's own chrome. */
  #inOwnUi(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      !!target.closest(".pdf-text-popover, .pdf-annot-editor, .pdf-annot-note-popup")
    );
  }

  /**
   * Offers the popover once the selection stops moving.
   *
   * Also covers the ordering: a release is processed before the browser has
   * finished settling the selection it produced, so asking straight away would
   * read the old one.
   */
  #settlePopover(): void {
    if (this.#settle !== null) clearTimeout(this.#settle);
    this.#settle = setTimeout(() => {
      this.#settle = null;
      this.#showPopoverForSelection();
    }, POPOVER_SETTLE);
  }

  #showPopoverForSelection(): void {
    if (this.#destroyed) return;
    // With the drawing tools live the text layer does not take the pointer at
    // all, so there is nothing to select — and an offer to highlight a stale
    // selection would act on words the user can no longer see selected.
    if (this.#options.annotating()) {
      this.#hidePopover();
      return;
    }

    const range = this.#selectionRange();
    if (!range) {
      this.#hidePopover();
      return;
    }

    this.#popover ??= this.#createPopover();
    this.#positionPopover(range);
  }

  /** The current selection, if it is a real one inside this tile's text. */
  #selectionRange(): Range | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!this.#view.root.contains(range.commonAncestorContainer)) return null;
    const start =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    if (!start?.closest(".textLayer")) return null;
    return range.toString().trim() ? range : null;
  }

  #createPopover(): HTMLElement {
    const root = document.createElement("div");
    root.className = "pdf-text-popover";
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "annotate the selection");

    root.append(
      popoverButton("highlight", "highlight the selected text", () =>
        void this.#create(false),
      ),
      popoverButton("note", "highlight the selection and add a note", () =>
        void this.#create(true),
      ),
    );

    this.#view.root.append(root);
    return root;
  }

  #positionPopover(range?: Range): void {
    const popover = this.#popover;
    if (!popover) return;
    const live = range ?? this.#selectionRange();
    if (!live) {
      this.#hidePopover();
      return;
    }

    const box = live.getBoundingClientRect();
    const root = this.#view.root.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) {
      this.#hidePopover();
      return;
    }

    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = clamp(
      box.left + box.width / 2 - width / 2 - root.left,
      4,
      Math.max(4, root.width - width - 4),
    );
    // Below the selection, unless that would fall out of the tile — in which
    // case above it, which is where a popover goes when there is no room.
    const below = box.bottom - root.top + POPOVER_GAP;
    const top =
      below + height <= root.height
        ? below
        : Math.max(4, box.top - root.top - height - POPOVER_GAP);

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  #hidePopover(): void {
    if (this.#settle !== null) {
      clearTimeout(this.#settle);
      this.#settle = null;
    }
    this.#popover?.remove();
    this.#popover = null;
  }

  // -------------------------------------------------------------------------
  // Creating a mark
  // -------------------------------------------------------------------------

  async #create(withNote: boolean): Promise<void> {
    const anchor = await this.#geometry.anchorForSelection();
    this.#hidePopover();
    if (!anchor) {
      this.#view.announce("select some text to annotate it", "warn");
      return;
    }

    // The highlighter's own colour and opacity, from the one per-tool memory
    // this plugin has. Choosing a colour in the drawing palette changes the one
    // this uses next, which is what "there is one picker" has to mean.
    const style = overlayToolPreferences.get("highlight");
    const item: TextAnnotationItem = {
      ...textAnnotationStamp(),
      anchor,
      color: style.color,
      opacity: style.opacity,
      ...(withNote ? { note: "" } : {}),
    };

    this.#doc.add(item);
    window.getSelection()?.removeAllRanges();
    await this.refresh();
    if (this.#destroyed) return;

    if (withNote) this.#openEditor(item.id);
    else this.#view.announce(`highlighted “${preview(anchor.quote)}”`);
  }

  // -------------------------------------------------------------------------
  // The note
  // -------------------------------------------------------------------------

  #openEditor(id: string): void {
    this.#closeEditor("commit");
    const item = this.#doc.find(id);
    if (!item) return;
    const page = this.#view.pages[this.#subdivisionOf(item)];
    if (!page) return;

    const element = document.createElement("textarea");
    element.className = "pdf-annot-editor";
    element.value = item.note ?? "";
    element.placeholder = "note…";
    element.spellcheck = false;

    element.addEventListener("keydown", (event) => {
      if (
        event.key === "Escape" ||
        (event.key === "Enter" && (event.ctrlKey || event.metaKey))
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.#closeEditor("commit");
      }
    });
    element.addEventListener("blur", () => this.#closeEditor("commit"));

    page.root.append(element);
    this.#editor = { element, id };
    this.#positionEditor();
    element.focus({ preventScroll: true });
    element.setSelectionRange(element.value.length, element.value.length);
    this.#options.onChange();
  }

  /**
   * Commits or abandons the note.
   *
   * An emptied note leaves the highlight behind rather than deleting the mark.
   * That is the difference from a sticky note, and it follows from the model:
   * the user selected words and asked for them to be marked, and the comment is
   * something they then chose not to write. Deleting the highlight too would
   * throw away the half of the action that succeeded.
   */
  #closeEditor(how: "commit" | "cancel"): void {
    const editor = this.#editor;
    if (!editor) return;
    this.#editor = null;
    const text = editor.element.value.trim();
    editor.element.remove();

    if (how === "commit") {
      this.#doc.update(editor.id, (item) => ({
        ...item,
        note: text || undefined,
        updatedAt: Date.now(),
      }));
    }
    this.#options.onChange();
  }

  #positionEditor(): void {
    const editor = this.#editor;
    if (!editor) return;
    const item = this.#doc.find(editor.id);
    if (!item) {
      this.#closeEditor("cancel");
      return;
    }
    const box = this.#bubbleBox(item);
    if (box) placeOverPage(editor.element, box);
  }

  // -------------------------------------------------------------------------
  // Reading a note back
  // -------------------------------------------------------------------------

  /**
   * What a click does: open the note under the pointer, close the open one, and
   * otherwise nothing at all.
   *
   * Hit-tested against the resolved rectangles rather than by making the marks
   * take pointer events — see the module comment. A mark with no note is not a
   * target: there is nothing to show, and swallowing the click would only stop
   * the user putting the caret in the middle of their own highlight.
   */
  #handleClick(event: PointerEvent): void {
    if (this.#destroyed || this.#options.annotating()) return;
    if (this.#editor) return;

    const at = this.#pointFromClient(event.clientX, event.clientY);
    if (!at) {
      this.#closePopup();
      return;
    }

    // Front to back, so the newest note wins where two overlap.
    for (const entry of [...this.#resolved].reverse()) {
      if (!entry.item.note?.trim()) continue;
      if (entry.placement.subdivision !== at.subdivision) continue;
      if (!entry.placement.rects.some((rect) => contains(rect, at.point))) continue;
      if (this.#popup?.id === entry.item.id) this.#closePopup();
      else this.#openPopup(entry.item.id);
      return;
    }
    this.#closePopup();
  }

  #openPopup(id: string): void {
    this.#closePopup();
    const item = this.#doc.find(id);
    if (!item) return;
    const page = this.#view.pages[this.#subdivisionOf(item)];
    if (!page) return;

    const element = document.createElement("div");
    element.className = "pdf-annot-note-popup";
    element.setAttribute("role", "note");
    page.root.append(element);

    this.#popup = { element, id };
    this.#refreshPopup();
    this.#positionPopup();
  }

  /** Keeps the open note in step with the model, or closes it. */
  #refreshPopup(): void {
    const popup = this.#popup;
    if (!popup) return;
    const item = this.#doc.find(popup.id);
    if (!item?.note?.trim()) {
      this.#closePopup();
      return;
    }
    // `textContent`: a note is text the user typed, never markup to be parsed.
    popup.element.textContent = item.note;
  }

  #positionPopup(): void {
    const popup = this.#popup;
    if (!popup) return;
    const item = this.#doc.find(popup.id);
    if (!item) {
      this.#closePopup();
      return;
    }
    const box = this.#bubbleBox(item);
    if (box) placeOverPage(popup.element, box);
  }

  #closePopup(): void {
    this.#popup?.element.remove();
    this.#popup = null;
  }

  // -------------------------------------------------------------------------
  // Geometry helpers
  // -------------------------------------------------------------------------

  #subdivisionOf(item: TextAnnotationItem): number {
    return this.#doc.placement(item.id)?.subdivision ?? item.anchor.pageHint;
  }

  /** Where a bubble for this item goes: beside its first line. */
  #bubbleBox(item: TextAnnotationItem): NormalizedRect | null {
    const subdivision = this.#subdivisionOf(item);
    const page = this.#view.pages[subdivision];
    if (!page) return null;
    const first = this.#doc.placement(item.id)?.rects[0];
    const anchor = first ?? { x: 0.1, y: 0.1, width: 0, height: 0 };
    return noteBubbleBox(anchor, page.dimensions);
  }

  /** Which page a client-space point is over, and where on it. */
  #pointFromClient(
    clientX: number,
    clientY: number,
  ): { subdivision: number; point: NormalizedPoint } | null {
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
          subdivision: page.pageNumber - 1,
          point: {
            x: (clientX - box.left) / box.width,
            y: (clientY - box.top) / box.height,
          },
        };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  destroy(): void {
    this.#destroyed = true;
    this.#generation += 1;
    this.#abort.abort();
    this.#unsubscribe();
    this.#hidePopover();
    this.#closeEditor("cancel");
    this.#closePopup();
  }
}

/**
 * A resolved anchor as the thing the annotation layer already knows how to draw.
 *
 * Deliberately an `OverlayItem` and not a new shape: once the quote has been
 * found, a text highlight *is* a set of rectangles with a colour, which is what
 * a drawn highlight is. It carries the text item's own id, so a click, a
 * deletion and an exported `/NM` all name the same mark.
 */
function markOf(entry: ResolvedTextAnnotation): OverlayItem {
  return {
    id: entry.item.id,
    kind: "highlight",
    subdivision: entry.placement.subdivision,
    color: entry.item.color,
    opacity: entry.item.opacity,
    rects: entry.placement.rects,
    bounds: unionRects(entry.placement.rects),
    createdAt: entry.item.createdAt,
    updatedAt: entry.item.updatedAt,
  };
}

function contains(rect: NormalizedRect, point: NormalizedPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function preview(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > 32 ? `${flat.slice(0, 31)}…` : flat;
}

function popoverButton(
  label: string,
  title: string,
  run: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pdf-annot-button";
  button.textContent = label;
  button.title = title;
  // The selection is the input to both actions, and focusing a button clears
  // it in some engines. Same reason the drawing palette does this.
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  button.addEventListener("click", run);
  return button;
}
