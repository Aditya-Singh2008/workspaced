/**
 * The dockview theme for this app.
 *
 * dockview themes are two halves: a CSS class defining `--dv-*` custom
 * properties (see `.dockview-theme-workspace` in `src/theme/theme.css`, which
 * maps every one of them onto our design tokens) and this object, which
 * carries the handful of settings dockview needs in JavaScript rather than
 * CSS — the inter-group gap among them.
 *
 * The gap is the whole reason this is a function: "increase/decrease gap
 * between panels" is a phase 02 keybind, and dockview applies a new gap
 * natively through `api.updateOptions({ theme })`. Nothing here computes a
 * position.
 */

import type { DockviewTheme } from "dockview-react";

/** The class defining the `--dv-*` variables. Must match `theme.css`. */
export const WORKSPACE_DOCKVIEW_THEME_CLASS = "dockview-theme-workspace";

/**
 * The gap sizes the keybind cycles through, in pixels. Discrete rather than
 * continuous so the layout can only ever land on a value that looks
 * deliberate, and so the step size does not depend on the current value.
 *
 * Four values, down from six, because the gap is now reached by a single
 * cycling key rather than a widen/narrow pair — the shortest way back to a
 * value you overshot is to keep going, so the lap has to be short.
 */
export const GAP_STEPS = [0, 4, 8, 16] as const;

/**
 * Starts at zero: every tile draws its own 1px border (see `theme.css`), so
 * tiles are already separated and an added gap only pushes them apart.
 */
export const DEFAULT_GAP_INDEX = 0;

/**
 * Wraps rather than clamping. A gap is a set-once preference and did not earn
 * two shortcuts; with one key, wrapping is what makes every value reachable.
 */
export function cycleGapIndex(index: number, delta: number): number {
  const count = GAP_STEPS.length;
  return (((index + delta) % count) + count) % count;
}

export function workspaceDockviewTheme(gap: number): DockviewTheme {
  return {
    name: "workspace",
    className: WORKSPACE_DOCKVIEW_THEME_CLASS,
    colorScheme: "dark",
    gap,
    // Mount the drag overlay on the dockview root so the drop-zone indicator
    // is drawn above the panel content a viewer plugin owns.
    dndOverlayMounting: "absolute",
    // Highlight the whole group, header included, so the target of a drop is
    // unambiguous when groups are stacked as tabs.
    dndPanelOverlay: "group",
    // A 1px insertion line rather than a filled block, per the visual language.
    dndTabIndicator: "line",
    dndOverlayBorder: "1px solid var(--color-accent)",
    // A flat continuous bar; the Chrome-style wrapped underline is exactly the
    // kind of decoration the design language rules out.
    tabGroupIndicator: "none",
    tabAnimation: "default",
  };
}
