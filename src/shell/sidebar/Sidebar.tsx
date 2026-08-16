/**
 * The sidebar shell.
 *
 * Phase 02 needs somewhere for the toolbar's sidebar toggle to point, and the
 * only sidebar content that is file-type agnostic today is the list of what is
 * open. So that is all this is: a list, focusing a tile on click. It is also
 * the second mouse-reachable path to focusing a specific tile, alongside
 * clicking the tile itself.
 *
 * Phase 03 added the second half: previews of whatever the focused tile is
 * divided into, through `ViewerInstance.thumbnail` and nothing else — see
 * `SubdivisionRail.tsx`. Phase 05a added the annotation list beside it, and
 * `SidebarPanels.tsx` is the tab strip that chooses between the two. Phase 06
 * adds search results and the clipboard scratch panel the same way.
 *
 * The open-files list still takes the free space and the panels are capped below
 * it, rather than the other way round: a tile whose plugin has neither previews
 * nor annotations (the fallback viewer) must not leave a band of empty sidebar
 * where they would have been.
 */

import { SidebarPanels } from "./SidebarPanels";
import { clientLabel, useWorkspaceStore } from "../../store";

export function Sidebar() {
  const clients = useWorkspaceStore((state) => state.clients);
  const activeClientId = useWorkspaceStore((state) => state.activeClientId);
  const setActiveClient = useWorkspaceStore((state) => state.setActiveClient);
  const closeClient = useWorkspaceStore((state) => state.closeClient);

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-border bg-surface">
      <header className="shrink-0 border-b border-border px-2 py-1 text-muted">
        open files
      </header>

      <div className="min-h-0 grow overflow-y-auto">
        {clients.length === 0 ? (
          <p className="px-2 py-1 text-muted">nothing open</p>
        ) : (
          clients.map((client) => {
            const isActive = client.id === activeClientId;
            const label = clientLabel(client);
            return (
              <div
                key={client.id}
                className={
                  isActive
                    ? "flex items-center gap-1 border-l border-l-accent bg-surface-raised pl-2 pr-1 text-fg"
                    : "flex items-center gap-1 border-l border-l-transparent pl-2 pr-1 text-muted hover:bg-surface-hover"
                }
              >
                <button
                  type="button"
                  onClick={() => setActiveClient(client.id)}
                  title={client.path ?? label}
                  className="min-w-0 grow truncate py-1 text-left"
                >
                  {label}
                </button>
                <button
                  type="button"
                  onClick={() => closeClient(client.id)}
                  aria-label={`close ${label}`}
                  className="shrink-0 px-1 text-muted hover:text-fg"
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      <SidebarPanels />
    </aside>
  );
}
