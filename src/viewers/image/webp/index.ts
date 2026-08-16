/**
 * WebP, still and animated.
 *
 * The still path is the platform's. The animated path is the one place in this
 * plugin where a capability genuinely differs between the three target webviews
 * and there is no way to paper over it: animated WebP is VP8 video in a
 * container, and separating its frames means either a VP8 decoder — far past
 * what AGENTS.md's dependency rule would allow for one format — or the
 * platform's own, through `ImageDecoder`.
 *
 * `ImageDecoder` is in Chromium and not in WebKit at this app's floor. So:
 *
 *   - Where it exists, frames come back and the transport controls are real.
 *   - Where it does not, the first frame is decoded as a still and `notes` says
 *     the animation cannot be separated here. The instance reads the frame count
 *     and does not offer controls that would do nothing.
 *
 * This is AGENTS.md's "detect support at runtime per platform and fail with a
 * specific, named error state" applied to a capability rather than to a format,
 * and it is why the container is parsed here even though nothing else needs it:
 * knowing a file *is* animated is what makes the note truthful rather than
 * silence.
 */

import { ByteReader } from "../binary";
import {
  animatedImage,
  decodeError,
  decodeFramesViaImageDecoder,
  decodeNatively,
  probeFormatSupport,
  stillImage,
  type DecodeContext,
  type DecodedImage,
} from "../decode";

interface WebpInfo {
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
  readonly hasAlpha: boolean;
  readonly lossless: boolean;
  readonly frameCount: number;
  readonly loopCount: number;
}

/**
 * Walks the RIFF chunk list.
 *
 * A simple WebP is `RIFF … WEBP VP8 ` or `VP8L`; an extended one starts with a
 * `VP8X` chunk carrying the flags and the canvas size, followed by `ANIM`,
 * `ANMF` frames, `ALPH`, and so on. Chunks are padded to even lengths, which is
 * the detail that desynchronizes a parser that ignores it.
 */
function parse(bytes: Uint8Array): WebpInfo | null {
  const reader = new ByteReader(bytes, { littleEndian: true, offset: 12 });

  let width = 0;
  let height = 0;
  let animated = false;
  let hasAlpha = false;
  let lossless = false;
  let frameCount = 0;
  let loopCount = 0;

  try {
    while (reader.remaining >= 8) {
      const type = reader.ascii(4);
      const size = reader.u32();
      const next = reader.offset + size + (size % 2);

      switch (type) {
        case "VP8X": {
          const flags = reader.u8();
          animated = (flags & 0x02) !== 0;
          hasAlpha = (flags & 0x10) !== 0;
          reader.skip(3);
          // Canvas dimensions are stored as 24-bit values, minus one.
          width = (reader.u8() | (reader.u8() << 8) | (reader.u8() << 16)) + 1;
          height = (reader.u8() | (reader.u8() << 8) | (reader.u8() << 16)) + 1;
          break;
        }
        case "ANIM": {
          reader.skip(4); // background colour
          loopCount = reader.u16();
          break;
        }
        case "ANMF":
          frameCount += 1;
          break;
        case "ALPH":
          hasAlpha = true;
          break;
        case "VP8 ": {
          if (!width) {
            // The frame header: a 3-byte start code, then 14 bits of each
            // dimension after the 0x9d012a sync.
            reader.skip(6);
            width = reader.u16() & 0x3fff;
            height = reader.u16() & 0x3fff;
          }
          break;
        }
        case "VP8L": {
          lossless = true;
          if (!width) {
            reader.skip(1); // signature byte 0x2f
            const packed = reader.u32();
            width = (packed & 0x3fff) + 1;
            height = ((packed >>> 14) & 0x3fff) + 1;
            hasAlpha = ((packed >>> 28) & 1) !== 0;
          }
          break;
        }
        default:
          break;
      }

      reader.seek(Math.min(next, reader.size));
    }
  } catch {
    // Truncated chunk list; whatever was learned before it still stands.
  }

  if (!width || !height) return null;
  return { width, height, animated, hasAlpha, lossless, frameCount, loopCount };
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  const info = parse(context.bytes);

  if (!(await probeFormatSupport("image/webp"))) {
    throw decodeError(context, "is a WebP, which this platform cannot decode.", {
      code: "unsupported",
      detail:
        "the webview refused a known-good one-pixel WebP, so the format is not " +
        "available in this build of the system webview",
    });
  }

  const pixelFormat = info
    ? `${info.lossless ? "lossless" : "lossy"}${info.hasAlpha ? " + alpha" : ""}`
    : "WebP";

  if (info?.animated) {
    const decoded = await decodeFramesViaImageDecoder(context, "image/webp");
    if (decoded && decoded.frames.length > 1) {
      return animatedImage(decoded.frames, {
        loopCount: info.loopCount,
        pixelFormat: `${pixelFormat}, animated`,
        notes: decoded.truncated
          ? [`only the first ${decoded.frames.length} frames were decoded.`]
          : [],
      });
    }
  }

  const bitmap = await decodeNatively(context, "image/webp");
  if (!bitmap) {
    throw decodeError(context, "could not be decoded as a WebP.", {
      detail: info ? `${info.width}×${info.height}, ${pixelFormat}` : "unreadable container",
    });
  }

  return stillImage(bitmap, {
    pixelFormat,
    notes: info?.animated
      ? [
          `this WebP is animated (${info.frameCount || "several"} frames), but this ` +
            "platform's decoder cannot separate them — showing the first frame.",
        ]
      : [],
  });
}
