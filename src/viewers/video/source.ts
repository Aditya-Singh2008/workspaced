/**
 * Getting a URL the platform's media stack will actually stream.
 *
 * ## The rule this follows
 *
 * mpv opens a four-gigabyte film instantly. It does that by reading the header,
 * showing a frame, and pulling the rest of the file as it plays — never by
 * loading the file first. Any player that reads before it plays has a
 * time-to-first-frame proportional to the size of the file, which is the thing
 * that made this plugin slow to open anything.
 *
 * The `<video>` element does streaming reads natively, and does them well. All
 * it needs is a URL its media stack can resolve. So the whole job here is to
 * hand it one, in preference order, and the preferences are not guesses:
 *
 *   1. **A loopback HTTP URL** — `media.rs`. Streams by byte range, so opening a
 *      film costs the header and nothing else, and seeking costs one ranged
 *      request. This is the mpv-shaped path and it works on all three targets.
 *   2. **The app's `asset://` URL** — also streaming and one fewer moving part,
 *      but webkit2gtk cannot resolve it (GStreamer owns the URI and has never
 *      heard of the scheme), so it is the fallback rather than the default.
 *   3. **An object URL** — the whole file in memory. Kept only because a source
 *      neither of the above can serve is better watched than refused, and it is
 *      the path that was making loading slow when it was reached routinely.
 *
 * ## Everything is measured, nothing is asked
 *
 * None of these is chosen by sniffing the platform. Each is *tried*, and the
 * measurement in `mount.ts` decides — AGENTS.md: probe a capability by using it
 * and measuring the result, never by asking whether the API exists. A missing
 * loopback port and a webview that will not play HTTP both land in the same
 * place, one step down the list.
 */

import { invoke } from "@tauri-apps/api/core";

import type { FileHandle } from "../../files";

/** How the bytes reach the element. Reported by the info panel, and measured. */
export type MediaSourceKind = "loopback" | "asset" | "memory";

export interface MediaSource {
  readonly url: string;
  readonly kind: MediaSourceKind;
  /** Whether the platform fetches this by range instead of holding it all. */
  readonly streaming: boolean;
  release(): void;
}

/**
 * The ceiling on the in-memory fallback.
 *
 * Two gigabytes is generous for something held in RAM and is not a limit anyone
 * should be pleased about — it is the point past which the fallback is worse
 * than an honest refusal.
 */
const MAX_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

/** Read in chunks so no single allocation is the size of the film. */
const MEMORY_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * A streaming URL served over loopback, or `null` when one cannot be had.
 *
 * `null` covers a file with no path (a memory handle), a session running
 * outside Tauri, and a loopback port that could not be opened — none of which
 * is an error worth surfacing, because each simply moves the load one step down
 * the list.
 */
export async function openLoopbackStream(file: FileHandle): Promise<MediaSource | null> {
  if (!file.path) return null;

  let url: string;
  try {
    url = await invoke<string>("media_stream_url", { path: file.path });
  } catch (thrown) {
    console.warn("[video] the loopback media server is unavailable", thrown);
    return null;
  }

  const token = url.slice(url.lastIndexOf("/") + 1);
  let released = false;

  return {
    url,
    kind: "loopback",
    streaming: true,
    release: () => {
      if (released) return;
      released = true;
      // The grant outlives the tile otherwise, and a session that opened fifty
      // videos would leave fifty paths servable to anything that guessed a
      // 128-bit token. Cheap insurance, and it keeps the map bounded.
      void invoke("media_release", { token }).catch(() => {
        /* Teardown. A grant that cannot be revoked dies with the process. */
      });
    },
  };
}

/** The app's own asset URL, which streams wherever the webview resolves it. */
export function openAssetStream(file: FileHandle): MediaSource | null {
  const url = file.streamUrl();
  if (!url) return null;
  return {
    url,
    kind: "asset",
    streaming: true,
    release: () => {
      /* Nothing was allocated; the URL is a view onto the path. */
    },
  };
}

/**
 * The whole file as an object URL, or `null` when it is too large to hold.
 *
 * The slow path, by construction: nothing can be shown until the last byte has
 * crossed the IPC boundary. It exists so that a source the streaming paths
 * cannot serve still plays.
 */
export async function openMemorySource(
  file: FileHandle,
  signal?: AbortSignal,
): Promise<MediaSource | null> {
  if (file.size > MAX_MEMORY_BYTES) return null;

  // Ranged reads rather than `read()`: the handle memoizes what `read()`
  // returns, so that path would hold the film twice — once in the handle and
  // once in the blob. The chunks are handed to the `Blob` and dropped.
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < file.size; offset += MEMORY_CHUNK_BYTES) {
    signal?.throwIfAborted();
    chunks.push(await file.readRange(offset, Math.min(MEMORY_CHUNK_BYTES, file.size - offset)));
  }

  // Deliberately untyped: a blob with no type is sniffed from its own bytes,
  // and the declared type is what an engine on this path may just have refused.
  const url = URL.createObjectURL(new Blob(chunks as BlobPart[]));
  chunks.length = 0;

  let released = false;
  return {
    url,
    kind: "memory",
    streaming: false,
    release: () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    },
  };
}
