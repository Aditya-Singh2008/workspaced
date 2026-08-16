/**
 * Fallback viewer: whatever no other plugin claimed.
 *
 * Shows the file's identity and says plainly that nothing can render it. It is
 * a real plugin implementing the full contract, not a special case in the
 * shell — which keeps "unsupported file" out of the shell's vocabulary
 * entirely, and means opening an unknown file costs a tile rather than an
 * error.
 */

import { formatFileSize, type FileHandle } from "../../files";
import {
  BaseViewerInstance,
  type ThumbnailRequest,
  type ThumbnailResult,
  type ViewerCapabilities,
  type ViewerIcon,
  type ViewerInstance,
  type ViewerMountOptions,
  type ViewerPlugin,
} from "../contract";

export const FALLBACK_PLUGIN_ID = "fallback";

/**
 * Icon buckets by extension. Purely cosmetic — the fallback renders the same
 * message either way, this only picks the glyph.
 */
const ICONS: ReadonlyArray<readonly [ViewerIcon, readonly string[]]> = [
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "tiff", "heic"]],
  ["video", ["mp4", "mkv", "webm", "mov", "avi", "m4v", "wmv"]],
  ["audio", ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"]],
  ["archive", ["zip", "tar", "gz", "bz2", "xz", "7z", "rar"]],
  ["document", ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "epub"]],
];

function iconFor(extension: string | undefined): ViewerIcon {
  if (!extension) return "file";
  for (const [icon, extensions] of ICONS) {
    if (extensions.includes(extension)) return icon;
  }
  return "file";
}

interface FallbackState {
  /** Nothing meaningful to resume, but the shape has to round-trip. */
  readonly seen: boolean;
}

class FallbackViewerInstance extends BaseViewerInstance implements ViewerInstance {
  readonly pluginId = FALLBACK_PLUGIN_ID;
  readonly file: FileHandle;
  readonly capabilities: ViewerCapabilities = {
    search: false,
    copy: false,
    annotation: false,
    // Nothing about an unreadable file is worth a toolbar control or a
    // shortcut. Focusing a fallback tile is therefore what proves the toolbar
    // clears the previous tile's contributions, and that a plugin's keybind
    // section leaves the reference modal when its tile loses focus.
    toolbar: false,
    keybinds: false,
    thumbnail: false,
  };

  #root: HTMLElement | null;
  #state: FallbackState = { seen: true };

  constructor(container: HTMLElement, file: FileHandle) {
    super();
    this.file = file;
    this.#root = renderFallback(container, file);
    this.setStatus("ready");
  }

  async thumbnail(_request: ThumbnailRequest): Promise<ThumbnailResult> {
    return {
      kind: "icon",
      icon: iconFor(this.file.extension),
      label: this.file.extension?.toUpperCase(),
    };
  }

  serialize(): unknown {
    return this.#state;
  }

  restore(state: unknown): void {
    // Tolerate anything; there is nothing here worth failing over.
    if (state && typeof state === "object" && "seen" in state) {
      this.#state = { seen: Boolean((state as FallbackState).seen) };
    }
  }

  dispose(): void {
    this.#root?.remove();
    this.#root = null;
    this.markDisposed();
  }
}

function row(label: string, value: string): HTMLElement {
  const line = document.createElement("div");
  line.className = "flex gap-3";

  const key = document.createElement("span");
  key.className = "w-20 shrink-0 text-muted";
  key.textContent = label;

  const val = document.createElement("span");
  val.className = "min-w-0 break-all text-fg-dim";
  val.textContent = value;

  line.append(key, val);
  return line;
}

function renderFallback(container: HTMLElement, file: FileHandle): HTMLElement {
  const root = document.createElement("div");
  root.className =
    "flex h-full w-full flex-col items-center justify-center gap-6 bg-bg p-8 text-center";

  const glyph = document.createElement("div");
  glyph.className = "border border-border px-4 py-2 text-muted";
  glyph.textContent = file.extension ? `.${file.extension}` : "no extension";

  const heading = document.createElement("p");
  heading.className = "text-fg";
  heading.textContent = "No viewer available for this file type.";

  const detail = document.createElement("div");
  detail.className = "flex flex-col gap-1 text-left";
  detail.append(
    row("name", file.name),
    row("size", formatFileSize(file.size)),
    row("type", file.mimeType ?? (file.extension ? `.${file.extension}` : "unknown")),
  );
  if (file.path) detail.append(row("path", file.path));

  root.append(glyph, heading, detail);
  container.append(root);
  return root;
}

export const fallbackViewerPlugin: ViewerPlugin = {
  id: FALLBACK_PLUGIN_ID,
  displayName: "Unsupported file",
  // Claims nothing. The registry installs it via `setFallbackViewerPlugin`, so
  // it is reached only when matching finds nothing, never by competing.
  mimeTypes: [],
  extensions: [],
  stateVersion: 1,

  async mount(
    container: HTMLElement,
    file: FileHandle,
    options?: ViewerMountOptions,
  ): Promise<ViewerInstance> {
    const instance = new FallbackViewerInstance(container, file);
    if (options?.initialState !== undefined) instance.restore(options.initialState);
    return instance;
  },
};
