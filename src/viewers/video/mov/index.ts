/**
 * QuickTime (`.mov`).
 *
 * Structurally the same file as an MP4 — see `metadata/isobmff.ts`, which both
 * folders share — and different in the two ways that decide what this plugin can
 * tell the user about one.
 *
 * ## `.mov` is where the undecodable codecs actually live
 *
 * This matters more here than anywhere else in the plugin. An `.mp4` in the wild
 * is nearly always H.264 or HEVC, both of which some engine on some platform
 * decodes. A `.mov` is as likely to be ProRes off an edit bay, DV off a tape
 * deck, or QuickTime Animation out of a compositor — none of which any browser
 * engine has ever decoded, on any platform, and none of which ever will be.
 *
 * The brief's requirement is a "clear, specific error state … naming the codec",
 * and for these files the *most useful* thing to say is not "this platform lacks
 * a decoder", which reads as a fixable configuration problem. It is that no
 * browser engine decodes this format at all. So this parser marks those codecs
 * as it finds them and `mount.ts` phrases the failure accordingly.
 *
 * ## Metadata lives in `udta` directly, not under `meta/ilst`
 *
 * QuickTime's user-data atoms — `©nam`, `©swr`, `©day` — sit straight inside
 * `moov/udta` with a length-and-language header, where MP4's iTunes-style tags
 * are one level deeper inside `meta/ilst` wrapped in a `data` box. Reading only
 * the MP4 layout leaves every QuickTime file's title blank, which looks exactly
 * like a file that has no title.
 */

import { ByteReader, decodeText } from "../binary";
import { codecLabel } from "../codecs";
import type { ContainerInfo, ContainerParseInput, ContainerTrack } from "../container";
import { bitrateFromSize, emptyContainerInfo, sortTracks } from "../container";
import {
  boxesIn,
  chapterTrackIds,
  extractTimedText,
  findBox,
  movieDuration,
  movieTags,
  parseTracks,
  readChapterTrack,
  readMoov,
  type MoovBuffer,
} from "../metadata/isobmff";

/**
 * Codecs no browser engine decodes, on any of the three platforms.
 *
 * Not a platform support table — the module comment explains why that
 * distinction is load-bearing. These are production and archival formats that
 * were never web codecs and are not becoming them, so "this build lacks a
 * decoder" would be misleading advice: there is no build to install.
 */
const NEVER_DECODED_BY_A_WEB_ENGINE: ReadonlySet<string> = new Set([
  "apch", "apcn", "apcs", "apco", "ap4h", // Apple ProRes
  "dvc ", "dvcp", "dvpp", "dv5n", "dv5p", // DV
  "rle ", // QuickTime Animation
  "svq1", "svq3", // Sorenson
  "cvid", // Cinepak
  "jpeg", // Motion JPEG in a QuickTime wrapper
  "mp2v", "mp1v", // MPEG-1/2 video
  "twos", "sowt", "ulaw", "alaw", // uncompressed and companded PCM in a mov
]);

export async function parse(input: ContainerParseInput): Promise<ContainerInfo> {
  const buffer = await readMoov(input.file, input.head, input.size, input.signal);
  if (!buffer) {
    return emptyContainerInfo();
  }

  const notes: string[] = [];
  const { durationMs } = movieDuration(buffer.bytes, buffer.moov.bodyStart, buffer.moov.end);
  const parsed = parseTracks(buffer, codecLabel);

  const cues = await extractTimedText(input.file, buffer, parsed, input.signal);
  const tracks: ContainerTrack[] = parsed.map((entry) => {
    const found = cues.get(entry.track.id);
    return found ? { ...entry.track, cues: found } : entry.track;
  });

  // The chapter track first here, and `chpl` second — the reverse of `mp4/`.
  // Both conventions occur in `.mov` files, and a file written by Apple's own
  // tools uses the track; a `.mov` with a `chpl` came out of a transcoder that
  // put it there by habit.
  const chapters =
    (await readChapterTrack(input.file, buffer, parsed, input.signal)) ?? [];

  // Chapter tracks and timecode tracks are both real tracks that must not be
  // offered for selection: a chapter track in the subtitle menu would put
  // "Chapter 3" on screen for the length of chapter 3, and a timecode track is
  // not something anyone selects. A timecode track is normal in a `.mov` off an
  // edit bay, so its presence is recorded as a note rather than dropped
  // silently — the same rule the image plugin's decode notes follow.
  const chapterTracks = chapterTrackIds(parsed);
  const timecodeTracks = new Set(
    parsed.filter((entry) => entry.fourcc === "tmcd").map((entry) => entry.track.id),
  );
  if (timecodeTracks.size > 0) {
    notes.push("this file carries a timecode track, which is not shown");
  }

  const selectable = tracks.filter(
    (track) => !chapterTracks.has(track.id) && !timecodeTracks.has(track.id),
  );

  const production = selectable.filter((track) =>
    NEVER_DECODED_BY_A_WEB_ENGINE.has(track.codecId),
  );
  if (production.length > 0) {
    const names = [...new Set(production.map((track) => track.codecLabel))];
    notes.push(
      `this file uses ${names.join(" and ")}, which no browser engine decodes on any platform`,
    );
  }

  const { title, writer } = {
    ...movieTags(buffer.bytes, buffer.moov.bodyStart, buffer.moov.end),
    ...quickTimeUserData(buffer),
  };

  return {
    durationMs,
    tracks: sortTracks(selectable),
    chapters,
    bitrate: bitrateFromSize(input.size, durationMs),
    writer,
    title,
    notes,
  };
}

/**
 * QuickTime's `udta` text atoms.
 *
 * Each is a four-character type — `©nam` for the title, `©swr` for the writing
 * software — whose payload is a 16-bit length, a 16-bit language code, and then
 * that many bytes of text. The length is the *text's* length rather than the
 * atom's, which is the detail that makes reading the payload wholesale produce a
 * title with two stray characters on the front.
 */
function quickTimeUserData(buffer: MoovBuffer): { title?: string; writer?: string } {
  const udta = findBox(buffer.bytes, "udta", buffer.moov.bodyStart, buffer.moov.end);
  if (!udta) return {};

  const result: { title?: string; writer?: string } = {};
  for (const atom of boxesIn(buffer.bytes, udta.bodyStart, udta.end)) {
    if (atom.type !== "©nam" && atom.type !== "©swr") continue;
    const reader = new ByteReader(buffer.bytes, atom.bodyStart);
    const length = reader.u16();
    reader.u16(); // language
    if (length === null) continue;
    const text = reader.slice(Math.min(length, atom.end - reader.offset));
    if (!text) continue;
    const value = decodeText(text).trim();
    if (!value) continue;
    if (atom.type === "©nam") result.title = value;
    else result.writer = value;
  }
  return result;
}
