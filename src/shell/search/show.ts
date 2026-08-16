/**
 * "Show me the search", as one call.
 *
 * Three entry points want it — the `Mod+F` binding, the toolbar button and the
 * command palette — and each of them wants the same three things to happen:
 * the sidebar open, the search panel selected, the cursor in the box. Writing
 * that out three times is how two of them end up subtly different.
 *
 * The optional `text` is what makes the palette's "search for what I just
 * typed" entry work without the palette knowing anything about the panel.
 */

import { useLayoutStore } from "../../store";
import { useSearchStore } from "./store";

export function showGlobalSearch(text?: string): void {
  useLayoutStore.getState().revealSidebarPanel("search");

  const search = useSearchStore.getState();
  if (text !== undefined) {
    search.setQuery(text);
    search.runNow();
  }
  search.requestFocus();
}
