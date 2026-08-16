/**
 * The dockview panel component: the bridge between a dock panel and a viewer
 * tile.
 *
 * It resolves the workspace client the panel stands for and reports whether
 * this tile currently holds focus. Everything below it — mounting the plugin,
 * rendering its failures — is `ViewerSurface`, which knows nothing about
 * docking, and everything above it is dockview, which knows nothing about
 * viewers.
 */

import { useEffect, useState } from "react";

import type { IDockviewPanelProps } from "dockview-react";

import { ViewerSurface } from "../../app/ViewerSurface";
import { useWorkspaceStore } from "../../store";

/** The component id registered with dockview. */
export const VIEWER_PANEL_COMPONENT = "viewer";

export interface ViewerPanelParams {
  /** Workspace-client id. The panel id is the same value. */
  readonly clientId: string;
  [key: string]: unknown;
}

export function ViewerPanel(props: IDockviewPanelProps<ViewerPanelParams>) {
  const clientId = props.params.clientId;
  const client = useWorkspaceStore((state) =>
    state.clients.find((candidate) => candidate.id === clientId),
  );

  // A tile is focused when it is the visible panel of its group *and* that
  // group is the active one — dockview tracks the two independently.
  const [focused, setFocused] = useState(
    () => props.api.isActive && props.api.isGroupActive,
  );

  useEffect(() => {
    const update = () => setFocused(props.api.isActive && props.api.isGroupActive);
    const subscriptions = [
      props.api.onDidActiveChange(update),
      props.api.onDidActiveGroupChange(update),
    ];
    update();
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [props.api]);

  // The panel outliving its client is a normal frame of the close sequence:
  // the store drops the client, then the effect that mirrors clients into
  // panels closes the panel.
  if (!client) return null;

  return <ViewerSurface client={client} focused={focused} />;
}
