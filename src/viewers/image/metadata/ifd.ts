/**
 * TIFF image file directories — the structure underneath TIFF, EXIF and every
 * TIFF-based camera RAW format.
 *
 * It lives in `metadata/` rather than in `tiff/` because three separate parts of
 * this plugin read it and none of them owns it: the TIFF decoder needs it for
 * strip offsets and pixel layout, the RAW modules need it to find the embedded
 * preview, and the EXIF panel needs it for everything a camera recorded. Putting
 * it inside any one format's folder would make the other two import across
 * formats, which AGENTS.md's file-organization rule exists to prevent.
 *
 * ## The structure, briefly
 *
 * A header declares the byte order (`II` or `MM`) and points at the first
 * directory. A directory is a count, that many 12-byte entries, and a pointer to
 * the next directory — so directories form a chain, which is how a TIFF holds
 * more than one image and how a RAW file holds its previews. Each entry is a
 * tag, a type, a count, and either the value itself or a pointer to it,
 * depending on whether it fits in four bytes.
 *
 * Two things make a naive reader fail on real files:
 *
 *   - **Offsets are absolute from the start of the TIFF header**, which is *not*
 *     the start of the file when the structure is embedded — an EXIF block
 *     inside a JPEG's APP1 segment, for instance. Hence {@link IfdReader}'s
 *     `base`.
 *   - **Pointers can be circular or absurd.** These files come from cameras,
 *     card readers and half-finished transfers. Every traversal here is bounded
 *     and every offset is checked, because the alternative is a viewer that
 *     hangs on a corrupt file rather than reporting one.
 */

import { ByteReader } from "../binary";

export const IFD_TYPE_SIZES: Readonly<Record<number, number>> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};

export interface IfdEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Where the value bytes are, absolute within the reader's buffer. */
  readonly offset: number;
}

export type Ifd = ReadonlyMap<number, IfdEntry>;

/** Bounds on traversal, so a corrupt or hostile file cannot spin. */
const MAX_DIRECTORIES = 32;
const MAX_ENTRIES_PER_DIRECTORY = 512;

export class IfdReader {
  readonly bytes: Uint8Array;
  readonly littleEndian: boolean;
  /** Offset of the TIFF header, which every internal pointer is relative to. */
  readonly base: number;

  constructor(bytes: Uint8Array, littleEndian: boolean, base: number) {
    this.bytes = bytes;
    this.littleEndian = littleEndian;
    this.base = base;
  }

  /**
   * Recognises a TIFF header and returns a reader positioned on it.
   *
   * `base` is where the header starts — zero for a `.tif`, and the offset of
   * the `Exif\0\0` payload for a JPEG's APP1 segment.
   */
  static open(bytes: Uint8Array, base = 0): { reader: IfdReader; firstIfd: number } | null {
    if (base + 8 > bytes.length) return null;
    const marker = (bytes[base]! << 8) | bytes[base + 1]!;
    const littleEndian = marker === 0x4949; // "II"
    if (!littleEndian && marker !== 0x4d4d) return null; // not "MM" either

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint16(base + 2, littleEndian);
    // 42 is classic TIFF. 43 is BigTIFF, whose offsets are 64-bit and whose
    // directory layout differs; it is recognised so the caller can say so
    // rather than misparse it as classic.
    if (magic !== 42) return null;

    const firstIfd = view.getUint32(base + 4, littleEndian);
    return { reader: new IfdReader(bytes, littleEndian, base), firstIfd };
  }

  /** Reads one directory. Returns `null` when the offset is not usable. */
  readIfd(offset: number): { entries: Ifd; next: number } | null {
    const at = this.base + offset;
    if (offset <= 0 || at + 2 > this.bytes.length) return null;

    const reader = new ByteReader(this.bytes, {
      littleEndian: this.littleEndian,
      offset: at,
    });

    try {
      const count = reader.u16();
      if (count === 0 || count > MAX_ENTRIES_PER_DIRECTORY) return null;

      const entries = new Map<number, IfdEntry>();
      for (let index = 0; index < count; index += 1) {
        const tag = reader.u16();
        const type = reader.u16();
        const valueCount = reader.u32();
        const size = (IFD_TYPE_SIZES[type] ?? 0) * valueCount;

        // Four bytes or fewer live in the entry itself; anything larger is a
        // pointer. Getting this backwards is the classic EXIF parsing bug — it
        // reads a small value as an offset into the middle of the file.
        const valueOffset =
          size > 4 ? this.base + reader.u32() : ((reader.skip(4), reader.offset - 4));

        entries.set(tag, { tag, type, count: valueCount, offset: valueOffset });
      }

      const next = reader.remaining >= 4 ? reader.u32() : 0;
      return { entries, next };
    } catch {
      return null;
    }
  }

  /** Every directory in the chain starting at `offset`, bounded and cycle-safe. */
  readChain(offset: number): Ifd[] {
    const directories: Ifd[] = [];
    const seen = new Set<number>();
    let at = offset;

    while (at > 0 && directories.length < MAX_DIRECTORIES && !seen.has(at)) {
      seen.add(at);
      const result = this.readIfd(at);
      if (!result) break;
      directories.push(result.entries);
      at = result.next;
    }
    return directories;
  }

  // -------------------------------------------------------------------------
  // Values
  // -------------------------------------------------------------------------

  /** An entry's numeric values. Empty when the type is not numeric or is unreadable. */
  numbers(entry: IfdEntry | undefined): number[] {
    if (!entry) return [];
    const size = IFD_TYPE_SIZES[entry.type];
    if (!size) return [];
    if (entry.offset + size * entry.count > this.bytes.length) return [];

    const reader = new ByteReader(this.bytes, {
      littleEndian: this.littleEndian,
      offset: entry.offset,
    });
    const out: number[] = [];

    try {
      for (let index = 0; index < entry.count; index += 1) {
        switch (entry.type) {
          case 1:
          case 7:
            out.push(reader.u8());
            break;
          case 6:
            out.push((reader.u8() << 24) >> 24);
            break;
          case 3:
            out.push(reader.u16());
            break;
          case 8:
            out.push(reader.i16());
            break;
          case 4:
          case 13:
            out.push(reader.u32());
            break;
          case 9:
            out.push(reader.i32());
            break;
          case 5: {
            const numerator = reader.u32();
            const denominator = reader.u32();
            out.push(denominator === 0 ? 0 : numerator / denominator);
            break;
          }
          case 10: {
            const numerator = reader.i32();
            const denominator = reader.i32();
            out.push(denominator === 0 ? 0 : numerator / denominator);
            break;
          }
          case 11:
            out.push(reader.f32());
            break;
          case 12:
            out.push(reader.f64());
            break;
          default:
            return out;
        }
      }
    } catch {
      // A truncated value array: return what was read.
    }
    return out;
  }

  /** The first numeric value, or `undefined`. The common case for most tags. */
  number(entry: IfdEntry | undefined): number | undefined {
    return this.numbers(entry)[0];
  }

  /**
   * A rational as its two parts, which some tags need unreduced — a shutter
   * speed is `1/250`, and `0.004` is the same number and the wrong answer.
   */
  rational(entry: IfdEntry | undefined): { numerator: number; denominator: number } | null {
    if (!entry || (entry.type !== 5 && entry.type !== 10)) return null;
    if (entry.offset + 8 > this.bytes.length) return null;
    const reader = new ByteReader(this.bytes, {
      littleEndian: this.littleEndian,
      offset: entry.offset,
    });
    try {
      return entry.type === 5
        ? { numerator: reader.u32(), denominator: reader.u32() }
        : { numerator: reader.i32(), denominator: reader.i32() };
    } catch {
      return null;
    }
  }

  /** An ASCII entry, trimmed of its NUL terminator and surrounding space. */
  text(entry: IfdEntry | undefined): string | undefined {
    if (!entry) return undefined;
    if (entry.offset + entry.count > this.bytes.length) return undefined;
    const raw = this.bytes.subarray(entry.offset, entry.offset + entry.count);
    let end = raw.length;
    while (end > 0 && (raw[end - 1] === 0 || raw[end - 1] === 0x20)) end -= 1;
    if (end === 0) return undefined;
    // Latin-1 rather than UTF-8: the ASCII type is specified as 7-bit, and
    // cameras that exceed it overwhelmingly use the host code page. Decoding as
    // UTF-8 turns those bytes into replacement characters; Latin-1 at least
    // shows something recognisable.
    return new TextDecoder("windows-1252", { fatal: false })
      .decode(raw.subarray(0, end))
      .trim();
  }

  /** The raw bytes an entry points at, bounded to the buffer. */
  raw(entry: IfdEntry | undefined): Uint8Array | undefined {
    if (!entry) return undefined;
    const size = (IFD_TYPE_SIZES[entry.type] ?? 1) * entry.count;
    if (entry.offset + size > this.bytes.length) return undefined;
    return this.bytes.subarray(entry.offset, entry.offset + size);
  }
}

// ---------------------------------------------------------------------------
// Tags this plugin reads by name
// ---------------------------------------------------------------------------

export const TIFF_TAG = {
  imageWidth: 256,
  imageHeight: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  imageDescription: 270,
  make: 271,
  model: 272,
  stripOffsets: 273,
  orientation: 274,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  xResolution: 282,
  yResolution: 283,
  planarConfiguration: 284,
  resolutionUnit: 296,
  software: 305,
  dateTime: 306,
  artist: 315,
  predictor: 317,
  colorMap: 320,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  subIfds: 330,
  extraSamples: 338,
  sampleFormat: 339,
  jpegInterchangeFormat: 513,
  jpegInterchangeFormatLength: 514,
  yCbCrSubSampling: 530,
  copyright: 33432,
  exifIfd: 34665,
  gpsIfd: 34853,
  iccProfile: 34675,
  xmp: 700,
  iptc: 33723,
  photoshop: 34377,
  newSubfileType: 254,
} as const;

export const EXIF_TAG = {
  exposureTime: 33434,
  fNumber: 33437,
  exposureProgram: 34850,
  isoSpeed: 34855,
  photographicSensitivity: 34855,
  dateTimeOriginal: 36867,
  dateTimeDigitized: 36868,
  shutterSpeedValue: 37377,
  apertureValue: 37378,
  exposureBias: 37380,
  meteringMode: 37383,
  flash: 37385,
  focalLength: 37386,
  colorSpace: 40961,
  pixelXDimension: 40962,
  pixelYDimension: 40963,
  focalLength35mm: 41989,
  lensMake: 42035,
  lensModel: 42036,
  bodySerialNumber: 42033,
} as const;

export const GPS_TAG = {
  latitudeRef: 1,
  latitude: 2,
  longitudeRef: 3,
  longitude: 4,
  altitudeRef: 5,
  altitude: 6,
  timestamp: 7,
  datestamp: 29,
} as const;
