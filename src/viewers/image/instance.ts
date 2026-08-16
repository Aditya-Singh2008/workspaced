/**
 * The mounted image viewer: the class the contract's `ViewerInstance` names.
 *
 * It owns the decoded image and the tile's state, and delegates the rest — the
 * surface to `engine/view.ts`, the side panel to `engine/panels.ts`, playback to
 * `engine/animation.ts`, sibling files to `folder.ts`. What lives *here* is the
 * parts the contract asks for: capabilities, the toolbar and keybind
 * contributions, copy, thumbnails, state round-tripping, and a `dispose()` that
 * provably gives every bitmap back.
 *
 * ## Frames are subdivisions
 *
 * The contract calls anything a file can be divided into a *subdivision*, and is
 * explicit that the shell must be able to page through them and draw thumbnails
 * without knowing what they are. An animation's frames are exactly that, so an
 * animated GIF reports `subdivisionCount` and gets the sidebar's preview rail as
 * a filmstrip — with `reveal({ subdivision })` seeking to a frame — without one
 * line of shell code knowing what a frame is. AGENTS.md anticipates this in
 * reverse: "a video plugin exposing keyframes gets the same rail without
 * touching it."
 *
 * A still image reports no `subdivisionCount` at all, which is the contract's
 * "omitted for single-view content", and the rail stays away.
 *
 * ## Search is absent, not empty
 *
 * `capabilities.search` is `false` and there is no `search` property, which is
 * the contract's rule that absence is never an error. Verification item 2 checks
 * the shell treats this plugin as non-searchable with no error — and the reason
 * that works is that the shell reads the capability and *hides* the UI, rather
 * than this plugin implementing a `find` that always returns nothing.
 *
 * ## Inversion appears nowhere
 *
 * By instruction, and it is worth stating in the file rather than only in the
 * brief: inversion is a PDF accessibility mechanism tied to a page composite
 * pipeline, there is no invert control in the toolbar, the keybinds, the context
 * menu or the settings, and the self-test asserts it. An image viewer that
 * inverted an image would be editing it.
 */

import type { NormalizedRect } from "../../annotation";
import type { FileHandle } from "../../files";
import {
  BaseViewerInstance,
  type CopyableContent,
  type CopyScope,
  type ThumbnailRequest,
  type ThumbnailResult,
  type ToolbarControl,
  type Unsubscribe,
  type ViewerCapabilities,
  type ViewerCopyApi,
  type ViewerHost,
  type ViewerInstance,
  type ViewerKeybind,
  type ViewerKeybindApi,
  type ViewerLocation,
  type ViewerToolbarApi,
} from "../contract";
import { imageKeybinds, imageMenuItems, imageToolbarControls, type ImageActions } from "./actions";
import { clampAdjustments, DEFAULT_ADJUSTMENTS, type Adjustments } from "./engine/adjust";
import { AnimationTransport, type PlaybackSpeed } from "./engine/animation";
import {
  copyImageToClipboard,
  DEFAULT_EXPORT_QUALITY,
  encodeCanvas,
  needsFlattening,
  renderForExport,
  stripExtension,
  writableFormats,
} from "./engine/export";
import { Loupe } from "./engine/loupe";
import { closeImageMenu, openImageMenu } from "./engine/menu";
import { Inspector } from "./engine/panels";
import { computeHistogram, samplePixel, type SampledPixel } from "./engine/pixels";
import { ImageView } from "./engine/view";
import { FolderSession } from "./folder";
import type { ImageFormat } from "./formats";
import { IMAGE_PLUGIN_ID } from "./id";
import type { LoadedImage } from "./mount";
import { imageSettings, subscribeToImageSettings } from "./settings";
import {
  DEFAULT_IMAGE_STATE,
  INSPECTOR_PANELS,
  parseImageState,
  type ImageViewerState,
  type InspectorPanel,
  type Rotation,
  type ZoomMode,
} from "./state";

export interface ImageInstanceInit {
  readonly container: HTMLElement;
  readonly loaded: LoadedImage;
  readonly initialState: unknown;
  readonly host?: ViewerHost;
}

export class ImageViewerInstance extends BaseViewerInstance implements ViewerInstance {
  readonly pluginId = IMAGE_PLUGIN_ID;
  readonly capabilities: ViewerCapabilities;

  readonly toolbar: ViewerToolbarApi;
  readonly keybinds: ViewerKeybindApi;
  readonly copy: ViewerCopyApi;

  #loaded: LoadedImage;
  /** The handle originally opened, kept so folder browsing can find its way back. */
  #openedFile: FileHandle;
  #view: ImageView;
  #inspector: Inspector;
  #loupe: Loupe;
  #transport: AnimationTransport | null = null;
  #folder: FolderSession | null = null;
  #host: ViewerHost | undefined;

  #panel: InspectorPanel = "none";
  #adjustments: Adjustments = DEFAULT_ADJUSTMENTS;
  #sample: SampledPixel | null = null;

  #slideshowTimer: ReturnType<typeof setTimeout> | null = null;
  #histogramTimer: ReturnType<typeof setTimeout> | null = null;
  #thumbnailCache = new Map<string, ThumbnailResult>();

  #toolbarListeners = new Set<() => void>();
  #keybindListeners = new Set<() => void>();
  #unsubscribeSettings: Unsubscribe;
  #abort = new AbortController();
  #navigation = 0;
  #disposing = false;

  constructor(init: ImageInstanceInit) {
    super();
    this.#loaded = init.loaded;
    this.#openedFile = init.loaded.file;
    this.#host = init.host;

    const initial = parseImageState(init.initialState);
    this.#adjustments = initial.adjustments;
    this.#panel = initial.panel;

    this.capabilities = {
      // No text, therefore no search — and no `search` property at all. See the
      // class comment.
      search: false,
      copy: true,
      // Phase 05's job. Declared false rather than half-implemented, because the
      // contract's rule is "optional capability, not disabled capability".
      annotation: false,
      toolbar: true,
      keybinds: true,
      thumbnail: true,
      subdivisionCount: this.#frameCount() > 1 ? this.#frameCount() : undefined,
    };

    this.#view = new ImageView({
      container: init.container,
      callbacks: {
        onViewChange: () => {
          this.#notifyToolbar();
          this.#scheduleHistogram();
        },
        onPersist: () => this.#host?.requestPersist(),
        onPointerMove: (point, client) => this.#onPointerMove(point, client),
      },
    });

    // Into the view's root rather than the scroller: the scroller clips its
    // overflow, and a loupe near the edge of the image is exactly where it
    // would be cut in half.
    this.#loupe = new Loupe(this.#view.root);

    this.#inspector = new Inspector(this.#view.panelHost, {
      onAdjustmentsChange: (adjustments) => this.#setAdjustments(adjustments),
      onSensitiveToggle: () => this.#notifyToolbar(),
    });

    this.#view.scroller.addEventListener(
      "contextmenu",
      (event) => {
        event.preventDefault();
        openImageMenu(event, imageMenuItems(this.#actions()));
      },
      { signal: this.#abort.signal },
    );

    // A settings change is an application-wide preference, so every open tile
    // re-lays out rather than only the one it was changed in.
    this.#unsubscribeSettings = subscribeToImageSettings(() => {
      this.#view.layout();
      this.#notifyToolbar();
    });

    this.toolbar = {
      getControls: () => this.#toolbarControls(),
      onControlsChange: (listener) => subscribe(this.#toolbarListeners, listener),
    };

    this.keybinds = {
      groupTitle: "Image",
      getKeybinds: () => this.#keybindDefinitions(),
      // The declaration genuinely changes: navigation and playback bindings are
      // enabled by whether this tile has siblings and whether the image is
      // animated, and both differ after a folder step.
      onKeybindsChange: (listener) => subscribe(this.#keybindListeners, listener),
    };

    this.copy = {
      getCopyable: (scope) => this.#getCopyable(scope),
      locateRegion: (tileRect) => this.#locateRegion(tileRect),
    };

    this.#applyLoaded(init.loaded, initial);
    this.setStatus("ready");

    // Both are deferred rather than awaited: an image must be on screen before
    // the directory has been listed, and a tile that waits for a slow network
    // mount to enumerate a folder would appear to hang on a file it has already
    // decoded.
    void this.#openFolder(initial.folderFile);
  }

  get file(): FileHandle {
    // The file being *displayed*, which folder browsing can move off the one the
    // tile was opened with. The shell keys the client on its own handle and
    // takes the label from `setDisplayName`, so this is free to be the truth.
    return this.#loaded.file;
  }

  // -------------------------------------------------------------------------
  // Loading and navigation
  // -------------------------------------------------------------------------

  #frameCount(): number {
    const source = this.#loaded.image.source;
    return source.kind === "raster" ? source.frames.length : 1;
  }

  /** Installs a decoded image into the view, transport and panels. */
  #applyLoaded(loaded: LoadedImage, state: ImageViewerState): void {
    this.#loaded = loaded;
    this.#thumbnailCache.clear();

    this.#view.setImage(loaded.image);
    this.#view.setOrientation({
      rotation: state.rotation,
      flipX: state.flipX,
      flipY: state.flipY,
    });
    this.#view.setAdjustments(this.#adjustments);
    this.#view.setZoomMode(state.zoomMode, state.zoom);
    this.#view.setCenterFraction({ x: state.centerX, y: state.centerY });

    // Every caveat the decode produced, in one line under the image. A RAW
    // preview, a truncated GIF, an animation this platform cannot separate —
    // the brief requires each of these be stated rather than silently coped
    // with, and the metadata panel carries the full list.
    this.#view.setNotice(loaded.image.notes[0] ?? null);

    this.#transport?.destroy();
    this.#transport = null;
    const source = loaded.image.source;
    if (source.kind === "raster" && source.frames.length > 1) {
      this.#transport = new AnimationTransport({
        frameCount: source.frames.length,
        delayAt: (index) => source.frames[index]?.delayMs ?? 100,
        loopCount: source.loopCount,
        onFrame: (index) => {
          this.#view.drawFrame(index);
          this.#scheduleHistogram();
        },
        onChange: () => this.#notifyToolbar(),
      });
      if (imageSettings().autoplayAnimations) this.#transport.play();
    }

    this.#inspector.setMetadata(loaded.metadata);
    this.#inspector.setAdjustments(this.#adjustments);
    this.#inspector.setPanel(this.#panel);
    this.#scheduleHistogram();
    this.#notifyToolbar();
    this.#notifyKeybinds();
  }

  async #openFolder(restoreName?: string): Promise<void> {
    const folder = await FolderSession.open(this.#openedFile);
    if (this.#disposing || !folder) return;
    this.#folder = folder;

    // A remembered position is restored only if that file is still there. The
    // listing was re-read just now, so "still there" is a real check rather than
    // an assumption about a directory nobody has touched.
    if (restoreName && restoreName !== this.#openedFile.name) {
      const handle = folder.goToName(restoreName);
      if (handle) {
        await this.#showFile(handle);
        return;
      }
    }

    this.#notifyToolbar();
    this.#notifyKeybinds();
  }

  /**
   * Replaces what this tile is showing with another file.
   *
   * Guarded by a navigation counter rather than an abort signal: holding down
   * the next key starts several loads, and the answer is not to cancel them —
   * a decode is not cheap to abandon halfway — but to ignore every result except
   * the newest. Without it, a slow decode landing after a fast one would show
   * the wrong image and leave the toolbar describing a third.
   */
  async #showFile(handle: FileHandle): Promise<void> {
    const generation = ++this.#navigation;
    const { loadImage } = await import("./mount");

    try {
      const loaded = await loadImage(handle, this.#abort.signal);
      if (this.#disposing || generation !== this.#navigation) {
        loaded.image.dispose();
        handle.release();
        return;
      }

      const previous = this.#loaded;
      // The view transform carries across deliberately: someone stepping through
      // a folder of scans they have rotated upright wants the next one upright
      // too. The zoom does not — a fit mode is meaningful across images and a
      // pixel zoom is not, so a custom zoom falls back to the default fit.
      this.#applyLoaded(loaded, {
        ...DEFAULT_IMAGE_STATE,
        zoomMode:
          this.#view.zoomMode === "custom"
            ? imageSettings().defaultFitMode
            : this.#view.zoomMode,
        rotation: this.#view.rotation,
        flipX: this.#view.flipX,
        flipY: this.#view.flipY,
        adjustments: this.#adjustments,
        panel: this.#panel,
      });

      if (previous.file !== this.#openedFile) previous.file.release();
      previous.image.dispose();

      // The tab, the sidebar and the status bar all follow this. Without it they
      // would keep naming the file the tile was opened with, which after three
      // steps through a directory is simply false.
      this.#host?.setDisplayName(
        handle.id === this.#openedFile.id ? null : handle.name,
      );
      this.#host?.invalidate(["thumbnail", "capabilities", "state"]);
      this.#host?.requestPersist();
    } catch (thrown) {
      if (this.#disposing || generation !== this.#navigation) return;
      handle.release();
      // A single unreadable file in a directory must not take down a tile that
      // is working. Say which one and stay where we are.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      this.#view.announce(message, "warn");
      this.#stopSlideshow();
    }
  }

  #navigate(direction: 1 | -1, options?: { wrap?: boolean }): void {
    const folder = this.#folder;
    if (!folder) return;
    const handle = folder.advance(direction, options);
    if (!handle) {
      this.#view.announce(
        direction > 0 ? "this is the last image in the folder" : "this is the first image",
      );
      return;
    }
    void this.#showFile(handle);
  }

  // -------------------------------------------------------------------------
  // Slideshow
  // -------------------------------------------------------------------------

  #startSlideshow(): void {
    if (!this.#folder || this.#folder.count < 2) {
      this.#view.announce("there are no other images in this folder", "warn");
      return;
    }
    this.#stopSlideshow();
    const seconds = imageSettings().slideshowIntervalSeconds;
    this.#view.announce(`slideshow started — ${seconds}s per image`);
    this.#scheduleSlide();
    this.#notifyToolbar();
  }

  #scheduleSlide(): void {
    this.#slideshowTimer = setTimeout(
      () => {
        this.#slideshowTimer = null;
        if (this.#disposing) return;
        // Wrapping, unlike a manual step. Reaching the end of a slideshow and
        // stopping without saying so would look like a failure; going round is
        // what a slideshow is. See `folder.ts`.
        this.#navigate(1, { wrap: true });
        this.#scheduleSlide();
      },
      imageSettings().slideshowIntervalSeconds * 1000,
    );
  }

  #stopSlideshow(): void {
    if (!this.#slideshowTimer) return;
    clearTimeout(this.#slideshowTimer);
    this.#slideshowTimer = null;
    this.#notifyToolbar();
  }

  // -------------------------------------------------------------------------
  // Inspector
  // -------------------------------------------------------------------------

  #setPanel(panel: InspectorPanel): void {
    this.#panel = panel;
    this.#inspector.setPanel(panel);
    // Leaving the light panel takes the loupe with it; it has nothing to aim at
    // once the readout it belongs to is gone.
    if (!this.#inspector.samplingActive) this.#loupe.hide();
    // The panel takes width from the image, so the fit has to be recomputed —
    // otherwise opening the histogram leaves a fitted image overflowing.
    this.#view.layout();
    if (panel === "histogram") this.#scheduleHistogram();
    this.#notifyToolbar();
    this.#host?.requestPersist();
  }

  /**
   * Samples the pixel under the pointer and aims the loupe at it.
   *
   * Only while the light panel is open. The picker and the loupe are one
   * feature and they belong to that panel (see `engine/panels.ts`), so with any
   * other panel showing this does nothing at all — which also means no
   * `getImageData` call per pointer move for a panel that would not display the
   * result.
   */
  #onPointerMove(
    point: { x: number; y: number } | null,
    client: { clientX: number; clientY: number } | null,
  ): void {
    if (!this.#inspector.samplingActive) {
      this.#loupe.hide();
      return;
    }

    if (!point || !client) {
      this.#sample = null;
      this.#inspector.setSample(null);
      this.#loupe.hide();
      return;
    }

    const canvas = this.#view.pixelCanvas();
    if (!canvas) return;

    this.#sample = samplePixel(canvas, point, this.#adjustments);
    this.#inspector.setSample(this.#sample);
    this.#loupe.show({
      source: canvas,
      point,
      client,
      transform: {
        rotation: this.#view.rotation,
        flipX: this.#view.flipX,
        flipY: this.#view.flipY,
      },
    });
  }

  /**
   * Recomputes the histogram, coalesced.
   *
   * Every adjustment slider movement, every frame of an animation and every
   * fit change would otherwise each trigger a full `getImageData` pass. One pass
   * shortly after things stop moving says the same thing.
   */
  #scheduleHistogram(): void {
    if (this.#panel !== "histogram") return;
    if (this.#histogramTimer) clearTimeout(this.#histogramTimer);
    this.#histogramTimer = setTimeout(() => {
      this.#histogramTimer = null;
      if (this.#disposing) return;
      const canvas = this.#view.pixelCanvas();
      this.#inspector.setHistogram(canvas ? computeHistogram(canvas, this.#adjustments) : null);
    }, 80);
  }

  #setAdjustments(adjustments: Adjustments): void {
    this.#adjustments = clampAdjustments(adjustments);
    this.#view.setAdjustments(this.#adjustments);
    this.#inspector.setAdjustments(this.#adjustments);
    if (this.#sample) {
      const canvas = this.#view.pixelCanvas();
      if (canvas) {
        this.#sample = samplePixel(canvas, this.#sample, this.#adjustments);
        this.#inspector.setSample(this.#sample);
      }
    }
    this.#scheduleHistogram();
  }

  // -------------------------------------------------------------------------
  // Copy and export
  // -------------------------------------------------------------------------

  /** The current view, rendered at natural resolution with the transform baked in. */
  #renderCurrent(options?: {
    region?: NormalizedRect;
    background?: string;
  }): HTMLCanvasElement | null {
    const source = this.#view.pixelCanvas();
    if (!source) return null;

    const region = options?.region
      ? {
          x: Math.round(options.region.x * source.width),
          y: Math.round(options.region.y * source.height),
          width: Math.round(options.region.width * source.width),
          height: Math.round(options.region.height * source.height),
        }
      : undefined;

    return renderForExport(source, {
      rotation: this.#view.rotation,
      flipX: this.#view.flipX,
      flipY: this.#view.flipY,
      adjustments: this.#adjustments,
      region,
      background: options?.background,
    });
  }

  async #getCopyable(scope: CopyScope): Promise<readonly CopyableContent[]> {
    // A selection inside an image is a region, and this plugin has no
    // rubber-band tool of its own yet — phase 05's overlay model is where that
    // belongs. Returning nothing is the contract's stated non-error.
    if (scope.kind === "selection") return [];

    const canvas = this.#renderCurrent(
      scope.kind === "region" ? { region: scope.rect } : undefined,
    );
    if (!canvas) return [];

    try {
      const encoded = await encodeCanvas(canvas, "image/png");
      if (!encoded) return [];
      return [
        {
          kind: "image",
          blob: encoded.blob,
          mimeType: encoded.mimeType,
          width: encoded.width,
          height: encoded.height,
        },
      ];
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /**
   * Phase 06's region copy: a box the shell drew over this tile, as a rect of
   * the image.
   *
   * The shell owns the tile's box and normalizes against it; everything from
   * there — where the picture sits inside the scroller, how far it is zoomed,
   * which way up it is — is this plugin's, and `imageRegionAt` is where that
   * knowledge already lives (it is the pixel inspector's inverse transform).
   * The subdivision is always 0: an image is one view of one thing.
   */
  #locateRegion(tileRect: NormalizedRect): ViewerLocation | null {
    const box = this.#view.root.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;

    const rect = this.#view.imageRegionAt({
      left: box.left + tileRect.x * box.width,
      top: box.top + tileRect.y * box.height,
      right: box.left + (tileRect.x + tileRect.width) * box.width,
      bottom: box.top + (tileRect.y + tileRect.height) * box.height,
    });
    return rect ? { subdivision: 0, rect } : null;
  }

  async #copyImage(): Promise<void> {
    const contents = await this.#getCopyable({ kind: "all" });
    const image = contents.find((content) => content.kind === "image");
    if (!image || image.kind !== "image") {
      this.#view.announce("there is nothing to copy", "warn");
      return;
    }
    const result = await copyImageToClipboard(image.blob);
    this.#view.announce(result.message, result.ok ? "info" : "warn");
  }

  /**
   * Export with format conversion.
   *
   * The target format is chosen by the extension the user types into the native
   * save dialog, which is how every other application does it and avoids a
   * format picker the brief did not ask for. The dialog is filtered to the
   * formats the canvas can actually write — established by writing one, not by
   * asking (see `engine/export.ts`).
   */
  async #exportImage(): Promise<void> {
    const formats = await writableFormats();
    if (formats.length === 0) {
      this.#view.announce("this platform cannot encode any export format", "warn");
      return;
    }

    // Default to the source format when it is writable, so "export" without a
    // deliberate conversion round-trips the format the user already has.
    const preferred =
      formats.find((format) => format.id === this.#loaded.format.id) ?? formats[0]!;
    const base = stripExtension(this.#loaded.file.name);

    const path = await this.#chooseExportPath(base, preferred, formats);
    if (!path) return;

    const target = formatForPath(path, formats) ?? preferred;
    const canvas = this.#renderCurrent(
      needsFlattening(target) ? { background: "#ffffff" } : undefined,
    );
    if (!canvas) {
      this.#view.announce("the image could not be rendered for export", "warn");
      return;
    }

    try {
      const encoded = await encodeCanvas(
        canvas,
        target.mimeTypes[0]!,
        target.id === "png" ? undefined : DEFAULT_EXPORT_QUALITY,
      );
      if (!encoded) {
        this.#view.announce(`this platform cannot write ${target.label}`, "warn");
        return;
      }
      const { writeFileBytes } = await import("../../files");
      await writeFileBytes(path, new Uint8Array(await encoded.blob.arrayBuffer()));
      this.#view.announce(
        `exported ${encoded.width}×${encoded.height} as ${target.label}`,
      );
    } catch (thrown) {
      console.error("[image] export failed", thrown);
      this.#view.announce(
        thrown instanceof Error ? `export failed: ${thrown.message}` : "export failed",
        "warn",
      );
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  async #chooseExportPath(
    base: string,
    preferred: ImageFormat,
    formats: readonly ImageFormat[],
  ): Promise<string | null> {
    const { saveFileViaDialog } = await import("../../files");
    return saveFileViaDialog({
      defaultName: `${base}.${preferred.extensions[0]}`,
      // Every writable format, preferred first, so the dialog's own type list is
      // the conversion menu.
      filters: [preferred, ...formats.filter((format) => format.id !== preferred.id)].map(
        (format) => ({ name: format.label, extensions: format.extensions }),
      ),
    });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * The verb list `actions.ts` turns into a toolbar, a keybind section and a
   * context menu.
   *
   * Every field is read live and every method goes through the same setter the
   * toolbar does — which is what makes a button and a shortcut two ways to run
   * one action rather than two implementations that can disagree.
   */
  #actions(): ImageActions {
    const transport = this.#transport;
    const folder = this.#folder;

    return {
      zoomPercent: this.#view.zoomPercent,
      zoomMode: this.#view.zoomMode,
      rotation: this.#view.rotation,
      flipX: this.#view.flipX,
      flipY: this.#view.flipY,
      panel: this.#panel,
      sensitiveShown: this.#inspector.showSensitive,

      frameCount: transport?.frameCount ?? 1,
      frameIndex: transport?.index ?? 0,
      playing: transport?.playing ?? false,
      speed: transport?.speed ?? 1,

      folderPosition: folder?.position ?? 1,
      folderCount: folder?.count ?? 1,
      atFolderStart: folder?.atStart ?? true,
      atFolderEnd: folder?.atEnd ?? true,
      slideshowRunning: this.#slideshowTimer !== null,

      zoomIn: () => this.#view.stepZoom(1),
      zoomOut: () => this.#view.stepZoom(-1),
      setZoomMode: (mode) => this.#view.setZoomMode(mode),
      cycleFitMode: () => this.#cycleFitMode(),

      rotateClockwise: () => this.#view.rotateBy(90),
      rotateCounterClockwise: () => this.#view.rotateBy(-90),
      flipHorizontally: () => this.#view.setOrientation({ flipX: !this.#view.flipX }),
      flipVertically: () => this.#view.setOrientation({ flipY: !this.#view.flipY }),

      cycleInspector: () => this.#cycleInspector(),
      setInspector: (panel) => this.#setPanel(panel),
      toggleSensitiveMetadata: () => this.#toggleSensitive(),

      nextImage: () => this.#navigate(1),
      previousImage: () => this.#navigate(-1),
      toggleSlideshow: () =>
        this.#slideshowTimer ? this.#stopSlideshow() : this.#startSlideshow(),

      togglePlayback: () => transport?.toggle(),
      stepFrame: (direction) => transport?.step(direction),
      cycleSpeed: () => transport?.cycleSpeed(),

      copyImage: () => void this.#copyImage(),
      exportImage: () => void this.#exportImage(),
    };
  }

  #cycleFitMode(): void {
    const order: ZoomMode[] = ["fit-window", "actual", "fill"];
    const at = order.indexOf(this.#view.zoomMode);
    // A custom zoom lands on the first fit mode, which is the one people want
    // back after zooming in on a detail.
    this.#view.setZoomMode(at < 0 ? order[0]! : order[(at + 1) % order.length]!);
  }

  #cycleInspector(): void {
    const at = INSPECTOR_PANELS.indexOf(this.#panel);
    this.#setPanel(INSPECTOR_PANELS[(at + 1) % INSPECTOR_PANELS.length]!);
  }

  #toggleSensitive(): void {
    if (!this.#loaded.metadata.hasSensitive) {
      this.#view.announce("this image carries no location data");
      return;
    }
    // Opening the panel as well: toggling the visibility of something that is
    // not on screen would look like nothing happened.
    if (this.#panel !== "metadata") this.#setPanel("metadata");
    const shown = this.#inspector.toggleSensitive();
    this.#view.announce(shown ? "location data shown" : "location data hidden");
  }

  // -------------------------------------------------------------------------
  // Contributions
  // -------------------------------------------------------------------------

  #toolbarControls(): readonly ToolbarControl[] {
    return imageToolbarControls(this.#actions());
  }

  #keybindDefinitions(): readonly ViewerKeybind[] {
    return imageKeybinds(this.#actions());
  }

  #notifyToolbar(): void {
    for (const listener of this.#toolbarListeners) listener();
  }

  #notifyKeybinds(): void {
    for (const listener of this.#keybindListeners) listener();
  }

  // -------------------------------------------------------------------------
  // Contract surface
  // -------------------------------------------------------------------------

  /**
   * A scaled-down render.
   *
   * Frame `subdivision` for an animation, the first frame for its cover — which
   * is what the brief asks for — and the natural image otherwise. Cached by
   * frame and requested size, so the sidebar rail scrolling back over a frame it
   * has already drawn costs nothing.
   *
   * Deliberately *not* transformed: a thumbnail identifies the file, and one
   * that followed the tile's rotation and exposure preview would stop matching
   * the file it stands for the moment either changed.
   */
  async thumbnail(request: ThumbnailRequest): Promise<ThumbnailResult> {
    const subdivision = request.subdivision ?? 0;
    const key = `${subdivision}@${Math.round(request.maxWidth)}x${Math.round(request.maxHeight)}`;
    const cached = this.#thumbnailCache.get(key);
    if (cached) return cached;

    request.signal?.throwIfAborted();

    const source = this.#loaded.image.source;
    const drawable =
      source.kind === "raster"
        ? source.frames[Math.min(subdivision, source.frames.length - 1)]?.bitmap
        : this.#view.pixelCanvas();

    if (!drawable) {
      return { kind: "icon", icon: "image", label: this.#loaded.format.label };
    }

    const scale = Math.min(
      request.maxWidth / this.#loaded.image.width,
      request.maxHeight / this.#loaded.image.height,
      1,
    );
    const width = Math.max(1, Math.floor(this.#loaded.image.width * scale));
    const height = Math.max(1, Math.floor(this.#loaded.image.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return { kind: "icon", icon: "image", label: this.#loaded.format.label };
    }
    context.drawImage(drawable, 0, 0, width, height);

    // A data URL rather than an `ImageBitmap`: the contract makes the *consumer*
    // own a returned bitmap and close it, so a cache of bitmaps would hand the
    // same one to two callers and the first `close()` would break the second.
    // That is the same reasoning `viewers/pdf/thumbnails.ts` records.
    const result: ThumbnailResult = {
      kind: "dataUrl",
      dataUrl: canvas.toDataURL("image/png"),
      width,
      height,
    };
    canvas.width = 0;
    canvas.height = 0;

    this.#thumbnailCache.set(key, result);
    return result;
  }

  /** Seeks to a frame. The rail's click path, and the only location an image has. */
  async reveal(location: ViewerLocation): Promise<void> {
    if (location.subdivision === undefined) return;
    this.#transport?.seek(location.subdivision);
  }

  serialize(): ImageViewerState {
    const center = this.#view.centerFraction();
    return {
      zoomMode: this.#view.zoomMode,
      zoom: this.#view.zoomPercent,
      centerX: center.x,
      centerY: center.y,
      rotation: this.#view.rotation as Rotation,
      flipX: this.#view.flipX,
      flipY: this.#view.flipY,
      adjustments: this.#adjustments,
      panel: this.#panel,
      folderFile:
        this.#loaded.file.name === this.#openedFile.name
          ? undefined
          : this.#loaded.file.name,
    };
  }

  restore(state: unknown): void {
    const parsed = parseImageState(state);
    this.#adjustments = parsed.adjustments;
    this.#setPanel(parsed.panel);
    this.#view.setOrientation({
      rotation: parsed.rotation,
      flipX: parsed.flipX,
      flipY: parsed.flipY,
    });
    this.#view.setAdjustments(parsed.adjustments);
    this.#view.setZoomMode(parsed.zoomMode, parsed.zoom);
    this.#view.setCenterFraction({ x: parsed.centerX, y: parsed.centerY });
    this.#inspector.setAdjustments(parsed.adjustments);

    if (parsed.folderFile && parsed.folderFile !== this.#loaded.file.name) {
      const handle = this.#folder?.goToName(parsed.folderFile);
      if (handle) void this.#showFile(handle);
    }

    this.#notifyToolbar();
  }

  resize(): void {
    this.#view.resize();
  }

  /**
   * Pauses when the tile loses focus.
   *
   * `defaultRenderer: "always"` means a tile tabbed behind another stays mounted
   * (AGENTS.md, docking), which is what keeps decoded state alive — and would
   * also keep four animations running behind a tab nobody is looking at. A
   * slideshow is stopped rather than paused, because it is a mode the user
   * started and silently resuming it later would be a surprise.
   */
  setActive(active: boolean): void {
    if (active) return;
    this.#transport?.pause();
    this.#loupe.hide();
    closeImageMenu();
  }

  dispose(): void {
    this.#disposing = true;
    this.#abort.abort();
    this.#unsubscribeSettings();
    this.#stopSlideshow();
    if (this.#histogramTimer) clearTimeout(this.#histogramTimer);
    closeImageMenu();

    this.#transport?.destroy();
    this.#transport = null;
    this.#inspector.destroy();
    this.#loupe.destroy();
    this.#view.destroy();

    // Every decoded frame, given back explicitly. A GIF holds one canvas per
    // frame and a large TIFF holds a full-resolution one; waiting for the
    // collector to notice is how a session that opened forty images ends up
    // holding all of them.
    this.#loaded.image.dispose();
    if (this.#loaded.file !== this.#openedFile) this.#loaded.file.release();
    this.#thumbnailCache.clear();
    this.#toolbarListeners.clear();
    this.#keybindListeners.clear();

    this.markDisposed();
  }

  // -------------------------------------------------------------------------
  // Test hooks. Not part of the contract.
  // -------------------------------------------------------------------------

  /** Whether any bitmap-holding element is still live. */
  get holdsPixels(): boolean {
    return this.#view.holdsPixels;
  }

  get currentFormat(): ImageFormat {
    return this.#loaded.format;
  }

  get currentNotes(): readonly string[] {
    return this.#loaded.image.notes;
  }

  get transportForTesting(): AnimationTransport | null {
    return this.#transport;
  }

  setSpeedForTesting(speed: PlaybackSpeed): void {
    this.#transport?.setSpeed(speed);
  }
}

function subscribe(set: Set<() => void>, listener: () => void): Unsubscribe {
  set.add(listener);
  return () => set.delete(listener);
}

/** Which writable format a chosen path names, by its extension. */
function formatForPath(
  path: string,
  formats: readonly ImageFormat[],
): ImageFormat | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  const extension = path.slice(dot + 1).toLowerCase();
  return formats.find((format) => format.extensions.includes(extension));
}
