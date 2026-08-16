/**
 * One document's text-anchored annotations, and where they currently sit.
 *
 * Deliberately smaller than {@link OverlayDocument}, and the two differences are
 * the interesting part:
 *
 *   - **No history.** A drawn mark is made by a drag, which produces a hundred
 *     intermediate states and needs a transaction to collapse them into one
 *     undo. A text mark is made by pressing one button on a popover: there is no
 *     gesture to collapse, the result is visible immediately, and it is removed
 *     from the same sidebar list as everything else. A `Mod+Z` that took back
 *     some marks and not others would be worse than one that takes back none.
 *   - **Placements, which are cached and not owned.** An item has no position;
 *     it has an anchor, and a position is what resolving that anchor against the
 *     current document *produces*. The map here is the last such answer, kept so
 *     that `listAnnotations()` — which the contract requires to be synchronous —
 *     has a subdivision and a rectangle to hand the sidebar without doing I/O.
 *     It is derived state: throwing it away costs a re-resolution, never a mark.
 */

import type {
  TextAnnotationItem,
  TextAnnotationPlacement,
  ResolvedTextAnnotation,
} from "./model";

export type TextAnnotationChangeReason = "edit" | "replace" | "place";

export class TextAnnotationDocument {
  #items: readonly TextAnnotationItem[] = [];
  #placements = new Map<string, TextAnnotationPlacement>();
  #listeners = new Set<(reason: TextAnnotationChangeReason) => void>();

  get items(): readonly TextAnnotationItem[] {
    return this.#items;
  }

  get isEmpty(): boolean {
    return this.#items.length === 0;
  }

  subscribe(listener: (reason: TextAnnotationChangeReason) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  find(id: string): TextAnnotationItem | undefined {
    return this.#items.find((item) => item.id === id);
  }

  placement(id: string): TextAnnotationPlacement | undefined {
    return this.#placements.get(id);
  }

  /** Everything currently resolved onto one subdivision, in creation order. */
  itemsOn(subdivision: number): readonly TextAnnotationItem[] {
    return this.#items.filter(
      (item) => this.#placements.get(item.id)?.subdivision === subdivision,
    );
  }

  add(item: TextAnnotationItem): void {
    this.#items = [...this.#items, item];
    this.#notify("edit");
  }

  update(
    id: string,
    patch: (item: TextAnnotationItem) => TextAnnotationItem,
  ): void {
    let touched = false;
    const next = this.#items.map((item) => {
      if (item.id !== id) return item;
      touched = true;
      return patch(item);
    });
    if (!touched) return;
    this.#items = next;
    this.#notify("edit");
  }

  remove(id: string): void {
    if (!this.find(id)) return;
    this.#items = this.#items.filter((item) => item.id !== id);
    this.#placements.delete(id);
    this.#notify("edit");
  }

  clear(): void {
    if (this.isEmpty) return;
    this.#items = [];
    this.#placements.clear();
    this.#notify("edit");
  }

  /** Replaces every item, e.g. from restored session state. */
  replaceAll(items: readonly TextAnnotationItem[]): void {
    this.#items = [...items];
    this.#placements.clear();
    this.#notify("replace");
  }

  /**
   * Records where every item resolved to.
   *
   * Notifies with `"place"` and only when something actually moved, which is
   * what keeps a resolution pass from waking the pass that produced it: a
   * listener that re-resolves on `"edit"` and redraws on `"place"` cannot loop.
   */
  setPlacements(resolved: readonly ResolvedTextAnnotation[]): void {
    let changed = false;
    const seen = new Set<string>();

    for (const entry of resolved) {
      seen.add(entry.item.id);
      const previous = this.#placements.get(entry.item.id);
      if (!samePlacement(previous, entry.placement)) {
        this.#placements.set(entry.item.id, entry.placement);
        changed = true;
      }
    }
    for (const id of [...this.#placements.keys()]) {
      if (!seen.has(id) && !this.find(id)) {
        this.#placements.delete(id);
        changed = true;
      }
    }

    if (changed) this.#notify("place");
  }

  #notify(reason: TextAnnotationChangeReason): void {
    for (const listener of this.#listeners) {
      try {
        listener(reason);
      } catch (thrown) {
        console.error("[annotation] text listener threw", thrown);
      }
    }
  }
}

function samePlacement(
  a: TextAnnotationPlacement | undefined,
  b: TextAnnotationPlacement,
): boolean {
  if (!a) return false;
  if (a.subdivision !== b.subdivision) return false;
  if (a.range.start !== b.range.start || a.range.end !== b.range.end) return false;
  if (a.rects.length !== b.rects.length) return false;
  return a.rects.every((rect, index) => {
    const other = b.rects[index]!;
    return (
      Math.abs(rect.x - other.x) < 1e-9 &&
      Math.abs(rect.y - other.y) < 1e-9 &&
      Math.abs(rect.width - other.width) < 1e-9 &&
      Math.abs(rect.height - other.height) < 1e-9
    );
  });
}
