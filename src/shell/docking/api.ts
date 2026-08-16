/**
 * The live `DockviewApi`, reachable from outside the component that owns it.
 *
 * There is exactly one dock in the app, and its API is not serializable and
 * must not trigger re-renders — the same reasoning that keeps viewer instances
 * out of the Zustand store (`viewers/instances.ts`). So it lives here, in a
 * plain module-level slot, set by `DockingWorkspace` while it is mounted.
 *
 * The reason this exists rather than the component keeping it to itself: the
 * layout keybinds are registered by the app shell, not by the dock, so that
 * they are listed in the keybind reference whether or not anything is open.
 * A binding with nothing to act on reports itself unavailable; it does not
 * vanish from the reference.
 */

import type { DockviewApi } from "dockview-react";

let current: DockviewApi | null = null;

export function setWorkspaceDockApi(api: DockviewApi | null): void {
  current = api;
}

/** `null` whenever the workspace is showing the empty state. */
export function workspaceDockApi(): DockviewApi | null {
  return current;
}
