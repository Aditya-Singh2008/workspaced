/**
 * Docking library integration.
 *
 * All tiling, splitting and resizing goes through dockview — no hand-rolled
 * layout math (AGENTS.md, non-negotiable constraints). `DockingWorkspace` is
 * the only component that talks to the library; `layout.ts` is the only place
 * that defines what "master" means against its model.
 *
 * Phase 07 wired the layout into the session record through the same two calls
 * every layout action already used: `toJSON` is handed to `persistence/` as a
 * function it may call when it is about to write, and a restored grid comes
 * back through `applyRestoredLayout`.
 */

export { DockingWorkspace } from "./DockingWorkspace";
export { DOCK_ACTIONS, FOCUS_KEYBIND_GROUP, LAYOUT_KEYBIND_GROUP } from "./actions";
export type { DockAction, DockActionContext } from "./actions";
export { workspaceDockApi } from "./api";
export { isDockActionAvailable, useDockKeybinds } from "./useDockKeybinds";
export {
  applyRestoredLayout,
  applyTiling,
  cycleFocus,
  findMasterGroup,
  focusTileAt,
  isMasterPanel,
  moveInDirection,
  retile,
  swapWithMaster,
  tileOrder,
  toggleMonocle,
} from "./layout";
export type { TileDirection } from "./layout";

export {
  clampMasterFraction,
  DEFAULT_TILING_PARAMS,
  hasMasterArea,
  LAYOUT_MODES,
  layoutModeInfo,
  MAX_MASTER_FRACTION,
  MIN_MASTER_FRACTION,
  readMasterFraction,
  readTiles,
  reorderTiles,
  tileGrid,
  tileLayout,
} from "./tiling";
export type { LayoutMode, LayoutModeInfo, TileState, TilingParams } from "./tiling";
export {
  DEFAULT_GAP_INDEX,
  GAP_STEPS,
  cycleGapIndex,
  workspaceDockviewTheme,
  WORKSPACE_DOCKVIEW_THEME_CLASS,
} from "./theme";
export { VIEWER_PANEL_COMPONENT } from "./ViewerPanel";
export type { ViewerPanelParams } from "./ViewerPanel";
