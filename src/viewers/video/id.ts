/**
 * The plugin id, on its own so it can be imported without pulling in a parser.
 *
 * Same shape as `viewers/image/id.ts` and for the same reason: `index.ts` is the
 * eager descriptor and everything under it is lazy, so anything that only needs
 * to *name* this plugin — the registry, a restored session's recorded plugin id,
 * a self-test — must be able to reach the id without loading the plugin.
 *
 * Persisted in session state (`ViewerPluginDescriptor.id`), so changing it
 * invalidates saved sessions.
 */

export const VIDEO_PLUGIN_ID = "video";
