/**
 * Images built in memory, so the self-test needs no fixture files on disk.
 * **Dev builds only.**
 *
 * The same argument `viewers/pdf/dev/fixture.ts` makes: a suite that depends on
 * sample files is a suite that does not run on a fresh clone, and format
 * coverage is exactly where a missing fixture is most likely to hide a
 * regression.
 *
 * Two ways of producing one, chosen per format:
 *
 *   - **Encoded by the platform.** JPEG, PNG and WebP are written by
 *     `canvas.toBlob`, which is the only sane way to obtain a real JPEG and has
 *     the useful property that the bytes are a *genuine* file from the same
 *     encoder the export path uses.
 *   - **Built by hand.** BMP, TIFF, GIF and ICO cannot be produced by a canvas,
 *     and they are precisely the formats with a decoder in this plugin — so the
 *     fixtures have to be constructed, and constructing them is what makes the
 *     decoder testable at all.
 *
 * Every fixture uses {@link TEST_PATTERN}: four flat quadrants in colours no
 * decoder would produce by accident, so a check can assert the colour at a
 * coordinate and catch a transposed axis, a swapped red and blue, or an
 * off-by-one row — the failures that a "did it decode" check sails past.
 */

/**
 * The pattern: red, green, blue, white quadrants, clockwise from top-left.
 *
 * Chosen so every channel distinguishes at least two quadrants — a red/green
 * pattern would not notice a decoder that dropped the blue channel — and so
 * the top-left is *not* the same as the bottom-right, which is what makes a
 * 180° rotation detectable.
 */
export const TEST_PATTERN = {
  topLeft: { r: 255, g: 0, b: 0 },
  topRight: { r: 0, g: 255, b: 0 },
  bottomRight: { r: 0, g: 0, b: 255 },
  bottomLeft: { r: 255, g: 255, b: 255 },
} as const;

export const FIXTURE_SIZE = 8;

/** The pattern's colour at a coordinate, for assertions. */
export function expectedColor(
  x: number,
  y: number,
  size = FIXTURE_SIZE,
): { r: number; g: number; b: number } {
  const half = size / 2;
  if (y < half) return x < half ? TEST_PATTERN.topLeft : TEST_PATTERN.topRight;
  return x < half ? TEST_PATTERN.bottomLeft : TEST_PATTERN.bottomRight;
}

/**
 * The pattern at half intensity, for the checks about *changing* pixel values.
 *
 * {@link TEST_PATTERN} is fully saturated, which is right for asserting that a
 * decoder put the correct colour in the correct place and useless for asserting
 * that an adjustment did anything: every channel is already 0 or 255, so
 * doubling the exposure clamps straight back to the values it started with and
 * a completely broken adjustment looks identical to a working one. This cost a
 * failing check to notice, which is the good outcome — the fixture was wrong,
 * not the code, and a fixture that cannot fail is worse than either.
 */
export function midtoneCanvas(size = FIXTURE_SIZE): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const image = context.createImageData(size, size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const colour = expectedColor(x, y, size);
      const at = (y * size + x) * 4;
      image.data[at] = colour.r >> 1;
      image.data[at + 1] = colour.g >> 1;
      image.data[at + 2] = colour.b >> 1;
      image.data[at + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/** The pattern as a canvas, which every other builder starts from. */
export function patternCanvas(size = FIXTURE_SIZE): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  const image = context.createImageData(size, size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const colour = expectedColor(x, y, size);
      const at = (y * size + x) * 4;
      image.data[at] = colour.r;
      image.data[at + 1] = colour.g;
      image.data[at + 2] = colour.b;
      image.data[at + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

/** Encodes the pattern through the platform's own encoder. */
export async function encodedPattern(
  mimeType: string,
  size = FIXTURE_SIZE,
): Promise<Uint8Array | null> {
  const canvas = patternCanvas(size);
  const blob = await new Promise<Blob | null>((resolve) => {
    // Maximum quality: these bytes are compared against expected colours, and a
    // lossy encoder at its default setting turns flat quadrants into a gradient
    // at the boundaries.
    canvas.toBlob(resolve, mimeType, 1);
  });
  canvas.width = 0;
  canvas.height = 0;
  if (!blob || (blob.type && blob.type !== mimeType)) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// BMP
// ---------------------------------------------------------------------------

/** A 24-bit uncompressed BMP: file header, BITMAPINFOHEADER, bottom-up rows. */
export function buildBmp(size = FIXTURE_SIZE): Uint8Array {
  const rowBytes = Math.ceil((size * 3) / 4) * 4;
  const pixelBytes = rowBytes * size;
  const offset = 14 + 40;
  const bytes = new Uint8Array(offset + pixelBytes);
  const view = new DataView(bytes.buffer);

  bytes[0] = 0x42; // B
  bytes[1] = 0x4d; // M
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, offset, true);

  view.setUint32(14, 40, true); // header size
  view.setInt32(18, size, true);
  view.setInt32(22, size, true); // positive: bottom-up
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bits per pixel
  view.setUint32(30, 0, true); // BI_RGB

  for (let y = 0; y < size; y += 1) {
    // Bottom-up, so the last image row is written first.
    const row = offset + (size - 1 - y) * rowBytes;
    for (let x = 0; x < size; x += 1) {
      const colour = expectedColor(x, y, size);
      bytes[row + x * 3] = colour.b;
      bytes[row + x * 3 + 1] = colour.g;
      bytes[row + x * 3 + 2] = colour.r;
    }
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// TIFF
// ---------------------------------------------------------------------------

/**
 * An uncompressed little-endian RGB TIFF, one strip.
 *
 * The most basic file the decoder has to read, which makes it the right thing
 * to assert against: if this comes back wrong, nothing about the strip walk,
 * the sample unpacking or the photometric handling can be trusted.
 */
export function buildTiff(size = FIXTURE_SIZE): Uint8Array {
  const entries: [tag: number, type: number, count: number, value: number][] = [];
  const pixelBytes = size * size * 3;
  const headerBytes = 8;

  // The strip goes first so its offset is a fixed, known number; the directory
  // follows it. Either order is legal and this one avoids a second pass.
  const stripOffset = headerBytes;
  const ifdOffset = stripOffset + pixelBytes;

  entries.push(
    [256, 3, 1, size], // ImageWidth
    [257, 3, 1, size], // ImageLength
    [258, 3, 1, 8], // BitsPerSample — one value, so 8 fits inline
    [259, 3, 1, 1], // Compression: none
    [262, 3, 1, 2], // Photometric: RGB
    [273, 4, 1, stripOffset], // StripOffsets
    [277, 3, 1, 3], // SamplesPerPixel
    [278, 4, 1, size], // RowsPerStrip
    [279, 4, 1, pixelBytes], // StripByteCounts
    [284, 3, 1, 1], // PlanarConfiguration: chunky
  );

  const ifdBytes = 2 + entries.length * 12 + 4;
  const bytes = new Uint8Array(ifdOffset + ifdBytes);
  const view = new DataView(bytes.buffer);

  bytes[0] = 0x49; // I
  bytes[1] = 0x49; // I — little-endian
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const colour = expectedColor(x, y, size);
      const at = stripOffset + (y * size + x) * 3;
      bytes[at] = colour.r;
      bytes[at + 1] = colour.g;
      bytes[at + 2] = colour.b;
    }
  }

  view.setUint16(ifdOffset, entries.length, true);
  entries.forEach(([tag, type, count, value], index) => {
    const at = ifdOffset + 2 + index * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, count, true);
    // A SHORT's value sits in the low half of the four-byte field, which is the
    // detail a reader gets wrong if it treats the field as a LONG.
    if (type === 3) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  });
  view.setUint32(ifdOffset + 2 + entries.length * 12, 0, true); // no next IFD

  return bytes;
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

/**
 * Packs LZW codes without ever compressing anything.
 *
 * A valid GIF whose code stream is nothing but literals and clear codes. This is
 * the standard trick for writing a GIF without an encoder, and the constraint
 * that makes it work is the one it looks like it ignores: the decoder still adds
 * a dictionary entry per code, so the code width would grow — a clear code is
 * emitted often enough that it never reaches the first boundary.
 *
 * Codes are packed least-significant-bit first, which is the opposite of TIFF's
 * LZW and the reason `gif/lzw.ts` and `tiff/compression.ts` are separate files.
 */
function packUncompressedLzw(indices: Uint8Array): Uint8Array {
  const CLEAR = 256;
  const END = 257;
  const WIDTH = 9;
  // The decoder's table reaches 511 after 254 codes following a clear, at which
  // point the width would change. Re-clearing well before that keeps it at 9.
  const CODES_PER_RUN = 200;

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;

  const emit = (code: number): void => {
    buffer |= code << bits;
    bits += WIDTH;
    while (bits >= 8) {
      out.push(buffer & 0xff);
      buffer >>= 8;
      bits -= 8;
    }
  };

  emit(CLEAR);
  for (let index = 0; index < indices.length; index += 1) {
    if (index > 0 && index % CODES_PER_RUN === 0) emit(CLEAR);
    emit(indices[index]!);
  }
  emit(END);
  if (bits > 0) out.push(buffer & 0xff);

  // Data sub-blocks: a length byte then up to 255 bytes, terminated by a zero.
  const blocked: number[] = [];
  for (let at = 0; at < out.length; at += 255) {
    const chunk = out.slice(at, at + 255);
    blocked.push(chunk.length, ...chunk);
  }
  blocked.push(0);
  return new Uint8Array(blocked);
}

/**
 * An animated GIF whose frames are flat colours.
 *
 * Flat frames rather than the quadrant pattern, because what this fixture exists
 * to check is *which frame is on screen* — frame-stepping, the transport, the
 * subdivision rail — and a single sampled pixel answers that unambiguously when
 * each frame is one colour.
 */
export const GIF_FRAME_COLORS = [
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
] as const;

export const GIF_FRAME_DELAY_MS = 100;

export function buildAnimatedGif(size = FIXTURE_SIZE): Uint8Array {
  const bytes: number[] = [];
  const push = (...values: number[]): void => {
    bytes.push(...values);
  };
  const push16 = (value: number): void => {
    bytes.push(value & 0xff, (value >> 8) & 0xff);
  };

  push(...[..."GIF89a"].map((character) => character.charCodeAt(0)));
  push16(size);
  push16(size);
  // Global colour table present, 8-bit resolution, 256 entries.
  push(0xf7, 0, 0);

  // The palette: the frame colours first, then black to fill the 256 entries a
  // table of this declared size must have.
  for (let index = 0; index < 256; index += 1) {
    const colour = GIF_FRAME_COLORS[index];
    push(colour?.r ?? 0, colour?.g ?? 0, colour?.b ?? 0);
  }

  // NETSCAPE2.0 application extension: loop forever.
  push(0x21, 0xff, 11);
  push(...[..."NETSCAPE2.0"].map((character) => character.charCodeAt(0)));
  push(3, 1, 0, 0, 0);

  for (let frame = 0; frame < GIF_FRAME_COLORS.length; frame += 1) {
    // Graphic control extension: disposal 1 (leave in place), no transparency.
    push(0x21, 0xf9, 4, 0x04);
    push16(GIF_FRAME_DELAY_MS / 10); // hundredths of a second
    push(0, 0);

    // Image descriptor: full-frame, no local colour table, not interlaced.
    push(0x2c);
    push16(0);
    push16(0);
    push16(size);
    push16(size);
    push(0);

    push(8); // LZW minimum code size
    const indices = new Uint8Array(size * size).fill(frame);
    push(...packUncompressedLzw(indices));
  }

  push(0x3b); // trailer
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// ICO
// ---------------------------------------------------------------------------

/**
 * An icon holding two sizes, the larger second.
 *
 * The order matters: it is what proves the decoder chooses the *largest* entry
 * rather than the first, which is the behaviour that distinguishes this module
 * from handing the file to an `<img>`.
 */
export function buildIco(): Uint8Array {
  const sizes = [4, 16];
  const payloads = sizes.map((size) => dibFor(size));

  const directoryBytes = 6 + payloads.length * 16;
  const total = directoryBytes + payloads.reduce((sum, payload) => sum + payload.length, 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);

  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, payloads.length, true);

  let offset = directoryBytes;
  payloads.forEach((payload, index) => {
    const size = sizes[index]!;
    const at = 6 + index * 16;
    bytes[at] = size;
    bytes[at + 1] = size;
    bytes[at + 2] = 0; // colours in palette: 0 means more than 256
    bytes[at + 3] = 0; // reserved
    view.setUint16(at + 4, 1, true); // planes
    view.setUint16(at + 6, 32, true); // bits per pixel
    view.setUint32(at + 8, payload.length, true);
    view.setUint32(at + 12, offset, true);
    bytes.set(payload, offset);
    offset += payload.length;
  });

  return bytes;
}

/** A bare 32-bit DIB with the doubled height an icon payload declares. */
function dibFor(size: number): Uint8Array {
  const colourBytes = size * size * 4;
  const maskBytes = Math.ceil(size / 32) * 4 * size;
  const bytes = new Uint8Array(40 + colourBytes + maskBytes);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 40, true);
  view.setInt32(4, size, true);
  view.setInt32(8, size * 2, true); // colour data plus AND mask
  view.setUint16(12, 1, true);
  view.setUint16(14, 32, true);
  view.setUint32(16, 0, true); // BI_RGB

  for (let y = 0; y < size; y += 1) {
    const row = 40 + (size - 1 - y) * size * 4; // bottom-up
    for (let x = 0; x < size; x += 1) {
      const colour = expectedColor(x, y, size);
      bytes[row + x * 4] = colour.b;
      bytes[row + x * 4 + 1] = colour.g;
      bytes[row + x * 4 + 2] = colour.r;
      bytes[row + x * 4 + 3] = 255;
    }
  }
  // The AND mask stays zero: fully opaque, which is what a 32-bit icon means.

  return bytes;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/**
 * The pattern as vector geometry.
 *
 * Deliberately given a `viewBox` and *no* width or height, which is how most
 * real SVGs are written and is the case that renders at the browser's 300×150
 * default unless the decoder resolves the size itself.
 */
export function buildSvg(size = FIXTURE_SIZE): Uint8Array {
  const half = size / 2;
  const rect = (x: number, y: number, colour: { r: number; g: number; b: number }): string =>
    `<rect x="${x}" y="${y}" width="${half}" height="${half}" fill="rgb(${colour.r},${colour.g},${colour.b})"/>`;

  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">` +
    rect(0, 0, TEST_PATTERN.topLeft) +
    rect(half, 0, TEST_PATTERN.topRight) +
    rect(0, half, TEST_PATTERN.bottomLeft) +
    rect(half, half, TEST_PATTERN.bottomRight) +
    `</svg>`;

  return new TextEncoder().encode(markup);
}

/** An SVG carrying a script, for the sanitizer check. */
export function buildHostileSvg(): Uint8Array {
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8" onload="globalThis.__svgRan = true">` +
    `<script>globalThis.__svgRan = true;</script>` +
    `<rect width="8" height="8" fill="red" onclick="globalThis.__svgRan = true"/>` +
    `<a href="javascript:globalThis.__svgRan = true"><rect width="4" height="4"/></a>` +
    `</svg>`;
  return new TextEncoder().encode(markup);
}

// ---------------------------------------------------------------------------
// EXIF
// ---------------------------------------------------------------------------

/**
 * Splices an EXIF APP1 segment carrying an orientation tag and GPS coordinates
 * into a JPEG.
 *
 * Built rather than embedded because what needs testing is the *reader*: a
 * fixture with known coordinates is the only way to check that the degrees,
 * minutes and seconds are combined correctly, that the hemisphere reference is
 * applied, and — the point of the exercise — that a photo with location data is
 * reported as carrying sensitive metadata.
 */
export const FIXTURE_GPS = {
  latitude: 51.5,
  longitude: -0.125,
  orientation: 6,
} as const;

export function withExif(jpeg: Uint8Array): Uint8Array {
  const tiff = buildExifTiff();
  const payload = new Uint8Array(6 + tiff.length);
  payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
  payload.set(tiff, 6);

  const segment = new Uint8Array(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = 0xe1; // APP1
  segment[2] = ((payload.length + 2) >> 8) & 0xff;
  segment[3] = (payload.length + 2) & 0xff;
  segment.set(payload, 4);

  // Immediately after the SOI marker, which is where a reader looks first.
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

function buildExifTiff(): Uint8Array {
  // Layout, all offsets relative to the TIFF header:
  //   0   header (8 bytes)
  //   8   IFD0: orientation, GPS pointer
  //   ..  GPS IFD: refs and the two coordinate triples
  //   ..  the rationals the coordinate triples point at
  const buffer = new Uint8Array(256);
  const view = new DataView(buffer.buffer);

  view.setUint16(0, 0x4949, false); // "II", little-endian
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true); // IFD0 at offset 8

  const ifd0Offset = 8;
  const ifd0Entries = 2;
  const gpsIfdOffset = ifd0Offset + 2 + ifd0Entries * 12 + 4;
  const gpsEntries = 4;
  const rationalsOffset = gpsIfdOffset + 2 + gpsEntries * 12 + 4;

  // --- IFD0 ---
  view.setUint16(ifd0Offset, ifd0Entries, true);
  writeEntry(view, ifd0Offset + 2, 274, 3, 1, FIXTURE_GPS.orientation); // Orientation
  writeEntry(view, ifd0Offset + 14, 34853, 4, 1, gpsIfdOffset); // GPSInfoIFD
  view.setUint32(ifd0Offset + 2 + ifd0Entries * 12, 0, true);

  // --- GPS IFD ---
  const latRef = "N";
  const lonRef = "W";
  view.setUint16(gpsIfdOffset, gpsEntries, true);
  // A one-character ASCII value fits inline, which is the case a reader gets
  // wrong by treating the field as an offset.
  writeAsciiInline(view, gpsIfdOffset + 2, 1, latRef);
  writeEntry(view, gpsIfdOffset + 14, 2, 5, 3, rationalsOffset); // GPSLatitude
  writeAsciiInline(view, gpsIfdOffset + 26, 3, lonRef);
  writeEntry(view, gpsIfdOffset + 38, 4, 5, 3, rationalsOffset + 24); // GPSLongitude
  view.setUint32(gpsIfdOffset + 2 + gpsEntries * 12, 0, true);

  // --- the six rationals ---
  writeDms(view, rationalsOffset, FIXTURE_GPS.latitude);
  writeDms(view, rationalsOffset + 24, Math.abs(FIXTURE_GPS.longitude));

  return buffer.subarray(0, rationalsOffset + 48);
}

function writeEntry(
  view: DataView,
  at: number,
  tag: number,
  type: number,
  count: number,
  value: number,
): void {
  view.setUint16(at, tag, true);
  view.setUint16(at + 2, type, true);
  view.setUint32(at + 4, count, true);
  if (type === 3) view.setUint16(at + 8, value, true);
  else view.setUint32(at + 8, value, true);
}

function writeAsciiInline(view: DataView, at: number, tag: number, text: string): void {
  view.setUint16(at, tag, true);
  view.setUint16(at + 2, 2, true); // ASCII
  view.setUint32(at + 4, text.length + 1, true); // including the NUL
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(at + 8 + index, text.charCodeAt(index));
  }
  view.setUint8(at + 8 + text.length, 0);
}

/** Degrees as three unsigned rationals, which is how EXIF stores a coordinate. */
function writeDms(view: DataView, at: number, degrees: number): void {
  const whole = Math.floor(degrees);
  const minutesFloat = (degrees - whole) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60 * 100);

  view.setUint32(at, whole, true);
  view.setUint32(at + 4, 1, true);
  view.setUint32(at + 8, minutes, true);
  view.setUint32(at + 12, 1, true);
  view.setUint32(at + 16, seconds, true);
  view.setUint32(at + 20, 100, true);
}
