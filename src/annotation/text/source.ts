/**
 * The seam between the text-anchor model and the file type it is anchored in.
 *
 * Everything in `annotation/text/` is written against these four methods and
 * nothing else, which is the whole point of the phase: a `TextAnchor` is a
 * quote and two hints, and turning either of those into something on screen
 * needs knowledge that only a plugin has — where the glyphs are, what the
 * user has selected, how the document divides up. So the plugin supplies it.
 *
 * The PDF plugin implements this in `viewers/pdf/textGeometry.ts` over pdf.js's
 * text items. A future `txt` plugin implements `textOf` as "the file", and
 * `regionsFor` as "the box of that character range in the laid-out view", and
 * gets highlighting, notes, the sidebar list and the export bridge with no
 * change to any file in this directory. If a PDF-shaped branch ever appears in
 * here, the boundary is in the wrong place and the branch belongs on the other
 * side of it.
 *
 * It is reachable from the shell as well as from inside a tile: the contract
 * carries it as `ViewerAnnotationApi.textAnchors`, which is how phase 06's
 * command palette will be able to say "highlight the selection" without
 * knowing what kind of file is focused.
 */

import type { NormalizedRect } from "../geometry";
import type { TextAnchor } from "./anchor";

/** A half-open character range within one subdivision's text. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * What the anchor model needs from a plugin to *resolve* an anchor.
 *
 * Separate from {@link TextAnchorCapability} because resolution is all the
 * model itself ever does: a self-test, or a headless re-resolution during a
 * save, can supply these three over a plain string array with no viewer, no
 * DOM and no selection anywhere in sight.
 */
export interface TextAnchorSource {
  /** How many subdivisions there are to search. */
  readonly subdivisionCount: number;

  /**
   * One subdivision's text, in reading order.
   *
   * The string every offset in a {@link TextAnchor} is an offset into. It must
   * be derived the same way every time — an implementation that returns a
   * different concatenation on Tuesday has not broken the anchors (the quote
   * still finds them) but has made every hint useless.
   */
  textOf(subdivision: number): Promise<string>;

  /**
   * Where a character range sits, as `0..1` boxes over the subdivision.
   *
   * One rectangle per run of text on one line, so a range crossing a line wrap
   * comes back as several contiguous boxes rather than one that swallows the
   * margin between them.
   */
  regionsFor(
    subdivision: number,
    range: TextRange,
  ): Promise<readonly NormalizedRect[]>;
}

/** The whole capability a plugin publishes: resolution, plus authoring. */
export interface TextAnchorCapability extends TextAnchorSource {
  /**
   * An anchor for whatever the user has selected inside this viewer, or `null`
   * if the selection is empty, is not in this viewer, or holds no words.
   *
   * The one method that has to be asked of the plugin rather than derived: only
   * it knows how its rendered text maps back to the offsets `textOf` reports.
   */
  anchorForSelection(): Promise<TextAnchor | null>;
}
