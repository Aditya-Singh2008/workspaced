/**
 * Frame capture: the picture on screen right now, as an image.
 *
 * The brief asks for "frame capture (export current frame as image, reusing
 * Phase 4a's image export path)", and the second half is the point. Encoding a
 * canvas, checking that the format actually came back rather than a silently
 * substituted PNG, flattening for formats without an alpha channel, listing the
 * formats this platform can really write, and putting an image on the system
 * clipboard are all solved in `viewers/image/engine/export.ts` — and they were
 * solved there against specific webview behaviour that is documented in that
 * file. A second implementation here would be a second place for the `toBlob`
 * fallback to go unnoticed.
 *
 * ## Importing another plugin, and why that is not a layering violation
 *
 * AGENTS.md's rule is that plugins never import *shell* modules, so that the
 * shell can be changed without touching them and so that a plugin cannot reach
 * around the contract. `image/engine/export.ts` is neither: it is leaf code with
 * no shell dependency, no plugin state and no DOM ownership — a canvas goes in
 * and bytes come out. The import is dynamic, so a session that watches a video
 * and never captures a frame does not parse the image plugin's encode path.
 *
 * ## The capture is the decoded frame, not the tile
 *
 * At the media's own resolution, without the scale mode, the letterboxing or the
 * captions. Someone capturing a frame wants the frame — a screenshot of the tile
 * is what a screenshot tool is for, and one taken at whatever size the tile
 * happened to be would be useless for the delivery checks this plugin exists to
 * support.
 */

/** A grabbed frame and where it came from. The canvas is the caller's to free. */
export interface CapturedFrame {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly atMs: number;
}

/**
 * Draws the frame currently displayed into a new canvas.
 *
 * `null` when there is nothing to draw — before metadata arrives, for an
 * audio-only file, or when the engine refuses to hand the frame to a canvas.
 * That last case is real: some hardware decode paths produce a protected
 * surface, and `drawImage` throws a `SecurityError` rather than returning black.
 * Every caller turns `null` into a message, because a capture that silently
 * produced a blank image would be worse than one that said it could not.
 */
export function captureFrame(video: HTMLVideoElement): CapturedFrame | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) return null;

  try {
    context.drawImage(video, 0, 0, width, height);
  } catch {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }

  return { canvas, width, height, atMs: video.currentTime * 1000 };
}

/** Frees a captured frame's backing store. Canvases are not small. */
export function releaseFrame(frame: CapturedFrame): void {
  frame.canvas.width = 0;
  frame.canvas.height = 0;
}

/**
 * A frame as PNG bytes, for the contract's `getCopyable`.
 *
 * PNG rather than a lossy format because a copied frame is usually going
 * somewhere it will be looked at closely, and because `ClipboardItem` is only
 * specified to accept PNG anyway.
 */
export async function frameToPng(frame: CapturedFrame): Promise<{
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
} | null> {
  const { encodeCanvas } = await import("../../image/engine/export");
  const encoded = await encodeCanvas(frame.canvas, "image/png");
  if (!encoded) return null;
  return {
    blob: encoded.blob,
    mimeType: encoded.mimeType,
    width: encoded.width,
    height: encoded.height,
  };
}

/** Puts a frame on the system clipboard. The message is meant to be shown. */
export async function copyFrame(frame: CapturedFrame): Promise<{ ok: boolean; message: string }> {
  const png = await frameToPng(frame);
  if (!png) return { ok: false, message: "the frame could not be encoded" };

  const { copyImageToClipboard } = await import("../../image/engine/export");
  return copyImageToClipboard(png.blob);
}

/**
 * Saves a frame through the native save dialog.
 *
 * The format follows the extension the user types, exactly as the image
 * plugin's export does — and for the same reason, that a format picker beside a
 * dialog which already has one is a second control for one decision. The
 * default name carries the timecode, so capturing four frames from one film
 * produces four distinguishable files instead of three overwrite prompts.
 */
export async function saveFrame(
  frame: CapturedFrame,
  options: { baseName: string; timecode: string },
): Promise<{ ok: boolean; message: string }> {
  const {
    DEFAULT_EXPORT_QUALITY,
    encodeCanvas,
    needsFlattening,
    writableFormats,
  } = await import("../../image/engine/export");

  const formats = await writableFormats();
  if (formats.length === 0) {
    return { ok: false, message: "this platform cannot encode any image format" };
  }

  // PNG first when it is available: a captured frame is a still of compressed
  // video, and re-compressing it lossily by default adds a second generation of
  // artefacts to something being looked at *for* its artefacts.
  const preferred = formats.find((format) => format.id === "png") ?? formats[0]!;
  // `:` is legal in a filename on Linux and not on Windows, and a timecode is
  // full of them.
  const stamp = options.timecode.replace(/[:.]/g, "-");

  const { saveFileViaDialog, writeFileBytes } = await import("../../../files");
  const path = await saveFileViaDialog({
    defaultName: `${options.baseName}-${stamp}.${preferred.extensions[0]}`,
    filters: formats.map((format) => ({
      name: format.label,
      extensions: [...format.extensions],
    })),
  });
  if (!path) return { ok: false, message: "" };

  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const target =
    formats.find((format) => format.extensions.includes(extension)) ?? preferred;

  // JPEG has no alpha channel, so a transparent pixel encodes as black on some
  // engines and white on others. A decoded video frame is opaque, which makes
  // this a no-op today — and the flattening stays because a format's need for a
  // background is a property of the format, not of what happens to be in it.
  const source = needsFlattening(target) ? flatten(frame.canvas, "#000000") : frame.canvas;

  try {
    const encoded = await encodeCanvas(
      source,
      target.mimeTypes[0]!,
      target.id === "png" ? undefined : DEFAULT_EXPORT_QUALITY,
    );
    if (!encoded) {
      return { ok: false, message: `this platform cannot write ${target.label}` };
    }
    await writeFileBytes(path, new Uint8Array(await encoded.blob.arrayBuffer()));
    return {
      ok: true,
      message: `captured ${encoded.width}×${encoded.height} as ${target.label}`,
    };
  } catch (thrown) {
    console.error("[video] frame export failed", thrown);
    return {
      ok: false,
      message: thrown instanceof Error ? `capture failed: ${thrown.message}` : "capture failed",
    };
  } finally {
    if (source !== frame.canvas) {
      source.width = 0;
      source.height = 0;
    }
  }
}

/** A copy of a canvas over an opaque background. */
function flatten(canvas: HTMLCanvasElement, background: string): HTMLCanvasElement {
  const flat = document.createElement("canvas");
  flat.width = canvas.width;
  flat.height = canvas.height;
  const context = flat.getContext("2d");
  if (!context) return canvas;
  context.fillStyle = background;
  context.fillRect(0, 0, flat.width, flat.height);
  context.drawImage(canvas, 0, 0);
  return flat;
}
