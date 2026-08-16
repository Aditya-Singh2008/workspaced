/**
 * Video containers built in memory, so the self-test needs no sample files.
 * **Dev builds only.**
 *
 * The same argument `viewers/image/dev/fixtures.ts` and `viewers/pdf/dev/
 * fixture.ts` make: a suite that depends on media files on disk is a suite that
 * does not run on a fresh clone, and container coverage is exactly where a
 * missing fixture hides a regression. It matters more here than anywhere else in
 * the app, because nobody checks a six-gigabyte film into a repository — so
 * without these, the MP4, Matroska, AVI and Ogg parsers would have no test at
 * all beyond "it did not throw".
 *
 * ## These are headers, not playable films
 *
 * Every builder below produces a *structurally real* container header — correct
 * box nesting, correct EBML variable-length integers, correct RIFF chunk
 * padding, correct Ogg segment tables — carrying no media samples. That is
 * precisely what the parsers read, so it is precisely what they can be tested
 * against, and it keeps each fixture in the hundreds of bytes rather than the
 * megabytes a real encode would take.
 *
 * It does mean these files do not *play*, which is the right division: the
 * parsers are tested against handmade bytes, and playback is tested against
 * {@link recordVideo}, which asks the platform to encode a genuine file. When the
 * platform cannot, the playback checks skip with a reason rather than failing —
 * `SelfTestCheck.skipped` exists for this.
 *
 * ## The values are distinctive on purpose
 *
 * 640×360 at 30 fps, five seconds, two audio channels at 48 kHz, chapters at
 * one and three seconds. None of them is a value a parser could produce by
 * accident from a misread offset, which is what makes a check that asserts them
 * worth writing — "it returned a track" passes for a parser reading the wrong
 * bytes entirely.
 */

export const FIXTURE_WIDTH = 640;
export const FIXTURE_HEIGHT = 360;
export const FIXTURE_FPS = 30;
export const FIXTURE_DURATION_MS = 5000;
export const FIXTURE_CHANNELS = 2;
export const FIXTURE_SAMPLE_RATE = 48_000;

/** Chapter marks, in the order they appear. Asserted by name and time. */
export const FIXTURE_CHAPTERS: readonly { startMs: number; title: string }[] = [
  { startMs: 0, title: "Opening" },
  { startMs: 1000, title: "Middle" },
  { startMs: 3000, title: "Closing" },
];

// ---------------------------------------------------------------------------
// Byte plumbing
// ---------------------------------------------------------------------------

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values.map((value) => value & 0xff));
}

function u16be(value: number): Uint8Array {
  return u8(value >>> 8, value);
}

function u32be(value: number): Uint8Array {
  return u8(value >>> 24, value >>> 16, value >>> 8, value);
}

function u16le(value: number): Uint8Array {
  return u8(value, value >>> 8);
}

function u32le(value: number): Uint8Array {
  return u8(value, value >>> 8, value >>> 16, value >>> 24);
}

/** A 64-bit big-endian value, built in two halves because bit shifts are 32-bit. */
function u64be(value: number): Uint8Array {
  const high = Math.floor(value / 2 ** 32);
  return concat([u32be(high), u32be(value >>> 0)]);
}

function u64le(value: number): Uint8Array {
  const high = Math.floor(value / 2 ** 32);
  return concat([u32le(value >>> 0), u32le(high)]);
}

// ---------------------------------------------------------------------------
// ISOBMFF — MP4 and MOV
// ---------------------------------------------------------------------------

/** `[size][type][payload]`, the whole of ISOBMFF's structure. */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32be(body.length + 8), ascii(type), body]);
}

/** A box whose first four payload bytes are a version and three flag bytes. */
function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version, flags >>> 16, flags >>> 8, flags), ...payload);
}

/** The 3×3 fixed-point transform every ISOBMFF header carries. Always identity. */
const IDENTITY_MATRIX = concat([
  u32be(0x00010000), u32be(0), u32be(0),
  u32be(0), u32be(0x00010000), u32be(0),
  u32be(0), u32be(0), u32be(0x40000000),
]);

/**
 * ISO 639-2/T packed into fifteen bits, five per letter, offset from `0x60`.
 *
 * The format's own scheme, and worth building here rather than hardcoding a
 * constant: it is what `unpackLanguage` reverses, and a fixture that hardcoded
 * the answer would pass even if both halves were wrong in the same way.
 */
function packLanguage(code: string): Uint8Array {
  const letters = [...code.padEnd(3, " ")].map((letter) => (letter.charCodeAt(0) - 0x60) & 0x1f);
  return u16be((letters[0]! << 10) | (letters[1]! << 5) | letters[2]!);
}

/** An `avcC` record: the four bytes `avc1.640028` is derived from, and no more. */
function avcConfig(): Uint8Array {
  return box(
    "avcC",
    // configurationVersion, AVCProfileIndication (High), profile_compatibility,
    // AVCLevelIndication (4.0), lengthSizeMinusOne, numOfSPS (0), numOfPPS (0).
    u8(0x01, 0x64, 0x00, 0x28, 0xff, 0xe0, 0x00),
  );
}

/**
 * An `esds` descriptor tree for AAC-LC, which is what `mp4a.40.2` means.
 *
 * Three nested descriptors, each `[tag][length][body]`: an ES_Descriptor holding
 * a DecoderConfigDescriptor holding a DecoderSpecificInfo. The last is the
 * AudioSpecificConfig whose top five bits are the audio object type — `2` for
 * AAC-LC, which is the `2` at the end of the codec string.
 */
function esdsBox(): Uint8Array {
  const descriptor = (tag: number, body: Uint8Array): Uint8Array =>
    concat([u8(tag, body.length), body]);

  const audioSpecificConfig = u8(0x12, 0x10); // objectType 2, 48 kHz, stereo.
  const decoderSpecific = descriptor(0x05, audioSpecificConfig);
  const decoderConfig = descriptor(
    0x04,
    concat([
      u8(0x40, 0x15), // objectTypeIndication (MPEG-4 audio), streamType (audio).
      u8(0x00, 0x00, 0x00), // bufferSizeDB
      u32be(128_000), // maxBitrate
      u32be(128_000), // avgBitrate
      decoderSpecific,
    ]),
  );
  const slConfig = descriptor(0x06, u8(0x02));
  const es = descriptor(0x03, concat([u16be(2), u8(0x00), decoderConfig, slConfig]));
  return fullBox("esds", 0, 0, es);
}

function videoSampleEntry(): Uint8Array {
  return box(
    "avc1",
    u8(0, 0, 0, 0, 0, 0), // reserved
    u16be(1), // data_reference_index
    concat([u16be(0), u16be(0), u32be(0), u32be(0), u32be(0)]), // pre_defined/reserved
    u16be(FIXTURE_WIDTH),
    u16be(FIXTURE_HEIGHT),
    u32be(0x00480000), // horizresolution, 72 dpi
    u32be(0x00480000), // vertresolution
    u32be(0), // reserved
    u16be(1), // frame_count
    new Uint8Array(32), // compressorname
    u16be(0x0018), // depth
    u16be(0xffff), // pre_defined, -1
    avcConfig(),
  );
}

function audioSampleEntry(): Uint8Array {
  return box(
    "mp4a",
    u8(0, 0, 0, 0, 0, 0),
    u16be(1), // data_reference_index
    concat([u16be(0), u16be(0), u32be(0)]), // version, revision, vendor
    u16be(FIXTURE_CHANNELS),
    u16be(16), // sample size
    u16be(0), // pre_defined
    u16be(0), // reserved
    u32be(FIXTURE_SAMPLE_RATE << 16), // 16.16 fixed point
    esdsBox(),
  );
}

function sampleTable(entry: Uint8Array, sampleCount: number, sampleDelta: number): Uint8Array {
  return box(
    "stbl",
    fullBox("stsd", 0, 0, u32be(1), entry),
    // One run of `sampleCount` samples, each `sampleDelta` units long. This is
    // where the frame rate comes from: 1000 units at a 30000 timescale is 30
    // frames a second.
    fullBox("stts", 0, 0, u32be(1), u32be(sampleCount), u32be(sampleDelta)),
    fullBox("stsc", 0, 0, u32be(0)),
    fullBox("stsz", 0, 0, u32be(0), u32be(0)),
    fullBox("stco", 0, 0, u32be(0)),
  );
}

function track(options: {
  id: number;
  handler: "vide" | "soun";
  timescale: number;
  duration: number;
  entry: Uint8Array;
  sampleCount: number;
  sampleDelta: number;
  language: string;
  name: string;
}): Uint8Array {
  const isVideo = options.handler === "vide";
  return box(
    "trak",
    fullBox(
      "tkhd",
      0,
      // enabled | in movie | in preview.
      0x000007,
      u32be(0), // creation
      u32be(0), // modification
      u32be(options.id),
      u32be(0), // reserved
      u32be(Math.round((options.duration / options.timescale) * 1000)),
      concat([u32be(0), u32be(0)]), // reserved
      u16be(0), // layer
      u16be(0), // alternate_group
      u16be(isVideo ? 0 : 0x0100), // volume
      u16be(0), // reserved
      IDENTITY_MATRIX,
      u32be(isVideo ? FIXTURE_WIDTH << 16 : 0),
      u32be(isVideo ? FIXTURE_HEIGHT << 16 : 0),
    ),
    box(
      "mdia",
      fullBox(
        "mdhd",
        0,
        0,
        u32be(0),
        u32be(0),
        u32be(options.timescale),
        u32be(options.duration),
        packLanguage(options.language),
        u16be(0),
      ),
      fullBox(
        "hdlr",
        0,
        0,
        u32be(0),
        ascii(options.handler),
        concat([u32be(0), u32be(0), u32be(0)]),
        ascii(`${options.name}\0`),
      ),
      box("minf", sampleTable(options.entry, options.sampleCount, options.sampleDelta)),
    ),
  );
}

/**
 * The Nero `chpl` chapter list, version 1.
 *
 * Timestamps are in 100-nanosecond units — a Windows convention that arrived
 * with the format and never left — which is why the milliseconds are multiplied
 * by ten thousand here and divided by it in `mp4/index.ts`.
 */
function chplBox(): Uint8Array {
  const entries = FIXTURE_CHAPTERS.map((chapter) => {
    const title = ascii(chapter.title);
    return concat([u64be(chapter.startMs * 10_000), u8(title.length), title]);
  });
  return fullBox(
    "chpl",
    1,
    0,
    u8(0), // reserved
    u32be(FIXTURE_CHAPTERS.length),
    ...entries,
  );
}

/**
 * A complete MP4 header: one H.264 track, one AAC track, three chapters.
 *
 * No `mdat`, because nothing in the parse path reads sample data — the sample
 * table's offsets are only followed for timed-text tracks, and this fixture has
 * none. {@link buildMp4WithSubtitles} is the one that does.
 */
export function buildMp4(options?: { brand?: string; withChapters?: boolean }): Uint8Array {
  const brand = options?.brand ?? "isom";
  const timescale = 30_000;
  const videoDuration = (FIXTURE_DURATION_MS / 1000) * timescale;

  const udta = options?.withChapters === false ? [] : [box("udta", chplBox())];

  return concat([
    box("ftyp", ascii(brand), u32be(512), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41")),
    box(
      "moov",
      fullBox(
        "mvhd",
        0,
        0,
        u32be(0),
        u32be(0),
        u32be(1000), // timescale: milliseconds
        u32be(FIXTURE_DURATION_MS),
        u32be(0x00010000), // rate
        u16be(0x0100), // volume
        u16be(0), // reserved
        concat([u32be(0), u32be(0)]),
        IDENTITY_MATRIX,
        concat([u32be(0), u32be(0), u32be(0), u32be(0), u32be(0), u32be(0)]),
        u32be(3), // next_track_ID
      ),
      track({
        id: 1,
        handler: "vide",
        timescale,
        duration: videoDuration,
        entry: videoSampleEntry(),
        sampleCount: (FIXTURE_DURATION_MS / 1000) * FIXTURE_FPS,
        sampleDelta: timescale / FIXTURE_FPS,
        language: "und",
        name: "VideoHandler",
      }),
      track({
        id: 2,
        handler: "soun",
        timescale: FIXTURE_SAMPLE_RATE,
        duration: (FIXTURE_DURATION_MS / 1000) * FIXTURE_SAMPLE_RATE,
        entry: audioSampleEntry(),
        sampleCount: 1,
        sampleDelta: 1024,
        language: "eng",
        name: "SoundHandler",
      }),
      ...udta,
    ),
  ]);
}

/** The same header with a QuickTime brand, so `mov` and `mp4` can be told apart. */
export function buildMov(): Uint8Array {
  return buildMp4({ brand: "qt  " });
}

// ---------------------------------------------------------------------------
// EBML — WebM and Matroska
// ---------------------------------------------------------------------------

/** An EBML element id, written as the big-endian bytes it already encodes as. */
function ebmlId(id: number): Uint8Array {
  if (id <= 0xff) return u8(id);
  if (id <= 0xffff) return u16be(id);
  if (id <= 0xffffff) return u8(id >>> 16, id >>> 8, id);
  return u32be(id);
}

/**
 * An EBML variable-length size.
 *
 * The leading one-bit says how many bytes the number occupies, and the rest is
 * the value — so the same integer has a different encoding at each width, and a
 * writer that always used four bytes would still be valid. Four is used here
 * for everything above 2^21 and the smallest width otherwise, which is what real
 * muxers do and what exercises the reader's width detection.
 */
function ebmlSize(value: number): Uint8Array {
  if (value < 2 ** 7 - 1) return u8(0x80 | value);
  if (value < 2 ** 14 - 1) return u8(0x40 | (value >>> 8), value);
  if (value < 2 ** 21 - 1) return u8(0x20 | (value >>> 16), value >>> 8, value);
  return u8(0x10 | (value >>> 24), value >>> 16, value >>> 8, value);
}

function ebml(id: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([ebmlId(id), ebmlSize(body.length), body]);
}

/** An unsigned integer, in the fewest bytes that hold it. EBML's own rule. */
function ebmlUint(id: number, value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.round(value));
  do {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return ebml(id, Uint8Array.from(bytes));
}

function ebmlString(id: number, text: string): Uint8Array {
  return ebml(id, ascii(text));
}

/** An 8-byte IEEE double, which is how Matroska stores a duration. */
function ebmlFloat(id: number, value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return ebml(id, new Uint8Array(buffer));
}

const ID = {
  header: 0x1a45dfa3,
  docType: 0x4282,
  docTypeVersion: 0x4287,
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
  language: 0x22b59c,
  flagDefault: 0x88,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  defaultDuration: 0x23e383,
  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  chapters: 0x1043a770,
  editionEntry: 0x45b9,
  chapterAtom: 0xb6,
  chapterTimeStart: 0x91,
  chapterDisplay: 0x80,
  chapterString: 0x85,
  cluster: 0x1f43b675,
} as const;

export interface MatroskaOptions {
  /** `"webm"` or `"matroska"`. The only thing that separates the two formats. */
  readonly docType?: string;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  /** Adds a subtitle track, which Matroska declares and this plugin cannot read. */
  readonly subtitleCodec?: string;
}

/**
 * A Matroska or WebM header: EBML header, Info, Tracks, Chapters, and an empty
 * Cluster to mark where the header stops.
 *
 * The Cluster matters: `readSegmentHeader` walks elements until it reaches one,
 * because everything a parser wants is before the first Cluster and everything
 * after it is media. A fixture without one would leave the walk running off the
 * end of the buffer, which is the case worth having covered.
 */
export function buildMatroska(options?: MatroskaOptions): Uint8Array {
  const docType = options?.docType ?? "webm";
  const videoCodec = options?.videoCodec ?? "V_VP9";
  const audioCodec = options?.audioCodec ?? "A_OPUS";

  const trackEntries = [
    ebml(
      ID.trackEntry,
      ebmlUint(ID.trackNumber, 1),
      ebmlUint(ID.trackType, 1), // video
      ebmlString(ID.codecId, videoCodec),
      ebmlString(ID.trackName, "Picture"),
      ebmlString(ID.language, "und"),
      ebmlUint(ID.flagDefault, 1),
      // Nanoseconds per frame: the only place a Matroska file states a rate.
      ebmlUint(ID.defaultDuration, Math.round(1_000_000_000 / FIXTURE_FPS)),
      ebml(
        ID.video,
        ebmlUint(ID.pixelWidth, FIXTURE_WIDTH),
        ebmlUint(ID.pixelHeight, FIXTURE_HEIGHT),
      ),
    ),
    ebml(
      ID.trackEntry,
      ebmlUint(ID.trackNumber, 2),
      ebmlUint(ID.trackType, 2), // audio
      ebmlString(ID.codecId, audioCodec),
      ebmlString(ID.language, "eng"),
      ebml(
        ID.audio,
        ebmlFloat(ID.samplingFrequency, FIXTURE_SAMPLE_RATE),
        ebmlUint(ID.channels, FIXTURE_CHANNELS),
      ),
    ),
  ];

  if (options?.subtitleCodec) {
    trackEntries.push(
      ebml(
        ID.trackEntry,
        ebmlUint(ID.trackNumber, 3),
        ebmlUint(ID.trackType, 17), // subtitle
        ebmlString(ID.codecId, options.subtitleCodec),
        ebmlString(ID.language, "fra"),
      ),
    );
  }

  const chapterAtoms = FIXTURE_CHAPTERS.map((chapter, index) =>
    ebml(
      ID.chapterAtom,
      // Matroska's chapter uid is required and arbitrary; a stable one keeps the
      // fixture byte-identical between runs.
      ebmlUint(0x73c4, index + 1),
      ebmlUint(ID.chapterTimeStart, chapter.startMs * 1_000_000),
      ebml(ID.chapterDisplay, ebmlString(ID.chapterString, chapter.title)),
    ),
  );

  return concat([
    ebml(ID.header, ebmlString(ID.docType, docType), ebmlUint(ID.docTypeVersion, 2)),
    ebml(
      ID.segment,
      ebml(
        ID.info,
        // A one-millisecond tick, so the duration below reads as milliseconds.
        ebmlUint(ID.timecodeScale, 1_000_000),
        ebmlFloat(ID.duration, FIXTURE_DURATION_MS),
        ebmlString(ID.title, "Fixture"),
        ebmlString(ID.muxingApp, "workspace-fixture"),
        ebmlString(ID.writingApp, "workspace-fixture"),
      ),
      ebml(ID.tracks, ...trackEntries),
      ebml(ID.chapters, ebml(ID.editionEntry, ...chapterAtoms)),
      ebml(ID.cluster, ebmlUint(0xe7, 0)),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// RIFF — AVI
// ---------------------------------------------------------------------------

/**
 * A RIFF chunk, padded to an even length.
 *
 * The padding byte is not counted in the size, which is the detail every naive
 * RIFF reader gets wrong: a chunk of odd length followed by another lands the
 * reader one byte into the next chunk's id, and every chunk after it is
 * garbage that still parses.
 */
function riffChunk(id: string, body: Uint8Array): Uint8Array {
  const padded = body.length % 2 === 1 ? concat([body, u8(0)]) : body;
  return concat([ascii(id), u32le(body.length), padded]);
}

function riffList(type: string, ...children: Uint8Array[]): Uint8Array {
  return riffChunk("LIST", concat([ascii(type), ...children]));
}

/** An AVI header: one XVID video stream and one MP3 audio stream. */
export function buildAvi(): Uint8Array {
  const microsecondsPerFrame = Math.round(1_000_000 / FIXTURE_FPS);
  const totalFrames = (FIXTURE_DURATION_MS / 1000) * FIXTURE_FPS;

  const avih = riffChunk(
    "avih",
    concat([
      u32le(microsecondsPerFrame),
      u32le(0), // dwMaxBytesPerSec
      u32le(0), // dwPaddingGranularity
      u32le(0x10), // dwFlags: HAS_INDEX
      u32le(totalFrames),
      u32le(0), // dwInitialFrames
      u32le(2), // dwStreams
      u32le(0), // dwSuggestedBufferSize
      u32le(FIXTURE_WIDTH),
      u32le(FIXTURE_HEIGHT),
      concat([u32le(0), u32le(0), u32le(0), u32le(0)]), // dwReserved
    ]),
  );

  const videoStream = riffList(
    "strl",
    riffChunk(
      "strh",
      concat([
        ascii("vids"),
        ascii("XVID"),
        u32le(0), // dwFlags
        u16le(0), // wPriority
        u16le(0), // wLanguage
        u32le(0), // dwInitialFrames
        u32le(1), // dwScale
        u32le(FIXTURE_FPS), // dwRate — rate/scale is the frame rate
        u32le(0), // dwStart
        u32le(totalFrames),
        u32le(0), // dwSuggestedBufferSize
        u32le(0), // dwQuality
        u32le(0), // dwSampleSize
        concat([u32le(0), u32le(0)]), // rcFrame
      ]),
    ),
    riffChunk(
      "strf",
      concat([
        u32le(40), // biSize
        u32le(FIXTURE_WIDTH),
        u32le(FIXTURE_HEIGHT),
        u16le(1), // biPlanes
        u16le(24), // biBitCount
        ascii("XVID"), // biCompression — the authoritative codec id
        concat([u32le(0), u32le(0), u32le(0), u32le(0), u32le(0)]),
      ]),
    ),
  );

  const audioStream = riffList(
    "strl",
    riffChunk(
      "strh",
      concat([
        ascii("auds"),
        // `fccHandler` is four characters and is routinely blank for audio —
        // the real codec id is `wFormatTag` in the format block below, which is
        // exactly why the parser prefers it.
        ascii("\0\0\0\0"),
        u32le(0),
        u16le(0),
        u16le(0),
        u32le(0),
        u32le(1), // dwScale
        u32le(FIXTURE_SAMPLE_RATE), // dwRate
        u32le(0),
        u32le(0),
        u32le(0),
        u32le(0),
        u32le(0),
        concat([u32le(0), u32le(0)]),
      ]),
    ),
    riffChunk(
      "strf",
      concat([
        u16le(0x0055), // wFormatTag: MP3
        u16le(FIXTURE_CHANNELS),
        u32le(FIXTURE_SAMPLE_RATE),
        u32le(16_000), // nAvgBytesPerSec
        u16le(0), // nBlockAlign
        u16le(0), // wBitsPerSample
      ]),
    ),
  );

  const hdrl = riffList("hdrl", avih, videoStream, audioStream);
  const info = riffList("INFO", riffChunk("ISFT", ascii("workspace-fixture\0")));
  const movi = riffList("movi");

  const body = concat([ascii("AVI "), hdrl, info, movi]);
  return concat([ascii("RIFF"), u32le(body.length), body]);
}

// ---------------------------------------------------------------------------
// Ogg — OGV
// ---------------------------------------------------------------------------

/**
 * One Ogg page.
 *
 * The segment table is the interesting part: a page's payload is described as a
 * list of lengths capped at 255, where a value below 255 ends a packet. A
 * payload under 255 bytes is therefore one segment, which is all these fixtures
 * need. The CRC is left zero — nothing in this plugin verifies it, and a page
 * that has to be re-checksummed after every edit is a fixture nobody maintains.
 */
function oggPage(options: {
  headerType: number;
  granule: number;
  serial: number;
  sequence: number;
  payload: Uint8Array;
}): Uint8Array {
  const segments: number[] = [];
  let remaining = options.payload.length;
  while (remaining >= 255) {
    segments.push(255);
    remaining -= 255;
  }
  segments.push(remaining);

  return concat([
    ascii("OggS"),
    u8(0), // stream structure version
    u8(options.headerType),
    u64le(options.granule),
    u32le(options.serial),
    u32le(options.sequence),
    u32le(0), // CRC
    u8(segments.length),
    Uint8Array.from(segments),
    options.payload,
  ]);
}

/** A Theora identification header, the layout `ogv/index.ts` reads. */
function theoraIdentification(): Uint8Array {
  const header = new Uint8Array(42);
  header.set(u8(0x80), 0);
  header.set(ascii("theora"), 1);
  header.set(u8(3, 2, 1), 7); // VMAJ, VMIN, VREV
  header.set(u16be(FIXTURE_WIDTH >> 4), 10); // FMBW, in macroblocks
  header.set(u16be(FIXTURE_HEIGHT >> 4), 12); // FMBH
  // PICW and PICH, 24-bit: the real picture size, which is what the parser uses.
  header.set(u8(0, FIXTURE_WIDTH >>> 8, FIXTURE_WIDTH), 14);
  header.set(u8(0, FIXTURE_HEIGHT >>> 8, FIXTURE_HEIGHT), 17);
  header.set(u32be(FIXTURE_FPS), 22); // FRN
  header.set(u32be(1), 26); // FRD
  // The keyframe granule shift, split across two bytes at 40 and 41: six here,
  // which is the value every encoder writes.
  header.set(u8(0x00, 0xc0), 40);
  return header;
}

/** A Vorbis identification header. */
function vorbisIdentification(): Uint8Array {
  const header = new Uint8Array(30);
  header.set(u8(0x01), 0);
  header.set(ascii("vorbis"), 1);
  header.set(u32le(0), 7); // version
  header.set(u8(FIXTURE_CHANNELS), 11);
  header.set(u32le(FIXTURE_SAMPLE_RATE), 12);
  return header;
}

/**
 * An Ogg file with a Theora and a Vorbis stream.
 *
 * Two beginning-of-stream pages, then a tail page per stream carrying the
 * granule position the duration is derived from — which is how Ogg states a
 * duration at all: it does not, and the last page's granule is the only answer.
 */
export function buildOgv(): Uint8Array {
  const theoraSerial = 0x1111;
  const vorbisSerial = 0x2222;
  const frames = (FIXTURE_DURATION_MS / 1000) * FIXTURE_FPS;

  return concat([
    oggPage({ headerType: 0x02, granule: 0, serial: theoraSerial, sequence: 0, payload: theoraIdentification() }),
    oggPage({ headerType: 0x02, granule: 0, serial: vorbisSerial, sequence: 0, payload: vorbisIdentification() }),
    // The keyframe shift is six, so a granule of `frames << 6` is "frame
    // `frames`, and it was a keyframe" — the encoding the parser reverses.
    oggPage({
      headerType: 0x04,
      granule: frames * 2 ** 6,
      serial: theoraSerial,
      sequence: 1,
      payload: u8(0),
    }),
    oggPage({
      headerType: 0x04,
      granule: (FIXTURE_DURATION_MS / 1000) * FIXTURE_SAMPLE_RATE,
      serial: vorbisSerial,
      sequence: 1,
      payload: u8(0),
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

/** What every subtitle fixture says, so one assertion covers all three formats. */
export const FIXTURE_CUES: readonly { startMs: number; endMs: number; text: string }[] = [
  { startMs: 500, endMs: 2000, text: "The first line." },
  { startMs: 2500, endMs: 4000, text: "A second line\nover two rows." },
  { startMs: 4200, endMs: 4900, text: "The last line." },
];

function srtTime(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const rest = milliseconds % 1000;
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(rest, 3)}`;
}

export function buildSrt(): string {
  return FIXTURE_CUES.map(
    (cue, index) =>
      `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`,
  ).join("\n");
}

export function buildVtt(): string {
  const body = FIXTURE_CUES.map(
    (cue) =>
      `${srtTime(cue.startMs).replace(",", ".")} --> ${srtTime(cue.endMs).replace(",", ".")}\n` +
      // Markup a real caption file carries and a parser has to strip.
      `<v Speaker>${cue.text}</v>\n`,
  ).join("\n");
  return `WEBVTT\n\n${body}`;
}

/**
 * An ASS file whose `Format:` line puts the columns in an unusual order.
 *
 * Deliberately not the conventional order: ASS declares its own column layout
 * and a parser that assumes the common one reads the end time as the text on
 * any file written by a tool that ordered them differently. The fixture is the
 * only way to notice.
 */
export function buildAss(): string {
  const assTime = (milliseconds: number): string => {
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
    const seconds = Math.floor((milliseconds % 60_000) / 1000);
    const centiseconds = Math.floor((milliseconds % 1000) / 10);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centiseconds)}`;
  };

  const lines = FIXTURE_CUES.map(
    (cue) =>
      `Dialogue: ${assTime(cue.startMs)},${assTime(cue.endMs)},Default,,0,0,0,,` +
      `{\\pos(10,10)}${cue.text.replace("\n", "\\N")}`,
  );

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "",
    "[Events]",
    "Format: Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...lines,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// A file that actually plays
// ---------------------------------------------------------------------------

/** How long to let the recorder run. Two frames is enough to have a duration. */
const RECORD_MS = 400;

/**
 * Why no file could be recorded, or the file itself.
 *
 * A result rather than `null`, because the two reasons are different facts and
 * a skipped check has to say which: a platform with no recorder will never cover
 * this, while a recorder that produced nothing will cover it as soon as the
 * window is in front. AGENTS.md is specific that a skip's reason should say what
 * would make it run.
 */
export type RecordingResult =
  | { readonly ok: true; readonly video: RecordedVideo }
  | { readonly ok: false; readonly reason: string };

/** A file the platform encoded, and what it actually turned out to be. */
export interface RecordedVideo {
  readonly bytes: Uint8Array;
  /** The recorder's own answer, which is *not* always what was asked for. */
  readonly mimeType: string;
  /** Derived from {@link mimeType}, so the file's name does not lie either. */
  readonly extension: string;
}

/**
 * A real, playable video, encoded by the platform from a canvas.
 *
 * The handmade fixtures above cover every parser and none of the player, and the
 * player is where the platform differences live. `MediaRecorder` is the only way
 * to obtain a genuine encoded file without shipping one — and it is *not*
 * present everywhere: WKWebView has no `MediaRecorder` at all, and the codec a
 * build accepts varies.
 *
 * **The container is whatever the recorder chose, and it is not always WebM.**
 * webkit2gtk on this machine returns MP4, and an earlier version of this
 * function assumed otherwise: the bytes were handed out labelled `video/webm`,
 * the blob URL carried that type, and the engine refused its own recording
 * because the declared type disagreed with the content. So the recorder's answer
 * is returned alongside the bytes and every caller uses it.
 *
 * Never throws, and every check built on it skips with the returned reason. A
 * green report with skips is not the same as a green one without, which is the
 * point of the distinction.
 */
export async function recordVideo(): Promise<RecordingResult> {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext("2d");
    if (!context) return { ok: false, reason: "this webview has no 2D canvas context" };

    // Something has to change between frames: an encoder handed an unchanging
    // canvas may emit a single frame and a file with no duration.
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const capture = (canvas as HTMLCanvasElement & {
      captureStream?: (frameRate?: number) => MediaStream;
    }).captureStream;
    if (typeof capture !== "function") {
      return {
        ok: false,
        reason:
          "this webview has no canvas.captureStream, so no file can be encoded in " +
          "memory; open a real video file to check playback",
      };
    }

    if (typeof MediaRecorder === "undefined") {
      return {
        ok: false,
        reason:
          "this platform has no MediaRecorder — WKWebView has none — so no genuinely " +
          "playable file could be produced in memory; open a real video file to check playback",
      };
    }

    const stream = capture.call(canvas, 10);

    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];

    const finished = new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      // Bounded, like every other wait in this plugin: a recorder that never
      // fires `stop` would hang the suite, and AGENTS.md is explicit that a hang
      // reports nothing and is strictly worse than a failure.
      setTimeout(resolve, RECORD_MS * 4);
    });

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.start();

    const painting = setInterval(() => {
      context.fillStyle = context.fillStyle === "#ff0000" ? "#0000ff" : "#ff0000";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }, 50);

    await new Promise((resolve) => setTimeout(resolve, RECORD_MS));
    clearInterval(painting);
    recorder.stop();
    await finished;

    for (const track of stream.getTracks()) track.stop();
    canvas.width = 0;
    canvas.height = 0;

    if (chunks.length === 0) {
      return {
        ok: false,
        reason:
          "the recorder produced no data — a window that is not being composited " +
          "delivers no frames to capture, which is the usual cause. Bring the window " +
          "to the front and run the self-tests again to cover this",
      };
    }
    // The recorder's type, not a guess. `MediaRecorder.mimeType` carries codec
    // parameters a blob URL should not, so the chunk's own type wins and the
    // parameters are trimmed off whichever it comes from.
    const declared = (chunks[0]!.type || recorder.mimeType || "video/webm").split(";")[0]!.trim();
    const blob = new Blob(chunks, { type: declared });
    return {
      ok: true,
      video: {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mimeType: declared,
        extension: declared.includes("mp4") ? "mp4" : declared.includes("ogg") ? "ogv" : "webm",
      },
    };
  } catch (thrown) {
    return {
      ok: false,
      reason: `the recorder failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    };
  }
}
