/**
 * TIFF's two hand-rolled compressions: LZW and PackBits.
 *
 * The other two that matter — none, and Deflate — need no code here: the first
 * is a copy and the second goes through the platform's `DecompressionStream`
 * (see `binary.ts`).
 *
 * ## TIFF's LZW is not GIF's LZW
 *
 * They share a name and an idea and differ in all three places a decoder can go
 * wrong, which is why `gif/lzw.ts` cannot be reused here and why this comment
 * exists rather than a cross-reference:
 *
 *   1. **Bit order.** GIF packs codes least-significant-bit first; TIFF packs
 *      them most-significant-bit first.
 *   2. **Fixed roots.** TIFF's alphabet is always 256 bytes, so the clear code
 *      is always 256 and the width always starts at 9. GIF's depends on the
 *      image's colour depth.
 *   3. **Early change.** TIFF widens the code *one entry before* the table
 *      actually needs it — at 511, 1023 and 2047 rather than 512, 1024 and 2048.
 *      This is a documented quirk of the original implementation that the spec
 *      then had to bless. A decoder that widens on the round numbers reads
 *      correctly for exactly 253 codes and then produces noise, which is the
 *      single most common way a TIFF LZW decoder is wrong.
 */

const CLEAR_CODE = 256;
const END_CODE = 257;
const FIRST_ENTRY = 258;
const MAX_CODES = 4096;

/** Reads MSB-first codes of a changing width out of a byte array. */
class BitReader {
  #bytes: Uint8Array;
  #buffer = 0;
  #count = 0;
  #position = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  /** Returns `-1` when the stream is exhausted. */
  read(width: number): number {
    while (this.#count < width) {
      if (this.#position >= this.#bytes.length) return -1;
      this.#buffer = (this.#buffer << 8) | this.#bytes[this.#position++]!;
      this.#count += 8;
    }
    this.#count -= width;
    const value = (this.#buffer >>> this.#count) & ((1 << width) - 1);
    // Keep the buffer from overflowing 32 bits over a long stream.
    this.#buffer &= (1 << this.#count) - 1;
    return value;
  }
}

export function lzwDecode(data: Uint8Array, expectedLength: number): Uint8Array {
  const output = new Uint8Array(expectedLength);
  const reader = new BitReader(data);

  const prefix = new Int32Array(MAX_CODES);
  const suffix = new Uint8Array(MAX_CODES);
  const stack = new Uint8Array(MAX_CODES);
  for (let code = 0; code < 256; code += 1) {
    prefix[code] = -1;
    suffix[code] = code;
  }

  let width = 9;
  let next = FIRST_ENTRY;
  let previous = -1;
  let first = 0;
  let written = 0;

  while (written < expectedLength) {
    const code = reader.read(width);
    if (code < 0 || code === END_CODE) break;

    if (code === CLEAR_CODE) {
      width = 9;
      next = FIRST_ENTRY;
      previous = -1;
      continue;
    }

    if (previous === -1) {
      if (code >= 256) break;
      first = suffix[code]!;
      output[written++] = first;
      previous = code;
      continue;
    }

    let top = 0;
    let walk = code;
    if (code >= next) {
      stack[top++] = first;
      walk = previous;
    }
    while (walk >= 256) {
      if (top >= MAX_CODES) return output;
      stack[top++] = suffix[walk]!;
      walk = prefix[walk]!;
      if (walk < 0) return output;
    }
    first = suffix[walk]!;
    stack[top++] = first;

    if (next < MAX_CODES) {
      prefix[next] = previous;
      suffix[next] = first;
      next += 1;
      // Early change — see the module comment. One less than the power of two.
      if (next === 511) width = 10;
      else if (next === 1023) width = 11;
      else if (next === 2047) width = 12;
    }
    previous = code;

    while (top > 0 && written < expectedLength) output[written++] = stack[--top]!;
  }

  return output;
}

/**
 * PackBits: Apple's byte-oriented run-length encoding.
 *
 * A signed length byte says what follows: 0…127 means that many plus one
 * literal bytes, −1…−127 means the next byte repeated that many plus one times,
 * and −128 is a no-op that every encoder avoids and every decoder must skip.
 */
export function packBitsDecode(data: Uint8Array, expectedLength: number): Uint8Array {
  const output = new Uint8Array(expectedLength);
  let read = 0;
  let written = 0;

  while (read < data.length && written < expectedLength) {
    const header = (data[read++]! << 24) >> 24; // to signed

    if (header >= 0) {
      const count = header + 1;
      for (let index = 0; index < count && written < expectedLength; index += 1) {
        if (read >= data.length) return output;
        output[written++] = data[read++]!;
      }
    } else if (header !== -128) {
      if (read >= data.length) return output;
      const value = data[read++]!;
      const count = 1 - header;
      for (let index = 0; index < count && written < expectedLength; index += 1) {
        output[written++] = value;
      }
    }
  }

  return output;
}
