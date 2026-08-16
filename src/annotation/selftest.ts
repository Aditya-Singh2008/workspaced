/**
 * Annotation self-test. **Dev builds only.**
 *
 * Three things are checked here, chosen because each is wrong in a way that
 * looks right:
 *
 *   - **The edit model.** Undo after a drag, z-order, and what a resize does to
 *     an ink path are all invisible in a screenshot and obvious in use.
 *   - **The save-target rule.** AGENTS.md's marker policy is a decision
 *     procedure with a data-loss failure mode: the branch that must *not*
 *     overwrite a stranger's similarly-named file only runs when someone has one,
 *     which is never during development. It is driven here against a fake
 *     filesystem, including that planted collision.
 *   - **The export.** Not "does it write a file" but "is what it wrote a real
 *     annotation object" — the property that separates this from a tool that
 *     burns marks into the page, and the one thing about the output that cannot
 *     be judged by looking at it in the app that produced it. The exported bytes
 *     are parsed back with pdf-lib and each annotation dictionary is inspected.
 *     `viewers/pdf/selftest.ts` does the other half, reading the same file with
 *     *pdf.js*, which is a second implementation's opinion.
 *
 * No pdf.js and no PDF fixture from the plugin: this layer must not depend on a
 * viewer, so the documents here are built with pdf-lib itself.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  degrees,
} from "pdf-lib";

import { check, report, type SelfTestCheck, type SelfTestReport } from "../dev/selftest";
import {
  ANNOTATED_MARKER_KEY,
  exportAnnotatedPdf,
  pageSpaceOf,
  pdfCarriesAnnotatedMarker,
} from "./export/pdf";
import {
  OverlayDocument,
  hitTestItem,
  overlayItemStamp,
  transformItemToBounds,
  type OverlayItem,
} from "./overlay";
import {
  annotatedCompanionOrdinal,
  companionPath,
  resolveAnnotatedTarget,
} from "./store";
import {
  buildTextAnchor,
  resolveTextAnchor,
  resolveTextAnnotations,
  summarizeTextAnnotations,
  textAnnotationStamp,
  type ResolvedTextAnnotation,
  type TextAnchorSource,
  type TextAnnotationItem,
} from "./text";

const TITLE = "annotation model and export";

export async function runAnnotationSelfTest(): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [
    ...editModelChecks(),
    pageSpaceChecks(),
    ...(await textAnchorChecks()),
    ...(await targetPolicyChecks()),
    ...(await exportChecks()),
  ];
  return report(TITLE, checks);
}

// ---------------------------------------------------------------------------
// The edit model
// ---------------------------------------------------------------------------

function inkItem(points: readonly { x: number; y: number }[]): OverlayItem {
  return {
    ...overlayItemStamp(),
    kind: "ink",
    subdivision: 0,
    color: "#ff5f56",
    opacity: 1,
    strokeWidth: 0,
    strokes: [points],
    bounds: { x: 0, y: 0, width: 0, height: 0 },
  };
}

function boxItem(x: number, y: number): OverlayItem {
  return {
    ...overlayItemStamp(),
    kind: "shape",
    shape: "rect",
    subdivision: 0,
    color: "#2979ff",
    opacity: 1,
    strokeWidth: 0,
    bounds: { x, y, width: 0.2, height: 0.1 },
  };
}

function editModelChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];

  // --- a drag is one undo ---
  const document_ = new OverlayDocument();
  document_.add(inkItem([{ x: 0.1, y: 0.1 }]));
  const afterAdd = document_.items;

  const edit = document_.begin();
  for (const step of [0.2, 0.3, 0.4]) {
    edit.update(
      afterAdd.map((item) =>
        item.kind === "ink"
          ? { ...item, strokes: [[{ x: 0.1, y: 0.1 }, { x: step, y: step }]] }
          : item,
      ),
    );
  }
  edit.commit();
  const drawn = document_.items[0];
  const strokeLength = drawn?.kind === "ink" ? drawn.strokes[0]?.length ?? 0 : 0;
  document_.undo();
  const afterUndo = document_.items[0];
  const undoneLength =
    afterUndo?.kind === "ink" ? afterUndo.strokes[0]?.length ?? 0 : 0;
  document_.redo();

  checks.push(
    check(
      "a drag is one undo step, not one per frame",
      strokeLength === 2 && undoneLength === 1 && document_.items.length === 1,
      `stroke had ${strokeLength} point(s) after three live updates, ${undoneLength} after one undo`,
    ),
  );

  // --- an abandoned gesture leaves nothing ---
  const before = document_.items;
  const abandoned = document_.begin();
  abandoned.update([...before, boxItem(0.5, 0.5)]);
  abandoned.cancel();
  checks.push(
    check(
      "an abandoned gesture leaves no mark and no history",
      document_.items === before && !document_.canRedo,
      `${document_.items.length} item(s), redo available=${document_.canRedo}`,
    ),
  );

  // --- z-order is the array order ---
  const stack = new OverlayDocument();
  const first = boxItem(0.1, 0.1);
  const second = boxItem(0.2, 0.2);
  const third = boxItem(0.3, 0.3);
  stack.add(first);
  stack.add(second);
  stack.add(third);
  stack.sendToBack(third.id);
  const afterBack = stack.items.map((item) => item.id);
  stack.bringToFront(first.id);
  const afterFront = stack.items.map((item) => item.id);
  checks.push(
    check(
      "z-order is the item order, and both directions move exactly one item",
      afterBack[0] === third.id &&
        afterBack.length === 3 &&
        afterFront.at(-1) === first.id &&
        afterFront.filter((id) => id === first.id).length === 1,
      `after send-to-back: ${afterBack.join(",")}; after bring-to-front: ${afterFront.join(",")}`,
    ),
  );

  // --- a resize carries a path with it ---
  const stroke = inkItem([
    { x: 0.2, y: 0.2 },
    { x: 0.4, y: 0.6 },
  ]);
  const sized = new OverlayDocument();
  sized.add(stroke);
  const placed = sized.items[0]!;
  const resized = transformItemToBounds(placed, {
    x: 0.2,
    y: 0.2,
    width: placed.bounds.width * 2,
    height: placed.bounds.height * 2,
  });
  const end = resized.kind === "ink" ? resized.strokes[0]?.[1] : undefined;
  checks.push(
    check(
      "resizing an ink mark moves its points, not just its box",
      !!end && Math.abs(end.x - 0.6) < 1e-6 && Math.abs(end.y - 1.0) < 1e-6,
      `stroke end (0.4, 0.6) -> (${end?.x.toFixed(3)}, ${end?.y.toFixed(3)}) when the box was doubled`,
    ),
  );

  // --- hit testing follows the ink, not the box ---
  const diagonal = sized.items[0]!;
  const onStroke = hitTestItem(diagonal, { x: 0.3, y: 0.4 }, 0.006);
  const inEmptyCorner = hitTestItem(diagonal, { x: 0.39, y: 0.21 }, 0.006);
  checks.push(
    check(
      "clicking the empty corner of a diagonal stroke does not select it",
      onStroke && !inEmptyCorner,
      `on the line=${onStroke}, in the corner of its bounding box=${inEmptyCorner}`,
    ),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Page space
// ---------------------------------------------------------------------------

/**
 * The normalized-to-user-space mapping, for every `/Rotate`.
 *
 * Derived to agree with pdf.js's `PageViewport`, which is what produced the
 * coordinates in the first place; `viewers/pdf/selftest.ts` checks that
 * agreement against the real thing. This one checks the corners analytically,
 * because a rotation bug is a sign error that only shows on documents nobody
 * keeps around: it is right for `/Rotate 0`, which is every file on a developer's
 * machine, and puts every mark on the wrong edge of a scanned landscape page.
 */
function pageSpaceChecks(): SelfTestCheck {
  const box = { x: 0, y: 0, width: 400, height: 800 };
  // The top-left of the *displayed* page, whichever way it is turned.
  const expected: Record<number, readonly [number, number]> = {
    0: [0, 800],
    90: [0, 0],
    180: [400, 0],
    270: [400, 800],
  };

  const failures: string[] = [];
  for (const rotate of [0, 90, 180, 270]) {
    const space = pageSpaceOf(box, rotate);
    const [x, y] = space.toUser({ x: 0, y: 0 });
    const want = expected[rotate]!;
    const quarter = rotate === 90 || rotate === 270;
    const sizeOk =
      space.displayWidth === (quarter ? 800 : 400) &&
      space.displayHeight === (quarter ? 400 : 800);
    if (Math.abs(x - want[0]) > 1e-6 || Math.abs(y - want[1]) > 1e-6 || !sizeOk) {
      failures.push(
        `/Rotate ${rotate}: top-left -> (${x}, ${y}), wanted (${want[0]}, ${want[1]}), display ${space.displayWidth}x${space.displayHeight}`,
      );
    }
  }

  // A length is a fraction of the smaller side, which no rotation changes.
  const rotated = pageSpaceOf(box, 90).toLength(0.5);
  const upright = pageSpaceOf(box, 0).toLength(0.5);
  if (rotated !== upright || upright !== 200) {
    failures.push(`stroke width 0.5 -> ${upright}pt upright, ${rotated}pt rotated`);
  }

  return check(
    "normalized page coordinates map into user space for every rotation",
    failures.length === 0,
    failures.length === 0
      ? "the displayed top-left lands on the right corner of the media box at 0°, 90°, 180° and 270°"
      : failures.join("; "),
  );
}

// ---------------------------------------------------------------------------
// Text anchors (phase 05b)
// ---------------------------------------------------------------------------

/** Three "pages" of plain text. No viewer, no geometry, no pdf.js. */
function textSource(pages: readonly string[]): TextAnchorSource {
  return {
    subdivisionCount: pages.length,
    textOf: async (subdivision) => pages[subdivision] ?? "",
    // A box per line-ish run is the plugin's job; the model only needs to be
    // handed something back, and this suite is about the model.
    regionsFor: async (_subdivision, range) => [
      { x: 0, y: 0, width: (range.end - range.start) / 100, height: 0.02 },
    ],
  };
}

const PAGE_TWO = "The quick brown fox jumps over the lazy dog, twice, in a hurry.";

/**
 * What a quote-based anchor is *for*.
 *
 * Every one of these is a case where a stored bounding box gives the wrong
 * answer and looks like it worked: the words moved to another page, the
 * whitespace around them changed, the same short phrase occurs three times, or
 * they are gone and the honest answer is "nowhere". The hint fast path is
 * checked in both directions too, because a hint that is *trusted* rather than
 * verified is the failure this model exists to avoid — it silently highlights
 * whatever now sits at that offset.
 */
async function textAnchorChecks(): Promise<SelfTestCheck[]> {
  const pages = ["a cover page", PAGE_TWO, "a page after it"];
  const source = textSource(pages);

  const start = PAGE_TWO.indexOf("brown fox");
  const anchor = buildTextAnchor({
    text: PAGE_TWO,
    start,
    end: start + "brown fox".length,
    subdivision: 1,
  });

  const exact = anchor ? await resolveTextAnchor(anchor, source) : null;

  // The same words, one page later, with the spacing mangled and the hint now
  // pointing at the middle of a different sentence.
  const moved = anchor
    ? await resolveTextAnchor(
        anchor,
        textSource(["a cover page", "an inserted page", `  ${PAGE_TWO.replace(/ /g, "\n")}  `]),
      )
    : null;

  const gone = anchor
    ? await resolveTextAnchor({ ...anchor, quote: "no such words here" }, source)
    : null;

  // An anchor is only as good as its context when the quote repeats.
  const repeated = "alpha see below one\nbeta see below two\ngamma see below three";
  const secondAt = repeated.indexOf("see below", repeated.indexOf("see below") + 1);
  const ambiguous = buildTextAnchor({
    text: repeated,
    start: secondAt,
    end: secondAt + "see below".length,
    subdivision: 0,
  });
  const shifted = `a line that was added above\n${repeated}`;
  const disambiguated = ambiguous
    ? await resolveTextAnchor(ambiguous, textSource([shifted]))
    : null;

  const single = buildTextAnchor({ text: PAGE_TWO, start: 0, end: 1, subdivision: 1 });
  const whitespaceOnly = buildTextAnchor({
    text: "word   word",
    start: 4,
    end: 7,
    subdivision: 0,
  });

  // What the sidebar ends up showing, from the two calls the plugin makes.
  const marks: TextAnnotationItem[] = anchor
    ? [
        { ...textAnnotationStamp(), anchor, color: "#ffd93d", opacity: 0.4 },
        {
          ...textAnnotationStamp(),
          anchor,
          color: "#ffd93d",
          opacity: 0.4,
          note: "worth checking",
        },
      ]
    : [];
  const placed = await resolveTextAnnotations(marks, source);
  const listed = summarizeTextAnnotations(
    marks,
    (id) => placed.find((entry) => entry.item.id === id)?.placement,
  );

  return [
    check(
      "an anchor resolves by its hint when nothing has moved",
      !!exact && exact.viaHint && exact.subdivision === 1 && exact.start === start,
      exact
        ? `“${anchor?.quote}” -> subdivision ${exact.subdivision} at ${exact.start}, by hint=${exact.viaHint}`
        : "did not resolve",
    ),
    check(
      "the quote finds its words on another page, with the whitespace changed",
      !!moved &&
        !moved.viaHint &&
        moved.subdivision === 2 &&
        moved.start > 0,
      moved
        ? `found on subdivision ${moved.subdivision} at ${moved.start}..${moved.end} (hint said subdivision 1 at ${anchor?.offsetHint})`
        : "lost the quote after a reflow",
    ),
    check(
      "the recorded context picks the right one of three identical quotes",
      !!disambiguated && shifted.slice(disambiguated.start - 5, disambiguated.start) === "beta ",
      disambiguated
        ? `matched after ${JSON.stringify(shifted.slice(Math.max(0, disambiguated.start - 6), disambiguated.start))}`
        : "did not resolve",
    ),
    check(
      "words that are gone resolve to nothing rather than to something else",
      gone === null,
      `a quote no longer in the document -> ${gone === null ? "null" : JSON.stringify(gone)}`,
    ),
    check(
      "a selection with no words in it is not an anchor",
      !!single && whitespaceOnly === null,
      `one character -> ${single ? "anchored" : "refused"}; whitespace only -> ${whitespaceOnly ? "anchored" : "refused"}`,
    ),
    check(
      "the list entry is the words, and says whether a comment is attached",
      listed.length === 2 &&
        listed.every((entry) => entry.label.includes("brown fox")) &&
        listed.every((entry) => entry.subdivision === 1) &&
        listed.some((entry) => entry.type === "quote") &&
        listed.some(
          (entry) => entry.type === "comment" && entry.label.includes("worth checking"),
        ),
      listed.map((entry) => `${entry.type}: ${entry.label} @${entry.subdivision}`).join(" | "),
    ),
  ];
}

// ---------------------------------------------------------------------------
// The save-target policy
// ---------------------------------------------------------------------------

async function targetPolicyChecks(): Promise<SelfTestCheck[]> {
  const source = "/docs/report.pdf";
  const companion = companionPath(source, 0);
  const suffixed = companionPath(source, 1);

  /** A filesystem described by two sets: what exists, and what is ours. */
  const probeFor = (present: Record<string, boolean>) => ({
    exists: async (path: string) => path in present,
    carriesMarker: async (path: string) => present[path] === true,
  });

  const clean = await resolveAnnotatedTarget(
    { path: source, carriesMarker: false },
    probeFor({}),
  );
  const reopened = await resolveAnnotatedTarget(
    { path: companion, carriesMarker: true },
    probeFor({ [companion]: true }),
  );
  const sameCompanion = await resolveAnnotatedTarget(
    { path: source, carriesMarker: false },
    probeFor({ [companion]: true }),
  );
  // The one that matters: a file that happens to be named like our companion
  // but is not ours. Overwriting it is data loss; stepping over it is clutter.
  const stranger = await resolveAnnotatedTarget(
    { path: source, carriesMarker: false },
    probeFor({ [companion]: false }),
  );
  const twoStrangers = await resolveAnnotatedTarget(
    { path: source, carriesMarker: false },
    probeFor({ [companion]: false, [suffixed]: false }),
  );

  // The user gets the say over their own companion. Asked, and answered both
  // ways — including the case where declining has to walk past a *second*
  // companion of ours without asking about it too.
  const asked: string[] = [];
  const answering = (replace: boolean, present: Record<string, boolean>) => ({
    ...probeFor(present),
    confirmReplace: async (path: string) => {
      asked.push(path);
      return replace;
    },
  });
  const replaced = await resolveAnnotatedTarget(
    { path: source, carriesMarker: false },
    answering(true, { [companion]: true }),
  );
  const askedToReplace = [...asked];
  asked.length = 0;
  const kept = await resolveAnnotatedTarget(
    { path: source, carriesMarker: false },
    answering(false, { [companion]: true, [suffixed]: true }),
  );
  const askedOnce = [...asked];

  // Name matching, which is the same rule read backwards: it decides what the
  // open-time "load the annotated copy instead?" question is asked about.
  const ordinals: [string, number | null][] = [
    [companion, 0],
    [suffixed, 1],
    [companionPath(source, 2), 2],
    // Not ours: a different document, a different extension, a hand-made name,
    // and the two numbers `companionPath` never writes.
    ["/docs/other-annotated.pdf", null],
    ["/docs/report-annotated.txt", null],
    ["/docs/report-annotated-draft.pdf", null],
    ["/docs/report-annotated-1.pdf", null],
    ["/docs/report-annotated-02.pdf", null],
    // Same name, different folder. Never a companion.
    ["/elsewhere/report-annotated.pdf", null],
  ];
  const misread = ordinals.filter(
    ([candidate, want]) => annotatedCompanionOrdinal(candidate, source) !== want,
  );

  return [
    check(
      "a first save writes the companion, and a second overwrites it in place",
      clean.path === companion &&
        !clean.inPlace &&
        reopened.path === companion &&
        reopened.inPlace &&
        sameCompanion.path === companion,
      `clean -> ${clean.path}; already marked -> ${reopened.path} (in place=${reopened.inPlace}); our companion present -> ${sameCompanion.path}`,
    ),
    check(
      "a colliding file that is not ours is stepped over, never overwritten",
      stranger.path === suffixed && twoStrangers.path === companionPath(source, 2),
      `one stranger -> ${stranger.path}; two -> ${twoStrangers.path}`,
    ),
    check(
      "the user can keep an existing annotated copy, and is asked only once",
      replaced.path === companion &&
        askedToReplace.length === 1 &&
        kept.path === companionPath(source, 2) &&
        askedOnce.length === 1 &&
        askedOnce[0] === companion,
      `replace -> ${replaced.path} (asked about ${askedToReplace.join(", ") || "nothing"}); ` +
        `keep -> ${kept.path} (asked about ${askedOnce.join(", ") || "nothing"})`,
    ),
    check(
      "an annotated copy is recognised by name, and a stranger is not",
      misread.length === 0,
      misread.length === 0
        ? `${ordinals.length} names read correctly, ordinals and all`
        : misread
            .map(
              ([candidate, want]) =>
                `${candidate} -> ${annotatedCompanionOrdinal(candidate, source)}, wanted ${want}`,
            )
            .join("; "),
    ),
  ];
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

const CALLOUT_TEXT = "CALLOUT-MARKER";
const PAGE_BODY = "original body text";

/** A two-page document with real page content, built without a fixture file. */
async function buildSourcePdf(): Promise<Uint8Array> {
  const document_ = await PDFDocument.create();
  const first = document_.addPage([400, 600]);
  first.drawText(PAGE_BODY, { x: 40, y: 500, size: 12 });
  const second = document_.addPage([400, 600]);
  second.setRotation(degrees(90));
  second.drawText("second page", { x: 40, y: 500, size: 12 });
  return document_.save({ useObjectStreams: false });
}

function everyKind(): readonly OverlayItem[] {
  const at = (x: number, y: number, width = 0.2, height = 0.1) => ({
    x,
    y,
    width,
    height,
  });
  return [
    {
      ...overlayItemStamp(),
      kind: "ink",
      subdivision: 0,
      color: "#ff5f56",
      opacity: 1,
      strokeWidth: 2 / 612,
      strokes: [
        [
          { x: 0.1, y: 0.1 },
          { x: 0.3, y: 0.25 },
        ],
      ],
      bounds: at(0.1, 0.1),
    },
    {
      ...overlayItemStamp(),
      kind: "highlight",
      subdivision: 0,
      color: "#ffd93d",
      opacity: 0.4,
      rects: [at(0.1, 0.35)],
      bounds: at(0.1, 0.35),
    },
    {
      ...overlayItemStamp(),
      kind: "shape",
      shape: "rect",
      subdivision: 0,
      color: "#4ecb71",
      opacity: 1,
      strokeWidth: 2 / 612,
      bounds: at(0.1, 0.5),
    },
    {
      ...overlayItemStamp(),
      kind: "shape",
      shape: "ellipse",
      subdivision: 0,
      color: "#4ecb71",
      opacity: 1,
      strokeWidth: 2 / 612,
      fill: "#4ecb71",
      bounds: at(0.4, 0.5),
    },
    {
      ...overlayItemStamp(),
      kind: "shape",
      shape: "arrow",
      subdivision: 0,
      color: "#2979ff",
      opacity: 1,
      strokeWidth: 2 / 612,
      from: { x: 0.1, y: 0.65 },
      to: { x: 0.4, y: 0.75 },
      bounds: at(0.1, 0.65, 0.3, 0.1),
    },
    {
      ...overlayItemStamp(),
      kind: "text",
      subdivision: 0,
      color: "#1a1a1a",
      opacity: 1,
      text: CALLOUT_TEXT,
      fontSize: 12 / 612,
      bounds: at(0.5, 0.1, 0.4, 0.08),
    },
    {
      ...overlayItemStamp(),
      kind: "note",
      subdivision: 1,
      color: "#ffd93d",
      opacity: 1,
      text: "a note on the rotated page",
      open: false,
      bounds: at(0.5, 0.5, 0.05, 0.033),
    },
    {
      ...overlayItemStamp(),
      kind: "image",
      subdivision: 0,
      color: "#000000",
      opacity: 1,
      image: {
        mimeType: "image/png",
        base64: RED_DOT_PNG,
        width: 2,
        height: 2,
      },
      bounds: at(0.6, 0.6, 0.2, 0.13),
    },
  ];
}

/** A 2x2 PNG. Small enough to inline, real enough for pdf-lib to embed. */
const RED_DOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z4AAT" +
  "AxIYFRAWAAAv7YCAWEs9c0AAAAASUVORK5CYII=";

/**
 * Two text-anchored marks, already resolved — which is how they reach the
 * export in the app as well (the plugin resolves; this bridge writes).
 *
 * The first spans a line wrap, so its `/QuadPoints` has to describe *two*
 * quadrilaterals rather than one box across the gap. The second carries a note,
 * which is the `/Text` and `/Popup` pair.
 */
function resolvedTextMarks(): readonly ResolvedTextAnnotation[] {
  const anchor = (quote: string, offset: number) => ({
    quote,
    prefix: "",
    suffix: "",
    pageHint: 0,
    offsetHint: offset,
  });
  const stamped = (): TextAnnotationItem => ({
    ...textAnnotationStamp(),
    anchor: anchor("", 0),
    color: "#ffd93d",
    opacity: 0.4,
  });

  return [
    {
      item: { ...stamped(), anchor: anchor(WRAPPED_QUOTE, 12) },
      placement: {
        subdivision: 0,
        range: { start: 12, end: 12 + WRAPPED_QUOTE.length },
        rects: [
          { x: 0.5, y: 0.2, width: 0.35, height: 0.02 },
          { x: 0.1, y: 0.24, width: 0.2, height: 0.02 },
        ],
        viaHint: true,
      },
    },
    {
      item: { ...stamped(), anchor: anchor("a sentence", 80), note: NOTE_TEXT },
      placement: {
        subdivision: 0,
        range: { start: 80, end: 90 },
        rects: [{ x: 0.2, y: 0.4, width: 0.25, height: 0.02 }],
        viaHint: true,
      },
    },
  ];
}

const WRAPPED_QUOTE = "a quote that runs\nacross a line wrap";
const NOTE_TEXT = "TEXT-NOTE-MARKER";

async function exportChecks(): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];
  const source = await buildSourcePdf();
  const items = everyKind();
  const textItems = resolvedTextMarks();

  let bytes: Uint8Array;
  try {
    bytes = await exportAnnotatedPdf({ bytes: source, items, textItems });
  } catch (thrown) {
    return [
      check(
        "every overlay kind exports as a real PDF annotation object",
        false,
        `the export threw: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`,
      ),
    ];
  }

  const result = await PDFDocument.load(bytes, { updateMetadata: false });
  const annotations = [
    ...readAnnotations(result, 0).map((dict) => ({ page: 0, dict })),
    ...readAnnotations(result, 1).map((dict) => ({ page: 1, dict })),
  ];

  const subtypes = annotations.map(
    (entry) => entry.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() ?? "?",
  );
  const wanted = [
    "/Ink",
    "/Highlight",
    "/Square",
    "/Circle",
    "/Line",
    "/FreeText",
    "/Text",
    "/Popup",
    "/Stamp",
  ];
  const missing = wanted.filter((subtype) => !subtypes.includes(subtype));

  checks.push(
    check(
      "every overlay kind exports as a real PDF annotation object",
      missing.length === 0,
      missing.length === 0
        ? `${annotations.length} annotation(s): ${subtypes.join(" ")}`
        : `missing ${missing.join(" ")} — got ${subtypes.join(" ")}`,
    ),
  );

  // An annotation with no appearance stream is a request that the reader draw
  // the mark, and readers disagree about how — which is how an export looks
  // right in the app that wrote it and empty everywhere else.
  const withoutAppearance = annotations.filter(
    (entry) =>
      entry.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() !== "/Popup" &&
      entry.dict.get(PDFName.of("AP")) === undefined,
  );
  checks.push(
    check(
      "every annotation carries its own appearance stream",
      withoutAppearance.length === 0,
      `${annotations.length - withoutAppearance.length}/${annotations.length} have /AP (the popup legitimately does not)`,
    ),
  );

  // The ids are how a mark is matched back to the annotation it produced.
  const names = new Set(
    annotations
      .map((entry) => entry.dict.lookupMaybe(PDFName.of("NM"), PDFString)?.asString())
      .filter((name): name is string => typeof name === "string"),
  );
  const expectedNames = [
    ...items.map((item) => item.id),
    ...textItems.map((entry) => entry.item.id),
    // The note's icon is a second object and needs a second id: two annotations
    // in one file may not share an `/NM`.
    ...textItems
      .filter((entry) => entry.item.note)
      .map((entry) => `${entry.item.id}:note`),
  ];
  const unmatched = expectedNames.filter((id) => !names.has(id));
  checks.push(
    check(
      "each annotation carries the id of the mark that produced it",
      unmatched.length === 0,
      `${names.size} /NM value(s) for ${expectedNames.length} expected id(s)` +
        (unmatched.length ? `; missing ${unmatched.join(", ")}` : ""),
    ),
  );

  // The whole point: the page's own content stream is untouched, so the text
  // underneath is still text and the marks are objects sitting over it.
  const content = pageContentText(result, 0);
  const bodySurvived = contentShowsText(content, PAGE_BODY);
  const calloutBurnedIn = contentShowsText(content, CALLOUT_TEXT);
  const textNoteBurnedIn = contentShowsText(content, NOTE_TEXT);
  checks.push(
    check(
      "marks are not flattened into the page content",
      bodySurvived && !calloutBurnedIn && !textNoteBurnedIn,
      `page 1's content stream (${content.length} bytes): original text present=${bodySurvived}, ` +
        `callout text present=${calloutBurnedIn}, text-anchored note present=${textNoteBurnedIn}`,
    ),
  );

  checks.push(...textExportChecks(annotations, textItems));

  // Placement, on the page that is rotated: the *drawn* note is on page 2 and
  // its rectangle has to be inside the media box whichever way the page is
  // turned. Found by its own id rather than by subtype, since phase 05b's
  // comment is a `/Text` annotation too.
  const drawnNoteId = items.find((item) => item.kind === "note")?.id;
  const note = annotations.find(
    (entry) =>
      entry.dict.lookupMaybe(PDFName.of("NM"), PDFString)?.asString() === drawnNoteId,
  );
  const rect = note?.dict.lookupMaybe(PDFName.of("Rect"), PDFArray)?.asRectangle();
  const inside =
    !!rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 400 && rect.y + rect.height <= 600;
  checks.push(
    check(
      "a mark on a rotated page lands inside that page's box",
      note?.page === 1 && inside,
      rect
        ? `note /Rect [${rect.x.toFixed(1)} ${rect.y.toFixed(1)} ${(rect.x + rect.width).toFixed(1)} ${(rect.y + rect.height).toFixed(1)}] inside a 400x600 page rotated 90°`
        : "no /Text annotation was written",
    ),
  );

  const marked = await pdfCarriesAnnotatedMarker(bytes);
  const sourceMarked = await pdfCarriesAnnotatedMarker(source);
  const roundTripped = await pdfCarriesAnnotatedMarker(
    await exportAnnotatedPdf({ bytes, items }),
  );
  checks.push(
    check(
      "the annotated marker is written into the file and survives a re-save",
      marked && !sourceMarked && roundTripped,
      `/${ANNOTATED_MARKER_KEY} present in the export=${marked}, in the original=${sourceMarked}, after re-saving the export=${roundTripped}`,
    ),
  );

  return checks;
}

/**
 * The text-anchored half of the export.
 *
 * What is worth checking here is exactly what could be wrong without looking
 * wrong: a highlight that describes its two lines as one quadrilateral (so a
 * reader that draws from `/QuadPoints` paints across the wrap), a comment that
 * writes its icon somewhere other than the words it belongs to, and a `/Text`
 * with no `/Popup`, which several readers show in a comment list and nowhere
 * else.
 */
function textExportChecks(
  annotations: readonly { page: number; dict: PDFDict }[],
  textItems: readonly ResolvedTextAnnotation[],
): SelfTestCheck[] {
  const byName = (id: string) =>
    annotations.find(
      (entry) => entry.dict.lookupMaybe(PDFName.of("NM"), PDFString)?.asString() === id,
    );

  const wrapped = textItems[0]!;
  const commented = textItems[1]!;

  const highlight = byName(wrapped.item.id);
  const quads = highlight?.dict.lookupMaybe(PDFName.of("QuadPoints"), PDFArray);
  const subtype = highlight?.dict
    .lookupMaybe(PDFName.of("Subtype"), PDFName)
    ?.asString();
  const contents = highlight?.dict
    .lookupMaybe(PDFName.of("Contents"), PDFHexString)
    ?.decodeText();

  const icon = byName(`${commented.item.id}:note`);
  const iconRect = icon?.dict.lookupMaybe(PDFName.of("Rect"), PDFArray)?.asRectangle();
  const popupRef = icon?.dict.get(PDFName.of("Popup"));
  const iconText = icon?.dict
    .lookupMaybe(PDFName.of("Contents"), PDFHexString)
    ?.decodeText();
  // The resolved start, in user space: the first rectangle's top-left on a
  // 400x600 page with `y` running up.
  const wantX = commented.placement.rects[0]!.x * 400;
  const wantY = (1 - commented.placement.rects[0]!.y) * 600;

  return [
    check(
      "a text-anchored highlight exports one quadrilateral per line, not one box",
      subtype === "/Highlight" &&
        quads?.size() === wrapped.placement.rects.length * 8 &&
        contents === wrapped.item.anchor.quote,
      `${subtype ?? "missing"} with ${(quads?.size() ?? 0) / 8} quad(s) for ` +
        `${wrapped.placement.rects.length} rect(s); /Contents ${JSON.stringify(contents ?? "")}`,
    ),
    check(
      "a text-anchored note exports as /Text plus /Popup, at the start of its quote",
      icon?.dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.asString() === "/Text" &&
        !!popupRef &&
        iconText === NOTE_TEXT &&
        !!iconRect &&
        Math.abs(iconRect.x + iconRect.width - wantX) < 2 &&
        Math.abs(iconRect.y + iconRect.height - wantY) < 2,
      iconRect
        ? `icon /Rect [${iconRect.x.toFixed(1)} ${iconRect.y.toFixed(1)}] ${iconRect.width.toFixed(1)}x${iconRect.height.toFixed(1)}, ` +
          `quote starts at (${wantX.toFixed(1)}, ${wantY.toFixed(1)}), popup=${!!popupRef}, contents ${JSON.stringify(iconText ?? "")}`
        : "no /Text annotation was written for the comment",
    ),
  ];
}

/**
 * Whether a decoded content stream shows this text.
 *
 * Both spellings, because a content stream may write a string either way and
 * pdf-lib picks the second: `(original body text) Tj` and
 * `<6f726967696e616c…> Tj` are the same instruction. Checking only the literal
 * form makes "the text is still there" look false and "the callout was burned
 * in" look true, which is a wrong answer in both directions.
 */
function contentShowsText(content: string, text: string): boolean {
  if (content.includes(text)) return true;
  const hex = [...text]
    .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  return content.toLowerCase().includes(hex);
}

function readAnnotations(document_: PDFDocument, pageIndex: number): PDFDict[] {
  const page = document_.getPage(pageIndex);
  const annots = page.node.Annots();
  if (!annots) return [];
  const dicts: PDFDict[] = [];
  for (let index = 0; index < annots.size(); index += 1) {
    const entry = annots.get(index);
    const dict = document_.context.lookupMaybe(entry, PDFDict);
    if (dict) dicts.push(dict);
  }
  return dicts;
}

/** A page's content streams, decoded. */
function pageContentText(document_: PDFDocument, pageIndex: number): string {
  const page = document_.getPage(pageIndex);
  const contents = page.node.get(PDFName.of("Contents"));
  const refs: unknown[] =
    contents instanceof PDFArray ? contents.asArray() : [contents];

  let out = "";
  for (const entry of refs) {
    const stream = document_.context.lookupMaybe(entry as PDFRef | undefined, PDFStream);
    if (!stream) continue;
    // A stream that came back from `load` is raw and usually flate-encoded, so
    // it has to be decoded before "is our text in here" means anything.
    try {
      out +=
        stream instanceof PDFRawStream
          ? new TextDecoder().decode(decodePDFRawStream(stream).decode())
          : stream.getContentsString();
    } catch {
      out += stream.getContentsString();
    }
  }
  return out;
}
