/**
 * GIF, decoded here rather than by the platform.
 *
 * Every webview animates a GIF in an `<img>`, and none of them let you pause,
 * step or slow one. The phase brief requires "play/pause, frame-step, and speed
 * control for animated GIF/WebP", and there is no route to that except having
 * the frames. `ImageDecoder` would provide them on Chromium only; a decoder here
 * provides them on all three platforms, which is worth more than a marginally
 * faster path on one — so unlike every other raster format in this plugin, GIF
 * does not try the native decoder at all.
 *
 * ## Frames are composed, not stored
 *
 * A GIF frame is a *patch*: a sub-rectangle, drawn over what the previous frame
 * left behind, according to that frame's disposal method. Decoding each patch
 * on its own and showing it would produce the well-known result where an
 * animation plays as a sequence of fragments on a transparent background.
 *
 * So each decoded patch is composited onto a running canvas, and a *copy* of
 * that canvas becomes the frame. That is what makes frame-stepping and the
 * scrubber work: any frame can be shown instantly without replaying the
 * animation from the start, which the patch representation would require.
 *
 * The three disposal methods are handled where the spec puts them — *before*
 * drawing the next frame, applying to the region the previous frame occupied:
 *
 *   - `0`/`1` (unspecified / do not dispose): leave the canvas alone.
 *   - `2` (restore to background): clear the previous frame's rectangle.
 *   - `3` (restore to previous): put back what was there before it was drawn.
 *     Only this one needs a saved copy, and only for as long as one frame.
 */

import { ByteReader } from "../binary";
import {
  animatedImage,
  decodeError,
  MAX_ANIMATION_FRAMES,
  MAX_ANIMATION_PIXELS,
  stillImage,
  type DecodeContext,
  type DecodedImage,
  type ImageFrame,
} from "../decode";
import { lzwDecode } from "./lzw";

/**
 * What a zero or one-hundredth-of-a-second delay is shown as.
 *
 * Files claiming 0 or 10ms per frame are extremely common — encoders write "as
 * fast as possible" that way — and playing them literally produces a strobe
 * nobody intended. Every browser clamps to about this value, so matching them is
 * what makes an animation here look like the same animation elsewhere.
 */
const MIN_DELAY_MS = 20;
const DEFAULT_DELAY_MS = 100;

/** Rows of an interlaced GIF arrive in four passes with these starts and steps. */
const INTERLACE_PASSES: readonly (readonly [start: number, step: number])[] = [
  [0, 8],
  [4, 8],
  [2, 4],
  [1, 2],
];

interface GifFrameSpec {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly interlaced: boolean;
  readonly palette: Uint8Array;
  readonly transparentIndex: number;
  readonly disposal: number;
  readonly delayMs: number;
  readonly minCodeSize: number;
  readonly data: Uint8Array;
}

interface GifFile {
  readonly width: number;
  readonly height: number;
  readonly globalPalette: Uint8Array;
  readonly backgroundIndex: number;
  readonly loopCount: number;
  readonly frames: readonly GifFrameSpec[];
  readonly truncated: boolean;
}

/** Concatenates the data sub-blocks that follow a marker into one buffer. */
function readSubBlocks(reader: ByteReader): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const size = reader.u8();
    if (size === 0) break;
    const part = reader.slice(size);
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readPalette(reader: ByteReader, entries: number): Uint8Array {
  return reader.slice(entries * 3).slice();
}

function parse(bytes: Uint8Array): GifFile {
  const reader = new ByteReader(bytes, { littleEndian: true, offset: 6 });

  const width = reader.u16();
  const height = reader.u16();
  const packed = reader.u8();
  const backgroundIndex = reader.u8();
  reader.skip(1); // pixel aspect ratio, ignored by every renderer

  const globalPalette =
    packed & 0x80 ? readPalette(reader, 1 << ((packed & 0x07) + 1)) : new Uint8Array(0);

  const frames: GifFrameSpec[] = [];
  let loopCount = 0;
  let truncated = false;

  // Graphic control state applies to the *next* image descriptor, so it is
  // carried rather than attached.
  let pendingDelay = DEFAULT_DELAY_MS;
  let pendingDisposal = 0;
  let pendingTransparent = -1;

  try {
    parsing: for (;;) {
      const marker = reader.u8();

      switch (marker) {
        case 0x21: {
          const label = reader.u8();
          if (label === 0xf9) {
            const size = reader.u8();
            const flags = reader.u8();
            const rawDelay = reader.u16() * 10;
            const transparentIndex = reader.u8();
            reader.skip(Math.max(0, size - 4) + 1); // any extra bytes, then the terminator
            pendingDisposal = (flags >> 2) & 0x07;
            pendingTransparent = flags & 0x01 ? transparentIndex : -1;
            pendingDelay = rawDelay < MIN_DELAY_MS ? DEFAULT_DELAY_MS : rawDelay;
          } else if (label === 0xff) {
            const size = reader.u8();
            const identifier = reader.ascii(size);
            const payload = readSubBlocks(reader);
            // NETSCAPE2.0's sub-block is `[1, loopLow, loopHigh]`.
            if (identifier.startsWith("NETSCAPE") && payload.length >= 3 && payload[0] === 1) {
              loopCount = payload[1]! | (payload[2]! << 8);
            }
          } else {
            reader.skip(1);
            readSubBlocks(reader);
          }
          break;
        }

        case 0x2c: {
          const left = reader.u16();
          const top = reader.u16();
          const frameWidth = reader.u16();
          const frameHeight = reader.u16();
          const frameFlags = reader.u8();
          const palette =
            frameFlags & 0x80
              ? readPalette(reader, 1 << ((frameFlags & 0x07) + 1))
              : globalPalette;
          const minCodeSize = reader.u8();
          const data = readSubBlocks(reader);

          frames.push({
            left,
            top,
            width: frameWidth,
            height: frameHeight,
            interlaced: (frameFlags & 0x40) !== 0,
            palette,
            transparentIndex: pendingTransparent,
            disposal: pendingDisposal,
            delayMs: pendingDelay,
            minCodeSize,
            data,
          });

          pendingDelay = DEFAULT_DELAY_MS;
          pendingDisposal = 0;
          pendingTransparent = -1;

          if (frames.length >= MAX_ANIMATION_FRAMES) {
            truncated = true;
            break parsing;
          }
          break;
        }

        case 0x3b:
          break parsing;

        default:
          // A byte that is none of the three block markers means the stream has
          // desynchronized. Everything already parsed is still good.
          truncated = true;
          break parsing;
      }
    }
  } catch {
    // A read past the end: a truncated file, which is the common damaged GIF.
    truncated = true;
  }

  return { width, height, globalPalette, backgroundIndex, loopCount, frames, truncated };
}

/** Expands one frame's indices into its own RGBA patch. */
function patchFor(spec: GifFrameSpec): ImageData | null {
  const pixels = spec.width * spec.height;
  if (pixels <= 0) return null;

  const indices = lzwDecode(spec.data, spec.minCodeSize, pixels);
  const patch = new ImageData(spec.width, spec.height);
  const out = patch.data;
  const palette = spec.palette;

  const write = (sourceRow: number, targetRow: number): void => {
    for (let x = 0; x < spec.width; x += 1) {
      const index = indices[sourceRow * spec.width + x]!;
      const target = (targetRow * spec.width + x) * 4;
      if (index === spec.transparentIndex) continue; // leaves RGBA at 0,0,0,0
      out[target] = palette[index * 3] ?? 0;
      out[target + 1] = palette[index * 3 + 1] ?? 0;
      out[target + 2] = palette[index * 3 + 2] ?? 0;
      out[target + 3] = 255;
    }
  };

  if (spec.interlaced) {
    let sourceRow = 0;
    for (const [start, step] of INTERLACE_PASSES) {
      for (let y = start; y < spec.height; y += step) {
        write(sourceRow, y);
        sourceRow += 1;
      }
    }
  } else {
    for (let y = 0; y < spec.height; y += 1) write(y, y);
  }

  return patch;
}

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  const file = parse(context.bytes);

  if (file.frames.length === 0 || !file.width || !file.height) {
    throw decodeError(context, "contains no readable image data.", {
      detail: `${file.width}×${file.height}, ${file.frames.length} frame(s) parsed`,
    });
  }

  // The running canvas the frames are composed onto, and a scratch canvas for
  // turning each patch into something drawable.
  const stage = newCanvas(file.width, file.height);
  const stageContext = stage.getContext("2d", { willReadFrequently: true });
  const patchCanvas = newCanvas(1, 1);
  const patchContext = patchCanvas.getContext("2d");
  if (!stageContext || !patchContext) {
    throw decodeError(context, "could not be composed — no 2d canvas is available.", {
      code: "internal",
    });
  }

  const frames: ImageFrame[] = [];
  let pixels = 0;
  let truncated = file.truncated;

  for (const spec of file.frames) {
    context.signal?.throwIfAborted();

    // Disposal is applied before this frame is drawn and describes the *previous*
    // frame's region — hence the snapshot taken below rather than here.
    let restore: ImageData | null = null;
    if (spec.disposal === 3) {
      restore = stageContext.getImageData(spec.left, spec.top, spec.width, spec.height);
    }

    const patch = patchFor(spec);
    if (patch) {
      patchCanvas.width = spec.width;
      patchCanvas.height = spec.height;
      patchContext.putImageData(patch, 0, 0);
      // `drawImage`, not `putImageData`: the latter replaces the destination
      // pixels outright, so a frame's transparent areas would punch holes in
      // everything underneath it instead of letting it show through.
      stageContext.drawImage(patchCanvas, spec.left, spec.top);
    }

    const composed = newCanvas(file.width, file.height);
    composed.getContext("2d")?.drawImage(stage, 0, 0);
    frames.push({ bitmap: composed, delayMs: spec.delayMs });
    pixels += file.width * file.height;

    if (spec.disposal === 2) {
      stageContext.clearRect(spec.left, spec.top, spec.width, spec.height);
    } else if (spec.disposal === 3 && restore) {
      stageContext.putImageData(restore, spec.left, spec.top);
    }

    if (pixels > MAX_ANIMATION_PIXELS) {
      truncated = true;
      break;
    }
  }

  stage.width = 0;
  stage.height = 0;
  patchCanvas.width = 0;
  patchCanvas.height = 0;

  const notes: string[] = [];
  if (truncated) {
    notes.push(
      frames.length < file.frames.length || file.truncated
        ? `this file is truncated or oversized — ${frames.length} frame(s) were recovered.`
        : "the animation was cut short at this viewer's frame budget.",
    );
  }

  const colours = file.globalPalette.length / 3;
  const pixelFormat = `indexed${colours ? `, ${colours} colours` : ""}`;

  if (frames.length === 1) {
    return stillImage(frames[0]!.bitmap, { pixelFormat, notes });
  }

  return animatedImage(frames, {
    loopCount: file.loopCount,
    pixelFormat,
    notes,
  });
}
