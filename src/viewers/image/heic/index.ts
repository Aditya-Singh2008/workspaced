/**
 * HEIC / HEIF.
 *
 * The format whose support varies most across the three platforms, and the one
 * AGENTS.md's verification step calls out by name for exactly that reason.
 * A HEIC's image data is HEVC — the same codec as an H.265 video frame — so
 * whether it opens depends on whether the *operating system* licenses an HEVC
 * decoder:
 *
 *   - **macOS** decodes HEIC everywhere, including in `<img>`. This is the happy
 *     path and it needs no help.
 *   - **Windows** decodes it only when the HEIF Image Extensions are installed,
 *     which they usually are not on a fresh machine.
 *   - **Linux** decodes it when webkit2gtk was built against a HEIF library,
 *     which most distributions' builds are not.
 *
 * Shipping an HEVC decoder to close that gap is exactly the "heavy new
 * dependency" the phase brief tells us to weigh and reject: megabytes of WASM
 * for one format, in an app whose tech stack section says every dependency must
 * be justified.
 *
 * So this does what the brief prescribes for RAW and what the format makes
 * possible anyway: **the embedded preview**. Practically every HEIC written by a
 * phone carries a JPEG rendering of the same image in its EXIF block, because
 * that is how the file stays viewable on software that predates the format. Show
 * that, say plainly that it is what is being shown, and the tile is useful
 * everywhere instead of blank on two platforms out of three.
 *
 * If there is no preview either, the error names HEVC and names the platform's
 * missing decoder — which is a problem the user can act on, unlike "could not
 * open".
 */

import { ByteReader } from "../binary";
import {
  decodeError,
  decodeNatively,
  stillImage,
  type DecodeContext,
  type DecodedImage,
} from "../decode";
import { decodeLargestEmbeddedJpeg, describePreviewCoverage } from "../preview";

/**
 * The primary item's dimensions, from the `ispe` (image spatial extents) box.
 *
 * Read so the note can say what the *full* image would have been — the
 * difference between the preview's size and the real one is the thing worth
 * knowing when a 12-megapixel photo is being shown as a 1.5-megapixel preview.
 *
 * A shallow walk: `ispe` lives at meta → iprp → ipco → ispe, and this descends
 * only through those container boxes rather than implementing ISOBMFF properly.
 * It is best-effort by design — a missing size costs a sentence, not the image.
 */
function readPrimarySize(bytes: Uint8Array): { width: number; height: number } | null {
  const CONTAINERS = new Set(["meta", "iprp", "ipco"]);

  const walk = (start: number, end: number, depth: number): { width: number; height: number } | null => {
    if (depth > 4) return null;
    const reader = new ByteReader(bytes, { littleEndian: false, offset: start });

    while (reader.offset + 8 <= end) {
      const boxStart = reader.offset;
      let size = reader.u32be();
      const type = reader.ascii(4);

      if (size === 1) {
        // 64-bit size. The high word is zero for anything this app will open.
        reader.skip(4);
        size = reader.u32be();
      } else if (size === 0) {
        size = end - boxStart;
      }
      if (size < 8) return null;

      const boxEnd = Math.min(end, boxStart + size);

      if (type === "ispe") {
        reader.skip(4); // version and flags
        return { width: reader.u32be(), height: reader.u32be() };
      }

      if (CONTAINERS.has(type)) {
        // `meta` is a full box: four bytes of version and flags before its
        // children. The other two are plain containers.
        const childStart = reader.offset + (type === "meta" ? 4 : 0);
        const found = walk(childStart, boxEnd, depth + 1);
        if (found) return found;
      }

      reader.seek(boxEnd);
    }
    return null;
  };

  try {
    return walk(0, bytes.length, 0);
  } catch {
    return null;
  }
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  const full = readPrimarySize(context.bytes);

  // The platform first. Where HEVC is available this is the whole story and the
  // user gets the real image at full resolution.
  const native = await decodeNatively(context, "image/heic");
  if (native) {
    return stillImage(native, { pixelFormat: "HEVC" });
  }

  const preview = await decodeLargestEmbeddedJpeg(context);
  if (preview) {
    const notes = [
      "this platform's webview has no HEVC decoder, so this is the JPEG preview " +
        "embedded in the file rather than a full HEIC render.",
    ];
    if (full) {
      notes.push(
        `the full image is ${full.width}×${full.height}; the preview is ${preview.width}×${preview.height}.`,
      );
    }
    const coverage = describePreviewCoverage(preview, full ?? undefined);
    if (coverage) notes.push(coverage);

    return stillImage(preview.bitmap, { pixelFormat: "embedded JPEG preview", notes });
  }

  throw decodeError(
    context,
    "is an HEIC image, and this platform's webview has no HEVC decoder — the file " +
      "also carries no embedded JPEG preview to fall back on.",
    {
      code: "unsupported",
      detail:
        (full ? `the image is ${full.width}×${full.height}. ` : "") +
        "On Windows, installing the HEIF Image Extensions adds system HEIC " +
        "support; on Linux this depends on how webkit2gtk was built. macOS " +
        "decodes HEIC natively.",
    },
  );
}
