/**
 * The text-anchored annotation model: marks that answer "which words".
 *
 * The other half of AGENTS.md's two targeting strategies. An
 * {@link OverlayItem} carries a position and nothing else; a
 * {@link TextAnnotationItem} carries a {@link TextAnchor} and *no position at
 * all* — its rectangles are derived at render time from wherever those words
 * currently sit. That is not a stylistic difference: it is what lets a
 * highlight survive the document being re-extracted, re-OCR'd or reflowed, and
 * it is why conflating the two produced a highlight that could not survive a
 * font substitution on export.
 *
 * ## One item type, not two
 *
 * The phase brief asks for "Highlight" and "Add note" as two actions, and they
 * produce one kind of thing: "Add note" *is* a highlight, plus a comment
 * attached to the same anchor. Modelling them as two item types would mean two
 * resolution paths, two export paths and a decision to make every time a note is
 * emptied. So there is one item with an optional {@link TextAnnotationItem.note}
 * — and the *word* for it (`quote` or `comment`) is derived from whether that
 * note is there, which is the only place the distinction is real.
 */

import type { AnnotationSummary } from "../model";
import type { NormalizedRect } from "../geometry";
import { unionRects } from "../geometry";
import { resolveTextAnchor, type TextAnchor } from "./anchor";
import type { TextAnchorSource, TextRange } from "./source";

export interface TextAnnotationItem {
  /** Unique within a document. Written into the exported annotation's `/NM`. */
  readonly id: string;

  /** Which words this is attached to. The whole identity of the mark. */
  readonly anchor: TextAnchor;

  /** `#rrggbb`. The same ink palette the drawn tools use. */
  readonly color: string;

  /** `0..1`. Applied to the exported annotation's `/CA` as well as on screen. */
  readonly opacity: number;

  /** The comment attached to these words, if the user wrote one. */
  readonly note?: string;

  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Bumped when the item schema changes incompatibly. */
export const TEXT_ANNOTATION_VERSION = 1;

/** Where an item's words currently are. Derived, never stored on the item. */
export interface TextAnnotationPlacement {
  readonly subdivision: number;
  readonly range: TextRange;
  /** One box per line the quote covers. Empty when the quote could not be found. */
  readonly rects: readonly NormalizedRect[];
  /** Whether the anchor's own hints were still correct. */
  readonly viaHint: boolean;
}

export interface ResolvedTextAnnotation {
  readonly item: TextAnnotationItem;
  readonly placement: TextAnnotationPlacement;
}

let itemCounter = 0;

/**
 * A fresh item id.
 *
 * A distinct prefix from the overlay's, because both models' ids end up as `/NM`
 * values in one file and in one `removeAnnotation(id)` call — so being able to
 * tell at a glance which model an id came from is worth two characters.
 */
export function nextTextAnnotationId(): string {
  itemCounter += 1;
  return `tx${itemCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function textAnnotationStamp(): {
  id: string;
  createdAt: number;
  updatedAt: number;
} {
  const now = Date.now();
  return { id: nextTextAnnotationId(), createdAt: now, updatedAt: now };
}

/** The word the UI uses. Not the export subtype — both export a `/Highlight`. */
export function textAnnotationTypeLabel(item: TextAnnotationItem): string {
  return item.note?.trim() ? "comment" : "quote";
}

/** How much of the quote a one-line list row can show. */
const LABEL_QUOTE_CHARS = 38;

/**
 * A short label for the annotation list.
 *
 * The quote first, always, because the point of this model is the words: a row
 * saying "highlight on page 4" is exactly the position-shaped answer this whole
 * targeting strategy exists to stop giving. The note follows it when there is
 * one, since a comment's own text is the thing its author will scan for.
 */
export function textAnnotationLabel(item: TextAnnotationItem): string {
  const quote = truncate(collapse(item.anchor.quote), LABEL_QUOTE_CHARS);
  const note = collapse(item.note ?? "");
  return note ? `“${quote}” — ${truncate(note, LABEL_QUOTE_CHARS)}` : `“${quote}”`;
}

/**
 * The shell's view of these items, newest first.
 *
 * `placement` is asked for rather than stored on the item, because an item has
 * no position — and it may legitimately have no *answer* either, when the words
 * are no longer in the document. An unresolved mark still lists (it is still a
 * mark, and deleting it is the user's call, not ours); it just points at the
 * subdivision the anchor remembers, with no box to highlight.
 */
export function summarizeTextAnnotations(
  items: readonly TextAnnotationItem[],
  placement: (id: string) => TextAnnotationPlacement | undefined,
): readonly AnnotationSummary[] {
  return [...items]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((item) => {
      const placed = placement(item.id);
      return {
        id: item.id,
        type: textAnnotationTypeLabel(item),
        label: textAnnotationLabel(item),
        subdivision: placed?.subdivision ?? item.anchor.pageHint,
        rect: placed?.rects.length
          ? unionRects(placed.rects)
          : { x: 0, y: 0, width: 0, height: 0 },
        createdAt: item.createdAt,
      };
    });
}

/**
 * Resolves every item against the document as it is *now*.
 *
 * One pass over the marks, not over the pages: a document with four highlights
 * costs four text extractions however long it is, and the plugin's own cache
 * makes a second pass free. Items whose quote has gone are returned with an
 * empty rectangle list rather than dropped — losing the words is not losing the
 * annotation.
 */
export async function resolveTextAnnotations(
  items: readonly TextAnnotationItem[],
  source: TextAnchorSource,
): Promise<readonly ResolvedTextAnnotation[]> {
  const out: ResolvedTextAnnotation[] = [];
  for (const item of items) {
    const match = await resolveTextAnchor(item.anchor, source);
    if (!match) {
      out.push({
        item,
        placement: {
          subdivision: item.anchor.pageHint,
          range: { start: item.anchor.offsetHint, end: item.anchor.offsetHint },
          rects: [],
          viaHint: false,
        },
      });
      continue;
    }
    const range = { start: match.start, end: match.end };
    let rects: readonly NormalizedRect[] = [];
    try {
      rects = await source.regionsFor(match.subdivision, range);
    } catch {
      // Geometry that cannot be produced is a mark with nowhere to draw, not a
      // failed resolution: the list entry and the note survive it.
      rects = [];
    }
    out.push({
      item,
      placement: {
        subdivision: match.subdivision,
        range,
        rects,
        viaHint: match.viaHint,
      },
    });
  }
  return out;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
