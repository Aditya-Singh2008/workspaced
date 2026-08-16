# Phase 2: Tiling Shell

Depends on Phase 1 (`01-scaffold-and-core-architecture.md`) being complete. This phase builds the file-type-agnostic shell: docking/tiling, the minimal toolbar frame, and the keybind reference. It uses the stub plugin from Phase 1 for testing, since no real viewer exists yet.

## Goal

Replace the original hand-rolled binary split tree entirely with a proven docking library, achieving the same user-facing freeform arrangement (split any direction, stack as tabs, resize by dragging, drag one tile onto another's edge to rearrange) without any hand-written layout math.

## Tasks

**Docking integration**

1. Integrate the chosen docking library (per `AGENTS.md`) as the root of the workspace area. Each open file becomes a panel in the docking system; the docking library owns split/stack/resize geometry entirely.
2. Confirm the library natively supports: horizontal and vertical splits, drag-to-dock on any edge of an existing panel with a live drop-zone indicator, drag-to-stack as tabs within a panel, resizable dividers with a sensible minimum panel size, and programmatic layout construction/serialization. If the chosen library is missing any of these, stop and flag it rather than working around the gap by hand, since a partial workaround reintroduces the original problem.
3. Wire panel mount/unmount to the Viewer Plugin contract's `mount`/`dispose` lifecycle so opening a file creates a panel that mounts the resolved plugin, and closing a panel calls the plugin's disposal correctly every time, including when the whole app closes.
4. Define what "master" and "swap with master" mean against the docking library's model (for example, master is the first panel in the root split), so keyboard-driven layout actions have a coherent target even though users can also rearrange freely by mouse.

**Focus and keyboard navigation**

1. Implement focus tracking: exactly one panel is focused at a time, visually indicated with a thin accent-colored border (per the theme), all keyboard shortcuts and the toolbar act on the focused panel.
2. Implement keybindings: cycle focus next/previous, promote focused panel to master, swap focused panel with master, toggle monocle (focused panel fills the workspace, others hidden but retained), close focused panel, adjust master/split ratio, increase/decrease gap between panels.
3. Every one of these must also be reachable without a keyboard, either through the toolbar (only if essential, per the consolidation principle) or through a right-click context menu on the panel, since Phase 8 will formalize the essential-vs-keybind-only split. For now, ensure no action is keyboard-only with zero discovery path.

**Minimal toolbar frame**

Build the toolbar shell now, populated with only the controls that are unambiguously essential regardless of file type: open file, sidebar toggle, and a keybind reference trigger. File-type-specific controls (invert mode, page navigation, zoom) are added by later phases without needing to restructure this shell, since the toolbar should expose an extension point plugins can contribute controls into when their tile is focused.

1. Design the toolbar so a focused plugin can contribute a small set of contextual controls (for example, PDF's invert toggle appears only when a PDF tile is focused) without the toolbar component needing to know what a PDF is. This likely means the Viewer Plugin contract from Phase 1 needs a `getToolbarControls()` or similar optional method; if it doesn't already, add it now and update `contract.ts`.
2. Keep the toolbar visibly short. If a stub plugin's test controls make it feel crowded, that is a signal to revisit control count once real plugins exist in Phase 8, not to solve it now.

**Keybind reference**

1. Build the keybind reference modal (triggered from the toolbar and a dedicated key), listing all shell-level bindings from this phase in logical groups (focus and navigation, layout and resizing).
2. Design it so later phases can register additional bindings/groups (page navigation, zoom, annotation) without modifying this component's internals, just contributing entries to a shared registry.

## Verification

1. Open several instances of the stub plugin, split them in every direction, stack two as tabs, resize by dragging every divider, and drag one panel onto another's edge to rearrange, confirming the docking library handles all of it without custom layout code.
2. Close panels in different orders and confirm the remaining layout reflows correctly and no plugin instance leaks (dispose is called, no dangling references).
3. Confirm keyboard focus-cycling, promote, swap, and monocle work correctly against whatever arrangement resulted from freeform mouse rearrangement, not just the default split.
4. Confirm the toolbar shows only its baseline controls with no file open, and can display stub-plugin-contributed controls when a stub tile is focused, then hides them again when focus moves to a tile without contributed controls.
5. Confirm the keybind registry correctly abstracts modifier keys per platform (Ctrl on Windows/Linux, Cmd on macOS), that the keybind reference modal displays the platform-appropriate modifier, and that this is tested on at least two of the three target platforms before Phase 2 is considered done.

## Constraints

No manual pointer-event math for resizing or rearranging panels. If the docking library's API requires supplementary code to hit the specified interactions, that supplementary code should be thin glue, not a reimplementation of the library's job.
