# Phase 6: Clipboard, Global Search, Command Palette

Depends on Phases 1 through 5 being complete. These three systems are grouped together because they all follow the same pattern: shell-level UI that queries every open plugin through the Phase 1 contract, rather than knowing about specific file types.

## Goal

Cross-viewer copy/paste, workspace-wide search across every open tile regardless of file type, and a command palette reachable by both keyboard and mouse.

## Tasks

**Clipboard system**

1. Implement text copy using each plugin's contract-defined copy method (from Phase 1), so the shell never assumes DOM text selection exists, since not every plugin has selectable text.
2. Implement region/image copy to the system clipboard (Clipboard API, `ClipboardItem` with `image/png`) for plugins that expose image-region copying through the contract.
3. Implement a scratch panel: a lightweight notes area docked in the shell (sidebar or status area) where copied text or images can be collected across multiple open tiles during a session, distinct from the system clipboard.
4. Implement a session-only clipboard history (not persisted across app restarts) accessible via a compact list, showing recent copies of either type.
5. Define distinct keybindings for "copy to system clipboard" versus "yank to scratch panel," and register both with the Phase 2 keybind reference.
6. Visual feedback on successful copy should be a brief status-bar message, consistent with the established flat aesthetic, not a modal or animated toast.

**Global search**

1. Implement a search mode querying every open tile's plugin via the contract's optional search method, skipping plugins that don't implement it (image, video) without error.
2. Present results grouped by document/tile with enough surrounding context to identify the right match.
3. Selecting a result focuses that tile (using Phase 2's focus system) and, for plugins that support it, scrolls to and highlights the match.
4. Make search reachable both from a dedicated keybind/toolbar action and from within the command palette below.

**Command palette**

1. Implement a quick-launch overlay, triggered by keybind and also reachable via a visible toolbar button or icon, so it is not keyboard-only.
2. Support actions: open a file, jump to a page/position within the focused tile (delegated to that plugin), trigger global search, switch layout arrangement, trigger annotation mode on the focused tile if supported.
3. Support both typing-to-filter with keyboard navigation and direct mouse click on a result.
4. Style consistent with the established flat, monospace, bordered visual language.
5. Closing the palette (Escape, click outside, selecting a result) returns focus cleanly to whatever tile was focused before the palette opened.

## Verification

1. Copy text from a PDF tile and paste it into another PDF tile's search box, confirming cross-tile paste works.
2. Copy an image region from the image plugin to the system clipboard and paste it into an external application, confirming the OS-level clipboard integration works, not just an in-app scratch panel.
3. Run a global search across a workspace with a PDF, an image, and a video open; confirm results only come from the PDF (the searchable one), and no error surfaces from the other two.
4. Open the command palette by keyboard, filter to an action, and select it with Enter; then reopen it and select the same action by mouse click, confirming both paths work identically.
5. Confirm every new keybind introduced in this phase appears correctly in the Phase 2 keybind reference modal with no conflicts against existing bindings.

## Constraints

None of these three systems should contain a single reference to a specific plugin's internals. If global search needs something from a plugin that the contract doesn't currently expose, extend the contract (as in Phase 4) rather than special-casing the plugin inside the search implementation.
