/**
 * The inspector: the panel that shows the file's technical details, its tracks,
 * or its chapters.
 *
 * Three panels behind one cycling key, for the reason the image plugin's
 * inspector gives at length: three separate toggles would be three entries in
 * the keybind reference for three answers to the same question — "tell me more
 * about this file" — and AGENTS.md is explicit that a plugin's section of that
 * modal should be six to eight rows, not fifteen.
 *
 * ## It floats over the picture and does not take a column
 *
 * This used to be a real layout split — a 19-rem column beside the video — and
 * opening it resized the film. In a tile narrow enough for that to matter, which
 * is most of them once a layout has been split more than once, the column was
 * most of the tile and the picture was what fitted in the rest. Reading a codec
 * string should not reflow the thing decoding it.
 *
 * So `video.css` positions it over the top right of the tile instead, bounded to
 * a share of the width and scrolling inside itself. Nothing in this file changed
 * for that: it renders into the host it is given, and the host moved. That is
 * the split working — this module owns *what the three panels say*, and where
 * they sit is the view's business.
 *
 * The split between the three is by *what you do with them*, not by subject:
 *
 *   - **Info** is read. Codec, resolution, frame rate, bitrate, duration,
 *     container, audio details — the brief's metadata list, plus any caveat the
 *     parse collected. This panel is where those caveats live: they are answers
 *     to a question someone came here to ask, not news to interrupt a film with,
 *     which is why the line under the picture carries only a name/content
 *     mismatch and nothing else.
 *   - **Tracks** is operated. Every audio and subtitle track, selectable, with
 *     the ones that cannot be selected carrying their reason (see `tracks.ts`).
 *   - **Chapters** is navigated. Every mark, clickable, jumping the playhead.
 *
 * ## Info shows everything that was read, not a selection from it
 *
 * The rule for this panel is that a field the parsers produced and this panel
 * drops is a field nobody can get at: there is no other surface in the app that
 * shows a container's contents, and "it is in `ContainerTrack` but not on
 * screen" is indistinguishable from "the parser did not read it". Several fields
 * were in exactly that position — the track ids, the default and forced flags,
 * the container-native codec ids, the RFC 6381 parameter for audio, the whole of
 * every subtitle track, the file's own path and modified time — and every one of
 * them is the sort of thing someone opens a metadata panel *specifically* to
 * check.
 *
 * So each section renders every field its source carries, and omits a row only
 * when the file genuinely does not have that value. Two consequences worth
 * knowing:
 *
 *   - **Nothing here is derived twice.** Where the container and the decoder
 *     disagree — resolution, duration — both numbers are shown, labelled, rather
 *     than one being silently preferred. A disagreement is information.
 *   - **A guess is labelled as one.** The frame rate the transport steps by is
 *     the file's when the file states one and an assumption when it does not,
 *     and the row says which, because "25 fps" and "no stated rate, stepping at
 *     25" lead to different conclusions about a file that steps oddly.
 *
 * Plain DOM rather than React, matching the image and PDF plugins: a viewer owns
 * its container element and nothing else, and mounting a React root inside it
 * would tie the plugin's rendering to the shell's.
 */

import type { Chapter, ContainerInfo, ContainerTrack } from "../container";
import type { MediaSourceKind } from "../source";
import { codecCaveat } from "../codecs";
import { SUBTITLES_OFF, type SelectableTrack } from "./tracks";
import { formatTimecode } from "./transport";

export type VideoPanel = "none" | "info" | "tracks" | "chapters";

/** The order the cycle key visits, ending back at nothing. */
const PANEL_ORDER: readonly VideoPanel[] = ["none", "info", "tracks", "chapters"];

export interface VideoPanelData {
  /** The container's display name — "MPEG-4", "Matroska". */
  readonly formatLabel: string;
  readonly fileName: string;
  readonly fileSize?: number;
  /** Absent for an in-memory handle, which is the self-test's case. */
  readonly filePath?: string;
  /** Milliseconds since the epoch, when the platform reported one. */
  readonly modifiedAt?: number;
  readonly info: ContainerInfo;
  /**
   * What the decoder actually reports, as opposed to what the container
   * declared. The two disagree often enough to be worth showing both when they
   * do — a file whose header claims a resolution the stream does not carry is
   * exactly the kind of thing someone opens a metadata panel to find.
   */
  readonly measured: { width: number; height: number; durationMs: number };
  /**
   * The rate the transport is frame-stepping at, and whether the file stated it.
   *
   * Not the same question as the video track's `frameRate`, which is what the
   * *container* said: a file that states nothing still gets stepped at some
   * rate, and this is the only place that says which.
   */
  readonly frameRate?: { readonly value: number; readonly assumed: boolean };
  /**
   * How the bytes are reaching the decoder, measured at mount by `source.ts`.
   *
   * Which that module's own comment already said belonged here ("Reported by
   * the info panel, and measured") and which was not in fact shown anywhere. It
   * is the difference between a four-gigabyte file being read a range at a time
   * and being held whole in memory, which is the first thing worth knowing when
   * a large file is behaving badly.
   */
  readonly source?: { readonly kind: MediaSourceKind; readonly streaming: boolean };
  readonly audioTracks: readonly SelectableTrack[];
  readonly subtitleTracks: readonly SelectableTrack[];
  readonly selectedAudioId: string | null;
  readonly selectedSubtitleId: string;
}

export interface VideoInspectorCallbacks {
  onSelectAudio(id: string): void;
  onSelectSubtitle(id: string): void;
  onSeek(milliseconds: number): void;
}

export class VideoInspector {
  readonly host: HTMLElement;
  #callbacks: VideoInspectorCallbacks;

  #panel: VideoPanel = "none";
  #data: VideoPanelData | null = null;

  constructor(host: HTMLElement, callbacks: VideoInspectorCallbacks) {
    this.host = host;
    this.#callbacks = callbacks;
  }

  get panel(): VideoPanel {
    return this.#panel;
  }

  setPanel(panel: VideoPanel): void {
    this.#panel = panel;
    this.host.hidden = panel === "none";
    this.render();
  }

  /** The cycling key. Returns what is now showing, for the announcement. */
  cycle(): VideoPanel {
    const at = PANEL_ORDER.indexOf(this.#panel);
    const next = PANEL_ORDER[(at + 1) % PANEL_ORDER.length]!;
    this.setPanel(next);
    return next;
  }

  setData(data: VideoPanelData): void {
    this.#data = data;
    if (this.#panel !== "none") this.render();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(): void {
    if (this.#panel === "none") {
      this.host.replaceChildren();
      return;
    }

    const body = document.createElement("div");
    body.className = "video-panel-body";

    if (!this.#data) {
      body.append(note("still reading the file."));
      this.host.replaceChildren(body);
      return;
    }

    switch (this.#panel) {
      case "info":
        body.replaceChildren(...this.#infoContent(this.#data));
        break;
      case "tracks":
        body.replaceChildren(...this.#tracksContent(this.#data));
        break;
      case "chapters":
        body.replaceChildren(...this.#chaptersContent(this.#data));
        break;
      default:
        break;
    }

    this.host.replaceChildren(body);
  }

  #infoContent(data: VideoPanelData): Node[] {
    const { info, measured } = data;
    const nodes: Node[] = [];

    const video = info.tracks.find((track) => track.kind === "video");
    const audio = info.tracks.filter((track) => track.kind === "audio");
    const subtitles = info.tracks.filter((track) => track.kind === "subtitle");

    nodes.push(...section("General", this.#generalFields(data)));

    // A video section whenever there is a picture, with or without a header.
    // When the header could not be parsed the decoder still knows the
    // resolution, and showing that is more use than explaining the gap — the
    // person looking at this panel wants the number, not an account of how it
    // was obtained.
    const hasPicture = measured.width > 0 && measured.height > 0;
    if (video ?? hasPicture) {
      nodes.push(...section("Video", this.#videoFields(data, video, hasPicture)));
    }

    audio.forEach((track, index) => {
      nodes.push(
        ...section(audio.length > 1 ? `Audio ${index + 1}` : "Audio", audioFields(track)),
      );
    });

    subtitles.forEach((track, index) => {
      nodes.push(
        ...section(
          subtitles.length > 1 ? `Subtitles ${index + 1}` : "Subtitles",
          subtitleFields(track),
        ),
      );
    });

    // Sidecars are not in the container and so cannot appear above, but a file
    // with a `.srt` beside it has subtitle metadata whether or not the muxer
    // knew about it, and "this panel shows everything" has to include that.
    const sidecars = data.subtitleTracks.filter((track) => track.id.startsWith("sidecar:"));
    if (sidecars.length > 0) {
      nodes.push(
        ...section(
          "Sidecar subtitles",
          sidecars.map((track, index) => ({
            label: `file ${index + 1}`,
            value: track.detail ? `${track.label} — ${track.detail}` : track.label,
          })),
        ),
      );
    }

    // Nothing at all: no tracks in the header and no picture from the decoder,
    // which for an audio-only file is the whole truth and needs one short line
    // rather than an explanation of where the numbers usually come from.
    if (!video && audio.length === 0 && subtitles.length === 0 && !hasPicture) {
      nodes.push(note("no track details are available for this file."));
    }

    // Every caveat the parse collected, verbatim. A panel that quietly dropped
    // "the frame rate is variable and this is an average" would leave a number
    // above it looking more exact than it is.
    for (const line of info.notes) nodes.push(note(line));

    return nodes;
  }

  #generalFields(data: VideoPanelData): Field[] {
    const { info, measured } = data;
    const fields: Field[] = [
      { label: "file", value: data.fileName },
      { label: "container", value: data.formatLabel },
    ];

    // The path is where a file *is*, which is the question a workspace of
    // similarly named renders raises constantly and which nothing else in a
    // video tile answers.
    if (data.filePath) fields.push({ label: "path", value: data.filePath });
    if (data.fileSize !== undefined) {
      fields.push({ label: "size", value: `${formatBytes(data.fileSize)} (${data.fileSize} B)` });
    }
    if (data.modifiedAt !== undefined) {
      fields.push({ label: "modified", value: formatTimestamp(data.modifiedAt) });
    }

    // Both durations when they differ, for the reason the resolution rows give:
    // a fragmented MP4's header duration and the one the player settles on
    // routinely disagree, and the panel is where that is noticed rather than
    // wondered about.
    const played = measured.durationMs || 0;
    const declared = info.durationMs || 0;
    const duration = played || declared;
    fields.push({
      label: "duration",
      value:
        duration > 0
          ? played > 0 && declared > 0 && Math.abs(played - declared) > 1000
            ? `${formatTimecode(played)} (header says ${formatTimecode(declared)})`
            : formatTimecode(duration)
          : "unknown",
    });

    if (info.bitrate) {
      fields.push({ label: "bitrate", value: formatBitrate(info.bitrate) });
    }
    if (info.title) fields.push({ label: "title", value: info.title });
    if (info.writer) fields.push({ label: "written by", value: info.writer });

    if (info.tracks.length > 0) {
      fields.push({ label: "tracks", value: describeTrackCounts(info.tracks) });
    }
    if (info.chapters.length > 0) {
      fields.push({ label: "chapters", value: String(info.chapters.length) });
    }
    if (data.source) {
      fields.push({ label: "delivery", value: describeSource(data.source) });
    }

    return fields;
  }

  #videoFields(
    data: VideoPanelData,
    video: ContainerTrack | undefined,
    hasPicture: boolean,
  ): Field[] {
    const { measured } = data;
    const fields: Field[] = [];
    if (video) fields.push({ label: "codec", value: describeCodec(video) });

    // The declared and the measured resolution, and both only when they
    // differ: showing one number twice is noise, and showing only the
    // container's when the stream disagrees would be repeating a claim this
    // panel is in a position to check.
    const declared = video?.width && video.height ? `${video.width}×${video.height}` : null;
    const actual = hasPicture ? `${measured.width}×${measured.height}` : null;
    if (actual && declared && actual !== declared) {
      fields.push({ label: "resolution", value: `${actual} (header says ${declared})` });
    } else if (actual ?? declared) {
      fields.push({ label: "resolution", value: (actual ?? declared)! });
    }

    const width = measured.width || video?.width || 0;
    const height = measured.height || video?.height || 0;
    if (width > 0 && height > 0) {
      fields.push({ label: "aspect", value: describeAspect(width, height) });
    }

    if (video?.frameRate) {
      fields.push({ label: "frame rate", value: `${round(video.frameRate, 3)} fps` });
    }
    // What frame-stepping actually moves by, and whether that came from the file.
    // Only worth its own row when the container did not state a rate, since
    // otherwise it repeats the row above.
    if (data.frameRate?.assumed) {
      fields.push({
        label: "step rate",
        value: `${round(data.frameRate.value, 3)} fps (assumed — this file states none)`,
      });
    }

    if (video?.bitrate) {
      fields.push({ label: "track bitrate", value: formatBitrate(video.bitrate) });
    }
    if (video?.codec) fields.push({ label: "codec string", value: video.codec });
    if (video?.codecId && video.codecId !== video.codec) {
      fields.push({ label: "codec id", value: video.codecId });
    }
    if (video?.language) fields.push({ label: "language", value: video.language });
    if (video?.label) fields.push({ label: "name", value: video.label });
    if (video) fields.push({ label: "track id", value: String(video.id) });
    const flags = describeFlags(video);
    if (flags) fields.push({ label: "flags", value: flags });

    return fields;
  }

  #tracksContent(data: VideoPanelData): Node[] {
    const nodes: Node[] = [];

    nodes.push(heading("Audio"));
    if (data.audioTracks.length === 0) {
      nodes.push(note("this file has a single audio track, or none."));
    } else {
      nodes.push(
        trackList(data.audioTracks, data.selectedAudioId, (id) =>
          this.#callbacks.onSelectAudio(id),
        ),
      );
    }

    nodes.push(heading("Subtitles"));
    const subtitles = data.subtitleTracks;
    // One entry means "off" alone, which is not a choice worth rendering as a
    // list of one.
    if (subtitles.length <= 1) {
      nodes.push(
        note("no subtitles were found. A .srt or .vtt beside the video is picked up."),
      );
    } else {
      nodes.push(
        trackList(subtitles, data.selectedSubtitleId || SUBTITLES_OFF, (id) =>
          this.#callbacks.onSelectSubtitle(id),
        ),
      );
    }

    return nodes;
  }

  #chaptersContent(data: VideoPanelData): Node[] {
    const chapters = data.info.chapters;
    if (chapters.length === 0) {
      return [note("this file has no chapter marks.")];
    }

    const list = document.createElement("ol");
    list.className = "video-chapter-list";

    chapters.forEach((chapter: Chapter, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "video-chapter-item";
      button.addEventListener("click", () => this.#callbacks.onSeek(chapter.startMs));

      const time = document.createElement("span");
      time.className = "video-chapter-time";
      time.textContent = formatTimecode(chapter.startMs);

      const title = document.createElement("span");
      title.className = "video-chapter-title";
      title.textContent = chapter.title || `Chapter ${index + 1}`;

      button.append(time, title);
      item.append(button);
      list.append(item);
    });

    return [heading(`${chapters.length} chapters`), list];
  }
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

interface Field {
  readonly label: string;
  readonly value: string;
}

function heading(text: string): HTMLElement {
  const element = document.createElement("h3");
  element.className = "video-panel-heading";
  element.textContent = text;
  return element;
}

function note(text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = "video-panel-note";
  element.textContent = text;
  return element;
}

function section(title: string, fields: readonly Field[]): Node[] {
  if (fields.length === 0) return [];
  const list = document.createElement("dl");
  list.className = "video-fields";
  for (const field of fields) {
    const term = document.createElement("dt");
    term.textContent = field.label;
    const value = document.createElement("dd");
    value.textContent = field.value;
    list.append(term, value);
  }
  return [heading(title), list];
}

/**
 * A radio-style list of tracks.
 *
 * An unavailable track is rendered disabled *and* keeps its reason underneath,
 * which is the whole point of `tracks.ts` reaching this far: a greyed row with
 * no explanation invites the user to keep clicking it.
 */
function trackList(
  tracks: readonly SelectableTrack[],
  selectedId: string | null,
  onSelect: (id: string) => void,
): HTMLElement {
  const list = document.createElement("ul");
  list.className = "video-track-list";

  for (const track of tracks) {
    const item = document.createElement("li");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "video-track-item";
    button.disabled = !track.available;
    const chosen = track.id === selectedId;
    button.classList.toggle("is-selected", chosen);
    button.setAttribute("aria-pressed", String(chosen));
    if (track.available) button.addEventListener("click", () => onSelect(track.id));

    const label = document.createElement("span");
    label.className = "video-track-label";
    label.textContent = `${chosen ? "•" : " "} ${track.label}`;
    button.append(label);

    if (track.detail) {
      const detail = document.createElement("span");
      detail.className = "video-track-detail";
      detail.textContent = track.detail;
      button.append(detail);
    }

    item.append(button);

    if (track.reason) {
      const reason = document.createElement("p");
      reason.className = "video-track-reason";
      reason.textContent = track.reason;
      item.append(reason);
    }

    list.append(item);
  }

  return list;
}

/** Every field an audio track carries, in the order they answer questions in. */
function audioFields(track: ContainerTrack): Field[] {
  const fields: Field[] = [{ label: "codec", value: describeCodec(track) }];
  if (track.channels) {
    fields.push({ label: "channels", value: describeChannels(track.channels) });
  }
  if (track.sampleRate) {
    fields.push({ label: "sample rate", value: `${round(track.sampleRate / 1000, 3)} kHz` });
  }
  if (track.bitrate) fields.push({ label: "bitrate", value: formatBitrate(track.bitrate) });
  if (track.codec) fields.push({ label: "codec string", value: track.codec });
  if (track.codecId && track.codecId !== track.codec) {
    fields.push({ label: "codec id", value: track.codecId });
  }
  if (track.language) fields.push({ label: "language", value: track.language });
  if (track.label) fields.push({ label: "name", value: track.label });
  fields.push({ label: "track id", value: String(track.id) });
  const flags = describeFlags(track);
  if (flags) fields.push({ label: "flags", value: flags });
  return fields;
}

/**
 * Every field a subtitle track carries, including whether its text was reachable.
 *
 * The last part is the reason this section exists at all: the tracks panel can
 * only say "unavailable" beside a row, and *why* — a Matroska file whose cues
 * are spread through every cluster — belongs with the rest of what was read
 * about the file.
 */
function subtitleFields(track: ContainerTrack): Field[] {
  const fields: Field[] = [{ label: "codec", value: describeCodec(track) }];
  if (track.language) fields.push({ label: "language", value: track.language });
  if (track.label) fields.push({ label: "name", value: track.label });
  fields.push({
    label: "cues",
    value: track.cues
      ? `${track.cues.length} extracted`
      : "not extracted from this container",
  });
  if (track.codecId && track.codecId !== track.codec) {
    fields.push({ label: "codec id", value: track.codecId });
  }
  fields.push({ label: "track id", value: String(track.id) });
  const flags = describeFlags(track);
  if (flags) fields.push({ label: "flags", value: flags });
  return fields;
}

/** `"H.264 (High profile — not decodable on every platform)"`. */
function describeCodec(track: ContainerTrack): string {
  const caveat = codecCaveat(track.codecLabel);
  return caveat ? `${track.codecLabel} — ${caveat}` : track.codecLabel;
}

/**
 * `default`, `forced`, `default, forced`, or nothing.
 *
 * Both flags are in every container this plugin reads and neither was on screen
 * anywhere. A forced subtitle track is why captions appear on a film nobody
 * turned them on for, which is a question this panel should be able to answer.
 */
function describeFlags(track: ContainerTrack | undefined): string {
  if (!track) return "";
  const flags: string[] = [];
  if (track.isDefault) flags.push("default");
  if (track.isForced) flags.push("forced");
  return flags.join(", ");
}

/** `"2 video, 1 audio, 3 subtitle"` — what the container turned out to hold. */
function describeTrackCounts(tracks: readonly ContainerTrack[]): string {
  const counts = new Map<string, number>();
  for (const track of tracks) counts.set(track.kind, (counts.get(track.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${count} ${kind}`).join(", ");
}

/** `"6 (5.1)"`. The layout name is what the number means to anyone reading it. */
function describeChannels(channels: number): string {
  const layouts: Readonly<Record<number, string>> = {
    1: "mono",
    2: "stereo",
    6: "5.1",
    8: "7.1",
  };
  const layout = layouts[channels];
  return layout ? `${channels} (${layout})` : String(channels);
}

/**
 * `"16:9 (1.78)"`.
 *
 * The ratio in lowest terms when it is one of the ones people name, and the
 * decimal always — a 2.39:1 scope master reduces to something like 1024:429,
 * which is true and tells nobody anything.
 */
function describeAspect(width: number, height: number): string {
  const decimal = round(width / height, 2);
  const divisor = greatestCommonDivisor(width, height);
  const w = width / divisor;
  const h = height / divisor;
  return w <= 30 && h <= 30 ? `${w}:${h} (${decimal})` : `${decimal}:1`;
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y > 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1;
}

/** How the bytes are reaching the decoder, in words rather than in enum values. */
function describeSource(source: { kind: MediaSourceKind; streaming: boolean }): string {
  const path =
    source.kind === "loopback"
      ? "loopback server"
      : source.kind === "asset"
        ? "asset protocol"
        : "in memory";
  return source.streaming ? `${path}, fetched by range` : `${path}, whole file`;
}

/** A modified time, in the viewer's own locale and time zone. */
function formatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "unknown";
  try {
    return new Date(epochMs).toLocaleString();
  } catch {
    return new Date(epochMs).toISOString();
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${round(value, value < 10 ? 2 : 1)} ${units[unit]}`;
}

/** Mbit/s above a megabit, kbit/s below — the units these numbers are quoted in. */
function formatBitrate(bitsPerSecond: number): string {
  return bitsPerSecond >= 1_000_000
    ? `${round(bitsPerSecond / 1_000_000, 2)} Mbit/s`
    : `${Math.round(bitsPerSecond / 1000)} kbit/s`;
}
