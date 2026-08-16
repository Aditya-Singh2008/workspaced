/**
 * WebM.
 *
 * A profile of Matroska — see `metadata/ebml.ts`, which both this and `mkv/`
 * are built on — restricted to VP8, VP9 and AV1 for video and Vorbis and Opus
 * for audio. That restriction is the whole reason this folder exists separately
 * from `mkv/`, and it is what this parser can say that the Matroska one cannot.
 *
 * ## WebM is the one container every target webview demuxes
 *
 * WebView2, WKWebView and webkit2gtk all open it. So when a `.webm` fails, the
 * container is almost never the reason and the codec almost always is — and
 * within WebM's short codec list, exactly one is genuinely uncertain: AV1
 * depends on whether the webview was built with a decoder, which AGENTS.md
 * records as untrue of the webkit2gtk on the development machine. VP8 and VP9
 * are decoded everywhere.
 *
 * That makes an unplayable WebM a much narrower diagnosis than an unplayable
 * anything else, and the note attached here says so rather than leaving the
 * general "some codec is missing" message to do the work.
 *
 * ## A file outside the profile is still opened
 *
 * A `.webm` carrying H.264 is out of profile and does exist — some capture
 * tools write one. It is not rejected here: whether it plays is the webview's
 * answer to give, and a viewer that refused a file the platform would have
 * played is worse than one that tried. The out-of-profile track is noted, so a
 * failure has an explanation ready.
 */

import { codecLabel } from "../codecs";
import type { ContainerInfo, ContainerParseInput } from "../container";
import { bitrateFromSize, emptyContainerInfo, sortTracks } from "../container";
import {
  parseSegmentChapters,
  parseSegmentInfo,
  parseSegmentTracks,
  readSegmentHeader,
} from "../metadata/ebml";

/** The codecs the WebM specification admits. */
const WEBM_CODECS: ReadonlySet<string> = new Set([
  "V_VP8",
  "V_VP9",
  "V_AV1",
  "A_VORBIS",
  "A_OPUS",
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
        ? "this file's track list could not be reached; it may be a live recording still being written"
        : "this file declares no tracks",
    );
  }

  const outOfProfile = tracks.filter(
    (track) => track.kind !== "subtitle" && track.codecId && !WEBM_CODECS.has(track.codecId),
  );
  if (outOfProfile.length > 0) {
    const names = [...new Set(outOfProfile.map((track) => track.codecLabel))];
    notes.push(
      `this file is outside the WebM codec profile — it carries ${names.join(" and ")}, ` +
        `which a webview may decline even though the container is supported`,
    );
  }

  // Every subtitle track in a Matroska-family container is listed but not read;
  // `mkv/index.ts` carries the full explanation, and the note is worded the same
  // way here so the two say one thing rather than two.
  const subtitles = tracks.filter((track) => track.kind === "subtitle");
  if (subtitles.length > 0) {
    notes.push(
      `${subtitles.length} embedded subtitle ${subtitles.length === 1 ? "track is" : "tracks are"} ` +
        `listed but not extracted: their text is interleaved through the whole file rather than ` +
        `indexed, so reading it would mean reading the file. A sidecar .srt or .vtt beside the ` +
        `video is read in full`,
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
