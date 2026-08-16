/**
 * One document's overlay annotations, and the edits that can be made to them.
 *
 * The state is a single ordered array of immutable items, and *every* mutation
 * replaces it. That is what makes the rest of this file short:
 *
 *   - **z-order is the array order.** Last is frontmost, on screen and in the
 *     exported `/Annots`. "Bring to front" is a move within the array, not a
 *     property to keep in sync with anything.
 *   - **undo is a snapshot.** The items are immutable and shared by reference,
 *     so a history entry costs one array — a hundred of them share the one copy
 *     of a pasted image's bytes. A deep clone per edit would not.
 *
 * ## Why a drag is a transaction
 *
 * A pointer drag produces a change per frame. Recording each as its own undo
 * entry means undo replays the drag one mouse-move at a time, which is not what
 * anyone means by "undo that". {@link OverlayDocument.begin} captures the state
 * once, applies the intermediate states without touching the history, and pushes
 * a single entry on commit — so one drag is one undo, and an abandoned drag
 * (Escape, a pointer that left the window) restores exactly what was there.
 */

import { recomputeBounds, type OverlayItem } from "./model";

/** How many undo steps to keep. Beyond this the oldest is dropped. */
const HISTORY_LIMIT = 100;

export type OverlayChangeReason = "edit" | "undo" | "redo" | "replace";

export interface OverlayLiveEdit {
  /** Replaces the items mid-gesture, without touching the history. */
  update(items: readonly OverlayItem[]): void;
  /** Ends the gesture, recording everything it did as one undo entry. */
  commit(): void;
  /** Abandons the gesture and puts back what was there when it started. */
  cancel(): void;
}

export class OverlayDocument {
  #items: readonly OverlayItem[] = [];
  #undo: (readonly OverlayItem[])[] = [];
  #redo: (readonly OverlayItem[])[] = [];
  #listeners = new Set<(reason: OverlayChangeReason) => void>();
  #live: OverlayLiveEdit | null = null;

  get items(): readonly OverlayItem[] {
    return this.#items;
  }

  get isEmpty(): boolean {
    return this.#items.length === 0;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  subscribe(listener: (reason: OverlayChangeReason) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  find(id: string): OverlayItem | undefined {
    return this.#items.find((item) => item.id === id);
  }

  /** Everything on one subdivision, in z-order. */
  itemsOn(subdivision: number): readonly OverlayItem[] {
    return this.#items.filter((item) => item.subdivision === subdivision);
  }

  // -------------------------------------------------------------------------
  // Edits
  // -------------------------------------------------------------------------

  add(item: OverlayItem): void {
    this.#commit([...this.#items, withBounds(item)]);
  }

  /**
   * Applies a patch to one item.
   *
   * Bounds are re-derived rather than trusted from the caller: a patch that
   * changes an ink stroke or a shape's endpoints changes the box too, and the
   * one thing that must never happen is geometry and bounds disagreeing — that
   * is a mark you cannot click on.
   */
  update(id: string, patch: (item: OverlayItem) => OverlayItem): void {
    const next = this.#mapItem(id, patch);
    if (next) this.#commit(next);
  }

  remove(id: string): void {
    if (!this.find(id)) return;
    this.#commit(this.#items.filter((item) => item.id !== id));
  }

  removeAll(ids: readonly string[]): void {
    const doomed = new Set(ids);
    if (![...doomed].some((id) => this.find(id))) return;
    this.#commit(this.#items.filter((item) => !doomed.has(item.id)));
  }

  clear(): void {
    if (this.isEmpty) return;
    this.#commit([]);
  }

  bringToFront(id: string): void {
    const item = this.find(id);
    if (!item || this.#items.at(-1)?.id === id) return;
    this.#commit([...this.#items.filter((other) => other.id !== id), item]);
  }

  sendToBack(id: string): void {
    const item = this.find(id);
    if (!item || this.#items[0]?.id === id) return;
    this.#commit([item, ...this.#items.filter((other) => other.id !== id)]);
  }

  /**
   * Replaces every item, e.g. from restored session state.
   *
   * Clears the history rather than recording an entry: undoing back past a
   * restore into the *previous* document's marks would be a bug, not a feature.
   */
  replaceAll(items: readonly OverlayItem[]): void {
    this.#items = items.map(withBounds);
    this.#undo = [];
    this.#redo = [];
    this.#notify("replace");
  }

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  begin(): OverlayLiveEdit {
    // A gesture starting while another is open means a pointer was lost — a
    // capture that never released, a tile that closed mid-drag. Cancelling the
    // old one puts its state back rather than folding two gestures into one
    // undo entry.
    this.#live?.cancel();

    const before = this.#items;
    let closed = false;

    const edit: OverlayLiveEdit = {
      update: (items) => {
        if (closed) return;
        this.#items = items.map(withBounds);
        this.#notify("edit");
      },
      commit: () => {
        if (closed) return;
        closed = true;
        this.#live = null;
        if (this.#items === before) return;
        this.#pushHistory(before);
        this.#notify("edit");
      },
      cancel: () => {
        if (closed) return;
        closed = true;
        this.#live = null;
        if (this.#items === before) return;
        this.#items = before;
        this.#notify("edit");
      },
    };

    this.#live = edit;
    return edit;
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  undo(): boolean {
    const previous = this.#undo.pop();
    if (!previous) return false;
    this.#redo.push(this.#items);
    this.#items = previous;
    this.#notify("undo");
    return true;
  }

  redo(): boolean {
    const next = this.#redo.pop();
    if (!next) return false;
    this.#undo.push(this.#items);
    this.#items = next;
    this.#notify("redo");
    return true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #mapItem(
    id: string,
    patch: (item: OverlayItem) => OverlayItem,
  ): readonly OverlayItem[] | null {
    let touched = false;
    const next = this.#items.map((item) => {
      if (item.id !== id) return item;
      touched = true;
      return withBounds(patch(item));
    });
    return touched ? next : null;
  }

  #commit(next: readonly OverlayItem[]): void {
    this.#pushHistory(this.#items);
    this.#items = next;
    this.#notify("edit");
  }

  #pushHistory(snapshot: readonly OverlayItem[]): void {
    this.#undo.push(snapshot);
    if (this.#undo.length > HISTORY_LIMIT) this.#undo.shift();
    // Any new edit invalidates the redo branch — the standard linear history,
    // and the one users expect.
    this.#redo = [];
  }

  #notify(reason: OverlayChangeReason): void {
    for (const listener of this.#listeners) {
      try {
        listener(reason);
      } catch (thrown) {
        console.error("[annotation] overlay listener threw", thrown);
      }
    }
  }
}

/** Keeps `bounds` derived from the geometry it describes. */
function withBounds(item: OverlayItem): OverlayItem {
  const bounds = recomputeBounds(item);
  return bounds === item.bounds ? item : ({ ...item, bounds } as OverlayItem);
}
