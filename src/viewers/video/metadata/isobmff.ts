/**
 * The ISOBMFF box reader, shared by `mp4/` and `mov/`.
 *
 * The exact counterpart of `viewers/image/metadata/ifd.ts`: one structural
 * reader in `metadata/`, used by the format folders that are built on that
 * structure. MP4 and QuickTime are the same box format — an MP4 file is
 * QuickTime with a brand — and duplicating a box walker between two folders to
 * honour a directory layout would be the tail wagging the dog. What *is*
 * per-format lives in those folders: how each one records chapters, and which
 * codec fourccs each one can plausibly carry.
 *
 * ## Everything is bounds-checked, because the input is hostile
 *
 * A box header states its own length, and this plugin's whole job is opening
 * files someone else wrote. A box claiming to be 4 GB inside a 2 KB file, a box
 * whose size is smaller than its own header, a `stsd` claiming four billion
 * entries — all three occur in the wild, in corrupted files and in deliberately
 * malformed ones, and none of them may produce anything worse than a track this
 * parser declines to describe. So every walk is bounded by its parent, every
 * count is bounded by the bytes actually present, and a header that does not
 * make sense terminates the walk instead of advancing by a wrong amount.
 *
 * ## Reading it costs a header, not a file
 *
 * {@link findTopLevelBox} walks the file's top level by reading sixteen bytes
 * per box through {@link FileHandle.readRange}, then reads only the `moov` box
 * whole. A `moov` is tens to hundreds of kilobytes; the `mdat` beside it is the
 * whole film. Files written for progressive download put `moov` first and files
 * written by a camera put it last, so both ends have to be reachable — which is
 * exactly why this cannot be done from a fixed-size head buffer.
 */

import type { FileHandle } from "../../../files";
import { ByteReader, decodeText, hex } from "../binary";
import type { Chapter, ContainerTrack, SubtitleCue, TrackKind } from "../container";

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

export interface Box {
  readonly type: string;
  /** Offset of the box header, relative to the buffer it was found in. */
  readonly start: number;
  /** Offset of the first payload byte. */
  readonly bodyStart: number;
  /** Offset one past the last payload byte. */
  readonly end: number;
}

/** The smallest legal box: a 32-bit size and a four-character type. */
const BOX_HEADER = 8;

/**
 * Reads one box header at `at`, or `null` if it does not make sense.
 *
 * "Does not make sense" covers the three cases that matter: fewer than eight
 * bytes left, a stated size smaller than the header it is part of, and a size
 * running past the parent. The last is *clamped* rather than rejected, because a
 * final box whose size overruns by a few bytes is the commonest form of a
 * truncated download and everything before it is still readable.
 */
function readBoxHeader(bytes: Uint8Array, at: number, limit: number): Box | null {
  if (at + BOX_HEADER > limit) return null;
  const reader = new ByteReader(bytes, at);
  const size32 = reader.u32();
  const type = reader.ascii(4);
  if (size32 === null || type === null) return null;

  let bodyStart = at + BOX_HEADER;
  let size = size32;

  if (size32 === 1) {
    const large = reader.u64();
    if (large === null) return null;
    size = large;
    bodyStart = at + 16;
  } else if (size32 === 0) {
    // "To the end of the enclosing box", which for a top-level box means the
    // end of the file. Legal, and the normal encoding for a streamed `mdat`.
    size = limit - at;
  }

  if (size < bodyStart - at) return null;
  return { type, start: at, bodyStart, end: Math.min(at + size, limit) };
}

/** Every box directly inside `[start, end)`. Does not recurse. */
export function* boxesIn(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): Generator<Box> {
  let at = start;
  while (at + BOX_HEADER <= end) {
    const box = readBoxHeader(bytes, at, end);
    if (!box) return;
    yield box;
    // A zero-length advance would spin forever on a malformed size; the header
    // check above makes that impossible, and this is the belt to its braces.
    if (box.end <= at) return;
    at = box.end;
  }
}

/** The first child box of the given type, or `null`. */
export function findBox(
  bytes: Uint8Array,
  type: string,
  start = 0,
  end = bytes.length,
): Box | null {
  for (const box of boxesIn(bytes, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/** Follows a path of nested box types: `findPath(bytes, ["mdia", "mdhd"], …)`. */
export function findPath(
  bytes: Uint8Array,
  path: readonly string[],
  start = 0,
  end = bytes.length,
): Box | null {
  let from = start;
  let to = end;
  let found: Box | null = null;
  for (const type of path) {
    found = findBox(bytes, type, from, to);
    if (!found) return null;
    from = found.bodyStart;
    to = found.end;
  }
  return found;
}

/** A box's version and flags, and where its payload proper begins. */
export function fullBox(bytes: Uint8Array, box: Box): {
  version: number;
  flags: number;
  at: number;
} | null {
  const reader = new ByteReader(bytes, box.bodyStart);
  const version = reader.u8();
  const flags = reader.u32(box.bodyStart, false);
  if (version === null || flags === null) return null;
  return { version, flags: flags & 0x00ff_ffff, at: box.bodyStart + 4 };
}

/**
 * Finds a top-level box by reading headers rather than content.
 *
 * Sixteen bytes per box, however large the boxes are — which is the whole point:
 * a file's top level is `ftyp`, `moov`, `mdat` and a handful of others, and
 * walking it this way reaches a `moov` sitting after four gigabytes of `mdat`
 * for the cost of four reads.
 */
export async function findTopLevelBox(
  file: FileHandle,
  size: number,
  type: string,
  options?: { readonly signal?: AbortSignal; readonly head?: Uint8Array },
): Promise<Box | null> {
  let at = 0;
  // A generous bound on how many top-level boxes a legitimate file has. Without
  // it, a file whose boxes all report the minimum size is a walk of one
  // iteration per eight bytes of a multi-gigabyte file.
  for (let visited = 0; visited < 1024 && at + BOX_HEADER <= size; visited += 1) {
    options?.signal?.throwIfAborted();

    // Served from the head buffer where it reaches, which covers `ftyp` and a
    // front-loaded `moov` without a single extra read.
    const header =
      options?.head && at + 16 <= options.head.length
        ? options.head.subarray(at, at + 16)
        : await file.readRange(at, 16);
    if (header.length < BOX_HEADER) return null;

    const box = readBoxHeader(header, 0, header.length);
    if (!box) return null;

    // A stated size of zero means "to the end of the file", which
    // `readBoxHeader` cannot express from inside a sixteen-byte window — it
    // clamps to the window and would report a 16-byte box. Read the raw size
    // here instead. Such a box is by definition the last one, so if it is not
    // the one being looked for, there is nothing further to walk.
    const stated =
      (header[0]! << 24) | (header[1]! << 16) | (header[2]! << 8) | header[3]!;
    const end = stated === 0 ? size : Math.min(at + (box.end - box.start), size);

    // `readBoxHeader` worked in the window's coordinates; put it back into the
    // file's.
    const absolute: Box = {
      type: box.type,
      start: at,
      bodyStart: at + (box.bodyStart - box.start),
      end,
    };
    if (absolute.type === type) return absolute;
    if (stated === 0 || absolute.end <= at) return null;
    at = absolute.end;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small field readers
// ---------------------------------------------------------------------------

/**
 * The ISO 639-2 code packed into `mdhd`'s sixteen bits: three five-bit letters,
 * each offset from `0x60`.
 *
 * `und` — the explicit "undetermined" code — comes back as `undefined` rather
 * than as the string, because a track labelled "und" in a track menu says less
 * than a track labelled nothing at all.
 */
export function unpackLanguage(packed: number): string | undefined {
  const letters = [
    ((packed >> 10) & 0x1f) + 0x60,
    ((packed >> 5) & 0x1f) + 0x60,
    (packed & 0x1f) + 0x60,
  ];
  if (letters.some((code) => code < 0x61 || code > 0x7a)) return undefined;
  const code = String.fromCharCode(...letters);
  return code === "und" ? undefined : code;
}

/** A 16.16 fixed-point number, as used for track dimensions and sample rates. */
function fixed16(value: number): number {
  return value / 65536;
}

// ---------------------------------------------------------------------------
// Codec strings
//
// The RFC 6381 parameter, derived from the file's own configuration record.
// This is what makes a codec support check specific: `avc1` alone means "some
// H.264", and every webview on every platform supports some H.264. What varies
// is the profile and level, and those live in these few bytes.
// ---------------------------------------------------------------------------

/** `avc1.640028` — profile, constraint flags, level, from `avcC`. */
export function avcCodecString(fourcc: string, config: Uint8Array): string | undefined {
  if (config.length < 4) return undefined;
  return `${fourcc}.${hex(config[1]!, 2)}${hex(config[2]!, 2)}${hex(config[3]!, 2)}`;
}

/**
 * `hvc1.1.6.L93.B0` — the most involved of these, and worth the trouble.
 *
 * HEVC support is the single largest variance between the three target webviews
 * (AGENTS.md, "Platform targets"), so when it is missing this string is the
 * whole of what the error message can say that is useful. The compatibility
 * flags are stored most-significant-bit-first and specified to be written
 * *reversed*, which is the one part of this that is easy to get wrong and
 * impossible to notice: a wrong-but-plausible string makes `canPlayType` answer
 * about a codec the file does not contain.
 */
export function hevcCodecString(fourcc: string, config: Uint8Array): string | undefined {
  if (config.length < 13) return undefined;

  const profileSpace = (config[1]! >> 6) & 0x03;
  const tierFlag = (config[1]! >> 5) & 0x01;
  const profileIdc = config[1]! & 0x1f;

  let compatibility = 0;
  for (let index = 0; index < 4; index += 1) {
    compatibility = (compatibility << 8) | config[2 + index]!;
  }
  let reversed = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    reversed = (reversed << 1) | ((compatibility >>> bit) & 1);
  }

  const parts = [
    fourcc,
    `${["", "A", "B", "C"][profileSpace]}${profileIdc}`,
    (reversed >>> 0).toString(16),
    `${tierFlag ? "H" : "L"}${config[12]!}`,
  ];

  // The six constraint bytes, with trailing zero bytes omitted — which the
  // specification requires, and which is why two files at the same profile and
  // level can legitimately produce strings of different lengths.
  const constraints: string[] = [];
  for (let index = 6; index <= 11; index += 1) {
    constraints.push(hex(config[index] ?? 0, 2));
  }
  while (constraints.length && constraints[constraints.length - 1] === "00") {
    constraints.pop();
  }
  return [...parts, ...constraints].join(".");
}

/** `av01.0.08M.08` — profile, level, tier, bit depth, from `av1C`. */
export function av1CodecString(config: Uint8Array): string | undefined {
  if (config.length < 3) return undefined;
  const profile = (config[1]! >> 5) & 0x07;
  const level = config[1]! & 0x1f;
  const tier = (config[2]! >> 7) & 0x01;
  const highBitDepth = (config[2]! >> 6) & 0x01;
  const twelveBit = (config[2]! >> 5) & 0x01;
  const depth = twelveBit ? 12 : highBitDepth ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.${String(depth).padStart(2, "0")}`;
}

/** `vp09.00.41.08` — profile, level, bit depth, from `vpcC`. */
export function vp9CodecString(config: Uint8Array): string | undefined {
  // A `FullBox`: four bytes of version and flags before the payload.
  if (config.length < 7) return undefined;
  const profile = config[4]!;
  const level = config[5]!;
  const depth = (config[6]! >> 4) & 0x0f;
  return `vp09.${String(profile).padStart(2, "0")}.${String(level).padStart(2, "0")}.${String(depth).padStart(2, "0")}`;
}

/**
 * `mp4a.40.2` — from the MPEG-4 descriptor chain inside `esds`.
 *
 * The chain is `ES_Descriptor` → `DecoderConfigDescriptor` → optionally
 * `DecoderSpecificInfo`, each tag-length-value with a variable-length length
 * field. The object type indication distinguishes AAC from MP3 from a dozen
 * things no webview has decoded this century, and the audio object type inside
 * the specific info distinguishes AAC-LC from HE-AAC — which matters, because
 * Safari plays both and some Linux builds play only the first.
 */
function esdsCodec(payload: Uint8Array): string | undefined {
  /** One tag-length-value descriptor, advancing `cursor.at`. */
  const readDescriptor = (
    buffer: Uint8Array,
    cursor: { at: number },
  ): { tag: number; body: Uint8Array } | null => {
    if (cursor.at >= buffer.length) return null;
    const tag = buffer[cursor.at]!;
    cursor.at += 1;
    // The length is up to four bytes, each contributing seven bits, with the
    // high bit meaning "another byte follows".
    let length = 0;
    for (let index = 0; index < 4 && cursor.at < buffer.length; index += 1) {
      const byte = buffer[cursor.at]!;
      cursor.at += 1;
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    if (cursor.at + length > buffer.length) return null;
    const body = buffer.subarray(cursor.at, cursor.at + length);
    cursor.at += length;
    return { tag, body };
  };

  // Past the FullBox version and flags, then the ES_Descriptor.
  const es = readDescriptor(payload, { at: 4 });
  if (!es || es.tag !== 0x03 || es.body.length < 3) return undefined;

  // Inside ES_Descriptor: ES_ID (2 bytes) and a flags byte, then three optional
  // fields whose presence those flags declare. Skipping them by the flags
  // rather than by a fixed offset is what makes this work on streams that carry
  // a URL, which is where a fixed offset silently reads the wrong descriptor.
  let inner = 3;
  const flags = es.body[2]!;
  if (flags & 0x80) inner += 2; // depends-on ES id
  if (flags & 0x40) inner += 1 + (es.body[inner] ?? 0); // URL, length-prefixed
  if (flags & 0x20) inner += 2; // OCR ES id

  const config = readDescriptor(es.body, { at: inner });
  if (!config || config.tag !== 0x04 || config.body.length < 1) return undefined;

  const objectType = config.body[0]!;
  if (objectType !== 0x40) return `mp4a.${hex(objectType, 2)}`;

  // AAC. The DecoderSpecificInfo follows thirteen bytes of stream type, buffer
  // size and bitrates; its first five bits are the audio object type, which is
  // what separates AAC-LC (2) from HE-AAC (5) — a distinction that decides
  // playback on some Linux builds.
  const specific = readDescriptor(config.body, { at: 13 });
  if (!specific || specific.tag !== 0x05 || specific.body.length < 1) return "mp4a.40.2";

  const first = specific.body[0]!;
  let audioObjectType = (first >> 3) & 0x1f;
  // 31 is the escape for types above 30, whose real value is in the next six
  // bits plus an offset of 32.
  if (audioObjectType === 31 && specific.body.length >= 2) {
    audioObjectType = 32 + (((first & 0x07) << 3) | ((specific.body[1]! >> 5) & 0x07));
  }
  return `mp4a.40.${audioObjectType}`;
}

/**
 * The RFC 6381 parameter for one sample entry, from whichever configuration box
 * it carries.
 *
 * Falls back to the bare fourcc, which is a legal codec parameter and is what
 * every codec without a configuration record uses anyway (`ac-3`, `opus`,
 * `flac`). Returning something is important: the fourcc alone still lets
 * `canPlayType` give a useful answer for those, and still names the codec in an
 * error message.
 */
function codecStringFor(
  bytes: Uint8Array,
  fourcc: string,
  entryStart: number,
  entryEnd: number,
): string | undefined {
  const configOf = (type: string): Uint8Array | undefined => {
    const box = findBox(bytes, type, entryStart, entryEnd);
    return box ? bytes.subarray(box.bodyStart, box.end) : undefined;
  };

  switch (fourcc) {
    case "avc1":
    case "avc2":
    case "avc3":
    case "avc4": {
      const config = configOf("avcC");
      return config ? avcCodecString(fourcc, config) : fourcc;
    }
    case "hvc1":
    case "hev1": {
      const config = configOf("hvcC");
      return config ? hevcCodecString(fourcc, config) : fourcc;
    }
    case "av01": {
      const config = configOf("av1C");
      return config ? av1CodecString(config) : fourcc;
    }
    case "vp08":
      return "vp8";
    case "vp09": {
      const config = configOf("vpcC");
      return config ? vp9CodecString(config) : fourcc;
    }
    case "mp4a": {
      const config = configOf("esds");
      return config ? (esdsCodec(config) ?? "mp4a.40.2") : "mp4a.40.2";
    }
    case "Opus":
      return "opus";
    case "fLaC":
      return "flac";
    default:
      return fourcc;
  }
}

// ---------------------------------------------------------------------------
// Sample tables
// ---------------------------------------------------------------------------

export interface SampleRef {
  /** Absolute offset in the file. */
  readonly offset: number;
  readonly size: number;
  readonly startMs: number;
  readonly durationMs: number;
}

/**
 * Where every sample of a track is, and when it plays.
 *
 * Needed by exactly two callers, both of which read *text*: MP4's `tx3g`
 * subtitle cues and QuickTime's chapter titles. Both are small tracks — a
 * feature-length film's chapter track is a few hundred bytes — so having their
 * exact offsets means the cues can be fetched with a couple of ranged reads
 * instead of by reading the film.
 *
 * Capped at {@link MAX_SAMPLES}, because `stsz` states its own sample count and
 * a malformed one states four billion.
 */
const MAX_SAMPLES = 100_000;

export function sampleTable(
  bytes: Uint8Array,
  stbl: Box,
  timescale: number,
): readonly SampleRef[] {
  const stts = findBox(bytes, "stts", stbl.bodyStart, stbl.end);
  const stsz = findBox(bytes, "stsz", stbl.bodyStart, stbl.end);
  const stsc = findBox(bytes, "stsc", stbl.bodyStart, stbl.end);
  const stco = findBox(bytes, "stco", stbl.bodyStart, stbl.end);
  const co64 = findBox(bytes, "co64", stbl.bodyStart, stbl.end);
  if (!stts || !stsz || !stsc || (!stco && !co64) || timescale <= 0) return [];

  // --- sizes ---------------------------------------------------------------
  const sizeReader = new ByteReader(bytes, stsz.bodyStart + 4);
  const uniformSize = sizeReader.u32();
  const sampleCount = sizeReader.u32();
  if (uniformSize === null || sampleCount === null) return [];
  const count = Math.min(sampleCount, MAX_SAMPLES);

  const sizes: number[] = [];
  if (uniformSize > 0) {
    for (let index = 0; index < count; index += 1) sizes.push(uniformSize);
  } else {
    for (let index = 0; index < count; index += 1) {
      const size = sizeReader.u32();
      if (size === null) break;
      sizes.push(size);
    }
  }

  // --- times ---------------------------------------------------------------
  const timeReader = new ByteReader(bytes, stts.bodyStart + 4);
  const timeEntries = timeReader.u32() ?? 0;
  const starts: number[] = [];
  const durations: number[] = [];
  let ticks = 0;
  for (let entry = 0; entry < timeEntries && starts.length < count; entry += 1) {
    const runLength = timeReader.u32();
    const delta = timeReader.u32();
    if (runLength === null || delta === null) break;
    for (let index = 0; index < runLength && starts.length < count; index += 1) {
      starts.push((ticks / timescale) * 1000);
      durations.push((delta / timescale) * 1000);
      ticks += delta;
    }
  }

  // --- offsets -------------------------------------------------------------
  const chunkReader = new ByteReader(bytes, (co64 ?? stco)!.bodyStart + 4);
  const chunkCount = chunkReader.u32() ?? 0;
  const chunkOffsets: number[] = [];
  for (let index = 0; index < chunkCount && index < MAX_SAMPLES; index += 1) {
    const offset = co64 ? chunkReader.u64() : chunkReader.u32();
    if (offset === null) break;
    chunkOffsets.push(offset);
  }

  // --- samples per chunk ---------------------------------------------------
  const scReader = new ByteReader(bytes, stsc.bodyStart + 4);
  const scEntries = scReader.u32() ?? 0;
  const runs: { firstChunk: number; samplesPerChunk: number }[] = [];
  for (let index = 0; index < scEntries && index < MAX_SAMPLES; index += 1) {
    const firstChunk = scReader.u32();
    const samplesPerChunk = scReader.u32();
    scReader.u32(); // sample description index, unused here
    if (firstChunk === null || samplesPerChunk === null) break;
    runs.push({ firstChunk, samplesPerChunk });
  }
  if (runs.length === 0) return [];

  // Walk the chunks, laying samples end to end within each one. This is the
  // whole of the `stsc`/`stco` indirection: a chunk's offset is stated, and the
  // samples inside it are contiguous.
  const samples: SampleRef[] = [];
  let sampleIndex = 0;
  for (let chunk = 0; chunk < chunkOffsets.length && sampleIndex < sizes.length; chunk += 1) {
    let perChunk = runs[runs.length - 1]!.samplesPerChunk;
    for (let run = 0; run < runs.length; run += 1) {
      const next = runs[run + 1];
      if (chunk + 1 >= runs[run]!.firstChunk && (!next || chunk + 1 < next.firstChunk)) {
        perChunk = runs[run]!.samplesPerChunk;
        break;
      }
    }

    let offset = chunkOffsets[chunk]!;
    for (let index = 0; index < perChunk && sampleIndex < sizes.length; index += 1) {
      samples.push({
        offset,
        size: sizes[sampleIndex]!,
        startMs: starts[sampleIndex] ?? 0,
        durationMs: durations[sampleIndex] ?? 0,
      });
      offset += sizes[sampleIndex]!;
      sampleIndex += 1;
    }
  }

  return samples;
}

/**
 * Reads a text track's samples and turns them into cues.
 *
 * `tx3g` (MP4) and `text` (QuickTime) both store a sample as a big-endian
 * 16-bit length followed by that many bytes of UTF-8, optionally followed by
 * styling atoms this deliberately ignores — a cue is text, and the overlay
 * renders it in the app's own type.
 *
 * Samples are fetched in one read spanning the track's whole byte range when
 * that range is small, which it always is for text. The cap is what keeps a
 * malformed table from turning "read the subtitles" into "read the film".
 */
export async function readTextSamples(
  file: FileHandle,
  samples: readonly SampleRef[],
  options?: { readonly signal?: AbortSignal; readonly maxBytes?: number },
): Promise<readonly SubtitleCue[]> {
  if (samples.length === 0) return [];
  const maxBytes = options?.maxBytes ?? 4 * 1024 * 1024;

  const first = samples.reduce((low, sample) => Math.min(low, sample.offset), Infinity);
  const last = samples.reduce((high, sample) => Math.max(high, sample.offset + sample.size), 0);
  if (!Number.isFinite(first) || last <= first || last - first > maxBytes) return [];

  options?.signal?.throwIfAborted();
  const block = await file.readRange(first, last - first);

  const cues: SubtitleCue[] = [];
  for (const sample of samples) {
    const at = sample.offset - first;
    if (at < 0 || at + 2 > block.length || sample.size < 2) continue;
    const length = (block[at]! << 8) | block[at + 1]!;
    if (length === 0) continue;
    const text = decodeText(block.subarray(at + 2, Math.min(at + 2 + length, block.length)));
    if (!text.trim()) continue;
    cues.push({
      startMs: Math.round(sample.startMs),
      endMs: Math.round(sample.startMs + sample.durationMs),
      text: text.trim(),
    });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/** A parsed track plus the internals the format folders need to go further. */
export interface IsobmffTrack {
  readonly track: ContainerTrack;
  /** The `hdlr` type: `vide`, `soun`, `text`, `sbtl`, `subt`, `meta`. */
  readonly handler: string;
  /** The sample entry fourcc, for callers that branch on it. */
  readonly fourcc: string;
  readonly timescale: number;
  /** Located so chapter and subtitle readers can pull samples out of it. */
  readonly stbl: Box | null;
  /** Track ids this track references as chapters, from `tref/chap`. */
  readonly chapterRefs: readonly number[];
}

const HANDLER_KIND: Readonly<Record<string, TrackKind>> = {
  vide: "video",
  soun: "audio",
  text: "subtitle",
  sbtl: "subtitle",
  subt: "subtitle",
  clcp: "subtitle",
};

/** Where a sample entry's nested configuration boxes begin, per entry kind. */
function sampleEntryBodyStart(
  bytes: Uint8Array,
  kind: TrackKind,
  entryStart: number,
): number {
  if (kind !== "audio") {
    // VisualSampleEntry: 8 header + 8 SampleEntry + 62 visual fields.
    return entryStart + 86;
  }
  // AudioSampleEntry, whose QuickTime versions 1 and 2 add fields before the
  // nested boxes. Reading the version rather than assuming 0 is the difference
  // between finding an `esds` and concluding a track has no codec record.
  const version = new ByteReader(bytes, entryStart + 16).u16() ?? 0;
  if (version === 1) return entryStart + 52;
  if (version === 2) return entryStart + 72;
  return entryStart + 36;
}

/**
 * Parses one `trak` box.
 *
 * Returns `null` only when the track has no `hdlr` or no `mdhd` — that is, when
 * there is nothing here to describe. A track whose codec is unrecognised is
 * still returned, with the fourcc as its label, because "this file contains a
 * track using `mp2v` and nothing here plays it" is precisely the message the
 * brief asks for and it needs the track to exist to say it.
 */
export function parseTrack(
  bytes: Uint8Array,
  trak: Box,
  labelFor: (codecId: string) => string,
): IsobmffTrack | null {
  const mdia = findBox(bytes, "mdia", trak.bodyStart, trak.end);
  if (!mdia) return null;

  const mdhdBox = findBox(bytes, "mdhd", mdia.bodyStart, mdia.end);
  const hdlrBox = findBox(bytes, "hdlr", mdia.bodyStart, mdia.end);
  if (!mdhdBox || !hdlrBox) return null;

  // --- mdhd: timescale, duration, language ---------------------------------
  const mdhdHeader = fullBox(bytes, mdhdBox);
  if (!mdhdHeader) return null;
  const mdhd = new ByteReader(bytes, mdhdHeader.at);
  mdhd.skip(mdhdHeader.version === 1 ? 16 : 8);
  const timescale = (mdhdHeader.version === 1 ? mdhd.u32() : mdhd.u32()) ?? 0;
  const mediaDuration = (mdhdHeader.version === 1 ? mdhd.u64() : mdhd.u32()) ?? 0;
  const language = unpackLanguage(mdhd.u16() ?? 0);

  // --- hdlr: what kind of track this is ------------------------------------
  const hdlrHeader = fullBox(bytes, hdlrBox);
  const handler = hdlrHeader
    ? (new ByteReader(bytes, hdlrHeader.at + 4).ascii(4) ?? "")
    : "";
  const kind = HANDLER_KIND[handler];
  if (!kind) return null;

  // --- tkhd: id, dimensions, enabled flag ----------------------------------
  const tkhdBox = findBox(bytes, "tkhd", trak.bodyStart, trak.end);
  let id = 0;
  let width: number | undefined;
  let height: number | undefined;
  let enabled = true;
  if (tkhdBox) {
    const tkhdHeader = fullBox(bytes, tkhdBox);
    if (tkhdHeader) {
      enabled = (tkhdHeader.flags & 0x1) !== 0;
      const tkhd = new ByteReader(bytes, tkhdHeader.at);
      tkhd.skip(tkhdHeader.version === 1 ? 16 : 8);
      id = tkhd.u32() ?? 0;
      tkhd.skip(4); // reserved
      tkhd.skip(tkhdHeader.version === 1 ? 8 : 4); // duration
      tkhd.skip(8 + 2 + 2 + 2 + 2 + 36); // reserved, layer, group, volume, matrix
      if (kind === "video") {
        width = Math.round(fixed16(tkhd.u32() ?? 0));
        height = Math.round(fixed16(tkhd.u32() ?? 0));
      }
    }
  }

  // --- stsd: the codec and its parameters ----------------------------------
  const stbl = findPath(bytes, ["minf", "stbl"], mdia.bodyStart, mdia.end);
  const stsd = stbl ? findBox(bytes, "stsd", stbl.bodyStart, stbl.end) : null;

  let fourcc = "";
  let codec: string | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitrate: number | undefined;

  if (stsd) {
    const stsdHeader = fullBox(bytes, stsd);
    if (stsdHeader) {
      // Only the first entry. A track with several sample descriptions changes
      // codec partway through, which none of these containers does in practice
      // and which no `<video>` element would play if it did.
      const entry = readBoxHeader(bytes, stsdHeader.at + 4, stsd.end);
      if (entry) {
        fourcc = entry.type;
        const bodyStart = sampleEntryBodyStart(bytes, kind, entry.start);
        codec = codecStringFor(bytes, fourcc, bodyStart, entry.end);

        if (kind === "video") {
          // The sample entry's own dimensions, which are the coded ones. `tkhd`
          // carries the *display* dimensions, which differ for anamorphic
          // video — and the coded size is what a metadata panel should show
          // when the two disagree, so this only fills a gap `tkhd` left.
          const visual = new ByteReader(bytes, entry.start + 32);
          width ??= visual.u16() ?? undefined;
          height ??= visual.u16() ?? undefined;
        } else if (kind === "audio") {
          const audio = new ByteReader(bytes, entry.start + 24);
          channels = audio.u16() ?? undefined;
          audio.skip(6);
          sampleRate = Math.round(fixed16(audio.u32() ?? 0)) || undefined;
        }

        const btrt = findBox(bytes, "btrt", bodyStart, entry.end);
        if (btrt) {
          const rates = new ByteReader(bytes, btrt.bodyStart + 4);
          rates.u32(); // max bitrate
          bitrate = rates.u32() ?? undefined;
        }
      }
    }
  }

  // --- frame rate, from the sample-to-time table ---------------------------
  let frameRate: number | undefined;
  if (kind === "video" && stbl && timescale > 0) {
    const stts = findBox(bytes, "stts", stbl.bodyStart, stbl.end);
    if (stts) {
      const reader = new ByteReader(bytes, stts.bodyStart + 4);
      const entries = reader.u32() ?? 0;
      let samples = 0;
      let ticks = 0;
      for (let index = 0; index < entries && index < 4096; index += 1) {
        const runLength = reader.u32();
        const delta = reader.u32();
        if (runLength === null || delta === null) break;
        samples += runLength;
        ticks += runLength * delta;
      }
      if (ticks > 0) frameRate = Math.round((samples / (ticks / timescale)) * 1000) / 1000;
    }
  }

  // Derived from the track's own byte total when no `btrt` said otherwise. It
  // is the honest number for the panel and it is what `esds` would have said.
  if (bitrate === undefined && stbl && timescale > 0 && mediaDuration > 0) {
    const stsz = findBox(bytes, "stsz", stbl.bodyStart, stbl.end);
    if (stsz) {
      const reader = new ByteReader(bytes, stsz.bodyStart + 4);
      const uniform = reader.u32() ?? 0;
      const count = reader.u32() ?? 0;
      let total = 0;
      if (uniform > 0) {
        total = uniform * Math.min(count, MAX_SAMPLES);
      } else {
        for (let index = 0; index < Math.min(count, MAX_SAMPLES); index += 1) {
          total += reader.u32() ?? 0;
        }
      }
      const seconds = mediaDuration / timescale;
      if (seconds > 0 && total > 0) bitrate = Math.round((total * 8) / seconds);
    }
  }

  // --- name and chapter references -----------------------------------------
  const nameBox = findPath(bytes, ["udta", "name"], trak.bodyStart, trak.end);
  const label = nameBox
    ? decodeText(bytes.subarray(nameBox.bodyStart, nameBox.end)).trim() || undefined
    : undefined;

  const chapterRefs: number[] = [];
  const chap = findPath(bytes, ["tref", "chap"], trak.bodyStart, trak.end);
  if (chap) {
    const reader = new ByteReader(bytes, chap.bodyStart);
    while (reader.offset + 4 <= chap.end) {
      const ref = reader.u32();
      if (ref === null) break;
      chapterRefs.push(ref);
    }
  }

  const track: ContainerTrack = {
    id,
    kind,
    label,
    language,
    codecId: fourcc,
    codec,
    codecLabel: labelFor(fourcc),
    width: width || undefined,
    height: height || undefined,
    frameRate,
    channels,
    sampleRate,
    bitrate,
    isDefault: enabled,
  };

  return { track, handler, fourcc, timescale, stbl, chapterRefs };
}

/** `mvhd`'s timescale and duration, in milliseconds. */
export function movieDuration(bytes: Uint8Array, moovStart: number, moovEnd: number): {
  durationMs?: number;
  timescale: number;
} {
  const mvhdBox = findBox(bytes, "mvhd", moovStart, moovEnd);
  if (!mvhdBox) return { timescale: 0 };
  const header = fullBox(bytes, mvhdBox);
  if (!header) return { timescale: 0 };

  const reader = new ByteReader(bytes, header.at);
  reader.skip(header.version === 1 ? 16 : 8);
  const timescale = reader.u32() ?? 0;
  const duration = (header.version === 1 ? reader.u64() : reader.u32()) ?? 0;

  // `0xFFFFFFFF` is the 32-bit "unknown duration", which fragmented files write.
  const unknown = duration === 0xffff_ffff || duration === 0;
  return {
    timescale,
    durationMs: !unknown && timescale > 0 ? (duration / timescale) * 1000 : undefined,
  };
}

// ---------------------------------------------------------------------------
// The shared half of an ISOBMFF parse
//
// `mp4/index.ts` and `mov/index.ts` both do these three steps and then diverge
// — on how chapters are recorded, and on which codecs each container plausibly
// carries. Everything up to the divergence is here, so the two format folders
// contain what actually differs rather than two copies of a box walk.
// ---------------------------------------------------------------------------

export interface MoovBuffer {
  /**
   * The buffer the `moov` box lives in — the head when it fitted there, and a
   * freshly read block otherwise. Sample offsets read out of it are the file's
   * own (`stco` stores absolute offsets), so nothing downstream needs to know
   * which of the two this is.
   */
  readonly bytes: Uint8Array;
  /** The box, in {@link bytes}' coordinates. */
  readonly moov: Box;
}

/** A `moov` too large to be a header rather than a payload. */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

/**
 * Locates and reads the `moov` box.
 *
 * Served straight from the head buffer when the box fits inside it, which is
 * the case for every file written for progressive download. Otherwise the top
 * level is walked by headers — sixteen bytes per box — and only the `moov` is
 * read, which is what makes a camera file with a trailing `moov` cost two reads
 * rather than its own size.
 */
export async function readMoov(
  file: FileHandle,
  head: Uint8Array,
  size: number,
  signal?: AbortSignal,
): Promise<MoovBuffer | null> {
  const inHead = findBox(head, "moov");
  if (inHead && inHead.end <= head.length) {
    return { bytes: head, moov: inHead };
  }

  const located = await findTopLevelBox(file, size, "moov", { signal, head });
  if (!located) return null;

  const length = located.end - located.start;
  if (length <= 0 || length > MAX_MOOV_BYTES) return null;

  signal?.throwIfAborted();
  const bytes = await file.readRange(located.start, length);
  const moov = readBoxHeader(bytes, 0, bytes.length);
  if (!moov) return null;
  return { bytes, moov };
}

/** Every describable track in a `moov`, in the order the file lists them. */
export function parseTracks(
  buffer: MoovBuffer,
  labelFor: (codecId: string) => string,
): readonly IsobmffTrack[] {
  const tracks: IsobmffTrack[] = [];
  for (const box of boxesIn(buffer.bytes, buffer.moov.bodyStart, buffer.moov.end)) {
    if (box.type !== "trak") continue;
    const parsed = parseTrack(buffer.bytes, box, labelFor);
    if (parsed) tracks.push(parsed);
  }
  return tracks;
}

/**
 * Reads the cues out of every text track that carries them.
 *
 * This is the ISOBMFF half of the brief's "embedded … subtitle tracks", and it
 * is tractable here for a structural reason worth stating: `stbl` indexes every
 * sample in the track, so the cues can be fetched by their exact offsets — a
 * feature film's subtitle track is a few tens of kilobytes and costs one ranged
 * read. Matroska stores the same data interleaved through every cluster in the
 * file, with no index, which is why `mkv/index.ts` can only list its subtitle
 * tracks and says so rather than pretending otherwise.
 *
 * Bitmap subtitle tracks are skipped: their samples are images, and decoding
 * VobSub or PGS is a rendering project, not a parse. They stay in the track list
 * so the panel can say the file has them.
 */
export async function extractTimedText(
  file: FileHandle,
  buffer: MoovBuffer,
  tracks: readonly IsobmffTrack[],
  signal?: AbortSignal,
): Promise<Map<number, readonly SubtitleCue[]>> {
  const byTrack = new Map<number, readonly SubtitleCue[]>();

  for (const entry of tracks) {
    if (entry.track.kind !== "subtitle" || !entry.stbl) continue;
    // The two sample formats whose payload is a length-prefixed UTF-8 string.
    // `wvtt` is WebVTT-in-MP4, whose samples are nested boxes rather than a
    // plain string, and is left to the engine — Safari renders it natively and
    // exposes its cues through `textTracks`.
    if (entry.fourcc !== "tx3g" && entry.fourcc !== "text") continue;

    signal?.throwIfAborted();
    const samples = sampleTable(buffer.bytes, entry.stbl, entry.timescale);
    if (samples.length === 0) continue;

    try {
      const cues = await readTextSamples(file, samples, { signal });
      if (cues.length > 0) byTrack.set(entry.track.id, cues);
    } catch (thrown) {
      if (signal?.aborted) throw thrown;
      // One unreadable subtitle track must not fail the file it is inside.
      console.warn("[video] could not read a timed-text track", thrown);
    }
  }

  return byTrack;
}

/** A chapter list longer than this is a misparse, not a film. */
export const MAX_CHAPTERS = 2000;

/**
 * Chapters held as a text track that another track points at through
 * `tref/chap`.
 *
 * QuickTime's convention, and one that Apple's tools write into `.mp4` files as
 * readily as into `.mov` — so it lives here rather than in either format folder,
 * and both call it. Its samples are the titles and its sample table holds their
 * times, which is the same read {@link extractTimedText} performs for subtitles;
 * routing both through {@link readTextSamples} is what keeps one idea of what a
 * text sample is.
 */
export async function readChapterTrack(
  file: FileHandle,
  buffer: MoovBuffer,
  tracks: readonly IsobmffTrack[],
  signal?: AbortSignal,
): Promise<readonly Chapter[] | null> {
  const referenced = new Set(tracks.flatMap((entry) => entry.chapterRefs));
  if (referenced.size === 0) return null;

  for (const entry of tracks) {
    if (!referenced.has(entry.track.id) || !entry.stbl) continue;

    const samples = sampleTable(buffer.bytes, entry.stbl, entry.timescale);
    if (samples.length === 0) continue;

    try {
      const cues = await readTextSamples(file, samples.slice(0, MAX_CHAPTERS), { signal });
      if (cues.length === 0) continue;
      return cues.map((cue, index) => ({
        startMs: cue.startMs,
        title: cue.text || `Chapter ${index + 1}`,
      }));
    } catch (thrown) {
      if (signal?.aborted) throw thrown;
      console.warn("[video] could not read the chapter track", thrown);
    }
  }

  return null;
}

/** The track ids used as chapter tracks, which must not be offered as subtitles. */
export function chapterTrackIds(tracks: readonly IsobmffTrack[]): ReadonlySet<number> {
  return new Set(tracks.flatMap((entry) => entry.chapterRefs));
}

/** The `©nam` title and the `©too` writer from `moov/udta/meta/ilst`, if present. */
export function movieTags(
  bytes: Uint8Array,
  moovStart: number,
  moovEnd: number,
): { title?: string; writer?: string } {
  const ilst = findPath(bytes, ["udta", "meta", "ilst"], moovStart, moovEnd);
  if (!ilst) return {};

  const valueOf = (type: string): string | undefined => {
    const item = findBox(bytes, type, ilst.bodyStart, ilst.end);
    if (!item) return undefined;
    const data = findBox(bytes, "data", item.bodyStart, item.end);
    if (!data) return undefined;
    // `data` is a FullBox whose payload begins after four bytes of type and
    // four of locale.
    return decodeText(bytes.subarray(data.bodyStart + 8, data.end)).trim() || undefined;
  };

  return { title: valueOf("©nam"), writer: valueOf("©too") };
}
