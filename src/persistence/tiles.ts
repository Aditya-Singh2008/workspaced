/**
 * The two things a restored tile needs that do not belong in a store.
 *
 * **Its recorded file reference.** A tile whose file has moved has no
 * `FileHandle` to ask for one, and the next save must still write the tile out
 * — otherwise quitting an app that is showing "report.pdf could not be found"
 * silently forgets the tile, and the second restart comes back with one tile
 * fewer than the first. It is also what "retry" and "locate…" work from.
 *
 * **Its saved viewer state.** Opaque plugin data with no business in a reactive
 * store: it is neither render-relevant nor small, it is read exactly once — by
 * the mount that consumes it — and holding it in Zustand would re-render every
 * consumer of the client list on the way past. Same reasoning as
 * `viewers/instances.ts` and `files/store.ts`, one more time.
 *
 * Both are keyed by workspace-client id and dropped when the client goes.
 */

import type { PersistedFileRef } from "../files";

interface TileSource {
  readonly file: PersistedFileRef;
  /** Consumed by the first successful mount; see `clearRestoredState`. */
  state?: unknown;
}

const sources = new Map<string, TileSource>();

/** Records what a restored client was built from. */
export function rememberTileSource(
  clientId: string,
  file: PersistedFileRef,
  state?: unknown,
): void {
  sources.set(clientId, { file, state });
}

/** The reference a restore is working from, for a client with no handle. */
export function recordedFileRef(clientId: string): PersistedFileRef | undefined {
  return sources.get(clientId)?.file;
}

/**
 * The state to hand this client's first mount, if it is a restored one.
 *
 * Read rather than taken, because a mount can fail — a file that is there but
 * unreadable — and the retry that follows deserves the same state the first
 * attempt had. It is dropped once a mount succeeds, at which point the live
 * instance is the authority and the next save reads from it instead.
 */
export function restoredViewerState(clientId: string): unknown {
  return sources.get(clientId)?.state;
}

export function clearRestoredState(clientId: string): void {
  const source = sources.get(clientId);
  if (source) source.state = undefined;
}

/** Drops everything for clients that no longer exist. */
export function forgetTilesExcept(clientIds: Iterable<string>): void {
  const live = new Set(clientIds);
  for (const id of [...sources.keys()]) {
    if (!live.has(id)) sources.delete(id);
  }
}

/** Test hook: forget every recorded tile. */
export function forgetAllTiles(): void {
  sources.clear();
}
