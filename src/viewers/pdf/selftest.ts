/**
 * PDF plugin self-test. **Dev builds only.**
 *
 * Most of what matters about a PDF viewer is "look at it and see whether it is
 * right", which no automated check replaces. What *is* checkable, and what this
 * covers, is everything underneath that judgement — the parts where a
 * regression is invisible until someone opens the right file:
 *
 *   - a real page renders, end to end, through pdf.js into the tile;
 *   - the invert toggle and the invert shortcut stay in step, in *both*
 *     directions. This one is a regression test for a reported bug: pressing
 *     the key changed the page and left the toolbar showing the old state;
 *   - thumbnails render *content*, which is the specific thing that was broken
 *     in the original implementation — a blank rectangle is indistinguishable
 *     from a working thumbnail unless something samples it;
 *   - mounting and unmounting repeatedly gives every canvas back.
 *
 * Phase 05a added the annotation half, and split it deliberately from the suite
 * in `annotation/selftest.ts`. That one checks the model and reads the export
 * back with *pdf-lib*, the library that wrote it. These check the things only
 * this plugin can answer: that annotate mode actually takes over the tile, that
 * a mark reaches the contract surface the sidebar reads, that the coordinate
 * mapping agrees with **pdf.js's own viewport** rather than with our derivation
 * of it, and that an exported file's annotations are visible to a second,
 * independent parser.
 *
 * Phase 05b added the text half — an OCR'd page's invisible text layer, a real
 * browser selection over it, and the anchor that comes back — for the same
 * reason: `annotation/selftest.ts` can drive the quote model over plain strings,
 * but only the webview can say whether the words are selectable and whether they
 * are where the geometry claims.
 *
 * It runs in the real webview because canvas behaviour is where webkit2gtk,
 * WebView2 and WKWebView diverge, and this plugin is almost entirely canvas.
 */

import {
  check,
  report,
  skip,
  type SelfTestCheck,
  type SelfTestReport,
} from "../../dev/selftest";
import { createMemoryFileHandle, type FileHandle } from "../../files";
import type { ToolbarControl, ViewerInstance } from "../contract";
import { disposeViewer, isViewerDisposed, mountViewer } from "../instances";
import {
  buildFixturePdf,
  FIXTURE_OCR_LINES,
  FIXTURE_OCR_PAGE,
  FIXTURE_PAGE_COUNT,
  FIXTURE_PAGE_ONE_TEXT,
} from "./dev/fixture";
import { PDF_PLUGIN_ID } from "./id";
import type { PdfViewerInstance } from "./instance";

const TITLE = "pdf viewer plugin";

export async function runPdfSelfTest(): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [];
  checks.push(await engineBuiltInsCheck());
  checks.push(await workerModeCheck());
  const environment = await probeRenderEnvironment();
  checks.push(environment.check);
  checks.push(...(await lifecycleChecks(environment.canRender)));
  checks.push(await viewportAgreementCheck());
  return report(TITLE, checks);
}

/**
 * Whether this webview has the built-ins pdf.js expects, and which ones it did
 * not.
 *
 * The check that would have caught the *second* macOS hang, and the first one
 * to read when a platform starts behaving differently from the others: it names
 * the engine. An empty list means a current webview. A non-empty one means an
 * old WebKit that `compat.ts` is carrying — the app works, and the reason it
 * works is a polyfill rather than the platform. Only a built-in still *missing*
 * after that is a failure, which would mean a polyfill did not take and the
 * silent hang is back.
 *
 * First in the report because everything else in the suite, and everything in
 * the plugin, is downstream of it.
 */
async function engineBuiltInsCheck(): Promise<SelfTestCheck> {
  const { pdfCompatFilled, pdfCompatMissing } = await import("./compat");
  const filled = pdfCompatFilled();
  const missing = pdfCompatMissing();
  return check(
    "the webview has the built-ins pdf.js needs",
    missing.length === 0,
    missing.length > 0
      ? `still missing after polyfilling: ${missing.join(", ")}`
      : filled.length > 0
        ? `polyfilled for this webview: ${filled.join(", ")}`
        : "all present natively",
  );
}

/**
 * Whether the decoder got a real worker, and how long it took to say so.
 *
 * The check that would have caught the macOS bundle hanging on every PDF (see
 * `pdfjs.ts`, "The worker is started from source"). It is not merely
 * informational: `main-thread` means the probe timed out, which is a platform
 * this app is now carrying rather than a platform it works on, and the number
 * of milliseconds is what tells the two apart at a glance — a fallback taken in
 * five seconds is the timeout, and one taken in five milliseconds is a webview
 * that refused a blob worker outright.
 *
 * Deliberately the *first* check in the report: everything below it opens a
 * document, so if this one is slow the rest are about to be slower.
 */
async function workerModeCheck(): Promise<SelfTestCheck> {
  const { preparePdfWorker, PDFJS_VERSION } = await import("./pdfjs");
  const startedAt = performance.now();
  let mode: string;
  try {
    mode = await preparePdfWorker();
  } catch (thrown) {
    mode = thrown instanceof Error ? `unavailable — ${thrown.message}` : "unavailable";
  }
  const elapsed = Math.round(performance.now() - startedAt);
  return check(
    "pdf.js decodes in a worker",
    mode === "worker",
    `pdf.js ${PDFJS_VERSION}, ${mode}, resolved in ${elapsed}ms`,
  );
}

/** Why the render-dependent checks were skipped, when they were. */
const NO_COMPOSITOR =
  "the window is not being composited (minimised, occluded, or the screen is " +
  "asleep), so pdf.js cannot finish a render — it schedules its own " +
  "continuations on requestAnimationFrame. Bring the window to the front and " +
  "run the self-tests again to cover this.";

// ---------------------------------------------------------------------------
// Where pdf.js is allowed to draw
// ---------------------------------------------------------------------------

/**
 * Renders one page twice — into a canvas that is in the document, and into one
 * that is not — and reports whether each finished.
 *
 * This looks like a strange thing to check until it costs you an afternoon.
 * AGENTS.md warns that "canvas-heavy rendering is the most likely place for
 * inconsistencies to surface" on webkit2gtk, and this is the shape they take:
 * an attached canvas can be given an accelerated backing store, and an
 * accelerated backing store depends on the window actually being composited. A
 * render into one can then never complete — not fail, *never complete* — while
 * the identical render into a detached canvas finishes immediately.
 *
 * Bounded by a timeout, because the failure mode being detected is a promise
 * that never settles, and an unbounded await on it would hang the harness
 * exactly the way it hangs the viewer.
 */
async function probeRenderEnvironment(): Promise<{
  readonly check: SelfTestCheck;
  readonly canRender: boolean;
}> {
  const { loadPdfDocument } = await import("./pdfjs");
  const task = await loadPdfDocument({ data: buildFixturePdf() });
  const document_ = await task.promise;

  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:400px;height:520px;pointer-events:none;";
  document.body.append(host);

  try {
    const page = await document_.getPage(1);
    const viewport = page.getViewport({ scale: 1 });

    const attempt = async (attached: boolean): Promise<string> => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      if (attached) host.append(canvas);

      const context = canvas.getContext("2d", { alpha: false })!;
      const render = page.render({ canvas, canvasContext: context, viewport });

      const finished = await Promise.race([
        render.promise.then(() => true).catch(() => false),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 4000),
        ),
      ]);
      const ink = finished ? darkPixelCount(canvas) : -1;
      try {
        render.cancel();
      } catch {
        /* already finished */
      }
      canvas.remove();
      canvas.width = 0;
      return finished ? `${ink} ink pixel(s)` : "never settled (4s)";
    };

    const detached = await attempt(false);
    const attachedResult = await attempt(true);

    // The environment, alongside the result. pdf.js waits on `document.fonts`
    // before it paints glyphs, and a webview whose window is not being
    // composited delivers neither font events nor animation frames — so a
    // render that "never settles" may be saying something about the window
    // rather than about the code. Without these three values the two are
    // indistinguishable, which is the difference between a real bug and an
    // hour spent chasing one.
    const painting = await Promise.race([
      new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => resolve(true));
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    const fontsReady = await Promise.race([
      document.fonts.ready.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    const detail =
      `attached: ${attachedResult}; detached: ${detached}` +
      ` [visibility=${document.visibilityState} focus=${document.hasFocus()}` +
      ` frames=${painting} fonts.ready=${fontsReady}]`;

    // Logged the moment it is known, not with the rest of the report. This is
    // an environmental fact about the webview — like the `platform=` line the
    // panel prints — and it is most useful precisely when a *later* check hangs
    // and the report is never printed at all.
    if (import.meta.env.DEV) {
      const { devLog } = await import("../../dev/log");
      await devLog(`pdf: canvas render backend — ${detail}`);
    }

    const canRender =
      attachedResult.includes("ink") && !attachedResult.startsWith("0 ");
    return {
      canRender,
      check: canRender
        ? check("pdf.js renders into a canvas in the document", true, detail)
        : painting
          ? check("pdf.js renders into a canvas in the document", false, detail)
          : skip(
              "pdf.js renders into a canvas in the document",
              `${NO_COMPOSITOR} — ${detail}`,
            ),
    };
  } finally {
    host.remove();
    await document_.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Lifecycle, rendering, inversion, thumbnails and text
// ---------------------------------------------------------------------------

function scratchContainer(): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;left:-10000px;top:0;width:420px;height:560px;pointer-events:none;";
  document.body.append(container);
  return container;
}

/** Luminance range of a rendered image. A blank one measures ~0. */
function luminanceStats(canvas: HTMLCanvasElement): {
  mean: number;
  spread: number;
} {
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  })!;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let total = 0;
  let count = 0;
  let min = 255;
  let max = 0;
  // Every 16th pixel: enough for a mean and a range, and a full walk here would
  // dominate the self-test's runtime.
  for (let index = 0; index < data.length; index += 64) {
    const luminance =
      0.299 * data[index]! +
      0.587 * data[index + 1]! +
      0.114 * data[index + 2]!;
    total += luminance;
    count += 1;
    if (luminance < min) min = luminance;
    if (luminance > max) max = luminance;
  }
  return { mean: count ? total / count : 0, spread: max - min };
}

/**
 * Every pixel, not every sixteenth.
 *
 * Only used to explain a failure: a sampled mean cannot tell "nothing was
 * drawn" apart from "thin glyphs fell between the samples", and those two have
 * completely different causes.
 */
function darkPixelCount(canvas: HTMLCanvasElement): number {
  const context = canvas.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  })!;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index]! < 200 || data[index + 1]! < 200 || data[index + 2]! < 200)
      count += 1;
  }
  return count;
}

async function decodeToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(new Error("thumbnail data URL did not decode"));
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d", { alpha: false })!.drawImage(image, 0, 0);
  return canvas;
}

function findControl(
  controls: readonly ToolbarControl[],
  id: string,
): ToolbarControl | undefined {
  return controls.find((control) => control.id === id);
}

/**
 * Rendering, and the invert toggle's two entry points.
 *
 * Driven through the container the plugin was mounted into and the contributions
 * it publishes — no test-only hooks — so what is checked is the same surface the
 * shell and the user drive.
 */
async function renderedPageChecks(
  instance: ViewerInstance,
  container: HTMLElement,
  canRender: boolean,
): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];
  if (!canRender) {
    return [
      skip("renders page 1 into the tile", NO_COMPOSITOR),
      skip(
        "builds a selectable text layer once scrolling settles",
        NO_COMPOSITOR,
      ),
      ...invertSyncChecks(instance, container),
    ];
  }

  const pages = container.querySelector<HTMLElement>(".pdf-pages");
  const canvas = container.querySelector<HTMLCanvasElement>(
    '.pdf-page[data-page="1"] .pdf-page-canvas',
  );
  const textLayer = container.querySelector<HTMLElement>(
    '.pdf-page[data-page="1"] .textLayer',
  );

  if (!pages || !canvas || !textLayer) {
    checks.push(
      check("renders page 1 into the tile", false, "no page element found"),
    );
    return checks;
  }

  await waitFor(
    () => canvas.width > 0 && luminanceStats(canvas).spread > 40,
    8000,
  );
  const natural = luminanceStats(canvas);
  const rendered =
    canvas.width > 0 && natural.spread > 40 && natural.mean > 128;
  checks.push(
    check(
      "renders page 1 into the tile",
      rendered,
      rendered
        ? `${canvas.width}x${canvas.height}, mean luminance ${natural.mean.toFixed(0)}, range ${natural.spread.toFixed(0)} (light paper with content on it)`
        : // A blank canvas and a canvas whose ink the sampler stepped over look
          // identical in a mean. The full scan distinguishes them, and knowing
          // which it is is the whole difference between "pdf.js drew nothing"
          // and "the check is measuring wrong".
          `${canvas.width}x${canvas.height}, sampled mean ${natural.mean.toFixed(0)} range ${natural.spread.toFixed(0)}; ` +
            `full scan: ${darkPixelCount(canvas)} non-white pixel(s); page element marked rendered=${
              canvas.closest(".pdf-page")?.classList.contains("is-rendered") ??
              false
            }`,
    ),
  );

  // The text layer is deliberately deferred to the settle pass, so it arrives
  // after the canvas rather than with it.
  await waitFor(() => textLayer.childElementCount > 0, 5000);
  checks.push(
    check(
      "builds a selectable text layer once scrolling settles",
      textLayer.childElementCount > 0,
      `${textLayer.childElementCount} positioned span(s) over the page`,
    ),
  );

  checks.push(...invertSyncChecks(instance, container));

  // Inversion must not touch the pixels — that is what keeps a copied region in
  // the document's own colours. Needs a rendered page to be meaningful, so it
  // lives here rather than with the sync checks.
  const invertKeybind = instance
    .keybinds!.getKeybinds()
    .find((entry) => entry.id === "invert.toggle")!;
  invertKeybind.run();
  const invertedPixels = luminanceStats(canvas);
  invertKeybind.run();

  checks.push(
    check(
      "inversion leaves the canvas pixels alone",
      Math.abs(invertedPixels.mean - natural.mean) < 2,
      `canvas mean luminance ${natural.mean.toFixed(0)} -> ${invertedPixels.mean.toFixed(0)} while inverted (so a copied region keeps the document's colours)`,
    ),
  );

  return checks;
}

/**
 * The invert toggle and the invert shortcut, in both directions.
 *
 * A regression test for a reported bug: pressing the key changed the page and
 * left the toolbar showing the old state. It deliberately needs **no rendered
 * pixels** — the toggle, the shortcut, the contributed control's value, the
 * change notification and the CSS class are all observable on a page that has
 * not been drawn — so this keeps working on a machine where the window is not
 * being composited, which is precisely when the render checks cannot run.
 */
function invertSyncChecks(
  instance: ViewerInstance,
  container: HTMLElement,
): SelfTestCheck[] {
  const pages = container.querySelector<HTMLElement>(".pdf-pages");
  const canvas = container.querySelector<HTMLCanvasElement>(
    '.pdf-page[data-page="1"] .pdf-page-canvas',
  );
  const toolbar = instance.toolbar;
  const invertKeybind = instance.keybinds
    ?.getKeybinds()
    .find((entry) => entry.id === "invert.toggle");

  if (!pages || !canvas || !toolbar || !invertKeybind) {
    return [
      check(
        "the invert shortcut and the invert toggle stay in step",
        false,
        "the tile did not contribute an invert control and shortcut",
      ),
    ];
  }

  const readToggle = (): boolean => {
    const control = findControl(toolbar.getControls(), "invert.toggle");
    return control?.kind === "toggle" ? control.value : false;
  };

  // The change notification matters as much as the value: the shell re-reads
  // the controls when this fires, so a toggle that only reports correctly once
  // something *else* republishes is still broken from the user's side.
  let notifications = 0;
  const unsubscribe = toolbar.onControlsChange(() => {
    notifications += 1;
  });

  const before = readToggle();
  invertKeybind.run();
  const afterKeybind = readToggle();
  const notifiedByKeybind = notifications > 0;
  const classAfterKeybind = pages.classList.contains("is-inverted");
  const filter = getComputedStyle(canvas).filter;

  const toggleControl = findControl(toolbar.getControls(), "invert.toggle");
  if (toggleControl?.kind === "toggle") toggleControl.setValue(false);
  const afterToolbar = readToggle();
  const classAfterToolbar = pages.classList.contains("is-inverted");
  unsubscribe();

  return [
    check(
      "the invert shortcut and the invert toggle stay in step",
      before === false &&
        afterKeybind === true &&
        classAfterKeybind &&
        notifiedByKeybind &&
        afterToolbar === false &&
        !classAfterToolbar,
      `toggle ${before} -> ${afterKeybind} (shortcut, notified=${notifiedByKeybind}, class=${classAfterKeybind}) -> ${afterToolbar} (toolbar, class=${classAfterToolbar})`,
    ),
    check(
      "inverting applies a filter to the page canvas",
      filter !== "none" && filter.includes("invert"),
      `computed filter while inverted: "${filter}"`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Annotation (phase 05a)
// ---------------------------------------------------------------------------

/**
 * Annotate mode, the contract surface the sidebar reads, and the export.
 *
 * Driven entirely through what the shell can see — the contributed toolbar
 * control, the contributed keybind, the container's own DOM, and
 * `ViewerAnnotationApi` — because those are the surfaces that have to work. The
 * marks themselves are put in through the shared store, which is where the
 * tools put them, so nothing here needs a synthetic pointer gesture.
 */
async function annotationChecks(
  instance: ViewerInstance,
  container: HTMLElement,
  file: FileHandle,
): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];
  const { annotationDocumentKey, overlayDocumentFor, overlayItemStamp } = await import(
    "../../annotation"
  );

  const toolbar = instance.toolbar;
  const annotation = instance.annotation;
  const toggleKeybind = instance.keybinds
    ?.getKeybinds()
    .find((entry) => entry.id === "annotate.toggle");

  if (!toolbar || !annotation || !toggleKeybind) {
    return [
      check(
        "annotate mode is reachable from the toolbar and the keyboard",
        false,
        `capabilities.annotation=${instance.capabilities.annotation}, ` +
          `control=${!!toolbar}, keybind=${!!toggleKeybind}`,
      ),
    ];
  }

  const readToggle = (): boolean => {
    const control = findControl(toolbar.getControls(), "annotate.toggle");
    return control?.kind === "toggle" ? control.value : false;
  };
  const palette = (): boolean => !!container.querySelector(".pdf-annot-palette");

  const before = readToggle();
  toggleKeybind.run();
  const afterKey = readToggle();
  const paletteOpen = palette();
  const annotatingClass = !!container.querySelector(".pdf-viewer.is-annotating");

  const control = findControl(toolbar.getControls(), "annotate.toggle");
  if (control?.kind === "toggle") control.setValue(false);
  const afterToolbar = readToggle();
  const paletteClosed = !palette();

  checks.push(
    check(
      "the annotate toggle and its shortcut open the same tool palette",
      before === false &&
        afterKey === true &&
        paletteOpen &&
        annotatingClass &&
        afterToolbar === false &&
        paletteClosed,
      `toggle ${before} -> ${afterKey} (shortcut, palette=${paletteOpen}, tile marked=${annotatingClass}) -> ${afterToolbar} (toolbar, palette removed=${paletteClosed})`,
    ),
  );

  // The list the sidebar renders, and the deletion it offers.
  const overlay = overlayDocumentFor(annotationDocumentKey(file));
  let notifications = 0;
  const unsubscribe = annotation.onAnnotationsChange(() => {
    notifications += 1;
  });

  const mark = {
    ...overlayItemStamp(),
    kind: "note" as const,
    subdivision: 1,
    color: "#ffd93d",
    opacity: 1,
    text: "a self-test note",
    open: false,
    bounds: { x: 0.4, y: 0.3, width: 0.05, height: 0.04 },
  };
  overlay.add(mark);

  const listed = annotation.listAnnotations();
  const entry = listed.find((candidate) => candidate.id === mark.id);
  checks.push(
    check(
      "a mark reaches the annotation list with a place to jump to",
      !!entry &&
        entry.subdivision === 1 &&
        entry.type === "note" &&
        entry.label.includes("self-test") &&
        notifications > 0,
      entry
        ? `listed as "${entry.type} — ${entry.label}" on subdivision ${entry.subdivision}, ${notifications} change notification(s)`
        : `not listed: ${listed.length} entry(ies)`,
    ),
  );

  // The list's own delete, through the contract rather than the tools.
  annotation.removeAnnotation(mark.id);
  const afterDelete = annotation.listAnnotations();
  checks.push(
    check(
      "deleting from the list removes the mark",
      afterDelete.every((candidate) => candidate.id !== mark.id),
      `${listed.length} -> ${afterDelete.length} annotation(s)`,
    ),
  );
  unsubscribe();

  // The export, read back by pdf.js — a second parser's opinion of whether
  // those are real annotation objects. `annotation/selftest.ts` reads the same
  // file with pdf-lib; agreeing with the library that wrote it is not enough.
  overlay.add(mark);
  try {
    const exported = await within(
      annotation.export({ format: "pdf" }),
      15000,
      "annotation export",
    );
    const { loadPdfDocument } = await import("./pdfjs");
    const reopened = await (await loadPdfDocument({ data: new Uint8Array(exported.bytes) }))
      .promise;
    const page = await reopened.getPage(2);
    const parsed = (await page.getAnnotations()) as { subtype?: string }[];
    await reopened.destroy();

    checks.push(
      check(
        "pdf.js reads the exported marks back as annotation objects",
        parsed.some((item) => item.subtype === "Text") &&
          exported.suggestedName.endsWith("-annotated.pdf"),
        `${parsed.length} annotation(s) on page 2: ${parsed.map((item) => item.subtype ?? "?").join(" ")}; suggested name "${exported.suggestedName}"`,
      ),
    );
  } catch (thrown) {
    checks.push(
      check(
        "pdf.js reads the exported marks back as annotation objects",
        false,
        thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown),
      ),
    );
  }

  // The store outlives the tile on purpose, so the suite has to clean up after
  // itself rather than leaving a note on a document the user may have open.
  overlay.remove(mark.id);
  return checks;
}

// ---------------------------------------------------------------------------
// Text anchors and OCR-embedded text (phase 05b)
// ---------------------------------------------------------------------------

/**
 * The half of phase 05b that only the real webview can answer.
 *
 * `annotation/selftest.ts` drives the anchor model over plain strings, and the
 * model does not care where the strings came from. What it cannot check is the
 * part that made this phase's first task a task: that a *scanned, OCR'd* page —
 * invisible text drawn in rendering mode 3 over a picture — produces a text
 * layer you can select in, positioned over the right pixels at more than one
 * zoom, and that a browser selection over it maps back to the offsets the
 * anchor model works in. Page 3 of the fixture is that page.
 *
 * Every one of these needs the page actually rendered, so they skip rather than
 * fail when the window is not being composited (see `NO_COMPOSITOR`).
 */
async function textAnnotationChecks(
  instance: ViewerInstance,
  container: HTMLElement,
  file: FileHandle,
  canRender: boolean,
): Promise<SelfTestCheck[]> {
  const names = [
    "an OCR'd page's invisible text is selectable",
    "the OCR text layer sits over its glyphs at more than one zoom",
    "a selection across a line wrap anchors to the quote and resolves to two rectangles",
    "text selected without a drag is offered the popover, and it highlights",
    "a text-anchored mark reaches the annotation list and the exported file",
  ];
  if (!canRender) return names.map((name) => skip(name, NO_COMPOSITOR));

  const anchors = instance.annotation?.textAnchors;
  if (!anchors) {
    return names.map((name) =>
      check(
        name,
        false,
        "the tile published no text-anchor capability, so no text can be annotated",
      ),
    );
  }

  const checks: SelfTestCheck[] = [];
  const subdivision = FIXTURE_OCR_PAGE - 1;
  const { annotationDocumentKey, buildTextAnchor, resolveTextAnchor, textAnnotationStamp, textDocumentFor } =
    await import("../../annotation");

  // --- the text layer over a scan ---
  await instance.reveal?.({ subdivision });
  const pageElement = container.querySelector<HTMLElement>(
    `.pdf-page[data-page="${FIXTURE_OCR_PAGE}"]`,
  );
  const textLayer = pageElement?.querySelector<HTMLElement>(".textLayer");
  await waitFor(() => (textLayer?.childElementCount ?? 0) > 0, 8000);

  const pageText = await anchors.textOf(subdivision);
  /**
   * The spans that are in the layer *now*.
   *
   * Re-queried at every use rather than captured once: a zoom rebuilds the text
   * layer, and a span from before it is a detached node — one that still
   * measures, still reads back its text, and can still be put in a `Range`,
   * which then belongs to no document and selects nothing. Holding one across
   * the zoom check below is how the two checks after it came to depend on the
   * order they run in.
   */
  const liveSpans = (): HTMLElement[] =>
    [...(textLayer?.querySelectorAll("span") ?? [])].filter(
      (span) => (span.textContent ?? "").trim().length > 0,
    );

  const spans = liveSpans();
  checks.push(
    check(
      names[0]!,
      spans.length >= 2 &&
        FIXTURE_OCR_LINES.every(
          (line) =>
            pageText.includes(line) &&
            spans.some((span) => (span.textContent ?? "").includes(line)),
        ),
      `${spans.length} positioned span(s) over the scan; extracted ${JSON.stringify(pageText)}`,
    ),
  );

  // --- positioned correctly, at two zooms ---
  const firstLine = FIXTURE_OCR_LINES[0]!;
  const lineStart = pageText.indexOf(firstLine);
  const expected = (await anchors.regionsFor(subdivision, {
    start: lineStart,
    end: lineStart + firstLine.length,
  }))[0];
  /** The span's box relative to the page, which is what the geometry describes. */
  const measure = (): { x: number; y: number; width: number } | null => {
    const lineSpan = liveSpans().find((span) =>
      (span.textContent ?? "").includes(firstLine),
    );
    if (!pageElement || !lineSpan) return null;
    const page = pageElement.getBoundingClientRect();
    const box = lineSpan.getBoundingClientRect();
    if (page.width === 0 || box.width === 0) return null;
    return {
      x: (box.left - page.left) / page.width,
      y: (box.top - page.top) / page.height,
      width: box.width / page.width,
    };
  };

  const atFit = measure();
  const zoomIn = instance.keybinds?.getKeybinds().find((entry) => entry.id === "zoom.in");
  zoomIn?.run();
  zoomIn?.run();
  // The spans are repositioned through a custom property, so the new box is
  // there on the next layout rather than after a re-render — but the re-render
  // is what a real reader would be looking at, so let the settle pass run
  // rather than measuring mid-zoom.
  await pause(400);
  const zoomed = measure();
  instance.keybinds?.getKeybinds().find((entry) => entry.id === "zoom.fitWidth")?.run();
  await pause(200);

  /**
   * Within 0.6% of the page, i.e. a few pixels at a readable zoom.
   *
   * Deliberately tight on `y`. This check is what stands between the resolver
   * and a box that is a fraction of a line out of place, and at the 2% it
   * started at it passed comfortably while every highlight sat a descender's
   * height above the words it belonged to — the span's box hangs from the
   * *ascent* above the baseline, not the full glyph height (`textGeometry.ts`,
   * `ascentRatio`). The remaining slack is for the couple of percent between
   * the font metrics the PDF carries and the ones the engine measures off the
   * font it substituted.
   */
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.006;
  checks.push(
    check(
      names[1]!,
      !!expected &&
        !!atFit &&
        !!zoomed &&
        near(atFit.x, expected.x) &&
        near(atFit.y, expected.y) &&
        near(atFit.width, expected.width) &&
        near(zoomed.x, expected.x) &&
        near(zoomed.y, expected.y) &&
        near(zoomed.width, expected.width),
      expected
        ? `geometry says (${expected.x.toFixed(3)}, ${expected.y.toFixed(3)}) w=${expected.width.toFixed(3)}; ` +
          `span at fit-width (${atFit?.x.toFixed(3)}, ${atFit?.y.toFixed(3)}) w=${atFit?.width.toFixed(3)}; ` +
          `zoomed in (${zoomed?.x.toFixed(3)}, ${zoomed?.y.toFixed(3)}) w=${zoomed?.width.toFixed(3)}`
        : "the resolver produced no box for the first OCR line",
    ),
  );

  // --- a real browser selection, across the wrap ---
  const wrapStart = lineStart + firstLine.length - 8;
  const wrapEnd = pageText.indexOf(FIXTURE_OCR_LINES[1]!) + 9;
  const selection = window.getSelection();
  let anchor = null as Awaited<ReturnType<typeof anchors.anchorForSelection>>;

  // The zoom above rebuilt the layer, so these are looked up again.
  await waitFor(() => liveSpans().length >= 2, 4000);
  const selectable = liveSpans();

  if (selection && selectable.length >= 2) {
    const range = document.createRange();
    const first = selectable.find((span) =>
      (span.textContent ?? "").includes(firstLine),
    );
    const second = selectable.find((span) =>
      (span.textContent ?? "").includes(FIXTURE_OCR_LINES[1]!),
    );
    const head = first?.firstChild;
    const tail = second?.firstChild;
    if (head && tail) {
      range.setStart(head, Math.max(0, firstLine.length - 8));
      range.setEnd(tail, 9);
      selection.removeAllRanges();
      selection.addRange(range);
      anchor = await anchors.anchorForSelection();
    }
  }
  const resolvedAnchor = anchor ? await resolveTextAnchor(anchor, anchors) : null;
  const rects = resolvedAnchor
    ? await anchors.regionsFor(resolvedAnchor.subdivision, resolvedAnchor)
    : [];
  selection?.removeAllRanges();

  checks.push(
    check(
      names[2]!,
      !!anchor &&
        anchor.quote === pageText.slice(wrapStart, wrapEnd) &&
        anchor.pageHint === subdivision &&
        resolvedAnchor?.start === wrapStart &&
        resolvedAnchor.end === wrapEnd &&
        rects.length === 2 &&
        rects.every((rect) => rect.width > 0 && rect.height > 0),
      anchor
        ? `selected ${JSON.stringify(anchor.quote)} -> ${rects.length} rectangle(s) ` +
          `at ${rects.map((rect) => `(${rect.x.toFixed(2)}, ${rect.y.toFixed(2)})`).join(" ")}` +
          `; wanted ${JSON.stringify(pageText.slice(wrapStart, wrapEnd))}`
        : "the selection produced no anchor",
    ),
  );

  // --- the offer, for a selection no drag produced ---
  //
  // A regression test with a story. The popover was hung off a pointer release
  // that had travelled far enough to count as a drag, so a double-click on a
  // word, a triple-click on a line, a shift+click, shift+arrows and select-all
  // — every way of selecting text that does not move the mouse — left the
  // reader looking at their own selection with nothing offered about it. It now
  // follows the *selection*, which is what setting one directly here drives:
  // `selectionchange` is the event all of those have in common.
  const key = annotationDocumentKey(file);
  const store = textDocumentFor(key);
  const before = store.items.length;
  let popover: HTMLElement | null = null;
  let buttons: string[] = [];
  let quoted: string | undefined;

  const word = liveSpans()[0];
  if (selection && word) {
    const range = document.createRange();
    range.selectNodeContents(word);
    selection.removeAllRanges();
    selection.addRange(range);

    await waitFor(() => !!container.querySelector(".pdf-text-popover"), 2000);
    popover = container.querySelector<HTMLElement>(".pdf-text-popover");
    const controls = [...(popover?.querySelectorAll("button") ?? [])];
    buttons = controls.map((button) => button.textContent ?? "");
    // …and the offer has to do something. `click()` is what the button does on
    // a real press; the mark it makes is removed again below.
    controls.find((button) => button.textContent === "highlight")?.click();
    await waitFor(() => store.items.length > before, 4000);
    quoted = store.items.at(-1)?.anchor.quote;
  }
  selection?.removeAllRanges();
  for (const added of store.items.slice(before)) store.remove(added.id);

  checks.push(
    check(
      names[3]!,
      !!popover &&
        buttons.includes("highlight") &&
        buttons.includes("note") &&
        quoted === word?.textContent,
      popover
        ? `popover offered [${buttons.join(", ")}]; highlighting made a mark quoting ${JSON.stringify(quoted ?? null)}`
        : "no popover appeared for a selection the pointer did not drag out",
    ),
  );

  // --- the list, and the file ---
  const mark = {
    ...textAnnotationStamp(),
    anchor:
      anchor ??
      buildTextAnchor({ text: pageText, start: wrapStart, end: wrapEnd, subdivision })!,
    color: "#ffd93d",
    opacity: 0.4,
    note: "a self-test comment",
  };
  store.add(mark);

  // The tile resolves on its own, off the store's change notification — which
  // is the wiring being checked, so it is waited for rather than driven.
  await waitFor(() => (store.placement(mark.id)?.rects.length ?? 0) > 0, 4000);
  const listed = instance.annotation?.listAnnotations() ?? [];
  const entry = listed.find((candidate) => candidate.id === mark.id);

  let exportedSubtypes: string[] = [];
  try {
    const exported = await within(
      instance.annotation!.export({ format: "pdf" }),
      15000,
      "annotated export",
    );
    const { loadPdfDocument } = await import("./pdfjs");
    const reopened = await (await loadPdfDocument({ data: new Uint8Array(exported.bytes) }))
      .promise;
    const page = await reopened.getPage(FIXTURE_OCR_PAGE);
    exportedSubtypes = ((await page.getAnnotations()) as { subtype?: string }[]).map(
      (item) => item.subtype ?? "?",
    );
    await reopened.destroy();
  } catch (thrown) {
    exportedSubtypes = [thrown instanceof Error ? thrown.message : String(thrown)];
  }

  checks.push(
    check(
      names[4]!,
      !!entry &&
        entry.type === "comment" &&
        entry.label.includes("self-test comment") &&
        entry.subdivision === subdivision &&
        entry.rect.width > 0 &&
        exportedSubtypes.includes("Highlight") &&
        exportedSubtypes.includes("Text"),
      (entry
        ? `listed as "${entry.type} — ${entry.label}" on subdivision ${entry.subdivision}`
        : `not listed among ${listed.length} entry(ies)`) +
        `; page ${FIXTURE_OCR_PAGE} of the export holds: ${exportedSubtypes.join(" ") || "nothing"}`,
    ),
  );

  // The store outlives the tile, so the suite cleans up after itself.
  store.remove(mark.id);
  return checks;
}

/**
 * Our normalized-to-user-space mapping against pdf.js's own viewport.
 *
 * `annotation/selftest.ts` checks the mapping analytically; this checks it
 * against the thing it has to agree with. The coordinates in the model came out
 * of a `PageViewport`, and `convertToPdfPoint` is that viewport's own inverse —
 * so if the two disagree, every exported mark on a rotated page is somewhere
 * else, and no amount of internal consistency will show it.
 */
async function viewportAgreementCheck(): Promise<SelfTestCheck> {
  try {
    const [{ PDFDocument, degrees }, { loadPdfDocument }] = await Promise.all([
      import("pdf-lib"),
      import("./pdfjs"),
    ]);
    const { pageSpaceOf } = await import("../../annotation/export/pdf");

    const rotations = [0, 90, 180, 270];
    const built = await PDFDocument.create();
    for (const rotation of rotations) {
      built.addPage([400, 600]).setRotation(degrees(rotation));
    }
    const bytes = await built.save({ useObjectStreams: false });

    const document_ = await (await loadPdfDocument({ data: new Uint8Array(bytes) })).promise;
    const samples = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.25, y: 0.75 },
    ];
    const failures: string[] = [];

    for (const [index, rotation] of rotations.entries()) {
      const page = await document_.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      const view = page.view;
      const space = pageSpaceOf(
        {
          x: view[0]!,
          y: view[1]!,
          width: view[2]! - view[0]!,
          height: view[3]! - view[1]!,
        },
        page.rotate,
      );

      if (
        Math.abs(space.displayWidth - viewport.width) > 0.01 ||
        Math.abs(space.displayHeight - viewport.height) > 0.01
      ) {
        failures.push(
          `/Rotate ${rotation}: display ${space.displayWidth}x${space.displayHeight} vs viewport ${viewport.width}x${viewport.height}`,
        );
      }

      for (const sample of samples) {
        const [ourX, ourY] = space.toUser(sample);
        const [theirX, theirY] = viewport.convertToPdfPoint(
          sample.x * viewport.width,
          sample.y * viewport.height,
        ) as [number, number];
        if (Math.abs(ourX - theirX) > 0.01 || Math.abs(ourY - theirY) > 0.01) {
          failures.push(
            `/Rotate ${rotation} at (${sample.x}, ${sample.y}): ours (${ourX.toFixed(1)}, ${ourY.toFixed(1)}) vs pdf.js (${theirX.toFixed(1)}, ${theirY.toFixed(1)})`,
          );
        }
      }
    }
    await document_.destroy();

    return check(
      "annotation coordinates agree with pdf.js's own viewport at every rotation",
      failures.length === 0,
      failures.length === 0
        ? `${rotations.length} rotations x ${samples.length} points match convertToPdfPoint to within 0.01pt`
        : failures.join("; "),
    );
  } catch (thrown) {
    return check(
      "annotation coordinates agree with pdf.js's own viewport at every rotation",
      false,
      thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown),
    );
  }
}

async function lifecycleChecks(canRender: boolean): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];
  const handle = createMemoryFileHandle({
    name: "selftest.pdf",
    bytes: buildFixturePdf(),
    mimeType: "application/pdf",
  });

  const container = scratchContainer();
  const clientId = "pdf-selftest";

  try {
    const mounted = await mountViewer({ clientId, container, file: handle });
    checks.push(
      check(
        "mounts an in-memory PDF",
        mounted.ok && mounted.plugin.id === PDF_PLUGIN_ID,
        mounted.ok
          ? `plugin=${mounted.plugin.id}`
          : `failed: ${mounted.error.message}`,
      ),
    );
    if (!mounted.ok) return checks;

    const instance = mounted.instance;
    checks.push(
      check(
        "reports the right capabilities",
        instance.status === "ready" &&
          instance.capabilities.search &&
          instance.capabilities.copy &&
          instance.capabilities.toolbar &&
          instance.capabilities.keybinds &&
          instance.capabilities.subdivisionCount === FIXTURE_PAGE_COUNT,
        `status=${instance.status} capabilities=${JSON.stringify(instance.capabilities)}`,
      ),
    );

    // The command set is meant to stay short. A count is a blunt check and
    // exactly the right one: it fails when someone adds a shortcut without
    // deciding what it replaces.
    //
    // Exact rather than an upper bound, since phase 05a: an inequality lets a
    // phase spend the headroom silently, and the whole point is that growing
    // this list is a decision someone writes down. Nine and eight — the seven
    // reading actions, annotate, and `Mod+S` to save what annotate produced;
    // and the seven page/zoom/invert controls plus the annotate toggle. Save
    // gets no toolbar control: it belongs to the palette that opens with the
    // mode. `viewers/pdf/actions.ts` records what was cut, and what was added.
    const listed = instance
      .keybinds!.getKeybinds()
      .filter((entry) => !entry.hidden);
    const controls = instance.toolbar!.getControls();
    checks.push(
      check(
        "the command set stays short",
        listed.length === 9 && controls.length === 8,
        `${listed.length} listed shortcut(s): ${listed.map((entry) => entry.keys[0]).join(" ")}; ${controls.length} toolbar control(s)`,
      ),
    );

    checks.push(...(await renderedPageChecks(instance, container, canRender)));
    checks.push(...(await annotationChecks(instance, container, handle)));
    checks.push(
      ...(await textAnnotationChecks(instance, container, handle, canRender)),
    );

    // Every page, not just the first: the original's thumbnails looked fine on
    // page 1 and were broken beyond it.
    if (!canRender) {
      checks.push(
        skip(
          "every page produces a thumbnail with content in it",
          NO_COMPOSITOR,
        ),
      );
      checks.push(skip("thumbnails are cached", NO_COMPOSITOR));
    } else {
      const spreads: number[] = [];
      for (let page = 0; page < FIXTURE_PAGE_COUNT; page += 1) {
        const thumbnail = await within(
          instance.thumbnail({
            maxWidth: 120,
            maxHeight: 160,
            subdivision: page,
          }),
          8000,
          `thumbnail for page ${page + 1}`,
        );
        if (thumbnail.kind !== "dataUrl") {
          spreads.push(-1);
          continue;
        }
        const decoded = await decodeToCanvas(thumbnail.dataUrl);
        spreads.push(luminanceStats(decoded).spread);
        decoded.width = 0;
      }
      checks.push(
        check(
          "every page produces a thumbnail with content in it",
          spreads.every((spread) => spread > 40),
          `luminance range per page: ${spreads.map((s) => Math.round(s)).join(", ")} (blank would be ~0)`,
        ),
      );

      const started = performance.now();
      await within(
        instance.thumbnail({ maxWidth: 120, maxHeight: 160, subdivision: 0 }),
        8000,
        "cached thumbnail",
      );
      const cachedMs = performance.now() - started;
      checks.push(
        check(
          "thumbnails are cached",
          cachedMs < 8,
          `repeat request took ${cachedMs.toFixed(2)}ms`,
        ),
      );
    }

    const segments =
      (await instance.search?.extractText({ subdivision: 0 })) ?? [];
    const text = segments.map((segment) => segment.text).join("");
    checks.push(
      check(
        "extracts native text in logical order",
        text.includes(FIXTURE_PAGE_ONE_TEXT),
        `${segments.length} segment(s): ${JSON.stringify(text.slice(0, 80))}`,
      ),
    );

    const copyable =
      (await instance.copy?.getCopyable({ kind: "all", subdivision: 0 })) ?? [];
    // The same call on the OCR'd page, because "behaves identically to native
    // text" is a claim about copying as much as about selecting, and a text
    // layer that quietly dropped invisible glyphs would pass the first one.
    const copiedScan =
      (await instance.copy?.getCopyable({
        kind: "all",
        subdivision: FIXTURE_OCR_PAGE - 1,
      })) ?? [];
    checks.push(
      check(
        "copy returns the page text, from a scan's invisible layer as well",
        copyable.some(
          (item) =>
            item.kind === "text" && item.text.includes(FIXTURE_PAGE_ONE_TEXT),
        ) &&
          copiedScan.some(
            (item) =>
              item.kind === "text" &&
              FIXTURE_OCR_LINES.every((line) => item.text.includes(line)),
          ),
        `page 1: ${copyable.map((item) => item.kind).join(", ") || "nothing"}; ` +
          `the OCR'd page: ${JSON.stringify(
            copiedScan.find((item) => item.kind === "text")?.text ?? "",
          )}`,
      ),
    );

    const saved = instance.serialize();
    await instance.restore({
      page: 2,
      zoomMode: "custom",
      zoom: 175,
      inverted: true,
    });
    await instance.restore(saved);
    checks.push(
      check(
        "serializes and restores state",
        JSON.stringify(instance.serialize()) === JSON.stringify(saved),
        `${JSON.stringify(saved)}`,
      ),
    );

    let survivedGarbage = true;
    try {
      await instance.restore({ page: "seven", zoom: NaN, zoomMode: 5 });
      await instance.restore(null);
      await instance.restore(saved);
    } catch {
      survivedGarbage = false;
    }
    checks.push(
      check(
        "tolerates malformed restore state",
        survivedGarbage,
        "restored null and junk",
      ),
    );

    const pdfInstance = instance as PdfViewerInstance;
    const before = pdfInstance.liveBufferCount;
    await disposeViewer(clientId);
    checks.push(
      check(
        "dispose releases every page canvas",
        isViewerDisposed(instance) &&
          pdfInstance.liveBufferCount === 0 &&
          container.childElementCount === 0,
        `live page canvases ${before} -> ${pdfInstance.liveBufferCount}, container emptied=${container.childElementCount === 0}`,
      ),
    );
  } catch (thrown) {
    checks.push(
      check(
        "pdf lifecycle ran to completion",
        false,
        thrown instanceof Error
          ? `${thrown.message}\n${thrown.stack ?? ""}`
          : String(thrown),
      ),
    );
  } finally {
    await disposeViewer(clientId);
    handle.release();
    container.remove();
  }

  checks.push(...(await mountCycleChecks(canRender)));
  return checks;
}

/**
 * Mount and unmount repeatedly.
 *
 * A leak per mount is the failure mode the brief's "no memory growth over
 * several mount/unmount cycles" describes, and one cycle would never show it.
 */
async function mountCycleChecks(canRender: boolean): Promise<SelfTestCheck[]> {
  if (!canRender) {
    return [
      skip(
        "mounts and unmounts repeatedly without retaining canvases",
        NO_COMPOSITOR,
      ),
    ];
  }
  const cycles = 3;
  let clean = 0;

  for (let index = 0; index < cycles; index += 1) {
    const handle = createMemoryFileHandle({
      name: `cycle-${index}.pdf`,
      bytes: buildFixturePdf(),
      mimeType: "application/pdf",
    });
    const container = scratchContainer();
    try {
      const mounted = await mountViewer({
        clientId: "pdf-selftest-cycle",
        container,
        file: handle,
      });
      if (!mounted.ok) break;
      const instance = mounted.instance as PdfViewerInstance;
      // The `held` guard matters: without it a cycle where nothing ever
      // rendered would "pass" for having released the canvases it never
      // allocated, and this check would go green on a viewer that draws
      // nothing at all.
      const held = await waitFor(() => instance.liveBufferCount > 0, 8000);
      await disposeViewer("pdf-selftest-cycle");
      if (held && instance.liveBufferCount === 0) clean += 1;
    } finally {
      await disposeViewer("pdf-selftest-cycle");
      handle.release();
      container.remove();
    }
  }

  return [
    check(
      "mounts and unmounts repeatedly without retaining canvases",
      clean === cycles,
      `${clean}/${cycles} cycles ended with zero live page canvases`,
    ),
  ];
}

/**
 * Bounds an await that has no business being unbounded.
 *
 * Used for every `thumbnail()` call. The failure this exists for is a pdf.js
 * render promise that never settles, and awaiting one directly does not fail
 * the check — it stops the entire harness, with no output, indistinguishable
 * from a slow machine.
 */
async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle in ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Lets the viewer's own settle pass run. Never used to wait for a promise. */
async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}
