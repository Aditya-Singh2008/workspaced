/**
 * The annotation tool palette: a strip attached to the tile, not to the toolbar.
 *
 * The phase brief is specific about this. The toolbar contributes *one* control
 * ("annotate"), because the toolbar is under a standing instruction to stay
 * short and a permanent row of ten tool buttons would be the opposite of that.
 * Turning annotate mode on opens this strip inside the tile that is being
 * annotated, which is also where it belongs: the tools act on that document, and
 * two annotated tiles side by side each get their own.
 *
 * Plain DOM rather than React, matching the rest of this plugin: a viewer plugin
 * owns its container element and nothing else, and mounting a React root inside
 * it would tie the plugin's rendering to the shell's.
 *
 * Terse labels rather than icons, matching the toolbar's own `‹`, `−` and
 * `invert`: this app has no icon set, and inventing one for ten buttons would be
 * a second visual language.
 */

import {
  OVERLAY_COLORS,
  OVERLAY_TOOLS,
  STROKE_WIDTHS,
  type OverlayToolId,
  type OverlayToolStyle,
} from "../../annotation";

export interface AnnotationPaletteState {
  readonly tool: OverlayToolId;
  /**
   * What the style controls should show: the selected mark's own style when
   * there is one, otherwise the current tool's remembered style. A swatch row
   * that shows the *tool's* colour while a red arrow is selected is lying about
   * what clicking a swatch will do.
   */
  readonly style: OverlayToolStyle;
  /** Whether stroke width / fill apply to what the controls would act on. */
  readonly allowStroke: boolean;
  readonly allowFill: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasSelection: boolean;
  readonly count: number;
  readonly busy: boolean;
}

export interface AnnotationPaletteCallbacks {
  selectTool(tool: OverlayToolId): void;
  setStyle(patch: Partial<OverlayToolStyle>): void;
  undo(): void;
  redo(): void;
  remove(): void;
  bringToFront(): void;
  sendToBack(): void;
  save(): void;
  close(): void;
}

/** Which tools the fill and stroke-width controls apply to. Also see {@link AnnotationPaletteState}. */
export const STROKE_TOOLS: readonly OverlayToolId[] = [
  "ink",
  "rect",
  "ellipse",
  "line",
  "arrow",
];
export const FILL_TOOLS: readonly OverlayToolId[] = ["rect", "ellipse"];

export class AnnotationPalette {
  readonly root: HTMLElement;

  #callbacks: AnnotationPaletteCallbacks;
  #toolButtons = new Map<OverlayToolId, HTMLButtonElement>();
  #swatches = new Map<string, HTMLButtonElement>();
  #widthButtons = new Map<number, HTMLButtonElement>();
  #fillButton: HTMLButtonElement;
  #undoButton: HTMLButtonElement;
  #redoButton: HTMLButtonElement;
  #deleteButton: HTMLButtonElement;
  #frontButton: HTMLButtonElement;
  #backButton: HTMLButtonElement;
  #saveButton: HTMLButtonElement;
  #countLabel: HTMLElement;

  constructor(host: HTMLElement, callbacks: AnnotationPaletteCallbacks) {
    this.#callbacks = callbacks;

    const root = document.createElement("div");
    root.className = "pdf-annot-palette";
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "annotation tools");

    // --- tools ---
    const tools = row();
    for (const tool of OVERLAY_TOOLS) {
      const button = paletteButton(tool.label, tool.title);
      button.addEventListener("click", () => this.#callbacks.selectTool(tool.id));
      this.#toolButtons.set(tool.id, button);
      tools.append(button);
    }

    // --- style ---
    const style = row();
    for (const color of OVERLAY_COLORS) {
      const button = paletteButton("", `colour ${color}`);
      button.classList.add("pdf-annot-swatch");
      button.style.backgroundColor = color;
      button.addEventListener("click", () => this.#callbacks.setStyle({ color }));
      this.#swatches.set(color, button);
      style.append(button);
    }
    style.append(separator());
    for (const [index, width] of STROKE_WIDTHS.entries()) {
      const button = paletteButton(["thin", "med", "thick"][index] ?? String(index), "pen width");
      button.addEventListener("click", () => this.#callbacks.setStyle({ strokeWidth: width }));
      this.#widthButtons.set(width, button);
      style.append(button);
    }
    this.#fillButton = paletteButton("fill", "fill the shape's interior");
    this.#fillButton.addEventListener("click", () =>
      this.#callbacks.setStyle({ filled: !this.#fillButton.classList.contains("is-active") }),
    );
    style.append(separator(), this.#fillButton);

    // --- actions ---
    const actions = row();
    this.#undoButton = paletteButton("undo", "undo the last change");
    this.#undoButton.addEventListener("click", () => this.#callbacks.undo());
    this.#redoButton = paletteButton("redo", "redo");
    this.#redoButton.addEventListener("click", () => this.#callbacks.redo());
    this.#frontButton = paletteButton("front", "bring the selection to the front");
    this.#frontButton.addEventListener("click", () => this.#callbacks.bringToFront());
    this.#backButton = paletteButton("back", "send the selection to the back");
    this.#backButton.addEventListener("click", () => this.#callbacks.sendToBack());
    this.#deleteButton = paletteButton("del", "delete the selection");
    this.#deleteButton.addEventListener("click", () => this.#callbacks.remove());
    this.#saveButton = paletteButton("save", "write the annotated copy to disk");
    this.#saveButton.classList.add("pdf-annot-save");
    this.#saveButton.addEventListener("click", () => this.#callbacks.save());

    this.#countLabel = document.createElement("span");
    this.#countLabel.className = "pdf-annot-count";

    const close = paletteButton("×", "leave annotate mode");
    close.addEventListener("click", () => this.#callbacks.close());

    actions.append(
      this.#undoButton,
      this.#redoButton,
      separator(),
      this.#frontButton,
      this.#backButton,
      this.#deleteButton,
      separator(),
      this.#saveButton,
      this.#countLabel,
      close,
    );

    root.append(tools, style, actions);
    host.append(root);
    this.root = root;
  }

  update(state: AnnotationPaletteState): void {
    for (const [tool, button] of this.#toolButtons) {
      button.classList.toggle("is-active", tool === state.tool);
    }
    for (const [color, button] of this.#swatches) {
      button.classList.toggle("is-active", color === state.style.color);
    }

    for (const [width, button] of this.#widthButtons) {
      button.classList.toggle("is-active", width === state.style.strokeWidth);
      button.disabled = !state.allowStroke;
    }
    this.#fillButton.classList.toggle("is-active", state.style.filled);
    this.#fillButton.disabled = !state.allowFill;

    this.#undoButton.disabled = !state.canUndo;
    this.#redoButton.disabled = !state.canRedo;
    this.#deleteButton.disabled = !state.hasSelection;
    this.#frontButton.disabled = !state.hasSelection;
    this.#backButton.disabled = !state.hasSelection;
    this.#saveButton.disabled = state.busy || state.count === 0;
    this.#countLabel.textContent =
      state.count === 0 ? "no marks" : state.count === 1 ? "1 mark" : `${state.count} marks`;
  }

  destroy(): void {
    this.root.remove();
  }
}

function row(): HTMLElement {
  const element = document.createElement("div");
  element.className = "pdf-annot-row";
  return element;
}

function separator(): HTMLElement {
  const element = document.createElement("span");
  element.className = "pdf-annot-separator";
  return element;
}

function paletteButton(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pdf-annot-button";
  button.textContent = label;
  button.title = title;
  // The palette must never take focus off the document: the annotate-mode
  // shortcuts (undo, delete, escape) are dispatched from the window, and a
  // button holding focus after a click is one more thing between the user and
  // the next keystroke.
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  return button;
}
