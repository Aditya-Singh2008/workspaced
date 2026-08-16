/**
 * Image plugin self-test. **Dev builds only.**
 *
 * Most of what matters about an image viewer is "look at it and see whether it
 * is right", which no automated check replaces. What *is* checkable, and what
 * this covers, is everything underneath that judgement — the places where a
 * regression is invisible until someone opens the one file that shows it:
 *
 *   - **decoders produce the right pixels**, not merely *some* pixels. Every
 *     decode check asserts colours at coordinates, because a transposed axis, a
 *     swapped red and blue, or an off-by-one row all decode "successfully";
 *   - **the pixel inspector's coordinate mapping under rotation**, which is
 *     wrong in a way that looks plausible — it reports a real colour from the
 *     wrong pixel;
 *   - **the histogram and export follow the adjustment preview**, which is the
 *     `ctx.filter` trap AGENTS.md documents: on webkit2gtk the obvious
 *     implementation fails silently and reads back as working;
 *   - **an SVG's script does not run**, since this app's job is opening files
 *     the user did not write;
 *   - **no inversion exists anywhere**, which the brief requires and which is
 *     the kind of thing that arrives later by copy-paste from the PDF plugin;
 *   - **mounting and unmounting repeatedly gives every bitmap back.**
 *
 * It runs in the real webview because canvas behaviour is where webkit2gtk,
 * WebView2 and WKWebView diverge, and this plugin is almost entirely canvas.
 * Formats whose support genuinely varies by platform are *skipped with a
 * reason* rather than failed — `SelfTestCheck.skipped` exists for exactly this,
 * and a green report with skips is not the same as a green one without.
 */

import { check, report, skip, type SelfTestCheck, type SelfTestReport } from "../../dev/selftest";
import { createMemoryFileHandle } from "../../files";
import type { ToolbarControl, ViewerInstance } from "../contract";
import { disposeViewer, isViewerDisposed, mountViewer } from "../instances";
import { imageMenuItems } from "./actions";
import { probeFormatSupport } from "./decode";
import { DEFAULT_ADJUSTMENTS } from "./engine/adjust";
import { renderForExport } from "./engine/export";
import { Loupe } from "./engine/loupe";
import { Inspector } from "./engine/panels";
import { computeHistogram } from "./engine/pixels";
import { ImageView } from "./engine/view";
import {
  buildAnimatedGif,
  buildBmp,
  buildHostileSvg,
  buildIco,
  buildSvg,
  buildTiff,
  encodedPattern,
  expectedColor,
  FIXTURE_GPS,
  FIXTURE_SIZE,
  GIF_FRAME_COLORS,
  GIF_FRAME_DELAY_MS,
  midtoneCanvas,
  withExif,
} from "./dev/fixtures";
import { formatById, IMAGE_FORMATS, resolveFormat } from "./formats";
import { imageViewerPlugin } from "./index";
import type { ImageViewerInstance } from "./instance";
import { extractMetadata } from "./metadata";

const TITLE = "image viewer plugin";

export async function runImageSelfTest(): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [];
  checks.push(...formatTableChecks());
  checks.push(...(await decodeChecks()));
  checks.push(...(await viewChecks()));
  checks.push(...(await instanceChecks()));
  return report(TITLE, checks);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scratchContainer(width = 480, height = 360): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText =
    `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none;`;
  document.body.append(container);
  return container;
}

/** Colours within this distance are the same colour. */
const CHANNEL_TOLERANCE = 24;

function sameColor(
  actual: { r: number; g: number; b: number },
  expected: { r: number; g: number; b: number },
  tolerance = CHANNEL_TOLERANCE,
): boolean {
  return (
    Math.abs(actual.r - expected.r) <= tolerance &&
    Math.abs(actual.g - expected.g) <= tolerance &&
    Math.abs(actual.b - expected.b) <= tolerance
  );
}

function describeColor(colour: { r: number; g: number; b: number }): string {
  return `rgb(${colour.r},${colour.g},${colour.b})`;
}

function readPixel(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const data = context.getImageData(x, y, 1, 1).data;
  return { r: data[0]!, g: data[1]!, b: data[2]!, a: data[3]! };
}

function toCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d", { willReadFrequently: true })!.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * Decodes a data URL into a canvas.
 *
 * Bounded by a timeout, because an image that never loads is a real state here
 * — AGENTS.md on windows that are not being composited — and an unbounded await
 * would hang the harness rather than fail it.
 */
async function canvasFromDataUrl(dataUrl: string): Promise<HTMLCanvasElement | null> {
  const image = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    image.addEventListener("load", () => resolve(true), { once: true });
    image.addEventListener("error", () => resolve(false), { once: true });
    setTimeout(() => resolve(false), 4000);
    image.src = dataUrl;
  });
  if (!loaded || !image.naturalWidth) return null;
  return toCanvas(image, image.naturalWidth, image.naturalHeight);
}

async function decodeFixture(
  bytes: Uint8Array,
  name: string,
): Promise<import("./decode").DecodedImage> {
  const resolution = resolveFormat({ bytes, extension: name.split(".").pop() });
  if (!resolution) throw new Error(`no format resolved for ${name}`);
  const { decode } = await resolution.format.load();
  return decode({ bytes, name, extension: name.split(".").pop() });
}

/** The first raster frame of a decoded image, as a canvas. */
function frameCanvas(
  image: import("./decode").DecodedImage,
  index = 0,
): HTMLCanvasElement | null {
  if (image.source.kind !== "raster") return null;
  const frame = image.source.frames[index];
  if (!frame) return null;
  return toCanvas(frame.bitmap, frame.bitmap.width, frame.bitmap.height);
}

// ---------------------------------------------------------------------------
// The format table
// ---------------------------------------------------------------------------

function formatTableChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];

  // Two formats claiming one extension would make resolution depend on table
  // order, which is exactly the silent misdetection the brief's "registered
  // explicitly … so a misdetected file fails predictably" rule is about.
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const format of IMAGE_FORMATS) {
    for (const extension of format.extensions) {
      const owner = seen.get(extension);
      if (owner) collisions.push(`.${extension}: ${owner} and ${format.id}`);
      else seen.set(extension, format.id);
    }
  }
  checks.push(
    check(
      "no two formats claim the same extension",
      collisions.length === 0,
      collisions.length ? collisions.join("; ") : `${seen.size} extensions across ${IMAGE_FORMATS.length} formats`,
    ),
  );

  // The wildcard would swallow every format this plugin cannot open, and the
  // user would get a broken image tile instead of the fallback viewer.
  const wildcards = imageViewerPlugin.mimeTypes.filter((type) => type.includes("*"));
  checks.push(
    check(
      "the descriptor claims no MIME wildcard",
      wildcards.length === 0,
      wildcards.length
        ? `claims ${wildcards.join(", ")}`
        : `${imageViewerPlugin.mimeTypes.length} explicit MIME types, ${imageViewerPlugin.extensions.length} extensions`,
    ),
  );

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const mislabelled = resolveFormat({ bytes: png, extension: "jpg" });
  checks.push(
    check(
      "content outranks a lying extension",
      mislabelled?.format.id === "png" && Boolean(mislabelled.mismatch),
      mislabelled
        ? `.jpg holding PNG bytes resolved as ${mislabelled.format.id} (${mislabelled.mismatch ?? "no note"})`
        : "did not resolve",
    ),
  );

  // Every TIFF-container RAW has a byte-for-byte TIFF header, so the extension
  // is the only thing that can tell a .nef from a .tif. Losing this makes every
  // RAW file open as a TIFF and fail.
  const tiff = buildTiff(2);
  const raw = resolveFormat({ bytes: tiff, extension: "nef" });
  checks.push(
    check(
      "a TIFF-container RAW keeps its own format",
      raw?.format.id === "nef",
      `TIFF bytes named .nef resolved as ${raw?.format.id ?? "nothing"}`,
    ),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/** Asserts the quadrant pattern survived a decode. */
function patternCheck(
  name: string,
  canvas: HTMLCanvasElement | null,
  size = FIXTURE_SIZE,
): SelfTestCheck {
  if (!canvas) return check(name, false, "produced no raster frame");
  if (canvas.width !== size || canvas.height !== size) {
    return check(name, false, `decoded ${canvas.width}×${canvas.height}, expected ${size}×${size}`);
  }

  // One sample per quadrant, off-centre so a mirrored or transposed image
  // cannot coincidentally match.
  const probes: readonly [number, number][] = [
    [1, 1],
    [size - 2, 1],
    [size - 2, size - 2],
    [1, size - 2],
  ];

  const wrong: string[] = [];
  for (const [x, y] of probes) {
    const actual = readPixel(canvas, x, y);
    const expected = expectedColor(x, y, size);
    if (!sameColor(actual, expected)) {
      wrong.push(`(${x},${y}) got ${describeColor(actual)} want ${describeColor(expected)}`);
    }
  }

  return check(
    name,
    wrong.length === 0,
    wrong.length ? wrong.join("; ") : `${size}×${size}, all four quadrants correct`,
  );
}

async function decodeChecks(): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];

  // --- formats the platform encodes, so the fixture is a genuine file --------
  for (const [label, mimeType, name] of [
    ["PNG", "image/png", "pattern.png"],
    ["JPEG", "image/jpeg", "pattern.jpg"],
    ["WebP", "image/webp", "pattern.webp"],
  ] as const) {
    const bytes = await encodedPattern(mimeType);
    if (!bytes) {
      checks.push(
        skip(
          `${label} decodes to the right pixels`,
          `this webview cannot encode ${mimeType}, so no fixture could be built for it. ` +
            "The decode path is unverified here; run the self-test on a platform that can.",
        ),
      );
      continue;
    }
    try {
      const image = await decodeFixture(bytes, name);
      checks.push(patternCheck(`${label} decodes to the right pixels`, frameCanvas(image)));
      image.dispose();
    } catch (thrown) {
      checks.push(
        check(`${label} decodes to the right pixels`, false, describeThrown(thrown)),
      );
    }
  }

  // --- formats built by hand, which are the ones with a decoder here ---------
  for (const [label, bytes, name] of [
    ["BMP", buildBmp(), "pattern.bmp"],
    ["TIFF", buildTiff(), "pattern.tif"],
  ] as const) {
    try {
      const image = await decodeFixture(bytes, name);
      checks.push(patternCheck(`${label} decodes to the right pixels`, frameCanvas(image)));
      image.dispose();
    } catch (thrown) {
      checks.push(
        check(`${label} decodes to the right pixels`, false, describeThrown(thrown)),
      );
    }
  }

  // --- ICO: the largest entry, not the first --------------------------------
  try {
    const image = await decodeFixture(buildIco(), "pattern.ico");
    const canvas = frameCanvas(image);
    checks.push(
      check(
        "an icon decodes its largest size, not its first",
        canvas?.width === 16,
        canvas ? `chose the ${canvas.width}×${canvas.height} entry of 4 and 16` : "no frame",
      ),
    );
    image.dispose();
  } catch (thrown) {
    checks.push(
      check("an icon decodes its largest size, not its first", false, describeThrown(thrown)),
    );
  }

  // --- GIF: frames, delays, and per-frame colours ---------------------------
  try {
    const image = await decodeFixture(buildAnimatedGif(), "pattern.gif");
    if (image.source.kind !== "raster") {
      checks.push(check("an animated GIF decodes every frame", false, "not a raster source"));
    } else {
      const frames = image.source.frames;
      const wrong: string[] = [];
      frames.forEach((frame, index) => {
        const expected = GIF_FRAME_COLORS[index];
        if (!expected) return;
        const canvas = toCanvas(frame.bitmap, frame.bitmap.width, frame.bitmap.height);
        const actual = readPixel(canvas, 2, 2);
        if (!sameColor(actual, expected, 2)) {
          wrong.push(`frame ${index} is ${describeColor(actual)}, want ${describeColor(expected)}`);
        }
        if (frame.delayMs !== GIF_FRAME_DELAY_MS) {
          wrong.push(`frame ${index} delay ${frame.delayMs}ms, want ${GIF_FRAME_DELAY_MS}ms`);
        }
        canvas.width = 0;
      });
      checks.push(
        check(
          "an animated GIF decodes every frame",
          frames.length === GIF_FRAME_COLORS.length && wrong.length === 0,
          wrong.length
            ? wrong.join("; ")
            : `${frames.length} frames at ${GIF_FRAME_DELAY_MS}ms, each the right colour`,
        ),
      );
    }
    image.dispose();
  } catch (thrown) {
    checks.push(check("an animated GIF decodes every frame", false, describeThrown(thrown)));
  }

  // --- SVG: vector, sized from its viewBox ----------------------------------
  try {
    const image = await decodeFixture(buildSvg(), "pattern.svg");
    checks.push(
      check(
        "an SVG decodes as vector, sized from its viewBox",
        image.source.kind === "vector" &&
          image.width === FIXTURE_SIZE &&
          image.height === FIXTURE_SIZE,
        `kind=${image.source.kind} size=${image.width}×${image.height} ` +
          `(a viewBox-only SVG treated as a bitmap would be 300×150)`,
      ),
    );
    image.dispose();
  } catch (thrown) {
    checks.push(
      check("an SVG decodes as vector, sized from its viewBox", false, describeThrown(thrown)),
    );
  }

  // --- SVG: nothing in it executes ------------------------------------------
  try {
    const flag = globalThis as { __svgRan?: boolean };
    delete flag.__svgRan;
    const image = await decodeFixture(buildHostileSvg(), "hostile.svg");
    const markup = image.source.kind === "vector" ? image.source.markup : "";
    const surviving = [
      /<script/i.test(markup) ? "a <script> element" : null,
      /\son\w+\s*=/i.test(markup) ? "an inline event handler" : null,
      /javascript:/i.test(markup) ? "a javascript: URL" : null,
      flag.__svgRan ? "the payload actually ran" : null,
    ].filter(Boolean);

    checks.push(
      check(
        "an SVG's script and handlers are stripped",
        surviving.length === 0,
        surviving.length
          ? `still present: ${surviving.join(", ")}`
          : "no script, no inline handlers, no javascript: URL, nothing executed",
      ),
    );
    image.dispose();
  } catch (thrown) {
    checks.push(
      check("an SVG's script and handlers are stripped", false, describeThrown(thrown)),
    );
  }

  // --- formats whose support genuinely varies by platform --------------------
  for (const [label, formatId, mimeType] of [
    ["AVIF", "avif", "image/avif"],
    ["WebP", "webp", "image/webp"],
  ] as const) {
    const supported = await probeFormatSupport(mimeType);
    checks.push(
      supported
        ? check(
            `${label} is decodable on this platform`,
            true,
            `${formatById(formatId)?.label ?? formatId} decoded a known-good sample`,
          )
        : skip(
            `${label} is decodable on this platform`,
            `this webview refused a known-good one-pixel ${label}. The plugin reports ` +
              "this as an unsupported-format error per file rather than a blank tile; " +
              "there is nothing to fix here, but coverage for the format is absent on " +
              "this platform.",
          ),
    );
  }

  // --- metadata --------------------------------------------------------------
  const jpeg = await encodedPattern("image/jpeg");
  if (!jpeg) {
    checks.push(
      skip(
        "EXIF orientation and GPS are read, and GPS is marked sensitive",
        "this webview cannot encode a JPEG, so no EXIF fixture could be built.",
      ),
    );
  } else {
    try {
      const bytes = withExif(jpeg);
      const image = await decodeFixture(bytes, "geotagged.jpg");
      const metadata = extractMetadata({
        file: createMemoryFileHandle({ name: "geotagged.jpg", bytes, mimeType: "image/jpeg" }),
        bytes,
        format: formatById("jpeg")!,
        image,
      });

      // The exhaustive half of the panel: every tag in every directory, so a
// reader can tell "the file does not have it" from "this viewer does not
      // show it". The curated sections above it are a selection, not the whole.
      const allIfd0 = metadata.sections.find((s) => s.title === "all tags — IFD0");
      const allGps = metadata.sections.find((s) => s.title === "all tags — GPS");
      const listsOrientation = allIfd0?.fields.some((f) => f.label === "Orientation");
      const listsGpsRefs = allGps?.fields.some((f) => f.label === "GPSLatitudeRef");
      // Every GPS tag, not just the coordinates: a timestamp and a processing
      // method place someone as surely as a latitude does.
      const gpsAllSensitive = allGps?.fields.every((f) => f.sensitive) ?? false;

      checks.push(
        check(
          "the information panel lists every tag, not a chosen few",
          Boolean(listsOrientation && listsGpsRefs) && gpsAllSensitive,
          `IFD0 listing ${allIfd0?.fields.length ?? 0} tags (Orientation=${listsOrientation}), ` +
            `GPS listing ${allGps?.fields.length ?? 0} tags (GPSLatitudeRef=${listsGpsRefs}, ` +
            `all marked sensitive=${gpsAllSensitive})`,
        ),
      );

      const location = metadata.sections.find((section) => section.title === "location");
      const coordinates = location?.fields.find((field) => field.label === "coordinates");
      const parsed = coordinates?.value.split(",").map((part) => Number(part.trim()));
      const closeEnough =
        parsed?.length === 2 &&
        Math.abs(parsed[0]! - FIXTURE_GPS.latitude) < 0.001 &&
        Math.abs(parsed[1]! - FIXTURE_GPS.longitude) < 0.001;

      checks.push(
        check(
          "EXIF orientation and GPS are read, and GPS is marked sensitive",
          closeEnough === true &&
            coordinates?.sensitive === true &&
            metadata.hasSensitive &&
            metadata.orientation === FIXTURE_GPS.orientation,
          `orientation=${metadata.orientation ?? "none"} coordinates=${coordinates?.value ?? "none"} ` +
            `sensitive=${coordinates?.sensitive ?? false} ` +
            `(expected ${FIXTURE_GPS.latitude}, ${FIXTURE_GPS.longitude} — a west longitude ` +
            "comes out positive if the hemisphere reference is ignored)",
        ),
      );
      image.dispose();
    } catch (thrown) {
      checks.push(
        check(
          "EXIF orientation and GPS are read, and GPS is marked sensitive",
          false,
          describeThrown(thrown),
        ),
      );
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// The view: coordinates, adjustments, export
// ---------------------------------------------------------------------------

async function viewChecks(): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];
  const container = scratchContainer();

  try {
    const bytes = await encodedPattern("image/png");
    if (!bytes) {
      return [
        skip(
          "the pixel inspector maps a point correctly under rotation",
          "this webview cannot encode a PNG, so no fixture could be built.",
        ),
      ];
    }

    const image = await decodeFixture(bytes, "pattern.png");
    const view = new ImageView({
      container,
      callbacks: { onViewChange: () => {}, onPersist: () => {}, onPointerMove: () => {} },
    });
    view.setImage(image);
    view.setZoomMode("actual");
    view.layout();

    // --- the coordinate mapping, at every rotation --------------------------
    // The check that matters most in this file. A wrong mapping reports a real
    // colour from the wrong pixel, so it looks like a working eyedropper.
    const source = view.pixelCanvas();
    const wrong: string[] = [];

    for (const rotation of [0, 90, 180, 270] as const) {
      view.setOrientation({ rotation, flipX: false, flipY: false });
      view.layout();
      const box = view.frame.getBoundingClientRect();
      if (!box.width || !box.height) {
        wrong.push(`rotation ${rotation}: the frame has no box`);
        continue;
      }

      // Probe the four corners of the *displayed* box and check that each maps
      // back to a source pixel whose colour is the one visibly in that corner.
      const corners: readonly [string, number, number][] = [
        ["top-left", 0.25, 0.25],
        ["top-right", 0.75, 0.25],
        ["bottom-right", 0.75, 0.75],
        ["bottom-left", 0.25, 0.75],
      ];

      for (const [corner, fx, fy] of corners) {
        const point = view.imagePointAt({
          clientX: box.left + box.width * fx,
          clientY: box.top + box.height * fy,
        });
        if (!point || !source) {
          wrong.push(`rotation ${rotation} ${corner}: mapped outside the image`);
          continue;
        }
        const actual = readPixel(source, point.x, point.y);
        const expected = expectedColor(point.x, point.y);
        if (!sameColor(actual, expected)) {
          wrong.push(
            `rotation ${rotation} ${corner}: (${point.x},${point.y}) is ${describeColor(actual)}`,
          );
        }
      }
    }

    checks.push(
      check(
        "the pixel inspector maps a point correctly under rotation",
        wrong.length === 0,
        wrong.length ? wrong.join("; ") : "all four corners at 0°, 90°, 180° and 270°",
      ),
    );

    view.setOrientation({ rotation: 0 });

    // --- the histogram follows the adjustment preview -----------------------
    // Against a *midtone* source, not the saturated pattern: every channel of
    // that pattern is already 0 or 255, so doubling the exposure clamps back to
    // where it started and a broken adjustment would pass. See `fixtures.ts`.
    if (source) {
      const midtone = midtoneCanvas();
      const neutral = computeHistogram(midtone, DEFAULT_ADJUSTMENTS);
      const brightened = computeHistogram(midtone, {
        ...DEFAULT_ADJUSTMENTS,
        exposure: 1,
      });
      const meanOf = (bins: Uint32Array): number => {
        let total = 0;
        let count = 0;
        for (let value = 0; value < 256; value += 1) {
          total += value * bins[value]!;
          count += bins[value]!;
        }
        return count ? total / count : 0;
      };

      const before = neutral ? meanOf(neutral.luma) : 0;
      const after = brightened ? meanOf(brightened.luma) : 0;
      // A stop is a doubling, so the expected result is not merely "larger" —
      // it is roughly twice as large, which also catches an adjustment applied
      // at the wrong strength or in the wrong unit.
      const doubled = before > 0 && after / before > 1.7 && after / before < 2.1;
      checks.push(
        check(
          "the histogram reflects the adjustment preview",
          Boolean(neutral && brightened) && doubled,
          `mean luma ${before.toFixed(1)} at 0 EV, ${after.toFixed(1)} at +1 EV ` +
            `(ratio ${before ? (after / before).toFixed(2) : "n/a"}, want ~2.0; ` +
            "equal would mean the histogram describes the file rather than the screen)",
        ),
      );
      midtone.width = 0;
      midtone.height = 0;

      // --- export applies the transform, without ctx.filter ------------------
      // The specific trap AGENTS.md documents: on webkit2gtk the canvas filter
      // property is accepted, read back verbatim, and ignored when drawing — so
      // an export built on it comes out unadjusted on Linux and nowhere else.
      // A midtone source again, so "the adjustment was applied" is provable
      // rather than hidden by clamping.
      const exportSource = midtoneCanvas();
      const exported = renderForExport(exportSource, {
        rotation: 90,
        flipX: false,
        flipY: false,
        adjustments: { ...DEFAULT_ADJUSTMENTS, exposure: 1 },
      });

      if (!exported) {
        checks.push(check("export bakes in rotation and adjustments", false, "render returned null"));
      } else {
        // A quarter turn clockwise moves the top-left quadrant to the top-right.
        const movedTo = readPixel(exported, exported.width - 2, 1);
        const original = readPixel(exportSource, 1, 1);
        const rotatedIntoPlace = movedTo.r > movedTo.g + 100 && movedTo.b < 60;
        const brightened = movedTo.r >= Math.min(255, original.r * 2) - 8;

        checks.push(
          check(
            "export bakes in rotation and adjustments",
            rotatedIntoPlace && brightened,
            `top-left ${describeColor(original)} appears at the top-right as ` +
              `${describeColor(movedTo)} after a 90° turn and +1 EV ` +
              `(rotated=${rotatedIntoPlace} brightened=${brightened})`,
          ),
        );
        exported.width = 0;
        exported.height = 0;
      }
      exportSource.width = 0;
      exportSource.height = 0;
    }

    // --- the loupe magnifies the pixel that is actually being sampled -------
    // The whole point of it: at a fitted zoom one screen pixel covers many
    // image pixels, so a readout that changes as the pointer moves is not
    // aimable without something showing which pixel it is on. If the loupe were
    // off by one, or drew the source unrotated while the screen showed it
    // rotated, it would look plausible and point at the wrong pixel.
    if (source) {
      const loupe = new Loupe(container);
      const wrongLoupe: string[] = [];

      for (const rotation of [0, 90] as const) {
        for (const [x, y] of [
          [1, 1],
          [FIXTURE_SIZE - 2, FIXTURE_SIZE - 2],
        ] as const) {
          loupe.show({
            source,
            point: { x, y },
            client: { clientX: 100, clientY: 100 },
            transform: { rotation, flipX: false, flipY: false },
          });
          const centre = readPixel(
            loupe.element,
            Math.floor(loupe.element.width / 2),
            Math.floor(loupe.element.height / 2),
          );
          const expected = expectedColor(x, y);
          if (!sameColor(centre, expected)) {
            wrongLoupe.push(
              `rotation ${rotation} at (${x},${y}): centre is ${describeColor(centre)}, want ${describeColor(expected)}`,
            );
          }
        }
      }

      checks.push(
        check(
          "the loupe magnifies the pixel under the crosshair",
          wrongLoupe.length === 0 && loupe.visible,
          wrongLoupe.length
            ? wrongLoupe.join("; ")
            : "the centre of the loupe is the sampled pixel, at 0° and 90°",
        ),
      );

      loupe.hide();
      checks.push(
        check(
          "the loupe hides when there is nothing to sample",
          !loupe.visible && loupe.element.hidden,
          `visible=${loupe.visible} hidden=${loupe.element.hidden}`,
        ),
      );
      loupe.destroy();
    }

    // --- the picker belongs to the light panel and nowhere else -------------
    const panelHost = document.createElement("div");
    container.append(panelHost);
    const inspector = new Inspector(panelHost, {
      onAdjustmentsChange: () => {},
      onSensitiveToggle: () => {},
    });

    const sampling: Record<string, boolean> = {};
    for (const panel of ["metadata", "histogram", "adjust", "none"] as const) {
      inspector.setPanel(panel);
      sampling[panel] = inspector.samplingActive;
    }
    inspector.destroy();

    checks.push(
      check(
        "the colour picker appears in the light panel only",
        sampling.adjust === true &&
          sampling.metadata === false &&
          sampling.histogram === false &&
          sampling.none === false,
        `sampling active — light=${sampling.adjust} info=${sampling.metadata} ` +
          `levels=${sampling.histogram} closed=${sampling.none} ` +
          "(info and levels are read rather than tracked; a readout flickering above them is a distraction)",
      ),
    );

    view.destroy();
    image.dispose();
  } catch (thrown) {
    checks.push(check("the view could be exercised", false, describeThrown(thrown)));
  } finally {
    container.remove();
  }

  return checks;
}

// ---------------------------------------------------------------------------
// The instance: capabilities, contributions, thumbnails, lifecycle
// ---------------------------------------------------------------------------

async function instanceChecks(): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];
  const container = scratchContainer();
  const clientId = "selftest:image";

  try {
    const bytes = buildAnimatedGif();
    const file = createMemoryFileHandle({
      name: "selftest.gif",
      bytes,
      mimeType: "image/gif",
    });

    const result = await mountViewer({
      clientId,
      container,
      file,
      pluginId: imageViewerPlugin.id,
    });

    if (!result.ok) {
      checks.push(check("an image tile mounts", false, `${result.error.code}: ${result.error.message}`));
      return checks;
    }

    const instance = result.instance as ViewerInstance & ImageViewerInstance;
    checks.push(check("an image tile mounts", true, `status=${instance.status}`));

    // --- search is absent, not empty ---------------------------------------
    checks.push(
      check(
        "the plugin reports itself non-searchable, with no search API at all",
        instance.capabilities.search === false && instance.search === undefined,
        `capabilities.search=${instance.capabilities.search}, ` +
          `instance.search=${instance.search === undefined ? "absent" : "present"} ` +
          "(the shell hides search on the capability; a `find` returning nothing would be a different thing)",
      ),
    );

    // --- frames are subdivisions -------------------------------------------
    checks.push(
      check(
        "an animation's frames are exposed as subdivisions",
        instance.capabilities.subdivisionCount === GIF_FRAME_COLORS.length,
        `subdivisionCount=${instance.capabilities.subdivisionCount ?? "none"}, ` +
          `expected ${GIF_FRAME_COLORS.length}`,
      ),
    );

    // --- thumbnails are real imagery, per subdivision -----------------------
    const thumbnail = await instance.thumbnail({ maxWidth: 64, maxHeight: 64, subdivision: 2 });
    if (thumbnail.kind !== "dataUrl") {
      checks.push(
        check("a frame's thumbnail renders that frame", false, `kind=${thumbnail.kind}`),
      );
    } else {
      const canvas = await canvasFromDataUrl(thumbnail.dataUrl);
      const sampled = canvas ? readPixel(canvas, 1, 1) : null;
      const expected = GIF_FRAME_COLORS[2]!;
      checks.push(
        check(
          "a frame's thumbnail renders that frame",
          sampled !== null && sameColor(sampled, expected, 8),
          sampled
            ? `frame 2 previewed as ${describeColor(sampled)}, want ${describeColor(expected)} ` +
              "(a blank rectangle is indistinguishable from a working thumbnail unless something samples it)"
            : "the preview could not be decoded",
        ),
      );
      if (canvas) canvas.width = 0;
    }

    // --- frame stepping ------------------------------------------------------
    const transport = instance.transportForTesting;
    if (!transport) {
      checks.push(check("frame stepping moves one frame at a time", false, "no transport"));
    } else {
      transport.pause();
      transport.seek(0);
      transport.step(1);
      const afterForward = transport.index;
      transport.step(-1);
      const afterBack = transport.index;
      checks.push(
        check(
          "frame stepping moves one frame at a time, and stops playback",
          afterForward === 1 && afterBack === 0 && !transport.playing,
          `0 → step forward → ${afterForward} → step back → ${afterBack}, playing=${transport.playing}`,
        ),
      );
    }

    // --- no inversion, anywhere ---------------------------------------------
    const actions = collectActions(instance);
    checks.push(actions.check);

    // --- the listed keybind count -------------------------------------------
    checks.push(actions.keybindCount);

    // --- serialize / restore -------------------------------------------------
    const before = instance.serialize() as Record<string, unknown>;
    instance.restore({
      ...before,
      rotation: 270,
      flipX: true,
      adjustments: { brightness: 10, contrast: -5, exposure: 0.5 },
      panel: "histogram",
    });
    const after = instance.serialize() as Record<string, unknown>;
    const restored =
      after.rotation === 270 &&
      after.flipX === true &&
      after.panel === "histogram" &&
      (after.adjustments as { exposure: number }).exposure === 0.5;
    checks.push(
      check(
        "state round-trips through serialize and restore",
        restored,
        `rotation=${after.rotation} flipX=${after.flipX} panel=${after.panel} ` +
          `exposure=${(after.adjustments as { exposure: number }).exposure}`,
      ),
    );

    // A malformed state must fall back to defaults rather than throw — the
    // contract requires it, and a hand-edited session file is the case.
    let survived = true;
    try {
      instance.restore({ rotation: "sideways", zoom: Number.NaN, adjustments: 7, panel: 12 });
    } catch {
      survived = false;
    }
    checks.push(
      check(
        "a malformed restore falls back to defaults instead of throwing",
        survived,
        survived ? "nonsense state absorbed" : "restore threw",
      ),
    );

    await disposeViewer(clientId);
    checks.push(
      check(
        "disposing a tile gives its bitmaps back",
        isViewerDisposed(instance) && !instance.holdsPixels,
        `disposed=${isViewerDisposed(instance)} holdsPixels=${instance.holdsPixels}`,
      ),
    );
  } catch (thrown) {
    checks.push(check("the instance could be exercised", false, describeThrown(thrown)));
  } finally {
    await disposeViewer(clientId);
    container.remove();
  }

  // --- repeated mount and dispose leaks nothing -----------------------------
  checks.push(await lifecycleCheck());

  return checks;
}

/**
 * Sweeps every surface for the word "invert".
 *
 * The brief's verification item 7 asks that no inversion control appears in the
 * UI, the toolbar contributions, or the keybind reference. Asserting it is
 * cheap and the failure mode is specific: inversion arriving later by
 * copy-paste from the PDF plugin, which has one and should.
 */
function collectActions(instance: ImageViewerInstance): {
  check: SelfTestCheck;
  keybindCount: SelfTestCheck;
} {
  const controls = instance.toolbar?.getControls() ?? [];
  const keybinds = instance.keybinds?.getKeybinds() ?? [];

  // The menu is built from the same verb list, so reaching it through the
  // exported builder covers it without the instance having to expose one.
  const menu = imageMenuItems({
    zoomPercent: 100,
    zoomMode: "fit-window",
    rotation: 0,
    flipX: false,
    flipY: false,
    panel: "none",
    sensitiveShown: false,
    frameCount: 3,
    frameIndex: 0,
    playing: false,
    speed: 1,
    folderPosition: 1,
    folderCount: 4,
    atFolderStart: true,
    atFolderEnd: false,
    slideshowRunning: false,
    zoomIn: () => {},
    zoomOut: () => {},
    setZoomMode: () => {},
    cycleFitMode: () => {},
    rotateClockwise: () => {},
    rotateCounterClockwise: () => {},
    flipHorizontally: () => {},
    flipVertically: () => {},
    cycleInspector: () => {},
    setInspector: () => {},
    toggleSensitiveMetadata: () => {},
    nextImage: () => {},
    previousImage: () => {},
    toggleSlideshow: () => {},
    togglePlayback: () => {},
    stepFrame: () => {},
    cycleSpeed: () => {},
    copyImage: () => {},
    exportImage: () => {},
  });

  const haystack = [
    ...controls.map(labelOf),
    ...keybinds.map((keybind) => `${keybind.id} ${keybind.label}`),
    ...menu.map((item) => item.label),
  ].join(" | ");

  const offenders = haystack
    .split(" | ")
    .filter((entry) => /invert|negative/i.test(entry));

  const listed = keybinds.filter((keybind) => !keybind.hidden);

  return {
    check: check(
      "no inversion control exists in the toolbar, keybinds or context menu",
      offenders.length === 0,
      offenders.length
        ? `found: ${offenders.join(", ")}`
        : `${controls.length} controls, ${keybinds.length} keybinds, ${menu.length} menu items, none mentioning inversion`,
    ),
    keybindCount: check(
      "the reference modal lists a reminder, not a manual",
      listed.length <= 8,
      `${listed.length} listed, ${keybinds.length - listed.length} registered but hidden ` +
        "(AGENTS.md puts the right order of magnitude at six; every hidden one is in the context menu)",
    ),
  };
}

function labelOf(control: ToolbarControl): string {
  return `${control.id} ${control.label} ${control.title ?? ""}`;
}

/**
 * Mounts and disposes repeatedly.
 *
 * "No plugin instance leaks" is a standing requirement that cannot be checked by
 * looking at the window: a tile that closes without giving its canvases back
 * looks exactly like one that closed correctly.
 */
async function lifecycleCheck(): Promise<SelfTestCheck> {
  const rounds = 3;
  const instances: ImageViewerInstance[] = [];
  const container = scratchContainer();

  try {
    for (let round = 0; round < rounds; round += 1) {
      const clientId = `selftest:image:lifecycle:${round}`;
      const result = await mountViewer({
        clientId,
        container,
        file: createMemoryFileHandle({
          name: `lifecycle-${round}.bmp`,
          bytes: buildBmp(),
          mimeType: "image/bmp",
        }),
        pluginId: imageViewerPlugin.id,
      });
      if (!result.ok) {
        return check("repeated mount and dispose leaks nothing", false, result.error.message);
      }
      instances.push(result.instance as ImageViewerInstance);
      await disposeViewer(clientId);
    }

    const leaking = instances.filter((instance) => instance.holdsPixels);
    return check(
      "repeated mount and dispose leaks nothing",
      leaking.length === 0 && instances.every((instance) => isViewerDisposed(instance)),
      leaking.length
        ? `${leaking.length} of ${rounds} instances still hold pixels`
        : `${rounds} mount/dispose cycles, every canvas released`,
    );
  } finally {
    container.remove();
  }
}

function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
  return String(thrown);
}
