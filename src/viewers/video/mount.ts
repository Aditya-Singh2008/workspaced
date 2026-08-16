/**
 * Opening a video: container resolution, the playability measurement that
 * decides whether a tile appears at all, and the metadata that follows it in.
 *
 * Split from `index.ts` for the reason the image and PDF plugins split theirs:
 * the descriptor has to be registered at startup so the shell can *resolve*
 * files, and nothing here should be parsed by a session that opens no video. The
 * container parsers go one level further, behind `formats.ts`'s dynamic imports,
 * so opening an MP4 never parses the Matroska, AVI or Ogg paths.
 *
 * ## The file is not read
 *
 * mpv shows the first frame of a four-gigabyte film immediately, because it
 * reads the header and streams the rest. Nothing here may do worse. So:
 *
 *   - the picture comes from a URL the media stack fetches *by range* —
 *     `source.ts` for which URL and why — and never from the file's bytes;
 *   - the metadata comes from a 256 KB head plus targeted `readRange` calls,
 *     which is what `read_file_range` exists for.
 *
 * ## Nothing waits for anything it does not need
 *
 * That rule is the whole shape of this file, and it is worth stating as a chain
 * because the chain is what used to be slow. Opening a file once meant: read
 * 256 KB over IPC, then ask Rust for a stream URL, then hand it to the decoder,
 * then wait for the container parse *and* a directory listing, and only then
 * build a tile. Five waits, end to end, four of which the first frame does not
 * depend on.
 *
 * What the first frame actually needs is a URL, and a URL needs a path. So:
 *
 *   1. **The stream URL is asked for first**, before anything is read, because
 *      it is the only step the decoder is blocked on. It is not awaited here —
 *      the request is in flight while the sniff below happens.
 *   2. **The sniff is 4 KB, not 256 KB** ({@link SNIFF_BYTES}). Deciding *which*
 *      container this is reads at most 256 bytes; only the *parser* wants the
 *      big head, and the parser is no longer on this path.
 *   3. **The header parse and the sidecar search are started and left running.**
 *      They are ranged reads and a directory listing, neither of which the
 *      decoder has anything to do with.
 *   4. **The tile is built as soon as the picture is measured**, carrying
 *      {@link LoadedVideo.details} — a promise the instance adopts whenever it
 *      lands. Chapters, the track list, the metadata panel and caption search
 *      appear a moment after the film does, instead of the film waiting for
 *      them.
 *
 * ## One load, not two
 *
 * The measurement below used to run against a throwaway probe element, after
 * which the real element loaded the same source again — two decoder opens, two
 * header fetches, and the second one not started until the first had finished.
 * So the element the user will watch is now the element the measurement runs
 * on: {@link createVideoSurface} makes it, this file measures it, and the view
 * adopts it. Time to first frame roughly halves, and it is the same element
 * throughout, so nothing is measured that is not then used.
 *
 * ## Playability is measured before the tile exists
 *
 * The brief is emphatic: a recognised container whose codec this platform cannot
 * decode must produce "a specific error state naming the codec — never a
 * generic 'unsupported file' error or a blank player". A blank player is exactly
 * what happens if the element is simply handed the URL and left to it.
 *
 * So the outcome is turned into a {@link ViewerLoadError} carrying the codec's
 * name — which the shell renders as the tile's error state, in the one place it
 * renders every plugin's failures. The alternative, mounting and then calling
 * `host.reportError`, would flash a player on screen and replace it, and would
 * leave a working transport bar attached to a file that cannot play.
 */

import type { FileHandle } from "../../files";
import {
  ViewerLoadError,
  type ViewerInstance,
  type ViewerMountOptions,
} from "../contract";
import { describeUnsupported, loadMedia } from "./codecs";
import {
  HEAD_BYTES,
  SNIFF_BYTES,
  emptyContainerInfo,
  type ContainerInfo,
} from "./container";
import { findSidecarSubtitles, type SidecarSubtitles } from "./engine/subtitles";
import { createVideoSurface, discardVideoSurface } from "./engine/view";
import { resolveContainer, type VideoFormat } from "./formats";
import { VideoViewerInstance } from "./instance";
import {
  openAssetStream,
  openLoopbackStream,
  openMemorySource,
  type MediaSource,
  type MediaSourceKind,
} from "./source";

import "./video.css";

/**
 * Everything about the file that the first frame does not depend on.
 *
 * Arrives after the tile does. Every consumer of it — the chapter marks, the
 * track menu, the metadata panel, caption search — is additive, so a player
 * showing a picture with no chapters yet is a player mid-open, not a broken one.
 */
export interface VideoDetails {
  readonly info: ContainerInfo;
  readonly sidecars: readonly SidecarSubtitles[];
}

export interface LoadedVideo {
  readonly file: FileHandle;
  /** What the element's `src` is set to. */
  readonly url: string;
  /** How the bytes reach it, measured rather than assumed. */
  readonly sourceKind: MediaSourceKind;
  /** Whether the platform fetches by range instead of holding the whole file. */
  readonly streaming: boolean;
  /**
   * The element the source was measured on — already loaded, already holding a
   * decoder, and the one the view will adopt. Handing over a live element is
   * what keeps the load from happening twice.
   */
  readonly element: HTMLVideoElement;
  readonly format: VideoFormat;
  /**
   * The container's contents, still being read.
   *
   * Never rejects: a header this plugin could not parse is not a reason to
   * refuse a file the decoder is already playing, so the failure resolves to an
   * empty description instead. See {@link parseHeader}.
   */
  readonly details: Promise<VideoDetails>;
  /** What the engine reported when the source was measured. */
  readonly measured: { width: number; height: number; durationMs?: number };
  /** Set when the file's name disagreed with its content. */
  readonly mismatch?: string;
  /**
   * Releases whatever {@link url} holds — a loopback grant, an object URL.
   *
   * The instance calls it in `dispose()`. Without it a session that opened a
   * dozen films would leave a dozen grants live, and on the in-memory path a
   * dozen films in RAM.
   */
  readonly releaseUrl?: () => void;
}

export async function loadVideo(
  file: FileHandle,
  signal?: AbortSignal,
): Promise<LoadedVideo> {
  signal?.throwIfAborted();

  if (file.size === 0) {
    throw new ViewerLoadError({
      code: "corrupt",
      message: `${file.name} is empty.`,
      detail: "the file is zero bytes long",
      recoverable: false,
    });
  }

  // First, and not awaited. This is the only request the first frame is
  // actually blocked on, so it goes in flight before the sniff rather than
  // after it. `claim()` below is what makes starting it early safe: a grant
  // nobody takes is still released.
  const loopback = claimable(openLoopbackStream(file));

  try {
    // The sniff, and only the sniff. The parser's 256 KB head is read by
    // `parseHeader`, off this path.
    let sniff: Uint8Array;
    try {
      sniff = await file.readRange(0, Math.min(SNIFF_BYTES, file.size));
    } catch (thrown) {
      throw new ViewerLoadError({
        code: "not-found",
        message: `${file.name} could not be read.`,
        detail: thrown instanceof Error ? thrown.message : String(thrown),
        recoverable: true,
        cause: thrown,
      });
    }
    signal?.throwIfAborted();

    const resolution = resolveContainer({
      bytes: sniff,
      extension: file.extension,
      mimeType: file.mimeType,
    });

    if (!resolution) {
      // The registry sent this file here on its extension, and the bytes are not
      // any container this plugin knows. Naming both halves is what makes the
      // message actionable — the usual cause is a file saved with the wrong
      // extension.
      throw new ViewerLoadError({
        code: "unsupported",
        message: `${file.name} is not a video container this viewer recognises.`,
        detail:
          "the file's contents match no supported container" +
          (file.extension ? `, and its .${file.extension} extension did not resolve one` : ""),
        recoverable: false,
      });
    }

    const format = resolution.format;

    // Started, not awaited, and not awaited later either — they are handed to
    // the instance as a promise. The measurement needs the parsed tracks only to
    // *describe a failure*, so it takes the same promise and reaches it at the
    // one point it has something to say.
    const infoPromise = parseHeader(format, file, signal);
    const sidecarPromise = findSidecarSubtitles(file, { signal }).catch(() => []);
    const details: Promise<VideoDetails> = Promise.all([infoPromise, sidecarPromise])
      .then(([info, sidecars]) => ({ info, sidecars }))
      .catch(() => ({ info: emptyContainerInfo(), sidecars: [] }));

    const element = createVideoSurface();
    try {
      const resolved = await resolveSource({
        file,
        format,
        element,
        info: infoPromise,
        loopback,
        signal,
      });
      signal?.throwIfAborted();

      return {
        file,
        element,
        url: resolved.source.url,
        sourceKind: resolved.source.kind,
        streaming: resolved.source.streaming,
        format,
        details,
        measured: resolved.measured,
        mismatch: resolution.mismatch,
        releaseUrl: () => resolved.source.release(),
      };
    } catch (thrown) {
      // The element never reached a view, so nothing else will take it down.
      discardVideoSurface(element);
      throw thrown;
    }
  } finally {
    // Every path out of here that did not adopt the grant gives it back — an
    // abort between starting it and using it, an unrecognised container, a
    // failed sniff. Harmless once claimed.
    loopback.releaseIfUnclaimed();
  }
}

/**
 * A pending source that is released if nobody takes it.
 *
 * Starting the loopback request before the file is known to be video means the
 * request can outlive the reason for it. A grant left behind keeps a path
 * servable for the life of the process, which `media.rs` is explicit about not
 * wanting, so the promise is wrapped in something that cannot be forgotten.
 */
interface Claimable {
  claim(): Promise<MediaSource | null>;
  releaseIfUnclaimed(): void;
}

function claimable(pending: Promise<MediaSource | null>): Claimable {
  let claimed = false;
  // A rejection nobody is awaiting yet is still a rejection. `openLoopbackStream`
  // resolves to `null` rather than throwing, but the guard costs one line and
  // removes a class of unhandled-rejection warning from the abort paths.
  const settled = pending.catch(() => null);
  return {
    claim: () => {
      claimed = true;
      return settled;
    },
    releaseIfUnclaimed: () => {
      if (claimed) return;
      claimed = true;
      void settled.then((source) => source?.release());
    },
  };
}

/**
 * The container header, or an empty description when it cannot be read.
 *
 * A header that will not parse is not a reason to refuse the file, and not
 * something to tell the user about either. The platform decoder reads the
 * stream itself and may well play what this parser choked on, so the panel falls
 * back to what the decoder reports and the measurement gets the final say.
 * Refusing here would be this plugin's opinion overriding the decoder's
 * evidence.
 *
 * The head is read here rather than passed in, because this is no longer on the
 * path to the first frame and the read can happen beside the decoder's own.
 */
async function parseHeader(
  format: VideoFormat,
  file: FileHandle,
  signal?: AbortSignal,
): Promise<ContainerInfo> {
  try {
    // The parser module and the head it wants are two independent waits — a
    // dynamic import and an IPC read — so they overlap.
    const [{ parse }, head] = await Promise.all([
      format.load(),
      file.readRange(0, Math.min(HEAD_BYTES, file.size)),
    ]);
    signal?.throwIfAborted();
    return await parse({ file, head, size: file.size, signal });
  } catch (thrown) {
    if (signal?.aborted) throw thrown;
    console.warn(`[video] the ${format.label} header could not be parsed`, thrown);
    return emptyContainerInfo();
  }
}

interface ResolvedSource {
  readonly source: MediaSource;
  readonly measured: { width: number; height: number; durationMs?: number };
}

/**
 * Finds a URL this engine will actually play, and measures the result.
 *
 * The order is `source.ts`'s, and the choice between them is made by *trying*
 * each rather than by sniffing the platform — AGENTS.md: probe a capability by
 * using it and measuring the result. That rule earned its place here. On Linux
 * the app's own `asset://` URL fails with `MEDIA_ERR_SRC_NOT_SUPPORTED` before a
 * byte is read, for every container and every codec, because webkit2gtk hands
 * media to GStreamer and GStreamer has never heard of the scheme. Measured on
 * this machine against real H.264, VP9 and Theora files: all three failed
 * through `asset://`, all three failed through `file://`, and all three played
 * from other sources. That failure is indistinguishable from a missing codec,
 * so it must never be *inferred* — only measured.
 *
 * Only a source rejection moves down the list. A decode failure, a timeout or a
 * video track this platform cannot decode would fail the same way from every
 * source, and re-reading the file to reproduce a known answer is a slow way to
 * show the same error.
 */
async function resolveSource(options: {
  file: FileHandle;
  format: VideoFormat;
  element: HTMLVideoElement;
  info: Promise<ContainerInfo>;
  loopback: Claimable;
  signal?: AbortSignal;
}): Promise<ResolvedSource> {
  const attempts: Array<() => Promise<MediaSource | null>> = [
    // Already in flight since the top of `loadVideo`; this is where it is
    // collected, not where it starts.
    () => options.loopback.claim(),
    () => Promise.resolve(openAssetStream(options.file)),
    () => openMemorySource(options.file, options.signal),
  ];

  // The first failure, not the last: it came from the source most likely to
  // have got far enough to know something, and on the paths that matter it is
  // the one carrying the codec's name.
  let firstFailure: unknown = null;

  for (const attempt of attempts) {
    options.signal?.throwIfAborted();
    const source = await attempt();
    if (!source) continue;

    try {
      const measured = await measurePlayback({ ...options, url: source.url });
      return { source, measured };
    } catch (thrown) {
      source.release();
      firstFailure ??= thrown;
      if (!(thrown instanceof ViewerLoadError) || thrown.code !== "unsupported") throw thrown;
    }
  }

  if (firstFailure) throw firstFailure;

  throw new ViewerLoadError({
    code: "unsupported",
    message: `${options.file.name} cannot be streamed by this viewer.`,
    detail:
      "video is played by the platform's own media pipeline, which needs a URL it " +
      "can read directly, and no such URL could be produced for this file",
    recoverable: false,
  });
}

/**
 * Points the element at a source and turns the result into either a
 * measurement or a {@link ViewerLoadError}.
 */
async function measurePlayback(options: {
  file: FileHandle;
  url: string;
  format: VideoFormat;
  element: HTMLVideoElement;
  info: Promise<ContainerInfo>;
  signal?: AbortSignal;
}): Promise<{ width: number; height: number; durationMs?: number }> {
  const outcome = await loadMedia(options.element, options.url, {
    signal: options.signal,
    // The element being measured is the element that will be watched, so it may
    // as well start reading ahead now rather than after the tile appears.
    preload: "auto",
  });

  switch (outcome.kind) {
    case "ready": {
      // Metadata arrived and the picture did not: the audio decoded, the video
      // did not, and no `error` event fires for it. This is the
      // black-rectangle-with-sound case, and catching it is most of the reason
      // the measurement exists at all.
      //
      // `pictureConfirmed` is what keeps that from becoming a lie. A window
      // that is not being composited reports zero dimensions for every file
      // regardless of codec — measured on webkit2gtk against real H.264, VP9,
      // Theora and Xvid files, all of which are decodable on that machine and
      // all of which reported `videoWidth === 0` while the window was hidden.
      // Refusing to open them with a confident "no decoder for VP9" would be a
      // specific, actionable, wrong message. When nothing was established the
      // file opens and the player says what it knows.
      //
      // This is the one place the header parse is waited for, and only in the
      // branch that is about to refuse the file — where the codec's name is the
      // entire point of the message and a few milliseconds do not matter.
      if (outcome.width === 0 && outcome.pictureConfirmed) {
        const info = await options.info;
        if (info.tracks.some((track) => track.kind === "video")) {
          const report = describeUnsupported(options.format, info.tracks, { videoOnly: true });
          throw new ViewerLoadError({
            code: "unsupported",
            message: report.message,
            detail: report.detail,
            recoverable: false,
          });
        }
      }
      return {
        width: outcome.width,
        height: outcome.height,
        durationMs: outcome.durationMs,
      };
    }

    case "unsupported": {
      const report = describeUnsupported(options.format, (await options.info).tracks);
      throw new ViewerLoadError({
        code: "unsupported",
        message: report.message,
        detail: `${report.detail} (the engine said: ${outcome.detail})`,
        recoverable: false,
      });
    }

    case "error":
      throw new ViewerLoadError({
        // A decode failure on a container and codec this platform does have is
        // a damaged file far more often than a missing decoder, and `corrupt`
        // is the code that says so.
        code: outcome.recoverable ? "not-found" : "corrupt",
        message: outcome.recoverable
          ? `${options.file.name} could not be read while opening.`
          : `${options.file.name} could not be decoded.`,
        detail: outcome.detail,
        recoverable: outcome.recoverable,
      });

    case "timeout":
      options.signal?.throwIfAborted();
      throw new ViewerLoadError({
        // `internal` rather than a timeout code of its own: the contract's list
        // has none, and inventing one would be a plugin widening a shell
        // vocabulary from the outside. `recoverable` is what actually matters
        // here — it is what puts a retry button on the tile.
        code: "internal",
        message: `${options.file.name} did not start within 15 seconds.`,
        detail:
          "the platform's media pipeline accepted the file and then reported nothing — " +
          "a very large file on slow storage, or a decoder that has stalled",
        recoverable: true,
      });

    default:
      throw new ViewerLoadError({
        code: "internal",
        message: `${options.file.name} could not be opened.`,
        detail: "the media element reported an outcome this viewer does not know",
        recoverable: true,
      });
  }
}

export async function mountVideo(
  container: HTMLElement,
  file: FileHandle,
  options?: ViewerMountOptions,
): Promise<ViewerInstance> {
  const loaded = await loadVideo(file, options?.signal);

  if (options?.signal?.aborted) {
    // Aborted between the measurement and the mount: the element is live and
    // holding a decoder, and no instance is going to be built to take it down.
    discardVideoSurface(loaded.element);
    loaded.releaseUrl?.();
    options.signal.throwIfAborted();
  }

  return new VideoViewerInstance({
    container,
    loaded,
    initialState: options?.initialState,
    host: options?.host,
  });
}
