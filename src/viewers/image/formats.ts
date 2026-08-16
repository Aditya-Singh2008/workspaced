/**
 * The format table: every image format this plugin claims, and how each one is
 * decoded.
 *
 * One entry per format, each naming its own module. This is the file AGENTS.md's
 * "registered explicitly … so a misdetected file fails predictably rather than
 * silently" rule lives in, and it enforces that rule in two directions:
 *
 *   - **Outward.** The plugin descriptor's `extensions` and `mimeTypes` are
 *     derived from this table, so the shell's file-type registry is told exactly
 *     which files the image viewer handles. The tempting alternative — claiming
 *     the `image/*` wildcard and sorting it out later — would swallow every
 *     future format the plugin cannot actually open, and the user would get a
 *     broken image tile where they should have got the fallback viewer's honest
 *     "no viewer available".
 *   - **Inward.** {@link resolveFormat} matches on the file's own bytes first
 *     and its extension second, so a JPEG named `.png` opens as a JPEG *and
 *     says so*, and a `.png` that is not any known image fails with the format
 *     it appeared to be rather than with a decoder's internal error.
 *
 * Sharing a folder is allowed where the decode path is genuinely identical —
 * the camera RAW variants all reduce to "find the embedded preview in a
 * TIFF-like or ISOBMFF-like container" — but each variant is still its own row
 * here, because that is what makes the extension list and the error messages
 * name the format the user actually has.
 */

import type { ImageDecoder } from "./decode";

export interface ImageFormat {
  /** Stable id, also the folder name under `image/`. */
  readonly id: string;
  /** Shown in the metadata panel and in error messages. */
  readonly label: string;
  /** Lowercase, no leading dot. */
  readonly extensions: readonly string[];
  /**
   * Every MIME type that means this format. The first is canonical, and the one
   * handed to native decoders and used as the export type.
   */
  readonly mimeTypes: readonly string[];
  /**
   * True when `canvas.toBlob` can *write* this format, making it an option in
   * export's format conversion. Writing is a much shorter list than reading.
   */
  readonly encodable?: boolean;
  /**
   * Recognises the format from its leading bytes. Present for every format with
   * a usable signature; absent only for those without one.
   */
  readonly sniff?: (bytes: Uint8Array) => boolean;
  /**
   * Loads the decoder.
   *
   * Dynamic, and the reason every format is its own module: a session that
   * opens one JPEG parses the JPEG path and nothing else. The plugin's own
   * `mount` is already lazy, so this is the second level of the same idea —
   * without it, opening any image would pull in the TIFF, GIF and RAW decoders
   * too.
   */
  readonly load: () => Promise<{ decode: ImageDecoder }>;
}

const ascii = (text: string, offset = 0) =>
  (bytes: Uint8Array): boolean => {
    if (offset + text.length > bytes.length) return false;
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  };

const magic = (signature: readonly number[], offset = 0) =>
  (bytes: Uint8Array): boolean => {
    if (offset + signature.length > bytes.length) return false;
    for (let index = 0; index < signature.length; index += 1) {
      if (bytes[offset + index] !== signature[index]) return false;
    }
    return true;
  };

/** `ftyp` brands, which is how the ISOBMFF-based formats tell each other apart. */
const ftypBrand = (...brands: readonly string[]) =>
  (bytes: Uint8Array): boolean => {
    if (!ascii("ftyp", 4)(bytes) || bytes.length < 12) return false;
    const major = String.fromCharCode(...bytes.subarray(8, 12));
    if (brands.includes(major)) return true;
    // The compatible-brand list, which is where `mif1`-major HEIC files declare
    // what they really are.
    const limit = Math.min(bytes.length, 64);
    for (let offset = 16; offset + 4 <= limit; offset += 4) {
      const brand = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      if (brands.includes(brand)) return true;
    }
    return false;
  };

const isTiffLike = (bytes: Uint8Array): boolean =>
  magic([0x49, 0x49, 0x2a, 0x00])(bytes) || // little-endian, classic
  magic([0x4d, 0x4d, 0x00, 0x2a])(bytes) || // big-endian, classic
  magic([0x49, 0x49, 0x2b, 0x00])(bytes) || // little-endian, BigTIFF
  magic([0x4d, 0x4d, 0x00, 0x2b])(bytes); //  big-endian, BigTIFF

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const IMAGE_FORMATS: readonly ImageFormat[] = [
  {
    id: "jpeg",
    label: "JPEG",
    extensions: ["jpg", "jpeg", "jpe", "jfif", "jif"],
    mimeTypes: ["image/jpeg", "image/jpg", "image/pjpeg"],
    encodable: true,
    sniff: magic([0xff, 0xd8, 0xff]),
    load: () => import("./jpeg"),
  },
  {
    id: "png",
    label: "PNG",
    extensions: ["png", "apng"],
    mimeTypes: ["image/png", "image/apng"],
    encodable: true,
    sniff: magic([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    load: () => import("./png"),
  },
  {
    id: "bmp",
    label: "BMP",
    extensions: ["bmp", "dib"],
    mimeTypes: ["image/bmp", "image/x-ms-bmp"],
    sniff: magic([0x42, 0x4d]),
    load: () => import("./bmp"),
  },
  {
    id: "tiff",
    label: "TIFF",
    extensions: ["tif", "tiff"],
    mimeTypes: ["image/tiff", "image/x-tiff"],
    // Deliberately below the RAW formats in `resolveFormat`'s sniff order: every
    // TIFF-based RAW file also passes this test.
    sniff: isTiffLike,
    load: () => import("./tiff"),
  },
  {
    id: "webp",
    label: "WebP",
    extensions: ["webp"],
    mimeTypes: ["image/webp"],
    encodable: true,
    sniff: (bytes) => ascii("RIFF")(bytes) && ascii("WEBP", 8)(bytes),
    load: () => import("./webp"),
  },
  {
    id: "gif",
    label: "GIF",
    extensions: ["gif"],
    mimeTypes: ["image/gif"],
    sniff: (bytes) => ascii("GIF87a")(bytes) || ascii("GIF89a")(bytes),
    load: () => import("./gif"),
  },
  {
    id: "ico",
    label: "Icon",
    extensions: ["ico", "cur"],
    mimeTypes: ["image/x-icon", "image/vnd.microsoft.icon"],
    // Reserved-0, then type 1 (icon) or 2 (cursor). Four bytes of very weak
    // signature, which is why this sits near the end of the sniff order.
    sniff: (bytes) =>
      bytes.length >= 6 &&
      bytes[0] === 0 &&
      bytes[1] === 0 &&
      (bytes[2] === 1 || bytes[2] === 2) &&
      bytes[3] === 0,
    load: () => import("./ico"),
  },
  {
    id: "avif",
    label: "AVIF",
    extensions: ["avif", "avifs"],
    mimeTypes: ["image/avif", "image/avif-sequence"],
    sniff: ftypBrand("avif", "avis"),
    load: () => import("./avif"),
  },
  {
    id: "svg",
    label: "SVG",
    extensions: ["svg", "svgz"],
    mimeTypes: ["image/svg+xml"],
    // Text, and legitimately preceded by a BOM, an XML declaration, a doctype or
    // comments — so the signature is "an `<svg` element appears early", not a
    // fixed prefix. `svgz` is gzip and is recognised by its own magic.
    sniff: (bytes) => {
      if (magic([0x1f, 0x8b])(bytes)) return true;
      const head = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1024)));
      return /<svg[\s>]/i.test(head);
    },
    load: () => import("./svg"),
  },
  {
    id: "heic",
    label: "HEIC",
    extensions: ["heic", "heif", "hif", "heics", "heifs"],
    mimeTypes: ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"],
    sniff: ftypBrand("heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"),
    load: () => import("./heic"),
  },

  // --- Camera RAW -----------------------------------------------------------
  // One folder (`raw/`), because the decode path really is identical: locate the
  // largest embedded preview inside a TIFF-like or ISOBMFF-like container and
  // decode that. Each variant is still its own row so the extension list, the
  // metadata panel and the error messages name the format the user has.
  {
    id: "cr2",
    label: "Canon RAW (CR2)",
    extensions: ["cr2", "crw"],
    mimeTypes: ["image/x-canon-cr2", "image/x-canon-crw"],
    load: () => import("./raw"),
  },
  {
    id: "cr3",
    label: "Canon RAW (CR3)",
    extensions: ["cr3"],
    mimeTypes: ["image/x-canon-cr3"],
    sniff: ftypBrand("crx "),
    load: () => import("./raw"),
  },
  {
    id: "nef",
    label: "Nikon RAW (NEF)",
    extensions: ["nef", "nrw"],
    mimeTypes: ["image/x-nikon-nef", "image/x-nikon-nrw"],
    load: () => import("./raw"),
  },
  {
    id: "arw",
    label: "Sony RAW (ARW)",
    extensions: ["arw", "srf", "sr2"],
    mimeTypes: ["image/x-sony-arw", "image/x-sony-srf", "image/x-sony-sr2"],
    load: () => import("./raw"),
  },
  {
    id: "orf",
    label: "Olympus RAW (ORF)",
    extensions: ["orf"],
    mimeTypes: ["image/x-olympus-orf"],
    load: () => import("./raw"),
  },
  {
    id: "rw2",
    label: "Panasonic RAW (RW2)",
    extensions: ["rw2", "raw"],
    mimeTypes: ["image/x-panasonic-rw2", "image/x-panasonic-raw"],
    load: () => import("./raw"),
  },
  {
    id: "dng",
    label: "Adobe DNG",
    extensions: ["dng"],
    mimeTypes: ["image/x-adobe-dng"],
    load: () => import("./raw"),
  },
  {
    id: "raf",
    label: "Fujifilm RAW (RAF)",
    extensions: ["raf"],
    mimeTypes: ["image/x-fuji-raf"],
    sniff: ascii("FUJIFILMCCD-RAW"),
    load: () => import("./raw"),
  },
  {
    id: "pef",
    label: "Pentax RAW (PEF)",
    extensions: ["pef"],
    mimeTypes: ["image/x-pentax-pef"],
    load: () => import("./raw"),
  },
  {
    id: "srw",
    label: "Samsung RAW (SRW)",
    extensions: ["srw"],
    mimeTypes: ["image/x-samsung-srw"],
    load: () => import("./raw"),
  },
];

/** The RAW rows, by id. Used by the sniff order and by `raw/`'s own messages. */
export const RAW_FORMAT_IDS: ReadonlySet<string> = new Set([
  "cr2",
  "cr3",
  "nef",
  "arw",
  "orf",
  "rw2",
  "dng",
  "raf",
  "pef",
  "srw",
]);

export function isRawFormat(format: ImageFormat): boolean {
  return RAW_FORMAT_IDS.has(format.id);
}

// ---------------------------------------------------------------------------
// Derived lists — what the plugin descriptor announces
// ---------------------------------------------------------------------------

export const IMAGE_EXTENSIONS: readonly string[] = [
  ...new Set(IMAGE_FORMATS.flatMap((format) => format.extensions)),
];

export const IMAGE_MIME_TYPES: readonly string[] = [
  ...new Set(IMAGE_FORMATS.flatMap((format) => format.mimeTypes)),
];

/** The formats `canvas.toBlob` can write, which is what export can convert to. */
export const ENCODABLE_FORMATS: readonly ImageFormat[] = IMAGE_FORMATS.filter(
  (format) => format.encodable,
);

export function formatById(id: string): ImageFormat | undefined {
  return IMAGE_FORMATS.find((format) => format.id === id);
}

export function formatForExtension(extension: string | undefined): ImageFormat | undefined {
  if (!extension) return undefined;
  const wanted = extension.toLowerCase();
  return IMAGE_FORMATS.find((format) => format.extensions.includes(wanted));
}

export function formatForMimeType(mimeType: string | undefined): ImageFormat | undefined {
  if (!mimeType) return undefined;
  const wanted = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return IMAGE_FORMATS.find((format) => format.mimeTypes.includes(wanted));
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Sniff order.
 *
 * Signatures are not equally strong, and two of them overlap by construction:
 * every TIFF-based RAW file is also a valid TIFF, and ICO's signature is four
 * bytes of which three are zero. So the specific formats are tested before the
 * general ones, and the weak one is tested last — the order is the disambiguation
 * rule, and writing it down here is cheaper than a priority field on twenty rows.
 *
 * The TIFF-based RAW formats have no signature of their own to test *with*, which
 * is exactly why they rely on the extension and why `resolveFormat` keeps the
 * extension's answer when the bytes only say "TIFF".
 */
const SNIFF_ORDER: readonly string[] = [
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "heic",
  "cr3",
  "raf",
  "svg",
  "bmp",
  "tiff",
  "ico",
];

export interface FormatResolution {
  readonly format: ImageFormat;
  /** How it was decided. Surfaced in the metadata panel and the notes. */
  readonly matchedBy: "content" | "extension" | "mime" | "fallback";
  /**
   * Set when the bytes and the file name disagree — a JPEG named `.png`. The
   * content wins, and this sentence is shown to the user, because a file whose
   * name lies about its type is worth knowing about and silently coping is how
   * you end up debugging the wrong thing.
   */
  readonly mismatch?: string;
}

/**
 * Picks the format for a file, from its bytes first and its name second.
 *
 * Content wins because it is the thing that has to decode. The extension is
 * consulted when the bytes are inconclusive, which is the normal case for the
 * TIFF-based RAW formats — a `.nef` and a `.tif` have byte-for-byte the same
 * header, and only the name distinguishes them.
 */
export function resolveFormat(file: {
  readonly bytes: Uint8Array;
  readonly extension?: string;
  readonly mimeType?: string;
}): FormatResolution | null {
  const byName = formatForExtension(file.extension) ?? formatForMimeType(file.mimeType);

  let sniffed: ImageFormat | undefined;
  for (const id of SNIFF_ORDER) {
    const format = formatById(id);
    if (format?.sniff?.(file.bytes)) {
      sniffed = format;
      break;
    }
  }

  if (sniffed) {
    // The bytes say TIFF and the name says NEF: both are true, and the name is
    // the more specific answer. Same for a DNG, an ARW, an ORF — every
    // TIFF-container RAW.
    if (sniffed.id === "tiff" && byName && isRawFormat(byName)) {
      return { format: byName, matchedBy: "extension" };
    }
    if (byName && byName.id !== sniffed.id) {
      return {
        format: sniffed,
        matchedBy: "content",
        mismatch: `named .${file.extension ?? "?"} but contains ${sniffed.label} data`,
      };
    }
    return { format: sniffed, matchedBy: "content" };
  }

  if (byName) {
    return {
      format: byName,
      matchedBy: formatForExtension(file.extension) ? "extension" : "mime",
    };
  }

  return null;
}
