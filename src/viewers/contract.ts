/**
 * # The Viewer Plugin contract
 *
 * The seam that makes this app extensible, and the single source of truth for
 * it. The shell talks to every file type through this interface and nothing
 * else; if a shell component ever needs to know whether it is looking at a PDF,
 * the abstraction has leaked and belongs back here as a generalization.
 *
 * ## Design rules this file follows
 *
 * 1. **No file-type vocabulary.** There are no pages, no frames, no timestamps.
 *    Anything a file can be divided into is a *subdivision* (see
 *    {@link ViewerLocation}); the shell can page through subdivisions and draw
 *    thumbnails for them without knowing what they are.
 * 2. **Optional capability, not disabled capability.** A plugin that cannot
 *    search simply omits {@link ViewerInstance.search}. The shell reads
 *    {@link ViewerCapabilities} and *hides* the UI rather than showing it
 *    disabled. Absence is never an error.
 * 3. **Opaque state.** {@link ViewerInstance.serialize} returns `unknown`. The
 *    shell persists it verbatim and never inspects it.
 * 4. **Failures are local.** A plugin reports load and runtime failures through
 *    {@link ViewerError}; the shell renders them inside that one tile. A viewer
 *    must never be able to take down the shell or a sibling tile.
 *
 * ## Coordinates
 *
 * Positions crossing this boundary are *normalized*: `0..1` relative to the
 * subdivision's own box. That keeps them meaningful across zoom levels, device
 * pixel ratios, and rotation, and lets the shell draw a search highlight or a
 * region selection over any plugin without asking it for pixel geometry.
 */

import type {
  AnnotationExportOptions,
  AnnotationExportResult,
  AnnotationSummary,
  NormalizedRect,
  TextAnchorCapability,
} from "../annotation";
import type { FileHandle } from "../files";

export type { AnnotationSummary, NormalizedRect, TextAnchorCapability };

/** Removes a listener registered through one of the `on*` methods. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// 1. Identification
// ---------------------------------------------------------------------------

/**
 * How a plugin announces what it handles. Registered with
 * `registerViewerPlugin` (see `registry.ts`), which resolves an opened file to
 * exactly one plugin.
 */
export interface ViewerPluginDescriptor {
  /**
   * Stable, lowercase, unique across plugins — `"pdf"`, `"image"`, `"video"`.
   * Persisted in session state, so changing it invalidates saved sessions.
   */
  readonly id: string;

  /** Shown in the UI, e.g. in the fallback message or the command palette. */
  readonly displayName: string;

  /**
   * MIME types handled. Exact types (`"application/pdf"`) and trailing
   * wildcards (`"image/*"`) are both allowed; exact matches win over wildcards
   * during resolution.
   */
  readonly mimeTypes: readonly string[];

  /**
   * Extensions handled, lowercase and without the leading dot (`"pdf"`).
   *
   * This is the load-bearing path in practice: a file opened from a native
   * dialog has a real path but no MIME type, so extension matching is what
   * usually resolves it.
   */
  readonly extensions: readonly string[];

  /**
   * Tie-break when more than one plugin claims a type, higher wins. Defaults
   * to `0`. Registration order breaks equal priorities.
   */
  readonly priority?: number;

  /**
   * Bumped whenever the shape returned by {@link ViewerInstance.serialize}
   * changes incompatibly. The persistence layer discards saved state whose
   * version does not match, instead of feeding a plugin state it cannot read.
   */
  readonly stateVersion: number;

  /**
   * This plugin's *viewer-wide* preferences, if it has any. See
   * {@link ViewerPreferencesApi}.
   */
  readonly preferences?: ViewerPreferencesApi;
}

/**
 * Preferences that belong to a plugin rather than to any one open tile: the
 * image viewer's default fit mode, the video player's shared volume.
 *
 * ## Why this is on the descriptor and not on the instance
 *
 * {@link ViewerInstance.serialize} answers "what does *this tile* remember",
 * and both plugins that have preferences are explicit that theirs are a
 * different thing — a value the user set once that every tile picks up, which a
 * tile-scoped serialization would either duplicate n times or lose entirely
 * when the last tile of that type closes. So it hangs off the descriptor, which
 * exists whether or not anything is open.
 *
 * ## Why it is a contract extension rather than a persistence-layer import
 *
 * Phase 07's alternative was for `persistence/` to import
 * `viewers/image/settings` and `viewers/video/settings` directly and call the
 * `serialize`/`restore` pairs those modules already expose for it. That is the
 * one thing the architecture forbids outright: the shell would name two file
 * types, and a fourth plugin's preferences would mean editing the persistence
 * layer. Reading it off the descriptor means the persistence layer iterates
 * `listViewerPlugins()`, stores an opaque value per plugin id, and never learns
 * what any of them mean — the same deal {@link ViewerInstance.serialize} makes,
 * one level up. This is the sixth contribution point, added by the procedure
 * the phase briefs mandate: a plugin needed something the contract did not have.
 *
 * Optional and feature-detected, like every other capability here. The PDF
 * plugin has no viewer-wide preferences and omits it.
 */
export interface ViewerPreferencesApi {
  /**
   * Bumped when the shape of {@link serialize}'s result changes incompatibly.
   * The persistence layer discards a saved value whose version does not match,
   * exactly as it does for {@link ViewerPluginDescriptor.stateVersion}.
   */
  readonly version: number;

  /** Must be plain JSON. The shell writes it verbatim and never inspects it. */
  serialize(): unknown;

  /**
   * Applies a previously serialized value. Must tolerate partial, stale or
   * malformed input by keeping the current value rather than throwing — the
   * same rule {@link ViewerInstance.restore} follows.
   */
  restore(value: unknown): void;
}

// ---------------------------------------------------------------------------
// 2. Errors
// ---------------------------------------------------------------------------

export type ViewerErrorCode =
  /** The plugin claimed the type but cannot actually handle this file. */
  | "unsupported"
  /** The file disappeared or was never readable. */
  | "not-found"
  | "permission-denied"
  /** Structurally invalid or truncated content. */
  | "corrupt"
  /** Needs a credential the shell has not supplied (encrypted PDF). */
  | "password-required"
  /** Anything else. Always accompanied by a `detail`. */
  | "internal";

/**
 * A failure the shell renders *inside the failing tile*.
 *
 * Every path that can fail — `mount`, `restore`, `thumbnail`, a decode that
 * dies mid-session — surfaces one of these. See {@link ViewerLoadError} for
 * throwing one.
 */
export interface ViewerError {
  readonly code: ViewerErrorCode;
  /** One line, addressed to the user. No stack traces, no jargon. */
  readonly message: string;
  /** Technical detail for the console and bug reports. Not shown by default. */
  readonly detail?: string;
  /**
   * Whether retrying could plausibly succeed (a locked file, a transient read
   * error). The shell offers a retry affordance only when this is `true`.
   */
  readonly recoverable?: boolean;
  readonly cause?: unknown;
}

/**
 * The throwable form. `mount` rejecting with one of these is the required way
 * to report a load failure — that is the "convention" the contract guarantees.
 * Anything else a plugin throws is normalized to `code: "internal"` by the
 * shell, so a plugin can never crash the app by throwing the wrong thing.
 */
export class ViewerLoadError extends Error implements ViewerError {
  readonly code: ViewerErrorCode;
  readonly detail?: string;
  readonly recoverable?: boolean;

  constructor(error: ViewerError) {
    super(error.message, { cause: error.cause });
    this.name = "ViewerLoadError";
    this.code = error.code;
    this.detail = error.detail;
    this.recoverable = error.recoverable;
  }
}

/** Coerces anything thrown by a plugin into a `ViewerError`. */
export function toViewerError(thrown: unknown): ViewerError {
  if (thrown instanceof ViewerLoadError) {
    return {
      code: thrown.code,
      message: thrown.message,
      detail: thrown.detail,
      recoverable: thrown.recoverable,
      cause: thrown.cause,
    };
  }
  if (thrown instanceof Error) {
    return {
      code: "internal",
      message: thrown.message || "The viewer failed unexpectedly.",
      detail: thrown.stack,
      cause: thrown,
    };
  }
  return {
    code: "internal",
    message: "The viewer failed unexpectedly.",
    detail: String(thrown),
    cause: thrown,
  };
}

// ---------------------------------------------------------------------------
// 3. Locations
// ---------------------------------------------------------------------------

/**
 * A position inside a file, expressed without knowing what kind of file it is.
 *
 * A *subdivision* is the plugin's own notion of a discrete part: a PDF page, a
 * video keyframe. Files with a single view use subdivision `0`. This is what
 * lets the shell's global search, thumbnail rail and annotation overlay work
 * across every plugin.
 */
export interface ViewerLocation {
  /** Which subdivision. Omit (or `0`) for single-view content. */
  readonly subdivision?: number;

  /** Character range within the subdivision's extracted text, when applicable. */
  readonly range?: { readonly start: number; readonly end: number };

  /**
   * Normalized box within the subdivision. Lets the shell draw a highlight
   * without the plugin's help.
   */
  readonly rect?: NormalizedRect;

  /**
   * Anything else the plugin needs to re-find this exact spot. Opaque to the
   * shell, which only stores and hands it back.
   */
  readonly anchor?: unknown;
}

// ---------------------------------------------------------------------------
// 4. Capabilities
// ---------------------------------------------------------------------------

/**
 * What a mounted instance can do, read by the shell to decide which UI to show
 * at all. Static for the lifetime of an instance — a plugin that only knows
 * after loading (a PDF with no text layer) reports the capability it has *after
 * mount resolves*, which is when the shell first reads this.
 */
export interface ViewerCapabilities {
  /** {@link ViewerInstance.search} is present and meaningful. */
  readonly search: boolean;
  /** {@link ViewerInstance.copy} is present. */
  readonly copy: boolean;
  /** {@link ViewerInstance.annotation} is present. */
  readonly annotation: boolean;
  /** {@link ViewerInstance.toolbar} is present. */
  readonly toolbar: boolean;
  /** {@link ViewerInstance.keybinds} is present. */
  readonly keybinds: boolean;
  /**
   * `thumbnail()` returns real imagery rather than a generic icon. The shell
   * uses this to decide between a preview grid and a plain list.
   */
  readonly thumbnail: boolean;
  /**
   * How many subdivisions this instance has, when that is a fixed, knowable
   * number. Omitted for single-view or continuous content.
   */
  readonly subdivisionCount?: number;
}

// ---------------------------------------------------------------------------
// 5. Thumbnails
// ---------------------------------------------------------------------------

export interface ThumbnailRequest {
  /** Upper bounds in CSS pixels. Aspect ratio is the plugin's to preserve. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Which subdivision to preview. Defaults to `0`, always a sensible cover. */
  readonly subdivision?: number;
  /** Cancels an in-flight render when the requester goes away. */
  readonly signal?: AbortSignal;
}

/**
 * Icons the shell can draw for plugins with no meaningful preview. Kept as a
 * closed set so the shell owns the artwork and no plugin ships an image.
 */
export type ViewerIcon = "file" | "document" | "image" | "video" | "audio" | "archive";

/**
 * A preview image, in whichever form is cheapest for the plugin to produce.
 *
 * `"bitmap"` transfers without a copy and is preferred for anything rendered on
 * a canvas; the *consumer* owns the returned `ImageBitmap` and must `close()`
 * it. `"icon"` is the honest answer for a plugin that cannot preview its
 * content — it is not a failure.
 */
export type ThumbnailResult =
  | {
      readonly kind: "bitmap";
      readonly bitmap: ImageBitmap;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "canvas";
      readonly canvas: HTMLCanvasElement | OffscreenCanvas;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "dataUrl";
      readonly dataUrl: string;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "icon";
      readonly icon: ViewerIcon;
      /** Short caption, e.g. the file extension. */
      readonly label?: string;
    };

// ---------------------------------------------------------------------------
// 6. Search
// ---------------------------------------------------------------------------

/** A run of text plus enough position information for the shell to jump to it. */
export interface TextSegment {
  readonly text: string;
  readonly location: ViewerLocation;
}

export interface SearchQuery {
  readonly text: string;
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
  readonly regex?: boolean;
  /** Stop after this many hits. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface SearchMatch {
  /** The matched text exactly as it appears in the document. */
  readonly text: string;
  readonly location: ViewerLocation;
  /** Surrounding text for the results list. */
  readonly context?: string;
}

/**
 * Implemented only by plugins whose content has text. Its *absence* means "not
 * searchable" and the shell must treat that as normal — most images and all
 * video omit it.
 */
export interface ViewerSearchApi {
  /**
   * All searchable text, in reading order, segmented so each piece carries a
   * location. The shell caches this and can run its own matching, which is why
   * {@link find} is optional.
   */
  extractText(options?: {
    readonly subdivision?: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly TextSegment[]>;

  /**
   * Plugin-side search, for content where the plugin can do better than
   * matching over {@link extractText} — a native index, or hit rectangles the
   * shell cannot derive. Omit it and the shell searches the segments itself.
   */
  find?(query: SearchQuery): Promise<readonly SearchMatch[]>;

  /** Brings a location into view and, unless told otherwise, highlights it. */
  reveal(
    location: ViewerLocation,
    options?: { readonly highlight?: boolean },
  ): Promise<void>;

  /** Removes highlights previously drawn by {@link reveal}. */
  clearHighlights?(): void;
}

// ---------------------------------------------------------------------------
// 7. Copy
// ---------------------------------------------------------------------------

/** What the shell should ask for. */
export type CopyScope =
  /** Whatever the user currently has selected inside the viewer. */
  | { readonly kind: "selection" }
  /** A normalized region, for rubber-band capture over any renderer. */
  | {
      readonly kind: "region";
      readonly subdivision?: number;
      readonly rect: NormalizedRect;
    }
  /** The whole subdivision, or the whole file when `subdivision` is omitted. */
  | { readonly kind: "all"; readonly subdivision?: number };

export type CopyableContent =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image";
      readonly blob: Blob;
      readonly mimeType: string;
      readonly width: number;
      readonly height: number;
    };

/**
 * Implemented by plugins that have something copyable.
 *
 * The shell's clipboard system calls this rather than reading DOM selection,
 * because not every plugin renders selectable DOM text — a canvas-rendered page
 * has a selection the DOM knows nothing about.
 */
export interface ViewerCopyApi {
  /**
   * Everything copyable for the given scope, richest form first. A region of a
   * PDF may legitimately yield both text and an image; the shell decides which
   * flavors to put on the clipboard.
   *
   * Returns an empty array when there is nothing to copy. That is not an error.
   */
  getCopyable(scope: CopyScope): Promise<readonly CopyableContent[]>;

  /** Cheap check for enabling a toolbar button, without doing the extraction. */
  hasSelection?(): boolean;

  /** Fires when the answer to {@link hasSelection} may have changed. */
  onSelectionChange?(listener: () => void): Unsubscribe;

  /**
   * Which part of the content sits under a box the user dragged over the tile.
   *
   * `tileRect` is normalized to the *tile's* box — the one coordinate system
   * the shell can actually measure, since it owns the tile and nothing else.
   * The answer is a {@link ViewerLocation} in the plugin's own terms, whose
   * `subdivision` and `rect` are exactly what {@link CopyScope}'s `region`
   * variant wants. `null` means the box landed on nothing copyable (the margin
   * beside a page, the letterboxing around an image).
   *
   * ## Why this is on the contract rather than in the shell
   *
   * Phase 06's region copy is a rubber band drawn over any tile, and the
   * contract already promises that normalized coordinates let the shell "draw a
   * search highlight or a region selection over any plugin without asking it
   * for pixel geometry" (see "Coordinates" above). That promise holds for
   * *drawing*, where the shell is handed a location; it does not hold for the
   * inverse, because where a subdivision currently sits inside a tile is a
   * function of scroll offset, zoom, rotation and page layout — all of it the
   * plugin's, none of it derivable from the outside. The alternatives were a
   * shell that reads a PDF's scroll position (file-type logic in the shell) or
   * a region copy that can only ever mean "all of it". So the contract grew, by
   * the procedure the phase briefs mandate: one optional method, no file-type
   * vocabulary, useful to any plugin that renders content in a box.
   *
   * Optional and feature-detected like {@link ViewerInstance.reveal}: a plugin
   * whose copyable content has no spatial extent (a video, which copies the
   * current frame whatever box is drawn) omits it, and the shell hides region
   * copy for that tile rather than offering a gesture that would lie.
   */
  locateRegion?(tileRect: NormalizedRect): ViewerLocation | null;
}

// ---------------------------------------------------------------------------
// 8. Annotation
// ---------------------------------------------------------------------------

/**
 * Implemented by plugins whose tiles can be annotated. Plugins that can't simply
 * omit it, and the shell hides the annotation UI for those tiles rather than
 * showing a disabled button.
 *
 * ## What phase 05a changed, and why
 *
 * This started as a *shell-owned overlay* — `setOverlay`/`getOverlay`, the shell
 * holding the marks and handing them down. Building the authoring side showed
 * that backwards. The marks are edited inside the tile, by tools that need the
 * page geometry (which only the plugin has), and they have to outlive the tile
 * (close a document and reopen it and the annotations are still its
 * annotations), so they live in `annotation/store.ts` keyed by the file, with
 * the plugin as the thing that edits them. Handing the whole item list to the
 * shell as well would give shell components access to stroke geometry and image
 * bytes, which is the sort of access that eventually gets branched on.
 *
 * So the shell gets exactly what the sidebar's annotation list needs and nothing
 * more: a summary per annotation, a change notification, and deletion. This is
 * the same extension procedure `readout` and `reveal` went through in phases
 * 01–03 — the contract grew because a plugin needed something it did not have,
 * not speculatively — and it is recorded in AGENTS.md's contribution table.
 *
 * Navigation is deliberately *not* here. An {@link AnnotationSummary} carries a
 * subdivision and a rect, the shell builds a {@link ViewerLocation} from them,
 * and {@link ViewerInstance.reveal} does the jumping — the mechanism that
 * already exists for the thumbnail rail and for phase 06's search results.
 */
export interface ViewerAnnotationApi {
  /** Which formats this plugin can export an annotated copy as. Never empty. */
  readonly exportFormats: readonly AnnotationExportResult["format"][];

  /**
   * Every annotation on this document, for the sidebar's list.
   *
   * Called on focus and after every {@link onAnnotationsChange}, so it must be
   * cheap and must return fresh values — the same rule
   * {@link ViewerToolbarApi.getControls} follows.
   */
  listAnnotations(): readonly AnnotationSummary[];

  /** Fires when {@link listAnnotations} would return something different. */
  onAnnotationsChange(listener: () => void): Unsubscribe;

  /** Deletes one annotation. Unknown ids are ignored, not an error. */
  removeAnnotation(id: string): void;

  /**
   * Present when this plugin's content has text that can be annotated *as*
   * text: a quote, its context, and the boxes it currently occupies.
   *
   * Phase 05b's extension, and the smallest one that would do. The shared
   * `annotation/text/` model is written against these four methods and knows
   * nothing else about the file, so a future `txt` or `docx` plugin implements
   * them over plain character offsets and gets text-anchored highlights, notes,
   * the sidebar list and the export bridge without touching that model. The PDF
   * plugin implements them over pdf.js's text items in
   * `viewers/pdf/textGeometry.ts`.
   *
   * Absent is normal, and means exactly what absence always means here: no UI,
   * rather than disabled UI. A scanned page with no OCR layer has no text to
   * anchor to; an image has none at all.
   */
  readonly textAnchors?: TextAnchorCapability;

  /**
   * The annotated document, as bytes.
   *
   * Implementations must preserve as much of the original as the format allows.
   * The PDF plugin writes real PDF annotation *objects* through pdf-lib — a
   * `/Highlight`, an `/Ink`, a `/FreeText` — leaving the page's own content
   * stream untouched, so the export stays text-selectable and every mark stays
   * editable in any other compliant reader.
   */
  export(options: AnnotationExportOptions): Promise<AnnotationExportResult>;
}

// ---------------------------------------------------------------------------
// 9. Toolbar contributions
// ---------------------------------------------------------------------------

/**
 * Fields every contributed control shares.
 *
 * Controls are described, not rendered: a plugin hands the shell data and the
 * shell draws it with the shared theme. That is what lets the toolbar host a
 * PDF's inversion toggle without the toolbar component containing the word
 * "PDF", and what keeps every control looking the same.
 */
export interface ToolbarControlBase {
  /** Unique within the contributing instance. Also the React key. */
  readonly id: string;

  /** Short label. The toolbar is deliberately narrow — one or two words. */
  readonly label: string;

  /** Tooltip / accessible description. */
  readonly title?: string;

  readonly disabled?: boolean;

  /**
   * The accelerator spec (`"Mod+I"`) of the keybind that does the same thing,
   * shown alongside the tooltip. Declared as a spec, not a rendered string, so
   * the shell formats it for the host platform.
   */
  readonly accelerator?: string;

  /** Lower sorts first. Defaults to `0`; ties keep contribution order. */
  readonly order?: number;
}

export interface ToolbarButtonControl extends ToolbarControlBase {
  readonly kind: "button";
  run(): void;
}

export interface ToolbarToggleControl extends ToolbarControlBase {
  readonly kind: "toggle";
  readonly value: boolean;
  setValue(value: boolean): void;
}

export interface ToolbarChoiceControl extends ToolbarControlBase {
  readonly kind: "choice";
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  setValue(value: string): void;
}

/**
 * A value the plugin wants read, not pressed — a page position, a zoom
 * percentage, a timecode.
 *
 * It earns its place as a control kind rather than being faked with a disabled
 * button because the two read completely differently: a disabled button says
 * "this action is unavailable", and `3 / 12` is not an action at all. The
 * `label` is the caption (usually omitted, since the value speaks for itself);
 * `value` is what is displayed.
 */
export interface ToolbarReadoutControl extends ToolbarControlBase {
  readonly kind: "readout";
  readonly value: string;
}

export type ToolbarControl =
  | ToolbarButtonControl
  | ToolbarToggleControl
  | ToolbarChoiceControl
  | ToolbarReadoutControl;

/**
 * The toolbar extension point. Present iff `capabilities.toolbar`.
 *
 * The shell shows these controls only while this instance's tile is focused,
 * and hides them again when focus moves to a tile that contributes none — so
 * the toolbar stays short and always describes what you are looking at.
 */
export interface ViewerToolbarApi {
  /**
   * The controls to show right now. Called on focus and after every
   * {@link onControlsChange}, so it must be cheap and must return fresh values
   * (a toggle's `value` is read from here, not cached by the shell).
   */
  getControls(): readonly ToolbarControl[];

  /** Fires when {@link getControls} would return something different. */
  onControlsChange(listener: () => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// 10. Keybind contributions
// ---------------------------------------------------------------------------

/**
 * One keyboard action a plugin contributes.
 *
 * Deliberately the same shape the shell's own keybind registry uses, minus the
 * two fields the shell owns: the group (derived from
 * {@link ViewerKeybindApi.groupTitle}, so a plugin cannot collide with
 * another's section) and the namespaced id.
 */
export interface ViewerKeybind {
  /** Unique within the contributing instance. The shell namespaces it. */
  readonly id: string;

  /** Imperative and short: "next page", not "Goes to the next page". */
  readonly label: string;

  /**
   * Accelerator specs in `Mod+Shift+P` form. Declared with `Mod`, never `Ctrl`
   * or `Cmd` — the shell renders and matches them for the host platform, and a
   * plugin must never branch on the OS to describe a shortcut.
   */
  readonly keys: readonly string[];

  /** Lower sorts first within the plugin's section. */
  readonly order?: number;

  /** Bound and dispatchable, but not listed. For dev-only helpers. */
  readonly hidden?: boolean;

  /** Whether the action applies right now. Defaults to always. */
  enabled?(): boolean;

  run(): void;
}

/**
 * The keybind extension point. Present iff `capabilities.keybinds`.
 *
 * The sibling of {@link ViewerToolbarApi} and scoped the same way: the shell
 * registers these bindings while this instance's tile is focused and removes
 * them when focus leaves, so `PageDown` means "next page" in a paginated tile
 * and nothing at all in a tile that has no pages. That focus scoping is what
 * makes it safe for two plugins to want the same key.
 *
 * It exists because the alternative — a plugin importing the shell's keybind
 * registry directly — is exactly the reach into shell internals the contract
 * forbids, and because a shortcut that is not in the registry is not in the
 * reference modal either, which is where "there is a shortcut for this" is
 * supposed to be answerable.
 */
export interface ViewerKeybindApi {
  /**
   * Section title in the reference modal — "PDF", "Video". The shell derives
   * the group id from the contributing plugin, so two plugins choosing the same
   * title still get their own section.
   */
  readonly groupTitle: string;

  /**
   * The bindings to register right now. Called on focus and after every
   * {@link onKeybindsChange}, so it must be cheap.
   */
  getKeybinds(): readonly ViewerKeybind[];

  /** Fires when {@link getKeybinds} would return a different *declaration*. */
  onKeybindsChange?(listener: () => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// 11. Lifecycle
// ---------------------------------------------------------------------------

/** What the shell may be told to re-read after content changes. */
export type ViewerInvalidation = "thumbnail" | "text" | "capabilities" | "state";

export type ViewerStatus = "loading" | "ready" | "error";

/**
 * The shell's side of the conversation, handed to the plugin at mount.
 *
 * Every method is safe to call at any time, including during `dispose()`, and
 * none of them throw — a plugin must never have to defend against the shell.
 */
export interface ViewerHost {
  /**
   * Report a failure that should render inside this tile. Use this for
   * failures *after* a successful mount; for a failure during mount, reject
   * with a {@link ViewerLoadError} instead.
   */
  reportError(error: ViewerError): void;

  /** Clears a previously reported error after recovering. */
  clearError(): void;

  /**
   * Ask the shell to call `serialize()` and persist the result soon. Debounced
   * by the shell; call it freely on every scroll or zoom change.
   */
  requestPersist(): void;

  /** Tell the shell that cached derivatives are stale. */
  invalidate(aspects?: readonly ViewerInvalidation[]): void;

  /**
   * Rename what the shell calls this tile. `null` restores the opened file's
   * own name.
   *
   * For plugins whose tile can come to show something other than the file it
   * was opened with. The image plugin's folder browsing is the case it was
   * added for: stepping to the next photo in a directory replaces the tile's
   * content, and a tab still labelled with the *first* file's name is not a
   * cosmetic problem — it is the shell asserting something false about what is
   * on screen.
   *
   * Deliberately a rename and not "swap this tile's file". The shell owns which
   * file a client stands for, and letting a plugin reassign that would put
   * handle retention, plugin re-resolution and session restore under plugin
   * control. What a plugin legitimately owns is *what it is displaying*, and
   * this is the smallest way to say so. It carries no file-type vocabulary:
   * a video plugin walking a playlist wants exactly the same thing.
   */
  setDisplayName(name: string | null): void;
}

export interface ViewerMountOptions {
  /**
   * State from a previous session, as produced by
   * {@link ViewerInstance.serialize}. Already version-checked by the
   * persistence layer, so a plugin can trust its shape — but must still
   * tolerate partial state.
   */
  readonly initialState?: unknown;

  /** The shell callbacks. Omitted only in tests. */
  readonly host?: ViewerHost;

  /** Aborts a mount whose tile was closed while loading. */
  readonly signal?: AbortSignal;
}

/**
 * A mounted viewer. Created by {@link ViewerPlugin.mount}, destroyed by
 * {@link dispose}.
 */
export interface ViewerInstance {
  readonly pluginId: string;
  readonly file: FileHandle;

  /** See {@link ViewerCapabilities}. Read by the shell after mount resolves. */
  readonly capabilities: ViewerCapabilities;

  readonly status: ViewerStatus;

  /** Set whenever `status === "error"`. */
  readonly error?: ViewerError;

  /** Fires on every `status` transition after mount. */
  onStatusChange(listener: (status: ViewerStatus, error?: ViewerError) => void): Unsubscribe;

  /**
   * A preview image. Required of every plugin; those that cannot preview their
   * content return `{ kind: "icon" }`.
   */
  thumbnail(request: ThumbnailRequest): Promise<ThumbnailResult>;

  /**
   * Everything needed to resume where this instance left off — zoom, scroll
   * offset, current subdivision, per-instance preferences.
   *
   * Must be structured-clonable and JSON-serializable: the shell writes it to
   * disk without inspecting it. Must not include the file's contents or
   * anything derived from them at size.
   */
  serialize(): unknown;

  /**
   * Applies previously serialized state to a live instance. Called for a
   * mid-session restore; a fresh mount receives the same state through
   * {@link ViewerMountOptions.initialState} instead.
   *
   * Must tolerate partial, stale, or malformed state by falling back to
   * defaults rather than throwing.
   */
  restore(state: unknown): void | Promise<void>;

  /** Called when the tile's box changes. Optional; most plugins observe it themselves. */
  resize?(): void;

  /** Called when the tile becomes (or stops being) the focused one. */
  setActive?(active: boolean): void;

  /**
   * Brings a {@link ViewerLocation} into view.
   *
   * Optional in the same way {@link resize} is: no capability flag, the shell
   * feature-detects it. It is *not* under {@link ViewerSearchApi} because
   * navigating to a subdivision is not a search concern — the shell's
   * thumbnail rail needs it for a scanned PDF, which has thumbnails and pages
   * but no text and therefore no search capability at all. A searchable plugin
   * implements {@link ViewerSearchApi.reveal} too; the two are normally the
   * same function.
   */
  reveal?(
    location: ViewerLocation,
    options?: { readonly highlight?: boolean },
  ): Promise<void>;

  /** Present iff `capabilities.search`. */
  readonly search?: ViewerSearchApi;

  /** Present iff `capabilities.copy`. */
  readonly copy?: ViewerCopyApi;

  /** Present iff `capabilities.annotation`. */
  readonly annotation?: ViewerAnnotationApi;

  /** Present iff `capabilities.toolbar`. */
  readonly toolbar?: ViewerToolbarApi;

  /** Present iff `capabilities.keybinds`. */
  readonly keybinds?: ViewerKeybindApi;

  /**
   * Release everything: canvases, decoders, workers, object URLs, event
   * listeners, observers.
   *
   * The shell guarantees exactly one call per instance, and never touches the
   * instance again afterwards. Must not throw — a failure to clean up is the
   * plugin's problem, not the tile's.
   */
  dispose(): void | Promise<void>;
}

/** A registered viewer plugin. */
export interface ViewerPlugin extends ViewerPluginDescriptor {
  /**
   * Load `file` and render it into `container`.
   *
   * The container is empty, owned entirely by the plugin, and has a definite
   * box. The plugin appends whatever it needs and is responsible for tearing it
   * down in {@link ViewerInstance.dispose}.
   *
   * Always asynchronous, because every real plugin has an async load path.
   * Reject with a {@link ViewerLoadError} to have the shell render a failure
   * inside this tile.
   */
  mount(
    container: HTMLElement,
    file: FileHandle,
    options?: ViewerMountOptions,
  ): Promise<ViewerInstance>;
}

// ---------------------------------------------------------------------------
// Helpers for plugin authors
// ---------------------------------------------------------------------------

/** A no-op host, for mounting outside the shell (tests, the contract self-test). */
export function createNoopViewerHost(): ViewerHost {
  return {
    reportError: () => {},
    clearError: () => {},
    requestPersist: () => {},
    invalidate: () => {},
    setDisplayName: () => {},
  };
}

/**
 * Small base class handling the status/error bookkeeping every instance needs
 * identically. Plugins may extend it or implement {@link ViewerInstance}
 * directly; nothing in the shell depends on it.
 */
export abstract class BaseViewerInstance implements ViewerInstance {
  abstract readonly pluginId: string;
  abstract readonly file: FileHandle;
  abstract readonly capabilities: ViewerCapabilities;

  #status: ViewerStatus = "loading";
  #error: ViewerError | undefined;
  #listeners = new Set<(status: ViewerStatus, error?: ViewerError) => void>();
  #disposed = false;

  get status(): ViewerStatus {
    return this.#status;
  }

  get error(): ViewerError | undefined {
    return this.#error;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  onStatusChange(
    listener: (status: ViewerStatus, error?: ViewerError) => void,
  ): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  protected setStatus(status: ViewerStatus, error?: ViewerError): void {
    if (this.#status === status && this.#error === error) return;
    this.#status = status;
    this.#error = status === "error" ? error : undefined;
    for (const listener of this.#listeners) {
      // One bad listener must not stop the others, or block the plugin.
      try {
        listener(this.#status, this.#error);
      } catch (thrown) {
        console.error("viewer status listener threw", thrown);
      }
    }
  }

  protected markDisposed(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  abstract thumbnail(request: ThumbnailRequest): Promise<ThumbnailResult>;
  abstract serialize(): unknown;
  abstract restore(state: unknown): void | Promise<void>;
  abstract dispose(): void | Promise<void>;
}
