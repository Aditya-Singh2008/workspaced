/**
 * The layout actions, applied to a live dock.
 *
 * `tiling.ts` decides what a layout should look like; this file is the thin
 * bridge that reads the current one out of dockview, asks for the new shape,
 * and hands it back. Every action follows the same three steps, which is why
 * none of them can leave the grid in a state the others cannot recover from:
 *
 *     const current = api.toJSON()          // dockview's own serialization
 *     const next    = tileLayout(current, params, order)
 *     api.fromJSON(next, { reuseExistingPanels: true })
 *
 * The `reuseExistingPanels` flag is load-bearing: dockview re-parents the live
 * panel objects instead of recreating them, so re-tiling never remounts a
 * viewer. A PDF keeps its decoded pages across a promote.
 *
 * ## What "master" means here
 *
 * The first tile in the order — the top-left one, filling the master column.
 * Because the layout is derived from that order rather than accumulated by
 * moves, the definition holds no matter how the user got to the current
 * arrangement, including by dragging tiles around freehand.
 *
 * ## Freeform arrangements
 *
 * Dragging a tile onto another's edge still does whatever dockview does — this
 * module is not consulted. The layout actions below *normalize*: they replace
 * whatever is on screen with the derived tiling, preserving tile order, tab
 * stacks and focus. That is the deal, and it is what makes the arrangement
 * always recoverable: one keystroke returns any layout to a clean master and
 * stack.
 */

import type {
  DockviewApi,
  DockviewGroupPanel,
  GroupNavigationDirection,
  IDockviewGroupPanel,
  IDockviewPanel,
  SerializedDockview,
} from "dockview-react";

import { readTiles, tileLayout, type TilingParams } from "./tiling";

/**
 * A spatial direction, in dockview's own vocabulary so it can be passed
 * straight to `adjacentGroupInDirection` without a translation table.
 */
export type TileDirection = GroupNavigationDirection;

/**
 * Replaces the layout with the tiling derived from `order` (or the current
 * visual order) and the given parameters.
 *
 * Monocle is exited first: a maximized grid serializes as a special case, and
 * re-tiling underneath it would leave the two disagreeing about what is
 * visible.
 */
export function applyTiling(
  api: DockviewApi,
  params: TilingParams,
  order?: readonly string[],
): void {
  if (api.panels.length === 0) return;
  if (api.hasMaximizedGroup()) api.exitMaximizedGroup();

  const current = api.toJSON();
  api.fromJSON(tileLayout(current, params, order), { reuseExistingPanels: true });
}

/**
 * Applies a grid that came from a previous session, reporting whether it took.
 *
 * The same `fromJSON` every layout action ends with, and the same
 * `reuseExistingPanels` — the panels already exist here too, created by the
 * effect that mirrors clients into the dock, so this re-parents them rather
 * than remounting a viewer that has just started loading its file.
 *
 * It returns a boolean because the caller has a fallback worth taking. A layout
 * from an older dockview, or one damaged in the file, would otherwise leave the
 * workspace with a grid it cannot draw; re-deriving the tiling instead loses
 * the arrangement and keeps every tile, which is the right way round. (The
 * record's own reader has already checked that the panel ids match the tiles —
 * this is the case it cannot check, which is dockview's opinion of its own
 * serialization.)
 */
export function applyRestoredLayout(api: DockviewApi, layout: SerializedDockview): boolean {
  try {
    api.fromJSON(layout, { reuseExistingPanels: true });
    return true;
  } catch (thrown) {
    console.error("[docking] the restored layout could not be applied", thrown);
    return false;
  }
}

/** The tile ids of the live layout, master first. */
export function tileOrder(api: DockviewApi): readonly string[] {
  return readTiles(api.toJSON().grid).map((tile) => tile.id);
}

/**
 * The master group: the first tile in the order.
 *
 * Falls back to the first group dockview knows about, which only matters
 * before the first layout has been serialized.
 */
export function findMasterGroup(api: DockviewApi): DockviewGroupPanel | undefined {
  const [id] = tileOrder(api);
  return (id ? api.groups.find((group) => group.id === id) : undefined) ?? api.groups[0];
}

export function isMasterPanel(api: DockviewApi, panel: IDockviewPanel): boolean {
  return findMasterGroup(api)?.id === panel.group.id;
}

/** Moves focus to the next / previous tile, panels within a stack included. */
export function cycleFocus(api: DockviewApi, direction: 1 | -1): void {
  if (direction === 1) api.moveToNext({ includePanel: true });
  else api.moveToPrevious({ includePanel: true });
}

/**
 * Gives a tile focus by way of whichever of its panels is on top.
 *
 * Typed against the interface rather than the class because that is what
 * `adjacentGroupInDirection` hands back; a tab stack focuses its visible panel
 * rather than silently switching tabs underneath the user.
 */
function focusGroup(group: IDockviewGroupPanel | undefined): boolean {
  const panel = group?.activePanel ?? group?.panels[0];
  if (!panel) return false;
  panel.api.setActive();
  return true;
}

/**
 * Focuses the nth tile, counting from 1 in the layout's own reading order —
 * master first, then the stack, each band in turn.
 *
 * Reports whether it landed, so a number past the end of the order leaves
 * focus alone rather than silently doing nothing visible. This is the main
 * reason the tile order is worth keeping stable across every other action:
 * a tile that moved because something unrelated happened would make the
 * numbers useless.
 */
export function focusTileAt(api: DockviewApi, position: number): boolean {
  const id = tileOrder(api)[position - 1];
  return id ? focusGroup(api.groups.find((group) => group.id === id)) : false;
}

/**
 * Moves a tile in a spatial direction, by exchanging it with its neighbour.
 *
 * The two halves of this are deliberately split between the library and the
 * model. dockview answers the spatial question — which tile is currently over
 * there — and the answer is turned into a *swap of two positions in the tile
 * order*, which the grid is then re-derived from. So it inherits the property
 * that makes swap safe: exactly two tiles change place and every other tile is
 * left exactly where it was, in any mode, however the arrangement was reached.
 *
 * The alternative, asking dockview to move the panel to a position relative to
 * another group, is the accumulating-moves approach the tiling model exists to
 * replace: it nests a branch per call and drifts away from a clean layout.
 */
export function moveInDirection(
  api: DockviewApi,
  panel: IDockviewPanel,
  direction: TileDirection,
  params: TilingParams,
): boolean {
  const neighbour = api.adjacentGroupInDirection(panel.group, direction);
  if (!neighbour || neighbour.id === panel.group.id) return false;

  const order = [...tileOrder(api)];
  const from = order.indexOf(panel.group.id);
  const to = order.indexOf(neighbour.id);
  // A tile the derived layout does not know about; nothing sensible to do.
  if (from < 0 || to < 0) return false;

  [order[from], order[to]] = [order[to]!, order[from]!];

  const focused = panel.id;
  applyTiling(api, params, order);
  restoreFocus(api, focused);
  return true;
}


/**
 * Re-derives the layout without changing anything else. The "put this back in
 * order" action — the way out of any arrangement, however it was reached.
 */
export function retile(api: DockviewApi, params: TilingParams): void {
  const focused = api.activePanel?.id;
  applyTiling(api, params);
  restoreFocus(api, focused);
}

/**
 * Makes a tile the master, exchanging it with whatever was there and leaving
 * every other tile where it is. A swap is two index changes in the order, so
 * unlike a pair of moves it cannot destroy a group or nest a branch.
 *
 * This replaced a pair of actions. dwm's `zoom` pushes the focused window to
 * the head of the list, which shifts the old master — and every tile below it
 * — down a slot; that is faithful to dwm and it is also the thing that makes
 * the arrangement feel like it rearranged itself. Both actions answered "make
 * this the master", so only the one that disturbs nothing else survived.
 */
export function swapWithMaster(
  api: DockviewApi,
  panel: IDockviewPanel,
  params: TilingParams,
): void {
  const order = [...tileOrder(api)];
  const index = order.indexOf(panel.group.id);
  // Already the master, or a tile the layout does not know about.
  if (index <= 0) return;

  [order[0], order[index]] = [order[index]!, order[0]!];

  const focused = panel.id;
  applyTiling(api, params, order);
  restoreFocus(api, focused);
}

/**
 * Monocle: the focused tile fills the workspace, the others hidden but
 * retained. dockview's group maximization is exactly this, restore included.
 */
export function toggleMonocle(api: DockviewApi): void {
  if (api.hasMaximizedGroup()) {
    api.exitMaximizedGroup();
    return;
  }
  const panel = api.activePanel;
  if (panel) api.maximizeGroup(panel);
}

/** `fromJSON` picks its own active panel; put focus back where the user had it. */
function restoreFocus(api: DockviewApi, panelId: string | undefined): void {
  if (!panelId) return;
  api.getPanel(panelId)?.api.setActive();
}
