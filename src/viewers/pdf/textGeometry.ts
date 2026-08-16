/**
 * A page's text, its geometry, and the two directions between them.
 *
 * This is the PDF half of phase 05b's capability boundary: `annotation/text/`
 * knows about quotes and character offsets and nothing else, and everything that
 * turns those into something on a page happens here. Three jobs, in one file
 * because they are three views of one table:
 *
 *   - **`extractPageText`** — a page's text in reading order, plus the box of
 *     every text item that has one, keyed by its range within that text. One
 *     derivation, so the offsets a search reports, the offsets an anchor
 *     records and the offsets a rectangle is drawn from are the same offsets.
 *   - **`rectsForRange`** — a character range back to boxes, one per line. This
 *     is what phase 06 imports for search-match highlighting rather than
 *     writing a second version (AGENTS.md says so explicitly), which is why it
 *     is a plain function over an extracted page and not a method on anything.
 *   - **`PdfTextGeometry`** — the cache, and the `TextAnchorCapability` the
 *     plugin publishes: text by subdivision, regions for a range, and an anchor
 *     for whatever the user has selected in the tile.
 *
 * ## Invisible text is text
 *
 * A scanned page that has been through OCR carries its words as text drawn in
 * rendering mode 3 — invisible, positioned over the picture of them. Nothing in
 * this file, in `page.ts`'s text layer, or in pdf.js's `getTextContent()` looks
 * at the rendering mode: an OCR'd page's items arrive exactly like a born-digital
 * page's and are treated exactly the same. That is not an accident to be
 * preserved by luck — it is the property phase 05b's first task exists to
 * verify, and `dev/fixture.ts`'s third page is invisible text over an image so
 * the self-test can hold it to it. **Do not add a render-mode filter here.** It
 * would look like an optimization (why lay out glyphs nobody can see?) and it
 * would make every scanned document in the world unselectable.
 *
 * ## Mapping a live selection back to offsets
 *
 * pdf.js's text layer is one absolutely-positioned span per text item, so the
 * spans' text, walked in document order, is the page's text — and the DOM
 * ranges the browser hands back can be walked onto it. It is done by *matching*
 * each text node's value forward through the extracted string rather than by
 * counting characters, so a span pdf.js chose not to emit (or a `<br>` it did)
 * shifts nothing: the walk re-finds its place at every node.
 */

import type { NormalizedRect } from "../../annotation";
import {
  buildTextAnchor,
  type TextAnchor,
  type TextAnchorCapability,
  type TextRange,
} from "../../annotation";
import { pdfjs, type PdfDocument } from "./pdfjs";
import { clamp } from "./util";

/** One text item's place in the page's text, and its box on the page. */
export interface PdfTextBox {
  /** Range of the item's own characters within the page text. */
  readonly start: number;
  readonly end: number;
  /** Whether a newline follows it in the page text (pdf.js's `hasEOL`). */
  readonly eol: boolean;
  /** The item's box, normalized `0..1` over the page as displayed. */
  readonly rect: NormalizedRect;
}

export interface PdfPageText {
  readonly pageNumber: number;
  /** Every item's text, concatenated in reading order, newlines included. */
  readonly text: string;
  /** Only the items with usable geometry; the offsets still cover the rest. */
  readonly boxes: readonly PdfTextBox[];
}

/**
 * A page's text and geometry, from pdf.js's own text content.
 *
 * The mapping from a text item's matrix to a normalized box is the one phase 03
 * already used for search hits, moved here so there is one copy: `Util.transform`
 * composes the item's matrix with the viewport's, `matrix[4]`/`matrix[5]` are the
 * baseline origin in display space, and the glyph height comes out of the matrix
 * while the width comes from the item's own advance. The baseline is not the
 * bottom of the line, which is what {@link ascentRatio} is for.
 */
export async function extractPageText(
  document_: PdfDocument,
  pageNumber: number,
): Promise<PdfPageText> {
  const page = await document_.getPage(pageNumber);
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const boxWidth = viewport.width || 1;
  const boxHeight = viewport.height || 1;
  const horizontalScale =
    Math.hypot(viewport.transform[0]!, viewport.transform[1]!) || 1;

  const boxes: PdfTextBox[] = [];
  let text = "";

  for (const raw of content.items) {
    const item = raw as {
      str?: string;
      width?: number;
      hasEOL?: boolean;
      transform?: number[];
      fontName?: string;
    };
    const value = item.str ?? "";
    const eol = item.hasEOL === true;
    if (!value && !eol) continue;

    const start = text.length;
    text += value;
    const end = text.length;
    if (eol) text += "\n";

    // Whitespace-only runs and items pdf.js gives no matrix for still occupy
    // their characters — the offsets have to cover the whole string — but they
    // have no box worth highlighting.
    if (!value.trim() || !item.transform) continue;

    const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
    const glyphHeight = Math.hypot(matrix[1]!, matrix[3]!);
    const glyphWidth = (item.width ?? 0) * horizontalScale;
    const ascent = ascentRatio(content.styles?.[item.fontName ?? ""]);
    const x = clamp(matrix[4]! / boxWidth, 0, 1);
    const y = clamp((matrix[5]! - glyphHeight * ascent) / boxHeight, 0, 1);

    boxes.push({
      start,
      end,
      eol,
      rect: {
        x,
        y,
        width: clamp(glyphWidth / boxWidth, 0, 1 - x),
        height: clamp(glyphHeight / boxHeight, 0, 1 - y),
      },
    });
  }

  return { pageNumber, text, boxes };
}

/** What a font with no usable metrics is assumed to be. pdf.js's own fallback. */
const DEFAULT_ASCENT = 0.8;

/**
 * How much of a line's height sits *above* its baseline, as a fraction.
 *
 * A text item's matrix places its baseline, not its box: glyphs sit above it and
 * descenders hang below it. A box hung straight off the baseline — `y = baseline
 * - height` — therefore stops exactly where the descenders start, and a
 * highlight drawn from it covers the top three quarters of its own line while
 * the browser's selection, which is the text layer span's box and does include
 * the descent, covers all of it. The two are painted over the same words, so the
 * disagreement is visible. Offsetting by the ascent instead puts the box where
 * pdf.js puts the span (`top = tx[5] - fontHeight * ascent`, `TextLayer`), which
 * is what makes a highlight land on the band the selection that created it had.
 *
 * The ratio is the font's ascent over its full ascent-to-descent extent, from
 * the metrics the PDF itself carries — pdf.js measures the *substituted* font's
 * `fontBoundingBox` for the same number, which needs a laid-out document, and
 * this has to answer for pages that have never been rendered. For text fonts the
 * two agree to a couple of percent of a line, which is a fraction of the
 * descender this fixes.
 */
function ascentRatio(style: { ascent?: number; descent?: number } | undefined): number {
  const ascent = style?.ascent ?? Number.NaN;
  const descent = Math.abs(style?.descent ?? Number.NaN);
  if (Number.isFinite(ascent) && ascent > 0 && Number.isFinite(descent)) {
    return clamp(ascent / (ascent + descent), 0.5, 1);
  }
  // Only one of the pair: the same reading pdf.js falls back to, a descent
  // measured down from the top of the em box.
  if (Number.isFinite(descent) && descent > 0) return clamp(1 - descent, 0.5, 1);
  return DEFAULT_ASCENT;
}

/**
 * How far apart two boxes on one line may be and still be one rectangle.
 *
 * Half a line height, i.e. a couple of characters. Wide enough to close the gap
 * pdf.js leaves between the words of one sentence, which arrive as separate text
 * items on a surprising number of documents; narrow enough that a two-column
 * page does not get a highlight painted across its gutter.
 */
const JOIN_GAP_RATIO = 0.5;

/** Fraction of a line's height two boxes must share to count as the same line. */
const SAME_LINE_OVERLAP = 0.4;

/**
 * The boxes a character range covers, one per line.
 *
 * A range crossing a line wrap comes back as several contiguous rectangles
 * rather than one box swallowing everything between the end of one line and the
 * start of the next — which is the difference between a highlight and a
 * rectangle drawn over a paragraph.
 *
 * Within an item the box is interpolated across its advance width by character
 * count. Exact per-glyph positions would need the font's metrics for a mark
 * whose whole job is to sit behind the words; every PDF viewer's find-bar draws
 * it the same way.
 */
export function rectsForRange(
  page: PdfPageText,
  range: TextRange,
): readonly NormalizedRect[] {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  if (end <= start) return [];

  const pieces: NormalizedRect[] = [];
  for (const box of page.boxes) {
    if (box.end <= start || box.start >= end) continue;
    const length = Math.max(1, box.end - box.start);
    const from = (Math.max(start, box.start) - box.start) / length;
    const to = (Math.min(end, box.end) - box.start) / length;
    if (to <= from) continue;
    pieces.push({
      x: box.rect.x + box.rect.width * from,
      y: box.rect.y,
      width: box.rect.width * (to - from),
      height: box.rect.height,
    });
  }

  return joinRuns(pieces);
}

/** Merges boxes that sit on one line and touch, leaving the wraps alone. */
function joinRuns(pieces: readonly NormalizedRect[]): readonly NormalizedRect[] {
  const out: NormalizedRect[] = [];
  for (const piece of pieces) {
    const previous = out.at(-1);
    if (previous && sameLine(previous, piece) && adjacent(previous, piece)) {
      const left = Math.min(previous.x, piece.x);
      const right = Math.max(previous.x + previous.width, piece.x + piece.width);
      const top = Math.min(previous.y, piece.y);
      const bottom = Math.max(previous.y + previous.height, piece.y + piece.height);
      out[out.length - 1] = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };
      continue;
    }
    out.push(piece);
  }
  return out;
}

function sameLine(a: NormalizedRect, b: NormalizedRect): boolean {
  const overlap =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlap > SAME_LINE_OVERLAP * Math.min(a.height, b.height);
}

function adjacent(a: NormalizedRect, b: NormalizedRect): boolean {
  const gap = Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width);
  return gap <= JOIN_GAP_RATIO * Math.max(a.height, b.height);
}

// ---------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------

export interface PdfTextGeometryInit {
  readonly document: PdfDocument;
  readonly pageCount: number;
  /** The tile's root element, for resolving a selection back to a page. */
  readonly root: HTMLElement;
}

/**
 * The plugin's implementation of `TextAnchorCapability`, with a page cache.
 *
 * Cached by *promise*, so two anchors on one page share a single
 * `getTextContent()` even when both are resolved in the same tick. pdf.js caches
 * page proxies itself, so the cost this saves is the text extraction, which for
 * a dense page is the expensive half.
 */
export class PdfTextGeometry implements TextAnchorCapability {
  readonly subdivisionCount: number;

  #document: PdfDocument;
  #root: HTMLElement;
  #pages = new Map<number, Promise<PdfPageText>>();
  #disposed = false;

  constructor(init: PdfTextGeometryInit) {
    this.#document = init.document;
    this.#root = init.root;
    this.subdivisionCount = init.pageCount;
  }

  /** One page's text and geometry. Page numbers are 1-based, as pdf.js has them. */
  page(pageNumber: number): Promise<PdfPageText> {
    const cached = this.#pages.get(pageNumber);
    if (cached) return cached;
    const pending = extractPageText(this.#document, pageNumber).catch((thrown) => {
      // A page that cannot be extracted is an empty page for every purpose here,
      // and must not be re-attempted on every keystroke.
      console.error(`[pdf] text extraction failed on page ${pageNumber}`, thrown);
      return { pageNumber, text: "", boxes: [] } satisfies PdfPageText;
    });
    this.#pages.set(pageNumber, pending);
    return pending;
  }

  async textOf(subdivision: number): Promise<string> {
    if (this.#disposed) return "";
    if (subdivision < 0 || subdivision >= this.subdivisionCount) return "";
    return (await this.page(subdivision + 1)).text;
  }

  async regionsFor(
    subdivision: number,
    range: TextRange,
  ): Promise<readonly NormalizedRect[]> {
    if (this.#disposed) return [];
    if (subdivision < 0 || subdivision >= this.subdivisionCount) return [];
    return rectsForRange(await this.page(subdivision + 1), range);
  }

  /**
   * An anchor for the current selection, if it is inside this tile.
   *
   * The quote is sliced out of the *extracted* page text rather than taken from
   * `Selection.toString()`, and that is load-bearing: the browser's string is
   * assembled from the DOM, which puts line breaks where the layout has them,
   * while the anchor has to be findable in the string `textOf` returns. Slicing
   * from the same string the resolver will search guarantees it is.
   */
  async anchorForSelection(): Promise<TextAnchor | null> {
    if (this.#disposed) return null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    if (!this.#root.contains(range.commonAncestorContainer)) return null;

    const start = endpointTextNode(range.startContainer, range.startOffset, "start");
    if (!start) return null;

    const layer = textLayerOf(start.node);
    const pageNumber = pageNumberOf(layer);
    if (!layer || !pageNumber) return null;

    // A selection that runs onto the next page is anchored to the page it
    // started on and stops at the end of that page's text. A PDF annotation
    // belongs to exactly one page, so a two-page highlight is two marks, and
    // making the first one silently is better than making none.
    const rawEnd = endpointTextNode(range.endContainer, range.endOffset, "end");
    const end = rawEnd && textLayerOf(rawEnd.node) === layer ? rawEnd : null;

    const page = await this.page(pageNumber);
    if (!page.text) return null;

    const startOffset = offsetInPageText(layer, start.node, start.offset, page.text);
    if (startOffset < 0) return null;
    const endOffset = end
      ? offsetInPageText(layer, end.node, end.offset, page.text)
      : page.text.length;

    return buildTextAnchor({
      text: page.text,
      start: startOffset,
      end: endOffset < 0 ? page.text.length : endOffset,
      subdivision: pageNumber - 1,
    });
  }

  /** Drops the cache. The document itself belongs to the instance. */
  dispose(): void {
    this.#disposed = true;
    this.#pages.clear();
  }
}

// ---------------------------------------------------------------------------
// DOM -> offset
// ---------------------------------------------------------------------------

/**
 * A range endpoint as a text node and an offset within it.
 *
 * A `Range` endpoint may be an element and a child index — which is what the
 * browser gives you when the user drags past the end of a span — so it has to be
 * resolved to the text on the side the endpoint is facing.
 */
function endpointTextNode(
  container: Node,
  offset: number,
  side: "start" | "end",
): { node: Text; offset: number } | null {
  if (container.nodeType === Node.TEXT_NODE) {
    return { node: container as Text, offset };
  }
  const children = [...container.childNodes];
  if (side === "start") {
    for (const child of children.slice(offset)) {
      const node = firstTextNode(child);
      if (node) return { node, offset: 0 };
    }
    const previous = lastTextNode(container);
    return previous ? { node: previous, offset: previous.length } : null;
  }
  for (const child of children.slice(0, offset).reverse()) {
    const node = lastTextNode(child);
    if (node) return { node, offset: node.length };
  }
  const next = firstTextNode(container);
  return next ? { node: next, offset: 0 } : null;
}

function firstTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

function lastTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    last = current as Text;
  }
  return last;
}

function textLayerOf(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(".textLayer") ?? null;
}

function pageNumberOf(layer: HTMLElement | null): number {
  const page = layer?.closest<HTMLElement>(".pdf-page");
  const value = Number(page?.dataset.page ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Where a point in the rendered text layer sits in the extracted page text.
 *
 * Matched rather than counted: each text node's value is located in the page
 * text from wherever the previous one ended, so a node the extraction does not
 * account for costs one failed `indexOf` and nothing else. Counting characters
 * instead would silently accumulate an offset error from the first mismatch to
 * the bottom of the page.
 */
export function offsetInPageText(
  layer: HTMLElement,
  target: Text,
  targetOffset: number,
  text: string,
): number {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let cursor = 0;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    const at = value ? text.indexOf(value, cursor) : -1;
    const base = at >= 0 ? at : cursor;
    if (node === target) {
      return Math.min(base + Math.max(0, targetOffset), text.length);
    }
    cursor = base + value.length;
  }
  return -1;
}
