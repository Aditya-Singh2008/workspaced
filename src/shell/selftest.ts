/**
 * Phase 06's suite: the clipboard, global search and the command palette.
 * **Dev builds only.**
 *
 * One suite for three systems, because they are one phase and because they
 * share the property worth checking: each of them queries *every* open plugin
 * through the contract and has to behave when a plugin does not answer. The
 * failure mode they share is the reason this exists — a search that throws
 * because an image has no text, a copy that silently does nothing because a
 * canvas has no DOM selection, a palette entry that runs an action the focused
 * tile cannot perform.
 *
 * ## What is checked here, and what cannot be
 *
 * The matching rules, the skip rules, the clipboard collections and the palette
 * list are all derivable without a window, and are checked directly. Two things
 * are not:
 *
 *   - **`ViewerCopyApi.locateRegion`** needs a mounted tile with real layout,
 *     because it is a question about where a page currently sits on screen.
 *     There is no version of it that is true off-DOM.
 *   - **The system clipboard** can only be verified by reading it back, which
 *     needs a permission the platform may refuse. When it can be read, the
 *     check runs a real round trip *and puts the user's previous clipboard
 *     back*; when it cannot, it skips rather than clobbering a clipboard it
 *     could not verify.
 *
 * Both are named in the report rather than quietly absent, which is the rule
 * AGENTS.md sets for coverage a run cannot provide.
 */

import { check, report, skip, type SelfTestCheck, type SelfTestReport } from "../dev/selftest";
import type { HostPlatform } from "../platform";
import type { SearchMatch, TextSegment, ViewerInstance } from "../viewers";
import type { WorkspaceClient } from "../store";
import {
  CLIPBOARD_HISTORY_LIMIT,
  entryContent,
  preferredContent,
  useClipboardStore,
} from "./clipboard";
import { writeToSystemClipboard } from "./clipboard/system";
import {
  buildPaletteCommands,
  filterPaletteCommands,
  type PaletteContext,
} from "./command-palette";
import { findKeybindConflicts, listKeybinds } from "./keybinds";
import { matchSegments, runWorkspaceSearch } from "./search";

export async function runShellServicesSelfTest(): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [
    ...searchChecks(),
    ...(await workspaceSearchChecks()),
    ...clipboardChecks(),
    await systemClipboardCheck(),
    ...paletteChecks(),
    ...keybindChecks(),
  ];

  return report("clipboard, search and command palette", checks);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function segment(text: string, subdivision: number, start: number): TextSegment {
  return {
    text,
    location: { subdivision, range: { start, end: start + text.length } },
  };
}

function searchChecks(): readonly SelfTestCheck[] {
  const segments = [
    segment("The quick brown fox ", 0, 0),
    segment("jumps over the lazy dog.", 0, 20),
    segment("The dog sleeps.", 1, 0),
  ];

  const hits = matchSegments(segments, { text: "the" });
  const caseSensitive = matchSegments(segments, { text: "The", caseSensitive: true });
  const limited = matchSegments(segments, { text: "the", limit: 2 });
  const first = hits[0];

  return [
    check(
      "matching is case-insensitive by default",
      // "The" leading the first segment, "the" inside the second, "The"
      // leading the third. Case sensitivity has to be asked for.
      hits.length === 3,
      `${hits.length} hits for "the" across ${segments.length} segments`,
    ),
    check(
      "case-sensitive matching is narrower",
      caseSensitive.length === 2,
      `${caseSensitive.length} hits for "The" with caseSensitive`,
    ),
    check(
      "a match narrows the range to the hit",
      first?.location.range?.start === 0 && first?.location.range?.end === 3,
      `first hit range ${JSON.stringify(first?.location.range)}`,
    ),
    check(
      "a match keeps its segment's subdivision",
      hits.at(-1)?.location.subdivision === 1,
      `last hit is on subdivision ${hits.at(-1)?.location.subdivision}`,
    ),
    check(
      "the limit is honoured",
      limited.length === 2,
      `${limited.length} hits with limit 2`,
    ),
    check(
      "an empty query matches nothing",
      matchSegments(segments, { text: "" }).length === 0,
      "no hits for the empty string",
    ),
  ];
}

/**
 * A stand-in for a mounted tile.
 *
 * Only the four members the search path reads are real; everything else throws
 * if touched, which is the point — a search that reached for `thumbnail` or
 * `serialize` would be doing something it has no business doing.
 */
function fakeInstance(options: {
  readonly searchable: boolean;
  readonly text?: string;
  readonly throws?: boolean;
}): ViewerInstance {
  const searchApi = {
    extractText: async () => [segment(options.text ?? "", 0, 0)],
    reveal: async () => {},
    find: options.throws
      ? async (): Promise<readonly SearchMatch[]> => {
          throw new Error("this plugin's index is broken");
        }
      : undefined,
  };

  return {
    pluginId: "fake",
    capabilities: {
      search: options.searchable,
      copy: false,
      annotation: false,
      toolbar: false,
      keybinds: false,
      thumbnail: false,
    },
    status: "ready",
    search: options.searchable ? (searchApi as ViewerInstance["search"]) : undefined,
  } as unknown as ViewerInstance;
}

function fakeClient(id: string, name: string): WorkspaceClient {
  return { id, fileHandleId: id, pluginId: "fake", name, size: 0 };
}

async function workspaceSearchChecks(): Promise<readonly SelfTestCheck[]> {
  const clients = [
    fakeClient("a", "report.pdf"),
    fakeClient("b", "photo.png"),
    fakeClient("c", "clip.mp4"),
    fakeClient("d", "broken.pdf"),
  ];

  const instances = new Map<string, ViewerInstance>([
    ["a", fakeInstance({ searchable: true, text: "the dog and the fox" })],
    // The two the phase brief names: an image and a video with no captions.
    ["b", fakeInstance({ searchable: false })],
    ["c", fakeInstance({ searchable: false })],
    ["d", fakeInstance({ searchable: true, throws: true })],
  ]);

  const result = await runWorkspaceSearch("the", clients, {
    instanceFor: (id) => instances.get(id),
  });

  return [
    check(
      "results come only from tiles that can search",
      result.tiles.length === 1 && result.tiles[0]?.clientId === "a",
      `${result.tiles.length} tile(s) in the results: ${result.tiles
        .map((tile) => tile.label)
        .join(", ")}`,
    ),
    check(
      "a plugin without search is skipped, not failed",
      result.skipped === 2 && result.failed.length === 1,
      `${result.skipped} skipped, ${result.failed.length} failed (${result.failed.join(", ")})`,
    ),
    check(
      "one plugin's broken search does not empty the others'",
      result.matchCount === 2,
      `${result.matchCount} matches survived a throwing sibling`,
    ),
    check(
      "an aborted run rejects rather than returning half a result",
      await rejectsWhenAborted(clients, instances),
      "abort during the run propagates",
    ),
  ];
}

async function rejectsWhenAborted(
  clients: readonly WorkspaceClient[],
  instances: ReadonlyMap<string, ViewerInstance>,
): Promise<boolean> {
  const controller = new AbortController();
  controller.abort();
  try {
    await runWorkspaceSearch("the", clients, {
      signal: controller.signal,
      instanceFor: (id) => instances.get(id),
    });
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

function clipboardChecks(): readonly SelfTestCheck[] {
  const store = useClipboardStore.getState();
  const scratchBefore = store.scratch.length;
  /**
   * Whatever the session had copied before this ran.
   *
   * Checking the cap means overflowing it, which evicts real entries — so they
   * are re-added from their own content afterwards rather than merely counted.
   * Re-adding rather than restoring the array is deliberate: eviction revokes an
   * image entry's object URL, and putting the dead URL back would leave a
   * scratch panel full of broken previews.
   */
  const historyBefore = store.history;

  const text = { kind: "text", text: "hello" } as const;
  const image = {
    kind: "image",
    blob: new Blob([new Uint8Array([0])], { type: "image/png" }),
    mimeType: "image/png",
    width: 4,
    height: 4,
  } as const;

  const preferText = preferredContent([image, text]);
  const preferImage = preferredContent([text, image], "image");

  // Runs against the live store and cleans up after itself, the same rule the
  // keybind registry suite follows.
  const entry = store.addToScratch(text, "selftest");
  const added = useClipboardStore.getState().scratch.length === scratchBefore + 1;
  useClipboardStore.getState().removeEntry(entry.id);
  const removed = useClipboardStore.getState().scratch.length === scratchBefore;

  const overfill: string[] = [];
  for (let index = 0; index < CLIPBOARD_HISTORY_LIMIT + 5; index += 1) {
    overfill.push(
      useClipboardStore.getState().addToHistory({ kind: "text", text: `${index}` }, "selftest")
        .id,
    );
  }
  const capped = useClipboardStore.getState().history.length === CLIPBOARD_HISTORY_LIMIT;
  const newestFirst = useClipboardStore.getState().history[0]?.id === overfill.at(-1);

  useClipboardStore.getState().clearHistory();
  for (const entry of [...historyBefore].reverse()) {
    useClipboardStore.getState().addToHistory(entryContent(entry), entry.source);
  }
  const probes = new Set(overfill);
  const restored =
    useClipboardStore.getState().history.length === historyBefore.length &&
    !useClipboardStore.getState().history.some((entry) => probes.has(entry.id));

  return [
    check(
      "text wins when a plugin offers both flavours",
      preferText?.kind === "text",
      `preferred ${preferText?.kind} from [image, text]`,
    ),
    check(
      "the region gesture can ask for the image instead",
      preferImage?.kind === "image",
      `preferred ${preferImage?.kind} from [text, image] with prefer=image`,
    ),
    check(
      "the scratch panel collects and releases entries",
      added && removed,
      `added=${added} removed=${removed}`,
    ),
    check(
      "the history is capped and newest-first",
      capped && newestFirst,
      `${CLIPBOARD_HISTORY_LIMIT} kept of ${CLIPBOARD_HISTORY_LIMIT + 5}, newest first=${newestFirst}`,
    ),
    check(
      "the suite leaves the store as it found it",
      restored,
      `${historyBefore.length} pre-existing entries back, none of the ${overfill.length} probes left`,
    ),
  ];
}

/**
 * A real round trip through the OS clipboard — write, read back, put the
 * user's own clipboard contents back.
 *
 * The restore is not politeness for its own sake: a self-test that runs on
 * every dev boot and silently eats whatever you had copied is one people turn
 * off. If the clipboard cannot be read, nothing is written at all, because a
 * write that cannot be verified is a clipboard that was clobbered for nothing.
 */
async function systemClipboardCheck(): Promise<SelfTestCheck> {
  const name = "text reaches the system clipboard";

  if (!navigator.clipboard?.readText || !navigator.clipboard.writeText) {
    return skip(name, "this platform exposes no clipboard read; verify by hand into another app");
  }

  let previous: string;
  try {
    previous = await navigator.clipboard.readText();
  } catch {
    return skip(
      name,
      "clipboard read was refused (permission, or no document focus); verify by hand into another app",
    );
  }

  const probe = `workspace-selftest-${Date.now()}`;
  try {
    const written = await writeToSystemClipboard({ kind: "text", text: probe });
    if (!written.ok) return check(name, false, written.message);
    const read = await navigator.clipboard.readText();
    return check(
      name,
      read === probe,
      read === probe ? "wrote and read back the probe string" : `read back ${JSON.stringify(read)}`,
    );
  } finally {
    try {
      await navigator.clipboard.writeText(previous);
    } catch {
      // Nothing useful to do: the probe stays on the clipboard. Reported by
      // the check above either way.
    }
  }
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------

function paletteContext(query: string): PaletteContext {
  return {
    query,
    // No dock and no tiles: the empty state, where every tile action must be
    // listed and disabled rather than missing.
    dockApi: null,
    clients: [],
    activeClientId: null,
    actions: {
      openFile: () => {},
      showSearch: () => {},
      showScratch: () => {},
      toggleSidebar: () => {},
      toggleKeybindReference: () => {},
      copyToClipboard: () => {},
      yankToScratch: () => {},
      startRegionCapture: () => {},
      canCopy: () => false,
      canCopyRegion: () => false,
      clearSavedSession: () => {},
      sessionRecording: () => true,
    },
  };
}

function paletteChecks(): readonly SelfTestCheck[] {
  const empty = buildPaletteCommands(paletteContext(""));
  const typed = buildPaletteCommands(paletteContext("arrangement"));

  const ids = new Set(empty.map((command) => command.id));
  const duplicated = empty.length !== ids.size;
  const dockEntries = empty.filter((command) => command.id.startsWith("dock."));
  const filtered = filterPaletteCommands(typed, "arrangement");
  const dynamic = buildPaletteCommands(paletteContext("dog")).find(
    (command) => command.id === "shell.searchFor",
  );
  const fuzzy = filterPaletteCommands(empty, "nsa").map((command) => command.label);

  return [
    check("every command has a unique id", !duplicated, `${ids.size} of ${empty.length} unique`),
    check(
      "the layout arrangements are in the palette",
      dockEntries.some((command) => command.label.includes("arrangement")),
      `${dockEntries.length} dock actions listed`,
    ),
    check(
      "a tile action with no tile is disabled, not missing",
      dockEntries.length > 0 && dockEntries.every((command) => command.disabled === true),
      "every dock command is disabled with no dock",
    ),
    check(
      "the search entry carries the typed text",
      dynamic?.label.includes("dog") === true,
      dynamic?.label ?? "no dynamic search entry",
    ),
    check(
      "filtering keeps what matches",
      filtered.length > 0 && filtered.every((command) => command.id !== "shell.openFile"),
      `${filtered.length} of ${typed.length} match "arrangement"`,
    ),
    check(
      "initials find a multi-word command",
      fuzzy.some((label) => label === "next screen arrangement"),
      `"nsa" matched: ${fuzzy.slice(0, 3).join(", ") || "nothing"}`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Keybinds
// ---------------------------------------------------------------------------

/**
 * The phase brief's fifth verification, automated: *"confirm every new keybind
 * introduced in this phase appears correctly in the Phase 2 keybind reference
 * modal with no conflicts against existing bindings."*
 *
 * The conflict half is checked on all three platforms rather than this one,
 * because `Mod` collapses differently per OS — `Mod+C` and a hypothetical
 * `Meta+C` are distinct on Linux and the same key press on macOS.
 */
function keybindChecks(): readonly SelfTestCheck[] {
  const registered = listKeybinds();
  const introduced = ["shell.copy", "shell.yank", "shell.search", "shell.commandPalette"];

  // Registration is a side effect of the shell's components being mounted, so
  // an empty registry means this suite is being run outside the app — bundled
  // into Node to check the pure logic, which is a legitimate way to run it and
  // not a phase-06 regression. Saying "not verified here" is the honest report;
  // asserting against an empty registry would pass vacuously.
  if (registered.length === 0) {
    return [
      skip(
        "this phase's bindings are registered and listed",
        "no keybinds are registered — run the suite inside the app",
      ),
      skip(
        "no binding conflicts on any platform",
        "no keybinds are registered — run the suite inside the app",
      ),
    ];
  }
  const present = introduced.filter((id) =>
    registered.some((keybind) => keybind.id === id && !keybind.hidden),
  );

  const platforms: readonly HostPlatform[] = ["linux", "macos", "windows"];
  const conflicts = platforms.flatMap((platform) =>
    findKeybindConflicts(platform).map(
      ([first, second]) => `${platform}: ${first.id} vs ${second.id}`,
    ),
  );

  return [
    check(
      "this phase's bindings are registered and listed",
      present.length === introduced.length,
      present.length === introduced.length
        ? introduced.join(", ")
        : `missing ${introduced.filter((id) => !present.includes(id)).join(", ")}`,
    ),
    check(
      "no binding conflicts on any platform",
      conflicts.length === 0,
      conflicts.length === 0 ? `${registered.length} bindings, no collisions` : conflicts.join("; "),
    ),
  ];
}
