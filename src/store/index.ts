/**
 * Zustand stores: client list, layout state, preferences, clipboard history.
 * Layout and toolbar state arrived with phase 02; clipboard with phase 06.
 */

export { clientLabel, isClientPending, useWorkspaceStore } from "./workspace";
export type { ClientProblem, RestoredClient, WorkspaceClient } from "./workspace";

export { gapForIndex, useLayoutStore } from "./layout";

export { sortToolbarControls, useToolbarStore } from "./toolbar";
