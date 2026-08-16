/**
 * Finding the JPEG hiding inside a file this app cannot decode.
 *
 * Two formats need this and neither owns it, so it sits in the plugin root:
 * camera RAW, whose sensor data needs a demosaicing pipeline nobody is shipping
 * in a webview, and HEIC, whose image data is HEVC. Both nearly always carry a
 * fully-rendered JPEG alongside — the camera's own view of the shot, which is
 * what the back of the camera showed and what most software displays.
 *
 * The phase brief authorises exactly this for RAW: "decode the embedded preview
 * JPEG at minimum and clearly indicate to the user that a full RAW render was
 * not performed, rather than failing to open the file." The same argument
 * applies to HEIC on a platform with no HEVC decoder, and the same honesty
 * requirement comes with it — every caller here reports the substitution through
 * `DecodedImage.notes`.
 *
 * ## Why scanning, and not parsing
 *
 * A precise answer would mean an IFD walk for the TIFF-based RAW formats, an
 * ISOBMFF item walk for CR3 and HEIC, and a bespoke parser for RAF — four
 * container formats to find one JPEG, each with vendor deviations, and each
 * silently returning nothing when a vendor moves the preview. Scanning for the
 * JPEG itself works on all of them, including formats that did not exist when
 * this was written.
 *
 * The cost is false positives: `FFD8FF` can occur by chance in undecoded sensor
 * data. That is handled by *validating candidates rather than trusting them* —
 * each is checked for a plausible marker sequence, then actually decoded, and
 * the largest one that produces a real image wins. A false positive fails to
 * decode and costs one attempt.
 */

import { decodeViaImageBitmap, type DecodeContext } from "./decode";

/** How many candidates to attempt, largest first. */
const MAX_CANDIDATES = 8;

/** Smaller than this is a thumbnail for a file list, not a preview to view. */
const MIN_CANDIDATE_BYTES = 4096;

export interface EmbeddedPreview {
  readonly bitmap: ImageBitmap;
  readonly width: number;
  readonly height: number;
  /** Byte range within the source file, for the metadata panel's detail line. */
  readonly byteLength: number;
}

interface Candidate {
  readonly start: number;
  readonly end: number;
}

/**
 * Whether a `FFD8` really begins a JPEG.
 *
 * A JPEG's start-of-image is immediately followed by another marker, which is
 * `FF` and a code of `C0` or above. Random data satisfies that about once every
 * 8000 hits, which takes the false-positive rate from "several per RAW file" to
 * "rare enough that the decode attempt handles it".
 */
function looksLikeJpegStart(bytes: Uint8Array, at: number): boolean {
  return (
    bytes[at] === 0xff &&
    bytes[at + 1] === 0xd8 &&
    bytes[at + 2] === 0xff &&
    (bytes[at + 3] ?? 0) >= 0xc0
  );
}

/**
 * Every plausible embedded JPEG, largest first.
 *
 * Nested starts are skipped: a JPEG's own EXIF block routinely contains a
 * thumbnail JPEG, and reporting the outer one is right — resuming the scan after
 * the outer image's end rather than after its start is what does that.
 */
export function findEmbeddedJpegs(bytes: Uint8Array): Candidate[] {
  const candidates: Candidate[] = [];

  for (let at = 0; at + 4 < bytes.length; at += 1) {
    if (!looksLikeJpegStart(bytes, at)) continue;

    // Find this image's end marker. Scanning forward for `FFD9` is safe because
    // entropy-coded data byte-stuffs every `FF` with a following `00`.
    let end = -1;
    for (let scan = at + 2; scan + 1 < bytes.length; scan += 1) {
      if (bytes[scan] === 0xff && bytes[scan + 1] === 0xd9) {
        end = scan + 2;
        break;
      }
    }
    if (end < 0) break;

    if (end - at >= MIN_CANDIDATE_BYTES) candidates.push({ start: at, end });
    at = end - 1;
  }

  return candidates.sort((a, b) => b.end - b.start - (a.end - a.start));
}

/**
 * Decodes the largest embedded JPEG that actually decodes.
 *
 * "Largest" is measured in *pixels*, not bytes, and only after decoding —
 * a highly-compressed 4000×3000 preview can be smaller on disk than a
 * lightly-compressed 640×480 thumbnail, and the byte order is only a heuristic
 * for which to try first.
 */
export async function decodeLargestEmbeddedJpeg(
  context: DecodeContext,
): Promise<EmbeddedPreview | null> {
  const candidates = findEmbeddedJpegs(context.bytes).slice(0, MAX_CANDIDATES);
  let best: EmbeddedPreview | null = null;

  for (const candidate of candidates) {
    context.signal?.throwIfAborted();
    const slice = context.bytes.subarray(candidate.start, candidate.end);
    const bitmap = await decodeViaImageBitmap({ ...context, bytes: slice }, "image/jpeg");
    if (!bitmap) continue;

    if (!best || bitmap.width * bitmap.height > best.width * best.height) {
      best?.bitmap.close();
      best = {
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        byteLength: candidate.end - candidate.start,
      };
    } else {
      bitmap.close();
    }
  }

  return best;
}

/**
 * How much of the frame the preview actually covers.
 *
 * A camera's embedded preview is usually the full frame at reduced resolution,
 * but some are a cropped 16:9 rendering of a 3:2 sensor. Comparing the aspect
 * ratios is enough to notice, and it is worth telling the user when the picture
 * they are looking at is not the whole picture.
 */
export function describePreviewCoverage(
  preview: { width: number; height: number },
  full?: { width: number; height: number },
): string | null {
  if (!full?.width || !full.height) return null;
  const previewRatio = preview.width / preview.height;
  const fullRatio = full.width / full.height;
  if (Math.abs(previewRatio - fullRatio) < 0.02) return null;
  return `the embedded preview is ${preview.width}×${preview.height} and cropped differently from the ${full.width}×${full.height} full frame.`;
}
