/**
 * Track selection: what audio and subtitle tracks a file offers, which of them
 * this platform can actually switch to, and which one is live.
 *
 * The brief asks to "expose track selection and render subtitles correctly over
 * the video". The first half is where the honesty lives, because a track being
 * *in the file* and a track being *selectable here* are different facts and the
 * gap between them is large:
 *
 *   - **Subtitles.** A sidecar `.srt` is fully ours — parsed, rendered, and
 *     searchable. An MP4 timed-text track was extracted at parse time and is
 *     equally ours. A Matroska subtitle track was listed and not extracted, for
 *     the structural reason `mkv/index.ts` sets out. A bitmap track (PGS,
 *     VobSub) is images, not text.
 *   - **Audio.** `HTMLMediaElement.audioTracks` is the only way to switch the
 *     playing track, and it is *not implemented* in Chromium — so on WebView2 a
 *     multi-track file plays its default track and no API can change that. It is
 *     present in WebKit, so macOS and most webkit2gtk builds can.
 *
 * A menu whose entries silently do nothing is worse than a menu that says which
 * entries do nothing, which is the same judgement the image plugin makes when it
 * shows a RAW file's embedded preview and says so. So every track the container
 * declared appears in the list, and the ones that cannot be selected carry the
 * reason.
 */

import type { ContainerTrack, SubtitleCue } from "../container";
import type { SidecarSubtitles } from "./subtitles";

/** The id used for "no subtitles", which is a choice rather than an absence. */
export const SUBTITLES_OFF = "off";

export interface SelectableTrack {
  readonly id: string;
  readonly label: string;
  /** Codec, channels, language — the second line in a menu row. */
  readonly detail?: string;
  /** Whether choosing it does anything. */
  readonly available: boolean;
  /** Why not, when it is not. Shown in the menu and the panel. */
  readonly reason?: string;
}

/**
 * The `audioTracks` API, which TypeScript's DOM library does not declare because
 * it is unimplemented in the engine those types are generated against.
 *
 * Declared here rather than reached for with `any`, so the two properties this
 * plugin uses are named and typed, and so the feature detection below is a check
 * for something with a shape rather than a cast.
 */
interface AudioTrackLike {
  readonly id: string;
  readonly label: string;
  readonly language: string;
  enabled: boolean;
}

interface AudioTrackListLike {
  readonly length: number;
  [index: number]: AudioTrackLike;
}

function audioTrackList(video: HTMLVideoElement): AudioTrackListLike | null {
  const list = (video as unknown as { audioTracks?: AudioTrackListLike }).audioTracks;
  // Probed by shape, and then by *use* below — an empty list on an engine that
  // has the property is indistinguishable from a file with one audio track, and
  // both mean "there is nothing to switch between".
  return list && typeof list.length === "number" ? list : null;
}

export class TrackModel {
  #video: HTMLVideoElement;
  #container: readonly ContainerTrack[];
  #sidecars: readonly SidecarSubtitles[];

  #selectedAudio: string | null = null;
  #selectedSubtitle: string = SUBTITLES_OFF;

  constructor(options: {
    video: HTMLVideoElement;
    container?: readonly ContainerTrack[];
    sidecars?: readonly SidecarSubtitles[];
  }) {
    this.#video = options.video;
    this.#container = options.container ?? [];
    this.#sidecars = options.sidecars ?? [];
  }

  /**
   * Takes the container's tracks and the sidecars once they have been read.
   *
   * The model is built before either is known, because the tile is built before
   * either is known — the header parse and the directory listing run beside the
   * decoder rather than in front of it (`mount.ts`, "Nothing waits for anything
   * it does not need"). Until this is called the file offers whatever the
   * *element* exposes, which for audio is the switchable list and for subtitles
   * is nothing.
   *
   * Every list here is derived on demand rather than stored, so adopting is two
   * assignments and the current selection survives it untouched. That matters:
   * a restored subtitle choice is applied as soon as the sidecars land, and
   * re-deriving a list must not silently reset what the user picked in the
   * moment before it did.
   */
  adopt(next: {
    container?: readonly ContainerTrack[];
    sidecars?: readonly SidecarSubtitles[];
  }): void {
    if (next.container) this.#container = next.container;
    if (next.sidecars) this.#sidecars = next.sidecars;
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------

  /**
   * The audio tracks, from the element where it exposes them and from the
   * container otherwise.
   *
   * The element's list is preferred when present because it is the one that can
   * be switched — its ids are what `enabled` is set on. The container's list is
   * the fallback and is marked unavailable, which is the accurate description of
   * a track this engine will not let anyone select.
   */
  audioTracks(): readonly SelectableTrack[] {
    const list = audioTrackList(this.#video);

    if (list && list.length > 0) {
      const tracks: SelectableTrack[] = [];
      for (let index = 0; index < list.length; index += 1) {
        const track = list[index]!;
        // The container's parallel entry, for a codec name the element does not
        // carry. Positional, because the element exposes no container id — which
        // is right for every file where both lists came from the same demuxer.
        const parallel = this.#container.filter((entry) => entry.kind === "audio")[index];
        tracks.push({
          id: track.id || String(index),
          label: track.label || parallel?.label || describeLanguage(track.language) || `Audio ${index + 1}`,
          detail: parallel ? describeAudio(parallel) : track.language || undefined,
          available: true,
        });
      }
      return tracks;
    }

    const declared = this.#container.filter((track) => track.kind === "audio");
    if (declared.length <= 1) {
      // One track is not a choice. Reporting it as an unavailable selection
      // would put a permanently greyed row in the menu to say nothing.
      return [];
    }

    return declared.map((track, index) => ({
      id: String(track.id),
      label: track.label || describeLanguage(track.language) || `Audio ${index + 1}`,
      detail: describeAudio(track),
      available: false,
      reason:
        "this webview does not expose audio track switching, so the file's default " +
        "track is the one playing",
    }));
  }

  get selectedAudioId(): string | null {
    return this.#selectedAudio;
  }

  /**
   * Switches the playing audio track.
   *
   * Returns whether it worked, rather than throwing or failing quietly: the
   * caller turns `false` into a message naming the limitation, and a menu that
   * appeared to accept a choice it could not make would be the thing this whole
   * module exists to avoid.
   */
  selectAudio(id: string): boolean {
    const list = audioTrackList(this.#video);
    if (!list || list.length === 0) return false;

    let matched = false;
    for (let index = 0; index < list.length; index += 1) {
      const track = list[index]!;
      const isWanted = (track.id || String(index)) === id;
      // Exactly one enabled: setting the wanted one first and clearing the rest
      // afterwards leaves a moment with two enabled, which WebKit resolves by
      // keeping the *first*.
      track.enabled = isWanted;
      if (isWanted) matched = true;
    }

    if (matched) this.#selectedAudio = id;
    return matched;
  }

  // -------------------------------------------------------------------------
  // Subtitles
  // -------------------------------------------------------------------------

  /**
   * Every subtitle track, in the order they are worth offering: off, then the
   * sidecars, then what was extracted from the container, then what was found
   * but could not be read.
   *
   * Sidecars come before embedded tracks deliberately. Someone who put an `.srt`
   * next to a film did it because they wanted that one.
   */
  subtitleTracks(): readonly SelectableTrack[] {
    const tracks: SelectableTrack[] = [
      { id: SUBTITLES_OFF, label: "off", available: true },
    ];

    this.#sidecars.forEach((sidecar, index) => {
      tracks.push({
        id: `sidecar:${index}`,
        label: sidecar.name,
        detail: [describeLanguage(sidecar.language), `${sidecar.cues.length} cues`]
          .filter(Boolean)
          .join(" · "),
        available: true,
      });
    });

    for (const track of this.#container) {
      if (track.kind !== "subtitle") continue;

      if (track.cues && track.cues.length > 0) {
        tracks.push({
          id: `embedded:${track.id}`,
          label: track.label || describeLanguage(track.language) || `Subtitles ${track.id}`,
          detail: [track.codecLabel, `${track.cues.length} cues`].filter(Boolean).join(" · "),
          available: true,
        });
        continue;
      }

      tracks.push({
        id: `embedded:${track.id}`,
        label: track.label || describeLanguage(track.language) || `Subtitles ${track.id}`,
        detail: track.codecLabel,
        available: false,
        reason: unreadableSubtitleReason(track),
      });
    }

    return tracks;
  }

  get selectedSubtitleId(): string {
    return this.#selectedSubtitle;
  }

  /**
   * Chooses a subtitle track and returns its cues.
   *
   * `null` means the selection did not take — an unavailable track — and the
   * caller says so. An empty array means "off", which is a successful selection
   * of nothing.
   */
  selectSubtitle(id: string): readonly SubtitleCue[] | null {
    if (id === SUBTITLES_OFF) {
      this.#selectedSubtitle = SUBTITLES_OFF;
      return [];
    }

    const sidecar = /^sidecar:(\d+)$/.exec(id);
    if (sidecar) {
      const found = this.#sidecars[Number(sidecar[1])];
      if (!found) return null;
      this.#selectedSubtitle = id;
      return found.cues;
    }

    const embedded = /^embedded:(\d+)$/.exec(id);
    if (embedded) {
      const trackId = Number(embedded[1]);
      const found = this.#container.find(
        (track) => track.kind === "subtitle" && track.id === trackId,
      );
      if (!found?.cues?.length) return null;
      this.#selectedSubtitle = id;
      return found.cues;
    }

    return null;
  }

  /** The next track in the list, skipping the unavailable ones. For the cycle key. */
  nextSubtitleId(): string {
    const usable = this.subtitleTracks().filter((track) => track.available);
    if (usable.length <= 1) return SUBTITLES_OFF;
    const at = usable.findIndex((track) => track.id === this.#selectedSubtitle);
    return usable[(at + 1) % usable.length]!.id;
  }

  /** Whether any subtitle text exists at all, which decides `capabilities.search`. */
  get hasSearchableText(): boolean {
    if (this.#sidecars.some((sidecar) => sidecar.cues.length > 0)) return true;
    return this.#container.some(
      (track) => track.kind === "subtitle" && (track.cues?.length ?? 0) > 0,
    );
  }

  /**
   * Every cue this plugin holds, for the contract's `extractText`.
   *
   * The *selected* track alone would be the wrong answer: the shell's global
   * search asks a tile what text it has, and "the language you happen to be
   * watching in" is not that. Each cue keeps its track so a result can say where
   * it came from.
   */
  allCues(): readonly { readonly track: string; readonly cues: readonly SubtitleCue[] }[] {
    const groups: { track: string; cues: readonly SubtitleCue[] }[] = [];
    for (const sidecar of this.#sidecars) {
      if (sidecar.cues.length > 0) groups.push({ track: sidecar.name, cues: sidecar.cues });
    }
    for (const track of this.#container) {
      if (track.kind !== "subtitle" || !track.cues?.length) continue;
      groups.push({
        track: track.label || describeLanguage(track.language) || `Subtitles ${track.id}`,
        cues: track.cues,
      });
    }
    return groups;
  }
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

/**
 * Why an embedded subtitle track could not be read.
 *
 * Two genuinely different answers, and conflating them would misinform: a text
 * track was reachable in principle and is not indexed, while a bitmap track is
 * images and no amount of reading would produce text.
 */
function unreadableSubtitleReason(track: ContainerTrack): string {
  const bitmap = /VOBSUB|PGS|DVBSUB|TEXTST/i.test(track.codecId);
  return bitmap
    ? "these are image subtitles rather than text, and are not rendered here"
    : "this container interleaves subtitle text through the whole file with no index " +
      "reaching it; a sidecar .srt or .vtt beside the video is read in full";
}

/** `"English"`, falling back to the tag itself for anything unrecognised. */
function describeLanguage(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  try {
    // The platform already has every language name, in the user's own locale.
    // A hand-written table would be a second, worse copy of it.
    const names = new Intl.DisplayNames(undefined, { type: "language" });
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** `"AAC · 5.1 · 48 kHz"`, skipping whatever the container did not say. */
function describeAudio(track: ContainerTrack): string {
  const parts = [track.codecLabel];
  if (track.channels) {
    parts.push(
      track.channels === 1
        ? "mono"
        : track.channels === 2
          ? "stereo"
          : track.channels === 6
            ? "5.1"
            : track.channels === 8
              ? "7.1"
              : `${track.channels} channels`,
    );
  }
  if (track.sampleRate) parts.push(`${Math.round(track.sampleRate / 100) / 10} kHz`);
  const language = describeLanguage(track.language);
  if (language) parts.push(language);
  return parts.filter(Boolean).join(" · ");
}
