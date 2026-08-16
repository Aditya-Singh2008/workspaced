/**
 * The search panel: one box, and every open tile's hits grouped under its name.
 *
 * It contains no file-type vocabulary at all. A result row shows the
 * subdivision number under a `#` heading — the same choice the annotation list
 * made, for the same reason: a subdivision is a page in a PDF and a caption cue
 * in a video, and the shell is not allowed to know which. What it shows beside
 * that is the match's own context string, with the matched run marked, which
 * every plugin produces from its own text.
 *
 * The group header is the tile's name and doubles as its focus button, so a
 * result set is also a way to move between the documents that have hits.
 */

import { useEffect, useRef } from "react";

import type { SearchMatch } from "../../viewers";
import { ellipsize } from "../clipboard";
import { MINIMUM_QUERY_LENGTH, type SearchTileResult } from "./engine";
import { revealSearchMatch, useSearchStore } from "./store";

export function SearchPanel() {
  const query = useSearchStore((state) => state.query);
  const result = useSearchStore((state) => state.result);
  const running = useSearchStore((state) => state.running);
  const focusNonce = useSearchStore((state) => state.focusNonce);
  const setQuery = useSearchStore((state) => state.setQuery);
  const runNow = useSearchStore((state) => state.runNow);
  const clear = useSearchStore((state) => state.clear);

  const inputRef = useRef<HTMLInputElement>(null);

  // Focus follows the request rather than the mount, so `Mod+F` with the panel
  // already open still puts the cursor in the box — which is what pressing it
  // twice means.
  useEffect(() => {
    if (focusNonce === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-1 py-1">
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="search open tiles"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") runNow();
            if (event.key === "Escape") event.currentTarget.blur();
          }}
          className="min-w-0 grow border border-border bg-bg px-1 py-0.5 text-fg placeholder:text-disabled focus:border-border-accent"
        />
        {query ? (
          <button
            type="button"
            onClick={clear}
            aria-label="clear the search"
            className="shrink-0 px-1 text-muted hover:text-fg"
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="min-h-0 grow overflow-y-auto">
        <Summary running={running} query={query} />
        {result?.tiles.map((tile) =>
          tile.matches.length > 0 ? (
            <TileGroup key={tile.clientId} tile={tile} query={result.query} />
          ) : null,
        )}
      </div>
    </div>
  );
}

/**
 * The one line above the results.
 *
 * It is where the phase brief's third verification is actually answered: tiles
 * whose plugin has no text are counted here, plainly, instead of appearing as
 * empty groups or as errors. "3 in 1 tile · 2 without text" is a true sentence
 * about a workspace holding a PDF, an image and a video.
 */
function Summary({ running, query }: { readonly running: boolean; readonly query: string }) {
  const result = useSearchStore((state) => state.result);

  if (running) return <p className="px-2 py-1 text-muted">searching…</p>;

  if (query.trim().length < MINIMUM_QUERY_LENGTH) {
    return (
      <p className="px-2 py-1 text-disabled">
        type at least {MINIMUM_QUERY_LENGTH} characters
      </p>
    );
  }

  if (!result) return null;

  const tilesWithHits = result.tiles.filter((tile) => tile.matches.length > 0).length;
  const parts = [
    result.matchCount === 0
      ? "no matches"
      : `${result.matchCount} in ${tilesWithHits} ${tilesWithHits === 1 ? "tile" : "tiles"}`,
  ];
  if (result.skipped > 0) parts.push(`${result.skipped} without text`);
  if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);

  return (
    <p className="px-2 py-1 text-muted" title={result.failed.join(", ")}>
      {parts.join(" · ")}
    </p>
  );
}

function TileGroup({
  tile,
  query,
}: {
  readonly tile: SearchTileResult;
  readonly query: string;
}) {
  return (
    <section>
      <header className="flex items-baseline gap-2 border-b border-border bg-surface-raised px-2 py-0.5">
        <span className="min-w-0 truncate text-fg-dim" title={tile.label}>
          {tile.label}
        </span>
        <span className="grow" />
        <span className="shrink-0 text-muted">
          {tile.matches.length}
          {tile.truncated ? "+" : ""}
        </span>
      </header>

      {tile.matches.map((match, index) => (
        <MatchRow
          // The location is the identity of a hit, and two hits never share
          // one; the index disambiguates the degenerate case of a plugin that
          // reports no range at all.
          key={`${match.location.subdivision ?? 0}:${match.location.range?.start ?? index}`}
          match={match}
          query={query}
          onSelect={() => revealSearchMatch(tile.clientId, match.location)}
        />
      ))}
    </section>
  );
}

function MatchRow({
  match,
  query,
  onSelect,
}: {
  readonly match: SearchMatch;
  readonly query: string;
  readonly onSelect: () => void;
}) {
  const context = ellipsize(match.context ?? match.text, 90);

  return (
    <button
      type="button"
      onClick={onSelect}
      title={context}
      className="flex w-full items-baseline gap-2 border-l border-l-transparent px-1 py-0.5 text-left text-muted hover:bg-surface-hover"
    >
      <span className="w-6 shrink-0 text-right text-disabled">
        {(match.location.subdivision ?? 0) + 1}
      </span>
      <span className="min-w-0 grow truncate">
        <Marked text={context} needle={query} />
      </span>
    </button>
  );
}

/**
 * The matched run, in the foreground colour, inside its context.
 *
 * Marking is done on the *context* string rather than by trusting an offset,
 * because the context a plugin returns is its own text with its own trimming
 * and there is no promise that the match's range indexes into it. Searching the
 * displayed string for the displayed query is the only version of this that
 * cannot be subtly wrong.
 */
function Marked({ text, needle }: { readonly text: string; readonly needle: string }) {
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;

  return (
    <>
      {text.slice(0, at)}
      <span className="bg-selection text-fg">{text.slice(at, at + needle.length)}</span>
      {text.slice(at + needle.length)}
    </>
  );
}
