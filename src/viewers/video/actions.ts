/**
 * What a video tile can be asked to do, and how those actions reach the user.
 *
 * The same shape as `viewers/image/actions.ts` and `shell/docking/actions.ts`,
 * for the same reason: one verb list, three surfaces derived from it, so an
 * action cannot end up with a shortcut and no visible path or a button and no
 * shortcut. {@link VideoActions} is what the instance implements; the three
 * functions below are the toolbar, the keybinds, and the tile's context menu.
 *
 * ## The toolbar is five controls, and the brief names them
 *
 * *"Contribute a minimal, essential-only toolbar control set when a video tile
 * is focused (play/pause, seek, volume)."* So: seek back, play/pause, seek
 * forward, the position readout, and volume. The timeline itself is not a
 * toolbar control — it is in the tile, where it can be as wide as the video and
 * carry chapter marks, the loop region and a hover preview, none of which fit in
 * a shared strip of chrome.
 *
 * Volume is one control rather than two. The contract has no slider kind, and a
 * mute toggle beside a level choice would be two controls for one question with
 * a state they can contradict — muted at 80% shows both "silent" and "80%". So
 * the choice includes "muted" as a value.
 *
 * It is also, now, the only *visible* volume control anywhere. The tile's own
 * bar used to carry a continuous slider, a mute button and a speed readout, and
 * all three came out of it: the bar floats over the picture and fades when the
 * pointer stops (`engine/view.ts`), so its width is the picture's width and a
 * timeline worth dragging is what that width is for. Nothing became
 * unreachable — the level is `Up`/`Down` and this control, mute is `m` and a
 * menu row, speed is `x` and a menu row — and each announces what it did over
 * the picture, because a control that is not on screen has to say so.
 *
 * ## Eight listed shortcuts, and what is deliberately not among them
 *
 * AGENTS.md puts the right order of magnitude at six to eight. The eight are
 * Space, J/K/L, A, I, S and F, and the choices behind them:
 *
 *   - **J, K and L get three rows, and earn them.** They are the one idiom a
 *     review tool is expected to have and the one nothing else in this app
 *     suggests. Someone who knows them will try them; someone who does not will
 *     find them here, which is what the modal is for.
 *   - **One loop key, not three.** In point, out point and clear are the whole
 *     life cycle of a review loop in that order, every time — the same
 *     three-toggles-into-one-rotation consolidation AGENTS.md describes. `a`
 *     walks it and the status line says which step it just took.
 *   - **One inspector key, not three.** Info, tracks and chapters are three
 *     answers to "tell me more about this file". `i` visits each and returns to
 *     none.
 *   - **`f` is fullscreen, not fit.** It means fullscreen in every video player
 *     there is, and matching the image plugin's `f` here would break the much
 *     stronger convention. Scale mode has no binding at all: it is three entries
 *     in the context menu, which is a legitimate route and the one this setting
 *     is reached by about once a session.
 *
 * Seeking, frame-stepping, zoom, volume, mute, speed, chapter jumps, frame
 * capture and picture-in-picture are registered and hidden. Every one is in the
 * context menu, so nothing is keyboard-only and the modal stays a reminder
 * rather than a manual.
 *
 * ## The keys, and what they avoid
 *
 * The shell owns every `Mod`+letter, `Mod`+digit and `Mod`+arrow. So these live
 * in the space left over: the transport letters a review tool already trains
 * people on, and bare arrows and punctuation — safe because the registry refuses
 * to fire an unmodified binding while a text field has focus.
 *
 * `Mod+=` and `Mod+-` are the one exception, and they are borrowed rather than
 * claimed: AGENTS.md names them (with `Mod+P`) as the accelerators "conventional
 * to the point that moving them would be worse than the risk, and unclaimed by
 * the shell", and the image plugin already zooms with them. A video that zoomed
 * with different keys from an image in the tile beside it would be the kind of
 * inconsistency the shared keybind registry exists to prevent.
 *
 * `PageUp`/`PageDown` are previous/next *chapter* here, previous/next *image* in
 * the image plugin and previous/next *page* in a PDF. That is not a collision:
 * contributed bindings are registered only while their tile is focused, which is
 * what the contract's keybind extension point exists to provide.
 */

import type { ToolbarControl, ViewerKeybind } from "../contract";
import type { VideoPanel } from "./engine/panels";
import type { ScaleMode, ZoomMode } from "./engine/view";
import { formatTimecode } from "./engine/transport";
import { SCALE_MODES, SCALE_MODE_LABELS } from "./settings";

/** How far a bare arrow moves the playhead. */
export const NUDGE_MS = 5000;

/** How much an arrow changes the volume. */
export const VOLUME_STEP = 0.05;

/** The verbs. Implemented by the instance, consumed by the three surfaces below. */
export interface VideoActions {
  readonly playing: boolean;
  readonly currentMs: number;
  readonly durationMs: number;
  readonly speed: number;
  /** `0` when not shuttling; negative when shuttling backwards. */
  readonly shuttleRate: number;

  readonly muted: boolean;
  readonly volume: number;
  /** Whether this file has audio at all. A silent file gets no volume control. */
  readonly hasAudio: boolean;

  /** A fit mode, or `custom` while an explicit zoom is in effect. */
  readonly scaleMode: ZoomMode;
  /** What the picture is scaled to, as a percentage of its own pixels. */
  readonly zoomPercent: number;
  readonly panel: VideoPanel;

  readonly loopIn: number | null;
  readonly loopOut: number | null;
  readonly chapterCount: number;

  /** The selected subtitle track's name, for the menu row. */
  readonly subtitleLabel: string;
  /** Whether there is more than one subtitle option to cycle between. */
  readonly hasSubtitleChoice: boolean;

  /** Whether there is a picture — false for an audio-only file. */
  readonly hasPicture: boolean;
  readonly pictureInPicture: boolean;
  readonly fullscreen: boolean;

  togglePlayback(): void;
  seekBy(milliseconds: number): void;
  seekTo(milliseconds: number): void;
  stepFrame(direction: 1 | -1): void;

  shuttle(direction: 1 | -1): void;
  stopShuttle(): void;
  cycleSpeed(): void;

  cycleLoop(): void;
  clearLoop(): void;

  previousChapter(): void;
  nextChapter(): void;

  setScaleMode(mode: ScaleMode): void;
  zoomIn(): void;
  zoomOut(): void;
  cycleInspector(): void;
  setInspector(panel: VideoPanel): void;
  cycleSubtitles(): void;

  toggleMute(): void;
  setVolume(volume: number): void;
  nudgeVolume(delta: number): void;

  copyFrame(): void;
  exportFrame(): void;
  togglePictureInPicture(): void;
  toggleFullscreen(): void;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

/** The volume stops the toolbar offers. Continuous adjustment is in the tile. */
const VOLUME_STOPS = [0.25, 0.5, 0.75, 1] as const;

const MUTED_VALUE = "muted";

export function videoToolbarControls(actions: VideoActions): readonly ToolbarControl[] {
  const controls: ToolbarControl[] = [
    {
      kind: "button",
      id: "seek.back",
      label: "◀◀",
      title: `back ${NUDGE_MS / 1000} seconds`,
      accelerator: "Left",
      order: 10,
      run: () => actions.seekBy(-NUDGE_MS),
    },
    {
      kind: "toggle",
      id: "play.toggle",
      label: actions.playing ? "pause" : "play",
      title: "play or pause",
      accelerator: "Space",
      order: 11,
      value: actions.playing,
      setValue: () => actions.togglePlayback(),
    },
    {
      kind: "button",
      id: "seek.forward",
      label: "▶▶",
      title: `forward ${NUDGE_MS / 1000} seconds`,
      accelerator: "Right",
      order: 12,
      run: () => actions.seekBy(NUDGE_MS),
    },
    {
      // A readout, not a disabled button: a timecode is a value to read, which
      // is the distinction the contract added this control kind for.
      kind: "readout",
      id: "time.position",
      label: "time",
      title: "position and duration",
      order: 20,
      value: `${formatTimecode(actions.currentMs)} / ${formatTimecode(actions.durationMs)}`,
    },
  ];

  // A file with no audio gets no volume control. A permanently inert slider is
  // worse than an absent one — it invites the user to conclude the audio is
  // broken rather than absent.
  if (actions.hasAudio) {
    controls.push({
      kind: "choice",
      id: "audio.volume",
      label: "volume",
      title: "volume, shared by every video tile",
      accelerator: "m",
      order: 30,
      value: actions.muted ? MUTED_VALUE : nearestStop(actions.volume),
      options: [
        { value: MUTED_VALUE, label: "muted" },
        ...VOLUME_STOPS.map((stop) => ({
          value: String(stop),
          label: `${Math.round(stop * 100)}%`,
        })),
      ],
      setValue: (value) => {
        if (value === MUTED_VALUE) {
          if (!actions.muted) actions.toggleMute();
          return;
        }
        if (actions.muted) actions.toggleMute();
        actions.setVolume(Number(value));
      },
    });
  }

  return controls;
}

/** The offered stop closest to the real volume, so the control never reads blank. */
function nearestStop(volume: number): string {
  let best: number = VOLUME_STOPS[0];
  for (const stop of VOLUME_STOPS) {
    if (Math.abs(stop - volume) < Math.abs(best - volume)) best = stop;
  }
  return String(best);
}

// ---------------------------------------------------------------------------
// Keybinds
// ---------------------------------------------------------------------------

export function videoKeybinds(actions: VideoActions): readonly ViewerKeybind[] {
  const hasChapters = actions.chapterCount > 0;

  return [
    {
      id: "play.toggle",
      label: "play or pause",
      keys: ["Space"],
      order: 10,
      run: () => actions.togglePlayback(),
    },
    {
      id: "shuttle.back",
      label: "play backwards, or stop if already going back",
      keys: ["j"],
      order: 20,
      run: () => actions.shuttle(-1),
    },
    {
      id: "shuttle.stop",
      label: "stop and hold this frame",
      keys: ["k"],
      order: 21,
      run: () => actions.stopShuttle(),
    },
    {
      id: "shuttle.forward",
      label: "play forwards, or stop if already going forward",
      keys: ["l"],
      order: 22,
      run: () => actions.shuttle(1),
    },
    {
      id: "loop.cycle",
      label: "set the loop in point, the out point, then clear",
      keys: ["a"],
      order: 30,
      run: () => actions.cycleLoop(),
    },
    {
      id: "inspect.cycle",
      label: "show info, tracks, chapters, or nothing",
      keys: ["i"],
      order: 40,
      run: () => actions.cycleInspector(),
    },
    {
      id: "subtitles.cycle",
      label: "cycle subtitle tracks",
      keys: ["s"],
      order: 41,
      enabled: () => actions.hasSubtitleChoice,
      run: () => actions.cycleSubtitles(),
    },
    {
      id: "present.fullscreen",
      label: "fullscreen",
      keys: ["f"],
      order: 50,
      run: () => actions.toggleFullscreen(),
    },

    // --- registered, not listed ---------------------------------------------
    // Every one of these is in the context menu below, so none is
    // keyboard-only. They are hidden because eight rows already say what this
    // plugin does and twenty would say it worse.
    {
      id: "seek.back",
      label: `back ${NUDGE_MS / 1000} seconds`,
      keys: ["Left"],
      order: 11,
      hidden: true,
      run: () => actions.seekBy(-NUDGE_MS),
    },
    {
      id: "seek.forward",
      label: `forward ${NUDGE_MS / 1000} seconds`,
      keys: ["Right"],
      order: 12,
      hidden: true,
      run: () => actions.seekBy(NUDGE_MS),
    },
    {
      id: "frame.previous",
      label: "previous frame",
      keys: [","],
      order: 13,
      hidden: true,
      run: () => actions.stepFrame(-1),
    },
    {
      id: "frame.next",
      label: "next frame",
      keys: ["."],
      order: 14,
      hidden: true,
      run: () => actions.stepFrame(1),
    },
    {
      id: "chapter.previous",
      label: "previous chapter",
      keys: ["PageUp"],
      order: 15,
      hidden: true,
      enabled: () => hasChapters,
      run: () => actions.previousChapter(),
    },
    {
      id: "chapter.next",
      label: "next chapter",
      keys: ["PageDown"],
      order: 16,
      hidden: true,
      enabled: () => hasChapters,
      run: () => actions.nextChapter(),
    },
    {
      id: "play.speed",
      label: "cycle playback speed",
      keys: ["x"],
      order: 23,
      hidden: true,
      run: () => actions.cycleSpeed(),
    },
    {
      // The image plugin's keys, deliberately — see the module comment on why
      // these two are the accelerators a plugin may take from the shell's space.
      id: "zoom.in",
      label: "zoom in",
      keys: ["Mod+="],
      order: 24,
      hidden: true,
      enabled: () => actions.hasPicture,
      run: () => actions.zoomIn(),
    },
    {
      id: "zoom.out",
      label: "zoom out",
      keys: ["Mod+-"],
      order: 25,
      hidden: true,
      enabled: () => actions.hasPicture,
      run: () => actions.zoomOut(),
    },
    {
      id: "audio.mute",
      label: "mute or unmute",
      keys: ["m"],
      order: 60,
      hidden: true,
      enabled: () => actions.hasAudio,
      run: () => actions.toggleMute(),
    },
    {
      id: "audio.louder",
      label: "louder",
      keys: ["Up"],
      order: 61,
      hidden: true,
      enabled: () => actions.hasAudio,
      run: () => actions.nudgeVolume(VOLUME_STEP),
    },
    {
      id: "audio.quieter",
      label: "quieter",
      keys: ["Down"],
      order: 62,
      hidden: true,
      enabled: () => actions.hasAudio,
      run: () => actions.nudgeVolume(-VOLUME_STEP),
    },
    {
      // Not `Mod+C`. Copy belongs to the shell's clipboard system, which phase
      // 06 builds on top of the `getCopyable` this instance already implements;
      // claiming the conventional chord now would put it in the wrong layer and
      // have to be taken back. `c` and `e` mean the same two things in the image
      // plugin.
      id: "frame.copy",
      label: "copy this frame to the clipboard",
      keys: ["c"],
      order: 70,
      hidden: true,
      enabled: () => actions.hasPicture,
      run: () => actions.copyFrame(),
    },
    {
      id: "frame.export",
      label: "save this frame as an image",
      keys: ["e"],
      order: 71,
      hidden: true,
      enabled: () => actions.hasPicture,
      run: () => actions.exportFrame(),
    },
    {
      id: "present.pip",
      label: "picture-in-picture",
      keys: ["p"],
      order: 72,
      hidden: true,
      enabled: () => actions.hasPicture,
      run: () => actions.togglePictureInPicture(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export interface VideoMenuItem {
  readonly label: string;
  /** A separator when true; `label` and `run` are then ignored. */
  readonly separator?: boolean;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  run?(): void;
}

/**
 * The tile's own right-click menu.
 *
 * Labels carry no accelerators, and that is deliberate rather than an omission.
 * AGENTS.md requires that bindings "are rendered only through
 * `formatAccelerator`; nothing else may branch on the platform", and a plugin
 * may not import a shell module to reach it. The reference modal — which does go
 * through it — is where shortcuts are read; this menu is where actions are
 * *found*, which is the job the brief gives it.
 */
export function videoMenuItems(actions: VideoActions): readonly VideoMenuItem[] {
  const hasChapters = actions.chapterCount > 0;

  const items: VideoMenuItem[] = [
    { label: actions.playing ? "pause" : "play", run: () => actions.togglePlayback() },
    { label: "previous frame", run: () => actions.stepFrame(-1) },
    { label: "next frame", run: () => actions.stepFrame(1) },
    { label: `playback speed: ${actions.speed}×`, run: () => actions.cycleSpeed() },
    { label: "", separator: true },
    {
      label: "previous chapter",
      disabled: !hasChapters,
      run: () => actions.previousChapter(),
    },
    { label: "next chapter", disabled: !hasChapters, run: () => actions.nextChapter() },
    { label: "", separator: true },
    // The loop's one key becomes two rows here, because a menu has room to say
    // what the next press will do and a keybind list does not.
    { label: loopLabel(actions), run: () => actions.cycleLoop() },
    {
      label: "clear the loop",
      disabled: actions.loopIn === null,
      run: () => actions.clearLoop(),
    },
    { label: "", separator: true },
  ];

  for (const mode of SCALE_MODES) {
    items.push({
      label: SCALE_MODE_LABELS[mode] === "100%" ? "actual size" : SCALE_MODE_LABELS[mode],
      // Nothing is ticked while the zoom is `custom`, which is the honest answer:
      // the picture is at a size none of these three rows describes, and the
      // zoom row below says what it is.
      checked: actions.scaleMode === mode,
      run: () => actions.setScaleMode(mode),
    });
  }

  items.push(
    {
      // The readout is in the label because there is nowhere else for it: the
      // shared toolbar is capped at the five controls the brief names, and the
      // tile's own bar gave up everything but the timeline. The badge over the
      // picture carries it while the menu is closed.
      label: `zoom in (${formatZoom(actions.zoomPercent)})`,
      disabled: !actions.hasPicture,
      run: () => actions.zoomIn(),
    },
    {
      label: "zoom out",
      disabled: !actions.hasPicture,
      run: () => actions.zoomOut(),
    },
  );

  items.push({ label: "", separator: true });

  for (const panel of ["info", "tracks", "chapters"] as const) {
    items.push({
      label:
        panel === "info"
          ? "file information"
          : panel === "tracks"
            ? "audio and subtitle tracks"
            : "chapter list",
      checked: actions.panel === panel,
      // Clicking the open panel closes it, so the row is a toggle rather than a
      // one-way switch that has to be turned off from the keyboard.
      run: () => actions.setInspector(actions.panel === panel ? "none" : panel),
    });
  }

  items.push(
    {
      label: `subtitles: ${actions.subtitleLabel}`,
      disabled: !actions.hasSubtitleChoice,
      run: () => actions.cycleSubtitles(),
    },
    { label: "", separator: true },
    {
      label: "copy this frame",
      disabled: !actions.hasPicture,
      run: () => actions.copyFrame(),
    },
    {
      label: "save this frame as…",
      disabled: !actions.hasPicture,
      run: () => actions.exportFrame(),
    },
    { label: "", separator: true },
    {
      label: "picture-in-picture",
      checked: actions.pictureInPicture,
      disabled: !actions.hasPicture,
      run: () => actions.togglePictureInPicture(),
    },
    { label: "fullscreen", checked: actions.fullscreen, run: () => actions.toggleFullscreen() },
    {
      label: "mute",
      checked: actions.muted,
      disabled: !actions.hasAudio,
      run: () => actions.toggleMute(),
    },
  );

  return items;
}

/** `100%`, `12.5%` — the image plugin's formatting, for the same numbers. */
function formatZoom(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/** What pressing the loop key next will do, said in the menu. */
function loopLabel(actions: VideoActions): string {
  if (actions.loopIn === null) return "set the loop in point";
  if (actions.loopOut === null) {
    return `set the loop out point (in at ${formatTimecode(actions.loopIn)})`;
  }
  return `clear the loop (${formatTimecode(actions.loopIn)}–${formatTimecode(actions.loopOut)})`;
}
