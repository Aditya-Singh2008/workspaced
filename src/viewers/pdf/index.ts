/**
 * The PDF viewer plugin.
 *
 * This file is the whole public surface: a `ViewerPlugin` descriptor and the
 * two hooks a host can register. Everything else in this directory is private
 * to it, and nothing outside it imports `pdfjs-dist` — which is what lets the
 * shell host a PDF without containing the word "PDF" anywhere (AGENTS.md, core
 * architectural principle).
 *
 * **The descriptor is eager, the implementation is not.** `mount()` reaches the
 * rest of the plugin through a dynamic `import()`, so registering the plugin at
 * startup costs a few hundred bytes of metadata rather than a megabyte of
 * decoder. A session that opens no PDF never loads pdf.js, its worker, or this
 * plugin's stylesheet at all. The descriptor's own fields — the id, the MIME
 * types, the extensions — are what the registry needs to *resolve* a file, and
 * resolution happens for every file whether or not it turns out to be a PDF.
 *
 * ## Module map
 *
 *   `id.ts`         the plugin id, importable without pdf.js
 *   `mount.ts`      opening a document: validation, load errors, the probe
 *   `pdfjs.ts`      the library and its worker, configured once
 *   `instance.ts`   the mounted `ViewerInstance`: capabilities, contributions
 *   `view.ts`       the scroller: the render queue, navigation, zoom, inversion
 *   `page.ts`       one page's element, canvas and text layer
 *   `thumbnails.ts` the contract's `thumbnail()`, natural colours, cached
 *   `print.ts`      the original file, by whichever route the webview allows
 *   `actions.ts`    the verb list the toolbar and the keybinds both derive from
 *   `state.ts`      what a tile remembers, and how it survives a bad restore
 *   `ocr.ts`        the opt-in OCR hook; nothing is bundled
 *   `selftest.ts`   dev-only checks for the parts a human cannot eyeball
 */

import type { FileHandle } from "../../files";
import type { ViewerInstance, ViewerMountOptions, ViewerPlugin } from "../contract";
import { PDF_PLUGIN_ID } from "./id";

export { PDF_PLUGIN_ID } from "./id";

// Light enough to re-export eagerly: `ocr.ts` holds one nullable function
// reference and imports nothing. A host registering an OCR model must be able
// to do so without that registration itself pulling in pdf.js.
export { registerPdfOcr } from "./ocr";
export type { PdfOcr } from "./ocr";

export const pdfViewerPlugin: ViewerPlugin = {
  id: PDF_PLUGIN_ID,
  displayName: "PDF",
  mimeTypes: ["application/pdf", "application/x-pdf"],
  extensions: ["pdf"],
  // 2: the inversion state became a single boolean, replacing a mode plus two
  // per-page override maps and a tint. A session written by version 1 carries
  // fields this plugin no longer reads, so the persistence layer discards it
  // rather than restoring half of it.
  stateVersion: 2,

  async mount(
    container: HTMLElement,
    file: FileHandle,
    options?: ViewerMountOptions,
  ): Promise<ViewerInstance> {
    const { mountPdf } = await import("./mount");
    return mountPdf(container, file, options);
  },
};
