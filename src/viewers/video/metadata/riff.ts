/**
 * The RIFF chunk reader, for AVI.
 *
 * Only one format in this plugin is built on RIFF, so unlike `isobmff.ts` and
 * `ebml.ts` this reader has a single caller. It lives in `metadata/` anyway
 * rather than inside `avi/`, because the alternative is a format folder
 * containing a general-purpose chunk walker, and the convention this directory
 * exists to hold is that structure readers live here and format meaning lives in
 * the format folder.
 *
 * RIFF is the simplest of the four: a four-character id, a 32-bit little-endian
 * length, and a payload padded to an even length. `RIFF` and `LIST` chunks
 * additionally carry a four-character form type before their children. The
 * padding is the one thing that trips a naive walk — a chunk of odd length is
 * followed by a pad byte that is not part of it, and ignoring that puts every
 * subsequent chunk one byte out.
 */

import { ByteReader } from "../binary";

export interface RiffChunk {
  readonly id: string;
  readonly start: number;
  readonly bodyStart: number;
  readonly end: number;
  /** The form type of a `RIFF` or `LIST` chunk — `"AVI "`, `"hdrl"`, `"strl"`. */
  readonly form?: string;
}

const CHUNK_HEADER = 8;

/** Every chunk directly inside `[start, end)`, handling the even-length padding. */
export function* chunksIn(
  bytes: Uint8Array,
  start: number,
  end: number,
): Generator<RiffChunk> {
  let at = start;
  while (at + CHUNK_HEADER <= end) {
    const reader = new ByteReader(bytes, at);
    const id = reader.ascii(4);
    const size = reader.u32(at + 4, true);
    if (id === null || size === null) return;

    const bodyStart = at + CHUNK_HEADER;
    const bodyEnd = Math.min(bodyStart + size, end);

    const container = id === "RIFF" || id === "LIST";
    const form = container ? (new ByteReader(bytes, bodyStart).ascii(4) ?? undefined) : undefined;

    yield {
      id,
      start: at,
      // A container's children begin after its form type.
      bodyStart: container ? bodyStart + 4 : bodyStart,
      end: bodyEnd,
      form,
    };

    // Chunks are padded to an even length, and the pad byte belongs to nobody.
    const advance = CHUNK_HEADER + size + (size % 2);
    if (advance <= 0) return;
    at += advance;
  }
}

export function findChunk(
  bytes: Uint8Array,
  id: string,
  start: number,
  end: number,
  form?: string,
): RiffChunk | null {
  for (const chunk of chunksIn(bytes, start, end)) {
    if (chunk.id !== id) continue;
    if (form && chunk.form !== form) continue;
    return chunk;
  }
  return null;
}
