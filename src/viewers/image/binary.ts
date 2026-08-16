/**
 * Reading structured bytes: a cursor, the two endiannesses, and bounds checks.
 *
 * Shared by every format module that parses a container itself — GIF, TIFF, ICO,
 * WebP, the ISOBMFF ones, and the metadata extractor — so it lives in the plugin
 * root rather than in whichever folder happened to need it first.
 *
 * **Every read is bounds-checked and throws.** That is the point of the module.
 * A truncated file is the *normal* case here: these formats are parsed from
 * whatever bytes are on disk, and a half-downloaded JPEG or a RAW file with a
 * clipped preview must produce "this file is truncated" rather than reading
 * `undefined` and rendering nonsense. Callers catch {@link ByteRangeError} at
 * the format boundary and turn it into a `ViewerError`.
 */

export class ByteRangeError extends RangeError {
  constructor(offset: number, length: number, size: number) {
    super(`read of ${length} byte(s) at ${offset} is past the end (${size} bytes)`);
    this.name = "ByteRangeError";
  }
}

export class ByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  /** Byte order for the multi-byte reads. TIFF-derived formats declare it. */
  littleEndian: boolean;
  offset = 0;

  constructor(bytes: Uint8Array, options?: { littleEndian?: boolean; offset?: number }) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.littleEndian = options?.littleEndian ?? true;
    this.offset = options?.offset ?? 0;
  }

  get size(): number {
    return this.bytes.byteLength;
  }

  get remaining(): number {
    return Math.max(0, this.size - this.offset);
  }

  /** Throws unless `length` bytes are readable at `offset`. */
  require(offset: number, length: number): void {
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new ByteRangeError(offset, length, this.size);
    }
  }

  seek(offset: number): this {
    this.require(offset, 0);
    this.offset = offset;
    return this;
  }

  skip(length: number): this {
    return this.seek(this.offset + length);
  }

  u8(): number {
    this.require(this.offset, 1);
    return this.view.getUint8(this.offset++);
  }

  u16(): number {
    this.require(this.offset, 2);
    const value = this.view.getUint16(this.offset, this.littleEndian);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.require(this.offset, 4);
    const value = this.view.getUint32(this.offset, this.littleEndian);
    this.offset += 4;
    return value;
  }

  i16(): number {
    this.require(this.offset, 2);
    const value = this.view.getInt16(this.offset, this.littleEndian);
    this.offset += 2;
    return value;
  }

  i32(): number {
    this.require(this.offset, 4);
    const value = this.view.getInt32(this.offset, this.littleEndian);
    this.offset += 4;
    return value;
  }

  /** Big-endian regardless of {@link littleEndian}, for the many formats that mix. */
  u16be(): number {
    this.require(this.offset, 2);
    const value = this.view.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  u32be(): number {
    this.require(this.offset, 4);
    const value = this.view.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }

  f32(): number {
    this.require(this.offset, 4);
    const value = this.view.getFloat32(this.offset, this.littleEndian);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.require(this.offset, 8);
    const value = this.view.getFloat64(this.offset, this.littleEndian);
    this.offset += 8;
    return value;
  }

  /** A borrowed view, not a copy. Valid as long as the source bytes are. */
  slice(length: number): Uint8Array {
    this.require(this.offset, length);
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  /** Fixed-length ASCII, stopping at the first NUL. */
  ascii(length: number): string {
    const raw = this.slice(length);
    let end = raw.length;
    for (let index = 0; index < raw.length; index += 1) {
      if (raw[index] === 0) {
        end = index;
        break;
      }
    }
    return String.fromCharCode(...raw.subarray(0, end));
  }
}

/** Whether `bytes` starts with `signature` at `offset`. Never throws. */
export function hasSignature(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  if (offset + signature.length > bytes.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

/** Whether `bytes` has these ASCII characters at `offset`. Never throws. */
export function hasAscii(bytes: Uint8Array, text: string, offset = 0): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * Inflates a zlib or raw-deflate stream through the platform's own
 * `DecompressionStream`.
 *
 * Used by the TIFF decoder (Deflate is one of the two compressions that matter
 * for the files people actually have) and by PNG's textual chunks. Present in
 * all three target webviews at the floor AGENTS.md sets, and the alternative is
 * an inflate implementation this plugin has no business owning.
 */
export async function inflate(
  bytes: Uint8Array,
  format: "deflate" | "deflate-raw" = "deflate",
): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice() as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream(format));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}
