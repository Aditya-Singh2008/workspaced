/**
 * App shell composition root: registers the viewer plugins and the keybind
 * groups, installs the single global key listener, and routes between the
 * empty state and the workspace.
 *
 * This is the only place plugin registration is triggered, and it goes through
 * `registerBuiltInViewerPlugins()` — the shell never imports an individual
 * plugin, which is what keeps file-type knowledge out of it.
 *
 * The toolbar, sidebar and status bar sit outside the routing so all three are
 * present with nothing open: opening a file, toggling the sidebar and reading
 * the shortcuts are meaningful whether or not anything is loaded.
 *
 * It is also where the session is restored, for the same reason plugins are
 * registered here: it happens once, at startup, before anything can depend on
 * it — and the composition root is the one place that is true of.
 */

import { useEffect } from "react";

import { useSessionRestore, type SessionRestoreResult } from "../persistence";
import { registerBuiltInViewerPlugins } from "../viewers";
import {
  FOCUS_KEYBIND_GROUP,
  LAYOUT_KEYBIND_GROUP,
  useDockKeybinds,
} from "../shell/docking";
import {
  findKeybindConflicts,
  installKeybindListener,
  KeybindReference,
  registerKeybindGroup,
  SHELL_KEYBIND_GROUP,
  useKeybinds,
} from "../shell/keybinds";
import { useClipboardKeybinds } from "../shell/clipboard";
import { CommandPalette } from "../shell/command-palette";
import { Sidebar } from "../shell/sidebar";
import { announceStatus, StatusBar } from "../shell/statusbar";
import { Toolbar } from "../shell/toolbar";
import { useLayoutStore, useWorkspaceStore } from "../store";
import { EmptyState } from "./EmptyState";
import { Workspace } from "./Workspace";

// Runs once at module evaluation, before any component renders, so a file can
// be resolved the instant the user opens one.
registerBuiltInViewerPlugins();

// Group declarations are separate from the bindings themselves so the sections
// of the reference modal can be ordered here while each phase registers its
// own bindings from its own module.
registerKeybindGroup({ id: SHELL_KEYBIND_GROUP, title: "shell", order: 10 });
registerKeybindGroup({ id: FOCUS_KEYBIND_GROUP, title: "focus and navigation", order: 20 });
registerKeybindGroup({ id: LAYOUT_KEYBIND_GROUP, title: "layout and resizing", order: 30 });

export function App() {
  const hasClients = useWorkspaceStore((state) => state.clients.length > 0);
  const sidebarVisible = useLayoutStore((state) => state.sidebarVisible);
  const keybindReferenceOpen = useLayoutStore((state) => state.keybindReferenceOpen);
  const setKeybindReferenceOpen = useLayoutStore((state) => state.setKeybindReferenceOpen);

  const session = useSessionRestore();

  useEffect(() => installKeybindListener(), []);

  // Said once, when the restore settles. A tile that failed says so in its own
  // place in the layout; this line is the workspace-level summary, which is the
  // only way "two of these five are missing" is visible without counting.
  useEffect(() => {
    const announcement = session.result ? restoreAnnouncement(session.result) : null;
    if (announcement) announceStatus(announcement.text, announcement.tone);
  }, [session.result]);

  // Registered here rather than inside the dock so the focus and layout
  // sections of the keybind reference exist with nothing open; each binding
  // reports itself unavailable until there is a tile to act on.
  useDockKeybinds();

  // Same reasoning, for the same reason: the clipboard's two bindings have no
  // toolbar control to hang off, so the shell registers them and each reports
  // itself unavailable when the focused tile has nothing to copy.
  useClipboardKeybinds();

  // Adding tiles to an already-populated workspace, so splitting and stacking
  // can be exercised without going back to the empty state. Dropped from
  // production builds along with the branch that declares it.
  useKeybinds(
    import.meta.env.DEV
      ? [
          {
            id: "dev.openStubTile",
            group: SHELL_KEYBIND_GROUP,
            label: "dev: open a stub tile",
            // Not `Mod+Shift+D`: that is "fewer master tiles".
            keys: ["Mod+Alt+N"],
            order: 90,
            run: () => void import("../dev/stubTiles").then((m) => m.openStubTile()),
          },
        ]
      : [],
  );

  // Two bindings answering one key press is a mistake that is invisible until
  // someone presses it — and can exist only on a platform nobody is developing
  // on, since `Mod` collapses differently per OS.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    for (const [first, second] of findKeybindConflicts()) {
      console.warn(
        `[keybinds] "${first.id}" and "${second.id}" both answer ${first.keys[0]}`,
      );
    }
  });

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
      <Toolbar />

      <div className="flex min-h-0 grow">
        {sidebarVisible ? <Sidebar /> : null}
        <div className="min-h-0 min-w-0 grow">
          {hasClients ? (
            <Workspace />
          ) : session.phase === "restoring" ? (
            // Not the empty state: "no files open", with an *open file* button
            // under it, is a false statement about a workspace that is a
            // moment away from having four tiles in it.
            <div className="flex h-full w-full items-center justify-center bg-bg text-muted">
              restoring session…
            </div>
          ) : (
            <EmptyState />
          )}
        </div>
      </div>

      <StatusBar />

      <KeybindReference
        open={keybindReferenceOpen}
        onClose={() => setKeybindReferenceOpen(false)}
      />

      {/*
        Outside the workspace routing, like the two bars: the palette can open
        a file, so it has to be reachable from the empty state as well.
      */}
      <CommandPalette />
    </div>
  );
}

/**
 * What the status bar says about a restore, or nothing at all.
 *
 * Nothing is the common case — a session that came back intact does not need
 * telling, the tiles are right there. The two lines that do exist are both
 * about something the user cannot see by looking: a tile that is missing its
 * file (it is one tile among several, and its message is inside it), and a file
 * that opened but is not the one that was saved, which looks completely normal
 * and may explain why a page number landed somewhere unexpected.
 */
function restoreAnnouncement(
  result: SessionRestoreResult,
): { readonly text: string; readonly tone: "info" | "warn" } | null {
  if (result.missing > 0) {
    return {
      text:
        `restored ${result.tiles} tile(s) — ${result.missing} file(s) could not be reopened`,
      tone: "warn",
    };
  }
  if (result.changed > 0) {
    return {
      text: `restored ${result.tiles} tile(s) — ${result.changed} changed on disk since`,
      tone: "info",
    };
  }
  return null;
}
