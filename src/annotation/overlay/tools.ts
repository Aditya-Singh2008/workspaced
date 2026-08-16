/**
 * The tools, and what each one remembers.
 *
 * ## Annotations carry literal colours, and that is not a palette violation
 *
 * AGENTS.md's visual language governs the *application*: one accent, muted
 * greys, secondary colour for functional signalling only. An annotation is not
 * application chrome — it is content the user is adding to their document, and
 * it will be read in Acrobat tomorrow with none of this app's CSS. The same
 * exception `pdf.css` already makes for paper white ("that is not chrome, it is
 * the document") applies here. So {@link OVERLAY_COLORS} is a real ink palette,
 * and it is the *only* place in this app that is allowed one.
 *
 * The six are the highlighter/pen colours every PDF annotator ships, kept
 * legible against both white paper and an inverted page.
 *
 * ## Per-tool memory
 *
 * The brief: "Color and stroke-width pickers remember their last-used value per
 * tool, so re-selecting the highlight tool doesn't reset to a default every
 * time." Per *tool*, not globally — a yellow highlighter and a red pen are two
 * settings, and one picker shared between them makes choosing either one undo
 * the other. This is session-scoped state; phase 07 can persist it with the rest
 * of the preferences.
 */

import { DEFAULT_FONT_SIZE, DEFAULT_STROKE_WIDTH, type OverlayItemKind } from "./model";

export type OverlayToolId =
  /** Not a mark: the pointer that selects, moves and resizes what is there. */
  | "select"
  | "ink"
  | "highlight"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "text"
  | "note"
  | "image";

export interface OverlayToolDescriptor {
  readonly id: OverlayToolId;
  /** Palette label. Terse — the strip is meant to be one line. */
  readonly label: string;
  readonly title: string;
  /** Which item kind it produces. Absent for `select`. */
  readonly kind?: OverlayItemKind;
}

/**
 * The palette, in order.
 *
 * Ink through image is the tool set the phase brief names, one entry each. There
 * is deliberately no "eraser": deleting is selecting and pressing Delete, which
 * is one fewer mode and works on marks an eraser stroke would have to hunt for.
 */
export const OVERLAY_TOOLS: readonly OverlayToolDescriptor[] = [
  { id: "select", label: "sel", title: "select, move and resize" },
  { id: "ink", label: "pen", title: "freehand ink", kind: "ink" },
  { id: "highlight", label: "mark", title: "highlight a region", kind: "highlight" },
  { id: "rect", label: "box", title: "rectangle", kind: "shape" },
  { id: "ellipse", label: "oval", title: "ellipse", kind: "shape" },
  { id: "line", label: "line", title: "line", kind: "shape" },
  { id: "arrow", label: "arw", title: "arrow", kind: "shape" },
  { id: "text", label: "txt", title: "text callout", kind: "text" },
  { id: "note", label: "note", title: "sticky note", kind: "note" },
  { id: "image", label: "img", title: "paste or drop an image", kind: "image" },
];

/** Ink colours. See the module comment for why these are literal. */
export const OVERLAY_COLORS: readonly string[] = [
  "#ffd93d", // yellow — the default highlighter
  "#ff5f56", // red
  "#4ecb71", // green
  "#2979ff", // blue
  "#c678dd", // violet
  "#1a1a1a", // near-black ink
];

export interface OverlayToolStyle {
  readonly color: string;
  readonly opacity: number;
  readonly strokeWidth: number;
  readonly fontSize: number;
  /** Shapes only: whether the interior is filled with `color`. */
  readonly filled: boolean;
}

/**
 * Where each tool starts before the user has touched it.
 *
 * The highlighter is the only one that is translucent, because a highlight that
 * hides the words underneath it is not a highlight. Everything else draws at
 * full strength.
 */
function initialStyle(tool: OverlayToolId): OverlayToolStyle {
  const base: OverlayToolStyle = {
    color: "#ff5f56",
    opacity: 1,
    strokeWidth: DEFAULT_STROKE_WIDTH,
    fontSize: DEFAULT_FONT_SIZE,
    filled: false,
  };
  switch (tool) {
    case "highlight":
      return { ...base, color: "#ffd93d", opacity: 0.4 };
    case "note":
      return { ...base, color: "#ffd93d" };
    case "text":
      return { ...base, color: "#1a1a1a" };
    default:
      return base;
  }
}

/** Session-scoped per-tool style memory. */
export class OverlayToolPreferences {
  #styles = new Map<OverlayToolId, OverlayToolStyle>();

  get(tool: OverlayToolId): OverlayToolStyle {
    const known = this.#styles.get(tool);
    if (known) return known;
    const initial = initialStyle(tool);
    this.#styles.set(tool, initial);
    return initial;
  }

  set(tool: OverlayToolId, patch: Partial<OverlayToolStyle>): OverlayToolStyle {
    const next = { ...this.get(tool), ...patch };
    this.#styles.set(tool, next);
    return next;
  }
}

/**
 * One set of preferences for the whole app.
 *
 * A per-instance copy would mean the pen colour resets every time a second PDF
 * is opened, which is exactly the annoyance the requirement is about — the
 * memory is the user's, not the tile's.
 */
export const overlayToolPreferences = new OverlayToolPreferences();
