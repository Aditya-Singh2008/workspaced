/**
 * The docking library, hosting the workspace.
 *
 * dockview owns split/stack/resize geometry entirely: this component only
 * keeps two lists in step — the workspace clients in the Zustand store, and
 * the panels in the dock — and forwards keyboard actions to `layout.ts`.
 * There is no geometry here and no pointer handling.
 *
 * Everything phase 02 requires of the library is native, none of it
 * reimplemented here:
 *
 *   - horizontal and vertical splits — `addPanel({ position })`, and dragging
 *     a tile onto any edge of another;
 *   - drag-to-dock with a live drop-zone indicator — dockview's own overlay,
 *     themed through `--dv-*` in `src/theme/theme.css`;
 *   - drag-to-stack as tabs — dropping onto a group's header or centre;
 *   - resizable dividers with a minimum panel size — dockview's sashes;
 *   - programmatic construction and serialization — `addPanel`, `toJSON`,
 *     `fromJSON`, which is also how `tiling.ts` derives the tiled layout.
 *
 * Three options are deliberate rather than default:
 *
 *   - `dndStrategy: "pointer"` drives drag-and-drop from pointer events on
 *     every platform instead of HTML5 drag-and-drop. AGENTS.md flags Linux's
 *     webkit2gtk as the likeliest source of divergence, and HTML5 DnD is one
 *     of the places it diverges; pointer events behave the same across
 *     webkit2gtk, WebView2 and WKWebView.
 *   - `defaultRenderer: "always"` keeps a tabbed-behind tile mounted. Panels
 *     hold decoders and canvases; unmounting one because it moved behind a tab
 *     would throw that work away and re-run it on every tab switch.
 *   - `disableFloatingGroups` — freeform tiling is a grid; floating and popout
 *     windows are a different interaction model and are not part of this app.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewWillShowOverlayLocationEvent,
  type GroupNavigationDirection,
  type IDockviewHeaderActionsProps,
  type IWatermarkPanelProps,
  type Position,
} from "dockview-react";

import { formatAcceleratorSpec } from "../keybinds";
import { provideSessionLayout, requestSessionSave, takeRestoredLayout } from "../../persistence";
import { clientLabel, gapForIndex, useLayoutStore, useWorkspaceStore } from "../../store";
import { DOCK_ACTIONS } from "./actions";
import { setWorkspaceDockApi } from "./api";
import { applyRestoredLayout, applyTiling } from "./layout";
import { workspaceDockviewTheme } from "./theme";
import { isDockActionAvailable } from "./useDockKeybinds";
import { ViewerPanel, VIEWER_PANEL_COMPONENT, type ViewerPanelParams } from "./ViewerPanel";

/** Stable identity: dockview re-reads this map whenever it changes. */
const PANEL_COMPONENTS = { [VIEWER_PANEL_COMPONENT]: ViewerPanel };

/** Drop position -> the spatial direction it would place the tile in. */
const DROP_DIRECTION: Partial<Record<Position, GroupNavigationDirection>> = {
  left: "left",
  right: "right",
  top: "up",
  bottom: "down",
};

function Watermark(_props: IWatermarkPanelProps) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg text-muted">
      empty tile
    </div>
  );
}

/**
 * The per-tile monocle button, at the right-hand end of every tab strip.
 *
 * Monocle was keyboard-and-context-menu only, which makes the single most
 * reversible action in the workspace the least visible one. A button on the
 * strip it applies to is where a user looks for "make this bigger", and it is
 * a toggle rather than an action, so it also *reports* the state — the tile
 * that is filling the workspace is the one showing the button lit.
 *
 * `[M]` is dwm's monocle glyph, the same one the status bar shows, so the two
 * indicators read as the same idea rather than two unrelated marks.
 */
function TileActions(props: IDockviewHeaderActionsProps) {
  const monocle = useLayoutStore((state) => state.monocle);
  // Only the maximized group is lit; the others offer to take its place.
  const maximized = monocle && props.api.isMaximized();

  return (
    <button
      type="button"
      // Keeps the drag-a-tile-by-its-strip gesture from starting on the button.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => {
        if (props.containerApi.hasMaximizedGroup()) {
          props.containerApi.exitMaximizedGroup();
          if (!maximized) props.api.maximize();
        } else {
          props.api.maximize();
        }
      }}
      aria-pressed={maximized}
      title={maximized ? "restore the other tiles" : "fill the workspace with this tile"}
      className={
        maximized
          ? "mx-1 border border-border-accent px-1 text-fg"
          : "mx-1 border border-transparent px-1 text-disabled hover:border-border-strong hover:text-fg"
      }
    >
      [M]
    </button>
  );
}

/**
 * Whether a drop would leave the layout exactly as it is.
 *
 * dockview offers a drop zone on every edge of every tile, including the ones
 * that describe where the dragged tile already is — with two tiles side by
 * side, "drop on the right half of the left tile" and "drop on the left half
 * of the right tile" both mean *stay put*. Those zones light up a quarter of
 * the window and then do nothing, which reads as a broken drag.
 *
 * Suppressing the overlay also suppresses the drop, so the zone stops existing
 * rather than becoming a silent no-op.
 */
function isNoOpDrop(
  event: DockviewWillShowOverlayLocationEvent,
  api: DockviewApi,
): boolean {
  const data = event.getData();
  if (!data) return false;

  const source = api.getGroup(data.groupId);
  if (!source) return false;

  // Pulling one tab out of a stack always changes something, wherever it
  // lands. Only a whole tile moving can be a no-op.
  const movingWholeTile = data.panelId === undefined || source.panels.length === 1;
  if (!movingWholeTile) return false;

  // The only tile there is has nowhere to go.
  if (api.groups.length === 1) return true;

  const target = event.group;
  if (!target) return false;

  // Onto itself, at any position.
  if (target.id === source.id) return true;

  // Stacking two different tiles is always a real change.
  if (event.position === "center") return false;

  const direction = DROP_DIRECTION[event.position];
  if (!direction) return false;

  // "Put it on this side of that tile" — where it already is.
  return api.adjacentGroupInDirection(target, direction)?.id === source.id;
}

export function DockingWorkspace() {
  const clients = useWorkspaceStore((state) => state.clients);
  const activeClientId = useWorkspaceStore((state) => state.activeClientId);
  const setActiveClient = useWorkspaceStore((state) => state.setActiveClient);
  const closeClient = useWorkspaceStore((state) => state.closeClient);

  const gapIndex = useLayoutStore((state) => state.gapIndex);
  const setMonocle = useLayoutStore((state) => state.setMonocle);
  const setTileCount = useLayoutStore((state) => state.setTileCount);

  const [api, setApi] = useState<DockviewApi | null>(null);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    setApi(event.api);
  }, []);

  // Published for the keybinds, which the app shell registers so they stay
  // listed in the reference modal even with nothing open. Cleared on unmount so
  // they correctly report themselves unavailable in the empty state.
  useEffect(() => {
    setWorkspaceDockApi(api);
    // The persistence layer's view of the grid: a function it calls when it is
    // about to write, rather than a snapshot pushed on every layout event.
    // Cleared on unmount, which is how "the workspace is empty" gets recorded.
    provideSessionLayout(api ? () => api.toJSON() : null);
    return () => {
      setWorkspaceDockApi(null);
      provideSessionLayout(null);
    };
  }, [api]);

  // --- dock -> shell -------------------------------------------------------

  useEffect(() => {
    if (!api) return;

    const subscriptions = [
      api.onDidActivePanelChange((event) => {
        setActiveClient(event.panel?.id ?? null);
      }),

      api.onDidRemovePanel((panel) => {
        // dockview also fires this while *moving* a panel between groups, and
        // on every re-tile, which re-parents each panel through a temporary
        // group. The removal is only real if the panel is still gone once the
        // current operation has finished putting it back.
        const id = panel.id;
        queueMicrotask(() => {
          if (!api.getPanel(id)) closeClient(id);
        });
      }),

      api.onDidMaximizedGroupChange(() => {
        setMonocle(api.hasMaximizedGroup());
      }),

      // Tiles, not panels: stacking two files as tabs makes one tile out of
      // two clients, and the rotation's length is counted in tiles.
      api.onDidLayoutChange(() => {
        setTileCount(api.groups.length);
        // Every meaningful change to the arrangement — added, removed, resized,
        // rearranged — reaches this one event, including each frame of a sash
        // drag. Cheap on purpose: the request is a flag, and the grid is not
        // serialized until the debounce elapses (`persistence/session.ts`).
        requestSessionSave();
      }),

      api.onWillShowOverlay((event) => {
        if (isNoOpDrop(event, api)) event.preventDefault();
      }),
    ];

    return () => {
      for (const subscription of subscriptions) subscription.dispose();
    };
  }, [api, setActiveClient, closeClient, setMonocle, setTileCount]);

  // --- shell -> dock -------------------------------------------------------

  // Clients are the source of truth for *which* tiles exist; the tiling model
  // decides where they sit. A newly opened file joins the end of the tile
  // order and the layout is re-derived, so opening files always produces the
  // same arrangement rather than depending on which tile happened to be
  // focused at the time.
  //
  // Closing does not re-tile: dockview reflows the survivors correctly on its
  // own, and rearranging tiles the user did not touch would be a surprise.
  useEffect(() => {
    if (!api) return;

    let added = false;

    for (const client of clients) {
      if (api.getPanel(client.id)) continue;

      // Every tile gets its own group; the re-tile below places it. Without a
      // direction the panel would join the focused group as a tab, and the
      // tiling model would faithfully preserve a stack the user never asked
      // for.
      const reference = api.activeGroup ?? api.groups[0];

      api.addPanel<ViewerPanelParams>({
        id: client.id,
        component: VIEWER_PANEL_COMPONENT,
        title: clientLabel(client),
        params: { clientId: client.id },
        renderer: "always",
        ...(reference
          ? { position: { referenceGroup: reference, direction: "right" } }
          : {}),
      });
      added = true;
    }

    for (const panel of [...api.panels]) {
      if (!clients.some((client) => client.id === panel.id)) panel.api.close();
    }

    if (!added) return;

    // A restored session brings its own grid, and it is the whole point of the
    // phase that it is applied instead of being derived: the arrangement is
    // what the user built, including any freehand drag the tiling model would
    // normalize away. It is taken once — a later file opened by hand re-tiles
    // like it always did.
    const restored = takeRestoredLayout();
    if (restored && applyRestoredLayout(api, restored)) return;

    // Read at call time rather than through the dependency list: the layout
    // actions re-tile on their own when these change, and re-tiling here as
    // well would fight them.
    applyTiling(api, useLayoutStore.getState().tiling);
  }, [api, clients]);

  useEffect(() => {
    if (!api || !activeClientId) return;
    const panel = api.getPanel(activeClientId);
    if (!panel) return;
    if (panel.api.isActive && panel.api.isGroupActive) return;
    panel.api.setActive();
  }, [api, activeClientId]);

  // A tab's label follows what its viewer says it is showing, which for a plugin
  // that can navigate within a tile (folder browsing) is not the file it was
  // opened with. Separate from the effect that creates panels, because a rename
  // is not a membership change and must not re-tile.
  useEffect(() => {
    if (!api) return;
    for (const client of clients) {
      const panel = api.getPanel(client.id);
      const label = clientLabel(client);
      if (panel && panel.title !== label) panel.api.setTitle(label);
    }
  }, [api, clients]);

  // --- mouse ---------------------------------------------------------------

  // The same actions the keybinds run (see `useDockKeybinds`), targeting the
  // tile that was right-clicked instead of the focused one. This is the
  // discovery path phase 02 requires: no layout action is keyboard-only.
  const getTabContextMenuItems = useCallback<
    NonNullable<React.ComponentProps<typeof DockviewReact>["getTabContextMenuItems"]>
  >(
    ({ panel, api: menuApi }) => [
      // `menu: false` opts an action out — the directional focus family, the
      // numbered tile jumps and the dock-wide nudges, none of which are about
      // the tile that was right-clicked. Everything is still in the reference
      // modal, which is the discovery path phase 02 actually requires.
      ...DOCK_ACTIONS.filter((action) => action.menu !== false).map((action) => ({
        label: `${action.label}  ${formatAcceleratorSpec(action.keys[0]!)}`,
        disabled: !isDockActionAvailable(action, menuApi),
        action: () => action.run({ api: menuApi, panel }),
      })),
      "separator" as const,
      "closeOthers" as const,
      "closeAll" as const,
    ],
    [],
  );

  const theme = useMemo(
    () => workspaceDockviewTheme(gapForIndex(gapIndex)),
    [gapIndex],
  );

  return (
    <DockviewReact
      className="h-full w-full"
      components={PANEL_COMPONENTS}
      watermarkComponent={Watermark}
      onReady={onReady}
      theme={theme}
      rightHeaderActionsComponent={TileActions}
      defaultRenderer="always"
      dndStrategy="pointer"
      disableFloatingGroups
      noPanelsOverlay="watermark"
      getTabContextMenuItems={getTabContextMenuItems}
    />
  );
}
