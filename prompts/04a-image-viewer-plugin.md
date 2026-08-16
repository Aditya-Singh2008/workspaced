# Phase 4a: Image Viewer Plugin

Depends on Phases 1 through 3 being complete. Independent of Phase 4b (video), the two share nothing beyond the Phase 1 contract and can be built in parallel.

## Goal

A comprehensive, professional-grade image viewer plugin under `Workspace_App/src/viewers/image/`, matching the functional depth of established top-tier image viewing applications (the feature set found in tools like IrfanView, XnView MP, ACDSee, or Apple Preview), built entirely against the Phase 1 Viewer Plugin contract. This plugin does not implement inversion. Inversion is a PDF-specific accessibility mechanism tied to the page composite pipeline in Phase 3 and has no equivalent requirement here; do not add an invert control anywhere in this plugin.

## File organization

All image-viewer code and settings live under `Workspace_App/src/viewers/image/`. Code specific to a single file format goes in its own subdirectory named for that format: `image/jpeg/`, `image/png/`, `image/bmp/`, `image/tiff/`, `image/webp/`, `image/gif/`, `image/ico/`, `image/avif/`, `image/svg/`, `image/heic/`, `image/raw/`. Code and settings shared across every format (the viewing engine, pan/zoom, color tools, metadata panel, shared preferences) live directly in `image/`, never nested inside a per-format folder. Formats that genuinely share an identical decode and render path (the various camera RAW variants, for instance) may share one subdirectory, but each format must still be explicitly registered with the Phase 1 file-type registry so misdetection fails predictably rather than silently.

## Format coverage

Support, at minimum, each of the following as its own registered format:

- **Raster, broad compatibility**: JPEG, PNG, BMP, TIFF, WebP (static and animated), GIF (animated), ICO, AVIF.
- **Vector**: SVG, rendered natively (not rasterized), so it stays crisp at any zoom level.
- **Modern/HDR**: HEIC/HEIF.
- **Camera RAW**: at minimum the common variants (CR2/CR3, NEF, ARW, ORF, RW2, DNG). If a full RAW decode pipeline is impractical without a heavy new dependency, decode the embedded preview JPEG at minimum and clearly indicate to the user that a full RAW render was not performed, rather than failing to open the file.

For any format where platform-level decode support varies, detect support at runtime and show a clear per-file error state rather than a blank or crashed tile, per `AGENTS.md`'s Platform targets section.

## Core viewing engine (shared, lives in `image/` directly)

1. **Pan and zoom** - smooth cursor-centered zoom via trackpad pinch and ctrl-scroll, mouse-drag pan, matching the feel already established for the PDF plugin so the app feels consistent across file types.
2. **Fit modes** - fit-to-window, actual size (100%), fill.
3. **Non-destructive rotate and flip** - view-only transforms that do not alter the source file, applied instantly.
4. **Pixel-level inspection** - an eyedropper/color-picker tool showing the pixel color under the cursor at high zoom, with RGB and hex readouts.
5. **Histogram** - a live histogram panel reflecting the currently displayed image.
6. **Metadata panel** - EXIF/IPTC/XMP where present: dimensions, file size, color profile, camera/lens info for photos, GPS data if present, with a clear, unobtrusive way to hide sensitive metadata like GPS.
7. **Folder browsing** - next/previous navigation through sibling image files in the same directory as the opened file, plus a slideshow mode with configurable interval.
8. **Animated format playback** - play/pause, frame-step, and speed control for animated GIF/WebP, using the same transport-control conventions the video plugin (Phase 4b) uses, so the interaction feels familiar across both plugins even though they are independent implementations.
9. **Copy and export** - copy the currently displayed image (respecting any active non-destructive view transform) to the system clipboard, and export/save-as with format conversion among the supported formats.
10. **Non-destructive light adjustment preview** - brightness, contrast, and exposure preview adjustments that affect only the display, never the source file. These are view aids, not editing tools; do not let this grow into a paint or retouch feature set.

## Toolbar contributions and keybinds

Contribute a minimal, essential-only control set when an image tile is focused (zoom, fit mode, rotate), per the consolidation principle established elsewhere in this project. Everything else (histogram toggle, metadata panel toggle, pixel inspector, slideshow, folder navigation, adjustment preview panel) is keybind-accessible and/or reachable via a right-click context menu, registered in the shell's keybind reference from Phase 2.

## Plugin contract implementation

1. **Thumbnail** - a scaled-down render of the image; for animated formats, use the first frame.
2. **Search** - not implemented. Confirm the shell correctly treats this plugin as non-searchable with no error.
3. **Copy** - image data (and cropped selection, if selection is implemented) to the system clipboard, per the contract's copy method.
4. **Serialize/restore** - current zoom, pan position, rotation, active adjustment preview values, and current position within a folder browsing session.

## Verification

1. Open one file from each format category listed above and confirm correct rendering, correct metadata extraction, and correct thumbnail generation.
2. Confirm SVG remains crisp at 800% zoom, proving native vector rendering rather than rasterized scaling.
3. Confirm folder navigation correctly steps through sibling files and behaves sensibly at the ends of the directory listing.
4. Confirm animated GIF/WebP playback controls work independently per tile when multiple animated images are open simultaneously.
5. Confirm the eyedropper, histogram, and metadata panel all reflect the currently displayed image accurately, including after zoom/pan/rotate changes.
6. Confirm copy-to-clipboard and export/format-conversion both produce correct output.
7. Confirm no inversion control appears anywhere in this plugin's UI, toolbar contributions, or keybind reference entries.
8. Run the cross-platform check from `AGENTS.md`'s Platform targets section for at least the RAW and HEIC formats, since decode support is the most likely to vary by OS.

## Constraints

Do not implement inversion, region classification, or any PDF-specific concept here. If a format's decode requires a new dependency, justify it against `AGENTS.md`'s tech stack section before adding it, and prefer a dependency scoped to that one format's subdirectory over a single dependency that pulls in unrelated format support you don't need.
