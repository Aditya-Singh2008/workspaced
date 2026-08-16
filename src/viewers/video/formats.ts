/**
 * The container table: every video container this plugin claims, and how each
 * one is read.
 *
 * The exact counterpart of `viewers/image/formats.ts`, and it enforces the same
 * rule in the same two directions (AGENTS.md: "registered explicitly with
 * `registry.ts`, so a misdetected file fails predictably rather than silently"):
 *
 *   - **Outward.** The plugin descriptor's `extensions` and `mimeTypes` are
 *     derived from this table. The plugin does not claim the `video/*` wildcard,
 *     for exactly the reason the image plugin does not claim `image/*`: a
 *     wildcard swallows every container that exists now or later, including the
 *     ones no webview on any of the three platforms can open, and the user gets
 *     a broken player where the fallback viewer's honest "no viewer available"
 *     belongs.
 *   - **Inward.** {@link resolveContainer} matches on the file's own bytes
 *     first and its extension second, so a Matroska file named `.mp4` is
 *     recognised as Matroska *and says so*.
 *
 * ## Container and codec are different questions, and both get asked
 *
 * This table answers the first: what *kind of box* the file is. It says nothing
 * about whether this machine can play what is inside the box, which is
 * `codecs.ts`'s job and is a per-platform, per-file question. Keeping them apart
 * is what lets the plugin tell a user "this is a Matroska file and this build of
 * the webview has no HEVC decoder" rather than "unsupported file".
 *
 * ## `mp4` and `mov` are one byte format and two rows
 *
 * QuickTime and MP4 are both ISOBMFF and share a box parser — the same
 * relationship the camera RAW formats have with TIFF in the image plugin, which
 * AGENTS.md permits ("formats sharing an identical decode path may share one
 * subfolder"). They are *not* sharing a folder here, because the phase brief
 * names `video/mp4/` and `video/mov/` separately and because the two genuinely
 * differ above the box layer: QuickTime carries chapters as a `chap`-referenced
 * text track and MP4 as a `chpl` list, and MOV's codec fourccs include a whole
 * generation of formats no webview will play. The shared half lives in
 * `metadata/isobmff.ts`, which is where `metadata/ifd.ts` lives in the image
 * plugin and for the same reason.
 */

import type { ContainerParser } from "./container";

export interface VideoFormat {
  /** Stable id, also the folder name under `video/`. */
  readonly id: string;
  /** Shown in the metadata panel and in error messages. */
  readonly label: string;
  /** Lowercase, no leading dot. */
  readonly extensions: readonly string[];
  /**
   * Every MIME type that means this container. The first is canonical and is
   * the one handed to `canPlayType` when a codec parameter is added to it.
   */
  readonly mimeTypes: readonly string[];
  /** Recognises the container from its leading bytes. */
  readonly sniff?: (bytes: Uint8Array) => boolean;
  /**
   * Loads the container parser.
   *
   * Dynamic, and the reason each container is its own module: opening an MP4
   * parses the ISOBMFF path and nothing else. The plugin's own `mount` is
   * already lazy, so this is the second level of the same idea — the one
   * `viewers/image/formats.ts` established.
   */
  readonly load: () => Promise<{ parse: ContainerParser }>;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

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

/**
 * The `ftyp` brand list, which is how the ISOBMFF containers tell each other
 * apart.
 *
 * The major brand at offset 8 and the compatible brands after it are both
 * checked, because a file whose major brand is `isom` routinely declares
 * `qt  ` or `M4V ` in the compatible list and that is where its real identity
 * is. Bounded at 64 bytes: the list is short by construction and an unbounded
 * scan over a hostile file is a scan over the whole file.
 */
function ftypBrand(...brands: readonly string[]) {
  return (bytes: Uint8Array): boolean => {
    if (!ascii("ftyp", 4)(bytes) || bytes.length < 12) return false;
    const limit = Math.min(bytes.length, 64);
    for (let offset = 8; offset + 4 <= limit; offset += 4) {
      const brand = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      if (brands.includes(brand)) return true;
    }
    return false;
  };
}

/** Any ISOBMFF file: an `ftyp` box, whatever it claims to be. */
const isIsobmff = ascii("ftyp", 4);

/**
 * A QuickTime file with no `ftyp` box at all.
 *
 * Files written before the brand was specified — and files written by some
 * capture hardware since — start straight in with `moov`, `mdat`, `wide`, `free`
 * or `pnot`. There is no other signature to go on, so the check is "the first
 * box has a plausible size and a QuickTime-only type", which is weak enough that
 * this sits at the end of the sniff order.
 */
function isBareQuickTime(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const size = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
  if (size < 8) return false;
  const type = String.fromCharCode(...bytes.subarray(4, 8));
  return ["moov", "mdat", "wide", "free", "skip", "pnot"].includes(type);
}

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/**
 * WebM and Matroska are the same byte format distinguished by one string.
 *
 * `DocType` is an EBML element inside the header, so strictly it should be
 * parsed. It is a short ASCII literal within the first few dozen bytes of every
 * real file, and searching a bounded prefix for it is both correct in practice
 * and immune to a malformed header that would make a strict parse throw — which
 * matters here, because sniffing runs *before* anything has decided the file is
 * trustworthy.
 */
function ebmlDocType(bytes: Uint8Array, docType: string): boolean {
  if (!magic(EBML_MAGIC)(bytes)) return false;
  const limit = Math.min(bytes.length, 256);
  for (let offset = 4; offset + docType.length <= limit; offset += 1) {
    if (ascii(docType, offset)(bytes)) {
      // The byte before the string has to be the element's size, so that the
      // literal is a `DocType` value rather than four characters that happened
      // to appear inside something else — `webm` turns up in a Matroska file's
      // `DocTypeExtensionName` in rare muxes.
      //
      // An EBML size is a variable-length integer whose leading one-bit says how
      // wide it is, so a one-byte size of `n` is `0x80 | n` — never a small
      // integer, which is what an earlier version of this check looked for and
      // is why it matched nothing. Writers routinely declare a length longer
      // than the string and pad with NULs, so the length has to be *at least*
      // the string's rather than equal to it.
      const previous = bytes[offset - 1] ?? 0;
      const declared = previous - 0x80;
      if (previous >= 0x80 && declared >= docType.length && declared <= docType.length + 8) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const VIDEO_FORMATS: readonly VideoFormat[] = [
  {
    id: "mp4",
    label: "MP4",
    extensions: ["mp4", "m4v", "mp4v", "m4p"],
    mimeTypes: ["video/mp4", "video/x-m4v", "application/mp4"],
    sniff: ftypBrand(
      "isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ",
      "M4VP", "dash", "mp71", "cmfc", "av01",
    ),
    load: () => import("./mp4"),
  },
  {
    id: "mov",
    label: "QuickTime",
    extensions: ["mov", "qt"],
    mimeTypes: ["video/quicktime"],
    // Tested before `mp4` in the sniff order: a QuickTime file's major brand is
    // `qt  ` and its compatible list frequently also contains `isom`.
    sniff: (bytes) => ftypBrand("qt  ")(bytes) || isBareQuickTime(bytes),
    load: () => import("./mov"),
  },
  {
    id: "webm",
    label: "WebM",
    extensions: ["webm"],
    mimeTypes: ["video/webm"],
    sniff: (bytes) => ebmlDocType(bytes, "webm"),
    load: () => import("./webm"),
  },
  {
    id: "mkv",
    label: "Matroska",
    extensions: ["mkv", "mk3d", "mks"],
    mimeTypes: ["video/x-matroska", "video/matroska"],
    sniff: (bytes) => ebmlDocType(bytes, "matroska"),
    load: () => import("./mkv"),
  },
  {
    id: "avi",
    label: "AVI",
    extensions: ["avi", "divx"],
    mimeTypes: ["video/x-msvideo", "video/avi", "video/msvideo"],
    sniff: (bytes) => ascii("RIFF")(bytes) && ascii("AVI ", 8)(bytes),
    load: () => import("./avi"),
  },
  {
    id: "ogv",
    label: "Ogg",
    // `.ogg` is deliberately absent. It means an Ogg *audio* file far more often
    // than a video one, and claiming it would put every Vorbis file in a video
    // tile showing a black rectangle. `.ogx` is the multiplexed-stream extension
    // and is claimed, because a video stream is the usual reason for one.
    extensions: ["ogv", "ogm", "ogx"],
    mimeTypes: ["video/ogg", "application/ogg"],
    sniff: ascii("OggS"),
    load: () => import("./ogv"),
  },
];

// ---------------------------------------------------------------------------
// Derived lists — what the plugin descriptor announces
// ---------------------------------------------------------------------------

export const VIDEO_EXTENSIONS: readonly string[] = [
  ...new Set(VIDEO_FORMATS.flatMap((format) => format.extensions)),
];

export const VIDEO_MIME_TYPES: readonly string[] = [
  ...new Set(VIDEO_FORMATS.flatMap((format) => format.mimeTypes)),
];

export function formatById(id: string): VideoFormat | undefined {
  return VIDEO_FORMATS.find((format) => format.id === id);
}

export function formatForExtension(extension: string | undefined): VideoFormat | undefined {
  if (!extension) return undefined;
  const wanted = extension.toLowerCase();
  return VIDEO_FORMATS.find((format) => format.extensions.includes(wanted));
}

export function formatForMimeType(mimeType: string | undefined): VideoFormat | undefined {
  if (!mimeType) return undefined;
  const wanted = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return VIDEO_FORMATS.find((format) => format.mimeTypes.includes(wanted));
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Sniff order.
 *
 * The specific signatures before the general ones, exactly as the image plugin's
 * order does, and for the same reason: two of these overlap by construction.
 * Every QuickTime file with an `ftyp` box is also a plausible MP4, and a bare
 * QuickTime file has no signature at all beyond a box type — so `mov`'s branded
 * test runs before `mp4`, and its unbranded test runs last of everything.
 *
 * WebM and Matroska cannot both match, since the test is on `DocType`, so their
 * relative order carries no meaning.
 */
const SNIFF_ORDER: readonly string[] = ["avi", "ogv", "webm", "mkv", "mov", "mp4"];

export interface ContainerResolution {
  readonly format: VideoFormat;
  readonly matchedBy: "content" | "extension" | "mime";
  /**
   * Set when the bytes and the file name disagree. The content wins and this
   * sentence is shown, because a file whose name lies about its container is
   * worth knowing about — it is the usual reason a file "that plays everywhere
   * else" does not play here.
   */
  readonly mismatch?: string;
}

/**
 * Picks the container for a file, from its bytes first and its name second.
 *
 * Content wins because it is the thing that has to play. Unlike the image
 * plugin there is no exception to that rule: no container here shares a header
 * with another and relies on its extension to disambiguate, so a name that
 * disagrees with the bytes is always the name being wrong.
 */
export function resolveContainer(file: {
  readonly bytes: Uint8Array;
  readonly extension?: string;
  readonly mimeType?: string;
}): ContainerResolution | null {
  const byName = formatForExtension(file.extension) ?? formatForMimeType(file.mimeType);

  let sniffed: VideoFormat | undefined;
  for (const id of SNIFF_ORDER) {
    const format = formatById(id);
    if (format?.sniff?.(file.bytes)) {
      sniffed = format;
      break;
    }
  }

  if (sniffed) {
    if (byName && byName.id !== sniffed.id) {
      return {
        format: sniffed,
        matchedBy: "content",
        mismatch: `named .${file.extension ?? "?"} but contains ${sniffed.label} data`,
      };
    }
    return { format: sniffed, matchedBy: "content" };
  }

  // An ISOBMFF file whose brand is in nobody's list. It is one of the two
  // formats in this table that it could be, and MP4 is overwhelmingly the more
  // likely — but the extension knows better if it has an opinion.
  if (isIsobmff(file.bytes)) {
    const format = byName?.id === "mov" ? byName : formatById("mp4")!;
    return { format, matchedBy: byName ? "extension" : "content" };
  }

  if (byName) {
    return {
      format: byName,
      matchedBy: formatForExtension(file.extension) ? "extension" : "mime",
    };
  }

  return null;
}
