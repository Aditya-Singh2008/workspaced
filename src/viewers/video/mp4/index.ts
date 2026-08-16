/**
 * MP4.
 *
 * The box walking is in `metadata/isobmff.ts`, shared with `mov/` because MP4
 * *is* QuickTime with a brand. What is here is the two things that are MP4's
 * own: how it records chapters, and what has to be said about a fragmented file.
 *
 * ## Chapters, and why there are three ways to write them
 *
 * MP4 never specified chapters, so three conventions grew instead, and a real
 * file may use any of them:
 *
 *   1. **Nero `chpl`**, a flat list in `moov/udta`. The commonest, and the one
 *      every transcoder writes.
 *   2. **A QuickTime chapter track**, referenced from the video track's
 *      `tref/chap`. What Apple's tools write into `.mp4` as readily as `.mov`.
 *   3. **`moov/udta/meta/ilst` keys**, which are per-file metadata rather than
 *      chapters and are not chapters at all. Not read here.
 *
 * All three are tried in that order because that is their order of specificity,
 * and the first that yields anything wins. Reading only `chpl` would silently
 * lose the chapters in every file Apple wrote — silently, because a file with no
 * chapters and a file whose chapters were not found look identical.
 */

import type {
  Chapter,
  ContainerInfo,
  ContainerParseInput,
  ContainerTrack,
} from "../container";
import { bitrateFromSize, emptyContainerInfo, sortTracks } from "../container";
import { ByteReader, decodeText } from "../binary";
import { codecLabel } from "../codecs";
import {
  chapterTrackIds,
  extractTimedText,
  findBox,
  findPath,
  fullBox,
  MAX_CHAPTERS,
  movieDuration,
  movieTags,
  parseTracks,
  readChapterTrack,
  readMoov,
  type MoovBuffer,
} from "../metadata/isobmff";

export async function parse(input: ContainerParseInput): Promise<ContainerInfo> {
  const buffer = await readMoov(input.file, input.head, input.size, input.signal);
  if (!buffer) {
    // No note: the platform decoder reads the stream itself, so a header this
    // parser could not find changes nothing the viewer can act on. The panel
    // falls back to what the decoder reports.
    return emptyContainerInfo();
  }

  const notes: string[] = [];
  const { durationMs } = movieDuration(buffer.bytes, buffer.moov.bodyStart, buffer.moov.end);
  const parsed = parseTracks(buffer, codecLabel);
  const { title, writer } = movieTags(buffer.bytes, buffer.moov.bodyStart, buffer.moov.end);

  // A fragmented file keeps its samples in `moof` boxes after the `moov`, and
  // its `mvhd` duration is either zero or the 32-bit unknown. The element still
  // plays it and still reports a duration once it has loaded, so this is a note
  // rather than a failure — but the metadata panel would otherwise show a
  // duration read from the container that disagrees with the one on the
  // scrubber, and an unexplained disagreement is worse than a stated gap.
  const fragmented = findBox(buffer.bytes, "mvex", buffer.moov.bodyStart, buffer.moov.end);
  if (fragmented && durationMs === undefined) {
    notes.push(
      "this is a fragmented MP4: its duration is not in the header and is taken from the player",
    );
  }

  const cues = await extractTimedText(input.file, buffer, parsed, input.signal);
  const tracks: ContainerTrack[] = parsed.map((entry) => {
    const found = cues.get(entry.track.id);
    return found ? { ...entry.track, cues: found } : entry.track;
  });

  const chapters =
    readNeroChapters(buffer) ??
    (await readChapterTrack(input.file, buffer, parsed, input.signal)) ??
    [];

  // Chapter tracks are a rendering detail, not something to offer for selection:
  // a "subtitle track" whose cues are the chapter titles would appear in the
  // subtitle menu and put "Chapter 3" on screen for the length of chapter 3.
  const chapterTracks = chapterTrackIds(parsed);
  const selectable = tracks.filter((track) => !chapterTracks.has(track.id));

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

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

/**
 * The Nero `chpl` list.
 *
 * Two layouts are in circulation and both appear in files written this decade.
 * Version 1 — what every current muxer writes — has a reserved byte before a
 * 32-bit count; version 0 has an 8-bit count and no reserved byte. Reading the
 * wrong one does not fail, it produces a plausible-looking count from the wrong
 * offset and then a list of chapters at nonsense timestamps, so the version is
 * checked rather than assumed.
 *
 * Timestamps are in 100-nanosecond units, which is a Windows convention that
 * arrived with the format and never left.
 */
function readNeroChapters(buffer: MoovBuffer): readonly Chapter[] | null {
  const chpl = findPath(buffer.bytes, ["udta", "chpl"], buffer.moov.bodyStart, buffer.moov.end);
  if (!chpl) return null;

  const header = fullBox(buffer.bytes, chpl);
  if (!header) return null;

  const reader = new ByteReader(buffer.bytes, header.at);
  let count: number | null;
  if (header.version === 1) {
    reader.skip(1); // reserved
    count = reader.u32();
  } else {
    count = reader.u8();
  }
  if (count === null || count <= 0) return null;

  const chapters: Chapter[] = [];
  for (let index = 0; index < Math.min(count, MAX_CHAPTERS); index += 1) {
    const timestamp = reader.u64();
    const length = reader.u8();
    if (timestamp === null || length === null) break;
    const title = reader.slice(length);
    if (title === null) break;
    chapters.push({
      startMs: Math.round(timestamp / 10_000),
      title: decodeText(title).trim() || `Chapter ${index + 1}`,
    });
  }

  return chapters.length > 0 ? chapters : null;
}
