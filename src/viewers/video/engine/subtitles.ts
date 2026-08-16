/**
 * Subtitles: finding them, parsing them, and drawing them over the video.
 *
 * The brief asks for "embedded/sidecar subtitle tracks (SRT/VTT)" to be
 * selectable and "render[ed] correctly over the video", plus search over caption
 * text with results that jump to a timestamp. Three sources feed one model:
 *
 *   1. **Sidecar files** beside the video — `film.srt`, `film.en.vtt`. Found by
 *      listing the directory, parsed here, rendered here.
 *   2. **Embedded tracks this plugin extracted**, which is MP4 and QuickTime
 *      timed text (`metadata/isobmff.ts` explains why those and not Matroska's).
 *   3. **Embedded tracks the webview itself exposes** through
 *      `video.textTracks`, which is WebVTT-in-MP4 on Safari and little else.
 *
 * All three arrive as {@link SubtitleCue} lists, so the renderer, the track menu
 * and the search index cannot tell them apart — which is what makes "search the
 * captions" one implementation rather than three.
 *
 * ## They are drawn by this plugin, not by the engine
 *
 * The obvious alternative is a `<track>` element and the browser's own cue
 * renderer. It is rejected for three reasons that all point the same way:
 * `::cue` styling is unevenly implemented across the three target webviews, so
 * the same file would look different on each; the native renderer positions cues
 * against the video's own box, which in a tile with letterboxing is not where
 * they belong; and the cue text would then live somewhere this plugin cannot
 * read it for the contract's `extractText`. Drawing them is about forty lines
 * and makes all three problems not exist.
 *
 * ## Markup is stripped, not rendered
 *
 * SRT carries a little HTML, ASS carries a whole override language, and WebVTT
 * carries its own tag set. None of it is rendered: a subtitle in this viewer is
 * text in the app's own type, for the same reason the image plugin renders an
 * SVG through an `<img>` — the file is one the user did not write, and turning
 * its markup into DOM is a decision with consequences beyond typography. What
 * *is* honoured is line breaks, because a two-line subtitle broken onto one line
 * changes how fast it can be read.
 */

import {
  directoryOf,
  listDirectoryFiles,
  type FileHandle,
} from "../../../files";
import type { SubtitleCue } from "../container";

/** Sidecar extensions looked for beside the video. */
export const SUBTITLE_EXTENSIONS: readonly string[] = ["srt", "vtt", "ass", "ssa", "sub"];

/** A sidecar larger than this is not subtitles. */
const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * `00:01:02,500` / `00:01:02.500` / `1:02.5` / `0:00:01.00` (ASS).
 *
 * One parser for all four formats' timestamps, because they differ only in the
 * decimal separator and in how many fields they bother to write. Being strict
 * about the separator would reject half the SRT files in existence, which use a
 * full stop despite the specification.
 */
function parseTimestamp(text: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  // ASS writes centiseconds and the others milliseconds. Padding to three
  // digits makes `.50` mean half a second in both rather than fifty
  // milliseconds in one of them.
  const fraction = Number(match[4]!.padEnd(3, "0"));
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + fraction;
}

/**
 * Strips a cue's markup down to text and line breaks.
 *
 * ASS override blocks (`{\pos(200,900)}`) go first, since they can contain
 * anything including angle brackets, then the tag sets SRT and WebVTT share, then
 * ASS's own `\N` line break. The HTML entities are the four that appear in real
 * files; a full entity table would be a decoder for a language this does not
 * render.
 */
function stripMarkup(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\\[Nnh]/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * SubRip and WebVTT, which are the same format with different headers.
 *
 * The differences that matter: WebVTT starts with a `WEBVTT` line and may carry
 * `NOTE` and `STYLE` blocks, and its cues may have a settings suffix after the
 * arrow. Both are handled by treating any block containing an arrow line as a
 * cue and ignoring everything else — which also makes a malformed block one
 * missing subtitle rather than a failed file.
 */
export function parseSrtOrVtt(source: string): readonly SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  // A BOM survives a UTF-8 decode and would defeat the `WEBVTT` check and the
  // first cue's index line alike. Line endings are normalised because SRT files
  // are written on every platform and read on every other one.
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const arrowAt = lines.findIndex((line) => line.includes("-->"));
    if (arrowAt < 0) continue;

    const [from, rest] = lines[arrowAt]!.split("-->");
    if (!from || !rest) continue;
    // WebVTT allows cue settings after the end time, space-separated.
    const to = rest.trim().split(/\s+/)[0]!;

    const startMs = parseTimestamp(from);
    const endMs = parseTimestamp(to);
    if (startMs === null || endMs === null) continue;

    const body = stripMarkup(lines.slice(arrowAt + 1).join("\n"));
    if (!body) continue;

    cues.push({ startMs, endMs: Math.max(endMs, startMs + 1), text: body });
  }

  return cues.sort((a, b) => a.startMs - b.startMs);
}

/**
 * SubStation Alpha, which is a different shape entirely: an INI-like file whose
 * `[Events]` section has a `Format:` line naming the columns and then one
 * `Dialogue:` row per cue.
 *
 * The format line has to be read rather than assumed. The column order is
 * genuinely per-file — ASS and SSA differ from each other, and a file written by
 * a fansub tool may differ from both — and taking fixed positions produces cues
 * with the actor's name as their text, which looks like a working subtitle track
 * saying the wrong thing.
 */
export function parseAss(source: string): readonly SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");

  let startColumn = 1;
  let endColumn = 2;
  let textColumn = 9;
  let inEvents = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("[")) {
      inEvents = /^\[events\]$/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue;

    if (/^format\s*:/i.test(trimmed)) {
      const columns = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((column) => column.trim().toLowerCase());
      const at = (name: string, fallback: number): number => {
        const index = columns.indexOf(name);
        return index >= 0 ? index : fallback;
      };
      startColumn = at("start", 1);
      endColumn = at("end", 2);
      textColumn = at("text", columns.length - 1);
      continue;
    }

    if (!/^dialogue\s*:/i.test(trimmed)) continue;

    // The text column is last and may itself contain commas, so the split is
    // limited: everything from the text column onwards is one field.
    const fields = trimmed.slice(trimmed.indexOf(":") + 1).split(",");
    if (fields.length <= textColumn) continue;

    const startMs = parseTimestamp(fields[startColumn]?.trim() ?? "");
    const endMs = parseTimestamp(fields[endColumn]?.trim() ?? "");
    if (startMs === null || endMs === null) continue;

    const body = stripMarkup(fields.slice(textColumn).join(","));
    if (!body) continue;

    cues.push({ startMs, endMs: Math.max(endMs, startMs + 1), text: body });
  }

  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** Picks the parser from the file's extension, defaulting to the SRT family. */
export function parseSubtitles(extension: string | undefined, source: string): readonly SubtitleCue[] {
  return extension === "ass" || extension === "ssa"
    ? parseAss(source)
    : parseSrtOrVtt(source);
}

// ---------------------------------------------------------------------------
// Sidecar discovery
// ---------------------------------------------------------------------------

export interface SidecarSubtitles {
  /** The file name, which is what the track menu shows. */
  readonly name: string;
  /** The language guessed from the name — `film.en.srt` gives `"en"`. */
  readonly language?: string;
  readonly cues: readonly SubtitleCue[];
}

/**
 * Finds and reads the subtitle files beside a video.
 *
 * Matching is on the stem: `film.mkv` takes `film.srt`, `film.en.srt` and
 * `film.forced.srt`, and ignores `trailer.srt`. That is the convention every
 * media player uses, and the looser alternative — every subtitle file in the
 * directory — turns a folder of episodes into forty tracks on each one.
 *
 * Returns an empty array for anything with no directory to search, which
 * includes every in-memory handle. A normal condition, not a failure.
 */
export async function findSidecarSubtitles(
  file: FileHandle,
  options?: { readonly signal?: AbortSignal },
): Promise<readonly SidecarSubtitles[]> {
  const directory = file.path ? directoryOf(file.path) : undefined;
  if (!directory) return [];

  const stem = stripExtension(file.name).toLowerCase();

  let entries;
  try {
    entries = await listDirectoryFiles(directory, SUBTITLE_EXTENSIONS);
  } catch (thrown) {
    console.warn("[video] could not list the folder for sidecar subtitles", thrown);
    return [];
  }

  const found: SidecarSubtitles[] = [];
  for (const entry of entries) {
    options?.signal?.throwIfAborted();

    const name = stripExtension(entry.name).toLowerCase();
    if (name !== stem && !name.startsWith(`${stem}.`)) continue;
    if (entry.size > MAX_SIDECAR_BYTES) continue;

    try {
      const { createNativeFileHandle } = await import("../../../files");
      const handle = createNativeFileHandle(entry, "drag-drop");
      const bytes = await handle.read();
      handle.release();

      const cues = parseSubtitles(entry.extension, decodeSubtitleText(bytes));
      if (cues.length === 0) continue;

      found.push({
        name: entry.name,
        language: languageFromName(entry.name, stem),
        cues,
      });
    } catch (thrown) {
      if (options?.signal?.aborted) throw thrown;
      // One unreadable sidecar must not cost the others, or the video.
      console.warn(`[video] could not read ${entry.name}`, thrown);
    }
  }

  return found;
}

/**
 * Decodes a subtitle file's bytes.
 *
 * UTF-8, with two exceptions worth handling because they are common rather than
 * exotic: a UTF-16 byte-order mark, which Windows tools write; and a UTF-8
 * decode that comes back full of replacement characters, which means the file is
 * in some single-byte legacy encoding. For the second, Latin-1 at least produces
 * readable text for the Western European files it usually is, where UTF-8 would
 * produce a screen of question marks.
 */
function decodeSubtitleText(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
  }

  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const replacements = (utf8.match(/�/g) ?? []).length;
  if (replacements > 0 && replacements > utf8.length / 200) {
    return new TextDecoder("windows-1252", { fatal: false }).decode(bytes);
  }
  return utf8;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * The language tag between the stem and the extension: `film.en.srt` → `en`.
 *
 * Only accepted when it looks like a language tag. `film.forced.srt` and
 * `film.2.srt` both have something in that position and neither is a language,
 * and labelling a track "forced" as though it were a language is worse than
 * leaving it unlabelled — the name is shown either way.
 */
function languageFromName(name: string, stem: string): string | undefined {
  const withoutExtension = stripExtension(name);
  if (withoutExtension.length <= stem.length + 1) return undefined;
  const suffix = withoutExtension.slice(stem.length + 1);
  return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/i.test(suffix) ? suffix.toLowerCase() : undefined;
}

// ---------------------------------------------------------------------------
// Lookup and rendering
// ---------------------------------------------------------------------------

/**
 * The cues showing at a given moment.
 *
 * Found by binary search on the start times, then walked backwards — because
 * cues overlap. Two speakers subtitled at once is normal, and the naive "find
 * the last cue that started" shows one of them. The backward walk is bounded, so
 * a pathological file with a thousand overlapping cues cannot make this the
 * expensive part of a pointer move.
 */
export function cuesAt(cues: readonly SubtitleCue[], timeMs: number): readonly SubtitleCue[] {
  if (cues.length === 0) return [];

  let low = 0;
  let high = cues.length - 1;
  let last = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (cues[middle]!.startMs <= timeMs) {
      last = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (last < 0) return [];

  const showing: SubtitleCue[] = [];
  for (let index = last; index >= 0 && last - index < 16; index -= 1) {
    const cue = cues[index]!;
    if (cue.endMs > timeMs) showing.unshift(cue);
  }
  return showing;
}

/**
 * The caption overlay: a fixed band across the lower part of the stage.
 *
 * Positioned against the *stage* rather than the video element, so captions sit
 * over the letterboxing of a 2.39:1 film in a 16:9 tile rather than crossing the
 * picture — which is where a cinema puts them and where the native cue renderer
 * would not.
 */
export class CaptionOverlay {
  readonly root: HTMLElement;
  #cues: readonly SubtitleCue[] = [];
  #shownKey = "";

  constructor(host: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "video-captions";
    this.root.setAttribute("aria-live", "polite");
    this.root.hidden = true;
    host.append(this.root);
  }

  setCues(cues: readonly SubtitleCue[]): void {
    this.#cues = cues;
    this.#shownKey = "";
    this.update(0);
  }

  get hasCues(): boolean {
    return this.#cues.length > 0;
  }

  /**
   * Redraws for a playhead position.
   *
   * Called on every `timeupdate`, so it compares against what is already on
   * screen and does nothing when the answer has not changed — which for a
   * two-second subtitle is seven calls out of eight.
   */
  update(timeMs: number): void {
    const showing = cuesAt(this.#cues, timeMs);
    const key = showing.map((cue) => `${cue.startMs}`).join("|");
    if (key === this.#shownKey) return;
    this.#shownKey = key;

    if (showing.length === 0) {
      this.root.hidden = true;
      this.root.replaceChildren();
      return;
    }

    this.root.hidden = false;
    this.root.replaceChildren(
      ...showing.map((cue) => {
        const line = document.createElement("p");
        line.className = "video-caption-line";
        // `textContent` with `white-space: pre-line` in the stylesheet: the line
        // breaks the file asked for, and nothing else it asked for.
        line.textContent = cue.text;
        return line;
      }),
    );
  }

  clear(): void {
    this.#cues = [];
    this.#shownKey = "";
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  destroy(): void {
    this.root.remove();
  }
}
