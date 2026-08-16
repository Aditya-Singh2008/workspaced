/**
 * Shell layout preferences and transient shell UI state.
 *
 * Deliberately *not* the tiling layout itself — that lives in dockview, which
 * owns split geometry and serializes it (AGENTS.md: no hand-rolled layout
 * math, and no second source of truth for it either). What is here is the
 * handful of values the shell decides and dockview reads back: the gap between
 * groups, whether the sidebar is showing, whether the keybind reference is
 * open, and a mirror of dockview's monocle state so the toolbar and context
 * menu can render the right label.
 */

import { create } from "zustand";

import type { SidebarPanelId } from "../shell/sidebar/panels";
import { cycleGapIndex, DEFAULT_GAP_INDEX, GAP_STEPS } from "../shell/docking/theme";
import {
  clampMasterFraction,
  DEFAULT_TILING_PARAMS,
  rotateArrangement,
  type TilingParams,
} from "../shell/docking/tiling";

interface LayoutState {
  /** Index into `GAP_STEPS`, not a pixel value: only declared gaps are reachable. */
  readonly gapIndex: number;
  readonly sidebarVisible: boolean;
  /**
   * Which of the sidebar's lower panels is showing.
   *
   * Shell state rather than the tab strip's own, because phase 06 gave two of
   * those panels entry points outside the sidebar — see
   * `shell/sidebar/panels.ts`. The strip still falls back when the focused tile
   * does not offer the selected panel; this is the request, not the resolution.
   */
  readonly sidebarPanel: SidebarPanelId;
  readonly keybindReferenceOpen: boolean;
  /**
   * Whether the command palette overlay is up.
   *
   * Beside `keybindReferenceOpen` because it is the same kind of thing: a
   * transient, workspace-wide overlay that several places need to open and that
   * nothing else in the app needs to know the internals of.
   */
  readonly commandPaletteOpen: boolean;
  /**
   * Mirrors `DockviewApi.hasMaximizedGroup()`. dockview stays authoritative;
   * this copy exists so React can render a label from it.
   */
  readonly monocle: boolean;

  /**
   * How many *tiles* the dock is showing, mirrored from dockview.
   *
   * Not the same as the number of open files: a tab stack is several panels in
   * one tile. The rotation's length depends on the tile count, so the status
   * bar has to count the same things the rotation does or the two disagree
   * about which arrangement is which.
   */
  readonly tileCount: number;
  setTileCount(count: number): void;

  /**
   * The two numbers the tiled layout is derived from. They live here rather
   * than in dockview because they are a *preference* that outlives any one
   * arrangement — the layout is recomputed from them, never the other way
   * round. See `shell/docking/tiling.ts`.
   */
  readonly tiling: TilingParams;

  /**
   * Steps to the next (or previous) distinct way of dividing the screen.
   *
   * This is the only control over the shape. It replaced a layout cycle, a
   * master-count pair and a master-width pair — five bindings between them,
   * three of which the Linux desktop swallowed before the app saw them — with
   * one rotation through arrangements that are guaranteed to look different
   * from each other. Needs the tile count because how many distinct shapes
   * exist depends on how many tiles there are.
   */
  rotateArrangement(delta: number, tileCount: number): void;

  /**
   * Adopts a master fraction the user produced by dragging the divider rather
   * than by pressing a key, so the two ways of setting it cannot disagree.
   * See `readMasterFraction` in `shell/docking/tiling.ts`.
   */
  setMasterFraction(fraction: number): void;

  cycleGap(delta: number): void;
  toggleSidebar(): void;
  setSidebarVisible(visible: boolean): void;
  setSidebarPanel(panel: SidebarPanelId): void;
  /** Shows the sidebar and selects a panel in one call — what every caller wants. */
  revealSidebarPanel(panel: SidebarPanelId): void;
  setKeybindReferenceOpen(open: boolean): void;
  toggleKeybindReference(): void;
  setCommandPaletteOpen(open: boolean): void;
  toggleCommandPalette(): void;
  setMonocle(monocle: boolean): void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  gapIndex: DEFAULT_GAP_INDEX,
  sidebarVisible: false,
  sidebarPanel: "views",
  keybindReferenceOpen: false,
  commandPaletteOpen: false,
  monocle: false,
  tileCount: 0,
  tiling: DEFAULT_TILING_PARAMS,

  setTileCount(tileCount) {
    set((state) => (state.tileCount === tileCount ? state : { tileCount }));
  },

  rotateArrangement(delta, tileCount) {
    set((state) => ({
      tiling: { ...state.tiling, ...rotateArrangement(state.tiling, tileCount, delta) },
    }));
  },

  setMasterFraction(fraction) {
    set((state) => ({
      tiling: { ...state.tiling, masterFraction: clampMasterFraction(fraction) },
    }));
  },

  cycleGap(delta) {
    set((state) => ({ gapIndex: cycleGapIndex(state.gapIndex, delta) }));
  },

  toggleSidebar() {
    set((state) => ({ sidebarVisible: !state.sidebarVisible }));
  },

  setSidebarVisible(sidebarVisible) {
    set({ sidebarVisible });
  },

  setSidebarPanel(sidebarPanel) {
    set({ sidebarPanel });
  },

  revealSidebarPanel(sidebarPanel) {
    set({ sidebarPanel, sidebarVisible: true });
  },

  setKeybindReferenceOpen(keybindReferenceOpen) {
    set({ keybindReferenceOpen });
  },

  toggleKeybindReference() {
    set((state) => ({ keybindReferenceOpen: !state.keybindReferenceOpen }));
  },

  setCommandPaletteOpen(commandPaletteOpen) {
    set({ commandPaletteOpen });
  },

  toggleCommandPalette() {
    set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen }));
  },

  setMonocle(monocle) {
    set({ monocle });
  },
}));

/** The gap in pixels, for handing to dockview. */
export function gapForIndex(index: number): number {
  return GAP_STEPS[index] ?? GAP_STEPS[DEFAULT_GAP_INDEX]!;
}
