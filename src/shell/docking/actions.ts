/**
 * The layout actions, declared once.
 *
 * Phase 02 requires that no action is keyboard-only with zero discovery path.
 * The cheapest way to guarantee that is to stop writing actions twice: this
 * list is the single declaration, and both consumers derive from it —
 *
 *   - the keybind registry binds each action's `keys` and lists it in the
 *     reference modal;
 *   - the panel context menu renders the same list, targeting the tile that
 *     was right-clicked instead of the focused one.
 *
 * Adding an action here therefore adds it to both. Forgetting the mouse path
 * is not possible.
 *
 * ## The set, and why it is this set
 *
 * Every entry is a tiling operation borrowed from dwm or i3, because between
 * them they reach every arrangement this layout model can express, and nothing
 * else is needed:
 *
 *   | dwm / i3        | here                      |
 *   |-----------------|---------------------------|
 *   | i3 `move <dir>` | move left/down/up/right   |
 *   | `focusstack`    | focus next / previous     |
 *   | i3 workspace n  | focus tile 1 … 9          |
 *   | `zoom`          | make tile master          |
 *   | `setlayout`     | next / previous           |
 *   | + `incnmaster`  |   screen arrangement      |
 *   | `arrange`       | retile                    |
 *   | monocle layout  | toggle monocle            |
 *   | `killclient`    | close tile                |
 *
 * "Retile" has no dwm equivalent because dwm re-arranges continuously; here
 * the user can also drag tiles freehand, so normalizing is something they ask
 * for rather than something that happens to them.
 *
 * ## The shape of the bindings
 *
 *   `Mod`       + ← →      focus the previous / next tile or tab
 *   `Mod`       + 1 … 9    focus a tile by number
 *   `Mod+Shift` + arrows   move the tile
 *   `Mod+Enter`            the next way of dividing the screen
 *
 * Everything else is a single key for a single job, and nothing has two
 * bindings — a second combo for a job another key already does is exactly the
 * redundancy that made this list long.
 *
 * Deliberately *not* here, and why:
 *
 *   - **`Mod+Alt`+anything.** Not a preference — GNOME binds all four
 *     `Ctrl+Alt`+arrow combinations to switch-to-workspace and takes them
 *     before the webview ever sees a key press, so the master-area bindings
 *     that lived there genuinely did nothing on Linux. Do not rebind here.
 *   - **directional focus** (`Mod`+arrow per direction). Four bindings to
 *     reach a tile, next to nine that reach one directly. `Mod+1 … 9` is the
 *     faster route to a named tile and cycling is the faster route to the
 *     next one, so the middle option was the one to drop.
 *   - **cycle layout, master count, master width** as separate keys. All
 *     three only ever produced some arrangement of the screen, so they folded
 *     into one rotation that visits every arrangement and nothing else. The
 *     master *width* is now the divider itself, which is draggable and sticks.
 *   - **promote to master**, separately from swap. Both meant "make this the
 *     master" and differed only in whether the rest of the stack shifted down
 *     a slot. The survivor is the one that leaves other tiles alone.
 *   - **decrease gap**. A gap is set once; one wrapping key is enough.
 *
 * `Mod`+digit is spoken for. A later phase wanting digits for page jumps or
 * zoom presets needs a different modifier, not these.
 */

import type { DockviewApi, IDockviewPanel } from "dockview-react";

import { useLayoutStore } from "../../store";
import {
  cycleFocus,
  focusTileAt,
  moveInDirection,
  retile,
  swapWithMaster,
  toggleMonocle,
  type TileDirection,
} from "./layout";
import { readMasterFraction, type TilingParams } from "./tiling";

/** The keybind reference groups these actions are listed under. */
export const LAYOUT_KEYBIND_GROUP = "layout";
export const FOCUS_KEYBIND_GROUP = "focus";

export interface DockActionContext {
  readonly api: DockviewApi;
  /**
   * The tile the action applies to: the focused one when invoked by keyboard,
   * the right-clicked one when invoked from the context menu.
   */
  readonly panel: IDockviewPanel | undefined;
}

export interface DockAction {
  /** Stable and namespaced; also the keybind id. */
  readonly id: string;
  readonly group: typeof LAYOUT_KEYBIND_GROUP | typeof FOCUS_KEYBIND_GROUP;
  readonly label: string;
  /** Accelerator specs, `Mod`-relative. The first is the one displayed. */
  readonly keys: readonly string[];
  readonly order: number;
  /** Greyed out, and skipped by the dispatcher, when there is no target tile. */
  readonly requiresPanel: boolean;
  /**
   * Bound and dispatchable, but not listed in the reference modal. For the
   * members of a numbered family whose first entry already documents the set.
   */
  readonly hidden?: boolean;
  /**
   * Opt out of the tile context menu. The default is to appear there, so the
   * phase 02 guarantee — no action is keyboard-only — holds for anything added
   * later without the author having to remember it. Opt out only when the
   * action does not act on the tile that was right-clicked, or when it belongs
   * to a family too large to list.
   */
  readonly menu?: false;
  run(context: DockActionContext): void;
}

/**
 * The tiling parameters, refreshed from the live dock at the moment an action
 * runs.
 *
 * The refresh is what makes a dragged divider stick. dockview owns sash
 * geometry, so once the user drags the master edge the stored `masterFraction`
 * is stale and the next promote would snap the width back to whatever was last
 * set from the keyboard — the single most jarring thing about the layout
 * before this. Reading the ratio back first means the two ways of setting the
 * width agree, whichever the user reached for last.
 */
function tiling(api: DockviewApi): TilingParams {
  const store = useLayoutStore.getState();
  const observed = readMasterFraction(api.toJSON().grid, store.tiling.mode);

  if (
    observed !== null &&
    Math.abs(observed - store.tiling.masterFraction) >= FRACTION_EPSILON
  ) {
    store.setMasterFraction(observed);
    return useLayoutStore.getState().tiling;
  }

  return store.tiling;
}

/**
 * The stored parameters, with no refresh. For the actions that have just
 * changed one of them: re-reading the dock there would read the *old* grid and
 * discard the change that was the point of the keystroke.
 */
function storedTiling(): TilingParams {
  return useLayoutStore.getState().tiling;
}

/** Below this, a difference is rounding rather than something the user did. */
const FRACTION_EPSILON = 0.005;

/**
 * The four directions, in i3's `hjkl` order so the reference modal lists them
 * the way the keys sit under a hand rather than alphabetically.
 */
const DIRECTIONS: readonly { readonly direction: TileDirection; readonly arrow: string }[] =
  [
    { direction: "left", arrow: "ArrowLeft" },
    { direction: "down", arrow: "ArrowDown" },
    { direction: "up", arrow: "ArrowUp" },
    { direction: "right", arrow: "ArrowRight" },
  ];

/** `Mod+Shift` + a direction moves the tile itself. */
const MOVE_DIRECTION_ACTIONS: readonly DockAction[] = DIRECTIONS.map(
  ({ direction, arrow }, index) => ({
    id: `layout.move${direction}`,
    group: LAYOUT_KEYBIND_GROUP,
    label: `move the tile ${direction}`,
    keys: [`Mod+Shift+${arrow}`],
    order: 10 + index,
    requiresPanel: true,
    run: ({ api, panel }) => {
      if (panel) moveInDirection(api, panel, direction, tiling(api));
    },
  }),
);

/**
 * `Mod+1` … `Mod+9`: straight to the nth tile in layout order.
 *
 * Only the first is listed. Nine near-identical rows would swamp the section
 * and say nine times what one row says once — and the reference modal is the
 * thing that has to stay short, not the accelerator table.
 */
const FOCUS_TILE_ACTIONS: readonly DockAction[] = Array.from(
  { length: 9 },
  (_, index) => {
    const position = index + 1;
    return {
      id: `focus.tile${position}`,
      group: FOCUS_KEYBIND_GROUP,
      label:
        position === 1
          ? "focus tile 1 … 9, in layout order"
          : `focus tile ${position}`,
      keys: [`Mod+${position}`],
      order: 30 + index,
      requiresPanel: false,
      hidden: position !== 1,
      menu: false,
      run: ({ api }) => {
        focusTileAt(api, position);
      },
    };
  },
);

/**
 * Steps the rotation, in either direction.
 *
 * `tiling(api)` first so a dragged master edge is adopted before the shape
 * changes — the new shape has different slots and cannot carry the sizes
 * across, but it can at least start from the proportion the user last chose.
 */
function rotate(api: DockviewApi, delta: number): void {
  tiling(api);
  useLayoutStore.getState().rotateArrangement(delta, api.groups.length);
  retile(api, storedTiling());
}

export const DOCK_ACTIONS: readonly DockAction[] = [
  {
    id: "focus.next",
    group: FOCUS_KEYBIND_GROUP,
    // On the arrows rather than the bracket keys they started on: with the
    // directional four gone, plain `Mod`+arrow is free and is where a hand
    // goes looking for "next". Cycling reaches tabs stacked behind other
    // tabs, which is the one thing `Mod+1 … 9` cannot.
    label: "focus next tile or tab",
    keys: ["Mod+ArrowRight"],
    order: 20,
    requiresPanel: false,
    menu: false,
    run: ({ api }) => cycleFocus(api, 1),
  },
  {
    id: "focus.previous",
    group: FOCUS_KEYBIND_GROUP,
    label: "focus previous tile or tab",
    keys: ["Mod+ArrowLeft"],
    order: 21,
    requiresPanel: false,
    menu: false,
    run: ({ api }) => cycleFocus(api, -1),
  },
  ...FOCUS_TILE_ACTIONS,

  ...MOVE_DIRECTION_ACTIONS,
  {
    id: "layout.nextArrangement",
    group: LAYOUT_KEYBIND_GROUP,
    label: "next screen arrangement",
    keys: ["Mod+Enter"],
    order: 20,
    requiresPanel: false,
    run: ({ api }) => rotate(api, 1),
  },
  {
    id: "layout.previousArrangement",
    group: LAYOUT_KEYBIND_GROUP,
    label: "previous screen arrangement",
    keys: ["Mod+Shift+Enter"],
    order: 21,
    requiresPanel: false,
    menu: false,
    run: ({ api }) => rotate(api, -1),
  },
  {
    id: "layout.makeMaster",
    group: LAYOUT_KEYBIND_GROUP,
    // `Home` because that is exactly what this does — move the tile to the
    // first slot in the order. `Mod+Enter` used to hold it and now drives the
    // rotation; `Mod+M` was never available, since macOS claims it to minimise
    // the window before the webview sees it.
    label: "make tile master",
    keys: ["Mod+Home"],
    order: 30,
    requiresPanel: true,
    run: ({ api, panel }) => {
      if (panel) swapWithMaster(api, panel, tiling(api));
    },
  },
  {
    id: "layout.toggleMonocle",
    group: LAYOUT_KEYBIND_GROUP,
    // Not `Mod+M`: that is the macOS minimise-window accelerator and the
    // native menu claims it before the webview sees the key.
    label: "toggle monocle",
    keys: ["Mod+Shift+M"],
    order: 50,
    requiresPanel: true,
    run: ({ api, panel }) => {
      // Maximisation is per group, so target the tile the caller named rather
      // than whatever happens to be focused.
      if (panel && !api.hasMaximizedGroup()) panel.api.setActive();
      toggleMonocle(api);
    },
  },
  {
    id: "layout.retile",
    group: LAYOUT_KEYBIND_GROUP,
    label: "retile (restore the tiled layout)",
    keys: ["Mod+Shift+R"],
    order: 80,
    requiresPanel: false,
    run: ({ api }) => retile(api, tiling(api)),
  },
  {
    id: "layout.cycleGap",
    group: LAYOUT_KEYBIND_GROUP,
    // One wrapping key rather than a widen/narrow pair: the gap is a
    // preference you set once, and `GAP_STEPS` is short enough that coming
    // back round to a value you overshot is quick.
    label: "cycle gap between tiles",
    keys: ["Mod+Shift+G"],
    order: 90,
    requiresPanel: false,
    menu: false,
    run: () => useLayoutStore.getState().cycleGap(1),
  },
  {
    id: "layout.closeTile",
    group: LAYOUT_KEYBIND_GROUP,
    label: "close tile",
    keys: ["Mod+W"],
    order: 100,
    requiresPanel: true,
    run: ({ panel }) => panel?.api.close(),
  },
];
