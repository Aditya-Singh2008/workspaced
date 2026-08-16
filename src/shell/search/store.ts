/**
 * The state behind the search panel, and the two things that drive it from
 * outside: the `Mod+F` binding and the command palette.
 *
 * It is a store rather than component state because search has three entry
 * points and only one of them is the panel. A keybind pressed with the sidebar
 * closed has to be able to set a query, and a palette entry has to be able to
 * hand over the text the user already typed there, without either of them
 * finding the component first.
 *
 * ## The debounce lives here, not in the panel
 *
 * Extraction is real work — a hundred-page PDF is a hundred `getTextContent`
 * calls — so a run per keystroke would be a run per keystroke behind the one
 * before it. `setQuery` schedules; a run already in flight is aborted rather
 * than awaited, because its results are answering a question the user has
 * already changed.
 */

import { create } from "zustand";

import { useWorkspaceStore } from "../../store";
import { getViewerInstance, type ViewerLocation } from "../../viewers";
import {
  clearSearchHighlights,
  MINIMUM_QUERY_LENGTH,
  runWorkspaceSearch,
  type WorkspaceSearchResult,
} from "./engine";

/** Long enough to outlast typing, short enough to feel immediate. */
const DEBOUNCE_MS = 180;

interface SearchState {
  readonly query: string;
  readonly result: WorkspaceSearchResult | null;
  readonly running: boolean;
  /**
   * Bumped whenever something asks for the search box to take focus. The panel
   * watches it; nothing else reads it.
   */
  readonly focusNonce: number;

  setQuery(text: string): void;
  /** Runs immediately, skipping the debounce. For Enter and the palette. */
  runNow(): void;
  clear(): void;
  requestFocus(): void;
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: AbortController | null = null;

export const useSearchStore = create<SearchState>((set, get) => {
  async function execute(text: string): Promise<void> {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    const clients = useWorkspaceStore.getState().clients;
    clearSearchHighlights(clients);

    if (text.trim().length < MINIMUM_QUERY_LENGTH) {
      set({ result: null, running: false });
      return;
    }

    set({ running: true });
    try {
      const result = await runWorkspaceSearch(text, clients, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      set({ result, running: false });
    } catch (thrown) {
      if (controller.signal.aborted) return;
      console.error("[search] run failed", thrown);
      set({ result: null, running: false });
    } finally {
      if (inFlight === controller) inFlight = null;
    }
  }

  return {
    query: "",
    result: null,
    running: false,
    focusNonce: 0,

    setQuery(text) {
      set({ query: text });
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void execute(get().query);
      }, DEBOUNCE_MS);
    },

    runNow() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      void execute(get().query);
    },

    clear() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      inFlight?.abort();
      inFlight = null;
      clearSearchHighlights(useWorkspaceStore.getState().clients);
      set({ query: "", result: null, running: false });
    },

    requestFocus() {
      set((state) => ({ focusNonce: state.focusNonce + 1 }));
    },
  };
});

/**
 * Selecting a result: focus that tile, then ask its plugin to show the match.
 *
 * Both halves go through machinery that already exists — phase 02's focus
 * system (the workspace store's active client, which the dock mirrors) and the
 * contract's `reveal`. There is no search-specific navigation, which is the
 * same conclusion the annotation list reached in phase 05a.
 *
 * `search.reveal` is preferred over `instance.reveal` only because a searchable
 * plugin is expected to highlight from the former; the contract says the two
 * are normally the same function.
 */
export function revealSearchMatch(clientId: string, location: ViewerLocation): void {
  useWorkspaceStore.getState().setActiveClient(clientId);
  const instance = getViewerInstance(clientId);
  if (!instance) return;
  if (instance.search?.reveal) void instance.search.reveal(location, { highlight: true });
  else void instance.reveal?.(location, { highlight: true });
}
