/**
 * Camera RAW: CR2, CR3, NEF, ARW, ORF, RW2, DNG, RAF, PEF, SRW.
 *
 * One folder for ten formats, which AGENTS.md permits for exactly this case —
 * "formats sharing an identical decode path may share one subfolder" — because
 * the decode path really is one path. Each is still its own row in `formats.ts`,
 * so the extension list and every error message name the format the user has.
 *
 * ## What a full RAW render would cost, and why this does not do one
 *
 * A RAW file is not an image. It is the sensor's readout: one brightness value
 * per photosite behind a colour filter array, in the camera's own linear space,
 * with black levels, white levels and per-channel gains that vary by model.
 * Turning that into a picture means demosaicing, white balance from the shot's
 * illuminant, the camera's colour matrix, tone mapping and highlight recovery —
 * and the parameters for each are vendor-specific, undocumented, and different
 * for every body. That is `libraw`'s job, and `libraw` is a large C++ library
 * with a per-model database.
 *
 * The phase brief anticipates this precisely: *"If a full RAW decode pipeline is
 * impractical without a heavy new dependency, decode the embedded preview JPEG
 * at minimum and clearly indicate to the user that a full RAW render was not
 * performed, rather than failing to open the file."* That is what this does.
 *
 * It is also less of a compromise than it sounds. The embedded preview is the
 * camera's *own* rendering — the JPEG its processor would have written, with its
 * white balance and picture style applied — and for looking at a photo it is
 * frequently the picture the photographer intended. What it is not is editable
 * headroom, and the note says so rather than letting anyone assume otherwise.
 *
 * ## Two ways in
 *
 * The precise route reads the container's directories and follows the tags that
 * point at previews. It is tried first because it identifies the *full frame's*
 * dimensions along the way, which is what lets the note say how much resolution
 * is not being shown. When it finds nothing — a vendor put the preview
 * somewhere else, or the file is one of the non-TIFF containers — the scan in
 * `preview.ts` finds it anyway.
 */

import {
  decodeError,
  decodeViaImageBitmap,
  stillImage,
  type DecodeContext,
  type DecodedImage,
} from "../decode";
import { formatForExtension } from "../formats";
import { IfdReader, TIFF_TAG, type Ifd } from "../metadata/ifd";
import { decodeLargestEmbeddedJpeg, describePreviewCoverage } from "../preview";

interface PreviewCandidate {
  readonly offset: number;
  readonly length: number;
}

/**
 * Every JPEG a TIFF-style directory chain points at.
 *
 * Three tag pairs carry them, and which one a vendor uses is not predictable:
 * `JPEGInterchangeFormat` (Canon, Pentax, and DNG's convention), the strip tags
 * of a reduced-resolution sub-directory (Nikon, Sony), and sub-IFDs pointed at
 * by tag 330 (DNG, and most modern bodies). All three are followed.
 */
function previewsFromDirectories(reader: IfdReader, directories: readonly Ifd[]): {
  previews: PreviewCandidate[];
  fullSize?: { width: number; height: number };
} {
  const previews: PreviewCandidate[] = [];
  let fullSize: { width: number; height: number } | undefined;

  const consider = (ifd: Ifd): void => {
    const width = reader.number(ifd.get(TIFF_TAG.imageWidth));
    const height = reader.number(ifd.get(TIFF_TAG.imageHeight));
    const subfileType = reader.number(ifd.get(TIFF_TAG.newSubfileType)) ?? 0;

    // Bit 0 of NewSubfileType means "reduced resolution". A directory without it
    // that is bigger than anything seen so far is the full frame.
    if (width && height && (subfileType & 1) === 0) {
      if (!fullSize || width * height > fullSize.width * fullSize.height) {
        fullSize = { width, height };
      }
    }

    const jpegOffset = reader.number(ifd.get(TIFF_TAG.jpegInterchangeFormat));
    const jpegLength = reader.number(ifd.get(TIFF_TAG.jpegInterchangeFormatLength));
    if (jpegOffset && jpegLength) {
      previews.push({ offset: jpegOffset, length: jpegLength });
    }

    // A reduced-resolution directory whose single strip is JPEG data.
    const compression = reader.number(ifd.get(TIFF_TAG.compression));
    if (compression === 7 || compression === 6) {
      const offsets = reader.numbers(ifd.get(TIFF_TAG.stripOffsets));
      const counts = reader.numbers(ifd.get(TIFF_TAG.stripByteCounts));
      if (offsets.length === 1 && counts.length === 1) {
        previews.push({ offset: offsets[0]!, length: counts[0]! });
      }
    }
  };

  for (const ifd of directories) {
    consider(ifd);
    for (const offset of reader.numbers(ifd.get(TIFF_TAG.subIfds))) {
      const sub = reader.readIfd(offset);
      if (sub) consider(sub.entries);
    }
  }

  return { previews, fullSize };
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  const label = formatForExtension(context.extension)?.label ?? "camera RAW";

  let fullSize: { width: number; height: number } | undefined;
  let best: { bitmap: ImageBitmap; width: number; height: number } | null = null;

  // The precise route, for the TIFF-container formats — which is all of them
  // except CR3 and RAF.
  const opened = IfdReader.open(context.bytes);
  if (opened) {
    const directories = opened.reader.readChain(opened.firstIfd);
    const found = previewsFromDirectories(opened.reader, directories);
    fullSize = found.fullSize;

    for (const candidate of found.previews) {
      context.signal?.throwIfAborted();
      if (candidate.offset + candidate.length > context.bytes.length) continue;
      const slice = context.bytes.subarray(
        candidate.offset,
        candidate.offset + candidate.length,
      );
      // Some vendors point at the JPEG's payload rather than its SOI marker, and
      // some point a few bytes early. Trying the decode is cheaper than
      // guessing which.
      const bitmap = await decodeViaImageBitmap({ ...context, bytes: slice }, "image/jpeg");
      if (!bitmap) continue;
      if (!best || bitmap.width * bitmap.height > best.width * best.height) {
        best?.bitmap.close();
        best = { bitmap, width: bitmap.width, height: bitmap.height };
      } else {
        bitmap.close();
      }
    }
  }

  // The scan, which does not care what container this is.
  if (!best) {
    const scanned = await decodeLargestEmbeddedJpeg(context);
    if (scanned) best = scanned;
  }

  if (!best) {
    throw decodeError(
      context,
      `is a ${label} file with no embedded preview image, and this viewer does not ` +
        "render sensor data.",
      {
        code: "unsupported",
        detail:
          "Rendering RAW sensor data requires demosaicing and per-camera colour " +
          "processing, which this app does not ship. Files written by a camera " +
          "normally embed a JPEG preview; this one does not, which usually means " +
          "it was produced by conversion software with previews disabled.",
      },
    );
  }

  const notes = [
    `this is the JPEG preview embedded in the ${label} file — no full RAW render ` +
      "was performed, so this is the camera's own rendering rather than the " +
      "sensor data.",
  ];
  if (fullSize && (fullSize.width !== best.width || fullSize.height !== best.height)) {
    notes.push(
      `the sensor image is ${fullSize.width}×${fullSize.height}; this preview is ${best.width}×${best.height}.`,
    );
  }
  const coverage = describePreviewCoverage(best, fullSize);
  if (coverage) notes.push(coverage);

  return stillImage(best.bitmap, {
    pixelFormat: `${label} — embedded preview`,
    notes,
  });
}
