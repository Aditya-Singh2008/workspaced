/**
 * AVIF.
 *
 * Entirely the platform's decoder, and the format most likely not to have one.
 * AVIF is AV1 intra-frame coding in an ISOBMFF container; decoding it here would
 * mean shipping an AV1 decoder, which is exactly the "heavy new dependency" the
 * phase brief tells us to weigh against the benefit and lose.
 *
 * So the interesting work is the failure. AGENTS.md is explicit that support
 * varies by webview and that a capability must be probed by *using* it: a
 * webkit2gtk build without the AV1 codec still has an `<img>` element, still has
 * `createImageBitmap`, and still answers every question about its capabilities
 * affirmatively — it simply produces nothing. {@link probeFormatSupport} decodes
 * a real one-pixel AVIF, so the error below distinguishes "this build cannot do
 * AVIF at all" from "this particular file is broken", which are different
 * problems with different answers.
 */

import {
  decodeError,
  decodeFramesViaImageDecoder,
  decodeNatively,
  animatedImage,
  probeFormatSupport,
  stillImage,
  type DecodeContext,
  type DecodedImage,
} from "../decode";

/** An `avis` brand, or an `msf1`-style sequence, means an animation. */
function looksLikeSequence(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 64);
  for (let offset = 8; offset + 4 <= limit; offset += 4) {
    const brand = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (brand === "avis" || brand === "msf1") return true;
  }
  return false;
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  if (!(await probeFormatSupport("image/avif"))) {
    throw decodeError(
      context,
      "is an AVIF, and this platform's webview has no AV1 image decoder.",
      {
        code: "unsupported",
        detail:
          "a known-good one-pixel AVIF was refused by this webview, so the format " +
          "is unavailable in this build regardless of the file. On Linux this " +
          "usually means webkit2gtk was built without AV1 support.",
      },
    );
  }

  if (looksLikeSequence(context.bytes)) {
    const decoded = await decodeFramesViaImageDecoder(context, "image/avif");
    if (decoded && decoded.frames.length > 1) {
      return animatedImage(decoded.frames, {
        loopCount: decoded.loopCount,
        pixelFormat: "AV1, animated",
        notes: decoded.truncated
          ? [`only the first ${decoded.frames.length} frames were decoded.`]
          : [],
      });
    }
  }

  const bitmap = await decodeNatively(context, "image/avif");
  if (!bitmap) {
    throw decodeError(
      context,
      "could not be decoded, although this platform does support AVIF.",
      {
        detail:
          "the file is most likely truncated, or uses an AV1 profile this " +
          "decoder does not implement",
      },
    );
  }

  return stillImage(bitmap, {
    pixelFormat: "AV1",
    notes: looksLikeSequence(context.bytes)
      ? [
          "this AVIF is a sequence, but this platform's decoder cannot separate " +
            "its frames — showing the first.",
        ]
      : [],
  });
}
