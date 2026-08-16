/**
 * What an image tile can be asked to do, and how those actions reach the user.
 *
 * The same shape as `viewers/pdf/actions.ts` and `shell/docking/actions.ts`, for
 * the same reason: one verb list, three surfaces derived from it, so an action
 * cannot end up with a shortcut and no visible path or a button and no shortcut.
 * {@link ImageActions} is what the instance implements; the three functions
 * below are the toolbar, the keybinds, and the tile's own context menu.
 *
 * ## The toolbar is five controls, and the brief is why
 *
 * *"Contribute a minimal, essential-only control set when an image tile is
 * focused (zoom, fit mode, rotate) … Everything else … is keybind-accessible
 * and/or reachable via a right-click context menu."* So the toolbar is zoom
 * out, the zoom readout, zoom in, the fit mode, and rotate. The transport
 * controls appear *only for an animated image*, where they are not an extra —
 * they are the difference between a GIF you can watch and a GIF you can control
 * — and vanish again for the still image in the next tile.
 *
 * ## Eight listed shortcuts, and what is deliberately not among them
 *
 * AGENTS.md puts the right order of magnitude at six and records that the PDF
 * plugin was cut from sixteen to that. This lists eight, and the consolidations
 * that got it there are worth more than the count:
 *
 *   - **One inspector key, not four.** Metadata, histogram, adjustments and the
 *     pixel readout are four ways of saying "tell me more about this image", and
 *     four toggles would be the "cycle layout / master count / master width"
 *     mistake AGENTS.md describes folding into a single rotation. `i` visits
 *     each and returns to none, and the panel says which one it is on.
 *   - **One fit key, not three.** Fit-to-window, actual size and fill are three
 *     answers to "how big should this be"; `f` cycles them, exactly as the
 *     PDF plugin cut three fit keys down to one.
 *   - **Rotate one way.** Four presses is a full turn. A second binding to save
 *     two presses is a chip in the reference modal for a job already covered,
 *     which is the alias rule. Counter-clockwise stays registered and hidden.
 *
 * Flip, frame-stepping, play/pause, copy, export and the location toggle are
 * registered and hidden. Every one of them is in the context menu, which is the
 * discovery path the brief names — so nothing is keyboard-only and the modal
 * stays a reminder rather than a manual.
 *
 * ## The keys, and what they avoid
 *
 * The shell owns every `Mod`+letter, `Mod`+digit and `Mod`+arrow (AGENTS.md:
 * "`Mod`+digit is spoken for"). So these live in the two spaces left over: the
 * document keys a reader already reaches for, and bare letters — safe because
 * the registry refuses to fire an unmodified binding while a text field has
 * focus. `Mod+=` and `Mod+-` are the deliberate exceptions, the same two the
 * PDF plugin claims, and they mean the same thing in both.
 *
 * `PageUp`/`PageDown` are next/previous *image* here and next/previous *page*
 * in a PDF, which is not a collision: contributed bindings are registered only
 * while their tile is focused, and that scoping is what the contract's keybind
 * extension point exists to provide.
 */

import type { ToolbarControl, ViewerKeybind } from "../contract";
import { FIT_MODE_LABELS, FIT_MODES } from "./settings";
import type { InspectorPanel, ZoomMode } from "./state";

/** The verbs. Implemented by the instance, consumed by the three surfaces below. */
export interface ImageActions {
  readonly zoomPercent: number;
  readonly zoomMode: ZoomMode;
  readonly rotation: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  readonly panel: InspectorPanel;
  /** Whether the metadata panel is currently revealing GPS and the like. */
  readonly sensitiveShown: boolean;

  /** Animation, when there is one. `frameCount <= 1` means a still image. */
  readonly frameCount: number;
  readonly frameIndex: number;
  readonly playing: boolean;
  readonly speed: number;

  /** Folder browsing, when the file has a directory to browse. */
  readonly folderPosition: number;
  readonly folderCount: number;
  readonly atFolderStart: boolean;
  readonly atFolderEnd: boolean;
  readonly slideshowRunning: boolean;

  zoomIn(): void;
  zoomOut(): void;
  setZoomMode(mode: ZoomMode): void;
  cycleFitMode(): void;

  rotateClockwise(): void;
  rotateCounterClockwise(): void;
  flipHorizontally(): void;
  flipVertically(): void;

  cycleInspector(): void;
  setInspector(panel: InspectorPanel): void;
  toggleSensitiveMetadata(): void;

  nextImage(): void;
  previousImage(): void;
  toggleSlideshow(): void;

  togglePlayback(): void;
  stepFrame(direction: 1 | -1): void;
  cycleSpeed(): void;

  copyImage(): void;
  exportImage(): void;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export function imageToolbarControls(actions: ImageActions): readonly ToolbarControl[] {
  const controls: ToolbarControl[] = [
    {
      kind: "button",
      id: "zoom.out",
      label: "−",
      title: "zoom out",
      accelerator: "Mod+-",
      order: 10,
      run: () => actions.zoomOut(),
    },
    {
      // A readout, not a disabled button: a zoom level is a value to read, which
      // is the distinction the contract added this control kind for.
      kind: "readout",
      id: "zoom.level",
      label: "zoom",
      title: "zoom level",
      order: 11,
      value: formatZoom(actions.zoomPercent),
    },
    {
      kind: "button",
      id: "zoom.in",
      label: "+",
      title: "zoom in",
      accelerator: "Mod+=",
      order: 12,
      run: () => actions.zoomIn(),
    },
    {
      kind: "choice",
      id: "fit.mode",
      label: "fit",
      title: "how the image is sized",
      accelerator: "f",
      order: 20,
      // `custom` is a state the fit modes leave behind rather than one to pick,
      // so it is shown when active and never offered.
      value: actions.zoomMode,
      options: [
        ...FIT_MODES.map((mode) => ({ value: mode, label: FIT_MODE_LABELS[mode] })),
        ...(actions.zoomMode === "custom"
          ? [{ value: "custom", label: "custom" }]
          : []),
      ],
      setValue: (value) => actions.setZoomMode(value as ZoomMode),
    },
    {
      kind: "button",
      id: "rotate.cw",
      label: "⟳",
      title: "rotate 90° clockwise",
      accelerator: "r",
      order: 30,
      run: () => actions.rotateClockwise(),
    },
  ];

  if (actions.frameCount > 1) {
    controls.push(
      {
        kind: "toggle",
        id: "play.toggle",
        label: actions.playing ? "pause" : "play",
        title: "play or pause the animation",
        accelerator: "Space",
        order: 40,
        value: actions.playing,
        setValue: () => actions.togglePlayback(),
      },
      {
        kind: "readout",
        id: "frame.position",
        label: "frame",
        title: "current frame",
        order: 41,
        value: `${actions.frameIndex + 1} / ${actions.frameCount}`,
      },
    );
  }

  return controls;
}

/** `100%`, `12.5%`, `800%` — trailing zeros dropped, because most are integers. */
function formatZoom(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Keybinds
// ---------------------------------------------------------------------------

export function imageKeybinds(actions: ImageActions): readonly ViewerKeybind[] {
  const hasFolder = actions.folderCount > 1;
  const animated = actions.frameCount > 1;

  return [
    {
      id: "folder.next",
      label: "next image in this folder",
      keys: ["PageDown"],
      order: 10,
      enabled: () => hasFolder && !actions.atFolderEnd,
      run: () => actions.nextImage(),
    },
    {
      id: "folder.previous",
      label: "previous image in this folder",
      keys: ["PageUp"],
      order: 11,
      enabled: () => hasFolder && !actions.atFolderStart,
      run: () => actions.previousImage(),
    },
    {
      id: "zoom.in",
      label: "zoom in",
      keys: ["Mod+="],
      order: 20,
      run: () => actions.zoomIn(),
    },
    {
      id: "zoom.out",
      label: "zoom out",
      keys: ["Mod+-"],
      order: 21,
      run: () => actions.zoomOut(),
    },
    {
      id: "fit.cycle",
      label: "fit to window, actual size, fill",
      keys: ["f"],
      order: 22,
      run: () => actions.cycleFitMode(),
    },
    {
      id: "rotate.cw",
      label: "rotate 90°",
      keys: ["r"],
      order: 30,
      run: () => actions.rotateClockwise(),
    },
    {
      id: "inspect.cycle",
      label: "show info, levels, light, or nothing",
      keys: ["i"],
      order: 40,
      run: () => actions.cycleInspector(),
    },
    {
      id: "slideshow.toggle",
      label: "start or stop the slideshow",
      keys: ["s"],
      order: 50,
      enabled: () => hasFolder,
      run: () => actions.toggleSlideshow(),
    },

    // --- registered, not listed ---------------------------------------------
    // Every one of these is in the context menu below, so none is
    // keyboard-only. They are hidden because eight rows already say what this
    // plugin does and sixteen would say it twice.
    {
      id: "rotate.ccw",
      label: "rotate 90° anticlockwise",
      keys: ["Shift+R"],
      order: 31,
      hidden: true,
      run: () => actions.rotateCounterClockwise(),
    },
    {
      id: "flip.horizontal",
      label: "flip horizontally",
      keys: ["x"],
      order: 32,
      hidden: true,
      run: () => actions.flipHorizontally(),
    },
    {
      id: "flip.vertical",
      label: "flip vertically",
      keys: ["y"],
      order: 33,
      hidden: true,
      run: () => actions.flipVertically(),
    },
    {
      id: "play.toggle",
      label: "play or pause the animation",
      keys: ["Space"],
      order: 60,
      hidden: true,
      enabled: () => animated,
      run: () => actions.togglePlayback(),
    },
    {
      id: "frame.next",
      label: "next frame",
      keys: ["."],
      order: 61,
      hidden: true,
      enabled: () => animated,
      run: () => actions.stepFrame(1),
    },
    {
      id: "frame.previous",
      label: "previous frame",
      keys: [","],
      order: 62,
      hidden: true,
      enabled: () => animated,
      run: () => actions.stepFrame(-1),
    },
    {
      id: "play.speed",
      label: "cycle playback speed",
      keys: ["k"],
      order: 63,
      hidden: true,
      enabled: () => animated,
      run: () => actions.cycleSpeed(),
    },
    {
      // Not `Mod+C`. Copy belongs to the shell's clipboard system, which phase
      // 06 builds on top of the `getCopyable` this instance already implements;
      // claiming the conventional chord now would put it in the wrong layer and
      // have to be taken back.
      id: "copy.image",
      label: "copy the image to the clipboard",
      keys: ["c"],
      order: 70,
      hidden: true,
      run: () => actions.copyImage(),
    },
    {
      id: "export.image",
      label: "export or convert this image",
      keys: ["e"],
      order: 71,
      hidden: true,
      run: () => actions.exportImage(),
    },
    {
      id: "metadata.sensitive",
      label: "show or hide location data",
      keys: ["g"],
      order: 72,
      hidden: true,
      run: () => actions.toggleSensitiveMetadata(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export interface ImageMenuItem {
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
 * may not import a shell module to reach it. The reference modal — which does
 * go through it — is where shortcuts are read; this menu is where actions are
 * *found*, which is the job the brief gives it.
 */
export function imageMenuItems(actions: ImageActions): readonly ImageMenuItem[] {
  const animated = actions.frameCount > 1;
  const hasFolder = actions.folderCount > 1;

  const items: ImageMenuItem[] = [
    { label: "zoom in", run: () => actions.zoomIn() },
    { label: "zoom out", run: () => actions.zoomOut() },
    ...FIT_MODES.map((mode) => ({
      label: mode === "fit-window" ? "fit to window" : mode === "actual" ? "actual size" : "fill",
      checked: actions.zoomMode === mode,
      run: () => actions.setZoomMode(mode),
    })),
    { label: "", separator: true },
    { label: "rotate 90° clockwise", run: () => actions.rotateClockwise() },
    { label: "rotate 90° anticlockwise", run: () => actions.rotateCounterClockwise() },
    { label: "flip horizontally", checked: actions.flipX, run: () => actions.flipHorizontally() },
    { label: "flip vertically", checked: actions.flipY, run: () => actions.flipVertically() },
    { label: "", separator: true },
  ];

  for (const panel of ["metadata", "histogram", "adjust"] as const) {
    items.push({
      label:
        panel === "metadata"
          ? "image information"
          : panel === "histogram"
            ? "histogram"
            : "light adjustments",
      checked: actions.panel === panel,
      run: () => actions.setInspector(actions.panel === panel ? "none" : panel),
    });
  }
  items.push({
    label: "show location data",
    checked: actions.sensitiveShown,
    run: () => actions.toggleSensitiveMetadata(),
  });

  if (animated) {
    items.push(
      { label: "", separator: true },
      { label: actions.playing ? "pause" : "play", run: () => actions.togglePlayback() },
      { label: "next frame", run: () => actions.stepFrame(1) },
      { label: "previous frame", run: () => actions.stepFrame(-1) },
      { label: `playback speed (${actions.speed}×)`, run: () => actions.cycleSpeed() },
    );
  }

  if (hasFolder) {
    items.push(
      { label: "", separator: true },
      {
        label: "next image",
        disabled: actions.atFolderEnd,
        run: () => actions.nextImage(),
      },
      {
        label: "previous image",
        disabled: actions.atFolderStart,
        run: () => actions.previousImage(),
      },
      {
        label: actions.slideshowRunning ? "stop the slideshow" : "start a slideshow",
        run: () => actions.toggleSlideshow(),
      },
    );
  }

  items.push(
    { label: "", separator: true },
    { label: "copy image", run: () => actions.copyImage() },
    { label: "export as…", run: () => actions.exportImage() },
  );

  return items;
}
