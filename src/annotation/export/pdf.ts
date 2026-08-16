/**
 * The PDF export bridge: overlay items in, real PDF annotation objects out.
 *
 * This is the file the phase brief calls "the detail that actually separates a
 * real tool from a toy". Every item here becomes a standards-compliant
 * annotation dictionary — `/Ink`, `/Highlight`, `/Square`, `/Circle`, `/Line`,
 * `/FreeText`, `/Text` with its `/Popup`, `/Stamp` — attached to the page's
 * `/Annots`. Nothing is drawn into the page's content stream. Open the result in
 * Acrobat or Okular and each mark is an object you can click, edit and delete;
 * flatten it into the page instead and it is a smudge on the paper for ever.
 *
 * ## One bridge for both targeting models
 *
 * Phase 05b's text-anchored marks arrive here already resolved to rectangles
 * (`PdfAnnotationExportOptions.textItems`) and go through the *same* builders as
 * the drawn ones — a `/Highlight` with `/QuadPoints` from those rectangles, plus
 * the `/Text` and `/Popup` pair when there is a comment. There is no second
 * export path and no second annotated-flag mechanism, which is what the phase
 * brief asks for and what keeps "does this file look like the tile did" a single
 * question.
 *
 * ## pdf-lib has no high-level API for any of this, and that is expected
 *
 * AGENTS.md says to "verify pdf-lib's current high-level support for each of
 * these subtypes before writing to it" and to use the low-level object API where
 * it is missing. Verified against the pinned 1.17.1: `PDFDocument` exposes page
 * content drawing, fonts, images and form fields, and *no* annotation
 * constructor of any kind. So every dictionary below is built through
 * `context.obj`/`context.register` and attached with `PDFPageLeaf.addAnnot`,
 * which is the low-level path that document names. The one high-level API used
 * is image embedding (`embedPng`/`embedJpg`), which is not annotation-specific.
 *
 * ## Every annotation carries its own appearance stream
 *
 * An annotation dictionary without `/AP` is a request that the *reader* draw the
 * mark, and readers disagree — pdf.js draws almost none of them, Acrobat
 * synthesises its own on open and then saves it, and a few draw nothing at all.
 * That is how an export ends up looking correct in the app that wrote it and
 * empty everywhere else. So each annotation gets a Form XObject drawing exactly
 * what the tile drew, and the dictionary stays fully editable alongside it.
 *
 * ## Coordinates
 *
 * Items are normalized `0..1` over the page *as displayed*, with `y` down.
 * PDF user space has `y` up, an origin at the crop box's corner, and a `/Rotate`
 * that the display has already applied. {@link pageSpaceOf} is the one place
 * that conversion happens, derived to agree with pdf.js's own `PageViewport`
 * (see the check in `annotation/selftest.ts`, which drives all four rotations).
 */

import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  StandardFonts,
  type PDFFont,
  type PDFImage,
  type PDFObject,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";

import { unionRects, type NormalizedPoint, type NormalizedRect } from "../geometry";
import {
  NOTE_SIZE,
  TEXT_BASELINE_RATIO,
  TEXT_LINE_HEIGHT,
  TEXT_PADDING_RATIO,
  recomputeBounds,
  type OverlayItem,
} from "../overlay";
import type { ResolvedTextAnnotation } from "../text";

/**
 * The durable marker identifying a file as this app's annotated output.
 *
 * In the Info dictionary rather than XMP, having checked what pdf-lib actually
 * supports cleanly: `context.trailerInfo.Info` is a public, round-tripping
 * dictionary any key can be added to, while XMP would mean hand-assembling an
 * RDF packet and a metadata stream with no library help and more ways to be
 * subtly wrong. AGENTS.md allows either and asks that the choice be verified;
 * this is the verification.
 *
 * It lives inside the file, so a rename or a move cannot detach it — which is
 * the entire point of not using a filename convention for this.
 */
export const ANNOTATED_MARKER_KEY = "WorkspaceAnnotated";
export const ANNOTATED_MARKER_VALUE = "workspace-app/1";

/** What `/T` (the annotation's author) is set to. */
const ANNOTATION_AUTHOR = "Workspace";

/**
 * What `PDFContext.obj` accepts, restated.
 *
 * pdf-lib takes a plain object and turns it into a `PDFDict`, but does not
 * export the type of what it takes — so every dictionary in this file would
 * otherwise be built as `any`. Restating it costs six lines and buys the
 * compiler back: a stray `undefined` or a nested object with a function in it is
 * caught here rather than written into a PDF.
 *
 * One rule this type cannot express and every call site has to remember: a bare
 * *string* becomes a `/Name`, not a text string. Anything the user typed goes
 * through `PDFHexString.fromText`.
 */
type PdfLiteral =
  | PDFObject
  | string
  | number
  | boolean
  | null
  | undefined
  | PdfLiteral[]
  | { [key: string]: PdfLiteral };

type PdfFields = { [key: string]: PdfLiteral };

export interface PdfAnnotationExportOptions {
  /** The original document's bytes. Never mutated. */
  readonly bytes: Uint8Array;
  readonly items: readonly OverlayItem[];
  /**
   * Phase 05b's text-anchored marks, already resolved to rectangles.
   *
   * Resolution is deliberately the *caller's* job: it needs the document's text
   * and glyph geometry, which is the plugin's to know, and doing it here would
   * drag pdf.js into a module whose entire purpose is to write a file with
   * pdf-lib. What arrives is what the tile is drawing, which is also what makes
   * "the file looks like the tile did" true by construction.
   */
  readonly textItems?: readonly ResolvedTextAnnotation[];
  /** Overrides `/T` on every annotation. */
  readonly author?: string;
}

// ---------------------------------------------------------------------------
// Page space
// ---------------------------------------------------------------------------

export interface PageSpace {
  /** The page's box as the viewer displays it, in points. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  /** Normalized display point -> `[x, y]` in PDF user space. */
  toUser(point: NormalizedPoint): readonly [number, number];
  /**
   * A normalized length -> points.
   *
   * Lengths (stroke width, font size, the note icon) are a fraction of the
   * *smaller* dimension, which is the same number whichever way the page is
   * rotated — so unlike a position, this needs no rotation branch.
   */
  toLength(fraction: number): number;
}

/**
 * The mapping from displayed, normalized coordinates to PDF user space.
 *
 * `box` is the page's crop box (falling back to the media box), because that is
 * what pdf.js's viewport is built from — annotating relative to the media box of
 * a cropped page puts every mark at an offset nobody can see the cause of.
 */
export function pageSpaceOf(
  box: { x: number; y: number; width: number; height: number },
  rotate: number,
): PageSpace {
  // Normalized to a quarter turn: /Rotate is a multiple of 90 but may be
  // negative or greater than 360, and JavaScript's `%` keeps the sign.
  const turn = (((Math.round(rotate / 90) % 4) + 4) % 4) * 90;
  const quarter = turn === 90 || turn === 270;

  return {
    displayWidth: quarter ? box.height : box.width,
    displayHeight: quarter ? box.width : box.height,
    toUser(point) {
      // u runs right and v runs up, both 0..1 within the box, before rotation.
      let u: number;
      let v: number;
      switch (turn) {
        case 90:
          u = point.y;
          v = point.x;
          break;
        case 180:
          u = 1 - point.x;
          v = point.y;
          break;
        case 270:
          u = 1 - point.y;
          v = 1 - point.x;
          break;
        default:
          u = point.x;
          v = 1 - point.y;
          break;
      }
      return [box.x + u * box.width, box.y + v * box.height] as const;
    },
    toLength(fraction) {
      return fraction * Math.min(box.width, box.height);
    },
  };
}

function pageSpaceForPage(page: PDFPage): PageSpace {
  const media = page.getMediaBox();
  const crop = page.node.CropBox()?.asRectangle();
  const box = crop ?? media;
  // A crop box may legitimately extend past the media box; the viewer shows the
  // intersection, so that is what the coordinates are relative to.
  const left = Math.max(box.x, media.x);
  const bottom = Math.max(box.y, media.y);
  const right = Math.min(box.x + box.width, media.x + media.width);
  const top = Math.min(box.y + box.height, media.y + media.height);
  const usable =
    right > left && top > bottom
      ? { x: left, y: bottom, width: right - left, height: top - bottom }
      : media;
  return pageSpaceOf(usable, page.node.Rotate()?.asNumber() ?? 0);
}

/**
 * The item's box, re-derived rather than read off the item.
 *
 * `bounds` is maintained by `OverlayDocument`, so in the running app the two are
 * always the same. Deriving it again here costs nothing and removes a silent
 * failure mode that is genuinely hard to see: `/Rect` and the appearance
 * stream's `/BBox` both come from this number, and a `/BBox` of zero area clips
 * the appearance to nothing — so an item with stale bounds does not export
 * *wrongly*, it exports **invisibly**, in a file that otherwise looks correct
 * and contains a real annotation object with the right subtype. Found exactly
 * that way, rendering an export through poppler.
 */
function boundsOf(item: OverlayItem): NormalizedRect {
  return recomputeBounds(item);
}

/** The rectangle an item occupies, in user space, as `/Rect` wants it. */
function userRect(space: PageSpace, rect: NormalizedRect): [number, number, number, number] {
  const [x1, y1] = space.toUser({ x: rect.x, y: rect.y });
  const [x2, y2] = space.toUser({ x: rect.x + rect.width, y: rect.y + rect.height });
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
}

// ---------------------------------------------------------------------------
// Content stream building
// ---------------------------------------------------------------------------

/** Three decimals is finer than any renderer resolves, and keeps streams small. */
function n(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0";
}

/** `#rrggbb` -> the 0..1 triple PDF colour operators and `/C` both want. */
export function rgbOf(color: string): readonly [number, number, number] {
  const hex = color.replace("#", "").trim();
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((digit) => digit + digit)
          .join("")
      : hex.padEnd(6, "0").slice(0, 6);
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [0, 0, 0];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** A content stream, assembled as text. */
class Ops {
  #parts: string[] = [];

  push(line: string): this {
    this.#parts.push(line);
    return this;
  }

  save(): this {
    return this.push("q");
  }

  restore(): this {
    return this.push("Q");
  }

  graphicsState(name: string): this {
    return this.push(`/${name} gs`);
  }

  strokeColor(color: string): this {
    const [r, g, b] = rgbOf(color);
    return this.push(`${n(r)} ${n(g)} ${n(b)} RG`);
  }

  fillColor(color: string): this {
    const [r, g, b] = rgbOf(color);
    return this.push(`${n(r)} ${n(g)} ${n(b)} rg`);
  }

  lineWidth(width: number): this {
    // Round caps and joins: a freehand stroke with mitred corners looks like a
    // polygon, which is exactly what it must not look like.
    return this.push(`${n(width)} w 1 J 1 j`);
  }

  moveTo(x: number, y: number): this {
    return this.push(`${n(x)} ${n(y)} m`);
  }

  lineTo(x: number, y: number): this {
    return this.push(`${n(x)} ${n(y)} l`);
  }

  curveTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
  ): this {
    return this.push(`${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x3)} ${n(y3)} c`);
  }

  rect(x: number, y: number, width: number, height: number): this {
    return this.push(`${n(x)} ${n(y)} ${n(width)} ${n(height)} re`);
  }

  toString(): string {
    return this.#parts.join("\n");
  }
}

/** A cubic-bezier ellipse inscribed in a box. */
function ellipsePath(
  ops: Ops,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  // 0.5523 is the standard four-arc circle approximation; the error is well
  // under a thousandth of the radius, which is invisible and exact enough that
  // no reader will redraw it differently.
  const k = 0.5523;
  const rx = width / 2;
  const ry = height / 2;
  const cx = x + rx;
  const cy = y + ry;
  ops.moveTo(cx + rx, cy);
  ops.curveTo(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry);
  ops.curveTo(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy);
  ops.curveTo(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry);
  ops.curveTo(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy);
}

/** The two barbs of an open arrowhead at `to`, pointing away from `from`. */
export function arrowHeadPoints(
  from: readonly [number, number],
  to: readonly [number, number],
  size: number,
): readonly [readonly [number, number], readonly [number, number]] {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const spread = Math.PI / 7;
  return [
    [to[0] - size * Math.cos(angle - spread), to[1] - size * Math.sin(angle - spread)],
    [to[0] - size * Math.cos(angle + spread), to[1] - size * Math.sin(angle + spread)],
  ] as const;
}

/** A PDF date string, which `/M` and `/CreationDate` both take. */
function pdfDate(milliseconds: number): PDFString {
  return PDFString.fromDate(new Date(milliseconds));
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

/**
 * Writes `items` into `bytes` as real annotation objects and returns the result.
 *
 * The source bytes are the *original* document every time, not the last export:
 * re-saving after adding one more mark rebuilds the whole annotation set from
 * the live model, so a file saved five times carries five annotations rather
 * than fifteen.
 */
export async function exportAnnotatedPdf(
  options: PdfAnnotationExportOptions,
): Promise<Uint8Array> {
  const document_ = await PDFDocument.load(options.bytes, {
    // The marker and the annotations are the only things this pass is allowed to
    // change. `updateMetadata` would rewrite the producer and creation date of a
    // document we did not author.
    updateMetadata: false,
    ignoreEncryption: true,
  });

  const author = options.author ?? ANNOTATION_AUTHOR;
  const pageCount = document_.getPageCount();

  /** Embedded lazily: a document with no callouts should not gain a font. */
  let helvetica: PDFFont | null = null;
  const font = (): PDFFont => {
    helvetica ??= document_.embedStandardFont(StandardFonts.Helvetica);
    return helvetica;
  };

  // Keyed by the image data, so pasting one screenshot onto ten pages embeds it
  // once.
  const images = new Map<string, PDFImage>();

  for (const item of options.items) {
    if (item.subdivision < 0 || item.subdivision >= pageCount) continue;
    const page = document_.getPage(item.subdivision);
    const space = pageSpaceForPage(page);

    const built = await buildAnnotation({
      item,
      page,
      space,
      author,
      font,
      images,
      document: document_,
    });
    for (const ref of built) page.node.addAnnot(ref);
  }

  // Text-anchored marks, second, so they sit under a drawn mark that overlaps
  // them in `/Annots` order — the same z-order the tile draws them in.
  for (const entry of options.textItems ?? []) {
    const subdivision = entry.placement.subdivision;
    if (subdivision < 0 || subdivision >= pageCount) continue;
    // A quote that could not be found has no rectangles, and an annotation with
    // no geometry is an invisible object in someone's file. It stays in the
    // model — the words may come back — and stays out of the export.
    if (entry.placement.rects.length === 0) continue;

    const page = document_.getPage(subdivision);
    for (const ref of textAnnotations(entry, {
      page,
      space: pageSpaceForPage(page),
      author,
      font,
      images,
      document: document_,
    })) {
      page.node.addAnnot(ref);
    }
  }

  writeAnnotatedMarker(document_);

  // Object streams off: the output stays a plainly structured file whose Info
  // dictionary can be read with `strings` when something is wrong, at a size
  // cost of a few hundred bytes on a document that is already megabytes.
  return document_.save({ useObjectStreams: false });
}

/** Whether these bytes are a PDF this app produced. Never throws. */
export async function pdfCarriesAnnotatedMarker(bytes: Uint8Array): Promise<boolean> {
  try {
    const document_ = await PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: true,
      throwOnInvalidObject: false,
    });
    const info = document_.context.lookupMaybe(
      document_.context.trailerInfo.Info,
      PDFDict,
    );
    const marker = info?.get(PDFName.of(ANNOTATED_MARKER_KEY));
    return marker !== undefined;
  } catch {
    // Unreadable, encrypted beyond recovery, or not a PDF at all. Whatever it
    // is, it is not ours — and the caller's collision rule turns that into
    // "leave it alone", which is the safe answer.
    return false;
  }
}

function writeAnnotatedMarker(document_: PDFDocument): void {
  const context = document_.context;
  let info = context.lookupMaybe(context.trailerInfo.Info, PDFDict);
  if (!info) {
    info = context.obj({});
    context.trailerInfo.Info = context.register(info);
  }
  info.set(
    PDFName.of(ANNOTATED_MARKER_KEY),
    PDFHexString.fromText(ANNOTATED_MARKER_VALUE),
  );
  info.set(PDFName.of("ModDate"), pdfDate(Date.now()));
}

// ---------------------------------------------------------------------------
// One item -> one (or two) annotation objects
// ---------------------------------------------------------------------------

interface BuildContext {
  readonly item: OverlayItem;
  readonly page: PDFPage;
  readonly space: PageSpace;
  readonly author: string;
  font(): PDFFont;
  readonly images: Map<string, PDFImage>;
  readonly document: PDFDocument;
  /**
   * `/Contents` for a mark whose text is not on the item.
   *
   * Only a text-anchored highlight needs it: the words it covers are what a
   * reader's comment list shows for it, and they live on the anchor rather than
   * on the synthesized highlight below.
   */
  readonly contents?: string;
}

/** Everything a builder needs except the item it is building. */
type BuildBase = Omit<BuildContext, "item" | "contents">;

/**
 * Returns the refs to attach to the page, in order.
 *
 * More than one for a sticky note, which is an annotation *pair* — the icon and
 * its popup — in every reader that shows comments.
 */
async function buildAnnotation(build: BuildContext): Promise<readonly PDFRef[]> {
  switch (build.item.kind) {
    case "ink":
      return [inkAnnotation(build, build.item)];
    case "highlight":
      return [highlightAnnotation(build, build.item)];
    case "shape":
      return [shapeAnnotation(build, build.item)];
    case "text":
      return [freeTextAnnotation(build, build.item)];
    case "note":
      return noteAnnotation(build, build.item);
    case "image":
      return [await stampAnnotation(build, build.item)];
  }
}

/** The fields every markup annotation carries. */
function commonFields(
  build: BuildContext,
  rect: readonly number[],
  contents = build.contents ?? "",
): PdfFields {
  const item = build.item;
  return {
    Type: "Annot",
    Rect: [...rect],
    // The item's own id, so an exported annotation can be matched back to the
    // mark that produced it — by the round-trip check, and by a future import.
    NM: PDFString.of(item.id),
    // Bit 3: print. An annotation that is invisible on paper is a surprise.
    F: 4,
    CA: item.opacity,
    C: [...rgbOf(item.color)],
    M: pdfDate(item.updatedAt),
    CreationDate: pdfDate(item.createdAt),
    T: PDFHexString.fromText(build.author),
    Contents: PDFHexString.fromText(contents),
  };
}

/**
 * Registers an appearance stream and returns the `/AP` value for it.
 *
 * The form's `/BBox` is the annotation's own rectangle and its matrix is the
 * identity, so the content is written in plain user-space coordinates and no
 * reader has to map anything. That is the arrangement least likely to be
 * rendered differently by two viewers.
 */
function appearance(
  build: BuildContext,
  rect: readonly number[],
  content: string,
  resources: PdfFields,
): PDFRef {
  const stream = build.document.context.stream(content, {
    Type: "XObject",
    Subtype: "Form",
    FormType: 1,
    BBox: [...rect],
    Resources: resources,
  });
  return build.document.context.register(stream);
}

/** An `/ExtGState` resource carrying the item's opacity, and a blend mode. */
function alphaResources(opacity: number, blendMode?: string): PdfFields {
  return {
    ExtGState: {
      GS: {
        Type: "ExtGState",
        ca: opacity,
        CA: opacity,
        ...(blendMode ? { BM: blendMode } : {}),
      },
    },
  };
}

function register(build: BuildContext, fields: PdfFields): PDFRef {
  return build.document.context.register(build.document.context.obj(fields));
}

// --- ink -------------------------------------------------------------------

function inkAnnotation(
  build: BuildContext,
  item: Extract<OverlayItem, { kind: "ink" }>,
): PDFRef {
  const { space } = build;
  const width = space.toLength(item.strokeWidth);
  const rect = userRect(space, boundsOf(item));

  const paths = item.strokes.map((stroke) => stroke.map((point) => space.toUser(point)));

  const ops = new Ops();
  ops.save().graphicsState("GS").strokeColor(item.color).lineWidth(width);
  for (const path of paths) {
    const first = path[0];
    if (!first) continue;
    ops.moveTo(first[0], first[1]);
    for (const point of path.slice(1)) ops.lineTo(point[0], point[1]);
    // A tap with no movement: a zero-length segment with round caps paints a
    // dot, where a bare `m` paints nothing at all.
    if (path.length === 1) ops.lineTo(first[0], first[1]);
    ops.push("S");
  }
  ops.restore();

  return register(build, {
    ...commonFields(build, rect),
    Subtype: "Ink",
    InkList: paths.map((path) => path.flatMap(([x, y]) => [x, y])),
    BS: { W: width, S: "S" },
    AP: {
      N: appearance(build, rect, ops.toString(), alphaResources(item.opacity)),
    },
  });
}

// --- highlight -------------------------------------------------------------

function highlightAnnotation(
  build: BuildContext,
  item: Extract<OverlayItem, { kind: "highlight" }>,
): PDFRef {
  const { space } = build;
  const rect = userRect(space, boundsOf(item));
  const boxes = item.rects.map((box) => userRect(space, box));

  const ops = new Ops();
  ops.save().graphicsState("GS").fillColor(item.color);
  for (const [x1, y1, x2, y2] of boxes) ops.rect(x1, y1, x2 - x1, y2 - y1);
  ops.push("f").restore();

  return register(build, {
    ...commonFields(build, rect),
    Subtype: "Highlight",
    // Upper-left, upper-right, lower-left, lower-right. The order looks wrong
    // and is what the specification says; getting it wrong makes viewers that
    // draw from QuadPoints render a bow-tie.
    QuadPoints: boxes.flatMap(([x1, y1, x2, y2]) => [x1, y2, x2, y2, x1, y1, x2, y1]),
    AP: {
      // Multiply, so the words underneath a highlight stay readable — which is
      // the difference between a highlighter and a redaction. Matched on screen
      // by the same blend mode in `pdf.css`.
      N: appearance(build, rect, ops.toString(), alphaResources(item.opacity, "Multiply")),
    },
  });
}

// --- shapes ----------------------------------------------------------------

function shapeAnnotation(
  build: BuildContext,
  item: Extract<OverlayItem, { kind: "shape" }>,
): PDFRef {
  const { space } = build;
  const width = space.toLength(item.strokeWidth);
  const rect = userRect(space, boundsOf(item));
  const ops = new Ops();
  ops.save().graphicsState("GS").strokeColor(item.color).lineWidth(width);
  if (item.fill) ops.fillColor(item.fill);
  const paint = item.fill ? "B" : "S";

  if (item.shape === "line" || item.shape === "arrow") {
    const from = space.toUser(item.from ?? { x: item.bounds.x, y: item.bounds.y });
    const to = space.toUser(
      item.to ?? {
        x: item.bounds.x + item.bounds.width,
        y: item.bounds.y + item.bounds.height,
      },
    );
    ops.moveTo(from[0], from[1]).lineTo(to[0], to[1]).push("S");

    if (item.shape === "arrow") {
      const [left, right] = arrowHeadPoints(from, to, Math.max(width * 4, 6));
      ops.moveTo(left[0], left[1]).lineTo(to[0], to[1]).lineTo(right[0], right[1]);
      ops.push("S");
    }
    ops.restore();

    return register(build, {
      ...commonFields(build, rect),
      Subtype: "Line",
      L: [from[0], from[1], to[0], to[1]],
      // The reader's own idea of the line ends, for the case where it decides to
      // regenerate the appearance: none at the tail, an open arrow at the head.
      LE: item.shape === "arrow" ? ["None", "OpenArrow"] : ["None", "None"],
      BS: { W: width, S: "S" },
      ...(item.fill ? { IC: [...rgbOf(item.fill)] } : {}),
      AP: { N: appearance(build, rect, ops.toString(), alphaResources(item.opacity)) },
    });
  }

  // The path is inset by half the pen width, because `/Rect` was padded by it —
  // stroking the rectangle itself would paint half the line outside the box.
  const inset = width / 2;
  const x = rect[0] + inset;
  const y = rect[1] + inset;
  const boxWidth = Math.max(0, rect[2] - rect[0] - width);
  const boxHeight = Math.max(0, rect[3] - rect[1] - width);

  if (item.shape === "ellipse") ellipsePath(ops, x, y, boxWidth, boxHeight);
  else ops.rect(x, y, boxWidth, boxHeight);
  ops.push(paint).restore();

  return register(build, {
    ...commonFields(build, rect),
    Subtype: item.shape === "ellipse" ? "Circle" : "Square",
    BS: { W: width, S: "S" },
    // How far the drawn shape is inset from `/Rect`, which is exactly the half
    // pen width above. Readers that regenerate the appearance need it to put the
    // shape back where we drew it.
    RD: [inset, inset, inset, inset],
    ...(item.fill ? { IC: [...rgbOf(item.fill)] } : {}),
    AP: { N: appearance(build, rect, ops.toString(), alphaResources(item.opacity)) },
  });
}

// --- text callout ----------------------------------------------------------

function freeTextAnnotation(
  build: BuildContext,
  item: Extract<OverlayItem, { kind: "text" }>,
): PDFRef {
  const { space } = build;
  const rect = userRect(space, boundsOf(item));
  const size = space.toLength(item.fontSize);
  const padding = size * TEXT_PADDING_RATIO;
  const leading = size * TEXT_LINE_HEIGHT;
  const font = build.font();
  const [r, g, b] = rgbOf(item.color);
  const lines = item.text.split("\n");

  const ops = new Ops();
  ops.save().graphicsState("GS");
  // Clipped to the box, so text longer than the callout is cut off here exactly
  // as it is on screen rather than spilling across the page.
  ops.rect(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]).push("W n");
  ops.fillColor(item.color);
  ops.push("BT").push(`/Helv ${n(size)} Tf`).push(`${n(leading)} TL`);
  ops.push(
    `1 0 0 1 ${n(rect[0] + padding)} ${n(rect[3] - padding - size * TEXT_BASELINE_RATIO)} Tm`,
  );
  for (const [index, line] of lines.entries()) {
    if (index > 0) ops.push("T*");
    ops.push(`(${escapePdfText(line)}) Tj`);
  }
  ops.push("ET").restore();

  return register(build, {
    ...commonFields(build, rect, item.text),
    Subtype: "FreeText",
    // The appearance string a reader uses if it re-renders the text itself.
    DA: PDFString.of(`/Helv ${n(size)} Tf ${n(r)} ${n(g)} ${n(b)} rg`),
    // Left-aligned, and no border: a callout with a box round it was not what
    // was drawn on screen.
    Q: 0,
    BS: { W: 0, S: "S" },
    DR: { Font: { Helv: font.ref } },
    AP: {
      N: appearance(build, rect, ops.toString(), {
        ...alphaResources(item.opacity),
        Font: { Helv: font.ref },
      }),
    },
  });
}

/**
 * Escapes a string for a PDF literal in a *content* stream.
 *
 * Not the same job as `PDFHexString.fromText`, which is for object strings: this
 * is text inside an appearance stream, where `(`, `)` and `\` end or corrupt the
 * literal. Characters outside Latin-1 are dropped rather than mangled — the
 * standard Helvetica encoding cannot show them, and a `?` where the glyph should
 * be at least says so honestly.
 */
function escapePdfText(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\" || character === "(" || character === ")") out += `\\${character}`;
    else if (code < 32) out += " ";
    else if (code > 255) out += "?";
    else out += character;
  }
  return out;
}

// --- sticky note -----------------------------------------------------------

function noteAnnotation(
  build: BuildContext,
  item: Extract<OverlayItem, { kind: "note" }>,
): readonly PDFRef[] {
  const { space } = build;
  const target = build.document;
  const rect = userRect(space, boundsOf(item));
  const width = rect[2] - rect[0];
  const height = rect[3] - rect[1];

  // The icon, drawn rather than left to the reader: three lines on a filled
  // square, which is what every reader's own "note" glyph amounts to.
  const ops = new Ops();
  ops.save().graphicsState("GS").fillColor(item.color).strokeColor("#333333");
  ops.rect(rect[0], rect[1], width, height).push("B");
  ops.lineWidth(Math.max(0.6, height * 0.06));
  for (const fraction of [0.35, 0.5, 0.65]) {
    ops.moveTo(rect[0] + width * 0.2, rect[1] + height * fraction);
    ops.lineTo(rect[2] - width * 0.2, rect[1] + height * fraction);
  }
  ops.push("S").restore();

  const noteRef = target.context.nextRef();
  const popupRef = target.context.nextRef();

  // The popup sits to the right of the icon at a readable size. Only shown when
  // the reader opens the comment, but it has to exist: a `/Text` annotation with
  // no `/Popup` shows its text in some readers' comment list and nowhere else.
  const popupRect = [rect[2] + 2, rect[1] - 60, rect[2] + 182, rect[3]];

  target.context.assign(
    noteRef,
    target.context.obj({
      ...commonFields(build, rect, item.text),
      Subtype: "Text",
      Name: "Note",
      Open: item.open,
      Popup: popupRef,
      AP: { N: appearance(build, rect, ops.toString(), alphaResources(item.opacity)) },
    }),
  );

  target.context.assign(
    popupRef,
    target.context.obj({
      Type: "Annot",
      Subtype: "Popup",
      Rect: popupRect,
      Parent: noteRef,
      Open: item.open,
    }),
  );

  return [noteRef, popupRef];
}

// --- text-anchored marks (phase 05b) ---------------------------------------

/**
 * A resolved text anchor, as one or two real annotation objects.
 *
 * There is no new export path here, and that is the point: once an anchor has
 * been resolved to rectangles it *is* a highlight, so it goes through the same
 * {@link highlightAnnotation} that a swept-out one does — same `/QuadPoints`
 * derived from the same rectangles, same appearance stream, same multiply blend
 * so the words underneath stay readable. A note on it adds the `/Text` and
 * `/Popup` pair {@link noteAnnotation} already builds, positioned at the start
 * of the quote.
 *
 * The only thing the two models do differently by the time they reach this file
 * is where the rectangles came from.
 */
function textAnnotations(
  entry: ResolvedTextAnnotation,
  base: BuildBase,
): readonly PDFRef[] {
  const highlight = highlightItemFor(entry);
  const refs: PDFRef[] = [
    highlightAnnotation(
      { ...base, item: highlight, contents: entry.item.anchor.quote },
      highlight,
    ),
  ];

  const note = entry.item.note?.trim();
  if (note) {
    const icon = noteItemFor(entry, base.space, note);
    refs.push(...noteAnnotation({ ...base, item: icon }, icon));
  }
  return refs;
}

/** The mark as a highlight item, carrying the text item's own id into `/NM`. */
function highlightItemFor(
  entry: ResolvedTextAnnotation,
): Extract<OverlayItem, { kind: "highlight" }> {
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

/**
 * The note's icon, at the resolved start of the quote.
 *
 * Just before the first line rather than on top of it, which is where every
 * reader puts a comment icon and which keeps it off the words it is about. A
 * quote starting hard against the left margin has nowhere to put it and gets it
 * at the margin instead — an icon slightly over the first letter is better than
 * one off the page, where `/Rect` would be outside the crop box.
 *
 * Opaque, whatever the highlight's opacity: a 40% highlighter is a highlighter,
 * and a 40% comment icon is a rendering bug.
 */
function noteItemFor(
  entry: ResolvedTextAnnotation,
  space: PageSpace,
  note: string,
): Extract<OverlayItem, { kind: "note" }> {
  const first = entry.placement.rects[0] ?? { x: 0, y: 0, width: 0, height: 0 };
  const side = NOTE_SIZE * Math.min(space.displayWidth, space.displayHeight);
  const width = side / space.displayWidth;
  const height = side / space.displayHeight;
  const bounds: NormalizedRect = {
    x: Math.max(0, Math.min(first.x - width, 1 - width)),
    y: Math.max(0, Math.min(first.y, 1 - height)),
    width,
    height,
  };

  return {
    // A distinct id: two annotation objects in one file may not share an `/NM`,
    // and this one has to be traceable back to the mark that produced it.
    id: `${entry.item.id}:note`,
    kind: "note",
    subdivision: entry.placement.subdivision,
    color: entry.item.color,
    opacity: 1,
    text: note,
    open: false,
    bounds,
    createdAt: entry.item.createdAt,
    updatedAt: entry.item.updatedAt,
  };
}

// --- pasted image ----------------------------------------------------------

/**
 * A pasted image, as a `/Stamp` with an image appearance stream.
 *
 * AGENTS.md names this as the one deliberate exception to "never draw into the
 * page": an image genuinely is a stamp, and a `/Stamp` annotation with an image
 * in its appearance stream is still a real, selectable, deletable annotation
 * object — not content burned into the page. The pixels have to live in a stream
 * somewhere; what matters is that the *annotation* stays an annotation.
 */
async function stampAnnotation(
  build: BuildContext,
  item: Extract<OverlayItem, { kind: "image" }>,
): Promise<PDFRef> {
  const { space } = build;
  const target = build.document;
  const rect = userRect(space, boundsOf(item));
  const width = rect[2] - rect[0];
  const height = rect[3] - rect[1];

  const key = `${item.image.mimeType}:${item.image.base64.length}:${item.image.base64.slice(0, 64)}`;
  let embedded = build.images.get(key);
  if (!embedded) {
    const bytes = base64ToBytes(item.image.base64);
    embedded =
      item.image.mimeType === "image/jpeg"
        ? await target.embedJpg(bytes)
        : await target.embedPng(bytes);
    build.images.set(key, embedded);
  }

  const ops = new Ops();
  ops.save().graphicsState("GS");
  ops.push(`${n(width)} 0 0 ${n(height)} ${n(rect[0])} ${n(rect[1])} cm`);
  ops.push("/Im0 Do").restore();

  return register(build, {
    ...commonFields(build, rect),
    Subtype: "Stamp",
    AP: {
      N: appearance(build, rect, ops.toString(), {
        ...alphaResources(item.opacity),
        XObject: { Im0: embedded.ref },
      }),
    },
  });
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` on a megabyte image is an argument
  // list long enough to overflow the call stack, which it does at around a
  // hundred thousand entries on every engine.
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
