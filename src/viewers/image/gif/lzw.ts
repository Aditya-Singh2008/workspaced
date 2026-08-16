/**
 * GIF's variable-width LZW, as specified in the GIF89a spec's appendix F.
 *
 * Separate from `index.ts` because it is the one genuinely intricate piece of
 * the format and it is worth reading on its own. Everything else about a GIF is
 * a struct.
 *
 * Two things distinguish this from textbook LZW, and both are the source of the
 * classic "the image decodes as noise from row 40" bug:
 *
 *   1. **Codes are little-endian bit-packed across byte boundaries.** A 9-bit
 *      code straddles two bytes with the *low* bits in the earlier byte.
 *   2. **The code width grows one bit at a time**, when the next free dictionary
 *      slot reaches the current width's ceiling, and resets on every clear code.
 *      An encoder may emit clear codes at any point, and a decoder that assumes
 *      one only at the start desynchronizes at the first one.
 *
 * The `code === next` case is the other half of LZW's reputation: it is legal
 * for an encoder to reference the entry it is *about to* create, which happens
 * whenever a run repeats immediately. The string is then the previous string
 * plus its own first byte, which is what the `stack[top++] = first` branch
 * builds.
 *
 * Truncation is normal rather than exceptional — a GIF cut short by a failed
 * download still has whole frames at the front — so running out of input
 * returns what was decoded instead of throwing. The caller renders the partial
 * frame, which is what every other GIF decoder does.
 */

const MAX_CODES = 4096;
const MAX_CODE_SIZE = 12;

/**
 * Expands one frame's LZW data into `pixelCount` palette indices.
 *
 * `minCodeSize` is the byte that precedes the data sub-blocks in the file, and
 * `data` is those sub-blocks already concatenated (the block structure is
 * framing, not part of the code stream — a single code may span two sub-blocks).
 */
export function lzwDecode(
  data: Uint8Array,
  minCodeSize: number,
  pixelCount: number,
): Uint8Array {
  const output = new Uint8Array(pixelCount);
  if (minCodeSize < 2 || minCodeSize > 11) return output;

  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const prefix = new Int32Array(MAX_CODES);
  const suffix = new Uint8Array(MAX_CODES);
  const stack = new Uint8Array(MAX_CODES);
  for (let code = 0; code < clearCode; code += 1) {
    prefix[code] = -1;
    suffix[code] = code;
  }

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let previous = -1;
  let first = 0;

  let bitBuffer = 0;
  let bitCount = 0;
  let position = 0;
  let written = 0;

  while (written < pixelCount) {
    while (bitCount < codeSize) {
      if (position >= data.length) return output;
      bitBuffer |= data[position++]! << bitCount;
      bitCount += 8;
    }

    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      next = endCode + 1;
      previous = -1;
      continue;
    }
    if (code === endCode) break;

    if (previous === -1) {
      // The first code after a clear is always a root, and using the general
      // path for it would dereference `prefix[-1]`.
      if (code >= clearCode) break;
      first = suffix[code]!;
      output[written++] = first;
      previous = code;
      continue;
    }

    let top = 0;
    let walk = code;
    if (code >= next) {
      // The about-to-be-created entry: previous string, then its first byte.
      stack[top++] = first;
      walk = previous;
    }
    // Chase the prefix chain back to a root, pushing suffixes as we go — which
    // yields the string reversed, hence the stack.
    while (walk >= clearCode) {
      if (top >= MAX_CODES) return output; // a cyclic chain: corrupt data
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
      // A power of two is the ceiling of the current width. `next` only ever
      // increases from `clearCode + 2`, so the first one it meets is the right
      // one.
      if ((next & (next - 1)) === 0 && codeSize < MAX_CODE_SIZE) codeSize += 1;
    }
    previous = code;

    while (top > 0 && written < pixelCount) output[written++] = stack[--top]!;
  }

  return output;
}
