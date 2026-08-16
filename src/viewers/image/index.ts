/**
 * The image viewer plugin.
 *
 * This file is the whole public surface: a `ViewerPlugin` descriptor and
 * nothing else. Everything below it is private to this directory, and nothing
 * outside it imports a decoder — which is what lets the shell host an image
 * without containing the word "image" anywhere (AGENTS.md, core architectural
 * principle).
 *
 * **The descriptor is eager, the implementation is not**, and there are two
 * levels of it. `mount()` reaches the rest of the plugin through a dynamic
 * `import()`, so registering the plugin at startup costs a list of extensions
 * rather than a decoder; and `formats.ts` loads each format's module the same
 * way, so opening a JPEG never parses the TIFF, GIF or RAW paths. The
 * descriptor's own fields are what the registry needs to *resolve* a file, and
 * resolution happens for every file whether or not it turns out to be an image.
 *
 * **The type lists are derived, never written down.** They come from
 * `formats.ts`, which is what makes "every format is registered explicitly"
 * checkable rather than aspirational — and it is why this plugin does not claim
 * the `image/*` wildcard. A wildcard would swallow every image format that
 * exists now or later, including the ones this plugin cannot open, and the user
 * would get a broken image tile where the fallback viewer's honest "no viewer
 * available for this file type" belongs.
 *
 * ## Module map
 *
 *   `id.ts`         the plugin id, importable without a decoder
 *   `formats.ts`    the format table: one row per registered format
 *   `mount.ts`      opening a file: resolution, decode dispatch, load errors
 *   `instance.ts`   the mounted `ViewerInstance`: capabilities, contributions
 *   `actions.ts`    the verb list the toolbar, keybinds and menu derive from
 *   `state.ts`      what a tile remembers, and how it survives a bad restore
 *   `settings.ts`   viewer-wide preferences, as opposed to per-tile state
 *   `decode.ts`     what "a decoded image" is, and the platform decode paths
 *   `preview.ts`    finding the embedded JPEG in a RAW or HEIC file
 *   `folder.ts`     the sibling files, for next/previous and the slideshow
 *   `binary.ts`     bounds-checked byte reading, for the formats parsed here
 *   `engine/`       the shared surface: view, panels, pixels, animation, export
 *   `metadata/`     EXIF, IPTC and XMP, and the TIFF directory reader
 *   `<format>/`     one folder per format (RAW variants share `raw/`)
 *
 * This plugin implements **no inversion**, by instruction. Inversion is a
 * PDF-specific accessibility mechanism tied to the page composite pipeline in
 * phase 03; there is no invert control in the toolbar, the keybinds, the context
 * menu or the settings, and `selftest.ts` asserts their absence so it cannot
 * arrive by accident.
 */

import type { FileHandle } from "../../files";
import type { ViewerInstance, ViewerMountOptions, ViewerPlugin } from "../contract";
import { IMAGE_EXTENSIONS, IMAGE_MIME_TYPES } from "./formats";
import { IMAGE_PLUGIN_ID } from "./id";
// Eager, like the descriptor's own fields and for the same reason: `settings.ts`
// imports nothing and holds one object, and the shell asks for these before any
// tile exists — a lazily-loaded preference is one that has not been applied yet
// when the first image opens.
import { restoreImageSettings, serializeImageSettings } from "./settings";

export { IMAGE_PLUGIN_ID } from "./id";
export { IMAGE_EXTENSIONS, IMAGE_FORMATS, IMAGE_MIME_TYPES } from "./formats";

export const imageViewerPlugin: ViewerPlugin = {
  id: IMAGE_PLUGIN_ID,
  displayName: "Image",
  mimeTypes: IMAGE_MIME_TYPES,
  extensions: IMAGE_EXTENSIONS,
  stateVersion: 1,

  // The viewer-wide half of what this plugin remembers; `state.ts` is the
  // per-tile half. See `settings.ts` for where the line falls.
  preferences: {
    version: 1,
    serialize: serializeImageSettings,
    restore: restoreImageSettings,
  },

  async mount(
    container: HTMLElement,
    file: FileHandle,
    options?: ViewerMountOptions,
  ): Promise<ViewerInstance> {
    const { mountImage } = await import("./mount");
    return mountImage(container, file, options);
  },
};
