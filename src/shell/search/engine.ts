/**
 * Workspace-wide search, run over whatever is open.
 *
 * The rule the phase brief states and this file exists to hold: *"query every
 * open tile's plugin via the contract's optional search method, skipping plugins
 * that don't implement it (image, video) without error."* Absence of
 * `capabilities.search` is the normal case for most file types, so it produces a
 * count of tiles that had no text — not a row, not a warning, and never a
 * rejected promise.
 *
 * ## Two ways to match, and why the shell owns one of them
 *
 * `ViewerSearchApi` splits searching in half on purpose. `extractText()` is
 * required and returns located segments; `find()` is optional and exists for
 * "content where the plugin can do better than matching over extractText — a
 * native index, or hit rectangles the shell cannot derive". So:
 *
 *   - a plugin with `find` is asked, and gets to return real hit rectangles
 *     (the PDF plugin interpolates a box across the matched glyphs, which the
 *     shell has no way to compute);
 *   - a plugin without it — the video plugin, whose subtitles are text with
 *     timestamps and no geometry at all — is matched here, over its segments.
 *
 * The second path is not a fallback for a missing feature. It is the reason
 * `find` can stay optional, and it means a future plain-text plugin becomes
 * searchable by implementing one method.
 */

import {
  getViewerInstance,
  type SearchMatch,
  type SearchQuery,
  type TextSegment,
  type ViewerInstance,
} from "../../viewers";
import { clientLabel, type WorkspaceClient } from "../../store";

/** One tile's hits, kept together — the brief asks for results grouped by tile. */
export interface SearchTileResult {
  readonly clientId: string;
  /** What that tile is called right now, captured so the list stays stable. */
  readonly label: string;
  readonly matches: readonly SearchMatch[];
  /** Whether {@link MATCHES_PER_TILE} cut the list short. */
  readonly truncated: boolean;
}

export interface WorkspaceSearchResult {
  readonly query: string;
  readonly tiles: readonly SearchTileResult[];
  /** Open tiles whose plugin has no text. Reported as a fact, never an error. */
  readonly skipped: number;
  readonly matchCount: number;
  /**
   * Tiles whose search threw. Separate from {@link skipped} because "this
   * plugin cannot search" and "this plugin tried and broke" are different
   * things, and only the second is worth telling the user about.
   */
  readonly failed: readonly string[];
}

/**
 * Per-tile cap.
 *
 * A three-letter query against a long document has thousands of hits, and a
 * results list that long is slower to skim than the document. Cutting it off
 * and *saying so* is more useful than either rendering it all or refusing
 * short queries.
 */
export const MATCHES_PER_TILE = 100;

/** Below this, matching is noise: two letters hit most of a document. */
export const MINIMUM_QUERY_LENGTH = 2;

/**
 * The shell's own matcher, over a plugin's located segments.
 *
 * Each match keeps the location of the segment it came from and narrows the
 * character range to the hit itself, so `reveal` lands on the word rather than
 * the paragraph. The rect is *not* narrowed: interpolating a box across a
 * segment needs glyph advances the shell does not have, which is exactly what
 * a plugin implements `find` to do better.
 */
export function matchSegments(
  segments: readonly TextSegment[],
  query: SearchQuery,
): readonly SearchMatch[] {
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  if (!needle) return [];

  const limit = query.limit ?? Infinity;
  const matches: SearchMatch[] = [];

  for (const segment of segments) {
    const haystack = query.caseSensitive ? segment.text : segment.text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      from = at + Math.max(1, needle.length);

      const start = segment.location.range?.start ?? 0;
      matches.push({
        text: segment.text.slice(at, at + query.text.length),
        context: segment.text.trim(),
        location: {
          ...segment.location,
          range: { start: start + at, end: start + at + query.text.length },
        },
      });
      if (matches.length >= limit) return matches;
    }
  }

  return matches;
}

/**
 * One instance's hits, or `null` when it has no text at all.
 *
 * `null` rather than an empty array so a caller can tell "searched, found
 * nothing" from "not searchable" — the difference between a tile that belongs
 * in the results with no rows and one that should not be mentioned.
 */
export async function searchInstance(
  instance: ViewerInstance,
  query: SearchQuery,
): Promise<readonly SearchMatch[] | null> {
  if (!instance.capabilities.search || !instance.search) return null;

  if (instance.search.find) return await instance.search.find(query);

  const segments = await instance.search.extractText({ signal: query.signal });
  return matchSegments(segments, query);
}

/**
 * Runs `text` against every open tile.
 *
 * Sequential rather than parallel, and that is deliberate: extraction is
 * CPU-bound work on the main thread for every plugin that has it, and firing
 * five documents' worth of it at once makes the window unresponsive without
 * finishing any sooner. Between tiles the abort signal is honoured, so typing
 * another character stops the run rather than queueing behind it.
 */
export async function runWorkspaceSearch(
  text: string,
  clients: readonly WorkspaceClient[],
  options?: {
    readonly signal?: AbortSignal;
    /**
     * How a client id becomes an instance. Defaults to the live map, and is a
     * parameter only so the self-test can run this against fakes — the skip
     * and failure rules are the part worth checking and they need neither a
     * window nor a real decoder.
     */
    readonly instanceFor?: (clientId: string) => ViewerInstance | undefined;
  },
): Promise<WorkspaceSearchResult> {
  const resolve = options?.instanceFor ?? getViewerInstance;
  const tiles: SearchTileResult[] = [];
  const failed: string[] = [];
  let skipped = 0;
  let matchCount = 0;

  for (const client of clients) {
    options?.signal?.throwIfAborted();

    const instance = resolve(client.id);
    if (!instance) continue;

    if (!instance.capabilities.search || !instance.search) {
      skipped += 1;
      continue;
    }

    try {
      const matches =
        (await searchInstance(instance, {
          text,
          limit: MATCHES_PER_TILE + 1,
          signal: options?.signal,
        })) ?? [];

      const truncated = matches.length > MATCHES_PER_TILE;
      const kept = truncated ? matches.slice(0, MATCHES_PER_TILE) : matches;
      matchCount += kept.length;
      tiles.push({
        clientId: client.id,
        label: clientLabel(client),
        matches: kept,
        truncated,
      });
    } catch (thrown) {
      if (options?.signal?.aborted) throw thrown;
      // Local, like every other plugin failure: one tile's broken search must
      // not empty the results of the four beside it.
      console.error(`[search] "${client.name}" failed to search`, thrown);
      failed.push(clientLabel(client));
    }
  }

  return { query: text, tiles, skipped, matchCount, failed };
}

/** Drops any match highlighting this search drew, in every tile that has some. */
export function clearSearchHighlights(clients: readonly WorkspaceClient[]): void {
  for (const client of clients) {
    getViewerInstance(client.id)?.search?.clearHighlights?.();
  }
}
