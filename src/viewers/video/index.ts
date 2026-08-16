/**
 * The video viewer plugin.
 *
 * This file is the whole public surface: a `ViewerPlugin` descriptor and
 * nothing else. Everything below it is private to this directory, and nothing
 * outside it imports a container parser — which is what lets the shell host a
 * film without containing the word "video" anywhere (AGENTS.md, core
 * architectural principle).
 *
 * **The descriptor is eager, the implementation is not**, and there are two
 * levels of it. `mount()` reaches the rest of the plugin through a dynamic
 * `import()`, so registering the plugin at startup costs a list of extensions
 * rather than six container parsers; and `formats.ts` loads each container's
 * module the same way, so opening an MP4 never parses the Matroska, AVI or Ogg
 * paths.
 *
 * **The type lists are derived, never written down.** They come from
 * `formats.ts`, which is what makes "every container is registered explicitly"
 * checkable rather than aspirational — and it is why this plugin does not claim
 * the `video/*` wildcard. A wildcard would swallow every container that exists
 * now or later, including the ones this plugin cannot open, and the user would
 * get a broken player where the fallback viewer's honest "no viewer available
 * for this file type" belongs.
 *
 * ## Module map
 *
 *   `id.ts`         the plugin id, importable without a parser
 *   `formats.ts`    the container table: one row per registered container
 *   `codecs.ts`     codec names, and the measurement that decides playability
 *   `container.ts`  what a parsed container is: tracks, chapters, cues, notes
 *   `mount.ts`      opening a file: resolution, header parsing, load errors
 *   `instance.ts`   the mounted `ViewerInstance`: capabilities, contributions
 *   `actions.ts`    the verb list the toolbar, keybinds and menu derive from
 *   `state.ts`      what a tile remembers, and how it survives a bad restore
 *   `settings.ts`   viewer-wide preferences, including the shared volume
 *   `binary.ts`     bounds-checked byte reading, shared by every parser
 *   `engine/`       the player: view, transport, scrubber, tracks, subtitles,
 *                   thumbnailer, capture, panels, menu, presentation
 *   `metadata/`     the container primitives: ISOBMFF, EBML, RIFF, Ogg
 *   `<container>/`  one folder per container: mp4, mov, webm, mkv, avi, ogv
 *
 * This plugin implements **no inversion and nothing image-specific**, by
 * instruction. There is no invert control, no zoom-and-pan, no rotation and no
 * adjustment pipeline in the toolbar, the keybinds, the context menu or the
 * settings, and `selftest.ts` asserts their absence so none can arrive by
 * accident.
 */

import type { FileHandle } from "../../files";
import type { ViewerInstance, ViewerMountOptions, ViewerPlugin } from "../contract";
import { VIDEO_EXTENSIONS, VIDEO_MIME_TYPES } from "./formats";
import { VIDEO_PLUGIN_ID } from "./id";
// Eager, like the descriptor's own fields: `settings.ts` imports nothing at
// runtime and the shared volume has to be in effect before the first tile
// opens, not after a dynamic import resolves.
import { restoreVideoSettings, serializeVideoSettings } from "./settings";

export { VIDEO_PLUGIN_ID } from "./id";
export { VIDEO_EXTENSIONS, VIDEO_FORMATS, VIDEO_MIME_TYPES } from "./formats";

export const videoViewerPlugin: ViewerPlugin = {
  id: VIDEO_PLUGIN_ID,
  displayName: "Video",
  mimeTypes: VIDEO_MIME_TYPES,
  extensions: VIDEO_EXTENSIONS,
  stateVersion: 1,

  // The viewer-wide half of what this plugin remembers — the shared volume
  // above all — as opposed to `state.ts`, which is one tile's playhead.
  preferences: {
    version: 1,
    serialize: serializeVideoSettings,
    restore: restoreVideoSettings,
  },

  async mount(
    container: HTMLElement,
    file: FileHandle,
    options?: ViewerMountOptions,
  ): Promise<ViewerInstance> {
    const { mountVideo } = await import("./mount");
    return mountVideo(container, file, options);
  },
};
