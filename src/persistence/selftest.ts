/**
 * Phase 07's suite: the session record, the debounced writer, and a restore in
 * which one file is missing. **Dev builds only.**
 *
 * ## What can be checked here, and what cannot
 *
 * Everything that decides *what is written and what happens to it on the way
 * back* is a pure function or a store mutation, and all of it is checked
 * directly against a backend in memory and an injected reopen — including the
 * phase brief's second verification, a moved file, which needs no filesystem to
 * reproduce: the failure it describes is a reopen that says no.
 *
 * Three things are deliberately not here:
 *
 *   - **The Tauri store plugin itself.** Its own tests cover writing JSON to
 *     the app data directory; this suite covers everything on our side of that
 *     call, against `createMemorySessionStorage`, which is why that interface
 *     exists at all.
 *   - **The grid actually coming back.** `applyRestoredLayout` is one
 *     `fromJSON` call into the docking library, and what it produces is a
 *     picture — the phase brief's first verification is a human looking at a
 *     restarted window, and no assertion here can stand in for that.
 *   - **A restart.** The suite runs inside one page load. It checks that a
 *     record is written, and that a record is read back into the same
 *     workspace; the join between them is the thing a restart adds.
 *   - **`clearSavedSession` itself**, because running it would delete the
 *     developer's own saved workspace on every dev boot. What it does — pause
 *     the writer, then clear the store — is checked here on a writer and a
 *     backend of the suite's own.
 *
 * ## It runs against the live stores, and puts them back
 *
 * A restore is a mutation of the workspace and layout stores by definition, so
 * this drives the real ones — a fake would be checking a copy of the code. The
 * price is bookkeeping: every check that writes restores what it found, and the
 * last check asserts that it did. Where the app is not in a state that can be
 * safely disturbed (tiles already open, which happens when the suite is run
 * from the harness rather than the empty state), the restore checks skip and
 * say so rather than closing someone's workspace.
 */

import {
  annotationDocumentKey,
  clearAnnotationStore,
  OVERLAY_VERSION,
  overlayDocumentFor,
  serializeAnnotationDocuments,
  TEXT_ANNOTATION_VERSION,
  textDocumentFor,
  type AnnotationDocumentRecord,
} from "../annotation";
import { check, report, skip, type SelfTestCheck, type SelfTestReport } from "../dev/selftest";
import { createMemoryFileHandle, getFileHandle, type PersistedFileRef } from "../files";
import {
  registerViewerPlugin,
  unregisterViewerPlugin,
  type ViewerPlugin,
} from "../viewers";
import { useLayoutStore, useWorkspaceStore } from "../store";
import {
  isJsonSafe,
  parseSession,
  SESSION_RECORD_VERSION,
  usableTileState,
  type PersistedSession,
  type PersistedTile,
} from "./record";
import {
  collectSession,
  createSessionWriter,
  nextSaveDelay,
  pauseSessionWrites,
  SAVE_DEBOUNCE_MS,
  SAVE_MAX_DELAY_MS,
} from "./session";
import { createMemorySessionStorage, setSessionStorage, type SessionStorage } from "./storage";
import { clearRestoredLayout, hasRestoredLayout, restoreSession } from "./restore";
import { forgetAllTiles, restoredViewerState } from "./tiles";

export async function runPersistenceSelfTest(): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [
    ...recordChecks(),
    ...delayChecks(),
    ...collectionChecks(),
    ...(await writerChecks()),
    // Last: it is the only section that replaces the workspace, and it declines
    // to run when there is one to replace.
    ...(await restoreChecks()),
  ];

  return report("session persistence", checks);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_PLUGIN_ID = "selftest-persistence";

function fileRef(path: string, name: string): PersistedFileRef {
  return { path, name, size: 1024, modifiedAt: 1_700_000_000_000 };
}

function tile(clientId: string, path: string, state: unknown): PersistedTile {
  return {
    clientId,
    pluginId: FIXTURE_PLUGIN_ID,
    stateVersion: 3,
    file: fileRef(path, path.slice(path.lastIndexOf("/") + 1)),
    state,
  };
}

/**
 * A layout shaped enough for the record's reader to accept or reject it.
 *
 * Never handed to dockview here — the panel ids are the only part this suite is
 * about, since they are what ties a saved grid to the clients a restore will
 * create.
 */
function layoutFor(panelIds: readonly string[]): PersistedSession["layout"] {
  return {
    grid: { root: { type: "branch", data: [], size: 100 }, width: 100, height: 100 },
    panels: Object.fromEntries(panelIds.map((id) => [id, { id }])),
  } as unknown as PersistedSession["layout"];
}

function sessionFixture(): PersistedSession {
  return {
    version: SESSION_RECORD_VERSION,
    savedAt: 1_700_000_000_000,
    tiles: [
      tile("client:901", "/tmp/selftest/present.workspace-fixture", { page: 7 }),
      tile("client:902", "/tmp/selftest/moved.workspace-fixture", { zoom: 250 }),
    ],
    layout: layoutFor(["client:901", "client:902"]),
    shell: {
      tiling: { mode: "wide", masterCount: 2, masterFraction: 0.65 },
      gapIndex: 2,
      sidebarVisible: true,
      sidebarPanel: "notes",
      activeClientId: "client:902",
    },
    preferences: {
      [FIXTURE_PLUGIN_ID]: { version: 2, value: { greeting: "restored" } },
    },
    annotations: [],
  };
}

/** A plugin that exists only to have a `stateVersion` and preferences. */
function fixturePlugin(applied: { value: unknown }): ViewerPlugin {
  return {
    id: FIXTURE_PLUGIN_ID,
    displayName: "self-test",
    mimeTypes: [],
    extensions: [],
    stateVersion: 3,
    preferences: {
      version: 2,
      serialize: () => applied.value,
      restore: (value) => {
        applied.value = value;
      },
    },
    mount: () => Promise.reject(new Error("the self-test plugin never mounts")),
  };
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

function recordChecks(): readonly SelfTestCheck[] {
  const good = sessionFixture();
  const parsed = parseSession(JSON.parse(JSON.stringify(good)) as unknown);

  const wrongVersion = parseSession({ ...good, version: SESSION_RECORD_VERSION + 1 });
  const rubbish = [null, "nope", 7, [], {}].map(parseSession);

  const pathless = parseSession({
    ...good,
    tiles: [{ ...good.tiles[0] }, { clientId: "client:903", pluginId: "x", stateVersion: 1 }],
  });

  const strayLayout = parseSession({ ...good, layout: layoutFor(["client:999"]) });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  return [
    check(
      "a well-formed record survives the round trip",
      parsed?.tiles.length === 2 &&
        parsed.tiles[0]?.file.path === "/tmp/selftest/present.workspace-fixture" &&
        parsed.shell.tiling.mode === "wide" &&
        parsed.shell.sidebarPanel === "notes",
      `${parsed?.tiles.length ?? 0} tiles, mode ${parsed?.shell.tiling.mode}`,
    ),
    check(
      "a record from another version is refused whole",
      wrongVersion === null,
      "version mismatch discards the record rather than half-reading it",
    ),
    check(
      "nothing that is not a record parses as one",
      rubbish.every((result) => result === null),
      `null, a string, a number, an array and {} all rejected`,
    ),
    check(
      "a tile with no path is dropped and its siblings are not",
      pathless?.tiles.length === 1,
      `${pathless?.tiles.length ?? 0} of 2 tiles kept`,
    ),
    check(
      "a layout naming a tile the record does not have is dropped",
      strayLayout !== null && strayLayout.layout === null && strayLayout.tiles.length === 2,
      "the grid goes, both tiles stay",
    ),
    check(
      "state is handed over only at the version that wrote it",
      usableTileState(good.tiles[0]!, 3) !== undefined &&
        usableTileState(good.tiles[0]!, 4) === undefined &&
        usableTileState(good.tiles[0]!, undefined) === undefined,
      "matching version restores, a bumped one discards, an unknown plugin discards",
    ),
    check(
      "state JSON cannot hold is caught before it can lose the record",
      !isJsonSafe(cyclic) && isJsonSafe({ page: 3 }) && isJsonSafe(undefined),
      "a cycle is refused, plain state and no state are not",
    ),
  ];
}

// ---------------------------------------------------------------------------
// The debounce
// ---------------------------------------------------------------------------

function delayChecks(): readonly SelfTestCheck[] {
  return [
    check(
      "a change waits out the quiet period",
      nextSaveDelay(0) === SAVE_DEBOUNCE_MS,
      `${nextSaveDelay(0)}ms after the first change`,
    ),
    check(
      "a continuous stream of changes is written by the ceiling",
      nextSaveDelay(SAVE_MAX_DELAY_MS - 100) === 100 &&
        nextSaveDelay(SAVE_MAX_DELAY_MS) === 0 &&
        nextSaveDelay(SAVE_MAX_DELAY_MS * 2) === 0,
      `a drag held for ${SAVE_MAX_DELAY_MS}ms writes rather than deferring again`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * The one thing a saved workspace cannot contain: a file that has no path.
 *
 * The dev stub tiles and every self-test fixture are `createMemoryFileHandle`
 * bytes, and there is nothing to reopen them from next time. Recording one
 * would produce a tile that can only ever fail, so the tile is left out — and
 * with it the grid, because a layout naming a panel the restore will not create
 * is a layout the record cannot honour.
 */
function collectionChecks(): readonly SelfTestCheck[] {
  const name = "a file with no path on disk is left out of the record";

  const handle = createMemoryFileHandle({
    name: "selftest-scratch.txt",
    bytes: new Uint8Array([1, 2, 3, 4]),
  });
  const client = useWorkspaceStore.getState().openFile(handle);
  if (!client) {
    return [skip(name, "no viewer plugin resolved — run this suite inside the app")];
  }

  // Annotations on that file cannot be found again either — the key is a
  // handle id, which is minted per session.
  const key = annotationDocumentKey(handle);
  overlayDocumentFor(key).add({
    kind: "note",
    id: "an-selftest-memory",
    subdivision: 0,
    bounds: { x: 0, y: 0, width: 0.05, height: 0.05 },
    color: "#ffd54f",
    opacity: 1,
    text: "on bytes with no path",
    open: false,
    createdAt: 1,
    updatedAt: 1,
  });

  const session = collectSession();
  overlayDocumentFor(key).clear();
  useWorkspaceStore.getState().closeClient(client.id);

  return [
    check(
      name,
      !session.tiles.some((tile) => tile.clientId === client.id) && session.layout === null,
      `${session.tiles.length} tile(s) recorded from a workspace holding one in-memory file`,
    ),
    check(
      "nor are its annotations, which could never be matched to a file again",
      !session.annotations.some((document) => document.key === key),
      `${session.annotations.length} document(s) recorded; ${key} is not one of them`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The write loop, driven on an instance of its own.
 *
 * Its own writer and its own backend, so nothing here can stop the app's from
 * recording — which is exactly what an earlier version of this suite did by
 * resetting the module's state, silently disabling session saving for the rest
 * of a dev run. What it collects is a real {@link collectSession}, so the thing
 * being written is the thing the app writes.
 */
async function writerChecks(): Promise<readonly SelfTestCheck[]> {
  const storage = createMemorySessionStorage();
  const clientsBefore = useWorkspaceStore.getState().clients;
  const handlesBefore = clientsBefore.map((client) => getFileHandle(client.fileHandleId));

  const writer = createSessionWriter({
    collect: collectSession,
    storage: async () => storage,
  });
  writer.resume();

  try {
    // A burst, of the size a sash drag produces.
    for (let index = 0; index < 40; index += 1) writer.request();
    const duringBurst = writer.writes;
    await wait(SAVE_DEBOUNCE_MS + 150);
    const afterBurst = writer.writes;

    const stored = parseSession(await storage.read());

    writer.request();
    await writer.flush();
    const flushed = writer.writes;

    await writer.clear();
    writer.pause();
    const cleared = await storage.read();

    writer.request();
    await wait(SAVE_DEBOUNCE_MS + 150);
    const afterClear = writer.writes;

    return [
      check(
        "a burst of changes is one write, and not before the debounce",
        duringBurst === 0 && afterBurst === 1,
        `40 requests -> ${duringBurst} writes immediately, ${afterBurst} after ${SAVE_DEBOUNCE_MS}ms`,
      ),
      check(
        "what was written reads back as a session",
        stored !== null && stored.version === SESSION_RECORD_VERSION,
        stored ? `savedAt ${new Date(stored.savedAt).toISOString()}` : "nothing readable",
      ),
      check(
        "a flush writes immediately rather than waiting",
        flushed === afterBurst + 1,
        `${flushed} writes after flushing a pending change`,
      ),
      check(
        "clearing forgets the record",
        cleared === undefined,
        "the store holds nothing afterwards",
      ),
      check(
        "a paused writer records nothing, which is what clearing leaves behind",
        afterClear === flushed,
        `${afterClear - flushed} writes after clearing and pausing`,
      ),
      check(
        "clearing touches no file and closes no tile",
        useWorkspaceStore.getState().clients === clientsBefore &&
          clientsBefore.every(
            (client, index) => getFileHandle(client.fileHandleId) === handlesBefore[index],
          ),
        `the workspace and its ${clientsBefore.length} file handle(s) are as they were; only the app's own record went`,
      ),
    ];
  } finally {
    writer.pause();
  }
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

const MISSING_PATH = "/tmp/selftest/moved.workspace-fixture";

/** Answers for the file that is there, and refuses for the one that moved. */
const fakeReopen = async (ref: PersistedFileRef) =>
  ref.path === MISSING_PATH
    ? { ok: false as const, reason: "No such file or directory (os error 2)" }
    : {
        ok: true as const,
        handle: createMemoryFileHandle({ name: ref.name, bytes: new Uint8Array([1, 2, 3]) }),
        changed: false,
      };

async function restoreChecks(): Promise<readonly SelfTestCheck[]> {
  if (useWorkspaceStore.getState().clients.length > 0) {
    return [
      skip(
        "a restore rebuilds every tile, missing files included",
        "files are open — restoring would replace them; run this suite from the empty state",
      ),
    ];
  }

  // The app's own writer, stopped for the duration: this section puts two
  // fixture tiles into the real workspace for a few milliseconds, and a
  // debounce that happened to elapse in the middle would save them.
  const resumeWrites = pauseSessionWrites();

  const storage = createMemorySessionStorage();
  const session = sessionFixture();
  const annotated: AnnotationDocumentRecord = {
    key: "/tmp/selftest/present.workspace-fixture",
    // The live constants, not the numbers they hold today: a fixture pinned to
    // `1` would start failing the moment an item schema was bumped, which is
    // the version gate working rather than a regression.
    overlayVersion: OVERLAY_VERSION,
    textVersion: TEXT_ANNOTATION_VERSION,
    overlay: [
      {
        kind: "note",
        id: "an-selftest",
        subdivision: 2,
        bounds: { x: 0.1, y: 0.1, width: 0.05, height: 0.05 },
        color: "#ffd54f",
        opacity: 1,
        text: "in progress",
        open: true,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    text: [],
    updatedAt: 2,
    target: "/tmp/selftest/present-annotated.workspace-fixture",
  };
  await storage.write({ ...session, annotations: [annotated] });

  const layoutBefore = useLayoutStore.getState();
  const restoredBefore = {
    tiling: layoutBefore.tiling,
    gapIndex: layoutBefore.gapIndex,
    sidebarVisible: layoutBefore.sidebarVisible,
    sidebarPanel: layoutBefore.sidebarPanel,
  };
  const annotationsBefore = serializeAnnotationDocuments().length;

  const applied = { value: { greeting: "untouched" } as unknown };
  registerViewerPlugin(fixturePlugin(applied));

  try {
    const result = await restoreSession({ reopen: fakeReopen, storage });

    const clients = useWorkspaceStore.getState().clients;
    const present = clients.find((client) => client.id === "client:901");
    const moved = clients.find((client) => client.id === "client:902");
    const layout = useLayoutStore.getState();
    const marks = overlayDocumentFor("/tmp/selftest/present.workspace-fixture").items;

    return [
      check(
        "a restore rebuilds every tile, missing files included",
        clients.length === 2 && result.tiles === 2,
        `${clients.length} tiles from ${result.tiles} recorded, ${result.missing} missing`,
      ),
      check(
        "the file that is still there gets its handle",
        !!present?.fileHandleId && !!getFileHandle(present.fileHandleId) && !present.problem,
        present?.fileHandleId
          ? `client:901 holds ${present.fileHandleId}`
          : "client:901 has no handle",
      ),
      check(
        "the file that moved leaves one tile in the contract's error state",
        moved?.problem?.code === "not-found" &&
          moved.problem.recoverable === true &&
          moved.fileHandleId === "" &&
          present?.problem === undefined,
        moved?.problem
          ? `${moved.problem.code}: ${moved.problem.message}`
          : "client:902 reported nothing",
      ),
      check(
        "the arrangement is kept for the dock even though a file failed",
        result.hasLayout,
        // Read off the result rather than `hasRestoredLayout()`: inside the
        // app the dock mounts the moment these fixture clients appear and
        // empties that slot, which is the grid being applied, not lost.
        hasRestoredLayout()
          ? "the recorded grid is waiting for the dock"
          : "the recorded grid was handed over and the live dock has taken it",
      ),
      check(
        "the shell's own state comes back",
        layout.tiling.mode === "wide" &&
          layout.tiling.masterCount === 2 &&
          layout.gapIndex === 2 &&
          layout.sidebarVisible &&
          layout.sidebarPanel === "notes",
        `${layout.tiling.mode} x${layout.tiling.masterCount}, gap ${layout.gapIndex}, sidebar on ${layout.sidebarPanel}`,
      ),
      check(
        "the tile that had focus has it again",
        // The restore's own answer, for the same reason as above: once the
        // dock exists it owns which panel is active and the store follows it.
        result.focused === "client:902",
        `the restore asked for ${result.focused}; the store now says ${
          useWorkspaceStore.getState().activeClientId
        }`,
      ),
      check(
        "each tile's saved state is waiting for its mount",
        // Read through the same call `ViewerSurface` makes on the way into
        // `mountViewer`, which is what makes this a check of the real path.
        (restoredViewerState("client:901") as { page?: number } | undefined)?.page === 7,
        `client:901 resumes at ${JSON.stringify(restoredViewerState("client:901"))}`,
      ),
      check(
        "a plugin's viewer-wide preferences are restored through the contract",
        (applied.value as { greeting?: string }).greeting === "restored",
        `preferences.restore() received ${JSON.stringify(applied.value)}`,
      ),
      check(
        "an in-progress annotation is back on its document",
        marks.length === 1 && marks[0]?.id === "an-selftest",
        `${marks.length} mark(s) restored on the document, keyed by its path`,
      ),
      check(
        "the suite leaves the annotation store as it found it",
        cleanUpAnnotations() === annotationsBefore,
        "the fixture document is emptied again",
      ),
      check(
        "the suite leaves the shell state as it found it",
        restoreShellState(restoredBefore),
        "tiling, gap and sidebar put back",
      ),
    ];
  } finally {
    unregisterViewerPlugin(FIXTURE_PLUGIN_ID);
    useWorkspaceStore.getState().closeAll();
    forgetAllTiles();
    clearRestoredLayout();
    resumeWrites();
  }
}

function cleanUpAnnotations(): number {
  overlayDocumentFor("/tmp/selftest/present.workspace-fixture").clear();
  textDocumentFor("/tmp/selftest/present.workspace-fixture").clear();
  return serializeAnnotationDocuments().length;
}

function restoreShellState(before: {
  tiling: ReturnType<typeof useLayoutStore.getState>["tiling"];
  gapIndex: number;
  sidebarVisible: boolean;
  sidebarPanel: ReturnType<typeof useLayoutStore.getState>["sidebarPanel"];
}): boolean {
  useLayoutStore.setState(before);
  const now = useLayoutStore.getState();
  return (
    now.tiling === before.tiling &&
    now.gapIndex === before.gapIndex &&
    now.sidebarVisible === before.sidebarVisible &&
    now.sidebarPanel === before.sidebarPanel
  );
}

/**
 * Everything back to a fresh run's state, annotations included.
 *
 * Not used by the suite, which cleans up after itself check by check — this is
 * for the harness, where a page is driven through several restores in a row and
 * the *previous* one's leftovers are the thing most likely to make the next
 * look like it worked.
 */
export function resetPersistenceForTesting(): void {
  forgetAllTiles();
  clearRestoredLayout();
  clearAnnotationStore();
  setSessionStorage(null);
}

export type { SessionStorage };
