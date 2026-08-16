/**
 * Binds the layout actions to the keyboard.
 *
 * Called by the app shell rather than by `DockingWorkspace`, so the bindings
 * are registered — and therefore listed in the keybind reference — even with
 * nothing open. Each one reports itself unavailable when there is no dock or
 * no focused tile, which greys it out in the reference and leaves the key
 * press for anything else that wants it.
 */

import { useMemo } from "react";

import type { DockviewApi } from "dockview-react";

import { useKeybinds } from "../keybinds";
import { workspaceDockApi } from "./api";
import { DOCK_ACTIONS, type DockAction } from "./actions";

/** A tile action needs a tile; the dock-wide ones only need a dock. */
export function isDockActionAvailable(
  action: DockAction,
  api: DockviewApi | null,
): boolean {
  if (!api) return false;
  return !action.requiresPanel || api.activePanel !== undefined;
}

export function useDockKeybinds(): void {
  const definitions = useMemo(
    () =>
      DOCK_ACTIONS.map((action) => ({
        id: action.id,
        group: action.group,
        label: action.label,
        keys: action.keys,
        order: action.order,
        hidden: action.hidden,
        enabled: () => isDockActionAvailable(action, workspaceDockApi()),
        run: () => {
          const api = workspaceDockApi();
          if (api) action.run({ api, panel: api.activePanel });
        },
      })),
    [],
  );

  useKeybinds(definitions);
}
