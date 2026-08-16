/** Small helpers shared across the plugin. */

import type { NormalizedRect } from "../../annotation";

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Puts an element over a page at a normalized box.
 *
 * Percentages rather than pixels, matching the reveal highlight and the
 * annotation layer: the page element is the containing block, so a zoom moves
 * the box with the paper and nothing has to be repositioned. Shared by both
 * annotation models — a note bubble is a note bubble whether the note is pinned
 * to a point or to a sentence.
 */
export function placeOverPage(element: HTMLElement, box: NormalizedRect): void {
  element.style.left = `${box.x * 100}%`;
  element.style.top = `${box.y * 100}%`;
  element.style.width = `${box.width * 100}%`;
  element.style.height = `${box.height * 100}%`;
}

/**
 * The size of a note's popup — the editor and the read-only reader alike — in
 * page points. Wide enough for a sentence, short enough not to bury the page.
 */
export const NOTE_BUBBLE = { width: 190, height: 90 } as const;

/** That bubble as a normalized box, kept inside the page and beside `anchor`. */
export function noteBubbleBox(
  anchor: NormalizedRect,
  page: { width: number; height: number },
): NormalizedRect {
  const width = NOTE_BUBBLE.width / page.width;
  const height = NOTE_BUBBLE.height / page.height;
  return {
    x: clamp(anchor.x + anchor.width, 0, Math.max(0, 1 - width)),
    y: clamp(anchor.y, 0, Math.max(0, 1 - height)),
    width,
    height,
  };
}
