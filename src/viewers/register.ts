/**
 * The one place plugins are wired into the registry.
 *
 * Later phases add their plugin here and nowhere else — that is what keeps the
 * shell free of file-type knowledge. The shell imports this function, not any
 * individual plugin.
 */

import { devStubViewerPlugin } from "./dev/stub";
import { fallbackViewerPlugin } from "./fallback";
import { imageViewerPlugin } from "./image";
import { pdfViewerPlugin } from "./pdf";
import { registerViewerPlugin, setFallbackViewerPlugin } from "./registry";
import { videoViewerPlugin } from "./video";

let registered = false;

export function registerBuiltInViewerPlugins(): void {
  if (registered) return;
  registered = true;

  registerViewerPlugin(pdfViewerPlugin);
  registerViewerPlugin(imageViewerPlugin);
  registerViewerPlugin(videoViewerPlugin);

  if (import.meta.env.DEV) {
    registerViewerPlugin(devStubViewerPlugin);
  }

  // Installed last and separately: it competes with nothing, it only catches
  // what nothing else claimed.
  setFallbackViewerPlugin(fallbackViewerPlugin);
}
