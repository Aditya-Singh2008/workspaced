/**
 * Matroska (`.mkv`).
 *
 * Byte-for-byte the same EBML structure as WebM — see `metadata/ebml.ts` — and
 * the opposite situation in every way that matters to a user.
 *
 * ## Matroska is the container most likely to fail, and least likely to be the
 * file's fault
 *
 * Chromium has no Matroska demuxer, so WebView2 opens no `.mkv` at all, whatever
 * is inside it. WKWebView likewise. webkit2gtk demuxes it through GStreamer and
 * usually plays it. That is the widest single behaviour gap in this plugin: the
 * *same file* plays on Linux and produces a blank player on Windows and macOS,
 * and the codecs are irrelevant to the difference.
 *
 * This is exactly the case the brief's error requirement was written for, and it
 * is why the container check in `codecs.ts` runs before the per-track one: telling
 * someone their HEVC track is unsupported, when the real answer is that this
 * engine does not open Matroska and would refuse an H.264 track just the same,
 * sends them to re-encode a file that only needed remuxing.
 *
 * ## Subtitles are listed, not extracted, and the difference is stated
 *
 * Matroska stores subtitle samples interleaved through every cluster in the
 * file, with no index that reaches them — the `Cues` element indexes video
 * keyframes for seeking, not text. Extracting a subtitle track therefore means
 * reading the entire file, which for a feature-length `.mkv` is several
 * gigabytes to recover a few kilobytes of text, and this plugin's whole parsing
 * strategy is built on never doing that (`container.ts`).
 *
 * So embedded subtitle tracks are listed with their language and codec, appear
 * in the track menu marked unavailable, and are named in the metadata panel —
 * and a sidecar `.srt` or `.vtt` beside the file is read in full and works
 * completely. That split is stated rather than papered over, for the same reason
 * the image plugin says out loud that a RAW file is showing its embedded preview:
 * silently showing a partial answer as though it were the whole one is a lie of
 * omission, and a subtitle menu whose entries do nothing is exactly that.
 *
 * MP4 and QuickTime have no such problem — their sample tables index every cue —
 * and `metadata/isobmff.ts` extracts them, which is why the two containers behave
 * differently here and why that difference is worth a paragraph.
 */

import { codecLabel } from "../codecs";
import type { ContainerInfo, ContainerParseInput, ContainerTrack } from "../container";
import { bitrateFromSize, emptyContainerInfo, sortTracks } from "../container";
import {
  parseSegmentChapters,
  parseSegmentInfo,
  parseSegmentTracks,
  readSegmentHeader,
} from "../metadata/ebml";

/**
 * Subtitle codecs whose samples are images rather than text.
 *
 * Worth distinguishing from the text ones in what is said about them: a text
 * track is one this plugin *could* have read given an index, and a bitmap track
 * is one it could not read at all — rendering PGS means decoding run-length
 * images and compositing them, which is a feature, not a parse.
 */
const BITMAP_SUBTITLES: ReadonlySet<string> = new Set([
  "S_VOBSUB",
  "S_HDMV/PGS",
  "S_HDMV/TEXTST",
  "S_DVBSUB",
]);

export async function parse(input: ContainerParseInput): Promise<ContainerInfo> {
  const header = await readSegmentHeader(input.file, input.head, input.size, input.signal);
  if (!header) {
    return emptyContainerInfo();
  }

  const notes: string[] = [];
  const info = parseSegmentInfo(header);
  const tracks = parseSegmentTracks(header, codecLabel);
  const chapters = parseSegmentChapters(header);

  if (tracks.length === 0) {
    notes.push(
      header.truncated
        ? "this file's track list sits after its clusters and was not reached — it is most " +
          "likely a live recording still being written"
        : "this file declares no tracks",
    );
  }

  describeSubtitles(tracks, notes);

  // Several audio tracks is the normal shape of a Matroska file and is one of
  // the two reasons people use the container. Saying so up front turns "why is
  // this in the wrong language" into a menu the user knows to open.
  const audio = tracks.filter((track) => track.kind === "audio");
  if (audio.length > 1) {
    notes.push(
      `${audio.length} audio tracks — the one playing can be changed from the track menu`,
    );
  }

  return {
    durationMs: info.durationMs,
    tracks: sortTracks(tracks),
    chapters,
    bitrate: bitrateFromSize(input.size, info.durationMs),
    writer: info.writer,
    title: info.title,
    notes,
  };
}

function describeSubtitles(tracks: readonly ContainerTrack[], notes: string[]): void {
  const subtitles = tracks.filter((track) => track.kind === "subtitle");
  if (subtitles.length === 0) return;

  const bitmap = subtitles.filter((track) => BITMAP_SUBTITLES.has(track.codecId));
  const text = subtitles.filter((track) => !BITMAP_SUBTITLES.has(track.codecId));

  if (text.length > 0) {
    notes.push(
      `${text.length} embedded text subtitle ${text.length === 1 ? "track is" : "tracks are"} ` +
        `listed but not extracted: Matroska interleaves subtitle text through every cluster in ` +
        `the file with no index reaching it, so reading it would mean reading the whole file. ` +
        `A sidecar .srt or .vtt beside the video is read in full and works normally`,
    );
  }

  if (bitmap.length > 0) {
    const names = [...new Set(bitmap.map((track) => track.codecLabel))];
    notes.push(
      `${bitmap.length} subtitle ${bitmap.length === 1 ? "track is" : "tracks are"} ` +
        `${names.join(" and ")} — image subtitles, which are not rendered here`,
    );
  }
}
