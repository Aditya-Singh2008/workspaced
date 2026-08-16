/**
 * PNG, including the animated variant (APNG).
 *
 * The still path is the platform's, for the same reason JPEG's is. What this
 * module adds is the two things a decoder cannot tell you from the bitmap: the
 * colour type and bit depth, which come straight out of the `IHDR` chunk, and
 * whether the file is *animated*, which is the presence of an `acTL` chunk.
 *
 * ## An APNG that cannot be taken apart is still an APNG
 *
 * Every webview renders an APNG's animation in an `<img>`; only some can
 * enumerate its frames. Frame enumeration is what the transport controls need —
 * a native `<img>` animation cannot be paused, stepped or slowed, so exposing
 * transport controls over one would be a row of buttons that do nothing.
 *
 * So when `ImageDecoder` is unavailable, this decodes the *default image* (the
 * still frame a non-APNG-aware decoder would show) and says in `notes` that the
 * animation is not available here. The tile shows a correct picture with an
 * honest caveat, which is the outcome AGENTS.md's platform section asks for and
 * is much better than either a broken control set or a failed tile.
 */

import { ByteReader, hasAscii } from "../binary";
import {
  animatedImage,
  decodeError,
  decodeFramesViaImageDecoder,
  decodeNatively,
  stillImage,
  type DecodeContext,
  type DecodedImage,
} from "../decode";

const COLOR_TYPES: Readonly<Record<number, string>> = {
  0: "grayscale",
  2: "RGB",
  3: "indexed",
  4: "grayscale + alpha",
  6: "RGBA",
};

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlaced: boolean;
  readonly animated: boolean;
  readonly frameCount: number;
  readonly loopCount: number;
}

/**
 * Walks the chunk list far enough to answer "what is this and is it animated".
 *
 * Stops at the first `IDAT`: `IHDR` is required to be first and `acTL` is
 * required to precede `IDAT`, so everything this needs is in the header
 * section. Walking the whole file would mean stepping over every scanline chunk
 * of a 50 MB image to learn nothing.
 */
function readHeader(bytes: Uint8Array): PngHeader | null {
  const reader = new ByteReader(bytes, { littleEndian: false, offset: 8 });
  let header: Omit<PngHeader, "animated" | "frameCount" | "loopCount"> | null = null;
  let animated = false;
  let frameCount = 0;
  let loopCount = 0;

  try {
    while (reader.remaining >= 8) {
      const length = reader.u32();
      const type = reader.ascii(4);

      if (type === "IHDR") {
        const width = reader.u32();
        const height = reader.u32();
        const bitDepth = reader.u8();
        const colorType = reader.u8();
        reader.skip(2); // compression, filter — one legal value each
        const interlaced = reader.u8() !== 0;
        header = { width, height, bitDepth, colorType, interlaced };
        reader.skip(4); // CRC
        continue;
      }

      if (type === "acTL") {
        animated = true;
        frameCount = reader.u32();
        loopCount = reader.u32();
        reader.skip(4);
        continue;
      }

      // Everything needed is before the pixel data.
      if (type === "IDAT" || type === "IEND") break;

      reader.skip(length + 4);
    }
  } catch {
    // A truncated chunk list: whatever was read before it is still usable.
  }

  if (!header) return null;
  return { ...header, animated, frameCount, loopCount };
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  const { bytes } = context;
  const header = readHeader(bytes);

  if (!header) {
    throw decodeError(context, "is not a readable PNG — its header is missing.", {
      detail: hasAscii(bytes, "IHDR", 12)
        ? "the IHDR chunk is present but could not be read"
        : "no IHDR chunk was found at the start of the file",
    });
  }

  const pixelFormat = `${header.bitDepth}-bit ${
    COLOR_TYPES[header.colorType] ?? `colour type ${header.colorType}`
  }${header.interlaced ? ", interlaced" : ""}`;

  if (header.animated) {
    const frames = await decodeFramesViaImageDecoder(context, "image/png");
    if (frames && frames.frames.length > 1) {
      return animatedImage(frames.frames, {
        loopCount: header.loopCount,
        pixelFormat: `${pixelFormat}, APNG`,
        notes: frames.truncated
          ? [
              `only the first ${frames.frames.length} of ${header.frameCount} frames were decoded.`,
            ]
          : [],
      });
    }
  }

  const bitmap = await decodeNatively(context, "image/png");
  if (!bitmap) {
    throw decodeError(context, "could not be decoded as a PNG.", {
      detail: `${header.width}×${header.height}, ${pixelFormat}`,
    });
  }

  return stillImage(bitmap, {
    pixelFormat,
    notes: header.animated
      ? [
          `this is an animated PNG with ${header.frameCount} frames, but this ` +
            "platform's decoder cannot separate them — showing the still image.",
        ]
      : [],
  });
}
