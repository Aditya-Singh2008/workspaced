/**
 * Contract self-test plugin. **Dev builds only.**
 *
 * Exists to prove the Viewer Plugin contract is implementable end to end before
 * any real plugin depends on it — it registers, mounts, previews, serializes,
 * restores and unmounts, exercising every required part of the interface and
 * nothing more.
 *
 * It is registered only under `import.meta.env.DEV` (see `../register.ts`) and
 * is what `contract-selftest.ts` drives.
 */

import type { FileHandle } from "../../files";
import { resolveThemeToken } from "../../theme";
import {
  BaseViewerInstance,
  ViewerLoadError,
  type ThumbnailRequest,
  type ThumbnailResult,
  type ToolbarControl,
  type Unsubscribe,
  type ViewerCapabilities,
  type ViewerInstance,
  type ViewerKeybindApi,
  type ViewerMountOptions,
  type ViewerPlugin,
  type ViewerToolbarApi,
} from "../contract";

export const STUB_PLUGIN_ID = "dev-stub";

/** The type the stub claims. Nothing real uses it, so it can never shadow a plugin. */
export const STUB_MIME_TYPE = "application/x-workspace-selftest";
export const STUB_EXTENSION = "selftest";

/** Content that makes the stub deliberately fail, to exercise the error path. */
export const STUB_FAIL_MARKER = "FAIL";

interface StubState {
  readonly note: string;
  readonly views: number;
  /** Stands in for a real per-instance preference, e.g. the PDF invert mode. */
  readonly flagged: boolean;
}

const DEFAULT_STATE: StubState = { note: "", views: 0, flagged: false };

function parseState(state: unknown): StubState {
  if (!state || typeof state !== "object") return DEFAULT_STATE;
  const candidate = state as Partial<StubState>;
  return {
    note: typeof candidate.note === "string" ? candidate.note : DEFAULT_STATE.note,
    views: typeof candidate.views === "number" ? candidate.views : DEFAULT_STATE.views,
    flagged:
      typeof candidate.flagged === "boolean" ? candidate.flagged : DEFAULT_STATE.flagged,
  };
}

class StubViewerInstance extends BaseViewerInstance implements ViewerInstance {
  readonly pluginId = STUB_PLUGIN_ID;
  readonly file: FileHandle;
  readonly capabilities: ViewerCapabilities = {
    search: false,
    copy: false,
    annotation: false,
    // Exercises the phase 02 toolbar extension point end to end, the same way
    // the rest of this class exercises the phase 01 lifecycle.
    toolbar: true,
    // The keybind extension point (phase 03) is the toolbar's sibling and is
    // exercised here for the same reason: so the seam is proven by something
    // other than the first plugin that happened to need it.
    keybinds: true,
    thumbnail: true,
    subdivisionCount: 1,
  };

  readonly toolbar: ViewerToolbarApi;
  readonly keybinds: ViewerKeybindApi;

  #root: HTMLElement | null;
  #noteField: HTMLElement;
  #state: StubState;
  /** Everything dispose() must reclaim, so leaks are observable. */
  #bitmaps: ImageBitmap[] = [];
  #abort = new AbortController();
  #toolbarListeners = new Set<() => void>();

  constructor(container: HTMLElement, file: FileHandle, initialState: unknown) {
    super();
    this.file = file;
    this.#state = { ...parseState(initialState), views: parseState(initialState).views + 1 };

    const root = document.createElement("div");
    root.className =
      "flex h-full w-full flex-col items-center justify-center gap-2 bg-bg text-muted";

    const title = document.createElement("p");
    title.className = "text-fg";
    title.textContent = `dev stub viewer — ${file.name}`;

    this.#noteField = document.createElement("p");
    this.#noteField.className = "text-muted";

    root.append(title, this.#noteField);
    container.append(root);
    this.#root = root;

    // Keeps a listener registered so a missing dispose() is detectable.
    window.addEventListener("resize", this.#onResize, { signal: this.#abort.signal });

    this.toolbar = {
      getControls: () => this.#toolbarControls(),
      onControlsChange: (listener) => this.#onToolbarControlsChange(listener),
    };

    // One binding, on a key nothing in the shell claims, so focusing a stub
    // tile visibly adds a section to the reference modal and unfocusing it
    // takes the section away again.
    this.keybinds = {
      groupTitle: "Dev stub",
      getKeybinds: () => [
        {
          id: "bump",
          label: "bump the view counter",
          keys: ["Mod+Shift+B"],
          order: 10,
          run: () => {
            this.#state = { ...this.#state, views: this.#state.views + 1 };
            this.#paint();
          },
        },
      ],
    };

    this.#paint();
    this.setStatus("ready");
  }

  #onResize = (): void => {
    /* intentionally inert */
  };

  #paint(): void {
    this.#noteField.textContent = `note="${this.#state.note}" views=${this.#state.views} flagged=${this.#state.flagged}`;
  }

  /**
   * One toggle and one button: enough to prove both control kinds render, that
   * a toggle's value is read back from the plugin rather than cached by the
   * toolbar, and that the controls vanish when focus moves to a tile that
   * contributes none.
   */
  #toolbarControls(): readonly ToolbarControl[] {
    return [
      {
        kind: "toggle",
        id: "flag",
        label: "flag",
        title: "stub: toggle the flag",
        order: 10,
        value: this.#state.flagged,
        setValue: (value) => {
          this.#state = { ...this.#state, flagged: value };
          this.#paint();
          this.#notifyToolbar();
        },
      },
      {
        kind: "button",
        id: "bump",
        label: "bump",
        title: "stub: increment the view counter",
        order: 20,
        run: () => {
          this.#state = { ...this.#state, views: this.#state.views + 1 };
          this.#paint();
        },
      },
    ];
  }

  #onToolbarControlsChange(listener: () => void): Unsubscribe {
    this.#toolbarListeners.add(listener);
    return () => this.#toolbarListeners.delete(listener);
  }

  #notifyToolbar(): void {
    for (const listener of this.#toolbarListeners) listener();
  }

  async thumbnail(request: ThumbnailRequest): Promise<ThumbnailResult> {
    request.signal?.throwIfAborted();

    const width = Math.max(1, Math.min(request.maxWidth, 256));
    const height = Math.max(1, Math.min(request.maxHeight, 256));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new ViewerLoadError({
        code: "internal",
        message: "Could not create a preview.",
        detail: "2d canvas context unavailable",
      });
    }

    // Colors come from the theme tokens. No literal fallback: a token that
    // fails to resolve is a theme bug and should be visible as one.
    context.fillStyle = resolveThemeToken("surface");
    context.fillRect(0, 0, width, height);
    context.strokeStyle = resolveThemeToken("accent");
    context.lineWidth = 1;
    context.strokeRect(0.5, 0.5, width - 1, height - 1);

    const bitmap = await createImageBitmap(canvas);
    this.#bitmaps.push(bitmap);
    return { kind: "bitmap", bitmap, width, height };
  }

  serialize(): StubState {
    return this.#state;
  }

  restore(state: unknown): void {
    this.#state = parseState(state);
    this.#paint();
  }

  setActive(active: boolean): void {
    this.#root?.classList.toggle("border-border-accent", active);
  }

  dispose(): void {
    this.#abort.abort();
    for (const bitmap of this.#bitmaps) bitmap.close();
    this.#bitmaps = [];
    this.#toolbarListeners.clear();
    this.#root?.remove();
    this.#root = null;
    this.markDisposed();
  }

  /** Test hook: how many bitmaps are still open. Not part of the contract. */
  get openBitmapCount(): number {
    return this.#bitmaps.length;
  }
}

export const devStubViewerPlugin: ViewerPlugin = {
  id: STUB_PLUGIN_ID,
  displayName: "Dev stub",
  mimeTypes: [STUB_MIME_TYPE],
  extensions: [STUB_EXTENSION],
  stateVersion: 1,

  async mount(
    container: HTMLElement,
    file: FileHandle,
    options?: ViewerMountOptions,
  ): Promise<ViewerInstance> {
    options?.signal?.throwIfAborted();

    const bytes = await file.read();
    if (new TextDecoder().decode(bytes).includes(STUB_FAIL_MARKER)) {
      throw new ViewerLoadError({
        code: "corrupt",
        message: "This file is deliberately unreadable.",
        detail: `stub saw the ${STUB_FAIL_MARKER} marker`,
        recoverable: false,
      });
    }

    return new StubViewerInstance(container, file, options?.initialState);
  },
};

export type { StubState };
export { StubViewerInstance };
