/**
 * What "a decoded image" means to this plugin, and the decode paths every
 * format module builds on.
 *
 * Shared across every format, so it lives in the plugin root rather than in any
 * one format's folder (AGENTS.md: "anything shared across every format … lives
 * directly in the plugin's root"). A format module's whole job is to turn bytes
 * into a {@link DecodedImage}; everything downstream — the engine, the
 * histogram, thumbnails, export — knows only this shape and never which format
 * produced it.
 *
 * ## Two kinds of source, and why the distinction is load-bearing
 *
 * A raster image is a fixed grid of pixels: zooming past 100% shows those
 * pixels bigger, which is correct and is what the pixel inspector inspects. A
 * vector image has no pixels until something chooses a size — so it must be
 * *re-rasterized* at every zoom level rather than scaled, which is the phase
 * brief's "SVG stays crisp at 800%" requirement.
 *
 * The engine honours that by sizing the display element in CSS pixels instead
 * of applying a `transform: scale()`. A transform is composited: the browser
 * takes whatever the element already painted and stretches it, so an SVG zoomed
 * by transform blurs exactly like a JPEG. Sizing the element makes the browser
 * lay it out again, and an `<svg>` laid out at 8× re-renders its geometry at 8×.
 * That is the entire mechanism, and it is why {@link VectorSource} carries
 * markup rather than a bitmap.
 *
 * ## Probing support by using it
 *
 * Format support varies by webview and AGENTS.md is explicit that a capability
 * must be probed *by using it and measuring the result*, never by asking whether
 * an API exists. {@link probeFormatSupport} therefore decodes a real
 * few-byte sample of the format in question and checks that pixels came back.
 * `typeof ImageDecoder !== "undefined"` would have said "supported" on webviews
 * that ship the constructor and reject every AVIF handed to it.
 */

import { ViewerLoadError, type ViewerError } from "../contract";

// ---------------------------------------------------------------------------
// The decoded shape
// ---------------------------------------------------------------------------

/** One frame of a raster image. Still images have exactly one. */
export interface ImageFrame {
  /** Drawable at natural size. Owned by the {@link DecodedImage}. */
  readonly bitmap: ImageBitmap | HTMLCanvasElement;
  /** How long this frame is shown, in milliseconds. `0` for still images. */
  readonly delayMs: number;
}

export interface RasterSource {
  readonly kind: "raster";
  readonly frames: readonly ImageFrame[];
  /** `0` means loop forever, which is what most animated files ask for. */
  readonly loopCount: number;
}

export interface VectorSource {
  readonly kind: "vector";
  /** The document's own markup, rendered as an element. See the module note. */
  readonly markup: string;
}

export type ImageSource = RasterSource | VectorSource;

/**
 * The result of decoding a file, and the only thing the engine ever sees.
 *
 * `notes` is the honest-reporting channel the phase brief asks for by name: a
 * RAW file rendered from its embedded preview says so here, and the engine
 * shows it. It is not an error — the file opened — but it is a material
 * difference between what the user is looking at and what the file contains,
 * and silently showing the preview would be a lie of omission.
 */
export interface DecodedImage {
  readonly source: ImageSource;
  /** Natural size in CSS pixels. For vector, the viewBox or declared size. */
  readonly width: number;
  readonly height: number;
  /** Short human description: "8-bit RGB", "indexed, 64 colours". */
  readonly pixelFormat?: string;
  /** Caveats worth telling the user. Usually empty. */
  readonly notes: readonly string[];
  /** Releases every bitmap. Called exactly once, by the instance's `dispose`. */
  dispose(): void;
}

export interface DecodeContext {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly extension?: string;
  readonly mimeType?: string;
  readonly signal?: AbortSignal;
}

/** What a format folder exports. The only surface `formats.ts` calls. */
export type ImageDecoder = (context: DecodeContext) => Promise<DecodedImage>;

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Ceiling on decoded animation, in frames and in total pixels.
 *
 * Every frame of an animation is held as a live bitmap so that frame-stepping
 * and scrubbing are instant, which is the interaction the brief asks for. That
 * trade is right for the animations people actually open and wrong without a
 * bound: a 1200-frame 1080p GIF is 10 GB of RGBA. Past the budget the decode
 * stops and says so through `notes`, which keeps a pathological file *open and
 * usable* rather than either hanging or failing.
 */
export const MAX_ANIMATION_FRAMES = 480;
export const MAX_ANIMATION_PIXELS = 96 * 1024 * 1024;

/**
 * Ceiling on a single still image, in pixels.
 *
 * Not a memory limit — it is the point past which `createImageBitmap` starts
 * failing with no useful message on at least webkit2gtk. Refusing at a stated
 * size produces a better error than the decoder's own.
 */
export const MAX_STILL_PIXELS = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Wraps a single bitmap as a still {@link DecodedImage}. */
export function stillImage(
  bitmap: ImageBitmap | HTMLCanvasElement,
  options?: { pixelFormat?: string; notes?: readonly string[] },
): DecodedImage {
  return animatedImage([{ bitmap, delayMs: 0 }], {
    loopCount: 0,
    pixelFormat: options?.pixelFormat,
    notes: options?.notes,
  });
}

/** Wraps a frame list as an animated {@link DecodedImage}. */
export function animatedImage(
  frames: readonly ImageFrame[],
  options?: {
    loopCount?: number;
    pixelFormat?: string;
    notes?: readonly string[];
  },
): DecodedImage {
  const first = frames[0];
  if (!first) throw new Error("an image needs at least one frame");
  const { width, height } = frameSize(first.bitmap);

  let disposed = false;
  return {
    source: { kind: "raster", frames, loopCount: options?.loopCount ?? 0 },
    width,
    height,
    pixelFormat: options?.pixelFormat,
    notes: options?.notes ?? [],
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const frame of frames) releaseFrame(frame.bitmap);
    },
  };
}

/** Wraps SVG markup as a {@link DecodedImage}. */
export function vectorImage(
  markup: string,
  size: { width: number; height: number },
  options?: { notes?: readonly string[] },
): DecodedImage {
  return {
    source: { kind: "vector", markup },
    width: size.width,
    height: size.height,
    pixelFormat: "vector",
    notes: options?.notes ?? [],
    // Nothing to release: the markup is a string and the element that renders
    // it belongs to the engine, which removes it with the rest of the tile.
    dispose() {},
  };
}

export function frameSize(bitmap: ImageBitmap | HTMLCanvasElement): {
  width: number;
  height: number;
} {
  return { width: bitmap.width, height: bitmap.height };
}

export function releaseFrame(bitmap: ImageBitmap | HTMLCanvasElement): void {
  if (typeof ImageBitmap !== "undefined" && bitmap instanceof ImageBitmap) {
    bitmap.close();
    return;
  }
  // A canvas is released by zeroing it; dropping the reference alone leaves the
  // backing store alive until the next GC, which for a page of decoded frames
  // is long enough to matter.
  const canvas = bitmap as HTMLCanvasElement;
  canvas.width = 0;
  canvas.height = 0;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * A decode failure described in the contract's vocabulary.
 *
 * Every format module funnels its failures through here so a tile always gets a
 * sentence naming *the format and what was wrong with it*, rather than whatever
 * the underlying decoder happened to throw. The brief calls for "a clear
 * per-file error state rather than a blank or crashed tile", and "The operation
 * is insecure" — webkit2gtk's message for an unsupported `createImageBitmap` —
 * is not that.
 */
export function decodeFailure(
  context: DecodeContext,
  reason: string,
  options?: { code?: ViewerError["code"]; detail?: string; recoverable?: boolean },
): ViewerError {
  return {
    code: options?.code ?? "corrupt",
    message: `${context.name}: ${reason}`,
    detail: options?.detail,
    recoverable: options?.recoverable ?? false,
  };
}

// ---------------------------------------------------------------------------
// Native decode paths
// ---------------------------------------------------------------------------

function blobOf(context: DecodeContext, mimeType: string): Blob {
  // A fresh view, because `Blob` keeps a reference to the buffer and the
  // `FileHandle` memoizes those same bytes for the metadata and export paths.
  return new Blob([context.bytes.slice() as BlobPart], { type: mimeType });
}

/** The throwable form of {@link decodeFailure}, which is what `mount` expects. */
export function decodeError(
  context: DecodeContext,
  reason: string,
  options?: { code?: ViewerError["code"]; detail?: string; recoverable?: boolean },
): ViewerLoadError {
  return new ViewerLoadError(decodeFailure(context, reason, options));
}

/**
 * The webview's own decoder, via `createImageBitmap`.
 *
 * The preferred path for every format the platform handles: it decodes off the
 * main thread, produces a GPU-friendly bitmap, and is the only route that gets
 * hardware decode for JPEG.
 *
 * `imageOrientation: "from-image"` is passed explicitly rather than relied on.
 * It is the specified default *now*, but it was `"none"` when the API shipped,
 * and the difference is a phone photo displayed on its side — a bug that looks
 * like a broken viewer and is invisible on any image without an EXIF orientation
 * tag. The `<img>` path below gets the same behaviour from CSS
 * `image-orientation: from-image`, which is the default and not overridden
 * anywhere in this app's stylesheets.
 */
export async function decodeViaImageBitmap(
  context: DecodeContext,
  mimeType: string,
): Promise<ImageBitmap | null> {
  try {
    const bitmap = await createImageBitmap(blobOf(context, mimeType), {
      imageOrientation: "from-image",
    });
    context.signal?.throwIfAborted();
    if (!bitmap.width || !bitmap.height) {
      bitmap.close();
      return null;
    }
    return bitmap;
  } catch {
    return null;
  }
}

/**
 * The webview's decoder again, but through an `<img>` element.
 *
 * Not redundant with {@link decodeViaImageBitmap}: the two use *different*
 * decoder registrations in every engine. WebKit decodes TIFF and HEIC in an
 * `<img>` on macOS while `createImageBitmap` on the same bytes rejects, and
 * `<img>` is also the only path that renders an ICO by picking a size. So this
 * is the second thing to try, not a fallback for old browsers.
 *
 * Bounded by a timeout because a decode that neither loads nor errors is a real
 * state here — see AGENTS.md on windows that are not being composited — and an
 * unbounded await on it would hang the tile rather than fail it.
 */
export async function decodeViaImageElement(
  context: DecodeContext,
  mimeType: string,
  timeoutMs = 15000,
): Promise<HTMLCanvasElement | null> {
  const url = URL.createObjectURL(blobOf(context, mimeType));
  const image = new Image();
  image.decoding = "sync";

  try {
    const loaded = await new Promise<boolean>((resolve) => {
      const settle = (ok: boolean): void => resolve(ok);
      image.addEventListener("load", () => settle(true), { once: true });
      image.addEventListener("error", () => settle(false), { once: true });
      context.signal?.addEventListener("abort", () => settle(false), { once: true });
      setTimeout(() => settle(false), timeoutMs);
      image.src = url;
    });

    if (!loaded) return null;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context2d = canvas.getContext("2d", { willReadFrequently: true });
    if (!context2d) return null;
    context2d.drawImage(image, 0, 0);
    return canvas;
  } catch {
    return null;
  } finally {
    image.src = "";
    URL.revokeObjectURL(url);
  }
}

/**
 * Both native paths in order, for the formats the platform is expected to
 * handle. Returns `null` when neither works, which is the caller's cue to try
 * a format-specific decoder or report an unsupported-here error.
 */
export async function decodeNatively(
  context: DecodeContext,
  mimeType: string,
): Promise<ImageBitmap | HTMLCanvasElement | null> {
  return (
    (await decodeViaImageBitmap(context, mimeType)) ??
    (await decodeViaImageElement(context, mimeType))
  );
}

// ---------------------------------------------------------------------------
// Frame-accurate animation, where the platform offers it
// ---------------------------------------------------------------------------

interface ImageDecoderTrack {
  readonly frameCount: number;
  readonly repetitionCount: number;
}

interface ImageDecoderLike {
  readonly tracks: {
    ready: Promise<void>;
    readonly selectedTrack: ImageDecoderTrack | null;
  };
  readonly completed: Promise<void>;
  decode(options: { frameIndex: number }): Promise<{
    image: CanvasImageSource & { displayWidth: number; displayHeight: number; duration: number | null; close(): void };
  }>;
  close(): void;
}

/**
 * WebCodecs' `ImageDecoder`, used for animation the platform can take apart.
 *
 * Present in Chromium (so WebView2) and absent in WebKit at the floor this app
 * targets, which is exactly the "detect support at runtime" case AGENTS.md
 * describes. Callers must have a still-image path for when this returns `null`
 * — a webview that cannot enumerate an animated WebP's frames can still decode
 * its first one, and a static image with a note beats a failed tile.
 *
 * GIF deliberately does *not* come through here even where it exists, because
 * the plugin's own GIF decoder works on all three platforms and one behaviour
 * everywhere is worth more than a marginally faster path on one.
 */
export async function decodeFramesViaImageDecoder(
  context: DecodeContext,
  mimeType: string,
): Promise<{ frames: ImageFrame[]; loopCount: number; truncated: boolean } | null> {
  const Ctor = (globalThis as { ImageDecoder?: new (init: unknown) => ImageDecoderLike })
    .ImageDecoder;
  if (!Ctor) return null;

  let decoder: ImageDecoderLike | null = null;
  const frames: ImageFrame[] = [];
  let pixels = 0;
  let truncated = false;

  try {
    decoder = new Ctor({ data: context.bytes.slice(), type: mimeType });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount < 1) return null;

    const wanted = Math.min(track.frameCount, MAX_ANIMATION_FRAMES);
    truncated = wanted < track.frameCount;

    for (let index = 0; index < wanted; index += 1) {
      context.signal?.throwIfAborted();
      const { image } = await decoder.decode({ frameIndex: index });
      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.displayWidth;
        canvas.height = image.displayHeight;
        const context2d = canvas.getContext("2d");
        if (!context2d) throw new Error("2d canvas context unavailable");
        context2d.drawImage(image, 0, 0);
        frames.push({
          // `duration` is microseconds. A frame with no stated duration is not
          // a still: browsers treat it as the same ~100ms default that a GIF
          // with a zero delay gets, and so does the transport.
          bitmap: canvas,
          delayMs: image.duration ? image.duration / 1000 : 100,
        });
        pixels += canvas.width * canvas.height;
      } finally {
        image.close();
      }
      if (pixels > MAX_ANIMATION_PIXELS) {
        truncated = true;
        break;
      }
    }

    if (frames.length === 0) return null;
    return {
      frames,
      loopCount: track.repetitionCount === Infinity ? 0 : track.repetitionCount,
      truncated,
    };
  } catch {
    for (const frame of frames) releaseFrame(frame.bitmap);
    return null;
  } finally {
    try {
      decoder?.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime support probes
// ---------------------------------------------------------------------------

/**
 * Minimal valid files, used to ask the webview what it can actually decode.
 *
 * Each is the smallest well-formed image of its format that a decoder will
 * accept, so a successful decode proves the format is supported and a failure
 * proves it is not. That is the "probe by using it" rule from AGENTS.md applied
 * to format support: a capability list would claim AVIF works on a webkit2gtk
 * build with no AV1 decoder, and the user would get a blank tile.
 */
const PROBE_SAMPLES: Readonly<Record<string, string>> = {
  // 1x1 AVIF.
  "image/avif":
    "AAAAHGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZgAAAPJtZXRhAAAAAAAAAChoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAbGliYXZpZgAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAEWAAAAGgAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAOcGl4aQAAAAABCAAAAAxhdjFDgQAMAAAAABNjb2xybmNseAABAA0ABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAAB9tZGF0EgAKBhgADlgIIGkyCR/wAABAAABZ8g==",
  // 1x1 WebP (lossy).
  "image/webp":
    "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=",
  // 8x8 grayscale TIFF, uncompressed.
  "image/tiff":
    "SUkqAAgAAAAIAP4ABAABAAAAAAAAAAABBAABAAAACAAAAAEBBAABAAAACAAAAAIBAwABAAAACAAAAAMBAwABAAAAAQAAAAYBAwABAAAAAQAAABEBBAABAAAAmgAAABcBBAABAAAAQAAAAAAAAAA=",
};

const probeResults = new Map<string, Promise<boolean>>();

/**
 * Whether this webview can decode a MIME type, established by decoding one.
 *
 * Memoized per type: the answer cannot change within a session, and the probe
 * costs a decode. Types with no sample registered are reported as supported,
 * because the caller has a real file to try and a probe that cannot run must
 * not stand in the way of one that can.
 */
export function probeFormatSupport(mimeType: string): Promise<boolean> {
  const cached = probeResults.get(mimeType);
  if (cached) return cached;

  const sample = PROBE_SAMPLES[mimeType];
  const result = sample
    ? (async () => {
        try {
          const bytes = base64ToBytes(sample);
          const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mimeType }));
          const ok = bitmap.width > 0 && bitmap.height > 0;
          bitmap.close();
          return ok;
        } catch {
          return false;
        }
      })()
    : Promise.resolve(true);

  probeResults.set(mimeType, result);
  return result;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
