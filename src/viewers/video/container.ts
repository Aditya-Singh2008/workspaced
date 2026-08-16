/**
 * What this plugin reads out of a container, and why it reads anything at all.
 *
 * Playback is the webview's job — the brief is explicit that this plugin builds
 * "a high-quality control and review layer on top of native playback", not a
 * decoder. So the obvious question is why there is a container parser here.
 *
 * Three things the `<video>` element cannot tell us, each of which a feature
 * depends on:
 *
 *   1. **Which codecs the file actually contains.** The element's failure mode
 *      is a single `MEDIA_ERR_SRC_NOT_SUPPORTED` with no detail, and the brief
 *      requires an error state "naming the codec, not a generic 'unsupported
 *      file' message". The only place that name exists is the container.
 *   2. **Chapters, and the full track list.** The element exposes `audioTracks`
 *      and `textTracks` on some engines and neither on others, and no engine
 *      exposes chapters from any of these containers.
 *   3. **Codec, bitrate and framerate for the metadata panel**, none of which
 *      the element reports.
 *
 * ## Parsed from a header, never from the file
 *
 * Everything here is produced from ranged reads (`FileHandle.readRange`). A
 * container header is kilobytes; the file behind it is routinely gigabytes, and
 * a parser that called `read()` would spend the file's size in memory to answer
 * a question the first `moov` box already answers. That is what `readRange`
 * exists for, and it is the constraint every parser under this directory is
 * written to.
 *
 * ## A parser reports what it could not read
 *
 * `notes` is not decoration. A container this plugin can open but only partly
 * understand — a fragmented MP4 whose duration lives in a `sidx`, a Matroska
 * file whose subtitle tracks it can list but not extract — has to say so, for
 * the same reason `DecodedImage.notes` does in the image plugin: silently
 * showing a partial answer as though it were the whole one is a lie of
 * omission. Every note reaches the metadata panel, and the first reaches the
 * line under the video.
 */

import type { FileHandle } from "../../files";

export type TrackKind = "video" | "audio" | "subtitle";

/**
 * One timed line of text.
 *
 * Lives here rather than in `engine/subtitles.ts` because it is container
 * vocabulary first: an MP4 with a `tx3g` track has cues in the file, and the
 * sidecar parser in `engine/subtitles.ts` produces the same shape from a `.srt`
 * beside it so the renderer and the search index cannot tell the two apart.
 */
export interface SubtitleCue {
  readonly startMs: number;
  readonly endMs: number;
  /** Plain text. Formatting markup is stripped by whichever parser produced it. */
  readonly text: string;
}

export interface Chapter {
  readonly startMs: number;
  readonly title: string;
}

export interface ContainerTrack {
  /** The container's own track id, used to correlate with the element's tracks. */
  readonly id: number;
  readonly kind: TrackKind;
  /** The track's name, when the container carries one. */
  readonly label?: string;
  /** BCP 47 / ISO 639 as the container spelled it. */
  readonly language?: string;

  /** The container-native codec id: `"avc1"`, `"V_MPEGH/ISO/HEVC"`, `"0x0055"`. */
  readonly codecId: string;
  /**
   * The RFC 6381 parameter, when this parser could derive one — `"avc1.640028"`.
   *
   * This is the string that goes to `canPlayType`, and deriving it from the
   * file's own configuration record rather than guessing from the fourcc is what
   * makes the answer specific: `avc1` alone says "H.264", `avc1.640028` says
   * "High profile at level 4.0", and a webview can support one and not the other.
   */
  readonly codec?: string;
  /** Human-readable, for the panel and the error message: `"H.265 / HEVC"`. */
  readonly codecLabel: string;

  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly channels?: number;
  readonly sampleRate?: number;
  /** Bits per second, when the container states it. */
  readonly bitrate?: number;

  readonly isDefault?: boolean;
  readonly isForced?: boolean;

  /**
   * The track's cues, when this parser could extract them.
   *
   * Set for MP4/MOV text tracks, whose sample table indexes every cue and makes
   * extraction a bounded set of ranged reads. Absent for Matroska, whose
   * subtitle samples are interleaved through every cluster in the file and
   * cannot be reached without reading all of it — see `mkv/index.ts`, which
   * lists those tracks and says plainly that it did not extract them.
   */
  readonly cues?: readonly SubtitleCue[];
}

export interface ContainerInfo {
  readonly durationMs?: number;
  readonly tracks: readonly ContainerTrack[];
  readonly chapters: readonly Chapter[];
  /** Overall bits per second, when stated or derivable from duration and size. */
  readonly bitrate?: number;
  /** The muxer that wrote the file, when it recorded itself. */
  readonly writer?: string;
  readonly title?: string;
  /** What this parser could not read. Never dropped — see the module comment. */
  readonly notes: readonly string[];
}

export interface ContainerParseInput {
  /** For ranged reads. A parser must never call `read()`. */
  readonly file: FileHandle;
  /** The first {@link HEAD_BYTES} of the file, already read. */
  readonly head: Uint8Array;
  readonly size: number;
  readonly signal?: AbortSignal;
}

export type ContainerParser = (input: ContainerParseInput) => Promise<ContainerInfo>;

/**
 * How much of the file is read before a parser is called.
 *
 * 256 KB covers the EBML header plus `Info`, `Tracks` and usually `Chapters`
 * for Matroska, the whole `moov` box for most MP4 files written for streaming,
 * and every AVI and Ogg header outright — so the common case costs one read.
 * Parsers that need more ask for it by range; none of them assume this is
 * enough.
 */
export const HEAD_BYTES = 256 * 1024;

/**
 * How much is read to decide *which* container this is.
 *
 * Every sniff in `formats.ts` is bounded: the deepest looks 256 bytes in, for
 * Matroska's `DocType`. So resolving a container needs a fraction of a page,
 * not the quarter-megabyte a *parser* needs — and the two reads were the same
 * read until the difference started costing time.
 *
 * It costs time because the sniff is the only part of the open that everything
 * else waits behind: the file is not known to be video until it resolves, so
 * the header parse, the sidecar search and the error messages all queue behind
 * it. Reading 256 KB over IPC to look at 256 bytes put a quarter-megabyte
 * transfer at the front of that queue on every open. The parser's read still
 * happens, at {@link HEAD_BYTES}, but it happens *beside* the decoder starting
 * rather than in front of it — see `mount.ts`, "Nothing waits for anything it
 * does not need".
 *
 * 4 KB rather than 256 bytes because a short read is a syscall either way and
 * the margin costs nothing, and because a sniff added later has room.
 */
export const SNIFF_BYTES = 4096;

/** An empty result, for a parser that recognised the container and found nothing. */
export function emptyContainerInfo(note?: string): ContainerInfo {
  return { tracks: [], chapters: [], notes: note ? [note] : [] };
}

/**
 * Overall bitrate from duration and file size.
 *
 * A fallback for containers that do not state one, which is most of them. It
 * includes the container's own overhead and every track, which is what "the
 * bitrate of this file" usually means in a media player, and it is labelled as
 * derived in the panel so it is not mistaken for a muxed-in value.
 */
export function bitrateFromSize(size: number, durationMs?: number): number | undefined {
  if (!durationMs || durationMs <= 0 || !size) return undefined;
  return Math.round((size * 8) / (durationMs / 1000));
}

/** Sorts video first, then audio, then subtitles; stable within each kind. */
export function sortTracks(tracks: readonly ContainerTrack[]): readonly ContainerTrack[] {
  const rank: Record<TrackKind, number> = { video: 0, audio: 1, subtitle: 2 };
  return [...tracks].sort((a, b) => rank[a.kind] - rank[b.kind]);
}
