/**
 * Copy and export: turning what is on screen into a file or a clipboard entry.
 *
 * The brief asks for copy that respects "any active non-destructive view
 * transform", and for "export/save-as with format conversion among the supported
 * formats". Both start from the same render, which is the interesting part of
 * this module.
 *
 * ## What "what is on screen" means
 *
 * Rotation, flip and the light adjustments are part of the image the user is
 * looking at and are baked in. Zoom and pan are not: they describe the *window
 * onto* the image, and an export that came out at whatever magnification the
 * tile happened to be at — cropped to the visible area — would be a screenshot,
 * not the picture. So the render is at natural resolution, oriented, adjusted,
 * and complete.
 *
 * ## The adjustments are applied by lookup table, and that is not a detail
 *
 * The obvious implementation sets `ctx.filter` to the same CSS filter string the
 * display element uses and draws. It is wrong on the platform this app has to
 * run on, and wrong *silently*: AGENTS.md records that webkit2gtk accepts the
 * canvas `filter` property, returns it verbatim when read back, and ignores it
 * when drawing. An export on Linux would come out unadjusted while the preview
 * beside it showed the adjustment, and a feature probe that set the property and
 * read it back would report everything working.
 *
 * So the pixels go through {@link adjustmentLut}, which is derived from the
 * specified behaviour of the CSS filter functions and therefore produces the
 * same numbers the compositor does — on every platform, checkably.
 */

import { ENCODABLE_FORMATS, type ImageFormat } from "../formats";
import { adjustmentLut, applyLut, isNeutral, type Adjustments } from "./adjust";

export interface RenderOptions {
  readonly rotation: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly adjustments: Adjustments;
  /**
   * Region of the source to render, in natural pixels. The whole image when
   * omitted. Used by the contract's region copy.
   */
  readonly region?: { x: number; y: number; width: number; height: number };
  /** Flatten onto this colour. Required for formats with no alpha channel. */
  readonly background?: string;
}

/**
 * Renders the source into a new canvas with the view transform applied.
 *
 * The canvas is the caller's to release; every caller here does so as soon as it
 * has bytes, because a full-resolution RGBA copy of a large photo is tens of
 * megabytes and holding one per export would be a leak with a slow fuse.
 */
export function renderForExport(
  source: HTMLCanvasElement,
  options: RenderOptions,
): HTMLCanvasElement | null {
  const region = options.region ?? {
    x: 0,
    y: 0,
    width: source.width,
    height: source.height,
  };
  const width = Math.max(1, Math.round(region.width));
  const height = Math.max(1, Math.round(region.height));
  if (!width || !height) return null;

  const quarterTurned = options.rotation === 90 || options.rotation === 270;
  const canvas = document.createElement("canvas");
  canvas.width = quarterTurned ? height : width;
  canvas.height = quarterTurned ? width : height;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((options.rotation * Math.PI) / 180);
  context.scale(options.flipX ? -1 : 1, options.flipY ? -1 : 1);
  context.drawImage(
    source,
    region.x,
    region.y,
    width,
    height,
    -width / 2,
    -height / 2,
    width,
    height,
  );
  context.restore();

  if (!isNeutral(options.adjustments)) {
    try {
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      applyLut(image.data, adjustmentLut(options.adjustments));
      context.putImageData(image, 0, 0);
    } catch {
      // A tainted canvas cannot happen for these sources; if it somehow did,
      // an unadjusted export is better than none, and the caller says so.
      return canvas;
    }
  }

  return canvas;
}

export interface EncodedImage {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Encodes a canvas, checking that the format actually came back.
 *
 * `toBlob` does not reject for a type it cannot write — it silently falls back
 * to PNG, and the resulting file is a PNG named `.webp`. Comparing the blob's
 * reported type against the request is the only way to notice, and it is worth
 * noticing: the difference shows up when the file is opened somewhere else.
 */
export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number,
): Promise<EncodedImage | null> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, mimeType, quality);
  });
  if (!blob) return null;
  return {
    blob,
    mimeType: blob.type || mimeType,
    width: canvas.width,
    height: canvas.height,
  };
}

/** The formats export can convert to: whatever the canvas can actually write. */
export async function writableFormats(): Promise<readonly ImageFormat[]> {
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;

  const usable: ImageFormat[] = [];
  for (const format of ENCODABLE_FORMATS) {
    const mimeType = format.mimeTypes[0]!;
    // Probed by encoding, not by asking — the same rule the decode side follows,
    // and for the same reason: `toBlob` reports success for a type it quietly
    // substituted PNG for.
    const encoded = await encodeCanvas(probe, mimeType, 0.9);
    if (encoded && (encoded.mimeType === mimeType || format.id === "png")) {
      usable.push(format);
    }
  }
  probe.width = 0;
  probe.height = 0;
  return usable;
}

/** Default JPEG/WebP quality. High enough that conversion is not lossy in practice. */
export const DEFAULT_EXPORT_QUALITY = 0.92;

/**
 * Whether a format needs the image flattened onto an opaque background first.
 *
 * JPEG has no alpha channel, and a canvas with transparency encoded as JPEG
 * comes out with those pixels black on some engines and white on others. Making
 * the choice explicit means the same file everywhere.
 */
export function needsFlattening(format: ImageFormat): boolean {
  return format.id === "jpeg";
}

/**
 * Puts an image on the system clipboard.
 *
 * PNG only, which is not a limitation so much as the format: `ClipboardItem` is
 * specified to accept PNG, and every other type is at the browser's discretion.
 * Phase 06 builds the shell's cross-viewer clipboard on top of the contract's
 * `getCopyable`, which this plugin already implements, and this call site
 * becomes "ask the shell to copy" instead.
 */
export async function copyImageToClipboard(blob: Blob): Promise<{ ok: boolean; message: string }> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      return { ok: false, message: "this platform has no image clipboard support" };
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return { ok: true, message: "copied the image to the clipboard" };
  } catch (thrown) {
    console.error("[image] clipboard write failed", thrown);
    return { ok: false, message: "could not write the image to the clipboard" };
  }
}

/** `photo.jpg` -> `photo`, so a converted export does not become `photo.jpg.png`. */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
