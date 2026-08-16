/**
 * Bounds-checked byte reading, for the containers parsed in this plugin.
 *
 * The sibling of `viewers/image/binary.ts`, and deliberately not shared with it:
 * the two plugins share nothing beyond the contract (AGENTS.md), and a common
 * byte reader would be the first thread of a coupling that ends with a common
 * "media" layer neither plugin asked for. It is forty lines either way.
 *
 * Everything here returns a *value* rather than throwing on a short read, and
 * every getter checks its own bounds. That is not defensive habit — this plugin's
 * entire input is files the user did not write, and a container's own length
 * fields are attacker-controlled. A box that claims to be 4GB inside a 2KB file
 * is a normal thing to encounter, and the parser above this has to see `null`
 * rather than a `RangeError` from three frames down.
 *
 * Offsets are numbers, not `BigInt`, with one exception: the 64-bit sizes that
 * ISOBMFF and Matroska both use. Those are read through {@link u64} and folded
 * to a `number`, which is exact below 2^53 — a file larger than nine petabytes
 * would lose precision, and a file larger than nine petabytes is not the failure
 * mode worth designing for.
 */

export class ByteReader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  /** Where the next relative read starts. Absolute reads ignore it. */
  offset = 0;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  get length(): number {
    return this.bytes.length;
  }

  get remaining(): number {
    return Math.max(0, this.bytes.length - this.offset);
  }

  /** Whether `count` bytes are readable at `at`. The check every getter makes. */
  has(count: number, at = this.offset): boolean {
    return at >= 0 && count >= 0 && at + count <= this.bytes.length;
  }

  seek(offset: number): void {
    this.offset = offset;
  }

  skip(count: number): void {
    this.offset += count;
  }

  u8(at = this.offset): number | null {
    if (!this.has(1, at)) return null;
    if (at === this.offset) this.offset += 1;
    return this.view.getUint8(at);
  }

  u16(at = this.offset, little = false): number | null {
    if (!this.has(2, at)) return null;
    if (at === this.offset) this.offset += 2;
    return this.view.getUint16(at, little);
  }

  u32(at = this.offset, little = false): number | null {
    if (!this.has(4, at)) return null;
    if (at === this.offset) this.offset += 4;
    return this.view.getUint32(at, little);
  }

  /**
   * A 64-bit big-endian value as a `number`.
   *
   * Composed from two 32-bit halves rather than `getBigUint64`, because every
   * caller wants a `number` and the conversion would be immediate anyway.
   */
  u64(at = this.offset, little = false): number | null {
    if (!this.has(8, at)) return null;
    if (at === this.offset) this.offset += 8;
    const first = this.view.getUint32(at, little);
    const second = this.view.getUint32(at + 4, little);
    return little ? second * 0x1_0000_0000 + first : first * 0x1_0000_0000 + second;
  }

  /** A fixed-length ASCII run — a box type, a FourCC, a RIFF chunk id. */
  ascii(count: number, at = this.offset): string | null {
    if (!this.has(count, at)) return null;
    if (at === this.offset) this.offset += count;
    let text = "";
    for (let index = 0; index < count; index += 1) {
      text += String.fromCharCode(this.bytes[at + index]!);
    }
    return text;
  }

  slice(count: number, at = this.offset): Uint8Array | null {
    if (!this.has(count, at)) return null;
    if (at === this.offset) this.offset += count;
    return this.bytes.subarray(at, at + count);
  }
}

/** UTF-8 text, replacing anything malformed rather than throwing. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Text from a container that did not say which encoding it used.
 *
 * The honest answer is UTF-8, which is what every modern container writes. The
 * one case worth handling is a UTF-16 byte-order mark, which QuickTime chapter
 * titles and some AVI `INFO` chunks carry — decoding those as UTF-8 produces a
 * string of interleaved NULs that renders as an empty-looking title, which is
 * indistinguishable from a chapter that has no name.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le", { fatal: false }).decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be", { fatal: false }).decode(bytes.subarray(2));
    }
  }
  // Trailing NULs are how fixed-width fields in these containers pad, and they
  // survive a UTF-8 decode as invisible characters that break string equality.
  return decodeUtf8(bytes).replace(/\0+$/, "");
}

/** Lowercase hex, for the profile bytes that go into an RFC 6381 codec string. */
export function hex(value: number, digits: number): string {
  return value.toString(16).padStart(digits, "0");
}
