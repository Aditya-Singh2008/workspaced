/**
 * JPEG.
 *
 * Entirely the platform's decoder, and deliberately so. JPEG is the one format
 * where every one of the three target webviews has a mature, hardware-assisted
 * path, and a decoder written here would be slower, larger, and would still have
 * to get progressive scans, restart markers, arithmetic coding, CMYK and
 * subsampling right. AGENTS.md's rule about not adding dependencies applies just
 * as well to code we would have to maintain ourselves.
 *
 * What this module does own is the failure. `createImageBitmap` rejects with
 * nothing useful, so a truncated download and a file that is not a JPEG at all
 * come back identically; the checks below turn the common cases into a sentence
 * that says what is wrong with *this file*.
 */

import {
  decodeError,
  decodeNatively,
  stillImage,
  type DecodeContext,
  type DecodedImage,
} from "../decode";

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

/**
 * Whether the file ends with an end-of-image marker.
 *
 * A truncated JPEG is the single most common damaged image, because it is what a
 * cancelled download or a full disk leaves behind. Some encoders pad past the
 * marker, so the last few bytes are searched rather than only the final two.
 */
function hasEndMarker(bytes: Uint8Array): boolean {
  const from = Math.max(0, bytes.length - 32);
  for (let index = bytes.length - 2; index >= from; index -= 1) {
    if (bytes[index] === EOI[0] && bytes[index + 1] === EOI[1]) return true;
  }
  return false;
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  const { bytes } = context;

  if (bytes[0] !== SOI[0] || bytes[1] !== SOI[1]) {
    throw decodeError(context, "does not begin with a JPEG header.", {
      detail: "expected the SOI marker 0xFFD8",
    });
  }

  const bitmap = await decodeNatively(context, "image/jpeg");
  if (bitmap) {
    return stillImage(bitmap, { pixelFormat: describe(bytes) });
  }

  throw decodeError(
    context,
    hasEndMarker(bytes)
      ? "could not be decoded as a JPEG."
      : "is a truncated JPEG — the file ends part-way through the image.",
    {
      detail: `${bytes.length} bytes, end-of-image marker ${
        hasEndMarker(bytes) ? "present" : "missing"
      }`,
      recoverable: false,
    },
  );
}

/**
 * The colour model and coding, read from the start-of-frame marker.
 *
 * Shown in the metadata panel next to the dimensions. Worth the twenty lines
 * because "progressive, 3 components" answers the two questions people actually
 * have about a JPEG that is behaving oddly, and neither is recoverable from the
 * decoded bitmap.
 */
function describe(bytes: Uint8Array): string {
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // SOF0..SOF15, excluding the four that are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const precision = bytes[offset + 4] ?? 8;
      const components = bytes[offset + 9] ?? 3;
      const coding =
        marker === 0xc0 || marker === 0xc1
          ? "baseline"
          : marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce
            ? "progressive"
            : "lossless";
      const model =
        components === 1 ? "grayscale" : components === 4 ? "CMYK" : "YCbCr";
      return `${precision}-bit ${model}, ${coding}`;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) break;
    offset += 2 + length;
  }
  return "JPEG";
}
