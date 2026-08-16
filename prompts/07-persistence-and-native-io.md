# Phase 7: Persistence and Native I/O

Depends on Phases 1 through 6 being complete. Implements session and layout persistence using real file handles, which is one of the primary reasons this project moved off the browser-only architecture in the first place.

## Goal

The workspace survives a restart: the same tiles, in the same arrangement, with the same files reopened automatically (not just a placeholder prompting the user to reselect, since native file access makes this unnecessary), and each tile's plugin resumes its own state via the Phase 1 contract.

## Tasks

**Layout persistence**

1. Persist the docking library's layout state (from Phase 2) to Tauri's store plugin on every meaningful change (panel added, removed, resized, rearranged), debounced so this doesn't thrash disk on every pixel of a drag.
2. On launch, restore the layout structure before attempting to reopen files, so the arrangement is visually correct even if a file fails to reopen.

**File reference persistence**

1. For each tile, persist the real file path (via the Tauri filesystem plugin from Phase 1) rather than the browser's filename-and-size heuristic matching from the original design. Native file access means the app can reopen the exact file directly.
2. On restore, attempt to silently reopen each persisted file path. If a file has moved or been deleted, show that specific tile's error state (per the Phase 1 contract's error convention) rather than failing the whole session restore.
3. Where the user's OS or Tauri's permission model requires re-confirming access to a path (sandboxing, moved files, external drives), handle that gracefully with a clear per-tile prompt, not a full-app blocking dialog.

**Per-plugin state persistence**

1. For each tile, call the plugin's `serialize()` method (Phase 1 contract) and persist the result alongside its file path and layout position.
2. On restore, after a file is successfully reopened, call the plugin's `restore()` method with the persisted state so zoom, scroll position, current page or timestamp, inversion mode, and in-progress annotations (Phase 5) all resume correctly.

**Manual controls**

1. Provide a "clear saved session" action (toolbar or command palette) for when persisted state becomes stale or the user wants a clean start.
2. Confirm this action does not delete files on disk, only the app's own persisted session record.

## Verification

1. Arrange several tiles of mixed file types (PDF, image, video) in a nontrivial split/stack layout, adjust zoom and page position in each, place an in-progress annotation on one, then restart the app and confirm everything restores: layout, files, per-plugin view state, and the annotation.
2. Move or rename a file referenced by a persisted tile, restart, and confirm that specific tile shows a clear error state while every other tile restores normally.
3. Use "clear saved session," restart, and confirm the app launches to the empty state with no attempt to reopen anything.
4. Confirm debounced layout persistence does not cause noticeable lag or excessive disk writes during rapid resize/drag interactions.

## Constraints

Persistence logic belongs in `src/persistence/` and must not require plugins to know about Tauri's store API directly. Plugins only ever see `serialize()`/`restore()` calls from the shell; how and where that data is stored is the persistence layer's concern alone.
