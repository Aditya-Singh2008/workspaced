/**
 * Viewer layer. `contract.ts` is the single source of truth for the plugin
 * interface; everything else here is the machinery that resolves, mounts and
 * disposes plugins on the shell's behalf.
 */

export * from "./contract";

export {
  DuplicatePluginError,
  clearViewerPlugins,
  getFallbackViewerPlugin,
  getViewerPlugin,
  listViewerPlugins,
  registerViewerPlugin,
  resolveViewerPlugin,
  resolveViewerPluginForFile,
  setFallbackViewerPlugin,
  unregisterViewerPlugin,
} from "./registry";
export type { ViewerMatchKind, ViewerResolution } from "./registry";

export {
  disposeAllViewers,
  disposeViewer,
  getViewerInstance,
  isViewerDisposed,
  listViewerInstances,
  mountViewer,
  subscribeToViewerInstances,
  viewerInstancesVersion,
} from "./instances";
export type { MountViewerArgs, MountViewerResult } from "./instances";

export { fallbackViewerPlugin, FALLBACK_PLUGIN_ID } from "./fallback";
export { registerBuiltInViewerPlugins } from "./register";
