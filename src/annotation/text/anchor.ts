/**
 * The `TextAnchor`: what identifies an annotation attached to *words* rather
 * than to a place on the paper.
 *
 * ## A quote, not a coordinate
 *
 * `{ quote, prefix, suffix, pageHint, offsetHint }` — the W3C Web Annotation
 * Data Model's `TextQuoteSelector` plus a positional hint, not invented here.
 * The quote and its surrounding context *are* the annotation's identity; the
 * two hints are a fast path to skip straight to the right spot and are always
 * re-verified against the quote rather than trusted outright. That is the
 * difference between an annotation that survives the document being reflowed,
 * re-OCR'd, or re-extracted by a slightly different pdf.js, and a bounding box,
 * which survives none of those.
 *
 * ## Nothing here knows what a page is
 *
 * Offsets are character offsets into "the text of one subdivision", and a
 * subdivision is whatever the file divides into (AGENTS.md's word). The half of
 * this that *is* file-type-specific — turning a subdivision's glyph geometry
 * into rectangles, and turning a live selection into a character range — is
 * reached through {@link TextAnchorSource}, which the PDF plugin implements in
 * `viewers/pdf/textGeometry.ts`. A future `txt` plugin implements the same
 * three methods against plain character offsets and gets everything in this
 * directory unchanged.
 */

import type { TextAnchorSource } from "./source";

/**
 * How much context to keep on each side of the quote.
 *
 * Enough to disambiguate a short quote that occurs many times ("the", "Figure
 * 2") and short enough that a paragraph's worth of edits around the mark does
 * not invalidate it. Forty characters is roughly six words either side, which is
 * the range the Web Annotation implementations in the wild settled on.
 */
export const ANCHOR_CONTEXT_CHARS = 40;

/**
 * How many subdivisions a lost anchor may be searched over before giving up.
 *
 * A bound rather than a whole-document scan: every subdivision costs a text
 * extraction, and on a 900-page book an anchor whose quote was genuinely deleted
 * would otherwise spend 900 of them proving it. Searched nearest-to-the-hint
 * first, so the realistic case — a page inserted or removed ahead of the mark —
 * is found in the first few.
 */
export const ANCHOR_SEARCH_BUDGET = 64;

export interface TextAnchor {
  /** The selected text itself. The durable identity. */
  readonly quote: string;
  /** Up to {@link ANCHOR_CONTEXT_CHARS} of text immediately before the quote. */
  readonly prefix: string;
  /** Up to {@link ANCHOR_CONTEXT_CHARS} of text immediately after the quote. */
  readonly suffix: string;
  /** Which subdivision the quote was on when it was made. A hint, not a fact. */
  readonly pageHint: number;
  /** Where in that subdivision's text it started. Also only a hint. */
  readonly offsetHint: number;
}

/** Where an anchor was found, now. */
export interface TextAnchorMatch {
  readonly subdivision: number;
  readonly start: number;
  readonly end: number;
  /**
   * Whether the hint was still correct.
   *
   * Not used to decide anything — the quote decides — but reported because "the
   * hints have drifted" is exactly the state a re-save should write back, and
   * because a self-test that cannot tell the fast path from the search cannot
   * prove the search works.
   */
  readonly viaHint: boolean;
}

/**
 * Builds an anchor for `[start, end)` within one subdivision's text.
 *
 * Returns `null` for a selection with no actual words in it — a stray click, a
 * drag that caught only whitespace — because an anchor whose quote is empty
 * matches at every offset in the document, which is worse than no anchor.
 */
export function buildTextAnchor(options: {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly subdivision: number;
}): TextAnchor | null {
  const text = options.text;
  const start = clampIndex(Math.min(options.start, options.end), text.length);
  const end = clampIndex(Math.max(options.start, options.end), text.length);
  const quote = text.slice(start, end);
  if (!quote.trim()) return null;

  return {
    quote,
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start),
    suffix: text.slice(end, end + ANCHOR_CONTEXT_CHARS),
    pageHint: options.subdivision,
    offsetHint: start,
  };
}

/**
 * Finds the anchor's quote in one subdivision's text.
 *
 * Two passes, in order:
 *
 *   1. **Exact.** Every occurrence of the quote, scored by how much of the
 *      recorded context still sits around it. This is what disambiguates the
 *      fifth "see below" on a page from the other four.
 *   2. **Whitespace-tolerant.** Runs of whitespace collapsed to one space on
 *      both sides, with a map back to the original offsets. This is the pass
 *      that earns the model its keep: two extractions of the same page can
 *      disagree about whether a line break is a newline, a space or nothing at
 *      all — pdf.js decides per text item, and an OCR pass decides per scan —
 *      and a highlight that vanishes because the space it recorded became a
 *      newline is exactly the failure a quote model is supposed to prevent.
 */
export function matchAnchorInText(
  anchor: TextAnchor,
  text: string,
): { readonly start: number; readonly end: number } | null {
  const exact = bestOccurrence(text, anchor.quote, anchor, (index) => index);
  if (exact) return exact;

  const flatText = collapseWhitespace(text);
  const flatQuote = collapseWhitespace(anchor.quote).value.trim();
  if (!flatQuote) return null;

  const flatAnchor: TextAnchor = {
    ...anchor,
    quote: flatQuote,
    prefix: collapseWhitespace(anchor.prefix).value,
    suffix: collapseWhitespace(anchor.suffix).value,
    // The hint is an offset into the *original* text, so it means nothing in
    // collapsed space. Zero rather than a wrong number: proximity scoring only
    // breaks ties, and a tie broken by a meaningless offset is a coin toss
    // dressed up as a decision.
    offsetHint: 0,
  };

  return bestOccurrence(
    flatText.value,
    flatQuote,
    flatAnchor,
    (index) => flatText.map[index] ?? text.length,
    flatAnchor.offsetHint === 0,
  );
}

/**
 * Resolves an anchor against a whole document.
 *
 * The hinted subdivision first and by the fast path (does the quote still start
 * exactly where it says?), then the same subdivision by search, then outwards.
 * A resolution that had to look elsewhere is not a degraded result — it is the
 * feature — but it is reported as one so a caller can write the corrected hints
 * back.
 */
export async function resolveTextAnchor(
  anchor: TextAnchor,
  source: TextAnchorSource,
): Promise<TextAnchorMatch | null> {
  const count = Math.max(0, source.subdivisionCount);
  if (count === 0) return null;

  const order = searchOrder(anchor.pageHint, count).slice(0, ANCHOR_SEARCH_BUDGET);
  for (const [attempt, subdivision] of order.entries()) {
    let text: string;
    try {
      text = await source.textOf(subdivision);
    } catch {
      // A subdivision whose text cannot be read is not a reason to abandon the
      // rest of the document.
      continue;
    }
    if (!text) continue;

    if (attempt === 0 && text.startsWith(anchor.quote, anchor.offsetHint)) {
      return {
        subdivision,
        start: anchor.offsetHint,
        end: anchor.offsetHint + anchor.quote.length,
        viaHint: true,
      };
    }

    const match = matchAnchorInText(anchor, text);
    if (match) return { subdivision, ...match, viaHint: false };
  }
  return null;
}

/** The hinted subdivision, then its neighbours, nearest first. */
export function searchOrder(hint: number, count: number): number[] {
  const start = clampIndex(Math.round(hint), Math.max(0, count - 1));
  const order = [start];
  for (let distance = 1; order.length < count; distance += 1) {
    if (start - distance >= 0) order.push(start - distance);
    if (start + distance < count) order.push(start + distance);
    if (start - distance < 0 && start + distance >= count) break;
  }
  return order;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.round(value), max));
}

/**
 * The occurrence of `needle` whose surroundings best match the anchor's.
 *
 * `toOriginal` maps an index in the searched string back to an index in the
 * text the caller cares about, which is the identity for the exact pass and the
 * collapse map for the tolerant one.
 */
function bestOccurrence(
  haystack: string,
  needle: string,
  anchor: TextAnchor,
  toOriginal: (index: number) => number,
  ignoreOffsetHint = false,
): { readonly start: number; readonly end: number } | null {
  if (!needle) return null;

  let best: { start: number; end: number; score: number; distance: number } | null =
    null;

  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    const score =
      commonSuffixLength(haystack.slice(Math.max(0, at - anchor.prefix.length), at), anchor.prefix) +
      commonPrefixLength(haystack.slice(end, end + anchor.suffix.length), anchor.suffix);
    const distance = ignoreOffsetHint ? 0 : Math.abs(at - anchor.offsetHint);

    if (
      !best ||
      score > best.score ||
      // Context is the tiebreaker that matters; distance from where it used to
      // be only settles a draw between two equally plausible occurrences.
      (score === best.score && distance < best.distance)
    ) {
      best = { start: at, end, score, distance };
    }
  }

  if (!best) return null;
  const start = toOriginal(best.start);
  const end = toOriginal(best.end - 1) + 1;
  return end > start ? { start, end } : null;
}

/** Runs of whitespace to one space, with an index map back to the original. */
function collapseWhitespace(text: string): { value: string; map: number[] } {
  let value = "";
  const map: number[] = [];
  let inRun = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (/\s/.test(character)) {
      if (inRun) continue;
      inRun = true;
      value += " ";
      map.push(index);
      continue;
    }
    inRun = false;
    value += character;
    map.push(index);
  }
  return { value, map };
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let count = 0;
  while (count < limit && a[count] === b[count]) count += 1;
  return count;
}

function commonSuffixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let count = 0;
  while (count < limit && a[a.length - 1 - count] === b[b.length - 1 - count]) {
    count += 1;
  }
  return count;
}
