/**
 * Restoring: putting a saved session back, in the order that makes a missing
 * file cost one tile instead of the workspace.
 *
 * The order is the whole design, and it is the phase brief's second task read
 * literally — *"restore the layout structure before attempting to reopen files,
 * so the arrangement is visually correct even if a file fails to reopen"*:
 *
 *   1. **Preferences and annotations**, before anything can be mounted. A tile
 *      that opens later asks for its document's marks at mount and its plugin's
 *      settings on the first frame; putting them back afterwards would mean an
 *      image opening at the wrong fit mode and then correcting itself.
 *   2. **The shell's own state** — the tiling parameters, the gap, the sidebar.
 *      The parameters matter beyond appearance: the grid below is dockview's
 *      serialization, and the next re-tile is derived from these, so a restored
 *      arrangement whose parameters were forgotten would jump on the first
 *      keystroke.
 *   3. **The clients**, all of them, with their recorded ids and no files. This
 *      is the step that makes the rest survivable: the workspace now has
 *      exactly the tiles it had, so the recorded layout — whose panel ids are
 *      those client ids — can be applied verbatim.
 *   4. **The grid**, handed to the dock the moment it has panels to arrange.
 *   5. **The files**, in parallel, each tile settling into a viewer or into an
 *      error of its own.
 *
 * Steps 1–4 cannot fail on account of a file, because they never touch one.
 *
 * ## What a failure looks like
 *
 * A tile, in its place in the layout, holding the contract's error convention:
 * a code, one line addressed to the user, and the technical reason underneath.
 * Two ways forward, both per tile and neither modal — *retry*, for a file that
 * was on a drive that had not mounted yet, and *locate…*, which is the native
 * picker and the answer to both "it moved" and "this platform wants the user to
 * re-confirm access to that path". That last is the brief's third file-reference
 * task: a full-app dialog for what is one tile's problem would block the four
 * tiles that opened perfectly.
 */

import type { SerializedDockview } from "dockview-react";

import { restoreAnnotationDocuments } from "../annotation";
import {
  extensionOf,
  openFilesViaDialog,
  restoreFileRef,
  type PersistedFileRef,
} from "../files";
import { getViewerPlugin, listViewerPlugins } from "../viewers";
import { useLayoutStore, useWorkspaceStore, type RestoredClient } from "../store";
import { parseSession, usableTileState, type PersistedSession } from "./record";
import { sessionStorage, type SessionStorage } from "./storage";
import { recordedFileRef, rememberTileSource, restoredViewerState } from "./tiles";

export interface SessionRestoreResult {
  /** Whether a usable record was found at all. */
  readonly found: boolean;
  readonly tiles: number;
  /** Files that opened. */
  readonly reopened: number;
  /** Files that could not be opened; each is one tile in its error state. */
  readonly missing: number;
  /** Files that opened but are not the bytes that were saved. */
  readonly changed: number;
  /** Which backend answered. `"memory"` means nothing was ever saved. */
  readonly storage: "tauri" | "memory";

  /**
   * Whether the record's own grid was handed over for the dock to apply.
   *
   * Reported rather than inferred from {@link hasRestoredLayout}, which is a
   * slot the dock empties the moment it has panels to arrange — so by the time
   * anyone asks, "no layout waiting" means either that there never was one or
   * that it has already been applied, and those are opposite answers.
   */
  readonly hasLayout: boolean;

  /** Which tile the restore asked for focus on, before the dock had a say. */
  readonly focused: string | null;
}

/**
 * Reopening one recorded reference. `restoreFileRef` is the only implementation
 * the app has; the parameter exists so the self-test can drive a restore in
 * which one file is there and another is not, which is the phase brief's second
 * verification and needs no filesystem to check.
 */
export type ReopenFile = typeof restoreFileRef;

export interface SessionRestoreOptions {
  readonly reopen?: ReopenFile;
  /**
   * Where to read the record from. The self-test's, so that driving a restore
   * neither reads nor disturbs whatever the app itself has saved.
   */
  readonly storage?: SessionStorage;
}

const NOTHING_RESTORED: SessionRestoreResult = {
  found: false,
  tiles: 0,
  reopened: 0,
  missing: 0,
  changed: 0,
  storage: "memory",
  hasLayout: false,
  focused: null,
};

// ---------------------------------------------------------------------------
// The layout, handed over to the dock
// ---------------------------------------------------------------------------

let pendingLayout: SerializedDockview | null = null;

/**
 * The grid the restore is waiting to apply, taken exactly once.
 *
 * A slot rather than a call into the dock, because the dock does not exist yet
 * when a restore runs: `DockingWorkspace` mounts when the first client appears,
 * which is a consequence of step 3 above. So the layout waits here for the
 * component to ask for it, on the same pass that creates the panels.
 */
export function takeRestoredLayout(): SerializedDockview | null {
  const layout = pendingLayout;
  pendingLayout = null;
  return layout;
}

/** Whether a restore is going to hand the dock a grid. */
export function hasRestoredLayout(): boolean {
  return pendingLayout !== null;
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

function applyPreferences(session: PersistedSession): void {
  for (const plugin of listViewerPlugins()) {
    const preferences = plugin.preferences;
    const saved = session.preferences[plugin.id];
    if (!preferences || !saved) continue;
    // Version-gated exactly like a tile's state: a preference shape that has
    // moved on is dropped rather than half-applied.
    if (saved.version !== preferences.version) continue;
    try {
      preferences.restore(saved.value);
    } catch (thrown) {
      console.error(`[persistence] "${plugin.id}" threw from preferences.restore()`, thrown);
    }
  }
}

/**
 * The four shell values a session carries, set in one go.
 *
 * Directly rather than through the store's own actions because there is no
 * action for "be exactly this": `cycleGap` and `rotateArrangement` are steps
 * from the current value, which is the right shape for a keystroke and the
 * wrong one for a restore.
 *
 * Nothing else in that store is restored, deliberately: `monocle` and
 * `tileCount` are mirrors of dockview and are re-read from it the moment the
 * grid is applied, and the keybind reference and command palette are overlays
 * rather than state anyone wants to come back to.
 */
function applyShellState(session: PersistedSession): void {
  useLayoutStore.setState({
    tiling: session.shell.tiling,
    gapIndex: session.shell.gapIndex,
    sidebarVisible: session.shell.sidebarVisible,
    sidebarPanel: session.shell.sidebarPanel,
  });
}

function clientFor(file: PersistedFileRef, clientId: string, pluginId: string): RestoredClient {
  return {
    id: clientId,
    pluginId,
    name: file.name,
    size: Math.max(0, file.size),
    extension: extensionOf(file.name),
    mimeType: file.mimeType,
    path: file.path,
  };
}

/**
 * Reads the saved session and puts it back.
 *
 * Never rejects and never leaves the app in a half-restored state: every step
 * is independently survivable, and the worst outcome is the empty state, which
 * is where the app starts anyway.
 */
export async function restoreSession(
  options?: SessionRestoreOptions,
): Promise<SessionRestoreResult> {
  const storage = options?.storage ?? (await sessionStorage());

  let raw: unknown;
  try {
    raw = await storage.read();
  } catch (thrown) {
    console.error("[persistence] the saved session could not be read", thrown);
    return { ...NOTHING_RESTORED, storage: storage.kind };
  }

  const session = parseSession(raw);
  if (!session) return { ...NOTHING_RESTORED, storage: storage.kind };

  applyPreferences(session);
  restoreAnnotationDocuments(session.annotations);
  applyShellState(session);

  if (session.tiles.length === 0) {
    return { ...NOTHING_RESTORED, found: true, storage: storage.kind };
  }

  // Recorded before any client exists, because `ViewerSurface` reads the state
  // back on the mount that the next few lines set in motion.
  for (const tile of session.tiles) {
    rememberTileSource(
      tile.clientId,
      tile.file,
      usableTileState(tile, getViewerPlugin(tile.pluginId)?.stateVersion),
    );
  }

  pendingLayout = session.layout;

  const workspace = useWorkspaceStore.getState();
  workspace.restoreClients(
    session.tiles.map((tile) => clientFor(tile.file, tile.clientId, tile.pluginId)),
  );

  const recorded = session.shell.activeClientId;
  const focused =
    recorded && session.tiles.some((tile) => tile.clientId === recorded) ? recorded : null;
  if (focused) workspace.setActiveClient(focused);

  // In parallel: four tiles on a slow disk should not open one after the other,
  // and each one's outcome is entirely its own.
  const outcomes = await Promise.all(
    session.tiles.map((tile) => reopenTileFile(tile.clientId, options?.reopen)),
  );

  return {
    found: true,
    tiles: session.tiles.length,
    reopened: outcomes.filter((outcome) => outcome !== "missing").length,
    missing: outcomes.filter((outcome) => outcome === "missing").length,
    changed: outcomes.filter((outcome) => outcome === "changed").length,
    storage: storage.kind,
    hasLayout: session.layout !== null,
    focused,
  };
}

export type ReopenOutcome = "opened" | "changed" | "missing";

/**
 * Reopens one tile's recorded file.
 *
 * The `changed` answer — the file is there but is not the bytes that were saved
 * — restores it anyway, with its state. The contract already requires a plugin
 * to tolerate stale state (a page number past the end of a document that has
 * been edited, a playhead past a shortened video), and every plugin's
 * `parse*State` clamps against the file it actually has. Refusing to restore
 * would throw away a reader's position because someone fixed a typo.
 */
export async function reopenTileFile(
  clientId: string,
  reopen: ReopenFile = restoreFileRef,
): Promise<ReopenOutcome> {
  const file = recordedFileRef(clientId);
  const workspace = useWorkspaceStore.getState();
  if (!file) {
    workspace.setClientProblem(clientId, {
      code: "internal",
      message: "This tile has no file to reopen.",
    });
    return "missing";
  }

  const result = await reopen(file);
  if (!result.ok) {
    workspace.setClientProblem(clientId, {
      code: "not-found",
      message: `${file.name} could not be reopened.`,
      detail: `${file.path} — ${result.reason}`,
      // Always: the two things that make this fail — a drive that is not
      // mounted yet, an access grant the platform wants re-confirming — are
      // both things a second attempt can succeed at.
      recoverable: true,
    });
    return "missing";
  }

  workspace.attachClientFile(clientId, result.handle);
  return result.changed ? "changed" : "opened";
}

/**
 * The tile's "locate…": the native picker, for one tile, without touching the
 * others.
 *
 * Answers both halves of the brief's third file-reference task. A file that
 * moved is found again, and a platform that will not read a path until the user
 * picks it themselves gets exactly that — the picker *is* the grant on macOS
 * and inside a sandbox, which is why this is a file dialog rather than a
 * "retry with permission" button.
 *
 * Returns whether a file was attached; dismissing the picker is not a failure
 * and leaves the tile as it was.
 */
export async function relocateTileFile(clientId: string): Promise<boolean> {
  const [picked] = await openFilesViaDialog({ multiple: false });
  if (!picked) return false;

  const ref = picked.toPersistable();
  // The tile now stands for the file the user pointed at, so that is what the
  // next save records — while the viewer state carries over, because they were
  // asked to find *this* tile's document and did.
  if (ref) rememberTileSource(clientId, ref, restoredViewerState(clientId));

  useWorkspaceStore.getState().attachClientFile(clientId, picked);
  return true;
}

/** Test hook: forget a layout a restore never handed over. */
export function clearRestoredLayout(): void {
  pendingLayout = null;
}
