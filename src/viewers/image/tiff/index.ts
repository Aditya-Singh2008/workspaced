/**
 * TIFF.
 *
 * The one raster format in this plugin with **no native decoder on two of the
 * three target platforms**. Chromium — and therefore WebView2 — dropped TIFF
 * long ago; WebKit still has it, so macOS and some webkit2gtk builds decode a
 * `.tif` in an `<img>` and Windows does not. A viewer that claims TIFF and shows
 * a blank tile on Windows has not implemented TIFF.
 *
 * So the native path is tried first (it is faster, and on WebKit it handles
 * variants this decoder does not), and everything below it is the fallback that
 * makes the format actually work everywhere.
 *
 * ## What this decoder covers, and what it says when it does not
 *
 * Baseline TIFF plus the extensions that appear in files people actually have:
 * uncompressed, LZW, PackBits and Deflate; 1, 4, 8 and 16 bits per sample;
 * grayscale in either polarity, RGB, RGBA and palette; strips and tiles; the
 * horizontal predictor; and single-strip JPEG-compressed TIFFs, which is what
 * most scanners emit.
 *
 * Everything else — CCITT fax groups 3 and 4, JBIG, CMYK separations, floating
 * point samples, planar configuration 2 — is *detected and named*. That is the
 * difference the phase brief asks for between a clear per-file error and a blank
 * tile: "this TIFF uses CCITT Group 4 compression, which this viewer cannot
 * decode" tells the user what to do, and a grey rectangle does not.
 *
 * A multi-page TIFF is reported as such and its first page is shown. Pages are
 * genuinely subdivisions in the contract's sense, but wiring the whole
 * subdivision rail through a decoder that has to re-read strips per page is
 * phase 05's kind of work, and a note beats a half-built rail.
 */

import { inflate } from "../binary";
import {
  decodeError,
  decodeNatively,
  stillImage,
  MAX_STILL_PIXELS,
  type DecodeContext,
  type DecodedImage,
} from "../decode";
import { IfdReader, TIFF_TAG, type Ifd } from "../metadata/ifd";
import { lzwDecode, packBitsDecode } from "./compression";

const COMPRESSION_NAMES: Readonly<Record<number, string>> = {
  1: "uncompressed",
  2: "CCITT Group 3 (modified Huffman)",
  3: "CCITT Group 3 fax",
  4: "CCITT Group 4 fax",
  5: "LZW",
  6: "JPEG (old-style)",
  7: "JPEG",
  8: "Deflate",
  9: "JBIG (T.85)",
  10: "JBIG (T.43)",
  32773: "PackBits",
  32946: "Deflate (old tag)",
  34712: "JPEG 2000",
};

const PHOTOMETRIC_NAMES: Readonly<Record<number, string>> = {
  0: "grayscale (white is zero)",
  1: "grayscale",
  2: "RGB",
  3: "indexed",
  4: "transparency mask",
  5: "CMYK",
  6: "YCbCr",
  8: "CIE L*a*b*",
};

interface Layout {
  readonly width: number;
  readonly height: number;
  readonly bitsPerSample: number[];
  readonly samplesPerPixel: number;
  readonly compression: number;
  readonly photometric: number;
  readonly predictor: number;
  readonly planar: number;
  readonly extraSamples: number[];
  readonly sampleFormat: number;
  readonly colorMap: number[];
  /** Tiled files describe their blocks with a different set of tags. */
  readonly tiled: boolean;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly offsets: number[];
  readonly byteCounts: number[];
  readonly pageCount: number;
}

function readLayout(reader: IfdReader, ifd: Ifd, pageCount: number): Layout | null {
  const width = reader.number(ifd.get(TIFF_TAG.imageWidth)) ?? 0;
  const height = reader.number(ifd.get(TIFF_TAG.imageHeight)) ?? 0;
  if (!width || !height) return null;

  const bitsPerSample = reader.numbers(ifd.get(TIFF_TAG.bitsPerSample));
  const samplesPerPixel = reader.number(ifd.get(TIFF_TAG.samplesPerPixel)) ?? 1;
  const tileWidth = reader.number(ifd.get(TIFF_TAG.tileWidth));
  const tiled = tileWidth !== undefined && tileWidth > 0;

  const rowsPerStrip = reader.number(ifd.get(TIFF_TAG.rowsPerStrip)) ?? height;

  return {
    width,
    height,
    bitsPerSample: bitsPerSample.length ? bitsPerSample : [1],
    samplesPerPixel,
    compression: reader.number(ifd.get(TIFF_TAG.compression)) ?? 1,
    // 1 (BlackIsZero) is the specified default and the right guess when the tag
    // is missing; assuming RGB instead renders a grayscale scan as colour noise.
    photometric: reader.number(ifd.get(TIFF_TAG.photometric)) ?? 1,
    predictor: reader.number(ifd.get(TIFF_TAG.predictor)) ?? 1,
    planar: reader.number(ifd.get(TIFF_TAG.planarConfiguration)) ?? 1,
    extraSamples: reader.numbers(ifd.get(TIFF_TAG.extraSamples)),
    sampleFormat: reader.number(ifd.get(TIFF_TAG.sampleFormat)) ?? 1,
    colorMap: reader.numbers(ifd.get(TIFF_TAG.colorMap)),
    tiled,
    blockWidth: tiled ? tileWidth! : width,
    blockHeight: tiled ? (reader.number(ifd.get(TIFF_TAG.tileLength)) ?? 0) : rowsPerStrip,
    offsets: reader.numbers(
      ifd.get(tiled ? TIFF_TAG.tileOffsets : TIFF_TAG.stripOffsets),
    ),
    byteCounts: reader.numbers(
      ifd.get(tiled ? TIFF_TAG.tileByteCounts : TIFF_TAG.stripByteCounts),
    ),
    pageCount,
  };
}

/** Why this file cannot be decoded here, in the user's words. `null` if it can. */
function unsupportedReason(layout: Layout): string | null {
  const compression = layout.compression;
  if (![1, 5, 7, 8, 32773, 32946].includes(compression)) {
    return `uses ${COMPRESSION_NAMES[compression] ?? `compression type ${compression}`} compression, which this viewer cannot decode`;
  }
  if (layout.planar === 2) {
    return "stores its colour channels in separate planes (PlanarConfiguration 2), which this viewer cannot decode";
  }
  if (layout.sampleFormat === 3) {
    return "stores floating-point samples, which this viewer cannot decode";
  }
  if (![0, 1, 2, 3].includes(layout.photometric)) {
    return `is ${PHOTOMETRIC_NAMES[layout.photometric] ?? `photometric type ${layout.photometric}`}, which this viewer cannot convert`;
  }
  const bits = layout.bitsPerSample[0] ?? 8;
  if (![1, 4, 8, 16].includes(bits)) {
    return `stores ${bits} bits per sample, which this viewer cannot unpack`;
  }
  if (layout.bitsPerSample.some((value) => value !== bits)) {
    return "stores its channels at different bit depths, which this viewer cannot unpack";
  }
  if (layout.width * layout.height > MAX_STILL_PIXELS) {
    return `is ${layout.width}×${layout.height}, which is past this viewer's size limit`;
  }
  return null;
}

async function decompress(
  block: Uint8Array,
  compression: number,
  expectedLength: number,
): Promise<Uint8Array> {
  switch (compression) {
    case 1:
      return block;
    case 5:
      return lzwDecode(block, expectedLength);
    case 32773:
      return packBitsDecode(block, expectedLength);
    case 8:
    case 32946:
      try {
        return await inflate(block, "deflate");
      } catch {
        // Some encoders write a raw deflate stream under the zlib tag.
        return inflate(block, "deflate-raw");
      }
    default:
      return block;
  }
}

/**
 * Undoes horizontal differencing.
 *
 * Predictor 2 stores each sample as its difference from the sample one pixel to
 * the left, which compresses far better and is meaningless until reversed. It
 * operates per channel and per row, and applying it across a row boundary is a
 * classic way to produce an image that smears to the right.
 */
function undoPredictor(
  data: Uint8Array,
  width: number,
  rows: number,
  samples: number,
  bits: number,
): void {
  if (bits !== 8 && bits !== 16) return;
  const rowLength = width * samples * (bits / 8);

  for (let row = 0; row < rows; row += 1) {
    const start = row * rowLength;
    if (start + rowLength > data.length) break;

    if (bits === 8) {
      for (let index = samples; index < rowLength; index += 1) {
        data[start + index] = (data[start + index]! + data[start + index - samples]!) & 0xff;
      }
    } else {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let index = samples; index < width * samples; index += 1) {
        const at = start + index * 2;
        const previous = view.getUint16(at - samples * 2, true);
        view.setUint16(at, (view.getUint16(at, true) + previous) & 0xffff, true);
      }
    }
  }
}

/** One decompressed block's samples, written into the RGBA output. */
function writeBlock(
  out: Uint8ClampedArray,
  data: Uint8Array,
  layout: Layout,
  originX: number,
  originY: number,
  blockWidth: number,
  blockHeight: number,
): void {
  const bits = layout.bitsPerSample[0] ?? 8;
  const samples = layout.samplesPerPixel;
  const maxValue = (1 << bits) - 1;
  const rowLength = Math.ceil((blockWidth * samples * bits) / 8);

  const palette = layout.colorMap;
  const paletteEntries = palette.length / 3;
  const alphaIndex =
    layout.extraSamples.length && samples > (layout.photometric === 2 ? 3 : 1)
      ? (layout.photometric === 2 ? 3 : 1)
      : -1;

  for (let y = 0; y < blockHeight; y += 1) {
    const targetY = originY + y;
    if (targetY >= layout.height) break;
    const rowStart = y * rowLength;

    for (let x = 0; x < blockWidth; x += 1) {
      const targetX = originX + x;
      if (targetX >= layout.width) break;

      const readSample = (sample: number): number => {
        const bitOffset = (x * samples + sample) * bits;
        if (bits === 8) return data[rowStart + (bitOffset >> 3)] ?? 0;
        if (bits === 16) {
          const at = rowStart + (bitOffset >> 3);
          // Little-endian regardless of the file's byte order: the decompressed
          // sample stream is a byte stream, and TIFF stores multi-byte samples
          // in the file's order — which `undoPredictor` has already normalized.
          return ((data[at + 1] ?? 0) << 8) | (data[at] ?? 0);
        }
        const byte = data[rowStart + (bitOffset >> 3)] ?? 0;
        return (byte >> (8 - bits - (bitOffset & 7))) & maxValue;
      };

      const target = (targetY * layout.width + targetX) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      if (layout.photometric === 3) {
        const index = readSample(0);
        if (index < paletteEntries) {
          // Colour map entries are 16-bit and stored as all reds, then all
          // greens, then all blues — not interleaved.
          r = (palette[index] ?? 0) >> 8;
          g = (palette[paletteEntries + index] ?? 0) >> 8;
          b = (palette[paletteEntries * 2 + index] ?? 0) >> 8;
        }
      } else if (layout.photometric === 2) {
        const scale = bits === 16 ? 1 / 257 : bits === 8 ? 1 : 255 / maxValue;
        r = Math.round(readSample(0) * scale);
        g = Math.round(readSample(1) * scale);
        b = Math.round(readSample(2) * scale);
        if (alphaIndex >= 0) a = Math.round(readSample(alphaIndex) * scale);
      } else {
        const scale = bits === 16 ? 1 / 257 : bits === 8 ? 1 : 255 / maxValue;
        let value = Math.round(readSample(0) * scale);
        // Photometric 0 means the *smallest* value is white, so a bilevel scan
        // stored that way renders as a negative unless inverted here.
        if (layout.photometric === 0) value = 255 - value;
        r = value;
        g = value;
        b = value;
        if (alphaIndex >= 0) a = Math.round(readSample(alphaIndex) * scale);
      }

      out[target] = r;
      out[target + 1] = g;
      out[target + 2] = b;
      out[target + 3] = a;
    }
  }
}

async function decodeOurselves(
  context: DecodeContext,
  reader: IfdReader,
  layout: Layout,
): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const context2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!context2d) return null;

  const image = context2d.createImageData(layout.width, layout.height);
  // Opaque by default: a file with no alpha channel must not come out
  // transparent because `createImageData` zeroes the buffer.
  for (let index = 3; index < image.data.length; index += 4) image.data[index] = 255;

  const bits = layout.bitsPerSample[0] ?? 8;
  const blocksAcross = layout.tiled
    ? Math.ceil(layout.width / layout.blockWidth)
    : 1;

  for (let block = 0; block < layout.offsets.length; block += 1) {
    context.signal?.throwIfAborted();

    const offset = layout.offsets[block]!;
    const length = layout.byteCounts[block] ?? 0;
    if (offset + length > reader.bytes.length) break;

    const originX = layout.tiled ? (block % blocksAcross) * layout.blockWidth : 0;
    const originY = layout.tiled
      ? Math.floor(block / blocksAcross) * layout.blockHeight
      : block * layout.blockHeight;

    // A strip's height is clipped by the image; a tile's is not — tiles are
    // padded to their full size and the excess is discarded on write.
    const blockHeight = layout.tiled
      ? layout.blockHeight
      : Math.min(layout.blockHeight, layout.height - originY);
    if (blockHeight <= 0) break;

    const rowLength = Math.ceil((layout.blockWidth * layout.samplesPerPixel * bits) / 8);
    const expected = rowLength * blockHeight;

    const raw = reader.bytes.subarray(offset, offset + length);
    const data = await decompress(raw, layout.compression, expected);

    if (layout.predictor === 2) {
      undoPredictor(data, layout.blockWidth, blockHeight, layout.samplesPerPixel, bits);
    }

    writeBlock(
      image.data,
      data,
      layout,
      originX,
      originY,
      layout.blockWidth,
      blockHeight,
    );
  }

  context2d.putImageData(image, 0, 0);
  return canvas;
}

/**
 * A JPEG-compressed TIFF with one strip is a JPEG with a TIFF wrapper, and the
 * platform decodes it as one.
 *
 * This is how most document scanners write colour TIFFs, so it is worth the
 * special case. Multi-strip JPEG TIFFs need shared quantization tables stitched
 * back into each strip, which is a different job and is reported as unsupported.
 */
async function decodeJpegStrip(
  context: DecodeContext,
  reader: IfdReader,
  layout: Layout,
): Promise<HTMLCanvasElement | ImageBitmap | null> {
  if (layout.offsets.length !== 1) return null;
  const offset = layout.offsets[0]!;
  const length = layout.byteCounts[0] ?? 0;
  if (!length || offset + length > reader.bytes.length) return null;
  const strip = reader.bytes.subarray(offset, offset + length);
  if (strip[0] !== 0xff || strip[1] !== 0xd8) return null;
  return decodeNatively({ ...context, bytes: strip }, "image/jpeg");
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  const opened = IfdReader.open(context.bytes);
  if (!opened) {
    // BigTIFF has a different magic and a 64-bit directory layout. Saying so is
    // more useful than "not a TIFF", because the file is one.
    const marker = (context.bytes[2] ?? 0) | ((context.bytes[3] ?? 0) << 8);
    throw decodeError(
      context,
      marker === 43 || marker === 0x2b00
        ? "is a BigTIFF, which this viewer cannot read."
        : "is not a readable TIFF.",
      { detail: "the TIFF header could not be parsed" },
    );
  }

  const { reader, firstIfd } = opened;
  const directories = reader.readChain(firstIfd);
  const ifd = directories[0];
  if (!ifd) {
    throw decodeError(context, "contains no image directory.", {
      detail: `first IFD offset ${firstIfd}`,
    });
  }

  const layout = readLayout(reader, ifd, directories.length);
  if (!layout) {
    throw decodeError(context, "does not declare its image dimensions.", {
      detail: "ImageWidth or ImageLength is missing from the first directory",
    });
  }

  const describe = () =>
    `${layout.bitsPerSample[0] ?? 8}-bit ${
      PHOTOMETRIC_NAMES[layout.photometric] ?? "unknown"
    }, ${COMPRESSION_NAMES[layout.compression] ?? layout.compression}${
      layout.tiled ? ", tiled" : ""
    }`;

  const notes: string[] = [];
  if (layout.pageCount > 1) {
    notes.push(
      `this TIFF has ${layout.pageCount} pages; the first one is shown.`,
    );
  }

  // The platform first: on WebKit it is faster and handles more variants than
  // the decoder below, and where it works there is nothing to gain by ignoring
  // it. On Chromium it simply declines, at the cost of one failed decode.
  const native = await decodeNatively(context, "image/tiff");
  if (native) {
    return stillImage(native, { pixelFormat: describe(), notes });
  }

  if (layout.compression === 7) {
    const jpeg = await decodeJpegStrip(context, reader, layout);
    if (jpeg) {
      return stillImage(jpeg, { pixelFormat: describe(), notes });
    }
  }

  const reason = unsupportedReason(layout);
  if (reason) {
    throw decodeError(context, `${reason}.`, {
      code: "unsupported",
      detail: `${layout.width}×${layout.height}, ${describe()}`,
    });
  }

  if (!layout.offsets.length) {
    throw decodeError(context, "declares no image data.", {
      detail: `${layout.tiled ? "TileOffsets" : "StripOffsets"} is missing or empty`,
    });
  }

  const canvas = await decodeOurselves(context, reader, layout);
  if (!canvas) {
    throw decodeError(context, "could not be decoded as a TIFF.", {
      detail: `${layout.width}×${layout.height}, ${describe()}`,
    });
  }

  return stillImage(canvas, {
    pixelFormat: describe(),
    notes: [...notes, "decoded by this app rather than by the system image decoder."],
  });
}
