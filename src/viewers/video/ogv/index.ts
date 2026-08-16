/**
 * Ogg (`.ogv`).
 *
 * The page walking is in `metadata/ogg.ts`; what is here is what each codec's
 * identification header says and how each one's granule position converts to
 * time — which is per-codec rather than per-container, and is the reason a
 * generic page walk cannot produce a duration on its own.
 *
 * ## Every stream identifies itself in its first packet
 *
 * Theora, Vorbis, Opus, FLAC and Speex each begin with a magic string and then
 * their own fixed header layout. There is no table of contents: the codec list
 * *is* the set of streams whose first page was found, which is why an Ogg file
 * with a stream starting late in the file — legal, and what chaining produces —
 * has that stream missing from the list here. Noted rather than papered over.
 *
 * ## Theora is a decoder question, not a container one
 *
 * Every target webview opens Ogg. Whether it *decodes* Theora is the variable:
 * Firefox always did, and Chromium removed it, so WebView2 opens the container
 * and refuses the video. That is the same shape of failure as WebM-with-AV1 and
 * the opposite of Matroska's, and it is worth the plugin distinguishing them.
 */

import { ByteReader } from "../binary";
import { codecLabel } from "../codecs";
import type { ContainerInfo, ContainerParseInput, ContainerTrack } from "../container";
import { bitrateFromSize, emptyContainerInfo, sortTracks } from "../container";
import { pagesIn, readTailGranules } from "../metadata/ogg";

/** How much of the end of the file to scan for the last pages. */
const TAIL_WINDOW = 128 * 1024;

interface Stream {
  readonly serial: number;
  readonly track: ContainerTrack;
  /** Turns a granule position into milliseconds, per this codec's rules. */
  readonly granuleToMs: (granule: number) => number | undefined;
}

export async function parse(input: ContainerParseInput): Promise<ContainerInfo> {
  const notes: string[] = [];
  const streams: Stream[] = [];

  for (const page of pagesIn(input.head)) {
    if (!page.beginsStream) continue;
    const stream = identify(page.serial, page.payload, streams.length + 1);
    if (stream) streams.push(stream);
    // Ogg requires every stream's beginning-of-stream page to precede all other
    // pages, so once a page that is not one appears, the stream list is complete.
    else if (streams.length > 0) break;
  }

  if (streams.length === 0) {
    return emptyContainerInfo();
  }

  // The duration is at the far end of the file. A file smaller than the window
  // has already been read into the head, so this costs a read only for the ones
  // large enough to need it.
  let durationMs: number | undefined;
  try {
    const granules =
      input.size <= input.head.length
        ? tailGranulesFrom(input.head)
        : await readTailGranules(input.file, input.size, TAIL_WINDOW, input.signal);

    for (const stream of streams) {
      const granule = granules.get(stream.serial);
      if (granule === undefined) continue;
      const milliseconds = stream.granuleToMs(granule);
      if (milliseconds === undefined) continue;
      // The longest stream is the file's duration: an audio track a few
      // milliseconds longer than the video is normal, and taking the video's
      // alone would report a length the player disagrees with.
      durationMs = Math.max(durationMs ?? 0, milliseconds);
    }
  } catch (thrown) {
    if (input.signal?.aborted) throw thrown;
    notes.push("this file's end could not be read, so its duration is taken from the player");
  }

  if (durationMs === undefined && notes.length === 0) {
    notes.push(
      "no end-of-stream page carried a usable position, so the duration is taken from the player",
    );
  }

  return {
    durationMs,
    tracks: sortTracks(streams.map((stream) => stream.track)),
    // Ogg carries chapters as `CHAPTER01=` comments in a Vorbis comment block,
    // a convention with no specification behind it and no agreement between the
    // tools that write it. Not read: a chapter list assembled from a convention
    // half the writers follow is worse than none, because a partial list looks
    // complete.
    chapters: [],
    bitrate: bitrateFromSize(input.size, durationMs),
    notes,
  };
}

/** The tail granules of a file small enough to be entirely in the head buffer. */
function tailGranulesFrom(bytes: Uint8Array): Map<number, number> {
  const granules = new Map<number, number>();
  for (const page of pagesIn(bytes)) {
    if (page.granule > 0) {
      granules.set(page.serial, Math.max(granules.get(page.serial) ?? 0, page.granule));
    }
  }
  return granules;
}

/**
 * Recognises a stream from its identification packet.
 *
 * Each codec's magic is its own: Theora's is `\x80theora`, Vorbis's
 * `\x01vorbis`, Opus's `OpusHead`. The leading byte in the first two is a packet
 * type, which is why they are checked from offset 1 — matching from offset 0
 * works for Opus and silently fails for the other two.
 */
function identify(serial: number, payload: Uint8Array, id: number): Stream | null {
  const magic = (text: string, offset: number): boolean => {
    if (offset + text.length > payload.length) return false;
    for (let index = 0; index < text.length; index += 1) {
      if (payload[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  };

  // --- Theora --------------------------------------------------------------
  if (magic("theora", 1) && payload.length >= 42) {
    const reader = new ByteReader(payload, 0);
    // Frame dimensions are stored in macroblocks at offsets 10 and 12, and in
    // pixels at 14 and 17 as 24-bit values. The pixel figures are the real
    // picture size and the macroblock ones are it rounded up to a multiple of
    // sixteen, so a 1920×1080 video reports 1088 from the wrong pair.
    const width = ((payload[14]! << 16) | (payload[15]! << 8) | payload[16]!) >>> 0;
    const height = ((payload[17]! << 16) | (payload[18]! << 8) | payload[19]!) >>> 0;
    const rateNumerator = reader.u32(22, false) ?? 0;
    const rateDenominator = reader.u32(26, false) ?? 0;
    const fps = rateDenominator > 0 ? rateNumerator / rateDenominator : 0;
    // Theora's granule is two counts packed together: the frame number of the
    // last keyframe in the high bits, and the offset since it in the low bits,
    // with the split declared in the header. Adding the two halves gives the
    // absolute frame number.
    const keyframeShift = ((payload[40]! & 0x03) << 3) | ((payload[41]! & 0xe0) >> 5);

    return {
      serial,
      track: {
        id,
        kind: "video",
        codecId: "theora",
        codec: "theora",
        codecLabel: codecLabel("theora"),
        width: width || undefined,
        height: height || undefined,
        frameRate: fps ? Math.round(fps * 1000) / 1000 : undefined,
        isDefault: true,
      },
      granuleToMs: (granule) => {
        if (!fps) return undefined;
        const keyframe = Math.floor(granule / 2 ** keyframeShift);
        const offset = granule % 2 ** keyframeShift;
        return ((keyframe + offset) / fps) * 1000;
      },
    };
  }

  // --- Vorbis --------------------------------------------------------------
  if (magic("vorbis", 1) && payload.length >= 16) {
    const reader = new ByteReader(payload, 0);
    const channels = payload[11] ?? 0;
    const sampleRate = reader.u32(12, true) ?? 0;
    return {
      serial,
      track: {
        id,
        kind: "audio",
        codecId: "vorbis",
        codec: "vorbis",
        codecLabel: codecLabel("vorbis"),
        channels: channels || undefined,
        sampleRate: sampleRate || undefined,
        isDefault: true,
      },
      granuleToMs: (granule) =>
        sampleRate > 0 ? (granule / sampleRate) * 1000 : undefined,
    };
  }

  // --- Opus ----------------------------------------------------------------
  if (magic("OpusHead", 0) && payload.length >= 19) {
    const channels = payload[9] ?? 0;
    const preSkip = (payload[11]! << 8) | payload[10]!;
    return {
      serial,
      track: {
        id,
        kind: "audio",
        codecId: "opus",
        codec: "opus",
        codecLabel: codecLabel("opus"),
        channels: channels || undefined,
        // Opus granules are always counted at 48 kHz whatever the source rate,
        // which is a property of the codec rather than of this file.
        sampleRate: 48_000,
        isDefault: true,
      },
      granuleToMs: (granule) => (Math.max(0, granule - preSkip) / 48_000) * 1000,
    };
  }

  // --- FLAC and Speex, listed but not timed --------------------------------
  // Both appear in Ogg files and neither carries a rate this parser reads. They
  // are listed so the track menu and the panel are complete; the duration comes
  // from whichever stream did supply one, which in a video file is the video.
  if (magic("FLAC", 1)) {
    return {
      serial,
      track: {
        id,
        kind: "audio",
        codecId: "flac",
        codec: "flac",
        codecLabel: codecLabel("flac"),
        isDefault: true,
      },
      granuleToMs: () => undefined,
    };
  }
  if (magic("Speex   ", 0)) {
    return {
      serial,
      track: {
        id,
        kind: "audio",
        codecId: "speex",
        codecLabel: codecLabel("speex"),
        isDefault: true,
      },
      granuleToMs: () => undefined,
    };
  }

  return null;
}
