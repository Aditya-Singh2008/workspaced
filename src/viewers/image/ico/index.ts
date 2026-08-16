/**
 * Windows icons and cursors (`.ico`, `.cur`).
 *
 * An icon file is a *directory* of images at different sizes, and that is the
 * whole reason this module exists rather than handing the bytes to the platform.
 * Every webview will render an `.ico` in an `<img>`, but which entry it picks is
 * up to it — typically the first, which by convention is the smallest. Opening a
 * 256×256 application icon in an image viewer and getting a 16×16 one is not a
 * subtle failure, and it is the normal outcome of the easy path.
 *
 * So the directory is read here and the largest entry is chosen deliberately.
 * Decoding that entry then splits two ways, because ICO is a container for two
 * different formats:
 *
 *   - **PNG payload** (how every modern large icon is stored): handed straight
 *     to the platform's PNG decoder.
 *   - **DIB payload**: wrapped in a synthesized BMP file header and handed to
 *     the platform's BMP decoder. The wrapper is four fields, and it means this
 *     module does not carry a second copy of `bmp/`'s pixel loop — which is the
 *     right trade for two folders that must stay independent.
 *
 * The DIB path also has to apply the **AND mask**, the 1-bit-per-pixel
 * transparency plane stored after the colour data. Icons below 32 bits have no
 * alpha channel and rely on it entirely, so skipping it renders every such icon
 * as an opaque rectangle including its background.
 */

import { ByteReader } from "../binary";
import {
  decodeError,
  decodeNatively,
  stillImage,
  type DecodeContext,
  type DecodedImage,
} from "../decode";

interface IconEntry {
  readonly width: number;
  readonly height: number;
  readonly colorCount: number;
  readonly bitCount: number;
  readonly size: number;
  readonly offset: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

function readDirectory(bytes: Uint8Array): { entries: IconEntry[]; cursor: boolean } | null {
  const reader = new ByteReader(bytes, { littleEndian: true });
  try {
    if (reader.u16() !== 0) return null;
    const type = reader.u16();
    if (type !== 1 && type !== 2) return null;
    const count = reader.u16();
    if (count === 0 || count > 512) return null;

    const entries: IconEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      // A zero in the size byte means 256 — the field is one byte and the
      // largest legal icon does not fit in it.
      const width = reader.u8() || 256;
      const height = reader.u8() || 256;
      const colorCount = reader.u8();
      reader.skip(1); // reserved
      // For a cursor these two fields are the hotspot rather than planes/bpp.
      const planesOrHotspotX = reader.u16();
      const bitCountOrHotspotY = reader.u16();
      const size = reader.u32();
      const offset = reader.u32();
      entries.push({
        width,
        height,
        colorCount,
        bitCount: type === 1 ? bitCountOrHotspotY : 0,
        size,
        offset,
      });
      void planesOrHotspotX;
    }
    return { entries, cursor: type === 2 };
  } catch {
    return null;
  }
}

/** Largest by area, then by colour depth — the entry a viewer should show. */
function bestEntry(entries: readonly IconEntry[]): IconEntry | undefined {
  return [...entries].sort((a, b) => {
    const byArea = b.width * b.height - a.width * a.height;
    if (byArea !== 0) return byArea;
    return b.bitCount - a.bitCount;
  })[0];
}

/**
 * Wraps a bare DIB in the 14-byte file header that makes it a BMP.
 *
 * Two corrections are needed beyond the header. The DIB inside an icon declares
 * *twice* its real height, because the field covers the colour data and the AND
 * mask together; and the pixel-data offset has to account for the palette,
 * whose length is not in the header.
 */
function dibToBmp(dib: Uint8Array): { bmp: Uint8Array; height: number; bitCount: number } | null {
  if (dib.length < 40) return null;
  const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const headerSize = view.getUint32(0, true);
  if (headerSize < 40) return null;

  const width = view.getInt32(4, true);
  const doubledHeight = view.getInt32(8, true);
  const bitCount = view.getUint16(14, true);
  const height = Math.abs(doubledHeight) / 2;
  if (!width || !height) return null;

  const declaredColors = view.getUint32(32, true);
  const paletteEntries = bitCount <= 8 ? declaredColors || 1 << bitCount : 0;
  const pixelOffset = 14 + headerSize + paletteEntries * 4;

  const colourBytes = Math.ceil((width * bitCount) / 32) * 4 * height;
  const bmp = new Uint8Array(14 + headerSize + paletteEntries * 4 + colourBytes);

  bmp[0] = 0x42; // B
  bmp[1] = 0x4d; // M
  const out = new DataView(bmp.buffer);
  out.setUint32(2, bmp.length, true);
  out.setUint32(10, pixelOffset, true);

  bmp.set(dib.subarray(0, Math.min(dib.length, headerSize + paletteEntries * 4)), 14);
  // The height the BMP decoder must see is the real one, not the doubled one.
  out.setInt32(14 + 8, doubledHeight < 0 ? -height : height, true);

  const colourStart = headerSize + paletteEntries * 4;
  bmp.set(
    dib.subarray(colourStart, Math.min(dib.length, colourStart + colourBytes)),
    14 + colourStart,
  );

  return { bmp, height, bitCount };
}

/**
 * Punches the AND mask through the decoded canvas's alpha channel.
 *
 * The mask is 1 bit per pixel, bottom-up, rows padded to 4 bytes, and a set bit
 * means *transparent*. Only meaningful below 32 bits per pixel; a 32-bit icon
 * carries real alpha and its mask is conventionally all zeros, so applying it
 * would be harmless but pointless.
 */
function applyAndMask(
  canvas: HTMLCanvasElement,
  dib: Uint8Array,
  headerAndPaletteBytes: number,
  colourBytes: number,
): void {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;

  const maskStart = headerAndPaletteBytes + colourBytes;
  const rowBytes = Math.ceil(canvas.width / 32) * 4;
  if (maskStart + rowBytes * canvas.height > dib.length) return;

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    const sourceRow = canvas.height - 1 - y;
    for (let x = 0; x < canvas.width; x += 1) {
      const byte = dib[maskStart + sourceRow * rowBytes + (x >> 3)] ?? 0;
      const transparent = (byte >> (7 - (x & 7))) & 1;
      if (transparent) image.data[(y * canvas.width + x) * 4 + 3] = 0;
    }
  }
  context.putImageData(image, 0, 0);
}

export async function decode(context: DecodeContext): Promise<DecodedImage> {
  const directory = readDirectory(context.bytes);
  const entry = directory ? bestEntry(directory.entries) : undefined;

  if (directory && entry) {
    const payload = context.bytes.subarray(entry.offset, entry.offset + entry.size);
    const kind = directory.cursor ? "cursor" : "icon";
    const summary = `${directory.entries.length} ${kind} size${
      directory.entries.length === 1 ? "" : "s"
    }, showing ${entry.width}×${entry.height}`;

    if (
      payload.length > 8 &&
      PNG_MAGIC.every((byte, index) => payload[index] === byte)
    ) {
      const bitmap = await decodeNatively({ ...context, bytes: payload }, "image/png");
      if (bitmap) {
        return stillImage(bitmap, { pixelFormat: `PNG payload — ${summary}` });
      }
    } else {
      const wrapped = dibToBmp(payload);
      if (wrapped) {
        const bitmap = await decodeNatively(
          { ...context, bytes: wrapped.bmp },
          "image/bmp",
        );
        if (bitmap) {
          const canvas = toCanvas(bitmap);
          if (canvas && wrapped.bitCount < 32) {
            const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
            const headerSize = view.getUint32(0, true);
            const declaredColors = view.getUint32(32, true);
            const paletteEntries =
              wrapped.bitCount <= 8 ? declaredColors || 1 << wrapped.bitCount : 0;
            const colourBytes =
              Math.ceil((canvas.width * wrapped.bitCount) / 32) * 4 * wrapped.height;
            applyAndMask(canvas, payload, headerSize + paletteEntries * 4, colourBytes);
          }
          if (canvas) {
            return stillImage(canvas, {
              pixelFormat: `${wrapped.bitCount}-bit DIB payload — ${summary}`,
            });
          }
        }
      }
    }
  }

  // The directory was unreadable, or its chosen entry would not decode. The
  // platform's own handling of the whole file is a worse answer — it picks its
  // own size — but a picture at the wrong size beats no picture.
  const whole = await decodeNatively(context, "image/x-icon");
  if (whole) {
    return stillImage(whole, {
      pixelFormat: "icon",
      notes: [
        "this icon's directory could not be read, so the system decoder chose " +
          "which size to show.",
      ],
    });
  }

  throw decodeError(context, "could not be decoded as an icon.", {
    detail: directory
      ? `${directory.entries.length} entries, none of which decoded`
      : "the icon directory could not be read",
  });
}

function toCanvas(bitmap: ImageBitmap | HTMLCanvasElement): HTMLCanvasElement | null {
  if (!(typeof ImageBitmap !== "undefined" && bitmap instanceof ImageBitmap)) {
    return bitmap as HTMLCanvasElement;
  }
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}
