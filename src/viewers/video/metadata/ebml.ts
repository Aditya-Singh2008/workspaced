/**
 * The EBML element reader, shared by `webm/` and `mkv/`.
 *
 * WebM is a profile of Matroska — a restricted codec list and a couple of
 * forbidden elements — so the two format folders share this reader for exactly
 * the reason `mp4/` and `mov/` share `isobmff.ts`, and differ above it in what
 * they can say about what they found.
 *
 * ## EBML in one paragraph
 *
 * Every element is a variable-length id, a variable-length size, and a payload.
 * Both lengths are encoded the same way: the number of leading zero bits in the
 * first byte gives the total width, and the first set bit is a marker. Ids keep
 * their marker bit (so `0x1A45DFA3` is written as those four bytes); sizes strip
 * it. A size whose value bits are all ones means "unknown", which live-muxed
 * files use for the top-level Segment and which is the single most common reason
 * a naive parser walks off the end of a real file.
 *
 * ## Bounded, because the header is not the file
 *
 * A Matroska file's interesting elements — `Info`, `Tracks`, `Chapters` — sit at
 * the front, ahead of the clusters that are the actual film. This reader walks
 * the Segment's children by *header*, using ranged reads, and pulls only those
 * three whole. So parsing a four-gigabyte `.mkv` costs a few tens of kilobytes,
 * and a `Cluster` element four gigabytes long is skipped by arithmetic rather
 * than read.
 */

import type { FileHandle } from "../../../files";
import type { Chapter, ContainerTrack, TrackKind } from "../container";
import {
  avcCodecString,
  av1CodecString,
  hevcCodecString,
  vp9CodecString,
} from "./isobmff";

export interface EbmlElement {
  /** The element id, marker bit included: `0x1654AE6B` for Tracks. */
  readonly id: number;
  /** Offset of the id's first byte. */
  readonly start: number;
  /** Offset of the first payload byte. */
  readonly bodyStart: number;
  /**
   * Offset one past the payload, or `null` for the "unknown size" encoding —
   * which is legal, means "until the next element that cannot be a child", and
   * is what live muxers write for the Segment.
   */
  readonly end: number | null;
}

/** Ids longer than this are malformed; the longest real one is four bytes. */
const MAX_ID_BYTES = 4;
/** Sizes are up to eight bytes, one of which is consumed by the marker. */
const MAX_SIZE_BYTES = 8;

/** How many bytes a variable-length integer occupies, from its first byte. */
function widthOf(first: number): number {
  for (let width = 1; width <= 8; width += 1) {
    if (first & (0x80 >> (width - 1))) return width;
  }
  return 0;
}

/**
 * Reads one element header at `at`.
 *
 * `null` for anything that does not parse: too few bytes, a first byte of zero
 * (which encodes a width greater than eight and cannot occur in a valid file),
 * or a size that would run past `limit`. A caller that gets `null` stops
 * walking, which is the only safe response — an EBML stream gives no way to
 * resynchronise after a bad length.
 */
export function readElement(
  bytes: Uint8Array,
  at: number,
  limit = bytes.length,
): EbmlElement | null {
  if (at >= limit) return null;

  const idWidth = widthOf(bytes[at] ?? 0);
  if (idWidth === 0 || idWidth > MAX_ID_BYTES || at + idWidth > limit) return null;

  let id = 0;
  for (let index = 0; index < idWidth; index += 1) {
    // Ids keep their marker bit, which is what makes `0x1A45DFA3` the literal
    // written in every specification. `>>> 0` because a four-byte id has its
    // top bit set and would otherwise come out negative.
    id = ((id << 8) | bytes[at + index]!) >>> 0;
  }

  const sizeAt = at + idWidth;
  if (sizeAt >= limit) return null;
  const sizeWidth = widthOf(bytes[sizeAt] ?? 0);
  if (sizeWidth === 0 || sizeWidth > MAX_SIZE_BYTES || sizeAt + sizeWidth > limit) return null;

  // The marker bit is stripped from a size, unlike an id.
  let size = bytes[sizeAt]! & (0xff >> sizeWidth);
  let allOnes = size === 0xff >> sizeWidth;
  for (let index = 1; index < sizeWidth; index += 1) {
    const byte = bytes[sizeAt + index]!;
    size = size * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }

  const bodyStart = sizeAt + sizeWidth;
  return {
    id,
    start: at,
    bodyStart,
    end: allOnes ? null : bodyStart + size,
  };
}

/** Every element directly inside `[start, end)`. Does not recurse. */
export function* elementsIn(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): Generator<EbmlElement> {
  let at = start;
  while (at < end) {
    const element = readElement(bytes, at, end);
    if (!element) return;
    yield element;
    // An unknown-size child inside a buffer cannot be walked past: there is no
    // length to advance by, and guessing would produce elements at arbitrary
    // offsets. Stopping is the honest response.
    if (element.end === null || element.end <= at || element.end > end) return;
    at = element.end;
  }
}

export function findElement(
  bytes: Uint8Array,
  id: number,
  start = 0,
  end = bytes.length,
): EbmlElement | null {
  for (const element of elementsIn(bytes, start, end)) {
    if (element.id === id) return element;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/** An unsigned integer payload, big-endian and of whatever length it happens to be. */
export function uintValue(bytes: Uint8Array, element: EbmlElement): number | undefined {
  const end = element.end ?? bytes.length;
  if (end <= element.bodyStart || end - element.bodyStart > 8) return undefined;
  let value = 0;
  for (let at = element.bodyStart; at < end; at += 1) {
    value = value * 256 + bytes[at]!;
  }
  return value;
}

/**
 * A float payload, which EBML stores as four or eight IEEE bytes.
 *
 * Duration is written as a float, and it is one of the few places in these
 * containers where a length of zero is legal and means "use the default" — so a
 * length this does not recognise comes back `undefined` rather than as zero,
 * which would read as a zero-length film.
 */
export function floatValue(bytes: Uint8Array, element: EbmlElement): number | undefined {
  const end = element.end ?? bytes.length;
  const length = end - element.bodyStart;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (length === 4) return view.getFloat32(element.bodyStart, false);
  if (length === 8) return view.getFloat64(element.bodyStart, false);
  return undefined;
}

export function stringValue(bytes: Uint8Array, element: EbmlElement): string | undefined {
  const end = element.end ?? bytes.length;
  if (end <= element.bodyStart) return undefined;
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(element.bodyStart, end))
    // Fixed-width string elements are NUL-padded, and the padding survives a
    // UTF-8 decode as invisible characters that break every comparison.
    .replace(/\0+$/, "");
  return text || undefined;
}

// ---------------------------------------------------------------------------
// Locating the header elements
// ---------------------------------------------------------------------------

/** The ids this plugin looks for. Everything else is skipped by arithmetic. */
export const EBML_ID = {
  header: 0x1a45dfa3,
  docType: 0x4282,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  title: 0x7ba9,
  muxingApp: 0x4d80,
  writingApp: 0x5741,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  trackName: 0x536e,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  language: 0x22b59c,
  languageBcp47: 0x22b59d,
  flagDefault: 0x88,
  flagForced: 0x55aa,
  flagEnabled: 0xb9,
  defaultDuration: 0x23e383,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  displayWidth: 0x54b0,
  displayHeight: 0x54ba,
  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  chapters: 0x1043a770,
  editionEntry: 0x45b9,
  editionFlagHidden: 0x45bd,
  chapterAtom: 0xb6,
  chapterTimeStart: 0x91,
  chapterFlagHidden: 0x98,
  chapterDisplay: 0x80,
  chapterString: 0x85,
  cluster: 0x1f43b675,
} as const;

/** How much of a header element is worth reading. `Tracks` is the largest. */
const MAX_ELEMENT_BYTES = 8 * 1024 * 1024;

export interface SegmentHeader {
  /** A buffer holding `Info`, `Tracks` and `Chapters`, indexed from zero. */
  readonly bytes: Uint8Array;
  /** Where each of those sits in {@link bytes}, when it was found. */
  readonly info: EbmlElement | null;
  readonly tracks: EbmlElement | null;
  readonly chapters: EbmlElement | null;
  /** Set when the walk stopped before reaching the clusters. */
  readonly truncated: boolean;
}

/**
 * Finds the Segment and reads the three header elements out of it.
 *
 * The walk stops at the first `Cluster`, which is where the header ends and the
 * film begins. A file that puts `Tracks` *after* its clusters is legal and is
 * what a live mux produces; nothing here chases it, because doing so means
 * reading the file, and the note the format folders attach says exactly that
 * rather than reporting a file with no tracks.
 */
export async function readSegmentHeader(
  file: FileHandle,
  head: Uint8Array,
  size: number,
  signal?: AbortSignal,
): Promise<SegmentHeader | null> {
  const ebml = readElement(head, 0);
  if (!ebml || ebml.id !== EBML_ID.header || ebml.end === null) return null;

  const segment = readElement(head, ebml.end);
  if (!segment || segment.id !== EBML_ID.segment) return null;

  // Unknown-size segments are normal and mean "to the end of the file".
  const segmentEnd = segment.end === null ? size : Math.min(segment.end, size);

  let info: EbmlElement | null = null;
  let tracks: EbmlElement | null = null;
  let chapters: EbmlElement | null = null;
  const collected: { element: EbmlElement; bytes: Uint8Array }[] = [];

  let at = segment.bodyStart;
  let truncated = false;

  // Bounded for the same reason the ISOBMFF walk is: a malformed file whose
  // every element reports the minimum size is otherwise one iteration per two
  // bytes of a multi-gigabyte file.
  for (let visited = 0; visited < 4096 && at < segmentEnd; visited += 1) {
    signal?.throwIfAborted();

    const header =
      at + 12 <= head.length ? head.subarray(at, at + 12) : await file.readRange(at, 12);
    if (header.length < 2) {
      truncated = true;
      break;
    }

    const local = readElement(header, 0, header.length);
    if (!local) {
      truncated = true;
      break;
    }
    const headerLength = local.bodyStart;
    const bodyLength = local.end === null ? null : local.end - local.bodyStart;

    // The clusters start here; everything this parser wants is behind us.
    if (local.id === EBML_ID.cluster) break;

    const wanted =
      local.id === EBML_ID.info || local.id === EBML_ID.tracks || local.id === EBML_ID.chapters;

    if (wanted && bodyLength !== null && bodyLength > 0 && bodyLength <= MAX_ELEMENT_BYTES) {
      const total = headerLength + bodyLength;
      const bytes =
        at + total <= head.length
          ? head.subarray(at, at + total)
          : await file.readRange(at, total);
      const element = readElement(bytes, 0, bytes.length);
      if (element) collected.push({ element, bytes });
    }

    if (bodyLength === null) {
      // An unknown-size element that is not a Cluster cannot be stepped over.
      truncated = true;
      break;
    }
    const next = at + headerLength + bodyLength;
    if (next <= at) {
      truncated = true;
      break;
    }
    at = next;
  }

  if (collected.length === 0) {
    return { bytes: new Uint8Array(0), info: null, tracks: null, chapters: null, truncated };
  }

  // The three elements were read separately and are concatenated into one buffer
  // so every downstream offset is into a single array — which is what lets the
  // element accessors above take `(bytes, element)` rather than each caller
  // remembering which of three buffers a given element came out of.
  const total = collected.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const entry of collected) {
    bytes.set(entry.bytes, cursor);
    const shifted: EbmlElement = {
      id: entry.element.id,
      start: entry.element.start + cursor,
      bodyStart: entry.element.bodyStart + cursor,
      end: entry.element.end === null ? null : entry.element.end + cursor,
    };
    if (shifted.id === EBML_ID.info) info = shifted;
    else if (shifted.id === EBML_ID.tracks) tracks = shifted;
    else if (shifted.id === EBML_ID.chapters) chapters = shifted;
    cursor += entry.bytes.length;
  }

  return { bytes, info, tracks, chapters, truncated };
}

// ---------------------------------------------------------------------------
// Matroska semantics
//
// Above this line is EBML, which is a container-agnostic binary encoding. Below
// it is what Matroska means by those elements. The two stay in one file because
// Matroska is EBML's only user here and a second module would add a file
// without adding a boundary — the same judgement `isobmff.ts` makes about MP4
// and QuickTime sharing a box walker.
// ---------------------------------------------------------------------------

/** Matroska's `TrackType` values. 3, 0x12 and 0x20 are not playable content. */
const TRACK_KIND: Readonly<Record<number, TrackKind>> = {
  1: "video",
  2: "audio",
  0x11: "subtitle",
};

/** Nanoseconds per tick, when `Info` does not say otherwise. */
const DEFAULT_TIMECODE_SCALE = 1_000_000;

export interface SegmentInfo {
  readonly durationMs?: number;
  readonly title?: string;
  readonly writer?: string;
}

export function parseSegmentInfo(header: SegmentHeader): SegmentInfo {
  if (!header.info) return {};
  const { bytes } = header;
  const start = header.info.bodyStart;
  const end = header.info.end ?? bytes.length;

  const scaleElement = findElement(bytes, EBML_ID.timecodeScale, start, end);
  const scale = (scaleElement && uintValue(bytes, scaleElement)) || DEFAULT_TIMECODE_SCALE;

  const durationElement = findElement(bytes, EBML_ID.duration, start, end);
  // `Duration` is in *timecode-scale units*, not seconds and not milliseconds —
  // reading it as either produces a duration wrong by a factor of a thousand,
  // which looks like a plausible number and is why the scale is read first.
  const ticks = durationElement ? floatValue(bytes, durationElement) : undefined;
  const durationMs =
    ticks !== undefined && ticks > 0 ? (ticks * scale) / 1_000_000 : undefined;

  const titleElement = findElement(bytes, EBML_ID.title, start, end);
  // `WritingApp` is the application and `MuxingApp` the library it used. The
  // application is the more useful of the two to show, and the library is the
  // fallback for muxers that only set one.
  const writingApp = findElement(bytes, EBML_ID.writingApp, start, end);
  const muxingApp = findElement(bytes, EBML_ID.muxingApp, start, end);

  return {
    durationMs,
    title: titleElement ? stringValue(bytes, titleElement) : undefined,
    writer:
      (writingApp ? stringValue(bytes, writingApp) : undefined) ??
      (muxingApp ? stringValue(bytes, muxingApp) : undefined),
  };
}

/**
 * The RFC 6381 parameter for a Matroska track.
 *
 * `CodecPrivate` holds, byte for byte, the same configuration record ISOBMFF
 * puts in `avcC`, `hvcC`, `av1C` and `vpcC` — the specifications share it
 * deliberately, so that remuxing between the two containers copies the record
 * rather than rebuilding it. Sharing the builders from `isobmff.ts` is therefore
 * not a shortcut across a boundary; it is the boundary being in the right place.
 */
function matroskaCodecString(codecId: string, priv?: Uint8Array): string | undefined {
  switch (codecId) {
    case "V_MPEG4/ISO/AVC":
      return priv ? avcCodecString("avc1", priv) : "avc1";
    case "V_MPEGH/ISO/HEVC":
      return priv ? hevcCodecString("hvc1", priv) : "hvc1";
    case "V_AV1":
      return priv ? av1CodecString(priv) : "av01";
    case "V_VP8":
      return "vp8";
    case "V_VP9":
      // WebM writes VP9 with no `CodecPrivate` far more often than with one, and
      // the bare `vp9` parameter is what every engine accepts for it.
      return priv && priv.length >= 7 ? vp9CodecString(priv) : "vp9";
    case "V_THEORA":
      return "theora";
    case "A_OPUS":
      return "opus";
    case "A_VORBIS":
      return "vorbis";
    case "A_FLAC":
      return "flac";
    case "A_AAC":
    case "A_AAC/MPEG4/LC":
      return "mp4a.40.2";
    case "A_AAC/MPEG4/LC/SBR":
      return "mp4a.40.5";
    case "A_AC3":
      return "ac-3";
    case "A_EAC3":
      return "ec-3";
    case "A_MPEG/L3":
      return "mp3";
    default:
      return undefined;
  }
}

export function parseSegmentTracks(
  header: SegmentHeader,
  labelFor: (codecId: string) => string,
): readonly ContainerTrack[] {
  if (!header.tracks) return [];
  const { bytes } = header;
  const tracks: ContainerTrack[] = [];

  for (const entry of elementsIn(
    bytes,
    header.tracks.bodyStart,
    header.tracks.end ?? bytes.length,
  )) {
    if (entry.id !== EBML_ID.trackEntry) continue;
    const start = entry.bodyStart;
    const end = entry.end ?? bytes.length;

    const typeElement = findElement(bytes, EBML_ID.trackType, start, end);
    const kind = TRACK_KIND[typeElement ? (uintValue(bytes, typeElement) ?? 0) : 0];
    if (!kind) continue;

    const numberElement = findElement(bytes, EBML_ID.trackNumber, start, end);
    const codecElement = findElement(bytes, EBML_ID.codecId, start, end);
    const codecId = (codecElement ? stringValue(bytes, codecElement) : undefined) ?? "";

    const privateElement = findElement(bytes, EBML_ID.codecPrivate, start, end);
    const priv = privateElement
      ? bytes.subarray(privateElement.bodyStart, privateElement.end ?? bytes.length)
      : undefined;

    const nameElement = findElement(bytes, EBML_ID.trackName, start, end);
    // `LanguageBCP47` supersedes the ISO 639-2 `Language` when both are present,
    // which is what the current specification says and what modern muxers write.
    const bcp47 = findElement(bytes, EBML_ID.languageBcp47, start, end);
    const iso = findElement(bytes, EBML_ID.language, start, end);
    const rawLanguage =
      (bcp47 ? stringValue(bytes, bcp47) : undefined) ??
      (iso ? stringValue(bytes, iso) : undefined);

    const defaultElement = findElement(bytes, EBML_ID.flagDefault, start, end);
    const forcedElement = findElement(bytes, EBML_ID.flagForced, start, end);

    let width: number | undefined;
    let height: number | undefined;
    let frameRate: number | undefined;
    const video = findElement(bytes, EBML_ID.video, start, end);
    if (video) {
      const videoEnd = video.end ?? bytes.length;
      const widthElement = findElement(bytes, EBML_ID.pixelWidth, video.bodyStart, videoEnd);
      const heightElement = findElement(bytes, EBML_ID.pixelHeight, video.bodyStart, videoEnd);
      width = widthElement ? uintValue(bytes, widthElement) : undefined;
      height = heightElement ? uintValue(bytes, heightElement) : undefined;

      // Matroska has no frame-rate field. `DefaultDuration` is the nominal
      // nanoseconds per frame, which is its reciprocal — and is absent from
      // variable-frame-rate files, where there is genuinely no single answer and
      // reporting one would be inventing it.
      const defaultDuration = findElement(bytes, EBML_ID.defaultDuration, start, end);
      const nanoseconds = defaultDuration ? uintValue(bytes, defaultDuration) : undefined;
      if (nanoseconds && nanoseconds > 0) {
        frameRate = Math.round((1_000_000_000 / nanoseconds) * 1000) / 1000;
      }
    }

    let channels: number | undefined;
    let sampleRate: number | undefined;
    const audio = findElement(bytes, EBML_ID.audio, start, end);
    if (audio) {
      const audioEnd = audio.end ?? bytes.length;
      const channelsElement = findElement(bytes, EBML_ID.channels, audio.bodyStart, audioEnd);
      const rateElement = findElement(
        bytes,
        EBML_ID.samplingFrequency,
        audio.bodyStart,
        audioEnd,
      );
      channels = channelsElement ? uintValue(bytes, channelsElement) : undefined;
      const rate = rateElement ? floatValue(bytes, rateElement) : undefined;
      sampleRate = rate ? Math.round(rate) : undefined;
    }

    tracks.push({
      id: (numberElement ? uintValue(bytes, numberElement) : undefined) ?? tracks.length + 1,
      kind,
      label: nameElement ? stringValue(bytes, nameElement) : undefined,
      language: rawLanguage && rawLanguage !== "und" ? rawLanguage : undefined,
      codecId,
      codec: matroskaCodecString(codecId, priv),
      codecLabel: labelFor(codecId),
      width,
      height,
      frameRate,
      channels,
      sampleRate,
      isDefault: defaultElement ? uintValue(bytes, defaultElement) !== 0 : true,
      isForced: forcedElement ? uintValue(bytes, forcedElement) !== 0 : false,
    });
  }

  return tracks;
}

/**
 * Chapters from the first non-hidden edition.
 *
 * A Matroska file may carry several editions — a theatrical cut and a
 * director's cut, say — and taking every atom from all of them would produce
 * one list with two overlapping sets of timestamps in it. The first ordinary
 * edition is what a player shows, and hidden editions are hidden by request.
 */
export function parseSegmentChapters(header: SegmentHeader): readonly Chapter[] {
  if (!header.chapters) return [];
  const { bytes } = header;

  for (const edition of elementsIn(
    bytes,
    header.chapters.bodyStart,
    header.chapters.end ?? bytes.length,
  )) {
    if (edition.id !== EBML_ID.editionEntry) continue;
    const editionEnd = edition.end ?? bytes.length;

    const hidden = findElement(bytes, EBML_ID.editionFlagHidden, edition.bodyStart, editionEnd);
    if (hidden && uintValue(bytes, hidden) !== 0) continue;

    const chapters: Chapter[] = [];
    for (const atom of elementsIn(bytes, edition.bodyStart, editionEnd)) {
      if (atom.id !== EBML_ID.chapterAtom) continue;
      const atomEnd = atom.end ?? bytes.length;

      const atomHidden = findElement(bytes, EBML_ID.chapterFlagHidden, atom.bodyStart, atomEnd);
      if (atomHidden && uintValue(bytes, atomHidden) !== 0) continue;

      const startElement = findElement(bytes, EBML_ID.chapterTimeStart, atom.bodyStart, atomEnd);
      const nanoseconds = startElement ? uintValue(bytes, startElement) : undefined;
      if (nanoseconds === undefined) continue;

      // `ChapterDisplay` repeats per language. The first is the file's own
      // preferred one, which is the right default without a language preference
      // to match against.
      const display = findElement(bytes, EBML_ID.chapterDisplay, atom.bodyStart, atomEnd);
      const stringElement = display
        ? findElement(bytes, EBML_ID.chapterString, display.bodyStart, display.end ?? bytes.length)
        : null;

      chapters.push({
        startMs: Math.round(nanoseconds / 1_000_000),
        title:
          (stringElement ? stringValue(bytes, stringElement) : undefined) ??
          `Chapter ${chapters.length + 1}`,
      });
    }

    if (chapters.length > 0) {
      return chapters.sort((a, b) => a.startMs - b.startMs);
    }
  }

  return [];
}
