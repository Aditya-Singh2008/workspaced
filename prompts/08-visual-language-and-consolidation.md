# Phase 8: Visual Language and Toolbar Consolidation

Depends on Phases 1 through 7 being complete, since this phase audits the accumulated UI across every plugin and system built so far, rather than adding new functionality.

## Goal

Confirm the established tiling-window-manager visual language is applied consistently everywhere, and reduce the toolbar and status areas to only what every user genuinely needs, moving everything else to keybind-only with full discoverability through the keybind reference.

## Tasks

**Visual language audit**

1. Walk every component built across Phases 2 through 6 (docking chrome, toolbar, sidebar, command palette, search results, clipboard history, scratch panel, keybind reference, annotation controls, per-plugin toolbar contributions) and confirm each one consumes the Phase 1 Tailwind theme tokens exclusively: no hardcoded colors, no non-zero border-radius, no shadows, no gradients, monospace typography throughout.
2. Fix any component found styling itself independently of the theme file.

**Toolbar consolidation**

1. Classify every control currently surfaced in the toolbar (baseline shell controls from Phase 2 plus each plugin's contributed controls from Phases 3 and 4) into essential-always-visible, keybind-only, or redundant-remove-entirely, using the same criteria as the original design: essential means a first-time or occasional user would not discover it any other way and uses it frequently; keybind-only means it maps to a memorable shortcut power users reach for by habit; redundant means the information or action is duplicated elsewhere.
2. Reduce the toolbar to essential-only. For PDF: open, print, save/export, sidebar toggle, page navigation, zoom in/out with a single fit toggle, invert mode segmented control, keybind reference trigger. Master/swap/gap adjustment/reset-zoom/fit-page become keybind-only, as originally specified.
3. Move infrequent preference-tuning controls (tint swatch selection, gap size) into popovers attached to their related control, rather than permanent toolbar space.
4. Confirm the toolbar fits within a standard viewport width with no horizontal scrolling at any reasonable window size, across every plugin's contributed control set. If it still overflows, move additional items to keybind-only rather than accepting scroll behavior.

**Status area consolidation**

1. Reduce the status area to only glanceable, non-actionable state: current page/position indicator for the focused tile. Remove duplicated information already shown elsewhere (filename if already visible in the tile itself, layout mode if visually obvious from the tiling, client count, ratio/gap indicators which are better shown as transient labels during the drag interaction itself rather than permanent status text).

**Keybind reference completeness**

1. Confirm every control removed from the toolbar or status area in this phase has its keybind correctly listed in the keybind reference modal, grouped logically, and that the reference reflects the final set across all plugins, not just the shell-level bindings from Phase 2.

## Verification

1. With a PDF, an image, and a video tile open simultaneously, confirm the toolbar shows a coherent, non-overflowing control set that updates correctly as focus moves between tiles, and that switching focus never causes a layout jump or flicker in the toolbar.
2. Confirm every keybind-only action remains fully functional and is discoverable via the keybind reference without needing to read documentation outside the app.
3. Resize the app window to a small but reasonable size and confirm no toolbar horizontal scrolling occurs.
4. Spot-check five arbitrary components against the theme file and confirm zero hardcoded style values remain.

## Constraints

This is a UI and interaction-classification pass, not a logic change. Do not alter tiling, rendering, persistence, or plugin behavior in this phase, only their visual presentation and control surface.
