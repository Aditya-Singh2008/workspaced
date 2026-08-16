/**
 * The tiled workspace region.
 *
 * Phase 01's single-surface stand-in is gone: the client list is dockview
 * panels and the tab strip is dockview's own. Nothing about splitting,
 * stacking or resizing lives here — see `shell/docking/`.
 */

import { DockingWorkspace } from "../shell/docking";

export function Workspace() {
  return <DockingWorkspace />;
}
