/**
 * The mounted PDF viewer: the class the contract's `ViewerInstance` names.
 *
 * It owns the document handle and the state, and delegates everything else —
 * the scroller, virtualization and render queue to `view.ts`, one page's
 * resources to `page.ts`. What lives *here* is the parts the contract asks
 * for: the capability set, the toolbar and keybind contributions, search, copy,
 * thumbnails, state round-tripping, and a `dispose()` that provably gives
 * everything back.
 */

import {
  annotationDocumentKey,
  overlayDocumentFor,
  summarizeOverlayItems,
  summarizeTextAnnotations,
  textDocumentFor,
  type AnnotationExportOptions,
  type AnnotationExportResult,
  type AnnotationSummary,
  type NormalizedRect,
  type TextAnnotationDocument,
} from "../../annotation";
import type { FileHandle } from "../../files";
import {
  BaseViewerInstance,
  type CopyableContent,
  type CopyScope,
  type SearchQuery,
  type SearchMatch,
  type TextSegment,
  type ThumbnailRequest,
  type ThumbnailResult,
  type ToolbarControl,
  type Unsubscribe,
  type ViewerAnnotationApi,
  type ViewerCapabilities,
  type ViewerCopyApi,
  type ViewerHost,
  type ViewerInstance,
  type ViewerKeybind,
  type ViewerKeybindApi,
  type ViewerLocation,
  type ViewerSearchApi,
  type ViewerToolbarApi,
} from "../contract";
import { pdfKeybinds, pdfToolbarControls, type PdfActions } from "./actions";
import { PdfAnnotator } from "./annotate";
import { PDF_PLUGIN_ID } from "./id";
import { getPdfOcr } from "./ocr";
import type { PdfDocument } from "./pdfjs";
import { printDocument } from "./print";
import { parsePdfState, type PdfViewerState } from "./state";
import { PdfTextAnnotator } from "./textAnnotate";
import { PdfTextGeometry } from "./textGeometry";
import { PdfThumbnailCache } from "./thumbnails";
import { clamp } from "./util";
import { PdfView } from "./view";

/**
 * How many pages to look at before deciding the document has no text.
 *
 * One is not enough: a native PDF whose cover is a full-page image would be
 * declared unsearchable. Four is enough for every real cover-plus-front-matter
 * arrangement and is still four cheap `getTextContent` calls rather than a scan
 * of the whole document, which for a 900-page book would be the slowest part of
 * opening it.
 */
export const TEXT_PROBE_PAGES = 4;

/** Fewer than this many non-space characters on a page is furniture, not text. */
export const MIN_TEXT_CHARS = 12;

export interface PdfInstanceInit {
  readonly container: HTMLElement;
  readonly file: FileHandle;
  readonly document: PdfDocument;
  readonly pageSizes: readonly { width: number; height: number }[];
  readonly hasText: boolean;
  readonly initialState: unknown;
  readonly host?: ViewerHost;
}

export class PdfViewerInstance extends BaseViewerInstance implements ViewerInstance {
  readonly pluginId = PDF_PLUGIN_ID;
  readonly file: FileHandle;
  readonly capabilities: ViewerCapabilities;

  readonly toolbar: ViewerToolbarApi;
  readonly keybinds: ViewerKeybindApi;
  readonly search?: ViewerSearchApi;
  readonly copy: ViewerCopyApi;
  readonly annotation: ViewerAnnotationApi;

  #document: PdfDocument;
  #view: PdfView;
  #thumbnails: PdfThumbnailCache;
  #annotator: PdfAnnotator;
  #geometry: PdfTextGeometry;
  /**
   * Assigned after {@link #annotator}, which is why it is optional here: the
   * two know about each other (one draws the other's marks) and something has to
   * be built first.
   */
  #textAnnotator: PdfTextAnnotator | undefined;
  #textDocument: TextAnnotationDocument;
  #host: ViewerHost | undefined;

  /** OCR results the user asked for, so a second copy does not re-run the model. */
  #ocrText = new Map<number, string>();
  /** Highlight elements drawn by `reveal`, cleared by `clearHighlights`. */
  #highlights: HTMLElement[] = [];

  #toolbarListeners = new Set<() => void>();
  #selectionListeners = new Set<() => void>();
  #annotationListeners = new Set<() => void>();
  #abort = new AbortController();
  #disposing = false;

  constructor(init: PdfInstanceInit) {
    super();
    this.file = init.file;
    this.#document = init.document;
    this.#host = init.host;

    const initial = parsePdfState(init.initialState);

    this.capabilities = {
      // A PDF with no text layer at all is genuinely not searchable, and the
      // contract says a plugin reports the capability it has *after* mount
      // resolves. Reporting `true` regardless would put a search box on a tile
      // that can only ever return nothing.
      search: init.hasText,
      copy: true,
      // Phase 05a. Every PDF can be drawn on, so this is unconditional — unlike
      // `search`, which depends on the document actually having text.
      annotation: true,
      toolbar: true,
      keybinds: true,
      thumbnail: true,
      subdivisionCount: init.pageSizes.length,
    };

    this.#thumbnails = new PdfThumbnailCache(init.document);

    this.#view = new PdfView({
      container: init.container,
      document: init.document,
      pageSizes: init.pageSizes,
      callbacks: {
        // Every one of these republishes the toolbar, which is what keeps the
        // page readout, the zoom readout and the invert toggle showing what the
        // tile is actually doing however the change was made.
        onPageChange: () => this.#notifyToolbar(),
        onZoomChange: () => this.#notifyToolbar(),
        onPersist: () => this.#host?.requestPersist(),
        onRenderError: (pageNumber, thrown) => {
          // One page failing is not the document failing. Say so in the strip
          // and leave the rest of the tile working.
          const detail = thrown instanceof Error ? thrown.message : String(thrown);
          console.error(`[pdf] page ${pageNumber} failed to render`, thrown);
          // Also to the terminal in dev. The webview console is unreadable from
          // outside the app on all three platforms, so without this a page that
          // renders blank is indistinguishable from a page that renders slowly
          // — which cost real time during phase 03.
          if (import.meta.env.DEV) {
            void import("../../dev/log").then(({ devLog }) =>
              devLog(`pdf: page ${pageNumber} failed to render — ${detail}`),
            );
          }
          // The reason goes in the strip, not just the console. "page 3 could
          // not be rendered" is the same sentence whether the webview stopped
          // painting, the decoder never sent the page, or the file is damaged —
          // and the console and `devLog` that used to carry the difference are
          // both unreachable in a release build, which is where these are seen.
          this.#view.announce(`page ${pageNumber} could not be rendered — ${detail}`, "warn");
        },
        // Fires during the view's own construction, before `#annotator` is
        // assigned — hence the optional call rather than an assertion.
        onLayout: () => {
          this.#annotator?.syncLayout();
          this.#textAnnotator?.syncLayout();
        },
      },
    });

    this.#geometry = new PdfTextGeometry({
      document: init.document,
      pageCount: init.pageSizes.length,
      root: this.#view.root,
    });

    // Annotations belong to the file, not to this tile: closing a document and
    // reopening it finds the same marks, and two tiles on one file share them.
    // Both models are keyed the same way, for the same reason.
    const documentKey = annotationDocumentKey(init.file);
    this.#textDocument = textDocumentFor(documentKey);
    this.#annotator = new PdfAnnotator({
      view: this.#view,
      file: init.file,
      documentKey,
      overlay: overlayDocumentFor(documentKey),
      onChange: () => {
        // Includes the mode being turned on, which the selection popover has to
        // hear about: it offers to annotate a selection the drawing tools have
        // just taken the pointer away from.
        this.#textAnnotator?.modeChanged();
        this.#notifyToolbar();
        this.#notifyAnnotations();
      },
      onDisplayName: (name) => this.#host?.setDisplayName(name),
      // The two seams between the models: one layer draws every mark on a page,
      // and one save writes every mark in the file.
      derivedMarks: () => this.#textAnnotator?.marks ?? [],
      textAnnotations: () => this.#textAnnotator?.annotations ?? [],
    });

    this.#textAnnotator = new PdfTextAnnotator({
      view: this.#view,
      geometry: this.#geometry,
      document: this.#textDocument,
      annotating: () => this.#annotator.enabled,
      onChange: () => {
        this.#annotator.render();
        this.#notifyToolbar();
        this.#notifyAnnotations();
      },
    });

    this.toolbar = {
      getControls: () => this.#toolbarControls(),
      onControlsChange: (listener) => subscribe(this.#toolbarListeners, listener),
    };

    this.keybinds = {
      groupTitle: "PDF",
      getKeybinds: () => this.#keybindDefinitions(),
    };

    if (init.hasText) {
      this.search = {
        extractText: (options) => this.#extractText(options),
        find: (query) => this.#find(query),
        reveal: (location, options) => this.reveal(location, options),
        clearHighlights: () => this.clearHighlights(),
      };
    }

    this.copy = {
      getCopyable: (scope) => this.#getCopyable(scope),
      hasSelection: () => this.#selectedText().length > 0,
      onSelectionChange: (listener) => subscribe(this.#selectionListeners, listener),
      locateRegion: (tileRect) => this.#locateRegion(tileRect),
    };

    this.annotation = {
      exportFormats: ["pdf"],
      listAnnotations: () => this.#listAnnotations(),
      onAnnotationsChange: (listener) =>
        subscribe(this.#annotationListeners, listener),
      // Whichever model owns it. The shell has one list and one delete, which
      // is the whole reason the summary carries an opaque id.
      removeAnnotation: (id) => {
        if (!this.#textAnnotator?.remove(id)) this.#annotator.remove(id);
      },
      textAnchors: this.#geometry,
      export: (options) => this.#exportAnnotated(options),
    };

    document.addEventListener("selectionchange", this.#onSelectionChange, {
      signal: this.#abort.signal,
    });

    // Restore before the first render so the initial pass renders the right
    // pages at the right scale, rather than rendering page 1 and then jumping.
    this.#view.setInverted(initial.inverted);
    this.#view.setZoomState({ mode: initial.zoomMode, zoom: initial.zoom });
    this.#view.goToPage(initial.page);

    this.setStatus("ready");
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * The verb list `actions.ts` turns into a toolbar and a keybind section.
   *
   * Every field is read from the view at the moment it is asked for, and every
   * method goes through the same setter the toolbar does. That is what makes
   * the button and the shortcut two ways to run one action rather than two
   * implementations that can disagree: press `i` and the toolbar toggle moves,
   * because both are reading `view.inverted`.
   */
  #actions(): PdfActions {
    return {
      pageNumber: this.#view.currentPage,
      pageCount: this.#view.pageCount,
      zoomPercent: this.#view.zoomPercent,
      inverted: this.#view.inverted,

      annotating: this.#annotator.enabled,
      canUndoAnnotation: this.#annotator.overlay.canUndo,
      canRedoAnnotation: this.#annotator.overlay.canRedo,
      hasAnnotationSelection: this.#annotator.selected !== null,
      editingAnnotation: this.#annotator.editing,
      // Both models: `Mod+S` and the palette's save button write one file.
      hasAnnotations: this.#annotator.markCount > 0,

      nextPage: () => this.#view.goToPage(this.#view.currentPage + 1),
      previousPage: () => this.#view.goToPage(this.#view.currentPage - 1),

      zoomIn: () => this.#view.stepZoom(1),
      zoomOut: () => this.#view.stepZoom(-1),
      fitWidth: () => this.#view.fitWidth(),

      setInverted: (inverted) => this.#setInverted(inverted),
      toggleInverted: () => this.#setInverted(!this.#view.inverted),

      setAnnotating: (annotating) => this.#annotator.setEnabled(annotating),
      toggleAnnotating: () => this.#annotator.setEnabled(!this.#annotator.enabled),
      undoAnnotation: () => this.#annotator.undo(),
      redoAnnotation: () => this.#annotator.redo(),
      deleteAnnotation: () => this.#annotator.deleteSelection(),
      escapeAnnotation: () => this.#annotator.escape(),
      // The same call the palette's save button makes, so `Mod+S` and the chip
      // are two ways to run one action rather than two implementations.
      saveAnnotations: () => void this.#annotator.save(),

      extractTextWithOcr: () => void this.#extractWithOcr(this.#view.currentPage),
      print: () => void this.#print(),
    };
  }

  /**
   * The annotated document, as bytes.
   *
   * The contract's export, which hands the caller the file rather than writing
   * it; the palette's save button goes through `PdfAnnotator.save`, which adds
   * the target-path policy on top. Both produce the same bytes from the same
   * pipeline — there is one export path, not two.
   */
  async #exportAnnotated(
    options: AnnotationExportOptions,
  ): Promise<AnnotationExportResult> {
    if (options.format !== "pdf") {
      throw new Error(`the PDF plugin cannot export annotations as ${options.format}`);
    }
    const bytes = await this.#annotator.exportBytes();
    const dot = this.file.name.lastIndexOf(".");
    const stem = dot > 0 ? this.file.name.slice(0, dot) : this.file.name;
    return {
      format: "pdf",
      mimeType: "application/pdf",
      bytes,
      suggestedName: `${stem}-annotated.pdf`,
    };
  }

  #setInverted(inverted: boolean): void {
    if (this.#view.inverted === inverted) return;
    this.#view.setInverted(inverted);
    this.#notifyToolbar();
    this.#host?.requestPersist();
  }

  async #print(): Promise<void> {
    this.#view.announce("preparing to print…");
    await printDocument({
      file: this.file,
      document: this.#document,
      onError: (message, detail) => {
        this.#host?.reportError({ code: "internal", message, detail, recoverable: true });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Contributions
  // -------------------------------------------------------------------------

  #toolbarControls(): readonly ToolbarControl[] {
    return pdfToolbarControls(this.#actions());
  }

  #keybindDefinitions(): readonly ViewerKeybind[] {
    return pdfKeybinds(this.#actions());
  }

  #notifyToolbar(): void {
    for (const listener of this.#toolbarListeners) listener();
  }

  #notifyAnnotations(): void {
    for (const listener of this.#annotationListeners) listener();
  }

  /**
   * Both models' marks, in one list, newest first.
   *
   * The sidebar gets one list and not two — the phase brief is explicit about
   * that, and it is right: "what is on this document" is one question, and a
   * reviewer does not think of a drawn highlight and a highlighted sentence as
   * living in different places. They stay distinguishable by their `type` word
   * (`highlight` and `note` are drawn; `quote` and `comment` are anchored to
   * text) and by their labels, which for an anchored mark are the words it is
   * attached to.
   */
  #listAnnotations(): readonly AnnotationSummary[] {
    const drawn = summarizeOverlayItems(this.#annotator.overlay.items);
    const anchored = summarizeTextAnnotations(this.#textDocument.items, (id) =>
      this.#textDocument.placement(id),
    );
    return [...drawn, ...anchored].sort((a, b) => b.createdAt - a.createdAt);
  }

  // -------------------------------------------------------------------------
  // Text: extraction, search, copy, OCR
  // -------------------------------------------------------------------------

  /**
   * One page's text items, plus each item's box in normalized page space.
   *
   * Derived from `textGeometry.ts` rather than from `getTextContent` directly,
   * since phase 05b: the offsets a search reports, the offsets an anchor records
   * and the offsets a highlight is drawn from have to be the same offsets, and
   * two extractions that agree today are two extractions that can drift.
   */
  async #pageSegments(pageNumber: number): Promise<TextSegment[]> {
    const page = await this.#geometry.page(pageNumber);
    return page.boxes.map((box) => {
      // The item's own characters plus the newline that follows it, which is
      // what the shell's segment list has always contained.
      const end = box.end + (box.eol ? 1 : 0);
      return {
        text: page.text.slice(box.start, end),
        location: {
          subdivision: pageNumber - 1,
          range: { start: box.start, end },
          rect: box.rect,
        },
      };
    });
  }

  async #extractText(options?: {
    readonly subdivision?: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly TextSegment[]> {
    if (options?.subdivision !== undefined) {
      options.signal?.throwIfAborted();
      return this.#pageSegments(options.subdivision + 1);
    }

    const all: TextSegment[] = [];
    for (let pageNumber = 1; pageNumber <= this.#view.pageCount; pageNumber += 1) {
      options?.signal?.throwIfAborted();
      all.push(...(await this.#pageSegments(pageNumber)));
    }
    return all;
  }

  /**
   * Plugin-side search.
   *
   * Implemented — rather than left to the shell's matching over
   * {@link #extractText} — for the one reason the contract names: hit
   * rectangles. A match inside a text item gets a box interpolated across that
   * item's width, which is close enough to highlight accurately and is
   * something the shell cannot derive from a segment list.
   */
  async #find(query: SearchQuery): Promise<readonly SearchMatch[]> {
    const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
    if (!needle) return [];

    const matches: SearchMatch[] = [];
    const limit = query.limit ?? Infinity;

    for (let pageNumber = 1; pageNumber <= this.#view.pageCount; pageNumber += 1) {
      query.signal?.throwIfAborted();
      if (matches.length >= limit) break;

      for (const segment of await this.#pageSegments(pageNumber)) {
        const haystack = query.caseSensitive ? segment.text : segment.text.toLowerCase();
        let from = 0;
        for (;;) {
          const at = haystack.indexOf(needle, from);
          if (at < 0) break;
          from = at + Math.max(1, needle.length);

          const rect = segment.location.rect;
          const start = segment.location.range?.start ?? 0;
          matches.push({
            text: segment.text.slice(at, at + query.text.length),
            context: segment.text.trim(),
            location: {
              subdivision: pageNumber - 1,
              range: { start: start + at, end: start + at + query.text.length },
              rect: rect
                ? {
                    // Interpolated across the item's own box. Exact per-glyph
                    // advances would need the font metrics, which is a lot of
                    // work for a highlight.
                    x: rect.x + (rect.width * at) / Math.max(1, segment.text.length),
                    y: rect.y,
                    width:
                      (rect.width * query.text.length) /
                      Math.max(1, segment.text.length),
                    height: rect.height,
                  }
                : undefined,
            },
          });
          if (matches.length >= limit) break;
        }
        if (matches.length >= limit) break;
      }
    }

    return matches;
  }

  /** The user's selection, but only the part inside this tile. */
  #selectedText(): string {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
    const range = selection.getRangeAt(0);
    // Two tiles can be open at once; a selection in the other one is not ours.
    if (!this.#view.root.contains(range.commonAncestorContainer)) return "";
    return selection.toString();
  }

  #onSelectionChange = (): void => {
    for (const listener of this.#selectionListeners) listener();
  };

  async #pageText(pageNumber: number): Promise<string> {
    const segments = await this.#pageSegments(pageNumber);
    const native = segments.map((segment) => segment.text).join("");
    if (native.trim()) return native;
    // A scanned page. Whatever OCR the user has already asked for stands in;
    // OCR is never run implicitly (see `#extractWithOcr`).
    return this.#ocrText.get(pageNumber) ?? "";
  }

  async #getCopyable(scope: CopyScope): Promise<readonly CopyableContent[]> {
    if (scope.kind === "selection") {
      const text = this.#selectedText();
      return text ? [{ kind: "text", text }] : [];
    }

    if (scope.kind === "all") {
      if (scope.subdivision !== undefined) {
        const text = await this.#pageText(scope.subdivision + 1);
        return text.trim() ? [{ kind: "text", text }] : [];
      }
      const parts: string[] = [];
      for (let pageNumber = 1; pageNumber <= this.#view.pageCount; pageNumber += 1) {
        parts.push(await this.#pageText(pageNumber));
      }
      const text = parts.join("\n\n");
      return text.trim() ? [{ kind: "text", text }] : [];
    }

    // A region: both flavours, richest first, and the shell decides. This is
    // the case the contract's "may legitimately yield both" is written for.
    const pageNumber = (scope.subdivision ?? 0) + 1;
    const out: CopyableContent[] = [];

    const text = await this.#regionText(pageNumber, scope.rect);
    if (text.trim()) out.push({ kind: "text", text });

    const image = await this.#regionImage(pageNumber, scope.rect);
    if (image) out.push(image);

    return out;
  }

  /**
   * Every text item whose box overlaps the rect, in reading order.
   *
   * Native text only. A scanned region yields nothing here and that is correct:
   * the brief is explicit that OCR runs only when the user invokes it, so a
   * rubber-band copy must not quietly start a model.
   */
  async #regionText(pageNumber: number, rect: NormalizedRect): Promise<string> {
    const segments = await this.#pageSegments(pageNumber);
    return segments
      .filter((segment) => {
        const box = segment.location.rect;
        if (!box) return false;
        return (
          box.x < rect.x + rect.width &&
          box.x + box.width > rect.x &&
          box.y < rect.y + rect.height &&
          box.y + box.height > rect.y
        );
      })
      .map((segment) => segment.text)
      .join("");
  }

  /**
   * Phase 06's region copy: which page a box drawn over the tile landed on,
   * and where on that page.
   *
   * The page with the largest overlap wins, which is the only rule that gives a
   * sensible answer for a band dragged across a page boundary in a continuously
   * scrolled document: one region, on the page most of it is on, rather than a
   * refusal or a silent crop to the first page it touched.
   *
   * The returned rect is normalized to the page's own box, which is what both
   * `#regionText` and `#regionImage` already expect — the same normalization
   * the text layer's geometry uses, so a region's text and its pixels come from
   * the same rectangle by construction.
   */
  #locateRegion(tileRect: NormalizedRect): ViewerLocation | null {
    const tile = this.#view.root.getBoundingClientRect();
    if (tile.width <= 0 || tile.height <= 0) return null;

    const left = tile.left + tileRect.x * tile.width;
    const top = tile.top + tileRect.y * tile.height;
    const right = left + tileRect.width * tile.width;
    const bottom = top + tileRect.height * tile.height;

    let best: { index: number; box: DOMRect; area: number } | null = null;
    this.#view.pages.forEach((page, index) => {
      const box = page.root.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const overlapWidth = Math.min(right, box.right) - Math.max(left, box.left);
      const overlapHeight = Math.min(bottom, box.bottom) - Math.max(top, box.top);
      if (overlapWidth <= 0 || overlapHeight <= 0) return;
      const area = overlapWidth * overlapHeight;
      if (!best || area > best.area) best = { index, box, area };
    });

    if (!best) return null;
    const { index, box } = best as { index: number; box: DOMRect; area: number };

    // Clamped to the page: a band dragged past the edge means "to the edge",
    // and a rect outside 0..1 would crop off the canvas.
    const x = clamp((Math.max(left, box.left) - box.left) / box.width, 0, 1);
    const y = clamp((Math.max(top, box.top) - box.top) / box.height, 0, 1);
    const width = clamp((Math.min(right, box.right) - box.left) / box.width, 0, 1) - x;
    const height = clamp((Math.min(bottom, box.bottom) - box.top) / box.height, 0, 1) - y;
    if (width <= 0 || height <= 0) return null;

    return { subdivision: index, rect: { x, y, width, height } };
  }

  /**
   * The region as pixels, cropped from the page's canvas.
   *
   * The canvas holds the document's own colours — inversion is a CSS filter on
   * the element, not a change to its pixels — so a copied figure comes out as
   * the figure, not as the figure the way it currently looks.
   */
  async #regionImage(
    pageNumber: number,
    rect: NormalizedRect,
  ): Promise<CopyableContent | null> {
    const page = this.#view.pages[pageNumber - 1];
    const source = page?.canvas;
    if (!source?.width || !source.height) return null;

    const x = Math.max(0, Math.floor(rect.x * source.width));
    const y = Math.max(0, Math.floor(rect.y * source.height));
    const width = Math.min(source.width - x, Math.ceil(rect.width * source.width));
    const height = Math.min(source.height - y, Math.ceil(rect.height * source.height));
    if (width < 1 || height < 1) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return null;
    context.drawImage(source, x, y, width, height, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) return null;

    return { kind: "image", blob, mimeType: "image/png", width, height };
  }

  /**
   * The explicit OCR action.
   *
   * Never implicit and never bundled: it runs only when the user asks, only
   * through a hook a host registered (see `ocr.ts`), and says so plainly when
   * there is no hook rather than appearing to do nothing.
   */
  async #extractWithOcr(pageNumber: number): Promise<void> {
    const cached = this.#ocrText.get(pageNumber);
    if (cached) {
      await this.#writeClipboard(cached, `copied OCR text from page ${pageNumber}`);
      return;
    }

    const ocr = getPdfOcr();
    if (!ocr) {
      this.#view.announce(
        "no OCR plugin is registered — text extraction from scans is unavailable",
        "warn",
      );
      return;
    }

    const page = this.#view.pages[pageNumber - 1];
    if (!page?.canvas.width) {
      this.#view.announce("scroll to the page before extracting its text", "warn");
      return;
    }

    const context = page.canvas.getContext("2d", { willReadFrequently: true });
    let image: ImageData;
    try {
      if (!context) throw new Error("2d canvas context unavailable");
      image = context.getImageData(0, 0, page.canvas.width, page.canvas.height);
    } catch {
      this.#view.announce("could not read this page's pixels", "warn");
      return;
    }

    this.#view.announce(`extracting text from page ${pageNumber}…`);
    let text: string | null = null;
    try {
      text = await ocr(image, { pageNumber });
    } catch (thrown) {
      console.error("[pdf] OCR hook threw", thrown);
    }
    if (this.#disposing) return;

    if (!text?.trim()) {
      this.#view.announce(`no text found on page ${pageNumber}`, "warn");
      return;
    }
    this.#ocrText.set(pageNumber, text);
    this.#host?.invalidate(["text"]);
    await this.#writeClipboard(text, `extracted ${text.length} characters`);
  }

  /**
   * Writes to the system clipboard.
   *
   * Direct for now. Phase 06 builds the shell's cross-viewer clipboard on top
   * of `ViewerCopyApi.getCopyable`, which this instance already implements, and
   * this call site becomes "ask the shell to copy" instead.
   */
  async #writeClipboard(text: string, success: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.#view.announce(success);
    } catch (thrown) {
      console.error("[pdf] clipboard write failed", thrown);
      this.#view.announce("could not write to the clipboard", "warn");
    }
  }

  // -------------------------------------------------------------------------
  // Contract surface
  // -------------------------------------------------------------------------

  async thumbnail(request: ThumbnailRequest): Promise<ThumbnailResult> {
    return this.#thumbnails.get(request);
  }

  async reveal(
    location: ViewerLocation,
    options?: { readonly highlight?: boolean },
  ): Promise<void> {
    this.clearHighlights();
    const pageNumber = clamp(
      (location.subdivision ?? 0) + 1,
      1,
      Math.max(1, this.#view.pageCount),
    );

    if (location.rect) {
      this.#view.revealRect(pageNumber, location.rect);
      if (options?.highlight !== false) this.#drawHighlight(pageNumber, location.rect);
    } else {
      this.#view.goToPage(pageNumber);
    }
  }

  clearHighlights(): void {
    for (const element of this.#highlights) element.remove();
    this.#highlights = [];
  }

  #drawHighlight(pageNumber: number, rect: NormalizedRect): void {
    const page = this.#view.pages[pageNumber - 1];
    if (!page) return;
    const element = document.createElement("div");
    element.className = "pdf-highlight";
    // Percentages, so the highlight follows the page through every zoom change
    // without being repositioned.
    element.style.left = `${rect.x * 100}%`;
    element.style.top = `${rect.y * 100}%`;
    element.style.width = `${rect.width * 100}%`;
    element.style.height = `${rect.height * 100}%`;
    page.root.append(element);
    this.#highlights.push(element);
  }

  /**
   * View state only. Annotations are deliberately *not* here: they belong to the
   * file rather than to this tile (see `annotation/store.ts`), and the contract
   * says serialized state "must not include the file's contents or anything
   * derived from them at size" — a pasted screenshot is exactly that.
   */
  serialize(): PdfViewerState {
    return {
      page: this.#view.currentPage,
      zoomMode: this.#view.zoomMode,
      zoom: this.#view.zoomPercent,
      inverted: this.#view.inverted,
    };
  }

  restore(state: unknown): void {
    const parsed = parsePdfState(state);
    this.#view.setInverted(parsed.inverted);
    this.#view.setZoomState({ mode: parsed.zoomMode, zoom: parsed.zoom });
    this.#view.goToPage(parsed.page);
    this.#notifyToolbar();
  }

  resize(): void {
    this.#view.resize();
  }

  /**
   * Focus, which only the annotator cares about — and only for the clipboard:
   * `paste` is a window event, so two annotated tiles would otherwise both act
   * on one keystroke.
   */
  setActive(active: boolean): void {
    this.#annotator.setActive(active);
  }

  dispose(): void {
    this.#disposing = true;
    this.#abort.abort();
    this.clearHighlights();

    // Before the view: both annotators hold elements inside the view's pages
    // and listeners on its container, and tearing the view down first would
    // leave them removing nodes from a detached tree.
    this.#textAnnotator?.destroy();
    this.#annotator.destroy();
    this.#geometry.dispose();
    this.#view.destroy();
    this.#thumbnails.dispose();
    this.#ocrText.clear();
    this.#toolbarListeners.clear();
    this.#selectionListeners.clear();
    this.#annotationListeners.clear();

    // `destroy()` tears down the worker as well as the document, which is the
    // difference between closing a tile and leaking a thread per PDF opened.
    void this.#document.destroy().catch((thrown: unknown) => {
      console.error("[pdf] destroying the document failed", thrown);
    });

    this.markDisposed();
  }

  /** Test hook: how many pages still hold canvas pixels. Not part of the contract. */
  get liveBufferCount(): number {
    return this.#view.pages.filter((page) => page.holdsPixels).length;
  }
}

function subscribe(set: Set<() => void>, listener: () => void): Unsubscribe {
  set.add(listener);
  return () => set.delete(listener);
}
