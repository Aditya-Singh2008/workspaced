/**
 * Whether this machine can play this file, and what to say when it cannot.
 *
 * The phase brief makes this the plugin's first requirement: *"Detect codec
 * support at runtime per platform rather than assuming a format that plays on
 * one OS plays on all three"*, and *"show a clear, specific error state in that
 * tile naming the codec, not a generic 'unsupported file' message or a blank
 * player."* Everything in this file exists to make that second sentence
 * possible, because naming the codec requires knowing the codec, and the
 * `<video>` element never says.
 *
 * ## Support is measured, never asked
 *
 * AGENTS.md states the rule this follows and the cost of breaking it: *"probe a
 * capability by using it and measuring the result, never by asking whether the
 * API exists."* It was written about `CanvasRenderingContext2D.filter` on
 * webkit2gtk, and `canPlayType` is the same trap wearing a different hat. It
 * answers `"probably"`, `"maybe"` or `""`, and:
 *
 *   - `""` is honest and useful — a decisive no.
 *   - `"probably"` is a *guess made from the MIME string*, not from a decoder.
 *     WebKit answers `"probably"` for `video/mp4; codecs="hvc1…"` on Linux
 *     builds with no HEVC decoder at all, because the answer is produced by the
 *     type parser rather than by the pipeline.
 *   - `"maybe"` means the engine did not even parse the codec parameter.
 *
 * So {@link canPlayHint} is used for exactly what it is worth — deciding what to
 * *say* — and the actual answer comes from {@link loadMedia}, which points a
 * real element at the real file and waits for the engine to either report the
 * media's dimensions or fail. That is the measurement. It is also the only test
 * that catches the case no type string can express: a file whose video track
 * this build cannot decode but whose audio track it can, which loads
 * "successfully" and plays as sound over a black rectangle.
 *
 * ## Two dimensions of failure, and both are reported
 *
 * A file can fail because the *container* is unsupported (Chromium has no
 * Matroska demuxer, so an MKV fails whatever is inside it) or because a *track's
 * codec* is unsupported (HEVC in an MP4 that WebView2 opens happily). The
 * messages differ, because the remedies differ, and lumping them together is
 * exactly the generic error the brief rules out.
 */

import { currentPlatform } from "../../platform";
import type { ContainerTrack } from "./container";
import type { VideoFormat } from "./formats";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Container-native codec ids to the names people use.
 *
 * Keyed by the id each container writes: an ISOBMFF sample-entry fourcc, a
 * Matroska `CodecID`, an AVI FourCC or WAVE format tag, an Ogg stream name. One
 * table rather than one per container, because the *question* is the same in all
 * of them and half the ids appear in more than one — `avc1` is written by MP4,
 * by Matroska inside `V_MS/VFW/FOURCC`, and by AVI.
 *
 * The list is deliberately longer than what any webview plays. A codec nobody
 * can decode is precisely the one whose name has to appear in an error message,
 * and `"this file uses Apple ProRes, which no browser engine decodes"` is worth
 * a table row that will never be shown to a working file.
 */
const CODEC_LABELS: Readonly<Record<string, string>> = {
  // --- video, ISOBMFF -------------------------------------------------------
  avc1: "H.264 / AVC",
  avc2: "H.264 / AVC",
  avc3: "H.264 / AVC",
  avc4: "H.264 / AVC",
  hvc1: "H.265 / HEVC",
  hev1: "H.265 / HEVC",
  dvh1: "Dolby Vision (HEVC)",
  dvhe: "Dolby Vision (HEVC)",
  av01: "AV1",
  vp08: "VP8",
  vp09: "VP9",
  mp4v: "MPEG-4 Part 2",
  mp1v: "MPEG-1 Video",
  mp2v: "MPEG-2 Video",
  s263: "H.263",
  h263: "H.263",
  jpeg: "Motion JPEG",
  "dvc ": "DV",
  dvcp: "DV",
  apch: "Apple ProRes 422 HQ",
  apcn: "Apple ProRes 422",
  apcs: "Apple ProRes 422 LT",
  apco: "Apple ProRes 422 Proxy",
  ap4h: "Apple ProRes 4444",
  "rle ": "QuickTime Animation",
  svq1: "Sorenson Video",
  svq3: "Sorenson Video 3",
  cvid: "Cinepak",

  // --- audio, ISOBMFF -------------------------------------------------------
  mp4a: "AAC",
  "ac-3": "Dolby Digital (AC-3)",
  "ec-3": "Dolby Digital Plus (E-AC-3)",
  ac4: "Dolby AC-4",
  Opus: "Opus",
  fLaC: "FLAC",
  alac: "Apple Lossless",
  ".mp3": "MP3",
  twos: "PCM (big-endian)",
  sowt: "PCM (little-endian)",
  lpcm: "PCM",
  ulaw: "PCM (µ-law)",
  alaw: "PCM (A-law)",
  dtsc: "DTS",
  dtse: "DTS Express",

  // --- text, ISOBMFF --------------------------------------------------------
  tx3g: "3GPP timed text",
  text: "QuickTime text",
  wvtt: "WebVTT",
  stpp: "TTML",
  c608: "CEA-608 captions",
  c708: "CEA-708 captions",

  // --- Matroska -------------------------------------------------------------
  "V_MPEG4/ISO/AVC": "H.264 / AVC",
  "V_MPEGH/ISO/HEVC": "H.265 / HEVC",
  V_AV1: "AV1",
  V_VP8: "VP8",
  V_VP9: "VP9",
  "V_MPEG4/ISO/ASP": "MPEG-4 Part 2",
  "V_MPEG4/ISO/SP": "MPEG-4 Part 2",
  "V_MPEG4/MS/V3": "MS MPEG-4 v3",
  "V_MPEG1": "MPEG-1 Video",
  "V_MPEG2": "MPEG-2 Video",
  V_THEORA: "Theora",
  "V_MS/VFW/FOURCC": "VfW-wrapped video",
  V_QUICKTIME: "QuickTime-wrapped video",
  A_AAC: "AAC",
  "A_AAC/MPEG4/LC": "AAC-LC",
  "A_AAC/MPEG4/LC/SBR": "HE-AAC",
  A_AC3: "Dolby Digital (AC-3)",
  A_EAC3: "Dolby Digital Plus (E-AC-3)",
  A_TRUEHD: "Dolby TrueHD",
  A_DTS: "DTS",
  "A_DTS/LOSSLESS": "DTS-HD MA",
  A_OPUS: "Opus",
  A_VORBIS: "Vorbis",
  A_FLAC: "FLAC",
  "A_MPEG/L3": "MP3",
  "A_MPEG/L2": "MP2",
  "A_PCM/INT/LIT": "PCM (little-endian)",
  "A_PCM/INT/BIG": "PCM (big-endian)",
  "A_PCM/FLOAT/IEEE": "PCM (float)",
  "S_TEXT/UTF8": "SubRip subtitles",
  "S_TEXT/ASS": "ASS subtitles",
  "S_TEXT/SSA": "SSA subtitles",
  "S_TEXT/WEBVTT": "WebVTT subtitles",
  "S_TEXT/USF": "USF subtitles",
  S_VOBSUB: "VobSub subtitles (bitmap)",
  "S_HDMV/PGS": "PGS subtitles (bitmap)",
  S_DVBSUB: "DVB subtitles (bitmap)",

  // --- AVI FourCCs ----------------------------------------------------------
  H264: "H.264 / AVC",
  X264: "H.264 / AVC",
  HEVC: "H.265 / HEVC",
  XVID: "Xvid (MPEG-4 Part 2)",
  DIVX: "DivX (MPEG-4 Part 2)",
  DX50: "DivX 5 (MPEG-4 Part 2)",
  FMP4: "MPEG-4 Part 2",
  MP42: "MS MPEG-4 v2",
  MP43: "MS MPEG-4 v3",
  MPG4: "MS MPEG-4 v1",
  MJPG: "Motion JPEG",
  DVSD: "DV",
  WMV3: "Windows Media Video 9",
  WVC1: "VC-1",
  VP80: "VP8",
  VP90: "VP9",
  "0x0001": "PCM",
  "0x0002": "ADPCM",
  "0x0055": "MP3",
  "0x00ff": "AAC",
  "0x0161": "Windows Media Audio",
  "0x2000": "Dolby Digital (AC-3)",
  "0x2001": "DTS",
  "0xf1ac": "FLAC",

  // --- Ogg ------------------------------------------------------------------
  theora: "Theora",
  vorbis: "Vorbis",
  opus: "Opus",
  speex: "Speex",
  flac: "FLAC",
  daala: "Daala",
};

/**
 * The human name for a codec id, or the id itself.
 *
 * Falling back to the raw id is deliberate. An unknown fourcc printed verbatim
 * is still a searchable, actionable fact — `"this file uses a track this viewer
 * does not recognise (mvc1)"` tells someone what to look up, and inventing
 * "unknown codec" throws away the only identifying thing there was.
 */
export function codecLabel(codecId: string): string {
  if (!codecId) return "an unnamed codec";
  return (
    CODEC_LABELS[codecId] ??
    CODEC_LABELS[codecId.toUpperCase()] ??
    CODEC_LABELS[codecId.toLowerCase()] ??
    codecId
  );
}

/**
 * Why a codec might be missing on this machine, for the codecs where the answer
 * is a fact about licensing or build options rather than about the file.
 *
 * Kept to the four cases AGENTS.md already documents as varying, and phrased as
 * what is true rather than as a per-platform support matrix — a matrix would be
 * a table of claims that goes stale the first time a distro rebuilds its
 * webview, which is precisely the "asking rather than measuring" failure at a
 * different altitude.
 */
const CODEC_CAVEATS: Readonly<Record<string, string>> = {
  "H.265 / HEVC":
    "HEVC decoding depends on a licensed decoder supplied by the operating system, " +
    "not on this application — it is present on macOS, on Windows only with the " +
    "HEVC Video Extensions installed, and on Linux only where the webview was built " +
    "against one",
  "Dolby Vision (HEVC)":
    "Dolby Vision is HEVC plus a licensed extension, and depends on a decoder " +
    "supplied by the operating system",
  AV1:
    "AV1 decoding depends on whether this webview was built with an AV1 decoder, " +
    "which varies by distribution and by webview version",
  "Dolby Digital (AC-3)":
    "AC-3 is a licensed codec and is absent from most browser-engine builds",
  "Dolby Digital Plus (E-AC-3)":
    "E-AC-3 is a licensed codec and is absent from most browser-engine builds",
  "DTS": "DTS is a licensed codec and is absent from browser-engine builds",
};

export function codecCaveat(label: string): string | undefined {
  return CODEC_CAVEATS[label];
}

// ---------------------------------------------------------------------------
// Media type strings
// ---------------------------------------------------------------------------

/**
 * The MIME type plus codec parameter for a file, the string `canPlayType` wants.
 *
 * Only the tracks that carry a usable RFC 6381 parameter are named. A codec
 * parameter the engine cannot parse downgrades its whole answer to `"maybe"`,
 * which is less information than asking about the container alone — so a track
 * whose parameter this plugin could not derive is left out of the string and
 * dealt with by the real load instead.
 */
export function mediaTypeFor(
  format: VideoFormat,
  tracks: readonly ContainerTrack[],
): string {
  const base = format.mimeTypes[0]!;
  const parameters = tracks
    .filter((track) => track.kind !== "subtitle" && track.codec)
    .map((track) => track.codec!);
  if (parameters.length === 0) return base;
  return `${base}; codecs="${parameters.join(",")}"`;
}

export type PlaybackHint = "probably" | "maybe" | "no";

/**
 * What the engine claims about a type string.
 *
 * A *hint*, and named one. See the module comment for why a `"probably"` here
 * is not evidence of anything — it is used to phrase a message, never to decide
 * whether to try.
 */
export function canPlayHint(type: string): PlaybackHint {
  const probe = document.createElement("video");
  const answer = probe.canPlayType(type);
  return answer === "probably" ? "probably" : answer === "maybe" ? "maybe" : "no";
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

export type MediaLoadOutcome =
  /** Metadata arrived. */
  | {
      readonly kind: "ready";
      readonly durationMs?: number;
      readonly width: number;
      readonly height: number;
      /**
       * Whether `width` of zero is a *finding* rather than an absence of one.
       *
       * `false` means the engine never got far enough to say either way, and no
       * conclusion may be drawn from the zero. This distinction is the whole
       * reason the field exists: on webkit2gtk the video dimensions are
       * published when the sink negotiates caps, which needs the decoder
       * actually running, which does not happen while the window is not being
       * composited — so a perfectly good VP9 file reports `videoWidth === 0`
       * for the same reason `requestAnimationFrame` stops firing. Treating that
       * as "no decoder for VP9" is a confident, specific, wrong error message,
       * which is worse than the vague one it replaced.
       */
      readonly pictureConfirmed: boolean;
    }
  /** The engine rejected the source outright. */
  | { readonly kind: "unsupported"; readonly detail: string }
  /** Decoding began and failed, or the source could not be fetched. */
  | { readonly kind: "error"; readonly detail: string; readonly recoverable: boolean }
  /**
   * Nothing happened within the deadline.
   *
   * A real state, not a stuck one: AGENTS.md records that a window which is not
   * being composited stops delivering frames, and while `loadedmetadata` is not
   * itself a rAF callback, a media pipeline in that state can and does sit
   * still. Reporting it as its own outcome is what keeps an unbounded `await`
   * out of the mount path — a hang reports nothing, which is strictly worse
   * than a failure.
   */
  | { readonly kind: "timeout" };

/** Long enough for a large file on a slow disk, short enough to not read as a hang. */
export const MEDIA_LOAD_TIMEOUT_MS = 15_000;

/**
 * How long to keep waiting for a picture after metadata arrived without one.
 *
 * Short, because it is only ever paid by a file that genuinely has no video
 * dimensions yet, and it delays opening the tile. Well inside
 * {@link MEDIA_LOAD_TIMEOUT_MS}, which continues to run underneath it.
 *
 * It was four seconds, which was four seconds added to opening *every* file in
 * a window that is not being composited — the state in which no file ever
 * publishes dimensions. `resize` and `loadeddata` follow `loadedmetadata`
 * within a frame or two when they are coming at all, so a wait this long is
 * only ever spent on a file that will not answer.
 */
const PICTURE_TIMEOUT_MS = 900;

/**
 * Points an element at a source and waits for the engine to commit.
 *
 * The three interesting outcomes are all distinguished:
 *
 *   - `MEDIA_ERR_SRC_NOT_SUPPORTED` means "I will not even try", which is the
 *     container or the codec being absent;
 *   - `MEDIA_ERR_DECODE` means "I tried and the bitstream defeated me", which is
 *     a corrupt file far more often than a missing decoder;
 *   - metadata arriving with `videoWidth === 0` on a file the container says has
 *     a video track means the *audio* decoded and the video did not. No type
 *     string expresses that state and no `error` event fires for it; it is the
 *     black-rectangle-with-sound failure, and catching it is most of the reason
 *     this function measures instead of asking.
 */
export function loadMedia(
  element: HTMLVideoElement,
  url: string,
  options?: {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    /**
     * What to ask the engine to fetch.
     *
     * `"metadata"` for a throwaway measurement. `"auto"` for the element that
     * will actually be watched — it lets the media stack read ahead from the
     * moment the header lands, which over a ranged stream is the difference
     * between pressing play and waiting for it, and is what mpv does by
     * default. It is a hint either way; no engine is obliged to honour it.
     */
    readonly preload?: "metadata" | "auto";
  },
): Promise<MediaLoadOutcome> {
  return new Promise<MediaLoadOutcome>((resolve) => {
    const abort = new AbortController();
    let settled = false;

    const finish = (outcome: MediaLoadOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.abort();
      resolve(outcome);
    };

    const timer = setTimeout(() => finish({ kind: "timeout" }), options?.timeoutMs ?? MEDIA_LOAD_TIMEOUT_MS);

    const ready = (pictureConfirmed: boolean): MediaLoadOutcome => ({
      kind: "ready",
      durationMs: Number.isFinite(element.duration) ? element.duration * 1000 : undefined,
      width: element.videoWidth,
      height: element.videoHeight,
      pictureConfirmed,
    });

    element.addEventListener(
      "loadedmetadata",
      () => {
        // Dimensions already known: nothing more to establish.
        if (element.videoWidth > 0) {
          finish(ready(true));
          return;
        }

        // No dimensions yet, and *why* decides everything downstream. An
        // audio-only file will never have any; a video file whose decoder is
        // missing will never have any; and a perfectly good file in a window
        // that is not being composited has none *yet*. The first two are worth
        // an error naming the codec and the third must never produce one, so
        // the wait continues rather than concluding here.
        //
        // `resize` is the event that fires when the dimensions arrive, and
        // `loadeddata` means a frame has actually been decoded — after which a
        // zero really is an answer.
        const settle = (confirmed: boolean) => () => finish(ready(confirmed));
        element.addEventListener("resize", settle(true), { signal: abort.signal });
        element.addEventListener("loadeddata", settle(true), { signal: abort.signal });
        // And when neither arrives, the honest report is that nothing was
        // established — `pictureConfirmed: false`, and the caller opens the file
        // rather than refusing it on a measurement it did not get.
        const pictureTimer = setTimeout(() => finish(ready(false)), PICTURE_TIMEOUT_MS);
        abort.signal.addEventListener("abort", () => clearTimeout(pictureTimer));
      },
      { signal: abort.signal },
    );

    element.addEventListener(
      "error",
      () => {
        const error = element.error;
        switch (error?.code) {
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            finish({
              kind: "unsupported",
              detail: error.message || "the engine refused the source",
            });
            break;
          case MediaError.MEDIA_ERR_DECODE:
            finish({
              kind: "error",
              detail: error.message || "decoding failed partway through the stream",
              recoverable: false,
            });
            break;
          case MediaError.MEDIA_ERR_NETWORK:
            finish({
              kind: "error",
              detail: error.message || "the file could not be read",
              recoverable: true,
            });
            break;
          default:
            finish({
              kind: "error",
              detail: error?.message || "the media element reported an unspecified failure",
              recoverable: true,
            });
            break;
        }
      },
      { signal: abort.signal },
    );

    options?.signal?.addEventListener("abort", () => finish({ kind: "timeout" }), {
      signal: abort.signal,
    });

    element.preload = options?.preload ?? "metadata";
    element.src = url;
    // Required: assigning `src` queues a load, but an element that has already
    // loaded something needs telling, and the spec makes this the only way to
    // reset the media element's error state.
    element.load();
  });
}

// ---------------------------------------------------------------------------
// Saying what went wrong
// ---------------------------------------------------------------------------

export interface UnsupportedReport {
  readonly message: string;
  readonly detail: string;
}

/**
 * The specific error the brief asks for, assembled from what the container said
 * and what the engine did.
 *
 * The order of the cases is the order of usefulness. A named codec beats a named
 * container, and a named container beats "unsupported", because each one leaves
 * the reader with something to do: install the extension, remux the file, or
 * report a file this viewer got wrong.
 */
export function describeUnsupported(
  format: VideoFormat,
  tracks: readonly ContainerTrack[],
  options?: { readonly videoOnly?: boolean },
): UnsupportedReport {
  const platform = currentPlatform();
  const engine =
    platform === "windows"
      ? "WebView2"
      : platform === "macos"
        ? "WKWebView"
        : "webkit2gtk";

  const video = tracks.filter((track) => track.kind === "video");
  const audio = tracks.filter((track) => track.kind === "audio");

  // The one case where the *tracks* are beside the point: a container no engine
  // on this platform demuxes fails whatever it contains, and naming its codecs
  // would send the reader after the wrong thing entirely.
  const containerType = mediaTypeFor(format, []);
  if (tracks.length > 0 && canPlayHint(containerType) === "no") {
    return {
      message:
        `${engine} cannot open ${format.label} files, whatever they contain — ` +
        `this one holds ${describeTrackList([...video, ...audio])}.`,
      detail:
        `the ${engine} media pipeline rejects the ${format.label} container itself ` +
        `(${containerType}); remuxing the same streams into MP4 or WebM would play ` +
        `without re-encoding`,
    };
  }

  // Video decoded nowhere, audio decoded fine: the black-rectangle case.
  if (options?.videoOnly && video.length > 0) {
    const track = video[0]!;
    return {
      message:
        `${engine} played this file's audio but has no decoder for its video: ` +
        `${track.codecLabel}.`,
      detail: describeCodecDetail(track, engine),
    };
  }

  const unsupportedVideo = video[0];
  if (unsupportedVideo) {
    return {
      message: `${engine} has no decoder for this file's video: ${unsupportedVideo.codecLabel}.`,
      detail: describeCodecDetail(unsupportedVideo, engine),
    };
  }

  const unsupportedAudio = audio[0];
  if (unsupportedAudio) {
    return {
      message: `${engine} has no decoder for this file's audio: ${unsupportedAudio.codecLabel}.`,
      detail: describeCodecDetail(unsupportedAudio, engine),
    };
  }

  return {
    message: `${engine} could not play this ${format.label} file.`,
    detail:
      `the container was recognised but no track inside it could be identified, so ` +
      `there is no codec to name — the file is most likely truncated`,
  };
}

function describeCodecDetail(track: ContainerTrack, engine: string): string {
  const parameter = track.codec ? ` (${track.codec})` : ` (${track.codecId})`;
  const caveat = codecCaveat(track.codecLabel);
  const geometry =
    track.width && track.height ? `, ${track.width}×${track.height}` : "";
  return caveat
    ? `${track.codecLabel}${parameter}${geometry} — ${caveat}`
    : `${engine} reported no decoder for ${track.codecLabel}${parameter}${geometry}`;
}

/** `"an H.265 / HEVC video track and an AAC audio track"`, for a message. */
function describeTrackList(tracks: readonly ContainerTrack[]): string {
  const described = tracks
    .slice(0, 3)
    .map((track) => `${indefiniteArticle(track.codecLabel)} ${track.codecLabel} ${track.kind} track`);
  if (described.length === 0) return "no identifiable tracks";
  if (described.length === 1) return described[0]!;
  return `${described.slice(0, -1).join(", ")} and ${described[described.length - 1]}`;
}

function indefiniteArticle(word: string): string {
  return /^[aeiouAEIOU]/.test(word) || /^[FHLMNRSX]/.test(word) ? "an" : "a";
}
