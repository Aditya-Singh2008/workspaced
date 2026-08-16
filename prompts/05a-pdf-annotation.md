# Phase 5a: PDF Annotation

Depends on Phase 3 (PDF viewer plugin) being complete. Phase 5b (text-anchored highlights and notes) depends on this phase; do not start 5b first. Read `AGENTS.md`'s "Annotation model and export" section before starting; this brief assumes it.

## Goal

A high-quality PDF annotation system, scoped to PDF only for now, matching the feature depth of the leading dedicated PDF annotation tools (Acrobat, PDF Expert, Foxit, Xodo, Nitro, PDF-XChange) rather than a bare-minimum sketch layer. Every annotation produced here is a page-relative, position-anchored item — highlighting or noting a specific piece of *text* is Phase 5b's job, not this one.

Built PDF-only, but not PDF-locked: the data model lives in `annotation/overlay/`, outside `viewers/pdf/`, and contains nothing PDF-specific. A future plugin (image, most plausibly) opts in by implementing its own render/export bridge in `annotation/export/`, exactly like the PDF bridge this phase builds. Do not build that second bridge now; just don't make decisions here that would require rewriting the data model to accommodate it later.

## What "premium" means here, concretely

The annotation types and interactions below are drawn from what the current leading PDF annotation tools treat as baseline, not exotic: multi-color highlighting, a real comment/annotation list with jump-to-location, freehand ink, standard review shapes, text callouts, and — the detail that actually separates a "real" tool from a toy — annotations that remain genuine PDF annotation objects, readable and editable in any other compliant PDF reader, not a raster mark baked into the page. That last point is the one most worth getting right; see AGENTS.md's export section for why and how.

Explicitly out of scope for this phase, even though some competitors bundle them: redaction, form filling, e-signatures, document comparison, and collaborative/multi-reviewer review threads. These are different feature categories, not a smaller version of this one; do not let them creep in.

## Tasks

**Overlay data model (`annotation/overlay/`)**

1. Define the overlay item types: `ink` (a stroke, as a series of points, with color/width/opacity), `highlight` (a freehand-drawn or drag-rectangle highlight region — this is a drawn mark, not a text selection; see the constraints below on not confusing this with Phase 5b), `shape` (`rect` | `ellipse` | `line` | `arrow`, with color/stroke width, optionally filled), `text` (a FreeText callout: position, font size, color, string content), `note` (a point-anchored sticky note: position, string content, collapsed/expanded state), `image` (a pasted or dropped image: position, size, rotation, the image data itself).
2. Every item is page-relative in position (and page-numbered, for a multi-page document), consistent with the "page-relative position and nothing else" framing in AGENTS.md.
3. Support move, resize (where the type has meaningful dimensions), delete, undo/redo, and z-order (bring to front / send to back) for overlapping items.
4. Color and stroke-width pickers remember their last-used value per tool, so re-selecting the highlight tool doesn't reset to a default every time.

**Tools and interaction**

1. Contribute a single "Annotate" toggle to the PDF plugin's toolbar contribution (`viewers/pdf/actions.ts`), not one button per tool. Toggling it on opens a compact tool palette attached to the tile (a floating strip or a docked panel, your choice, but not a permanent top-bar addition), consistent with the toolbar's standing instruction to stay short.
2. The palette offers the tool set from the data model above: ink, highlight, shapes, text callout, sticky note, image paste. Selecting a tool and interacting with the page creates the corresponding item.
3. Image input: support both pasting from the system clipboard and dropping an image file onto the page. For clipboard paste, read directly from the system clipboard (Tauri's clipboard plugin, or the browser Clipboard API) scoped to this feature; do not wait on or depend on Phase 6's cross-viewer clipboard system, which does not exist yet at this point in the execution order and solves a different problem (cross-tile copy/paste, history, the scratch panel). If Phase 6 later wants to factor out a shared "read image from system clipboard" helper, that's a Phase 6 decision, not a dependency for this phase.
4. **Keybind discipline**: the PDF plugin's listed keybind section is deliberately capped at six rows (`viewers/pdf/actions.ts`, already cut down once — see AGENTS.md's keybind history). Do not add a new listed row per annotation tool. Prefer the toolbar toggle, the tool palette, and the tile's right-click context menu for tool selection. If a specific keybind is genuinely justified (for example, a fast "toggle annotate mode" key), weigh it explicitly against the existing six before adding it, and update the self-test that asserts the count as a deliberate decision, not an incidental change.

**Annotation list panel**

1. Add an "Annotations" tab to `shell/sidebar/`, alongside the existing open-files list and the subdivision rail, following the same shell-owns-the-UI / plugin-owns-the-data split `SubdivisionRail.tsx` already establishes.
2. This requires extending the Viewer Plugin contract: follow the exact procedure already used for `readout` and `reveal` in phases 01–03 (an extension happens because a plugin needs something the contract doesn't have, not speculatively). At minimum, the focused tile needs to report an annotations capability and a way to list its current annotations (type, page, short label, timestamp). Add the resulting row(s) to the contribution table in AGENTS.md's "How a plugin reaches the shell" section, with the same one-line justification style already used there.
3. Each list entry is clickable and uses the existing `reveal(location)` mechanism (already generalized since phase 03) to jump to that annotation's page and position. Do not build a second navigation mechanism.
4. Support deleting an annotation directly from the list.

**Export and the annotated-flag mechanism**

1. Implement export exactly as specified in AGENTS.md's "Annotation model and export" section: real PDF annotation objects via `pdf-lib` (Highlight, FreeText, Ink, Text/Popup, Square/Circle/Line for shapes, Stamp for pasted images), constructed through `pdf-lib`'s low-level object API where its high-level helpers don't cover a subtype, with flattening only as a last resort for a subtype that genuinely cannot be represented as a real object.
2. Implement the annotated-flag: a durable marker embedded in the PDF's own Info dictionary or XMP metadata (verify which `pdf-lib` supports cleanly before committing) identifying a file as a workspace-generated annotated output.
3. Implement the save logic precisely as specified in AGENTS.md: overwrite in place if the currently open file already carries the marker; otherwise write `<name>-annotated.pdf` alongside the original, embed the marker, and repoint the open tile at the new file for the rest of the session. Handle the path-collision edge case exactly as specified: an existing file at the target path that already carries the marker is treated as the same companion file; one that doesn't carry the marker gets a numeric suffix rather than being overwritten.
4. The original source file is never written to once an annotated companion exists for it.

## Verification

1. Create one of each overlay type (ink, highlight, each shape, text callout, sticky note, pasted image) on a multi-page PDF; confirm move/resize/delete/undo/redo/z-order all work correctly for the applicable types.
2. Export and reopen the file in this app and in at least one other PDF reader (any compliant reader available); confirm every annotation is present, correctly positioned, and recognized as a real annotation object (selectable/editable as such), not a flattened image.
3. Save a second time on the same file; confirm it overwrites in place rather than producing a second `-annotated` file.
4. Open the original (never-annotated) source file again separately and save an annotation from it; confirm this does not touch the existing `<name>-annotated.pdf` companion incorrectly — specifically, confirm the collision-handling rule (marker present -> treat as the same companion; marker absent -> numeric suffix) behaves correctly against a deliberately planted unrelated file with a colliding name.
5. Confirm the annotation list panel shows every created item, jumps correctly via `reveal()`, and supports deletion.
6. Confirm the toolbar's footprint is exactly one new control ("Annotate") when a PDF tile is focused, and that no new listed keybind rows were added without an explicit, documented justification against the six-row cap.
7. Confirm image paste works via both clipboard paste and file drop, on all three target platforms (per AGENTS.md's Platform targets section), since clipboard image-read behavior is one of the areas already flagged as varying by webview.

## Constraints

Do not implement text-anchored highlighting or notes here; that is Phase 5b, and conflating the two data models is the specific mistake AGENTS.md's export section documents as already tried and rejected. Do not build a second export pipeline, a second annotated-flag mechanism, or a second navigation mechanism if Phase 5b needs to show its own annotations in the same list; extend what this phase builds, following the shared model split (`annotation/overlay/` vs `annotation/text/`, one `store.ts`, one `export/` bridge per plugin) already specified in AGENTS.md.
