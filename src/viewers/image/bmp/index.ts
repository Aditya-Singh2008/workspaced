/**
 * BMP / DIB.
 *
 * The platform decoder is tried first and usually wins. The decoder below it
 * exists because BMP is the format where "the browser supports it" is least
 * true in practice: 32-bit BMPs with a real alpha channel are rendered opaque
 * by some engines and transparent by others, `BI_BITFIELDS` files with unusual
 * masks are refused outright, and top-down (negative-height) images are the
 * kind of thing that gets flipped. These are exactly the files a screenshot
 * tool or an old Windows program produces, so they are not a curiosity.
 *
 * It is a hundred lines and no dependency, which is the trade AGENTS.md asks for
 * — and unlike JPEG, uncompressed BMP is a format one can be *sure* of getting
 * right, because there is nothing to get wrong beyond row padding and byte
 * order.
 *
 * Run-length encoded BMPs (`BI_RLE4`/`BI_RLE8`) are not decoded here. They are
 * rare enough that the platform's own decoder is the right owner, and a file
 * that neither path can read gets an error naming the compression rather than a
 * blank tile.
 */

import { ByteReader } from "../binary";
import {
  decodeError,
  decodeNatively,
  stillImage,
  type DecodeContext,
  type DecodedImage,
} from "../decode";

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;
const BI_ALPHABITFIELDS = 6;

interface BmpInfo {
  readonly width: number;
  readonly height: number;
  readonly topDown: boolean;
  readonly bitCount: number;
  readonly compression: number;
  readonly paletteOffset: number;
  readonly paletteCount: number;
  readonly pixelOffset: number;
  readonly masks?: { r: number; g: number; b: number; a: number };
}

function readInfo(bytes: Uint8Array): BmpInfo | null {
  const reader = new ByteReader(bytes, { littleEndian: true });
  if (reader.u8() !== 0x42 || reader.u8() !== 0x4d) return null; // "BM"
  reader.skip(8);
  const pixelOffset = reader.u32();

  const headerStart = reader.offset;
  const headerSize = reader.u32();
  // BITMAPCOREHEADER (12) uses 16-bit dimensions and no compression field. It
  // predates Windows 3.0 and the platform decoder handles it; anything smaller
  // is not a DIB header at all.
  if (headerSize < 40) return null;

  const width = reader.i32();
  const rawHeight = reader.i32();
  reader.skip(2); // planes, always 1
  const bitCount = reader.u16();
  const compression = reader.u32();
  reader.skip(20); // sizeImage, pixels-per-metre pair, clrUsed, clrImportant
  reader.seek(headerStart + 32);
  const clrUsed = reader.u32();

  let masks: BmpInfo["masks"];
  if (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS) {
    // Always at header + 40, and pleasingly so: a plain BITMAPINFOHEADER is
    // exactly 40 bytes and puts the masks in the dwords *after* it, while
    // BITMAPV4HEADER declares them as its own fields at offsets 40–52. The two
    // layouts coincide, so there is one case here rather than two.
    reader.seek(headerStart + 40);
    const r = reader.u32();
    const g = reader.u32();
    const b = reader.u32();
    const a = compression === BI_ALPHABITFIELDS || headerSize >= 108 ? reader.u32() : 0;
    masks = { r, g, b, a };
  }

  const paletteOffset =
    headerStart +
    headerSize +
    (headerSize === 40 && (compression === BI_BITFIELDS || compression === BI_ALPHABITFIELDS)
      ? compression === BI_ALPHABITFIELDS
        ? 16
        : 12
      : 0);

  const paletteCount = bitCount <= 8 ? (clrUsed || 1 << bitCount) : 0;

  return {
    width: Math.abs(width),
    height: Math.abs(rawHeight),
    topDown: rawHeight < 0,
    bitCount,
    compression,
    paletteOffset,
    paletteCount,
    pixelOffset,
    masks,
  };
}

/** Shift and scale for a bit mask, so any channel width lands in 0…255. */
function channelFor(mask: number): { shift: number; max: number } | null {
  if (!mask) return null;
  let shift = 0;
  let value = mask;
  while ((value & 1) === 0) {
    value >>>= 1;
    shift += 1;
  }
  let bits = 0;
  while (value & 1) {
    value >>>= 1;
    bits += 1;
  }
  return { shift, max: (1 << bits) - 1 };
}

function decodeOurselves(bytes: Uint8Array, info: BmpInfo): HTMLCanvasElement | null {
  const { width, height, bitCount } = info;
  if (!width || !height) return null;
  // Allow-list rather than reject-list: an unknown compression must not fall
  // through into the raw pixel loop, which would read compressed bytes as
  // colour values and render noise instead of failing.
  if (
    info.compression !== BI_RGB &&
    info.compression !== BI_BITFIELDS &&
    info.compression !== BI_ALPHABITFIELDS
  ) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  const image = context.createImageData(width, height);
  const out = image.data;

  // Palette entries are BGRA quads, and the fourth byte is reserved (zero) in
  // every version that matters — so it is *not* alpha and must not be read as
  // one, which is a classic way to decode a palette image as fully transparent.
  const palette = new Uint8Array(info.paletteCount * 4);
  if (info.paletteCount) {
    const available = Math.max(0, bytes.length - info.paletteOffset);
    palette.set(
      bytes.subarray(
        info.paletteOffset,
        info.paletteOffset + Math.min(palette.length, available),
      ),
    );
  }

  const red = info.masks ? channelFor(info.masks.r) : null;
  const green = info.masks ? channelFor(info.masks.g) : null;
  const blue = info.masks ? channelFor(info.masks.b) : null;
  const alpha = info.masks ? channelFor(info.masks.a) : null;

  const rowBytes = Math.ceil((width * bitCount) / 32) * 4;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let y = 0; y < height; y += 1) {
    // Bottom-up unless the height was negative, which is the whole meaning of
    // that sign.
    const sourceRow = info.topDown ? y : height - 1 - y;
    const rowStart = info.pixelOffset + sourceRow * rowBytes;
    if (rowStart + rowBytes > bytes.length) break;

    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;

      if (bitCount <= 8) {
        const perByte = 8 / bitCount;
        const byte = bytes[rowStart + Math.floor(x / perByte)] ?? 0;
        const shift = 8 - bitCount * ((x % perByte) + 1);
        const index = (byte >> shift) & ((1 << bitCount) - 1);
        b = palette[index * 4] ?? 0;
        g = palette[index * 4 + 1] ?? 0;
        r = palette[index * 4 + 2] ?? 0;
      } else if (bitCount === 16) {
        const value = view.getUint16(rowStart + x * 2, true);
        if (red && green && blue) {
          r = Math.round((((value & info.masks!.r) >>> red.shift) / red.max) * 255);
          g = Math.round((((value & info.masks!.g) >>> green.shift) / green.max) * 255);
          b = Math.round((((value & info.masks!.b) >>> blue.shift) / blue.max) * 255);
          if (alpha) {
            a = Math.round((((value & info.masks!.a) >>> alpha.shift) / alpha.max) * 255);
          }
        } else {
          // No masks means the default 5-5-5 layout, not 5-6-5.
          r = Math.round((((value >>> 10) & 31) / 31) * 255);
          g = Math.round((((value >>> 5) & 31) / 31) * 255);
          b = Math.round(((value & 31) / 31) * 255);
        }
      } else if (bitCount === 24) {
        const at = rowStart + x * 3;
        b = bytes[at] ?? 0;
        g = bytes[at + 1] ?? 0;
        r = bytes[at + 2] ?? 0;
      } else if (bitCount === 32) {
        const value = view.getUint32(rowStart + x * 4, true);
        if (red && green && blue) {
          r = Math.round((((value & info.masks!.r) >>> red.shift) / red.max) * 255);
          g = Math.round((((value & info.masks!.g) >>> green.shift) / green.max) * 255);
          b = Math.round((((value & info.masks!.b) >>> blue.shift) / blue.max) * 255);
          a = alpha
            ? Math.round((((value & info.masks!.a) >>> alpha.shift) / alpha.max) * 255)
            : 255;
        } else {
          const at = rowStart + x * 4;
          b = bytes[at] ?? 0;
          g = bytes[at + 1] ?? 0;
          r = bytes[at + 2] ?? 0;
          // The fourth byte is alpha in practice and reserved on paper. A file
          // whose "alpha" is uniformly zero is one that meant it as padding, and
          // honouring it would render the image invisible — so that case is
          // treated as opaque. `hasAlpha` below decides it for the whole image
          // rather than per pixel, because a per-pixel rule would punch holes in
          // exactly the images it is trying to save.
          a = bytes[at + 3] ?? 255;
        }
      } else {
        return null;
      }

      out[target] = r;
      out[target + 1] = g;
      out[target + 2] = b;
      out[target + 3] = a;
    }
  }

  if (bitCount === 32 && !info.masks && !hasAnyAlpha(out)) {
    for (let index = 3; index < out.length; index += 4) out[index] = 255;
  }

  context.putImageData(image, 0, 0);
  return canvas;
}

function hasAnyAlpha(data: Uint8ClampedArray): boolean {
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] !== 0) return true;
  }
  return false;
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  const info = readInfo(context.bytes);

  const native = await decodeNatively(context, "image/bmp");
  if (native) {
    return stillImage(native, { pixelFormat: describe(info) });
  }

  if (info) {
    const canvas = decodeOurselves(context.bytes, info);
    if (canvas) {
      return stillImage(canvas, {
        pixelFormat: describe(info),
        notes: ["decoded by this app rather than by the system image decoder."],
      });
    }
  }

  throw decodeError(
    context,
    info && (info.compression === BI_RLE4 || info.compression === BI_RLE8)
      ? `is a run-length encoded BMP (BI_RLE${info.compression === BI_RLE4 ? 4 : 8}), which this platform's decoder refused.`
      : "could not be decoded as a BMP.",
    {
      detail: info
        ? `${info.width}×${info.height}, ${info.bitCount}-bit, compression ${info.compression}`
        : "the file header could not be read",
    },
  );
}

function describe(info: BmpInfo | null): string {
  if (!info) return "BMP";
  const layout =
    info.bitCount <= 8 ? `indexed, ${info.paletteCount} colours` : `${info.bitCount}-bit`;
  return `${layout}${info.topDown ? ", top-down" : ""}`;
}
