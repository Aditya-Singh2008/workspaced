/**
 * AVI.
 *
 * The oldest container in the table and the one whose diagnosis is most
 * clear-cut: **no target webview plays AVI.** Chromium never had a demuxer for
 * it, WebKit dropped its QuickTime-backed one long ago, and webkit2gtk's
 * GStreamer backend is the only one with any chance — and only when the distro
 * shipped the plugin.
 *
 * That makes this parser's job almost entirely about the error message. A user
 * opening an `.avi` will, on two of the three platforms, always see a failure,
 * and the difference between a good and a bad viewer is whether that failure
 * says "unsupported file" or says which codecs are in the file and that the
 * container itself is the obstacle. So the header is still read in full: the
 * codec names, the resolution and the duration all go into the message and the
 * metadata panel, and a file this app cannot play is still a file this app can
 * tell you about.
 *
 * ## Duration comes from the main header, not from a duration field
 *
 * AVI has no duration. `avih` states microseconds per frame and a total frame
 * count, and their product is the length — which makes a variable-frame-rate
 * AVI's duration a nominal figure rather than a measured one. That is inherent
 * to the format rather than a limitation here, and it is why the note says so
 * when the two headers disagree.
 */

import { ByteReader, decodeText, hex } from "../binary";
import { codecLabel } from "../codecs";
import type { ContainerInfo, ContainerParseInput, ContainerTrack } from "../container";
import { bitrateFromSize, emptyContainerInfo, sortTracks } from "../container";
import { chunksIn, findChunk } from "../metadata/riff";

export async function parse(input: ContainerParseInput): Promise<ContainerInfo> {
  const bytes = input.head;

  const riff = findChunk(bytes, "RIFF", 0, bytes.length, "AVI ");
  if (!riff) {
    return emptyContainerInfo();
  }

  const hdrl = findChunk(bytes, "LIST", riff.bodyStart, riff.end, "hdrl");
  if (!hdrl) {
    return emptyContainerInfo();
  }

  const notes: string[] = [];
  const main = readMainHeader(bytes, hdrl);
  const tracks: ContainerTrack[] = [];

  // Each `strl` list is one stream: a `strh` header saying what kind and at what
  // rate, and a `strf` format block whose layout depends on the kind.
  for (const chunk of chunksIn(bytes, hdrl.bodyStart, hdrl.end)) {
    if (chunk.id !== "LIST" || chunk.form !== "strl") continue;
    const track = readStream(bytes, chunk, tracks.length + 1);
    if (track) tracks.push(track);
  }

  if (tracks.length === 0) {
    notes.push("no streams could be read from this file's header");
  }

  // `avih`'s stream count is a header field and the `strl` lists are the streams
  // themselves. A disagreement means the header list was truncated — the file is
  // still playable to whatever extent AVI ever is, but the track menu is
  // incomplete and saying so is better than a menu that quietly lost an entry.
  if (main.streamCount > 0 && main.streamCount !== tracks.length) {
    notes.push(
      `the header declares ${main.streamCount} streams and ${tracks.length} could be read; ` +
        `the header list appears truncated`,
    );
  }

  const durationMs =
    main.microsecondsPerFrame > 0 && main.totalFrames > 0
      ? (main.microsecondsPerFrame * main.totalFrames) / 1000
      : undefined;

  if (durationMs !== undefined) {
    notes.push(
      "AVI has no duration field: this length is the frame count times the nominal frame " +
        "interval, and is approximate for variable-rate files",
    );
  }

  return {
    durationMs,
    tracks: sortTracks(tracks),
    // AVI has no chapter concept at all. Not "none found" — none possible.
    chapters: [],
    bitrate: bitrateFromSize(input.size, durationMs),
    writer: readInfoTag(bytes, riff, "ISFT"),
    title: readInfoTag(bytes, riff, "INAM"),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

interface MainHeader {
  readonly microsecondsPerFrame: number;
  readonly totalFrames: number;
  readonly streamCount: number;
}

function readMainHeader(
  bytes: Uint8Array,
  hdrl: { bodyStart: number; end: number },
): MainHeader {
  const avih = findChunk(bytes, "avih", hdrl.bodyStart, hdrl.end);
  if (!avih) return { microsecondsPerFrame: 0, totalFrames: 0, streamCount: 0 };
  const reader = new ByteReader(bytes, avih.bodyStart);
  return {
    microsecondsPerFrame: reader.u32(avih.bodyStart, true) ?? 0,
    totalFrames: reader.u32(avih.bodyStart + 16, true) ?? 0,
    streamCount: reader.u32(avih.bodyStart + 24, true) ?? 0,
  };
}

/**
 * One `strl` list: the stream header and its format block.
 *
 * The two format blocks are borrowed wholesale from Windows: `BITMAPINFOHEADER`
 * for video, whose `biCompression` is the codec FourCC, and `WAVEFORMATEX` for
 * audio, whose `wFormatTag` is a 16-bit codec number. Those numbers are why
 * `codecs.ts` keys some of its labels on strings like `"0x0055"` — an AVI names
 * MP3 with a number and every other container in this plugin names it with text.
 */
function readStream(
  bytes: Uint8Array,
  strl: { bodyStart: number; end: number },
  fallbackId: number,
): ContainerTrack | null {
  const strh = findChunk(bytes, "strh", strl.bodyStart, strl.end);
  const strf = findChunk(bytes, "strf", strl.bodyStart, strl.end);
  if (!strh) return null;

  const header = new ByteReader(bytes, strh.bodyStart);
  const type = header.ascii(4);
  const handler = header.ascii(4) ?? "";
  if (type === null) return null;

  // `dwScale` and `dwRate`: the stream's time base, whose ratio is the frame
  // rate for a video stream and the sample rate for an audio one.
  const scale = header.u32(strh.bodyStart + 20, true) ?? 0;
  const rate = header.u32(strh.bodyStart + 24, true) ?? 0;

  // The stream's name, when it has one. Rare in AVI and worth showing when set.
  const strn = findChunk(bytes, "strn", strl.bodyStart, strl.end);
  const label = strn ? decodeText(bytes.subarray(strn.bodyStart, strn.end)).trim() : undefined;

  if (type === "vids") {
    let codecId = handler.trim();
    let width: number | undefined;
    let height: number | undefined;

    if (strf) {
      const format = new ByteReader(bytes, strf.bodyStart);
      width = format.u32(strf.bodyStart + 4, true) ?? undefined;
      height = format.u32(strf.bodyStart + 8, true) ?? undefined;
      // `biCompression`, four bytes read as characters. It is the authoritative
      // codec id; `strh`'s handler is frequently blank or set to a decoder name
      // rather than a format, so the format block wins where it has an opinion.
      const compression = format.ascii(4, strf.bodyStart + 16);
      if (compression && compression.trim() && compression !== "\0\0\0\0") {
        codecId = compression.trim();
      }
    }

    return {
      id: fallbackId,
      kind: "video",
      label: label || undefined,
      codecId,
      // No RFC 6381 parameter: AVI's FourCCs do not map onto one, and inventing
      // an `avc1.…` from a FourCC that only says "H264" would be a guess handed
      // to `canPlayType` as though it were read from the file.
      codecLabel: codecLabel(codecId),
      width: width || undefined,
      height: height || undefined,
      frameRate: scale > 0 && rate > 0 ? Math.round((rate / scale) * 1000) / 1000 : undefined,
      isDefault: true,
    };
  }

  if (type === "auds") {
    let codecId = handler.trim();
    let channels: number | undefined;
    let sampleRate: number | undefined;
    let bitrate: number | undefined;

    if (strf) {
      const format = new ByteReader(bytes, strf.bodyStart);
      const tag = format.u16(strf.bodyStart, true);
      if (tag !== null) codecId = `0x${hex(tag, 4)}`;
      channels = format.u16(strf.bodyStart + 2, true) ?? undefined;
      sampleRate = format.u32(strf.bodyStart + 4, true) ?? undefined;
      const bytesPerSecond = format.u32(strf.bodyStart + 8, true) ?? 0;
      if (bytesPerSecond > 0) bitrate = bytesPerSecond * 8;
    }

    return {
      id: fallbackId,
      kind: "audio",
      label: label || undefined,
      codecId,
      codecLabel: codecLabel(codecId),
      channels: channels || undefined,
      sampleRate: sampleRate || undefined,
      bitrate,
      isDefault: true,
    };
  }

  // `txts` streams exist and carry subtitles, but no two writers agree on the
  // payload and there is no index to reach them by. Listed, not read — the same
  // honesty the Matroska parser applies to its own subtitle tracks.
  if (type === "txts") {
    return {
      id: fallbackId,
      kind: "subtitle",
      label: label || undefined,
      codecId: handler.trim() || "txts",
      codecLabel: "AVI text stream",
      isDefault: false,
    };
  }

  // `mids` (MIDI) and vendor-specific stream types. Nothing to show and nothing
  // to play; leaving them out of the track list is the honest result.
  return null;
}

/** A `LIST INFO` tag, which is where AVI keeps the muxer name and the title. */
function readInfoTag(
  bytes: Uint8Array,
  riff: { bodyStart: number; end: number },
  id: string,
): string | undefined {
  const info = findChunk(bytes, "LIST", riff.bodyStart, riff.end, "INFO");
  if (!info) return undefined;
  const tag = findChunk(bytes, id, info.bodyStart, info.end);
  if (!tag) return undefined;
  return decodeText(bytes.subarray(tag.bodyStart, tag.end)).trim() || undefined;
}
