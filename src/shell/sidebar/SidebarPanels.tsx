/**
 * The sidebar's lower half: what the focused tile has to show about itself, and
 * what the workspace has to show about all of them.
 *
 * Phase 03 put the subdivision rail here. Phase 05a added the annotation list
 * beside it, as the brief asks — "an Annotations tab […] alongside the existing
 * open-files list and the subdivision rail" — and the tab strip is what makes
 * "beside" possible in a 256px column. The open-files list above is untouched
 * and still takes the free space, because it answers a different question
 * ("what is open") from either of these ("what is *in* this one"), and phase 02
 * deliberately made those two visible at once.
 *
 * Phase 06 adds the last two, and they are a different kind of panel: search
 * results and the scratch panel are about the *workspace*, not the focused
 * tile. So they are always present — a fallback viewer with no previews and no
 * annotations still gets a search box — while the first two continue to appear
 * only when the focused instance reports the capability behind them. That is
 * also why which panel is showing became shell state (`store/layout.ts`): both
 * of the new ones can be opened by a keybind that runs whether or not this
 * component is mounted.
 *
 * Both original panels follow the split `SubdivisionRail.tsx` established and
 * this component enforces: the shell owns the chrome, the tabs and the layout;
 * the plugin owns the data, reached only through the contract. Nothing here
 * names a file type. A tab appears because the focused instance reports a
 * capability — `thumbnail` plus a `subdivisionCount` for one, `annotation` for
 * the other — so a video plugin that grows keyframes and comments gets both for
 * free.
 */

import { useSyncExternalStore } from "react";

import {
  getViewerInstance,
  subscribeToViewerInstances,
  viewerInstancesVersion,
} from "../../viewers";
import { useLayoutStore, useWorkspaceStore } from "../../store";
import { ScratchPanel } from "../clipboard";
import { SearchPanel } from "../search";
import { AnnotationList } from "./AnnotationList";
import { SubdivisionRail } from "./SubdivisionRail";
import type { SidebarPanelId } from "./panels";

export function SidebarPanels() {
  const activeClientId = useWorkspaceStore((state) => state.activeClientId);
  const panel = useLayoutStore((state) => state.sidebarPanel);
  const setPanel = useLayoutStore((state) => state.setSidebarPanel);

  // A tile mounts asynchronously: the store gains the client first and the
  // instance appears a moment later. Without this subscription a panel would
  // read "no instance" on the render that opening a file triggers and never
  // look again — an empty sidebar for a document that is plainly on screen.
  const instancesVersion = useSyncExternalStore(
    subscribeToViewerInstances,
    viewerInstancesVersion,
    viewerInstancesVersion,
  );

  const instance = activeClientId ? getViewerInstance(activeClientId) : undefined;
  const subdivisions = instance?.capabilities.subdivisionCount ?? 0;
  const hasViews = instance?.capabilities.thumbnail === true && subdivisions > 0;
  const hasNotes = instance?.capabilities.annotation === true;

  // Falling back rather than showing an empty frame: focusing a tile whose
  // plugin has no previews while the rail was open must land somewhere real.
  // The two workspace panels are always real, so this can only ever fall
  // *towards* them.
  const active: SidebarPanelId =
    (panel === "views" && !hasViews) || (panel === "notes" && !hasNotes)
      ? hasViews
        ? "views"
        : hasNotes
          ? "notes"
          : "search"
      : panel;

  // The resolution is deliberately *not* written back to the store. Focusing a
  // tile whose plugin has no previews should show search for as long as that
  // tile is focused, and show the rail again the moment a tile with previews
  // is — which is what phase 03 did, and what persisting the fallback would
  // quietly undo.

  return (
    <div className="flex max-h-[60%] min-h-0 shrink-0 flex-col border-t border-border">
      {/*
        Wrapping, since phase 06: four tabs do not fit across 256px, and the
        alternatives are worse than a second row — truncating a label ("scrat…")
        or breaking one across two lines ("3 / views"), both of which this
        strip did before `whitespace-nowrap` and `flex-wrap` were added. Three
        tabs or fewer still sit on one line, so a tile with no annotations looks
        exactly as it did.
      */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-1 py-1">
        {hasViews ? (
          <Tab
            label={subdivisions === 1 ? "1 view" : `${subdivisions} views`}
            active={active === "views"}
            onSelect={() => setPanel("views")}
          />
        ) : null}
        {hasNotes ? (
          <Tab
            label="annotations"
            active={active === "notes"}
            onSelect={() => setPanel("notes")}
          />
        ) : null}
        <Tab
          label="search"
          active={active === "search"}
          onSelect={() => setPanel("search")}
        />
        <Tab
          label="scratch"
          active={active === "scratch"}
          onSelect={() => setPanel("scratch")}
        />
      </header>

      {active === "views" && activeClientId ? (
        <SubdivisionRail
          key={`${activeClientId}:views`}
          clientId={activeClientId}
          count={subdivisions}
          instancesVersion={instancesVersion}
        />
      ) : null}
      {active === "notes" && activeClientId ? (
        <AnnotationList key={`${activeClientId}:notes`} clientId={activeClientId} />
      ) : null}
      {active === "search" ? <SearchPanel /> : null}
      {active === "scratch" ? <ScratchPanel /> : null}
    </div>
  );
}

function Tab({
  label,
  active,
  onSelect,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={
        active
          ? "shrink-0 whitespace-nowrap border-b border-b-accent text-fg"
          : "shrink-0 whitespace-nowrap border-b border-b-transparent text-muted hover:text-fg"
      }
    >
      {label}
    </button>
  );
}
