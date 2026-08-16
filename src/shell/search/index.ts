/**
 * Global search UI. Queries each open viewer through
 * `ViewerInstance.search` (`src/viewers/contract.ts`) and treats a plugin
 * without that capability as "not searchable", never as an error.
 *
 * Built by phase 06 (`prompts/06-clipboard-search-command-palette.md`).
 */

export {
  clearSearchHighlights,
  matchSegments,
  MATCHES_PER_TILE,
  MINIMUM_QUERY_LENGTH,
  runWorkspaceSearch,
  searchInstance,
} from "./engine";
export type { SearchTileResult, WorkspaceSearchResult } from "./engine";

export { revealSearchMatch, useSearchStore } from "./store";
export { SearchPanel } from "./SearchPanel";
export { showGlobalSearch } from "./show";
