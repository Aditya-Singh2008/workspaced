/**
 * The Ogg page reader, for `ogv/`.
 *
 * Ogg is the odd one out among the four container structures in this plugin: it
 * is a *stream* format rather than a file format, with no header at the front
 * describing the whole thing. Every stream is a sequence of pages tagged with a
 * serial number, the pages of different streams are interleaved, and what a
 * player knows about a stream comes from the first page or two of that stream —
 * its "beginning of stream" page, which carries the codec's identification
 * header.
 *
 * Two consequences shape this reader:
 *
 *   - **The tracks are found at the front, and the duration at the back.** Each
 *     stream's identification header is in its first page, near the start of the
 *     file. The duration is the largest granule position on the last page of the
 *     video stream, which is at the end. So this reads a window at each end,
 *     which is exactly what `FileHandle.readRange` is for.
 *   - **Granule position means something different per codec.** For Theora it is
 *     a packed pair of frame counts; for Vorbis and Opus it is a sample count.
 *     Converting it to seconds therefore needs the codec's own rate, read from
 *     the same identification header — which is why duration is computed here
 *     rather than by a generic page walk.
 */

import type { FileHandle } from "../../../files";
import { ByteReader } from "../binary";

export interface OggPage {
  readonly start: number;
  readonly end: number;
  readonly serial: number;
  readonly granule: number;
  /** The page starts a logical stream: its payload is an identification header. */
  readonly beginsStream: boolean;
  readonly payload: Uint8Array;
}

const CAPTURE = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
/** Header up to the segment table: capture, version, flags, granule, serial, … */
const PAGE_HEADER = 27;

/**
 * Reads one page header at `at`, or `null` if there is not a page there.
 *
 * The page's length is the fixed header plus a segment table plus the sum of
 * that table — Ogg states no total length anywhere, which is what makes it a
 * stream format and what makes every walk over it a walk that has to add up the
 * segment lengths.
 */
export function readPage(bytes: Uint8Array, at: number): OggPage | null {
  if (at + PAGE_HEADER > bytes.length) return null;
  for (let index = 0; index < CAPTURE.length; index += 1) {
    if (bytes[at + index] !== CAPTURE[index]) return null;
  }

  const reader = new ByteReader(bytes, at + 5);
  const flags = reader.u8() ?? 0;
  const granule = reader.u64(at + 6, true) ?? 0;
  const serial = reader.u32(at + 14, true) ?? 0;

  const segmentCount = bytes[at + 26] ?? 0;
  const tableEnd = at + PAGE_HEADER + segmentCount;
  if (tableEnd > bytes.length) return null;

  let payloadLength = 0;
  for (let index = 0; index < segmentCount; index += 1) {
    payloadLength += bytes[at + PAGE_HEADER + index]!;
  }

  const end = tableEnd + payloadLength;
  if (end > bytes.length) return null;

  return {
    start: at,
    end,
    serial,
    granule,
    // Bit 1 of the header flags is "beginning of stream".
    beginsStream: (flags & 0x02) !== 0,
    payload: bytes.subarray(tableEnd, end),
  };
}

/** Every page in a buffer, stopping at the first thing that is not one. */
export function* pagesIn(bytes: Uint8Array, start = 0): Generator<OggPage> {
  let at = start;
  while (at < bytes.length) {
    const page = readPage(bytes, at);
    if (!page || page.end <= at) return;
    yield page;
    at = page.end;
  }
}

/**
 * The last page of each stream, found by scanning backwards from the end.
 *
 * The final page of a stream carries the largest granule position, which is the
 * only place a duration exists in an Ogg file. Scanning a window at the end
 * rather than the whole file is the same bargain every parser here makes — and
 * the window has to be resynchronised, because it almost certainly starts in the
 * middle of a page. That is what the capture pattern is for: `OggS` is the
 * format's designed resynchronisation point.
 */
export async function readTailGranules(
  file: FileHandle,
  size: number,
  windowBytes: number,
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const granules = new Map<number, number>();
  const start = Math.max(0, size - windowBytes);

  signal?.throwIfAborted();
  const tail = await file.readRange(start, size - start);

  // Find the first capture pattern in the window and walk forward from there.
  // Anything before it is the tail of a page whose header is outside the window
  // and which therefore cannot be read.
  let first = -1;
  for (let at = 0; at + 4 <= tail.length; at += 1) {
    if (
      tail[at] === CAPTURE[0] &&
      tail[at + 1] === CAPTURE[1] &&
      tail[at + 2] === CAPTURE[2] &&
      tail[at + 3] === CAPTURE[3]
    ) {
      first = at;
      break;
    }
  }
  if (first < 0) return granules;

  for (const page of pagesIn(tail, first)) {
    // `-1` is the granule for a page that completes no packet, and taking it as
    // a maximum would report a negative duration.
    if (page.granule > 0) {
      granules.set(page.serial, Math.max(granules.get(page.serial) ?? 0, page.granule));
    }
  }
  return granules;
}
