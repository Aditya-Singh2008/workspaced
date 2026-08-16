# Phase 1: Scaffold and Core Architecture

Read `AGENTS.md` in full before starting. This phase produces no visible features. It produces the seam every later phase builds against, so correctness here matters more than speed.

## Goal

Stand up the Tauri + React + TypeScript project and define the Viewer Plugin contract, the file-type registry, and the Tailwind theme. No PDF-specific, image-specific, or video-specific logic belongs in this phase.

## Tasks

**Project scaffold**

1. Initialize a Tauri 2.x project with a React + TypeScript frontend (Vite as the frontend build tool).
2. Set up the module structure exactly as specified in `AGENTS.md`'s module map. Create empty directories with placeholder index files where a later phase will fill them in, so the intended structure is visible from the start.
3. Configure Tailwind CSS with a theme file (`src/theme/`) encoding the design tokens from `AGENTS.md`: background color, foreground color, muted text color, single accent color, border width and color rules, zero border-radius, monospace font stack (`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`). Every later component must consume these tokens, never hardcode a color or radius value.
4. Set up the Rust backend with the Tauri filesystem plugin and store plugin enabled, even though nothing uses them yet. Verify a basic native file-open dialog works end to end (Rust command callable from the frontend, returns a real file path).

**Viewer Plugin contract**

Define the contract in `src/viewers/contract.ts`. This is the single most important file in the project. At minimum, it must specify:

1. **Identification**: how a plugin declares which MIME types and/or file extensions it handles.
2. **Lifecycle**: `mount(container: HTMLElement, fileHandle: FileHandle, initialState?: unknown): ViewerInstance` and a corresponding `unmount()`/`dispose()` that the shell guarantees is called exactly once when a tile closes, releasing all resources (canvases, decoders, object URLs, event listeners).
3. **Thumbnail**: an async method returning a small preview image (as a data URL, ImageBitmap, or canvas) for use in the sidebar and command palette. Plugins that cannot produce a meaningful thumbnail (fallback viewer) return a generic icon instead.
4. **Search**: an optional method returning searchable text content plus enough position information for the shell's global search to jump to a match. Plugins without text content (most images, video) omit this; the shell must treat its absence as "not searchable," not as an error.
5. **Copy**: an optional method exposing what the plugin considers copyable at a given selection or region (text, image data, or both). The shell's clipboard system calls this rather than assuming DOM selection behavior, since not every plugin renders selectable DOM text.
6. **State serialization**: `serialize(): unknown` and `restore(state: unknown)` for whatever the plugin needs to resume where it left off (zoom, scroll position, current page or timestamp, per-instance preferences). The shell persists whatever this returns without inspecting it.
7. **Annotation** (optional): a capability flag plus methods for accepting overlay content and exporting a flattened result. Plugins that don't support annotation simply don't implement this part of the contract; the shell must hide annotation UI for such tiles rather than showing a disabled button.
8. **Error state**: a required method or convention for the plugin to report a load failure to the shell in a way that renders inside its own tile, never as a shell-level crash or global error.

Write this contract with TypeScript interfaces and generous doc comments. Treat it as public API design, since every phase after this one is a consumer of it.

**File-type registry**

Implement `src/viewers/registry.ts`:

1. A registration function plugins call to announce which MIME types/extensions they handle.
2. A resolution function taking an opened file and returning the matching plugin, using MIME type first and falling back to extension matching when MIME type is unavailable or generic (`application/octet-stream`).
3. A fallback plugin (`src/viewers/fallback/`) that handles anything unmatched: displays file name, size, type, and a message that no viewer is available, without crashing or blocking the rest of the workspace.

**File handle abstraction**

Define a `FileHandle` type/interface in a shared location that normalizes access whether the file came from a native Tauri file dialog, a drag-and-drop event, or (later) a restored session path. Every viewer plugin and the persistence layer should depend on this abstraction, not on `File`, `Blob`, or raw path strings directly, so the underlying access mechanism can change without touching plugin code.

## Verification

1. The app launches to an empty workspace state with no viewer plugins registered yet, and does not error.
2. A stub "hello world" plugin (delete before merging, or keep behind a dev flag) can be registered against a test MIME type, mounted into a container, produce a placeholder thumbnail, serialize and restore trivial state, and unmount cleanly, proving the contract is implementable end to end before any real plugin depends on it.
3. Opening a file with no matching plugin correctly falls through to the fallback viewer without error.
4. Tailwind theme tokens are the only source of color/radius/font values anywhere in the codebase at this point (there should be almost no styled components yet, so this is easy to confirm now and should be re-verified in every later phase).

## Constraints

Do not implement tiling, toolbar, or any real viewer in this phase. Resist the urge to "just quickly wire up PDF rendering to see it work," since that is exactly how the contract ends up shaped around one file type instead of designed for many. If PDF-specific needs surface while writing the contract, generalize the contract rather than special-casing PDF within it.
