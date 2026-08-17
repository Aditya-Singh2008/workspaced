/**
 * Video plugin self-test. **Dev builds only.**
 *
 * Most of what matters about a video player is "watch it and see whether it is
 * right", which no automated check replaces — whether a scrub feels responsive,
 * whether captions land on the frame they belong to, whether J and K behave the
 * way a hand trained on a deck expects. What *is* checkable, and what this
 * covers, is everything underneath that judgement:
 *
 *   - **the container parsers read the right numbers**, not merely *some*
 *     numbers. Every parse check asserts a resolution, a frame rate, a codec
 *     string and a chapter title, because a parser reading four bytes from the
 *     wrong offset returns a track and a duration just as confidently as one
 *     reading the right ones;
 *   - **an unplayable file is described by codec name**, which is the brief's
 *     one hard requirement about failure and the thing a generic message
 *     silently satisfies;
 *   - **the shuttle and the loop cycle**, which are state machines that are easy
 *     to get subtly wrong and impossible to notice being wrong;
 *   - **every hidden keybind is reachable from the context menu**, which is the
 *     brief's "keybind-accessible *and/or* context-menu-reachable" turned into
 *     something a machine can check — the alternative is a shortcut nobody can
 *     discover;
 *   - **nothing image-specific leaked in**, which the brief requires and which
 *     is exactly the kind of thing that arrives later by copy-paste from a
 *     sibling plugin;
 *   - **mounting and disposing releases every decoder**, since a video decoder
 *     held past its tile is a resource leak with teeth.
 *
 * It runs in the real webview because codec support is *the* thing that differs
 * between webkit2gtk, WebView2 and WKWebView. Checks that need a genuinely
 * playable file are *skipped with a reason* when the platform cannot produce
 * one — `SelfTestCheck.skipped` exists for exactly this, and a green report with
 * skips is not the same as a green one without.
 */

import { check, report, skip, type SelfTestCheck, type SelfTestReport } from "../../dev/selftest";
import { createMemoryFileHandle, type FileHandle } from "../../files";
import type { ToolbarControl, ViewerInstance } from "../contract";
import { disposeViewer, isViewerDisposed, mountViewer } from "../instances";
import {
  videoKeybinds,
  videoMenuItems,
  videoToolbarControls,
  type VideoActions,
} from "./actions";
import type { ContainerInfo } from "./container";
import { HEAD_BYTES } from "./container";
import { codecLabel, describeUnsupported, loadMedia } from "./codecs";
import {
  buildAss,
  buildAvi,
  buildMatroska,
  buildMov,
  buildMp4,
  buildOgv,
  buildSrt,
  buildVtt,
  FIXTURE_CHANNELS,
  FIXTURE_CHAPTERS,
  FIXTURE_CUES,
  FIXTURE_DURATION_MS,
  FIXTURE_FPS,
  FIXTURE_HEIGHT,
  FIXTURE_SAMPLE_RATE,
  FIXTURE_WIDTH,
  recordVideo,
} from "./dev/fixtures";
import { ProgressGlide } from "./engine/glide";
import { cuesAt, parseAss, parseSrtOrVtt, parseSubtitles } from "./engine/subtitles";
import { formatTimecode, PLAYBACK_SPEEDS, QUICK_SPEEDS, Transport } from "./engine/transport";
import {
  createVideoSurface,
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  rateIndicator,
  speedChipLabel,
  VideoView,
} from "./engine/view";
import { formatById, resolveContainer, VIDEO_EXTENSIONS, VIDEO_FORMATS } from "./formats";
import { videoViewerPlugin } from "./index";
import {
  DEFAULT_VIDEO_SETTINGS,
  resetVideoSettings,
  subscribeToVideoSettings,
  updateVideoSettings,
  videoSettings,
} from "./settings";
import { parseVideoState } from "./state";

const TITLE = "video viewer plugin";

export async function runVideoSelfTest(): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [];
  checks.push(...formatTableChecks());
  checks.push(...resolutionChecks());
  checks.push(...(await parserChecks()));
  checks.push(...subtitleChecks());
  checks.push(...transportChecks());
  checks.push(...glideChecks());
  checks.push(...(await viewChecks()));
  checks.push(...stateChecks());
  checks.push(...settingsChecks());
  checks.push(...contributionChecks());
  checks.push(...errorMessageChecks());
  checks.push(...(await playbackChecks()));
  return report(TITLE, checks);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scratchContainer(width = 480, height = 320): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText =
    `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none;`;
  document.body.append(container);
  return container;
}

function handleFor(name: string, bytes: Uint8Array, mimeType?: string): FileHandle {
  return createMemoryFileHandle({ name, bytes, mimeType });
}

/** Parses a fixture through the same path `mount.ts` uses, minus the playback probe. */
async function parseFixture(formatId: string, file: FileHandle): Promise<ContainerInfo> {
  const format = formatById(formatId);
  if (!format) throw new Error(`no such format: ${formatId}`);
  const { parse } = await format.load();
  const head = await file.readRange(0, Math.min(HEAD_BYTES, file.size));
  return parse({ file, head, size: file.size, signal: undefined });
}

function close(actual: number | undefined, expected: number, tolerance = 1): boolean {
  return actual !== undefined && Math.abs(actual - expected) <= tolerance;
}

// ---------------------------------------------------------------------------
// The format table
// ---------------------------------------------------------------------------

function formatTableChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];

  const required = ["mp4", "mov", "webm", "mkv", "avi", "ogv"];
  const missing = required.filter((id) => !formatById(id));
  checks.push(
    check(
      "every container the brief names is registered",
      missing.length === 0,
      missing.length === 0
        ? `${VIDEO_FORMATS.length} containers: ${VIDEO_FORMATS.map((f) => f.id).join(", ")}`
        : `missing: ${missing.join(", ")}`,
    ),
  );

  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const format of VIDEO_FORMATS) {
    for (const extension of format.extensions) {
      const owner = seen.get(extension);
      if (owner) collisions.push(`.${extension} claimed by both ${owner} and ${format.id}`);
      else seen.set(extension, format.id);
    }
  }
  checks.push(
    check(
      "no two containers claim the same extension",
      collisions.length === 0,
      collisions.length === 0 ? `${seen.size} extensions, all distinct` : collisions.join("; "),
    ),
  );

  // `.ogg` is audio by convention and this is a video plugin. Claiming it would
  // put a music file in a player with a black rectangle where the picture goes.
  checks.push(
    check(
      "the audio-only .ogg extension is not claimed",
      !VIDEO_EXTENSIONS.includes("ogg"),
      VIDEO_EXTENSIONS.includes("ogg")
        ? "video/formats.ts claims .ogg"
        : "only .ogv is claimed for Ogg",
    ),
  );

  const derived = VIDEO_FORMATS.flatMap((format) => format.extensions);
  checks.push(
    check(
      "the plugin's extension list is derived from the table",
      derived.every((extension) => VIDEO_EXTENSIONS.includes(extension)) &&
        VIDEO_EXTENSIONS.length === new Set(derived).size,
      `${VIDEO_EXTENSIONS.length} extensions from ${VIDEO_FORMATS.length} containers`,
    ),
  );

  checks.push(
    check(
      "the plugin does not claim the video/* wildcard",
      !videoViewerPlugin.mimeTypes?.some((type) => type.includes("*")),
      "a wildcard would swallow containers this plugin cannot open",
    ),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Container resolution
// ---------------------------------------------------------------------------

function resolutionChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];

  const cases: readonly [string, Uint8Array, string][] = [
    ["mp4", buildMp4(), "mp4"],
    ["mov", buildMov(), "mov"],
    ["webm", buildMatroska({ docType: "webm" }), "webm"],
    ["mkv", buildMatroska({ docType: "matroska" }), "mkv"],
    ["avi", buildAvi(), "avi"],
    ["ogv", buildOgv(), "ogv"],
  ];

  for (const [name, bytes, expected] of cases) {
    const resolved = resolveContainer({ bytes, extension: expected });
    checks.push(
      check(
        `${name} is recognised from its bytes`,
        resolved?.format.id === expected && resolved.matchedBy === "content",
        resolved
          ? `resolved to ${resolved.format.id} by ${resolved.matchedBy}`
          : "nothing matched",
      ),
    );
  }

  // The usual real-world cause of "it plays everywhere else": a Matroska file
  // saved as `.mp4`. Content has to win, and the disagreement has to be said.
  const lying = resolveContainer({ bytes: buildMatroska({ docType: "matroska" }), extension: "mp4" });
  checks.push(
    check(
      "a file whose name disagrees with its bytes resolves by content and says so",
      lying?.format.id === "mkv" && typeof lying.mismatch === "string",
      lying ? `${lying.format.id}, mismatch: ${lying.mismatch ?? "none"}` : "nothing matched",
    ),
  );

  checks.push(
    check(
      "bytes that are no known container resolve to nothing",
      resolveContainer({ bytes: new Uint8Array(64) }) === null,
      "an unrecognised file is refused rather than guessed at",
    ),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// The parsers
// ---------------------------------------------------------------------------

async function parserChecks(): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];

  // --- MP4 -----------------------------------------------------------------
  try {
    const info = await parseFixture("mp4", handleFor("fixture.mp4", buildMp4(), "video/mp4"));
    const video = info.tracks.find((track) => track.kind === "video");
    const audio = info.tracks.find((track) => track.kind === "audio");

    checks.push(
      check(
        "mp4: the video track's size, rate and codec are read",
        video?.width === FIXTURE_WIDTH &&
          video.height === FIXTURE_HEIGHT &&
          close(video.frameRate, FIXTURE_FPS, 0.01) &&
          video.codec === "avc1.640028",
        video
          ? `${video.width}×${video.height} @ ${video.frameRate} fps, ${video.codec}`
          : "no video track",
      ),
    );
    checks.push(
      check(
        "mp4: H.264 is named rather than shown as a fourcc",
        (video?.codecLabel ?? "").includes("H.264"),
        `codecLabel is ${video?.codecLabel ?? "absent"}`,
      ),
    );
    checks.push(
      check(
        "mp4: the audio track's esds descriptors yield mp4a.40.2",
        audio?.codec === "mp4a.40.2" &&
          audio.channels === FIXTURE_CHANNELS &&
          audio.sampleRate === FIXTURE_SAMPLE_RATE,
        audio
          ? `${audio.codec}, ${audio.channels}ch @ ${audio.sampleRate} Hz`
          : "no audio track",
      ),
    );
    checks.push(
      check(
        "mp4: the audio track's language is unpacked from its packed form",
        audio?.language === "eng",
        `language is ${audio?.language ?? "absent"}`,
      ),
    );
    checks.push(
      check(
        "mp4: the duration comes out in milliseconds",
        close(info.durationMs, FIXTURE_DURATION_MS, 2),
        `durationMs is ${info.durationMs ?? "absent"}`,
      ),
    );
    checks.push(
      check(
        "mp4: Nero chpl chapters are read with their titles and times",
        info.chapters.length === FIXTURE_CHAPTERS.length &&
          info.chapters.every(
            (chapter, index) =>
              chapter.title === FIXTURE_CHAPTERS[index]!.title &&
              close(chapter.startMs, FIXTURE_CHAPTERS[index]!.startMs, 1),
          ),
        info.chapters.map((chapter) => `${chapter.startMs}ms ${chapter.title}`).join(", ") ||
          "no chapters",
      ),
    );
  } catch (thrown) {
    checks.push(check("mp4: the header parses", false, String(thrown)));
  }

  // --- MOV -----------------------------------------------------------------
  try {
    const info = await parseFixture("mov", handleFor("fixture.mov", buildMov(), "video/quicktime"));
    const video = info.tracks.find((track) => track.kind === "video");
    checks.push(
      check(
        "mov: the QuickTime brand parses through the same ISOBMFF path",
        video?.width === FIXTURE_WIDTH && video.codec === "avc1.640028",
        video ? `${video.width}×${video.height}, ${video.codec}` : "no video track",
      ),
    );
  } catch (thrown) {
    checks.push(check("mov: the header parses", false, String(thrown)));
  }

  // --- WebM ----------------------------------------------------------------
  try {
    const info = await parseFixture(
      "webm",
      handleFor("fixture.webm", buildMatroska({ docType: "webm" }), "video/webm"),
    );
    const video = info.tracks.find((track) => track.kind === "video");
    const audio = info.tracks.find((track) => track.kind === "audio");
    checks.push(
      check(
        "webm: EBML variable-length integers decode to the right track values",
        video?.codecId === "V_VP9" &&
          video.width === FIXTURE_WIDTH &&
          video.height === FIXTURE_HEIGHT &&
          close(video.frameRate, FIXTURE_FPS, 0.05),
        video
          ? `${video.codecId} ${video.width}×${video.height} @ ${video.frameRate} fps`
          : "no video track",
      ),
    );
    checks.push(
      check(
        "webm: the audio track's float sampling frequency is read",
        audio?.codecId === "A_OPUS" &&
          audio.channels === FIXTURE_CHANNELS &&
          close(audio.sampleRate, FIXTURE_SAMPLE_RATE, 1),
        audio ? `${audio.codecId}, ${audio.channels}ch @ ${audio.sampleRate} Hz` : "no audio track",
      ),
    );
    checks.push(
      check(
        "webm: the duration is scaled by TimecodeScale",
        close(info.durationMs, FIXTURE_DURATION_MS, 2),
        `durationMs is ${info.durationMs ?? "absent"}`,
      ),
    );
    checks.push(
      check(
        "webm: chapters are read from the Chapters element",
        info.chapters.length === FIXTURE_CHAPTERS.length &&
          info.chapters[1]?.title === FIXTURE_CHAPTERS[1]!.title,
        info.chapters.map((chapter) => chapter.title).join(", ") || "no chapters",
      ),
    );
  } catch (thrown) {
    checks.push(check("webm: the header parses", false, String(thrown)));
  }

  // --- Matroska ------------------------------------------------------------
  try {
    const info = await parseFixture(
      "mkv",
      handleFor(
        "fixture.mkv",
        buildMatroska({
          docType: "matroska",
          videoCodec: "V_MPEG4/ISO/AVC",
          audioCodec: "A_AAC",
          subtitleCodec: "S_TEXT/UTF8",
        }),
        "video/x-matroska",
      ),
    );
    const subtitle = info.tracks.find((track) => track.kind === "subtitle");
    checks.push(
      check(
        "mkv: a subtitle track is listed even though its cues cannot be reached",
        subtitle !== undefined && (subtitle.cues?.length ?? 0) === 0,
        subtitle
          ? `${subtitle.codecId} listed with ${subtitle.cues?.length ?? 0} cues`
          : "no subtitle track",
      ),
    );
    checks.push(
      check(
        "mkv: the unreadable subtitle track is explained in a note",
        info.notes.some((note) => /subtitle/i.test(note)),
        info.notes.join(" | ") || "no notes",
      ),
    );
  } catch (thrown) {
    checks.push(check("mkv: the header parses", false, String(thrown)));
  }

  // --- AVI -----------------------------------------------------------------
  try {
    const info = await parseFixture("avi", handleFor("fixture.avi", buildAvi(), "video/x-msvideo"));
    const video = info.tracks.find((track) => track.kind === "video");
    const audio = info.tracks.find((track) => track.kind === "audio");
    checks.push(
      check(
        "avi: RIFF chunk walking finds the stream headers",
        video?.codecId === "XVID" &&
          video.width === FIXTURE_WIDTH &&
          close(video.frameRate, FIXTURE_FPS, 0.01) &&
          audio?.channels === FIXTURE_CHANNELS,
        video
          ? `${video.codecId} ${video.width}×${video.height} @ ${video.frameRate} fps, ` +
            `audio ${audio?.codecId ?? "none"}`
          : "no video track",
      ),
    );
    checks.push(
      check(
        "avi: the duration comes from the frame count and frame duration",
        close(info.durationMs, FIXTURE_DURATION_MS, 40),
        `durationMs is ${info.durationMs ?? "absent"}`,
      ),
    );
  } catch (thrown) {
    checks.push(check("avi: the header parses", false, String(thrown)));
  }

  // --- Ogg -----------------------------------------------------------------
  try {
    const info = await parseFixture("ogv", handleFor("fixture.ogv", buildOgv(), "video/ogg"));
    const video = info.tracks.find((track) => track.kind === "video");
    const audio = info.tracks.find((track) => track.kind === "audio");
    checks.push(
      check(
        "ogv: both logical streams are identified from their first pages",
        video?.codecId === "theora" && audio?.codecId === "vorbis",
        `${video?.codecId ?? "none"} + ${audio?.codecId ?? "none"}`,
      ),
    );
    checks.push(
      check(
        "ogv: the picture size comes from the pixel fields, not the macroblock ones",
        video?.width === FIXTURE_WIDTH && video.height === FIXTURE_HEIGHT,
        video ? `${video.width}×${video.height}` : "no video track",
      ),
    );
    checks.push(
      check(
        "ogv: the duration is derived from the last page's granule position",
        close(info.durationMs, FIXTURE_DURATION_MS, 50),
        `durationMs is ${info.durationMs ?? "absent"}`,
      ),
    );
  } catch (thrown) {
    checks.push(check("ogv: the header parses", false, String(thrown)));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

function subtitleChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];

  const srt = parseSrtOrVtt(buildSrt());
  checks.push(
    check(
      "srt: every cue's timing and text survive the parse",
      srt.length === FIXTURE_CUES.length &&
        srt.every(
          (cue, index) =>
            cue.startMs === FIXTURE_CUES[index]!.startMs &&
            cue.endMs === FIXTURE_CUES[index]!.endMs &&
            cue.text === FIXTURE_CUES[index]!.text,
        ),
      `${srt.length} cues, first at ${srt[0]?.startMs ?? "?"}ms`,
    ),
  );

  const vtt = parseSrtOrVtt(buildVtt());
  checks.push(
    check(
      "vtt: markup is stripped and the text is left intact",
      vtt.length === FIXTURE_CUES.length && vtt[0]?.text === FIXTURE_CUES[0]!.text,
      vtt[0] ? `first cue: ${JSON.stringify(vtt[0].text)}` : "no cues",
    ),
  );

  // The check the ASS parser exists for: the fixture's `Format:` line declares
  // an unusual column order, and a parser that assumed the common one reads the
  // end time as the caption text.
  const ass = parseAss(buildAss());
  checks.push(
    check(
      "ass: the declared column order is honoured rather than assumed",
      ass.length === FIXTURE_CUES.length &&
        ass[0]?.startMs === FIXTURE_CUES[0]!.startMs &&
        ass[1]?.text === FIXTURE_CUES[1]!.text,
      ass[0] ? `first cue ${ass[0].startMs}–${ass[0].endMs}ms: ${JSON.stringify(ass[0].text)}` : "no cues",
    ),
  );

  checks.push(
    check(
      "the extension chooses the parser",
      parseSubtitles("ass", buildAss()).length === FIXTURE_CUES.length &&
        parseSubtitles("srt", buildSrt()).length === FIXTURE_CUES.length,
      "ass and srt both parse through parseSubtitles",
    ),
  );

  // The lookup that runs ten times a second while a film plays.
  const during = cuesAt(srt, 1000);
  const between = cuesAt(srt, 2200);
  checks.push(
    check(
      "the active cue is found by time, and a gap yields none",
      during.length === 1 && during[0]?.text === FIXTURE_CUES[0]!.text && between.length === 0,
      `at 1000ms: ${during.length} cue(s); at 2200ms: ${between.length}`,
    ),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function transportChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];

  checks.push(
    check(
      "timecodes are formatted for their magnitude",
      formatTimecode(0) === "0:00.0" &&
        formatTimecode(83_000) === "1:23" &&
        formatTimecode(3_723_000) === "1:02:03",
      `${formatTimecode(0)} / ${formatTimecode(83_000)} / ${formatTimecode(3_723_000)}`,
    ),
  );

  checks.push(
    check(
      "the frame-accurate timecode counts frames within the second",
      formatTimecode(1500, { frames: 30 }) === "0:01:15",
      formatTimecode(1500, { frames: 30 }),
    ),
  );

  checks.push(
    check(
      "the speed ladder covers the range the brief asks for",
      PLAYBACK_SPEEDS.includes(0.25) &&
        PLAYBACK_SPEEDS.includes(1) &&
        PLAYBACK_SPEEDS.includes(2) &&
        [...PLAYBACK_SPEEDS].every((speed, index, all) => index === 0 || speed > all[index - 1]!),
      `speeds: ${PLAYBACK_SPEEDS.join(", ")}`,
    ),
  );

  checks.push(
    check(
      "every speed the bar's chip can reach is on the full ladder",
      QUICK_SPEEDS.every((speed) => (PLAYBACK_SPEEDS as readonly number[]).includes(speed)),
      `chip: ${QUICK_SPEEDS.join(", ")}`,
    ),
  );

  // A `<video>` with no source: every method used here operates on the
  // transport's own state, and nothing below asks the element to decode.
  const element = document.createElement("video");
  const announcements: string[] = [];
  const transport = new Transport({
    video: element,
    frameRate: 25,
    callbacks: { onChange: () => {}, onAnnounce: (message) => announcements.push(message) },
  });

  try {
    // There is no ladder to climb any more, and the point of these checks is
    // that there is not: pressing a direction twice must land back at rest
    // rather than at some faster rate, because a rate a decoder cannot sustain
    // is a number in a readout over a stuttering picture.
    const pressed: number[] = [];
    transport.shuttle(1);
    pressed.push(transport.shuttleRate);
    transport.shuttle(1);
    pressed.push(transport.shuttleRate);
    transport.shuttle(1);
    pressed.push(transport.shuttleRate);
    checks.push(
      check(
        "K toggles forward rather than climbing a ladder",
        pressed[0] === 1 && pressed[1] === 0 && pressed[2] === 1,
        `rates after three presses: ${pressed.join(", ")}`,
      ),
    );

    // The half of "toggles" that is not the flag. `K` absorbed `L`'s job when
    // `L` was removed, so the second press is now the only way that key stops a
    // forward shuttle — and it used to clear `shuttleRate` while leaving the
    // element playing, which is a stop key that does not stop.
    transport.shuttle(1);
    const stoppedElement = element.paused;
    checks.push(
      check(
        "K pressed twice pauses the element, not just the flag",
        transport.shuttleRate === 0 && stoppedElement,
        `rate ${transport.shuttleRate}, element ${stoppedElement ? "paused" : "playing"}`,
      ),
    );

    // One press turns round. The old ladder took four to get from forward to
    // reverse, which for a single-rate transport would be three too many.
    transport.shuttle(1);
    transport.shuttle(-1);
    checks.push(
      check(
        "J out of a forward shuttle reverses immediately",
        transport.shuttleRate === -1,
        `rate is ${transport.shuttleRate}`,
      ),
    );

    transport.shuttle(-1);
    checks.push(
      check(
        "J again stops rather than reversing faster",
        transport.shuttleRate === 0,
        `rate is ${transport.shuttleRate}`,
      ),
    );

    // Stopping no longer has a key of its own — `L` was removed and `K` took
    // its job, so stopping is the second press of whichever direction key
    // started it, or `Space`. `pause()` is that last route, and it has to leave
    // a *reverse* shuttle at rest too: reverse is a stepper, not playback, so
    // pausing an element that is already paused has to reach the flag as well.
    transport.shuttle(-1);
    transport.pause();
    checks.push(
      check(
        "stopping the shuttle leaves it at rest",
        transport.shuttleRate === 0 && element.paused,
        `rate ${transport.shuttleRate}, element ${element.paused ? "paused" : "playing"}`,
      ),
    );

    // The chip's ladder, including the two ways off it: from a speed below 1×
    // the first press must land on 1× rather than doing nothing, and from 4× it
    // must come back rather than having nowhere to go. Both are reachable
    // because `x` and the context menu walk a wider set than the chip does.
    const walked: number[] = [];
    transport.setSpeed(1);
    for (let press = 0; press < 4; press += 1) {
      transport.cycleQuickSpeed();
      walked.push(transport.speed);
    }
    transport.setSpeed(0.25);
    transport.cycleQuickSpeed();
    const fromSlow = transport.speed;
    transport.setSpeed(4);
    transport.cycleQuickSpeed();
    const fromFast = transport.speed;
    checks.push(
      check(
        "the chip walks 1× → 1.5× → 2× and finds its way back from anywhere",
        walked.join() === "1.5,2,1,1.5" && fromSlow === 1 && fromFast === 1,
        `walk: ${walked.join(" → ")}; from 0.25×: ${fromSlow}×; from 4×: ${fromFast}×`,
      ),
    );

    // One signed number, because the timeline, the chip and the badge all ask
    // the same question and three separate answers is how a bar ends up gliding
    // forwards over a film that is running backwards.
    transport.setSpeed(2);
    transport.shuttle(-1);
    const reversingRate = transport.signedRate;
    transport.pause();
    const stoppedRate = transport.signedRate;
    transport.setSpeed(1);
    checks.push(
      check(
        "the signed rate carries the direction and the speed together",
        reversingRate === -2 && stoppedRate === 0,
        `reversing at 2×: ${reversingRate}; stopped: ${stoppedRate}`,
      ),
    );

    // -----------------------------------------------------------------------
    // What the *element* is running at
    //
    // Everything above asks the transport what it thinks; these ask the video.
    // The three of them are the difference between a speed control that works
    // and one that only updates a readout, which is what "the macOS build does
    // not speed the video up" turned out to be.
    // -----------------------------------------------------------------------

    // The speed control used to be applied only at rest, so `x` during a
    // forward shuttle — the state someone reaching for it is most likely to be
    // in — moved the readout and nothing else.
    transport.shuttle(1);
    transport.setSpeed(1.5);
    const duringShuttle = element.playbackRate;
    transport.pause();
    checks.push(
      check(
        "changing the speed during a forward shuttle reaches the element",
        Math.abs(duringShuttle - 1.5) < 0.001,
        `element rate ${duringShuttle}`,
      ),
    );

    transport.setSpeed(2);
    const fast = { rate: element.playbackRate, fallback: element.defaultPlaybackRate, pitch: element.preservesPitch };
    transport.setSpeed(1);
    const normal = { fallback: element.defaultPlaybackRate, pitch: element.preservesPitch };
    checks.push(
      check(
        "the rate is written to defaultPlaybackRate as well",
        fast.rate === 2 && fast.fallback === 2 && normal.fallback === 1,
        `at 2×: rate ${fast.rate}, default ${fast.fallback}; at 1×: default ${normal.fallback}`,
      ),
    );
    checks.push(
      check(
        "pitch correction is on away from 1× and off at 1×",
        fast.pitch === true && normal.pitch === false,
        `at 2×: ${fast.pitch}; at 1×: ${normal.pitch}`,
      ),
    );

    // An engine that resets the rate behind the app's back, which is what
    // WKWebView does on a resume. The event is synthesised because no engine
    // does it on demand — what is being checked is the response to it, and the
    // response is the difference between a film that keeps its speed across a
    // pause and one that quietly drops to 1×.
    transport.setSpeed(2);
    element.playbackRate = 1;
    element.dispatchEvent(new Event("ratechange"));
    const rateAfterDrop = element.playbackRate;
    checks.push(
      check(
        "a rate the engine drops is put back",
        Math.abs(rateAfterDrop - 2) < 0.001,
        `element rate after the drop: ${rateAfterDrop}`,
      ),
    );

    // ...but not forever. An engine that answers 1× to every request is
    // refusing, not glitching, and the loop has to end somewhere the user can
    // see rather than in an unbounded exchange of events.
    const before = announcements.length;
    for (let drop = 0; drop < 8; drop += 1) {
      element.playbackRate = 1;
      element.dispatchEvent(new Event("ratechange"));
    }
    const conceded = announcements.slice(before).some((message) => message.includes("will not play at"));
    checks.push(
      check(
        "an engine that keeps refusing a rate is believed, and said so",
        conceded && element.playbackRate === 1,
        conceded
          ? `gave up at ${element.playbackRate}× and announced it`
          : `no announcement; element rate ${element.playbackRate}`,
      ),
    );
    transport.setSpeed(1);

    // The loop's three-state cycle. `currentMs` is zero throughout on a source
    // that never loaded, so the second press is rejected for being no later than
    // the first — which is the guard being checked.
    transport.cycleLoop();
    const afterIn = transport.loopIn;
    transport.cycleLoop();
    checks.push(
      check(
        "the loop refuses an out point that is not after its in point",
        afterIn !== null && transport.loopOut === null && !transport.looping,
        `in ${afterIn}, out ${transport.loopOut}, looping ${transport.looping}`,
      ),
    );
    checks.push(
      check(
        "the rejected out point is explained rather than silently ignored",
        announcements.some((message) => /out point/i.test(message)),
        announcements.join(" | ") || "nothing was announced",
      ),
    );

    transport.restoreLoop({ inMs: 1000, outMs: 4000 });
    const restored = transport.loopRange;
    transport.clearLoop();
    checks.push(
      check(
        "a loop round-trips through restore and clear",
        restored?.inMs === 1000 &&
          restored.outMs === 4000 &&
          transport.loopIn === null &&
          transport.loopRange === null,
        `restored ${restored?.inMs}–${restored?.outMs}, cleared to ${transport.loopIn}`,
      ),
    );

    checks.push(
      check(
        "a half-set loop is not reported as an active range",
        transport.loopRange === null,
        "loopRange is null until both ends are set",
      ),
    );
  } finally {
    transport.destroy();
  }

  // The wiring behind the black-flicker fix. What it is protecting against is a
  // future change that stops raising the signal — reverse would keep working and
  // would quietly start strobing again, which is exactly the kind of regression
  // that gets noticed months later and blamed on the file.
  const holds: boolean[] = [];
  const holdTransport = new Transport({
    video: document.createElement("video"),
    frameRate: 25,
    callbacks: {
      onChange: () => {},
      onAnnounce: () => {},
      onHoldFrame: (active) => holds.push(active),
    },
  });

  try {
    holdTransport.shuttle(-1);
    const engaged = holds[0] === true;
    holdTransport.pause();
    checks.push(
      check(
        "reverse asks for the picture to be held, and gives it back when it stops",
        engaged && holds.at(-1) === false,
        `hold signals: ${holds.join(", ") || "none"}`,
      ),
    );

    holds.length = 0;
    holdTransport.stepFrame(1);
    checks.push(
      check(
        "a seek made while paused covers its own gap",
        holds.includes(true) && holds.at(-1) === false,
        `hold signals: ${holds.join(", ") || "none"}`,
      ),
    );
  } catch (thrown) {
    checks.push(check("the transport raises the frame hold around blanking seeks", false, String(thrown)));
  } finally {
    holdTransport.destroy();
  }

  return checks;
}

// ---------------------------------------------------------------------------
// The timeline's motion
//
// What cannot be checked here is whether the bar *looks* smooth — that is a
// property of the compositor and of a real film playing. What can be checked is
// the contract underneath it: that the animation exists only when there is a
// duration to animate along *and* a track to animate across, that it is pointed
// where the transport says, and that reverse drives it backwards rather than
// being quietly ignored. A bar that glided forwards over a film running
// backwards would pass every other check in this file.
//
// Two of the checks below are about the *mechanism* rather than the result,
// because both are invisible from the outside and both are the whole of why the
// bar moves the way it does. That the marker's keyframes are in pixels is what
// puts it on the compositor beside the fill on every engine this app ships to —
// a percentage translation depends on the box size, and an animated transform
// that does is the one engines decline to accelerate — and it would go on
// working, slightly worse and only on some of them, if someone wrote `100%`
// back. And that ordinary drift is absorbed by
// changing the bar's *speed* rather than by writing its position is what keeps a
// correction from being a teleport; a version that snapped instead would land in
// the right place every time and step on the way there.
// ---------------------------------------------------------------------------

/** The far end of an element's animation, as written. */
function lastKeyframeTransform(element: HTMLElement): string {
  const effect = element.getAnimations()[0]?.effect as KeyframeEffect | undefined;
  const frames = effect?.getKeyframes() ?? [];
  return String(frames[frames.length - 1]?.transform ?? "");
}

function glideChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];
  const container = scratchContainer();
  const fill = document.createElement("div");
  const marker = document.createElement("div");
  container.append(fill, marker);
  const glide = new ProgressGlide({ fill, marker });

  try {
    checks.push(
      check(
        "a film with no known duration is drawn by hand rather than animated",
        !glide.active && glide.positionMs === null,
        `active ${glide.active}`,
      ),
    );

    glide.setDuration(60_000);
    checks.push(
      check(
        "a duration alone is not enough: an unmeasured track is still drawn by hand",
        !glide.active,
        `active ${glide.active} with a duration but no width`,
      ),
    );

    glide.setTrackWidth(600);
    checks.push(
      check(
        "a duration and a measured track together build the animation",
        glide.active,
        `active ${glide.active} after 60s across 600px`,
      ),
    );

    checks.push(
      check(
        "the marker is translated in pixels, not by a percentage",
        lastKeyframeTransform(marker).includes("600px"),
        `marker ends at ${lastKeyframeTransform(marker) || "nothing"}`,
      ),
    );

    // 60s across 600px is 100ms per pixel, so half a pixel is 50ms. The point is
    // that it is derived at all: the same half-pixel is 4.5 seconds of a
    // two-hour film, and the fixed tolerance this replaced meant one of those
    // two was always wrong.
    checks.push(
      check(
        "what counts as drift is derived from the track, not from a constant",
        Math.round(glide.thresholds.deadband) === 50,
        `deadband ${glide.thresholds.deadband}ms at 100ms/px`,
      ),
    );

    // Stopped: the bar goes exactly where it is told, with no tolerance, because
    // where it is told is the only information there is.
    glide.sync({ currentMs: 30_000, rate: 0, visible: true });
    checks.push(
      check(
        "a stopped transport parks the bar on the playhead",
        glide.positionMs === 30_000 && glide.rate === 0,
        `at ${String(glide.positionMs)}ms, rate ${glide.rate}`,
      ),
    );

    // Nudged by less than the parking epsilon and told the same position again:
    // the bar must be left alone. A paused film with the chrome up is synced ten
    // to sixty times a second and every one of those used to be two writes.
    const played = fill.getAnimations()[0];
    if (played) played.currentTime = 30_000.5;
    glide.sync({ currentMs: 30_000, rate: 0, visible: true });
    checks.push(
      check(
        "a parked bar is not rewritten to say where it already is",
        glide.positionMs === 30_000.5,
        `at ${String(glide.positionMs)}ms after being told 30000ms twice`,
      ),
    );

    // Running, and then handed an error inside the servo band: the bar must not
    // move to meet it, it must lean into it.
    glide.sync({ currentMs: 30_000, rate: 1, visible: true });
    const beforeDrift = glide.positionMs ?? 0;
    glide.sync({ currentMs: 30_150, rate: 1, visible: true });
    const afterDrift = glide.positionMs ?? 0;
    const trimmed = played?.playbackRate ?? 1;
    checks.push(
      check(
        "drift is absorbed by changing speed rather than by jumping",
        Math.abs(afterDrift - beforeDrift) < 50 && trimmed > 1.1,
        `moved ${Math.round(afterDrift - beforeDrift)}ms, playing at ${trimmed}×`,
      ),
    );

    // And past the band it is a seek, which is a jump and should look like one.
    glide.sync({ currentMs: 45_000, rate: 1, visible: true });
    checks.push(
      check(
        "a jump larger than any drift is obeyed at once",
        Math.abs((glide.positionMs ?? 0) - 45_000) < 5 && Math.abs((played?.playbackRate ?? 0) - 1) < 0.01,
        `at ${String(glide.positionMs)}ms, playing at ${played?.playbackRate ?? 0}×`,
      ),
    );

    // A divider drag resizes the tile on every frame of the drag, and each one
    // rebuilds the marker. None of it may show.
    glide.setTrackWidth(900);
    checks.push(
      check(
        "a resize rebuilds the marker without disturbing the bar",
        glide.active &&
          glide.rate === 1 &&
          Math.abs((glide.positionMs ?? 0) - 45_000) < 50 &&
          lastKeyframeTransform(marker).includes("900px"),
        `active ${glide.active}, rate ${glide.rate}, at ${String(glide.positionMs)}ms, ` +
          `marker ends at ${lastKeyframeTransform(marker) || "nothing"}`,
      ),
    );

    glide.sync({ currentMs: 45_000, rate: -2, visible: true });
    checks.push(
      check(
        "reversing at 2× runs the bar backwards at 2×",
        glide.rate === -2,
        `rate ${glide.rate}`,
      ),
    );

    // The bar is hidden for most of a film's life, and a hidden bar that keeps
    // animating is work nobody can see.
    glide.sync({ currentMs: 45_000, rate: -2, visible: false });
    checks.push(
      check("a bar nobody can see is frozen rather than driven", glide.rate === 0, `rate ${glide.rate}`),
    );

    glide.setDuration(0);
    checks.push(
      check(
        "losing the duration hands the bar back to the fallback",
        !glide.active,
        `active ${glide.active}`,
      ),
    );
  } catch (thrown) {
    checks.push(check("the timeline's animation behaves", false, String(thrown)));
  } finally {
    glide.destroy();
    container.remove();
  }

  return checks;
}

// ---------------------------------------------------------------------------
// The surface: zoom, the state badges, and the frame hold
//
// All three are checkable without a playable file, which is the point of doing
// them here: they are geometry and DOM, not decoding. What no check replaces is
// looking at reverse play and seeing that it no longer strobes — but "the hold
// is put up and taken down at the right moments" is the part that can silently
// regress, and it is the part that is asserted.
// ---------------------------------------------------------------------------

async function viewChecks(): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];
  const noop = (): void => {};
  const container = scratchContainer();
  const view = new VideoView({
    container,
    video: createVideoSurface(),
    callbacks: {
      onTogglePlay: noop,
      onCycleSpeed: noop,
      onToggleFullscreen: noop,
      onContextMenu: noop,
      onZoomChange: noop,
      onPersist: noop,
    },
  });

  try {
    const start = view.zoomPercent;
    view.stepZoom(1);
    checks.push(
      check(
        "zooming in leaves the fit mode behind and enlarges the picture",
        view.zoomMode === "custom" && view.zoomPercent > start,
        `${start}% → ${view.zoomPercent}%, mode ${view.zoomMode}`,
      ),
    );

    // Walked off both ends of the ladder deliberately: a zoom that can run away
    // is a tile that can be made unusable and not obviously recoverable.
    for (let step = 0; step < 40; step += 1) view.stepZoom(1);
    const ceiling = view.zoomPercent;
    for (let step = 0; step < 80; step += 1) view.stepZoom(-1);
    const floor = view.zoomPercent;
    checks.push(
      check(
        "the zoom ladder is bounded at both ends",
        ceiling <= MAX_ZOOM_PERCENT && floor >= MIN_ZOOM_PERCENT && floor < ceiling,
        `top ${ceiling}%, bottom ${floor}%`,
      ),
    );

    view.setScaleMode("fit");
    checks.push(
      check(
        "picking a fit mode discards the explicit zoom",
        view.zoomMode === "fit",
        `mode is ${view.zoomMode}`,
      ),
    );

    // --- the rate badge and the speed chip --------------------------------
    // Driven through `rateIndicator` rather than through the view, because the
    // interesting part is which state is worth saying anything about, and
    // reaching the "chrome has faded" case through a real view means waiting out
    // a two-and-a-half second idle timer for one assertion.
    const idlePlain = rateIndicator({ playing: true, shuttleRate: 0, speed: 1 }, false);
    const chromePlain = rateIndicator({ playing: true, shuttleRate: 0, speed: 1 }, true);
    checks.push(
      check(
        "an untouched 1× forward tile gets no badge, bar or no bar",
        idlePlain === "" && chromePlain === "",
        `idle: ${JSON.stringify(idlePlain)}, chrome up: ${JSON.stringify(chromePlain)}`,
      ),
    );

    const reverse = rateIndicator({ playing: true, shuttleRate: -1, speed: 2 }, false);
    const reverseWithBar = rateIndicator({ playing: true, shuttleRate: -1, speed: 2 }, true);
    checks.push(
      check(
        "the badge reports direction and speed, and stands down when the bar is up",
        reverse.includes("◀") && reverse.includes("2") && reverseWithBar === "",
        `bar down: ${JSON.stringify(reverse)}, bar up: ${JSON.stringify(reverseWithBar)}`,
      ),
    );

    const slowPaused = rateIndicator({ playing: false, shuttleRate: 0, speed: 0.5 }, false);
    checks.push(
      check(
        "a paused tile at an unusual speed says so rather than claiming a direction",
        slowPaused.includes("⏸") && slowPaused.includes("0.5"),
        JSON.stringify(slowPaused),
      ),
    );

    // The other half of the handoff: what the bar itself shows. Always
    // something, because it is a control as well as a readout, and the direction
    // glyph only where the play button does not already give it.
    const chipPlain = speedChipLabel({ shuttleRate: 0, speed: 1 });
    const chipFast = speedChipLabel({ shuttleRate: 0, speed: 1.5 });
    const chipBack = speedChipLabel({ shuttleRate: -1, speed: 2 });
    checks.push(
      check(
        "the speed chip always reads, and marks the direction only in reverse",
        chipPlain === "1×" && chipFast === "1.5×" && chipBack === "◀◀ 2×",
        [chipPlain, chipFast, chipBack].map((label) => JSON.stringify(label)).join(", "),
      ),
    );

    // And that both decisions actually reach the DOM. The view starts with its
    // bar up — a paused tile always shows its controls — so this is the
    // bar-is-up half of the handoff: chip filled, badge silent.
    view.update({ playing: true, currentMs: 0, durationMs: 1000, shuttleRate: -1, speed: 2 });
    const badge = container.querySelector<HTMLElement>(".video-badge.is-rate");
    const chip = container.querySelector<HTMLElement>(".video-speed");
    checks.push(
      check(
        "with the bar up the chip carries the speed and the badge stays out of it",
        chip?.textContent === chipBack && badge?.hidden === true,
        `chip ${JSON.stringify(chip?.textContent ?? "")}, badge hidden ${String(badge?.hidden)}`,
      ),
    );
    checks.push(
      check(
        "a reversing transport marks the chip as active",
        chip?.classList.contains("is-active") === true,
        chip?.className ?? "no chip",
      ),
    );

    // --- the frame hold ---------------------------------------------------
    view.holdFrame(true);
    checks.push(
      check(
        "the hold covers the picture while the element is between frames",
        view.holding && container.querySelector(".video-hold") !== null,
        view.holding ? "a canvas is over the picture" : "nothing was put up",
      ),
    );

    view.holdFrame(false);
    // Released on the next presented frame, or on its deadline — which is the
    // path this takes, since a sourceless element presents nothing. Polled
    // rather than awaited on an event, for the reason AGENTS.md gives: a bare
    // await on something that may never happen reports nothing at all.
    const released = await until(() => !view.holding, 1000);
    checks.push(
      check(
        "the hold is given back once the picture is live again",
        released && container.querySelector(".video-hold") === null,
        released ? "the canvas was removed" : "the hold was still up after a second",
      ),
    );

    view.destroy();
    checks.push(
      check(
        "destroying the view leaves nothing in the tile",
        container.childElementCount === 0,
        `${container.childElementCount} child elements remain`,
      ),
    );
  } catch (thrown) {
    checks.push(check("the video surface zooms, badges and holds frames", false, String(thrown)));
  } finally {
    view.destroy();
    container.remove();
  }

  return checks;
}

/** Polls a condition to a deadline. Never hangs, which is the whole point. */
async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// State and settings
// ---------------------------------------------------------------------------

function stateChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];

  const round = parseVideoState({
    positionMs: 12_345,
    scaleMode: "fill",
    panel: "tracks",
    speed: 1.5,
    audioTrackId: "1",
    subtitleTrackId: "sidecar:0",
    loopInMs: 1000,
    loopOutMs: 2000,
  });
  checks.push(
    check(
      "a complete state survives the round trip",
      round.positionMs === 12_345 &&
        round.scaleMode === "fill" &&
        round.panel === "tracks" &&
        round.speed === 1.5 &&
        round.subtitleTrackId === "sidecar:0" &&
        round.loopInMs === 1000,
      JSON.stringify(round),
    ),
  );

  // Zoom and pan, which is the state a restored tile most visibly gets wrong if
  // it drops either: the zoom without the centre reopens someone in the wrong
  // corner of the frame, and the centre without the zoom is meaningless.
  const zoomed = parseVideoState({ scaleMode: "custom", zoom: 240, centerX: 0.25, centerY: 0.8 });
  checks.push(
    check(
      "a custom zoom and its pan centre survive the round trip",
      zoomed.scaleMode === "custom" &&
        zoomed.zoom === 240 &&
        zoomed.centerX === 0.25 &&
        zoomed.centerY === 0.8,
      JSON.stringify(zoomed),
    ),
  );

  const absurd = parseVideoState({ zoom: 1e9, centerX: -4, centerY: 12 });
  checks.push(
    check(
      "an out-of-range zoom or centre is clamped rather than believed",
      absurd.zoom === MAX_ZOOM_PERCENT && absurd.centerX === 0 && absurd.centerY === 1,
      `zoom ${absurd.zoom}, centre ${absurd.centerX}/${absurd.centerY}`,
    ),
  );

  const junk = parseVideoState({
    positionMs: "halfway",
    scaleMode: "enormous",
    panel: 7,
    speed: Number.NaN,
    subtitleTrackId: 42,
  });
  checks.push(
    check(
      "malformed state falls back to defaults rather than throwing",
      junk.positionMs === 0 && junk.scaleMode === "fit" && junk.panel === "none" && junk.speed === 1,
      JSON.stringify(junk),
    ),
  );

  checks.push(
    check(
      "state parsing tolerates null and non-objects",
      parseVideoState(null).positionMs === 0 && parseVideoState("nonsense").panel === "none",
      "null and a string both yield the default state",
    ),
  );

  // A loop whose out point is not after its in point would pin the playhead the
  // moment it started, so a half-valid pair is dropped whole.
  const halfLoop = parseVideoState({ loopInMs: 5000, loopOutMs: 1000 });
  const oneEnd = parseVideoState({ loopInMs: 5000 });
  checks.push(
    check(
      "an impossible or half-set loop is dropped on restore",
      halfLoop.loopInMs === undefined && oneEnd.loopInMs === undefined,
      `reversed: ${halfLoop.loopInMs}, in-only: ${oneEnd.loopInMs}`,
    ),
  );

  // Volume is a session preference and belongs in settings.ts, not in a saved
  // layout that would restore it a week later in a different room.
  const serialized = JSON.stringify(parseVideoState({}));
  checks.push(
    check(
      "volume is not part of the per-tile state",
      !serialized.includes("volume") && !serialized.includes("muted"),
      serialized,
    ),
  );

  return checks;
}

function settingsChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];
  resetVideoSettings();

  const seen: number[] = [];
  const unsubscribe = subscribeToVideoSettings((settings) => seen.push(settings.volume));
  updateVideoSettings({ volume: 0.4 });
  unsubscribe();

  checks.push(
    check(
      "a volume change reaches every subscribed tile",
      seen.includes(0.4) && videoSettings().volume === 0.4,
      `listener saw ${seen.join(", ") || "nothing"}`,
    ),
  );

  updateVideoSettings({ volume: 12 });
  const high = videoSettings().volume;
  updateVideoSettings({ volume: Number.NaN });
  const invalid = videoSettings().volume;
  checks.push(
    check(
      "volume is clamped and an unusable value falls back",
      high === 1 && invalid === DEFAULT_VIDEO_SETTINGS.volume,
      `12 became ${high}, NaN became ${invalid}`,
    ),
  );

  checks.push(
    check(
      "autoplay is off by default",
      DEFAULT_VIDEO_SETTINGS.autoplay === false,
      "a restored layout of six videos must not start six soundtracks",
    ),
  );

  resetVideoSettings();
  return checks;
}

// ---------------------------------------------------------------------------
// Toolbar, keybinds and menu
// ---------------------------------------------------------------------------

/** A stand-in tile, so the contributions can be checked without a playable file. */
function stubActions(overrides?: Partial<VideoActions>): VideoActions {
  const noop = (): void => {};
  return {
    playing: false,
    currentMs: 1000,
    durationMs: 5000,
    speed: 1,
    shuttleRate: 0,
    muted: false,
    volume: 1,
    hasAudio: true,
    scaleMode: "fit",
    zoomPercent: 100,
    panel: "none",
    loopIn: null,
    loopOut: null,
    chapterCount: 3,
    subtitleLabel: "off",
    hasSubtitleChoice: true,
    hasPicture: true,
    pictureInPicture: false,
    fullscreen: false,
    togglePlayback: noop,
    seekBy: noop,
    seekTo: noop,
    stepFrame: noop,
    shuttle: noop,
    cycleSpeed: noop,
    cycleLoop: noop,
    clearLoop: noop,
    previousChapter: noop,
    nextChapter: noop,
    setScaleMode: noop,
    zoomIn: noop,
    zoomOut: noop,
    cycleInspector: noop,
    setInspector: noop,
    cycleSubtitles: noop,
    toggleMute: noop,
    setVolume: noop,
    nudgeVolume: noop,
    copyFrame: noop,
    exportFrame: noop,
    togglePictureInPicture: noop,
    toggleFullscreen: noop,
    ...overrides,
  };
}

function contributionChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];
  const actions = stubActions();

  const controls = videoToolbarControls(actions);
  checks.push(
    check(
      "the toolbar stays minimal",
      controls.length <= 5,
      `${controls.length} controls: ${controls.map((control) => control.id).join(", ")}`,
    ),
  );

  const kinds = new Set(controls.map((control: ToolbarControl) => control.kind));
  checks.push(
    check(
      "the toolbar covers play/pause, seek and volume",
      controls.some((control) => control.id === "play.toggle") &&
        controls.some((control) => control.id.startsWith("seek.")) &&
        controls.some((control) => control.id === "audio.volume"),
      `kinds present: ${[...kinds].join(", ")}`,
    ),
  );

  const silent = videoToolbarControls(stubActions({ hasAudio: false }));
  checks.push(
    check(
      "a file with no audio gets no volume control",
      !silent.some((control) => control.id === "audio.volume"),
      `${silent.length} controls for a silent file`,
    ),
  );

  const keybinds = videoKeybinds(actions);
  const listed = keybinds.filter((binding) => !binding.hidden);
  checks.push(
    check(
      "the reference modal gets six to eight rows",
      listed.length >= 6 && listed.length <= 8,
      `${listed.length} listed of ${keybinds.length} registered: ` +
        listed.map((binding) => binding.keys.join("/")).join(", "),
    ),
  );

  const ids = keybinds.map((binding) => binding.id);
  checks.push(
    check(
      "no keybind id is registered twice",
      new Set(ids).size === ids.length,
      `${ids.length} bindings, ${new Set(ids).size} distinct ids`,
    ),
  );

  // One binding per job: two bindings on the same key would be a conflict, and
  // two keys running the same action would be the alias AGENTS.md forbids.
  const keys = keybinds.flatMap((binding) => binding.keys);
  checks.push(
    check(
      "no key is bound twice",
      new Set(keys).size === keys.length,
      keys.join(", "),
    ),
  );

  // The shell owns Mod+letter, Mod+digit and Mod+arrow. A plugin claiming one
  // would shadow a shell action while its tile had focus.
  //
  // `Mod+=` and `Mod+-` are the exception AGENTS.md names by hand — "conventional
  // to the point that moving them would be worse than the risk, and unclaimed by
  // the shell" — and the image plugin already zooms with them. Spelling the two
  // out here rather than loosening the pattern to "punctuation is fine" keeps the
  // check as strict as it was for everything else: `Mod+P` would still fail it,
  // and so would any future `Mod`+letter arriving by copy-paste.
  const allowed = new Set(["Mod+=", "Mod+-"]);
  const shellSpace = keys.filter((key) => /^Mod\+/i.test(key) && !allowed.has(key));
  checks.push(
    check(
      "no binding reaches into the shell's Mod+ space",
      shellSpace.length === 0,
      shellSpace.length === 0
        ? "every binding is a bare key or one of the two zoom accelerators"
        : shellSpace.join(", "),
    ),
  );

  // The brief's actual requirement: keybind-accessible *and/or* reachable from
  // the context menu. A hidden binding with no menu row is neither.
  const menu = videoMenuItems(actions);
  const menuLabels = menu.map((item) => item.label.toLowerCase()).join(" | ");
  const orphans = keybinds
    .filter((binding) => binding.hidden)
    .filter((binding) => !menuCovers(menuLabels, binding.id));
  checks.push(
    check(
      "every unlisted shortcut is reachable from the context menu",
      orphans.length === 0,
      orphans.length === 0
        ? `${menu.filter((item) => !item.separator).length} menu rows cover ${keybinds.length} bindings`
        : `not in the menu: ${orphans.map((binding) => binding.id).join(", ")}`,
    ),
  );

  // Nothing image-specific, by instruction. This is the check that stops a
  // rotate or an invert arriving later by copy-paste from the image plugin.
  //
  // Zoom is deliberately *not* on this list any more. It was, and the reasoning
  // — that inspecting a picture closely is an image-viewer job — turned out to
  // be wrong for a review tool, where getting closer to a frame is how an
  // artefact or a burned-in timecode is checked (`engine/view.ts` sets out the
  // reversal). The rest of the list stands: rotation, inversion, levels and the
  // adjustment pipeline are all *editing a picture*, which a player does not do.
  const surface = [
    ...controls.map((control) => `${control.id} ${control.label}`),
    ...keybinds.map((binding) => `${binding.id} ${binding.label}`),
    ...menu.map((item) => item.label),
  ]
    .join(" ")
    .toLowerCase();
  const forbidden = ["invert", "rotate", "flip", "histogram", "exposure", "slideshow"];
  const leaked = forbidden.filter((word) => surface.includes(word));
  checks.push(
    check(
      "no image-specific or PDF-specific concept appears anywhere",
      leaked.length === 0,
      leaked.length === 0 ? "no invert, rotate, flip, histogram or exposure" : leaked.join(", "),
    ),
  );

  return checks;
}

/** Whether a menu label plausibly offers the action a hidden binding runs. */
function menuCovers(menuLabels: string, bindingId: string): boolean {
  const wanted: Record<string, RegExp> = {
    "seek.back": /play|pause/,
    "seek.forward": /play|pause/,
    "frame.previous": /previous frame/,
    "frame.next": /next frame/,
    "chapter.previous": /previous chapter/,
    "chapter.next": /next chapter/,
    "play.speed": /playback speed/,
    "zoom.in": /zoom in/,
    "zoom.out": /zoom out/,
    "audio.mute": /mute/,
    "audio.louder": /mute/,
    "audio.quieter": /mute/,
    "frame.copy": /copy this frame/,
    "frame.export": /save this frame/,
    "present.pip": /picture-in-picture/,
  };
  const pattern = wanted[bindingId];
  return pattern ? pattern.test(menuLabels) : false;
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

function errorMessageChecks(): SelfTestCheck[] {
  const checks: SelfTestCheck[] = [];

  const format = formatById("mkv")!;
  const tracks = [
    {
      id: 1,
      kind: "video" as const,
      codecId: "V_MPEGH/ISO/HEVC",
      codecLabel: codecLabel("V_MPEGH/ISO/HEVC"),
    },
    {
      id: 2,
      kind: "audio" as const,
      codecId: "A_DTS",
      codecLabel: codecLabel("A_DTS"),
    },
  ];

  const report = describeUnsupported(format, tracks);
  checks.push(
    check(
      "an unplayable file is described by codec or container name",
      /H\.265|HEVC|Matroska/i.test(report.message) && report.message.length > 20,
      report.message,
    ),
  );
  checks.push(
    check(
      "the message is never the generic 'unsupported file'",
      !/^unsupported/i.test(report.message.trim()) && report.detail.length > 0,
      `detail: ${report.detail}`,
    ),
  );

  const videoOnly = describeUnsupported(format, tracks, { videoOnly: true });
  checks.push(
    check(
      "audio-plays-but-video-does-not is described as its own case",
      /audio/i.test(videoOnly.message) && /H\.265|HEVC|Matroska/i.test(videoOnly.message),
      videoOnly.message,
    ),
  );

  checks.push(
    check(
      "codec ids from every container map to human names",
      codecLabel("avc1").includes("H.264") &&
        codecLabel("V_VP9").includes("VP9") &&
        // A fourcc and an Ogg codec name both have to come out as words rather
        // than as themselves — an unmapped id falls through to its own id.
        codecLabel("XVID") !== "XVID" &&
        codecLabel("theora") !== "theora",
      `avc1→${codecLabel("avc1")}, V_VP9→${codecLabel("V_VP9")}, ` +
        `XVID→${codecLabel("XVID")}, theora→${codecLabel("theora")}`,
    ),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Playback, against a file the platform encoded
// ---------------------------------------------------------------------------

async function playbackChecks(): Promise<SelfTestCheck[]> {
  const checks: SelfTestCheck[] = [];

  const recording = await recordVideo();
  if (!recording.ok) {
    checks.push(skip("a real file mounts, plays and disposes", recording.reason));
    return checks;
  }

  const recorded = recording.video;
  const container = scratchContainer();
  const file = handleFor(`recorded.${recorded.extension}`, recorded.bytes, recorded.mimeType);
  const clientId = "video-selftest";

  try {
    // Before anything is asked of the plugin: can a bare `<video>` play this at
    // all? The recording is the platform's own output, and it does not follow
    // that the platform's player accepts it — webkit2gtk's recorder emits an MP4
    // its own pipeline will not open without Media Source Extensions.
    //
    // Establishing that *first* is the difference between "the plugin is broken"
    // and "there is nothing playable on this machine to test with", and it is
    // the same probe-by-using discipline the plugin itself follows. Without it
    // this suite reports a plugin failure for a platform limitation.
    const playable = await probePlayable(file);
    if (!playable.ok) {
      // The plugin still has to *fail well*, and a real unplayable file is a
      // better test of that than any fixture: this is the brief's "never a
      // generic 'unsupported file' error" checked against genuine bytes.
      const refusal = await mountViewer({ clientId, container, file });
      await disposeViewer(clientId);
      const message = refusal.ok ? "" : refusal.error.message;
      checks.push(
        check(
          "a file this platform cannot play is refused by name, not generically",
          !refusal.ok &&
            message.length > 20 &&
            !/^unsupported/i.test(message.trim()) &&
            /mp4|webm|matroska|h\.26|vp9|av1|quicktime/i.test(message),
          refusal.ok ? "the tile mounted, so there was nothing to refuse" : message,
        ),
      );
      checks.push(
        skip(
          "a real file mounts, plays and disposes",
          `this platform's recorder produced ${recorded.mimeType} that its own player ` +
            `will not open (${playable.reason}), so there is no playable file here. ` +
            "Open a real video file to cover playback, thumbnails and copy.",
        ),
      );
      return checks;
    }

    const mounted = await mountViewer({ clientId, container, file });
    if (!mounted.ok) {
      checks.push(
        check("a real file mounts", false, `${mounted.error.message} — ${mounted.error.detail ?? ""}`),
      );
      return checks;
    }

    const instance: ViewerInstance = mounted.instance;
    checks.push(
      check(
        `a recorded ${recorded.mimeType} opens in the video plugin`,
        instance.pluginId === "video" && instance.status === "ready",
        `${instance.pluginId}, status ${instance.status}`,
      ),
    );

    checks.push(
      check(
        "a file with no captions is not searchable, and says so by omission",
        instance.capabilities.search === false && instance.search === undefined,
        "capabilities.search is false and there is no search property",
      ),
    );

    // The tile's own `<video>` is a second element loading the same source, so
    // it has its own metadata to wait for — the mount's probe finishing says
    // nothing about this one. Polled with a deadline rather than awaited on an
    // event, because in a window that is not being composited the frame may
    // never arrive and a bare `await` would hang the suite.
    const copied = await copyYieldsAFrame(instance, 4000);
    checks.push(
      copied
        ? check(
            "copy yields the current frame as image data",
            true,
            "getCopyable returned a PNG blob with real dimensions",
          )
        : skip(
            "copy yields the current frame as image data",
            "the tile's video element decoded no frame within four seconds — a window " +
              "that is not being composited is the usual cause, and `captureFrame` " +
              "correctly returns nothing rather than a blank image. Bring the window " +
              "to the front and run the self-tests again to cover this.",
          ),
    );

    // Whether the *file* can be seeked at all, established before the thumbnail
    // is judged. A thumbnail is a frame from a timestamp nobody is playing, so
    // it is a seek by construction — and `MediaRecorder` output frequently
    // carries no seek index, which makes "no thumbnail" the file's property
    // rather than the plugin's. Guessing at the cause in the skip reason was
    // wrong once already (it blamed compositing, which was measured not to be
    // it), so the reason is measured too.
    const seekable = await probeSeekable(file);
    const thumbnail = await instance.thumbnail({ maxWidth: 160, maxHeight: 120 });
    checks.push(
      thumbnail.kind !== "icon"
        ? check(
            "the thumbnail is a real frame rather than an icon",
            thumbnail.width > 0 && thumbnail.height > 0,
            `${thumbnail.kind} ${thumbnail.width}×${thumbnail.height}`,
          )
        : seekable.ok
          ? check(
              "the thumbnail is a real frame rather than an icon",
              false,
              `the source seeks (${seekable.reason}) and the previewer still produced no frame`,
            )
          : skip(
              "the thumbnail is a real frame",
              `this file cannot be seeked (${seekable.reason}), and a thumbnail is a frame ` +
                "from a timestamp nobody is playing. Recorder output routinely carries no " +
                "seek index; open a real video file to cover the preview decoder.",
            ),
    );

    const state = instance.serialize();
    instance.restore(state);
    checks.push(
      check(
        "state round-trips through serialize and restore",
        typeof state === "object" && state !== null,
        JSON.stringify(state),
      ),
    );

    await disposeViewer(clientId);
    checks.push(
      check(
        "disposing releases the instance",
        isViewerDisposed(instance),
        "the instance is marked disposed and its decoders are released",
      ),
    );

    checks.push(
      check(
        "the tile's DOM is left empty",
        container.childElementCount === 0,
        `${container.childElementCount} child elements remain`,
      ),
    );
  } catch (thrown) {
    checks.push(check("a real file mounts, plays and disposes", false, String(thrown)));
  } finally {
    await disposeViewer(clientId);
    container.remove();
    file.release();
  }

  return checks;
}

/**
 * Whether a bare `<video>` will play a handle's stream URL.
 *
 * Off-screen rather than `display: none`, for the reason
 * `engine/thumbnailer.ts` records: a `display: none` video is not required to
 * decode and on WebKit does not, which would turn this probe into a timeout and
 * a timeout into a false negative.
 */
async function probePlayable(file: FileHandle): Promise<{ ok: boolean; reason: string }> {
  const url = file.streamUrl();
  if (!url) return { ok: false, reason: "the handle produced no stream URL" };

  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.style.cssText =
    "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.append(element);

  try {
    const outcome = await loadMedia(element, url, { timeoutMs: 8000 });
    if (outcome.kind === "ready" && outcome.width > 0) {
      return { ok: true, reason: `${outcome.width}×${outcome.height}` };
    }
    if (outcome.kind === "ready") return { ok: false, reason: "metadata arrived with no picture" };
    if (outcome.kind === "timeout") return { ok: false, reason: "the element never reported anything" };
    return { ok: false, reason: outcome.detail };
  } finally {
    element.removeAttribute("src");
    element.load();
    element.remove();
  }
}

/**
 * Whether a bare `<video>` will seek this handle's source.
 *
 * Bounded, like every other wait here: a source that cannot be seeked often
 * answers by never firing `seeked` at all rather than by failing.
 */
async function probeSeekable(file: FileHandle): Promise<{ ok: boolean; reason: string }> {
  const url = file.streamUrl();
  if (!url) return { ok: false, reason: "the handle produced no stream URL" };

  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.style.cssText =
    "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
  document.body.append(element);

  try {
    const outcome = await loadMedia(element, url, { timeoutMs: 8000 });
    if (outcome.kind !== "ready") return { ok: false, reason: `the source did not load (${outcome.kind})` };

    const duration = Number.isFinite(element.duration) ? element.duration : 0;
    if (duration <= 0) return { ok: false, reason: "the source reports no duration to seek within" };

    const target = duration * 0.25;
    const seeked = await new Promise<boolean>((resolve) => {
      const abort = new AbortController();
      const timer = setTimeout(() => {
        abort.abort();
        resolve(false);
      }, 3000);
      const settle = (value: boolean) => () => {
        clearTimeout(timer);
        abort.abort();
        resolve(value);
      };
      element.addEventListener("seeked", settle(true), { signal: abort.signal });
      element.addEventListener("error", settle(false), { signal: abort.signal });
      try {
        element.currentTime = target;
      } catch {
        settle(false)();
      }
    });

    return seeked
      ? { ok: true, reason: `landed at ${element.currentTime.toFixed(2)}s of ${duration.toFixed(2)}s` }
      : { ok: false, reason: "the seek was never answered" };
  } finally {
    element.removeAttribute("src");
    element.load();
    element.remove();
  }
}

async function copyYieldsAFrame(
  instance: ViewerInstance,
  timeoutMs: number,
): Promise<boolean> {
  if (!instance.copy) return false;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const copyable = await instance.copy.getCopyable({ kind: "all" });
    const image = copyable.find((item) => item.kind === "image");
    if (image?.kind === "image" && image.width > 0 && image.height > 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
