/**
 * Toolbar controls contributed by mounted viewer plugins.
 *
 * The toolbar and the tile that owns a plugin instance are siblings in the
 * tree, so the contribution has to travel through state rather than props.
 * Controls are stored per workspace-client id and the toolbar reads only the
 * focused client's — which is what makes "PDF's invert toggle appears only
 * when a PDF tile is focused" fall out for free, without the toolbar knowing
 * what a PDF is.
 *
 * The control objects themselves carry callbacks and are therefore not
 * serializable. That is fine here and different from the decode state rule in
 * `viewers/instances.ts`: these are small, are replaced wholesale rather than
 * mutated, and re-rendering on change is exactly what we want.
 */

import { create } from "zustand";

import type { ToolbarControl } from "../viewers";

interface ToolbarState {
  readonly contributions: Readonly<Record<string, readonly ToolbarControl[]>>;

  /** Replaces a tile's contribution. An empty array is a valid contribution. */
  setContributions(clientId: string, controls: readonly ToolbarControl[]): void;

  /** Called when a tile unmounts, so a closed tile leaves nothing behind. */
  clearContributions(clientId: string): void;
}

export const useToolbarStore = create<ToolbarState>((set) => ({
  contributions: {},

  setContributions(clientId, controls) {
    set((state) => ({
      contributions: { ...state.contributions, [clientId]: controls },
    }));
  },

  clearContributions(clientId) {
    set((state) => {
      if (!(clientId in state.contributions)) return state;
      const next = { ...state.contributions };
      delete next[clientId];
      return { contributions: next };
    });
  },
}));

/** Contribution order, then declared order. Stable across re-reads. */
export function sortToolbarControls(
  controls: readonly ToolbarControl[],
): readonly ToolbarControl[] {
  return [...controls].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
